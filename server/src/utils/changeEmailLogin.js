'use strict';

const crypto = require('node:crypto');
const { totpSnapshot } = require('../automation/lib/totp');
const { AUTH_BASE, CHATGPT_BASE, EXTRACT_PROFILE } = require('./protocolRt/constants');
const { follow, postAccount, seedDeviceCookies, warmLoginDoor } = require('./protocolRt/http');
const { createSentinelState, sentinelHeaders } = require('./protocolRt/sentinel');
const { continueUrl, factorIdFromBody, apiErrorCode, pageType, isPhoneStep, isConsentStep } = require('./protocolRt/parse');

class RebindLoginError extends Error {
  constructor(message, code = 'REBIND_LOGIN_FAILED', extra = {}) {
    super(message);
    this.name = 'RebindLoginError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function jsonBody(resp) {
  return resp?.data && typeof resp.data === 'object' && !Array.isArray(resp.data) ? resp.data : {};
}

async function waitMs(session, ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  if (typeof session?.wait === 'function') await session.wait(delay);
  else await new Promise((resolve) => setTimeout(resolve, delay));
}

async function freshTotp(secret, session) {
  const key = String(secret || '').replace(/[\s-]+/g, '').toUpperCase();
  let snapshot = totpSnapshot(key);
  if (snapshot.validFor <= 5) {
    await waitMs(session, (snapshot.validFor + 1) * 1000);
    snapshot = totpSnapshot(key);
  }
  return snapshot.code;
}

async function loginWebSession(session, creds = {}, { cancelled, log } = {}) {
  const email = String(creds.email || '').trim();
  const password = String(creds.password || '');
  const totp = String(creds.totp || creds.totp_secret || creds.mfaSecret || '').replace(/[\s-]+/g, '').toUpperCase();
  if (!email || !password) throw new RebindLoginError('账号缺少邮箱或密码', 'REBIND_MISSING_PASSWORD');
  if (!totp) throw new RebindLoginError('账号缺少 TOTP', 'REBIND_MISSING_TOTP');

  const deviceId = String(creds.deviceId || '').trim() || crypto.randomUUID();
  const profile = EXTRACT_PROFILE;
  const sentinelState = createSentinelState({
    deviceId,
    userAgent: profile.user_agent,
    screen: profile.screen,
    platform: profile.sentinel_platform,
  });
  const checkpoint = async () => {
    if (cancelled?.()) throw new RebindLoginError('换绑登录已取消', 'JOB_CANCELLED', { terminal: true });
  };

  await seedDeviceCookies(session, deviceId);
  await warmLoginDoor(session, profile, deviceId, () => {});
  await checkpoint();
  const csrf = await session.request(`${CHATGPT_BASE}/api/auth/csrf`, {
    headers: { Accept: '*/*' },
    timeout: 30000,
  });
  const csrfToken = String(csrf.data?.csrfToken || '');
  if (!csrfToken) throw new RebindLoginError('没有拿到登录 CSRF', 'REBIND_WEB_CSRF', { retryable: true });

  const signIn = new URL(`${CHATGPT_BASE}/api/auth/signin/openai`);
  for (const [key, value] of Object.entries({
    prompt: 'login',
    'ext-oai-did': deviceId,
    auth_session_logging_id: crypto.randomUUID(),
    screen_hint: 'login',
    login_hint: email,
  })) signIn.searchParams.set(key, value);

  log?.('正在打开网页登录门…');
  const started = await session.request(signIn.href, {
    method: 'POST',
    headers: { Accept: '*/*', Origin: CHATGPT_BASE, Referer: `${CHATGPT_BASE}/auth/login` },
    form: { callbackUrl: '/', csrfToken, json: 'true' },
    timeout: 45000,
  });
  const authorizeUrl = String(started.data?.url || '');
  if (!authorizeUrl.startsWith(`${AUTH_BASE}/`)) {
    throw new RebindLoginError('网页登录入口没有给出授权地址', 'REBIND_WEB_SIGNIN', { retryable: true });
  }

  const first = await follow(session, profile, deviceId, authorizeUrl, {
    referer: `${AUTH_BASE}/`,
    checkpoint,
  });
  let body = jsonBody(first.last);
  let kind = pageType(body);
  if (!kind && first.last?.status === 200) {
    const extra = await sentinelHeaders(session, sentinelState, 'authorize_continue');
    let cont = await postAccount(session, profile, deviceId, '/api/accounts/authorize/continue', {
      username: email,
    }, { referer: `${AUTH_BASE}/log-in`, extraHeaders: extra });
    body = jsonBody(cont);
    if (cont.status !== 200) {
      cont = await postAccount(session, profile, deviceId, '/api/accounts/authorize/continue', {
        username: { kind: 'email', value: email },
      }, { referer: `${AUTH_BASE}/log-in`, extraHeaders: extra });
      body = jsonBody(cont);
    }
    if (cont.status !== 200) {
      throw new RebindLoginError(`邮箱登录被拒绝（HTTP ${cont.status}）`, 'REBIND_WEB_EMAIL', {
        retryable: cont.status >= 500 || cont.status === 429,
        status: cont.status,
      });
    }
    kind = pageType(body);
  }

  let factorId = factorIdFromBody(body);
  for (let step = 0; step < 12; step += 1) {
    await checkpoint();
    if (['login_password', 'password'].includes(kind)) {
      log?.('正在核对密码…');
      const pwHeaders = await sentinelHeaders(session, sentinelState, 'password_verify');
      const resp = await postAccount(session, profile, deviceId, '/api/accounts/password/verify', {
        password,
      }, { referer: `${AUTH_BASE}/log-in/password`, extraHeaders: pwHeaders });
      body = jsonBody(resp);
      const code = apiErrorCode(body);
      if (resp.status !== 200) {
        throw new RebindLoginError('密码核对没通过', code || 'REBIND_BAD_CREDENTIALS', {
          terminal: /deactivat|locked|invalid|incorrect|password/i.test(code || ''),
          status: resp.status,
        });
      }
      kind = pageType(body);
      factorId = factorIdFromBody(body) || factorId;
      continue;
    }
    if (['mfa_challenge', 'mfa'].includes(kind)) {
      if (!factorId) throw new RebindLoginError('没有拿到 2FA 因子', 'REBIND_TOTP_FACTOR');
      log?.('正在提交 TOTP…');
      await postAccount(session, profile, deviceId, '/api/accounts/mfa/issue_challenge', {
        id: factorId, type: 'totp', force_fresh_challenge: true,
      }, { referer: `${AUTH_BASE}/mfa-challenge` });
      const resp = await postAccount(session, profile, deviceId, '/api/accounts/mfa/verify', {
        id: factorId, type: 'totp', code: await freshTotp(totp, session),
      }, { referer: `${AUTH_BASE}/mfa-challenge` });
      body = jsonBody(resp);
      if (resp.status !== 200) {
        throw new RebindLoginError('二次验证没通过', 'REBIND_TOTP_FAILED', { terminal: true });
      }
      kind = pageType(body);
      continue;
    }
    if (isPhoneStep(kind, body)) {
      throw new RebindLoginError('换绑后登录要绑手机，本次只刷新 AT，不走接码', 'REBIND_PHONE_REQUIRED');
    }
    const nxt = continueUrl(body);
    if (nxt) {
      await follow(session, profile, deviceId, nxt, { referer: `${AUTH_BASE}/`, checkpoint });
    } else if (isConsentStep(kind, body)) {
      throw new RebindLoginError(`登录停在授权步骤：${kind || '空'}`, 'REBIND_WEB_CONSENT');
    }
    break;
  }

  for (const url of [`${CHATGPT_BASE}/api/auth/session?refresh=true`, `${CHATGPT_BASE}/api/auth/session`]) {
    await checkpoint();
    const response = await session.request(url, {
      headers: { Accept: 'application/json' },
      timeout: 30000,
    }).catch(() => null);
    const token = String(response?.data?.accessToken || response?.data?.access_token || '').trim();
    if (token) {
      return {
        access_token: token,
        chatgpt_account_id: String(response?.data?.account?.id || ''),
        deviceId,
        method: 'web',
      };
    }
  }
  throw new RebindLoginError('登录完成但没有拿到 session AT', 'REBIND_SESSION_MISSING', { retryable: true });
}

module.exports = {
  RebindLoginError,
  jsonBody,
  freshTotp,
  loginWebSession,
};
