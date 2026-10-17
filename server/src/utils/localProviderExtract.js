'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CHATGPT_RETRY_ATTEMPTS,
  PROVIDER_RETRY_ATTEMPTS,
  CHATGPT_TIMEOUT_MS,
  STRIPE_TIMEOUT_MS,
  CAMPAIGN_ID,
  GCASH_FAILURE_ATTEMPTS,
  openaiCheckoutPageAmountMinor,
  protoError,
  newId,
  chatgptAccountIdFromToken,
  accountEmailFromAccessToken,
  parseCheckoutResponse,
  checkoutCreateBody,
  checkoutUpdateBody,
  taxesBody,
  phBilling,
  chatgptCheckoutHeaders,
  chatgptCheckoutShortUrl,
  gcashRequestExtra,
  redactCheckoutId,
  gcashConfirmStatus,
  describeGcashConfirm,
  evaluateCheckoutUpdateResponse,
  isOaicsSessionId,
  findSubmissionAttempt,
  stripeContext,
  stripeElementsClientParams,
  stripeAdditionalElementsParams,
  stripeCustomTaxRegionBody,
  applyCustomTaxRegionAmount,
  stripeConfirmReturnUrl,
  stripePaymentPageParams,
  toOpenaiPayUrl,
  collectUrls,
  extractRedirectToUrl,
  isIgnoredResourceUrl,
  collectPaymentMethodTypes,
  recoverableExtractError,
  classifyCheckoutError,
  expectedAmount,
  DEFAULT_STRIPE_RUNTIME_VERSION,
  STRIPE_VERSION_FULL,
  gcashChatgptExtra,
  gcashSentinelHeaders,
  sessionCookieEntries,
  applyGcashProcessorEntity,
  gcashConfirmBody,
  gcashStartBody,
  GCASH_CHAT,
} = require('./paymentLink');
const {
  EXTRACT_BROWSER,
  EXTRACT_SAFARI_IMPERSONATE,
  withExtractSession,
  fingerprintFor,
  isUnsupportedImpersonateError,
  rememberUnsupportedImpersonate,
} = require('./extractHttp');
const {
  CHECKOUT_PATH,
  CHECK_PATH,
  proxyForRegion,
  billingForPaypalCountry,
  verifyProxyCountry,
  seedSession,
  checkEligibility,
  chatgptRequest,
  stripeRequest,
  stripeInit,
  serializeCheckout,
  mergeCheckout,
  stripePublishableKey,
  withRetries,
  raiseIfSubmissionFailed,
  submitTaxes,
  snapshotBilling,
  chatgptApprove,
  stripeElements,
  responseDetail,
  compactText,
} = require('./paypalExtract');
const { freshStickyProxy } = require('./stickyProxy');
const { isPlaceholderQrValue } = require('./gcashQr');
const { captureGcashH5Screenshot, isUsableGcashQrDataUrl, closeGcashH5 } = require('./gcashH5Screenshot');
const {
  parseGcashAuthPage,
  preferReadyGcashLink,
  safeAuthView,
  consultGcashQr,
  consultQrPayload,
  consultQrKind,
} = require('./gcashProtocol');
const { promoCampaignId } = require('./accountCheck');

const CHATGPT_ORIGIN = 'https://chatgpt.com/';
const STRIPE_JS_ORIGIN = 'https://js.stripe.com/';
const CHECKOUT_PROXY_SPACING_MS = 2500;
const DEBUG_HEADER_KEYS = Object.freeze([
  'authorization', 'cookie', 'set-cookie', 'openai-sentinel-token', 'oai-telemetry',
]);
const DEBUG_SECRET_KEYS = Object.freeze([
  'authorization', 'cookie', 'set-cookie', 'openai-sentinel-token', 'oai-telemetry',
  'access_token', 'accesstoken', 'redirectresult', 'password', 'secret',
]);
const DEBUG_QR_KEYS = Object.freeze(['qrcode', 'qr_code', 'qrcodedata', 'qrcodepayload', 'qrcodeimage']);

function gcashExtractDebugEnabled(options = {}) {
  if (options.debug === true) return true;
  const env = String(process.env.GCASH_EXTRACT_DEBUG || '').trim().toLowerCase();
  return env === '1' || env === 'true' || env === 'yes';
}

function gcashDebugTracePath(options = {}) {
  const requested = String(options.debugTracePath || process.env.GCASH_EXTRACT_DEBUG_TRACE || '').trim();
  if (requested) return requested;
  return path.join(os.tmpdir(), 'gcash-extract-debug-trace.json');
}

function debugIdPrefix(value) {
  const text = String(value || '').trim();
  if (/^oaics_/i.test(text)) return `${text.slice(0, 8)}…`;
  if (/^cs_live_/i.test(text)) return `${text.slice(0, 10)}…`;
  if (/^cs_test_/i.test(text)) return `${text.slice(0, 10)}…`;
  if (/^cpmt_/i.test(text)) return `${text.slice(0, 10)}…`;
  return text;
}

function debugEmailPrefix(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('@');
  if (at <= 0) return text ? '<email>' : '';
  return `${text.slice(0, at)}@…`;
}

function debugStripQuery(url) {
  try {
    const parsed = new URL(String(url || ''));
    const queryKeys = [...parsed.searchParams.keys()];
    parsed.search = '';
    parsed.hash = '';
    return { origin_path: `${parsed.origin}${parsed.pathname}`, query_keys: queryKeys };
  } catch {
    return { origin_path: String(url || '').split('?')[0], query_keys: [] };
  }
}

function debugHeaderFlags(headers) {
  const flags = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = String(key || '').toLowerCase();
    if (DEBUG_HEADER_KEYS.includes(name) || name === 'chatgpt-account-id') {
      flags[name.replace(/-/g, '_')] = Boolean(value);
    }
  }
  return flags;
}

function debugSentinelMeta(headers) {
  let raw = '';
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === 'openai-sentinel-token') {
      raw = String(value || '').trim();
      break;
    }
  }
  if (!raw) return { present: false };
  try {
    const parsed = JSON.parse(raw);
    return {
      present: true,
      flow: String(parsed?.flow || ''),
      has_p: Boolean(parsed?.p),
      has_c: Boolean(parsed?.c),
      has_t: Boolean(parsed?.t),
    };
  } catch {
    return { present: true, flow: '' };
  }
}

function debugIsSecretKey(key) {
  const name = String(key || '').replace(/[-_]/g, '').toLowerCase();
  return DEBUG_SECRET_KEYS.includes(name) || DEBUG_QR_KEYS.includes(String(key || '').replace(/-/g, '').toLowerCase());
}

function debugRedactJson(value, key = '', depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const name = String(key || '').toLowerCase();
    if (/email/i.test(name) && value.includes('@')) return debugEmailPrefix(value);
    if (/chatgpt[-_]?account[-_]?id/.test(name)) return { present: Boolean(value) };
    if (/redirectresult/i.test(name)) return value ? { present: true, length: value.length } : '';
    if (DEBUG_QR_KEYS.includes(name.replace(/-/g, '')) || name === 'qrcode') {
      return {
        length: value.length,
        placeholder: isPlaceholderQrValue(value),
        prefix: value.slice(0, 8),
      };
    }
    if (/redirecturl/i.test(name)) return debugStripQuery(value);
    if (/^(checkout_session_id|session_id|custom_payment_method_type_id|selected_payment_method_type)$/i.test(name)
      || (name === 'id' && /^(oaics_|cs_live_|cs_test_|cpmt_)/.test(value))) {
      return debugIdPrefix(value);
    }
    if (debugIsSecretKey(name) || /^eyJ[A-Za-z0-9_-]+\./.test(value)) {
      return value ? `<redacted len=${value.length}>` : '';
    }
    if (value.length > 800 && (/^data:image/i.test(value) || /^[A-Za-z0-9+/=_-]{400,}$/.test(value))) {
      return { redacted: 'long_blob', length: value.length, prefix: value.slice(0, 12) };
    }
    return value;
  }
  if (typeof value !== 'object' || depth > 12) return depth > 12 ? '<max_depth>' : value;
  if (seen.has(value)) return '<cycle>';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => debugRedactJson(item, String(index), depth + 1, seen));
  }
  const out = {};
  for (const [childKey, child] of Object.entries(value)) {
    out[childKey] = debugRedactJson(child, childKey, depth + 1, seen);
  }
  return out;
}

function debugRequestSummary(options = {}, parsedUrl = {}) {
  const json = options.json && typeof options.json === 'object' ? options.json : null;
  const form = options.form && typeof options.form === 'object' ? options.form : null;
  const keys = json ? Object.keys(json) : form ? Object.keys(form) : [];
  const cpm = json?.selected_payment_method_type || json?.custom_payment_method_type_id || '';
  const methods = json?.custom_payment_methods;
  let paymentPrefix;
  if (typeof cpm === 'string' && cpm) paymentPrefix = debugIdPrefix(cpm);
  else if (Array.isArray(methods) && methods[0]?.id) paymentPrefix = debugIdPrefix(methods[0].id);
  else if (Array.isArray(json?.payment_method_types)) paymentPrefix = json.payment_method_types.slice(0, 6);
  return {
    host: parsedUrl.host || '',
    path: parsedUrl.path || '',
    keys,
    promo: json?.promo_campaign || undefined,
    country: json?.billing_details?.country || json?.country || undefined,
    currency: json?.billing_details?.currency || json?.currency || undefined,
    plan: json?.plan_name || undefined,
    processor_entity: json?.processor_entity || undefined,
    payment_method_type_prefix: paymentPrefix,
    checkout_session_id_prefix: debugIdPrefix(json?.checkout_session_id || ''),
    header_flags: debugHeaderFlags(options.headers),
    sentinel: debugSentinelMeta(options.headers),
    operation_type: options.headers?.['Operation-Type'] || options.headers?.['operation-type'] || undefined,
  };
}

function debugParseUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return { host: parsed.hostname, path: parsed.pathname, href: `${parsed.origin}${parsed.pathname}` };
  } catch {
    return { host: '', path: String(url || ''), href: String(url || '') };
  }
}

