const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { readdir, readFile, rm } = require('node:fs/promises');
const { promisify } = require('node:util');
const path = require('node:path');
const { config } = require('./config');

let cloakModule = null;
const loadCloakBrowser = async () => {
  cloakModule ||= await import('cloakbrowser');
  return cloakModule;
};
const launch = async options => (await loadCloakBrowser()).launch(options);
const launchPersistentContext = async options => (await loadCloakBrowser()).launchPersistentContext(options);
const execFileAsync = promisify(execFile);

const LIVE_RUNTIMES = new Set();
const BROWSER_CLOSE_TIMEOUT_MS = 8000;
const BROWSER_KILL_TIMEOUT_MS = 2000;
const CLOAK_LICENSE_CAPACITY_ATTEMPTS = 16;
const CLOAK_LICENSE_CAPACITY_BASE_DELAY_MS = 5000;
const CLOAK_LICENSE_CAPACITY_MAX_DELAY_MS = 60000;
const CLOAK_LICENSE_MAX_SESSIONS = 50;
const CLOAK_LICENSE_SESSION_COUNT_URL = 'https://cloakbrowser.dev/api/license/session/count';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const mask = (value) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '';
function parseLicenseKeys(options = {}) {
  const seen = new Set();
  const keys = [];
  const add = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    for (const line of String(value || '').split(/[\r\n]+/)) {
      const key = line.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  };
  add(options.licenseKeys);
  add(options.licenseKey);
  return keys;
}

class LicensePool {
  constructor(keys = []) {
    this.keys = [];
    this.cursor = 0;
    this.exhaustedUntil = new Map();
    this.setKeys(keys);
  }
  setKeys(keys) {
    this.keys = [...(Array.isArray(keys) ? keys : parseLicenseKeys({ licenseKey: keys }))];
    if (this.cursor >= this.keys.length) this.cursor = 0;
    for (const key of [...this.exhaustedUntil.keys()]) {
      if (!this.keys.includes(key)) this.exhaustedUntil.delete(key);
    }
  }
  size() { return this.keys.length; }
  current() {
    if (!this.keys.length) return '';
    return this.keys[this.cursor % this.keys.length];
  }
  advance() {
    if (this.keys.length > 1) this.cursor = (this.cursor + 1) % this.keys.length;
    return this.current();
  }
  isExhausted(key) {
    const until = this.exhaustedUntil.get(key) || 0;
    if (until <= Date.now()) {
      this.exhaustedUntil.delete(key);
      return false;
    }
    return true;
  }
  markExhausted(key, delayMs) {
    if (!key) return;
    this.exhaustedUntil.set(key, Date.now() + Math.max(1, Number(delayMs) || CLOAK_LICENSE_CAPACITY_BASE_DELAY_MS));
  }
  pick({ skip = null } = {}) {
    const n = this.keys.length;
    if (!n) return '';
    const skipped = skip instanceof Set ? skip : new Set(skip ? [skip] : []);
    for (let i = 0; i < n; i += 1) {
      const idx = (this.cursor + i) % n;
      const key = this.keys[idx];
      if (skipped.has(key) || this.isExhausted(key)) continue;
      this.cursor = idx;
      return key;
    }
    return '';
  }
  nextAvailable(fromKey) {
    if (this.keys.length <= 1) return '';
    const start = this.keys.indexOf(fromKey);
    this.cursor = start >= 0 ? (start + 1) % this.keys.length : this.cursor;
    return this.pick({ skip: fromKey });
  }
}
const hasHeader = (headers, name) => Object.keys(headers || {})
  .some(key => key.toLowerCase() === String(name).toLowerCase());
const timeoutLike = error => error?.name === 'TimeoutError'
  || /ERR_TIMED_OUT|(?:timeout|timed out).*?(?:exceeded|\d+\s*ms)/i.test(String(error?.message || ''));
