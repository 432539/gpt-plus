'use strict';

/**
 * curl_cffi chrome145 HTTP session. Corresponds to gcash_chain.py:_request
 * and Session(impersonate=TLS_IMPERSONATE).
 *
 * Node drives a dedicated Python curl_cffi worker so TLS impersonation is the
 * same library/profile as the open-source chain, not a forged User-Agent.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const {
  TLS_IMPERSONATE,
  HTTP_TIMEOUT,
  httpError,
  redactHttpError,
  proxyUrl,
} = require('./protocol');

const WORKER_PATH = path.join(__dirname, 'curlCffiWorker.py');

function resolvePython() {
  const bundled = [
    path.resolve(__dirname, '../../../../.venv/Scripts/python.exe'),
    path.resolve(__dirname, '../../../../.venv/bin/python3'),
    path.resolve(__dirname, '../../../.venv/Scripts/python.exe'),
  ];
  const fromEnv = String(process.env.MK_GCASH_PYTHON || process.env.EXTRACT_PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  for (const candidate of bundled) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function headerObject(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null || value === '') continue;
    out[String(key)] = String(value);
  }
  return out;
}

async function createCurlCffiSession(impersonate = TLS_IMPERSONATE) {
  const executable = resolvePython();
  const child = spawn(executable, [WORKER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
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
  child.stderr.on('data', () => { /* never log secrets from worker */ });
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

  await send({ action: 'init', impersonate });

  const session = {
    impersonate,
    transport: 'curl_cffi',
    async setCookie(name, value, options = {}) {
      if (!name) return;
      await send({
        action: 'set_cookie',
        name: String(name),
        value: String(value || ''),
        domain: String(options.domain || '.chatgpt.com'),
        path: String(options.path || '/'),
      });
    },
    async cookies() {
      const result = await send({ action: 'cookies' });
      return Array.isArray(result.cookies) ? result.cookies : [];
    },
    async request(method, url, options = {}) {
      let body = options.data;
      if (body != null && (typeof body === 'object')) {
        body = JSON.stringify(body);
      }
      return send({
        action: 'request',
        method: String(method || 'GET').toUpperCase(),
        url,
        headers: headerObject(options.headers),
        body: body == null ? null : String(body),
        timeout: Number(options.timeout) || HTTP_TIMEOUT,
        allow_redirects: Boolean(options.followRedirect),
        proxy_url: options.proxyUrl || '',
      });
    },
    async close() {
      if (closed) return;
      try { await send({ action: 'close' }); } catch { /* process may already be gone */ }
      try { child.stdin.end(); } catch { /* ignore */ }
      lines.close();
    },
  };
  return session;
}

/** gcash_chain.py:_browser_cookies */
function browserCookies(cookies) {
  const output = [];
  const now = Date.now() / 1000;
  for (const cookie of cookies || []) {
    if (!cookie.domain || !cookie.name) continue;
    const item = {
      name: String(cookie.name),
      value: String(cookie.value),
      domain: String(cookie.domain),
      path: String(cookie.path || '/'),
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
    };
    if (cookie.expires && Number(cookie.expires) > now) {
      item.expires = Number(cookie.expires);
    }
    output.push(item);
  }
  return output;
}

/** gcash_chain.py:_session_cookie_header */
function sessionCookieHeader(cookies) {
  const pairs = {};
  for (const cookie of cookies || []) {
    const name = String(cookie.name || '').trim();
    const value = String(cookie.value || '').trim();
    const domain = String(cookie.domain || '').toLowerCase();
    if (name && value && (
      !domain || domain.includes('chatgpt.com') || domain.includes('openai.com')
    )) {
      pairs[name] = value;
    }
  }
  return Object.entries(pairs).map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * gcash_chain.py:_request
 * Returns { json, headers } or { url, text, headers } when followRedirect is true.
 */
async function requestJson(method, url, reqHeaders, data = null, options = {}) {
  const timeout = options.timeout ?? HTTP_TIMEOUT;
  const proxy = options.proxy;
  const followRedirect = Boolean(options.followRedirect);
  const ownSession = !options.session;
  const client = options.session || await createCurlCffiSession(options.impersonate || TLS_IMPERSONATE);
  try {
    const proxyRendered = proxyUrl(proxy);
    const requestHeaders = { ...(reqHeaders || {}) };
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (parsed && parsed.hostname === 'chatgpt.com' && parsed.pathname.startsWith('/backend-api/')) {
      if (!requestHeaders['x-openai-target-path'] && !requestHeaders['X-Openai-Target-Path']) {
        requestHeaders['x-openai-target-path'] = parsed.pathname;
      }
      if (!requestHeaders['x-openai-target-route'] && !requestHeaders['X-Openai-Target-Route']) {
        requestHeaders['x-openai-target-route'] = parsed.pathname;
      }
    }
    const response = await client.request(method, url, {
      headers: requestHeaders,
      data,
      timeout,
      followRedirect,
      proxyUrl: proxyRendered,
    });
    if (Number(response.status) >= 400) throw httpError(response, url);
    if (followRedirect) {
      return { url: String(response.url), text: response.text || '', headers: response.headers || {}, status: Number(response.status) };
    }
    const body = response.text || '';
    if (!body) return { json: {}, headers: response.headers || {}, status: Number(response.status) };
    try {
      return { json: JSON.parse(body), headers: response.headers || {}, status: Number(response.status) };
    } catch {
      const contentType = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';
      let pathname = '/';
      try { pathname = new URL(url).pathname; } catch { /* keep */ }
      throw new Error(`${pathname} 响应不是 JSON（${contentType}）`);
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message.includes('HTTP ')
      || error.message.includes('响应不是 JSON')
      || error.name === 'TokenRevokedError'
    )) {
      throw error;
    }
    const message = redactHttpError(String(error?.message || error));
    if (message.toLowerCase().includes('timeout') || message.toLowerCase().includes('timed out')) {
      throw new Error('连接超时');
    }
    throw new Error(`连接失败：${message.slice(0, 200)}`);
  } finally {
    if (ownSession) await client.close().catch(() => {});
  }
}

module.exports = {
  createCurlCffiSession,
  browserCookies,
  sessionCookieHeader,
  requestJson,
};
