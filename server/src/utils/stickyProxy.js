'use strict';

const crypto = require('node:crypto');

// CliProxy and 1024Proxy share the region/sid/t contract. Keep the
// delimiters outside the session value so refreshing cannot consume -t-*.
const REGION_SID_PATTERN = /(-region-[A-Za-z]{2}-sid-)([A-Za-z0-9_-]+)(-t-\d+)$/i;
const IPROCKET_LSID_PATTERN = /(-res-[A-Za-z]{2}-Lsid-)([A-Za-z0-9]+)(-TTL-\d+)$/i;
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomAlphanumeric(length) {
  return Array.from(
    { length },
    () => ALPHANUMERIC[crypto.randomInt(0, ALPHANUMERIC.length)],
  ).join('');
}

function replaceSessionValue(username, pattern, nextValue) {
  return username.replace(
    pattern,
    (_match, prefix, _previousValue, suffix) => `${prefix}${nextValue}${suffix}`,
  );
}

function rewriteStickyUsername(username, { regionSidLength = 8 } = {}) {
  const value = String(username || '');
  const regionMatch = value.match(REGION_SID_PATTERN);
  if (regionMatch) {
    let nextSession;
    do {
      nextSession = randomAlphanumeric(regionSidLength);
    } while (nextSession === regionMatch[2]);
    return replaceSessionValue(value, REGION_SID_PATTERN, nextSession);
  }
  const iprocketMatch = value.match(IPROCKET_LSID_PATTERN);
  if (iprocketMatch) {
    let nextSession;
    do {
      nextSession = String(crypto.randomInt(100_000_000, 1_000_000_000));
    } while (nextSession === iprocketMatch[2]);
    return replaceSessionValue(value, IPROCKET_LSID_PATTERN, nextSession);
  }
  return value;
}

function maskStickyUsername(username) {
  const value = String(username || '');
  return replaceSessionValue(
    replaceSessionValue(value, REGION_SID_PATTERN, '*'),
    IPROCKET_LSID_PATTERN,
    '*',
  );
}

function freshStickyProxy(proxy) {
  if (!proxy) return proxy;
  const regionSidLength = proxy.automated_pool === '1024proxy' ? 12 : 8;
  const username = String(proxy.username || '');
  const rewritten = rewriteStickyUsername(username, { regionSidLength });
  if (rewritten === username) return { ...proxy };
  return {
    ...proxy,
    username: rewritten,
  };
}

module.exports = {
  freshStickyProxy,
  maskStickyUsername,
  rewriteStickyUsername,
};
