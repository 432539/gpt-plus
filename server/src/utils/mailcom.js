// mail.com 网页协议客户端(移植自参考项目 services/mailcom.py)
// 登录必须 Chrome TLS：普通 Node/undici 会被打到 support.mail.com assistance。
// 登录 → 换 sid → OAuth 换令牌 → 列/增/删别名、收件、取正文。
// OAuth 公钥与 mail.com 网页端一致,字面值就是 *******(不是打码)。

const crypto = require('crypto');
const { hydrateDomains, DEFAULT_PULL_SUFFIXES } = require('./mailcomDomains');
const { createMailcomTransport, proxyLabel, shuffled } = require('./mailcomProxy');

const BUILTIN_OAUTH_SECRET = process.env.MAIL_OAUTH_PUBLIC_SECRET || '*******';

const LOGIN_URL = 'https://login.mail.com/login';
const LOGIN_PAGE_URL = 'https://www.mail.com/';
const OAUTH_BRIDGE = 'https://oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token';
const MAILLIST_URL = 'https://maillist.mail.com/Mailbox/Mail';
const MAILBODY_URL = 'https://webmail-cats-live.mail.com/mailbox/primary/mailbody/%s/Body';
const SETTINGS = 'https://settings-cats.mail.com';
const MAILSET_ORIGIN = 'https://mailset-root.mail.com';
const WEBMAIL_ORIGIN = 'https://webmailer.mail.com';

const MAILBOX_SCOPE = 'mail_mailbox_r';
const MAILBOX_CLIENT = 'mailcom_webmailermaillist_passport_live';
const MAILSET_SCOPE = 'mail_mailbox_w webmailer_setting_r webmailer_setting_w mail_confix_w';
const MAILSET_CLIENT = 'mailcom_mailset_root_live';

const ALIAS_CAP = 10;
const TOKEN_SKEW_SEC = 60;
const MAILCOM_LOCAL_MAX_LENGTH = 40;
const GIVEN_NAMES = [
  'amelia', 'ava', 'charlotte', 'chloe', 'daniel', 'david', 'ella', 'emily',
  'ethan', 'grace', 'henry', 'isabella', 'jack', 'james', 'liam', 'lucas',
  'mia', 'noah', 'olivia', 'oscar', 'sophia', 'william',
];
const SURNAMES = [
  'anderson', 'brown', 'clark', 'davis', 'evans', 'garcia', 'harris',
  'jackson', 'johnson', 'martin', 'miller', 'moore', 'robinson', 'smith',
  'taylor', 'thomas', 'walker', 'white', 'wilson', 'young',
];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const INBOX_AD_CT = 'application/vnd.1and1.mms.inboxadrequest-v1+json; charset=utf-8';
const MAIL_LIST_ACCEPT = 'application/vnd.1and1.mms.unified-maillist-v1+json; charset=utf-8';
const STATISTICS_RE = /name="statistics"\s+value="([^"]+)"/;
const LOGIN_REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const SCOPE_CLIENTS = {
  [MAILBOX_SCOPE]: { clientId: MAILBOX_CLIENT, origin: WEBMAIL_ORIGIN, referer: `${WEBMAIL_ORIGIN}/` },
  [MAILSET_SCOPE]: { clientId: MAILSET_CLIENT, origin: MAILSET_ORIGIN, referer: `${MAILSET_ORIGIN}/` },
};

function loginRedirectInfo(location, baseUrl = LOGIN_URL) {
  const raw = String(location || '').trim();
  if (!raw) {
    return { host: '', path: '', hasOtt: false, ls: '', interceptionType: '', summary: '(empty)' };
  }
  try {
    const url = new URL(raw, baseUrl);
    const ls = String(url.searchParams.get('ls') || '').toLowerCase();
    return {
      host: String(url.host || '').toLowerCase(),
      path: url.pathname || '/',
      hasOtt: url.searchParams.has('ott'),
      ls,
      interceptionType: String(url.searchParams.get('interceptiontype') || '').slice(0, 80),
      summary: `${url.host}${url.pathname || '/'}`,
    };
  } catch {
    let interceptionType = '';
    try {
      interceptionType = decodeURIComponent((/[?&]interceptiontype=([^&]*)/i.exec(raw) || [])[1] || '').slice(0, 80);
    } catch {
      interceptionType = '';
    }
    return {
      host: '',
      path: '',
      hasOtt: /(?:^|[?&])ott=/i.test(raw),
      ls: /[?&]ls=wd\b/i.test(raw) ? 'wd' : /[?&]ls=te\b/i.test(raw) ? 'te' : '',
      interceptionType,
      summary: '(unparseable)',
    };
  }
}

