'use strict';

/**
 * Minimal gpt-plus glue for the MK GCash port.
 * Old gcashPayJob / H5 poll is not used when MK_GCASH=1.
 */

const { mkGcashEnabled } = require('./enabled');
const { manager: chainManager } = require('./gcashChain');
const paymentMonitor = require('./paymentMonitor').manager;
const { toChainProxy } = require('./proxyAdapt');
const { PNG_SIGNATURE, INITIAL_QR_CAPTURE_TIMEOUT, sleep, tokenHex } = require('./protocol');
const { encodeExtractLink } = require('../utils/accountFields');
const {
  markGcashExtracted,
  updateGcashQrImage,
  markPaid,
  extractLinkState,
  PROGRESS,
} = require('../utils/accountProgress');

const leases = new Map();

function leaseKey(userId, accountId) {
  return `${String(userId)}:${String(accountId)}`;
}

function getLease(userId, accountId) {
  return leases.get(leaseKey(userId, accountId)) || null;
}

function setLease(userId, accountId, lease) {
  leases.set(leaseKey(userId, accountId), { ...lease, userId, accountId: Number(accountId) });
}

function qrDataUrl(png) {
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return '';
  return `data:image/png;base64,${png.toString('base64')}`;
}

function remainingMs(expiresAt, now = Date.now()) {
  const exp = Number(expiresAt || 0);
  if (!exp) return 0;
  const expMs = exp > 1e12 ? exp : exp * 1000;
  return Math.max(0, expMs - now);
}

function monitorToWallStatus(monitor, paid) {
  const status = monitor.status || 'unavailable';
  if (paid || status === 'completed') return 'plus';
  if (status === 'expired') return 'expired';
  if (status === 'callback_processing' || status === 'redirect_captured') return 'processing';
  if (status === 'callback_unconfirmed' || status === 'callback_failed') return 'continue_success';
  if (status === 'refreshing') return 'waiting_scan';
  return 'waiting_scan';
}

async function waitForQr(monitorId, timeoutSeconds = INITIAL_QR_CAPTURE_TIMEOUT) {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const status = paymentMonitor.status(monitorId);
    if (status.qr_ready) return paymentMonitor.qrImage(monitorId);
    if (['failed', 'abandoned', 'callback_failed'].includes(status.status)) break;
    await sleep(0.35);
  }
  return paymentMonitor.qrImage(monitorId);
}

/**
 * Run the open-source chain for one gpt-plus account. Does not write fake AT/email.
 */
async function waitSessionTask(jobId, clientId, cancelCheck, onUpdate) {
  let lastKey = '';
  while (true) {
    if (cancelCheck?.()) {
      chainManager.cancelSession(jobId);
      throw Object.assign(new Error('TASK_CANCELLED: 用户已停止任务'), { code: 'JOB_CANCELLED' });
    }
    const session = chainManager.getSession(jobId);
    const task = (session?.tasks || []).find((item) => item.client_account_id === clientId);
    if (!task) throw new Error('任务不存在');
    const key = `${task.status}|${task.current_step}|${task.error_message || ''}|${task.attempts_used || 0}`;
    if (onUpdate && key !== lastKey) {
      lastKey = key;
      try { onUpdate(task); } catch { /* ignore */ }
    }
    if (task.status === 'success' || task.status === 'failed') return task;
    await sleep(0.25);
  }
}

async function extractOne({
  userId,
  accountId,
  token,
  chatgptAccountId,
  email,
  name,
  proxy,
  proxyPool = [],
  maxAttempts = 5,
  cancelCheck = null,
  onUpdate = null,
}) {
  const jobId = chainManager.createSession();
  const clientId = `acct_${tokenHex(8)}`;
  const chainProxy = toChainProxy(proxy);
  const chainPool = (proxyPool.length ? proxyPool : (chainProxy ? [chainProxy] : []))
    .map(toChainProxy)
    .filter(Boolean);
  chainManager.submitJobs(jobId, [{
    token,
    account_id: chatgptAccountId || '',
    billing_email: email || '',
    billing_name: name || '',
    client_account_id: clientId,
    proxy: chainProxy,
    proxy_pool: chainPool,
    max_attempts: maxAttempts,
  }]);
  const task = await waitSessionTask(jobId, clientId, cancelCheck, onUpdate);
  if (task.status !== 'success') {
    throw Object.assign(new Error(task.error_message || 'MK GCash 提链失败'), {
      status: 502,
      recoverable: true,
      mk_result: task,
    });
  }
  let qrPng = Buffer.alloc(0);
  if (task.monitor_id) qrPng = await waitForQr(task.monitor_id);
  setLease(userId, accountId, {
    jobId,
    clientId,
    monitorId: task.monitor_id,
    cid: '',
    proxy,
  });
  const qr = qrDataUrl(qrPng);
  markGcashExtracted(userId, accountId, {
    gcash_link: encodeExtractLink(task.gcash_url),
    gcash_qr: qr,
    gcash_cs_id: '',
  });
  return {
    link: task.gcash_url,
    qr,
    cs_id: '',
    monitor_id: task.monitor_id,
    flow: task.payment_route || 'adyen_redirect',
  };
}

