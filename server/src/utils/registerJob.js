const db = require('../db');
const crypto = require('crypto');
const { decrypt } = require('./crypto');
const { disableMailcomPullSuffix, readSettings, cloakLicenseKeys, cloakLicenseConfigured } = require('./settings');
const { normalizeSuffixList } = require('./mailcomDomains');
const { toColumns, toDetail, INSERT_COLUMNS, valuesForInsert } = require('./accountFields');
const { resolveTrial } = require('./accountCheck');
const { PROGRESS } = require('./accountProgress');
const { jobSlotKey, normalizeChannel, isGcChannel, occupiedAccountEmailsSql } = require('./accountChannel');
const { checkWritable, getPlanContext } = require('./plan');
const { waitMailOtp } = require('./mailOtp');
const { allocateMailpitAddresses, mailpitReady, waitMailpitOtp } = require('./mailpit');
const { getMother } = require('./mailcomService');
const { selectUnusedForRegister, suffixStatsForUser, suffixOfAddress } = require('./suffixPick');
const opLog = require('./opLog');
const { REGISTER_CONGRATS_COPY } = require('./registerLogCopy');
const {
  createMailChannel,
  createPhoneChannel,
  parseImportedMailboxList,
  providerName,
  settleChannel,
} = require('../automation/channels/providers');
const {
  countryCode,
  countryFromGroup,
  isAutoProxyGroup,
  MAX_ACQUIRE_ATTEMPTS,
  ProxyExitLeaseManager,
} = require('./dynamicProxy');
const { detectProxyGeo } = require('./proxyGeo');
const { requireChannelDynamicProxy, channelCountry, channelAutoGroup } = require('./channelProxy');
const {
  AVAILABLE,
  effectiveProxyRegion,
  isPaymentProxyGroup,
  isRegisterProxyGroup,
  keepRegistrationProxy,
} = require('./paymentProxy');
const {
  REGISTER_MAX_ATTEMPTS,
  BATCH_INFRASTRUCTURE_FAILURE_CODES,
  CAPACITY_FAILURE_CODES,
  classifyRegisterFailure,
  registerRetryDelayMs,
  registerFailureRetryDelayMs,
} = require('../automation/lib/retry-policy');
const { isAccountCreationRejectedFailure } = require('../automation/lib/account-creation-reject');
const {
  calculateRegisterThroughput,
  planRegisterMailboxPipeline,
  createRegisterMailboxPipeline,
  normalizeRegisterPerformanceProfile,
  planRegisterRuntimeLimits,
} = require('../automation/lib/register-performance');
const { config: automationConfig } = require('../automation/config');
const { HeroSmsGuard } = require('../automation/lib/herosms-guard');
const { remainingDailyRegisters } = require('./pipelineCaps');
const {
  cfMailReady,
  enabledCfDomains,
  splitMailMix,
  interleaveRows,
  disableCfMailSuffix,
} = require('./cfMail');
const { pickQuotaSuffix, selectUnusedUnderQuota } = require('./suffixQuota');

const REGISTER_CONCURRENCY_CAP = 200;
const REGISTER_BATCH_LIMIT = 2000;
const CAPACITY_MAX_ATTEMPTS = 12;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CONSUMING_STAGES = new Set(['password_submission', 'passwordless_email_otp_send']);
const TERMINAL_JOB_STATUSES = new Set(['success', 'failed', 'cancelled', 'skipped', 'partial']);
const INFRASTRUCTURE_CODES = new Set(BATCH_INFRASTRUCTURE_FAILURE_CODES);
const CAPACITY_CODES = new Set(CAPACITY_FAILURE_CODES);
const PROXY_LEASE_CODES = new Set([
  'PROXY_EXIT_COLLISION', 'PROXY_EXIT_INVALID', 'PROXY_EXIT_COUNTRY_MISMATCH', 'PROXY_EXIT_PROBE_FAILED',
]);
const jobs = new Map();
const proxyExitLeases = new ProxyExitLeaseManager({ probe: detectProxyGeo });
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function emptyState() {
  return {
    run_id: '',
    running: false,
    stop: false,
    finished: false,
    target: 0,
    success: 0,
    failed: 0,
    retried: 0,
    attempted: 0,
    completed: 0,
    concurrency: 0,
    proxy_group: '',
    current_email: '',
    message: '',
    started_at: '',
    updated_at: '',
    finished_at: '',
    interrupted: false,
    unused: 0,
  };
}

function persistedState(row) {
  if (!row) return emptyState();
  return {
    ...emptyState(),
    run_id: row.run_id || '',
    running: Boolean(row.running),
    finished: Boolean(row.finished),
    interrupted: Boolean(row.interrupted),
    target: Number(row.target) || 0,
    success: Number(row.success) || 0,
    failed: Number(row.failed) || 0,
    retried: Number(row.retried) || 0,
    attempted: Number(row.completed) || 0,
    completed: Number(row.completed) || 0,
    concurrency: Number(row.concurrency) || 0,
    proxy_group: row.proxy_group || '',
    message: row.message || '',
    started_at: row.started_at || '',
    updated_at: row.updated_at || '',
    finished_at: row.finished_at || '',
  };
}

function latestPersistedState(userId) {
  const row = db
    .prepare(
      `SELECT r.* FROM registration_runs r
       LEFT JOIN registration_batches b ON b.run_id = r.run_id
       WHERE r.user_id = ?
         AND (b.kind IS NULL OR b.kind = '' OR b.kind = 'register')
       ORDER BY r.started_at DESC, r.updated_at DESC
       LIMIT 1`
    )
    .get(userId);
  return persistedState(row);
}

function persistState(userId, state, { required = false } = {}) {
  state.completed = Number(state.attempted) || 0;
  try {
    db.prepare(
      `INSERT INTO registration_runs (
         run_id, user_id, target, concurrency, completed, success, failed, retried,
         running, finished, interrupted, proxy_group, message, started_at, updated_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), ?)
       ON CONFLICT(run_id) DO UPDATE SET
         completed=excluded.completed, success=excluded.success, failed=excluded.failed,
         retried=excluded.retried, running=excluded.running, finished=excluded.finished,
         interrupted=excluded.interrupted, message=excluded.message,
         updated_at=datetime('now','localtime'), finished_at=excluded.finished_at`
    ).run(
      state.run_id,
      userId,
      state.target,
      state.concurrency,
      state.completed,
      state.success,
      state.failed,
      state.retried,
      state.running ? 1 : 0,
      state.finished ? 1 : 0,
      state.interrupted ? 1 : 0,
      state.proxy_group || '',
      state.message || '',
      state.started_at || '',
      state.finished_at || ''
    );
    return true;
  } catch (error) {
    if (required) throw error;
    console.warn(`注册任务状态保存失败（${state.run_id || 'unknown'}）：`, error.message);
    return false;
  }
}

function parseResult(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

const SENSITIVE_RESULT_KEYS = new Set([
  'password', 'access_token', 'refresh_token', 'id_token', 'session_token',
  'client_secret', 'totp_secret', 'vmail_token', 'gmail_access_token',
  'gmail_refresh_token', 'gmail_client_secret',
]);

function safeJobResult(value) {
  if (Array.isArray(value)) return value.map(safeJobResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_RESULT_KEYS.has(String(key).toLowerCase()))
      .map(([key, child]) => [key, safeJobResult(child)])
  );
}

function jobView(row) {
  const settlements = db.prepare(
    `SELECT settlement_id AS id, resource_type, provider, external_id, action, status,
            error_code, error, retry_at, updated_at
     FROM registration_settlements WHERE job_id = ? ORDER BY created_at`
  ).all(row.job_id);
  return {
    id: row.job_id,
    kind: row.kind || 'register',
    account_id: row.account_id || null,
    email_id: row.email_id,
    email: row.email,
    status: row.status,
    progress: Number(row.progress) || 0,
    attempt: Number(row.attempt) || 0,
    capacity_attempt: Number(row.capacity_attempt) || 0,
    error_code: row.error_code || '',
    error: row.error || '',
    result: parseResult(row.result),
    partial: Boolean(row.partial) || row.status === 'partial',
    started_at: row.started_at || '',
    updated_at: row.updated_at || '',
    finished_at: row.finished_at || '',
    settlements,
  };
}

function channelExternalId(channel, type) {
  if (!channel) return '';
  if (type === 'phone') return String(channel.activation?.activationId || channel.activation?.id || '');
  return String(channel.mailId || channel.activation?.mailId || channel.activation?.id || '');
}

function persistSettlement(jobId, userId, type, provider, channel, action, status, error = null) {
  const externalId = channelExternalId(channel, type);
  if (!externalId) return null;
  const id = `${jobId}:${type}:${externalId}`;
  const retryAt = status === 'pending' || status === 'failed'
    ? new Date(Date.now() + 121000).toISOString() : '';
  db.prepare(
    `INSERT INTO registration_settlements (
       settlement_id, job_id, user_id, resource_type, provider, external_id,
       action, status, error_code, error, retry_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, resource_type, external_id) DO UPDATE SET
       action=excluded.action, status=excluded.status, error_code=excluded.error_code,
       error=excluded.error, retry_at=excluded.retry_at,
       updated_at=datetime('now','localtime')
             WHERE registration_settlements.status NOT IN ('finished','cancelled')
               AND NOT (
                 registration_settlements.status='settling'
                 AND registration_settlements.claim_token<>''
                 AND datetime(registration_settlements.claim_until) > datetime('now')
               )`
  ).run(
    id, jobId, userId, type, provider || '', externalId, action, status,
    String(error?.code || ''), error ? shortError(error) : '', retryAt
  );
  return id;
}

function claimSettlement(settlementId, { leaseMs = 60000, action = '' } = {}) {
  const token = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const until = new Date(Date.now() + Math.max(300, Number(leaseMs) || 60000)).toISOString();
  const changed = db.prepare(
    `UPDATE registration_settlements
     SET action=CASE WHEN ?='' THEN action ELSE ? END,
         status='settling', claim_token=?, claim_until=?, settle_attempt=settle_attempt+1,
         updated_at=datetime('now','localtime')
     WHERE settlement_id=?
       AND status NOT IN ('finished','cancelled')
       AND (claim_token='' OR claim_token IS NULL OR claim_until='' OR claim_until IS NULL OR claim_until<=?)`
  ).run(action, action, token, until, settlementId, nowIso).changes;
  return changed ? token : '';
}

function renewSettlementClaim(settlementId, token, leaseMs = 60000) {
  const until = new Date(Date.now() + Math.max(300, Number(leaseMs) || 60000)).toISOString();
  return db.prepare(
    `UPDATE registration_settlements
     SET claim_until=?,updated_at=datetime('now','localtime')
     WHERE settlement_id=? AND status='settling' AND claim_token=?`
  ).run(until, settlementId, token).changes === 1;
}

function completeSettlementClaim(settlementId, token, status, error = null) {
  const retryAt = ['pending', 'failed', 'ambiguous'].includes(status)
    ? new Date(Date.now() + 121000).toISOString() : '';
  return db.prepare(
    `UPDATE registration_settlements
     SET status=?, error_code=?, error=?, retry_at=?, claim_token='', claim_until='',
         updated_at=datetime('now','localtime')
     WHERE settlement_id=? AND claim_token=?`
  ).run(
    status, String(error?.code || ''), error ? shortError(error) : '', retryAt,
    settlementId, token
  ).changes === 1;
}

function ambiguousSettlementError(error) {
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  return [
    'REQUEST_TIMEOUT', 'REQUEST_FAILED', 'RESPONSE_READ_FAILED', 'SETTLEMENT_CALL_TIMEOUT',
    'PROTOCOL_REQUEST_TIMEOUT', 'PROTOCOL_REQUEST_NETWORK', 'ECONNRESET', 'ETIMEDOUT',
  ].includes(code) || /timeout|timed out|response.*lost|socket|econnreset|network/i.test(
    String(error?.message || error)
  );
}

