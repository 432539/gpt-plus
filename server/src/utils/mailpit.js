'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pollMailboxOtp } = require('./mailOtp');

const execFileAsync = promisify(execFile);

const DEFAULT_SMTP_HOST = '';
const DEFAULT_MX_HOST = '';
const DEFAULT_URL = 'http://127.0.0.1:8025';
const DEFAULT_UI_URL = '';
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeDomain(value) {
  return text(value).toLowerCase().replace(/\.+$/, '');
}

function isValidDomain(value) {
  const domain = normalizeDomain(value);
  return Boolean(domain) && domain.length <= 253 && DOMAIN_RE.test(domain) && !domain.includes('..');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDomainList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const domain = normalizeDomain(typeof item === 'string' ? item : item?.domain);
    if (!isValidDomain(domain) || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      domain,
      enabled: item?.enabled !== false,
    });
  }
  return out;
}

function mailpitConfig(settings = {}) {
  const raw = settings.mailpit && typeof settings.mailpit === 'object' ? settings.mailpit : {};
  const domains = normalizeDomainList(Array.isArray(raw.domains) ? raw.domains : []);
  return {
    url: text(raw.url) || DEFAULT_URL,
    username: text(raw.username),
    password: text(raw.password),
    webhook_secret: text(raw.webhook_secret),
    smtp_host: text(raw.smtp_host) || DEFAULT_SMTP_HOST,
    mx_host: normalizeDomain(raw.mx_host) || DEFAULT_MX_HOST,
    ui_url: text(raw.ui_url) || DEFAULT_UI_URL,
    domains,
  };
}

function enabledDomains(settingsOrCfg = {}) {
  const cfg = settingsOrCfg.domains ? settingsOrCfg : mailpitConfig(settingsOrCfg);
  return cfg.domains.filter((item) => item.enabled).map((item) => item.domain);
}

function mailpitReady(settings = {}) {
  const cfg = mailpitConfig(settings);
  if (!enabledDomains(cfg).length) return false;
  if (cfg.username && !cfg.password) return false;
  return Boolean(cfg.url);
}

function allowedRecipientsRegex(settingsOrCfg = {}) {
  const domains = enabledDomains(settingsOrCfg);
  if (!domains.length) return DEFAULT_MX_HOST ? `@${escapeRegex(DEFAULT_MX_HOST)}$` : '(?!)';
  return `@(${domains.map(escapeRegex).join('|')})$`;
}

function splitZone(domain) {
  const fqdn = normalizeDomain(domain);
  if (fqdn.endsWith('.it.com')) {
    const head = fqdn.slice(0, -'.it.com'.length);
    const parts = head.split('.').filter(Boolean);
    if (parts.length >= 2) {
      return { host: parts.slice(0, -1).join('.'), zone: `${parts[parts.length - 1]}.it.com`, fqdn };
    }
    if (parts.length === 1) return { host: '@', zone: fqdn, fqdn };
  }
  const labels = fqdn.split('.');
  if (labels.length <= 2) return { host: '@', zone: fqdn, fqdn };
  return { host: labels[0], zone: labels.slice(1).join('.'), fqdn };
}

function dnsRecordsFor(domain, options = {}) {
  const fqdn = normalizeDomain(domain);
  const smtpHost = text(options.smtp_host || options.smtpHost) || DEFAULT_SMTP_HOST;
  const mxHost = normalizeDomain(options.mx_host || options.mxHost) || DEFAULT_MX_HOST;
  const { host, zone } = splitZone(fqdn);
  const isMxTarget = fqdn === mxHost;
  const records = [
    {
      type: 'A',
      host,
      name: fqdn,
      value: smtpHost,
      copy: `${host}  A  ${smtpHost}`,
      required: isMxTarget,
      hint: isMxTarget ? '管理界面与 MX 目标' : '可选：仅当 MX 指向本域时需要',
    },
    {
      type: 'MX',
      host,
      name: fqdn,
      value: `10 ${mxHost}`,
      copy: `${host}  MX  10 ${mxHost}`,
      required: true,
      hint: `${fqdn} 的验证码投递到 ${mxHost}`,
    },
    {
      type: 'TXT',
      host,
      name: fqdn,
      value: `v=spf1 ip4:${smtpHost} -all`,
      copy: `${host}  TXT  v=spf1 ip4:${smtpHost} -all`,
      required: true,
      hint: '降低被当作伪造发信',
    },
  ];
  return { domain: fqdn, zone, host, smtp_host: smtpHost, mx_host: mxHost, records };
}