function applyPaidIfNeeded(userId, row, monitor) {
  if (!monitor || monitor.status !== 'completed') return false;
  if (String(row.activated_at || '').trim() || row.progress === PROGRESS.PAID) return true;
  markPaid(userId, row.id, {
    plan_type: 'Plus',
    extract_link: row.extract_link || '',
    extracted_at: row.extracted_at || '',
  });
  try { require('../utils/accountGcPipeline').notePaidForRt(userId, row.id); } catch { /* optional */ }
  return true;
}

function paywallView(row, userId, options = {}) {
  const { toDetail } = require('../utils/accountFields');
  const detail = options.detail || toDetail(row);
  const now = Number(options.now || Date.now());
  const lease = getLease(userId, row.id);
  const monitor = lease?.monitorId ? paymentMonitor.status(lease.monitorId) : { status: 'unavailable' };
  const paid = options.paid != null
    ? Boolean(options.paid)
    : Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID
      || monitor.status === 'completed';
  const qrPng = lease?.monitorId ? paymentMonitor.qrImage(lease.monitorId) : Buffer.alloc(0);
  const liveQr = qrDataUrl(qrPng);
  if (liveQr && liveQr !== detail.gcash_qr) {
    try { updateGcashQrImage(userId, row.id, liveQr); } catch { /* keep serving live */ }
  }
  const expiresAt = monitor.expires_at;
  const qrRemaining = remainingMs(expiresAt, now);
  const expired = monitor.status === 'expired' || (!paid && lease && monitor.status === 'unavailable' && extractLinkState(detail, now) === 'expired');
  const processing = !paid && ['redirect_captured', 'callback_processing'].includes(monitor.status);
  const qrValue = liveQr || String(detail.gcash_qr || '');
  const scannable = Boolean(qrValue && !paid && !expired && !processing && qrRemaining > 0 && monitor.qr_ready);
  const refreshable = Boolean(!paid && !expired && monitor.refresh_available);
  let status = monitorToWallStatus(monitor, paid);
  if (paid) status = 'plus';
  else if (expired) status = 'expired';
  const continueSubmitted = ['callback_processing', 'callback_unconfirmed', 'completed'].includes(monitor.status);
  return {
    id: Number(row.id),
    email: String(detail.email || ''),
    paid,
    expired,
    qr: scannable ? qrValue : (paid ? '' : qrValue),
    link: options.includeLink ? String(monitor.gcash_url || detail.gcash_link || '') : undefined,
    link_available: Boolean(monitor.gcash_url || detail.gcash_link),
    progress: paid ? PROGRESS.PAID : row.progress,
    phase: paid ? 'paid' : (monitor.status || 'monitor_active'),
    status,
    scannable,
    processing,
    refreshable,
    refresh_code: refreshable ? '' : (lease ? '' : 'SESSION_MISSING'),
    refresh_message: monitor.status === 'unavailable' && !paid ? (lease ? '' : '会话已失效，需要新号重新出码') : '',
    refreshing: monitor.status === 'refreshing',
    continue_submitted: continueSubmitted && !paid,
    continue_error: monitor.status === 'callback_failed' ? (monitor.error || '支付回调失败') : '',
    h5_alive: Boolean(lease?.monitorId) && !['failed', 'abandoned', 'unavailable'].includes(monitor.status),
    h5_url_kind: '',
    has_consult_uuid: false,
    qr_ttl_ms: 5 * 60 * 1000,
    qr_remaining_ms: qrRemaining,
    url_ttl_ms: 5 * 60 * 1000,
    url_remaining_ms: qrRemaining,
    monitoring: Boolean(lease?.monitorId) && !paid,
    payment_status: monitor.status || 'unavailable',
    payment_success: paid,
    qr_source: monitor.qr_source || '',
    qr_version: Number(monitor.qr_version || 0),
    mk: true,
  };
}

