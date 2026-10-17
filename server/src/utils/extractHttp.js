const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { buildProxyUrl } = require('./mailcomProxy');

const EXTRACT_ACCEPT_LANGUAGE = 'en-GB,en;q=0.9';

// ChatGPT checkout/approve is picky: chrome145/146 JA3 + Client Hints 500'd after
// the newest-profile switch. Match the sanitized source default (chrome136) and
// the proven 131/136 pair; keep 142 optional for curl_cffi 0.16.
const EXTRACT_CHROME_PROFILES = Object.freeze([
  { major: 131, impersonate: 'chrome131' },
  { major: 136, impersonate: 'chrome136' },
  { major: 142, impersonate: 'chrome142' },
]);
const EXTRACT_BROWSER = 'chrome136';
const EXTRACT_CHROME_MAJOR = 136;
const EXTRACT_SAFARI_IMPERSONATE = 'safari17_0';
const EXTRACT_SAFARI_USER_AGENT = (
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
);
const EXTRACT_CHROME_BROWSERS = new Set(EXTRACT_CHROME_PROFILES.map((item) => item.impersonate));
const EXTRACT_BROWSERS = new Set([...EXTRACT_CHROME_BROWSERS, EXTRACT_SAFARI_IMPERSONATE]);
const IMPIT_BROWSERS = Object.freeze(['chrome142', 'chrome136', 'chrome131', 'chrome124']);
const unsupportedImpersonates = new Set();

function isSafariImpersonate(value) {
  return String(value || '').trim().toLowerCase() === EXTRACT_SAFARI_IMPERSONATE;
}

function chromeMajorFromImpersonate(value) {
  const match = String(value || '').match(/^chrome(\d+)/i);
  return match ? Number(match[1]) : EXTRACT_CHROME_MAJOR;
}

function chromeUserAgent(major) {
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Number(major) || EXTRACT_CHROME_MAJOR}.0.0.0 Safari/537.36`
  );
}

function chromeClientHints(major) {
  const version = String(Number(major) || EXTRACT_CHROME_MAJOR);
  return `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not_A Brand";v="99"`;
}

function applyAcceptLanguage(fingerprint, acceptLanguage) {
  const language = String(acceptLanguage || '').trim();
  if (!language || !fingerprint) return fingerprint;
  return {
    ...fingerprint,
    acceptLanguage: language,
    headers: {
      ...(fingerprint.headers || {}),
      'Accept-Language': language,
    },
  };
}

