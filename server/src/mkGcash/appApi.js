'use strict';

/**
 * Corresponds to app.py job/account parsing and public API helpers.
 */

const crypto = require('node:crypto');
const {
  ensureFullChainProxySupported,
  parseProxy,
  tokenHex,
} = require('./protocol');
const { QueueFullError, manager: chainManager } = require('./gcashChain');
const {
  MAX_ACCOUNTS,
  MAX_PROXIES,
  MAX_CONCURRENCY,
  MAX_SESSION_CONCURRENCY,
  MAX_QUEUE,
} = require('./limits');

const JWT_RE = /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/;
const JOB_RE = /^local_[a-f0-9]{16}$/;
const CLIENT_RE = /^acct_[a-f0-9]{16}$/;
const JOB_RETENTION_SECONDS = 60 * 60;
const JOB_META = new Map();

const ABANDONABLE_MONITOR_STATUSES = new Set([
  'starting', 'waiting_scan', 'refreshing', 'redirect_captured',
  'callback_processing', 'expired',
]);

function decodeJwtPayload(token) {
  try {
    let part = String(token).split('.')[1];
    part += '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function tokenFromText(value) {
  const match = JWT_RE.exec(String(value || ''));
  return match ? match[1] : '';
}

function lineFields(line) {
  line = String(line || '').trim();
  if (!line) return { token: '', email: '', name: '' };
  let email = '';
  let name = '';
  const parts = line.split('|').map((part) => part.trim());
  if (parts.length >= 3) {
    name = parts.slice(0, -2).join('|').trim();
    if (parts[parts.length - 2].includes('@')) email = parts[parts.length - 2];
  } else if (parts.length === 2) {
    if (parts[0].includes('@')) email = parts[0];
    else name = parts[0];
  }
  return { token: tokenFromText(line), email, name };
}

function accountFromToken(token, explicitEmail = '', explicitName = '') {
  if (!token || token.length > 32768) throw new Error('AT 格式无效');
  const payload = decodeJwtPayload(token);
  const profile = payload['https://api.openai.com/profile'];
  const auth = payload['https://api.openai.com/auth'];
  const profileObj = profile && typeof profile === 'object' ? profile : {};
  const authObj = auth && typeof auth === 'object' ? auth : {};
  let expiresAt = payload.exp;
  try { expiresAt = expiresAt != null ? Number(expiresAt) : null; } catch { expiresAt = null; }
  if (!Number.isFinite(expiresAt)) expiresAt = null;
  if (expiresAt != null && expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error('AT 已过期');
  }
  const email = String(
    explicitEmail
    || profileObj.email
    || payload.email
    || payload.preferred_username
    || '',
  ).trim();
  const name = String(
    explicitName
    || profileObj.name
    || payload.name
    || payload.given_name
    || '',
  ).trim();
  const accountId = String(
    authObj.chatgpt_account_id
    || payload.chatgpt_account_id
    || payload.account_id
    || '',
  ).trim();
  return { token, email, name, account_id: accountId, expires_at: expiresAt };
}

function parseAccounts(payload) {
  const candidates = [];
  const rawText = payload.tokens || '';
  if (rawText) {
    if (typeof rawText !== 'string') throw new Error('tokens 必须是字符串');
    rawText.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      const parsed = lineFields(line);
      candidates.push([index + 1, parsed.token, parsed.email, parsed.name]);
    });
  }
  const rawAccounts = payload.accounts || [];
  if (rawAccounts && rawAccounts.length) {
    if (!Array.isArray(rawAccounts)) throw new Error('accounts 必须是数组');
    const baseLine = candidates.length;
    rawAccounts.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        candidates.push([baseLine + index + 1, '', '', '']);
        return;
      }
      const token = tokenFromText(item.access_token || item.token || item.authorization);
      candidates.push([
        baseLine + index + 1,
        token,
        String(item.email || '').trim(),
        String(item.name || '').trim(),
      ]);
    });
  }
  if (!candidates.length) throw new Error('请至少提交一个 AT');
  if (candidates.length > MAX_ACCOUNTS) {
    throw new Error(`当前部署每次最多提交 ${MAX_ACCOUNTS} 个账号`);
  }
  const parsed = [];
  const warnings = [];
  const seen = new Set();
  for (const [lineNumber, token, email, name] of candidates) {
    if (!token) {
      warnings.push({ line: lineNumber, error: '未找到 JWT AT' });
      continue;
    }
    const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    if (seen.has(tokenHash)) {
      warnings.push({ line: lineNumber, error: '重复 AT，已跳过' });
      continue;
    }
    try {
      parsed.push(accountFromToken(token, email, name));
    } catch (exc) {
      warnings.push({ line: lineNumber, error: String(exc.message || exc) });
      continue;
    }
    seen.add(tokenHash);
  }
  if (!parsed.length) throw new Error(warnings[0]?.error || '没有可用账号');
  return { accounts: parsed, warnings };
}

