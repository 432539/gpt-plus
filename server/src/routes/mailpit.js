'use strict';

const express = require('express');
const { readSettings, writeSettings, publicView } = require('../utils/settings');
const {
  isValidDomain,
  normalizeDomain,
  normalizeDomainList,
  mailpitConfig,
  dnsRecordsFor,
  checkDomainDns,
  pingMailpit,
  syncMailpitAllowlist,
  verifyWebhookSecret,
} = require('../utils/mailpit');

const router = express.Router();

function viewOf(req, settings) {
  return publicView(settings, req.user.id);
}

function persistDomains(userId, domains) {
  return writeSettings(userId, { mailpit: { domains: normalizeDomainList(domains) } });
}

router.get('/status', async (req, res) => {
  const settings = readSettings(req.user.id);
  const ping = await pingMailpit(settings);
  const cfg = mailpitConfig(settings);
  res.json({
    ok: ping.ok,
    version: ping.version || '',
    error: ping.error || '',
    url: cfg.url,
    username: cfg.username,
    ui_url: cfg.ui_url,
    smtp_host: cfg.smtp_host,
    mx_host: cfg.mx_host,
  });
});

router.get('/domains', async (req, res) => {
  const settings = readSettings(req.user.id);
  const cfg = mailpitConfig(settings);
  const check = String(req.query.check || '') === '1';
  const domains = [];
  for (const item of cfg.domains) {
    const spec = dnsRecordsFor(item.domain, cfg);
    const row = {
      domain: item.domain,
      enabled: item.enabled,
      example: `otp@${item.domain}`,
      ...spec,
    };
    if (check) {
      try {
        row.dns = await checkDomainDns(item.domain, cfg);
      } catch (error) {
        row.dns = { ok: false, status: 'error', label: '检测失败', error: String(error.message || error).slice(0, 160) };
      }
    }
    domains.push(row);
  }
  const ping = await pingMailpit(settings);
  res.json({
    smtp_host: cfg.smtp_host,
    mx_host: cfg.mx_host,
    ui_url: cfg.ui_url,
    url: cfg.url,
    username: cfg.username,
    ready: ping.ok && cfg.domains.some((item) => item.enabled),
    mailpit: ping,
    allowlist: require('../utils/mailpit').allowedRecipientsRegex(cfg),
    domains,
  });
});

router.post('/domains', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);
  if (!isValidDomain(domain)) {
    return res.status(400).json({ message: '域名格式无效' });
  }
  const settings = readSettings(req.user.id);
  const cfg = mailpitConfig(settings);
  if (cfg.domains.some((item) => item.domain === domain)) {
    return res.status(400).json({ message: '该域名已存在' });
  }
  if (cfg.domains.length >= 50) {
    return res.status(400).json({ message: '最多维护 50 个收信域名' });
  }
  const next = persistDomains(req.user.id, [...cfg.domains, { domain, enabled: req.body?.enabled !== false }]);
  const allowlist = await syncMailpitAllowlist(next);
  res.json({ ...viewOf(req, next), allowlist });
});

router.patch('/domains', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);
  if (!isValidDomain(domain)) {
    return res.status(400).json({ message: '域名格式无效' });
  }
  const settings = readSettings(req.user.id);
  const cfg = mailpitConfig(settings);
  if (!cfg.domains.some((item) => item.domain === domain)) {
    return res.status(404).json({ message: '域名不存在' });
  }
  const enabled = req.body?.enabled === undefined ? undefined : Boolean(req.body.enabled);
  const next = persistDomains(req.user.id, cfg.domains.map((item) => (
    item.domain === domain && enabled !== undefined ? { ...item, enabled } : item
  )));
  const allowlist = await syncMailpitAllowlist(next);
  res.json({ ...viewOf(req, next), allowlist });
});

router.delete('/domains', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain || req.query?.domain);
  if (!isValidDomain(domain)) {
    return res.status(400).json({ message: '域名格式无效' });
  }
  const settings = readSettings(req.user.id);
  const cfg = mailpitConfig(settings);
  const nextList = cfg.domains.filter((item) => item.domain !== domain);
  if (nextList.length === cfg.domains.length) {
    return res.status(404).json({ message: '域名不存在' });
  }
  const next = persistDomains(req.user.id, nextList);
  const allowlist = await syncMailpitAllowlist(next);
  res.json({ ...viewOf(req, next), allowlist });
});

router.post('/check', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain || req.query?.domain);
  if (!isValidDomain(domain)) {
    return res.status(400).json({ message: '域名格式无效' });
  }
  const settings = readSettings(req.user.id);
  const cfg = mailpitConfig(settings);
  try {
    const dns = await checkDomainDns(domain, cfg);
    res.json(dns);
  } catch (error) {
    res.status(500).json({ message: `DNS 检测失败：${String(error.message || error).slice(0, 160)}` });
  }
});

function webhookHandler(req, res) {
  const token = String(req.query.token || req.headers['x-mailpit-token'] || '').trim();
  try {
    const db = require('../db');
    const { readSettings: read } = require('../utils/settings');
    const secrets = db.prepare('SELECT id FROM users').all()
      .map((row) => mailpitConfig(read(row.id)).webhook_secret)
      .filter(Boolean);
    if (secrets.length && !secrets.some((secret) => verifyWebhookSecret({ mailpit: { webhook_secret: secret } }, token))) {
      return res.status(401).json({ message: 'webhook 密钥无效' });
    }
  } catch {
    /* ignore lookup errors; still ack so Mailpit does not retry forever */
  }
  res.status(204).end();
}

module.exports = router;
module.exports.webhookHandler = webhookHandler;
