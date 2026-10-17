'use strict';

const crypto = require('node:crypto');
const AUTH_ORIGIN = 'https://auth.openai.com';
const AUTH_API = `${AUTH_ORIGIN}/api/accounts`;
const SENTINEL_FLOW_CONTINUE = 'authorize_continue';
const SENTINEL_FLOW_PHONE_OTP = 'verify_phone_otp';
const PHONE_REPLACEMENT_ATTEMPTS = 10;
const AUTH_CONTINUE_MAX_STEPS = 12;

const AUTH_PAGES = Object.freeze({
  CALLBACK: 'callback', CHOOSE_ACCOUNT: 'choose_account', ADD_PHONE: 'add_phone',
  PHONE_VERIFICATION: 'phone_verification', WORKSPACE: 'workspace', LOGIN: 'login',
  ERROR: 'error', UNKNOWN: 'unknown',
});

class AuthContinueError extends Error {
  constructor(message, code = 'AUTH_CONTINUE_FAILED', { page = '', retryable = false, detail } = {}) {
    super(message);
    this.name = 'AuthContinueError';
    this.code = code;
    this.page = page;
    this.retryable = retryable;
    if (detail !== undefined) this.detail = detail;
  }
}

function classifyAuthPage(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return AUTH_PAGES.UNKNOWN; }
  if (url.hostname === 'localhost' && url.pathname === '/auth/callback') return AUTH_PAGES.CALLBACK;
  const path = url.pathname.toLowerCase();
  if (path.includes('choose-an-account')) return AUTH_PAGES.CHOOSE_ACCOUNT;
  if (path.includes('add-phone')) return AUTH_PAGES.ADD_PHONE;
  if (path.includes('phone-verification') || path.includes('phone-otp')) return AUTH_PAGES.PHONE_VERIFICATION;
  if (/\/(?:consent|workspace|organization)|sign-in-with-chatgpt/.test(path)) return AUTH_PAGES.WORKSPACE;
  if (path === '/log-in' || path === '/login') return AUTH_PAGES.LOGIN;
  if (path.endsWith('/error')) return AUTH_PAGES.ERROR;
  return AUTH_PAGES.UNKNOWN;
}

function callbackResult(rawUrl, state) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return null; }
  if (url.hostname !== 'localhost' || url.pathname !== '/auth/callback') return null;
  if (state && String(url.searchParams.get('state') || '') !== String(state)) return null;
  const error = String(url.searchParams.get('error') || '');
  return {
    code: String(url.searchParams.get('code') || ''),
    error,
    detail: String(url.searchParams.get('error_description') || '') || error,
  };
}

function parseAuthSessionId(text) {
  return String(text || '').match(/\bus_[A-Za-z0-9_-]{8,}\b/)?.[0] || '';
}

function parseWorkspacesFromAuthCookie(value) {
  let raw = String(value || '');
  try { raw = decodeURIComponent(raw); } catch {}
  if (!raw) return [];
  const candidates = [raw];
  for (const segment of raw.split(/[.:]/)) {
    if (segment.length < 16) continue;
    try { candidates.push(Buffer.from(segment, 'base64').toString('utf8')); } catch {}
  }
  const found = new Map();
  for (const text of candidates) {
    for (const match of text.matchAll(/"(?:workspace_)?id"\s*:\s*"([0-9a-f-]{36})"(?:[^{}]*?"(?:name|title)"\s*:\s*"([^"]{0,80})")?/gi)) {
      if (!found.has(match[1])) found.set(match[1], { id: match[1], name: match[2] || '' });
    }
  }
  return [...found.values()];
}

function pickWorkspace(workspaces = []) {
  const list = workspaces.filter(item => item?.id);
  return list.find(item => /personal|个人/i.test(item.name || '')) || list[0] || null;
}

function parseAuthErrorPayload(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return null; }
  if (!url.pathname.endsWith('/error')) return null;
  const raw = String(url.searchParams.get('payload') || '').trim();
  if (!raw) return null;
  const candidates = [raw];
  try { candidates.unshift(decodeURIComponent(raw)); } catch {}
  try { candidates.unshift(Buffer.from(raw, 'base64').toString('utf8')); } catch {}
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return { raw };
}

