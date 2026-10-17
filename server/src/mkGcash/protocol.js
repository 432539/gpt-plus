'use strict';

/**
 * Pure helpers from gcash_chain.py and payment_monitor.py.
 * Function comments name the Python source. Do not add steps the open source does not have.
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const OPENAI_BASE = 'https://chatgpt.com';
const ADYEN_BASE = 'https://checkoutshopper-live.adyen.com';
const CHECKOUT_BASE = `${OPENAI_BASE}/backend-api/payments/checkout`;
const CONTINUE_PATH = '/backend-api/payments/checkout/custom_payment_method/continue';
const ENTITLEMENT_URL = `${OPENAI_BASE}/backend-api/accounts/check/v4-2023-04-27`;
const PROCESSOR_ENTITY = 'openai_llc';
const PLAN_NAME = 'chatgptplusplan';
const PROMO_CAMPAIGN = Object.freeze({
  promo_campaign_id: 'plus-1-month-free',
  is_coupon_from_query_param: true,
});
const HTTP_TIMEOUT = 30;
const QR_TTL_SECONDS = 5 * 60;
const CALLBACK_MAX_ATTEMPTS = 3;
const CALLBACK_RETRY_DELAYS = [0.75, 1.5];
const CALLBACK_VERIFY_DELAYS = [0.0, 0.75, 1.5];
const BROWSER_PROFILE = ['chrome145', '145', '145.0.0.0'];
const [TLS_IMPERSONATE, CHROME_MAJOR, CHROME_FULL_VERSION] = BROWSER_PROFILE;
const CHROME_USER_AGENT = (
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) '
  + `Chrome/${CHROME_FULL_VERSION} Safari/537.36`
);

const MONITOR_TTL_SECONDS = 5 * 60;
const MONITOR_REFRESH_GRACE_SECONDS = 10 * 60;
const INITIAL_QR_CAPTURE_TIMEOUT = 55;
const REFRESH_QR_CAPTURE_TIMEOUT = 45;
const MONITOR_READY_TIMEOUT = 120;
const MONITOR_REFRESH_TIMEOUT = 90;
const CHECKOUT_STATUS_POLL_SECONDS = 3.0;
const CALLBACK_CONFIRM_TIMEOUT_SECONDS = 5 * 60;

const TERMINAL_STATUSES = new Set([
  'completed', 'callback_failed', 'callback_unconfirmed', 'expired', 'failed', 'abandoned',
]);
const CALLBACK_SUCCESS_STATUSES = new Set(['success', 'succeeded', 'completed', 'complete', 'paid']);
const CALLBACK_ACCEPTED_STATUSES = new Set([...CALLBACK_SUCCESS_STATUSES, 'accepted', 'pending', 'processing']);
const CALLBACK_FAILURE_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CONTINUE_CONTEXT_HEADER_NAMES = new Set([
  'chatgpt-account-id',
  'oai-session-id',
  'oai-web-deployment-attestation',
  'x-oai-is-client-observation',
  'oai-client-build-number',
  'oai-client-version',
  'oai-device-id',
  'x-openai-target-path',
  'x-openai-target-route',
]);
const FRONTEND_CONTEXT_COOKIE_NAMES = new Set([
  'oai-did', 'cf_clearance', '__cf_bm', '__cfseq',
  'cf_chl_rc_i', 'cf_chl_rc_ni', 'cf_chl_rc_m',
]);

class TokenRevokedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenRevokedError';
  }
}

class QueueFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueFullError';
  }
}

function sleep(seconds) {
  const ms = Math.max(0, Number(seconds) || 0) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function htmlUnescape(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[name.toLowerCase()] || entity;
  });
}

/** gcash_chain.py:_bearer */
function bearer(token) {
  return `Bearer ${token}`;
}

/** gcash_chain.py:_headers */
function headers({ token = null, accountId = null, contentType = 'application/json', html = false } = {}) {
  const h = {
    Accept: html
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `${OPENAI_BASE}/`,
    'Sec-Fetch-Site': html ? 'cross-site' : 'same-origin',
    'Sec-Fetch-Mode': html ? 'navigate' : 'cors',
    'Sec-Fetch-Dest': html ? 'document' : 'empty',
  };
  if (html) h['Upgrade-Insecure-Requests'] = '1';
  else h.Origin = OPENAI_BASE;
  if (contentType) h['Content-Type'] = contentType;
  if (token) h.Authorization = bearer(token);
  if (accountId) h['ChatGPT-Account-Id'] = String(accountId);
  return h;
}

