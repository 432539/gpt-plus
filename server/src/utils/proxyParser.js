const SUPPORTED_PROXY_TYPES = new Set(['http', 'https', 'socks5']);

function normalizeProxyType(value) {
  const type = String(value || 'http').trim().toLowerCase().replace(/:$/, '');
  if (type === 'socks5h') return 'socks5';
  return SUPPORTED_PROXY_TYPES.has(type) ? type : '';
}

function decodeUserInfo(value) {
  return decodeURIComponent(value || '');
}

// 解析一行代理配置,支持多种写法:
//   type://user:pass@host:port
//   user:pass@host:port
//   host:port:user:pass
//   host:port
function parseProxyLine(raw, group = '默认分组') {
  const line = String(raw || '').trim();
  if (!line) return null;
  let proxyType = 'http';
  let host = '';
  let port = 0;
  let username = '';
  let password = '';
  try {
    if (/^[a-z0-9]+:\/\//i.test(line)) {
      const u = new URL(line);
      proxyType = normalizeProxyType(u.protocol);
      if (!proxyType) return null;
      host = u.hostname;
      port = Number(u.port);
      username = decodeUserInfo(u.username);
      password = decodeUserInfo(u.password);
    } else if (line.includes('@')) {
      const at = line.lastIndexOf('@');
      const auth = line.slice(0, at);
      const addr = line.slice(at + 1);
      const colon = addr.lastIndexOf(':');
      const h = addr.slice(0, colon);
      const p = addr.slice(colon + 1);
      const cut = auth.indexOf(':');
      host = h;
      port = Number(p);
      username = cut >= 0 ? auth.slice(0, cut) : auth;
      password = cut >= 0 ? auth.slice(cut + 1) : '';
    } else {
      const p = line.split(':');
      if (p.length >= 4) {
        host = p[0];
        port = Number(p[1]);
        username = p[2];
        password = p.slice(3).join(':');
      } else {
        host = p[0];
        port = Number(p[1]);
      }
    }
  } catch {
    return null;
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    group_name: group || '默认分组',
    proxy_type: normalizeProxyType(proxyType),
    host,
    port,
    username,
    password,
    status: '可用',
  };
}

function parseProxies(text, group) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => parseProxyLine(line, group))
    .filter(Boolean);
}

module.exports = { SUPPORTED_PROXY_TYPES, normalizeProxyType, parseProxyLine, parseProxies };
