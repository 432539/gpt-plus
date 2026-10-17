'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  playwrightNeedsHttpBridge,
  startPlaywrightProxyBridge,
} = require('./playwrightProxyBridge');
const {
  parseCheckoutVerifyUrl,
  parseGcashAuthPage,
  isGcashRpcUrl,
  hostnameOf,
  isGcashAuthPage,
  isAdyenPaymentReturnUrl,
  extractRedirectResult,
} = require('./gcashProtocol');

const FIXTURE_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAG/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z';

function isAdyenCheckoutshopper(url) {
  return /checkoutshopper-live\.adyen\.com/i.test(String(url || ''));
}

function isChatgptHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
}

function isGcashCheckoutSuccessUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    const host = parsed.hostname.toLowerCase();
    if (!isChatgptHost(host)) return false;
    if (/\/payments\/success/i.test(parsed.pathname)) return true;
    return parsed.searchParams.get('reason') === 'checkout_success';
  } catch {
    return false;
  }
}

function safeH5HostPath(url) {
  try {
    const parsed = new URL(String(url || ''));
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function playwrightCookiesFromEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((item) => {
      const name = String(item?.name || '').trim();
      const value = String(item?.value || '');
      if (!name || !value) return null;
      const domain = String(item.domain || 'chatgpt.com').trim().toLowerCase();
      if (!isChatgptHost(domain.replace(/^\./, ''))) return null;
      const cookie = {
        name,
        value,
        domain,
        path: String(item.path || '/'),
        secure: item.secure == null ? true : Boolean(item.secure),
      };
      const expires = Number(item.expires);
      if (Number.isFinite(expires) && expires > 0) cookie.expires = Math.floor(expires);
      const sameSite = String(item.sameSite || item.same_site || '').toLowerCase();
      if (sameSite === 'strict') cookie.sameSite = 'Strict';
      if (sameSite === 'lax') cookie.sameSite = 'Lax';
      if (sameSite === 'none') cookie.sameSite = 'None';
      return cookie;
    })
    .filter(Boolean);
}

function chatgptSessionPayload(accessToken, accountId = '') {
  let claims = {};
  try {
    const part = String(accessToken || '').split('.')[1] || '';
    claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    claims = {};
  }
  const profile = claims['https://api.openai.com/profile'] && typeof claims['https://api.openai.com/profile'] === 'object'
    ? claims['https://api.openai.com/profile']
    : {};
  const auth = claims['https://api.openai.com/auth'] && typeof claims['https://api.openai.com/auth'] === 'object'
    ? claims['https://api.openai.com/auth']
    : {};
  const expiresAt = Number(claims.exp) || Math.floor(Date.now() / 1000) + 3600;
  return {
    user: {
      id: String(auth.chatgpt_user_id || auth.user_id || claims.sub || '').trim(),
      name: String(profile.name || '').trim(),
      email: String(profile.email || '').trim(),
      idp: 'openai',
      iat: Number(claims.iat) || 0,
      amr: Array.isArray(auth.amr) ? auth.amr : [],
      mfa: false,
    },
    expires: new Date(expiresAt * 1000).toISOString(),
    account: {
      id: String(accountId || auth.chatgpt_account_id || '').trim(),
      planType: String(auth.chatgpt_plan_type || 'free').trim().toLowerCase() || 'free',
      structure: 'personal',
      isDelinquent: false,
      residencyRegion: 'no_constraint',
      computeResidency: String(auth.chatgpt_compute_residency || 'no_constraint'),
    },
    accessToken: String(accessToken || '').trim(),
    authProvider: 'openai',
  };
}

function chatgptIdentityHeaders(url, headers, identity = {}) {
  const next = { ...(headers || {}) };
  const hasHeader = (name) => Object.keys(next)
    .some((key) => String(key).toLowerCase() === String(name).toLowerCase());
  const addIfMissing = (name, value) => {
    if (value && !hasHeader(name)) next[name] = value;
  };
  let host = '';
  let pathname = '/';
  try {
    const parsed = new URL(String(url || ''));
    host = parsed.hostname;
    pathname = parsed.pathname || '/';
  } catch {
    return next;
  }
  if (!isChatgptHost(host)) return headers || {};
  const path = pathname.toLowerCase();
  if (!(path === '/' || path.startsWith('/checkout/') || path.startsWith('/backend-api/') || path.startsWith('/api/auth/') || path.startsWith('/payments/'))) {
    return next;
  }
  const token = String(identity.accessToken || '').trim();
  const accountId = String(identity.accountId || '').trim();
  const deviceId = String(identity.deviceId || '').trim();
  const sessionId = String(identity.sessionId || '').trim();
  addIfMissing('authorization', token ? `Bearer ${token}` : '');
  addIfMissing('chatgpt-account-id', accountId);
  addIfMissing('oai-device-id', deviceId);
  addIfMissing('oai-session-id', sessionId);
  return next;
}

function writeGcashQrImage(qr, dest) {
  const text = String(qr || '').trim();
  const file = String(dest || '').trim();
  if (!text || !file || !/^data:image\//i.test(text)) return '';
  const match = text.match(/^data:image\/([\w+.-]+);base64,(.+)$/i);
  if (!match) return '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(match[2], 'base64'));
  return file;
}

async function playwrightRequestHeaders(request) {
  if (typeof request?.allHeaders === 'function') {
    try {
      const all = await request.allHeaders();
      if (all && typeof all === 'object') return all;
    } catch { /* fall through to headers() */ }
  }
  try {
    return request.headers?.() || {};
  } catch {
    return {};
  }
}

async function installChatgptIdentity(context, identity, emit) {
  const token = String(identity?.accessToken || '').trim();
  if (!context?.route || !token) return false;
  const body = JSON.stringify(chatgptSessionPayload(token, identity.accountId));
  const handler = async (route) => {
    const request = route.request();
    const url = String(request.url() || '');
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch { pathname = ''; }
    const nativeHeaders = await playwrightRequestHeaders(request);
    if (pathname === '/api/auth/session' && String(request.method() || '').toUpperCase() === 'GET') {
      const headers = chatgptIdentityHeaders(url, nativeHeaders, identity);
      if (typeof route.fetch === 'function') {
        try {
          const native = await route.fetch({ headers });
          const nativeText = await native.text();
          let nativePayload;
          try { nativePayload = JSON.parse(nativeText); } catch { nativePayload = null; }
          if (Number(native.status?.() || 0) < 400 && nativePayload?.accessToken) {
            await route.fulfill({ response: native, body: nativeText });
            return;
          }
        } catch {
          /* access-token fallback below */
        }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body,
      });
      return;
    }
    const headers = chatgptIdentityHeaders(url, nativeHeaders, identity);
    await route.continue({ headers });
  };
  await context.route('https://chatgpt.com/**', handler);
  await context.route('https://*.chatgpt.com/**', handler);
  emit?.('qr', 'Playwright 已挂上 ChatGPT 登录态（cookie + session），回跳才能 continue 到账。');
  return true;
}

async function bootstrapChatgptIdentity(page, emit) {
  if (!page?.goto) return false;
  try {
    const response = await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const http = Number(response?.status?.() || response?.status || 0);
    if (http >= 400) {
      emit?.('qr', `ChatGPT 登录页 HTTP ${http}，仍打开 GCash，但回跳可能缺登录态。`);
      return false;
    }
    const probe = await page.evaluate(async () => {
      let sessionStatus = 0;
      let sessionAuthenticated = false;
      const backendStatuses = [];
      try {
        const res = await fetch('/api/auth/session', { cache: 'no-store', credentials: 'include' });
        sessionStatus = res.status;
        const payload = await res.json();
        sessionAuthenticated = Boolean(payload && payload.accessToken);
      } catch {
        sessionStatus = 0;
      }
      if (sessionAuthenticated) {
        for (const path of ['/backend-api/accounts', '/backend-api/me']) {
          try {
            const res = await fetch(path, { cache: 'no-store', credentials: 'include' });
            backendStatuses.push(res.status);
          } catch {
            backendStatuses.push(0);
          }
        }
      }
      return { sessionStatus, sessionAuthenticated, backendStatuses };
    });
    const backendReady = (probe?.backendStatuses || []).some((status) => status >= 200 && status < 300);
    if (!probe?.sessionAuthenticated || !backendReady) {
      emit?.(
        'qr',
        `ChatGPT 无头登录态未就绪（session HTTP ${probe?.sessionStatus || 0}，backend=[${(probe?.backendStatuses || []).join(',')}]）。`,
      );
      return false;
    }
    emit?.('qr', 'ChatGPT 无头登录态已验证，正在打开 Adyen/GCash 页面。');
    return true;
  } catch (error) {
    emit?.('qr', `ChatGPT 登录态预热失败：${String(error?.message || error).slice(0, 160)}。仍打开 GCash。`);
    return false;
  }
}

function gcashH5PageUrl(h5) {
  if (typeof h5?.currentUrl === 'function') {
    try { return String(h5.currentUrl() || '').trim(); } catch { return ''; }
  }
  try {
    return String(h5?.page?.url?.() || '').trim();
  } catch {
    return '';
  }
}

function h5UrlKind(url) {
  const text = String(url || '').trim();
  if (!text) return 'empty';
  if (parseCheckoutVerifyUrl(text)) return 'verify';
  if (isGcashCheckoutSuccessUrl(text)) return 'success';
  if (isGcashAuthPage(text)) return 'gcash_auth';
  if (isAdyenPaymentReturnUrl(text)) return 'adyen_return';
  if (isAdyenCheckoutshopper(text) || /checkoutPaymentRedirect/i.test(text)) return 'adyen_redirect';
  if (isChatgptHost(hostnameOf(text))) return 'chatgpt';
  if (/gcash\.com/i.test(text)) return 'gcash_other';
  return 'other';
}

function gcashH5CallbackFromUrl(url) {
  const target = String(url || '').trim();
  if (!target) return null;
  const verify = parseCheckoutVerifyUrl(target);
  if (verify) return { kind: 'verify', url: target, ...verify };
  if (isGcashCheckoutSuccessUrl(target)) return { kind: 'success', url: target, verifyUrl: target };
  const kind = h5UrlKind(target);
  if (kind === 'adyen_return' || kind === 'adyen_redirect') {
    return { kind: 'adyen', url: target, redirectResult: extractRedirectResult(target) };
  }
  if (kind !== 'gcash_auth' && extractRedirectResult(target)) {
    return { kind: 'adyen', url: target, redirectResult: extractRedirectResult(target) };
  }
  return null;
}

function h5LeftGcashAuth(h5) {
  if (!isParkedH5Alive(h5)) return false;
  const url = gcashH5PageUrl(h5);
  if (!/^https?:\/\//i.test(url)) return false;
  return h5UrlKind(url) !== 'gcash_auth';
}

const h5DebugDumps = new Map();

function gcashPayDebugEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.GCASH_PAY_DEBUG || ''));
}