function debugResponsePayload(response, parsedUrl) {
  const text = String(response?.text || '');
  const contentType = String(
    response?.headers?.['content-type'] || response?.headers?.['Content-Type'] || '',
  ).toLowerCase();
  if (response?.data && typeof response.data === 'object') {
    return debugRedactJson(response.data);
  }
  if (contentType.includes('json') || (text.startsWith('{') || text.startsWith('['))) {
    try { return debugRedactJson(JSON.parse(text)); } catch { /* fall through */ }
  }
  return {
    kind: contentType.includes('html') || /<html/i.test(text) ? 'html' : 'text',
    length: text.length,
    has_placeholder_qr: isPlaceholderQrValue(text),
    has_adyen: /adyen/i.test(text) || /adyen\.com/i.test(parsedUrl.host || ''),
    has_gcash: /gcash/i.test(text) || /gcash\.com/i.test(parsedUrl.host || ''),
  };
}

function createGcashDebugTrace(filePath) {
  const trace = {
    filePath,
    started_at: new Date().toISOString(),
    steps: [],
  };
  const flush = () => {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify({
        started_at: trace.started_at,
        updated_at: new Date().toISOString(),
        steps: trace.steps,
      }, null, 2)}\n`);
    } catch { /* debug file is best-effort */ }
  };
  return {
    filePath,
    steps: trace.steps,
    push(step) {
      trace.steps.push(step);
      flush();
    },
    note(event, data = {}) {
      trace.steps.push({ event, at: new Date().toISOString(), ...data });
      flush();
    },
    flush,
  };
}

function wrapSessionForDebugTrace(session, debugTrace) {
  if (!session || typeof session.request !== 'function' || !debugTrace) return session;
  const original = session.request.bind(session);
  session.request = async (url, options = {}) => {
    const parsed = debugParseUrl(url);
    if (/custom_payment_method\/continue/i.test(parsed.path || '')) {
      debugTrace.note('blocked_continue', { method: String(options.method || 'POST').toUpperCase(), path: parsed.path });
      throw protoError('debug mode stops before custom_payment_method/continue', {
        status: 409,
        code: 'GCASH_DEBUG_NO_CONTINUE',
        recoverable: false,
      });
    }
    const started = Date.now();
    const method = String(options.method || 'GET').toUpperCase();
    const request = debugRequestSummary(options, parsed);
    try {
      const response = await original(url, options);
      debugTrace.push({
        method,
        host: parsed.host,
        path: parsed.path,
        http: Number(response?.status) || 0,
        t_ms: Date.now() - started,
        request,
        response: debugResponsePayload(response, parsed),
      });
      return response;
    } catch (error) {
      debugTrace.push({
        method,
        host: parsed.host,
        path: parsed.path,
        http: Number(error?.status) || 0,
        t_ms: Date.now() - started,
        request,
        error: compactText(String(error?.message || error), 240),
        code: error?.code || '',
      });
      throw error;
    }
  };
  return session;
}

function emvQrAmount(payload) {
  const text = String(payload || '');
  if (!/^000201/.test(text)) return '';
  let index = 0;
  while (index + 4 <= text.length) {
    const id = text.slice(index, index + 2);
    const length = Number(text.slice(index + 2, index + 4));
    if (!Number.isFinite(length) || length < 0) break;
    const value = text.slice(index + 4, index + 4 + length);
    if (id === '54') return value;
    index += 4 + length;
  }
  return '';
}

function describeDebugAmount(amount, formatted, source) {
  const value = amount == null ? 'missing' : String(amount);
  return `amount=${value}${formatted ? ` (${formatted})` : ''}${source ? ` source=${source}` : ''}`;
}

const CHANNEL_SPECS = Object.freeze({
  upi: {
    id: 'upi',
    method: 'upi',
    country: 'IN',
    currency: 'INR',
    updateCountry: 'VN',
    impersonate: '',
    bank: '',
    locale: 'en',
    timezone: 'Asia/Kolkata',
    resultHost: 'stripe.com',
    flow: 'stripe',
    preferredHosts: ['stripe.com'],
  },
  pix: {
    id: 'pix',
    method: 'pix',
    country: 'BR',
    currency: 'BRL',
    updateCountry: 'VN',
    impersonate: '',
    bank: '',
    locale: 'pt-BR',
    timezone: 'America/Sao_Paulo',
    resultHost: 'stripe.com',
    flow: 'stripe',
    preferredHosts: ['stripe.com'],
  },
  ideal: {
    id: 'ideal',
    method: 'ideal',
    country: 'NL',
    currency: 'EUR',
    updateCountry: 'VN',
    impersonate: EXTRACT_SAFARI_IMPERSONATE,
    bank: 'ing',
    locale: 'nl',
    timezone: 'Europe/Amsterdam',
    resultHost: 'stripe.com',
    flow: 'stripe',
    preferredHosts: [
      'ing.nl', 'ideal.nl', 'ideal.com', 'rabobank.nl', 'abnamro.nl',
      'hooks.stripe.com', 'redirect.stripe.com',
    ],
  },
  twint: {
    id: 'twint',
    method: 'twint',
    country: 'CH',
    currency: 'CHF',
    updateCountry: '',
    impersonate: '',
    bank: '',
    locale: 'de',
    timezone: 'Europe/Zurich',
    resultHost: 'twint.ch',
    flow: 'stripe',
    preferredHosts: ['twint.ch', 'stripe.com'],
  },
  blik: {
    id: 'blik',
    method: 'blik',
    country: 'PL',
    currency: 'PLN',
    updateCountry: '',
    impersonate: '',
    bank: '',
    locale: 'pl',
    timezone: 'Europe/Warsaw',
    resultHost: 'stripe.com',
    flow: 'stripe',
    preferredHosts: ['blik.com'],
  },
  kakao_pay: {
    id: 'kakao_pay',
    method: 'kakao_pay',
    country: 'KR',
    currency: 'KRW',
    updateCountry: '',
    impersonate: '',
    bank: '',
    locale: 'ko',
    timezone: 'Asia/Seoul',
    resultHost: 'kakaopay.com',
    flow: 'stripe',
    preferredHosts: ['kakaopay.com', 'kakao.com'],
  },
  naver_pay: {
    id: 'naver_pay',
    method: 'naver_pay',
    country: 'KR',
    currency: 'KRW',
    updateCountry: '',
    impersonate: '',
    bank: '',
    locale: 'ko',
    timezone: 'Asia/Seoul',
    resultHost: 'pay.naver.com',
    flow: 'stripe',
    preferredHosts: ['pay.naver.com', 'naver.com'],
  },
  gcash: {
    id: 'gcash',
    method: 'gcash',
    country: 'PH',
    currency: 'PHP',
    updateCountry: 'PH',
    skipCheckoutUpdate: false,
    impersonate: EXTRACT_BROWSER,
    bank: '',
    locale: 'en',
    timezone: 'Asia/Manila',
    resultHost: 'adyen.com',
    flow: 'adyen',
    preferredHosts: ['checkoutshopper-live.adyen.com', 'adyen.com', 'm.gcash.com'],
  },
});

const FALLBACK_BILLING = Object.freeze({
  IN: { name: 'Rahul Sharma', line1: '12 MG Road', city: 'Bengaluru', state: 'KA', postal_code: '560001' },
  BR: { name: 'Joao Silva', line1: 'Avenida Paulista 1000', city: 'Sao Paulo', state: 'SP', postal_code: '01310-100' },
  NL: { name: 'Jan de Vries', line1: 'Damrak 88', city: 'Amsterdam', state: 'NH', postal_code: '1012 LP' },
  CH: { name: 'Luca Meier', line1: 'Bahnhofstrasse 10', city: 'Zurich', state: 'ZH', postal_code: '8001' },
  PL: { name: 'Jan Kowalski', line1: 'Nowy Swiat 6', city: 'Warsaw', state: 'MZ', postal_code: '00-400' },
  KR: { name: 'Kim Minjun', line1: 'Teheran-ro 123', city: 'Seoul', state: 'Seoul', postal_code: '06134' },
  PH: { name: 'Juan Dela Cruz', line1: 'Ayala Avenue 100', city: 'Manila', state: 'Metro Manila', postal_code: '1000' },
});

const IDEAL_BANK_HOSTS = Object.freeze([
  'ideal.com', 'ideal.nl', 'ing.nl', 'rabobank.nl', 'abnamro.nl', 'asn.nl',
  'bunq.com', 'knab.nl', 'n26.com', 'regiobank.nl', 'snsbank.nl', 'sns.nl',
  'triodos.nl', 'vanlanschotkempen.com', 'handelsbanken.nl', 'mollie.com', 'adyen.com',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function channelSpec(channelId) {
  const spec = CHANNEL_SPECS[String(channelId || '').trim()];
  if (!spec) {
    throw protoError(`未知本地支付通道：${channelId || ''}`, {
      status: 400,
      code: 'LOCAL_CHANNEL_UNKNOWN',
      recoverable: false,
    });
  }
  return spec;
}

function wiredLocalChannelIds() {
  return Object.keys(CHANNEL_SPECS);
}

function impersonateForChannel(channelId) {
  const spec = channelSpec(channelId);
  return spec.impersonate || EXTRACT_BROWSER;
}

function checkoutBodyForChannel(channelId) {
  const spec = channelSpec(channelId);
  return checkoutCreateBody({
    country: spec.country,
    currency: spec.currency,
    uiMode: 'custom',
    promoEnabled: spec.id !== 'gcash',
    promoQuery: false,
  });
}

function channelChatgptExtra(spec, extra = {}) {
  if (spec?.id === 'gcash' || spec?.method === 'gcash') return gcashChatgptExtra(extra);
  return extra;
}

async function checkGcashAccounts(session, detail, deviceId, sessionId, emit, debug = false) {
  emit('eligibility', '正在通过 PH 调用 accounts/check（r19：资格、建单与优惠 update 全程菲律宾出口）。');
  const extra = await gcashRequestExtra(session, deviceId, {
    Accept: 'application/json',
    Origin: 'https://chatgpt.com',
    Referer: CHATGPT_ORIGIN,
  });
  const response = await chatgptRequest(session, detail, deviceId, sessionId, CHECK_PATH, {
    method: 'GET',
    extra,
    includeAccountId: true,
  });
  const status = Number(response.status) || 0;
  emit('eligibility', `accounts/check HTTP ${status}。`);
  const bodyText = `${response.text || ''} ${JSON.stringify(response.data || {})}`.toLowerCase();
  if (status === 401 && /token[_ -]?invalidated|token[_ -]?expired/.test(bodyText)) {
    throw protoError('账号 Token 已被作废，请重新导入有效的 Access Token', {
      status: 401,
      code: 'ACCOUNT_TOKEN_INVALIDATED',
      skip: true,
    });
  }
  if (status >= 400) {
    throw protoError(`accounts/check HTTP ${status}`, {
      status: status || 502,
      code: 'ACCOUNT_ELIGIBILITY_CHECK',
      recoverable: true,
    });
  }
  const payload = response.data && typeof response.data === 'object' ? response.data : {};
  const accountId = detail.chatgpt_account_id || chatgptAccountIdFromToken(detail.access_token) || '';
  const campaign = String(promoCampaignId(payload, accountId) || '').trim();
  if (campaign.toLowerCase() === CAMPAIGN_ID) {
    emit('eligibility', `账号资格检查通过：PH 返回 ${CAMPAIGN_ID}。`);
    return { response, campaign };
  }
  if (debug) {
    emit(
      'eligibility',
      `DEBUG 继续：accounts/check 未返回 ${CAMPAIGN_ID}（${campaign || 'eligible_promo_campaigns 为空'}）。`,
    );
    return { response, campaign: '' };
  }
  throw protoError('账号没有 plus-1-month-free 试用资格', {
    status: 409,
    code: 'ACCOUNT_NOT_ELIGIBLE',
    recoverable: false,
  });
}

async function openGcashCheckoutPage(session, detail, deviceId, sessionId, checkout, emit) {
  const pageUrl = chatgptCheckoutShortUrl(
    checkout.cs_id,
    checkout.billing_country || 'PH',
    checkout.processor_entity,
  );
  let path = '/checkout';
  try { path = new URL(pageUrl).pathname; } catch { /* keep */ }
  emit('checkout', 'checkout/update 未返回金额，正在 GET OpenAI checkout 页做最终金额校验。');
  const extra = await gcashRequestExtra(session, deviceId, {
    Referer: CHATGPT_ORIGIN,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  const response = await chatgptRequest(session, detail, deviceId, sessionId, path, {
    method: 'GET',
    extra,
  });
  emit('checkout', `checkout 页 GET HTTP ${Number(response.status) || 0}。`);
  return response;
}

async function applyGcashCheckoutPageAmount(session, detail, deviceId, sessionId, checkout, spec, emit) {
  const page = await openGcashCheckoutPage(session, detail, deviceId, sessionId, checkout, emit);
  const parsed = openaiCheckoutPageAmountMinor(page.text, checkout);
  if (parsed.amount === 0) {
    return acceptZeroPromotion(checkout, {
      amount: 0,
      source: 'checkout_page.total.minorUnitsAmount',
      formatted: parsed.currency ? `0.00 ${parsed.currency}` : '0',
    }, emit, spec.country, 'checkout page');
  }
  if (parsed.amount == null) {
    throw protoError('checkout/update 没有返回明确金额，无法确认 0 元优惠', {
      status: 409,
      code: 'CHECKOUT_PROMOTION',
      recoverable: true,
    });
  }
  throw protoError(
    `checkout 页面支付金额不是0元，当前 ${parsed.amount} ${parsed.currency || spec.currency}`,
    { status: 409, code: 'PAYMENT_AMOUNT_NOT_ZERO', recoverable: false },
  );
}

function skipCheckoutUpdateForChannel(channelId) {
  return channelSpec(channelId).skipCheckoutUpdate === true;
}

function updateCountryForChannel(channelId) {
  const spec = channelSpec(channelId);
  if (spec.skipCheckoutUpdate) return '';
  return spec.updateCountry || spec.country;
}

function requireGcashOaicsCheckout(checkout) {
  const csId = String(checkout?.cs_id || '').trim();
  if (isOaicsSessionId(csId)) return checkout;
  throw protoError(`GCash 需要 oaics_ checkout，当前返回 ${redactCheckoutId(csId) || '空'}`, {
    status: 409,
    code: 'GCASH_OAICS_REQUIRED',
    recoverable: true,
  });
}

function nestedValue(payload, key) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(payload, key)) return payload[key];
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = nestedValue(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const value of Object.values(payload)) {
    const found = nestedValue(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hasNestedKey(payload, target) {
  if (Array.isArray(payload)) return payload.some((item) => hasNestedKey(item, target));
  if (!payload || typeof payload !== 'object') return false;
  for (const [key, value] of Object.entries(payload)) {
    if (key === target) return true;
    if (hasNestedKey(value, target)) return true;
  }
  return false;
}

function hasNestedStringValue(payload, target) {
  if (typeof payload === 'string') return payload.trim().toLowerCase() === String(target).toLowerCase();
  if (Array.isArray(payload)) return payload.some((item) => hasNestedStringValue(item, target));
  if (!payload || typeof payload !== 'object') return false;
  return Object.values(payload).some((value) => hasNestedStringValue(value, target));
}

function hostnameOf(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isExternalHttpUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text) || isIgnoredResourceUrl(text)) return false;
  const host = hostnameOf(text);
  return Boolean(host) && !['chatgpt.com', 'pay.openai.com', 'openai.com'].includes(host);
}

function generateBrazilCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(base).size === 1) return generateBrazilCpf();
  const firstSum = base.reduce((sum, digit, index) => sum + digit * (10 - index), 0);
  const first = firstSum % 11 < 2 ? 0 : 11 - (firstSum % 11);
  const secondBase = [...base, first];
  const secondSum = secondBase.reduce((sum, digit, index) => sum + digit * (11 - index), 0);
  const second = secondSum % 11 < 2 ? 0 : 11 - (secondSum % 11);
  const digits = [...base, first, second].join('');
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function fallbackBilling(country, email = '') {
  const profile = FALLBACK_BILLING[country] || FALLBACK_BILLING.NL;
  const suffix = String(10000 + Math.floor(Math.random() * 89999));
  return {
    name: profile.name,
    email: email || `buyer${suffix}@gmail.com`,
    phone: '',
    tax_id: country === 'BR' ? generateBrazilCpf() : '',
    country,
    line1: profile.line1,
    line2: '',
    city: profile.city,
    state: profile.state,
    postal_code: profile.postal_code,
  };
}

async function billingForChannel(spec, email, fetchImpl) {
  if (spec.id === 'gcash') {
    return phBilling();
  }
  const generated = await billingForPaypalCountry(spec.country, email, fetchImpl);
  if (String(generated?.country || '').toUpperCase() === spec.country && generated.line1 && generated.city) {
    if (spec.method === 'pix' && !generated.tax_id) generated.tax_id = generateBrazilCpf();
    return generated;
  }
  return fallbackBilling(spec.country, email);
}

function isIdealRedirectUrl(value) {
  const host = hostnameOf(value);
  if (!isExternalHttpUrl(value) || !host) return false;
  if (host === 'hooks.stripe.com' || host === 'redirect.stripe.com') return true;
  return IDEAL_BANK_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

function isAdyenGcashRedirect(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('checkoutshopper-live.adyen.com') || text.includes('m.gcash.com');
}

function extractUpiRedirectUrl(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const nextAction = payload.next_action;
    if (nextAction && typeof nextAction === 'object') {
      const upi = nextAction.upi_handle_redirect_or_display_qr_code;
      if (upi && typeof upi === 'object') {
        const hosted = String(upi.hosted_instructions_url || '').trim();
        if (hosted && isExternalHttpUrl(hosted)) return hosted;
        const qr = upi.qr_code && typeof upi.qr_code === 'object' ? upi.qr_code : {};
        for (const key of ['image_url_png', 'image_url_svg']) {
          const image = String(qr[key] || '').trim();
          if (image && isExternalHttpUrl(image)) return image;
        }
      }
    }
    for (const key of ['payment_intent', 'setup_intent']) {
      const nested = extractUpiRedirectUrl(payload[key]);
      if (nested) return nested;
    }
  }
  const hosted = nestedValue(payload, 'hosted_instructions_url');
  return hosted && isExternalHttpUrl(hosted) ? String(hosted) : '';
}

function extractPixRedirectUrl(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const nextAction = payload.next_action;
    if (nextAction && typeof nextAction === 'object') {
      const pix = nextAction.pix_display_qr_code;
      if (pix && typeof pix === 'object') {
        const hosted = String(pix.hosted_instructions_url || '').trim();
        if (hosted && isExternalHttpUrl(hosted)) return hosted;
        for (const key of ['image_url_png', 'image_url_svg']) {
          const image = String(pix[key] || '').trim();
          if (image && isExternalHttpUrl(image)) return image;
        }
      }
    }
    for (const key of ['payment_intent', 'setup_intent']) {
      const nested = extractPixRedirectUrl(payload[key]);
      if (nested) return nested;
    }
  }
  const hosted = nestedValue(payload, 'hosted_instructions_url');
  if (hosted && isExternalHttpUrl(hosted)) return String(hosted);
  for (const key of ['image_url_png', 'image_url_svg']) {
    const image = nestedValue(payload, key);
    if (image && isExternalHttpUrl(image)) return String(image);
  }
  return '';
}

function extractIdealRedirectUrl(payload) {
  const redirect = extractRedirectToUrl(payload);
  if (redirect && isIdealRedirectUrl(redirect)) return redirect;
  return collectUrls(payload).find((item) => isIdealRedirectUrl(item)) || '';
}

function extractBlikRedirectUrl(payload) {
  if (hasNestedKey(payload, 'blik_authorize') || hasNestedStringValue(payload, 'blik_authorize')) {
    return { inApp: true, url: '' };
  }
  const urls = collectUrls(payload);
  const blik = urls.find((item) => {
    const blob = `${hostnameOf(item)} ${item}`.toLowerCase();
    return isExternalHttpUrl(item) && blob.includes('blik');
  });
  if (blik) return { inApp: false, url: blik };
  if (urls.some((item) => hostnameOf(item) === 'checkout.stripe.com')) {
    throw protoError('只拿到 Stripe Checkout 容器页，不是 BLIK 支付链接。', {
      status: 502,
      code: 'STRIPE_REDIRECT_RETRY',
      recoverable: true,
    });
  }
  return { inApp: false, url: '' };
}

function extractLocalRedirectUrl(method, payload) {
  if (method === 'upi') return extractUpiRedirectUrl(payload);
  if (method === 'pix') return extractPixRedirectUrl(payload);
  if (method === 'ideal') return extractIdealRedirectUrl(payload);
  if (method === 'blik') {
    const blik = extractBlikRedirectUrl(payload);
    return blik.inApp ? { inApp: true, url: '' } : blik.url;
  }
  return extractRedirectToUrl(payload) || collectUrls(payload).find((item) => isExternalHttpUrl(item)) || '';
}

function applyPixConfirmParams(body, initPayload) {
  const future = initPayload?.setup_future_usage_for_payment_method_type;
  if (future && future.pix != null) {
    body['setup_future_usage_for_payment_method_type[pix]'] = String(future.pix);
  }
  const setupIntent = initPayload?.setup_intent;
  if (setupIntent && typeof setupIntent === 'object' && setupIntent.usage != null) {
    body['setup_intent[usage]'] = String(setupIntent.usage);
  }
  const amount = Number(expectedAmount(initPayload));
  if (Number.isFinite(amount) && amount === 0) {
    delete body['elements_options_client[saved_payment_method][enable_save]'];
    delete body['elements_options_client[saved_payment_method][enable_redisplay]'];
    delete body['client_attribution_metadata[payment_intent_creation_flow]'];
  }
}

function localPaymentMethodBody(spec, checkout, stripePk, billing, ctx) {
  const runtime = ctx.runtime_version || DEFAULT_STRIPE_RUNTIME_VERSION;
  const body = {
    guid: ctx.guid || newId(),
    muid: ctx.muid || newId(),
    sid: ctx.sid || newId(),
    'billing_details[name]': billing.name || 'Alex Morgan',
    'billing_details[email]': billing.email || 'buyer@example.com',
    'billing_details[phone]': billing.phone || '',
    'billing_details[address][country]': billing.country || spec.country,
    'billing_details[address][line1]': billing.line1 || '',
    'billing_details[address][line2]': billing.line2 || '',
    'billing_details[address][city]': billing.city || '',
    'billing_details[address][postal_code]': billing.postal_code || '',
    'billing_details[address][state]': billing.state || '',
    type: spec.method === 'ideal' ? 'ideal' : spec.method,
    payment_user_agent: `stripe.js/${runtime}; stripe-js-v3/${runtime}; payment-element; deferred-intent`,
    referrer: 'https://chatgpt.com',
    time_on_page: String(25000 + Math.floor(Math.random() * 30000)),
    'client_attribution_metadata[checkout_session_id]': checkout.cs_id,
    'client_attribution_metadata[client_session_id]': ctx.stripe_js_id,
    'client_attribution_metadata[checkout_config_id]': ctx.config_id || '',
    'client_attribution_metadata[elements_session_id]': ctx.elements_session_id,
    'client_attribution_metadata[elements_session_config_id]': ctx.elements_session_config_id,
    'client_attribution_metadata[merchant_integration_source]': 'elements',
    'client_attribution_metadata[merchant_integration_subtype]': 'payment-element',
    'client_attribution_metadata[merchant_integration_version]': '2021',
    'client_attribution_metadata[payment_intent_creation_flow]': 'deferred',
    'client_attribution_metadata[payment_method_selection_flow]': 'automatic',
    ...stripeAdditionalElementsParams('client_attribution_metadata'),
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
  };
  if (spec.method === 'ideal' && spec.bank) body['ideal[bank]'] = spec.bank;
  if (spec.method === 'pix') body['billing_details[tax_id]'] = billing.tax_id || generateBrazilCpf();
  return body;
}

function localConfirmBody(spec, checkout, stripePk, initPayload, ctx, pmId, stripeHostedUrl) {
  const runtime = ctx.runtime_version || DEFAULT_STRIPE_RUNTIME_VERSION;
  const body = {
    guid: ctx.guid || newId(),
    muid: ctx.muid || newId(),
    sid: ctx.sid || newId(),
    payment_method: pmId,
    init_checksum: String(initPayload?.init_checksum || ctx.init_checksum || ''),
    version: runtime,
    expected_amount: String(ctx.checkout_amount || expectedAmount(initPayload)),
    expected_payment_method_type: spec.method,
    return_url: stripeConfirmReturnUrl(checkout.cs_id, checkout, stripeHostedUrl),
    ...stripeElementsClientParams({ ...ctx, locale: spec.locale || ctx.locale || 'en' }),
    'elements_options_client[saved_payment_method][enable_save]': 'never',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'never',
    'client_attribution_metadata[client_session_id]': String(ctx.stripe_js_id || ''),
    'client_attribution_metadata[checkout_session_id]': checkout.cs_id,
    'client_attribution_metadata[checkout_config_id]': String(ctx.config_id || ''),
    'client_attribution_metadata[elements_session_id]': String(ctx.elements_session_id || ''),
    'client_attribution_metadata[elements_session_config_id]': String(ctx.elements_session_config_id || ''),
    'client_attribution_metadata[merchant_integration_source]': 'checkout',
    'client_attribution_metadata[merchant_integration_subtype]': 'payment-element',
    'client_attribution_metadata[merchant_integration_version]': 'custom',
    'client_attribution_metadata[payment_intent_creation_flow]': 'deferred',
    'client_attribution_metadata[payment_method_selection_flow]': 'automatic',
    ...stripeAdditionalElementsParams('client_attribution_metadata'),
    'consent[terms_of_service]': 'accepted',
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
  };
  if (spec.method === 'pix') applyPixConfirmParams(body, initPayload);
  return body;
}

function ensureMethodAvailable(initPayload, method, label) {
  const available = collectPaymentMethodTypes(initPayload);
  if (available.size && !available.has(method)) {
    throw protoError(
      `当前 checkout 不支持 ${label}。`,
      { status: 409, code: 'PAYMENT_METHOD_UNAVAILABLE', recoverable: true },
    );
  }
}

function gcashMethodId(checkout) {
  const methods = Array.isArray(checkout?.custom_payment_methods) ? checkout.custom_payment_methods : [];
  return methods
    .map((item) => String(item?.id || '').trim())
    .find((id) => id.startsWith('cpmt_')) || '';
}

function cancelledError() {
  return protoError('任务已取消', { code: 'JOB_CANCELLED' });
}

function assertActive(cancelled) {
  if (cancelled?.()) throw cancelledError();
}

function staleCheckoutError(error) {
  const detail = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /checkout_not_active|inactive_session|session.*expir|checkout 已失效/.test(detail);
}

function locationHeader(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get('location') || headers.get('Location') || '').trim();
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'location') return String(value || '').trim();
  }
  return '';
}

function hostMatches(url, hosts) {
  const host = hostnameOf(url);
  return (hosts || []).some((item) => host === item || host.endsWith(`.${item}`));
}

async function followPreferredRedirect(session, url, preferredHosts) {
  let current = String(url || '').trim();
  if (!current) return '';
  if (hostMatches(current, preferredHosts)) return current;
  for (let hop = 1; hop <= 8; hop += 1) {
    if (!current) return '';
    if (hostMatches(current, preferredHosts)) return current;
    let response;
    try {
      response = await session.request(current, {
        method: 'GET',
        timeout: STRIPE_TIMEOUT_MS,
        redirect: 'manual',
      });
    } catch {
      return current;
    }
    const finalUrl = String(response.url || current);
    if (hostMatches(finalUrl, preferredHosts)) return finalUrl;
    const status = Number(response.status) || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = locationHeader(response.headers);
      if (location) {
        try {
          current = new URL(location.split(';')[0], finalUrl || current).href;
          continue;
        } catch {
          return current;
        }
      }
    }
    return finalUrl || current;
  }
  return current;
}

async function postLocalCheckout(session, detail, deviceId, sessionId, spec, extra = {}) {
  const headers = spec.id === 'gcash'
    ? await gcashRequestExtra(session, deviceId, {
      Referer: CHATGPT_ORIGIN,
      'x-openai-target-path': CHECKOUT_PATH,
      'x-openai-target-route': CHECKOUT_PATH,
      ...extra,
    })
    : channelChatgptExtra(spec, {
      Referer: CHATGPT_ORIGIN,
      'x-openai-target-path': CHECKOUT_PATH,
      'x-openai-target-route': CHECKOUT_PATH,
      ...extra,
    });
  return chatgptRequest(session, detail, deviceId, sessionId, CHECKOUT_PATH, {
    method: 'POST',
    json: checkoutBodyForChannel(spec.id),
    extra: headers,
  });
}

async function createLocalCheckout(session, detail, deviceId, sessionId, spec, emit, cancelled, proxy, debug = false) {
  assertActive(cancelled);
  return serializeCheckout(proxy, async () => {
    emit(
      'checkout',
      spec.id === 'gcash'
        ? `正在创建 ${spec.method} checkout（${spec.country}/${spec.currency}，建单不带优惠，随后 checkout/update 应用 ${CAMPAIGN_ID}）。`
        : `正在创建 ${spec.method} checkout（${spec.country}/${spec.currency}，优惠 ${CAMPAIGN_ID}）。`,
    );
    let response = await postLocalCheckout(session, detail, deviceId, sessionId, spec);
    if (spec.id === 'gcash' && Number(response.status) >= 400) {
      const unusual = classifyCheckoutError(response);
      if (unusual?.code === 'EXTRACT_CHECKOUT_UNUSUAL') {
        emit('sentinel', '纯协议建单被风控拒绝（unusual_activity），正在为同一会话动态生成 Sentinel 头重试。');
        const retrySentinel = await gcashSentinelHeaders(
          session, deviceId, 'https://chatgpt.com/', GCASH_CHAT.sentinelCreateFlow,
        );
        if (Object.keys(retrySentinel).length) {
          emit('checkout', 'Sentinel 同会话重试建单。');
        }
        response = await postLocalCheckout(session, detail, deviceId, sessionId, spec, retrySentinel);
      }
    }
    if (Number(response.status) >= 400 || !response.data) {
      const error = classifyCheckoutError(response);
      emit('checkout', compactText(error.message, 240));
      throw error;
    }
    const checkout = parseCheckoutResponse(response.data, spec.country, spec.currency, false);
    checkout.chatgpt_account_id = detail.chatgpt_account_id || chatgptAccountIdFromToken(detail.access_token) || '';
    checkout.create_http = Number(response.status) || 0;
    if (spec.id === 'gcash') {
      applyGcashProcessorEntity(checkout);
      try {
        requireGcashOaicsCheckout(checkout);
      } catch (error) {
        emit('checkout', `GCash 需要 oaics_ session，当前 ${redactCheckoutId(checkout.cs_id)}，已拒绝。`);
        throw error;
      }
      if (!gcashMethodId(checkout)) {
        emit('eligibility', 'checkout 未返回 cpmt_ 开头的 custom_payment_methods。');
        throw protoError('账号没有 GCash 试用资格（checkout 未返回 cpmt_）', {
          status: 409,
          code: 'ACCOUNT_NOT_ELIGIBLE',
          recoverable: false,
        });
      }
      const payable = evaluateCheckoutUpdateResponse(
        Number(response.status) || 200,
        response.data,
        response.text,
        { currency: spec.currency, payableOnly: true },
      );
      checkout.gcash_payable_amount = payable.amount;
      emit('checkout', `checkout 创建 HTTP ${checkout.create_http}：${redactCheckoutId(checkout.cs_id)} / ${spec.country} / ${spec.currency}。${payable.logReason}`);
      if (payable.amount === 0) {
        checkout.checkout_amount_minor = 0;
        checkout.amount_zero_source = payable.source;
        emit('promotion', `建单已是 0 元 source=${payable.source || 'unknown'}，仍走 checkout/update 对齐 r19。`);
      } else if (payable.amount != null) {
        emit(
          'checkout',
          `建单应付 ${describeDebugAmount(payable.amount, payable.formatted, payable.source)}，等待 checkout/update 应用优惠。`,
        );
        if (debug) {
          emit(
            'promotion',
            `DEBUG 继续：建单应付非 0 ${describeDebugAmount(payable.amount, payable.formatted, payable.source)}。`,
          );
        }
      }
    } else {
      emit('checkout', `checkout 创建成功：${redactCheckoutId(checkout.cs_id)} / ${spec.country} / ${spec.currency}。`);
    }
    return checkout;
  }, session.transport === 'curl_cffi' ? CHECKOUT_PROXY_SPACING_MS : 0);
}

function acceptZeroPromotion(merged, evaluated, emit, country, via = 'checkout/update') {
  merged.checkout_amount_minor = 0;
  emit('promotion', `零元校验通过 amount=0 source=${evaluated.source || 'unknown'}。`);
  emit('promotion', `${country} ${via} 金额检测通过：${evaluated.formatted || '0'}。`);
  return merged;
}

async function readGcashTaxesPayable(session, detail, deviceId, sessionId, checkout, spec, billing, emit, debug = false) {
  const path = '/backend-api/payments/checkout/taxes';
  const extra = await gcashRequestExtra(session, deviceId, chatgptCheckoutHeaders(checkout, path));
  const response = await chatgptRequest(session, detail, deviceId, sessionId, path, {
    json: taxesBody(checkout, billing),
    extra,
  });
  const status = Number(response.status) || 0;
  const evaluated = evaluateCheckoutUpdateResponse(status, response.data, response.text, {
    currency: spec.currency,
    payableOnly: true,
  });
  emit('promotion', `taxes HTTP ${status} ${evaluated.logReason}。`);
  if (!evaluated.ok && !(debug && evaluated.code === 'PAYMENT_AMOUNT_NOT_ZERO') && !checkout.amount_zero_source) {
    throw protoError(evaluated.message || 'taxes 后优惠无效', {
      status: status || 400,
      code: evaluated.code || 'CHECKOUT_PROMOTION',
      recoverable: evaluated.recoverable === true,
    });
  }
  if (debug && evaluated.code === 'PAYMENT_AMOUNT_NOT_ZERO') {
    emit(
      'promotion',
      `DEBUG 继续：taxes 应付非 0 ${describeDebugAmount(evaluated.amount, evaluated.formatted, evaluated.source)}。`,
    );
  }
  return { response, evaluated, http: status };
}

async function submitGcashTaxesAndSnapshot(session, detail, deviceId, sessionId, checkout, spec, billing, emit, debug = false) {
  emit('billing', '正在提交 OAICS taxes，随后 snapshot（失败不阻断）。');
  const taxed = await readGcashTaxesPayable(
    session, detail, deviceId, sessionId, checkout, spec, billing, emit, debug,
  );
  checkout.taxes_https = [taxed.http];
  if (taxed.evaluated.amount === 0) {
    checkout.checkout_amount_minor = 0;
    checkout.amount_zero_source = checkout.amount_zero_source || taxed.evaluated.source;
    emit('promotion', `零元校验通过 amount=0 source=${taxed.evaluated.source || 'unknown'} via=taxes。`);
  } else if (taxed.evaluated.amount != null && taxed.evaluated.amount !== 0 && !checkout.amount_zero_source) {
    if (debug) {
      checkout.checkout_amount_minor = taxed.evaluated.amount;
      emit(
        'promotion',
        `DEBUG 继续：taxes 应付非 0 ${describeDebugAmount(taxed.evaluated.amount, taxed.evaluated.formatted, taxed.evaluated.source)}。`,
      );
    } else {
      throw protoError(taxed.evaluated.message || 'taxes 后支付金额不是0元', {
        status: 409,
        code: 'PAYMENT_AMOUNT_NOT_ZERO',
        recoverable: false,
      });
    }
  }
  const extra = await gcashRequestExtra(session, deviceId, chatgptCheckoutHeaders(checkout, '/backend-api/payments/checkout/snapshot'));
  await snapshotBilling(session, detail, deviceId, sessionId, checkout, billing, extra);
  return checkout;
}

async function updateLocalCheckout(session, detail, deviceId, sessionId, checkout, spec, emit, cancelled, debug = false) {
  const path = '/backend-api/payments/checkout/update';
  const country = updateCountryForChannel(spec.id);
  const body = checkoutUpdateBody(checkout.cs_id, checkout.processor_entity, spec.country);
  return withRetries(CHATGPT_RETRY_ATTEMPTS, cancelled, async (attempt) => {
    emit('promotion', `正在通过 ${country} 调用 checkout/update（${attempt}/${CHATGPT_RETRY_ATTEMPTS}），应用 ${CAMPAIGN_ID}。`);
    const extra = spec.id === 'gcash'
      ? await gcashRequestExtra(session, deviceId, chatgptCheckoutHeaders(checkout, path))
      : channelChatgptExtra(spec, chatgptCheckoutHeaders(checkout, path));
    const response = await chatgptRequest(session, detail, deviceId, sessionId, path, {
      json: body,
      extra,
    });
    const status = Number(response.status) || 0;
    const evaluated = evaluateCheckoutUpdateResponse(status, response.data, response.text, {
      currency: spec.currency,
      payableOnly: spec.id === 'gcash',
    });
    emit('promotion', `checkout/update ${evaluated.logReason}。`);
    if (!evaluated.ok && !(debug && spec.id === 'gcash' && evaluated.code === 'PAYMENT_AMOUNT_NOT_ZERO')) {
      throw protoError(evaluated.message || '优惠更新无效', {
        status: status || 400,
        code: evaluated.code || 'CHECKOUT_PROMOTION',
        recoverable: evaluated.recoverable === true,
      });
    }
    const merged = mergeCheckout(checkout, response.data);
    if (evaluated.amount === 0) {
      return acceptZeroPromotion(merged, evaluated, emit, country);
    }
    if (debug && evaluated.code === 'PAYMENT_AMOUNT_NOT_ZERO') {
      merged.checkout_amount_minor = evaluated.amount;
      emit(
        'promotion',
        `DEBUG 继续：checkout/update 应付非 0 ${describeDebugAmount(evaluated.amount, evaluated.formatted, evaluated.source)}。`,
      );
      return merged;
    }
    if (evaluated.deferred) {
      emit('promotion', `${country} checkout/update 已接受，金额延后到 taxes 确认。`);
    }
    return merged;
  });
}

async function pollLocalRedirect(stripeSession, checkout, stripePk, ctx, spec, emit, cancelled, { afterApprove = false } = {}) {
  const params = stripePaymentPageParams(stripePk, ctx);
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assertActive(cancelled);
    const response = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}`, { method: 'GET', params });
    if (Number(response.status) === 200) {
      const extracted = extractLocalRedirectUrl(spec.method, response.data || {});
      if (extracted && typeof extracted === 'object' && extracted.inApp) return extracted;
      if (extracted) return extracted;
      const submission = findSubmissionAttempt(response.data || {});
      const state = String(submission.state || '').toLowerCase();
      if (state === 'requires_approval' && !afterApprove) {
        throw protoError('payment page requires ChatGPT approval', {
          status: 409,
          code: 'STRIPE_REQUIRES_APPROVAL',
          recoverable: true,
        });
      }
      lastErr = `poll ${attempt}/4 empty`;
      emit('redirect', `轮询未包含 ${spec.method} 跳转（${attempt}/4）。`);
    } else {
      lastErr = `http ${response.status}: ${responseDetail(response)}`;
    }
    if (attempt < 4) await sleep(afterApprove ? [3000, 6000, 12000][attempt - 1] || 0 : [2000, 4000, 8000][attempt - 1] || 0);
  }
  throw protoError(`轮询仍未包含 ${spec.method} 跳转: ${lastErr}`, { status: 502, recoverable: true });
}