function exampleAddress(domain) {
  return `otp@${normalizeDomain(domain)}`;
}

function pickMailpitDomain(settings = {}, preferred = '') {
  const domains = enabledDomains(settings);
  if (!domains.length) {
    const err = new Error('没有已启用的 Mailpit 收信域名');
    err.status = 400;
    err.code = 'MAILPIT_DOMAIN_REQUIRED';
    throw err;
  }
  const want = normalizeDomain(preferred);
  if (want && domains.includes(want)) return want;
  return domains[0];
}

function generateLocalPart() {
  const raw = crypto.randomBytes(6).toString('hex');
  return `otp${raw}`;
}

function generateMailpitAddress(settings = {}, preferredDomain = '') {
  const domain = pickMailpitDomain(settings, preferredDomain);
  const local = generateLocalPart();
  if (!LOCAL_RE.test(local)) return `otp${crypto.randomBytes(8).toString('hex')}@${domain}`;
  return `${local}@${domain}`;
}

function allocateMailpitAddresses(settings = {}, count = 1, preferredDomain = '') {
  const n = Math.max(1, Math.min(2000, Number(count) || 1));
  const seen = new Set();
  const emails = [];
  let guard = 0;
  while (emails.length < n && guard < n * 8) {
    guard += 1;
    const address = generateMailpitAddress(settings, preferredDomain);
    if (seen.has(address)) continue;
    seen.add(address);
    emails.push({ id: null, address, mailbox_type: 'mailpit' });
  }
  if (emails.length < n) {
    const err = new Error('生成 Mailpit 地址失败');
    err.status = 500;
    throw err;
  }
  return emails;
}

function mailpitBase(cfg) {
  try {
    const url = new URL(cfg.url || DEFAULT_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad');
    return url.href.replace(/\/$/, '');
  } catch {
    const err = new Error('Mailpit 地址无效');
    err.status = 400;
    err.code = 'MAILPIT_URL_INVALID';
    throw err;
  }
}

function mailpitHeaders(cfg) {
  const headers = { accept: 'application/json' };
  if (cfg.username || cfg.password) {
    const token = Buffer.from(`${cfg.username}:${cfg.password}`, 'utf8').toString('base64');
    headers.authorization = `Basic ${token}`;
  }
  return headers;
}

function mailpitError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

async function mailpitFetch(cfg, path, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const url = `${mailpitBase(cfg)}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: { ...mailpitHeaders(cfg), ...(options.headers || {}) },
      body: options.body,
    });
  } catch (error) {
    throw mailpitError(`Mailpit 无法连接：${String(error.message || error).slice(0, 160)}`, 'MAILPIT_UNREACHABLE');
  }
  if (response.status === 401 || response.status === 403) {
    throw mailpitError('Mailpit 管理接口认证失败', 'MAILPIT_AUTH', { terminal: true });
  }
  if (!response.ok) {
    throw mailpitError(`Mailpit HTTP ${response.status}`, 'MAILPIT_HTTP');
  }
  const type = String(response.headers.get('content-type') || '');
  if (type.includes('json')) return response.json();
  return response.text();
}

function listAddress(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.toLowerCase();
  return text(entry.Address || entry.address || entry.email).toLowerCase();
}

function normalizeMailpitMessage(row = {}) {
  const to = row.To || row.to || [];
  return {
    id: String(row.ID || row.Id || row.id || ''),
    from: listAddress(row.From || row.from),
    subject: text(row.Subject || row.subject),
    date: row.Created || row.Date || row.date || '',
    to: (Array.isArray(to) ? to : [to]).map((item) => ({ address: listAddress(item) })),
    snippet: text(row.Snippet || row.snippet),
  };
}

async function searchMailpit(cfg, address, options = {}) {
  const query = `to:"${String(address || '').replace(/"/g, '')}"`;
  const data = await mailpitFetch(cfg, `/api/v1/search?query=${encodeURIComponent(query)}`, options);
  const rows = data?.messages || data?.Messages || data || [];
  return (Array.isArray(rows) ? rows : []).map(normalizeMailpitMessage);
}

