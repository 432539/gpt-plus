'use strict';

const crypto = require('crypto');
const { normalizeSuffixList } = require('./mailcomDomains');
const { suffixOfAddress } = require('./suffixPick');

const DEFAULT_CF_DOMAINS = Object.freeze([]);

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '').replace(/\.+$/, '');
}

function cfMailConfig(settings = {}) {
  const raw = settings.cfworker_mail && typeof settings.cfworker_mail === 'object'
    ? settings.cfworker_mail
    : {};
  return {
    api_url: String(raw.api_url || '').trim().replace(/\/$/, ''),
    api_key: String(raw.api_key || raw.admin_token || '').trim(),
    domain: normalizeDomain(raw.domain),
    disabled_suffixes: normalizeSuffixList(raw.disabled_suffixes),
    domains: Array.isArray(raw.domains) ? raw.domains : [],
  };
}

function cfMailCatalog(settings = {}) {
  const cfg = cfMailConfig(settings);
  const disabled = new Set(cfg.disabled_suffixes);
  const seen = new Set();
  const items = [];
  const push = (value, enabledHint) => {
    const domain = normalizeDomain(typeof value === 'string' ? value : value?.domain || value?.suffix);
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    const explicit = typeof value === 'object' && value && value.enabled !== undefined
      ? value.enabled !== false
      : enabledHint !== false;
    items.push({
      domain,
      suffix: domain,
      enabled: explicit && !disabled.has(domain),
    });
  };
  for (const item of cfg.domains) push(item, true);
  if (cfg.domain) push(cfg.domain, true);
  return items;
}

function enabledCfDomains(settings = {}) {
  return cfMailCatalog(settings).filter((item) => item.enabled).map((item) => item.domain);
}

function cfMailReady(settings = {}) {
  const cfg = cfMailConfig(settings);
  return Boolean(cfg.api_url && cfg.api_key && enabledCfDomains(settings).length);
}

function pickCfMailDomain(settings = {}, preferred = '', random = Math.random) {
  const enabled = enabledCfDomains(settings);
  if (!enabled.length) {
    throw Object.assign(new Error('没有已启用的 CF 收信域名'), {
      status: 400,
      code: 'CFWORKER_DOMAIN_REQUIRED',
    });
  }
  const want = normalizeDomain(preferred);
  if (want && enabled.includes(want)) return want;
  const index = Math.min(enabled.length - 1, Math.floor(Number(random()) * enabled.length));
  return enabled[index];
}

function splitMailMix(count, mailcomShare = 5, cfShare = 5) {
  const totalCount = Math.max(0, Math.floor(Number(count) || 0));
  const mailParts = Math.max(0, Number(mailcomShare) || 0);
  const cfParts = Math.max(0, Number(cfShare) || 0);
  const parts = mailParts + cfParts;
  if (!totalCount) return { mailcom: 0, cfworker: 0 };
  if (!parts) return { mailcom: totalCount, cfworker: 0 };
  if (!cfParts) return { mailcom: totalCount, cfworker: 0 };
  if (!mailParts) return { mailcom: 0, cfworker: totalCount };
  const cfworker = Math.round(totalCount * cfParts / parts);
  return { mailcom: totalCount - cfworker, cfworker };
}

function interleaveRows(left = [], right = []) {
  const out = [];
  const limit = Math.max(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    if (i < left.length) out.push(left[i]);
    if (i < right.length) out.push(right[i]);
  }
  return out;
}

function disableCfMailSuffix(userId, address) {
  const { readSettings, writeSettings } = require('./settings');
  const domain = suffixOfAddress(address);
  if (!domain) return { changed: false, domain: '' };
  const current = readSettings(userId);
  const catalog = cfMailCatalog(current);
  if (!catalog.some((item) => item.domain === domain)) return { changed: false, domain };
  if (!catalog.some((item) => item.domain === domain && item.enabled)) {
    return { changed: false, domain };
  }
  const disabled = normalizeSuffixList([...(current.cfworker_mail?.disabled_suffixes || []), domain]);
  const domains = catalog.map((item) => ({
    domain: item.domain,
    enabled: item.domain === domain ? false : item.enabled,
  }));
  writeSettings(userId, {
    cfworker_mail: {
      disabled_suffixes: disabled,
      domains,
    },
  });
  return { changed: true, domain };
}

function randomLocalPart() {
  return `otp${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  DEFAULT_CF_DOMAINS,
  normalizeDomain,
  cfMailConfig,
  cfMailCatalog,
  enabledCfDomains,
  cfMailReady,
  pickCfMailDomain,
  splitMailMix,
  interleaveRows,
  disableCfMailSuffix,
  randomLocalPart,
};