function decodeProxyUserInfo(value) {
  const text = String(value || '');
  if (!text) return '';
  try { return decodeURIComponent(text); } catch { return text; }
}

function parseUrlProxy(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch {
    return { type: 'http', host: null, port: null, user: null, password: null };
  }
  const scheme = String(parsed.protocol || '').replace(/:$/, '').toLowerCase();
  const type = scheme === 'socks5h' ? 'socks5' : scheme;
  if (!['http', 'https', 'socks5'].includes(type)) {
    return { type: 'http', host: null, port: null, user: null, password: null };
  }
  const defaultPort = type === 'https' ? 443 : type === 'socks5' ? 1080 : 80;
  const user = parsed.username ? decodeProxyUserInfo(parsed.username) : null;
  const password = parsed.username || parsed.password
    ? decodeProxyUserInfo(parsed.password)
    : null;
  return {
    type,
    host: parsed.hostname || null,
    port: Number(parsed.port || defaultPort),
    user,
    password: user != null ? (password || '') : null,
  };
}

/** gcash_chain.py:_parse_proxy, plus gpt-plus socks5h / user:pass@host:port storage. */
function parseProxy(proxy) {
  if (!proxy) return { type: null, host: null, port: null, user: null, password: null };
  const raw = String(proxy).trim();
  if (!raw) return { type: null, host: null, port: null, user: null, password: null };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return parseUrlProxy(raw);

  if (raw.includes('@')) {
    const at = raw.lastIndexOf('@');
    const auth = raw.slice(0, at);
    const addr = raw.slice(at + 1);
    const colon = addr.lastIndexOf(':');
    if (colon <= 0) return { type: 'http', host: null, port: null, user: null, password: null };
    const cut = auth.indexOf(':');
    return {
      type: 'http',
      host: addr.slice(0, colon),
      port: Number(addr.slice(colon + 1)),
      user: cut >= 0 ? auth.slice(0, cut) : auth,
      password: cut >= 0 ? auth.slice(cut + 1) : '',
    };
  }

  // gcash_chain.py:_parse_proxy uses split(":", 3) so passwords may contain colons.
  const parts = raw.split(':');
  if (parts.length >= 4) {
    return {
      type: 'http',
      host: parts[0],
      port: Number(parts[1]),
      user: parts[2],
      password: parts.slice(3).join(':'),
    };
  }
  if (parts.length === 2) {
    return {
      type: 'http',
      host: parts[0],
      port: Number(parts[1]),
      user: null,
      password: null,
    };
  }
  return { type: 'http', host: null, port: null, user: null, password: null };
}

function proxyPortValid(port) {
  const value = Number(port);
  return Number.isFinite(value) && value >= 1 && value <= 65535;
}

/** HTTP (curl_cffi) accepts SOCKS5+auth; Chromium uses the CONNECT bridge. */
function ensureFullChainProxySupported(proxy) {
  const { host, port } = parseProxy(proxy);
  if (!host || !proxyPortValid(port)) throw new Error('代理格式无效');
}

/** gcash_chain.py:_proxy_url */
function proxyUrl(proxy) {
  if (!proxy) return '';
  const { type, host, port, user, password } = parseProxy(proxy);
  if (!host || !proxyPortValid(port)) throw new Error('代理格式无效');
  const scheme = type === 'socks5' ? 'socks5h' : type;
  let auth = '';
  if (user != null) {
    const encodedUser = encodeURIComponent(String(user));
    const encodedPassword = encodeURIComponent(String(password || ''));
    auth = `${encodedUser}:${encodedPassword}@`;
  }
  const renderedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${auth}${renderedHost}:${port}`;
}

/** payment_monitor.py:_playwright_proxy */
function playwrightProxy(proxy) {
  if (!proxy) return null;
  const { type, host, port, user, password } = parseProxy(proxy);
  if (!host || !proxyPortValid(port)) throw new Error('回调监控节点格式无效');
  if (type === 'socks5' && (user != null || password != null)) {
    throw new Error(
      '带账号密码的 SOCKS5 不支持 GCash 二维码与回调监控；'
      + '请改用认证 HTTP 代理或无认证 SOCKS5',
    );
  }
  const scheme = ['http', 'https', 'socks5'].includes(type) ? type : 'http';
  const renderedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const config = { server: `${scheme}://${renderedHost}:${port}` };
  if (user != null) {
    config.username = String(user);
    config.password = String(password || '');
  }
  return config;
}

function redactHttpError(message) {
  return String(message || '').replace(/(https?:\/\/)[^/@\s]+@/gi, '$1<credentials>@');
}