function isInterceptionRedirect(info) {
  const host = String(info?.host || '');
  const path = String(info?.path || '');
  return host.includes('interception') || path.toLowerCase().includes('logininterception');
}

function isAssistanceRedirect(info) {
  return String(info?.host || '').includes('support.mail.com');
}

function isTwoFaInterception(info) {
  return /twofa|2fa|mtan/i.test(String(info?.interceptionType || ''));
}

function isLoginOttRedirect(info) {
  return Boolean(info?.hasOtt) && !isInterceptionRedirect(info) && !isAssistanceRedirect(info);
}

function isRetryableLoginBounce(status, info) {
  if (info?.ls === 'wd' || info?.ls === 'te') return false;
  if (isTwoFaInterception(info)) return false;
  if (isInterceptionRedirect(info) || isAssistanceRedirect(info)) return true;
  if (info?.hasOtt) return false;
  if (LOGIN_REDIRECT_STATUSES.includes(status)) return true;
  // Proxy interstitials and bot walls often return 200 HTML instead of ott.
  return status === 200;
}

class MailcomError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.code = options.code || '';
    this.retryable = false;
  }
}
class RetryableMailcomError extends MailcomError {
  constructor(message, options = {}) {
    super(message, options);
    this.code = options.code || 'MAILCOM_TRANSIENT';
    this.retryable = true;
    this.proxyRotated = Boolean(options.proxyRotated);
  }
}

function randomLocal() {
  const given = GIVEN_NAMES[crypto.randomInt(GIVEN_NAMES.length)];
  const useSurname = crypto.randomInt(100) < 65;
  const surname = useSurname ? SURNAMES[crypto.randomInt(SURNAMES.length)] : '';
  const separator = surname && crypto.randomInt(100) < 45 ? '.' : '';
  const digitCount = crypto.randomInt(2, 5);
  let digits = '';
  for (let i = 0; i < digitCount; i += 1) digits += crypto.randomInt(10);
  return `${given}${separator}${surname}${digits}`.slice(0, MAILCOM_LOCAL_MAX_LENGTH);
}

