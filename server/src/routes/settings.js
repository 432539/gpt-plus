const express = require('express');
const db = require('../db');
const { readSettings, writeSettings, publicView, persistCloakLicenses } = require('../utils/settings');
const { credentials } = require('../utils/nvtokensList');
const { normalizeSessionCookie, testPlusPriceBoard } = require('../utils/nvtokensPool');

const router = express.Router();

function viewOf(req, settings) {
  return publicView(settings, req.user.id);
}

// 读取当前用户设置(脱敏)
router.get('/', (req, res) => {
  res.json(viewOf(req, readSettings(req.user.id)));
});

// 更新 CloakBrowser 授权
router.put('/cloak', (req, res) => {
  const { license_key, license_keys, headless, max_concurrency, humanize, human_preset } = req.body || {};
  const patch = { cloak: {} };
  if (license_keys !== undefined || (license_key !== undefined && license_key !== '')) {
    Object.assign(patch.cloak, persistCloakLicenses({
      license_key: license_key !== undefined && license_key !== '' ? license_key : '',
      license_keys: license_keys !== undefined ? license_keys : [],
    }));
  }
  if (headless !== undefined) patch.cloak.headless = Boolean(headless);
  if (humanize !== undefined) patch.cloak.humanize = Boolean(humanize);
  if (human_preset !== undefined) {
    const preset = String(human_preset || '').trim().toLowerCase();
    if (['careful', 'balanced', 'fast'].includes(preset)) patch.cloak.human_preset = preset;
  }
  if (max_concurrency !== undefined) {
    patch.cloak.max_concurrency = Math.max(1, Math.min(200, Number(max_concurrency) || 3));
  }
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

// 清除 CloakBrowser 授权
router.delete('/cloak', (req, res) => {
  const next = writeSettings(req.user.id, { cloak: { license_key: '', license_keys: [] } });
  res.json(viewOf(req, next));
});

router.put('/registration', (req, res) => {
  const patch = { registration: {} };
  if (req.body?.set_password !== undefined) patch.registration.set_password = Boolean(req.body.set_password);
  if (req.body?.enable_totp_2fa !== undefined) patch.registration.enable_totp_2fa = Boolean(req.body.enable_totp_2fa);
  if (req.body?.performance_profile !== undefined) {
    patch.registration.performance_profile = req.body.performance_profile === 'throughput' ? 'throughput' : 'safe';
  }
  if (req.body?.attempts !== undefined) {
    patch.registration.attempts = Math.max(1, Math.min(3, Number(req.body.attempts) || 3));
  }
  if (req.body?.mail_provider !== undefined) {
    const provider = String(req.body.mail_provider || '').trim().toLowerCase();
    if (!['mailcom', 'imported', 'herosms', 'smsbower', 'cfworker', 'mailpit', 'mix'].includes(provider)) {
      return res.status(400).json({ message: '不支持的注册邮箱供应商' });
    }
    patch.registration.mail_provider = provider;
  }
  const shareField = (key) => {
    if (req.body?.[key] === undefined) return;
    const n = Number.parseInt(req.body[key], 10);
    patch.registration[key] = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 5;
  };
  shareField('mailcom_share');
  shareField('cfworker_share');
  if (req.body?.mail_provider === undefined) {
    const current = readSettings(req.user.id).registration || {};
    const mailShare = patch.registration.mailcom_share ?? current.mailcom_share ?? 5;
    const cfShare = patch.registration.cfworker_share ?? current.cfworker_share ?? 5;
    if (Number(cfShare) > 0 && Number(mailShare) > 0) patch.registration.mail_provider = 'mix';
    else if (Number(cfShare) > 0) patch.registration.mail_provider = 'cfworker';
  }
  res.json(viewOf(req, writeSettings(req.user.id, patch)));
});

// 更新接码平台
router.put('/sms', (req, res) => {
  const { provider, api_url, api_key, country, product } = req.body || {};
  const patch = { sms: {} };
  if (provider !== undefined) patch.sms.provider = String(provider || '').trim();
  if (api_url !== undefined) patch.sms.api_url = String(api_url || '').trim();
  if (api_key !== undefined && api_key !== '') patch.sms.api_key = String(api_key).trim();
  if (country !== undefined) patch.sms.country = String(country || '').trim();
  if (product !== undefined) patch.sms.product = String(product || '').trim();
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

router.put('/registration-providers', (req, res) => {
  const current = readSettings(req.user.id);
  const body = req.body || {};
  const patch = {};
  for (const id of ['herosms', 'smsbower']) {
    if (!body[id] || typeof body[id] !== 'object') continue;
    const input = body[id];
    patch[id] = {};
    for (const key of ['api_url', 'country', 'service', 'domain', 'max_price', 'site']) {
      if (input[key] !== undefined) patch[id][key] = String(input[key] || '').trim();
    }
    if (id === 'herosms') {
      const limits = {
        max_reorders: [0, 10, 4],
        acquire_attempts: [1, 5, 3],
        requests_per_second: [1, 30, 12],
        max_request_concurrency: [1, 32, 16],
        max_active_activations: [1, 50, 20],
        max_transient_retries: [0, 3, 2],
        transient_retry_base_ms: [100, 5000, 500],
        ban_cooldown_ms: [60000, 21600000, 1800000],
        rate_cooldown_ms: [10000, 300000, 12000],
      };
      for (const [key, [min, max, fallback]] of Object.entries(limits)) {
        if (input[key] !== undefined) {
          patch[id][key] = Math.max(min, Math.min(max, Number(input[key]) || fallback));
        }
      }
    }
    if (input.api_key !== undefined && input.api_key !== '') patch[id].api_key = String(input.api_key).trim();
    if (input.clear_api_key === true) patch[id].api_key = '';
  }
  if (body.cfworker_mail && typeof body.cfworker_mail === 'object') {
    const input = body.cfworker_mail;
    patch.cfworker_mail = {};
    for (const key of ['api_url', 'domain']) {
      if (input[key] !== undefined) patch.cfworker_mail[key] = String(input[key] || '').trim();
    }
    if (input.api_key !== undefined && input.api_key !== '') patch.cfworker_mail.api_key = String(input.api_key).trim();
    if (input.clear_api_key === true) patch.cfworker_mail.api_key = '';
    if (Array.isArray(input.disabled_suffixes)) {
      patch.cfworker_mail.disabled_suffixes = [...new Set(input.disabled_suffixes
        .map((item) => String(item || '').trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean))];
    }
    if (Array.isArray(input.domains)) {
      const domains = [];
      const seen = new Set();
      const disabled = [];
      for (const item of input.domains) {
        const domain = String(item?.domain || item?.suffix || item || '').trim().toLowerCase().replace(/^@/, '');
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        const enabled = item?.enabled !== false;
        domains.push({ domain, enabled });
        if (!enabled) disabled.push(domain);
      }
      patch.cfworker_mail.domains = domains;
      if (input.disabled_suffixes === undefined) patch.cfworker_mail.disabled_suffixes = disabled;
    }
  }
  if (body.imported_mail && typeof body.imported_mail === 'object') {
    const input = body.imported_mail;
    patch.imported_mail = {};
    if (input.mailboxes !== undefined && input.mailboxes !== '') patch.imported_mail.mailboxes = String(input.mailboxes);
    if (input.clear_mailboxes === true) patch.imported_mail.mailboxes = '';
    if (input.allow_unsafe_url !== undefined) patch.imported_mail.allow_unsafe_url = Boolean(input.allow_unsafe_url);
  }
  // Explicitly retain omitted/blank secrets; the encrypted settings blob remains user-scoped.
  if (!Object.keys(patch).length) return res.json(viewOf(req, current));
  return res.json(viewOf(req, writeSettings(req.user.id, patch)));
});

router.put('/dynamic-proxy', (req, res) => {
  const body = req.body || {};
  const patch = { dynamic_proxy: { providers: {} } };
  if (body.active_pool !== undefined) {
    const active = String(body.active_pool || '').trim().toLowerCase();
    if (!['1024proxy', 'b2proxy', 'cliproxy', 'iprocket'].includes(active)) {
      return res.status(400).json({ message: '不支持的动态代理供应商' });
    }
    patch.dynamic_proxy.active_pool = active;
  }
  for (const id of ['1024proxy', 'b2proxy', 'cliproxy', 'iprocket']) {
    const input = body.providers?.[id];
    if (!input || typeof input !== 'object') continue;
    const item = {};
    if (input.username !== undefined) item.username = String(input.username || '').trim();
    if (input.password !== undefined && input.password !== '') item.password = String(input.password);
    if (input.clear_password === true) item.password = '';
    if (input.sticky_minutes !== undefined) {
      item.sticky_minutes = Math.max(1, Math.min(120, Number.parseInt(input.sticky_minutes, 10) || 30));
    }
    patch.dynamic_proxy.providers[id] = item;
  }
  return res.json(viewOf(req, writeSettings(req.user.id, patch)));
});

// 更新邮箱域名后缀策略
router.put('/email-domains', (req, res) => {
  const { mode, allow, deny } = req.body || {};
  const clean = (arr) =>
    Array.isArray(arr)
      ? [...new Set(arr.map((s) => String(s || '').trim().toLowerCase().replace(/^@/, '')).filter(Boolean))]
      : undefined;
  const patch = { email_domains: {} };
  if (['all', 'whitelist', 'blacklist'].includes(mode)) patch.email_domains.mode = mode;
  const a = clean(allow);
  const d = clean(deny);
  if (a !== undefined) patch.email_domains.allow = a;
  if (d !== undefined) patch.email_domains.deny = d;
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

router.put('/suffix-quota', (req, res) => {
  const body = req.body || {};
  const n = (value, fallback = 0) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(10000, parsed));
  };
  const patch = { suffix_quota: {} };
  if (body.hourly !== undefined) patch.suffix_quota.hourly = n(body.hourly, 0);
  if (body.daily !== undefined) patch.suffix_quota.daily = n(body.daily, 0);
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});
router.put('/mailcom', (req, res) => {
  const { proxy_group, poll_minutes, auto_delete_used, auto_repull, cap, enabled_suffixes, disabled_suffixes } = req.body || {};
  const patch = { mailcom: {} };
  if (proxy_group !== undefined) {
    const group = String(proxy_group || '').trim();
    if (group) {
      const exists = db
        .prepare('SELECT 1 FROM proxies WHERE user_id = ? AND group_name = ? LIMIT 1')
        .get(req.user.id, group);
      if (!exists) return res.status(400).json({ message: `代理分组「${group}」不存在或没有代理` });
    }
    patch.mailcom.proxy_group = group;
  }
  if (poll_minutes !== undefined) patch.mailcom.poll_minutes = Math.max(0, Math.min(1440, Number(poll_minutes) || 0));
  if (auto_delete_used !== undefined) patch.mailcom.auto_delete_used = Boolean(auto_delete_used);
  if (auto_repull !== undefined) patch.mailcom.auto_repull = Boolean(auto_repull);
  if (cap !== undefined) patch.mailcom.cap = Math.max(2, Math.min(10, Number(cap) || 10));
  if (Array.isArray(enabled_suffixes)) {
    patch.mailcom.enabled_suffixes = [...new Set(enabled_suffixes.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
  }
  if (Array.isArray(disabled_suffixes)) {
    patch.mailcom.disabled_suffixes = [...new Set(disabled_suffixes.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
  }
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

router.put('/accounts', (req, res) => {
  const { detect_poll_minutes, detect_proxy_group } = req.body || {};
  const patch = { accounts: {} };
  if (detect_proxy_group !== undefined) {
    const group = String(detect_proxy_group || '').trim();
    if (group) {
      const exists = db
        .prepare('SELECT 1 FROM proxies WHERE user_id = ? AND group_name = ? LIMIT 1')
        .get(req.user.id, group);
      if (!exists) return res.status(400).json({ message: `代理分组「${group}」不存在或没有代理` });
    }
    patch.accounts.detect_proxy_group = group;
  }
  if (detect_poll_minutes !== undefined) {
    patch.accounts.detect_poll_minutes = Math.max(0, Math.min(1440, Number(detect_poll_minutes) || 0));
  }
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

router.put('/import-dump', (req, res) => {
  const body = req.body || {};
  const patch = { import_dump: {} };
  if (body.url !== undefined && String(body.url || '').trim() !== '') {
    const url = String(body.url).trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ message: '导入接口地址必须以 http:// 或 https:// 开头' });
    }
    patch.import_dump.url = url.replace(/\/+$/, '');
  }
  if (body.api_key !== undefined && body.api_key !== '') patch.import_dump.api_key = String(body.api_key).trim();
  if (body.clear_api_key === true) patch.import_dump.api_key = '';
  if (!Object.keys(patch.import_dump).length) return res.json(viewOf(req, readSettings(req.user.id)));
  res.json(viewOf(req, writeSettings(req.user.id, patch)));
});

router.put('/pipeline', (req, res) => {
  const body = req.body || {};
  const patch = { pipeline: {} };
  for (const key of ['register', 'rebind', 'extract', 'pay', 'acquire_rt']) {
    if (body[key] !== undefined) patch.pipeline[key] = Boolean(body[key]);
  }
  const intField = (key, min, max, fallback) => {
    if (body[key] === undefined) return;
    const n = Number.parseInt(body[key], 10);
    patch.pipeline[key] = Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  intField('daily_register_limit', 0, 10000, 0);
  intField('register_concurrency', 1, 200, 5);
  intField('extract_attempts', 1, 50, 5);
  intField('extract_interval_minutes', 0, 1440, 10);
  intField('pay_attempts', 1, 50, 5);
  intField('rt_attempts', 1, 50, 5);
  const next = writeSettings(req.user.id, patch);
  try {
    require('../utils/accountPipeline').kick(req.user.id);
  } catch {
    /* poller optional at boot */
  }
  res.json(viewOf(req, next));
});

router.put('/pipeline-gc', (req, res) => {
  const body = req.body || {};
  const patch = { pipeline_gc: {} };
  for (const key of ['register', 'rebind', 'extract', 'pay', 'acquire_rt']) {
    if (body[key] !== undefined) patch.pipeline_gc[key] = Boolean(body[key]);
  }
  const next = writeSettings(req.user.id, patch);
  try {
    require('../utils/accountGcPipeline').kick(req.user.id);
  } catch {
    /* poller optional at boot */
  }
  res.json(viewOf(req, next));
});

router.put('/nvtokens', (req, res) => {
  const body = req.body || {};
  const patch = { nvtokens: {} };
  if (body.auto_list_plus !== undefined) patch.nvtokens.auto_list_plus = false;
  if (body.min_price_yuan !== undefined) {
    const n = Number(String(body.min_price_yuan || '').replace(/[^\d.-]/g, ''));
    patch.nvtokens.min_price_yuan = Number.isFinite(n) && n > 0 ? n.toFixed(2) : '20.00';
  }
  if (body.api_key !== undefined && body.api_key !== '') patch.nvtokens.api_key = String(body.api_key).trim();
  if (body.clear_api_key === true) patch.nvtokens.api_key = '';
  if (body.session_cookie !== undefined && body.session_cookie !== '') {
    patch.nvtokens.session_cookie = normalizeSessionCookie(body.session_cookie);
  }
  if (body.clear_session_cookie === true) patch.nvtokens.session_cookie = '';
  if (!Object.keys(patch.nvtokens).length) return res.json(viewOf(req, readSettings(req.user.id)));
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

router.post('/nvtokens/list-now', async (req, res) => {
  try {
    const result = await require('../utils/nvtokensList').sweepUser(req.user.id, {
      manual: true,
      fetchImpl: req.fetchImpl,
    });
    return res.json({
      ok: true,
      skipped: Boolean(result.skipped),
      reason: result.reason || '',
      listed: result.listed || 0,
      failed: result.failed || 0,
      skipped_rows: result.skipped_rows || 0,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      message: error.message,
      code: error.code || 'NVTOKENS_LIST_FAILED',
    });
  }
});

router.post('/nvtokens/price-board-test', async (req, res) => {
  const override = normalizeSessionCookie(req.body?.session || req.body?.session_cookie);
  const saved = credentials(readSettings(req.user.id)).session;
  const session = override || saved;
  if (!session) {
    return res.status(400).json({ ok: false, message: '请先填写或保存价格查询 Token' });
  }
  try {
    const result = await testPlusPriceBoard({
      session,
      omitApiKey: true,
      fetchImpl: req.fetchImpl,
    });
    const blob = JSON.stringify(result);
    if (blob.includes(session) || /scm_session=/i.test(blob)) {
      return res.status(400).json({ ok: false, message: '价格查询失败' });
    }
    if (!result.ok) {
      return res.status(400).json({ ok: false, message: result.message || '价格查询失败' });
    }
    return res.json({
      ok: true,
      min: result.min,
      max: result.max,
      avg: result.avg,
      p25: result.p25,
      inventory_label: result.inventory_label || '',
      merchants: Number(result.merchants) || 0,
      text: result.text || '',
    });
  } catch {
    return res.status(400).json({ ok: false, message: '价格查询失败' });
  }
});

router.put('/mailpit', async (req, res) => {
  const body = req.body || {};
  const patch = { mailpit: {} };
  if (body.url !== undefined) {
    const url = String(body.url || '').trim() || 'http://127.0.0.1:8025';
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ message: 'Mailpit 地址必须以 http:// 或 https:// 开头' });
      }
    } catch {
      return res.status(400).json({ message: 'Mailpit 地址无效' });
    }
    patch.mailpit.url = url.replace(/\/+$/, '');
  }
  if (body.username !== undefined) patch.mailpit.username = String(body.username || '').trim();
  if (body.password !== undefined && body.password !== '') patch.mailpit.password = String(body.password);
  if (body.clear_password === true) patch.mailpit.password = '';
  if (body.webhook_secret !== undefined && body.webhook_secret !== '') {
    patch.mailpit.webhook_secret = String(body.webhook_secret).trim();
  }
  if (body.clear_webhook_secret === true) patch.mailpit.webhook_secret = '';
  if (body.smtp_host !== undefined) {
    patch.mailpit.smtp_host = String(body.smtp_host || '').trim();
  }
  if (body.mx_host !== undefined) {
    patch.mailpit.mx_host = String(body.mx_host || '').trim().toLowerCase();
  }
  if (body.ui_url !== undefined) {
    patch.mailpit.ui_url = String(body.ui_url || '').trim();
  }
  if (!Object.keys(patch.mailpit).length) return res.json(viewOf(req, readSettings(req.user.id)));
  const next = writeSettings(req.user.id, patch);
  res.json(viewOf(req, next));
});

function sendRouteError(res, error) {
  const status = Number(error.status) || 500;
  res.status(status).json({ message: error.message || '请求失败' });
}

router.get('/cfworker-mail/domains', async (req, res) => {
  try {
    const { listWorkerDomains } = require('../utils/cfMailDns');
    const settings = readSettings(req.user.id);
    const domains = await listWorkerDomains(settings);
    res.json({ domains });
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.post('/cfworker-mail/domains', async (req, res) => {
  try {
    const { parseDomainList, addWorkerDomains } = require('../utils/cfMailDns');
    const { cfMailCatalog } = require('../utils/cfMail');
    const incoming = parseDomainList(req.body?.text || req.body?.domains);
    if (!incoming.length) return res.status(400).json({ message: '请填写至少一个域名' });
    const settings = readSettings(req.user.id);
    const catalog = cfMailCatalog(settings);
    const seen = new Set(catalog.map((item) => item.domain));
    const domains = catalog.map((item) => ({ domain: item.domain, enabled: item.enabled }));
    for (const domain of incoming) {
      if (seen.has(domain)) continue;
      seen.add(domain);
      domains.push({ domain, enabled: true });
    }
    const next = writeSettings(req.user.id, { cfworker_mail: { domains } });
    let worker = null;
    let warning = '';
    try {
      worker = await addWorkerDomains(next, incoming, { test: req.body?.test !== false });
    } catch (error) {
      warning = error.message || '已保存到控制台，但未能写入邮箱管理';
    }
    res.json({ ...viewOf(req, next), worker, warning });
  } catch (error) {
    sendRouteError(res, error);
  }
});

router.post('/cfworker-mail/test', async (req, res) => {
  try {
    const { parseDomainList, testWorkerDomains } = require('../utils/cfMailDns');
    const { enabledCfDomains } = require('../utils/cfMail');
    const settings = readSettings(req.user.id);
    const incoming = parseDomainList(req.body?.text || req.body?.domains);
    const domains = incoming.length ? incoming : enabledCfDomains(settings);
    if (!domains.length) return res.status(400).json({ message: '没有可测试的域名' });
    const data = await testWorkerDomains(settings, domains);
    res.json(data);
  } catch (error) {
    sendRouteError(res, error);
  }
});

module.exports = router;
