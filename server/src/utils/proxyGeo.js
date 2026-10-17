'use strict';

const crypto = require('node:crypto');

const PROBES = Object.freeze([
  'https://api.country.is/',
  'http://ip-api.com/json/?fields=status,countryCode,regionName,city,zip,timezone,currency,query',
  'https://ipinfo.io/json',
  'https://ipapi.co/json/',
]);
const cache = new Map();
const code = (value, size) => new RegExp(`^[A-Z]{${size}}$`).test(String(value || '').trim().toUpperCase())
  ? String(value).trim().toUpperCase() : '';

function normalizeProxyGeo(value = {}) {
  const country = code(value.country || value.country_code || value.countryCode, 2);
  if (!country) return null;
  return {
    ip: String(value.ip || value.query || value.ip_address || '').trim(),
    country,
    currency: code(value.currency, 3),
    region: String(value.region || value.region_name || value.regionName || '').trim(),
    city: String(value.city || '').trim(),
    postal: String(value.postal || value.zip || '').trim(),
    timezone: String(value.timezone || '').trim(),
  };
}

function proxyGeoCacheKey(proxy) {
  const identity = !proxy ? 'direct' : [
    proxy.proxy_type || proxy.type || 'http', proxy.host || '', proxy.port || '',
    proxy.username || '', proxy.password || '',
  ].join('|');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

async function detectProxyGeo(session, proxy, options = {}) {
  if (!session || typeof session.request !== 'function') throw new Error('代理地区检测缺少请求会话');
  const key = proxyGeoCacheKey(proxy);
  const now = Date.now();
  if (options.refresh) cache.delete(key);
  const hit = cache.get(key);
  if (hit?.value && hit.expiresAt > now) return { ...hit.value, cached: true };
  if (hit?.promise) return hit.promise;
  const urls = Array.isArray(options.urls) && options.urls.length ? options.urls : PROBES;
  const promise = (async () => {
    const errors = [];
    for (const url of urls) {
      try {
        const response = await session.request(url, { timeout: Number(options.timeoutMs) || 20000 });
        if (!response?.ok) { errors.push(`HTTP ${response?.status || 0}`); continue; }
        let data = response.data;
        if (!data && response.text) try { data = JSON.parse(response.text); } catch {}
        const geo = normalizeProxyGeo(data);
        if (geo) return { ...geo, source: new URL(url).hostname };
        errors.push('country missing');
      } catch (error) {
        errors.push(String(error?.code || error?.name || 'request failed'));
      }
    }
    throw new Error(`代理地区检测失败：${errors.slice(-3).join(' / ')}`);
  })().then(value => {
    cache.set(key, { value, expiresAt: Date.now() + Math.max(0, Number(options.ttlMs) || 900000) });
    return { ...value, cached: false };
  }).catch(error => { cache.delete(key); throw error; });
  cache.set(key, { promise });
  return promise;
}

function clearProxyGeoCache() { cache.clear(); }

module.exports = { PROBES, normalizeProxyGeo, proxyGeoCacheKey, detectProxyGeo, clearProxyGeoCache };