function parseProxyPool(value) {
  let rawItems;
  if (typeof value === 'string') rawItems = value.split(/\r?\n/);
  else if (Array.isArray(value)) rawItems = value;
  else throw new Error('proxy_pool 必须是字符串或数组');
  const pool = [];
  const seen = new Set();
  for (const rawProxy of rawItems) {
    const proxy = String(rawProxy || '').trim();
    if (!proxy || seen.has(proxy)) continue;
    if (proxy.length > 1024 || /\s/.test(proxy)) throw new Error('代理格式无效');
    try {
      const parsed = parseProxy(proxy);
      ensureFullChainProxySupported(proxy);
      if (!parsed.host || !parsed.port || !(parsed.port >= 1 && parsed.port <= 65535)) {
        throw new Error('代理格式无效');
      }
    } catch (exc) {
      throw new Error(String(exc.message || exc) || '代理格式无效');
    }
    seen.add(proxy);
    pool.push(proxy);
    if (pool.length > MAX_PROXIES) throw new Error(`自备代理最多 ${MAX_PROXIES} 条`);
  }
  if (!pool.length) throw new Error('请填写至少一个 PH 住宅代理');
  return pool;
}

function cleanupMeta() {
  const cutoff = Date.now() / 1000 - JOB_RETENTION_SECONDS;
  for (const [jobId, meta] of JOB_META.entries()) {
    if (meta.created < cutoff) JOB_META.delete(jobId);
  }
  chainManager.cleanup();
}

function createJob(payload) {
  if (payload.proxy_mode != null && payload.proxy_mode !== '' && payload.proxy_mode !== 'custom') {
    throw new Error('开源版仅支持用户自备代理池');
  }
  const { accounts, warnings } = parseAccounts(payload);
  const proxyPool = parseProxyPool(payload.proxy_pool || []);
  let maxAttempts;
  try { maxAttempts = Number.parseInt(payload.max_attempts ?? 5, 10); } catch {
    throw new Error('max_attempts 必须是整数');
  }
  if (!Number.isInteger(maxAttempts)) throw new Error('max_attempts 必须是整数');
  if (!(maxAttempts >= 1 && maxAttempts <= 10)) throw new Error('max_attempts 必须在 1 到 10 之间');

  cleanupMeta();
  const jobId = chainManager.createSession();
  const taskPayloads = [];
  const accountMeta = {};
  accounts.forEach((account, index) => {
    const clientId = `acct_${tokenHex(8)}`;
    accountMeta[clientId] = {
      email: account.email,
      name: account.name,
      expires_at: account.expires_at,
    };
    taskPayloads.push({
      token: account.token,
      account_id: account.account_id,
      billing_email: account.email,
      billing_name: account.name,
      client_account_id: clientId,
      proxy: proxyPool[index % proxyPool.length],
      proxy_pool: proxyPool,
      max_attempts: maxAttempts,
    });
  });
  try {
    chainManager.submitJobs(jobId, taskPayloads);
  } catch (exc) {
    chainManager.discardSession(jobId);
    throw exc;
  }
  JOB_META.set(jobId, {
    created: Date.now() / 1000,
    accounts: accountMeta,
    warnings,
  });
  return publicJob(jobId);
}

function jobMeta(jobId) {
  if (!JOB_RE.test(String(jobId || ''))) throw Object.assign(new Error('任务不存在'), { httpStatus: 404 });
  const meta = JOB_META.get(jobId);
  if (!meta) throw Object.assign(new Error('任务不存在或已清理'), { httpStatus: 404 });
  return meta;
}

function findTask(jobId, clientId) {
  jobMeta(jobId);
  if (!CLIENT_RE.test(String(clientId || ''))) {
    throw Object.assign(new Error('账号任务不存在'), { httpStatus: 404 });
  }
  for (const task of chainManager.getTasks(jobId)) {
    if (task.client_account_id === clientId) return task;
  }
  throw Object.assign(new Error('账号任务不存在'), { httpStatus: 404 });
}

