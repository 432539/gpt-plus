'use strict';

const { cfMailConfig, normalizeDomain } = require('./cfMail');

function parseDomainList(value) {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => String(item || '').split(/[\s,;，；]+/))
    : String(value || '').split(/[\s,;，；]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const domain = normalizeDomain(part);
    if (!domain || seen.has(domain)) continue;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

function workerBase(settings) {
  const cfg = cfMailConfig(settings);
  if (!cfg.api_url || !cfg.api_key) {
    throw Object.assign(new Error('请先配置 CF Worker 邮箱接口'), { status: 400, code: 'CFWORKER_MAIL_NOT_CONFIGURED' });
  }
  return cfg;
}

async function workerJson(settings, path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const cfg = workerBase(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cfg.api_url}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${cfg.api_key}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.message || `邮箱管理 HTTP ${response.status}`);
      err.status = response.status === 401 ? 400 : 502;
      err.code = response.status === 404 ? 'WORKER_NOT_FOUND' : 'CFWORKER_MAIL_ERROR';
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function addWorkerDomains(settings, domains, { test = true } = {}) {
  const list = parseDomainList(domains);
  if (!list.length) throw Object.assign(new Error('请填写至少一个域名'), { status: 400 });
  return workerJson(settings, '/admin/domains', {
    method: 'POST',
    body: { domains: list, test },
    timeoutMs: 60000,
  });
}

async function testWorkerDomains(settings, domains) {
  const list = parseDomainList(domains);
  return workerJson(settings, '/admin/domains/test', {
    method: 'POST',
    body: { domains: list },
    timeoutMs: 45000,
  });
}

async function listWorkerDomains(settings) {
  const data = await workerJson(settings, '/api/config');
  return parseDomainList(data.emailDomains || data.domains || []);
}

module.exports = {
  parseDomainList,
  workerJson,
  addWorkerDomains,
  testWorkerDomains,
  listWorkerDomains,
};