const transientNavigationLike = error => timeoutLike(error)
  || /net::ERR_(?:EMPTY_RESPONSE|CONNECTION_(?:RESET|CLOSED|ABORTED|REFUSED)|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/i
    .test(String(error?.message || ''));

async function remoteLicenseSessionCount(licenseKey) {
  const key = String(licenseKey || '').trim();
  if (!key || typeof fetch !== 'function') return null;
  try {
    const response = await fetch(CLOAK_LICENSE_SESSION_COUNT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license_key: key }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return Number.isFinite(Number(data?.active)) ? Math.max(0, Number(data.active)) : null;
  } catch {
    return null;
  }
}

async function settleWithin(factory, timeoutMs) {
  let timer;
  const outcome = await Promise.race([
    Promise.resolve().then(factory).then(
      () => ({ ok: true, timedOut: false }),
      error => ({ ok: false, timedOut: false, error }),
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, timedOut: true }), Math.max(1, Number(timeoutMs) || 1));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return outcome;
}

// 上下文导航只需要把页面切到目标 origin 并收下 Set-Cookie，两者在 `commit` 时都已完成。
// 等 `domcontentloaded` 会连带等完 chatgpt.com/auth/login 这类页面的全部同步脚本与风控挑战，
// 住宅代理上经常耗光整个超时预算；首次导航被代理挂死（HAR 里表现为 status 0，重试即通）也是
// 常态，所以给它一段有上限的独立预算并重试，而不是让一次挂起吃掉整个协议请求。
const CONTEXT_NAVIGATION_BUDGET_MS = 20000;
const CONTEXT_NAVIGATION_ATTEMPTS = 5;

function requestTimeoutError(method, target, timeoutMs, stage, context) {
  // context_navigation 阶段目标接口一个字节都没发出去，消息里必须点出真正卡住的页面，
  // 否则排查会一直盯着无辜的目标接口（曾把 /auth/login 的代理挂起误判成 csrf 接口故障）。
  const detail = stage === 'context_navigation' && context
    ? `：上下文页面 ${context.origin}${context.pathname} 未能加载，目标请求尚未发出`
    : '';
  const error = new Error(`协议请求超时 ${method} ${target.origin}${target.pathname} (${timeoutMs}ms)${detail}`);
  error.code = 'PROTOCOL_REQUEST_TIMEOUT';
  error.stage = stage;
  return error;
}

const networkFailureLike = error => /failed to fetch|networkerror|load failed|net::/i.test(String(error?.message || ''));

function requestNetworkError(method, target, detail) {
  const error = new Error(
    `协议请求网络层失败 ${method} ${target.origin}${target.pathname}：${detail || '代理不可达或连接被重置'}`,
  );
  error.code = 'PROTOCOL_REQUEST_NETWORK';
  error.stage = 'fetch';
  error.netError = detail || '';
  return error;
}

// Chromium 只把传输层失败暴露成 `TypeError: Failed to fetch`。真正的 net:: 错误码只存在于
// requestfailed 事件里，而它是区分「代理隧道不通」与「目标站拒连」的唯一线索。
function watchRequestFailure(page, target) {
  const failures = [];
  const onFailed = request => {
    try {
      const detail = request.failure?.()?.errorText || '';
      if (detail) failures.push({ url: request.url(), detail });
    } catch {}
  };
  if (typeof page?.on !== 'function') return { detail: () => '', dispose: () => {} };
  try { page.on('requestfailed', onFailed); } catch { return { detail: () => '', dispose: () => {} }; }
  return {
    detail: () => {
      const exact = failures.filter(item => item.url === target.href).at(-1);
      const sameOrigin = failures.filter(item => item.url.startsWith(target.origin)).at(-1);
      return (exact || sameOrigin)?.detail || '';
    },
    dispose: () => { try { page.off?.('requestfailed', onFailed); } catch {} },
  };
}

function jobCancelledError() {
  const error = new Error('任务已取消');
  error.code = 'JOB_CANCELLED';
  return error;
}

function installProcessShutdown() {
  if (globalThis.__gptPlusCloakShutdownInstalled) return;
  globalThis.__gptPlusCloakShutdownInstalled = true;
  const handle = () => {
    closeAllRuntimes().catch(() => {});
  };
  process.once('SIGTERM', handle);
  process.once('SIGINT', handle);
}

async function closeAllRuntimes() {
  const list = [...LIVE_RUNTIMES];
  await Promise.allSettled(list.map((runtime) => runtime.closeAll()));
}

function browserStillConnected(browser) {
  try {
    return typeof browser?.isConnected === 'function' && browser.isConnected() === true;
  } catch {
    return false;
  }
}

async function closeCloakHandles(resource, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS) {
  if (!resource) return true;
  const budget = Math.max(200, Number(timeoutMs) || BROWSER_CLOSE_TIMEOUT_MS);
  const browser = resource.browser;
  const context = resource.context;
  const child = typeof browser?.process === 'function' ? browser.process() : null;
  const pages = [];
  const takePages = (ctx) => {
    try {
      for (const page of (typeof ctx?.pages === 'function' ? ctx.pages() : []) || []) {
        if (page && !pages.includes(page)) pages.push(page);
      }
    } catch {}
  };
  takePages(context);
  try {
    for (const ctx of (typeof browser?.contexts === 'function' ? browser.contexts() : []) || []) takePages(ctx);
  } catch {}
  for (const page of pages) {
    await settleWithin(() => page?.close?.(), Math.min(2000, budget));
  }
  const contexts = [];
  const pushCtx = (ctx) => {
    if (ctx && !contexts.includes(ctx)) contexts.push(ctx);
  };
  pushCtx(context);
  try {
    for (const ctx of (typeof browser?.contexts === 'function' ? browser.contexts() : []) || []) pushCtx(ctx);
  } catch {}
  for (const ctx of contexts) {
    await settleWithin(() => ctx.close?.(), budget);
  }
  if (typeof browser?.close === 'function' && browser !== context) {
    await settleWithin(() => browser.close(), budget);
  }
  if (!browserStillConnected(browser)) return true;
  try { child?.kill?.('SIGKILL'); } catch {}
  await settleWithin(() => browser.close?.(), BROWSER_KILL_TIMEOUT_MS);
  return !browserStillConnected(browser);
}

async function closePlaywrightBrowser(browser, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS) {
  if (!browser) return;
  await closeCloakHandles({ browser }, timeoutMs);
}

function currentPageOrigin(page) {
  try {
    const value = typeof page?.url === 'function' ? page.url() : '';
    return value ? new URL(value).origin : '';
  } catch {
    return '';
  }
}

class Semaphore {
  constructor(limit) { this.limit = Math.max(1, Number(limit) || 1); this.active = 0; this.waiters = []; }
  async acquire(weight = 1, { cancelled = null, onCancel = null, label = 'other', activity = null } = {}) {
    const count = Math.max(1, Math.floor(Number(weight) || 1));
    if (count > this.limit) throw new Error(`CloakBrowser 会话组需要 ${count} 个并发槽，当前上限为 ${this.limit}`);
    const cancellationError = () => {
      const error = new Error('任务已取消');
      error.code = 'JOB_CANCELLED';
      return error;
    };
    if (cancelled?.()) throw cancellationError();
    if (!this.waiters.length && this.active + count <= this.limit) {
      this.active += count;
      return count;
    }
    await new Promise((resolve, reject) => {
      const waiter = {
        count,
        label: String(label || 'other'),
        activity,
        enqueuedAt: Date.now(),
        settled: false,
        detachCancel: null,
        resolve: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          try { waiter.detachCancel?.(); } catch {}
          resolve();
        },
        reject: error => {
          if (waiter.settled) return;
          waiter.settled = true;
          try { waiter.detachCancel?.(); } catch {}
          reject(error);
        },
      };
      const remove = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.reject(cancellationError());
        this.drain();
      };
      this.waiters.push(waiter);
      if (typeof onCancel === 'function') waiter.detachCancel = onCancel(remove);
      if (cancelled?.()) remove();
    });
    return count;
  }
  drain() {
    while (this.waiters.length && this.active + this.waiters[0].count <= this.limit) {
      const waiter = this.waiters.shift();
      this.active += waiter.count;
      waiter.resolve();
    }
  }
  release(weight = 1) {
    const count = Math.max(1, Math.floor(Number(weight) || 1));
    this.active = Math.max(0, this.active - count);
    this.drain();
  }
  setLimit(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    const pending = [];
    for (const waiter of this.waiters) {
      if (waiter.count > this.limit) waiter.reject(new Error(`CloakBrowser 会话组需要 ${waiter.count} 个并发槽，当前上限为 ${this.limit}`));
      else pending.push(waiter);
    }
    this.waiters = pending;
    this.drain();
  }
  stats() {
    const queuedByKind = {};
    for (const waiter of this.waiters) {
      queuedByKind[waiter.label] = (queuedByKind[waiter.label] || 0) + waiter.count;
    }
    const maxSlots = this.limit;
    const reservedSlots = this.active;
    return {
      maxSlots,
      reservedSlots,
      availableSlots: Math.max(0, maxSlots - reservedSlots),
      queuedRequests: this.waiters.length,
      queuedSlots: this.waiters.reduce((sum, waiter) => sum + waiter.count, 0),
      queuedByKind,
    };
  }
}

