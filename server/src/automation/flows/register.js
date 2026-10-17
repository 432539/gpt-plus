const crypto = require('node:crypto');
const { config } = require('../config');
const { exchangeDurableCredentials, refreshDurableCredentials } = require('../lib/chatgpt-oauth');
const { decodeJwt } = require('../lib/parsers');
const { SentinelTokenError, sentinelHeaders } = require('../lib/sentinel');
const { MailboxFlow, mailboxProxyBypass } = require('./mailbox');
const { enableTotp, MFA_REQUEST_TIMEOUT_MS } = require('./account-security');
const { driveHeadlessSignup, openSignupEntry } = require('./register-headless');
const { normalizeRegisterPerformanceProfile, headlessInteractionTuning } = require('../lib/register-performance');
const { REGISTER_MAX_ATTEMPTS, classifyRegisterFailure } = require('../lib/retry-policy');
const {
  REGISTER_ACCOUNT_CREATION_REJECTED,
  PASSWORD_SUBMISSION_STAGE,
  isExactAccountCreationRejectedMessage,
} = require('../lib/account-creation-reject');
const {
  createTelemetry,
  installRegistrationAssetOptimization,
} = require('../lib/register-assets');

const CHATGPT_REGISTER_URL = 'https://chatgpt.com/auth/login';
const CHATGPT_ORIGIN = 'https://chatgpt.com';
const AUTH_ORIGIN = 'https://auth.openai.com';
const AUTH_API = `${AUTH_ORIGIN}/api/accounts`;
const PASSWORD_REGISTER_REFERER = `${AUTH_ORIGIN}/create-account/password`;
const EMAIL_OTP_SEND_URL = `${AUTH_API}/email-otp/send`;
const CHATGPT_SESSION_URL = `${CHATGPT_ORIGIN}/api/auth/session`;
const CHATGPT_SESSION_REFRESH_URL = `${CHATGPT_SESSION_URL}?refresh=true`;
const CHATGPT_SESSION_URLS = [CHATGPT_SESSION_URL, CHATGPT_SESSION_REFRESH_URL];
const CHATGPT_TOKEN_PROBE_URL = `${CHATGPT_ORIGIN}/backend-api/accounts/check/v4-2023-04-27`;
const SENTINEL_ATTEMPTS = 2;
const SESSION_READ_TIMEOUT_MS = 30000;
const SESSION_REFRESH_TIMEOUT_MS = 90000;
const SESSION_REFRESH_ATTEMPTS = 2;
const CALLBACK_TIMEOUT_MS = 180000;
const CALLBACK_ATTEMPTS = 3;
const CALLBACK_RETRY_DELAY_MS = 2000;
const AUTHORIZE_REQUEST_TIMEOUT_MS = 120000;
const AUTHORIZE_RECOVERY_TIMEOUT_MS = 300000;
const AUTHORIZE_ATTEMPTS = 6;
const AUTHORIZE_SETTLE_ATTEMPTS = 20;
const AUTHORIZE_SETTLE_INTERVAL_MS = 500;
const AUTHORIZE_RETRY_DELAY_MS = 1500;
const STEP_NETWORK_ATTEMPTS = 5;
const AUTH_POST_NETWORK_ATTEMPTS = 3;
const STEP_NETWORK_RETRY_DELAY_MS = 1000;
// OpenAI 发信 + VMAIL 落库偶尔要几分钟；原来的 180s 上限经常正好卡住（失败任务总耗时
// 稳定在 3 分半），验证码其实是晚到而不是没到。可用 settings.vmail.emailTimeoutMs 调整。
const EMAIL_WAIT_MS = 300000;

const IDP_HOSTS = Object.freeze({
  'accounts.google.com': 'Google',
  'accounts.youtube.com': 'Google',
  'login.microsoftonline.com': 'Microsoft',
  'login.live.com': 'Microsoft',
  'appleid.apple.com': 'Apple',
});

const callbackNetworkFailure = error => ['PROTOCOL_REQUEST_TIMEOUT', 'PROTOCOL_REQUEST_NETWORK'].includes(String(error?.code || ''))
  || /net::ERR_(?:TIMED_OUT|EMPTY_RESPONSE|CONNECTION|NETWORK_CHANGED|PROXY|TUNNEL|ABORTED)|failed to fetch|networkerror|load failed|navigation (?:was )?interrupted|execution context was destroyed/i
    .test(String(error?.message || error || ''));
const callbackFailureLabel = error => String(error?.code || '')
  || String(error?.message || '').match(/net::(ERR_[A-Z_]+)/i)?.[1]
  || String(error?.name || 'NETWORK_ERROR');
const cancelledError = () => Object.assign(new Error('任务已取消'), { code: 'JOB_CANCELLED' });

function currentPageUrl(session) {
  return typeof session?.page?.url === 'function' ? String(session.page.url() || '') : '';
}

function idpProvider(value) {
  try { return IDP_HOSTS[new URL(value).hostname] || ''; } catch { return ''; }
}

function authorizeLanding(value) {
  try {
    const url = new URL(String(value || ''));
    if (IDP_HOSTS[url.hostname]) return url.href;
    if (url.origin !== AUTH_ORIGIN || /^\/api\/accounts\/authorize\/?$/i.test(url.pathname)) return '';
    return url.href;
  } catch { return ''; }
}

function emailOtpDispatchLevel(dispatch = {}) {
  const status = Number(dispatch.last_status) || 0;
  return status >= 200 && status < 400 && !dispatch.request_failures && !dispatch.last_error_code ? 'debug' : 'warn';
}

const REGISTRATION_CONSUMPTION_CHECKPOINTS = Object.freeze({
  PASSWORD_SUBMISSION: 'password_submission',
  PASSWORDLESS_EMAIL_OTP_SEND: 'passwordless_email_otp_send',
});