async function resolveLocalLink(
  chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, confirmPayload, ctx, spec, emit, cancelled,
) {
  const pk = stripePublishableKey(checkout);
  let extracted = extractLocalRedirectUrl(spec.method, confirmPayload);
  if (extracted && typeof extracted === 'object' && extracted.inApp) return extracted;
  if (extracted) return extracted;
  raiseIfSubmissionFailed(confirmPayload, `${spec.method} confirm`);
  const submission = findSubmissionAttempt(confirmPayload);
  if (String(submission.state || '') === 'requires_approval') {
    emit('approve', `Stripe 要求 ChatGPT approve，正在提交 approve。`);
    await chatgptApprove(chatgptSession, detail, deviceId, sessionId, checkout, emit, cancelled);
    return pollLocalRedirect(stripeSession, checkout, pk, ctx, spec, emit, cancelled, { afterApprove: true });
  }
  try {
    return await pollLocalRedirect(stripeSession, checkout, pk, ctx, spec, emit, cancelled);
  } catch (error) {
    if (error?.code !== 'STRIPE_REQUIRES_APPROVAL') throw error;
    emit('approve', '轮询 payment page 发现 requires_approval，正在提交 ChatGPT approve。');
    await chatgptApprove(chatgptSession, detail, deviceId, sessionId, checkout, emit, cancelled);
    return pollLocalRedirect(stripeSession, checkout, pk, ctx, spec, emit, cancelled, { afterApprove: true });
  }
}