function fingerprintFromProfile(profile, acceptLanguage) {
  const major = Number(profile?.major) || EXTRACT_CHROME_MAJOR;
  const impersonate = String(profile?.impersonate || EXTRACT_BROWSER);
  const userAgent = chromeUserAgent(major);
  const secChUa = chromeClientHints(major);
  const language = String(acceptLanguage || EXTRACT_ACCEPT_LANGUAGE).trim() || EXTRACT_ACCEPT_LANGUAGE;
  return {
    browser: 'chrome',
    impersonate,
    chromeMajor: major,
    userAgent,
    secChUa,
    secChUaPlatform: '"Windows"',
    acceptLanguage: language,
    headers: {
      'User-Agent': userAgent,
      'Accept-Language': language,
      'sec-ch-ua': secChUa,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  };
}

function safari17Fingerprint(acceptLanguage) {
  const language = String(acceptLanguage || EXTRACT_ACCEPT_LANGUAGE).trim() || EXTRACT_ACCEPT_LANGUAGE;
  return {
    browser: 'safari',
    impersonate: EXTRACT_SAFARI_IMPERSONATE,
    chromeMajor: 0,
    safariMajor: 17,
    userAgent: EXTRACT_SAFARI_USER_AGENT,
    secChUa: '',
    secChUaPlatform: '',
    acceptLanguage: language,
    headers: {
      'User-Agent': EXTRACT_SAFARI_USER_AGENT,
      'Accept-Language': language,
    },
  };
}

function fingerprintFor(value, acceptLanguage) {
  const raw = String(value || '').trim();
  if (isSafariImpersonate(raw)) return safari17Fingerprint(acceptLanguage);
  return fingerprintFromProfile(profileForImpersonate(resolveExtractBrowser(raw)), acceptLanguage);
}

function profileForImpersonate(value) {
  const impersonate = String(value || '').trim();
  return EXTRACT_CHROME_PROFILES.find((item) => item.impersonate === impersonate)
    || EXTRACT_CHROME_PROFILES.find((item) => item.impersonate === EXTRACT_BROWSER)
    || EXTRACT_CHROME_PROFILES[1]
    || EXTRACT_CHROME_PROFILES[0];
}

function liveChromeProfiles(exclude = []) {
  const blocked = new Set([
    ...unsupportedImpersonates,
    ...[...exclude].map((item) => String(item || '').trim()).filter(Boolean),
  ]);
  const live = EXTRACT_CHROME_PROFILES.filter((item) => !blocked.has(item.impersonate));
  if (live.length) return live;
  return [profileForImpersonate(EXTRACT_BROWSER)];
}

function chromeFingerprintFor(value, acceptLanguage) {
  return fingerprintFromProfile(profileForImpersonate(resolveExtractBrowser(value)), acceptLanguage);
}

function randomChromeFingerprint(exclude = []) {
  const pool = liveChromeProfiles(exclude);
  const primary = pool.filter((item) => item.major === 136 || item.major === 131);
  const chosen = primary.length && Math.random() < 0.8 ? primary : pool;
  return fingerprintFromProfile(chosen[Math.floor(Math.random() * chosen.length)]);
}

function rememberUnsupportedImpersonate(value) {
  const impersonate = String(value || '').trim();
  if (impersonate) unsupportedImpersonates.add(impersonate);
}

function resetUnsupportedImpersonates() {
  unsupportedImpersonates.clear();
}

function isUnsupportedImpersonateError(error) {
  const detail = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /impersonat(?:e|ing).*(?:not supported|unsupported)|does not match any variant of enum `?browser`?/.test(detail);
}

function impersonateFromError(error) {
  const match = String(error?.message || '').match(/impersonat(?:e|ing)\s+([a-z]+\d+[a-z]?)/i);
  return match ? match[1].toLowerCase() : '';
}

const EXTRACT_USER_AGENT = chromeUserAgent(EXTRACT_CHROME_MAJOR);
const EXTRACT_SEC_CH_UA = chromeClientHints(EXTRACT_CHROME_MAJOR);
const EXTRACT_CHROME_HEADERS = Object.freeze(chromeFingerprintFor(EXTRACT_BROWSER).headers);

function resolveExtractBrowser(value, exclude = []) {
  const blocked = new Set([...unsupportedImpersonates, ...[...exclude].map((item) => String(item || '').trim())]);
  const raw = String(value || process.env.EXTRACT_IMPERSONATE || EXTRACT_BROWSER).trim();
  if (isSafariImpersonate(raw)) return EXTRACT_SAFARI_IMPERSONATE;
  if (EXTRACT_CHROME_BROWSERS.has(raw) && !blocked.has(raw)) return raw;
  const live = liveChromeProfiles([...blocked]);
  const preferred = live.find((item) => item.impersonate === EXTRACT_BROWSER);
  return (preferred || live[0] || profileForImpersonate(EXTRACT_BROWSER)).impersonate;
}

function resolveImpitBrowser(value, exclude = []) {
  const blocked = new Set([...unsupportedImpersonates, ...[...exclude].map((item) => String(item || '').trim())]);
  const raw = String(value || process.env.EXTRACT_IMPERSONATE || '').trim();
  if (IMPIT_BROWSERS.includes(raw) && !blocked.has(raw)) return raw;
  return IMPIT_BROWSERS.find((item) => !blocked.has(item)) || 'chrome136';
}

function hasHeader(headers, name) {
  const target = String(name || '').toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === target);
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (typeof headers.entries === 'function') {
    for (const [key, value] of headers.entries()) out[key] = value;
    return out;
  }
  return { ...headers };
}

function attachResponseBuffer(view, source) {
  if (!view || !source) return view;
  if (source.buffer) {
    view.buffer = Buffer.isBuffer(source.buffer) ? source.buffer : Buffer.from(source.buffer);
  } else if (source.body_b64) {
    view.buffer = Buffer.from(source.body_b64, 'base64');
  }
  return view;
}

