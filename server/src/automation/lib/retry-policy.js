'use strict';

const TERMINAL_CODES = new Set([
  'JOB_CANCELLED',
  'MAIL_PROVIDER_NOT_CONFIGURED',
  'PHONE_PROVIDER_NOT_CONFIGURED',
  'DYNAMIC_PROXY_PROVIDER_NOT_CONFIGURED',
  'AUTH_CONTINUE_RATE_LIMITED',
  'REGISTER_EMAIL_BOUND_TO_IDP',
  'REGISTER_PASSWORD_LOGIN_REQUIRED',
  'REGISTER_PASSWORD_REQUIRED',
  'REGISTER_HEADLESS_PASSWORD_REQUIRED',
  'REGISTER_HEADLESS_EMAIL_NOT_NEW',
  'REGISTER_ACCOUNT_CREATION_REJECTED',
  'REGISTER_PASSWORD_FAILED',
  'MAILBOX_OTP_NOT_RECEIVED',
  'CHATGPT_OAUTH_UNSUPPORTED',
  'ACCOUNT_RT_REFRESH_VERIFY_FAILED',
  'CLOAK_LAUNCH_FAILED',
  'CLOAK_LICENSE_INVALID',
  'CLOAK_LICENSE_LOCAL_CONFIG',
  'AUTH_CONTINUE_PHONE_CODE_REJECTED',
  'AUTH_CONTINUE_PHONE_ALREADY_IN_USE_EXHAUSTED',
  'AUTH_CONTINUE_PHONE_REPUTATION_EXHAUSTED',
  'AUTH_CONTINUE_SMS_TIMEOUT_EXHAUSTED',
  'AUTH_CONTINUE_PHONE_REPLACEMENT_FAILED',
  'AUTH_CONTINUE_PHONE_PRICE_UNAVAILABLE',
  'AUTH_CONTINUE_PHONE_REJECTED',
  'AUTH_CONTINUE_PHONE_ACQUIRE_FAILED',
  'AUTH_CONTINUE_SMS_NOT_STARTED',
  'AUTH_CONTINUE_SESSION_NOT_SELECTED',
  'AUTH_CONTINUE_TOO_MANY_STEPS',
  'AUTH_CONTINUE_ERROR_PAGE',
]);

const RETRYABLE_CODES = new Set([
  'SENTINEL_TOKEN_FAILED',
  'PROTOCOL_REQUEST_TIMEOUT',
  'PROTOCOL_REQUEST_NETWORK',
  'AUTH_CONTINUE_SESSION_EXPIRED',
  'AUTH_CONTINUE_PHONE_ALREADY_IN_USE',
  'AUTH_CONTINUE_PHONE_REPUTATION',
  'REGISTER_AUTH_OFF_DOMAIN',
  'REGISTER_HEADLESS_NO_AUTH_HOST',
  'REGISTER_HEADLESS_AUTH_PAGE_FAILED',
  'REGISTER_HEADLESS_NO_EMAIL_FIELD',
  'REGISTER_HEADLESS_EMAIL_INPUT_UNSTABLE',
  'REGISTER_HEADLESS_PASSWORD_CHOICE_STALLED',
  'REGISTER_HEADLESS_PASSWORD_STALLED',
  'REGISTER_HEADLESS_OTP_STALLED',
  'REGISTER_HEADLESS_OTP_VALUE_REJECTED',
  'REGISTER_HEADLESS_OTP_INVALID_FORMAT',
  'REGISTER_HEADLESS_ABOUT_FIELDS_MISSING',
  'REGISTER_HEADLESS_ABOUT_REJECTED',
  'REGISTER_HEADLESS_NO_CALLBACK',
  'REGISTER_HEADLESS_ENTRY_TIMEOUT',
  'REGISTER_HEADLESS_ENTRY_NAVIGATION_FAILED',
  'CHATGPT_OAUTH_NO_CODE',
  'AUTH_CONTINUE_NO_SESSION_ID',
  'AUTH_CONTINUE_NO_WORKSPACE',
  'AUTH_CONTINUE_SMS_TIMEOUT',
  'AUTH_CONTINUE_SMS_FAILED',
  'AUTH_CONTINUE_UNKNOWN_PAGE',
  'CLOAK_BROWSER_DISCONNECTED',
  'CLOAK_BROWSER_CRASHED',
  'CLOAK_SESSION_WALL_TIMEOUT',
  'CLOAK_LICENSE_SESSION_LIMIT',
  'CLOAK_LICENSE_UNAVAILABLE',
  'MAILBOX_OTP_FETCH_FAILED',
]);