async function confirmGcashCheckout(session, detail, deviceId, sessionId, checkout, cpmId, emit) {
  const confirmPath = '/backend-api/payments/checkout/confirm';
  const json = gcashConfirmBody(checkout.cs_id, cpmId);
  const checkoutHeaders = chatgptCheckoutHeaders(checkout, confirmPath);
  const response = await chatgptRequest(session, detail, deviceId, sessionId, confirmPath, {
    json,
    extra: await gcashRequestExtra(session, deviceId, checkoutHeaders),
  });
  const http = Number(response.status) || 0;
  const payload = response.data && typeof response.data === 'object' ? response.data : {};
  const lastStatus = gcashConfirmStatus(payload);
  emit('confirm', `GCash checkout/confirm 已返回：${describeGcashConfirm(payload, http)}。`);
  if (http >= 400) {
    throw protoError(`chatgpt gcash checkout confirm failed: ${responseDetail(response)}`, {
      status: http || 502,
      code: 'GCASH_CONFIRM_HTTP',
      recoverable: true,
    });
  }
  if (lastStatus === 'blocked') {
    emit('confirm', 'confirm status=blocked，按参考仍 start');
  }
  return payload;
}

async function startGcashCustomPayment(session, detail, deviceId, sessionId, checkout, cpmId, emit, debug = false) {
  const startPath = '/backend-api/payments/checkout/custom_payment_method/start';
  const json = gcashStartBody(checkout.cs_id, cpmId);
  const response = await chatgptRequest(session, detail, deviceId, sessionId, startPath, {
    json,
    extra: await gcashRequestExtra(session, deviceId, chatgptCheckoutHeaders(checkout, startPath)),
  });
  const http = Number(response.status) || 0;
  emit('start', `custom_payment_method/start HTTP ${http}。`);
  if (http < 400) return response;
  const detailText = responseDetail(response);
  if (debug) {
    emit('start', `DEBUG start HTTP ${http}，停止该支路，不重试：${compactText(detailText, 200)}`);
    return { debug_stop: true, status: http, data: response.data, text: response.text };
  }
  throw protoError(`chatgpt gcash custom payment start failed: ${detailText}`, {
    status: response.status || 502,
    code: /must be confirmed/i.test(detailText) ? 'GCASH_START_UNCONFIRMED' : 'GCASH_START_FAILED',
    recoverable: true,
  });
}

