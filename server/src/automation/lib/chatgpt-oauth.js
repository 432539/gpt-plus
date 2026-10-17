const crypto = require('node:crypto');
const { AUTH_PAGES, classifyAuthPage, continueAuthorize } = require('../flows/auth-continue');
const { decodeJwt } = require('./parsers');

/**
 * ChatGPT 账号的可续期凭据（Authorization Code + PKCE）。
 *
 * 注册走的是 chatgpt.com 的 next-auth 网页流程，授权码在 OpenAI 服务端换成 token，
 * refresh_token 被封在 `__Secure-next-auth.session-token` cookie 里，浏览器只能通过
 * `/api/auth/session` 看到 accessToken——所以网页流程永远拿不到 refresh_token，账号
 * 是一次性的。
 *
 * 这里改用官方 Codex CLI 那个公共客户端再授权一次：注册收尾时浏览器上下文已经持有
 * auth.openai.com 的登录态，`/oauth/authorize` 会静默放行，换回来的 token 带
 * refresh_token，可以无限续期。
 *
 * 两个必须遵守的约束：
 *  - refresh_token 是轮换的，刷新成功后旧的立即作废；旧的再用一次会返回
 *    `refresh_token_reused` 并连带作废整条会话。调用方必须串行刷新并立刻写回。
 *  - `/oauth/token` 是给原生客户端用的，没有 CORS 头，因此 POST 必须从
 *    auth.openai.com 同源页面发出（见 `withAuthOrigin`）。
 */

const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com';
const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;
const CHATGPT_LOOPBACK_PORT = 1455;

const AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
const AUTHORIZE_SCOPE = 'openid profile email offline_access';
const REFRESH_SCOPE = 'openid profile email';
const LOOPBACK_HOST = 'localhost';
const LOOPBACK_PATH = '/auth/callback';
// route.fulfill 把这个地址变成一张空白页，唯一目的是把页面 origin 钉在 auth.openai.com，
// 让后面 /oauth/token 的 POST 保持同源。
const ORIGIN_BRIDGE_URL = `${CHATGPT_OAUTH_ISSUER}/__gptplus_oauth_origin`;
const STUB_BODY = '<!doctype html><title>oauth</title>';

const noop = () => {};
const base64url = value => Buffer.from(value).toString('base64url');

/** 这些错误码代表 refresh_token 已经死了，重试没有意义，只能重新登录。 */
const PERMANENT_REFRESH_CODES = new Set(['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']);

class ChatgptOAuthError extends Error {
  constructor(message, code = 'CHATGPT_OAUTH_FAILED', { permanent = false } = {}) {
    super(message);
    this.name = 'ChatgptOAuthError';
    this.code = code;
    this.permanent = permanent;
  }
}

function createPkce() {
  const verifier = crypto.randomBytes(64).toString('hex');
  return { verifier, challenge: base64url(crypto.createHash('sha256').update(verifier).digest()) };
}

const loopbackRedirectUri = (port = CHATGPT_LOOPBACK_PORT) => `http://${LOOPBACK_HOST}:${port}${LOOPBACK_PATH}`;

function buildAuthorizeUrl({ clientId = CHATGPT_OAUTH_CLIENT_ID, redirectUri, challenge, state, prompt = '', loginHint = '' } = {}) {
  const url = new URL(AUTHORIZE_URL);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: AUTHORIZE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  })) url.searchParams.set(key, String(value ?? ''));
  // prompt=none 让授权服务器要么直接回调授权码，要么以 error 回调，不再弹交互页。
  if (prompt) url.searchParams.set('prompt', prompt);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.href;
}

/**
 * 解析 loopback 回调。校验 state，避免把 authorize 中途的其他跳转误当成回调；
 * 同时把 error 回调也识别出来（prompt=none 打不过去时走的就是这条）。
 */
function authorizationCallbackFrom(rawUrl, state) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return null; }
  if (url.hostname !== LOOPBACK_HOST || url.pathname !== LOOPBACK_PATH) return null;
  if (String(url.searchParams.get('state') || '') !== String(state)) return null;
  return {
    code: String(url.searchParams.get('code') || ''),
    error: String(url.searchParams.get('error') || ''),
    errorDescription: String(url.searchParams.get('error_description') || ''),
  };
}

