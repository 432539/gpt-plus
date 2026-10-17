'use strict';

const db = require('../db');
const opLog = require('./opLog');
const { readSettings } = require('./settings');
const { persistDerivedProgress, PROGRESS, lastExtractStamp, isExtractRetryDue, extractLinkState } = require('./accountProgress');
const { isTrialUnset } = require('./accountCheck');
const {
  shouldSkipExtract,
  shouldSkipPay,
  isActivationRetryPending,
  underRetryCap,
} = require('./pipelineState');
const { pipelineCaps, remainingDailyRegisters, extractIntervalMs } = require('./pipelineCaps');
const {
  normalizePipeline,
  registerWaveSize,
  selectExtractIds,
  selectPayIds,
  selectRtIds,
  rtBlockReason,
  unusedChildCount,
  jobIsLive,
  PIPELINE_UNLIMITED_CAP,
} = require('./accountPipeline');
const { selectRebindIds } = require('./accountRebindJob');

const TICK_MS = 20 * 1000;
const owned = {
  register: new Set(),
  rebind: new Set(),
  extract: new Set(),
  pay: new Set(),
  acquire_rt: new Set(),
};
const pendingRtByUser = new Map();
let ticking = false;
let timer = null;

function accountRows(userId) {
  return db.prepare(
    `SELECT * FROM gpt_accounts
     WHERE user_id = ? AND COALESCE(channel, 'gb') = 'gc'
     ORDER BY id`
  ).all(userId);
}

function jobs() {
  return {
    register: require('./registerJob'),
    rebind: require('./accountRebindJob'),
    extract: require('./gcashExtractJob'),
    pay: require('./gcashPayJob'),
    rt: require('./accountRtJob'),
    detect: require('./gcashDetectJob'),
  };
}

function allowGcashExtract(settings = {}, body = {}) {
  if (body.pipeline === true) return normalizePipeline(settings.pipeline_gc).extract === true;
  return true;
}

function selectDetectIds(rows = []) {
  return rows.filter((row) => {
    if (!String(row.access_token || '').trim()) return false;
    return isTrialUnset(row.has_trial);
  }).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

function queuePendingRt(userId, id) {
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) return;
  let set = pendingRtByUser.get(userId);
  if (!set) {
    set = new Set();
    pendingRtByUser.set(userId, set);
  }
  set.add(accountId);
}

function pendingRtIds(userId) {
  return [...(pendingRtByUser.get(userId) || [])];
}

function clearPendingRt(userId, ids = []) {
  const set = pendingRtByUser.get(userId);
  if (!set) return;
  for (const id of ids) set.delete(Number(id));
  if (!set.size) pendingRtByUser.delete(userId);
}

function stopOwned(kind, userId, deps = jobs()) {
  if (!owned[kind]?.has(userId)) return;
  try {
    if (kind === 'register') deps.register.stop(userId, 'gc');
    else if (kind === 'rebind') deps.rebind.stop(userId, 'gc');
    else if (kind === 'extract') deps.extract.stop(userId);
    else if (kind === 'pay') deps.pay.stop(userId);
    else if (kind === 'acquire_rt') deps.rt.stop(userId, 'gc');
  } catch {
    /* already stopped */
  }
  owned[kind].delete(userId);
}

function registerLive(deps, userId) {
  if (typeof deps.register.isLive === 'function') return Boolean(deps.register.isLive(userId, 'gc'));
  return Boolean(deps.register.status?.(userId, 'gc')?.running);
}

function rtLive(deps, userId) {
  if (typeof deps.rt.isLive === 'function') {
    try { return Boolean(deps.rt.isLive(userId, 'gc')); } catch { /* fallback */ }
  }
  return jobIsLive(deps.rt, userId);
}