const TERMINAL_MESSAGES = [
  /deleted or deactivated/i,
  /insufficient balance/i,
  /account already exists/i,
  /user[_ -]?already[_ -]?exists/i,
  /已存在/,
  /无可用价格段号码/,
];
const RETRYABLE_MESSAGES = [
  /ERR_TIMED_OUT|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION|ERR_PROXY/i,
  /协议请求超时|上下文加载失败|等待验证邮件超时/,
  /Timeout \d+ms exceeded/i,
  /spawn EPERM/i,
];

function classifyRegisterFailure(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || error || '');
  if (TERMINAL_CODES.has(code) || TERMINAL_MESSAGES.some(pattern => pattern.test(message))) {
    return { retryable: false, terminal: true, code: code || 'TERMINAL', reason: '重试无效或会额外计费' };
  }
  if (RETRYABLE_CODES.has(code) || RETRYABLE_MESSAGES.some(pattern => pattern.test(message))) {
    return { retryable: true, terminal: false, code: code || 'RETRYABLE', reason: '偶发失败，换一轮可能成功' };
  }
  return { retryable: true, terminal: false, code: code || 'UNKNOWN', reason: '未归类失败，按可重试处理' };
}

const REGISTER_MAX_ATTEMPTS = 3;
const BATCH_INFRASTRUCTURE_FAILURE_CODES = Object.freeze([
  'CLOAK_LICENSE_INVALID',
  'CLOAK_LICENSE_UNAVAILABLE',
  'CLOAK_LICENSE_LOCAL_CONFIG',
  'PROXY_EXIT_ACQUIRE_EXHAUSTED',
  'PROXY_EXIT_PROBE_FAILED',
  'PROXY_EXIT_INVALID',
  'PROXY_EXIT_COUNTRY_MISMATCH',
  'PROXY_EXIT_COLLISION',
  'HEROSMS_CODE_TIMEOUT',
  'HEROSMS_EMAIL_BANNED',
  'HEROSMS_ACCOUNT_BANNED',
  'HEROSMS_ACTIVE_WINDOW_FULL',
]);
const CAPACITY_FAILURE_CODES = Object.freeze([
  'CLOAK_LICENSE_SESSION_LIMIT',
]);

function registerRetryDelayMs(attempt, random = Math.random) {
  const round = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = Math.min(4000, 500 * (2 ** (round - 1)));
  const sample = Math.max(0, Math.min(1, Number(random?.()) || 0));
  return base + Math.floor(sample * 251);
}

function registerFailureRetryDelayMs(error, attempt, random = Math.random) {
  const code = String(error?.code || '');
  if (!['CLOAK_LICENSE_UNAVAILABLE', 'CLOAK_LICENSE_SESSION_LIMIT'].includes(code)) {
    return registerRetryDelayMs(attempt, random);
  }
  const round = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = code === 'CLOAK_LICENSE_SESSION_LIMIT'
    ? Math.min(60000, 15000 * (2 ** Math.min(2, round - 1)))
    : Math.min(15000, 3000 * (2 ** (round - 1)));
  const sample = Math.max(0, Math.min(1, Number(random?.()) || 0));
  return base + Math.floor(sample * (code === 'CLOAK_LICENSE_SESSION_LIMIT' ? 2001 : 1001));
}

exports.REGISTER_MAX_ATTEMPTS = REGISTER_MAX_ATTEMPTS;
exports.BATCH_INFRASTRUCTURE_FAILURE_CODES = BATCH_INFRASTRUCTURE_FAILURE_CODES;
exports.CAPACITY_FAILURE_CODES = CAPACITY_FAILURE_CODES;
exports.registerRetryDelayMs = registerRetryDelayMs;
exports.registerFailureRetryDelayMs = registerFailureRetryDelayMs;
exports.REGISTER_TERMINAL_CODES = TERMINAL_CODES;
exports.REGISTER_RETRYABLE_CODES = RETRYABLE_CODES;
exports.classifyRegisterFailure = classifyRegisterFailure;
