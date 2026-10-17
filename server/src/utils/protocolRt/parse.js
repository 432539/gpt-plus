'use strict';

const { AUTH_BASE, CODEX_REDIRECT_URI, PHONE_PAGE_TYPES, CONSENT_PAGE_TYPES } = require('./constants');

class RtLoginError extends Error {
  constructor(message, code = 'ACCOUNT_RT_PROTOCOL_FAILED', extra = {}) {
    super(message);
    this.name = 'RtLoginError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function pageType(body) {
  if (!body || typeof body !== 'object') return '';
  const page = body.page;
  if (page && typeof page === 'object') return String(page.type || '').trim().toLowerCase();
  return String(body.type || '').trim().toLowerCase();
}

function apiErrorCode(body) {
  if (!body || typeof body !== 'object') return '';
  const err = body.error;
  if (err && typeof err === 'object') return String(err.code || err.error || '').trim();
  return String(body.code || '').trim();
}

function factorIdFromBody(body) {
  if (!body || typeof body !== 'object') return '';
  const page = body.page && typeof body.page === 'object' ? body.page : {};
  const payload = page.payload && typeof page.payload === 'object' ? page.payload : {};
  const fid = String(payload.factor_id || '').trim();
  if (fid) return fid;
  const factors = Array.isArray(payload.factors) ? payload.factors : [];
  for (const item of factors) {
    if (!item || typeof item !== 'object') continue;
    if (['totp', 'otp'].includes(String(item.type || '').toLowerCase()) || item.id) {
      return String(item.id || '').trim();
    }
  }
  return '';
}

function continueUrl(body) {
  if (!body || typeof body !== 'object') return '';
  const sources = [body, body.data && typeof body.data === 'object' ? body.data : {}];
  for (const source of sources) {
    for (const key of ['continue_url', 'redirect_url', 'url', 'continueUrl', 'redirectUrl']) {
      const value = source[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return '';
}

function isPhoneStep(kind, body) {
  if (PHONE_PAGE_TYPES.has(String(kind || '').trim().toLowerCase())) return true;
  const url = continueUrl(body).toLowerCase();
  return /add-phone|phone-otp|phone-verification/.test(url);
}

function isConsentStep(kind, body) {
  if (CONSENT_PAGE_TYPES.has(String(kind || '').trim().toLowerCase())) return true;
  const url = continueUrl(body).toLowerCase();
  return /sign-in-with-chatgpt|\/codex\/consent|oauth2\/auth|login_verifier|consent_challenge|\/workspace|\/organization/.test(url);
}

function isCodexCallbackUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    const host = String(parsed.hostname || '').toLowerCase();
    if ((host === 'localhost' || host === '127.0.0.1') && Number(parsed.port) === 1455) return true;
  } catch {
    return String(url).startsWith(CODEX_REDIRECT_URI);
  }
  return String(url).startsWith(CODEX_REDIRECT_URI);
}

function extractCode(url) {
  if (!url || !String(url).includes('code=')) return '';
  try {
    return new URL(String(url)).searchParams.get('code') || '';
  } catch {
    return '';
  }
}

function absUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${AUTH_BASE}${value.startsWith('/') ? value : `/${value}`}`;
}

function urlForLog(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.host ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : parsed.pathname;
  } catch {
    return '<invalid-url>';
  }
}

function isRtGateBlock(exc) {
  const text = String(exc?.message || exc || '');
  if (text.includes('登录小门被门禁拦住')) return true;
  return /HTTP 403|HTTP 429|HTTP 503/.test(text);
}

function cuteSmsError(exc) {
  const text = String(exc?.message || exc || '').trim();
  const low = text.toLowerCase();
  const name = exc?.name || '';
  if ((name === 'ValueError' || name === 'RtLoginError' || name === 'SmsBowerError') && /api key/i.test(low) && (/空/.test(text) || /missing/i.test(low))) {
    return '接码 API Key 还没填，去接码设置里贴上再试';
  }
  if (text.includes('暂未配置') && text.includes('国家')) {
    return '接码国家代码不认识，请改成 CL / US / NL 这种两位代号';
  }
  if (low.includes('bad_key') || text.includes('API Key 无效')) return '接码 API Key 无效，去接码设置核对一下';
  if (text.includes('402') || low.includes('no_balance') || text.includes('余额不足')) return '接码账户余额不够啦，先去平台充值';
  if (low.includes('no_numbers') || text.includes('没有可用号码') || low.includes('no number')) {
    return '这个国家暂时没有 OpenAI 的号，去接码设置换个国家再试（默认智利 CL，不用改代理地区）';
  }
  if (low.includes('bad_service') || low.includes('wrong_service') || text.includes('服务代码')) {
    return '接码服务代码不对，OpenAI 请填 openai 或 oa';
  }
  if (text.includes('连接失败') || low.includes('timed out') || low.includes('timeout')) {
    return '接码平台连不上，过几秒再点拿 RT';
  }
  if (text.includes('取号响应缺少')) return '接码平台回了空号，换个国家或稍后再试';
  if (low.includes('http 40') || low.includes('http 50')) return '接码接口打回来了错误状态，稍后重试或检查服务代码';
  if (text) return `接码领号失败：${text.slice(0, 80)}`;
  return '接码领号失败，去接码设置看看国家和 API Key';
}

module.exports = {
  RtLoginError,
  pageType,
  apiErrorCode,
  factorIdFromBody,
  continueUrl,
  isPhoneStep,
  isConsentStep,
  isCodexCallbackUrl,
  extractCode,
  absUrl,
  urlForLog,
  isRtGateBlock,
  cuteSmsError,
};