function isEmptyValidationBody(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '{}' || raw === '[]') return true;
  try {
    const json = JSON.parse(raw);
    if (json && typeof json === 'object' && !Array.isArray(json) && Object.keys(json).length === 0) return true;
    if (Array.isArray(json) && json.length === 0) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function decodeJwt(token) {
  const part = token.split('.')[1] || '';
  const pad = part + '='.repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

function tokenExpiry(token) {
  try {
    return Number(decodeJwt(token).exp) || 0;
  } catch {
    return 0;
  }
}

function isTokenFresh(token, nowSec = Date.now() / 1000, skewSec = TOKEN_SKEW_SEC) {
  return Boolean(token) && tokenExpiry(token) > nowSec + skewSec;
}

function createMemorySessionStore(initial = null) {
  let data =
    initial && typeof initial === 'object'
      ? { sid: String(initial.sid || ''), auth_id: String(initial.auth_id || initial.authId || ''), tokens: { ...(initial.tokens || {}) }, saved_at: String(initial.saved_at || '') }
      : null;
  return {
    load() {
      return data ? { sid: data.sid, auth_id: data.auth_id, tokens: { ...data.tokens }, saved_at: data.saved_at } : null;
    },
    save(next) {
      if (!next || !next.sid) return;
      data = {
        sid: String(next.sid || ''),
        auth_id: String(next.auth_id || next.authId || ''),
        tokens: { ...(next.tokens || {}) },
        saved_at: String(next.saved_at || new Date().toISOString()),
      };
    },
    clear() {
      data = null;
    },
    snapshot() {
      return data ? { sid: data.sid, auth_id: data.auth_id, tokens: { ...data.tokens }, saved_at: data.saved_at } : null;
    },
  };
}

function httpLooksLikeAssistance(error) {
  if (!error) return false;
  if (error.code === 'MAILCOM_BAD_CREDENTIALS' || error.code === 'MAILCOM_ACCOUNT_INTERCEPTED') return false;
  const message = String(error.message || error);
  return (
    error.retryable === true ||
    /support\.mail\.com|interception|logininterception|assistance|换 sid 失败|登录被重定向/i.test(message)
  );
}

class MailcomClient {
  constructor(username, password, oauthSecret, options = {}) {
    if (oauthSecret && typeof oauthSecret === 'object') {
      options = oauthSecret;
      oauthSecret = '';
    }
    this.username = String(username || '').trim();
    this.password = String(password || '');
    this.oauthSecret = String(oauthSecret || '').trim() || BUILTIN_OAUTH_SECRET;
    this.cookies = new Map();
    this.sid = '';
    this.authId = '';
    this.tokens = {};
    this.sessionStore = options.sessionStore || null;
    this._sessionHydrated = false;
    this._customFetch = typeof options.fetch === 'function' ? options.fetch : null;
    this.proxyPool = shuffled(Array.isArray(options.proxies) ? options.proxies : []);
    this.proxyIndex = this.proxyPool.length ? 0 : -1;
    this.proxy = this.proxyIndex >= 0 ? this.proxyPool[this.proxyIndex] : null;
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs) || 20000);
    this.loginRetries = Math.max(
      1,
      Number(options.loginRetries)
        || (this.proxyPool.length ? Math.min(6, Math.max(3, this.proxyPool.length)) : 1)
    );
    this._bindTransport();
  }

  _bindTransport() {
    const previous = this.transport;
    this.transport = createMailcomTransport(this.proxy, {
      timeoutMs: this.requestTimeoutMs,
      fetch: this._customFetch || undefined,
    });
    this.fetch = this.transport.fetch;
    this.dispatcher = this.transport.dispatcher;
    this.impersonated = Boolean(this.transport.impersonated);
    if (previous && typeof previous.close === 'function') previous.close().catch(() => {});
  }

  _resetAuth({ persist = true } = {}) {
    this.cookies.clear();
    this.sid = '';
    this.authId = '';
    this.tokens = {};
    if (persist) this.sessionStore?.clear?.();
  }

  _rotateProxy() {
    if (!this.proxyPool.length || !this.proxy) return false;
    this.proxyIndex = (this.proxyIndex + 1) % this.proxyPool.length;
    this.proxy = this.proxyPool[this.proxyIndex];
    this._bindTransport();
    this.cookies.clear();
    return true;
  }

  _proxyFailureSuffix() {
    return this.proxy ? `（${proxyLabel(this.proxy)}）` : '';
  }

  _hydrateFromStore() {
    if (this._sessionHydrated) return;
    this._sessionHydrated = true;
    const data = this.sessionStore?.load?.();
    if (!data || !data.sid) return;
    this.sid = String(data.sid || '');
    this.authId = String(data.auth_id || data.authId || '');
    this.tokens = data.tokens && typeof data.tokens === 'object' ? { ...data.tokens } : {};
  }

  _persistSession() {
    if (!this.sessionStore || !this.sid) return;
    this.sessionStore.save({
      sid: this.sid,
      auth_id: this.authId,
      tokens: this.tokens,
      saved_at: new Date().toISOString(),
    });
  }

  _scopeClient(scope) {
    const found = SCOPE_CLIENTS[scope];
    if (found) return found;
    throw new MailcomError(`未配置 scope=${scope} 的客户端信息`);
  }

  _applyToken(scope, token) {
    this.tokens[scope] = token;
    try {
      this.authId = String(decodeJwt(token).auth_id || this.authId);
    } catch {
      /* ignore */
    }
    this._persistSession();
    return token;
  }

  async ensureSession(scope = MAILBOX_SCOPE, { force = false } = {}) {
    const run = this.sessionStore?.runExclusive ? (fn) => this.sessionStore.runExclusive(fn) : (fn) => fn();
    return run(() => this._ensureSession(scope, { force }));
  }

  async _ensureSession(scope, { force = false } = {}) {
    this._hydrateFromStore();
    if (force) this._resetAuth({ persist: true });
    else if (this.sid && this.authId && isTokenFresh(this.tokens[scope])) return 'cache';

    if (!force && this.sid) {
      try {
        delete this.tokens[scope];
        await this._fetchAccessToken(scope, { skipLogin: true });
        return 'token-refresh';
      } catch {
        this._resetAuth({ persist: true });
      }
    }

    await this.login();
    await this._fetchAccessToken(scope);
    return 'login';
  }

  async _withScopeRetry(scope, requestFn) {
    await this.ensureSession(scope);
    let resp = await requestFn();
    if (resp.status === 401 || resp.status === 403) {
      await this.ensureSession(scope, { force: true });
      resp = await requestFn();
    }
    return resp;
  }

  async close() {
    const transport = this.transport;
    this.transport = undefined;
    this.dispatcher = undefined;
    if (transport && typeof transport.close === 'function') await transport.close().catch(() => {});
  }

  async _retryOperation(operation, retries = 3) {
    let last;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        last = error;
        if (!error || !error.retryable) throw error;
        if (this.proxy && !error.proxyRotated) this._rotateProxy();
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
    throw last;
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _storeCookies(res) {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const list = raw.length ? raw : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const line of list) {
      const first = String(line).split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) this.cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }

  async _request(url, { method = 'GET', headers = {}, body, redirect = 'manual' } = {}) {
    const cookie = this._cookieHeader();
    let res;
    try {
      const init = {
        method,
        redirect,
        headers: {
          // Impersonated Chrome already sends a matching User-Agent and cookie jar.
          // Overriding them desyncs TLS fingerprint vs headers and trips BotDetection.
          ...(this.impersonated ? {} : { 'User-Agent': USER_AGENT }),
          ...(!this.impersonated && cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body,
      };
      if (!this.impersonated) init.signal = AbortSignal.timeout(this.requestTimeoutMs);
      if (this.dispatcher) init.dispatcher = this.dispatcher;
      res = await this.fetch(url, init);
    } catch (error) {
      const suffix = this._proxyFailureSuffix();
      const proxyRotated = this.proxy ? this._rotateProxy() : false;
      throw new RetryableMailcomError(`mail.com 传输失败${suffix}`, { cause: error, proxyRotated });
    }
    this._storeCookies(res);
    return res;
  }

  async login(retries = this.loginRetries) {
    let last;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        return await this._doLogin();
      } catch (e) {
        last = e;
        if (!e || !e.retryable) throw e;
        if (this.proxy && !e.proxyRotated) this._rotateProxy();
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (last?.retryable) throw last;
    throw new MailcomError(last ? last.message : '登录失败', { code: last?.code });
  }

  async _doLogin() {
    const page = await this._request(LOGIN_PAGE_URL, { redirect: 'follow' });
    let stats = '';
    if (page.status === 200) {
      const m = STATISTICS_RE.exec(await page.text());
      if (m) stats = m[1];
    }
    const form = new URLSearchParams({
      username: this.username,
      password: this.password,
      service: 'mailint',
      uasServiceID: 'mc_starter_mailcom',
      successURL: 'https://$(clientName)-$(dataCenter).mail.com/login',
      loginFailedURL: 'https://www.mail.com/logout?ls=wd',
      loginErrorURL: 'https://www.mail.com/logout?ls=te',
      edition: 'US',
      lang: 'en',
      usertype: 'standard',
      ibaInfo: 'abd=false',
      statistics: stats,
    });
    const resp = await this._request(LOGIN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.mail.com',
        Referer: 'https://www.mail.com/',
      },
      body: form.toString(),
    });
    const loc = resp.headers.get('location') || '';
    const redirect = loginRedirectInfo(loc, LOGIN_URL);
    if (isTwoFaInterception(redirect)) {
      throw new MailcomError('mail.com 账号需要二次验证', { code: 'MAILCOM_ACCOUNT_INTERCEPTED' });
    }
    if ([302, 303].includes(resp.status) && isLoginOttRedirect(redirect)) {
      this.sid = await this._exchangeOtt(loc);
      this._persistSession();
      return this.sid;
    }
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableMailcomError(`mail.com 登录暂时不可用（HTTP ${resp.status}）`);
    }
    if (redirect.ls === 'wd' || /logout\?ls=wd/i.test(loc) || [401, 403].includes(resp.status)) {
      throw new MailcomError('mail.com 账号或密码错误', { code: 'MAILCOM_BAD_CREDENTIALS' });
    }
    if (redirect.ls === 'te' || /logout\?ls=te/i.test(loc)) {
      throw new MailcomError('mail.com 账号需要人工验证或已被拦截', { code: 'MAILCOM_ACCOUNT_INTERCEPTED' });
    }
    if (isRetryableLoginBounce(resp.status, redirect)) {
      const kind = redirect.interceptionType ? ` ${redirect.interceptionType}` : '';
      throw new RetryableMailcomError(
        `mail.com 登录被重定向（HTTP ${resp.status} → ${redirect.summary}${kind}${this._proxyFailureSuffix() ? `，${proxyLabel(this.proxy)}` : ''}）`
      );
    }
    throw new MailcomError(`mail.com 登录失败（HTTP ${resp.status} → ${redirect.summary}）`, {
      code: 'MAILCOM_LOGIN_REJECTED',
    });
  }

  async _exchangeOtt(callbackUrl) {
    const gate = loginRedirectInfo(callbackUrl);
    if (isInterceptionRedirect(gate) || isAssistanceRedirect(gate)) {
      throw new RetryableMailcomError(
        `mail.com 登录被重定向（${this.proxy ? `${proxyLabel(this.proxy)} → ` : ''}${gate.summary}）`
      );
    }
    const parts = new URL(callbackUrl);
    const tz = Math.trunc(-new Date().getTimezoneOffset() / 60);
    const rawQuery = parts.search.startsWith('?') ? parts.search.slice(1) : String(parts.search || '');
    const query = `${rawQuery}${rawQuery ? '&' : ''}tz=${tz}`;
    const halogin = `${parts.protocol}//${parts.host}/halogin?${query}`;
    const resp = await this._request(halogin);
    const loc = resp.headers.get('location') || '';
    const redirect = loginRedirectInfo(loc, halogin);
    let sid = '';
    if (loc) {
      try {
        sid = new URL(loc, halogin).searchParams.get('sid') || '';
      } catch {
        sid = '';
      }
    }
    if ([302, 303].includes(resp.status) && sid) return sid;
    throw new RetryableMailcomError(
      `halogin 换 sid 失败（${this.proxy ? `${proxyLabel(this.proxy)} → ` : ''}${redirect.summary}）`
    );
  }

  async _fetchAccessToken(scope, { skipLogin = false } = {}) {
    const { clientId, origin, referer } = this._scopeClient(scope);
    if (this.tokens[scope] && isTokenFresh(this.tokens[scope])) {
      try {
        this.authId = String(decodeJwt(this.tokens[scope]).auth_id || this.authId);
      } catch {
        /* ignore */
      }
      return this.tokens[scope];
    }
    if (!this.sid && !skipLogin) await this.login();
    if (!this.sid) throw new MailcomError('换令牌失败:没有 sid', { code: 'MAILCOM_AUTH' });
    const basic = 'Basic ' + Buffer.from(`${clientId}:${this.oauthSecret}`).toString('base64');
    // sid 与 scope 原样发送(对齐 mail_query;编码会破坏 sid、且 scope 空格需保持原样)
    const resp = await this._request(`${OAUTH_BRIDGE}?sid=${this.sid}`, {
      method: 'POST',
      headers: {
        Authorization: basic,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: origin,
        Referer: referer,
      },
      body: `grant_type=urn:mam:oauth:grant-type:spa&scope=${scope}`,
    });
    if (resp.status !== 200) {
      const detail = (await resp.text().catch(() => '')).slice(0, 200);
      if ([401, 403, 429].includes(resp.status) || resp.status >= 500) {
        throw new RetryableMailcomError(`mail.com 换令牌暂时失败（HTTP ${resp.status}）`);
      }
      throw new MailcomError(`换令牌失败 HTTP ${resp.status}${detail ? ' · ' + detail : ''}`);
    }
    const data = await resp.json().catch(() => ({}));
    const token = String(data.access_token || '');
    if (!token) throw new MailcomError('换令牌失败:没有 access_token');
    return this._applyToken(scope, token);
  }

  async _token(scope, clientId, origin, referer) {
    this._hydrateFromStore();
    if (this.tokens[scope] && isTokenFresh(this.tokens[scope])) {
      try {
        this.authId = String(decodeJwt(this.tokens[scope]).auth_id || this.authId);
      } catch {
        /* ignore */
      }
      return this.tokens[scope];
    }
    delete this.tokens[scope];
    try {
      return await this._fetchAccessToken(scope, { skipLogin: false });
    } catch (error) {
      if (!error?.retryable || !this.sid) throw error;
      this._resetAuth({ persist: true });
      await this.login();
      return this._fetchAccessToken(scope, { skipLogin: true });
    }
  }

  mailboxToken() {
    return this._token(MAILBOX_SCOPE, MAILBOX_CLIENT, WEBMAIL_ORIGIN, WEBMAIL_ORIGIN + '/');
  }

  mailsetToken() {
    return this._token(MAILSET_SCOPE, MAILSET_CLIENT, MAILSET_ORIGIN, MAILSET_ORIGIN + '/');
  }

  async _mailsetHeaders(accept, contentType) {
    return {
      Authorization: 'Bearer ' + (await this.mailsetToken()),
      Accept: accept,
      'Content-Type': contentType,
      Origin: MAILSET_ORIGIN,
      Referer: MAILSET_ORIGIN + '/',
      'x-ui-app': 'mailcom.mailset-compose/1.0.5-build.335',
    };
  }

  listDomains() {
    return this._retryOperation(() => this._listDomains());
  }

  async _listDomains() {
    const resp = await this._withScopeRetry(MAILSET_SCOPE, async () => {
      const headers = await this._mailsetHeaders('application/json', 'application/json');
      const params = new URLSearchParams({
        absoluteURI: 'false',
        'q.state.eq': 'ACTIVE',
        'q.owner.eq': 'gmx_MAILCOM',
      });
      return this._request(`${SETTINGS}/domains?${params.toString()}`, { headers });
    });
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableMailcomError(`mail.com 拉后缀暂时失败（HTTP ${resp.status}）`);
    }
    if (resp.status !== 200) {
      if ([401, 403].includes(resp.status)) {
        this._resetAuth({ persist: true });
        throw new RetryableMailcomError(`mail.com 拉后缀暂时失败（HTTP ${resp.status}）`);
      }
      throw new MailcomError(`拉后缀失败 HTTP ${resp.status}`);
    }
    const body = await resp.json().catch(() => ({}));
    const domains = (body.domains || [])
      .map((item) => String((item && item.domain) || '').toLowerCase())
      .filter(Boolean);
    if (domains.length) hydrateDomains(domains);
    return domains;
  }

  listAliasItems() {
    return this._retryOperation(() => this._listAliasItems());
  }

  async _listAliasItems() {
    const resp = await this._withScopeRetry(MAILSET_SCOPE, async () => {
      const headers = await this._mailsetHeaders(
        'application/vnd.ui.trinity.mailaddress.list-v5+json',
        'application/vnd.ui.trinity.mailaddress.list-v5+json'
      );
      const url = `${SETTINGS}/mailaccount/primary/emailAddresses?absoluteURI=false&q.state.in=ACTIVE`;
      return this._request(url, { headers });
    });
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableMailcomError(`mail.com 列别名暂时失败（HTTP ${resp.status}）`);
    }
    if (resp.status !== 200) {
      if ([401, 403].includes(resp.status)) {
        this._resetAuth({ persist: true });
        throw new RetryableMailcomError(`mail.com 列别名暂时失败（HTTP ${resp.status}）`);
      }
      throw new MailcomError(`列别名失败 HTTP ${resp.status}`);
    }
    const body = await resp.json().catch(() => ({}));
    const items = body.mailaddresslist || body.emailAddresses || body.items || [];
    return items.filter((it) => it && typeof it === 'object' && (it.address || it.email));
  }

  async listAliases() {
    return (await this.listAliasItems()).map((it) => String(it.address || it.email || '')).filter(Boolean);
  }

  validateAddress(address) {
    return this._retryOperation(() => this._validateAddress(address));
  }

  async _validateAddress(address) {
    const resp = await this._withScopeRetry(MAILSET_SCOPE, async () => {
      const headers = await this._mailsetHeaders(
        'application/vnd.ui.trinity.email-address-validation-response+json',
        'application/vnd.ui.trinity.email-address-validation-request+json'
      );
      return this._request(`${SETTINGS}/mailaccount/emailAddressValidations?absoluteURI=false`, {
        method: 'POST',
        headers,
        body: JSON.stringify([address]),
      });
    });
    const text = (await resp.text()).trim();
    return resp.status === 200 && isEmptyValidationBody(text);
  }

  addAlias(address) {
    return this._retryOperation(() => this._addAlias(address));
  }

  async _addAlias(address) {
    const resp = await this._withScopeRetry(MAILSET_SCOPE, async () => {
      const headers = await this._mailsetHeaders(
        'application/vnd.ui.trinity.minimalmailaddress-v3+json',
        'application/vnd.ui.trinity.minimalmailaddress-v3+json'
      );
      return this._request(`${SETTINGS}/mailaccount/primary/emailAddresses?absoluteURI=false`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          address,
          deletable: true,
          pgpEnabled: false,
          defaultSenderAddress: false,
          defaultReceiverAddress: false,
          state: 'ACTIVE',
        }),
      });
    });
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableMailcomError(`mail.com 添加别名暂时失败（HTTP ${resp.status}）`);
    }
    const body = (await resp.text().catch(() => '')).trim();
    return { status: resp.status, body: summarizeMailcomBody(body) };
  }

  deleteAlias(address) {
    return this._retryOperation(() => this._deleteAlias(address));
  }

  async _deleteAlias(address) {
    const want = String(address || '').trim();
    if (!want || !want.includes('@')) throw new MailcomError('缺少要删除的别名');
    const items = await this.listAliasItems();
    const found = items.find((it) => String(it.address || it.email || '').toLowerCase() === want.toLowerCase());
    if (!found) throw new MailcomError('mail.com 上没有这个别名');
    if (!found.deletable) throw new MailcomError('母号本身不能在 mail.com 上删除');
    const real = String(found.address || want).trim();
    const enc = encodeURIComponent(real);
    const resp = await this._withScopeRetry(MAILSET_SCOPE, async () => {
      const headers = {
        Authorization: 'Bearer ' + (await this.mailsetToken()),
        Accept: 'text/plain;charset=UTF-8',
        'Content-Type': 'text/plain;charset=UTF-8',
        Origin: MAILSET_ORIGIN,
        Referer: MAILSET_ORIGIN + '/',
        'x-ui-app': 'mailcom.mailset-compose/1.0.5-build.335',
      };
      return this._request(
        `${SETTINGS}/mailaccount/primary/emailAddressesRemovals/${enc}/removals?absoluteURI=false`,
        { method: 'POST', headers, body: '' }
      );
    });
    if (![200, 201, 202, 204].includes(resp.status)) throw new MailcomError(`删除别名失败 HTTP ${resp.status}`);
    return resp.status;
  }

  queryInbox(amount = 20) {
    return this._retryOperation(() => this._queryInbox(amount));
  }

  async _queryInbox(amount = 20) {
    const resp = await this._withScopeRetry(MAILBOX_SCOPE, async () => {
      const token = await this.mailboxToken();
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: MAIL_LIST_ACCEPT,
        'Content-Type': INBOX_AD_CT,
        Origin: WEBMAIL_ORIGIN,
        Referer: WEBMAIL_ORIGIN + '/',
        'x-ui-app': 'mailcom.webmailer.mail-list/6.6.3',
      };
      const params = new URLSearchParams({
        folderTypeOrId: 'INBOX',
        offset: '0',
        amount: String(amount),
        orderBy: 'INTERNALDATE DESC',
        no_cache: this.authId,
      });
      return this._request(`${MAILLIST_URL}?${params.toString()}`, { method: 'POST', headers, body: '' });
    });
    if (resp.status !== 200) {
      if ([401, 403].includes(resp.status)) {
        this._resetAuth({ persist: true });
        throw new RetryableMailcomError(`mail.com 收件暂时失败（HTTP ${resp.status}）`);
      }
      if (resp.status === 429 || resp.status >= 500) {
        throw new RetryableMailcomError(`mail.com 收件暂时失败（HTTP ${resp.status}）`);
      }
      throw new MailcomError(`收件失败 HTTP ${resp.status}`);
    }
    const body = await resp.json().catch(() => ({}));
    const out = [];
    for (const el of body.mailListElements || []) {
      const rd = el && el.rawData;
      if (!rd || typeof rd !== 'object' || !('attribute' in rd)) continue;
      const attr = rd.attribute || {};
      const header = rd.mailHeader || {};
      out.push({
        id: attr.mailIdentifier,
        subject: header.subject || '',
        from: header.from || '',
        to: header.to || [],
        date: header.date,
      });
    }
    return out;
  }

  getBody(mailId) {
    return this._retryOperation(() => this._getBody(mailId));
  }

  async _getBody(mailId) {
    const resp = await this._withScopeRetry(MAILBOX_SCOPE, async () => {
      const token = await this.mailboxToken();
      const headers = {
        Authorization: 'Bearer ' + token,
        Accept: 'text/plain',
        Origin: WEBMAIL_ORIGIN,
        Referer: WEBMAIL_ORIGIN + '/',
      };
      const url = MAILBODY_URL.replace('%s', encodeURIComponent(mailId)) + `?absoluteURI=false&no_cache=${this.authId}`;
      return this._request(url, { headers });
    });
    if (resp.status !== 200) {
      if ([401, 403].includes(resp.status)) {
        this._resetAuth({ persist: true });
        throw new RetryableMailcomError(`mail.com 拉正文暂时失败（HTTP ${resp.status}）`);
      }
      if (resp.status === 429 || resp.status >= 500) {
        throw new RetryableMailcomError(`mail.com 拉正文暂时失败（HTTP ${resp.status}）`);
      }
      throw new MailcomError(`拉正文失败 HTTP ${resp.status}`);
    }
    return await resp.text();
  }
}