function proxyUrl(proxy) {
  if (!proxy) return '';
  if (typeof proxy === 'string') return proxy;
  const rawScheme = String(proxy.proxy_type || proxy.type || 'http').toLowerCase();
  const scheme = rawScheme === 'socks5h' ? 'socks5' : rawScheme;
  if (!['http', 'https', 'socks5'].includes(scheme)) throw new TypeError(`不支持的代理类型: ${rawScheme}`);
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@` : '';
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * 组装 cloakbrowser 的 proxy 选项。
 *
 * 没有 bypass 时沿用 URL 字符串。需要按域名绕过时必须换成对象形式：cloakbrowser 只在
 * proxy 是对象时才把 `bypass` 转成 `--proxy-bypass-list`，字符串形式没有承载它的字段，
 * 会被静默丢掉——那样绕过就悄悄失效了。
 */
function proxyLaunchConfig(proxy, bypass = '') {
  const server = proxyUrl(proxy);
  if (!server) return undefined;
  const list = String(bypass || '').trim();
  if (!list) return server;
  let parsed;
  try { parsed = new URL(server.includes('://') ? server : `http://${server}`); } catch { return server; }
  const config = { server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`, bypass: list };
  if (parsed.username) config.username = decodeURIComponent(parsed.username);
  if (parsed.password) config.password = decodeURIComponent(parsed.password);
  return config;
}

const LAUNCH_ADMISSION_OWNER = Symbol('cloakLaunchAdmissionOwner');

function persistentProfile(profileKey, role, proxy, profileRoot = config.cloak.profileRoot) {
  const key = String(profileKey || '').trim();
  if (!key) return null;
  let proxyBinding = 'direct';
  if (typeof proxy === 'string') {
    try {
      const parsed = new URL(proxy);
      proxyBinding = [parsed.protocol, parsed.hostname, parsed.port, parsed.username].join('|');
    } catch {
      proxyBinding = proxy;
    }
  } else if (proxy && typeof proxy === 'object') {
    proxyBinding = [
      proxy.source, proxy.automated_pool, proxy.region, proxy.session_id,
      proxy.id, proxy.proxy_type || proxy.type, proxy.host, proxy.port, proxy.username,
    ].map(value => String(value || '')).join('|');
  }
  const digest = crypto.createHash('sha256')
    .update(`${key}\0${String(role || '')}\0${proxyBinding}`)
    .digest('hex');
  const root = path.resolve(String(profileRoot || config.cloak.profileRoot));
  return {
    id: digest.slice(0, 24),
    seed: 10000 + (Number.parseInt(digest.slice(0, 8), 16) % 90000),
    root,
    userDataDir: path.join(root, digest.slice(0, 24)),
  };
}

async function cleanupPersistentProfile(profile, log) {
  const root = path.resolve(String(profile?.root || config.cloak.profileRoot));
  const target = path.resolve(String(profile?.userDataDir || ''));
  if (!target || target === root || !target.startsWith(`${root}${path.sep}`)) return false;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      log?.('CloakBrowser 注册 profile 已回收', 'debug');
      return true;
    } catch (error) {
      lastError = error;
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(String(error?.code || '')) || attempt >= 4) break;
      await sleep(250 * attempt);
    }
  }
  log?.(`CloakBrowser 注册 profile 回收失败：${String(lastError?.message || lastError).slice(0, 160)}`, 'warn');
  return false;
}

async function persistentProfileProcessIds(profile) {
  const root = path.resolve(String(profile?.root || config.cloak.profileRoot));
  const target = path.resolve(String(profile?.userDataDir || ''));
  if (!target || target === root || !target.startsWith(`${root}${path.sep}`)) return [];
  if (process.platform === 'linux') {
    const entries = await readdir('/proc', { withFileTypes: true }).catch(() => []);
    const matches = [];
    await Promise.all(entries.filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async entry => {
      const pid = Number(entry.name);
      if (!pid || pid === process.pid) return;
      const command = await readFile(`/proc/${pid}/cmdline`).catch(() => null);
      if (!command) return;
      const args = command.toString('utf8').split('\0').filter(Boolean);
      if (args.some(value => value === `--user-data-dir=${target}` || value === target)) matches.push(pid);
    }));
    return matches;
  }
  if (process.platform === 'win32') {
    const escaped = target.replace(/'/g, "''");
    const script = `$p='${escaped}'; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -and $_.CommandLine.Contains($p) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 });
      const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