/** gcash_chain.py:_http_error */
function httpError(response, url) {
  const rawBody = String(response.text || '');
  let body = rawBody;
  body = body.replace(/eyJ[A-Za-z0-9_.-]+/g, '<token>');
  body = body.replace(/<[^>]+>/g, ' ');
  body = body.replace(/\s+/g, ' ').trim().slice(0, 240);
  let path = '/';
  try { path = new URL(url).pathname || '/'; } catch { /* keep */ }
  const headerGet = (name) => {
    const headersObj = response.headers || {};
    const direct = headersObj[name] || headersObj[name.toLowerCase()];
    if (direct) return String(direct);
    const key = Object.keys(headersObj).find((item) => item.toLowerCase() === name.toLowerCase());
    return key ? String(headersObj[key]) : '';
  };
  const trace = headerGet('x-request-id') || headerGet('cf-ray') || '';
  const contentType = headerGet('content-type').toLowerCase();
  const isCfChallenge = (
    Number(response.status) === 403
    && headerGet('cf-ray')
    && (
      contentType.includes('text/html')
      || rawBody.toLowerCase().includes('challenge-platform')
      || rawBody.toLowerCase().includes('just a moment')
    )
  );
  if (isCfChallenge) body = `Cloudflare 拒绝了请求${body ? `；${body}` : ''}`;
  const detail = body || response.reason || '请求失败';
  const suffix = trace ? ` [trace=${trace}]` : '';
  const message = `${path} HTTP ${response.status}：${detail}${suffix}`;
  if (Number(response.status) === 401 && (
    rawBody.toLowerCase().includes('token_revoked')
    || rawBody.toLowerCase().includes('invalidated oauth token')
  )) {
    return new TokenRevokedError(message);
  }
  return new Error(message);
}

/** gcash_chain.py:_walk_json */
function* walkJson(value) {
  yield value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const child of Object.values(value)) yield* walkJson(child);
  } else if (Array.isArray(value)) {
    for (const child of value) yield* walkJson(child);
  }
}

/** gcash_chain.py:_amount_is_zero */
function amountIsZero(value) {
  if (typeof value === 'boolean' || value == null) return false;
  if (typeof value === 'number') return value === 0;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return ['value', 'amount', 'total', 'subtotal', 'minor_units_amount', 'minorUnitsAmount', 'minor_unit_amount']
      .some((key) => amountIsZero(value[key]));
  }
  const match = String(value).trim().replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return false;
  const n = Number(match[0]);
  return Number.isFinite(n) && n === 0;
}

/** gcash_chain.py:_amount_number */
function amountNumber(value) {
  if (typeof value === 'boolean' || value == null) return null;
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['minor_units_amount', 'minorUnitsAmount', 'minor_unit_amount', 'amount', 'value', 'total']) {
      if (key in value) {
        const parsed = amountNumber(value[key]);
        if (parsed != null) return parsed;
      }
    }
    return null;
  }
  const match = String(value).trim().replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

/** gcash_chain.py:_checkout_amount */
function checkoutAmount(resp) {
  if (resp == null || (typeof resp !== 'object')) return { amount: null, source: '' };

  if (!Array.isArray(resp)) {
    const checkoutSession = resp.checkout_session;
    if (checkoutSession && typeof checkoutSession === 'object') {
      for (const key of ['amount_total', 'amount_due', 'grand_total']) {
        if (key in checkoutSession) {
          const amount = amountNumber(checkoutSession[key]);
          if (amount != null) return { amount, source: `checkout_session.${key}` };
        }
      }
    }
  }

  const preferredKeys = ['amount_total', 'amount_due', 'grand_total'];
  for (const node of walkJson(resp)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    for (const key of preferredKeys) {
      if (key in node) {
        const amount = amountNumber(node[key]);
        if (amount != null) return { amount, source: key };
      }
    }
  }

  for (const node of walkJson(resp)) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const state = node.checkout_state;
    if (state && typeof state === 'object' && 'total' in state) {
      const amount = amountNumber(state.total);
      if (amount != null) return { amount, source: 'checkout_state.total' };
    }
    const summary = node.total_summary;
    if (summary && typeof summary === 'object') {
      for (const key of ['due', 'total']) {
        if (key in summary) {
          const amount = amountNumber(summary[key]);
          if (amount != null) return { amount, source: `total_summary.${key}` };
        }
      }
    }
  }

  if (!Array.isArray(resp)) {
    for (const key of ['amount', 'subtotal']) {
      if (key in resp) {
        const amount = amountNumber(resp[key]);
        if (amount != null) return { amount, source: key };
      }
    }
  }
  return { amount: null, source: '' };
}

