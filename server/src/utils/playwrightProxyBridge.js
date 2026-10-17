'use strict';

const net = require('node:net');
const { buildProxyUrl } = require('./mailcomProxy');

function playwrightNeedsHttpBridge(proxy) {
  const type = String(proxy?.proxy_type || 'http').toLowerCase();
  return (type === 'socks5' || type === 'socks5h') && Boolean(String(proxy.username || '').trim());
}

function loadSocksClient() {
  try {
    return require('socks').SocksClient;
  } catch {
    try {
      return require('socks-proxy-agent/node_modules/socks').SocksClient;
    } catch {
      return null;
    }
  }
}

function playwrightProxy(proxy) {
  const raw = buildProxyUrl(proxy);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw.replace(/^socks5h:/i, 'socks5:'));
    const settings = { server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}` };
    if (parsed.username) settings.username = decodeURIComponent(parsed.username);
    if (parsed.password) settings.password = decodeURIComponent(parsed.password);
    return settings;
  } catch {
    return undefined;
  }
}

async function startPlaywrightProxyBridge(proxy) {
  if (!playwrightNeedsHttpBridge(proxy)) {
    return { settings: playwrightProxy(proxy), close: async () => {} };
  }
  const SocksClient = loadSocksClient();
  if (!SocksClient) {
    return { settings: playwrightProxy(proxy), close: async () => {} };
  }
  const socks = {
    host: String(proxy.host),
    port: Number(proxy.port),
    type: 5,
    userId: String(proxy.username || ''),
    password: String(proxy.password || ''),
  };
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('latin1');
      const headEnd = text.indexOf('\r\n\r\n');
      if (headEnd < 0 && buf.length < 8192) return;
      client.off('data', onData);
      const match = text.match(/^CONNECT\s+([^:\s]+):(\d+)/i);
      if (!match) {
        client.end();
        return;
      }
      try {
        const info = await SocksClient.createConnection({
          proxy: socks,
          command: 'connect',
          destination: { host: match[1], port: Number(match[2]) },
        });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (headEnd >= 0 && buf.length > headEnd + 4) {
          info.socket.write(buf.subarray(headEnd + 4));
        }
        client.pipe(info.socket);
        info.socket.pipe(client);
      } catch {
        try { client.end(); } catch { /* ignore */ }
      }
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    settings: { server: `http://127.0.0.1:${port}` },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  playwrightNeedsHttpBridge,
  startPlaywrightProxyBridge,
};