async function terminatePersistentProfileProcesses(profile) {
  if (!profile?.userDataDir || !['linux', 'win32'].includes(process.platform)) {
    return { supported: false, matched: 0, alive: 0 };
  }
  const initial = await persistentProfileProcessIds(profile);
  for (const pid of initial) {
    try { process.kill(pid, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM'); } catch {}
  }
  if (initial.length) await sleep(250);
  let remaining = await persistentProfileProcessIds(profile);
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  if (remaining.length) await sleep(100);
  remaining = await persistentProfileProcessIds(profile);
  return { supported: true, matched: initial.length, alive: remaining.length };
}

class CloakSession {
  constructor(browser, page, options, log) {
    this.browser = browser;
    this.page = page;
    this.options = options;
    this.log = log || (() => {});
    this.extraSessions = [];
  }
  async fingerprint() {
    const value = await this.page.evaluate(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: [...(navigator.languages || [])],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
      vendor: navigator.vendor,
      maxTouchPoints: navigator.maxTouchPoints,
      webdriver: navigator.webdriver,
    }));
    return { ...value, id: crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12) };
  }
  async goto(url, options = {}) {
    this.log(`CloakBrowser 导航 ${new URL(url).origin}`, 'debug');
    return this.page.goto(url, { waitUntil: options.waitUntil || 'domcontentloaded', timeout: options.timeout || this.options.timeoutMs });
  }
  async newPage(_options = {}) {
    const sourceContext = typeof this.page.context === 'function' ? this.page.context() : null;
    const page = sourceContext && typeof sourceContext.newPage === 'function'
      ? await sourceContext.newPage()
      : await this.browser.newPage();
    const targetContext = typeof page.context === 'function' ? page.context() : null;
    if (sourceContext && targetContext && sourceContext !== targetContext
      && typeof sourceContext.cookies === 'function' && typeof targetContext.addCookies === 'function') {
      const cookies = await sourceContext.cookies().catch(() => []);
      if (cookies.length) await targetContext.addCookies(cookies);
    }
    page.setDefaultTimeout(this.options.timeoutMs);
    page.setDefaultNavigationTimeout(this.options.timeoutMs);
    const session = new CloakSession(this.browser, page, this.options, this.log);
    this.extraSessions.push(session);
    return session;
  }
  async closePage() {
    await this.page.close().catch(() => {});
  }
  async closeExtraPages() {
    const extras = this.extraSessions.splice(0, this.extraSessions.length);
    await Promise.all(extras.map((session) => session.closePage().catch(() => {})));
  }
  async replaceRoute(url) {
    const target = new URL(String(url));
    const current = currentPageOrigin(this.page);
    if (current && current !== target.origin) {
      throw new Error(`replaceRoute 只允许同源路由：${current} -> ${target.origin}`);
    }
    await this.page.evaluate((href) => {
      history.replaceState(history.state, '', href);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, target.href);
    return target.href;
  }
  async request(url, {
    method = 'GET',
    headers = {},
    json,
    form,
    body,
    timeout,
    redirect = 'follow',
    params,
    contextUrl,
    referrer,
    waitUntil = 'domcontentloaded',
    readBody = true,
  } = {}) {
    const upper = method.toUpperCase(); const requestHeaders = { ...headers }; const target = new URL(url);
    const timeoutMs = Math.max(1, Number(timeout) || Number(this.options.timeoutMs) || 120000);
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    if (params) for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) target.searchParams.append(key, String(item));
      else target.searchParams.set(key, String(value));
    }
    let payload = body;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      if (!hasHeader(requestHeaders, 'content-type')) requestHeaders['content-type'] = 'application/json';
    }
    if (form !== undefined) {
      payload = new URLSearchParams(Object.entries(form).filter(([,v]) => v !== undefined && v !== null).map(([k,v]) => [k, String(v)])).toString();
      if (!hasHeader(requestHeaders, 'content-type')) requestHeaders['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    this.log(`协议请求 ${upper} ${target.origin}${target.pathname}`, 'debug');
    if ((upper === 'GET' || upper === 'HEAD') && !contextUrl) {
      await this.page.setExtraHTTPHeaders(requestHeaders);
      try {
        let response;
        try {
          response = await this.page.goto(target.href, { waitUntil, timeout: Math.max(1, remaining()) });
        } catch (error) {
          if (this.options.cancelled?.()) throw jobCancelledError();
          if (timeoutLike(error) || remaining() <= 0) throw requestTimeoutError(upper, target, timeoutMs, 'navigation');
          throw error;
        }
        if (!response) throw new Error(`CloakBrowser 未收到响应: ${target.origin}${target.pathname}`);
        let text = '';
        if (upper !== 'HEAD' && readBody !== false) try { text = (await response.body()).toString('utf8'); } catch {}
        return responseView(response.status(), response.headers(), text, response.url());
      } finally {
        await this.page.setExtraHTTPHeaders({}).catch(() => {});
      }
    }
    const requestContext = contextUrl ? new URL(contextUrl).href : target.origin;
    const contextTarget = new URL(requestContext);
    if (currentPageOrigin(this.page) !== contextTarget.origin) {
      await this.#enterContext(contextTarget, { method: upper, target, timeoutMs, remaining });
    }
    const fetchTimeout = remaining();
    if (fetchTimeout <= 0) throw requestTimeoutError(upper, target, timeoutMs, 'fetch');
    const failureWatch = watchRequestFailure(this.page, target);
    let result;
    try {
      result = await this.page.evaluate(async ({ url, method, headers, payload, redirect, timeout, referrer, readBody }) => {
        const ctl = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
        try {
          const request = { method, headers, body: payload ?? undefined, credentials: 'include', redirect, signal: ctl.signal };
          if (referrer) request.referrer = referrer;
          const response = await fetch(url, request);
          const text = readBody ? await response.text() : ''; const outHeaders = {}; response.headers.forEach((v,k) => { outHeaders[k]=v; });
          return { status: response.status, headers: outHeaders, text, url: response.url };
        } catch (error) {
          if (timedOut) return { requestError: 'timeout' };
          throw error;
        } finally { clearTimeout(timer); }
      }, {
        url: target.href,
        method: upper,
        headers: requestHeaders,
        payload: payload == null ? null : String(payload),
        redirect,
        timeout: fetchTimeout,
        referrer: referrer ? new URL(referrer).href : '',
        readBody: readBody !== false,
      });
    } catch (error) {
      if (this.options.cancelled?.()) throw jobCancelledError();
      if (remaining() <= 0 && (timeoutLike(error) || error?.name === 'AbortError')) {
        throw requestTimeoutError(upper, target, timeoutMs, 'fetch');
      }
      if (networkFailureLike(error)) {
        // requestfailed 可能比 evaluate 的 rejection 稍晚到达，留一个短窗口收集 net:: 错误码。
        await sleep(50);
        throw requestNetworkError(upper, target, failureWatch.detail());
      }
      throw error;
    } finally {
      failureWatch.dispose();
    }
    if (result?.requestError === 'timeout') throw requestTimeoutError(upper, target, timeoutMs, 'fetch');
    return responseView(result.status, result.headers, result.text, result.url);
  }
  async #enterContext(contextTarget, { method, target, timeoutMs, remaining }) {
    const label = `${contextTarget.origin}${contextTarget.pathname}`;
    this.log(`协议上下文导航 ${label}`, 'debug');
    for (let attempt = 1; attempt <= CONTEXT_NAVIGATION_ATTEMPTS; attempt += 1) {
      const budget = Math.min(remaining(), CONTEXT_NAVIGATION_BUDGET_MS);
      if (budget <= 0) break;
      try {
        await this.page.goto(contextTarget.href, { waitUntil: 'commit', timeout: budget });
        return;
      } catch (error) {
        if (this.options.cancelled?.()) throw jobCancelledError();
        // Keep bounded proxy transport failures in the current BrowserContext;
        // business/protocol errors still fail immediately.
        if (!transientNavigationLike(error) && remaining() > 0) {
          throw new Error(`CloakBrowser 协议上下文加载失败 ${label}: ${error.message}`);
        }
        this.log(`协议上下文 ${label} 在 ${budget}ms 内无响应（第 ${attempt}/${CONTEXT_NAVIGATION_ATTEMPTS} 次）`, 'warn');
      }
    }
    throw requestTimeoutError(method, target, timeoutMs, 'context_navigation', contextTarget);
  }
  async fill(selectors, value, { timeout = 5000 } = {}) {
    for (const selector of selectors) { const loc=this.page.locator(selector).first(); if(await loc.isVisible({timeout}).catch(()=>false)){await loc.fill(String(value));return selector;} } throw new Error(`未找到输入框: ${selectors.join(' | ')}`);
  }
  async click(selectors, { timeout = 5000 } = {}) {
    for (const selector of selectors) { const loc=this.page.locator(selector).first(); if(await loc.isVisible({timeout}).catch(()=>false)){await loc.click();return selector;} } throw new Error(`未找到按钮: ${selectors.join(' | ')}`);
  }
  async visible(selectors, timeout = 1500) { for (const selector of selectors) if (await this.page.locator(selector).first().isVisible({ timeout }).catch(() => false)) return selector; return ''; }
  async screenshot(name) { const file = path.join(__dirname, 'runtime', 'screenshots', `${name}.png`); await this.page.screenshot({ path: file, fullPage: true }); return file; }
  async cookies() { return this.page.context().cookies(); }
  async wait(ms) { await sleep(ms); }
}

function responseView(status, headers, text, url) {
  let data = null; try { data = JSON.parse(text); } catch {}
  return { ok: status >= 200 && status < 300, status, headers, text, data, url };
}

