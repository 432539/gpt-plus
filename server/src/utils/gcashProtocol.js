'use strict';

// GCash merchants-auth 协议（对照 m.gcash.com.har 提链 + 7chatgpt.com.har 回跳）。
// 真 QR：ap.mobilewallet.gka.authorisation.stateless.consult → qrCode。
// consult 与 query.result 同一套 form 信封；envInfo.tokenId 全程复用，轮询 uuid 用 consult result.uuid。
// 提链 consult 的 urlParameters 是授权页 query string（无前导 ?），不是 key/value 对象。
// 扫码轮询：ap.mobilewallet.gka.query.result，约 5s，form-urlencoded。
// 扫完先跟 Adyen checkoutPaymentReturn，落到 /checkout/verify?redirectResult=，再 continue。
// 无 EMV 时，GCSHLNKV / shortUrl / short.dynamic.link 也编码成可扫二维码。
// 不要把 cookie / token / redirectData / 完整 redirectUrl 打进日志或仓库。

const { randomUUID } = require('node:crypto');

const GCASH_RPC_URL = 'https://mgs-gw.paas.mynt.xyz/mgw.htm';
const GCASH_RPC_APP_ID = 'D54528A131559';
const GCASH_RPC_WORKSPACE = 'PROD';
const GCASH_RPC_TENANT = 'MYNTPH';
const GCASH_AUTH_STATELESS_CONSULT = 'ap.mobilewallet.gka.authorisation.stateless.consult';
const GCASH_QUERY_RESULT = 'ap.mobilewallet.gka.query.result';
const GCASH_QUERY_ACCESS_TOKEN = GCASH_QUERY_RESULT;
const GCASH_POLL_INTERVAL_MS = 5_000;
const GCASH_QR_TTL_MS = 300_000;
const GCASH_URL_TTL_MS = 24 * 60 * 60 * 1000;
const GCASH_POLL_TIMEOUT_MS = GCASH_QR_TTL_MS;
const CHATGPT_CONTINUE_PATH = '/backend-api/payments/checkout/custom_payment_method/continue';
const PROTOCOL_KEYS = Object.freeze(['errorActions', 'extendInfo', 'redirectUrl', 'success', 'traceId']);