function gcashExtractResult(checkout, cpmId, extra = {}) {
  return {
    link: extra.link || '',
    qr: extra.qr || '',
    cs_id: checkout.cs_id,
    flow: 'adyen',
    payment_method_id: cpmId,
    start_http: extra.start_http || 0,
    confirm_status: extra.confirm_status || '',
    amount_zero_source: checkout.amount_zero_source || '',
    checkout_amount_minor: checkout.checkout_amount_minor,
    checkout: {
      cs_id: checkout.cs_id,
      processor_entity: checkout.processor_entity || '',
      billing_country: checkout.billing_country || 'PH',
    },
    device_id: extra.device_id,
    session_id: extra.session_id,
    ...extra,
  };
}

async function extractGcashLink(
  chatgptSession, detail, deviceId, sessionId, checkout, billing, emit, fetchImpl,
  { stopAfterStart = false, debug = false, proxy, screenshotImpl } = {},
) {
  const cpmId = gcashMethodId(checkout);
  if (!cpmId) {
    throw protoError('账号没有 GCash 试用资格（checkout 未返回 cpmt_）', {
      status: 409,
      code: 'ACCOUNT_NOT_ELIGIBLE',
      recoverable: false,
    });
  }
  emit('billing', '正在提交 OAICS taxes / snapshot。');
  await submitGcashTaxesAndSnapshot(
    chatgptSession, detail, deviceId, sessionId, checkout, CHANNEL_SPECS.gcash, billing, emit, debug,
  );
  emit('confirm', '正在通过 ChatGPT checkout/confirm 确认 GCash custom payment method。');
  const skipSleep = typeof fetchImpl === 'function';
  const confirmPayload = await confirmGcashCheckout(
    chatgptSession, detail, deviceId, sessionId, checkout, cpmId, emit,
  );
  const confirmStatus = gcashConfirmStatus(confirmPayload) || 'empty';
  emit('confirm', `confirm HTTP 200 status=${confirmStatus}，正在启动 GCash custom payment method 流程。`);
  if (!skipSleep) await sleep(400);
  const startResponse = await startGcashCustomPayment(
    chatgptSession, detail, deviceId, sessionId, checkout, cpmId, emit, debug,
  );
  if (startResponse?.debug_stop) {
    return gcashExtractResult(checkout, cpmId, {
      debug_stopped: true,
      debug_stop_reason: 'start_http',
      start_http: Number(startResponse.status) || 0,
      confirm_status: confirmStatus,
      confirm_payload: debugRedactJson(confirmPayload),
      start_payload: debugRedactJson(startResponse.data || {}),
      device_id: deviceId,
      session_id: sessionId,
    });
  }
  const startHttp = Number(startResponse.status) || 0;
  const nextAction = startResponse.data?.next_action;
  const providerUrl = String(nextAction?.url || '').trim();
  if (!isAdyenGcashRedirect(providerUrl)) {
    if (debug) {
      emit('start', `DEBUG start HTTP ${startHttp} 无支付 URL，停止该支路。`);
      return gcashExtractResult(checkout, cpmId, {
        debug_stopped: true,
        debug_stop_reason: 'start_no_url',
        start_http: startHttp,
        confirm_status: confirmStatus,
        confirm_payload: debugRedactJson(confirmPayload),
        start_payload: debugRedactJson(startResponse.data || {}),
        next_action_present: Boolean(nextAction),
        device_id: deviceId,
        session_id: sessionId,
      });
    }
    throw protoError(
      `chatgpt gcash custom payment start 未返回支付 URL：HTTP ${startHttp} ${compactText(JSON.stringify(startResponse.data || {}), 240)}`,
      { status: 502, recoverable: true },
    );
  }
  if (stopAfterStart) {
    emit('qr', '已拿到 start 支付 URL，按测试要求停，不打开授权页、不扫码、不 continue。');
    return {
      link: providerUrl,
      qr: '',
      cs_id: checkout.cs_id,
      flow: 'adyen',
      payment_method_id: cpmId,
      stopped_after_start: true,
      start_http: startHttp,
      confirm_status: confirmStatus,
      amount_zero_source: checkout.amount_zero_source || '',
      checkout_amount_minor: checkout.checkout_amount_minor,
      checkout: {
        cs_id: checkout.cs_id,
        processor_entity: checkout.processor_entity || '',
        billing_country: checkout.billing_country || 'PH',
      },
      device_id: deviceId,
      session_id: sessionId,
    };
  }
  const keepH5 = !debug && typeof fetchImpl !== 'function' && typeof screenshotImpl !== 'function';
  emit(
    'qr',
    keepH5
      ? '已拿到 Adyen 长链，Playwright 先带 ChatGPT 登录态再打开 H5，保持打开直到 /checkout/verify 回跳。'
      : '已拿到 Adyen 长链，Playwright Chromium 打开 H5 截图（不 POST continue）。',
  );
  let chatgptIdentity;
  if (keepH5 && typeof fetchImpl !== 'function' && typeof screenshotImpl !== 'function') {
    chatgptIdentity = {
      accessToken: String(detail?.access_token || '').trim(),
      accountId: String(
        detail?.chatgpt_account_id
        || chatgptAccountIdFromToken(detail?.access_token)
        || checkout?.chatgpt_account_id
        || '',
      ).trim(),
      deviceId,
      sessionId,
      cookies: await sessionCookieEntries(chatgptSession, deviceId),
    };
    emit(
      'qr',
      chatgptIdentity.cookies.length
        ? '正在把出码会话的 ChatGPT cookie 注入 Chromium，扫码回跳才能用同一登录态 continue。'
        : '出码会话没有 session cookie，改用 access token 在 Chromium 里建立登录态。',
    );
  }
  const saveQrPath = String(process.env.GCASH_QR_SAVE_PATH || '').trim();
  const shot = await captureGcashH5Screenshot({
    url: providerUrl,
    proxy,
    userAgent: chatgptSession?.fingerprint?.userAgent,
    fetchImpl,
    screenshotImpl,
    emit,
    keepOpen: keepH5,
    chatgpt: chatgptIdentity,
    saveQrPath,
  });
  let qr = String(shot.qr || '').trim();
  let qrSource = shot.source || '';
  if (qr && qrSource !== 'playwright-fixture' && !isUsableGcashQrDataUrl(qr)) {
    emit('qr', 'H5 截到了空白加载页，不算二维码。');
    qr = '';
  }
  const auth = parseGcashAuthPage(shot.finalUrl || providerUrl);
  auth.browserVersion = String(chatgptSession?.fingerprint?.chromeMajor || '').trim();
  if (shot.h5?.consultUuid) auth.consultUuid = String(shot.h5.consultUuid);
  if (shot.h5?.tokenId) auth.tokenId = String(shot.h5.tokenId);
  const displayLink = preferReadyGcashLink(providerUrl, shot.finalUrl);
  if (auth.ready && displayLink && displayLink !== providerUrl) {
    emit('qr', 'H5 已落到 GCash 授权页，支付墙改存落地链。');
  }
  let consultPayload = null;
  let rawQr = '';
  let qrKind = '';
  if (auth.ready) {
    emit('qr', '已取得 merchants-auth，同一提链 HTTP 会话主动 consult；该协议码与 query.result UUID 同轮绑定。');
    let consulted;
    try {
      consulted = await consultGcashQr(chatgptSession, auth, emit);
    } catch (error) {
      if (keepH5 && shot.h5) await closeGcashH5(shot.h5);
      throw error;
    }
    consultPayload = consulted?.payload || null;
    const protocolQr = String(consulted?.qr || '').trim();
    const protocolUuid = String(consulted?.uuid || auth.consultUuid || '').trim();
    if (protocolQr && protocolUuid) {
      qr = protocolQr;
      rawQr = String(consulted?.raw || consultQrPayload(consultPayload) || '').trim();
      qrKind = consulted?.kind || consultQrKind(rawQr);
      qrSource = 'protocol-consult';
      emit('qr', `纯协议二维码已生成：has_uuid=true kind=${qrKind || 'payload'}，后续只轮询这一轮 query.result。`);
    } else if (qr && shot.h5?.consultUuid) {
      auth.consultUuid = String(shot.h5.consultUuid);
      if (shot.h5.tokenId) auth.tokenId = String(shot.h5.tokenId);
      qrSource = `${qrSource || 'playwright'}-fallback`;
      emit('qr', '主动 consult 未同时得到二维码与 UUID，保留已捕获 UUID 的 H5 DOM 码作为兜底。');
    } else if (keepH5) {
      if (shot.h5) await closeGcashH5(shot.h5);
      throw protoError('GCash consult 未同时返回二维码和 UUID，拒绝发布不可监控二维码', {
        status: 502,
        code: 'GCASH_CONSULT_UNBOUND',
        recoverable: true,
      });
    }
  } else {
    rawQr = '';
    qrKind = consultQrKind(rawQr);
  }
  if (keepH5 && (!auth.ready || !String(auth.consultUuid || '').trim())) {
    if (shot.h5) await closeGcashH5(shot.h5);
    throw protoError('GCash H5 未形成可轮询的 merchants-auth + consult UUID，拒绝发布二维码', {
      status: 502,
      code: 'GCASH_CONSULT_UNBOUND',
      recoverable: true,
    });
  }
  const qrEmvAmount = emvQrAmount(rawQr);
  if (debug) {
    const minor = checkout.checkout_amount_minor;
    const php = minor == null ? null : Number(minor) / 100;
    emit(
      'qr',
      `DEBUG QR source=${qrSource || 'none'} kind=${qrKind || 'none'} length=${qr.length} placeholder=${isPlaceholderQrValue(qr || rawQr)} emv_amount=${qrEmvAmount || 'none'} checkout_php=${php == null ? 'unknown' : php}。`,
    );
    if (php === 1100 || qrEmvAmount === '1100' || qrEmvAmount === '1100.00' || Number(qrEmvAmount) === 1100) {
      emit('qr', '警告：1100 PHP 二维码不得支付，本流程在 continue 前停止。');
    }
  }
  if (!qr) {
    emit('qr', '已有 Adyen/GCash 授权链；H5 截图未出码，按 r19 提链仍算成功。');
    if (debug) {
      return gcashExtractResult(checkout, cpmId, {
        debug_stopped: true,
        debug_stop_reason: 'qr_missing',
        link: displayLink,
        qr: '',
        qr_source: qrSource,
        qr_emv_amount: qrEmvAmount || '',
        protocol: safeAuthView(auth),
        start_http: startHttp,
        confirm_status: confirmStatus,
        confirm_payload: debugRedactJson(confirmPayload),
        start_payload: debugRedactJson(startResponse.data || {}),
        device_id: deviceId,
        session_id: sessionId,
      });
    }
  } else {
    emit('qr', `H5 截图/兜底已生成二维码（${qrSource || safeAuthView(auth).host || 'gcash'}），进入 monitor_active。`);
  }
  if (debug) emit('qr', 'DEBUG 已停在 continue / 支付之前。');
  return gcashExtractResult(checkout, cpmId, {
    link: displayLink,
    qr,
    qr_kind: qrKind || (qr.startsWith('data:image/') ? 'h5-screenshot' : ''),
    qr_source: qrSource,
    qr_emv_amount: qrEmvAmount || '',
    qr_length: qr.length,
    qr_placeholder: isPlaceholderQrValue(qr),
    protocol: debug ? safeAuthView(auth) : auth,
    start_http: startHttp,
    confirm_status: confirmStatus,
    confirm_payload: debug ? debugRedactJson(confirmPayload) : undefined,
    start_payload: debug ? debugRedactJson(startResponse.data || {}) : undefined,
    device_id: deviceId,
    session_id: sessionId,
    h5: shot.h5 || null,
    savedQrPath: shot.savedQrPath || '',
    debug_stopped: debug ? true : undefined,
    debug_stop_reason: debug ? 'before_continue' : undefined,
  });
}