class CloakRuntime {
  constructor(options = {}, eventLog = null) {
    const {
      launch: launchImpl,
      launchPersistentContext: launchPersistentImpl,
      profileCleanup,
      licenseSessionCount,
      ...cloakOptions
    } = options;
    this.options = { ...config.cloak, ...cloakOptions };
    this.eventLog = eventLog;
    this.semaphore = new Semaphore(this.options.maxConcurrency);
    this.launchSemaphore = new Semaphore(this.options.launchConcurrency);
    this.profileCleanupSemaphore = new Semaphore(this.options.profileCleanupConcurrency);
    this.profileCleanupPending = new Set();
    this.active = new Map();
    this.reservations = new Map();
    this.profileLocks = new Map();
    this.launchBrowser = typeof launchImpl === 'function' ? launchImpl : launch;
    this.launchPersistentContext = typeof launchPersistentImpl === 'function' ? launchPersistentImpl : launchPersistentContext;
    this.removePersistentProfile = typeof profileCleanup === 'function' ? profileCleanup : cleanupPersistentProfile;
    this.licenseSessionCount = typeof licenseSessionCount === 'function' ? licenseSessionCount : remoteLicenseSessionCount;
    this.licensePool = new LicensePool(parseLicenseKeys(this.options));
    this.licenseCapacity = {
      consecutive: 0, backoffUntil: 0, delayMs: 0,
      remoteActive: null, remoteCheckedAt: 0, remoteProbe: null,
      byKey: new Map(),
    };
    LIVE_RUNTIMES.add(this);
    installProcessShutdown();
  }
  licenseCapacityOptions(options = this.options) {
    return {
      attempts: Math.max(1, Math.min(32, Math.floor(Number(options.licenseSessionLimitAttempts) || CLOAK_LICENSE_CAPACITY_ATTEMPTS))),
      baseDelayMs: Math.max(1, Number(options.licenseSessionLimitBaseDelayMs) || CLOAK_LICENSE_CAPACITY_BASE_DELAY_MS),
      maxDelayMs: Math.max(1, Number(options.licenseSessionLimitMaxDelayMs) || CLOAK_LICENSE_CAPACITY_MAX_DELAY_MS),
      maxSessions: Math.max(1, Math.floor(
        Number(options.licenseMaxSessions)
        || Number(options.resourceMaxConcurrency)
        || Number(options.resourceConcurrency)
        || Number(options.maxConcurrency)
        || CLOAK_LICENSE_MAX_SESSIONS
      )),
      probeIntervalMs: Math.max(0, Number(options.licenseSessionProbeIntervalMs) || 2000),
    };
  }
  licenseSlot(key) {
    const pressure = this.licenseCapacity;
    const id = String(key || '');
    let slot = pressure.byKey.get(id);
    if (!slot) {
      slot = { active: null, checkedAt: 0, probe: null };
      pressure.byKey.set(id, slot);
    }
    return slot;
  }
  async probeRemoteLicenseCapacity({ force = false, licenseKey } = {}) {
    if (typeof this.licenseSessionCount !== 'function') return null;
    const key = String(licenseKey || this.licensePool.current() || this.options.licenseKey || '').trim();
    const pressure = this.licenseCapacity;
    const { probeIntervalMs } = this.licenseCapacityOptions();
    const slot = this.licenseSlot(key);
    if (!force && slot.checkedAt && Date.now() - slot.checkedAt < probeIntervalMs) {
      pressure.remoteActive = slot.active;
      pressure.remoteCheckedAt = slot.checkedAt;
      return slot.active;
    }
    if (slot.probe) return slot.probe;
    slot.probe = Promise.resolve()
      .then(() => this.licenseSessionCount(key))
      .then(value => {
        slot.active = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
        slot.checkedAt = Date.now();
        pressure.remoteActive = slot.active;
        pressure.remoteCheckedAt = slot.checkedAt;
        return slot.active;
      })
      .catch(() => null)
      .finally(() => { slot.probe = null; });
    return slot.probe;
  }
  async pickLicenseWithCapacity() {
    const keys = this.licensePool.keys;
    if (!keys.length) return String(this.options.licenseKey || '').trim();
    const { maxSessions, baseDelayMs } = this.licenseCapacityOptions();
    const tried = new Set();
    while (tried.size < keys.length) {
      const key = this.licensePool.pick({ skip: tried });
      if (!key) break;
      tried.add(key);
      const active = await this.probeRemoteLicenseCapacity({ force: true, licenseKey: key });
      if (active === null || active < maxSessions) return key;
      this.licensePool.markExhausted(key, this.licenseCapacity.delayMs || baseDelayMs);
    }
    return '';
  }
  noteLicenseCapacityLimit(log = null) {
    const pressure = this.licenseCapacity;
    const { baseDelayMs, maxDelayMs } = this.licenseCapacityOptions();
    if (Date.now() < pressure.backoffUntil) return Math.max(0, pressure.backoffUntil - Date.now());
    pressure.consecutive = Math.min(32, pressure.consecutive + 1);
    pressure.delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(6, pressure.consecutive - 1)));
    pressure.backoffUntil = Date.now() + pressure.delayMs;
    const message = `CloakBrowser 许可证席位暂满，暂停新浏览器冷启动 ${Math.ceil(pressure.delayMs / 1000)} 秒后重试`;
    if (typeof log === 'function') log(message, 'warn');
    else this.eventLog?.push('warn', message, 'cloak-capacity');
    return pressure.delayMs;
  }
  noteLicenseCapacitySuccess() {
    if (Date.now() < this.licenseCapacity.backoffUntil) return;
    this.licenseCapacity.consecutive = 0;
    this.licenseCapacity.backoffUntil = 0;
    this.licenseCapacity.delayMs = 0;
  }
  noteLicenseSessionClosed() {
    const pressure = this.licenseCapacity;
    pressure.remoteActive = null;
    pressure.remoteCheckedAt = 0;
    if (!pressure.consecutive && pressure.backoffUntil <= Date.now()) return;
    pressure.consecutive = 0;
    pressure.delayMs = 0;
    pressure.backoffUntil = Math.min(
      pressure.backoffUntil > Date.now() ? pressure.backoffUntil : Infinity,
      Date.now() + Math.max(250, Math.min(2000, Number(this.options.licenseSessionReleaseProbeDelayMs) || 2000)),
    );
  }
  async waitForLicenseCapacity(task = {}) {
    while (Date.now() < this.licenseCapacity.backoffUntil) {
      if (task.cancelled?.()) throw jobCancelledError();
      await sleep(Math.min(250, Math.max(1, this.licenseCapacity.backoffUntil - Date.now())));
    }
  }
  async acquireProfile(profile, task = {}) {
    if (!profile) return null;
    let lock = this.profileLocks.get(profile.id);
    if (!lock) {
      lock = new Semaphore(1);
      this.profileLocks.set(profile.id, lock);
    }
    await lock.acquire(1, {
      label: 'profile', activity: task.activity, cancelled: task.cancelled, onCancel: task.onCancel,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lock.release(1);
      if (!lock.active && !lock.waiters.length) this.profileLocks.delete(profile.id);
    };
  }
  async forceCloseResource(resource) {
    if (resource?.forceClosePromise) return resource.forceClosePromise;
    resource.forceClosePromise = (async () => {
      const timeoutMs = Math.max(1, Number(this.options.cleanupForceTimeoutMs) || BROWSER_KILL_TIMEOUT_MS);
      const closed = await closeCloakHandles(resource, timeoutMs);
      if (closed || !browserStillConnected(resource?.browser)) {
        resource.closed = true;
        return true;
      }
      const hardKill = resource?.browser?._channel?.killForTests;
      if (typeof hardKill === 'function' && (await settleWithin(() => hardKill.call(resource.browser._channel, {}), timeoutMs)).ok) {
        resource.closed = true;
        return true;
      }
      const terminated = await terminatePersistentProfileProcesses(resource?.profile);
      resource.closed = terminated.supported && terminated.alive === 0;
      return resource.closed;
    })();
    return resource.forceClosePromise;
  }
  async closeResource(resource, { force = false } = {}) {
    if (!resource?.close && !resource?.browser && !resource?.context) return true;
    if (resource.closed) return true;
    if (force) return this.forceCloseResource(resource);
    if (resource.closePromise) return resource.closePromise;
    resource.closePromise = (async () => {
      const timeoutMs = Math.max(1, Number(this.options.cleanupCloseTimeoutMs) || BROWSER_CLOSE_TIMEOUT_MS);
      const closed = await closeCloakHandles(resource, timeoutMs);
      if (closed || !browserStillConnected(resource?.browser)) {
        resource.closed = true;
        return true;
      }
      return this.forceCloseResource(resource);
    })();
    return resource.closePromise;
  }
  queueProfileCleanup(resource) {
    if (!resource?.cleanupProfile || !resource.closed) {
      try { resource?.profileRelease?.(); } catch {}
      if (resource) resource.profileRelease = null;
      return;
    }
    const cleanup = (async () => {
      let acquired = false;
      try {
        await this.profileCleanupSemaphore.acquire(1, { label: 'profile-cleanup' });
        acquired = true;
        await this.removePersistentProfile(resource.profile, resource.log);
      } finally {
        if (acquired) this.profileCleanupSemaphore.release(1);
        try { resource.profileRelease?.(); } catch {}
        resource.profileRelease = null;
      }
    })();
    this.profileCleanupPending.add(cleanup);
    cleanup.finally(() => this.profileCleanupPending.delete(cleanup)).catch(() => {});
  }
  async drainProfileCleanups() {
    while (this.profileCleanupPending.size) await Promise.allSettled([...this.profileCleanupPending]);
  }
  profileCleanupStats() { return { ...this.profileCleanupSemaphore.stats(), pending: this.profileCleanupPending.size }; }
  launchStats() { return this.launchSemaphore.stats(); }
  resourceCapacity(maxConcurrency = this.semaphore.limit) {
    const effective = Math.max(1, Number(maxConcurrency) || 1);
    const configured = Math.max(effective, Number(this.options.configuredMaxConcurrency) || effective);
    const resource = Math.max(1, Number(this.options.resourceMaxConcurrency) || Number(this.options.resourceConcurrency) || effective);
    return {
      configuredMaxConcurrency: configured,
      resourceMaxConcurrency: resource,
      resourceLimited: effective < configured,
      resourcePlan: { ...(this.options.resourcePlan || {}) },
    };
  }
  async acquireLaunchAdmission(task = {}) {
    while (true) {
      await this.waitForLicenseCapacity(task);
      await this.launchSemaphore.acquire(1, {
        label: String(task.kind || 'other'), activity: task.activity,
        cancelled: task.cancelled, onCancel: task.onCancel,
      });
      const licenseKey = await this.pickLicenseWithCapacity();
      if (this.licensePool.size() && !licenseKey) {
        this.launchSemaphore.release(1);
        this.noteLicenseCapacityLimit(task.log);
        continue;
      }
      if (Date.now() >= this.licenseCapacity.backoffUntil) {
        return this.#launchAdmissionTicket(task, licenseKey);
      }
      this.launchSemaphore.release(1);
    }
  }
  #launchAdmissionTicket(task, licenseKey) {
    let claimed = false;
    let released = false;
    let detachCancel = null;
    const release = () => {
      if (released) return;
      released = true;
      try { detachCancel?.(); } catch {}
      this.launchSemaphore.release(1);
    };
    if (typeof task.onCancel === 'function') detachCancel = task.onCancel(release);
    return {
      [LAUNCH_ADMISSION_OWNER]: this,
      licenseKey,
      claim: () => {
        if (claimed || released) return null;
        claimed = true;
        return release;
      },
      release,
    };
  }
  takeLaunchAdmission(admission) {
    if (!admission || admission[LAUNCH_ADMISSION_OWNER] !== this || typeof admission.claim !== 'function') return null;
    return admission.claim();
  }
  updateOptions(options = {}) {
    const clean = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
    this.options = { ...this.options, ...clean };
    this.licensePool.setKeys(parseLicenseKeys(this.options));
    this.semaphore.setLimit(this.options.maxConcurrency);
    this.launchSemaphore.setLimit(this.options.launchConcurrency);
    this.profileCleanupSemaphore.setLimit(this.options.profileCleanupConcurrency);
    return this.info();
  }
  slotStats() {
    const stats = this.semaphore.stats();
    const reservedByKind = {};
    for (const reservation of this.reservations.values()) {
      reservedByKind[reservation.kind] = (reservedByKind[reservation.kind] || 0) + reservation.slots;
    }
    return { ...stats, reservedByKind };
  }
  activity() {
    const now = Date.now();
    const safeActivity = value => ({
      jobId: String(value?.jobId || '').slice(0, 80),
      label: String(value?.label || '').slice(0, 160),
    });
    const slotStats = this.slotStats();
    return {
      ...slotStats,
      ...this.resourceCapacity(slotStats.maxSlots),
      launch: this.launchStats(),
      profile_cleanup: this.profileCleanupStats(),
      reservations: [...this.reservations.entries()].map(([id, reservation]) => ({
        id: id.slice(0, 8),
        kind: reservation.kind,
        slots: reservation.slots,
        startedAt: reservation.startedAt,
        runningMs: Math.max(0, now - reservation.startedAt),
        ...safeActivity(reservation.activity),
      })),
      queued: this.semaphore.waiters.map((waiter, index) => ({
        id: `queued-${index + 1}`,
        kind: waiter.label,
        slots: waiter.count,
        enqueuedAt: waiter.enqueuedAt,
        waitingMs: Math.max(0, now - waiter.enqueuedAt),
        ...safeActivity(waiter.activity),
      })),
    };
  }
  info() {
    let binary = null;
    try { binary = cloakModule?.binaryInfo?.() || { status: 'not_loaded' }; } catch (error) { binary = { error: error.message }; }
    const slotStats = this.slotStats();
    const launchStats = this.launchStats();
    return {
      engine: 'CloakBrowser', version: this.options.browserVersion || 'auto', binary,
      active: this.active.size, maxConcurrency: slotStats.maxSlots,
      reservedSlots: slotStats.reservedSlots, availableSlots: slotStats.availableSlots,
      queuedRequests: slotStats.queuedRequests, queuedSlots: slotStats.queuedSlots, slotStats,
      ...this.resourceCapacity(slotStats.maxSlots),
      launchConcurrency: launchStats.maxSlots, launching: launchStats.reservedSlots,
      launchQueued: launchStats.queuedRequests, launchStats,
      profileRoot: this.options.profileRoot, profileCleanup: this.profileCleanupStats(),
      headless: this.options.headless, timeoutMs: this.options.timeoutMs,
      locale: this.options.locale, timezone: this.options.timezone,
      releaseChannel: this.options.releaseChannel || 'stable',
      license: mask(this.licensePool.current() || this.options.licenseKey),
      licenseCount: this.licensePool.size(),
      externalTransport: 'browser-page-only',
      licenseCapacityBackoffMs: Math.max(0, this.licenseCapacity.backoffUntil - Date.now()),
      licenseCapacityFailures: this.licenseCapacity.consecutive,
      licenseRemoteActiveSessions: this.licenseCapacity.remoteActive,
      licenseMaxSessions: this.licenseCapacityOptions().maxSessions,
    };
  }
  async withSessions(tasks = [], handler) {
    const list = (Array.isArray(tasks) ? [...tasks] : [tasks]).map(task => ({ ...(task || {}) }));
    if (!list.length) throw new TypeError('CloakBrowser 会话组不能为空');
    if (typeof handler !== 'function') throw new TypeError('CloakBrowser 会话组缺少处理函数');
    const assertActive = task => {
      if (typeof task.cancelled === 'function' && task.cancelled()) {
        const error = new Error('任务已取消');
        error.code = 'JOB_CANCELLED';
        throw error;
      }
    };
    list.forEach(task => assertActive(task || {}));
    const cancelChecks = [...new Set(list.map(task => task.cancelled).filter(value => typeof value === 'function'))];
    const cancelHooks = [...new Set(list.map(task => task.onCancel).filter(value => typeof value === 'function'))];
    const kinds = [...new Set(list.map(task => String(task.kind || 'other')))];
    const reservationKind = kinds.length === 1 ? kinds[0] : 'mixed';
    const reservationActivity = list.find(task => task.activity)?.activity || null;
    const reservationId = crypto.randomUUID();
    const reserved = await this.semaphore.acquire(list.length, {
      label: reservationKind,
      activity: reservationActivity,
      cancelled: () => cancelChecks.some(check => check()),
      onCancel: handler => {
        const detachers = cancelHooks.map(subscribe => subscribe(handler));
        return () => {
          for (const detach of detachers) {
            try { detach?.(); } catch {}
          }
        };
      },
    });
    this.reservations.set(reservationId, { kind: reservationKind, slots: reserved, startedAt: Date.now(), activity: reservationActivity });
    const resources = [];
    let sessionFailed = false;
    let watchdogExpired = false;
    try {
      list.forEach(task => assertActive(task));
      for (const rawTask of list) {
        const task = rawTask || {};
        const id = crypto.randomUUID();
        const role = String(task.role || '').trim();
        const log = (message, level = 'info') => {
          const tagged = role ? `[${role}] ${message}` : message;
          if (task.log) task.log(tagged, level);
          else this.eventLog?.push(level, tagged, `cloak:${id.slice(0, 8)}`);
        };
        const taskOptions = Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined));
        const options = { ...this.options, ...taskOptions, proxy: proxyLaunchConfig(task.proxy, task.proxyBypass) };
        const profile = persistentProfile(task.profileKey, role, task.proxy, options.profileRoot);
        const resource = {
          id, role, log, browser: null, context: null, close: null, profile,
          cleanupProfile: task.cleanupProfile === true && Boolean(profile),
          closed: false, profileRelease: null, detachCancel: null, session: null,
          fingerprint: null, sessionReadyCleanup: null, launchRelease: null,
          forceClosePromise: null, launchReleaseTimer: null, launchAdmissionHoldMs: 0,
          launchLicenseKey: '',
        };
        resources.push(resource);
        resource.detachCancel = typeof task.onCancel === 'function' ? task.onCancel(() => {
          if (!resource.close && !resource.browser && !resource.context) return;
          try { return this.closeResource(resource).catch(() => {}); } catch { return undefined; }
        }) : null;
        assertActive(task);
        // With a proxy, let Cloak derive locale/timezone/geolocation together
        // from the exit IP. A fixed en-US locale paired with a GB/JP timezone is
        // an avoidable cross-surface fingerprint inconsistency.
        const useProxyGeo = Boolean(options.proxy) && options.geoip !== false;
        const launchOptions = {
          headless: options.headless,
          geoip: options.geoip !== false,
          humanize: options.humanize !== false,
          humanPreset: options.humanPreset || 'careful',
          locale: useProxyGeo ? undefined : options.locale,
          timezone: useProxyGeo ? undefined : options.timezone,
        };
        if (options.proxy) launchOptions.proxy = options.proxy;
        if (options.licenseKey) launchOptions.licenseKey = options.licenseKey;
        if (options.browserVersion) { launchOptions.browserVersion = options.browserVersion; launchOptions.releaseChannel = options.releaseChannel || 'stable'; }
        const args = [];
        if (profile) args.push(`--fingerprint=${profile.seed}`);
        if (options.allowThirdPartyCookies === true) args.push('--fingerprint-allow-3p-cookies');
        if (args.length) launchOptions.args = args;
        const bypassLabel = typeof options.proxy === 'object' && options.proxy?.bypass ? `，直连=${options.proxy.bypass}` : '';
        log(`启动 CloakBrowser（headless=${launchOptions.headless}，humanize=${launchOptions.humanize}，proxy=${options.proxy ? 'on' : 'off'}${profile ? '，profile=persistent' : ''}${bypassLabel}）`);
        resource.profileRelease = await this.acquireProfile(profile, task);
        const { attempts: licenseAttempts, baseDelayMs } = this.licenseCapacityOptions(options);
        const maxLicenseAttempts = Math.max(licenseAttempts, licenseAttempts * Math.max(1, this.licensePool.size()));
        if (!resource.launchLicenseKey && task.launchAdmission?.licenseKey) {
          resource.launchLicenseKey = task.launchAdmission.licenseKey;
        }
        for (let launchAttempt = 1; ; launchAttempt += 1) {
          await this.waitForLicenseCapacity(task);
          resource.launchRelease = this.takeLaunchAdmission(task.launchAdmission);
          if (!resource.launchRelease) {
            const admission = await this.acquireLaunchAdmission({
              kind: task.kind, activity: task.activity, cancelled: task.cancelled,
              onCancel: task.onCancel, log,
            });
            resource.launchRelease = admission.claim();
            if (admission.licenseKey && !resource.launchLicenseKey) {
              resource.launchLicenseKey = admission.licenseKey;
            }
          }
          const usedKey = resource.launchLicenseKey
            || this.licensePool.pick()
            || options.licenseKey
            || '';
          resource.launchLicenseKey = '';
          if (usedKey) launchOptions.licenseKey = usedKey;
          else delete launchOptions.licenseKey;
          try {
            if (profile) {
              resource.context = await this.launchPersistentContext({ ...launchOptions, userDataDir: profile.userDataDir });
              resource.browser = typeof resource.context.browser === 'function' ? resource.context.browser() : resource.context;
            } else {
              resource.browser = await this.launchBrowser(launchOptions);
            }
            resource.close = () => closeCloakHandles(resource);
            this.licensePool.advance();
            break;
          } catch (error) {
            resource.launchRelease?.();
            resource.launchRelease = null;
            if (stableCloakErrorCode(error) !== 'CLOAK_LICENSE_SESSION_LIMIT' || launchAttempt >= maxLicenseAttempts) throw error;
            this.licensePool.markExhausted(usedKey, this.licenseCapacity.delayMs || baseDelayMs);
            const nextKey = this.licensePool.nextAvailable(usedKey);
            if (resource.cleanupProfile) await this.removePersistentProfile(resource.profile, resource.log);
            if (nextKey) {
              resource.launchLicenseKey = nextKey;
              log(`许可证 ${mask(usedKey)} 席位暂满，改用授权 ${mask(nextKey)}`, 'warn');
              continue;
            }
            const waitMs = this.noteLicenseCapacityLimit(log);
            log(`许可证席位暂满，第 ${launchAttempt}/${maxLicenseAttempts} 次冷启动未获准；约 ${Math.ceil(waitMs / 1000)} 秒后自动重试，不跳过本任务`, 'warn');
          }
        }
        assertActive(task);
        resource.startedAt = Date.now();
        resource.activity = task.activity || reservationActivity || null;
        this.active.set(id, resource);
        let page;
        try {
          if (profile) {
            page = resource.context.pages?.()[0] || await resource.context.newPage();
          } else if (typeof resource.browser.newContext === 'function') {
            resource.context = await resource.browser.newContext();
            page = await resource.context.newPage();
          } else {
            page = await resource.browser.newPage();
            resource.context = typeof page.context === 'function' ? page.context() : null;
          }
        } catch (error) {
          await this.closeResource(resource);
          this.active.delete(id);
          resource.browser = null;
          throw error;
        }
        assertActive(task);
        page.setDefaultTimeout(options.timeoutMs);
        page.setDefaultNavigationTimeout(options.timeoutMs);
        resource.session = new CloakSession(resource.browser, page, options, log);
        await resource.session.goto('about:blank').catch(() => {});
        assertActive(task);
        resource.fingerprint = await resource.session.fingerprint();
        assertActive(task);
        if (typeof task.onSessionReady === 'function') {
          resource.sessionReadyCleanup = await task.onSessionReady(resource.session, resource.fingerprint);
          assertActive(task);
        }
        log(`CloakBrowser 会话就绪，fingerprint=${resource.fingerprint.id}`, 'ok');
        this.noteLicenseCapacitySuccess();
        resource.launchAdmissionHoldMs = Math.max(0, Math.min(15000, Number(task.launchAdmissionHoldMs) || 0));
        if (!resource.launchAdmissionHoldMs) {
          resource.launchRelease?.();
          resource.launchRelease = null;
        }
      }
      const handlerPromise = Promise.resolve().then(() => handler(
        resources.map(resource => resource.session),
        resources.map(resource => resource.fingerprint),
      ));
      for (const resource of resources) {
        if (!resource.launchRelease || !resource.launchAdmissionHoldMs) continue;
        resource.launchReleaseTimer = setTimeout(() => {
          resource.launchRelease?.();
          resource.launchRelease = null;
          resource.launchReleaseTimer = null;
        }, resource.launchAdmissionHoldMs);
      }
      const timeoutValues = list
        .map(task => Number(task?.sessionWallTimeoutMs))
        .filter(value => Number.isFinite(value) && value > 0);
      if (!timeoutValues.length) return await handlerPromise;
      const sessionWallTimeoutMs = Math.max(1, Math.min(...timeoutValues));
      let watchdogTimer;
      const watchdogPromise = new Promise((resolve, reject) => {
        watchdogTimer = setTimeout(() => {
          watchdogExpired = true;
          const error = new Error(`CloakBrowser 会话超过硬时限 (${sessionWallTimeoutMs}ms)，将按 context.close / browser.close 回收浏览器与并发槽`);
          error.code = 'CLOAK_SESSION_WALL_TIMEOUT';
          error.timeout_ms = sessionWallTimeoutMs;
          reject(error);
        }, sessionWallTimeoutMs);
      });
      try {
        return await Promise.race([handlerPromise, watchdogPromise]);
      } finally {
        clearTimeout(watchdogTimer);
      }
    } catch (error) {
      sessionFailed = true;
      if (stableCloakErrorCode(error) === 'CLOAK_LICENSE_SESSION_LIMIT') this.noteLicenseCapacityLimit();
      throw error;
    } finally {
      for (const resource of resources) {
        if (resource.launchReleaseTimer) clearTimeout(resource.launchReleaseTimer);
        resource.launchReleaseTimer = null;
        try { resource.detachCancel?.(); } catch {}
        try { resource.launchRelease?.(); } catch {}
        resource.launchRelease = null;
      }
      const closeResults = await Promise.allSettled(resources.map(async resource => {
        try { await resource.session?.closeExtraPages?.(); } catch {}
        if (!resource.close && !resource.browser && !resource.context) return false;
        return this.closeResource(resource, { force: watchdogExpired });
      }));
      if (closeResults.some(result => result.status === 'fulfilled' && result.value === true)) {
        this.noteLicenseSessionClosed();
      }
      await Promise.allSettled(resources.map(async resource => {
        try {
          if (typeof resource.sessionReadyCleanup === 'function') await resource.sessionReadyCleanup();
          else await resource.sessionReadyCleanup?.release?.();
        } catch {}
      }));
      for (const resource of resources) this.active.delete(resource.id);
      this.reservations.delete(reservationId);
      this.semaphore.release(reserved);
      for (const resource of resources) this.queueProfileCleanup(resource);
      for (const resource of resources) resource.log('CloakBrowser 会话已销毁', 'debug');
    }
  }
  async withSession(task = {}, handler) {
    return this.withSessions([task], ([session], [fingerprint]) => handler(session, fingerprint));
  }
  async request(url, options = {}, task = {}) { return this.withSession(task, session => session.request(url, options)); }
  async smoke(task = {}) { return this.withSession(task, async (_session, fingerprint) => ({ ok: fingerprint.webdriver !== true && Boolean(fingerprint.ua), fingerprint, runtime: this.info() })); }
  async closeAll() {
    const active = [...this.active.values()];
    await Promise.allSettled(active.map(async resource => {
      const closed = await this.closeResource(resource).catch(() => false);
      if (resource.cleanupProfile && closed) {
        await this.removePersistentProfile(resource.profile, resource.log).catch(() => {});
      }
      try { resource.profileRelease?.(); } catch {}
      this.active.delete(resource.id);
    }));
    await this.drainProfileCleanups();
    LIVE_RUNTIMES.delete(this);
  }
  async closeByJobIds(jobIds, { timeoutMs = 20000 } = {}) {
    const wanted = new Set((jobIds || []).map(value => String(value || '')).filter(Boolean));
    if (!wanted.size) return { closed: true, active: 0, reservations: 0 };
    const belongs = value => wanted.has(String(value?.activity?.jobId || ''));
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 20000);
    do {
      const active = [...this.active.values()].filter(belongs);
      if (active.length) await Promise.allSettled(active.map(resource => this.closeResource(resource)));
      const activeCount = [...this.active.values()].filter(belongs).length;
      const reservationCount = [...this.reservations.values()].filter(belongs).length;
      if (!activeCount && !reservationCount) return { closed: true, active: 0, reservations: 0 };
      await sleep(50);
    } while (Date.now() < deadline);
    return {
      closed: false,
      active: [...this.active.values()].filter(belongs).length,
      reservations: [...this.reservations.values()].filter(belongs).length,
    };
  }
}

