'use strict';

const crypto = require('node:crypto');
const {
  chatgptHeaders,
  chatgptAccountIdFromToken,
  accountEmailFromAccessToken,
  looksLikeHtmlChallenge,
} = require('./paymentLink');

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const PATHS = Object.freeze({
  eligibility: '/backend-api/accounts/change_email/eligibility',
  begin: '/backend-api/accounts/change_email/begin',
  verify: '/backend-api/accounts/change_email/verify',
});

function dropContentType(headers = {}) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'content-type') delete next[key];
  }
  return next;
}

function headerValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value || '');
  }
  return '';
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) return text ? '<redacted>' : '';
  return `${text.slice(0, 1)}***@${text.slice(at + 1)}`;
}

function emailDomain(value) {
  const text = String(value || '').trim();
  const at = text.lastIndexOf('@');
  return at > 0 ? text.slice(at + 1).toLowerCase() : '';
}

function jsonObject(response) {
  if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
    return response.data;
  }
  const text = String(response?.text || '').trim();
  if (!text || text.startsWith('<')) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeBody(data, text) {
  if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length) {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'boolean' || typeof value === 'number') out[key] = value;
      else if (value == null) out[key] = value;
      else if (typeof value === 'string') {
        if (value.includes('@')) out[key] = maskEmail(value);
        else if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(value)) out[key] = '<redacted>';
        else out[key] = value.slice(0, 80);
      } else out[key] = Array.isArray(value) ? `array:${value.length}` : typeof value;
    }
    return out;
  }
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (looksLikeHtmlChallenge(raw)) return { html_challenge: true, length: raw.length };
  return { text_length: raw.length };
}

function errorCodeOf(data) {
  if (!data || typeof data !== 'object') return '';
  const err = data.error;
  if (err && typeof err === 'object') return String(err.code || err.error || err.type || '').trim();
  if (typeof err === 'string') return err.trim();
  return String(data.code || data.error_code || '').trim();
}

function errorReasonOf(data) {
  if (!data || typeof data !== 'object') return '';
  const err = data.error && typeof data.error === 'object' ? data.error : {};
  return String(data.reason || data.message || data.detail || err.message || err.detail || '').trim();
}

function booleanField(data, names) {
  for (const name of names) {
    if (typeof data?.[name] === 'boolean') return data[name];
  }
  return undefined;
}

function interpretEligibility(response) {
  const status = Number(response?.status) || 0;
  const data = jsonObject(response);
  const keys = Object.keys(data);
  const errorCode = errorCodeOf(data);
  const reason = errorReasonOf(data).slice(0, 160);
  const flagged = booleanField(data, ['eligible', 'can_change_email', 'canChangeEmail', 'allowed']);
  let eligible;
  if (typeof flagged === 'boolean') eligible = flagged;
  else if (status === 200 && data.success === true && !errorCode) eligible = true;
  else if (status !== 200 || errorCode || reason) eligible = false;
  else eligible = null;
  return {
    status,
    eligible,
    errorCode,
    reason,
    keys,
    summary: summarizeBody(data, response?.text),
    html_challenge: looksLikeHtmlChallenge(response?.text),
  };
}

function interpretMutation(response) {
  const status = Number(response?.status) || 0;
  const data = jsonObject(response);
  const errorCode = errorCodeOf(data);
  const reason = errorReasonOf(data).slice(0, 160);
  const ok = status === 200 && !errorCode && (data.success === true || data.success === undefined);
  return {
    status,
    ok,
    success: data.success,
    errorCode,
    reason,
    keys: Object.keys(data),
    summary: summarizeBody(data, response?.text),
    html_challenge: looksLikeHtmlChallenge(response?.text),
  };
}

function canBeginChangeEmail(eligibility) {
  if (!eligibility) return false;
  if (eligibility.eligible === false) return false;
  if (eligibility.status !== 200) return false;
  if (eligibility.html_challenge) return false;
  if (eligibility.errorCode) return false;
  return eligibility.eligible === true || eligibility.eligible === null;
}

function changeEmailContext(detail = {}, ids = {}) {
  const accessToken = String(detail.accessToken || detail.access_token || '').trim();
  return {
    accessToken,
    deviceId: String(ids.deviceId || detail.deviceId || '').trim() || crypto.randomUUID(),
    sessionId: String(ids.sessionId || detail.sessionId || '').trim() || crypto.randomUUID(),
    accountId: String(
      ids.accountId
      || detail.chatgpt_account_id
      || detail.accountId
      || chatgptAccountIdFromToken(accessToken)
      || '',
    ).trim(),
  };
}

function changeEmailHeaders(ctx, { includeAccountId = false, extra = {}, fingerprint } = {}) {
  return chatgptHeaders({
    accessToken: ctx.accessToken,
    deviceId: ctx.deviceId,
    sessionId: ctx.sessionId,
    accountId: includeAccountId ? ctx.accountId : '',
    extra,
    fingerprint,
  });
}

async function changeEmailRequest(session, ctx, path, {
  method = 'GET',
  json,
  includeAccountId = false,
  extra = {},
} = {}) {
  const verb = String(method || 'GET').toUpperCase();
  let headers = changeEmailHeaders(ctx, {
    includeAccountId,
    extra,
    fingerprint: session?.fingerprint,
  });
  if (verb === 'GET' || verb === 'HEAD') headers = dropContentType(headers);
  const options = {
    method: verb,
    headers,
    timeout: 45000,
  };
  if (verb !== 'GET' && verb !== 'HEAD' && json !== undefined) options.json = json;
  return session.request(`${CHATGPT_ORIGIN}${path}`, options);
}

function pageExtra(extra = {}) {
  return {
    Origin: CHATGPT_ORIGIN,
    Referer: `${CHATGPT_ORIGIN}/`,
    ...extra,
  };
}

async function checkChangeEmailEligibility(session, ctx, extra = {}) {
  return changeEmailRequest(session, ctx, PATHS.eligibility, {
    method: 'GET',
    includeAccountId: false,
    extra: pageExtra(extra),
  });
}

async function beginChangeEmail(session, ctx, email, extra = {}) {
  return changeEmailRequest(session, ctx, PATHS.begin, {
    method: 'POST',
    includeAccountId: true,
    json: { email: String(email || '').trim() },
    extra: pageExtra(extra),
  });
}

async function verifyChangeEmail(session, ctx, { email, code } = {}, extra = {}) {
  return changeEmailRequest(session, ctx, PATHS.verify, {
    method: 'POST',
    includeAccountId: true,
    json: {
      email: String(email || '').trim(),
      code: String(code || '').trim(),
    },
    extra: pageExtra(extra),
  });
}

module.exports = {
  CHATGPT_ORIGIN,
  PATHS,
  dropContentType,
  headerValue,
  maskEmail,
  emailDomain,
  jsonObject,
  summarizeBody,
  interpretEligibility,
  interpretMutation,
  canBeginChangeEmail,
  changeEmailContext,
  changeEmailHeaders,
  changeEmailRequest,
  checkChangeEmailEligibility,
  beginChangeEmail,
  verifyChangeEmail,
  chatgptAccountIdFromToken,
  accountEmailFromAccessToken,
};