function responseAmountIsZero(resp) {
  const { amount, source } = checkoutAmount(resp);
  return Boolean(source) && amount === 0;
}

function extractPrefixedString(resp, prefix) {
  for (const value of walkJson(resp)) {
    if (typeof value === 'string' && value.startsWith(prefix)) return value;
  }
  return '';
}

function extractCheckoutId(resp) {
  return extractPrefixedString(resp, 'oaics_');
}

function extractProcessorEntity(resp) {
  for (const value of walkJson(resp)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entity = value.processor_entity;
    if (typeof entity === 'string' && entity) return entity;
  }
  return '';
}

/** gcash_chain.py:_explicit_payment_status */
function explicitPaymentStatus(resp) {
  for (const value of walkJson(resp)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const key of ['payment_status', 'paymentStatus', 'result_status', 'resultStatus']) {
      const status = value[key];
      if (typeof status === 'string' && status) {
        return status.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
      }
    }
  }
  return '';
}

/** gcash_chain.py:_active_plus_entitlement */
function activePlusEntitlement(resp, accountId = '') {
  if (!resp || typeof resp !== 'object' || Array.isArray(resp)) return false;
  const accounts = resp.accounts;
  if (!accounts || typeof accounts !== 'object') return false;
  const id = String(accountId || '').trim();
  const record = id ? accounts[id] : accounts.default;
  if (!record || typeof record !== 'object') return false;
  const entitlement = record.entitlement;
  const account = record.account;
  if (!entitlement || typeof entitlement !== 'object' || !account || typeof account !== 'object') return false;
  const planType = String(account.plan_type || '').trim().toLowerCase();
  const subscriptionPlan = String(entitlement.subscription_plan || '').trim().toLowerCase();
  return Boolean(
    entitlement.has_active_subscription === true
    && planType === 'plus'
    && subscriptionPlan === PLAN_NAME,
  );
}

/** gcash_chain.py:_verify_page_context */
function verifyPageContext(body) {
  const source = htmlUnescape(String(body || ''));
  const patterns = {
    account_id: /"account"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/i,
    oai_session_id: /"sessionId"\s*:\s*"([^"]+)"/i,
    web_deployment_attestation: /"webDeploymentAttestation"\s*:\s*"([^"]+)"/i,
    client_version: /<html[^>]+data-build="([^"]+)"/i,
    client_build_number: /<html[^>]+data-seq="([^"]+)"/i,
  };
  const output = {};
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = source.match(pattern);
    if (match && String(match[1]).trim()) output[key] = String(match[1]).trim();
  }
  return output;
}

function callbackErrorIsRetryable(error) {
  const text = String(error || '').toLowerCase();
  return [
    '连接超时', '连接失败', 'timeout', 'timed out', 'connection reset',
    'connection closed', 'eof', 'http 408', 'http 425', 'http 429',
    'http 500', 'http 502', 'http 503', 'http 504',
  ].some((marker) => text.includes(marker));
}

/** gcash_chain.py:_callback_action_result */
function callbackActionResult(redirectResult, nativeActionResult = null) {
  const result = String(redirectResult || '');
  if (!result) throw new Error('支付回调参数不完整');
  if (nativeActionResult && typeof nativeActionResult === 'object') {
    const nativeRedirect = nativeActionResult.redirectResult;
    if (nativeRedirect === result) {
      let serialized = '';
      try { serialized = JSON.stringify(nativeActionResult); } catch { serialized = ''; }
      if (serialized && serialized.length <= 32768) {
        return JSON.parse(serialized);
      }
    }
  }
  return { redirectResult: result };
}

/** Strings on a checkout method node, including one nested object (options.type). */
function methodNodeStrings(node) {
  const strings = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return strings;
  for (const child of Object.values(node)) {
    if (typeof child === 'string' && child) strings.push(child);
    else if (child && typeof child === 'object' && !Array.isArray(child)) {
      for (const nested of Object.values(child)) {
        if (typeof nested === 'string' && nested) strings.push(nested);
      }
    }
  }
  return strings;
}

/** gcash_chain.py:_extract_cpmt — also pair GCash when the type lives under options. */
function extractCpmt(resp) {
  for (const value of walkJson(resp)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const strings = methodNodeStrings(value);
    if (strings.some((child) => child.toLowerCase() === 'gcash')) {
      const cpmt = strings.find((child) => child.startsWith('cpmt_')) || '';
      if (cpmt) return cpmt;
    }
  }
  const candidates = [];
  for (const value of walkJson(resp)) {
    if (typeof value === 'string' && value.startsWith('cpmt_') && !candidates.includes(value)) {
      candidates.push(value);
    }
  }
  return candidates.length === 1 ? candidates[0] : '';
}