function stableCloakErrorCode(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'JOB_CANCELLED' || code.startsWith('CLOAK_')) return code;
  const exitCode = Number(message.match(/(?:process did exit:\s*exitCode=|exited with (?:exit )?code )(\d+)/i)?.[1] || 0);
  if (exitCode === 76) return 'CLOAK_LICENSE_SESSION_LIMIT';
  if (exitCode === 77) return 'CLOAK_LICENSE_INVALID';
  if (exitCode === 78) return 'CLOAK_LICENSE_UNAVAILABLE';
  if (exitCode === 79) return 'CLOAK_LICENSE_LOCAL_CONFIG';
  if (/license.*(?:invalid|expired|key)/i.test(message)) return 'CLOAK_LICENSE_INVALID';
  if (/session.*limit|too many.*session|active.*session.*(?:limit|exceed)/i.test(message)) return 'CLOAK_LICENSE_SESSION_LIMIT';
  if (/browser.*(?:closed|disconnect)|target page.*closed/i.test(message)) return 'CLOAK_BROWSER_DISCONNECTED';
  if (/crash/i.test(message)) return 'CLOAK_BROWSER_CRASHED';
  if (/timeout|timed out/i.test(message)) return 'PROTOCOL_REQUEST_TIMEOUT';
  return 'CLOAK_ERROR';
}

exports.closeAllRuntimes = closeAllRuntimes;
exports.closeCloakHandles = closeCloakHandles;
exports.closePlaywrightBrowser = closePlaywrightBrowser;
exports.parseLicenseKeys = parseLicenseKeys;
exports.Semaphore = Semaphore;
exports.proxyUrl = proxyUrl;
exports.proxyLaunchConfig = proxyLaunchConfig;
exports.persistentProfile = persistentProfile;
exports.CloakSession = CloakSession;
exports.CloakRuntime = CloakRuntime;
exports.stableCloakErrorCode = stableCloakErrorCode;