async function boundedSettlementCall(operation, {
  timeoutMs = 45000, renewClaim = null, renewEveryMs = 10000,
} = {}) {
  const limit = Math.max(100, Math.min(120000, Number(timeoutMs) || 45000));
  const controller = new AbortController();
  const timeoutMarker = Symbol('settlement-timeout');
  let timer;
  const original = Promise.resolve().then(() => operation(controller.signal));
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(timeoutMarker), limit);
  });
  const first = await Promise.race([
    original.then(value => ({ value }), error => ({ error })),
    timeout,
  ]);
  clearTimeout(timer);
  if (first !== timeoutMarker) {
    if (first.error) throw first.error;
    return first.value;
  }

  controller.abort(Object.assign(new Error(`供应商结算超过 ${limit}ms`), {
    code: 'SETTLEMENT_CALL_TIMEOUT',
  }));
  let renewalLost = false;
  let renewTimer = null;
  if (typeof renewClaim === 'function') {
    const renew = () => { if (!renewClaim()) renewalLost = true; };
    renew();
    renewTimer = setInterval(renew, Math.max(100, Number(renewEveryMs) || 10000));
  }
  try {
    await original.catch(() => {});
  } finally {
    if (renewTimer) clearInterval(renewTimer);
  }
  if (renewalLost) {
    throw Object.assign(new Error('供应商调用超时后 claim 续租失败'), {
      code: 'SETTLEMENT_COMPLETION_CAS_LOST',
    });
  }
  throw Object.assign(new Error(`供应商结算超过 ${limit}ms`), {
    code: 'SETTLEMENT_CALL_TIMEOUT',
  });
}

async function settleJobChannel({
  jobId, userId, type, provider, channel, success, log,
  callTimeoutMs = 45000, leaseMs = 60000,
}) {
  if (!channel || !channelExternalId(channel, type)) return { status: 'none' };
  const action = success ? 'finish' : 'cancel';
  let existing = db.prepare(
    `SELECT * FROM registration_settlements
     WHERE job_id=? AND resource_type=? AND external_id=?`
  ).get(jobId, type, channelExternalId(channel, type));
  if (['finished', 'cancelled'].includes(existing?.status)) return { status: existing.status };
  const settlementId = existing?.settlement_id || persistSettlement(
    jobId, userId, type, provider, channel, action, 'open'
  );
  existing = db.prepare('SELECT * FROM registration_settlements WHERE settlement_id=?').get(settlementId);
  const token = claimSettlement(settlementId, { action, leaseMs });
  if (!token) return {
    status: existing?.status || 'settling', action: existing?.action || '',
    claimed: false, conflict: existing?.action && existing.action !== action,
  };
  try {
    const settled = await boundedSettlementCall(
      signal => settleChannel(channel, success, null, { log, signal }),
      {
        timeoutMs: Math.min(callTimeoutMs, Math.max(100, leaseMs - 100)),
        renewClaim: () => renewSettlementClaim(settlementId, token, leaseMs),
        renewEveryMs: Math.max(100, Math.floor(leaseMs / 3)),
      }
    );
    const status = settled === false ? 'pending' : success ? 'finished' : 'cancelled';
    if (!completeSettlementClaim(settlementId, token, status)) {
      throw Object.assign(new Error('结算完成时持久 claim 已失效，结果不能静默提交'), {
        code: 'SETTLEMENT_COMPLETION_CAS_LOST',
        settlementStatus: success ? 'ambiguous' : 'failed',
      });
    }
    return { status };
  } catch (error) {
    const status = success && ambiguousSettlementError(error) ? 'ambiguous' : 'failed';
    const completed = completeSettlementClaim(settlementId, token, status, error);
    if (!completed && error.code !== 'SETTLEMENT_COMPLETION_CAS_LOST') {
      throw Object.assign(new Error('结算异常落盘时持久 claim 已失效'), {
        code: 'SETTLEMENT_COMPLETION_CAS_LOST', settlementStatus: status, cause: error,
      });
    }
    error.settlementStatus = status;
    throw error;
  }
}

function runtimeCapacity(state = {}) {
  const runtime = state.runtime;
  const info = runtime && typeof runtime.info === 'function' ? runtime.info() : {};
  const slots = info.slotStats || {};
  const maxSlots = Number(slots.maxSlots ?? info.maxConcurrency ?? state.concurrency) || 0;
  const configuredSlots = Number(info.configuredMaxConcurrency ?? maxSlots) || maxSlots;
  const resourceSlots = Number(info.resourceMaxConcurrency ?? maxSlots) || maxSlots;
  const reservedSlots = Number(slots.reservedSlots ?? info.reservedSlots) || 0;
  const queuedSlots = Number(slots.queuedSlots ?? info.queuedSlots ?? info.queuedRequests) || 0;
  return {
    max_slots: maxSlots,
    configured_max_slots: configuredSlots,
    resource_max_slots: resourceSlots,
    resource_limited: Boolean(info.resourceLimited) || (configuredSlots > 0 && maxSlots < configuredSlots),
    active_browsers: Number(info.active) || 0,
    reserved_slots: reservedSlots,
    available_slots: Math.max(0, Number(slots.availableSlots ?? info.availableSlots ?? (maxSlots - reservedSlots)) || 0),
    queued_slots: queuedSlots,
    registration_reserved: reservedSlots,
    other_reserved: 0,
  };
}

function batchView(batchId, userId) {
  const batch = db.prepare(
    'SELECT * FROM registration_batches WHERE batch_id = ? AND user_id = ?'
  ).get(batchId, userId);
  if (!batch) return null;
  const results = db.prepare(
    'SELECT * FROM registration_jobs WHERE batch_id = ? ORDER BY rowid'
  ).all(batchId).map(jobView);
  const state = liveRegisterJob(userId, batch.run_id) || {};
  const view = {
    id: batch.batch_id,
    batch_id: batch.batch_id,
    run_id: batch.run_id,
    kind: batch.kind || 'register',
    status: batch.status,
    finished: ['completed', 'cancelled', 'interrupted'].includes(batch.status),
    total: Number(batch.total) || 0,
    completed: Number(batch.completed) || 0,
    success: Number(batch.success) || 0,
    failed: Number(batch.failed) || 0,
    cancelled: Number(batch.cancelled) || 0,
    cancelled_count: Number(batch.cancelled) || 0,
    skipped: Number(batch.skipped) || 0,
    partial: Number(batch.partial) || 0,
    queued: Number(batch.queued) || 0,
    running: Number(batch.running) || 0,
    progress: Number(batch.progress) || 0,
    retried: Number(batch.retried) || 0,
    effective_concurrency: Number(batch.concurrency) || 1,
    proxy_group: batch.proxy_group || '',
    message: batch.message || '',
    circuit_breaker: {
      threshold: CIRCUIT_BREAKER_THRESHOLD,
      code: batch.circuit_code || '',
      count: Number(batch.circuit_count) || 0,
      triggered: Boolean(batch.circuit_triggered),
    },
    created_at: batch.created_at || '',
    updated_at: batch.updated_at || '',
    finished_at: batch.finished_at || '',
    results,
  };
  view.throughput = calculateRegisterThroughput(view, results, {
    capacity: runtimeCapacity(state).max_slots || view.effective_concurrency,
  });
  view.cloak_capacity = runtimeCapacity(state);
  return view;
}