async function extractStripeLocalLink(
  chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, spec, emit, cancelled,
) {
  let initPayload = await stripeInit(stripeSession, checkout, emit, { timezone: spec.timezone });
  ensureMethodAvailable(initPayload, spec.method, spec.method);
  const pk = stripePublishableKey(checkout, initPayload);
  const stripeHostedUrl = String(initPayload.stripe_hosted_url || '').trim();
  if (!stripeHostedUrl) {
    throw protoError('stripe init 未返回 stripe_hosted_url', { status: 502, recoverable: true });
  }
  let lastProviderError;
  for (let providerAttempt = 1; providerAttempt <= PROVIDER_RETRY_ATTEMPTS; providerAttempt += 1) {
    assertActive(cancelled);
    try {
      const ctx = stripeContext(checkout.cs_id, initPayload);
      ctx.locale = spec.locale || ctx.locale;
      await stripeElements(stripeSession, checkout, ctx, emit);
      const customTax = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}`, {
        form: stripeCustomTaxRegionBody(ctx, billing, pk),
        extra: { Origin: 'https://js.stripe.com', Referer: STRIPE_JS_ORIGIN },
      });
      if (Number(customTax.status) < 400) applyCustomTaxRegionAmount(ctx, customTax.data || {});
      await submitTaxes(chatgptSession, detail, deviceId, sessionId, checkout, billing, emit);
      await snapshotBilling(chatgptSession, detail, deviceId, sessionId, checkout, billing);
      emit('payment_method', `正在创建 ${spec.method} payment_method${spec.bank ? `（银行 ${spec.bank}）` : ''}。`);
      const pmResponse = await stripeRequest(stripeSession, '/v1/payment_methods', {
        form: localPaymentMethodBody(spec, checkout, pk, billing, ctx),
      });
      if (Number(pmResponse.status) >= 400) {
        throw protoError(`stripe ${spec.method} payment_methods failed: ${responseDetail(pmResponse)}`, {
          status: pmResponse.status || 502,
          recoverable: true,
        });
      }
      const pmId = String(pmResponse.data?.id || '');
      if (!pmId.startsWith('pm_')) {
        throw protoError(`stripe ${spec.method} payment_methods 未返回 pm_ id`, { status: 502, recoverable: true });
      }
      emit('confirm', `正在确认 Stripe payment page（${spec.method}）。`);
      const confirmReferer = toOpenaiPayUrl(stripeHostedUrl) || 'https://pay.openai.com/';
      const confirmResponse = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}/confirm`, {
        form: localConfirmBody(spec, checkout, pk, initPayload, ctx, pmId, stripeHostedUrl),
        extra: { Referer: confirmReferer },
      });
      if (Number(confirmResponse.status) >= 400) {
        throw protoError(`stripe ${spec.method} confirm failed: ${responseDetail(confirmResponse)}`, {
          status: confirmResponse.status || 502,
          code: 'STRIPE_RISK_RETRYABLE',
          recoverable: true,
        });
      }
      const resolved = await resolveLocalLink(
        chatgptSession, stripeSession, detail, deviceId, sessionId, checkout,
        confirmResponse.data || {}, ctx, spec, emit, cancelled,
      );
      if (resolved && typeof resolved === 'object' && resolved.inApp) {
        return {
          link: '',
          result_host: 'stripe.com',
          cs_id: checkout.cs_id,
          flow: 'blik_in_app',
          payment_method_id: pmId,
        };
      }
      const rawUrl = String(resolved || '').trim();
      const followed = spec.method === 'upi' || spec.method === 'pix'
        ? rawUrl
        : await followPreferredRedirect(stripeSession, rawUrl, spec.preferredHosts);
      const finalUrl = followed || rawUrl;
      if (!finalUrl) {
        throw protoError(`未提取到 ${spec.method} 跳转链`, { status: 502, recoverable: true });
      }
      return {
        link: finalUrl,
        cs_id: checkout.cs_id,
        flow: 'stripe',
        payment_method_id: pmId,
      };
    } catch (error) {
      lastProviderError = error;
      if (error?.code === 'JOB_CANCELLED' || error?.recoverable === false || error?.code === 'CHECKOUT_PROMOTION') {
        throw error;
      }
      const status = Number(error?.status) || 0;
      const retryable = error?.recoverable === true || [408, 425, 429, 500, 502, 503, 504].includes(status);
      if (!retryable || providerAttempt >= PROVIDER_RETRY_ATTEMPTS) throw error;
      emit('provider', `${spec.method} provider 第 ${providerAttempt} 次失败，保留 checkout 重试。`);
    }
  }
  throw lastProviderError || protoError(`${spec.method} provider 失败`, { status: 502, recoverable: true });
}