function isPlaceholderQrValue(value) {
  return /gcat_loader|(?:^|[/?#._-])(?:loader|spinner|placeholder)(?:[/?#._-]|\.|$)/i.test(String(value || ''));
}

function hostnameOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isGcashAuthPage(url) {
  const host = hostnameOf(url);
  if (!(host === 'm.gcash.com' || host.endsWith('.gcash.com'))) return false;
  return /gcash-merchants-auth|merchants-auth/i.test(String(url || ''));
}

function isGcashRpcUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname.toLowerCase() === 'mgs-gw.paas.mynt.xyz'
      && /\/mgw\.htm$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function queryObject(url) {
  const out = {};
  try {
    const parsed = new URL(String(url || ''));
    for (const [key, value] of parsed.searchParams.entries()) {
      if (key) out[key] = value;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function authPageQueryString(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    const search = String(parsed.search || '');
    return search.startsWith('?') ? search.slice(1) : search;
  } catch {
    return '';
  }
}

function parseGcashAuthPage(url) {
  const pageUrl = String(url || '').trim();
  const query = queryObject(pageUrl);
  const bindingId = String(query.bindingRequestID || query.netAuthId || '').trim();
  const authId = String(query.clientId || '').trim();
  const tokenId = String(query.tokenId || query.tokenid || '').trim();
  return {
    pageUrl: isGcashAuthPage(pageUrl) ? pageUrl : '',
    bindingId,
    authId,
    tokenId,
    scopes: String(query.scopes || '').trim(),
    terminalType: String(query.terminalType || '').trim(),
    productCode: String(query.productCode || '').trim(),
    queryKeys: Object.keys(query),
    ready: Boolean(isGcashAuthPage(pageUrl) && bindingId && authId),
  };
}

function safeAuthView(auth) {
  return {
    host: hostnameOf(auth?.pageUrl),
    ready: Boolean(auth?.ready),
    has_binding: Boolean(auth?.bindingId),
    has_auth: Boolean(auth?.authId),
    scopes: String(auth?.scopes || ''),
    query_keys: Array.isArray(auth?.queryKeys) ? auth.queryKeys.slice() : [],
  };
}

function preferReadyGcashLink(providerUrl, finalUrl) {
  const landed = parseGcashAuthPage(finalUrl);
  if (landed.ready && landed.pageUrl) return landed.pageUrl;
  return String(providerUrl || '').trim();
}

function unwrapProtocolPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return null;
    try {
      return unwrapProtocolPayload(JSON.parse(text));
    } catch {
      return null;
    }
  }
  if (typeof payload !== 'object') return null;
  if (payload.data && typeof payload.data === 'object' && (
    'success' in payload.data || 'qrCode' in payload.data || 'redirectUrl' in payload.data
  )) {
    return payload.data;
  }
  if (payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
    return unwrapProtocolPayload(payload.result);
  }
  return payload;
}

function protocolKeyList(payload) {
  const data = unwrapProtocolPayload(payload);
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data).filter((key) => PROTOCOL_KEYS.includes(key)).sort();
}

function isGcashScanComplete(payload) {
  const data = unwrapProtocolPayload(payload);
  if (!data || typeof data !== 'object') return false;
  const success = data.success === true || data.success === 'true' || data.success === 'TRUE';
  if (!success) return false;
  if (String(data.redirectUrl || '').trim()) return true;
  return Array.isArray(data.accessTokens) && data.accessTokens.length > 0;
}

function scanRedirectUrl(payload) {
  const data = unwrapProtocolPayload(payload);
  return String(data?.redirectUrl || '').trim();
}

function redirectFlag(payload) {
  return scanRedirectUrl(payload) ? '有' : '无';
}

function remainingTtlMs(startedAt, ttlMs, now = Date.now()) {
  const start = Number(startedAt || 0);
  const ttl = Number(ttlMs || 0);
  if (!start || !ttl) return 0;
  return Math.max(0, ttl - (now - start));
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function qrNeedsRefresh(issuedAt, now = Date.now(), ttlMs = GCASH_QR_TTL_MS) {
  const start = Number(issuedAt || 0);
  return start > 0 && now - start >= Number(ttlMs || GCASH_QR_TTL_MS);
}

function nestedShortDynamicLink(data) {
  if (!data || typeof data !== 'object') return '';
  const dotted = String(data['short.dynamic.link'] || '').trim();
  if (dotted) return dotted;
  const short = data.short;
  if (!short || typeof short !== 'object') return '';
  if (typeof short.dynamic === 'string') return String(short.dynamic).trim();
  if (short.dynamic && typeof short.dynamic === 'object') {
    return String(short.dynamic.link || short.dynamic.url || '').trim();
  }
  return String(short.dynamicLink || short.link || '').trim();
}

function consultQrCandidates(payload) {
  const data = unwrapProtocolPayload(payload);
  if (!data || typeof data !== 'object') return [];
  const values = [
    data.qrCode,
    data.qrcode,
    data.qrCodeText,
    data.qrCodeData,
    data.shortUrl,
    data.short_url,
    data.shortURL,
    nestedShortDynamicLink(data),
    data.dynamicLink,
    data.dynamic_link,
    data.deeplink,
    data.deepLink,
  ];
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || isPlaceholderQrValue(text) || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function consultQrPayload(payload) {
  const candidates = consultQrCandidates(payload);
  if (!candidates.length) return '';
  const emv = candidates.find((item) => /^000201/.test(item) || /^data:image\//i.test(item));
  if (emv) return emv;
  const url = candidates.find((item) => /^https?:\/\//i.test(item));
  if (url) return url;
  const shortCode = candidates.find((item) => /^GCSHLNKV/i.test(item));
  if (shortCode) return shortCode;
  return candidates[0];
}

function consultQrKind(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^data:image\//i.test(text)) return 'image';
  if (/^000201/.test(text)) return 'emv';
  if (/^GCSHLNKV/i.test(text)) return 'gcshlnkv';
  if (/short\.dynamic\.link/i.test(text) || /^https?:\/\//i.test(text)) return 'short_url';
  return 'payload';
}

function gcashRpcHeaders(operationType, { form = false } = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': form
      ? 'application/x-www-form-urlencoded;charset=UTF-8'
      : 'application/json',
    Origin: 'https://m.gcash.com',
    Referer: 'https://m.gcash.com/',
    'Operation-Type': String(operationType || ''),
    AppId: GCASH_RPC_APP_ID,
    WorkspaceId: GCASH_RPC_WORKSPACE,
    workspaceId: GCASH_RPC_WORKSPACE,
    Tenantid: GCASH_RPC_TENANT,
  };
}

function buildGcashFormRpcRequest(operationType, requestData) {
  const payload = Array.isArray(requestData) ? requestData : [requestData];
  return {
    url: GCASH_RPC_URL,
    method: 'POST',
    headers: gcashRpcHeaders(operationType, { form: true }),
    form: {
      operationType: String(operationType || ''),
      requestData: JSON.stringify(payload),
      version: '2.0',
      workspaceId: GCASH_RPC_WORKSPACE,
      appId: GCASH_RPC_APP_ID,
      tenantId: GCASH_RPC_TENANT,
    },
  };
}

function pollTokenId(auth) {
  const current = String(auth?.tokenId || '').trim();
  if (current) return current;
  const next = randomUUID();
  if (auth && typeof auth === 'object') auth.tokenId = next;
  return next;
}

function gcashEnvInfo(auth) {
  const browserVersion = String(auth?.browserVersion || auth?.chromeMajor || '136').replace(/\D.*$/, '') || '136';
  return {
    tokenId: pollTokenId(auth),
    osType: 'WindowsNT',
    osVersion: '10.0',
    browserType: 'Chrome',
    browserVersion,
    terminalType: 'WEB',
  };
}

function consultSessionUuid(payload) {
  const data = unwrapProtocolPayload(payload);
  return String(
    data?.uuid
    || payload?.result?.uuid
    || payload?.data?.uuid
    || '',
  ).trim();
}

function rememberPollToken(auth, payload) {
  const data = unwrapProtocolPayload(payload);
  const tid = String(
    data?.tokenId
    || data?.envInfo?.tokenId
    || data?.extendInfo?.tokenId
    || '',
  ).trim();
  if (tid && auth && typeof auth === 'object') auth.tokenId = tid;
  return tid;
}

function rememberConsultSession(auth, payload) {
  rememberPollToken(auth, payload);
  const uuid = consultSessionUuid(payload);
  if (uuid && auth && typeof auth === 'object') auth.consultUuid = uuid;
  return uuid;
}

function isCheckoutVerifyUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    return (host === 'chatgpt.com' || host.endsWith('.chatgpt.com'))
      && /\/checkout\/verify$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isAdyenPaymentReturnUrl(url) {
  const host = hostnameOf(url);
  return host.includes('adyen.com') && /checkoutPaymentReturn/i.test(String(url || ''));
}

function isAdyenCheckoutUrl(url) {
  const host = hostnameOf(url);
  if (!host.includes('adyen.com')) return false;
  return /checkoutPaymentReturn|checkoutPaymentRedirect|checkoutshopper/i.test(String(url || ''));
}

function extractRedirectResult(text) {
  const raw = String(text || '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const value = String(
      parsed.searchParams.get('redirectResult') || parsed.searchParams.get('redirect_result') || '',
    ).trim();
    if (value) return value;
  } catch {
    /* not a URL */
  }
  const match = raw.match(/(?:redirectResult|redirect_result)=([^&\s"'<>]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function protocolSuccessFlag(payload) {
  const data = unwrapProtocolPayload(payload);
  return data?.success === true || data?.success === 'true' || data?.success === 'TRUE';
}

function parseCheckoutVerifyUrl(url) {
  const raw = String(url || '').trim();
  if (!isCheckoutVerifyUrl(raw)) return null;
  try {
    const parsed = new URL(raw);
    return {
      verifyUrl: parsed.toString(),
      redirectResult: String(parsed.searchParams.get('redirectResult') || '').trim(),
      checkoutSessionId: String(parsed.searchParams.get('stripe_session_id') || '').trim(),
      processorEntity: String(parsed.searchParams.get('processor_entity') || '').trim(),
      currency: String(parsed.searchParams.get('currency') || '').trim(),
    };
  } catch {
    return null;
  }
}

function checkoutVerifySafeView(parsed) {
  return {
    has_verify: Boolean(parsed?.verifyUrl),
    has_redirect_result: Boolean(parsed?.redirectResult),
    checkout_session_id: String(parsed?.checkoutSessionId || ''),
    processor_entity: String(parsed?.processorEntity || ''),
    currency: String(parsed?.currency || ''),
  };
}

function chatgptVerifyHeaders(verifyUrl, path) {
  const referer = String(verifyUrl || '').trim();
  const { GCASH_CHAT } = require('./paymentLink');
  return {
    Referer: referer || 'https://chatgpt.com/checkout/verify',
    'Accept-Language': GCASH_CHAT.acceptLanguage,
    'oai-language': GCASH_CHAT.oaiLanguage,
    'x-openai-target-path': path,
    'x-openai-target-route': path,
  };
}

function buildGcashConsultRequest(auth) {
  const pageUrl = String(auth?.pageUrl || '').trim();
  return buildGcashFormRpcRequest(GCASH_AUTH_STATELESS_CONSULT, {
    bizType: 'ACQUIRING',
    channel: 'aggregator',
    envInfo: gcashEnvInfo(auth),
    expireSeconds: 300,
    extParams: {},
    originalUrl: pageUrl,
    urlParameters: authPageQueryString(pageUrl),
  });
}

function buildGcashPollRequest(auth) {
  return buildGcashFormRpcRequest(GCASH_QUERY_RESULT, {
    envInfo: gcashEnvInfo(auth),
    uuid: String(auth?.consultUuid || '').trim(),
    extParams: {},
  });
}

function buildGcashContinueRequest({
  checkoutSessionId, customPaymentMethodTypeId, redirectResult, verifyUrl,
} = {}) {
  const json = {
    checkout_session_id: String(checkoutSessionId || '').trim(),
  };
  const cpmId = String(customPaymentMethodTypeId || '').trim();
  if (cpmId) json.custom_payment_method_type_id = cpmId;
  const result = String(redirectResult || '').trim();
  if (result) json.redirect_result = result;
  return {
    path: CHATGPT_CONTINUE_PATH,
    method: 'POST',
    json,
    verifyUrl: String(verifyUrl || '').trim(),
  };
}

function continueRequestSafeView(request) {
  return {
    path: String(request?.path || ''),
    method: String(request?.method || 'POST').toUpperCase(),
    body_keys: Object.keys(request?.json || {}).sort(),
  };
}

function continueErrorCode(data) {
  if (!data || typeof data !== 'object') return '';
  const nested = data.error && typeof data.error === 'object' ? data.error : null;
  const detail = typeof data.detail === 'string' ? data.detail : '';
  const raw = nested?.code
    || data.code
    || data.error_code
    || nested?.type
    || data.type
    || (typeof data.error === 'string' ? data.error : '')
    || (detail && detail.length < 80 && !/redirectResult/i.test(detail) ? detail : '');
  return String(raw || '').replace(/redirectResult=[^&\s]+/gi, 'redirectResult=*').slice(0, 80);
}

function continueResponseData(response) {
  let data = response?.data;
  if (data && typeof data === 'object') return data;
  const text = String(response?.text || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function continueResponseSafeView(response) {
  const status = Number(response?.status) || 0;
  const data = continueResponseData(response);
  return {
    status,
    body_keys: data && !Array.isArray(data) ? Object.keys(data).sort() : [],
    error_code: continueErrorCode(data),
  };
}

async function postGcashRpc(session, built) {
  if (!session?.request || !built?.url) {
    return { status: 0, data: null, text: '' };
  }
  const options = {
    method: built.method,
    headers: built.headers,
    timeout: 30000,
    redirect: 'manual',
  };
  if (built.form) options.form = built.form;
  else options.json = built.json;
  const response = await session.request(built.url, options);
  let data = response?.data;
  if (data == null && response?.text) {
    try { data = JSON.parse(String(response.text)); } catch { data = null; }
  }
  return {
    status: Number(response?.status) || 0,
    data,
    text: String(response?.text || ''),
    url: String(response?.url || ''),
  };
}

async function consultGcashQr(session, auth, emit) {
  if (!auth?.ready) return { qr: '', payload: null, raw: '', kind: '', uuid: '' };
  emit?.('qr', '正在用 GCash stateless consult 取真码（EMV / GCSHLNKV / shortUrl）。');
  const built = buildGcashConsultRequest(auth);
  const response = await postGcashRpc(session, built);
  const uuid = rememberConsultSession(auth, response.data);
  const raw = consultQrPayload(response.data);
  const kind = consultQrKind(raw);
  if (!raw) return { qr: '', payload: response.data, raw: '', kind: '', uuid };
  if (/^data:image\//i.test(raw) && !isPlaceholderQrValue(raw)) {
    return { qr: raw, payload: response.data, raw, kind: kind || 'image', uuid };
  }
  const { looksLikeQrPayload, qrPayloadToDataUrl } = require('./gcashQr');
  if (looksLikeQrPayload(raw) || /^000201/.test(raw) || /^GCSHLNKV/i.test(raw)) {
    const image = await qrPayloadToDataUrl(raw);
    if (image) return { qr: image, payload: response.data, raw, kind: kind || 'payload', uuid };
  }
  return { qr: '', payload: response.data, raw, kind, uuid };
}

async function pollGcashScan(session, auth, emit) {
  if (!auth?.ready) return { complete: false, payload: null };
  const built = buildGcashPollRequest(auth);
  const response = await postGcashRpc(session, built);
  rememberPollToken(auth, response.data);
  const complete = isGcashScanComplete(response.data);
  if (complete) {
    emit?.('pay', '协议轮询检测到扫码完成，先跟 Adyen return / checkout/verify，再 continue');
  }
  return {
    complete,
    payload: response.data,
    redirectUrl: scanRedirectUrl(response.data),
    keys: protocolKeyList(response.data),
  };
}

async function followScanRedirect(session, redirectUrl, emit) {
  const target = String(redirectUrl || '').trim();
  const already = parseCheckoutVerifyUrl(target);
  if (already) {
    emit?.('pay', '扫码回跳已是 /checkout/verify，准备 continue');
    return { ok: true, ...already };
  }
  if (!target || !session?.request || !/^https?:\/\//i.test(target)) return { ok: false };
  try {
    const host = hostnameOf(target);
    emit?.('pay', `正在跟随扫码后的 return（${host || 'unknown'}）到 /checkout/verify。`);
    const response = await session.request(target, { method: 'GET', timeout: 30000, redirect: 'follow' });
    const finalUrl = String(response?.url || target).trim();
    const verify = parseCheckoutVerifyUrl(finalUrl);
    if (verify) {
      emit?.('pay', '已落到 /checkout/verify，准备 continue');
      return { ok: true, ...verify };
    }
    return { ok: Boolean(isAdyenPaymentReturnUrl(target) || host), verifyUrl: '', redirectResult: '' };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  GCASH_RPC_URL,
  GCASH_RPC_APP_ID,
  GCASH_AUTH_STATELESS_CONSULT,
  GCASH_QUERY_RESULT,
  GCASH_QUERY_ACCESS_TOKEN,
  GCASH_POLL_INTERVAL_MS,
  GCASH_QR_TTL_MS,
  GCASH_URL_TTL_MS,
  GCASH_POLL_TIMEOUT_MS,
  CHATGPT_CONTINUE_PATH,
  PROTOCOL_KEYS,
  hostnameOf,
  isGcashAuthPage,
  isGcashRpcUrl,
  parseGcashAuthPage,
  authPageQueryString,
  safeAuthView,
  preferReadyGcashLink,
  unwrapProtocolPayload,
  protocolKeyList,
  isGcashScanComplete,
  scanRedirectUrl,
  redirectFlag,
  remainingTtlMs,
  formatCountdown,
  qrNeedsRefresh,
  consultQrPayload,
  consultQrKind,
  gcashEnvInfo,
  rememberConsultSession,
  buildGcashConsultRequest,
  buildGcashPollRequest,
  buildGcashContinueRequest,
  parseCheckoutVerifyUrl,
  checkoutVerifySafeView,
  chatgptVerifyHeaders,
  isAdyenPaymentReturnUrl,
  isAdyenCheckoutUrl,
  extractRedirectResult,
  protocolSuccessFlag,
  continueRequestSafeView,
  continueResponseSafeView,
  consultSessionUuid,
  consultGcashQr,
  pollGcashScan,
  followScanRedirect,
};