const syncBatchTx = db.transaction((batchId, message = '', forcedStatus = '') => {
  const batch = db.prepare('SELECT * FROM registration_batches WHERE batch_id = ?').get(batchId);
  if (!batch) return null;
  const counts = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(status IN ('success','failed','cancelled','skipped','partial')) AS completed,
       SUM(status = 'success') AS success,
       SUM(status = 'failed') AS failed,
       SUM(status = 'cancelled') AS cancelled,
       SUM(status = 'skipped') AS skipped,
       SUM(status = 'partial' OR partial = 1) AS partial,
       SUM(status = 'queued') AS queued,
       SUM(status = 'running') AS running,
       COALESCE(ROUND(AVG(progress)), 0) AS progress,
       COALESCE(SUM(CASE WHEN attempt > 1 THEN attempt - 1 ELSE 0 END), 0) AS retried
     FROM registration_jobs WHERE batch_id = ?`
  ).get(batchId);
  const finished = Number(counts.completed) >= Number(counts.total);
  const status = forcedStatus || (finished ? (Number(counts.cancelled) ? 'cancelled' : 'completed') : batch.status);
  db.prepare(
    `UPDATE registration_batches SET status=?, total=?, completed=?, success=?, failed=?,
       cancelled=?, skipped=?, partial=?, queued=?, running=?, progress=?, retried=?,
       message=CASE WHEN ? != '' THEN ? ELSE message END,
       updated_at=datetime('now','localtime'),
       finished_at=CASE WHEN ? THEN datetime('now','localtime') ELSE finished_at END
     WHERE batch_id=?`
  ).run(
    status, counts.total, counts.completed, counts.success, counts.failed,
    counts.cancelled, counts.skipped, counts.partial, counts.queued, counts.running,
    finished ? 100 : counts.progress, counts.retried, message, message, finished ? 1 : 0, batchId
  );
  const legacyMessage = message || batch.message || '';
  db.prepare(
    `UPDATE registration_runs SET completed=?, success=?, failed=?, retried=?,
       running=?, finished=?, interrupted=?, message=?,
       updated_at=datetime('now','localtime'),
       finished_at=CASE WHEN ? THEN datetime('now','localtime') ELSE finished_at END
     WHERE run_id=?`
  ).run(
    counts.completed, counts.success, Number(counts.failed) + Number(counts.partial),
    counts.retried, finished ? 0 : 1, finished ? 1 : 0,
    status === 'interrupted' ? 1 : 0, legacyMessage, finished ? 1 : 0, batch.run_id
  );
  return counts;
});

function patchRegistrationJob(jobId, fields = {}) {
  const allowed = ['status', 'progress', 'attempt', 'capacity_attempt', 'error_code', 'error', 'result', 'partial'];
  const updates = [];
  const params = [];
  for (const key of allowed) {
    if (!(key in fields)) continue;
    updates.push(`${key} = ?`);
    if (key === 'result') params.push(fields[key] == null ? '' : JSON.stringify(safeJobResult(fields[key])));
    else if (key === 'partial') params.push(fields[key] ? 1 : 0);
    else params.push(fields[key]);
  }
  if (!updates.length) return;
  if (fields.status === 'running') updates.push("started_at = CASE WHEN started_at = '' THEN datetime('now','localtime') ELSE started_at END");
  if (TERMINAL_JOB_STATUSES.has(fields.status)) updates.push("finished_at = datetime('now','localtime')");
  updates.push("updated_at = datetime('now','localtime')");
  params.push(jobId);
  db.prepare(`UPDATE registration_jobs SET ${updates.join(', ')} WHERE job_id = ?`).run(...params);
  const row = db.prepare('SELECT batch_id FROM registration_jobs WHERE job_id = ?').get(jobId);
  if (row) syncBatchTx(row.batch_id);
}

function interruptBatchRow(batch, message, errorCode = 'PROCESS_RESTARTED') {
  db.prepare(
    `UPDATE registration_jobs
     SET status='cancelled', progress=100, error_code=?,
         error=?,
         finished_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
     WHERE batch_id=? AND status IN ('queued','running')`
  ).run(errorCode, message, batch.batch_id);
  syncBatchTx(batch.batch_id, message, 'interrupted');
  db.prepare(
    `UPDATE registration_batches SET status='interrupted', message=?,
     updated_at=datetime('now','localtime'), finished_at=datetime('now','localtime')
     WHERE batch_id=?`
  ).run(message, batch.batch_id);
  db.prepare(
    `UPDATE registration_runs SET running=0, finished=1, interrupted=1,
     interruption_logged=1, message=?, updated_at=datetime('now','localtime'),
     finished_at=datetime('now','localtime') WHERE run_id=?`
  ).run(message, batch.run_id);
  db.prepare(
    `INSERT INTO operation_logs (user_id, category, level, source, ref, run_id, message)
     SELECT ?, 'register', 'warning', 'register', ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM operation_logs
       WHERE user_id=? AND category='register' AND run_id=? AND message=?
     )`
  ).run(batch.user_id, batch.run_id, batch.run_id, message, batch.user_id, batch.run_id, message);
}

const reconcileStaleRunsTx = db.transaction(() => {
  const staleBatches = db.prepare(
    `SELECT * FROM registration_batches
     WHERE status NOT IN ('completed','cancelled','interrupted')`
  ).all();
  for (const batch of staleBatches) {
    interruptBatchRow(batch, '服务重启，任务中断；已完成结果和账号检查点已保留');
  }
  const stale = db.prepare('SELECT * FROM registration_runs WHERE running = 1').all();
  for (const row of stale) {
    const message = `服务重启，任务中断；已完成 ${row.completed}/${row.target}，成功 ${row.success}，失败 ${row.failed}`;
    db.prepare(
      `UPDATE registration_runs
       SET running = 0, finished = 1, interrupted = 1, message = ?,
           updated_at = datetime('now','localtime'), finished_at = datetime('now','localtime'),
           interruption_logged = 1
       WHERE run_id = ?`
    ).run(message, row.run_id);
    if (!row.interruption_logged) {
      db.prepare(
        `INSERT INTO operation_logs (user_id, category, level, source, ref, run_id, message)
         VALUES (?, 'register', 'warning', 'register', ?, ?, ?)`
      ).run(row.user_id, row.run_id, row.run_id, message);
    }
  }
  return staleBatches.length + stale.length;
});

function reconcileStaleRuns() {
  return reconcileStaleRunsTx();
}

const reconcileDeadKindTx = db.transaction((userId, kind) => {
  const batches = db.prepare(
    `SELECT * FROM registration_batches
     WHERE user_id = ? AND kind = ? AND status NOT IN ('completed','cancelled','interrupted')`
  ).all(userId, kind);
  const message = '流水线看门狗：任务已掉线，残留批次已中断';
  for (const batch of batches) {
    interruptBatchRow(batch, message, 'PIPELINE_WATCHDOG');
  }
  return batches.length;
});

function reconcileDeadKind(userId, kind = 'register') {
  if (kind === 'register' && jobs.get(jobSlotKey(userId, 'gb'))?.running) return 0;
  if (kind === 'register-gc' && jobs.get(jobSlotKey(userId, 'gc'))?.running) return 0;
  return reconcileDeadKindTx(userId, kind);
}

async function reconcilePendingSettlements({
  channelFactory, callTimeoutMs = 45000, leaseMs = 60000,
} = {}) {
  const rows = db.prepare(
    `SELECT s.*, j.email FROM registration_settlements s
     JOIN registration_jobs j ON j.job_id=s.job_id
     WHERE s.status IN ('open','pending','failed','ambiguous','settling')
       AND (s.retry_at='' OR s.retry_at IS NULL OR s.retry_at <= ?)
     ORDER BY s.created_at LIMIT 200`
  ).all(new Date().toISOString());
  let settled = 0;
  let pending = 0;
  let conflicts = 0;
  for (const row of rows) {
    const token = claimSettlement(row.settlement_id, { leaseMs });
    if (!token) continue;
    try {
      const settings = readSettings(row.user_id);
      const heroCfg = settings.herosms || {};
      const heroSmsGuard = new HeroSmsGuard({
        requestsPerSecond: heroCfg.requests_per_second,
        maxRequestConcurrency: heroCfg.max_request_concurrency,
        maxActiveActivations: heroCfg.max_active_activations,
        maxTransientRetries: heroCfg.max_transient_retries,
        transientRetryBaseMs: heroCfg.transient_retry_base_ms,
        banCooldownMs: heroCfg.ban_cooldown_ms,
        rateCooldownMs: heroCfg.rate_cooldown_ms,
      });
      let channel;
      if (channelFactory) channel = await channelFactory(row, settings);
      else if (row.resource_type === 'mail') {
        channel = createMailChannel(row.provider, settings, {}, { heroSmsGuard });
        channel?.restoreActivation?.(row.external_id, row.email);
      } else {
        channel = createPhoneChannel(row.provider, settings, { get_refresh_token: true }, { heroSmsGuard });
        channel?.restoreActivation?.({ activationId: row.external_id, phone: '' });
      }
      if (!channel) throw Object.assign(new Error('无法恢复供应商通道'), { code: 'SETTLEMENT_CHANNEL_UNAVAILABLE' });
      const finish = row.action === 'finish';
      const result = await boundedSettlementCall(
        signal => finish
          ? channel.finish(null, { log: () => {}, signal })
          : channel.cancel(null, { log: () => {}, signal }),
        {
          timeoutMs: Math.min(callTimeoutMs, Math.max(100, leaseMs - 100)),
          renewClaim: () => renewSettlementClaim(row.settlement_id, token, leaseMs),
          renewEveryMs: Math.max(100, Math.floor(leaseMs / 3)),
        }
      );
      const status = result === false ? 'pending' : finish ? 'finished' : 'cancelled';
      if (!completeSettlementClaim(row.settlement_id, token, status)) {
        throw Object.assign(new Error('恢复结算完成时 claim 已失效'), {
          code: 'SETTLEMENT_COMPLETION_CAS_LOST',
        });
      }
      if (['finished', 'cancelled'].includes(status)) settled += 1;
      else pending += 1;
    } catch (error) {
      pending += 1;
      const status = row.action === 'finish' && ambiguousSettlementError(error) ? 'ambiguous' : 'failed';
      const completed = completeSettlementClaim(row.settlement_id, token, status, error);
      if (!completed || error?.code === 'SETTLEMENT_COMPLETION_CAS_LOST') {
        conflicts += 1;
        console.warn(`结算 claim 冲突（${row.settlement_id}）：${error?.code || 'CAS_LOST'}`);
      }
    }
  }
  return { scanned: rows.length, settled, pending, conflicts };
}

function liveRegisterJob(userId, runId) {
  for (const channel of ['gb', 'gc']) {
    const state = jobs.get(jobSlotKey(userId, channel));
    if (!state) continue;
    if (!runId || state.run_id === runId) return state;
  }
  return jobs.get(userId) || null;
}

function status(userId, channel) {
  const slot = jobSlotKey(userId, channel);
  const live = jobs.get(slot);
  const st = live || (isGcChannel(channel) ? { running: false, finished: false, target: 0, success: 0, failed: 0, message: '' } : latestPersistedState(userId));
  const { runtime, ...view } = st;
  const batchKind = isGcChannel(channel) ? 'register-gc' : 'register';
  const batch = db.prepare(
    `SELECT batch_id FROM registration_batches
     WHERE user_id = ? AND (kind = ? OR (? = 'register' AND (kind IS NULL OR kind = '' OR kind = 'register')))
     ORDER BY created_at DESC, updated_at DESC LIMIT 1`
  ).get(userId, batchKind, batchKind);
  const details = batch ? batchView(batch.batch_id, userId) : null;
  return {
    ...view,
    ...(details ? {
      batch_id: details.batch_id,
      queued: details.queued,
      cancelled: details.cancelled,
      skipped: details.skipped,
      partial: details.partial,
      progress: details.progress,
      results: details.results,
      circuit_breaker: details.circuit_breaker,
    } : {}),
  };
}

function isLive(userId, channel) {
  return Boolean(jobs.get(jobSlotKey(userId, channel))?.running);
}

function resolveRegisterProxyGroup(proxyGroup, groups = []) {
  const requested = String(proxyGroup || '').trim();
  if (requested && requested !== '直连') return requested;
  return '__auto__:GB';
}

function listProxyGroups(userId) {
  return db
    .prepare('SELECT group_name, COUNT(*) AS count FROM proxies WHERE user_id = ? GROUP BY group_name ORDER BY group_name')
    .all(userId);
}

function normalizeStartOptions(body = {}, settings = {}, groups = []) {
  const rawCount = body.quantity ?? body.count ?? 1;
  const count = Math.max(1, Math.min(REGISTER_BATCH_LIMIT, Number.parseInt(rawCount, 10) || 1));
  const rawConcurrency = body.concurrency ?? body.threads ?? 1;
  const concurrency = Math.max(1, Math.min(REGISTER_CONCURRENCY_CAP, Number.parseInt(rawConcurrency, 10) || 1));
  const registerMode = String(body.register_mode || '').trim() === 'protocol'
    ? 'protocol'
    : 'headless_click';
  const headless = body.visible === true ? false : body.headless !== false;
  const positiveMs = (value, fallback, min = 1000, max = 30 * 60 * 1000) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  };
  const attempts = Math.max(1, Math.min(REGISTER_MAX_ATTEMPTS, Number.parseInt(
    body.attempts ?? body.max_attempts, 10
  ) || REGISTER_MAX_ATTEMPTS));
  return {
    ...body,
    count,
    quantity: count,
    concurrency,
    mail_provider: providerName(body.mail_provider || settings.registration?.mail_provider || 'mailcom'),
    mail_domain: String(body.mail_domain ?? body.domain ?? '').trim().toLowerCase(),
    proxy_group: resolveRegisterProxyGroup(body.proxy_group, groups),
    proxy_country: countryCode(body.proxy_country || body.country),
    phone_country: countryCode(body.phone_country),
    phone_max_price: body.phone_max_price ?? body.max_price ?? '',
    set_password: body.set_password !== undefined
      ? body.set_password !== false : settings.registration?.set_password !== false,
    enable_totp_2fa: body.enable_totp_2fa !== undefined
      ? body.enable_totp_2fa !== false : settings.registration?.enable_totp_2fa !== false,
    asset_optimization: body.asset_optimization !== undefined
      ? body.asset_optimization !== false : settings.registration?.asset_optimization !== false,
    get_refresh_token: body.get_refresh_token === true || body.durable_credentials === true,
    register_mode: registerMode,
    performance_profile: normalizeRegisterPerformanceProfile(
      body.performance_profile ?? settings.registration?.performance_profile
    ),
    headless,
    humanize: body.humanize !== false && settings.cloak?.humanize !== false,
    attempts: body.attempts === undefined && body.max_attempts === undefined
      ? Math.max(1, Math.min(REGISTER_MAX_ATTEMPTS, Number(settings.registration?.attempts) || attempts))
      : attempts,
    email_timeout_ms: positiveMs(body.email_timeout_ms ?? body.email_timeout, 300000, 10000),
    protocol_timeout_ms: positiveMs(body.protocol_timeout_ms ?? body.request_timeout_ms, 45000, 5000),
    session_wall_timeout_ms: positiveMs(body.session_wall_timeout_ms ?? body.timeout_ms, 10 * 60 * 1000, 30000),
  };
}

function retryableTransportError(error) {
  if (error?.code === 'JOB_CANCELLED') return false;
  if (error?.code === 'PROTOCOL_REQUEST_NETWORK' || error?.code === 'PROTOCOL_REQUEST_TIMEOUT') return true;
  return /failed to fetch|networkerror|load failed|net::|socket hang up|econnreset|browser has been closed|target closed|context or browser has been closed/i.test(
    String(error?.message || error)
  );
}

function shortError(error) {
  const msg = String(error?.message || error).replace(/\s+/g, ' ');
  if (/ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_TUNNEL/i.test(msg)) {
    return '代理隧道被断开，ChatGPT 页面加载失败';
  }
  if (/context or browser has been closed|target closed/i.test(msg)) {
    return 'Cloak 页面被关闭（代理中断或浏览器会话被回收）';
  }
  if (/PROTOCOL_REQUEST_TIMEOUT|协议上下文/.test(msg)) {
    return '通过代理打开 ChatGPT 超时';
  }
  return msg.slice(0, 240);
}

function listUnusedChildren(userId) {
  return db
    .prepare(
      `SELECT * FROM emails
       WHERE user_id = ?
         AND is_mother = 0
         AND mother_id IS NOT NULL
         AND mother_id != 0
         AND status = '未使用'
         AND lower(address) NOT IN (${occupiedAccountEmailsSql()})
       ORDER BY id`
    )
    .all(userId, userId, userId);
}

function disabledMailcomSuffixes(userId) {
  return new Set(normalizeSuffixList(readSettings(userId).mailcom?.disabled_suffixes));
}

function listRegisterableChildren(userId) {
  const unused = listUnusedChildren(userId);
  const disabled = disabledMailcomSuffixes(userId);
  if (!disabled.size) return unused;
  return unused.filter((row) => !disabled.has(suffixOfAddress(row.address)));
}

function assertRegistrationProxySelection(proxyGroup, proxyCountry, { dynamicProxy = false } = {}) {
  const group = String(proxyGroup || '').trim();
  if (!group || group === '直连') {
    throw Object.assign(new Error('注册必须选择代理分组；直连会暴露服务器 IP，极易秒封'), {
      status: 400, code: 'REGISTER_PROXY_REQUIRED',
    });
  }
  if (group === '__none__') return;
  if (isPaymentProxyGroup(group) && !isRegisterProxyGroup(group)) {
    throw Object.assign(
      new Error(`注册不能使用支付代理分组「${group}」；支付组专用于 GB 提链/开通，不能拿来注册 ChatGPT`),
      { status: 400, code: 'REGISTER_PAYMENT_PROXY_FORBIDDEN' },
    );
  }
}

function loadProxies(userId, groupName) {
  return loadRegistrationProxies(userId, groupName);
}

function loadRegistrationProxies(userId, groupName) {
  const group = String(groupName || '').trim();
  if (!group || group === '__none__' || group === '直连') return [];
  assertRegistrationProxySelection(group, '', { dynamicProxy: false });
  const rows = db.prepare(
    `SELECT * FROM proxies WHERE user_id = ? AND group_name = ? AND status = ? ORDER BY id`
  ).all(userId, group, AVAILABLE);
  const proxies = rows
    .map((r) => ({
      id: r.id,
      proxy_type: r.proxy_type || 'http',
      host: r.host,
      port: r.port,
      username: r.username || '',
      password: decrypt(r.password_enc || ''),
      group_name: r.group_name,
      region: effectiveProxyRegion(r),
      status: r.status,
    }))
    .filter((proxy) => keepRegistrationProxy(proxy, group));
  if (!proxies.length) {
    throw Object.assign(
      new Error(`代理分组「${group}」没有可用于注册的出口（已排除支付组与不可用代理）`),
      { status: 400, code: 'REGISTER_PROXY_UNAVAILABLE' },
    );
  }
  return proxies;
}

function describeRegisterProxySelection({
  proxyGroup,
  dynamicProxy = false,
  dynamicSettings = {},
  proxies = [],
} = {}) {
  if (dynamicProxy || isAutoProxyGroup(proxyGroup)) {
    const country = countryFromGroup(proxyGroup) || countryCode(dynamicSettings.country) || 'GB';
    const provider = String(dynamicSettings.active_pool || '1024proxy').toLowerCase();
    return `动态代理 ${country}（${provider}）`;
  }
  const group = String(proxyGroup || '').trim();
  if (!group || group === '直连' || group === '__none__') return '直连';
  return `${group} ${Array.isArray(proxies) ? proxies.length : 0} 条出口`;
}

function proxyLabel(proxy) {
  if (!proxy) return '直连';
  const sid = String(proxy.username || '').match(/sid-([A-Za-z0-9]+)/i)?.[1] || '';
  const userHint = sid ? `sid-${sid}` : String(proxy.username || '').slice(-8);
  return userHint
    ? `${proxy.host}:${proxy.port}（${userHint}）`
    : `${proxy.host}:${proxy.port}`;
}

function mailboxPassword(userId, row) {
  if (row.password_enc) {
    const own = decrypt(row.password_enc);
    if (own) return own;
  }
  if (row.mother_id) {
    const mother = getMother(userId, row.mother_id);
    if (mother) return decrypt(mother.password_enc || '');
  }
  return '';
}

function totp2faRequested(enableTotp2fa) {
  return enableTotp2fa !== false;
}

function totpSecretValue(fields = {}) {
  return String(fields.totp_secret || '').replace(/\s+/g, '').toUpperCase();
}

function isTotpSuccessfullyEnrolled(fields = {}) {
  const secret = totpSecretValue(fields);
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) return false;
  return fields.mfa_enabled === true || fields.mfa_enabled === 1 || fields.mfa_enabled === '1'
    || fields.hardening_status === 'security_complete';
}

// 勾选了 2FA 但 TOTP 未激活成功：即使已有 AT 也不入库。未勾选 2FA 的密码注册保持原入库行为。
function shouldPersistRegisterAccount(enableTotp2fa, fields = {}) {
  if (!totp2faRequested(enableTotp2fa)) return true;
  return isTotpSuccessfullyEnrolled(fields);
}

function persistRegisteredAccount(userId, email, fields = {}, { enableTotp2fa, channel } = {}) {
  if (!shouldPersistRegisterAccount(enableTotp2fa, { ...fields, email })) {
    return { saved: false, reason: 'totp_incomplete' };
  }
  const existing = db.prepare(
    'SELECT id FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
  ).get(userId, email);
  if (!existing && remainingDailyRegisters(userId, readSettings(userId)) === 0) {
    return { saved: false, reason: 'daily_cap' };
  }
  const next = {
    ...fields,
    channel: normalizeChannel(channel || fields.channel),
  };
  if (isGcChannel(next.channel)) next.monitor_pool = 0;
  const id = upsertAccountCheckpoint(userId, email, next);
  if (id && isGcChannel(next.channel)) {
    db.prepare('UPDATE gpt_accounts SET monitor_pool = 0 WHERE id = ? AND user_id = ?').run(id, userId);
  }
  return { saved: true, id };
}

function discardIncompleteTwoFaAccount(userId, email) {
  const currentRow = db.prepare(
    'SELECT * FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
  ).get(userId, email);
  if (!currentRow) return false;
  if (isTotpSuccessfullyEnrolled(toDetail(currentRow))) return false;
  if (require('./accountRetention').isLocallyProtected(currentRow)) return false;
  db.prepare('DELETE FROM gpt_accounts WHERE id = ? AND user_id = ?').run(currentRow.id, userId);
  return true;
}

function isSafeRegisterTrialProxy(proxy) {
  if (!proxy || !proxy.host) return false;
  if (isPaymentProxyGroup(proxy.group_name)) return false;
  return true;
}

async function checkTrialAfterRegister(userId, email, {
  proxy,
  log,
  fetchImpl,
  detectViaTokenFn,
} = {}) {
  const row = db.prepare(
    'SELECT * FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
  ).get(userId, email);
  if (!row) return { skipped: true, reason: 'not_saved' };
  const { trialKnown } = require('./accountCheck');
  if (isGcChannel(row.channel)) {
    try {
      const { checkGcashTrialForUser, gcashDetectLog } = require('./checkGcashTrial');
      const result = await checkGcashTrialForUser(userId, toDetail(row), {
        identity: email,
        fetchImpl,
        log: gcashDetectLog(userId, email),
      });
      db.prepare(
        `UPDATE gpt_accounts SET has_trial = ?, trial_label = ?, last_detected_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
         WHERE id = ? AND user_id = ?`
      ).run(result.has_trial === 1 ? 1 : 0, result.has_trial === 1 ? 'gcash-cpmt' : '', row.id, userId);
      if (result.has_trial === 1) log?.('GCash 资格检测：是', 'ok');
      else log?.('GCash 资格检测：否', 'ok');
      return result;
    } catch (error) {
      log?.(`GCash 资格检测失败，不影响入库：${shortError(error)}`, 'warning');
      return { skipped: true, reason: 'trial_check_failed', error: shortError(error) };
    }
  }
  const safeProxy = isSafeRegisterTrialProxy(proxy) ? proxy : null;
  if (!trialKnown(row.has_trial) && !safeProxy) {
    log?.('试用资格检测跳过：缺少注册代理，避免直连 VPS 打 accounts/check', 'warning');
    return { skipped: true, reason: 'no_register_proxy' };
  }
  try {
    const detect = detectViaTokenFn || require('./accountJob').detectViaToken;
    const result = await detect(userId, row.id, {
      proxy: safeProxy,
      trialOnly: true,
      fetchImpl,
    });
    if (result?.has_trial === 1) log?.('试用资格检测：是', 'ok');
    else if (result?.has_trial === 0) log?.('试用资格检测：否', 'ok');
    else if (result?.skipped && result.reason === 'trial_known') {
      log?.(Number(result.has_trial) === 1 ? '试用资格检测：是' : '试用资格检测：否', 'ok');
    } else log?.('试用资格检测未完成，保持未检测', 'warning');
    return result;
  } catch (error) {
    log?.(`试用资格检测失败，不影响入库：${shortError(error)}`, 'warning');
    return { skipped: true, reason: 'trial_check_failed', error: shortError(error) };
  }
}

function buildRegisterAccountPayload({ email, password, result, securityCheckpoint = {} }) {
  const {
    check,
    session_key,
    plan_type: _jwtPlan,
    plan: _jwtPlanAlias,
    progress: _progress,
    ...rest
  } = result || {};
  const trial = resolveTrial({
    check,
    accessToken: rest.access_token || rest.session_key || session_key || '',
  });
  return {
    ...rest,
    email,
    password,
    email_type: 'gmail',
    status: '正常',
    expires_at: rest.expires_at || rest.expire_date || null,
    remark: '',
    access_token: rest.access_token || session_key || '',
    refresh_token: rest.refresh_token || '',
    client_id: rest.client_id || '',
    chatgpt_account_id: rest.chatgpt_account_id || '',
    has_trial: trial.has_trial,
    trial_label: trial.trial_label || '',
    ...securityCheckpoint,
    // These registration invariants must remain after every upstream spread.
    // JWT/check trial or plus-1-month-free belongs only in has_trial.
    plan_type: 'Free',
    progress: PROGRESS.REGISTERED,
    activated_at: '',
    channel: normalizeChannel(rest.channel || securityCheckpoint.channel),
  };
}

function insertAccount(userId, payload) {
  // Final registration insertion boundary: callers and future payload changes
  // cannot turn a newly registered, unpaid account into an activated plan.
  const cols = toColumns({
    ...payload,
    plan_type: 'Free',
    progress: PROGRESS.REGISTERED,
    activated_at: '',
  });
  db.prepare(
    `INSERT INTO gpt_accounts (${INSERT_COLUMNS.join(', ')})
     VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`
  ).run(...valuesForInsert(userId, cols));
}

function upsertAccountCheckpoint(userId, email, fields = {}) {
  const currentRow = db.prepare(
    'SELECT * FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
  ).get(userId, email);
  const current = currentRow ? toDetail(currentRow) : {};
  const payload = buildRegisterAccountPayload({
    email,
    password: fields.password ?? current.password ?? '',
    result: { ...current, ...fields },
    securityCheckpoint: { ...current, ...fields },
  });
  const cols = toColumns(payload);
  if (!currentRow) {
    db.prepare(
      `INSERT INTO gpt_accounts (${INSERT_COLUMNS.join(', ')})
       VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`
    ).run(...valuesForInsert(userId, cols));
    return db.prepare(
      'SELECT id FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
    ).get(userId, email).id;
  }
  const columns = INSERT_COLUMNS.filter((column) => column !== 'user_id');
  db.prepare(
    `UPDATE gpt_accounts SET ${columns.map((column) => `${column} = ?`).join(', ')},
       updated_at = datetime('now','localtime') WHERE id = ? AND user_id = ?`
  ).run(...columns.map((column) => {
    if (column === 'has_trial') return cols.has_trial === 0 || cols.has_trial === 1 ? cols.has_trial : null;
    if (column === 'expires_at') return cols.expires_at || null;
    return cols[column] ?? '';
  }), currentRow.id, userId);
  return currentRow.id;
}

function markEmailUsed(userId, emailId) {
  return db.prepare(
    `UPDATE emails SET status = '已使用', used_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
     WHERE id = ? AND user_id = ? AND status != '已使用'`
  ).run(emailId, userId).changes;
}

function isMailboxOtpNotReceived(error) {
  return String(error?.code || '') === 'MAILBOX_OTP_NOT_RECEIVED';
}

function skipMailboxWithoutOtp(userId, row, log = () => {}) {
  const changed = markEmailUsed(userId, row.id);
  row._emailConsumed = true;
  log('未收到验证邮件，邮箱已标记为已使用，跳过', 'warning');
  return Boolean(changed);
}

function pickReplacementChild(userId, claimedIds) {
  const claimed = claimedIds instanceof Set ? claimedIds : new Set(claimedIds || []);
  const unused = listRegisterableChildren(userId).filter((item) => !claimed.has(item.id) && !claimed.has(item.address));
  return selectUnusedUnderQuota(userId, unused, suffixStatsForUser(userId), 1, readSettings(userId))[0] || null;
}

function insertQueuedRegistrationJob(state, userId, row) {
  row._jobId = row._jobId || crypto.randomUUID();
  row._attempt = 1;
  db.prepare(
    `INSERT INTO registration_jobs (
       job_id, batch_id, user_id, email_id, email, status, progress
     ) VALUES (?, ?, ?, ?, ?, 'queued', 0)`
  ).run(row._jobId, state.run_id, userId, row.id, row.address);
  return row;
}

function consumeEmailAtCheckpoint(userId, row, stage, log = () => {}) {
  if (!CONSUMING_STAGES.has(String(stage || ''))) {
    throw new Error(`未知邮箱消耗检查点：${String(stage || 'missing').slice(0, 80)}`);
  }
  if (row._emailConsumed) return false;
  const changed = markEmailUsed(userId, row.id);
  row._emailConsumed = true;
  if (changed) {
    log('邮箱已到达上游消耗阶段，已标记为已使用', 'info');
  }
  return Boolean(changed);
}

const disableSuffixForAccountCreationFailureTx = db.transaction((userId, row, error, runId = '') => {
  if (!isAccountCreationRejectedFailure(error)) return false;
  const mailcom = disableMailcomPullSuffix(userId, row.address);
  const cf = mailcom.changed ? { changed: false, domain: '' } : disableCfMailSuffix(userId, row.address);
  const result = mailcom.changed ? mailcom : cf;
  if (!result.changed) return false;
  const kind = mailcom.changed ? 'mail.com 拉取后缀' : 'CF 收信域名';
  db.prepare(
    `INSERT INTO operation_logs (user_id, category, level, source, ref, run_id, message)
     VALUES (?, 'register', 'warning', 'settings', '', ?, ?)`
  ).run(
    userId,
    String(runId || '').slice(0, 80),
    `已自动禁用 ${kind}：${result.domain}`
  );
  return true;
});

function disableSuffixForAccountCreationFailure(userId, row, error, runId = '') {
  return disableSuffixForAccountCreationFailureTx(userId, row, error, runId);
}

function mapLogLevel(level) {
  if (level === 'ok' || level === 'success') return 'success';
  if (level === 'warn' || level === 'warning') return 'warning';
  if (level === 'error') return 'error';
  return 'info';
}

function options(user) {
  const settings = readSettings(user.id);
  const unused = listRegisterableChildren(user.id);
  const groups = listProxyGroups(user.id);
  const cloak = settings.cloak || {};
  const st = status(user.id);
  const activePool = settings.dynamic_proxy?.active_pool || '1024proxy';
  const activeProvider = settings.dynamic_proxy?.providers?.[activePool] || {};
  return {
    unused_emails: unused.length,
    groups,
    cloak: {
      license_configured: cloakLicenseConfigured(cloak),
      license_count: cloakLicenseKeys(cloak).length,
      headless: cloak.headless !== false,
      max_concurrency: Math.max(1, Math.min(REGISTER_CONCURRENCY_CAP, Number(cloak.max_concurrency) || 3)),
      humanize: cloak.humanize !== false,
      human_preset: cloak.human_preset || 'careful',
    },
    default_proxy_group: resolveRegisterProxyGroup('', groups),
    registration: {
      set_password: settings.registration?.set_password !== false,
      enable_totp_2fa: settings.registration?.enable_totp_2fa !== false,
      asset_optimization: settings.registration?.asset_optimization !== false,
      mail_provider: settings.registration?.mail_provider || 'mailcom',
      performance_profile: normalizeRegisterPerformanceProfile(settings.registration?.performance_profile),
      attempts: Math.max(1, Math.min(REGISTER_MAX_ATTEMPTS, Number(settings.registration?.attempts) || REGISTER_MAX_ATTEMPTS)),
      mail_providers: {
        mailcom: unused.length > 0,
        mailpit: mailpitReady(settings),
        imported: Boolean(settings.imported_mail?.mailboxes),
        herosms: Boolean(settings.herosms?.api_key || settings.sms?.api_key),
        smsbower: Boolean(settings.smsbower?.api_key),
        cfworker: cfMailReady(settings),
        mix: unused.length > 0 && cfMailReady(settings),
      },
      mailcom_share: Number.isFinite(Number(settings.registration?.mailcom_share))
        ? Math.max(0, Math.min(100, Number(settings.registration.mailcom_share)))
        : 5,
      cfworker_share: Number.isFinite(Number(settings.registration?.cfworker_share))
        ? Math.max(0, Math.min(100, Number(settings.registration.cfworker_share)))
        : 5,
      phone_providers: {
        herosms: Boolean(settings.herosms?.api_key || settings.sms?.api_key),
        smsbower: Boolean(settings.smsbower?.api_key || settings.sms?.api_key),
      },
      dynamic_proxy_configured: Boolean(activeProvider.username && activeProvider.password),
      dynamic_proxy_active_pool: activePool,
    },
    runtime: st,
  };
}

async function loadAutomation() {
  const { CloakRuntime } = await import('../automation/cloak.js');
  const { RegisterFlow } = await import('../automation/flows/register.js');
  const { generateAccountPassword } = await import('../automation/flows/account-security.js');
  return { CloakRuntime, RegisterFlow, generateAccountPassword };
}

function pickCfDomainForUser(userId, settings, preferred = '') {
  const domain = pickQuotaSuffix(userId, enabledCfDomains(settings), {
    preferred, settings, mode: 'both',
  });
  if (!domain) {
    throw Object.assign(new Error('本时段每个域名后缀的邮箱额度已用完，请调大每小时/每天上限或换其它后缀'), {
      status: 400, code: 'SUFFIX_QUOTA_EXHAUSTED',
    });
  }
  return domain;
}

function allocateCfRows(userId, settings, count, preferred = '') {
  const rows = [];
  const want = Math.max(0, Number(count) || 0);
  for (let index = 0; index < want; index += 1) {
    const domain = pickQuotaSuffix(userId, enabledCfDomains(settings), {
      preferred, settings, mode: 'both',
    });
    if (!domain) break;
    rows.push({
      id: null,
      address: `cfworker:pending:${index + 1}`,
      _providerIndex: index,
      _mailProvider: 'cfworker',
      _mailDomain: domain,
    });
  }
  return rows;
}

async function start(user, body = {}) {
  const userId = user.id;
  const settings = readSettings(userId);
  body = normalizeStartOptions(body, settings, listProxyGroups(userId));
  body.channel = normalizeChannel(body.channel);
  body.proxy_group = channelAutoGroup(body.channel);
  body.proxy_country = channelCountry(body.channel);
  const slot = jobSlotKey(userId, body.channel);
  const mailProvider = body.mail_provider;
  const heroCfg = settings.herosms || {};
  const heroSmsGuard = new HeroSmsGuard({
    requestsPerSecond: heroCfg.requests_per_second,
    maxRequestConcurrency: heroCfg.max_request_concurrency,
    maxActiveActivations: heroCfg.max_active_activations,
    maxTransientRetries: heroCfg.max_transient_retries,
    transientRetryBaseMs: heroCfg.transient_retry_base_ms,
    banCooldownMs: heroCfg.ban_cooldown_ms,
    rateCooldownMs: heroCfg.rate_cooldown_ms,
  });
  const current = jobs.get(slot);
  const persisted = isGcChannel(body.channel) ? { running: false } : latestPersistedState(userId);
  if (current?.running) {
    const err = new Error('已有注册任务在运行');
    err.status = 400;
    throw err;
  }
  if (persisted.running) reconcileDeadKind(userId, isGcChannel(body.channel) ? 'register-gc' : 'register');

  const licenseKeys = cloakLicenseKeys(settings.cloak);
  if (!licenseKeys.length) {
    const err = new Error('请先在个人设置中配置 CloakBrowser 授权');
    err.status = 400;
    throw err;
  }
  if (body.get_refresh_token) {
    // Validate provider selection and credentials before creating persistent jobs.
    createPhoneChannel(body.phone_provider, settings, body);
  }

  const requested = body.count;
  const unused = mailProvider === 'mailcom' || mailProvider === 'mix'
    ? listRegisterableChildren(userId)
    : listUnusedChildren(userId);
  let emails;
  if (mailProvider === 'mix') {
    if (!cfMailReady(settings)) {
      throw Object.assign(new Error('请先在个人设置配置 CF Worker 邮箱接口，并启用至少一个收信域名'), {
        status: 400, code: 'CFWORKER_MAIL_NOT_CONFIGURED',
      });
    }
    const shares = splitMailMix(
      requested,
      body.mailcom_share ?? settings.registration?.mailcom_share ?? 5,
      body.cfworker_share ?? settings.registration?.cfworker_share ?? 5,
    );
    const mailCount = Math.min(shares.mailcom, unused.length);
    if (shares.mailcom && !unused.length && !shares.cfworker) {
      throw Object.assign(new Error('没有可用的未使用子号，请先在邮箱管理拉满子号'), { status: 400 });
    }
    const mailRows = mailCount
      ? selectUnusedUnderQuota(userId, unused, suffixStatsForUser(userId), mailCount, settings)
        .map((row) => ({ ...row, _mailProvider: 'mailcom' }))
      : [];
    const cfRows = allocateCfRows(userId, settings, shares.cfworker, body.mail_domain);
    if (!mailRows.length && !cfRows.length) {
      throw Object.assign(new Error('按当前 mail.com / CF 比例没有可分配的邮箱，或各后缀本时段额度已用完'), { status: 400 });
    }
    emails = interleaveRows(mailRows, cfRows);
    if (cfRows.length) createMailChannel('cfworker', settings, { ...body, mail_domain: cfRows[0]._mailDomain });
  } else if (mailProvider === 'mailcom') {
    if (!unused.length) throw Object.assign(new Error('没有可用的未使用子号，请先在邮箱管理拉满子号'), { status: 400 });
    emails = selectUnusedUnderQuota(userId, unused, suffixStatsForUser(userId), requested, settings)
      .map((row) => ({ ...row, _mailProvider: 'mailcom' }));
    if (!emails.length) {
      throw Object.assign(new Error('各域名后缀本时段注册额度已用完，请调大每小时/每天上限或等待下一时段'), {
        status: 400, code: 'SUFFIX_QUOTA_EXHAUSTED',
      });
    }
  } else if (mailProvider === 'imported') {
    const parsed = parseImportedMailboxList(body.imported_mailboxes ?? settings.imported_mail?.mailboxes, {
      allowUnsafeUrl: settings.imported_mail?.allow_unsafe_url === true,
    });
    if (parsed.errors.length) {
      throw Object.assign(new Error(`导入邮箱第 ${parsed.errors[0].line} 行：${parsed.errors[0].reason}`), {
        status: 400, code: 'IMPORTED_MAIL_INVALID',
      });
    }
    if (!parsed.entries.length) throw Object.assign(new Error('没有可用的导入邮箱'), { status: 400, code: 'IMPORTED_MAIL_REQUIRED' });
    emails = parsed.entries.slice(0, requested).map((entry, index) => ({
      id: null, address: entry.email, _entry: entry, _providerIndex: index, _mailProvider: 'imported',
    }));
  } else if (mailProvider === 'mailpit') {
    if (!mailpitReady(settings)) {
      throw Object.assign(new Error('请先在邮箱管理启用 Mailpit 收信域名，并配置管理接口账号'), {
        status: 400, code: 'MAILPIT_NOT_CONFIGURED',
      });
    }
    emails = allocateMailpitAddresses(settings, requested, body.mail_domain)
      .map((row) => ({ ...row, _mailProvider: 'mailpit' }));
  } else if (mailProvider === 'cfworker') {
    emails = allocateCfRows(userId, settings, requested, body.mail_domain);
    if (!emails.length) {
      throw Object.assign(new Error('本时段每个域名后缀的邮箱额度已用完，请调大每小时/每天上限或换其它后缀'), {
        status: 400, code: 'SUFFIX_QUOTA_EXHAUSTED',
      });
    }
    createMailChannel(mailProvider, settings, { ...body, mail_domain: emails[0]._mailDomain });
  } else {
    // Paid/worker mailboxes are acquired lazily inside each worker so a queued
    // task never reserves balance before it owns a Cloak slot.
    emails = Array.from({ length: requested }, (_, index) => ({
      id: null,
      address: `${mailProvider}:pending:${index + 1}`,
      _providerIndex: index,
      _mailProvider: mailProvider,
      _mailDomain: body.mail_domain,
    }));
    // Validate configuration without making an external request.
    createMailChannel(mailProvider, settings, body);
  }
  const remaining = remainingDailyRegisters(userId, settings);
  if (remaining === 0) {
    throw Object.assign(new Error('今日注册已达上限'), { status: 400, code: 'DAILY_REGISTER_CAP' });
  }
  if (Number.isFinite(remaining) && emails.length > remaining) {
    emails = emails.slice(0, remaining);
  }
  const target = emails.length;
  const proxyGroup = channelAutoGroup(body.channel);
  const dynamicProxy = true;
  const proxyCountry = channelCountry(body.channel);
  const dynamicSettings = {
    ...(settings.dynamic_proxy || {}),
    active_pool: 'cliproxy',
  };
  assertRegistrationProxySelection(proxyGroup, proxyCountry, { dynamicProxy });
  requireChannelDynamicProxy(userId, proxyCountry, `preflight:${userId}`, settings);
  const proxies = [];

  const limits = planRegisterRuntimeLimits({
    requestedThreads: body.concurrency,
    target,
    cloakMaxConcurrency: settings.cloak?.max_concurrency,
    resourceConcurrency: automationConfig.cloak.resourceConcurrency,
    performanceProfile: body.performance_profile,
    launchConcurrencyLimit: automationConfig.cloak.launchConcurrency,
  });
  const { configuredCloakMax, resourceCloakMax, requestedThreads, cloakMax, concurrency, launchConcurrency } = limits;

  let automation;
  try {
    automation = await loadAutomation();
  } catch (e) {
    const err = new Error(`注册引擎加载失败：${e.message || e}。请确认已安装 cloakbrowser 依赖`);
    err.status = 500;
    throw err;
  }

  const state = {
    ...emptyState(),
    run_id: crypto.randomUUID(),
    running: true,
    target,
    concurrency,
    proxy_group: proxyGroup || '直连',
    unused: mailProvider === 'mailcom' || mailProvider === 'mix' ? unused.length : emails.length,
    started_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    message: body.pipeline
      ? `持续注册中，本波 ${target}，并发 ${concurrency}`
      : `已启动，目标 ${target}，并发 ${concurrency}`,
  };
  jobs.set(slot, state);
  state.channel = body.channel;
  db.transaction(() => {
    persistState(userId, state, { required: true });
    db.prepare(
      `INSERT INTO registration_batches (
         batch_id, user_id, run_id, kind, status, total, concurrency, queued,
         proxy_group, message, created_at
       ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`
    ).run(
      state.run_id, userId, state.run_id, isGcChannel(body.channel) ? 'register-gc' : 'register',
      target, concurrency, target,
      state.proxy_group, state.message, state.started_at
    );
    const insertJob = db.prepare(
      `INSERT INTO registration_jobs (
         job_id, batch_id, user_id, email_id, email, status, progress
       ) VALUES (?, ?, ?, ?, ?, 'queued', 0)`
    );
    for (const row of emails) {
      row._jobId = crypto.randomUUID();
      insertJob.run(row._jobId, state.run_id, userId, row.id, row.address);
    }
  })();

  let runtime;
  try {
    runtime = new automation.CloakRuntime({
      licenseKey: licenseKeys[0],
      licenseKeys,
      headless: body.headless,
      humanize: body.humanize !== false,
      humanPreset: settings.cloak?.human_preset || 'careful',
      maxConcurrency: cloakMax,
      configuredMaxConcurrency: configuredCloakMax,
      resourceMaxConcurrency: resourceCloakMax,
      licenseMaxSessions: resourceCloakMax,
      resourcePlan: automationConfig.cloak.resourcePlan,
      launchConcurrency,
      profileCleanupConcurrency: automationConfig.cloak.profileCleanupConcurrency,
      profileRoot: automationConfig.cloak.profileRoot,
    });
  } catch (error) {
    state.running = false;
    state.finished = true;
    state.finished_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    state.message = `注册引擎启动失败：${shortError(error)}`;
    const code = String(error?.code || 'REGISTER_ENGINE_START_FAILED');
    db.prepare(
      `UPDATE registration_jobs SET status='failed', progress=100, error_code=?, error=?,
       finished_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
       WHERE batch_id=? AND status='queued'`
    ).run(code, state.message, state.run_id);
    persistState(userId, state);
    syncBatchTx(state.run_id, state.message);
    opLog.register(userId, 'error', state.message, { source: 'register', run_id: state.run_id });
    throw error;
  }
  state.runtime = runtime;
  const mailboxPlan = planRegisterMailboxPipeline({
    performanceProfile: body.performance_profile,
    effectiveConcurrency: concurrency,
    launchConcurrency: runtime.info?.().launchConcurrency || 1,
  });
  const needsMailboxPipeline = emails.some((row) => {
    const provider = row._mailProvider || mailProvider;
    return provider !== 'mailcom' && provider !== 'imported' && provider !== 'mailpit';
  });
  const mailboxPipeline = needsMailboxPipeline ? createRegisterMailboxPipeline(mailboxPlan) : null;
  state.mailbox_pipeline = mailboxPipeline;

  const queue = emails.map((row) => ({ ...row }));
  const claimedEmailIds = new Set(emails.map((row) => row.id).filter(Boolean));
  const nextProxy = (row, attempt) => requireChannelDynamicProxy(
    userId,
    proxyCountry,
    `${row._jobId}:${attempt}:${row._proxyAttempt || 0}`,
    settings,
  );

  const proxySummary = describeRegisterProxySelection({
    proxyGroup, dynamicProxy, dynamicSettings, proxies,
  });
  const unusedNote = (mailProvider === 'mailcom' || mailProvider === 'mix') && requested > unused.length
    ? `（请求 ${requested}，当前未使用 ${unused.length}，本次按 ${target}）`
    : '';
  opLog.register(
    userId,
    'info',
    `开始注册 ${target} 个账号${unusedNote}，并发 ${concurrency}，冷启动 ${launchConcurrency}，代理 ${proxySummary}，可用子号 ${unused.length}`,
    { source: 'register', run_id: state.run_id }
  );
  if (limits.resourceLimited) {
    opLog.register(
      userId,
      'warning',
      `本机资源槽位 ${resourceCloakMax} 低于请求并发 ${requestedThreads}，本波按 ${concurrency} 启动`,
      { source: 'register', run_id: state.run_id }
    );
  }

  const tripCircuit = (code) => {
    if (!INFRASTRUCTURE_CODES.has(code)) {
      state._infraCode = '';
      state._infraCount = 0;
      return false;
    }
    state._infraCount = state._infraCode === code ? (state._infraCount || 0) + 1 : 1;
    state._infraCode = code;
    db.prepare(
      `UPDATE registration_batches SET circuit_code=?, circuit_count=?,
       updated_at=datetime('now','localtime') WHERE batch_id=?`
    ).run(code, state._infraCount, state.run_id);
    if (state._infraCount < CIRCUIT_BREAKER_THRESHOLD) return false;
    state._circuitTriggered = true;
    const message = `批量熔断：连续 ${state._infraCount} 个子任务出现 ${code}，已跳过尚未启动的任务`;
    db.prepare(
      `UPDATE registration_batches SET circuit_triggered=1, message=?,
       updated_at=datetime('now','localtime') WHERE batch_id=?`
    ).run(message, state.run_id);
    db.prepare(
      `UPDATE registration_jobs SET status='skipped', progress=100,
       error_code=?, error=?, result=?, finished_at=datetime('now','localtime'),
       updated_at=datetime('now','localtime')
       WHERE batch_id=? AND status='queued'`
    ).run(code, message, JSON.stringify({
      success: false,
      skipped: true,
      error_code: 'BATCH_CIRCUIT_BREAKER',
      cause_code: code,
      partial: false,
    }), state.run_id);
    queue.splice(0);
    syncBatchTx(state.run_id, message);
    return true;
  };

  const worker = async () => {
    while (queue.length && !state.stop && state.success < state.target) {
      const row = queue.shift();
      if (remainingDailyRegisters(userId, settings) <= 0) {
        const capMessage = '今日注册已达上限';
        patchRegistrationJob(row._jobId, {
          status: 'skipped', progress: 100, error_code: 'DAILY_REGISTER_CAP', error: capMessage,
        });
        state.attempted += 1;
        while (queue.length) {
          const left = queue.shift();
          patchRegistrationJob(left._jobId, {
            status: 'skipped', progress: 100, error_code: 'DAILY_REGISTER_CAP', error: capMessage,
          });
          state.attempted += 1;
        }
        opLog.register(userId, 'warning', capMessage, { source: 'register', run_id: state.run_id });
        persistState(userId, state);
        break;
      }
      let email = row.address;
      const jobMailProvider = row._mailProvider || mailProvider;
      const attempt = Math.max(1, Number(row._attempt) || 1);
      const proxy = nextProxy(row, attempt);
      patchRegistrationJob(row._jobId, { status: 'running', progress: 1, attempt });
      state.current_email = email;
      state.message = `正在注册 ${email}${proxy ? `（${proxyLabel(proxy)}）` : '（直连）'}`;

      const log = (message, level = 'info') => {
        const logText = String(message || '');
        const messageLimit = 240;
        if (level === 'debug' || /等待.*验证邮件/.test(String(message || ''))) {
          if (!row._lastWaitLog || Date.now() - row._lastWaitLog > 20000) {
            row._lastWaitLog = Date.now();
            opLog.register(userId, 'info', `${email}：${logText.slice(0, messageLimit)}`, {
              ref: email,
              run_id: state.run_id,
            });
          }
          return;
        }
        opLog.register(userId, mapLogLevel(level), `${email}：${logText.slice(0, messageLimit)}`, {
          ref: email,
          run_id: state.run_id,
        });
      };

      log(
        `第 ${attempt} 次尝试，出口 ${proxyLabel(proxy)}`,
        'info'
      );

      const flow = new automation.RegisterFlow(runtime, {});
      let mailChannel = row._mailChannel || null;
      let phoneChannel = null;
      if (jobMailProvider === 'mailcom') {
        flow.mailbox.wait = async (_session, account, _settings, opts = {}) =>
          waitMailOtp(userId, account.email_id, {
            timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs, after: opts.after,
            log: opts.log || log, cancelled: opts.cancelled,
          });
      } else if (jobMailProvider === 'mailpit') {
        flow.mailbox.wait = async (_session, account, _settings, opts = {}) =>
          waitMailpitOtp(settings, account.email || row.address, {
            timeoutMs: opts.timeoutMs, intervalMs: opts.intervalMs, after: opts.after,
            log: opts.log || log, cancelled: opts.cancelled,
          });
      } else {
        mailChannel ||= createMailChannel(jobMailProvider, settings, {
          ...body, entry: row._entry, mail_domain: row._mailDomain || body.mail_domain,
        }, {
          cancelled: () => state.stop, log, heroSmsGuard,
        });
        row._mailChannel = mailChannel;
      }

      const accountPassword = body.set_password === false ? '' : automation.generateAccountPassword();
      const securityCheckpoint = {
        password: accountPassword,
        password_set: false,
        mfa_enabled: false,
        security_ready: false,
        hardening_status: 'pending',
      };
      let persistedAccountThisJob = false;
      let launchAdmission = null;
      let mailboxPermit = null;
      try {
        if (mailboxPipeline && mailChannel) {
          mailboxPermit = await mailboxPipeline.acquire(() => state.stop);
        }
        if (mailChannel && !row._mailAcquired) {
          const acquired = await mailChannel.acquire(null, { log, cancelled: () => state.stop });
          email = acquired.email;
          row.address = email;
          row._mailAcquired = true;
          persistSettlement(row._jobId, userId, 'mail', jobMailProvider, mailChannel, 'cancel', 'open');
          db.prepare('UPDATE registration_jobs SET email=?, updated_at=datetime(\'now\',\'localtime\') WHERE job_id=?')
            .run(email, row._jobId);
          state.current_email = email;
        }
        launchAdmission = await runtime.acquireLaunchAdmission({
          kind: 'register',
          activity: { jobId: row._jobId, label: email },
          cancelled: () => state.stop,
          log,
        });
        mailboxPermit?.release();
        mailboxPermit = null;
        if (body.get_refresh_token) {
          phoneChannel = createPhoneChannel(body.phone_provider, settings, body, {
            cancelled: () => state.stop, log, heroSmsGuard,
            onActivation: () => persistSettlement(
              row._jobId, userId, 'phone', body.phone_provider || settings.sms?.provider,
              phoneChannel, 'cancel', 'open'
            ),
          });
        }
        const result = await flow.run(
          { email, email_id: row.id, password: accountPassword, account_type: 'gmail' },
          {
            email_timeout_ms: body.email_timeout_ms,
            protocol_timeout_ms: body.protocol_timeout_ms,
            session_wall_timeout_ms: body.session_wall_timeout_ms,
            set_password: body.set_password,
            enable_totp_2fa: body.enable_totp_2fa,
            durable_credentials: body.get_refresh_token,
            get_refresh_token: body.get_refresh_token,
            humanize: body.humanize !== false,
            verify_refresh_token: body.get_refresh_token,
            register_mode: body.register_mode,
            performance_profile: body.performance_profile,
            registration_asset_optimization: body.asset_optimization,
            profile_key: `register:${email}`,
            cleanup_profile: true,
            headless: body.headless,
            phone_channel: body.phone_channel || 'sms',
          },
          {
            proxy,
            country: proxy?.region || proxyCountry || countryFromGroup(proxyGroup) || 'GB',
            proxyBypass: '',
            log,
            cancelled: () => state.stop,
            mailChannel,
            phoneChannel,
            onSessionReady: dynamicProxy
              ? async (session) => {
                  const claimed = await proxyExitLeases.claim(session, proxy, {
                    country: proxyCountry, kind: 'register', jobId: row._jobId, label: email,
                  });
                  return claimed?.release;
                }
              : undefined,
            launchAdmission,
            progress: (pct, msg) => {
              patchRegistrationJob(row._jobId, { progress: Math.max(1, Math.min(99, Number(pct) || 1)) });
              log(`${msg}（${pct}%）`, 'info');
            },
            onCredentialCheckpoint: async (fields) => {
              Object.assign(securityCheckpoint, fields);
              const persist = persistRegisteredAccount(userId, email, securityCheckpoint, {
                enableTotp2fa: body.enable_totp_2fa,
                channel: body.channel,
              });
              if (persist.saved) persistedAccountThisJob = true;
            },
            onSecurityCheckpoint: async (fields) => Object.assign(securityCheckpoint, fields),
            onConsumptionCheckpoint: async ({ stage } = {}) =>
              consumeEmailAtCheckpoint(userId, row, stage, log),
          }
        );
        const writable = checkWritable(user, 'gpt_accounts', true);
        if (writable) throw new Error(writable);

        const mergedFields = { ...securityCheckpoint, ...result, password: accountPassword };
        const persist = persistRegisteredAccount(userId, email, mergedFields, {
          enableTotp2fa: body.enable_totp_2fa,
          channel: body.channel,
        });
        const blockedByDailyCap = persist.reason === 'daily_cap';
        if (blockedByDailyCap) log('今日注册已达上限，未入库', 'warning');
        const blockedByTwoFa = totp2faRequested(body.enable_totp_2fa) && !persist.saved
          && persist.reason !== 'daily_cap';
        if (blockedByTwoFa) {
          if (persistedAccountThisJob) {
            discardIncompleteTwoFaAccount(userId, email);
            persistedAccountThisJob = false;
          }
        } else if (persist.saved) {
          persistedAccountThisJob = true;
          await checkTrialAfterRegister(userId, email, { proxy, log });
          try { require('./accountRebindJob').kickRegistered(userId, persist.id, body.channel); } catch { /* optional */ }
        }
        markEmailUsed(userId, row.id);
        const phoneSettlement = await settleJobChannel({
          jobId: row._jobId, userId, type: 'phone', provider: body.phone_provider || settings.sms?.provider,
          channel: phoneChannel, success: true, log,
        }).catch(settleError => {
          log(`手机号订单结算未确认：${shortError(settleError)}`, 'warning');
          return { status: 'failed' };
        });
        const mailSettlement = await settleJobChannel({
          jobId: row._jobId, userId, type: 'mail', provider: jobMailProvider,
          channel: mailChannel, success: true, log,
        }).catch(settleError => {
          log(`邮箱活动结算未确认：${shortError(settleError)}`, 'warning');
          return { status: 'failed' };
        });
        row._mailChannel = null;
        const cleanupPending = [phoneSettlement.status, mailSettlement.status].some(value => ['pending', 'failed'].includes(value));
        const isPartial = !blockedByTwoFa && !blockedByDailyCap && (
          result?.security_ready === false
          || result?.hardening_status === 'failed'
          || Boolean(result?.hardening_error_code)
          || (body.get_refresh_token && (
            !result?.refresh_token
            || result?.refresh_token_verified !== true
            || result?.credentials_ready !== true
          ))
        );
        if (blockedByTwoFa || isPartial || blockedByDailyCap) state.failed += 1;
        else state.success += 1;
        state.attempted += 1;
        patchRegistrationJob(row._jobId, {
          status: blockedByDailyCap ? 'skipped' : blockedByTwoFa ? 'failed' : isPartial ? 'partial' : 'success',
          progress: 100,
          partial: isPartial,
          error_code: blockedByDailyCap
            ? 'DAILY_REGISTER_CAP'
            : blockedByTwoFa
              ? String(result.hardening_error_code || 'ACCOUNT_MFA_NOT_ENROLLED')
              : isPartial ? String(result.hardening_error_code || (body.get_refresh_token ? 'ACCOUNT_RT_NOT_VERIFIED' : 'ACCOUNT_SECURITY_NOT_READY')) : '',
          error: blockedByDailyCap
            ? '今日注册已达上限，未入库'
            : blockedByTwoFa
              ? '2FA 未设置成功，不入库'
              : isPartial ? String(result.hardening_error || (body.get_refresh_token ? '账号已创建，但 refresh token 未取得或未通过续期验证' : '账号已创建，但 TOTP 安全配置未完成')) : '',
          result: {
            ...result, success: !blockedByTwoFa && !isPartial && !blockedByDailyCap, partial: isPartial,
            saved: Boolean(persist.saved) && !blockedByTwoFa,
            cleanup_pending: cleanupPending,
            phone_settlement: phoneSettlement.status,
            mail_settlement: mailSettlement.status,
          },
        });
        tripCircuit('');
        log(
          blockedByDailyCap
            ? '今日注册已达上限，未入库'
            : blockedByTwoFa
              ? '2FA 未设置成功，不入库'
              : isPartial
                ? String(result.hardening_error || '账号已创建，但安全配置未完成')
              : REGISTER_CONGRATS_COPY,
          blockedByDailyCap || blockedByTwoFa || isPartial ? 'warning' : 'success'
        );
        persistState(userId, state);
      } catch (error) {
        let disabledSuffix = false;
        try {
          disabledSuffix = disableSuffixForAccountCreationFailure(userId, row, error, state.run_id);
        } catch (settingsError) {
        console.warn('自动禁用邮箱域名失败：', settingsError.message);
        }
        if (state.stop || error?.code === 'JOB_CANCELLED' || /已取消/.test(String(error?.message || ''))) {
          await settleJobChannel({
            jobId: row._jobId, userId, type: 'phone', provider: body.phone_provider || settings.sms?.provider,
            channel: phoneChannel, success: false, log,
          }).catch(cancelError =>
            log(`手机号订单取消失败：${shortError(cancelError)}`, 'error'));
          await settleJobChannel({
            jobId: row._jobId, userId, type: 'mail', provider: jobMailProvider,
            channel: mailChannel, success: false, log,
          }).catch(cancelError =>
            log(`邮箱活动取消失败：${shortError(cancelError)}`, 'error'));
          row._mailChannel = null;
          state.attempted += 1;
          patchRegistrationJob(row._jobId, {
            status: 'cancelled', progress: 100, error_code: 'JOB_CANCELLED', error: '任务已停止',
          });
          log('任务已停止', 'warning');
          persistState(userId, state);
          break;
        }
        if (isMailboxOtpNotReceived(error)) {
          skipMailboxWithoutOtp(userId, row, log);
          await settleJobChannel({
            jobId: row._jobId, userId, type: 'phone', provider: body.phone_provider || settings.sms?.provider,
            channel: phoneChannel, success: false, log,
          }).catch(settleError =>
            log(`手机号订单取消失败：${shortError(settleError)}`, 'error'));
          await settleJobChannel({
            jobId: row._jobId, userId, type: 'mail', provider: jobMailProvider,
            channel: mailChannel, success: false, log,
          }).catch(settleError =>
            log(`邮箱活动取消失败：${shortError(settleError)}`, 'error'));
          row._mailChannel = null;
          state.attempted += 1;
          patchRegistrationJob(row._jobId, {
            status: 'skipped', progress: 100,
            error_code: 'MAILBOX_OTP_NOT_RECEIVED',
            error: '未收到验证邮件，邮箱已标记为已使用，跳过',
          });
          const replacement = jobMailProvider === 'mailcom' && state.success < state.target && !state.stop
            ? pickReplacementChild(userId, claimedEmailIds)
            : jobMailProvider === 'cfworker' && state.success < state.target && !state.stop
              ? (() => {
                try {
                  return {
                    id: null,
                    address: `cfworker:pending:r${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
                    _mailProvider: 'cfworker',
                    _mailDomain: pickCfDomainForUser(userId, settings),
                  };
                } catch {
                  return null;
                }
              })()
            : null;
          if (replacement) {
            replacement._mailProvider = replacement._mailProvider || jobMailProvider;
            if (replacement.id) claimedEmailIds.add(replacement.id);
            insertQueuedRegistrationJob(state, userId, replacement);
            queue.push(replacement);
            log(jobMailProvider === 'cfworker' ? '改用下一个 CF 域名继续注册' : '改用下一个未使用子号继续注册', 'info');
          }
          persistState(userId, state);
          continue;
        }
        if (isAccountCreationRejectedFailure(error)) {
          markEmailUsed(userId, row.id);
          row._emailConsumed = true;
          await settleJobChannel({
            jobId: row._jobId, userId, type: 'phone', provider: body.phone_provider || settings.sms?.provider,
            channel: phoneChannel, success: false, log,
          }).catch(settleError =>
            log(`手机号订单取消失败：${shortError(settleError)}`, 'error'));
          await settleJobChannel({
            jobId: row._jobId, userId, type: 'mail', provider: jobMailProvider,
            channel: mailChannel, success: false, log,
          }).catch(settleError =>
            log(`邮箱活动取消失败：${shortError(settleError)}`, 'error'));
          row._mailChannel = null;
          state.attempted += 1;
          patchRegistrationJob(row._jobId, {
            status: 'skipped', progress: 100,
            error_code: 'REGISTER_ACCOUNT_CREATION_REJECTED',
            error: disabledSuffix
              ? 'OpenAI 拒绝创建账号，已自动禁用该 mail.com 后缀并跳过'
              : 'OpenAI 拒绝创建账号，已跳过',
          });
          log(
            disabledSuffix
              ? 'OpenAI 拒绝创建账号，已自动禁用该邮箱域名并跳过'
              : 'OpenAI 拒绝创建账号，已跳过',
            'warning',
          );
          const replacement = jobMailProvider === 'mailcom' && state.success < state.target && !state.stop
            ? pickReplacementChild(userId, claimedEmailIds)
            : jobMailProvider === 'cfworker' && state.success < state.target && !state.stop
              ? (() => {
                try {
                  return {
                    id: null,
                    address: `cfworker:pending:r${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
                    _mailProvider: 'cfworker',
                    _mailDomain: pickCfDomainForUser(userId, settings),
                  };
                } catch {
                  return null;
                }
              })()
            : null;
          if (replacement) {
            replacement._mailProvider = replacement._mailProvider || jobMailProvider;
            if (replacement.id) claimedEmailIds.add(replacement.id);
            insertQueuedRegistrationJob(state, userId, replacement);
            queue.push(replacement);
            log(jobMailProvider === 'cfworker' ? '改用下一个 CF 域名继续注册' : '改用下一个未使用子号继续注册', 'info');
          }
          persistState(userId, state);
          continue;
        }
        let verdict = classifyRegisterFailure(error);
        await settleJobChannel({
          jobId: row._jobId, userId, type: 'phone', provider: body.phone_provider || settings.sms?.provider,
          channel: phoneChannel, success: false, log,
        }).catch(cancelError =>
          log(`手机号订单取消失败：${shortError(cancelError)}`, 'error'));
        if (PROXY_LEASE_CODES.has(verdict.code) && (row._proxyAttempt || 0) < MAX_ACQUIRE_ATTEMPTS) {
          row._proxyAttempt = (row._proxyAttempt || 0) + 1;
          if (row._proxyAttempt < MAX_ACQUIRE_ATTEMPTS) {
            row._attempt = attempt;
            patchRegistrationJob(row._jobId, {
              status: 'queued', progress: 0, capacity_attempt: row._proxyAttempt,
              error_code: verdict.code, error: shortError(error),
            });
            queue.push(row);
            const delay = registerRetryDelayMs(row._proxyAttempt);
            log(`动态代理独立出口获取失败，第 ${row._proxyAttempt}/${MAX_ACQUIRE_ATTEMPTS} 次换 sticky session；${delay}ms 后重试且不消耗注册轮次`, 'warning');
            persistState(userId, state);
            await sleep(delay);
            continue;
          }
          error = Object.assign(new Error(`连续 ${MAX_ACQUIRE_ATTEMPTS} 次未能获取独立动态代理出口`), {
            code: 'PROXY_EXIT_ACQUIRE_EXHAUSTED', cause_code: verdict.code, cause: error,
          });
          verdict = classifyRegisterFailure(error);
        }
        if (CAPACITY_CODES.has(verdict.code) && (row._capacityAttempt || 0) >= CAPACITY_MAX_ATTEMPTS) {
          // 容量等待有独立上限；耗尽后直接失败，绝不能递增业务 attempt。
          verdict.retryable = false;
        }
        if (CAPACITY_CODES.has(verdict.code) && (row._capacityAttempt || 0) < CAPACITY_MAX_ATTEMPTS) {
          row._capacityAttempt = (row._capacityAttempt || 0) + 1;
          row._attempt = attempt;
          patchRegistrationJob(row._jobId, {
            status: 'queued',
            progress: 0,
            capacity_attempt: row._capacityAttempt,
            error_code: verdict.code,
            error: shortError(error),
          });
          queue.push(row);
          const delay = registerFailureRetryDelayMs(error, row._capacityAttempt);
          log(`运行容量暂满，第 ${row._capacityAttempt}/${CAPACITY_MAX_ATTEMPTS} 次等待；${Math.ceil(delay / 1000)} 秒后重试且不消耗注册轮次`, 'warning');
          persistState(userId, state);
          await sleep(delay);
        } else if (verdict.retryable && attempt < body.attempts && !state.stop) {
          queue.push({ ...row, _attempt: attempt + 1 });
          state.retried += 1;
          patchRegistrationJob(row._jobId, {
            status: 'queued', progress: 0, error_code: verdict.code, error: shortError(error),
          });
          const delay = registerFailureRetryDelayMs(error, attempt);
          log(`第 ${attempt}/${body.attempts} 轮失败（${verdict.code}），${delay}ms 后换出口重试：${shortError(error)}`, 'warning');
          persistState(userId, state);
          await sleep(delay);
        } else {
          const checkpointed = Boolean(
            securityCheckpoint.password_set
            || securityCheckpoint.access_token
            || securityCheckpoint.refresh_token
            || securityCheckpoint.totp_secret
          );
          const canSave = checkpointed && shouldPersistRegisterAccount(
            body.enable_totp_2fa,
            securityCheckpoint,
          );
          if (canSave) {
            const persist = persistRegisteredAccount(userId, email, {
              ...securityCheckpoint,
              hardening_status: 'failed',
              hardening_error_code: verdict.code,
              hardening_error: shortError(error),
            }, { enableTotp2fa: body.enable_totp_2fa, channel: body.channel });
            persistedAccountThisJob = true;
            await checkTrialAfterRegister(userId, email, { proxy, log });
            if (persist.saved) {
              try { require('./accountRebindJob').kickRegistered(userId, persist.id, body.channel); } catch { /* optional */ }
            }
          } else if (totp2faRequested(body.enable_totp_2fa) && checkpointed) {
            if (persistedAccountThisJob) {
              discardIncompleteTwoFaAccount(userId, email);
              persistedAccountThisJob = false;
            }
          }
          const settlementSuccess = checkpointed;
          const mailSettlement = await settleJobChannel({
            jobId: row._jobId, userId, type: 'mail', provider: jobMailProvider,
            channel: mailChannel, success: settlementSuccess, log,
          }).catch(cancelError => {
            log(`邮箱活动${settlementSuccess ? '结算' : '取消'}失败：${shortError(cancelError)}`, 'error');
            return { status: 'failed' };
          });
          row._mailChannel = null;
          state.failed += 1;
          state.attempted += 1;
          patchRegistrationJob(row._jobId, {
            status: canSave ? 'partial' : 'failed',
            progress: 100,
            partial: canSave,
            error_code: totp2faRequested(body.enable_totp_2fa) && checkpointed && !canSave
              ? (verdict.code || 'ACCOUNT_MFA_NOT_ENROLLED')
              : verdict.code,
            error: totp2faRequested(body.enable_totp_2fa) && checkpointed && !canSave
              ? '2FA 未设置成功，不入库'
              : shortError(error),
            result: checkpointed ? {
              success: false,
              partial: canSave,
              saved: canSave,
              error_code: verdict.code,
              checkpoint_level: securityCheckpoint.access_token
                ? 'access_token'
                : securityCheckpoint.password_set ? 'password_set' : 'credential',
              mail_settlement: mailSettlement.status,
              cleanup_pending: ['pending', 'failed'].includes(mailSettlement.status),
            } : null,
          });
          tripCircuit(verdict.code);
          log(
            totp2faRequested(body.enable_totp_2fa) && checkpointed && !canSave
              ? '2FA 未设置成功，不入库'
              : `注册失败：${shortError(error)}`,
            'error',
          );
          persistState(userId, state);
        }
      } finally {
        mailboxPermit?.release();
        launchAdmission?.release();
      }
      state.message = `成功 ${state.success}/${state.target}，失败 ${state.failed}${
        state.retried ? `，换代理重试 ${state.retried}` : ''
      }`;
    }
  };

  Promise.all(Array.from({ length: concurrency }, () => worker()))
    .catch((e) => {
      opLog.register(userId, 'error', `注册任务异常：${String(e.message || e).slice(0, 240)}`, {
        run_id: state.run_id,
      });
    })
    .finally(() => {
      if (state.stop) {
        db.prepare(
          `UPDATE registration_jobs SET status='cancelled', progress=100,
           error_code='JOB_CANCELLED', error='批次已停止',
           finished_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
           WHERE batch_id=? AND status IN ('queued','running')`
        ).run(state.run_id);
      } else {
        db.prepare(
          `UPDATE registration_jobs SET status='failed', progress=100,
           error_code='REGISTER_BATCH_ABORTED', error='批次执行器提前结束',
           finished_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
           WHERE batch_id=? AND status IN ('queued','running')`
        ).run(state.run_id);
      }
      state.running = false;
      state.finished = true;
      state.finished_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
      state.current_email = '';
      state.message = body.pipeline
        ? `本波结束，成功 ${state.success}/${state.target}，失败 ${state.failed}${
            state.retried ? `，其中换代理重试 ${state.retried} 次` : ''
          }`
        : state.stop
          ? `已停止，成功 ${state.success}/${state.target}，失败 ${state.failed}`
          : `已结束，成功 ${state.success}/${state.target}，失败 ${state.failed}${
              state.retried ? `，其中换代理重试 ${state.retried} 次` : ''
            }`;
      persistState(userId, state);
      syncBatchTx(state.run_id, state.message, state.stop ? 'cancelled' : '');
      opLog.register(userId, state.success ? 'success' : 'info', state.message, {
        source: 'register',
        run_id: state.run_id,
      });
      runtime.closeAll().catch(() => {});
      try {
        if (isGcChannel(body.channel)) require('./accountGcPipeline').kick(userId);
        else require('./accountPipeline').kick(userId);
      } catch { /* poller optional */ }
    });

  const ctx = getPlanContext(user);
  return {
    ok: true,
    run_id: state.run_id,
    batch_id: state.run_id,
    job_ids: emails.map((row) => row._jobId),
    target,
    unused: mailProvider === 'mailcom' || mailProvider === 'mix' ? unused.length : emails.length,
    concurrency,
    proxy_group: proxyGroup || '直连',
    proxy_count: dynamicProxy ? target : proxies.length,
    cloak_max_concurrency: cloakMax,
    effective_concurrency: concurrency,
    launch_concurrency: launchConcurrency,
    resource_limited: Boolean(limits.resourceLimited),
    scheduler: {
      performance_profile: body.performance_profile,
      mailbox_pipeline: mailboxPlan,
    },
    warning:
      (mailProvider === 'mailcom' || mailProvider === 'mix') && requested > unused.length
        ? `目标 ${requested} 大于可用子号 ${unused.length}，已按 ${target} 启动`
        : '',
    plan_max: ctx.unlimited ? -1 : ctx.maxAccounts,
  };
}

function stop(userId, channel) {
  const state = jobs.get(jobSlotKey(userId, channel));
  if (!state?.running) return { ok: true, message: '当前没有运行中的注册任务' };
  state.stop = true;
  state.mailbox_pipeline?.cancelAll?.();
  state.running = false;
  state.finished = true;
  state.finished_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  state.message = '已取消全部排队和运行中的注册子任务';
  db.prepare(
    `UPDATE registration_jobs SET status='cancelled', progress=100,
     error_code='JOB_CANCELLED', error='收到停止指令',
     finished_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
     WHERE batch_id=? AND status IN ('queued','running')`
  ).run(state.run_id);
  persistState(userId, state);
  syncBatchTx(state.run_id, state.message, 'cancelled');
  opLog.register(userId, 'warning', '收到停止指令，正在轻轻关掉浏览器', {
    source: 'register',
    run_id: state.run_id,
  });
  if (state.runtime && typeof state.runtime.closeAll === 'function') {
    state.runtime.closeAll().catch(() => {});
  }
  return { ok: true, message: '已发送停止指令' };
}

function getBatch(userId, batchId) {
  return batchView(batchId, userId);
}

function getJob(userId, jobId) {
  const row = db.prepare('SELECT * FROM registration_jobs WHERE job_id = ? AND user_id = ?').get(jobId, userId);
  return row ? jobView(row) : null;
}

function activeBatches(userId) {
  return db.prepare(
    `SELECT batch_id FROM registration_batches
     WHERE user_id = ? AND status NOT IN ('completed','cancelled','interrupted')
     ORDER BY created_at DESC, updated_at DESC`
  ).all(userId).map(row => batchView(row.batch_id, userId));
}

function cancelBatch(userId, batchId) {
  const batch = db.prepare(
    'SELECT * FROM registration_batches WHERE batch_id = ? AND user_id = ?'
  ).get(batchId, userId);
  if (!batch) return null;
  const state = liveRegisterJob(userId, batchId);
  if (state?.run_id === batchId) return { ...stop(userId, state.channel), ...batchView(batchId, userId) };
  db.prepare(
    `UPDATE registration_jobs SET status='cancelled', progress=100,
     error_code='JOB_CANCELLED', error='收到批次取消指令',
     finished_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
     WHERE batch_id=? AND user_id=? AND status IN ('queued','running')`
  ).run(batchId, userId);
  syncBatchTx(batchId, '批次已取消', 'cancelled');
  return { ok: true, ...batchView(batchId, userId) };
}

function runtimeActivity(userId, channel) {
  const slot = jobSlotKey(userId, channel);
  const live = jobs.get(slot);
  const state = live || (isGcChannel(channel) ? { running: false } : latestPersistedState(userId));
  const batch = state.run_id ? batchView(state.run_id, userId) : null;
  const active = batch?.results?.filter(item => ['queued', 'running'].includes(item.status)) || [];
  return {
    running: Boolean(state.running),
    updated_at: state.updated_at || '',
    cloak: runtimeCapacity(state),
    activities: active.map(item => ({
      id: item.id,
      kind: 'register',
      label: item.email,
      status: item.status,
      progress: item.progress,
      attempt: item.attempt,
    })),
    batches: activeBatches(userId),
  };
}

module.exports = {
  options,
  start,
  stop,
  status,
  isLive,
  getBatch,
  getJob,
  activeBatches,
  cancelBatch,
  runtimeActivity,
  normalizeStartOptions,
  persistState,
  latestPersistedState,
  reconcileStaleRuns,
  reconcileDeadKind,
  reconcilePendingSettlements,
  loadRegistrationProxies,
  assertRegistrationProxySelection,
  resolveRegisterProxyGroup,
  describeRegisterProxySelection,
  _test: {
    consumeEmailAtCheckpoint,
    disableSuffixForAccountCreationFailure,
    listUnusedChildren,
    listRegisterableChildren,
    markEmailUsed,
    skipMailboxWithoutOtp,
    pickReplacementChild,
    selectUnusedForRegister,
    isMailboxOtpNotReceived,
    isAccountCreationRejectedFailure,
    insertAccount,
    buildRegisterAccountPayload,
    upsertAccountCheckpoint,
    persistRegisteredAccount,
    shouldPersistRegisterAccount,
    isTotpSuccessfullyEnrolled,
    discardIncompleteTwoFaAccount,
    checkTrialAfterRegister,
    isSafeRegisterTrialProxy,
    patchRegistrationJob,
    batchView,
    syncBatch: syncBatchTx,
    persistSettlement,
    settleJobChannel,
    claimSettlement,
    renewSettlementClaim,
    completeSettlementClaim,
    boundedSettlementCall,
    loadRegistrationProxies,
    assertRegistrationProxySelection,
  },
};