async function extractOnce({
  chatgptSession,
  stripeSession,
  detail,
  deviceId,
  sessionId,
  emit,
  cancelled,
  proxy,
  spec,
  fetchImpl,
  nextProxy,
  stopAfterStart,
  debug,
  screenshotImpl,
}) {
  let checkout = await createLocalCheckout(
    chatgptSession, detail, deviceId, sessionId, spec, emit, cancelled, proxy, debug,
  );
  if (!spec.skipCheckoutUpdate) {
    const updateCountry = updateCountryForChannel(spec.id);
    if (updateCountry && updateCountry !== spec.country) {
      const updateProxy = freshStickyProxy(proxyForRegion(
        typeof nextProxy === 'function' ? (nextProxy() || proxy) : proxy,
        updateCountry,
      ));
      await withExtractSession({
        proxy: updateProxy,
        timeoutMs: CHATGPT_TIMEOUT_MS,
        fetchImpl,
        impersonate: EXTRACT_BROWSER,
        acceptLanguage: spec.id === 'gcash' ? GCASH_CHAT.acceptLanguage : undefined,
      }, async (updateSession) => {
        await seedSession(updateSession, detail, deviceId);
        await verifyProxyCountry(updateSession, updateCountry, emit, '优惠 update');
        checkout = await updateLocalCheckout(
          updateSession, detail, deviceId, sessionId, checkout, spec, emit, cancelled, debug,
        );
      });
    } else {
      checkout = await updateLocalCheckout(
        chatgptSession, detail, deviceId, sessionId, checkout, spec, emit, cancelled, debug,
      );
    }
  }
  const billing = await billingForChannel(
    spec,
    accountEmailFromAccessToken(detail.access_token) || detail.email || '',
    fetchImpl,
  );
  emit('billing', `已生成 ${billing.country} 账单资料：${billing.city} ${billing.postal_code}。`);
  if (spec.id === 'gcash' && checkout.checkout_amount_minor == null && !checkout.amount_zero_source) {
    checkout = await applyGcashCheckoutPageAmount(
      chatgptSession, detail, deviceId, sessionId, checkout, spec, emit,
    );
  }
  if (spec.flow === 'adyen') {
    return extractGcashLink(
      chatgptSession, detail, deviceId, sessionId, checkout, billing, emit, fetchImpl,
      { stopAfterStart, debug, proxy, screenshotImpl },
    );
  }
  return extractStripeLocalLink(
    chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, spec, emit, cancelled,
  );
}

