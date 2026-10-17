'use strict';

const { readSettings } = require('./settings');
const { buildDynamicProxy, countryCode } = require('./dynamicProxy');
const { freshStickyProxy } = require('./stickyProxy');
const { isGcChannel } = require('./accountChannel');

const CLIPROXY = 'cliproxy';

function channelCountry(channel) {
  return isGcChannel(channel) ? 'PH' : 'GB';
}

function channelAutoGroup(channel) {
  return `__auto__:${channelCountry(channel)}`;
}

function cliproxyCredentials(userId, settings = readSettings(userId)) {
  const creds = settings?.dynamic_proxy?.providers?.cliproxy || {};
  const username = String(creds.username || '').trim();
  const password = String(creds.password || '').trim();
  if (!username || !password) return null;
  return {
    username,
    password,
    sticky_minutes: creds.sticky_minutes,
  };
}

function cliproxyConfigured(userId, settings) {
  return Boolean(cliproxyCredentials(userId, settings || readSettings(userId)));
}

function notConfiguredError() {
  return Object.assign(new Error('动态代理 CliProxy 未配置，业务流量不会回退手工导入分组'), {
    status: 400,
    code: 'DYNAMIC_PROXY_NOT_CONFIGURED',
  });
}

function invalidCountryError() {
  return Object.assign(new Error('动态代理需要有效的两位国家代码'), {
    status: 400,
    code: 'DYNAMIC_PROXY_COUNTRY_REQUIRED',
  });
}

function requireChannelDynamicProxy(userId, country, identity = '', settings) {
  const region = countryCode(country);
  if (!region) throw invalidCountryError();
  const creds = cliproxyCredentials(userId, settings);
  if (!creds) throw notConfiguredError();
  const proxy = buildDynamicProxy(region, {
    active_pool: CLIPROXY,
    providers: { cliproxy: creds },
  }, identity);
  return freshStickyProxy(proxy);
}

function nextChannelProxy(userId, country, identityPrefix = 'biz', settings) {
  let n = 0;
  return () => requireChannelDynamicProxy(
    userId,
    country,
    `${identityPrefix}:${++n}:${Date.now()}`,
    settings,
  );
}

function loadChannelProxies(userId, country, count = 3, identityPrefix = 'biz', settings) {
  const n = Math.max(1, Math.min(20, Number(count) || 3));
  return Array.from({ length: n }, (_, index) => requireChannelDynamicProxy(
    userId,
    country,
    `${identityPrefix}-${index}-${Date.now()}`,
    settings,
  ));
}

module.exports = {
  CLIPROXY,
  channelCountry,
  channelAutoGroup,
  cliproxyCredentials,
  cliproxyConfigured,
  requireChannelDynamicProxy,
  nextChannelProxy,
  loadChannelProxies,
  notConfiguredError,
};
