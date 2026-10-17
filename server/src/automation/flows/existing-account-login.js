const crypto = require('node:crypto');
const { decodeJwt } = require('../lib/parsers');
const { totpSnapshot } = require('../lib/totp');
const { exchangeDurableCredentials, refreshDurableCredentials } = require('../lib/chatgpt-oauth');
const { continueAuthorize } = require('./auth-continue');

const CHATGPT_ORIGIN = 'https://chatgpt.com';
const AUTH_ORIGIN = 'https://auth.openai.com';
const LOGIN_URL = `${CHATGPT_ORIGIN}/auth/login`;
const SESSION_URLS = [
  `${CHATGPT_ORIGIN}/api/auth/session?refresh=true`,
  `${CHATGPT_ORIGIN}/api/auth/session`,
];
const TOKEN_PROBE_URL = `${CHATGPT_ORIGIN}/backend-api/accounts/check/v4-2023-04-27`;

const EXISTING_LOGIN_SELECTORS = Object.freeze({
  email: [
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
    'input[inputmode="email"]',
  ],
  password: [
    'input[autocomplete="current-password"]',
    'input[name="password"]',
    'input[type="password"]',
  ],
  otp: [
    'input[autocomplete="one-time-code"]',
    'input[name="code"]',
    'input[id$="-code"]',
    'input[aria-label*="code" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
  ],
  submit: [
    'button[data-dd-action-name="Continue"]',
    'button[type="submit"]',
    'form input[type="submit"]',
    'form button:not([type])',
  ],
});

const sleep = (session, ms) => (typeof session.wait === 'function'
  ? session.wait(ms)
  : new Promise(resolve => setTimeout(resolve, ms)));

const loginError = (message, code, options = {}) => Object.assign(new Error(message), {
  code,
  terminal: options.terminal === true,
  retryable: options.retryable === true,
  actionable: options.actionable === true,
  ...(options.cause ? { cause: options.cause } : {}),
});

function ensureActive(cancelled) {
  if (!cancelled?.()) return;
  throw loginError('任务已取消', 'JOB_CANCELLED', { terminal: true });
}

function currentUrl(session) {
  try { return String(session.page.url() || ''); } catch { return ''; }
}

function responseMessage(response = {}) {
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  return String(data.error?.message || data.error?.code || data.message || response.text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

function requireOk(action, response) {
  if (response?.ok) return response;
  const status = Number(response?.status) || 0;
  const detail = responseMessage(response);
  throw loginError(
    `${action}失败 HTTP ${status || 'unknown'}${detail ? `: ${detail}` : ''}`,
    status === 401 || status === 403 ? 'ACCOUNT_RT_LOGIN_REJECTED' : 'ACCOUNT_RT_LOGIN_ENTRY_FAILED',
    { terminal: status === 401 || status === 403, retryable: status === 0 || status === 408 || status === 429 || status >= 500 },
  );
}

function findUrl(value, seen = new Set()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return new URL(value, AUTH_ORIGIN).href;
    return '';
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['continue_url', 'redirect_url', 'redirect_uri', 'callback_url', 'url', 'location']) {
    const found = findUrl(value[key], seen);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = findUrl(child, seen);
    if (found) return found;
  }
  return '';
}

async function visible(session, selectors, timeoutMs = 1000) {
  for (const selector of selectors) {
    const locator = session.page.locator(selector).first();
    if (await locator.isVisible({ timeout: timeoutMs }).catch(() => false)) return { selector, locator };
  }
  return null;
}

async function fillVisible(session, selectors, value, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = await visible(session, selectors, Math.min(800, Math.max(1, deadline - Date.now())));
    if (found) {
      await found.locator.fill(String(value), { timeout: Math.max(1, deadline - Date.now()) });
      return found;
    }
    await sleep(session, 250);
  } while (Date.now() < deadline);
  throw loginError('登录控件在限定时间内未渲染', 'ACCOUNT_RT_LOGIN_CONTROL_STALLED', { retryable: true });
}

async function clickSubmit(session, fallbackField) {
  const submit = await visible(session, EXISTING_LOGIN_SELECTORS.submit, 1500);
  if (submit) {
    await submit.locator.click({ timeout: 12000 });
    return;
  }
  if (fallbackField?.locator?.press) {
    await fallbackField.locator.press('Enter');
    return;
  }
  throw loginError('登录页没有可用的提交控件', 'ACCOUNT_RT_LOGIN_SUBMIT_STALLED', { retryable: true });
}