async function dumpGcashH5Debug(h5, opts = {}) {
  if (!gcashPayDebugEnabled()) return;
  const id = String(opts.id || 'unknown');
  const now = Date.now();
  if (now - Number(h5DebugDumps.get(id) || 0) < 60_000) return;
  h5DebugDumps.set(id, now);
  const dir = path.join(__dirname, '..', '..', '..', 'debug', 'gcash-h5');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
  const url = gcashH5PageUrl(h5);
  const kind = h5UrlKind(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(dir, `${id}-${kind}-${stamp}`);
  try {
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({
      id,
      kind,
      hostPath: safeH5HostPath(url),
      hasRedirectResult: Boolean(extractRedirectResult(url)),
      title: '',
    }, null, 2)}\n`);
  } catch { /* ignore */ }
  try {
    const shot = h5?.page?.screenshot;
    if (typeof shot === 'function') {
      await shot.call(h5.page, { path: `${base}.png`, timeout: 5000 });
    }
  } catch { /* ignore */ }
  try {
    const title = await h5?.page?.title?.();
    const metaPath = `${base}.json`;
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      meta.title = String(title || '').slice(0, 80);
      fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    }
  } catch { /* ignore */ }
}

async function ingestH5ScanProgress(h5, emit, opts = {}) {
  if (!isParkedH5Alive(h5)) return { kind: 'empty' };
  const url = gcashH5PageUrl(h5);
  const kind = h5UrlKind(url);
  if (extractRedirectResult(url)) {
    h5.scanComplete = true;
    h5.scanRedirectUrl = h5.scanRedirectUrl || url;
    emit?.('pay', `H5 URL 已出现扫码回跳标记 kind=${kind}，等待页面自行回跳`);
    await dumpGcashH5Debug(h5, opts);
    return { kind, hasRedirect: true, source: 'url' };
  }
  if (kind !== 'gcash_auth' && kind !== 'empty') {
    h5.scanComplete = true;
    emit?.('pay', `H5 已离开 GCash 授权页 kind=${kind}，按已扫码处理，等待页面自行回跳`);
    await dumpGcashH5Debug(h5, opts);
    return { kind, leftAuth: true };
  }
  try {
    const html = typeof h5.page?.content === 'function' ? await h5.page.content() : '';
    if (extractRedirectResult(html)) {
      h5.scanComplete = true;
      emit?.('pay', 'H5 DOM 已出现扫码回跳标记，等待页面自行回跳');
      await dumpGcashH5Debug(h5, opts);
      return { kind, hasRedirect: true, source: 'dom' };
    }
  } catch {
    /* keep waiting */
  }
  return { kind };
}

function readGcashH5Callback(h5) {
  if (h5?.callback?.kind) return { ...h5.callback };
  const url = gcashH5PageUrl(h5);
  return gcashH5CallbackFromUrl(url);
}

function isParkedH5Alive(h5) {
  if (!h5 || h5._closed) return false;
  try {
    if (typeof h5.browser?.isConnected === 'function' && !h5.browser.isConnected()) return false;
  } catch {
    return false;
  }
  try {
    if (h5.page?.url) {
      h5.page.url();
      return true;
    }
  } catch {
    return false;
  }
  return typeof h5.currentUrl === 'function' || Boolean(h5.page);
}

function ingestGcashH5Rpc(h5, raw) {
  if (!h5) return h5;
  const {
    rememberConsultSession,
    isGcashScanComplete,
    scanRedirectUrl,
  } = require('./gcashProtocol');
  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return h5;
    try { data = JSON.parse(text); } catch { return h5; }
  }
  if (data == null) return h5;
  rememberConsultSession(h5, data);
  if (isGcashScanComplete(data)) {
    h5.scanComplete = true;
    const redirect = scanRedirectUrl(data);
    if (redirect) h5.scanRedirectUrl = redirect;
  }
  return h5;
}

async function followScanRedirectInPage(h5, redirectUrl, emit, opts = {}) {
  const existing = readGcashH5Callback(h5);
  if (existing?.kind === 'success' || existing?.kind === 'verify') return existing;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs))
    ? Math.max(0, Number(opts.timeoutMs))
    : 8000;
  emit?.('pay', '扫码已完成，等待同一 Playwright 页自行回跳 /checkout/verify，不抢先打开 Adyen return');
  if (timeoutMs === 0) return existing || null;
  const deadline = Date.now() + timeoutMs;
  let last = readGcashH5Callback(h5);
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    last = readGcashH5Callback(h5);
  }
  return last;
}

async function submitGcashContinueInPage(h5, built, emit) {
  if (typeof h5?.retryFailedContinue !== 'function') {
    return { ok: false, skipped: true, status: 0 };
  }
  const result = await h5.retryFailedContinue();
  if (result?.ok) emit?.('pay', '同一页面已原样重试瞬断的真实 continue 请求并成功');
  else if (!result?.skipped) {
    emit?.(
      'pay',
      `真实continue重试失败：HTTP ${Number(result?.status) || 0} keys=[${(result?.body_keys || []).join(',')}] code=${result?.error_code || '无'}`,
    );
  }
  return result || { ok: false, skipped: true, status: 0 };
}

async function waitForGcashH5Callback(h5, opts = {}) {
  const timeoutMs = Math.max(0, Number(opts.timeoutMs ?? 12000));
  const deadline = Date.now() + timeoutMs;
  let last = readGcashH5Callback(h5);
  if (last?.kind === 'success' || timeoutMs === 0) return last;
  while (Date.now() < deadline) {
    if (last?.kind === 'verify' && !h5?.browserContinueSeen) {
      try { await h5?.recoverVerify?.(); } catch { /* keep waiting */ }
      try { await h5?.retryFailedContinue?.(); } catch { /* keep waiting */ }
    }
    last = readGcashH5Callback(h5);
    if (last?.kind === 'success') return last;
    if (h5?.browserContinueSeen && last?.kind === 'verify') return { ...last, browserContinueSeen: true };
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  last = readGcashH5Callback(h5);
  if (h5?.browserContinueSeen && last) return { ...last, browserContinueSeen: true };
  return last;
}

async function closeGcashH5(h5) {
  if (!h5 || h5._closed) return true;
  if (typeof h5.close === 'function') {
    await Promise.race([
      h5.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    h5._closed = true;
    return true;
  }
  h5._closed = true;
  try { await h5.browser?.close?.(); } catch { /* ignore */ }
  try { await h5.bridge?.close?.(); } catch { /* ignore */ }
  return true;
}

function safeContinueErrorCode(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const error = data.error;
  return String(
    (error && typeof error === 'object' ? error.code || error.type : '')
    || data.code
    || data.error_code
    || data.type
    || (typeof error === 'string' ? error : '')
    || '',
  ).replace(/redirectResult=[^&\s]+/gi, 'redirectResult=*').slice(0, 80);
}

function replayableContinueHeaders(headers) {
  const blocked = /^(?::|host$|cookie$|content-length$|origin$|referer$|sec-|proxy-|connection$)/i;
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!blocked.test(String(name)) && value != null) out[name] = String(value);
  }
  return out;
}

function attachH5Handle(browser, context, page, bridge, emit) {
  const handle = {
    browser,
    context,
    page,
    bridge,
    _closed: false,
    browserContinueSeen: false,
    browserContinueRequested: false,
    browserContinueHttp: 0,
    browserContinueError: null,
    browserContinueDetailPromise: null,
    failedContinueRequest: null,
    continueReplayAttempted: false,
    consoleErrorCount: 0,
    pageErrorCount: 0,
    lastHostPath: '',
    consultUuid: '',
    tokenId: '',
    scanComplete: false,
    scanRedirectUrl: '',
    callback: null,
    callbackPage: null,
    pages: new Set(),
    verifyRecoveryAttempts: 0,
    currentUrl() {
      if (handle.callback?.url) return handle.callback.url;
      try {
        const callbackUrl = String(handle.callbackPage?.url?.() || '');
        if (callbackUrl) return callbackUrl;
      } catch { /* ignore */ }
      try { return String(page?.url() || ''); } catch { return ''; }
    },
    async followReturn(redirectUrl) {
      const target = String(redirectUrl || '').trim();
      if (!target || !/^https?:\/\//i.test(target)) return false;
      const targetPage = handle.callbackPage || handle.page;
      if (!targetPage?.goto) return false;
      await targetPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
      try { rememberUrl(String(targetPage.url?.() || target), targetPage); } catch { /* ignore */ }
      return true;
    },
    async recoverVerify() {
      if (handle.callback?.kind !== 'verify' || handle.verifyRecoveryAttempts >= 2) return false;
      const targetPage = handle.callbackPage || [...handle.pages].reverse().find((item) => {
        try { return isChatgptHost(new URL(String(item?.url?.() || '')).hostname); } catch { return false; }
      }) || page;
      let current = '';
      try { current = String(targetPage?.url?.() || ''); } catch { current = ''; }
      if (gcashH5CallbackFromUrl(current)) return false;
      let parsed;
      try { parsed = new URL(current); } catch { return false; }
      if (!isChatgptHost(parsed.hostname) || !/^\/(?:$|login\/?$)/i.test(parsed.pathname)) return false;
      handle.verifyRecoveryAttempts += 1;
      try {
        await targetPage.goto(handle.callback.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        return true;
      } catch {
        return false;
      }
    },
    async retryFailedContinue() {
      const saved = handle.failedContinueRequest;
      if (!saved || handle.continueReplayAttempted) {
        return { ok: false, skipped: true, status: 0 };
      }
      const sourcePage = saved.page;
      if (!sourcePage?.evaluate || !handle.pages.has(sourcePage)) {
        return { ok: false, skipped: true, status: 0 };
      }
      let current = '';
      try { current = String(sourcePage.url?.() || ''); } catch { current = ''; }
      if (!isChatgptHost(hostnameOf(current)) || !parseCheckoutVerifyUrl(current)) {
        return { ok: false, skipped: true, status: 0 };
      }
      handle.continueReplayAttempted = true;
      try {
        const result = await sourcePage.evaluate(async ({ url, method, headers, body }) => {
          const response = await fetch(url, {
            method,
            credentials: 'include',
            headers,
            body,
          });
          let keys = [];
          let errorCode = '';
          try {
            const data = await response.clone().json();
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              keys = Object.keys(data);
              const error = data.error;
              errorCode = String(
                (error && typeof error === 'object' ? error.code || error.type : '')
                || data.code
                || data.error_code
                || data.type
                || (typeof error === 'string' ? error : '')
                || '',
              ).slice(0, 80);
            }
          } catch {
            /* non-JSON response */
          }
          return { status: response.status, keys, errorCode };
        }, {
          url: saved.url,
          method: saved.method,
          headers: replayableContinueHeaders(saved.headers),
          body: saved.body,
        });
        const status = Number(result?.status) || 0;
        const bodyKeys = Array.isArray(result?.keys) ? result.keys.filter((key) => typeof key === 'string') : [];
        const errorCode = String(result?.errorCode || '')
          .replace(/redirectResult=[^&\s]+/gi, 'redirectResult=*')
          .slice(0, 80);
        handle.browserContinueSeen = true;
        handle.browserContinueHttp = status;
        handle.browserContinueError = status >= 400
          ? { status, body_keys: bodyKeys, error_code: errorCode }
          : null;
        return {
          ok: status > 0 && status < 400,
          status,
          body_keys: bodyKeys,
          error_code: errorCode,
          via: 'native-request-replay',
        };
      } catch {
        return { ok: false, status: 0, body_keys: [], error_code: 'network_error', via: 'native-request-replay' };
      }
    },
    async verifyDiagnostics() {
      const sourcePage = handle.callbackPage || handle.page;
      let current = '';
      try { current = String(sourcePage?.url?.() || ''); } catch { current = ''; }
      let dom = {};
      try {
        dom = await sourcePage.evaluate(() => ({
          ready_state: String(document.readyState || ''),
          script_count: document.scripts?.length || 0,
          has_app_root: Boolean(document.querySelector('#__next, main, [data-testid]')),
        }));
      } catch {
        dom = {};
      }
      return {
        url_kind: parseCheckoutVerifyUrl(current)
          ? 'verify'
          : (isGcashCheckoutSuccessUrl(current) ? 'success' : (isChatgptHost(hostnameOf(current)) ? 'chatgpt-other' : 'external')),
        ready_state: String(dom.ready_state || ''),
        script_count: Number(dom.script_count || 0),
        has_app_root: Boolean(dom.has_app_root),
        console_errors: handle.consoleErrorCount,
        page_errors: handle.pageErrorCount,
      };
    },
    async close() {
      if (handle._closed) return;
      handle._closed = true;
      try { await browser?.close(); } catch { /* ignore */ }
      try { await bridge?.close?.(); } catch { /* ignore */ }
    },
  };
  const rememberUrl = (url, sourcePage) => {
    const callback = gcashH5CallbackFromUrl(url);
    if (!callback) return;
    if (callback.kind === 'success' || handle.callback?.kind !== 'success') {
      handle.callback = callback;
      handle.callbackPage = sourcePage || handle.callbackPage;
    }
  };
  const onResponse = (response, sourcePage) => {
      const url = String(response?.url?.() || '');
      rememberUrl(url, sourcePage);
      try {
        const headers = response.headers?.() || {};
        const location = String(headers.location || headers.Location || '').trim();
        if (location) rememberUrl(location, sourcePage);
      } catch { /* ignore */ }
      const hostPath = safeH5HostPath(url);
      if (hostPath) handle.lastHostPath = hostPath;
      if (/\/backend-api\/payments\/checkout\/custom_payment_method\/continue/i.test(url)) {
        handle.browserContinueSeen = true;
        handle.browserContinueHttp = Number(response.status?.() || response.status || 0) || 0;
        if (handle.browserContinueHttp >= 400) {
          handle.browserContinueDetailPromise = Promise.resolve(response.json?.())
            .then((data) => {
              const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).sort() : [];
              const errorCode = safeContinueErrorCode(data);
              handle.browserContinueError = {
                status: handle.browserContinueHttp,
                body_keys: keys,
                error_code: errorCode,
              };
              emit?.(
                'pay',
                `浏览器真实 continue 失败：HTTP ${handle.browserContinueHttp} keys=[${keys.join(',')}] code=${errorCode || '无'}`,
              );
            })
            .catch(() => {
              handle.browserContinueError = {
                status: handle.browserContinueHttp,
                body_keys: [],
                error_code: '',
              };
            });
        }
      }
      if (isGcashRpcUrl(url)) {
        Promise.resolve(response.text?.() || '')
          .then((text) => ingestGcashH5Rpc(handle, text))
          .catch(() => {});
      }
  };
  const rememberContinueRequest = async (request, sourcePage, failed = false) => {
    const url = String(request?.url?.() || '');
    if (!/\/backend-api\/payments\/checkout\/custom_payment_method\/continue/i.test(url)) return;
    handle.browserContinueRequested = true;
    if (!failed) return;
    let headers = {};
    try {
      headers = typeof request.allHeaders === 'function'
        ? await request.allHeaders()
        : (request.headers?.() || {});
    } catch {
      try { headers = request.headers?.() || {}; } catch { headers = {}; }
    }
    handle.failedContinueRequest = {
      url,
      method: String(request.method?.() || 'POST').toUpperCase(),
      headers: { ...headers },
      body: String(request.postData?.() || ''),
      page: sourcePage,
    };
    emit?.('pay', '浏览器真实 continue 网络瞬断，已仅在当前页面内存保留原请求，准备重试一次');
  };
  const attachPage = (sourcePage) => {
    if (!sourcePage || handle.pages.has(sourcePage)) return;
    handle.pages.add(sourcePage);
    try { rememberUrl(sourcePage.url?.(), sourcePage); } catch { /* ignore */ }
    sourcePage.on?.('request', (request) => {
      rememberUrl(request?.url?.(), sourcePage);
      void rememberContinueRequest(request, sourcePage, false);
    });
    sourcePage.on?.('requestfailed', (request) => {
      void rememberContinueRequest(request, sourcePage, true);
    });
    sourcePage.on?.('response', (response) => onResponse(response, sourcePage));
    sourcePage.on?.('framenavigated', (frame) => rememberUrl(frame?.url?.(), sourcePage));
    sourcePage.on?.('pageerror', () => {
      handle.pageErrorCount += 1;
      if (handle.callback?.kind === 'verify') emit?.('pay', 'verify 页发生前端脚本错误（内容已隐藏）');
    });
    sourcePage.on?.('console', (message) => {
      try {
        if (String(message?.type?.() || '').toLowerCase() === 'error') handle.consoleErrorCount += 1;
      } catch { /* ignore */ }
    });
  };
  try {
    for (const existing of context?.pages?.() || []) attachPage(existing);
    context?.on?.('page', attachPage);
    context?.on?.('request', (request) => {
      const sourcePage = request?.frame?.()?.page?.();
      rememberUrl(request?.url?.(), sourcePage);
    });
    attachPage(page);
  } catch { /* ignore */ }
  return handle;
}

const PLAYWRIGHT_CHROMIUM_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=390,844'];

function playwrightChromiumLaunchOptions(proxySettings) {
  const launch = {
    headless: true,
    args: [...PLAYWRIGHT_CHROMIUM_ARGS],
  };
  if (proxySettings) launch.proxy = proxySettings;
  return launch;
}

function playwrightChromiumExecutablePath(chromium) {
  try {
    return String(chromium?.executablePath?.() || '').trim();
  } catch {
    return '';
  }
}

function playwrightChromiumLaunchError(error, expectedPath = '') {
  const detail = String(error?.message || error || 'unknown').replace(/\s+/g, ' ').trim().slice(0, 180);
  const where = expectedPath ? `期望 ${expectedPath}。` : '';
  return new Error(
    `Playwright Chromium 启动失败：${detail}。${where}GCash H5 使用 Playwright 自带 Chromium，不是 Google Chrome / CloakBrowser。请在 server 目录执行 npx playwright-core install chromium。`,
  );
}

async function launchPlaywrightChromium(chromium, launch) {
  const options = { ...playwrightChromiumLaunchOptions(launch?.proxy), ...launch };
  delete options.channel;
  if (!Array.isArray(options.args) || !options.args.includes('--no-sandbox')) {
    options.args = [...PLAYWRIGHT_CHROMIUM_ARGS, ...(options.args || [])];
  }
  options.headless = true;
  const expected = playwrightChromiumExecutablePath(chromium);
  if (expected && fs.existsSync(expected) && !options.executablePath) {
    options.executablePath = expected;
  }
  if (expected && !fs.existsSync(expected) && !options.executablePath) {
    throw playwrightChromiumLaunchError(
      new Error(`bundled Chromium is not installed at ${expected}`),
      expected,
    );
  }
  try {
    return await chromium.launch(options);
  } catch (error) {
    throw playwrightChromiumLaunchError(error, expected || options.executablePath || '');
  }
}

const MIN_VIEWPORT_JPEG_BYTES = 6000;

function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    if (!length) break;
    offset += 2 + length;
  }
  return null;
}

function dataUrlImageBuffer(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/[\w+.-]+;base64,(.+)$/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
}

function viewportJpegLooksBlank(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return true;
  if (buffer.length < MIN_VIEWPORT_JPEG_BYTES) return true;
  const dim = jpegDimensions(buffer);
  if (!dim?.width || !dim?.height) return false;
  return buffer.length < Math.floor((dim.width * dim.height) / 80);
}

function isUsableGcashQrDataUrl(qr) {
  const text = String(qr || '').trim();
  if (!/^data:image\//i.test(text)) return false;
  if (/^data:image\/jpe?g/i.test(text)) {
    return !viewportJpegLooksBlank(dataUrlImageBuffer(text));
  }
  return true;
}

async function screenshotPage(page) {
  if (!page) return '';
  try {
    const frame = await page.screenshot({ type: 'jpeg', quality: 82, fullPage: false, timeout: 4000 });
    if (!frame || !frame.length || viewportJpegLooksBlank(Buffer.from(frame))) return '';
    return `data:image/jpeg;base64,${Buffer.from(frame).toString('base64')}`;
  } catch {
    return '';
  }
}

async function qrFromPageDom(page) {
  if (!page) return '';
  try {
    return String(await page.evaluate(() => {
      const skip = /gcat_loader|spinner|placeholder|favicon|logo/i;
      const square = (width, height) => {
        const w = Number(width) || 0;
        const h = Number(height) || 0;
        if (w < 80 || h < 80) return false;
        return Math.max(w, h) / Math.min(w, h) <= 1.6;
      };
      const canvas = document.querySelector('canvas');
      if (canvas && square(canvas.width, canvas.height)) {
        try {
          const data = canvas.toDataURL('image/png');
          if (data && data.length > 2000) return data;
        } catch { /* ignore */ }
      }
      const candidates = [];
      for (const img of document.querySelectorAll('img')) {
        const src = String(img.currentSrc || img.src || img.getAttribute('src') || '');
        if (!src || skip.test(src)) continue;
        if (!/^data:image\//i.test(src) || src.length <= 2000) continue;
        const w = Number(img.naturalWidth || img.width || 0);
        const h = Number(img.naturalHeight || img.height || 0);
        if (!square(w, h)) continue;
        candidates.push({ src, area: w * h });
      }
      candidates.sort((a, b) => b.area - a.area);
      return candidates[0]?.src || '';
    }) || '').trim();
  } catch {
    return '';
  }
}

function isGcashQrPage(url) {
  const text = String(url || '');
  return /gcash\.com/i.test(text) || parseGcashAuthPage(text).ready;
}

async function waitForGcashQrFrame(page, emit, opts = {}) {
  const timeoutMs = Math.max(200, Number(opts.timeoutMs) || 45000);
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  let selectorWaited = false;
  while (Date.now() < deadline) {
    try {
      lastUrl = String(page.url() || '');
    } catch {
      lastUrl = lastUrl || '';
    }
    if (parseCheckoutVerifyUrl(lastUrl) || isGcashCheckoutSuccessUrl(lastUrl)) {
      return { url: lastUrl, qr: '' };
    }
    if (!selectorWaited && isGcashQrPage(lastUrl) && typeof page.waitForSelector === 'function') {
      selectorWaited = true;
      try {
        await page.waitForSelector('canvas, img[src^="data:image"]', {
          timeout: Math.min(12000, Math.max(200, deadline - Date.now())),
        });
      } catch {
        /* keep polling DOM */
      }
    }
    const fromDom = await qrFromPageDom(page);
    if (fromDom) {
      emit?.('qr', 'H5 DOM 已抽出二维码图片。');
      return { url: lastUrl, qr: fromDom };
    }
    await page.waitForTimeout(700);
  }
  try {
    lastUrl = lastUrl || String(page.url() || '');
  } catch {
    /* ignore */
  }
  const fromDom = await qrFromPageDom(page);
  if (fromDom) {
    emit?.('qr', 'H5 DOM 已抽出二维码图片。');
    return { url: lastUrl, qr: fromDom };
  }
  if (isGcashQrPage(lastUrl)) {
    const shot = await screenshotPage(page);
    if (shot) {
      emit?.('qr', 'GCash 页无 canvas，改用非空白截图。');
      return { url: lastUrl, qr: shot };
    }
    emit?.('qr', 'GCash 授权页已打开但二维码还是空白，留给 consult 出码。');
    return { url: lastUrl, qr: '' };
  }
  emit?.('qr', '仍停在 Adyen 过渡页，未把过渡截图当成二维码。');
  return { url: lastUrl, qr: '' };
}

async function recaptureGcashH5Screenshot(h5, emit) {
  if (readGcashH5Callback(h5)) return '';
  try {
    const fromDom = await qrFromPageDom(h5?.page);
    if (fromDom) {
      emit?.('qr', 'Playwright H5 仍打开，已从页面抽出二维码。');
      return fromDom;
    }
    const qr = await screenshotPage(h5?.page);
    if (qr) emit?.('qr', 'Playwright H5 仍打开，已重新截图刷新二维码。');
    return qr;
  } catch (error) {
    emit?.('qr', `Playwright 重新截图失败：${String(error?.message || error).slice(0, 160)}。`);
    return '';
  }
}

async function captureGcashH5Screenshot({
  url,
  proxy,
  userAgent,
  fetchImpl,
  screenshotImpl,
  emit,
  keepOpen = false,
  chatgpt,
  saveQrPath,
} = {}) {
  const target = String(url || '').trim();
  if (!target) return { qr: '', source: '', h5: null, finalUrl: '' };
  if (typeof screenshotImpl === 'function') {
    const out = await screenshotImpl({ url: target, proxy });
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      return {
        qr: String(out.qr || '').trim(),
        source: 'screenshot-impl',
        h5: null,
        finalUrl: String(out.finalUrl || target).trim(),
      };
    }
    return { qr: String(out || '').trim(), source: 'screenshot-impl', h5: null, finalUrl: target };
  }
  if (typeof fetchImpl === 'function') {
    if (isAdyenCheckoutshopper(target)) {
      emit?.('qr', '已用 Playwright 截图路径的测试替身打开 Adyen H5。');
      return { qr: FIXTURE_JPEG, source: 'playwright-fixture', h5: null, finalUrl: target };
    }
    emit?.('qr', '非 Adyen checkoutshopper 页，测试截图为空，允许 consult 兜底。');
    return { qr: '', source: 'playwright-fixture', h5: null, finalUrl: target };
  }
  emit?.('qr', keepOpen
    ? '正在用 Playwright Chromium 打开已登录 ChatGPT 会话，再进 Adyen/GCash 截图，并保持打开直到支付成功。'
    : '正在用 Playwright Chromium 打开 Adyen H5 并截图。');
  let browser;
  let bridge;
  let h5 = null;
  try {
    const { chromium } = require('playwright-core');
    bridge = await startPlaywrightProxyBridge(proxy);
    const launch = playwrightChromiumLaunchOptions(bridge.settings);
    browser = await launchPlaywrightChromium(chromium, launch);
    const context = await browser.newContext({
      userAgent: userAgent || undefined,
      viewport: { width: 390, height: 844 },
      locale: 'en-PH',
      timezoneId: 'Asia/Manila',
    });
    const cookies = playwrightCookiesFromEntries(chatgpt?.cookies);
    if (cookies.length) {
      await context.addCookies(cookies);
      emit?.('qr', `已向 Chromium 注入 ${cookies.length} 条 ChatGPT cookie。`);
    }
    if (keepOpen) await installChatgptIdentity(context, chatgpt, emit);
    const page = await context.newPage();
    h5 = attachH5Handle(browser, context, page, bridge, emit);
    if (keepOpen && chatgpt?.accessToken) {
      const identityReady = await bootstrapChatgptIdentity(page, emit);
      if (!identityReady) {
        emit?.('qr', 'ChatGPT 登录态未就绪，关闭 H5，拒绝出不可回跳的码。');
        try { await h5.close(); } catch { /* ignore */ }
        h5 = null;
        throw new Error('ChatGPT frontend account context is not authenticated');
      }
    }
    try {
      await page.goto(target, { waitUntil: 'commit', timeout: 60000 });
    } catch (error) {
      emit?.('qr', `打开 Adyen 失败：${String(error?.message || error).slice(0, 120)}，重试一次。`);
      await page.goto(target, { waitUntil: 'commit', timeout: 60000 });
    }
    try {
      await page.waitForURL(/gcash\.com|checkout\/verify|payments\/success/i, { timeout: 40000 });
    } catch {
      emit?.('qr', `等待跳到 GCash 超时，当前 ${safeH5HostPath(page.url()) || 'unknown'}。`);
    }
    const waited = await waitForGcashQrFrame(page, emit, { timeoutMs: 45000 });
    const qr = String(waited.qr || '').trim();
    const finalUrl = String(waited.url || page.url() || target).trim();
    const saved = writeGcashQrImage(qr, saveQrPath);
    if (saved) emit?.('qr', '二维码已保存，可用 GCash 扫这个文件。');
    emit?.('qr', qr
      ? (keepOpen ? 'GCash H5 二维码已生成，浏览器保持打开以捕获 /checkout/verify 回跳。' : 'GCash H5 二维码已生成。')
      : 'Adyen/GCash H5 已打开但未抽出二维码图片。');
    if (keepOpen) {
      return { qr, source: 'playwright', h5, finalUrl, savedQrPath: saved };
    }
    try { await browser.close(); } catch { /* ignore */ }
    try { await bridge?.close?.(); } catch { /* ignore */ }
    return { qr, source: 'playwright', h5: null, finalUrl, savedQrPath: saved };
  } catch (error) {
    emit?.('qr', `Playwright H5 截图失败：${String(error?.message || error).slice(0, 280)}。`);
    if (keepOpen && h5) {
      return { qr: '', source: 'playwright-error', h5, finalUrl: target };
    }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    try { await bridge?.close?.(); } catch { /* ignore */ }
    return { qr: '', source: 'playwright-error', h5: null, finalUrl: target };
  }
}

module.exports = {
  captureGcashH5Screenshot,
  recaptureGcashH5Screenshot,
  readGcashH5Callback,
  followScanRedirectInPage,
  ingestH5ScanProgress,
  h5UrlKind,
  h5LeftGcashAuth,
  gcashH5PageUrl,
  submitGcashContinueInPage,
  waitForGcashH5Callback,
  isParkedH5Alive,
  ingestGcashH5Rpc,
  closeGcashH5,
  isAdyenCheckoutshopper,
  isGcashCheckoutSuccessUrl,
  isChatgptHost,
  playwrightNeedsHttpBridge,
  playwrightChromiumLaunchOptions,
  playwrightChromiumExecutablePath,
  playwrightChromiumLaunchError,
  launchPlaywrightChromium,
  playwrightCookiesFromEntries,
  playwrightRequestHeaders,
  chatgptIdentityHeaders,
  chatgptSessionPayload,
  installChatgptIdentity,
  bootstrapChatgptIdentity,
  attachH5Handle,
  writeGcashQrImage,
  waitForGcashQrFrame,
  isUsableGcashQrDataUrl,
  FIXTURE_JPEG,
};