function responseObject(response) {
  if (response?.data && typeof response.data === 'object') return response.data;
  try { return JSON.parse(String(response?.text || '')); } catch { return null; }
}

function collectUrls(value, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    if (/^(?:https?:\/\/|\/)/i.test(value)) out.push(value);
    return out;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const key of ['continue_url', 'redirect_url', 'url', 'href']) collectUrls(value[key], out, seen);
  for (const [key, child] of Object.entries(value)) {
    if (!['continue_url', 'redirect_url', 'url', 'href'].includes(key)) collectUrls(child, out, seen);
  }
  return out;
}

const RESPONSE_ROUTES = {
  choose_an_account: `${AUTH_ORIGIN}/choose-an-account`,
  add_phone: `${AUTH_ORIGIN}/add-phone`,
  phone_otp_send: `${AUTH_ORIGIN}/phone-verification`,
  phone_otp_verification: `${AUTH_ORIGIN}/phone-verification`,
  workspace: `${AUTH_ORIGIN}/workspace`,
  sign_in_with_chatgpt_consent: `${AUTH_ORIGIN}/sign-in-with-chatgpt/consent`,
  sign_in_with_chatgpt_codex_consent: `${AUTH_ORIGIN}/sign-in-with-chatgpt/codex/consent`,
  sign_in_with_chatgpt_codex_org: `${AUTH_ORIGIN}/sign-in-with-chatgpt/codex/organization`,
  error: `${AUTH_ORIGIN}/error`,
};

function authResponseTransition(response) {
  const data = responseObject(response);
  if (!data) return null;
  const type = String(data.page?.type || data.page_type || '').trim().toLowerCase().replaceAll('-', '_');
  const urls = collectUrls(data).map(value => {
    try { return new URL(value, AUTH_ORIGIN).href; } catch { return ''; }
  }).filter(Boolean);
  const callback = urls.find(value => callbackResult(value));
  if (callback) return { page: AUTH_PAGES.CALLBACK, url: callback, type, data };
  const url = RESPONSE_ROUTES[type] || urls.find(value => value.startsWith(`${AUTH_ORIGIN}/`)) || '';
  return url ? { page: classifyAuthPage(url), url, type, data } : (type ? { page: AUTH_PAGES.UNKNOWN, url: '', type, data } : null);
}

const responseMessage = response => {
  const data = responseObject(response) || {};
  return String(data.error?.message || data.error?.code || data.message || data.detail || response?.text || '').replace(/\s+/g, ' ').slice(0, 200);
};
const responseHeader = (response, name) => {
  if (typeof response?.headers?.get === 'function') return String(response.headers.get(name) || '');
  const key = Object.keys(response?.headers || {}).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? String(response.headers[key] || '') : '';
};