async function getMailpitMessage(cfg, id, options = {}) {
  const data = await mailpitFetch(cfg, `/api/v1/message/${encodeURIComponent(id)}`, options);
  const textBody = text(data?.Text || data?.text);
  const htmlBody = text(data?.HTML || data?.Html || data?.html);
  return [textBody, htmlBody].filter(Boolean).join('\n');
}

async function pingMailpit(settings = {}, options = {}) {
  const cfg = mailpitConfig(settings);
  try {
    const data = await mailpitFetch(cfg, '/api/v1/info', options);
    return { ok: true, version: text(data?.Version || data?.version), database: text(data?.Database || data?.database) };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 200), code: error.code || '' };
  }
}

async function waitMailpitOtp(settings, address, options = {}) {
  const cfg = mailpitConfig(settings);
  const expectedTo = text(address).toLowerCase();
  if (!expectedTo) throw new Error('Mailpit 收件地址为空');
  const log = options.log || (() => {});
  log('信箱收件走内网，不走代理', 'info');
  return pollMailboxOtp({
    ...options,
    expectedTo,
    sourceLabel: '信箱',
    log,
    fetchInboxFn: async () => ({ mails: await searchMailpit(cfg, expectedTo, options) }),
    fetchBodyFn: (mailId) => getMailpitMessage(cfg, mailId, options),
  });
}

function normalizeHostname(value) {
  return normalizeDomain(value).replace(/\.$/, '');
}

function collectAnswers(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    if (typeof row === 'string') return normalizeHostname(row);
    if (row && typeof row === 'object') {
      return normalizeHostname(row.exchange || row.address || row.value || '');
    }
    return '';
  }).filter(Boolean);
}

async function resolveSafe(resolver, method, name) {
  try {
    const rows = await resolver[method](name);
    return rows;
  } catch (error) {
    const code = String(error?.code || '');
    if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED'].includes(code)) return [];
    throw error;
  }
}