async function pageText(session) {
  return session.page.evaluate(() => String(document.body?.innerText || '').slice(0, 5000)).catch(() => '');
}

async function inlineError(session) {
  return session.page.evaluate(() => {
    const selectors = ['[role="alert"]', '[data-error]', '.text-red-500', '.error', 'p'];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const style = getComputedStyle(node);
        const text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (style.display !== 'none' && style.visibility !== 'hidden'
          && /incorrect|invalid|wrong|deactivat|deleted|disabled|try again|不正确|错误|无效/i.test(text)) return text.slice(0, 300);
      }
    }
    return '';
  }).catch(() => '');
}

function routeStage(url) {
  try {
    const value = new URL(url);
    if (value.hostname === 'chatgpt.com' && !/^\/auth\/(?:login|error)/i.test(value.pathname)) return 'landing';
    if (!/(^|\.)auth\.openai\.com$/i.test(value.hostname)) return 'transition';
    if (/\/(?:choose-an-account|workspace|organization|consent)(?:\/|$)|\/sign-in-with-chatgpt\//i.test(value.pathname)) return 'oauth';
    if (/\/(?:add-phone|phone-verification|phone-otp)(?:\/|$)/i.test(value.pathname)) return 'phone';
    if (/\/(?:log-in|login|reset-password)(?:\/|$)/i.test(value.pathname)) return 'password';
    if (/\/email-verification(?:\/|$)/i.test(value.pathname)) return 'otp';
    if (/\/error(?:\/|$)/i.test(value.pathname)) return 'error';
  } catch {}
  return 'transition';
}

async function detectExistingLoginStage(session) {
  const route = routeStage(currentUrl(session));
  if (['landing', 'oauth', 'phone', 'error'].includes(route)) return route;
  if (await visible(session, EXISTING_LOGIN_SELECTORS.password, 300)) return 'password';
  if (await visible(session, EXISTING_LOGIN_SELECTORS.otp, 300)) return 'otp';
  if (await visible(session, EXISTING_LOGIN_SELECTORS.email, 300)) return 'email';
  return route;
}

async function waitStage(session, allowed, { timeoutMs = 45000, cancelled, failOnInline = false } = {}) {
  const wanted = new Set(allowed);
  const deadline = Date.now() + timeoutMs;
  do {
    ensureActive(cancelled);
    const stage = await detectExistingLoginStage(session);
    if (wanted.has(stage)) return stage;
    if (failOnInline) {
      const error = await inlineError(session);
      if (error) {
        const deactivated = /deactivat|deleted|disabled|停用|删除/i.test(error);
        throw loginError(
          deactivated ? 'OpenAI 账号已停用或删除' : 'OpenAI 拒绝了登录凭据',
          deactivated ? 'ACCOUNT_RT_DEACTIVATED' : 'ACCOUNT_RT_BAD_CREDENTIALS',
          { terminal: true },
        );
      }
    }
    await sleep(session, 250);
  } while (Date.now() < deadline);
  return '';
}

function isEmailOtpText(text) {
  return /(?:sent|send|check).{0,60}(?:email|inbox)|(?:email|inbox).{0,60}(?:code|verification)|邮箱.{0,24}(?:验证码|代码)|验证码.{0,24}邮箱/is.test(String(text || ''));
}

async function freshTotp(secret, session, cancelled) {
  let snapshot = totpSnapshot(secret);
  if (snapshot.validFor <= 5) {
    await sleep(session, (snapshot.validFor + 1) * 1000);
    ensureActive(cancelled);
    snapshot = totpSnapshot(secret);
  }
  return snapshot;
}

/**
 * Faithful adaptation of the source driveExistingAccountLogin challenge loop.
 * Email OTP is supplied by the target mailbox poller; TOTP remains local.
 */
async function driveExistingAccountLogin({
  session, account, getEmailOtp, progress, log, cancelled, stepTimeoutMs = 45000,
} = {}) {
  const note = (message, level) => log?.(`[account-refresh] ${message}`, level);
  if (!String(account?.email || '').trim() || !String(account?.password || '')) {
    throw loginError('账号缺少 ChatGPT 邮箱或密码', 'ACCOUNT_RT_MISSING_PASSWORD', { actionable: true });
  }
  ensureActive(cancelled);
  let stage = await waitStage(session, ['email', 'password', 'otp', 'landing', 'oauth', 'phone', 'error'], {
    timeoutMs: stepTimeoutMs, cancelled,
  });
  if (stage === 'email') {
    progress?.(20, '提交已有账号邮箱');
    const field = await fillVisible(session, EXISTING_LOGIN_SELECTORS.email, account.email);
    await clickSubmit(session, field);
    stage = await waitStage(session, ['password', 'otp', 'landing', 'oauth', 'phone', 'error'], {
      timeoutMs: stepTimeoutMs, cancelled, failOnInline: true,
    });
  }
  if (stage === 'password') {
    progress?.(35, '输入已有账号密码');
    const field = await fillVisible(session, EXISTING_LOGIN_SELECTORS.password, account.password, 30000);
    await clickSubmit(session, field);
    stage = await waitStage(session, ['otp', 'landing', 'oauth', 'phone', 'error'], {
      timeoutMs: Math.max(45000, stepTimeoutMs), cancelled, failOnInline: true,
    });
  }

  for (let challenge = 0; stage === 'otp' && challenge < 3; challenge += 1) {
    const text = await pageText(session);
    const emailChallenge = isEmailOtpText(text);
    let code;
    if (emailChallenge) {
      if (typeof getEmailOtp !== 'function') {
        throw loginError('登录需要邮箱 OTP，但账号未关联可轮询邮箱', 'ACCOUNT_RT_EMAIL_OTP_UNAVAILABLE', { actionable: true });
      }
      progress?.(50, '等待 ChatGPT 登录邮箱验证码');
      const value = await getEmailOtp();
      code = String(value?.code || value || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(code)) {
        throw loginError('邮箱 OTP 通道未返回 6 位验证码', 'ACCOUNT_RT_EMAIL_OTP_INVALID', { retryable: true });
      }
      note('已取得邮箱 OTP，正在提交');
    } else {
      const secret = String(account.totp_secret || '').replace(/[\s-]+/g, '').toUpperCase();
      if (!secret) {
        throw loginError('登录要求 TOTP，但该账号未保存 TOTP 密钥', 'ACCOUNT_RT_TOTP_MISSING', { actionable: true });
      }
      progress?.(55, '输入当前 TOTP 验证码');
      code = (await freshTotp(secret, session, cancelled)).code;
    }
    const field = await fillVisible(session, EXISTING_LOGIN_SELECTORS.otp, code);
    await clickSubmit(session, field);
    stage = await waitStage(session, ['otp', 'landing', 'oauth', 'phone', 'error'], {
      timeoutMs: 45000, cancelled, failOnInline: true,
    });
  }

  if (stage === 'error') {
    const error = await inlineError(session);
    const deactivated = /deactivat|deleted|disabled|停用|删除/i.test(error);
    throw loginError(
      deactivated ? 'OpenAI 账号已停用或删除' : 'OpenAI 登录流程返回错误页',
      deactivated ? 'ACCOUNT_RT_DEACTIVATED' : 'ACCOUNT_RT_LOGIN_ERROR_PAGE',
      { terminal: true },
    );
  }
  if (stage === 'phone') return { partial: true, phone_required: true, landing: currentUrl(session) };
  if (!['landing', 'oauth'].includes(stage)) {
    throw loginError('已有账号登录未完成回调', 'ACCOUNT_RT_NO_CALLBACK', { retryable: true });
  }
  progress?.(70, '已有账号登录会话已建立');
  note(`登录已进入 ${stage === 'landing' ? 'ChatGPT' : 'OAuth continuation'}`, 'ok');
  return { landing: currentUrl(session), oauth_continuation: stage === 'oauth' };
}

async function beginLogin(session, account, options, ctx) {
  ctx.progress?.(5, '初始化 ChatGPT 登录协议');
  const csrf = requireOk('读取 ChatGPT CSRF', await session.request(`${CHATGPT_ORIGIN}/api/auth/csrf`, {
    headers: { Accept: '*/*' }, contextUrl: LOGIN_URL, timeout: options.timeoutMs,
  }));
  const csrfToken = String(csrf.data?.csrfToken || '');
  if (!csrfToken) throw loginError('ChatGPT CSRF 响应缺少 csrfToken', 'ACCOUNT_RT_LOGIN_ENTRY_FAILED', { retryable: true });
  const cookies = await session.cookies();
  const deviceId = cookies.find(item => item.name === 'oai-did')?.value || crypto.randomUUID();
  const signIn = new URL(`${CHATGPT_ORIGIN}/api/auth/signin/openai`);
  for (const [key, value] of Object.entries({
    prompt: 'login',
    'ext-oai-did': deviceId,
    auth_session_logging_id: crypto.randomUUID(),
    screen_hint: 'login',
    login_hint: account.email,
  })) signIn.searchParams.set(key, value);
  const started = requireOk('启动 ChatGPT OAuth 登录', await session.request(signIn.href, {
    method: 'POST',
    headers: { Accept: '*/*', Origin: CHATGPT_ORIGIN, Referer: `${LOGIN_URL}?email=${encodeURIComponent(account.email)}` },
    form: { callbackUrl: '/', csrfToken, json: 'true' },
    contextUrl: CHATGPT_ORIGIN,
    timeout: options.timeoutMs,
  }));
  const authorizeUrl = findUrl(started.data);
  if (!authorizeUrl || !authorizeUrl.startsWith(`${AUTH_ORIGIN}/`)) {
    throw loginError('ChatGPT OAuth 响应缺少认证入口', 'ACCOUNT_RT_LOGIN_ENTRY_FAILED', { retryable: true });
  }
  requireOk('打开 OpenAI 登录会话', await session.request(authorizeUrl, {
    headers: { Accept: 'text/html' }, waitUntil: 'domcontentloaded', timeout: options.timeoutMs,
  }));
  await sleep(session, 750);
  return deviceId;
}

function sessionCredentials(value = {}) {
  const root = value?.data && typeof value.data === 'object' ? value.data : value;
  const token = String(root?.accessToken || root?.access_token || root?.session?.accessToken || '');
  if (!token) return null;
  const decoded = decodeJwt(token);
  const auth = decoded.payload?.['https://api.openai.com/auth'] || {};
  return {
    access_token: token,
    chatgpt_account_id: String(auth.chatgpt_account_id || root?.account?.id || ''),
    client_id: String(decoded.payload?.client_id || ''),
    plan_type: decoded.plan || 'Free',
    expire_date: decoded.expire_date || '',
    expires_at: decoded.expires_at || decoded.expire_date || '',
  };
}

async function readSessionCredentials(session, cancelled, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    ensureActive(cancelled);
    for (const url of SESSION_URLS) {
      const response = await session.request(url, {
        headers: { Accept: 'application/json' }, contextUrl: CHATGPT_ORIGIN, timeout: 30000,
      }).catch(() => null);
      const credentials = sessionCredentials(response?.data);
      if (credentials) return credentials;
    }
    await sleep(session, 750);
  }
  throw loginError('登录完成但 ChatGPT 会话未返回 access token', 'ACCOUNT_RT_SESSION_TOKEN_MISSING', { retryable: true });
}