/** Compact, non-secret checkout payload shape for missing-cpmt errors. */
function checkoutMethodDiag(resp) {
  if (resp == null) return 'body=empty';
  if (typeof resp !== 'object') return `body=${typeof resp}`;
  const keys = Object.keys(resp).slice(0, 16).join(',') || 'none';
  const session = !Array.isArray(resp) && resp.checkout_session && typeof resp.checkout_session === 'object'
    ? resp.checkout_session
    : null;
  const sessionKeys = session ? Object.keys(session).slice(0, 20).join(',') : '';
  const methods = (session && session.custom_payment_methods) || resp.custom_payment_methods;
  const methodsLen = Array.isArray(methods) ? methods.length : 'na';
  const pmt = (session && session.payment_method_types) || resp.payment_method_types;
  const pmtSummary = Array.isArray(pmt) ? pmt.slice(0, 8).map((item) => String(item).slice(0, 24)).join('|') : '';
  let cpmtIds = 0;
  const types = [];
  for (const value of walkJson(resp)) {
    if (typeof value === 'string' && value.startsWith('cpmt_')) cpmtIds += 1;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (typeof value.id !== 'string' || !value.id.startsWith('cpmt_')) continue;
    const nested = value.options && typeof value.options === 'object' ? value.options : {};
    const label = String(value.type || value.brand || nested.type || nested.brand || '').slice(0, 24);
    types.push(label || 'untyped');
  }
  return (
    `keys=${keys} session_keys=${sessionKeys || 'none'} methods_len=${methodsLen} `
    + `pmt=${pmtSummary || 'none'} cpmt_ids=${cpmtIds} types=${types.slice(0, 8).join('|') || 'none'}`
  );
}