async function startRegister(userId, settings, deps = jobs()) {
  if (registerLive(deps, userId)) return { skipped: true, reason: 'running' };
  if (typeof deps.register.isLive === 'function' && deps.register.isLive(userId)) {
    return { skipped: true, reason: 'cloak_busy' };
  }
  const remaining = remainingDailyRegisters(userId, settings);
  if (remaining === 0) return { skipped: true, reason: 'daily_cap' };
  const { mailpitReady } = require('./mailpit');
  const { cfMailReady, splitMailMix } = require('./cfMail');
  const pref = String(settings.registration?.mail_provider || 'mailcom').toLowerCase();
  let mailProvider = 'mailcom';
  if (pref === 'cfworker' && cfMailReady(settings)) mailProvider = 'cfworker';
  else if ((pref === 'mix' || pref === 'mail-mix') && cfMailReady(settings)) mailProvider = 'mix';
  else if (pref === 'mailpit' && mailpitReady(settings)) mailProvider = 'mailpit';
  let available;
  if (mailProvider === 'mailpit' || mailProvider === 'cfworker') {
    const cap = pipelineCaps(settings).register_concurrency;
    available = Number.isFinite(remaining) ? Math.min(remaining, cap) : cap;
    if (!available) return { skipped: true, reason: 'daily_cap' };
  } else if (mailProvider === 'mix') {
    const unused = unusedChildCount(userId);
    const cap = pipelineCaps(settings).register_concurrency;
    const wave = Number.isFinite(remaining) ? Math.min(remaining, cap) : cap;
    const shares = splitMailMix(
      wave,
      settings.registration?.mailcom_share ?? 5,
      settings.registration?.cfworker_share ?? 5,
    );
    available = Math.min(shares.mailcom, unused) + shares.cfworker;
    if (!available) return { skipped: true, reason: unused ? 'daily_cap' : 'no_unused' };
  } else {
    const unused = unusedChildCount(userId);
    if (!unused) return { skipped: true, reason: 'no_unused' };
    available = Number.isFinite(remaining) ? Math.min(unused, remaining) : unused;
  }
  const { count, concurrency } = registerWaveSize(available, settings);
  owned.register.add(userId);
  opLog.register(userId, 'info', `GC 流水线自动注册：本波 ${count} 个，并发 ${concurrency}`, { source: 'pipeline-gc' });
  await deps.register.start({ id: userId }, {
    quantity: count,
    concurrency,
    pipeline: true,
    mail_provider: mailProvider,
    mailcom_share: settings.registration?.mailcom_share ?? 5,
    cfworker_share: settings.registration?.cfworker_share ?? 5,
    proxy_group: '__auto__:PH',
    proxy_country: 'PH',
    channel: 'gc',
    set_password: true,
    enable_totp_2fa: true,
    get_refresh_token: false,
    register_mode: 'headless_click',
    performance_profile: settings.registration?.performance_profile,
    headless: true,
    humanize: true,
  });
  return { skipped: false, count, concurrency };
}

async function startDetect(userId, ids, deps = jobs()) {
  if (!ids.length) return { skipped: true, reason: 'empty' };
  if (typeof deps.detect?.isLive === 'function' && deps.detect.isLive(userId)) {
    return { skipped: true, reason: 'running' };
  }
  if (jobIsLive(deps.detect, userId)) return { skipped: true, reason: 'running' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  const result = await deps.detect.start({ id: userId }, {
    ids: wave,
    concurrency: Math.max(1, Math.min(wave.length, require('./gcashConcurrency').gcashConcurrencyCap())),
    channel: 'gc',
  });
  opLog.account(userId, 'info', `GC 流水线资格检测：${wave.length} 个（未开出码，只更新 has_trial）`, {
    source: 'pipeline-gc',
  });
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0 };
}

async function startRebind(userId, ids, deps = jobs()) {
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  owned.rebind.add(userId);
  const result = await deps.rebind.start({ id: userId }, {
    ids: wave,
    concurrency: Math.max(1, Math.min(wave.length, 8)),
    pipeline: true,
    proxy_group: '__auto__:PH',
    proxy_country: 'PH',
    dynamic_proxy: true,
    channel: 'gc',
  });
  opLog.account(userId, 'info', `GC 流水线自动换绑：${wave.length} 个`, { source: 'rebind' });
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0 };
}

async function startExtract(userId, ids, deps = jobs()) {
  const settings = (deps.readSettings || readSettings)(userId);
  if (!allowGcashExtract(settings, { pipeline: true })) {
    return { skipped: true, reason: 'extract_off' };
  }
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  owned.extract.add(userId);
  const result = await deps.extract.start({ id: userId }, {
    ids: wave,
    concurrency: Math.max(1, Math.min(wave.length, require('./gcashConcurrency').gcashConcurrencyCap())),
    pipeline: true,
    channel: 'gc',
  });
  opLog.oauth(userId, 'info', `GC 流水线自动提链：${wave.length} 个`, { source: 'pipeline-gc' });
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0 };
}

async function startPay(userId, ids, deps = jobs()) {
  if (require('../mkGcash/enabled').mkGcashEnabled()) {
    return { skipped: true, reason: 'mk_gcash_monitor_inline' };
  }
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  owned.pay.add(userId);
  const result = await deps.pay.start({ id: userId }, {
    ids: wave,
    concurrency: Math.max(1, Math.min(wave.length, require('./gcashConcurrency').gcashConcurrencyCap())),
    pipeline: true,
    channel: 'gc',
  });
  opLog.activate(userId, 'info', `GC 流水线支付墙：${wave.length} 个已出码账号`, { source: 'pipeline-gc' });
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0 };
}

