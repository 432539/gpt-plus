const crypto = require('node:crypto');
const { totpSnapshot } = require('../lib/totp');

const ORIGIN = 'https://chatgpt.com';
const INFO_URL = `${ORIGIN}/backend-api/accounts/mfa_info`;
const ENROLL_URL = `${ORIGIN}/backend-api/accounts/mfa/enroll`;
const ACTIVATE_URL = `${ORIGIN}/backend-api/accounts/mfa/user/activate_enrollment`;
const MFA_INFO_MAX_ATTEMPTS = 5;
const MFA_ENROLL_MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const MIN_CODE_VALIDITY_MS = 4000;
const TOTP_PERIOD_MS = 30000;
const MFA_REQUEST_TIMEOUT_MS = 15000;
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%*';
const ALPHABET = LOWER + UPPER + DIGITS + SYMBOLS;

function generateAccountPassword(length = 20) {
  const size = Math.max(14, Math.min(128, Number(length) || 20));
  const out = [
    LOWER[crypto.randomInt(LOWER.length)],
    UPPER[crypto.randomInt(UPPER.length)],
    DIGITS[crypto.randomInt(DIGITS.length)],
    SYMBOLS[crypto.randomInt(SYMBOLS.length)],
  ];
  while (out.length < size) out.push(ALPHABET[crypto.randomInt(ALPHABET.length)]);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = crypto.randomInt(index + 1);
    [out[index], out[swap]] = [out[swap], out[index]];
  }
  return out.join('');
}

class AccountSecurityError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'AccountSecurityError';
    this.code = code;
    this.status = status;
  }
}

