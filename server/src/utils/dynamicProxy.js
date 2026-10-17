'use strict';

const crypto = require('node:crypto');

const AUTO_PROXY_GROUP = '__auto__';
const AUTO_PROXY_COUNTRY_PREFIX = `${AUTO_PROXY_GROUP}:`;
const MAX_ACQUIRE_ATTEMPTS = 8;
const POOLS = Object.freeze({
  '1024proxy': Object.freeze({
    host: 'us.1024proxy.io', port: 3000,
    username: ({ username, country, sessionId, minutes }) =>
      `${username}-region-${country}-sid-${sessionId}-t-${minutes}`,
  }),
  b2proxy: Object.freeze({
    host: 'hk.rrp.bestgo.work', port: 10000,
    username: ({ username, country, sessionId, minutes }) =>
      `${username}-zone-custom-region-${country}-session-${sessionId}-sessTime-${minutes}-sessAuto-1`,
  }),
  cliproxy: Object.freeze({
    host: 'sg.cliproxy.io', port: 443,
    username: ({ username, country, sessionId, minutes }) =>
      `${username}-region-${country}-sid-${sessionId}-t-${minutes}`,
  }),
  iprocket: Object.freeze({
    host: 'prem.country.iprocket.io', port: 9595,
    username: ({ username, country, sessionId, minutes }) =>
      `${username}-res-${country}-Lsid-${sessionId}-TTL-${minutes * 60}`,
  }),
});

const countryCode = value => /^[A-Z]{2}$/.test(String(value || '').trim().toUpperCase())
  ? String(value).trim().toUpperCase() : '';
const poolId = value => Object.hasOwn(POOLS, String(value || '').trim().toLowerCase())
  ? String(value).trim().toLowerCase() : '1024proxy';
const stickyMinutes = value => Math.max(1, Math.min(120, Number.parseInt(value, 10) || 30));
const stableSession = (provider, identity) => {
  const bytes = crypto.createHash('sha256').update(`${provider}\0${identity}`).digest();
  if (provider === 'b2proxy') return String(10_000_000 + (bytes.readUInt32BE(0) % 90_000_000));
  if (provider === 'iprocket') return String(100_000_000 + (bytes.readUInt32BE(0) % 900_000_000));
  return bytes.toString('base64url').slice(0, provider === 'cliproxy' ? 8 : 12);
};
const randomSession = provider => provider === 'b2proxy'
  ? String(crypto.randomInt(10_000_000, 100_000_000))
  : provider === 'iprocket'
    ? String(crypto.randomInt(100_000_000, 1_000_000_000))
    : crypto.randomBytes(provider === 'cliproxy' ? 6 : 9).toString('base64url');

function isAutoProxyGroup(value) {
  const group = String(value || '').trim();
  return group === AUTO_PROXY_GROUP || group.startsWith(AUTO_PROXY_COUNTRY_PREFIX);
}

function countryFromGroup(value) {
  const group = String(value || '').trim();
  return group.startsWith(AUTO_PROXY_COUNTRY_PREFIX)
    ? countryCode(group.slice(AUTO_PROXY_COUNTRY_PREFIX.length)) : '';
}

function buildDynamicProxy(countryValue, settings = {}, identity = '') {
  const country = countryCode(countryValue);
  if (!country) throw Object.assign(new Error('动态代理需要有效的两位国家代码'), { status: 400, code: 'DYNAMIC_PROXY_COUNTRY_REQUIRED' });
  const provider = poolId(settings.active_pool || settings.activePool || settings.provider);
  const credentials = settings.providers?.[provider] || settings;
  const username = String(credentials?.username || '').trim();
  const password = String(credentials?.password || '').trim();
  if (!username || !password) {
    throw Object.assign(new Error(`动态代理 ${provider} 未配置账号或密码`), { status: 400, code: 'DYNAMIC_PROXY_NOT_CONFIGURED' });
  }
  const explicit = String(credentials.session_id || credentials.sessionId || '').trim();
  const sessionId = /^[A-Za-z0-9_-]{6,64}$/.test(explicit)
    ? explicit : identity ? stableSession(provider, `${country}:${identity}`) : randomSession(provider);
  const minutes = stickyMinutes(credentials.sticky_minutes ?? credentials.stickyMinutes);
  const definition = POOLS[provider];
  return {
    id: `${provider}-auto-${country}-${sessionId}`,
    proxy_type: 'socks5', host: definition.host, port: definition.port,
    username: definition.username({ username, country, sessionId, minutes }),
    password, group_name: country, region: country, source: `${provider}-auto`,
    automated_pool: provider, dynamic: true, session_id: sessionId, sticky_minutes: minutes,
  };
}

const validIp = value => {
  const ip = String(value || '').trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip.split('.').every(part => Number(part) <= 255);
  return ip.includes(':') && /^[0-9a-f:]+$/i.test(ip);
};

class ProxyExitLeaseManager {
  constructor({ probe, now = Date.now } = {}) {
    this.probe = probe;
    this.now = now;
    this.active = new Map();
  }
  async claim(session, proxy, metadata = {}) {
    if (!proxy?.dynamic) return null;
    if (typeof this.probe !== 'function') throw Object.assign(new Error('动态代理缺少出口探测器'), { code: 'PROXY_EXIT_PROBE_FAILED' });
    let geo;
    try { geo = await this.probe(session, proxy, { refresh: true }); }
    catch (cause) { throw Object.assign(new Error('动态代理实际出口检测失败'), { code: 'PROXY_EXIT_PROBE_FAILED', cause }); }
    const ip = String(geo?.ip || '').trim();
    if (!validIp(ip)) throw Object.assign(new Error('动态代理出口未返回有效 IP'), { code: 'PROXY_EXIT_INVALID' });
    const expected = countryCode(metadata.country || proxy.region);
    if (expected && countryCode(geo.country) !== expected) {
      throw Object.assign(new Error(`动态代理出口国家 ${geo.country || '未知'} 与任务国家 ${expected} 不一致`), {
        code: 'PROXY_EXIT_COUNTRY_MISMATCH', ip, expectedCountry: expected, actualCountry: geo.country || '',
      });
    }
    if (this.active.has(ip)) throw Object.assign(new Error('动态代理出口已被其他任务占用'), { code: 'PROXY_EXIT_COLLISION', ip });
    const id = crypto.randomUUID();
    this.active.set(ip, { id, jobId: metadata.jobId || '', acquiredAt: this.now() });
    let released = false;
    return {
      geo,
      release: () => {
        if (released) return false;
        released = true;
        if (this.active.get(ip)?.id === id) this.active.delete(ip);
        return true;
      },
    };
  }
}

module.exports = {
  AUTO_PROXY_GROUP, AUTO_PROXY_COUNTRY_PREFIX, MAX_ACQUIRE_ATTEMPTS, POOLS,
  buildDynamicProxy, countryCode, countryFromGroup, isAutoProxyGroup, ProxyExitLeaseManager,
};