async function startRt(userId, ids, settings, deps = jobs()) {
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  owned.acquire_rt.add(userId);
  const result = await deps.rt.start({ id: userId }, {
    ids: wave,
    concurrency: Math.max(1, Math.min(wave.length, 8)),
    proxy_group: '__auto__:PH',
    proxy_country: 'PH',
    dynamic_proxy: true,
    phone_country: 'CL',
    pipeline: true,
    channel: 'gc',
  });
  opLog.register(userId, 'info', `GC 流水线协议拿 RT：${wave.length} 个`, { source: 'pipeline-gc' });
  clearPendingRt(userId, wave);
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0 };
}

function notePaidForRt(userId, accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: true, reason: 'bad_id' };
  queuePendingRt(userId, id);
  Promise.resolve()
    .then(async () => {
      const settings = readSettings(userId);
      if (!normalizePipeline(settings.pipeline_gc).acquire_rt) return;
      await startRt(userId, [id], settings);
    })
    .catch(() => {});
  return { queued: true, id };
}

async function tickUser(userId, deps = {}) {
  const settings = (deps.readSettings || readSettings)(userId);
  const pipeline = normalizePipeline(settings.pipeline_gc);
  const jobDeps = deps.jobs || jobs();
  if (!pipeline.register) stopOwned('register', userId, jobDeps);
  if (!pipeline.rebind) stopOwned('rebind', userId, jobDeps);
  if (!pipeline.extract) stopOwned('extract', userId, jobDeps);
  if (!pipeline.pay) stopOwned('pay', userId, jobDeps);
  if (!pipeline.acquire_rt) stopOwned('acquire_rt', userId, jobDeps);
  if (!pipeline.register && !pipeline.rebind && !pipeline.extract && !pipeline.pay && !pipeline.acquire_rt) return;

  const rows = (deps.accountRows || accountRows)(userId);
  const nowMs = Number(deps.nowMs) || Date.now();
  const caps = { ...pipelineCaps(settings), rebindRequired: pipeline.rebind };
  try {
    for (const row of rows) persistDerivedProgress(userId, row.id, row);
  } catch { /* optional */ }

  if (pipeline.rebind) {
    const ids = selectRebindIds(rows, nowMs, caps);
    if (ids.length) {
      try { await (deps.startRebind || startRebind)(userId, ids, jobDeps); } catch { owned.rebind.delete(userId); }
    }
  }
  if (pipeline.extract) {
    const ids = selectExtractIds(rows, nowMs, caps);
    if (ids.length) {
      try { await (deps.startExtract || startExtract)(userId, ids, jobDeps); } catch { owned.extract.delete(userId); }
    }
  } else {
    const ids = selectDetectIds(rows);
    if (ids.length) {
      try { await (deps.startDetect || startDetect)(userId, ids, jobDeps); } catch { /* detect is optional */ }
    }
  }
  if (pipeline.pay) {
    const ids = selectPayIds(rows, nowMs, caps);
    if (ids.length) {
      try { await (deps.startPay || startPay)(userId, ids, jobDeps); } catch { owned.pay.delete(userId); }
    }
  }
  if (pipeline.acquire_rt) {
    const ids = selectRtIds(rows, nowMs, pendingRtIds(userId), caps);
    if (ids.length) {
      try { await (deps.startRt || startRt)(userId, ids, settings, jobDeps); } catch { owned.acquire_rt.delete(userId); }
    }
  }
  if (pipeline.register) {
    try { await (deps.startRegister || startRegister)(userId, settings, jobDeps); } catch { owned.register.delete(userId); }
  }
}

async function tick(deps = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const users = deps.users || db.prepare('SELECT id FROM users WHERE status = 1').all();
    for (const user of users) await tickUser(user.id, deps);
  } finally {
    ticking = false;
  }
}

function kick(userId) {
  Promise.resolve()
    .then(() => (userId ? tickUser(userId) : tick()))
    .catch(() => {});
}

function startPoller() {
  if (timer) return;
  setTimeout(() => { tick().catch(() => {}); }, 4000);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

module.exports = {
  accountRows,
  allowGcashExtract,
  selectDetectIds,
  startRegister,
  startRebind,
  startDetect,
  startExtract,
  startPay,
  startRt,
  notePaidForRt,
  tickUser,
  tick,
  kick,
  startPoller,
  lastExtractStamp,
  isExtractRetryDue,
  extractLinkState,
  shouldSkipExtract,
  shouldSkipPay,
  isActivationRetryPending,
  underRetryCap,
  rtBlockReason,
  PROGRESS,
};