function tokenIdentity(token) {
  const payload = decodeJwt(token).payload || {};
  const auth = payload['https://api.openai.com/auth'] || {};
  const profile = payload['https://api.openai.com/profile'] || {};
  return {
    accountId: String(auth.chatgpt_account_id || ''),
    email: String(profile.email || payload.email || '').trim().toLowerCase(),
  };
}

function assertMatchingAccount(account, accessToken) {
  const actual = tokenIdentity(accessToken);
  const expectedId = String(account.chatgpt_account_id || tokenIdentity(account.access_token).accountId || '');
  if ((expectedId && actual.accountId && expectedId !== actual.accountId)
    || (account.email && actual.email && String(account.email).trim().toLowerCase() !== actual.email)) {
    throw loginError('当前浏览器会话与选中的账号不一致，未写入凭据', 'ACCOUNT_RT_SESSION_MISMATCH', { terminal: true });
  }
}

async function probeToken(session, accessToken, deviceId) {
  const response = await session.request(TOKEN_PROBE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'OAI-Language': 'en-US',
      'OAI-Device-Id': deviceId,
    },
    contextUrl: CHATGPT_ORIGIN,
    timeout: 30000,
  }).catch(error => ({ status: 0, text: String(error?.message || error) }));
  if (response.ok) return;
  if (response.status === 401) throw loginError('新登录会话的 access token 已失效', 'ACCOUNT_RT_SESSION_TOKEN_INVALID', { terminal: true });
  throw loginError('无法验证新登录会话，原凭据保持不变', 'ACCOUNT_RT_SESSION_PROBE_TRANSPORT', {
    retryable: response.status === 0 || response.status >= 500,
  });
}