const JAPANESE_LAST_NAMES = ['佐藤', '鈴木', '高橋', '田中', '渡辺', '伊藤', '山本', '中村', '小林', '加藤', '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '斎藤', '清水'];
const JAPANESE_FIRST_NAMES = ['太郎', '一郎', '健太', '大輔', '翔太', '拓也', '直樹', '雄大', '和也', '達也', '花子', '美咲', 'さくら', '優子', '真由美', '恵', '理恵', '麻衣', '彩', '陽子', '美穂', '結衣', '葵', '凛'];
const ENGLISH_FIRST_NAMES = ['James', 'Oliver', 'William', 'Henry', 'George', 'Harry', 'Jack', 'Charlie', 'Thomas', 'Oscar', 'Emily', 'Olivia', 'Amelia', 'Isla', 'Ava', 'Mia', 'Grace', 'Sophia', 'Lily', 'Chloe'];
const ENGLISH_LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia', 'Martinez', 'Robinson', 'Clark'];

const pick = values => values[crypto.randomInt(values.length)];
const birthdate = () => `${crypto.randomInt(1988, 2002)}-${String(crypto.randomInt(1, 13)).padStart(2, '0')}-${String(crypto.randomInt(1, 28)).padStart(2, '0')}`;
const japaneseIdentity = () => ({
  name: `${pick(JAPANESE_LAST_NAMES)} ${pick(JAPANESE_FIRST_NAMES)}`,
  birthdate: birthdate(),
});
const englishIdentity = () => ({
  name: `${pick(ENGLISH_FIRST_NAMES)} ${pick(ENGLISH_LAST_NAMES)}`,
  birthdate: birthdate(),
});

function registrationCountry(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function registrationIdentity(country) {
  const code = registrationCountry(country);
  if (!code || code === 'JP') return japaneseIdentity();
  return englishIdentity();
}

function sessionCredentials(value = {}) {
  const root = value?.data && typeof value.data === 'object' ? value.data : value;
  const accessToken = String(root?.accessToken || root?.access_token || root?.session?.accessToken || root?.session?.access_token || '');
  if (!accessToken) return null;
  const decoded = decodeJwt(accessToken), auth = decoded.payload?.['https://api.openai.com/auth'] || {};
  return {
    access_token: accessToken,
    chatgpt_account_id: String(auth.chatgpt_account_id || root?.account?.id || root?.accountId || ''),
    plan_type: decoded.plan || 'Free',
    expire_date: decoded.expire_date || '',
    expires_at: decoded.expires_at || decoded.expire_date || '',
    // 注册流程刚结束时签发的是 `is_signup` 注册态令牌，必须换成常规会话令牌后再落库。
    is_signup: auth.is_signup === true,
  };
}

async function probeHeadlessCallbackSession(session, { timeoutMs = 8000 } = {}) {
  let scratch = null;
  try {
    scratch = await session.newPage({ sameContext: true, purpose: 'headless-callback-probe' });
    const response = await scratch.request(CHATGPT_SESSION_URL, {
      headers: { Accept: 'application/json' },
      contextUrl: CHATGPT_ORIGIN,
      timeout: Math.max(1000, Number(timeoutMs) || 8000),
    });
    const credentials = sessionCredentials(response?.data);
    return {
      settled: Boolean(credentials),
      credentials,
      reason: credentials ? '' : response?.ok
        ? '响应缺少 accessToken（会话未登录）'
        : `HTTP ${Number(response?.status) || 'unknown'}`,
    };
  } catch (error) {
    if (error?.code === 'JOB_CANCELLED') throw error;
    return {
      settled: false,
      credentials: null,
      reason: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160),
    };
  } finally {
    await scratch?.closePage?.().catch(() => {});
  }
}

async function verifyRefreshCredential(session, credentials, options = {}) {
  if (!credentials?.access_token || !credentials?.refresh_token) {
    throw Object.assign(new Error('RT 续期验证前缺少 AT 或 RT'), { code: 'ACCOUNT_RT_CREDENTIALS_INCOMPLETE' });
  }
  try {
    const refreshed = await refreshDurableCredentials(session, {
      previous: credentials,
      refreshToken: credentials.refresh_token,
      clientId: credentials.client_id,
      timeoutMs: Number(options.protocol_timeout_ms) || 60000,
      log: options.log,
    });
    if (!refreshed?.access_token || !refreshed?.refresh_token) {
      throw Object.assign(new Error('RT 续期响应缺少最终 AT 或 RT'), { code: 'ACCOUNT_RT_CREDENTIALS_INCOMPLETE' });
    }
    return { ...refreshed, refresh_token_verified: true };
  } catch (error) {
    if (error?.code === 'ACCOUNT_RT_REFRESH_VERIFY_FAILED') throw error;
    throw Object.assign(new Error(`refresh token 续期验证失败 (${String(error?.code || 'UNKNOWN')})`), {
      code: 'ACCOUNT_RT_REFRESH_VERIFY_FAILED',
      cause_code: String(error?.code || ''),
      cause: error,
    });
  }
}

function responseMessage(response = {}) {
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  return String(data.error?.message || data.error?.code || data.message || response.text || '').replace(/\s+/g, ' ').slice(0, 240);
}

function requireOk(action, response) {
  if (response?.ok) return response;
  const detail = responseMessage(response);
  const error = new Error(`${action}失败 HTTP ${Number(response?.status) || 'unknown'}${detail ? `: ${detail}` : ''}`);
  error.status = Number(response?.status) || 0;
  error.upstreamMessage = detail;
  throw error;
}

function classifyPasswordSignupFailure(error) {
  if (Number(error?.status) === 400 && isExactAccountCreationRejectedMessage(error?.upstreamMessage)) {
    return {
      code: REGISTER_ACCOUNT_CREATION_REJECTED,
      stage: PASSWORD_SUBMISSION_STAGE,
    };
  }
  return null;
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

function pageType(value) {
  return String(value?.page?.type || value?.type || '').toLowerCase();
}

function urlLabel(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '-';
  }
}

class RegisterFlow {
  constructor(runtime, settings = {}) {
    this.runtime = runtime;
    this.settings = settings;
    this.mailbox = new MailboxFlow();
  }

  async run(account, options = {}, ctx = {}) {
    options = {
      ...options,
      password_signup: options.password_signup ?? options.set_password !== false,
      register_mode: options.register_mode || 'protocol',
    };
    if (options.get_refresh_token === true || options.durable_credentials === true) {
      options.durable_credentials = true;
      options.verify_refresh_token = true;
    }
    const started = Date.now();
    // ChatGPT/AuthAPI 全程走代理；只有验证码轮询那个自建 VMAIL 主机在同一浏览器里直连。
    const proxyBypass = ctx.proxyBypass ?? mailboxProxyBypass(this.settings);
    const performanceProfile = normalizeRegisterPerformanceProfile(options.performance_profile);
    const interaction = headlessInteractionTuning(performanceProfile);
    return this.runtime.withSession({
      kind: 'register',
      activity: { jobId: ctx.job?.id, label: account.email },
      profileKey: options.profile_key || `register:${account.id || account.email}`,
      cleanupProfile: options.cleanup_profile === true,
      allowThirdPartyCookies: true,
      proxy: ctx.proxy,
      proxyBypass,
      headless: options.headless ?? true,
      humanize: options.humanize !== false,
      humanPreset: options.humanPreset || 'careful',
      log: ctx.log,
      cancelled: ctx.cancelled,
      onCancel: ctx.onCancel,
      onSessionReady: ctx.onSessionReady,
      launchAdmission: ctx.launchAdmission,
      launchAdmissionHoldMs: Number(options.launch_admission_hold_ms) || 5000,
      sessionWallTimeoutMs: Number(options.session_wall_timeout_ms) || interaction.sessionWallTimeoutMs,
    }, async session => {
      ctx.job && (ctx.job._session = session);
      const identity = registrationIdentity(ctx.country || ctx.proxy?.region);
      const loggingId = crypto.randomUUID();

      if (options.register_mode === 'headless_click') {
        const assetOptimization = await installRegistrationAssetOptimization(session.page, {
          enabled: options.registration_asset_optimization !== false,
        }).catch(error => {
          ctx.log?.('页面小零件没能先热身，按原来的方式继续', 'warn');
          return { enabled: false, telemetry: createTelemetry(), dispose: async () => {} };
        });
        let finalCode = 'REGISTER_HEADLESS_FAILED';
        try {
          if (options.password_signup !== true) {
            throw Object.assign(new Error('无头模拟点击注册目前只支持密码注册'), { code: 'REGISTER_HEADLESS_PASSWORD_REQUIRED' });
          }
          ctx.log?.(
            options.enable_totp_2fa !== false
              ? '这次会设好密码，二次验证也会打开，轻轻点点页面就能注册'
              : '这次会设好密码，二次验证先不开，轻轻点点页面就能注册',
            'info',
          );
          ctx.progress?.(5, '正在打开注册小门');
          await openSignupEntry({
            session,
            entryUrl: options.register_url || CHATGPT_REGISTER_URL,
            progress: ctx.progress,
            log: ctx.log,
            cancelled: ctx.cancelled,
            stepTimeoutMs: Number(options.protocol_timeout_ms) || 45000,
            performanceProfile,
          });
          assetOptimization.telemetry.markPageReady();
          let callbackProbeCount = 0;
          const recoverLanding = performanceProfile === 'throughput' ? async () => {
            callbackProbeCount += 1;
            const probe = await probeHeadlessCallbackSession(session, { timeoutMs: interaction.callbackProbeTimeoutMs });
            ctx.log?.(probe.settled ? '回头看了一眼，已经接上啦' : '回头看了一眼，还在路上哦', probe.settled ? 'ok' : 'debug');
            return probe.settled;
          } : undefined;
          const signup = await driveHeadlessSignup({
            session,
            account,
            identity,
            waitForOtp: async () => {
              const hit = await this.#waitMailbox(session, account, options, ctx, started);
              return hit.code;
            },
            checkpoint: fields => this.#checkpoint(ctx, fields),
            onConsumptionCheckpoint: ctx.onConsumptionCheckpoint,
            progress: ctx.progress,
            log: ctx.log,
            cancelled: ctx.cancelled,
            stepTimeoutMs: Number(options.protocol_timeout_ms) || 45000,
            performanceProfile,
            recoverLanding,
            telemetry: assetOptimization.telemetry,
          });
          const cookies = await session.cookies().catch(() => []);
          const deviceId = cookies.find(item => item.name === 'oai-did')?.value || crypto.randomUUID();
          if (options.enable_totp_2fa !== false) {
            ctx.progress?.(88, '接着打开二次验证');
            ctx.log?.('页面注册好啦，接着打开二次验证', 'info');
          } else {
            ctx.log?.('这次没开二次验证，页面注册好就先收工', 'info');
          }
          const result = await this.#finalizeSession(session, account, options, ctx, deviceId);
          finalCode = 'SUCCESS';
          return { ...result, email_otp_send: signup.email_otp_send, headless_callback_recovered: signup.callback_recovered === true };
        } catch (error) {
          finalCode = error?.code || 'REGISTER_HEADLESS_FAILED';
          throw error;
        } finally {
          assetOptimization.telemetry.summary(finalCode);
          ctx.log?.(
            finalCode === 'SUCCESS' ? '页面小零件已经帮你省了一点加载' : '页面小零件这次先记一笔',
            finalCode === 'SUCCESS' ? 'ok' : 'info',
          );
          await assetOptimization.dispose().catch(() => {});
        }
      }

      ctx.progress?.(5, '正在准备注册');
      await this.#requestWithNetworkRecovery(session, `${CHATGPT_ORIGIN}/api/auth/providers`, {
        headers: { Accept: '*/*' },
        contextUrl: CHATGPT_REGISTER_URL,
        timeout: Number(options.protocol_timeout_ms) || 60000,
      }, { action: '预热 ChatGPT providers', ctx }).catch(error => {
        if (error?.code === 'JOB_CANCELLED') throw error;
      });
      const csrfResponse = requireOk('读取 ChatGPT CSRF', await this.#requestWithNetworkRecovery(session, `${CHATGPT_ORIGIN}/api/auth/csrf`, {
        headers: { Accept: '*/*' },
        contextUrl: CHATGPT_REGISTER_URL,
        timeout: Number(options.protocol_timeout_ms) || 60000,
      }, { action: '读取 ChatGPT CSRF', ctx }));
      const csrfToken = String(csrfResponse.data?.csrfToken || '');
      if (!csrfToken) throw new Error('ChatGPT CSRF 响应缺少 csrfToken');
      const chatgptCookies = await session.cookies();
      const deviceId = chatgptCookies.find(item => item.name === 'oai-did')?.value || crypto.randomUUID();

      const signIn = new URL(`${CHATGPT_ORIGIN}/api/auth/signin/openai`);
      for (const [key, value] of Object.entries({
        prompt: 'login',
        'ext-oai-did': deviceId,
        auth_session_logging_id: loggingId,
        screen_hint: 'login_or_signup',
        login_hint: account.email,
      })) signIn.searchParams.set(key, value);
      ctx.progress?.(18, '正在提交注册邮箱');
      const signInResponse = requireOk('启动 ChatGPT OAuth', await this.#requestWithNetworkRecovery(session, signIn.href, {
        method: 'POST',
        headers: { Accept: '*/*', Origin: CHATGPT_ORIGIN, Referer: `${CHATGPT_REGISTER_URL}?email=${encodeURIComponent(account.email)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        form: { callbackUrl: '/', csrfToken, json: 'true' },
        contextUrl: CHATGPT_ORIGIN,
        timeout: Number(options.protocol_timeout_ms) || 60000,
      }, { action: '启动 ChatGPT OAuth', ctx }));
      const authorizeUrl = findUrl(signInResponse.data);
      if (!authorizeUrl || !authorizeUrl.startsWith(`${AUTH_ORIGIN}/`)) {
        const fields = Object.keys(signInResponse.data || {}).slice(0, 8).join(',') || '-';
        throw new Error(`ChatGPT OAuth 响应缺少认证入口（candidate=${urlLabel(authorizeUrl)}，fields=${fields}）`);
      }

      ctx.progress?.(30, '正在打开注册小屋');
      const { response: authorizeResponse, landedUrl } = await this.#openAuthorize(session, authorizeUrl, options, ctx);
      if (!landedUrl.startsWith(AUTH_ORIGIN)) {
        const provider = idpProvider(landedUrl);
        if (provider) {
          throw Object.assign(new Error(`该邮箱已绑定 ${provider} 登录，无法用密码注册`), {
            code: 'REGISTER_EMAIL_BOUND_TO_IDP',
          });
        }
        throw Object.assign(new Error(`ChatGPT AuthAPI 未保持在认证域（落点 ${urlLabel(landedUrl)}，HTTP ${authorizeResponse.status || 'unknown'}）`), {
          code: 'REGISTER_AUTH_OFF_DOMAIN',
        });
      }

      if (options.password_signup === true) {
        ctx.progress?.(35, '正在设置登录密码');
        await this.#registerPassword(session, account, landedUrl, options, ctx, deviceId);
      } else {
        // Passwordless registration consumes the alias when the first OTP send is submitted upstream.
        ctx.progress?.(35, '正在发送验证码');
        await ctx.onConsumptionCheckpoint?.({
          stage: REGISTRATION_CONSUMPTION_CHECKPOINTS.PASSWORDLESS_EMAIL_OTP_SEND,
        });
        await this.#sendEmailOtp(session, options, ctx);
      }

      ctx.progress?.(42, '等待远程邮箱验证码');
      // mail.com 验证码在 Node 侧轮询，不再另开 Cloak 页，避免代理抖动时把主会话一起带崩。
      const hit = await this.#waitMailbox(session, account, options, ctx, started);
      if (!hit.code) throw new Error('ChatGPT 验证邮件缺少 OTP code');

      ctx.progress?.(56, '正在提交验证码');
      const otp = await this.#authPost(session, '/email-otp/validate', { code: hit.code }, 'email_otp_validate', `${AUTH_ORIGIN}/email-verification`, options, ctx, deviceId);
      let nextUrl = findUrl(otp.data);
      const nextType = pageType(otp.data);
      const needsAccountProfile = /about[_-]?you|create[_-]?account/.test(nextType)
        || /\/(?:about-you|create-account)\/?$/i.test(urlLabel(nextUrl));

      if (needsAccountProfile || (!nextUrl && !nextType)) {
        ctx.progress?.(70, '正在提交小资料');
        const created = await this.#authPost(session, '/create_account', identity, 'oauth_create_account', `${AUTH_ORIGIN}/about-you`, options, ctx, deviceId);
        nextUrl = findUrl(created.data);
      }
      if (!nextUrl) throw new Error(`ChatGPT AuthAPI 未返回回调 URL${nextType ? `（page.type=${nextType}）` : ''}`);

      ctx.progress?.(82, '正在完成注册回跳');
      await this.#completeOAuthCallback(session, nextUrl, options, ctx);

      return this.#finalizeSession(session, account, options, ctx, deviceId);
    });
  }

  async #requestWithNetworkRecovery(session, url, requestOptions, {
    action = '协议请求',
    ctx = {},
    attempts = STEP_NETWORK_ATTEMPTS,
  } = {}) {
    const maxAttempts = Math.max(1, Math.min(12, Number(attempts) || STEP_NETWORK_ATTEMPTS));
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (ctx.cancelled?.()) throw cancelledError();
      try {
        return await session.request(url, requestOptions);
      } catch (error) {
        if (error?.code === 'JOB_CANCELLED' || ctx.cancelled?.()) throw cancelledError();
        if (!callbackNetworkFailure(error)) throw error;
        lastError = error;
        if (attempt >= maxAttempts) break;
        ctx.log?.(`刚才卡住了一下，浏览器还在，再试一次（${attempt}/${maxAttempts}）`, 'warn');
        await session.wait(STEP_NETWORK_RETRY_DELAY_MS * attempt);
      }
    }
    if (lastError) {
      lastError.retry_scope = 'same_session_exhausted';
      throw lastError;
    }
    throw new Error(`${action}未返回结果`);
  }

  async #waitForAuthorizeLanding(session, responseUrl = '', ctx = {}) {
    for (let attempt = 0; attempt < AUTHORIZE_SETTLE_ATTEMPTS; attempt += 1) {
      if (ctx.cancelled?.()) throw cancelledError();
      const current = authorizeLanding(currentPageUrl(session));
      if (current) return current;
      const fallback = authorizeLanding(responseUrl);
      if (fallback) return fallback;
      if (attempt + 1 < AUTHORIZE_SETTLE_ATTEMPTS) await session.wait(AUTHORIZE_SETTLE_INTERVAL_MS);
    }
    return '';
  }

  async #openAuthorize(session, authorizeUrl, options = {}, ctx = {}) {
    const requestTimeoutMs = Math.max(
      AUTHORIZE_REQUEST_TIMEOUT_MS,
      Number(options.protocol_timeout_ms) || 0,
      Number(options.authorize_request_timeout_ms) || 0,
    );
    const recoveryTimeoutMs = Math.max(
      AUTHORIZE_RECOVERY_TIMEOUT_MS,
      requestTimeoutMs,
      Number(options.authorize_recovery_timeout_ms) || 0,
    );
    const attempts = Math.max(2, Math.min(12, Number(options.authorize_attempts) || AUTHORIZE_ATTEMPTS));
    const deadline = Date.now() + recoveryTimeoutMs;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (ctx.cancelled?.()) throw cancelledError();
      let response = null;
      try {
        response = requireOk('打开 ChatGPT AuthAPI 会话', await session.request(authorizeUrl, {
          headers: { Accept: 'text/html' },
          timeout: Math.min(requestTimeoutMs, Math.max(1000, deadline - Date.now())),
          waitUntil: 'commit',
          readBody: false,
        }));
      } catch (error) {
        if (error?.code === 'JOB_CANCELLED' || ctx.cancelled?.()) throw cancelledError();
        if (!callbackNetworkFailure(error)) throw error;
        lastError = error;
      }
      const landedUrl = await this.#waitForAuthorizeLanding(session, response?.url, ctx);
      if (landedUrl) return { response: response || { ok: true, status: 0, url: landedUrl }, landedUrl };
      if (response) return { response, landedUrl: currentPageUrl(session) || String(response.url || '') };
      if (attempt >= attempts || Date.now() >= deadline) break;
      ctx.log?.(`登录小门还没开好，再轻轻试一次（${attempt}/${attempts}）`, 'warn');
      await session.wait(Math.min(AUTHORIZE_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
    }
    if (lastError) {
      lastError.registration_stage = 'auth_session';
      lastError.retry_scope = 'same_session_exhausted';
      throw lastError;
    }
    throw Object.assign(new Error('ChatGPT AuthAPI authorize 在当前浏览器会话内未落地'), {
      code: 'REGISTER_AUTHORIZE_TIMEOUT',
      registration_stage: 'auth_session',
      retry_scope: 'same_session_exhausted',
    });
  }

  async #completeOAuthCallback(session, nextUrl, options = {}, ctx = {}) {
    const timeoutMs = Math.max(
      CALLBACK_TIMEOUT_MS,
      Number(options.callback_timeout_ms) || 0,
      Number(options.protocol_timeout_ms) || 0,
    );
    const attempts = Math.max(1, Math.min(5, Number(options.callback_attempts) || CALLBACK_ATTEMPTS));
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (ctx.cancelled?.()) throw cancelledError();
      try {
        requireOk('完成 ChatGPT OAuth 回调', await session.request(nextUrl, {
          headers: { Accept: 'text/html', Referer: `${AUTH_ORIGIN}/` },
          timeout: timeoutMs,
          waitUntil: 'commit',
          readBody: false,
        }));
        return;
      } catch (error) {
        if (error?.code === 'JOB_CANCELLED' || ctx.cancelled?.()) throw cancelledError();
        if (!callbackNetworkFailure(error)) throw error;
        lastError = error;
        const settled = await this.#sessionCredentials(session, CHATGPT_SESSION_URL, SESSION_READ_TIMEOUT_MS);
        if (settled.credentials) {
          ctx.log?.('授权已经接上啦，继续往下走', 'ok');
          return;
        }
        if (attempt >= attempts) break;
        ctx.log?.(`授权还在路上，再等一等（${attempt}/${attempts}）`, 'warn');
        await session.wait(CALLBACK_RETRY_DELAY_MS);
      }
    }
    throw Object.assign(new Error(`ChatGPT OAuth 回调在当前浏览器内重试 ${attempts} 次后仍遇到网络故障（${callbackFailureLabel(lastError)}）`), {
      code: lastError?.code === 'PROTOCOL_REQUEST_TIMEOUT' ? 'PROTOCOL_REQUEST_TIMEOUT' : 'PROTOCOL_REQUEST_NETWORK',
    });
  }

  async #waitMailbox(session, account, options, ctx, started) {
    const mailbox = ctx.mailChannel?.wait ? ctx.mailChannel : ctx.mailbox?.wait ? ctx.mailbox : this.mailbox;
    let handle = session;
    let close = async () => {};
    if (ctx.mailTransport?.request) handle = ctx.mailTransport;
    else if (ctx.mailChannel?.wait) {
      // Paid-mail vendor REST must not share the ChatGPT BrowserContext or the
      // same residential exit will fetch SMS/mail APIs during signup.
      handle = null;
    }
    try {
      return await mailbox.wait(handle, account, {
        ...this.settings,
        ...options,
        vmail_api_url: options.vmail_api_url || this.settings.vmail_api_url,
        vmail_key: options.vmail_key || this.settings.vmail_key,
      }, {
        timeoutMs: Number(options.email_timeout_ms) || EMAIL_WAIT_MS,
        intervalMs: Number(options.mail_poll_interval_ms || options.vmail_poll_interval_ms) || 3000,
        after: options.reuse_verification_email ? 0 : started,
        log: ctx.log,
        cancelled: ctx.cancelled,
        onCancel: ctx.onCancel,
      });
    } finally {
      await close().catch(() => {});
    }
  }

  async #checkpoint(ctx, fields) {
    const value = { ...fields, hardening_updated_at: new Date().toISOString() };
    await ctx.onCredentialCheckpoint?.(value);
    await ctx.onSecurityCheckpoint?.(value);
  }

  async #checkpointRequired(ctx, fields, code, action) {
    let last;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await this.#checkpoint(ctx, fields);
        return;
      } catch (error) {
        last = error;
        if (attempt === 1) ctx.log?.(`${action}失败，立即重试检查点写入`, 'warn');
      }
    }
    let detail = String(last?.message || last || '').replace(/\s+/g, ' ').slice(0, 240);
    for (const secret of [fields.password, fields.totp_secret, fields.access_token, fields.refresh_token, fields.session_key]) {
      if (secret) detail = detail.replaceAll(String(secret), '<redacted>');
    }
    throw Object.assign(new Error(`${action}失败${detail ? `：${detail}` : ''}`), { code, cause: last });
  }

  async #finalizeSession(session, account, options, ctx, deviceId) {
      ctx.progress?.(90, '正在取出登录凭证');
      const credentials = await this.#readCredentials(session, 15, ctx, options);
      if (!credentials) throw new Error('ChatGPT 协议注册完成，但 /api/auth/session 未返回 access token');

      ctx.progress?.(97, '正在核对登录凭证');
      const probe = await this.#probeToken(session, credentials.access_token, deviceId);
      if (probe.invalidated) {
        throw new Error(`ChatGPT 注册完成但令牌已被作废（HTTP 401${probe.detail ? `: ${probe.detail}` : ''}），账号未保存`);
      }
      if (!probe.ok) ctx.log?.('注册凭证核对时网页不太高兴，先按能用继续', 'warn');
      await this.#checkpoint(ctx, {
        ...credentials,
        session_key: credentials.access_token,
        email: account.email,
        password: account.password,
        password_required: options.password_signup === true,
        mfa_required: options.enable_totp_2fa !== false,
        password_set: options.password_signup === true,
        hardening_status: options.password_signup === true ? 'password_set' : 'pending',
        security_ready: false,
        credentials_ready: false,
      });
      const secured = {
        ...credentials,
        session_key: credentials.access_token,
        email: account.email,
        password_set: options.password_signup === true,
        mfa_enabled: false,
        security_ready: options.enable_totp_2fa === false,
        hardening_status: options.enable_totp_2fa === false ? 'security_complete' : 'password_set',
      };
      if (options.enable_totp_2fa !== false) {
        try {
          const mfa = await enableTotp(session, {
            accessToken: credentials.access_token,
            deviceId,
            timeoutMs: Math.max(MFA_REQUEST_TIMEOUT_MS, Number(options.mfa_timeout_ms) || 0, Number(options.protocol_timeout_ms) || 0),
            cancelled: ctx.cancelled,
            progress: ctx.progress,
            existingSecret: account.totp_secret,
            existingFactorId: account.mfa_factor_id,
            onEnrollment: fields => this.#checkpoint(ctx, fields),
          });
          Object.assign(secured, mfa, {
            security_ready: true,
            hardening_status: 'security_complete',
            hardening_error_code: '',
            hardening_error: '',
            mfa_enrolled_at: new Date().toISOString(),
          });
          Object.assign(account, mfa, { security_ready: true });
          await this.#checkpointRequired(ctx, {
            ...secured,
            password: account.password,
            credentials_ready: false,
          }, 'ACCOUNT_MFA_CHECKPOINT_FAILED', '保存二次验证状态');
          ctx.log?.('二次验证已经打开啦', 'ok');
        } catch (error) {
          if (error?.code === 'JOB_CANCELLED') throw error;
          if (error?.code === 'ACCOUNT_MFA_CHECKPOINT_FAILED') throw error;
          const safeMessage = String(error?.message || error)
            .replace(/\b[A-Z2-7]{16,128}\b/gi, '<redacted>')
            .replace(/\b\d{6}\b/g, '<redacted>')
            .slice(0, 200);
          Object.assign(secured, {
            mfa_enabled: error?.mfaEnabled === true,
            security_ready: false,
            hardening_status: 'failed',
            hardening_error_code: String(error?.code || 'ACCOUNT_MFA_SETUP_FAILED'),
            hardening_error: safeMessage,
          });
          ctx.log?.(`账号和密码都好了，但二次验证没设上：${safeMessage}。先不收进号簿`, 'warn');
        }
      }
      if (secured.hardening_status === 'failed') {
        await this.#checkpoint(ctx, { ...secured, password: account.password }).catch(() => {});
        const { password: _password, totp_secret: _secret, ...publicResult } = secured;
        return {
          ...publicResult,
          has_totp_secret: Boolean(secured.totp_secret || account.totp_secret),
          credentials_ready: false,
          security_setup_error_code: secured.hardening_error_code,
          security_setup_error: secured.hardening_error,
          partial: true,
        };
      }
      if (options.durable_credentials !== true) {
        const complete = {
          ...secured,
          refresh_token_requested: false,
          refresh_token_status: 'skipped',
          credentials_ready: false,
        };
        await this.#checkpoint(ctx, { ...complete, password: account.password });
        const { password: _password, totp_secret: _secret, ...publicResult } = complete;
        return { ...publicResult, has_totp_secret: Boolean(secured.totp_secret || account.totp_secret) };
      }
      const durable = await this.#durableCredentials(session, options, ctx, account.email, deviceId);
      let result = { ...secured, check: probe.data };
      if (durable) {
        const durableProbe = await this.#probeToken(session, durable.access_token, deviceId);
        if (!durableProbe.invalidated) {
          result = { ...result, ...durable, session_key: durable.access_token, check: durableProbe.data || probe.data };
        } else {
          ctx.log?.('续期凭证过期了，改用网页里的登录凭证', 'warn');
        }
      }
      if (!result.refresh_token || result.refresh_token_verified !== true) {
        result = {
          ...result,
          refresh_token_requested: true,
          refresh_token_status: result.refresh_token ? 'unverified' : 'failed',
          credentials_ready: false,
          partial: true,
          hardening_error_code: result.refresh_token ? 'ACCOUNT_RT_REFRESH_VERIFY_FAILED' : 'CHATGPT_OAUTH_NO_REFRESH',
          hardening_error: result.refresh_token ? 'refresh token 未通过真实续期验证' : '未取得 refresh token',
        };
      }
      result.password_required = options.password_signup === true;
      result.mfa_required = options.enable_totp_2fa !== false;
      result.credentials_ready = Boolean(result.access_token && result.refresh_token && result.security_ready);
      await this.#checkpoint(ctx, {
        ...result,
        password: account.password,
        ...(account.totp_secret ? { totp_secret: account.totp_secret } : {}),
      });
      const { password: _password, totp_secret: _secret, ...publicResult } = result;
      return { ...publicResult, has_totp_secret: Boolean(result.totp_secret || account.totp_secret) };
  }

  async #registerPassword(session, account, landedUrl, options, ctx, deviceId) {
    const password = String(account.password || '');
    if (!password) {
      const error = new Error('密码注册已开启，但未生成 ChatGPT 账号密码');
      error.code = 'REGISTER_PASSWORD_REQUIRED';
      throw error;
    }
    if (/\/(?:log-in|login)(?:\/|$)/i.test(new URL(landedUrl).pathname)) {
      throw Object.assign(new Error('邮箱已进入密码登录页；不再重放完整注册流程'), {
        code: 'REGISTER_PASSWORD_LOGIN_REQUIRED',
      });
    }
    await this.#checkpoint(ctx, { password, password_set: false, hardening_status: 'pending' });
    // Signal before transport: reaching password submission can consume the alias even when
    // this request or any later registration/security step fails.
    await ctx.onConsumptionCheckpoint?.({
      stage: REGISTRATION_CONSUMPTION_CHECKPOINTS.PASSWORD_SUBMISSION,
    });
    if (typeof session.replaceRoute === 'function') await session.replaceRoute(PASSWORD_REGISTER_REFERER).catch(() => {});
    let committed = false;
    let emailOtpSent = false;
    let registerError = null;
    for (let attempt = 1; attempt <= 2 && !committed; attempt += 1) {
      try {
        await this.#authPost(
          session,
          '/user/register',
          { username: account.email, password },
          'username_password_create',
          PASSWORD_REGISTER_REFERER,
          options,
          ctx,
          deviceId,
        );
        committed = true;
      } catch (error) {
        registerError = error;
        if (typeof error?.message === 'string') error.message = error.message.replaceAll(password, '<redacted>');
        const classification = classifyPasswordSignupFailure(error);
        if (classification) {
          Object.assign(error, classification);
          throw error;
        }
        const ambiguous = callbackNetworkFailure(error)
          || /account already exists|already registered|邮箱已存在/i.test(String(error?.message || ''));
        if (!ambiguous) {
          error.code ||= 'REGISTER_PASSWORD_FAILED';
          error.stage ||= REGISTRATION_CONSUMPTION_CHECKPOINTS.PASSWORD_SUBMISSION;
          throw error;
        }
        try {
          await this.#sendEmailOtp(session, options, ctx);
          committed = true;
          emailOtpSent = true;
        } catch {
          if (attempt >= 2) {
            registerError.code ||= 'REGISTER_PASSWORD_COMMIT_UNKNOWN';
            throw registerError;
          }
        }
      }
    }
    if (!committed) throw Object.assign(registerError || new Error('ChatGPT 密码注册未确认'), { code: 'REGISTER_PASSWORD_COMMIT_UNKNOWN' });
    await this.#checkpoint(ctx, { password, password_set: true, hardening_status: 'password_set' });
    account.password_set = true;
    if (!emailOtpSent) await this.#sendEmailOtp(session, options, ctx);
    ctx.log?.('登录密码设好了，验证码也已经发出去啦', 'ok');
  }

  async #sendEmailOtp(session, options, ctx = {}) {
    const sent = await this.#requestWithNetworkRecovery(session, EMAIL_OTP_SEND_URL, {
      headers: { Accept: 'application/json, text/plain, */*', Referer: PASSWORD_REGISTER_REFERER },
      contextUrl: PASSWORD_REGISTER_REFERER,
      referrer: PASSWORD_REGISTER_REFERER,
      timeout: Number(options.protocol_timeout_ms) || 60000,
    }, { action: '发送 ChatGPT 邮箱验证码', ctx });
    requireOk('发送 ChatGPT 邮箱验证码', sent);
  }

  async #authPost(session, path, json, flow, referer, options, ctx, deviceId) {
    const sentinel = await this.#sentinelHeaders(session, { flow, deviceId, ctx });
    const invocationId = crypto.randomUUID();
    const requestOptions = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Origin: AUTH_ORIGIN,
        Referer: referer,
        'X-Access-Flow-Invocation-Id': invocationId,
        ...sentinel,
      },
      json,
      contextUrl: referer,
      referrer: referer,
      timeout: Number(options.protocol_timeout_ms) || 60000,
    };
    const response = await this.#requestWithNetworkRecovery(session, `${AUTH_API}${path}`, requestOptions, {
      action: `ChatGPT AuthAPI ${path}`,
      ctx,
      attempts: path === '/user/register' ? 1 : AUTH_POST_NETWORK_ATTEMPTS,
    });
    return requireOk(`ChatGPT AuthAPI ${path}`, response);
  }

  /**
   * `/email-otp/validate` 与 `/create_account` 都受 Sentinel 保护，令牌绝不能伪造：
   * 之前拿不到令牌就发 `{e: 'q2n8w7x5z1'}`，OpenAI 会放行注册但随后作废该会话，账号
   * 一落库就是死的，后续 backend-api 全部返回 token_invalidated。
   *
   * auth.openai.com 的 login-web SDK 句柄留在模块作用域（页面只暴露
   * `__loginWebSentinelSdkReady` / `__loginWebSentinelSdkPrimaryError`），页面里取不到；
   * 而它的 SDK 与 checkout 用的是同一个 `sentinel.openai.com/backend-api/sentinel`
   * 服务，因此这里复用 checkout 已验证过的 sentinel 源 frame，在一次性页面上取令牌，
   * 协议页不会被导航离 auth.openai.com。取不到就让注册失败，把问题暴露给操作者。
   */
  async #sentinelHeaders(session, { flow, deviceId, ctx }) {
    const settings = { ...(config.sentinel || {}), ...(this.settings.sentinel || {}) };
    if (settings.enabled === false) {
      ctx.log?.('人机校验按设置关掉了，这次直接走', 'warn');
      return {};
    }
    let last;
    for (let attempt = 1; attempt <= SENTINEL_ATTEMPTS; attempt += 1) {
      const scratch = await session.newPage();
      try {
        return await sentinelHeaders(scratch, { flow, deviceId, log: ctx.log, settings });
      } catch (error) {
        last = error;
        ctx.log?.(`人机小票没领到（${attempt}/${SENTINEL_ATTEMPTS}），再试一次`, 'warn');
      } finally {
        await scratch.closePage().catch(() => {});
      }
      if (attempt < SENTINEL_ATTEMPTS) await session.wait(1000);
    }
    const diagnostic = await this.#loginWebSentinelState(session);
    throw new SentinelTokenError(
      `ChatGPT 注册无法生成 Sentinel 人机校验令牌（flow=${flow}）：${String(last?.message || last).slice(0, 240)}`
        + (diagnostic ? `；auth 页面 SDK 状态=${diagnostic}` : ''),
    );
  }

  /** 只能读到官方留下的这两个全局，用来给失败补上下文，而不是当成取令牌的通道。 */
  async #loginWebSentinelState(session) {
    if (typeof session?.page?.evaluate !== 'function') return '';
    const state = await session.page.evaluate(() => {
      const failure = globalThis.__loginWebSentinelSdkPrimaryError;
      if (failure) return String(failure?.message || failure);
      return globalThis.__loginWebSentinelSdkReady === undefined ? 'bootstrap_absent' : 'bootstrap_pending';
    }).catch(() => '');
    return typeof state === 'string' ? state.slice(0, 160) : '';
  }

  async #sessionCredentials(session, url, timeoutMs = SESSION_READ_TIMEOUT_MS) {
    try {
      const response = await session.request(url, {
        headers: { Accept: 'application/json' },
        contextUrl: CHATGPT_ORIGIN,
        timeout: timeoutMs,
      });
      const credentials = sessionCredentials(response?.data);
      return {
        credentials,
        reason: credentials ? '' : response?.ok
          ? '响应缺少 accessToken（会话未登录）'
          : `HTTP ${Number(response?.status) || 'unknown'}`,
      };
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      return { credentials: null, reason: String(error?.message || error).replace(/\s+/g, ' ').slice(0, 160) };
    }
  }

  /**
   * 注册回调后 `/api/auth/session` 返回的是注册态（`is_signup`）令牌。OpenAI 只把它当成
   * onboarding 用的临时会话，风控复核后会作废，此后提链/检测全部 token_invalidated。
   * 因此拿到首个令牌后必须再走一次 `?refresh=true`，用刷新态令牌替换它。
   */
  async #readCredentials(session, attempts = 1, ctx = {}, options = {}) {
    const urls = options.durable_credentials === true ? [CHATGPT_SESSION_URL] : CHATGPT_SESSION_URLS;
    let credentials = null;
    for (let attempt = 0; attempt < attempts && !credentials; attempt += 1) {
      for (const url of urls) {
        ({ credentials } = await this.#sessionCredentials(session, url));
        if (credentials) break;
      }
      if (!credentials && attempt + 1 < attempts) await session.wait(1000);
    }
    if (!credentials?.is_signup || options.durable_credentials === true) return credentials;
    return this.#refreshSignupToken(session, credentials, options, ctx);
  }

  async #refreshSignupToken(session, current, options = {}, ctx = {}) {
    const timeoutMs = Math.max(SESSION_READ_TIMEOUT_MS, Number(options.session_refresh_timeout_ms) || SESSION_REFRESH_TIMEOUT_MS);
    const attempts = Math.max(1, Math.min(5, Number(options.session_refresh_attempts) || SESSION_REFRESH_ATTEMPTS));
    let latest = current;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const { credentials } = await this.#sessionCredentials(session, CHATGPT_SESSION_REFRESH_URL, timeoutMs);
      if (credentials && !credentials.is_signup) {
        ctx.log?.(`已经换成常用登录凭证（第 ${attempt}/${attempts} 次）`, 'ok');
        return credentials;
      }
      if (credentials) latest = credentials;
      if (attempt >= attempts) break;
      const settled = await this.#sessionCredentials(session, CHATGPT_SESSION_URL);
      if (settled.credentials && !settled.credentials.is_signup) {
        ctx.log?.(`第 ${attempt} 次刷新没等到响应，但服务端已经换成常用凭证`, 'ok');
        return settled.credentials;
      }
      if (settled.credentials) latest = settled.credentials;
      await session.wait(2000);
    }
    ctx.log?.('注册页还没换成常用凭证，先按现在的继续', 'warn');
    return latest;
  }

  /**
   * 用官方公共客户端跑 PKCE，换出带 refresh_token 的可续期凭据。
   *
   * 默认关闭：OpenAI 会在 authorize 链路上用 `/add-phone` 拦住没绑手机号的账号，这一页
   * 无法跳过，需要接 SMS 才能过。因此「获取 AT」只走到 access_token 为止，续期凭据交给
   * 独立的「获取 RT」功能，调用方显式传 `durable_credentials: true` 才会尝试。
   */
  async #durableCredentials(session, options, ctx, email, deviceId) {
    if (options.durable_credentials !== true) return null;
    const attempts = Math.max(1, Math.min(5, Number(options.durable_attempts) || REGISTER_MAX_ATTEMPTS));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      ctx.progress?.(94, `换取可续期凭证（${attempt}/${attempts}）`);
      const scratch = await session.newPage({ sameContext: true, purpose: 'durable-oauth' });
      try {
        let credentials = await exchangeDurableCredentials(scratch, {
          timeoutMs: Number(options.protocol_timeout_ms) || 60000,
          email,
          log: ctx.log,
          sentinel: flow => this.#sentinelHeaders(scratch, { flow, deviceId, ctx }),
          phone: ctx.phoneChannel || ctx.phone,
          phoneChannel: options.phoneChannel || options.phone_channel,
          cancelled: ctx.cancelled,
        });
        if (options.verify_refresh_token === true) {
          credentials = await refreshDurableCredentials(scratch, {
            previous: credentials,
            refreshToken: credentials.refresh_token,
            clientId: credentials.client_id,
            timeoutMs: Number(options.protocol_timeout_ms) || 60000,
            log: ctx.log,
          });
          credentials.refresh_token_verified = true;
        }
        return credentials;
      } catch (error) {
        if (error?.code === 'JOB_CANCELLED') throw error;
        const verdict = classifyRegisterFailure(error);
        ctx.log?.('这次没换成可续期凭证，先记下，不挡住注册', 'warn');
        if (verdict.terminal || attempt >= attempts) return null;
      } finally {
        await scratch.closePage().catch(() => {});
      }
    }
    return null;
  }

  /** 落库前用真实 backend-api 校一次，避免把已被风控作废的会话当成注册成功。 */
  async #probeToken(session, accessToken, deviceId) {
    const response = await session.request(CHATGPT_TOKEN_PROBE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'OAI-Language': 'en-US',
        'OAI-Device-Id': deviceId,
      },
      contextUrl: CHATGPT_ORIGIN,
      timeout: 30000,
    }).catch(error => ({ ok: false, status: 0, text: String(error?.message || error), data: null }));
    return {
      ok: Boolean(response.ok),
      invalidated: response.status === 401,
      status: Number(response.status) || 0,
      detail: response.ok ? '' : responseMessage(response),
      data: response.ok ? response.data : null,
    };
  }
}

const registerConfig = {
  engine_available: true,
  engine: 'CloakBrowser protocol + DOM transport',
  browser_backends: ['cloakbrowser-protocol', 'cloakbrowser-headless-click'],
  provider: 'chatgpt',
  default_register_url: CHATGPT_REGISTER_URL,
  vmail_configured: false,
  sms_configured: false,
  note: 'ChatGPT 注册通过 AuthAPI 协议状态机执行，不操作浏览器 DOM；AuthAPI 请求必须携带真实 Sentinel 令牌，否则注册出的账号会被 OpenAI 作废。',
};

exports.CHATGPT_REGISTER_URL = CHATGPT_REGISTER_URL;
exports.REGISTRATION_CONSUMPTION_CHECKPOINTS = REGISTRATION_CONSUMPTION_CHECKPOINTS;
exports.emailOtpDispatchLevel = emailOtpDispatchLevel;
exports.probeHeadlessCallbackSession = probeHeadlessCallbackSession;
exports.verifyRefreshCredential = verifyRefreshCredential;
exports.classifyPasswordSignupFailure = classifyPasswordSignupFailure;
exports.registrationIdentity = registrationIdentity;
exports.registrationCountry = registrationCountry;
exports.RegisterFlow = RegisterFlow;
exports.registerConfig = registerConfig;