const root = value => (value?.data && typeof value.data === 'object' ? value.data : value || {});
const headers = ({ accessToken, deviceId, json = false }) => ({
  Accept: 'application/json',
  Origin: ORIGIN,
  Referer: `${ORIGIN}/`,
  'OAI-Language': 'en-US',
  ...(deviceId ? { 'OAI-Device-Id': deviceId } : {}),
  ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

function detail(response) {
  return String(root(response)?.error?.message || root(response)?.detail || root(response)?.message || response?.text || '')
    .replace(/\b[A-Z2-7]{16,128}\b/gi, '<redacted>')
    .replace(/\b\d{6}\b/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function failure(action, response, code) {
  const status = Number(response?.status) || 0;
  return new AccountSecurityError(`${action} HTTP ${status || 'unknown'}${detail(response) ? `: ${detail(response)}` : ''}`, code, status);
}

function stateOf(value) {
  const valueRoot = root(value);
  const raw = valueRoot.factors;
  const factors = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.totp) ? raw.totp : raw?.totp && typeof raw.totp === 'object' ? Object.values(raw.totp) : [];
  const totp = factors.filter(item => String(item?.factor_type || item?.type || 'totp').toLowerCase() === 'totp');
  return {
    enabled: valueRoot.mfa_enabled_v2 === true || valueRoot.mfa_enabled === true,
    factors: totp,
    factorId: String(valueRoot.native_default_factor_id || totp[0]?.id || ''),
  };
}

async function readInfo(session, options) {
  const deadline = Date.now() + options.timeoutMs;
  let last;
  for (let attempt = 1; attempt <= MFA_INFO_MAX_ATTEMPTS; attempt += 1) {
    if (options.cancelled?.()) throw new AccountSecurityError('任务已取消', 'JOB_CANCELLED');
    try {
      const response = await session.request(INFO_URL, {
        headers: headers(options), contextUrl: `${ORIGIN}/`, referrer: `${ORIGIN}/`,
        timeout: Math.max(1, deadline - Date.now()),
      });
      if (!response?.ok) throw failure('读取 2FA 状态失败', response, 'ACCOUNT_MFA_INFO_FAILED');
      return stateOf(response.data);
    } catch (error) {
      last = error;
      const transient = ['PROTOCOL_REQUEST_TIMEOUT', 'PROTOCOL_REQUEST_NETWORK'].includes(String(error?.code || ''))
        || /ERR_(?:TIMED_OUT|CONNECTION|NETWORK_CHANGED)|timeout|socket hang up/i.test(String(error?.message || error));
      if (!transient || attempt >= MFA_INFO_MAX_ATTEMPTS || Date.now() + RETRY_DELAY_MS >= deadline) throw error;
      options.log?.(`MFA 状态读取遇到瞬态网络错误，同一会话内重试 ${attempt + 1}/${MFA_INFO_MAX_ATTEMPTS}`, 'warn');
      await options.wait(RETRY_DELAY_MS);
    }
  }
  throw last;
}

async function createEnrollment(session, request) {
  let last;
  for (let attempt = 1; attempt <= MFA_ENROLL_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await session.request(ENROLL_URL, {
        method: 'POST', headers: headers({ ...request, json: true }), json: { factor_type: 'totp' },
        contextUrl: `${ORIGIN}/`, referrer: `${ORIGIN}/`, timeout: request.timeoutMs,
      });
      if (response?.ok) return response;
      last = failure('创建 TOTP 2FA 失败', response, 'ACCOUNT_MFA_ENROLL_FAILED');
      if (![408, 502, 503, 504].includes(Number(response?.status))
        && !(Number(response?.status) === 500 && /request|upstream|gateway.*timeout/i.test(detail(response)))) throw last;
    } catch (error) {
      last = error instanceof AccountSecurityError
        ? error
        : Object.assign(new AccountSecurityError(`创建 TOTP 2FA 失败: ${String(error?.message || error).slice(0, 200)}`, 'ACCOUNT_MFA_ENROLL_FAILED'), { cause: error });
      if (!/timeout|ERR_(?:TIMED_OUT|CONNECTION|NETWORK_CHANGED)|socket hang up/i.test(String(error?.message || error))
        && !['PROTOCOL_REQUEST_TIMEOUT', 'PROTOCOL_REQUEST_NETWORK'].includes(String(error?.code || ''))) throw last;
    }
    if (attempt >= MFA_ENROLL_MAX_ATTEMPTS) throw last;
    request.log?.(`MFA enroll 遇到瞬时错误，同一会话内重试 ${attempt + 1}/${MFA_ENROLL_MAX_ATTEMPTS}`, 'warn');
    await request.wait(RETRY_DELAY_MS);
  }
  throw last;
}

async function enableTotp(session, options = {}) {
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || MFA_REQUEST_TIMEOUT_MS);
  const wait = typeof options.wait === 'function'
    ? options.wait
    : ms => (typeof session.wait === 'function' ? session.wait(ms) : new Promise(resolve => setTimeout(resolve, ms)));
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const request = { ...options, timeoutMs, wait };
  const initial = await readInfo(session, request);
  if (initial.enabled) {
    const secret = String(options.existingSecret || '').replace(/\s+/g, '').toUpperCase();
    if (!secret) {
      const error = new AccountSecurityError('账号已启用 TOTP，但本地没有对应密钥', 'ACCOUNT_MFA_SECRET_MISSING');
      error.mfaEnabled = true;
      error.factorId = initial.factorId;
      throw error;
    }
    return { totp_secret: secret, mfa_factor_id: initial.factorId, mfa_factor_type: 'totp', mfa_enabled: true, already_enabled: true };
  }

  options.progress?.(92, '创建 ChatGPT TOTP 2FA');
  const enrolled = await createEnrollment(session, request);
  const data = root(enrolled);
  const secret = String(data.secret || '').replace(/\s+/g, '').toUpperCase();
  const sessionId = String(data.session_id || '');
  const factorId = String(data.factor?.id || '');
  if (!/^[A-Z2-7]{16,128}$/.test(secret) || !sessionId || !factorId) {
    throw new AccountSecurityError('TOTP enroll 响应缺少 secret、session_id 或 factor.id', 'ACCOUNT_MFA_ENROLL_INVALID');
  }
  await options.onEnrollment?.({
    totp_secret: secret, mfa_factor_id: factorId, mfa_factor_type: 'totp',
    mfa_enabled: false, hardening_status: 'mfa_enrolling',
  });

  let last;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (options.cancelled?.()) throw new AccountSecurityError('任务已取消', 'JOB_CANCELLED');
    const remaining = TOTP_PERIOD_MS - (clock() % TOTP_PERIOD_MS);
    if (attempt > 1 || remaining <= MIN_CODE_VALIDITY_MS) await wait(remaining + 50);
    const code = totpSnapshot(secret, { now: clock() }).code;
    try {
      const activated = await session.request(ACTIVATE_URL, {
        method: 'POST', headers: headers({ ...request, json: true }),
        json: { code, factor_type: 'totp', session_id: sessionId },
        contextUrl: `${ORIGIN}/`, referrer: `${ORIGIN}/`, timeout: timeoutMs,
      });
      if (!activated?.ok) throw failure('激活 TOTP 2FA 失败', activated, 'ACCOUNT_MFA_ACTIVATE_FAILED');
      last = null;
    } catch (error) {
      last = error;
    }
    const confirmed = await readInfo(session, request);
    if (confirmed.enabled && confirmed.factors.some(item => String(item?.id || '') === factorId)) {
      return { totp_secret: secret, mfa_factor_id: factorId, mfa_factor_type: 'totp', mfa_enabled: true };
    }
    last ||= new AccountSecurityError('激活响应成功，但 2FA 状态未确认', 'ACCOUNT_MFA_VERIFY_FAILED');
  }
  throw last || new AccountSecurityError('TOTP 2FA 激活后未通过状态确认', 'ACCOUNT_MFA_VERIFY_FAILED');
}

const accountSecurityEndpoints = Object.freeze({ info: INFO_URL, enroll: ENROLL_URL, activate: ACTIVATE_URL });

exports.MFA_REQUEST_TIMEOUT_MS = MFA_REQUEST_TIMEOUT_MS;
exports.generateAccountPassword = generateAccountPassword;
exports.AccountSecurityError = AccountSecurityError;
exports.enableTotp = enableTotp;
exports.accountSecurityEndpoints = accountSecurityEndpoints;
