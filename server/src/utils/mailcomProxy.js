const crypto = require('crypto');
const { ProxyAgent, Socks5ProxyAgent } = require('undici');

let impersonationWarned = false;

function proxyLabel(proxy) {
  if (!proxy) return 'direct';
  const sid = String(proxy.username || '').match(/sid-([A-Za-z0-9]+)/i)?.[1] || '';
  return `${proxy.host}:${proxy.port}${sid ? ` (sid-${sid})` : ''}`;
}

function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildProxyUrl(proxy) {
  if (!proxy) return '';
  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port);
  if (!host || !Number.isFinite(port) || port <= 0) return '';
  const type = String(proxy.proxy_type || 'http').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(type)) {
    throw new TypeError(`unsupported proxy type: ${type}`);
  }
  // curl/impit distinguish socks5h: the h guarantees target DNS is resolved by
  // the proxy instead of leaking lookups through the application host.
  const scheme = type === 'socks5' || type === 'socks5h' ? 'socks5h' : type;
  const user = String(proxy.username || '');
  const pass = String(proxy.password || '');
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `${scheme}://${auth}${host}:${port}`;
}

function createProxyDispatcher(proxy) {
  if (!proxy) return undefined;
  const type = String(proxy.proxy_type || 'http').toLowerCase().replace('socks5h', 'socks5');
  const uri = `${type}://${proxy.host}:${proxy.port}`;
  if (type === 'socks5') {
    // Undici passes targetHost to the SOCKS CONNECT command, so DNS remains
    // remote even though its URL parser names the scheme socks5 (not socks5h).
    return new Socks5ProxyAgent(uri, {
      username: proxy.username || undefined,
      password: proxy.password || undefined,
    });
  }
  if (!['http', 'https'].includes(type)) throw new TypeError(`unsupported proxy type: ${type}`);
  const options = { uri };
  if (proxy.username) {
    options.token = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
  }
  return new ProxyAgent(options);
}

function createMemoryCookieJar() {
  const cookies = new Map();
  return {
    cookies,
    setCookie(cookie) {
      const first = String(cookie || '').split(';')[0];
      const eq = first.indexOf('=');
      if (eq > 0) cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    },
    getCookieString() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

function createChromeTransport(proxy, { timeoutMs = 20000 } = {}) {
  const { Impit } = require('impit');
  const proxyUrl = buildProxyUrl(proxy);
  const cookieJar = createMemoryCookieJar();
  const browser = ['chrome142', 'chrome136', 'chrome131'].includes(String(process.env.MAILCOM_IMPERSONATE || ''))
    ? process.env.MAILCOM_IMPERSONATE
    : 'chrome142';
  const client = new Impit({
    browser,
    followRedirects: false,
    http3: false,
    timeout: Math.max(1000, Number(timeoutMs) || 20000),
    cookieJar,
    ...(proxyUrl ? { proxyUrl } : {}),
  });
  return {
    impersonated: true,
    cookieJar,
    fetch(url, opts = {}) {
      return client.fetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers,
        body: opts.body,
        redirect: opts.redirect || 'manual',
      });
    },
    async close() {},
  };
}

function createMailcomTransport(proxy, { timeoutMs = 20000, fetch } = {}) {
  if (typeof fetch === 'function') {
    return {
      impersonated: false,
      fetch,
      dispatcher: createProxyDispatcher(proxy),
      async close() {
        const dispatcher = this.dispatcher;
        this.dispatcher = undefined;
        if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close().catch(() => {});
      },
    };
  }
  try {
    return createChromeTransport(proxy, { timeoutMs });
  } catch (error) {
    if (!impersonationWarned) {
      impersonationWarned = true;
      console.warn(`mail.com Chrome TLS 不可用，回退 Node TLS：${String(error?.message || error).slice(0, 160)}`);
    }
    const dispatcher = createProxyDispatcher(proxy);
    return {
      impersonated: false,
      fetch: require('undici').fetch,
      dispatcher,
      async close() {
        if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close().catch(() => {});
      },
    };
  }
}

module.exports = {
  buildProxyUrl,
  createChromeTransport,
  createMailcomTransport,
  createMemoryCookieJar,
  createProxyDispatcher,
  proxyLabel,
  shuffled,
};
