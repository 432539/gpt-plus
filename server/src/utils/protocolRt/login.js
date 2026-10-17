'use strict';

const crypto = require('node:crypto');
const { totpCode } = require('../../automation/lib/totp');
const {
  AUTH_BASE, AUTHORIZE_GATE_STATUSES, EXTRACT_PROFILE, PHONE_ROTATIONS,
} = require('./constants');
const {
  RtLoginError, apiErrorCode, continueUrl, cuteSmsError, factorIdFromBody,
  isConsentStep, isPhoneStep, isRtGateBlock, pageType,
} = require('./parse');
const { buildCodexAuthorizeUrl, newPkceState } = require('./pkce');
const { createSentinelState, sentinelHeaders } = require('./sentinel');
const {
  follow, postAccount, seedDeviceCookies, warmLoginDoor,
} = require('./http');
const { acquireCodexRefreshToken, exchangeCodeForTokens, resolveAuthorizationCode } = require('./consent');

function refererForPage(kind) {
  const mapping = {
    login_password: `${AUTH_BASE}/log-in/password`,
    mfa_challenge: `${AUTH_BASE}/mfa-challenge`,
    add_phone: `${AUTH_BASE}/add-phone`,
    phone_otp_verification: `${AUTH_BASE}/phone-verification`,
    sign_in_with_chatgpt_codex_consent: `${AUTH_BASE}/sign-in-with-chatgpt/codex/consent`,
  };
  return mapping[kind] || `${AUTH_BASE}/log-in`;
}

function jsonBody(resp) {
  return resp?.data && typeof resp.data === 'object' ? resp.data : {};
}

async function bindPhone(session, profile, deviceId, sentinelState, {
  smsClient, log, cancelled,
} = {}) {
  let lastError = '';
  for (let attempt = 1; attempt <= PHONE_ROTATIONS; attempt += 1) {
    if (cancelled?.()) throw new RtLoginError('拿 RT 已取消', 'JOB_CANCELLED');
    let activation;
    try {
      if (attempt === 1 || !smsClient.activation) {
        log?.(`📱 正在领一个手机号（${smsClient.country || 'CL'}）…`);
        activation = await smsClient.reserveMatchingNumber();
      } else {
        log?.('📱 这个号用不了，换一个再试…');
        activation = await smsClient.rotateNumber();
      }
    } catch (error) {
      if (error instanceof RtLoginError) throw error;
      throw new RtLoginError(cuteSmsError(error), error.code || 'SMS_RESERVE_FAILED', { cause: error });
    }
    const phone = String(activation?.phone || '');
    if (!phone) throw new RtLoginError('接码平台没有给出手机号', 'SMS_PHONE_MISSING');
    const send = await postAccount(session, profile, deviceId, '/api/accounts/add-phone/send', {
      phone_number: phone, channel: 'sms',
    }, { referer: refererForPage('add_phone') });
    const body = jsonBody(send);
    if (send.status !== 200) {
      const code = apiErrorCode(body);
      lastError = code || '发短信失败';
      if (code === 'phone_number_in_use' || send.status === 400) continue;
      throw new RtLoginError('发短信被拒绝', 'ACCOUNT_RT_PHONE_SEND_DENIED');
    }
    log?.('📨 短信已发出，在门口等验证码…');
    let otp;
    try {
      otp = await smsClient.waitForCode(180);
    } catch (error) {
      lastError = error?.name || 'SMS_TIMEOUT';
      continue;
    }
    const extra = await sentinelHeaders(session, sentinelState, 'verify_phone_otp');
    const validate = await postAccount(session, profile, deviceId, '/api/accounts/phone-otp/validate', {
      code: otp,
    }, { referer: refererForPage('phone_otp_verification'), extraHeaders: extra });
    const nextBody = jsonBody(validate);
    if (validate.status !== 200) {
      lastError = apiErrorCode(nextBody) || '手机验证失败';
      continue;
    }
    try { await smsClient.finishActivation(); } catch { /* billed best-effort */ }
    log?.('🎀 手机号绑好啦');
    return { kind: pageType(nextBody), body: nextBody, charged: true };
  }
  throw new RtLoginError(`绑手机没成功（${lastError || '换号用尽'}）`, 'ACCOUNT_RT_PHONE_BIND_FAILED');
}

