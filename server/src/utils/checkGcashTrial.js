'use strict';

const {
  checkoutCreateBody,
  parseCheckoutResponse,
  classifyCheckoutError,
  inspectCheckoutPayableAmount,
  gcashRequestExtra,
  gcashSentinelHeaders,
  applyGcashProcessorEntity,
  GCASH_CHAT,
} = require('./paymentLink');
const { withExtractSession, EXTRACT_BROWSER } = require('./extractHttp');
const {
  CHECKOUT_PATH,
  chatgptRequest,
  verifyProxyCountry,
  seedSession,
  compactText,
} = require('./paypalExtract');
const { newId, protoError } = require('./paymentLink');
const { phDynamicProxy } = require('./phProxy');
const opLog = require('./opLog');

function gcashDetectLog(userId, label = '账号') {
  const who = String(label || '账号').trim() || '账号';
  return (message, level = 'info') => {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) return;
    const lv = level === 'error' ? 'error' : level === 'success' ? 'success' : 'info';
    opLog.account(uid, lv, `${who}：${String(message || '')}`, { source: 'gcash-detect' });
  };
}

const FORBIDDEN = Object.freeze([
  '/backend-api/payments/checkout/taxes',
  '/backend-api/payments/checkout/confirm',
  '/backend-api/payments/checkout/custom_payment_method/start',
]);

function gcashMethodId(checkout) {
  const methods = Array.isArray(checkout?.custom_payment_methods) ? checkout.custom_payment_methods : [];
  return methods
    .map((item) => String(item?.id || '').trim())
    .find((id) => id.startsWith('cpmt_')) || '';
}

function checkoutBody() {
  return checkoutCreateBody({
    country: 'PH',
    currency: 'PHP',
    uiMode: 'custom',
    promoEnabled: true,
    promoQuery: false,
  });
}

async function checkGcashTrialOnSession(session, detail, {
  deviceId, sessionId, emit, cancelled,
} = {}) {
  const accessToken = String(detail?.access_token || '').trim();
  if (!accessToken) {
    throw protoError('账号缺少 access token', { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
  }
  if (cancelled?.()) throw protoError('任务已取消', { code: 'JOB_CANCELLED' });
  const log = typeof emit === 'function' ? emit : () => {};
  log('eligibility', '正在通过 PH / GCash 检查试用资格（POST checkout 带 plus-1-month-free，不调用 taxes/confirm/start）。');
  const did = String(deviceId || detail?.device_id || '').trim() || newId();
  const sid = sessionId || newId();
  const body = checkoutBody();
  if (!body.promo_campaign || body.promo_campaign.promo_campaign_id !== GCASH_CHAT.promoCampaignId) {
    throw protoError('GCash 资格建单必须携带 plus-1-month-free，与 HAR 建单一致', {
      status: 500,
      recoverable: false,
    });
  }
  const checkoutExtra = await gcashRequestExtra(session, did, {
    Referer: GCASH_CHAT.promoHome,
    'x-openai-target-path': CHECKOUT_PATH,
    'x-openai-target-route': CHECKOUT_PATH,
  });
  const firstSentinel = await gcashSentinelHeaders(
    session, did, GCASH_CHAT.promoHome, GCASH_CHAT.sentinelCreateFlow,
  );
  if (Object.keys(firstSentinel).length) {
    log('eligibility', '资格建单前补 PH 指纹 Sentinel 头（chatgpt_checkout）。');
  }
  const response = await chatgptRequest(session, detail, did, sid, CHECKOUT_PATH, {
    method: 'POST',
    json: body,
    extra: { ...checkoutExtra, ...firstSentinel },
  });
  const path = String(response?.url || CHECKOUT_PATH);
  if (FORBIDDEN.some((item) => path.includes(item))) {
    throw protoError('资格检测误打到了禁止接口', { status: 500, code: 'GCASH_TRIAL_FORBIDDEN_PATH' });
  }
  if (Number(response.status) >= 400 || !response.data) {
    const classified = classifyCheckoutError(response);
    log('eligibility', compactText(classified.message || response?.text || `HTTP ${response.status}`, 200));
    if (classified.code === 'EXTRACT_CHECKOUT_UNUSUAL') throw classified;
    return { has_trial: 0, payment_method_id: '', checkout: null };
  }
  const checkout = applyGcashProcessorEntity(parseCheckoutResponse(response.data, 'PH', 'PHP', false));
  const methodId = gcashMethodId(checkout);
  const ok = Boolean(methodId);
  const inspected = inspectCheckoutPayableAmount(response.data);
  const amountText = inspected.amount == null
    ? '应付金额未返回'
    : `应付 ${inspected.amount} source=${inspected.source || 'unknown'}`;
  log('eligibility', ok
    ? `checkout 返回 GCash custom payment method（${methodId.slice(0, 12)}…）。${amountText}。cpmt_ 只表示能走 GCash，不等于应付已是 0。`
    : 'checkout 未返回 cpmt_ 开头的 custom_payment_methods。');
  return {
    has_trial: ok ? 1 : 0,
    payment_method_id: methodId,
    cs_id: checkout?.cs_id || '',
    checkout,
  };
}

async function checkGcashTrial({
  detail, proxy, cancelled, log, fetchImpl,
} = {}) {
  const accessToken = String(detail?.access_token || '').trim();
  if (!accessToken) {
    throw protoError('账号缺少 access token', { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
  }
  const emit = (step, message) => { log?.(`${step}: ${message}`, 'info'); };
  const currentProxy = proxy || null;
  if (!currentProxy && typeof fetchImpl !== 'function') {
    throw protoError('GCash 资格检测需要 PH 动态代理', {
      status: 400, code: 'GCASH_TRIAL_PROXY_REQUIRED', recoverable: false,
    });
  }
  const deviceId = String(detail?.device_id || '').trim() || newId();
  return withExtractSession({
    proxy: currentProxy,
    timeoutMs: 45000,
    fetchImpl,
    impersonate: EXTRACT_BROWSER,
    acceptLanguage: GCASH_CHAT.acceptLanguage,
  }, async (session) => {
    await seedSession(session, detail, deviceId);
    if (typeof fetchImpl !== 'function') {
      await verifyProxyCountry(session, 'PH', emit, 'GCash 资格');
    }
    return checkGcashTrialOnSession(session, detail, { deviceId, emit, cancelled });
  });
}

async function checkGcashTrialForUser(userId, detail, { identity, fetchImpl, cancelled, log } = {}) {
  const proxy = fetchImpl ? null : phDynamicProxy(userId, identity || detail?.email || 'gc-trial');
  const label = detail?.email || identity || '账号';
  const logger = log || (userId ? gcashDetectLog(userId, label) : undefined);
  return checkGcashTrial({ detail, proxy, fetchImpl, cancelled, log: logger });
}

module.exports = {
  checkGcashTrial,
  checkGcashTrialForUser,
  checkGcashTrialOnSession,
  gcashDetectLog,
  gcashMethodId,
  checkoutBody,
  FORBIDDEN,
};