function publicTask(jobId, task, meta) {
  const clientId = task.client_account_id || '';
  const account = (meta.accounts || {})[clientId] || {};
  let monitor = {};
  const monitorId = task.monitor_id || '';
  if (monitorId) monitor = chainManager.monitorStatus(monitorId) || {};
  const monitorStatus = monitor.status || task.callback_status || 'unavailable';
  let callbackError = '';
  if (monitorStatus === 'callback_unconfirmed') callbackError = '回调已受理，但未确认 Plus 权益到账';
  else if (monitorStatus === 'callback_failed') callbackError = '支付回调失败';
  else if (monitorStatus === 'expired') callbackError = '二维码已过期';
  const status = task.status || 'queued';
  const link = task.gcash_url || monitor.gcash_url || '';
  const qrReady = Boolean(monitor.qr_ready);
  return {
    id: clientId,
    email: account.email || '',
    name: account.name || '',
    status,
    current_step: task.current_step || '',
    steps: task.steps || [],
    queue_position: task.queue_position,
    attempts_used: Number(task.attempts_used || 0),
    error: task.error_message || callbackError,
    link_ready: status === 'success' && Boolean(link),
    link,
    expires_at: monitor.expires_at || task.expires_at,
    qr_ready: qrReady,
    qr_source: monitor.qr_source || '',
    qr_version: Number(monitor.qr_version || 0),
    qr_url: monitorId && qrReady ? `/api/mk-gcash/jobs/${jobId}/accounts/${clientId}/qr.png` : '',
    refresh_available: Boolean(monitor.refresh_available),
    payment_status: monitorStatus,
    payment_success: monitorStatus === 'completed',
  };
}

function publicJob(jobId) {
  const meta = jobMeta(jobId);
  const session = chainManager.getSession(jobId);
  if (!session) throw Object.assign(new Error('任务不存在或已清理'), { httpStatus: 404 });
  const items = (session.tasks || []).map((task) => publicTask(jobId, task, meta));
  return {
    job_id: jobId,
    done: Boolean(session.done),
    accounts: items,
    warnings: [...(meta.warnings || [])],
    queue: chainManager.queueStatus(),
  };
}

async function cancelJob(jobId) {
  jobMeta(jobId);
  const summary = chainManager.cancelSession(jobId);
  return { ok: true, ...summary, job: publicJob(jobId) };
}

async function refreshAccount(jobId, clientId) {
  const task = findTask(jobId, clientId);
  const monitorId = task.monitor_id || '';
  if (!monitorId) throw Object.assign(new Error('该账号尚未生成可刷新的 GCash 页面'), { httpStatus: 409 });
  await chainManager.refreshMonitor(monitorId);
  return publicTask(jobId, findTask(jobId, clientId), jobMeta(jobId));
}

async function abandonAccount(jobId, clientId) {
  const task = findTask(jobId, clientId);
  const monitorId = task.monitor_id || '';
  if (task.status !== 'success' || !monitorId) {
    throw Object.assign(new Error('该账号没有活动支付监控'), { httpStatus: 409 });
  }
  const status = (chainManager.monitorStatus(monitorId).status) || 'unavailable';
  if (status === 'completed') throw Object.assign(new Error('支付已经完成'), { httpStatus: 409 });
  if (!ABANDONABLE_MONITOR_STATUSES.has(status)) {
    throw Object.assign(new Error('当前支付监控已经结束'), { httpStatus: 409 });
  }
  await chainManager.abandonMonitor(monitorId);
  return publicTask(jobId, findTask(jobId, clientId), jobMeta(jobId));
}

async function abandonJob(jobId) {
  jobMeta(jobId);
  const session = chainManager.getSession(jobId);
  if (!session) throw Object.assign(new Error('任务不存在或已清理'), { httpStatus: 404 });
  if (!session.done) throw Object.assign(new Error('提链任务尚未完成，请先停止任务'), { httpStatus: 409 });
  let abandoned = 0;
  for (const task of session.tasks || []) {
    const monitorId = task.monitor_id || '';
    if (task.status !== 'success' || !monitorId) continue;
    const status = (chainManager.monitorStatus(monitorId).status) || 'unavailable';
    if (ABANDONABLE_MONITOR_STATUSES.has(status)) {
      await chainManager.abandonMonitor(monitorId);
      abandoned += 1;
    }
  }
  return { ok: true, abandoned, job: publicJob(jobId) };
}

function accountQr(jobId, clientId) {
  const task = findTask(jobId, clientId);
  const monitorId = task.monitor_id || '';
  return monitorId ? chainManager.monitorQrImage(monitorId) : Buffer.alloc(0);
}

function health() {
  return {
    ok: true,
    queue: chainManager.queueStatus(),
    limits: { max_accounts: MAX_ACCOUNTS },
  };
}

module.exports = {
  JWT_RE,
  JOB_RE,
  CLIENT_RE,
  QueueFullError,
  parseAccounts,
  parseProxyPool,
  accountFromToken,
  createJob,
  publicJob,
  publicTask,
  cancelJob,
  refreshAccount,
  abandonAccount,
  abandonJob,
  accountQr,
  health,
  findTask,
  jobMeta,
  chainManager,
  MAX_CONCURRENCY,
  MAX_SESSION_CONCURRENCY,
  MAX_QUEUE,
};