/** 校验 state 后取授权码，避免把 authorize 中途的其他跳转误当成回调。 */
function authorizationCodeFrom(rawUrl, state) {
  return authorizationCallbackFrom(rawUrl, state)?.code || '';
}

/**
 * 把 token 端点的响应整理成账号字段。
 *
 * 两个必须按「可选」处理的地方（`RefreshResponse` 三个字段都是 Option）：
 *  - 刷新响应可能不带 access_token / refresh_token，缺失时一律沿用旧值，否则会把账号
 *    刷成没令牌或不可续期；
 *  - 响应里**没有** client_id 字段，真实签发方只能从 access_token 的 `client_id` claim
 *    读。必须按实际签发值记录：续期要拿它回传，用错 client_id 会直接被拒。
 */
function credentialsFromTokens(data = {}, { clientId = CHATGPT_OAUTH_CLIENT_ID, previous = {} } = {}) {
  const accessToken = String(data.access_token || previous.access_token || '').trim();
  if (!accessToken) return null;
  const decoded = decodeJwt(accessToken);
  const auth = decoded.payload?.['https://api.openai.com/auth'] || {};
  return {
    access_token: accessToken,
    refresh_token: String(data.refresh_token || previous.refresh_token || '').trim(),
    client_id: String(decoded.payload?.client_id || previous.client_id || clientId || ''),
    chatgpt_account_id: String(auth.chatgpt_account_id || previous.chatgpt_account_id || ''),
    plan_type: decoded.plan || previous.plan_type || 'Free',
    expire_date: decoded.expire_date || '',
    expires_at: decoded.expires_at || decoded.expire_date || '',
    is_signup: auth.is_signup === true,
    rotated: Boolean(data.refresh_token) && String(data.refresh_token) !== String(previous.refresh_token || ''),
  };
}

function tokenError(response, action) {
  const data = response?.data && typeof response.data === 'object' ? response.data : {};
  const detail = String(data.error?.message || data.error_description || data.error || response?.text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  const status = Number(response?.status) || 0;
  const code = String(data.error?.code || (typeof data.error === 'string' ? data.error : '') || '').trim();
  const permanent = status === 401 || PERMANENT_REFRESH_CODES.has(code);
  return new ChatgptOAuthError(
    `${action}失败 HTTP ${status || 'unknown'}${detail ? `: ${detail}` : ''}`,
    code ? `CHATGPT_${code.toUpperCase()}` : 'CHATGPT_OAUTH_FAILED',
    { permanent },
  );
}

/**
 * 装上 loopback 与 origin 桥两张桩页。缺少 `page.route` 时直接放弃整条链路，
 * 而不是退化成跨源 POST——那样只会得到一个难查的 CORS 失败。
 */
async function installStubRoutes(page, log) {
  if (typeof page?.route !== 'function') return false;
  const stub = route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    headers: { 'access-control-allow-origin': '*' },
    body: STUB_BODY,
  });
  try {
    await page.route(url => url.hostname === LOOPBACK_HOST && url.pathname === LOOPBACK_PATH, stub);
    await page.route(url => url.href.startsWith(ORIGIN_BRIDGE_URL), stub);
    return true;
  } catch (error) {
    log(`[oauth] 回调桩页安装失败：${String(error?.message || error).slice(0, 160)}`, 'debug');
    return false;
  }
}

/** token 端点没有 CORS 头，POST 必须从 auth.openai.com 同源页面发出。 */
async function postToken(session, { json, form, timeoutMs, action }) {
  const response = await session.request(CHATGPT_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    ...(json ? { json } : {}),
    ...(form ? { form } : {}),
    contextUrl: ORIGIN_BRIDGE_URL,
    timeout: timeoutMs,
  });
  if (!response.ok) throw tokenError(response, action);
  return response.data && typeof response.data === 'object' ? response.data : {};
}

