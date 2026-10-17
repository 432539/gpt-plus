'use strict';

const db = require('../db');
const opLog = require('./opLog');
const { readSettings } = require('./settings');
const { deriveProgress, displayProgress, persistDerivedProgress, PROGRESS, lastExtractStamp, isExtractRetryDue, extractLinkState } = require('./accountProgress');
const {
  STEP_RETRY_CAP,
  shouldSkipExtract,
  shouldSkipPay,
  isPaidReadyForRt,
  isActivationRetryPending,
  underRetryCap,
} = require('./pipelineState');
const { pipelineCaps, remainingDailyRegisters, extractIntervalMs } = require('./pipelineCaps');
const { occupiedAccountEmailsSql } = require('./accountChannel');
const { selectRebindIds, rebindBlocksExtract } = require('./accountRebindJob');

const EXTRACT_INTERVAL_MS = 10 * 60 * 1000;
const EXTRACT_RETRY_MS = EXTRACT_INTERVAL_MS;
const TICK_MS = 20 * 1000;
const REGISTER_CONCURRENCY = 5;
const REGISTER_WAVE_MAX = 2000;
// Extract/pay have no product concurrency limit. 1000 is only a process safety valve.
const PIPELINE_UNLIMITED_CAP = 1000;
const PIPELINE_KEYS = Object.freeze(['register', 'rebind', 'extract', 'pay', 'acquire_rt']);

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
const lastSkipLog = new Map();
const SKIP_LOG_MS = 2 * 60 * 1000;

function logSkip(userId, category, key, message, level = 'warning') {
  const stamp = `${Number(userId) || 0}:${category}:${key}`;
  const prev = lastSkipLog.get(stamp) || 0;
  if (Date.now() - prev < SKIP_LOG_MS) return;
  lastSkipLog.set(stamp, Date.now());
  opLog[category](userId, level, message, { source: 'pipeline' });
}

function paySkipReason(row = {}, nowMs = Date.now(), caps = {}) {
  if (shouldSkipPay(row, caps)) {
    if (!underRetryCap(row, 'pay', caps.pay_attempts)) return 'pay_attempts';
    if (isActivationRetryPending(row)) return 'ok';
    if (String(row.activated_at || '').trim() || deriveProgress(row, nowMs) === PROGRESS.PAID) return 'activated';
    if (String(row.refresh_token || '').trim() || String(row.remark || '').trim() === '已拿RT') return 'has_rt';
    return 'should_skip_pay';
  }
  if (deriveProgress(row, nowMs) === PROGRESS.PAYMENT_REVIEW) return 'payment_review';
  const link = extractLinkState(row, nowMs);
  if (link === 'valid') return 'ok';
  if (link === 'expired') return 'extract_expired';
  return 'no_extract_link';
}