async function extractLocalProvider({
  channelId, detail, proxy, nextProxy, cancelled, log, fetchImpl, impersonate, maxCheckoutAttempts,
  keepSession = false,
  stopAfterStart = false,
  debug = false,
  debugTracePath = '',
  screenshotImpl,
}) {
  const spec = channelSpec(channelId);
  const accessToken = String(detail?.access_token || '').trim();
  if (!accessToken) {
    throw protoError('账号缺少 access token', { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
  }
  if (!proxy && typeof fetchImpl !== 'function') {
    throw protoError(`${spec.country} 本地支付探测缺少已校验的支付组代理`, {
      status: 400,
      code: 'EXTRACT_PROXY_REQUIRED',
      recoverable: false,
    });
  }
  const debugEnabled = gcashExtractDebugEnabled({ debug });
  const trace = debugEnabled ? createGcashDebugTrace(gcashDebugTracePath({ debugTracePath })) : null;
  const emit = (step, message) => {
    const line = `${step}: ${message}`;
    log?.(line, 'info');
    if (trace) trace.note('log', { step, message });
  };
  if (trace) {
    emit('debug', `GCash debug 模式：金额非 0 不中断，confirm blocked 仍 start，trace=${trace.filePath}`);
  }
  const eligibilityCache = {};
  let currentProxy = freshStickyProxy(proxyForRegion(proxy, spec.country));
  let lastError;
  let checkoutFailures = 0;
  const attemptCap = debugEnabled
    ? 1
    : Math.max(1, Number(maxCheckoutAttempts) || (spec.id === 'gcash' ? GCASH_FAILURE_ATTEMPTS : 2));
  const requestedImpersonate = String(impersonate || spec.impersonate || EXTRACT_BROWSER).trim();
  const deviceId = String(detail?.device_id || '').trim() || newId();
  const attachTrace = (result) => {
    if (!trace || !result || typeof result !== 'object') return result;
    result.debug_trace_path = trace.filePath;
    result.debug_steps = trace.steps.length;
    return result;
  };
  while (true) {
    assertActive(cancelled);
    const fingerprint = fingerprintFor(requestedImpersonate);
    try {
      return await withExtractSession({
        proxy: currentProxy,
        timeoutMs: CHATGPT_TIMEOUT_MS,
        fetchImpl,
        impersonate: fingerprint.impersonate,
        acceptLanguage: spec.id === 'gcash' ? GCASH_CHAT.acceptLanguage : undefined,
        keepOpen: keepSession === true && spec.id === 'gcash' && !debugEnabled,
      }, async (session) => {
        if (trace) wrapSessionForDebugTrace(session, trace);
        if (spec.id === 'ideal' && session.fingerprint?.impersonate !== EXTRACT_SAFARI_IMPERSONATE) {
          throw protoError('iDEAL 必须使用 Safari 17 指纹，已拒绝回退 Chrome', {
            status: 502,
            code: 'IDEAL_SAFARI_REQUIRED',
            recoverable: false,
          });
        }
        emit(
          'transport',
          `${spec.method} 探测使用 ${session.browser || fingerprint.impersonate} / ${spec.country} sticky。`,
        );
        const sessionId = newId();
        await seedSession(session, detail, deviceId);
        await verifyProxyCountry(session, spec.country, emit, spec.method);
        if (spec.id === 'gcash') {
          if (String(eligibilityCache.promo_campaign_id || '').toLowerCase() === CAMPAIGN_ID) {
            emit('eligibility', `资格预检已通过：复用 ${eligibilityCache.country || spec.country} 结果，后续重试不再重复检查。`);
          } else {
            const checked = await checkGcashAccounts(session, detail, deviceId, sessionId, emit, debugEnabled);
            if (String(checked?.campaign || '').toLowerCase() === CAMPAIGN_ID) {
              eligibilityCache.promo_campaign_id = CAMPAIGN_ID;
              eligibilityCache.country = spec.country;
            }
          }
        } else {
          await checkEligibility(
            session, detail, deviceId, sessionId, emit, cancelled, eligibilityCache,
            { exitCountry: spec.country },
          );
        }
        const result = await extractOnce({
          chatgptSession: session,
          stripeSession: session,
          detail,
          deviceId,
          sessionId,
          emit,
          cancelled,
          proxy: currentProxy,
          spec,
          fetchImpl,
          nextProxy,
          stopAfterStart,
          debug: debugEnabled,
          screenshotImpl,
        });
        emit('done', debugEnabled
          ? `debug 流水线已停在 continue 之前（${spec.method}）。`
          : `已探测到 ${spec.method}（主机名仅写入监控表）。`);
        if (keepSession && spec.id === 'gcash') result.keep_session = true;
        return attachTrace(result);
      });
    } catch (error) {
      lastError = error;
      if (trace) {
        trace.note('error', {
          code: error?.code || '',
          status: Number(error?.status) || 0,
          message: compactText(String(error?.message || error), 240),
        });
        error.debug_trace_path = trace.filePath;
      }
      if (debugEnabled) throw error;
      if (error?.code === 'ACCOUNT_NOT_ELIGIBLE' || error?.code === 'IDEAL_SAFARI_REQUIRED') throw error;
      if (spec.skipCheckoutUpdate && error?.code === 'CHECKOUT_PROMOTION') throw error;
      if (isUnsupportedImpersonateError(error)) {
        rememberUnsupportedImpersonate(fingerprint.impersonate);
        if (spec.id === 'ideal') throw error;
      }
      checkoutFailures += 1;
      const recoverable = staleCheckoutError(error) || recoverableExtractError(error);
      if (
        error?.skip
        || error?.code === 'JOB_CANCELLED'
        || !recoverable
        || checkoutFailures >= attemptCap
      ) {
        throw error;
      }
      emit('recovery', `${spec.method} 本轮失败：${compactText(error?.message, 200)}。更换 ${spec.country} sticky 重建 checkout（${checkoutFailures + 1}/${attemptCap}）。`);
      if (!fetchImpl) await sleep(error?.code === 'EXTRACT_CHECKOUT_UNUSUAL' ? 5000 : 800);
      currentProxy = freshStickyProxy(proxyForRegion(
        typeof nextProxy === 'function' ? (nextProxy() || currentProxy) : currentProxy,
        spec.country,
      ));
    }
  }
  throw lastError;
}

module.exports = {
  CHANNEL_SPECS,
  channelSpec,
  wiredLocalChannelIds,
  impersonateForChannel,
  checkoutBodyForChannel,
  skipCheckoutUpdateForChannel,
  updateCountryForChannel,
  localPaymentMethodBody,
  localConfirmBody,
  generateBrazilCpf,
  extractUpiRedirectUrl,
  extractPixRedirectUrl,
  extractIdealRedirectUrl,
  extractBlikRedirectUrl,
  extractLocalRedirectUrl,
  isIdealRedirectUrl,
  isAdyenGcashRedirect,
  isExternalHttpUrl,
  GCASH_FAILURE_ATTEMPTS,
  extractLocalProvider,
  confirmGcashCheckout,
  startGcashCustomPayment,
  gcashExtractDebugEnabled,
};