async function authPost(session, path, json, { referer, sentinel = {}, timeoutMs }) {
  return session.request(`${AUTH_API}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: AUTH_ORIGIN,
      Referer: referer, 'X-Access-Flow-Invocation-Id': crypto.randomUUID(), ...sentinel,
    },
    json, contextUrl: referer, referrer: referer, timeout: timeoutMs,
  });
}

async function routeTransition(session, response, sourcePage, previousUrl, timeoutMs) {
  const current = String(session.page.url() || '');
  if (current && current !== previousUrl) return { page: classifyAuthPage(current), url: current };
  const next = authResponseTransition(response);
  if (!next) throw new AuthContinueError('AuthAPI 响应缺少 continuation page/continue_url', 'AUTH_CONTINUE_INVALID_RESPONSE', { page: sourcePage });
  if ([AUTH_PAGES.CALLBACK, AUTH_PAGES.ERROR].includes(next.page)) return next;
  if (!next.url || next.page === AUTH_PAGES.UNKNOWN) {
    throw new AuthContinueError(`AuthAPI 返回未支持的 continuation page.type=${next.type || 'unknown'}`, 'AUTH_CONTINUE_UNKNOWN_PAGE', { page: sourcePage });
  }
  const navigate = typeof session.replaceRoute === 'function'
    ? url => session.replaceRoute(url)
    : url => session.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await navigate(next.url);
  const landed = String(session.page.url() || next.url);
  return { ...next, page: classifyAuthPage(landed) === AUTH_PAGES.UNKNOWN ? next.page : classifyAuthPage(landed), url: landed };
}

async function pageText(session) {
  return session.page.evaluate(() => {
    const parts = [document.documentElement?.innerHTML || ''];
    for (const script of document.querySelectorAll('script')) parts.push(script.textContent || '');
    return parts.join('\n').slice(0, 400000);
  }).catch(() => '');
}

async function readSessionId(session) {
  const value = await session.page.evaluate(() => {
    for (const node of document.querySelectorAll('[name="session_id"]')) {
      const candidate = String(node.value || node.getAttribute('value') || '');
      if (/^us_[A-Za-z0-9_-]{8,}$/.test(candidate)) return candidate;
    }
    return '';
  }).catch(() => '');
  if (/^us_[A-Za-z0-9_-]{8,}$/.test(String(value || ''))) return String(value);
  return parseAuthSessionId(await pageText(session));
}

async function readWorkspaces(session) {
  const cookies = typeof session.cookies === 'function' ? await session.cookies().catch(() => []) : [];
  const fromCookie = parseWorkspacesFromAuthCookie(cookies.find(item => item?.name === 'oai-client-auth-session')?.value);
  return fromCookie.length ? fromCookie : parseWorkspacesFromAuthCookie(await pageText(session));
}

const stripSo = headers => Object.fromEntries(Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== 'openai-sentinel-so-token'));
const normalizeOtp = value => String(value?.code ?? value?.otp ?? value ?? '').match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] || '';
const alreadyUsed = value => /phone number (?:is )?already in use|please use a different phone number/i.test(value);
const badReputation = value => /suspicious behavior from phone numbers similar/i.test(value);

async function continueAuthorize(session, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 60000);
  const visited = [];
  let phoneOrders = 0;
  let replacementReason = '';
  const sentinel = async flow => {
    if (typeof options.sentinel !== 'function') return {};
    try { return await options.sentinel(flow) || {}; } catch (error) {
      log(`[auth] Sentinel 令牌获取失败，继续不带令牌提交：${String(error?.message || error).slice(0, 160)}`, 'warn');
      return {};
    }
  };
  const release = async (page, reason, failure) => {
    if (typeof options.phone?.cancel !== 'function') {
      throw new AuthContinueError(`${failure}；接码通道缺少旧号码取消能力`, 'AUTH_CONTINUE_PHONE_REPLACEMENT_FAILED', { page });
    }
    await options.phone.cancel(session, { reason, attempt: phoneOrders, maxAttempts: PHONE_REPLACEMENT_ATTEMPTS });
    replacementReason = reason;
    if (phoneOrders >= PHONE_REPLACEMENT_ATTEMPTS) {
      const code = reason === 'already_in_use' ? 'AUTH_CONTINUE_PHONE_ALREADY_IN_USE_EXHAUSTED'
        : reason === 'phone_reputation' ? 'AUTH_CONTINUE_PHONE_REPUTATION_EXHAUSTED'
          : 'AUTH_CONTINUE_SMS_TIMEOUT_EXHAUSTED';
      throw new AuthContinueError(`${failure}；已连续更换 ${PHONE_REPLACEMENT_ATTEMPTS} 个号码`, code, { page });
    }
  };

  for (let step = 0; step < AUTH_CONTINUE_MAX_STEPS; step += 1) {
    if (options.cancelled?.()) throw new AuthContinueError('任务已取消', 'JOB_CANCELLED');
    const current = String(session.page.url() || '');
    const callback = callbackResult(current, options.state);
    if (callback?.code) return { code: callback.code, visited };
    if (callback?.error) throw new AuthContinueError(`authorize 以错误回调：${callback.detail}`, 'AUTH_CONTINUE_REJECTED', { page: 'callback' });
    const page = classifyAuthPage(current);
    visited.push(`${page}@${current ? new URL(current).origin + new URL(current).pathname : '-'}`);
    let response;

    if (page === AUTH_PAGES.CHOOSE_ACCOUNT) {
      const id = await readSessionId(session);
      if (!id) throw new AuthContinueError('账号选择页未取到 session_id', 'AUTH_CONTINUE_NO_SESSION_ID', { page });
      response = await authPost(session, '/session/select', { session_id: id }, {
        referer: `${AUTH_ORIGIN}/choose-an-account`, sentinel: stripSo(await sentinel(SENTINEL_FLOW_CONTINUE)), timeoutMs,
      });
    } else if (page === AUTH_PAGES.ADD_PHONE) {
      if (typeof options.phone?.acquire !== 'function') throw new AuthContinueError('需要绑定手机号但未配置接码通道', 'AUTH_CONTINUE_NO_PHONE', { page });
      for (;;) {
        let number;
        try {
          number = await options.phone.acquire(session, { reason: replacementReason, attempt: phoneOrders + 1, maxAttempts: PHONE_REPLACEMENT_ATTEMPTS });
        } catch (error) {
          throw new AuthContinueError(`获取手机号失败：${String(error?.message || error).slice(0, 200)}`, 'AUTH_CONTINUE_PHONE_ACQUIRE_FAILED', { page, retryable: true });
        }
        phoneOrders += 1;
        replacementReason = '';
        response = await authPost(session, '/add-phone/send', { phone_number: number, channel: options.phoneChannel || 'sms' }, {
          referer: `${AUTH_ORIGIN}/add-phone`, timeoutMs,
        });
        const detail = responseMessage(response);
        if (response?.ok && !detail) break;
        const status = Number(response?.status) || 0;
        const failure = `提交手机号失败 HTTP ${status}${detail ? `: ${detail}` : ''}`;
        if (status === 400 && (alreadyUsed(detail) || badReputation(detail))) {
          await release(page, alreadyUsed(detail) ? 'already_in_use' : 'phone_reputation', failure);
          continue;
        }
        const code = status === 409 && /sign-in session is no longer valid|start over/i.test(detail)
          ? 'AUTH_CONTINUE_SESSION_EXPIRED' : status === 429 ? 'AUTH_CONTINUE_RATE_LIMITED' : 'AUTH_CONTINUE_PHONE_REJECTED';
        throw new AuthContinueError(failure, code, { page, retryable: false });
      }
    } else if (page === AUTH_PAGES.PHONE_VERIFICATION) {
      if (typeof options.phone?.code !== 'function') throw new AuthContinueError('需要手机验证码但未配置接码通道', 'AUTH_CONTINUE_NO_PHONE', { page });
      let code;
      try { code = normalizeOtp(await options.phone.code(session)); } catch (error) {
        if (/timeout|超时/i.test(String(error?.message || error))) {
          await release(page, 'sms_timeout', `获取手机验证码失败：${String(error?.message || error).slice(0, 160)}`);
          if (typeof session.replaceRoute !== 'function') throw new AuthContinueError('当前浏览器会话缺少同源 SPA 换号路由能力', 'AUTH_CONTINUE_PHONE_REPLACEMENT_FAILED', { page });
          await session.replaceRoute(`${AUTH_ORIGIN}/add-phone`);
          continue;
        }
        throw new AuthContinueError(`获取手机验证码失败：${String(error?.message || error).slice(0, 160)}`, 'AUTH_CONTINUE_SMS_FAILED', { page, retryable: true });
      }
      if (!code) throw new AuthContinueError('接码平台返回的手机验证码不是 6 位数字', 'AUTH_CONTINUE_SMS_FAILED', { page, retryable: true });
      response = await authPost(session, '/phone-otp/validate', { code }, {
        referer: `${AUTH_ORIGIN}/phone-verification`, sentinel: await sentinel(SENTINEL_FLOW_PHONE_OTP), timeoutMs,
      });
    } else if (page === AUTH_PAGES.WORKSPACE) {
      const workspace = pickWorkspace(await readWorkspaces(session));
      if (!workspace) throw new AuthContinueError('工作区页未取到 workspace_id', 'AUTH_CONTINUE_NO_WORKSPACE', { page });
      try {
        response = await authPost(session, '/workspace/select', { workspace_id: workspace.id }, { referer: current, timeoutMs });
      } catch (error) {
        if (/execution context was destroyed|frame was detached/i.test(String(error?.message || error))) {
          const recovered = callbackResult(session.page.url(), options.state);
          if (recovered?.code) return { code: recovered.code, visited };
        }
        throw error;
      }
    } else if (page === AUTH_PAGES.LOGIN) {
      throw new AuthContinueError('authorize 要求重新登录，当前 sign-in session 已失效', 'AUTH_CONTINUE_SESSION_EXPIRED', { page });
    } else if (page === AUTH_PAGES.ERROR) {
      const payload = parseAuthErrorPayload(current);
      throw new AuthContinueError(`authorize 进入错误页 errorCode=${payload?.errorCode || payload?.errorIdentifier || 'unknown'}`, 'AUTH_CONTINUE_ERROR_PAGE', { page, detail: payload });
    } else {
      throw new AuthContinueError(`authorize 停在无法处理的页面 ${current || '-'}`, 'AUTH_CONTINUE_UNKNOWN_PAGE', { page });
    }

    if (!response?.ok) {
      const status = Number(response?.status) || 0;
      const detail = responseMessage(response);
      const code = status === 429 ? 'AUTH_CONTINUE_RATE_LIMITED'
        : page === AUTH_PAGES.PHONE_VERIFICATION && status === 400 ? 'AUTH_CONTINUE_PHONE_CODE_REJECTED'
          : 'AUTH_CONTINUE_FAILED';
      throw new AuthContinueError(`AuthAPI 提交失败 HTTP ${status || 'unknown'}${detail ? `: ${detail}` : ''}`, code, { page });
    }
    const next = await routeTransition(session, response, page, current, timeoutMs);
    if (page === AUTH_PAGES.CHOOSE_ACCOUNT && next.page === AUTH_PAGES.CHOOSE_ACCOUNT) {
      throw new AuthContinueError('session/select 未推进授权状态', 'AUTH_CONTINUE_SESSION_NOT_SELECTED', { page });
    }
    if (page === AUTH_PAGES.ADD_PHONE && next.page !== AUTH_PAGES.PHONE_VERIFICATION) {
      throw new AuthContinueError(`发码响应没有进入 phone-verification（next=${next.page}）`, 'AUTH_CONTINUE_SMS_NOT_STARTED', { page });
    }
    const nextCallback = callbackResult(next.url, options.state);
    if (nextCallback?.code) return { code: nextCallback.code, visited };
  }
  throw new AuthContinueError(`中间页超过 ${AUTH_CONTINUE_MAX_STEPS} 步仍未回调（经过 ${visited.join(' → ')}）`, 'AUTH_CONTINUE_TOO_MANY_STEPS');
}

exports.AUTH_PAGES = AUTH_PAGES;
exports.AuthContinueError = AuthContinueError;
exports.classifyAuthPage = classifyAuthPage;
exports.callbackResult = callbackResult;
exports.parseAuthSessionId = parseAuthSessionId;
exports.parseWorkspacesFromAuthCookie = parseWorkspacesFromAuthCookie;
exports.pickWorkspace = pickWorkspace;
exports.parseAuthErrorPayload = parseAuthErrorPayload;
exports.authResponseTransition = authResponseTransition;
exports.continueAuthorize = continueAuthorize;
exports.SENTINEL_FLOW_CONTINUE = SENTINEL_FLOW_CONTINUE;
exports.SENTINEL_FLOW_PHONE_OTP = SENTINEL_FLOW_PHONE_OTP;
exports.AUTH_CONTINUE_MAX_STEPS = AUTH_CONTINUE_MAX_STEPS;