function parseStamp(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = /T/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function normalizePipeline(raw = {}) {
  return {
    register: raw.register === true,
    rebind: raw.rebind === true,
    extract: raw.extract === true,
    pay: raw.pay === true,
    acquire_rt: raw.acquire_rt === true,
  };
}

function registerWaveSize(unused, settings = {}) {
  const available = Math.max(0, Number(unused) || 0);
  if (!available) return { count: 0, concurrency: 0 };
  const count = Math.max(1, Math.min(REGISTER_WAVE_MAX, available));
  const cap = pipelineCaps(settings).register_concurrency;
  const concurrency = Math.max(1, Math.min(cap, count));
  return { count, concurrency };
}

function registerMailKind(settings = {}) {
  const pref = String(settings.registration?.mail_provider || 'mailcom').toLowerCase();
  try {
    const { mailpitReady } = require('./mailpit');
    const { cfMailReady } = require('./cfMail');
    if (pref === 'cfworker' && cfMailReady(settings)) return 'cfworker';
    if ((pref === 'mix' || pref === 'mail-mix') && cfMailReady(settings)) return 'mix';
    if (pref === 'mailpit' && mailpitReady(settings)) return 'mailpit';
  } catch {
    /* keep mailcom */
  }
  return 'mailcom';
}

function registerSupply(userId, settings = {}) {
  const remaining = remainingDailyRegisters(userId, settings);
  const kind = registerMailKind(settings);
  if (kind === 'mailpit' || kind === 'cfworker' || kind === 'mix') return remaining;
  const unused = unusedChildCount(userId);
  if (!unused) return 0;
  return Number.isFinite(remaining) ? Math.min(unused, remaining) : unused;
}

function pipelineConcurrency(count) {
  const n = Math.max(0, Number(count) || 0);
  if (!n) return 1;
  return Math.max(1, Math.min(n, PIPELINE_UNLIMITED_CAP));
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

function selectExtractIds(rows = [], nowMs = Date.now(), caps = {}) {
  const interval = extractIntervalMs(caps);
  const rebindRequired = caps.rebindRequired === true;
  return rows.filter((row) => {
    if (rebindBlocksExtract(row, rebindRequired)) return false;
    if (shouldSkipExtract(row, caps)) return false;
    if (!String(row.access_token || '').trim()) return false;
    if (!isExtractRetryDue(row, nowMs, interval)) return false;
    const progress = deriveProgress(row, nowMs);
    if (progress === PROGRESS.PAYMENT_REVIEW) return false;
    if (isActivationRetryPending(row)) {
      return progress !== PROGRESS.EXTRACTED;
    }
    if (Number(row.has_trial) !== 1) return false;
    return progress === PROGRESS.REGISTERED || progress === PROGRESS.EXTRACTED_EXPIRED;
  }).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

function selectPayIds(rows = [], nowMs = Date.now(), caps = {}) {
  return rows.filter((row) => {
    if (shouldSkipPay(row, caps)) return false;
    // 支付待核验不得再扣款。extract 间隔只约束提链，不推迟支付。
    if (deriveProgress(row, nowMs) === PROGRESS.PAYMENT_REVIEW) return false;
    return extractLinkState(row, nowMs) === 'valid';
  }).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

function rtBlockReason(row = {}, nowMs = Date.now(), caps = {}) {
  if (String(row.refresh_token || '').trim() || String(row.remark || '').trim() === '已拿RT') return 'has_rt';
  const paid = String(row.activated_at || '').trim() || deriveProgress(row, nowMs) === PROGRESS.PAID;
  if (!paid) return 'not_paid';
  if (!String(row.password_enc || '').trim()) return 'no_password';
  if (!String(row.totp_secret_enc || '').trim()) return 'no_totp';
  if (!underRetryCap(row, 'rt', caps.rt_attempts)) return 'rt_attempts';
  return '';
}

function canAcquireRt(row = {}, nowMs = Date.now(), caps = {}) {
  return !rtBlockReason(row, nowMs, caps);
}

function selectRtIds(rows = [], nowMs = Date.now(), extraIds = [], caps = {}) {
  const picked = new Set();
  const byId = new Map();
  for (const row of rows) {
    const id = Number(row.id);
    if (Number.isInteger(id) && id > 0) byId.set(id, row);
    if (!canAcquireRt(row, nowMs, caps)) continue;
    if (id > 0) picked.add(id);
  }
  for (const raw of extraIds) {
    const id = Number(raw);
    const row = byId.get(id);
    // extraIds 仍须该号已支付：未支付的已提链不得因 pending 队列提前拿 RT。
    if (!row || !canAcquireRt(row, nowMs, caps)) continue;
    picked.add(id);
  }
  return [...picked];
}

function unusedChildCount(userId) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS c FROM emails
     WHERE user_id = ?
       AND is_mother = 0
       AND mother_id IS NOT NULL
       AND mother_id != 0
       AND status = '未使用'
       AND lower(address) NOT IN (${occupiedAccountEmailsSql()})`
  ).get(userId, userId, userId)?.c) || 0;
}

function accountRows(userId) {
  return db.prepare(
    `SELECT * FROM gpt_accounts
     WHERE user_id = ? AND COALESCE(channel, 'gb') = 'gb'
     ORDER BY id`
  ).all(userId);
}

function logOnce(userId, category, message) {
  opLog[category](userId, 'info', message, { source: 'pipeline' });
}

function warnOnce(userId, category, message) {
  opLog[category](userId, 'warning', message, { source: 'pipeline' });
}

function jobs() {
  return {
    register: require('./registerJob'),
    rebind: require('./accountRebindJob'),
    extract: require('./oauthJob'),
    pay: require('./activateJob'),
    rt: require('./accountRtJob'),
  };
}

function jobIsLive(mod, userId) {
  if (!mod) return false;
  if (typeof mod.isLive === 'function') return Boolean(mod.isLive(userId));
  return Boolean(mod.status?.(userId)?.running);
}

function cloakBusy(userId, deps = jobs()) {
  const registerLive = jobIsLive(deps.register, userId)
    || (typeof deps.register.isLive === 'function' && deps.register.isLive(userId, 'gc'));
  return registerLive || jobIsLive(deps.pay, userId);
}

function stopOwned(kind, userId, deps = jobs()) {
  if (!owned[kind]?.has(userId)) return;
  try {
    if (kind === 'register') deps.register.stop(userId);
    else if (kind === 'rebind') deps.rebind.stop(userId);
    else if (kind === 'extract') deps.extract.stop(userId);
    else if (kind === 'pay') deps.pay.stop(userId);
    else if (kind === 'acquire_rt') deps.rt.stop(userId);
  } catch {
    /* already stopped */
  }
  owned[kind].delete(userId);
}

async function startRegister(userId, settings, deps = jobs()) {
  if (jobIsLive(deps.register, userId)) return { skipped: true, reason: 'running' };
  if (cloakBusy(userId, deps)) return { skipped: true, reason: 'cloak_busy' };
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
    const mailCount = Math.min(shares.mailcom, unused);
    available = mailCount + shares.cfworker;
    if (!available) return { skipped: true, reason: unused ? 'daily_cap' : 'no_unused' };
  } else {
    const unused = unusedChildCount(userId);
    if (!unused) return { skipped: true, reason: 'no_unused' };
    available = Number.isFinite(remaining) ? Math.min(unused, remaining) : unused;
  }
  const { count, concurrency } = registerWaveSize(available, settings);
  owned.register.add(userId);
  logOnce(userId, 'register', `流水线自动注册：本波 ${count} 个，并发 ${concurrency}`);
  await deps.register.start({ id: userId }, {
    quantity: count,
    concurrency,
    pipeline: true,
    mail_provider: mailProvider,
    mailcom_share: settings.registration?.mailcom_share ?? 5,
    cfworker_share: settings.registration?.cfworker_share ?? 5,
    proxy_group: '__auto__:GB',
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

async function startRebind(userId, ids, deps = jobs()) {
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  const already = jobIsLive(deps.rebind, userId);
  owned.rebind.add(userId);
  const concurrency = Math.max(1, Math.min(wave.length, 8));
  const result = await deps.rebind.start({ id: userId }, {
    ids: wave,
    concurrency,
    pipeline: true,
    proxy_group: '__auto__:GB',
    proxy_country: 'GB',
    dynamic_proxy: true,
    channel: 'gb',
  });
  if (!already) opLog.account(userId, 'info', `流水线自动换绑：${wave.length} 个试用账号`, { source: 'rebind' });
  else if (result?.enqueued) opLog.account(userId, 'info', `流水线换绑补入 ${result.enqueued} 个`, { source: 'rebind' });
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0, concurrency };
}

async function startExtract(userId, ids, deps = jobs()) {
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  const already = jobIsLive(deps.extract, userId);
  owned.extract.add(userId);
  const concurrency = pipelineConcurrency(wave.length);
  const result = await deps.extract.start({ id: userId }, {
    ids: wave,
    concurrency,
    pipeline: true,
  });
  if (!already) logOnce(userId, 'oauth', `流水线自动提链：${wave.length} 个试用账号，并发 ${concurrency}`);
  else if (result?.enqueued) logOnce(userId, 'oauth', `流水线提链补入 ${result.enqueued} 个`);
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0, concurrency };
}

async function startPay(userId, ids, deps = jobs()) {
  if (!ids.length) {
    logSkip(userId, 'activate', 'pay-empty', '流水线自动支付跳过：没有有效提链（未过期且未支付）');
    return { skipped: true, reason: 'empty' };
  }
  const already = jobIsLive(deps.pay, userId);
  // 提链、拿 RT、注册均不得挡住已提链支付。注册即使占用 Cloak，支付也并行拉起，
  // 否则开关开着时残留已提链会一直等注册批次结束。
  if (!already && jobIsLive(deps.register, userId)) {
    logSkip(
      userId,
      'activate',
      'pay-parallel-register',
      '流水线自动支付：注册任务仍在跑，支付并行启动',
      'info',
    );
  }
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  owned.pay.add(userId);
  const concurrency = pipelineConcurrency(wave.length);
  const result = await deps.pay.start({ id: userId }, {
    ids: wave,
    concurrency,
    pipeline: true,
  });
  if (!already) logOnce(userId, 'activate', `流水线自动支付：${wave.length} 个已提链账号，并发 ${concurrency}`);
  else if (result?.enqueued) logOnce(userId, 'activate', `流水线支付补入 ${result.enqueued} 个`);
  return { skipped: false, count: wave.length, enqueued: result?.enqueued || 0, concurrency };
}

async function startRt(userId, ids, settings, deps = jobs()) {
  if (!ids.length) return { skipped: true, reason: 'empty' };
  const wave = ids.slice(0, PIPELINE_UNLIMITED_CAP);
  const already = jobIsLive(deps.rt, userId);
  const concurrency = pipelineConcurrency(wave.length);
  owned.acquire_rt.add(userId);
  const result = await deps.rt.start({ id: userId }, {
    ids: wave,
    concurrency,
    proxy_group: '__auto__:GB',
    proxy_country: 'GB',
    dynamic_proxy: true,
    phone_country: 'CL',
    pipeline: true,
  });
  if (!already) logOnce(userId, 'register', `流水线协议拿 RT：${wave.length} 个已支付账号`);
  else if (result?.enqueued) logOnce(userId, 'register', `流水线拿 RT 补入 ${result.enqueued} 个`);
  clearPendingRt(userId, wave);
  return { skipped: false, count: wave.length, concurrency, enqueued: result?.enqueued || 0 };
}

function watchdogUser(userId, pipeline, jobDeps = jobs(), opts = {}) {
  const restarted = [];
  const rows = opts.rows || [];
  const nowMs = Number(opts.nowMs) || Date.now();
  const caps = opts.caps || {};
  for (const kind of PIPELINE_KEYS) {
    if (!pipeline[kind]) continue;
    const dep = kind === 'acquire_rt' ? jobDeps.rt : kind === 'rebind' ? jobDeps.rebind : jobDeps[kind];
    const live = jobIsLive(dep, userId);
    if (live) {
      if (kind === 'pay' && typeof dep.dropSettled === 'function') {
        try { dep.dropSettled(userId); } catch { /* keep going */ }
      }
      continue;
    }
    if (kind === 'register' && typeof jobDeps.register.reconcileDeadKind === 'function') {
      try { jobDeps.register.reconcileDeadKind(userId, 'register'); } catch { /* keep going */ }
    }
    if (kind === 'rebind' && typeof jobDeps.rebind?.reconcileStale === 'function') {
      try { jobDeps.rebind.reconcileStale(userId); } catch { /* keep going */ }
    }
    if (kind === 'acquire_rt' && typeof jobDeps.rt.reconcileStale === 'function') {
      try { jobDeps.rt.reconcileStale(userId); } catch { /* keep going */ }
    } else if (kind === 'acquire_rt' && typeof jobDeps.register.reconcileDeadKind === 'function') {
      try { jobDeps.register.reconcileDeadKind(userId, 'account-rt'); } catch { /* keep going */ }
    }
    if (kind === 'rebind' && !selectRebindIds(rows, nowMs, caps).length) {
      owned.rebind.delete(userId);
      continue;
    }
    if (kind === 'acquire_rt' && !selectRtIds(rows, nowMs, pendingRtIds(userId), caps).length) {
      owned.acquire_rt.delete(userId);
      const blocked = {};
      for (const row of rows || []) {
        const reason = rtBlockReason(row, nowMs, caps);
        if (reason === 'has_rt' || reason === 'not_paid') continue;
        if (reason) blocked[reason] = (blocked[reason] || 0) + 1;
      }
      const parts = Object.entries(blocked).map(([key, n]) => `${key}=${n}`);
      if (parts.length) {
        logSkip(
          userId,
          'register',
          'rt-blocked',
          `流水线拿 RT 暂不拉起：已支付但仍无 RT（${parts.join('，')}）`,
        );
      }
      continue;
    }
    if (owned[kind].has(userId)) {
      owned[kind].delete(userId);
      warnOnce(
        userId,
        kind === 'extract' ? 'oauth' : kind === 'pay' ? 'activate' : kind === 'rebind' ? 'account' : 'register',
        `流水线看门狗：${kind === 'acquire_rt' ? '拿RT' : kind === 'extract' ? '提链' : kind === 'pay' ? '支付' : kind === 'rebind' ? '换绑' : '注册'}已掉线，开关仍开着，将自动拉起`,
      );
      restarted.push(kind);
    }
  }
  return restarted;
}

function notePaidForRt(userId, accountId, deps = {}) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: true, reason: 'bad_id' };
  queuePendingRt(userId, id);
  Promise.resolve()
    .then(async () => {
      const settings = (deps.readSettings || readSettings)(userId);
      if (!normalizePipeline(settings.pipeline).acquire_rt) return;
      const jobDeps = deps.jobs || jobs();
      await (deps.startRt || startRt)(userId, [id], settings, jobDeps);
    })
    .catch((error) => {
      opLog.register(
        userId,
        'warning',
        `支付成功后自动拿 RT 未启动：${String(error?.message || error).slice(0, 160)}`,
        { source: 'pipeline' },
      );
    });
  return { queued: true, id };
}

async function tickUser(userId, deps = {}) {
  const settings = (deps.readSettings || readSettings)(userId);
  const pipeline = normalizePipeline(settings.pipeline);
  const jobDeps = deps.jobs || jobs();
  const watch = deps.watchdogUser || watchdogUser;

  if (!pipeline.register) stopOwned('register', userId, jobDeps);
  if (!pipeline.rebind) stopOwned('rebind', userId, jobDeps);
  if (!pipeline.extract) stopOwned('extract', userId, jobDeps);
  if (!pipeline.pay) stopOwned('pay', userId, jobDeps);
  if (!pipeline.acquire_rt) stopOwned('acquire_rt', userId, jobDeps);
  if (!pipeline.register && !pipeline.rebind && !pipeline.extract && !pipeline.pay && !pipeline.acquire_rt) return;

  const rows = (deps.accountRows || accountRows)(userId);
  const nowMs = Number(deps.nowMs) || Date.now();
  const caps = { ...pipelineCaps(settings), rebindRequired: pipeline.rebind };
  watch(userId, pipeline, jobDeps, { rows, nowMs, caps });
  try {
    for (const row of rows) persistDerivedProgress(userId, row.id, row);
  } catch {
    /* progress reconcile optional */
  }

  async function runRebind() {
    if (!pipeline.rebind) return;
    const ids = selectRebindIds(rows, nowMs, caps);
    if (!ids.length) return;
    try {
      await (deps.startRebind || startRebind)(userId, ids, jobDeps);
    } catch (error) {
      if (!/运行中|不符合换绑/.test(String(error.message || ''))) {
        owned.rebind.delete(userId);
        warnOnce(userId, 'account', `流水线自动换绑未启动：${String(error.message || error).slice(0, 160)}`);
      }
    }
  }

  async function runExtract() {
    if (!pipeline.extract) return;
    const ids = selectExtractIds(rows, nowMs, caps);
    if (!ids.length) return;
    try {
      await (deps.startExtract || startExtract)(userId, ids, jobDeps);
    } catch (error) {
      if (error?.status === 409 || /已有提链/.test(String(error.message || ''))) {
        try {
          await jobDeps.extract.start({ id: userId }, {
            ids,
            concurrency: pipelineConcurrency(ids.length),
            pipeline: true,
          });
        } catch {
          /* still running, next tick */
        }
      } else {
        owned.extract.delete(userId);
        warnOnce(userId, 'oauth', `流水线自动提链未启动：${String(error.message || error).slice(0, 160)}`);
      }
    }
  }

  async function runRt() {
    if (!pipeline.acquire_rt) return;
    const ids = selectRtIds(rows, nowMs, pendingRtIds(userId), caps);
    if (!ids.length) {
      const blocked = {};
      for (const row of rows) {
        const reason = rtBlockReason(row, nowMs, caps);
        if (reason === 'has_rt' || reason === 'not_paid') continue;
        if (reason) blocked[reason] = (blocked[reason] || 0) + 1;
      }
      const parts = Object.entries(blocked).map(([key, n]) => `${key}=${n}`);
      if (parts.length) {
        logSkip(
          userId,
          'register',
          'rt-blocked',
          `流水线拿 RT 暂不拉起：已支付但仍无 RT（${parts.join('，')}）`,
        );
      }
      return;
    }
    try {
      await (deps.startRt || startRt)(userId, ids, settings, jobDeps);
    } catch (error) {
      owned.acquire_rt.delete(userId);
      if (!/运行中/.test(String(error.message || ''))) {
        warnOnce(userId, 'register', `流水线拿 RT 未启动：${String(error.message || error).slice(0, 160)}`);
      }
    }
  }

  async function runPay() {
    if (!pipeline.pay) return;
    const ids = selectPayIds(rows, nowMs, caps);
    if (!ids.length) {
      const idle = { extract: { running: false }, activate: { running: false }, detect: { running: false } };
      const reasons = {};
      for (const row of rows) {
        const shown = displayProgress(row, idle, nowMs);
        if (shown !== PROGRESS.EXTRACTED && shown !== PROGRESS.EXTRACTED_EXPIRED
          && row.progress !== PROGRESS.EXTRACTED && row.progress !== PROGRESS.EXTRACTED_EXPIRED) continue;
        const reason = paySkipReason(row, nowMs, caps);
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      const expired = reasons.extract_expired || 0;
      const leftover = Object.entries(reasons).filter(([key]) => key !== 'ok');
      if (expired) {
        logSkip(userId, 'activate', 'pay-expired', `流水线自动支付跳过：${expired} 个已提链已过期，改走重新提链`);
      }
      if (leftover.length && leftover.some(([key]) => key !== 'extract_expired')) {
        logSkip(
          userId,
          'activate',
          'pay-skip-reasons',
          `流水线自动支付跳过：${leftover.map(([key, n]) => `${key}=${n}`).join('，')}`,
        );
      }
      return;
    }
    try {
      const result = await (deps.startPay || startPay)(userId, ids, jobDeps);
      if (result?.skipped && result.reason && result.reason !== 'empty') {
        logSkip(userId, 'activate', `pay-${result.reason}`, `流水线自动支付跳过：${result.reason}`);
      }
    } catch (error) {
      owned.pay.delete(userId);
      const text = String(error.message || error);
      if (/所选支付代理分组没有代理|没有可用且区域为 GB/.test(text)) {
        logSkip(userId, 'activate', 'pay-no-proxy', '流水线自动支付跳过：没有可用的 GB 支付代理');
      } else if (/SMS|smsbower|缺少.*短信|SMS_KEY_MISSING/i.test(text)) {
        logSkip(userId, 'activate', 'pay-sms', '流水线自动支付跳过：短信配置不可用');
      } else if (!/已有开通/.test(text)) {
        warnOnce(userId, 'activate', `流水线自动支付未启动：${text.slice(0, 160)}`);
      }
    }
  }

  // 支付与提链同时开着时不要互相 await：提链 Cloak 初始化较慢时，已提链应立刻进入支付。
  // 拿 RT 也不等整批支付结束（notePaidForRt 仍可在开通成功后立刻入队）。
  // 注册放在支付之后：已提链优先占用 Cloak，避免注册长跑把支付饿死。
  await Promise.all([runPay(), runRebind(), runExtract(), runRt()]);

  if (pipeline.register) {
    try {
      const result = await (deps.startRegister || startRegister)(userId, settings, jobDeps);
      if (result?.skipped && result.reason && result.reason !== 'running' && result.reason !== 'no_unused') {
        logSkip(userId, 'register', `register-${result.reason}`, `流水线自动注册跳过：${result.reason}`);
      }
    } catch (error) {
      owned.register.delete(userId);
      if (!/已有注册任务/.test(String(error.message || ''))) {
        warnOnce(userId, 'register', `流水线自动注册未启动：${String(error.message || error).slice(0, 160)}`);
      }
    }
  }
}

async function tick(deps = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const users = (deps.users || db.prepare('SELECT id FROM users WHERE status = 1').all());
    for (const user of users) {
      await tickUser(user.id, deps);
    }
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
  setTimeout(() => { tick().catch(() => {}); }, 3000);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

module.exports = {
  EXTRACT_RETRY_MS,
  EXTRACT_INTERVAL_MS,
  REGISTER_CONCURRENCY,
  REGISTER_WAVE_MAX,
  PIPELINE_UNLIMITED_CAP,
  STEP_RETRY_CAP,
  PIPELINE_KEYS,
  normalizePipeline,
  isExtractRetryDue,
  lastExtractStamp,
  registerWaveSize,
  registerMailKind,
  registerSupply,
  selectExtractIds,
  selectRebindIds,
  startRebind,
  selectPayIds,
  selectRtIds,
  canAcquireRt,
  rtBlockReason,
  notePaidForRt,
  unusedChildCount,
  jobIsLive,
  watchdogUser,
  accountRows,
  startRegister,
  startExtract,
  startPay,
  startRt,
  tickUser,
  tick,
  kick,
  startPoller,
  paySkipReason,
  _test: { owned, parseStamp, jobIsLive, cloakBusy, pendingRtByUser, lastSkipLog },
};