const pageLabel = rawUrl => {
  try { const url = new URL(String(rawUrl)); return `${url.origin}${url.pathname}`; } catch { return '-'; }
};

const sleep = (session, ms) => (session.wait ? session.wait(ms) : new Promise(resolve => setTimeout(resolve, ms)));

/** authorize 之后可能连着好几道中间页（账号选择 → 绑手机 → …），逐页往前走。 */
const INTERSTITIAL_STEPS = 4;
// 这些页面是「可选的补资料/升级」提示，优先找跳过入口而不是确认按钮。
const SKIPPABLE_PAGE = /add-phone|add-email|passkey|upsell|later/i;

/**
 * 点掉一道 authorize 中间页。
 *
 * 注册协议其余部分一律不碰 DOM，这里是唯一例外：这些页面是纯 UI 关卡，官方 SPA 的
 * next-step 路由对 `add_phone` 之类干脆返回 error，没有可直接调用的协议入口。
 * 无论成功与否都把页面上的候选文案带回来——那是下一轮定位选择器的唯一依据。
 */
async function advanceInterstitial(page, { email, label, log }) {
  const outcome = await page.evaluate(({ target, preferSkip }) => {
    const nodes = [...document.querySelectorAll('button, a, [role="button"], [role="option"], li, input[type="submit"]')];
    const labelOf = node => String(node.innerText || node.textContent || node.value || '').replace(/\s+/g, ' ').trim();
    const labels = [...new Set(nodes.map(labelOf).filter(Boolean))].slice(0, 10);
    const wanted = String(target || '').toLowerCase();
    const bySkip = nodes.find(node => /skip|not now|maybe later|later|remind me|跳过|暂不|以后/i.test(labelOf(node)));
    const byEmail = wanted ? nodes.find(node => labelOf(node).toLowerCase().includes(wanted)) : null;
    const byCta = nodes.find(node => /continue|use this account|next|继续|使用|下一步/i.test(labelOf(node)));
    const hit = preferSkip ? (bySkip || byEmail || byCta) : (byEmail || byCta || bySkip);
    if (!hit) return { clicked: '', labels };
    hit.click();
    return { clicked: labelOf(hit).slice(0, 80), labels };
  }, { target: email, preferSkip: SKIPPABLE_PAGE.test(label) })
    .catch(error => ({ clicked: '', labels: [], error: String(error?.message || error).slice(0, 120) }));
  if (outcome.clicked) log(`[oauth] 中间页 ${label} 已点选「${outcome.clicked}」`, 'debug');
  else log(`[oauth] 中间页 ${label} 无可点项，候选文案：${outcome.labels.join(' | ') || '（空）'}`, 'warn');
  return Boolean(outcome.clicked);
}

/** 顺着中间页链条往前走，把每一步的落点记下来供诊断。 */
async function walkInterstitials(session, page, state, { email, log }) {
  const visited = [];
  for (let step = 0; step < INTERSTITIAL_STEPS; step += 1) {
    const label = pageLabel(page.url());
    visited.push(label);
    if (!await advanceInterstitial(page, { email, label, log })) return { code: '', visited };
    const outcome = await waitForCallback(session, page, state, { attempts: 20 });
    if (outcome.code) return { code: outcome.code, visited };
    if (outcome.error) return { code: '', visited, detail: outcome.detail };
    if (pageLabel(page.url()) === label) return { code: '', visited, detail: `${label} 点击后未跳转` };
  }
  return { code: '', visited, detail: `中间页超过 ${INTERSTITIAL_STEPS} 步仍未回调` };
}

/** 轮询地址栏等 loopback 回调；返回授权码或本次停留位置。 */
async function waitForCallback(session, page, state, { attempts = 12 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const callback = authorizationCallbackFrom(page.url(), state);
    if (callback?.code) return { code: callback.code };
    if (callback?.error) {
      return { code: '', error: callback.error, detail: callback.errorDescription || callback.error };
    }
    await sleep(session, 300);
  }
  return { code: '', landing: pageLabel(page.url()) };
}