function hostnameOf(url) {
  try {
    return String(new URL(String(url)).hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function isGcashUrl(url) {
  try {
    const parsed = new URL(String(url));
    const host = (parsed.hostname || '').toLowerCase();
    return parsed.protocol === 'https:' && (host === 'gcash.com' || host.endsWith('.gcash.com'));
  } catch {
    return false;
  }
}

function isAdyenUrl(url) {
  try {
    const parsed = new URL(String(url));
    const host = (parsed.hostname || '').toLowerCase();
    return parsed.protocol === 'https:' && (host === 'adyen.com' || host.endsWith('.adyen.com'));
  } catch {
    return false;
  }
}

/** gcash_chain.py:_is_adyen_checkout_redirect */
function isAdyenCheckoutRedirect(url) {
  try {
    const parsed = new URL(String(url));
    const redirectData = parsed.searchParams.get('redirectData') || '';
    return Boolean(
      parsed.protocol === 'https:'
      && (parsed.hostname || '').toLowerCase() === 'checkoutshopper-live.adyen.com'
      && parsed.pathname === '/checkoutshopper/checkoutPaymentRedirect'
      && redirectData,
    );
  } catch {
    return false;
  }
}

/** gcash_chain.py:_retry_decision */
function retryDecision(result) {
  const currentStep = String(result.current_step || '');
  const err = String(result.error_message || '').toLowerCase();
  if (['token_revoked', 'invalidated oauth token', 'invalid access token', 'authentication required', 'http 401']
    .some((value) => err.includes(value))) {
    return { retryable: false, label: '' };
  }
  if (err.includes('checkout_creation_rate_limited') || err.includes('too many checkout attempts')) {
    return { retryable: false, label: '' };
  }
  if (currentStep === 'proxy_test') {
    if (err.includes('格式无效')) return { retryable: false, label: '' };
    return { retryable: true, label: '代理预检失败，换节点重试' };
  }
  if (currentStep === 'create_checkout' && [
    '连接失败', '连接超时', 'timeout', 'timed out', 'refused', 'proxy',
    '无法连接', 'connection', 'reset', 'eof', 'cloudflare',
    'unusual activity', 'http 500', 'http 502', 'http 503', 'http 504',
  ].some((kw) => err.includes(kw))) {
    return { retryable: true, label: '建单连接失败，换节点重试' };
  }
  if (currentStep === 'configure_taxes' && err.includes('promo_not_applied')) {
    return { retryable: true, label: '优惠未落地，重建 Checkout' };
  }
  if (currentStep === 'configure_taxes' && err.includes('gcash_custom_method_missing')) {
    return { retryable: true, label: 'GCash 支付方式未生成，重建 Checkout' };
  }
  if (currentStep === 'confirm_payment' && (err.includes('confirm_blocked') || err.includes('confirm status=blocked'))) {
    return { retryable: true, label: 'confirm 被阻断，重建 Checkout' };
  }
  return { retryable: false, label: '' };
}

function isRetryableFailure(result) {
  return retryDecision(result).retryable;
}

/** payment_monitor.py:_sanitize_continue_context_headers */
function sanitizeContinueContextHeaders(headerMap) {
  if (!headerMap || typeof headerMap !== 'object' || Array.isArray(headerMap)) return {};
  const output = {};
  for (const [rawName, rawValue] of Object.entries(headerMap)) {
    const name = String(rawName || '').trim().toLowerCase();
    if (!CONTINUE_CONTEXT_HEADER_NAMES.has(name)) continue;
    const value = String(rawValue || '').trim();
    if (!value || value.length > 16384 || value.includes('\r') || value.includes('\n')) continue;
    output[name] = value;
  }
  return output;
}

function fromRedirectMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return '';
  for (const [key, item] of Object.entries(mapping)) {
    const normalized = String(key).replace(/_/g, '').toLowerCase();
    if (normalized === 'redirectresult' && typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const found = fromRedirectMapping(item);
      if (found) return found;
    }
  }
  return '';
}

/** payment_monitor.py:_extract_redirect_result */
function extractRedirectResult(value) {
  const text = String(value || '');
  if (!text) return '';

  try {
    const parsedUrl = new URL(text);
    if (parsedUrl.protocol && parsedUrl.host) {
      for (const section of [parsedUrl.search.replace(/^\?/, ''), parsedUrl.hash.replace(/^#/, '')]) {
        const params = new URLSearchParams(section);
        const mapping = {};
        for (const [key, item] of params.entries()) mapping[key] = item;
        const found = fromRedirectMapping(mapping);
        if (found) return found;
      }
    }
  } catch { /* not a URL */ }

  try {
    const parsedJson = JSON.parse(text);
    const found = fromRedirectMapping(parsedJson);
    if (found) return found;
  } catch { /* not json */ }

  try {
    const params = new URLSearchParams(text);
    const mapping = {};
    for (const [key, item] of params.entries()) mapping[key] = item;
    const found = fromRedirectMapping(mapping);
    if (found) return found;
  } catch { /* ignore */ }

  const match = text.match(/(?:redirectResult|redirect_result)=([^&\s]+)/i);
  if (match) return decodeURIComponent(match[1]);
  const embedded = text.match(/["']?(?:redirectResult|redirect_result)["']?\s*[:=]\s*["']([^"'<>&\s]+)/i);
  return embedded ? decodeURIComponent(embedded[1]) : '';
}

/** payment_monitor.py:_extract_continue_action_result */
function extractContinueActionResult(value) {
  let parsed = value;
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  let actionResult = parsed.action_result;
  if (typeof actionResult === 'string') {
    try { actionResult = JSON.parse(actionResult); } catch { return null; }
  }
  if (!actionResult || typeof actionResult !== 'object') return null;
  const redirect = actionResult.redirectResult;
  if (typeof redirect !== 'string' || !redirect) return null;
  let serialized = '';
  try { serialized = JSON.stringify(actionResult); } catch { return null; }
  if (serialized.length > 32768) return null;
  return JSON.parse(serialized);
}

/** payment_monitor.py:_gcash_url */
function gcashUrl(value) {
  const text = htmlUnescape(String(value || ''));
  const candidates = [text];
  const found = text.match(/https:\/\/(?:[a-z0-9-]+\.)*gcash\.com\/[^\s"'<>]+/gi) || [];
  candidates.push(...found);
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const host = (parsed.hostname || '').toLowerCase();
      if (parsed.protocol === 'https:' && (host === 'gcash.com' || host.endsWith('.gcash.com'))) {
        return candidate;
      }
    } catch { /* skip */ }
  }
  return '';
}

/** payment_monitor.py:_qr_candidate_score */
function qrCandidateScore(metadata, width, height) {
  width = Number(width || 0);
  height = Number(height || 0);
  if (Math.min(width, height) < 64 || Math.max(width, height) > 900) return -1;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > 1.45) return -1;
  metadata = metadata || {};
  const marker = [
    'id', 'class_name', 'alt', 'title', 'aria_label',
    'parent_id', 'parent_class', 'grandparent_id', 'grandparent_class',
    'parent_text', 'test_id', 'src',
  ].map((key) => String(metadata[key] || '')).join(' ').toLowerCase();
  const tag = String(metadata.tag || '').toLowerCase();
  const src = String(metadata.src || '').toLowerCase();
  const hasQrMarker = /(?:^|[^a-z0-9])qr(?:code)?(?:[^a-z0-9]|$)/.test(marker);
  const hasScanMarker = marker.includes('scan') && marker.includes('code');
  if (Math.min(width, height) < 96 && !(hasQrMarker || hasScanMarker)) return -1;
  let score = Math.floor(45 * (1 - (ratio - 1) / 0.45));
  if (hasQrMarker) score += 140;
  else if (hasScanMarker) score += 90;
  if (tag === 'canvas') score += 45;
  else if (tag === 'img' || tag === 'svg') score += 12;
  if (src.startsWith('data:image/') || src.startsWith('blob:')) {
    score += (hasQrMarker || hasScanMarker || tag === 'canvas') ? 35 : 8;
  }
  if (Math.min(width, height) >= 140) score += 15;
  return score;
}

/** payment_monitor.py:_qr_candidate_is_strong */
function qrCandidateIsStrong(metadata) {
  metadata = metadata || {};
  const tag = String(metadata.tag || '').toLowerCase();
  const structuralValues = ['id', 'class_name', 'parent_id', 'parent_class', 'test_id']
    .map((key) => String(metadata[key] || '').toLowerCase());
  const normalized = structuralValues.map((value) => value.replace(/[^a-z0-9]/g, ''));
  if (normalized.some((value) => value.includes('qrcode'))) return true;
  if (tag === 'canvas') {
    const tokens = new Set(structuralValues.join(' ').match(/[a-z0-9]+/g) || []);
    return tokens.has('qr');
  }
  return false;
}

/** payment_monitor.py:_decode_png_data_url */
function decodePngDataUrl(value) {
  const text = String(value || '');
  const comma = text.indexOf(',');
  if (comma < 0) return Buffer.alloc(0);
  const header = text.slice(0, comma);
  const payload = text.slice(comma + 1);
  if (!header.toLowerCase().startsWith('data:image/png')) return Buffer.alloc(0);
  let decoded;
  try {
    if (header.toLowerCase().includes(';base64')) decoded = Buffer.from(payload, 'base64');
    else decoded = Buffer.from(decodeURIComponent(payload));
  } catch {
    return Buffer.alloc(0);
  }
  if (decoded.length < 300 || decoded.length > 5 * 1024 * 1024) return Buffer.alloc(0);
  return decoded.subarray(0, 8).equals(PNG_SIGNATURE) ? decoded : Buffer.alloc(0);
}

function pngChunk(kind, payload) {
  const type = Buffer.isBuffer(kind) ? kind : Buffer.from(kind);
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, body])) >>> 0);
  return Buffer.concat([len, type, body, crc]);
}

/** payment_monitor.py:_fallback_qr_png */
function fallbackQrPng(gcashLink) {
  const trustedLink = gcashUrl(gcashLink);
  if (!trustedLink || trustedLink !== String(gcashLink || '')) {
    throw new Error('备用二维码拒绝了非 GCash 支付链接');
  }
  const QRCode = require('qrcode');
  const qr = QRCode.create(trustedLink, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const border = 4;
  const n = size + border * 2;
  const matrix = [];
  for (let y = 0; y < n; y += 1) {
    const row = [];
    for (let x = 0; x < n; x += 1) {
      const xx = x - border;
      const yy = y - border;
      row.push(xx >= 0 && yy >= 0 && xx < size && yy < size && qr.modules.get(xx, yy));
    }
    matrix.push(row);
  }
  if (!matrix.length || matrix.length !== matrix[0].length) {
    throw new Error('备用二维码生成失败');
  }
  const scale = Math.max(2, Math.min(8, Math.floor(384 / matrix.length)));
  const width = matrix.length * scale;
  const rows = [];
  for (const sourceRow of matrix) {
    const pixels = Buffer.concat(sourceRow.map((dark) => Buffer.alloc(scale, dark ? 0x00 : 0xff)));
    const encodedRow = Buffer.concat([Buffer.from([0x00]), pixels]);
    for (let i = 0; i < scale; i += 1) rows.push(encodedRow);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 0;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function shortHash(value) {
  const text = String(value || '');
  return text ? crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12) : '';
}

/** payment_monitor.py:_route_label */
function routeLabel(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return ''; }
  const host = (parsed.hostname || '').toLowerCase();
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !host) return '';
  const segments = [];
  for (const rawSegment of (parsed.pathname || '/').split('/')) {
    const segment = decodeURIComponent(rawSegment);
    const isIdentifier = (
      segment.length > 40
      || /^[A-Za-z0-9_-]{24,}$/.test(segment)
      || /^(?:oaics|cpmt|pay|pi|pm|sess|session|redirect)_[A-Za-z0-9_-]+$/i.test(segment)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
    );
    segments.push(isIdentifier ? '<id>' : segment.replace(/[^A-Za-z0-9._~-]/g, '_'));
  }
  const path = (segments.join('/') || '/').replace(/\/{2,}/g, '/');
  return `${host}${path}`.slice(0, 180);
}

/** payment_monitor.py:_safe_log_error */
function safeLogError(value) {
  let text = String(value || '');
  text = text.replace(/\b(?:https?|socks4a?|socks5h?):\/\/[^\s"'<>]+/gi, '<url>');
  text = text.replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer <token>');
  text = text.replace(/eyJ[A-Za-z0-9_.-]+/g, '<token>');
  text = text.replace(/(redirectResult|redirect_result)\s*[:=]\s*[^\s&;,]+/gi, '$1=<redirect>');
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>');
  text = text.replace(/(?<![\w.-])[\w.-]+:\d{2,5}:[^:\s]+:[^\s]+/g, '<proxy>');
  text = text.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/g, '<ip>');
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** payment_monitor.py:_payload_status */
function payloadStatus(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return ''; }
  }
  function walk(item) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of ['status', 'payment_status', 'result_status']) {
        const status = item[key];
        if (typeof status === 'string' && status) {
          return status.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
        }
      }
      for (const child of Object.values(item)) {
        const found = walk(child);
        if (found) return found;
      }
    } else if (Array.isArray(item)) {
      for (const child of item) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return '';
  }
  return walk(parsed);
}