// 统一 To 字段
function recipientsOf(to) {
  const out = [];
  if (typeof to === 'string') {
    if (to.trim()) out.push(to.trim().toLowerCase());
  } else if (Array.isArray(to)) {
    for (const item of to) out.push(...recipientsOf(item));
  } else if (to && typeof to === 'object') {
    const addr = String(to.address || to.email || to.mailbox || '').trim();
    if (addr) out.push(addr.toLowerCase());
  }
  return out;
}
function toMatches(to, wantAddress) {
  const want = String(wantAddress || '').trim().toLowerCase();
  if (!want) return true;
  return recipientsOf(to).some((item) => want === item || item.includes(want));
}
function summarizeMailcomBody(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  try {
    const json = JSON.parse(raw);
    const msg = json.message || json.error || json.detail || json.title || json.code || json.errorCode;
    if (msg) return String(msg).slice(0, 240);
    if (json.type) {
      const type = String(json.type).split(':').pop();
      if (type) return type.slice(0, 240);
    }
  } catch {
    /* plain text */
  }
  return raw.slice(0, 240);
}

function parseAliasAddResult(raw) {
  if (typeof raw === 'number') return { status: raw, body: '' };
  const status = Number(raw?.status) || 0;
  return { status, body: summarizeMailcomBody(raw?.body || raw?.text || '') };
}

function suffixOf(address) {
  const t = String(address || '').trim();
  return t.includes('@') ? t.split('@').pop().toLowerCase() : '';
}

module.exports = {
  MailcomClient,
  MailcomError,
  RetryableMailcomError,
  loginRedirectInfo,
  isAssistanceRedirect,
  isInterceptionRedirect,
  isLoginOttRedirect,
  isRetryableLoginBounce,
  isTwoFaInterception,
  httpLooksLikeAssistance,
  isTokenFresh,
  tokenExpiry,
  createMemorySessionStore,
  ALIAS_CAP,
  BUILTIN_OAUTH_SECRET,
  DEFAULT_PULL_SUFFIXES,
  MAILBOX_SCOPE,
  MAILSET_SCOPE,
  TOKEN_SKEW_SEC,
  MAILCOM_LOCAL_MAX_LENGTH,
  GIVEN_NAMES,
  SURNAMES,
  randomLocal,
  toMatches,
  recipientsOf,
  suffixOf,
  summarizeMailcomBody,
  parseAliasAddResult,
};