async function acquireRefreshTokenByLogin({
  session,
  email,
  password,
  mfaSecret,
  smsFactory,
  logger,
  cancelled,
  profile = EXTRACT_PROFILE,
} = {}) {
  const address = String(email || '').trim();
  const secret = String(mfaSecret || '').replace(/[\s-]+/g, '').toUpperCase();
  if (!address || !password) throw new RtLoginError('账号缺少邮箱或密码', 'ACCOUNT_RT_MISSING_PASSWORD');
  if (!secret) throw new RtLoginError('账号缺少 2FA 密钥，没法过验证', 'ACCOUNT_RT_MISSING_TOTP');

  const deviceId = crypto.randomUUID();
  const { verifier, challenge, state } = newPkceState();
  const sentinelState = createSentinelState({
    deviceId,
    userAgent: profile.user_agent,
    screen: profile.screen,
    platform: profile.sentinel_platform,
  });
  const log = (message) => logger?.(message);
  const checkpoint = async () => {
    if (cancelled?.()) throw new RtLoginError('拿 RT 已取消', 'JOB_CANCELLED');
  };

  await seedDeviceCookies(session, deviceId);
  const authorizeUrl = buildCodexAuthorizeUrl(challenge, state, deviceId);
  log('🧭 打开 Codex CLI 登录小门（不是网页端/Platform），准备用账号密码进去…');
  await warmLoginDoor(session, profile, deviceId, log);
  const first = await follow(session, profile, deviceId, authorizeUrl, {
    referer: `${AUTH_BASE}/`, log, checkpoint,
  });
  if (first.code) {
    log('✨ 登录会话里已经有授权码啦');
    return exchangeCodeForTokens(session, profile, { code: first.code, verifier, log });
  }
  const doorStatus = Number(first.last?.status || 0);
  if (AUTHORIZE_GATE_STATUSES.has(doorStatus)) {
    log(`🚪 登录小门被门禁拦住了（HTTP ${doorStatus}），先不提交邮箱`);
    throw new RtLoginError(`登录小门被门禁拦住了（HTTP ${doorStatus}）`, 'ACCOUNT_RT_GATE_BLOCK', { retryable: true });
  }
  if (doorStatus && doorStatus >= 400) {
    throw new RtLoginError(`登录小门没打开（HTTP ${doorStatus}）`, 'ACCOUNT_RT_LOGIN_ENTRY_FAILED', { retryable: true });
  }

  log('📧 正在提交邮箱…');
  const contHeaders = await sentinelHeaders(session, sentinelState, 'authorize_continue');
  let cont = await postAccount(session, profile, deviceId, '/api/accounts/authorize/continue', {
    username: address,
  }, { referer: `${AUTH_BASE}/log-in`, extraHeaders: contHeaders });
  let body = jsonBody(cont);
  if (cont.status !== 200) {
    cont = await postAccount(session, profile, deviceId, '/api/accounts/authorize/continue', {
      username: { kind: 'email', value: address },
    }, { referer: `${AUTH_BASE}/log-in`, extraHeaders: contHeaders });
    body = jsonBody(cont);
  }
  if (cont.status !== 200) {
    const err = new RtLoginError(`邮箱登录被拒绝（HTTP ${cont.status}）`, 'ACCOUNT_RT_EMAIL_DENIED');
    if (AUTHORIZE_GATE_STATUSES.has(cont.status)) {
      err.code = 'ACCOUNT_RT_GATE_BLOCK';
      err.retryable = true;
    }
    throw err;
  }

  let kind = pageType(body);
  let factorId = factorIdFromBody(body);
  let smsClient = null;
  let smsCharged = false;
  try {
    for (let step = 0; step < 12; step += 1) {
      await checkpoint();
      if (['login_password', 'password'].includes(kind)) {
        log('🔑 正在核对密码…');
        const pwHeaders = await sentinelHeaders(session, sentinelState, 'password_verify');
        const resp = await postAccount(session, profile, deviceId, '/api/accounts/password/verify', {
          password,
        }, { referer: refererForPage('login_password'), extraHeaders: pwHeaders });
        body = jsonBody(resp);
        if (resp.status !== 200) throw new RtLoginError('密码核对没通过', 'ACCOUNT_RT_BAD_CREDENTIALS', { terminal: true });
        kind = pageType(body);
        factorId = factorIdFromBody(body) || factorId;
        continue;
      }
      if (['mfa_challenge', 'mfa'].includes(kind)) {
        if (!factorId) throw new RtLoginError('没有拿到 2FA 因子', 'ACCOUNT_RT_TOTP_FACTOR_MISSING');
        log('🔐 正在做二次验证…');
        await postAccount(session, profile, deviceId, '/api/accounts/mfa/issue_challenge', {
          id: factorId, type: 'totp', force_fresh_challenge: true,
        }, { referer: refererForPage('mfa_challenge') });
        const code6 = totpCode(secret);
        const resp = await postAccount(session, profile, deviceId, '/api/accounts/mfa/verify', {
          id: factorId, type: 'totp', code: code6,
        }, { referer: refererForPage('mfa_challenge') });
        body = jsonBody(resp);
        if (resp.status !== 200) throw new RtLoginError('二次验证没通过', 'ACCOUNT_RT_TOTP_FAILED', { terminal: true });
        kind = pageType(body);
        continue;
      }
      if (isPhoneStep(kind, body)) {
        if (typeof smsFactory !== 'function') {
          throw new RtLoginError('这次要绑手机，请先在接码配置里填好 API Key', 'SMS_KEY_MISSING');
        }
        if (!smsClient) smsClient = smsFactory();
        log('📱 Codex 要验手机啦，准备接码…');
        const bound = await bindPhone(session, profile, deviceId, sentinelState, {
          smsClient, log, cancelled,
        });
        kind = bound.kind;
        body = bound.body;
        if (bound.charged) smsCharged = true;
        continue;
      }
      if (isConsentStep(kind, body)) {
        const nxt = continueUrl(body) || `${AUTH_BASE}/sign-in-with-chatgpt/codex/consent`;
        log(smsCharged ? '🤝 手机过关，正在授权 Codex，换刷新令牌…' : '🤝 这次不用再验手机，直接授权 Codex，换刷新令牌…');
        let authCode = await resolveAuthorizationCode(session, profile, deviceId, {
          continueUrl: nxt, challenge, state, log, checkpoint,
        });
        if (!authCode) {
          const tokens = await acquireCodexRefreshToken(session, profile, deviceId, { log, checkpoint });
          tokens.sms_charged = smsCharged;
          tokens.phone_verified = smsCharged;
          return tokens;
        }
        const tokens = await exchangeCodeForTokens(session, profile, { code: authCode, verifier, log });
        tokens.sms_charged = smsCharged;
        tokens.phone_verified = smsCharged;
        return tokens;
      }
      throw new RtLoginError(`登录停在不认识的步骤：${kind || '空'}`, 'ACCOUNT_RT_UNKNOWN_STEP');
    }
  } finally {
    if (smsClient) {
      try {
        if (!smsCharged) await smsClient.cancelActivation();
      } catch { /* ignore */ }
    }
  }
  throw new RtLoginError('登录走完了，但没有换到刷新令牌', 'ACCOUNT_RT_NO_REFRESH');
}

module.exports = {
  RtLoginError,
  isRtGateBlock,
  acquireRefreshTokenByLogin,
  bindPhone,
};
