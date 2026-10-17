const db = require('../db');
const { decrypt } = require('./crypto');

const GB = 'GB';
const AVAILABLE = '可用';
const PAY_GROUP_RE = /支付|paypal|pay(?:ment)?(?:[\s_-]?(?:gb|uk))?/i;
const REGISTER_GROUP_RE = /注册|register|\bjp\b|japan/i;

function normalizeProxyRegion(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  if (/\b(?:UNITED\s+KINGDOM|GREAT\s+BRITAIN)\b/.test(text)) return GB;
  const match = text.match(/(?:^|[^A-Z])([A-Z]{2})(?:[^A-Z]|$)/);
  if (!match) return '';
  return match[1] === 'UK' ? GB : match[1];
}

function usernameProxyRegion(value) {
  const text = String(value || '');
  const patterns = [
    /(?:^|[-_])region[-_]?([A-Za-z]{2}|any)(?=$|[-_])/i,
    /(?:^|_)g-([A-Za-z]{2}|any)(?=_|$)/i,
    /(?:^|[-_])res-([A-Za-z]{2}|any)(?=$|[-_])/i,
    /(?:^|[-_])country[-_]?([A-Za-z]{2}|any)(?=$|[-_])/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        specified: true,
        region: normalizeProxyRegion(match[1]),
      };
    }
  }
  return { specified: false, region: '' };
}

function effectiveProxyRegion(proxy) {
  const credentialRegion = usernameProxyRegion(proxy?.username);
  if (credentialRegion.specified) return credentialRegion.region;
  return normalizeProxyRegion(proxy?.region) || normalizeProxyRegion(proxy?.group_name);
}

function isGbPaymentProxy(proxy) {
  return String(proxy?.status || AVAILABLE) === AVAILABLE
    && effectiveProxyRegion(proxy) === GB;
}

function isPaymentProxyGroup(name) {
  return PAY_GROUP_RE.test(String(name || ''));
}

function isRegisterProxyGroup(name) {
  return REGISTER_GROUP_RE.test(String(name || ''));
}

function isForbiddenRegisterCountry(country) {
  const code = String(country || '').trim().toUpperCase();
  return code === GB || code === 'UK';
}

function isMixedRegisterGroup(name) {
  const text = String(name || '');
  return (isRegisterProxyGroup(text) || /\bjp\b|japan/i.test(text))
    && (isPaymentProxyGroup(text) || /\bgb\b|\buk\b/i.test(text));
}

function keepRegistrationProxy(proxy, groupName = '') {
  const group = String(groupName || proxy?.group_name || '');
  // 支付组专用于提链/开通，绝不能混进 ChatGPT 注册。GB 动态/注册组出口现在允许，身份跟出口走。
  if (isPaymentProxyGroup(group) && !isRegisterProxyGroup(group)) return false;
  return true;
}

function loadGbPaymentProxies(userId, groupName) {
  const group = String(groupName || '').trim();
  if (!group) return [];
  return db.prepare(
    `SELECT *
       FROM proxies
      WHERE user_id = ? AND group_name = ? AND status = ?
      ORDER BY id`
  ).all(userId, group, AVAILABLE)
    .filter(isGbPaymentProxy)
    .map((row) => ({
      id: row.id,
      proxy_type: row.proxy_type || 'http',
      host: row.host,
      port: row.port,
      username: row.username || '',
      password: decrypt(row.password_enc || ''),
      group_name: row.group_name,
      region: GB,
    }));
}

function requireGbPaymentProxies(userId, groupName) {
  const proxies = loadGbPaymentProxies(userId, groupName);
  if (proxies.length) return proxies;
  throw Object.assign(
    new Error(`支付代理分组「${String(groupName || '').trim() || '支付'}」没有状态可用且区域为 GB/UK 的代理；已在资格检查前停止，绝不会回退到其他分组、地区或直连`),
    { status: 400, code: 'EXTRACT_GB_PROXY_REQUIRED' },
  );
}

function decryptPaymentProxy(row) {
  return {
    id: row.id,
    proxy_type: row.proxy_type || 'http',
    host: row.host,
    port: row.port,
    username: row.username || '',
    password: decrypt(row.password_enc || ''),
    group_name: row.group_name,
    region: effectiveProxyRegion(row),
  };
}

function loadPaymentGroupProxies(userId, groupName) {
  const group = String(groupName || '').trim();
  if (!group || !isPaymentProxyGroup(group) || isRegisterProxyGroup(group)) return [];
  return db.prepare(
    `SELECT *
       FROM proxies
      WHERE user_id = ? AND group_name = ? AND status = ?
      ORDER BY id`
  ).all(userId, group, AVAILABLE)
    .map(decryptPaymentProxy);
}

module.exports = {
  GB,
  AVAILABLE,
  PAY_GROUP_RE,
  REGISTER_GROUP_RE,
  normalizeProxyRegion,
  usernameProxyRegion,
  effectiveProxyRegion,
  isGbPaymentProxy,
  isPaymentProxyGroup,
  isRegisterProxyGroup,
  isForbiddenRegisterCountry,
  isMixedRegisterGroup,
  keepRegistrationProxy,
  loadGbPaymentProxies,
  requireGbPaymentProxies,
  loadPaymentGroupProxies,
};