function responseView(status, headers, text, url, extra) {
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const code = Number(status) || 0;
  return attachResponseBuffer(
    { ok: code >= 200 && code < 300, status: code, headers, text, data, url },
    extra,
  );
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function cookieHostMatches(storedHost, requestHost) {
  const stored = String(storedHost || '').replace(/^\./, '').toLowerCase();
  const host = String(requestHost || '').replace(/^\./, '').toLowerCase();
  if (!stored || !host) return !stored || !host;
  return host === stored || host.endsWith(`.${stored}`) || stored.endsWith(`.${host}`);
}

function createExtractCookieJar() {
  const byHost = new Map();
  function bagFor(host) {
    const key = String(host || '').replace(/^\./, '').toLowerCase() || 'chatgpt.com';
    if (!byHost.has(key)) byHost.set(key, new Map());
    return byHost.get(key);
  }
  return {
    setCookie(cookie, url, cb) {
      const first = String(cookie || '').split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) {
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        const domainMatch = String(cookie || '').match(/;\s*domain=([^;]+)/i);
        const host = String(domainMatch?.[1] || '').replace(/^\./, '') || hostFromUrl(url) || 'chatgpt.com';
        if (name) bagFor(host).set(name, value);
      }
      if (typeof cb === 'function') cb(null);
    },
    getCookieString(url) {
      const host = hostFromUrl(url);
      const merged = new Map();
      for (const [stored, map] of byHost.entries()) {
        if (cookieHostMatches(stored, host)) {
          for (const [name, value] of map.entries()) merged.set(name, value);
        }
      }
      return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    dump() {
      const out = [];
      for (const [host, map] of byHost.entries()) {
        for (const [name, value] of map.entries()) {
          out.push({ name, value, domain: host, path: '/' });
        }
      }
      return out;
    },
  };
}

async function seedCookieJar(cookieJar, entries = []) {
  for (const entry of entries) {
    const name = String(entry?.name || '').trim();
    if (!name) continue;
    const domain = String(entry.domain || '.chatgpt.com').replace(/^\./, '') || 'chatgpt.com';
    const cookie = `${name}=${entry.value || ''}; Path=${entry.path || '/'}; Domain=.${domain}; Secure`;
    await cookieJar.setCookie(cookie, `https://${domain}/`);
  }
}

function applyParams(url, params) {
  const target = new URL(url);
  if (!params || typeof params !== 'object') return target.href;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) target.searchParams.append(key, String(item));
    } else {
      target.searchParams.set(key, String(value));
    }
  }
  return target.href;
}

function dropContentType(headers = {}) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'content-type') delete next[key];
  }
  return next;
}

function encodeBody({ method = 'GET', json, form, body, headers = {} } = {}) {
  const verb = String(method || 'GET').toUpperCase();
  const requestHeaders = { ...headers };
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!hasHeader(requestHeaders, 'content-type')) requestHeaders['content-type'] = 'application/json';
  }
  if (form !== undefined) {
    payload = new URLSearchParams(
      Object.entries(form)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    ).toString();
    if (!hasHeader(requestHeaders, 'content-type')) {
      requestHeaders['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
  }
  if (verb === 'GET' || verb === 'HEAD') {
    return { headers: dropContentType(requestHeaders), body: undefined };
  }
  return { headers: requestHeaders, body: payload == null ? undefined : payload };
}

async function normalizeResponse(response, fallbackUrl) {
  if (!response) return responseView(0, {}, '', fallbackUrl || '');
  if (typeof response.text === 'function') {
    const text = await response.text();
    return responseView(
      Number(response.status) || 0,
      headersToObject(response.headers),
      text,
      String(response.url || fallbackUrl || ''),
      response,
    );
  }
  const text = response.text != null
    ? String(response.text)
    : response.data != null
      ? (typeof response.data === 'string' ? response.data : JSON.stringify(response.data))
      : '';
  return responseView(
    Number(response.status) || 0,
    headersToObject(response.headers),
    text,
    String(response.url || fallbackUrl || ''),
    response,
  );
}

function setCookieValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    try {
      return headers.getSetCookie().filter(Boolean);
    } catch { /* ignore */ }
  }
  const raw = headers['set-cookie'] || headers['Set-Cookie'] || headers['set-Cookie'];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (raw) return [String(raw)];
  return [];
}

function applySetCookies(cookieJar, headers, url) {
  if (!cookieJar || typeof cookieJar.setCookie !== 'function') return;
  for (const cookie of setCookieValues(headers)) {
    cookieJar.setCookie(cookie, url, () => {});
  }
}