function wallRows(userId) {
  const db = require('../db');
  const rows = db.prepare(
    `SELECT * FROM gpt_accounts
     WHERE user_id = ? AND COALESCE(channel, 'gb') = 'gc'
     ORDER BY id ASC`,
  ).all(userId);
  return rows.filter((row) => {
    if (Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID) {
      return false;
    }
    const detail = require('../utils/accountFields').toDetail(row);
    const lease = getLease(userId, row.id);
    return Boolean(lease?.monitorId || detail.gcash_link || detail.gcash_qr);
  });
}

async function paywallWall(userId) {
  const rows = wallRows(userId);
  for (const row of rows) {
    const lease = getLease(userId, row.id);
    if (!lease?.monitorId) continue;
    const monitor = paymentMonitor.status(lease.monitorId);
    applyPaidIfNeeded(userId, row, monitor);
  }
  const now = Date.now();
  return {
    items: wallRows(userId)
      .map((row) => paywallView(row, userId, { now }))
      .sort((a, b) => a.qr_remaining_ms - b.qr_remaining_ms || a.id - b.id),
    polled_at: now,
    mk: true,
  };
}

function ownedGcashRow(userId, id) {
  const db = require('../db');
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw Object.assign(new Error('记录不存在'), { status: 404, code: 'NOT_FOUND' });
  if (String(row.channel || 'gb').trim().toLowerCase() !== 'gc') {
    throw Object.assign(new Error('该账号不是 GC 通道'), { status: 400, code: 'ACCOUNT_CHANNEL_MISMATCH' });
  }
  return row;
}

async function refreshPaywallQr(userId, id, options = {}) {
  const row = ownedGcashRow(userId, id);
  if (Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID) {
    throw Object.assign(new Error('该账号已完成支付'), { status: 409, code: 'ALREADY_PAID' });
  }
  const lease = getLease(userId, id);
  if (!lease?.monitorId) {
    throw Object.assign(new Error('原 GCash 页面已释放，需要重新提链'), { status: 409, code: 'SESSION_MISSING' });
  }
  const result = await paymentMonitor.refresh(lease.monitorId);
  const qr = qrDataUrl(paymentMonitor.qrImage(lease.monitorId));
  if (qr) updateGcashQrImage(userId, id, qr);
  const fresh = ownedGcashRow(userId, id);
  return {
    ok: true,
    refreshed: true,
    item: paywallView(fresh, userId, { includeLink: Boolean(options.includeLink) }),
    status: result.status,
  };
}

async function refreshPaywallWall(userId) {
  const candidates = wallRows(userId).filter((row) => {
    const view = paywallView(row, userId);
    return view.refreshable && !view.processing && view.qr_remaining_ms <= 30 * 1000;
  });
  const results = [];
  for (const row of candidates) {
    try {
      const result = await refreshPaywallQr(userId, row.id);
      results.push({ id: row.id, ok: Boolean(result.ok), refreshed: Boolean(result.refreshed), code: result.code || '' });
    } catch (error) {
      results.push({ id: row.id, ok: false, refreshed: false, code: error.code || 'REFRESH_FAILED' });
    }
  }
  return {
    requested: candidates.length,
    refreshed: results.filter((item) => item.refreshed).length,
    results,
    ...await paywallWall(userId),
  };
}

async function payStatus(userId, id) {
  const row = ownedGcashRow(userId, id);
  const lease = getLease(userId, id);
  const monitor = lease?.monitorId ? paymentMonitor.status(lease.monitorId) : { status: 'unavailable' };
  const paid = applyPaidIfNeeded(userId, row, monitor)
    || Boolean(String(row.activated_at || '').trim())
    || row.progress === PROGRESS.PAID;
  const fresh = ownedGcashRow(userId, id);
  const detail = require('../utils/accountFields').toDetail(fresh);
  return {
    ...paywallView(fresh, userId, { paid, includeLink: true }),
    cs_id: detail.gcash_cs_id || '',
  };
}

function ensureGcashPayMonitor() {
  return Promise.resolve({ ok: true, skipped: true, reason: 'mk_monitor_inline' });
}

function reserveGcashPayMonitor() {
  return { ok: true, skipped: true, reason: 'mk_monitor_inline' };
}

function releaseGcashPayMonitorReservation() {
  return false;
}

function activateReservedGcashPayMonitor() {
  return Promise.resolve({ ok: true, skipped: true, reason: 'mk_monitor_inline' });
}

module.exports = {
  mkGcashEnabled,
  extractOne,
  getLease,
  paywallWall,
  paywallView,
  refreshPaywallQr,
  refreshPaywallWall,
  payStatus,
  ensureGcashPayMonitor,
  reserveGcashPayMonitor,
  releaseGcashPayMonitorReservation,
  activateReservedGcashPayMonitor,
};