function randBits63() {
  const buf = crypto.randomBytes(8);
  buf[0] &= 0x7f;
  return String(buf.readBigUInt64BE());
}

function tokenHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function tokenUrlSafe(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  OPENAI_BASE,
  ADYEN_BASE,
  CHECKOUT_BASE,
  CONTINUE_PATH,
  ENTITLEMENT_URL,
  PROCESSOR_ENTITY,
  PLAN_NAME,
  PROMO_CAMPAIGN,
  HTTP_TIMEOUT,
  QR_TTL_SECONDS,
  CALLBACK_MAX_ATTEMPTS,
  CALLBACK_RETRY_DELAYS,
  CALLBACK_VERIFY_DELAYS,
  BROWSER_PROFILE,
  TLS_IMPERSONATE,
  CHROME_MAJOR,
  CHROME_FULL_VERSION,
  CHROME_USER_AGENT,
  MONITOR_TTL_SECONDS,
  MONITOR_REFRESH_GRACE_SECONDS,
  INITIAL_QR_CAPTURE_TIMEOUT,
  REFRESH_QR_CAPTURE_TIMEOUT,
  MONITOR_READY_TIMEOUT,
  MONITOR_REFRESH_TIMEOUT,
  CHECKOUT_STATUS_POLL_SECONDS,
  CALLBACK_CONFIRM_TIMEOUT_SECONDS,
  TERMINAL_STATUSES,
  CALLBACK_SUCCESS_STATUSES,
  CALLBACK_ACCEPTED_STATUSES,
  CALLBACK_FAILURE_STATUSES,
  PNG_SIGNATURE,
  CONTINUE_CONTEXT_HEADER_NAMES,
  FRONTEND_CONTEXT_COOKIE_NAMES,
  TokenRevokedError,
  QueueFullError,
  sleep,
  htmlUnescape,
  bearer,
  headers,
  parseProxy,
  ensureFullChainProxySupported,
  proxyUrl,
  playwrightProxy,
  redactHttpError,
  httpError,
  walkJson,
  amountIsZero,
  amountNumber,
  checkoutAmount,
  responseAmountIsZero,
  extractPrefixedString,
  extractCheckoutId,
  extractProcessorEntity,
  explicitPaymentStatus,
  activePlusEntitlement,
  verifyPageContext,
  callbackErrorIsRetryable,
  callbackActionResult,
  extractCpmt,
  checkoutMethodDiag,
  hostnameOf,
  isGcashUrl,
  isAdyenUrl,
  isAdyenCheckoutRedirect,
  retryDecision,
  isRetryableFailure,
  sanitizeContinueContextHeaders,
  extractRedirectResult,
  extractContinueActionResult,
  gcashUrl,
  qrCandidateScore,
  qrCandidateIsStrong,
  decodePngDataUrl,
  fallbackQrPng,
  shortHash,
  routeLabel,
  safeLogError,
  payloadStatus,
  randBits63,
  tokenHex,
  tokenUrlSafe,
};