/**
 * 取授权码：prompt=none 静默尝试 → 交互式 + 逐页点过中间页。
 *
 * 静默轮的导航超时（代理抖动）会额外重试一次——否则会把「网络没通」误当成
 * 「静默授权被拒」，白白退化成交互流程。
 */
async function authorizeForCode(session, page, options) {
  const { clientId, redirectUri, challenge, timeoutMs, log } = options;
  const state = base64url(crypto.randomBytes(16));
  const target = buildAuthorizeUrl({ clientId, redirectUri, challenge, state });
  let timedOut = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(target, { waitUntil: 'commit', timeout: timeoutMs }).catch(error => {
      const message = String(error?.message || error);
      timedOut = /ERR_TIMED_OUT|ERR_CONNECTION|Timeout/i.test(message);
      log(`[oauth] authorize 导航提示（第 ${attempt}/2 次）：${message.slice(0, 160)}`, 'debug');
    });
    let landed = classifyAuthPage(page.url());
    if (landed === AUTH_PAGES.LOGIN && typeof options.login === 'function') {
      await options.login({ state, authorizeUrl: target });
      landed = classifyAuthPage(page.url());
    }
    const outcome = await waitForCallback(session, page, state, { attempts: landed === AUTH_PAGES.LOGIN ? 30 : 12 });
    if (outcome.code) return { code: outcome.code, visited: [] };
    if (outcome.error) return { code: '', visited: [], detail: outcome.detail };
    if (timedOut && landed === AUTH_PAGES.UNKNOWN && attempt < 2) continue;
    try {
      const walk = await continueAuthorize(session, {
        state,
        sentinel: options.sentinel,
        phone: options.phone,
        phoneChannel: options.phoneChannel,
        cancelled: options.cancelled,
        timeoutMs,
        log,
      });
      return { code: walk.code, visited: walk.visited };
    } catch (failure) {
      return {
        code: '',
        visited: [failure?.page ? `${failure.page}:${failure.code}` : String(failure?.code || 'ERROR')],
        detail: String(failure?.message || failure).slice(0, 240),
        failure,
      };
    }
  }
  return { code: '', visited: [], detail: 'authorize 未完成' };
}

/**
 * 在已登录的浏览器会话里跑一遍 PKCE，换出带 refresh_token 的凭据。
 *
 * @param {{page?: object, request: Function, goto?: Function, wait?: Function}} session CloakBrowser 会话
 * @param {{clientId?: string, port?: number, timeoutMs?: number, log?: Function}} options
 */
async function exchangeDurableCredentials(session, options = {}) {
  const log = typeof options.log === 'function' ? options.log : noop;
  const clientId = String(options.clientId || CHATGPT_OAUTH_CLIENT_ID);
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 60000);
  const page = session?.page;
  if (typeof page?.goto !== 'function' || typeof page?.url !== 'function') {
    throw new ChatgptOAuthError('PKCE 授权需要 CloakBrowser 页面上下文', 'CHATGPT_OAUTH_UNSUPPORTED');
  }
  if (!await installStubRoutes(page, log)) {
    throw new ChatgptOAuthError('当前 CloakBrowser 不支持请求拦截，无法回收 loopback 授权码', 'CHATGPT_OAUTH_UNSUPPORTED');
  }

  const { verifier, challenge } = createPkce();
  const redirectUri = loopbackRedirectUri(options.port);
  const { code, visited, detail, failure } = await authorizeForCode(session, page, {
    clientId, redirectUri, challenge, timeoutMs, log,
    sentinel: options.sentinel,
    phone: options.phone,
    phoneChannel: options.phoneChannel,
    cancelled: options.cancelled,
    login: options.login,
  });
  if (!code) {
    const chain = [...new Set((visited || []).filter(value => value && value !== '-'))].join(' → ') || '-';
    throw new ChatgptOAuthError(
      `authorize 未回调 loopback 授权码（经过 ${chain}${detail ? `，${detail}` : ''}）`,
      String(failure?.code || 'CHATGPT_OAUTH_NO_CODE'),
      { permanent: failure?.retryable === false },
    );
  }

  const tokens = await postToken(session, {
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier },
    timeoutMs,
    action: 'PKCE 授权码交换',
  });
  const credentials = credentialsFromTokens(tokens, { clientId });
  if (!credentials) throw new ChatgptOAuthError('PKCE 授权码交换未返回 access_token');
  if (!credentials.refresh_token) throw new ChatgptOAuthError('PKCE 授权码交换未返回 refresh_token', 'CHATGPT_OAUTH_NO_REFRESH');
  // client_id 以 JWT claim 为准；与请求值不一致说明上游改了签发客户端，续期必须跟着改。
  if (credentials.client_id !== clientId) {
    log(`[oauth] 实际签发 client_id=${credentials.client_id} 与请求值 ${clientId} 不同，按签发值记录`, 'warn');
  }
  const addPhoneRequired = (visited || []).some(entry => String(entry).startsWith('add_phone@'));
  log(`[oauth] 已换到可续期凭据（client=${credentials.client_id}，plan=${credentials.plan_type}，add_phone=${addPhoneRequired}）`, 'ok');
  return { ...credentials, add_phone_required: addPhoneRequired };
}