function attachSessionApi(session, { fetchFn, cookieJar, browser, impersonated, fingerprint }) {
  session.browser = browser;
  session.impersonated = impersonated === true;
  session.cookieJar = cookieJar;
  session.fingerprint = fingerprint || chromeFingerprintFor(browser);
  session.seedCookies = (entries) => seedCookieJar(cookieJar, entries);
  session.request = async (url, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const target = applyParams(url, options.params);
    const encoded = encodeBody({ ...options, method });
    const headers = { ...encoded.headers };
    const jarCookie = typeof cookieJar?.getCookieString === 'function'
      ? cookieJar.getCookieString(target)
      : '';
    if (jarCookie && !hasHeader(headers, 'cookie')) headers.Cookie = jarCookie;
    const init = {
      method,
      headers,
      redirect: options.redirect || 'follow',
    };
    if (encoded.body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = encoded.body;
    if (Number(options.timeout) > 0) init.timeout = Number(options.timeout);
    const response = await fetchFn(target, init);
    const view = await normalizeResponse(response, target);
    applySetCookies(cookieJar, view.headers || response?.headers, view.url || target);
    return view;
  };
  session.cookies = async () => (typeof cookieJar.dump === 'function' ? cookieJar.dump() : []);
  session.close = async () => {};
  return session;
}

function createFetchExtractSession(fetchImpl, { timeoutMs, impersonate, acceptLanguage } = {}) {
  const cookieJar = createExtractCookieJar();
  const fingerprint = fingerprintFor(impersonate || EXTRACT_BROWSER, acceptLanguage);
  const session = attachSessionApi({}, {
    cookieJar,
    browser: fingerprint.impersonate,
    impersonated: false,
    fingerprint,
    fetchFn: (url, init) => fetchImpl(url, { timeout: timeoutMs, ...init }),
  });
  session.transport = 'fixture';
  return session;
}

function createImpitExtractSession(proxy, { timeoutMs, impersonate, acceptLanguage } = {}) {
  const { Impit } = require('impit');
  const tried = new Set();
  let lastError;
  while (tried.size < EXTRACT_CHROME_PROFILES.length + IMPIT_BROWSERS.length) {
    const fingerprint = chromeFingerprintFor(resolveImpitBrowser(impersonate, tried), acceptLanguage);
    if (tried.has(fingerprint.impersonate)) break;
    tried.add(fingerprint.impersonate);
    try {
      const cookieJar = createExtractCookieJar();
      const proxyUrl = buildProxyUrl(proxy);
      const client = new Impit({
        browser: fingerprint.impersonate,
        followRedirects: true,
        http3: false,
        timeout: Math.max(1000, Number(timeoutMs) || 45000),
        cookieJar,
        headers: { ...fingerprint.headers },
        ...(proxyUrl ? { proxyUrl } : {}),
      });
      const session = attachSessionApi({}, {
        cookieJar,
        browser: fingerprint.impersonate,
        impersonated: true,
        fingerprint,
        fetchFn: (url, init) => client.fetch(url, init),
      });
      session.transport = 'impit';
      return session;
    } catch (error) {
      lastError = error;
      if (!isUnsupportedImpersonateError(error)) throw error;
      rememberUnsupportedImpersonate(fingerprint.impersonate || impersonateFromError(error));
      impersonate = '';
    }
  }
  throw lastError || new Error('Impersonating chrome is not supported');
}

async function createCurlCffiExtractSession(proxy, { timeoutMs, impersonate, acceptLanguage } = {}) {
  const bundledPython = path.resolve(__dirname, '../../../.venv/bin/python3');
  const executable = process.env.EXTRACT_PYTHON
    || (fs.existsSync(bundledPython) ? bundledPython : (process.platform === 'win32' ? 'python' : 'python3'));
  const workerPath = path.join(__dirname, 'extract_http_worker.py');
  const safariOnly = isSafariImpersonate(impersonate);
  const tried = new Set();
  let lastError;
  while (tried.size < (safariOnly ? 1 : EXTRACT_CHROME_PROFILES.length + 1)) {
    const fingerprint = safariOnly
      ? safari17Fingerprint(acceptLanguage)
      : chromeFingerprintFor(resolveExtractBrowser(impersonate, tried), acceptLanguage);
    if (tried.has(fingerprint.impersonate)) break;
    tried.add(fingerprint.impersonate);
    const child = spawn(executable, [workerPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    const pending = [];
    let closed = false;
    let exitError = null;
    const failPending = (error) => {
      exitError = error;
      while (pending.length) pending.shift().reject(error);
    };
    child.once('error', (error) => failPending(error));
    child.once('exit', (code) => {
      closed = true;
      if (code && !exitError) failPending(new Error(`curl_cffi worker exited with code ${code}`));
    });
    lines.on('line', (line) => {
      const waiter = pending.shift();
      if (!waiter) return;
      try {
        const result = JSON.parse(line);
        if (!result.ok) waiter.reject(new Error(String(result.error || 'curl_cffi request failed')));
        else waiter.resolve(result);
      } catch {
        waiter.reject(new Error('curl_cffi worker returned invalid JSON'));
      }
    });
    const send = (command) => new Promise((resolve, reject) => {
      if (closed || exitError) {
        reject(exitError || new Error('curl_cffi worker is closed'));
        return;
      }
      pending.push({ resolve, reject });
      child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
        if (!error) return;
        const index = pending.findIndex((item) => item.resolve === resolve);
        if (index >= 0) pending.splice(index, 1);
        reject(error);
      });
    });
    const abortWorker = async () => {
      try { child.stdin.end(); } catch { /* already closed */ }
      lines.close();
      child.kill();
    };
    try {
      await send({
        action: 'init',
        impersonate: fingerprint.impersonate,
        proxy: buildProxyUrl(proxy),
        headers: fingerprint.headers,
      });
      return {
        browser: fingerprint.impersonate,
        fingerprint,
        transport: 'curl_cffi',
        impersonated: true,
        seedCookies: (entries) => send({ action: 'seed', cookies: entries }),
        async cookies() {
          const result = await send({ action: 'cookies' });
          return Array.isArray(result.cookies) ? result.cookies : [];
        },
        async request(url, options = {}) {
          const method = String(options.method || 'GET').toUpperCase();
          const target = applyParams(url, options.params);
          const encoded = encodeBody({ ...options, method });
          const result = await send({
            action: 'request',
            method,
            url: target,
            headers: encoded.headers,
            body: encoded.body,
            timeout: Number(options.timeout) || Number(timeoutMs) || 45000,
            redirect: options.redirect || 'follow',
          });
          return responseView(
            result.status,
            result.headers || {},
            result.text || '',
            result.url || target,
            result,
          );
        },
        async close() {
          if (closed) return;
          try { await send({ action: 'close' }); } catch { /* process may already be gone */ }
          child.stdin.end();
          lines.close();
        },
      };
    } catch (error) {
      await abortWorker();
      lastError = error;
      if (!isUnsupportedImpersonateError(error)) throw error;
      rememberUnsupportedImpersonate(fingerprint.impersonate || impersonateFromError(error));
      if (safariOnly) throw error;
      impersonate = '';
    }
  }
  throw lastError || new Error(safariOnly ? 'Impersonating safari17_0 is not supported' : 'Impersonating chrome is not supported');
}

function createExtractSession({ proxy, timeoutMs, fetchImpl, impersonate, acceptLanguage } = {}) {
  if (typeof fetchImpl === 'function') {
    return createFetchExtractSession(fetchImpl, { timeoutMs, impersonate, acceptLanguage });
  }
  if (isSafariImpersonate(impersonate)) {
    return createCurlCffiExtractSession(proxy, {
      timeoutMs,
      impersonate: EXTRACT_SAFARI_IMPERSONATE,
      acceptLanguage,
    });
  }
  if (process.env.EXTRACT_HTTP_ENGINE === 'impit') {
    return createImpitExtractSession(proxy, { timeoutMs, impersonate, acceptLanguage });
  }
  return createCurlCffiExtractSession(proxy, { timeoutMs, impersonate, acceptLanguage });
}

async function withExtractSession(options, handler) {
  if (typeof handler !== 'function') throw new TypeError('withExtractSession 缺少 handler');
  const session = await createExtractSession(options);
  let keepOpen = false;
  try {
    const result = await handler(session);
    keepOpen = options?.keepOpen === true && result && result.keep_session === true;
    if (keepOpen) return { ...result, session };
    return result;
  } finally {
    if (!keepOpen) await session.close?.().catch(() => {});
  }
}

module.exports = {
  EXTRACT_BROWSER,
  EXTRACT_CHROME_MAJOR,
  EXTRACT_CHROME_PROFILES,
  EXTRACT_SAFARI_IMPERSONATE,
  EXTRACT_SAFARI_USER_AGENT,
  EXTRACT_USER_AGENT,
  EXTRACT_SEC_CH_UA,
  EXTRACT_CHROME_HEADERS,
  chromeFingerprintFor,
  fingerprintFor,
  applyAcceptLanguage,
  safari17Fingerprint,
  isSafariImpersonate,
  randomChromeFingerprint,
  chromeMajorFromImpersonate,
  isUnsupportedImpersonateError,
  rememberUnsupportedImpersonate,
  resetUnsupportedImpersonates,
  resolveExtractBrowser,
  resolveImpitBrowser,
  createExtractCookieJar,
  createCurlCffiExtractSession,
  createExtractSession,
  withExtractSession,
  buildProxyUrl,
};