async function ensureRtPhoneChannel(login, ctx = {}) {
  if (!login?.phone_required) return null;
  if (ctx.phoneChannel) return ctx.phoneChannel;
  if (typeof ctx.getPhoneChannel !== 'function') return null;
  const phone = await ctx.getPhoneChannel({ reason: 'phone_required' });
  if (phone) ctx.phoneChannel = phone;
  return phone || null;
}

async function loginAndRefreshExistingAccount(runtime, account, options = {}, ctx = {}) {
  return runtime.withSession({
    kind: 'account-refresh-login',
    proxy: ctx.proxy,
    headless: options.headless !== false,
    profileKey: options.profile_key || options.profileKey,
    cleanupProfile: options.cleanup_profile !== false,
    sessionWallTimeoutMs: Number(options.session_wall_timeout_ms || options.sessionWallTimeoutMs) || 10 * 60 * 1000,
    onSessionReady: ctx.onSessionReady,
    cancelled: ctx.cancelled,
    log: ctx.log,
  }, async session => {
    const deviceId = await beginLogin(session, account, { timeoutMs: Number(options.timeoutMs) || 60000 }, ctx);
    const login = await driveExistingAccountLogin({
      session,
      account,
      getEmailOtp: ctx.getEmailOtp,
      progress: ctx.progress,
      log: ctx.log,
      cancelled: ctx.cancelled,
      stepTimeoutMs: Number(options.stepTimeoutMs) || 45000,
    });
    let phoneVerified = false;
    if (login.phone_required) {
      const phone = await ensureRtPhoneChannel(login, ctx);
      if (phone) {
        ctx.progress?.(60, '完成已有账号手机验证');
        await continueAuthorize(session, {
          phone,
          phoneChannel: options.phone_channel || 'sms',
          timeoutMs: Number(options.timeoutMs) || 60000,
        });
        login.phone_required = false;
        phoneVerified = true;
      }
    }
    let sessionResult;
    try {
      sessionResult = await readSessionCredentials(session, ctx.cancelled, login.phone_required ? 2 : 12);
    } catch (error) {
      if (login.phone_required) {
        throw loginError(
          'OpenAI 要求完成手机验证，且当前登录尚未签发可保存的 access token',
          'ACCOUNT_RT_PHONE_REQUIRED',
          { actionable: true, cause: error },
        );
      }
      throw error;
    }
    assertMatchingAccount(account, sessionResult.access_token);
    await probeToken(session, sessionResult.access_token, deviceId);

    let durable = null;
    let durableError = null;
    if (!login.phone_required) {
      const scratch = await session.newPage();
      try {
        const exchanged = await exchangeDurableCredentials(scratch, {
          timeoutMs: Number(options.timeoutMs) || 60000,
          email: account.email,
          log: ctx.log,
        });
        durable = await refreshDurableCredentials(scratch, {
          previous: exchanged,
          refreshToken: exchanged.refresh_token,
          clientId: exchanged.client_id,
          timeoutMs: Number(options.timeoutMs) || 60000,
          log: ctx.log,
        });
      } catch (error) {
        durableError = error;
      } finally {
        await scratch.closePage().catch(() => {});
      }
    }
    if (durable?.access_token && durable?.refresh_token) {
      assertMatchingAccount(account, durable.access_token);
      await probeToken(session, durable.access_token, deviceId);
      return { ...durable, refresh_token_verified: true, partial: false, phone_verified: phoneVerified };
    }
    return {
      ...sessionResult,
      partial: true,
      phone_required: login.phone_required === true
        || /add-phone|phone/i.test(String(durableError?.message || '')),
      durable_error_code: String(durableError?.code || (login.phone_required ? 'ACCOUNT_RT_PHONE_REQUIRED' : 'CHATGPT_OAUTH_NO_REFRESH')),
      durable_error: String(durableError?.message || (login.phone_required ? '上游要求手机号验证' : '未取得可续期凭据')).slice(0, 200),
    };
  });
}

exports.EXISTING_LOGIN_SELECTORS = EXISTING_LOGIN_SELECTORS;
exports.detectExistingLoginStage = detectExistingLoginStage;
exports.isEmailOtpText = isEmailOtpText;
exports.driveExistingAccountLogin = driveExistingAccountLogin;
exports.assertMatchingAccount = assertMatchingAccount;
exports.ensureRtPhoneChannel = ensureRtPhoneChannel;
exports.loginAndRefreshExistingAccount = loginAndRefreshExistingAccount;