/**
 * 用 refresh_token 换新的 access_token。响应里的新 refresh_token 必须由调用方立刻
 * 写回，且同一账号不能并发调用（轮换语义，见文件头注释）。
 *
 * `previous` 必须带上账号已存的 client_id：令牌是哪个客户端签发的，续期就得回传哪个，
 * 无条件用 Codex 客户端会让导入的账号刷不动。
 */
async function refreshDurableCredentials(session, options = {}) {
  const log = typeof options.log === 'function' ? options.log : noop;
  const previous = options.previous && typeof options.previous === 'object' ? options.previous : {};
  const refreshToken = String(options.refreshToken || previous.refresh_token || '').trim();
  if (!refreshToken) throw new ChatgptOAuthError('账号缺少 refresh_token，无法续期', 'CHATGPT_OAUTH_NO_REFRESH');
  const clientId = String(options.clientId || previous.client_id || CHATGPT_OAUTH_CLIENT_ID).trim() || CHATGPT_OAUTH_CLIENT_ID;
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 45000);
  if (!await installStubRoutes(session?.page, log)) {
    throw new ChatgptOAuthError('当前 CloakBrowser 不支持请求拦截，无法同源调用 token 端点', 'CHATGPT_OAUTH_UNSUPPORTED');
  }
  const tokens = await postToken(session, {
    form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: REFRESH_SCOPE },
    timeoutMs,
    action: 'refresh_token 续期',
  });
  const credentials = credentialsFromTokens(tokens, { clientId, previous: { ...previous, refresh_token: refreshToken } });
  if (!credentials) throw new ChatgptOAuthError('refresh_token 续期未返回 access_token，且本地没有可复用的旧值');
  log(`[oauth] 令牌已续期（client=${credentials.client_id}，rotated=${credentials.rotated}）`, 'ok');
  return credentials;
}

exports.CHATGPT_OAUTH_ISSUER = CHATGPT_OAUTH_ISSUER;
exports.CHATGPT_OAUTH_CLIENT_ID = CHATGPT_OAUTH_CLIENT_ID;
exports.CHATGPT_OAUTH_TOKEN_URL = CHATGPT_OAUTH_TOKEN_URL;
exports.CHATGPT_LOOPBACK_PORT = CHATGPT_LOOPBACK_PORT;
exports.ChatgptOAuthError = ChatgptOAuthError;
exports.createPkce = createPkce;
exports.loopbackRedirectUri = loopbackRedirectUri;
exports.buildAuthorizeUrl = buildAuthorizeUrl;
exports.authorizationCallbackFrom = authorizationCallbackFrom;
exports.authorizationCodeFrom = authorizationCodeFrom;
exports.credentialsFromTokens = credentialsFromTokens;
exports.exchangeDurableCredentials = exchangeDurableCredentials;
exports.refreshDurableCredentials = refreshDurableCredentials;
