'use strict';

/**
 * Map gpt-plus stored proxies onto the MK GCash chain.
 * curl_cffi accepts socks5h with auth; Chromium still needs the HTTP CONNECT bridge.
 */

const { buildProxyUrl } = require('../utils/mailcomProxy');
const { startPlaywrightProxyBridge } = require('../utils/playwrightProxyBridge');
const { parseProxy, playwrightProxy } = require('./protocol');

function toChainProxy(proxy) {
  if (!proxy) return '';
  if (typeof proxy === 'string') return proxy.trim();
  return buildProxyUrl(proxy) || '';
}

function toBridgeProxyObject(proxy) {
  if (proxy && typeof proxy === 'object' && proxy.host) {
    const type = String(proxy.proxy_type || proxy.type || 'http').toLowerCase().replace('socks5h', 'socks5');
    return {
      proxy_type: type,
      host: String(proxy.host || ''),
      port: Number(proxy.port),
      username: String(proxy.username || proxy.user || ''),
      password: String(proxy.password || ''),
    };
  }
  const parsed = parseProxy(proxy);
  return {
    proxy_type: parsed.type === 'socks5' ? 'socks5' : (parsed.type || 'http'),
    host: parsed.host || '',
    port: Number(parsed.port),
    username: parsed.user || '',
    password: parsed.password || '',
  };
}

function needsHttpBridge(proxy) {
  const row = toBridgeProxyObject(proxy);
  return (row.proxy_type === 'socks5' || row.proxy_type === 'socks5h')
    && Boolean(String(row.username || '').trim());
}

async function playwrightLaunchProxy(proxy) {
  if (!proxy) return { settings: undefined, close: async () => {} };
  if (needsHttpBridge(proxy)) {
    return startPlaywrightProxyBridge(toBridgeProxyObject(proxy));
  }
  return {
    settings: playwrightProxy(typeof proxy === 'string' ? proxy : toChainProxy(proxy)) || undefined,
    close: async () => {},
  };
}

module.exports = {
  toChainProxy,
  toBridgeProxyObject,
  needsHttpBridge,
  playwrightLaunchProxy,
};