async function checkDomainDns(domain, options = {}) {
  const spec = dnsRecordsFor(domain, options);
  const resolver = options.resolver || dns;
  const timeoutMs = Math.max(1000, Math.min(8000, Number(options.timeoutMs) || 4000));
  const withTimeout = async (work) => {
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (String(error?.code || '') === 'ETIMEOUT') return [];
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const aRecords = collectAnswers(await withTimeout(resolveSafe(resolver, 'resolve4', spec.domain)));
  const mxRecords = (await withTimeout(resolveSafe(resolver, 'resolveMx', spec.domain)))
    .map((row) => ({
      priority: Number(row.priority) || 0,
      exchange: normalizeHostname(row.exchange),
    }))
    .filter((row) => row.exchange);
  const txtRecords = (await withTimeout(resolveSafe(resolver, 'resolveTxt', spec.domain)))
    .map((row) => (Array.isArray(row) ? row.join('') : String(row || '')));

  const mxHostA = spec.mx_host === spec.domain
    ? aRecords
    : collectAnswers(await withTimeout(resolveSafe(resolver, 'resolve4', spec.mx_host)));

  const aOk = aRecords.includes(spec.smtp_host) || mxHostA.includes(spec.smtp_host);
  const mxOk = mxRecords.some((row) => (
    row.exchange === spec.mx_host || row.exchange === spec.domain
  ));
  const spfOk = txtRecords.some((row) => (
    /v=spf1/i.test(row) && row.toLowerCase().includes(`ip4:${spec.smtp_host}`)
  ));

  const checks = {
    a: { ok: aOk, found: aRecords, expected: spec.smtp_host },
    mx: { ok: mxOk, found: mxRecords, expected: spec.mx_host },
    spf: { ok: spfOk, found: txtRecords, expected: `v=spf1 ip4:${spec.smtp_host} -all` },
  };
  const requiredOk = mxOk && spfOk && (spec.domain === spec.mx_host ? aOk : true);
  const status = requiredOk ? 'ok' : ((mxOk || spfOk || aOk) ? 'partial' : 'missing');
  return {
    domain: spec.domain,
    status,
    ok: requiredOk,
    label: requiredOk ? '已解析' : (status === 'partial' ? '部分解析' : '未解析'),
    checks,
    records: spec.records,
    zone: spec.zone,
    host: spec.host,
    example: exampleAddress(spec.domain),
  };
}

function recipientsEnvPath() {
  return process.env.MAILPIT_RECIPIENTS_ENV || '/opt/mailpit/recipients.env';
}

async function syncMailpitAllowlist(settings = {}) {
  const regex = allowedRecipientsRegex(settings);
  const envPath = recipientsEnvPath();
  const body = `MP_SMTP_ALLOWED_RECIPIENTS=${regex}\n`;
  try {
    fs.mkdirSync(require('path').dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, body, { encoding: 'utf8' });
  } catch (error) {
    return { ok: false, regex, written: false, error: String(error.message || error).slice(0, 200) };
  }
  if (process.env.MAILPIT_SKIP_RESTART === '1') {
    return { ok: true, regex, written: true, restarted: false };
  }
  try {
    await execFileAsync('systemctl', ['try-restart', 'mailpit'], { timeout: 20000 });
    return { ok: true, regex, written: true, restarted: true };
  } catch (error) {
    return {
      ok: true,
      regex,
      written: true,
      restarted: false,
      restart_error: String(error.stderr || error.message || error).slice(0, 200),
    };
  }
}

function publicMailpitView(settings = {}) {
  const cfg = mailpitConfig(settings);
  return {
    url: cfg.url,
    username: cfg.username,
    password_configured: Boolean(cfg.password),
    webhook_secret_configured: Boolean(cfg.webhook_secret),
    smtp_host: cfg.smtp_host,
    mx_host: cfg.mx_host,
    ui_url: cfg.ui_url,
    ready: mailpitReady(settings),
    domains: cfg.domains.map((item) => ({
      ...item,
      example: exampleAddress(item.domain),
      ...dnsRecordsFor(item.domain, cfg),
    })),
  };
}

function verifyWebhookSecret(settings, provided) {
  const want = mailpitConfig(settings).webhook_secret;
  if (!want) return false;
  const got = text(provided);
  if (!got || got.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SMTP_HOST,
  DEFAULT_MX_HOST,
  DEFAULT_URL,
  DEFAULT_UI_URL,
  normalizeDomain,
  isValidDomain,
  normalizeDomainList,
  mailpitConfig,
  enabledDomains,
  mailpitReady,
  allowedRecipientsRegex,
  splitZone,
  dnsRecordsFor,
  exampleAddress,
  pickMailpitDomain,
  generateMailpitAddress,
  allocateMailpitAddresses,
  pingMailpit,
  waitMailpitOtp,
  checkDomainDns,
  syncMailpitAllowlist,
  publicMailpitView,
  verifyWebhookSecret,
  searchMailpit,
  getMailpitMessage,
};
