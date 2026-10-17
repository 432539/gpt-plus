'use strict';

const REGISTER_PERFORMANCE_PROFILES = Object.freeze({ SAFE: 'safe', THROUGHPUT: 'throughput' });
const REGISTER_PERFORMANCE_PROFILE_NAMES = new Set(Object.values(REGISTER_PERFORMANCE_PROFILES));

function normalizeRegisterPerformanceProfile(value, fallback = REGISTER_PERFORMANCE_PROFILES.SAFE) {
  const candidate = String(value ?? '').trim().toLowerCase();
  if (REGISTER_PERFORMANCE_PROFILE_NAMES.has(candidate)) return candidate;
  return REGISTER_PERFORMANCE_PROFILE_NAMES.has(fallback) ? fallback : REGISTER_PERFORMANCE_PROFILES.SAFE;
}

const TUNING = Object.freeze({
  safe: Object.freeze({
    cookieConsentProbeMs: 2500, emailSettleMs: 300, entrySignalWaitMs: 12000,
    otpAutoSubmitGraceMs: 2500, callbackProbeAfterMs: 0, callbackProbeTimeoutMs: 0,
    sessionWallTimeoutMs: 10 * 60 * 1000,
  }),
  throughput: Object.freeze({
    cookieConsentProbeMs: 250, emailSettleMs: 100, entrySignalWaitMs: 6000,
    otpAutoSubmitGraceMs: 400, callbackProbeAfterMs: 12000, callbackProbeTimeoutMs: 8000,
    sessionWallTimeoutMs: 12 * 60 * 1000,
  }),
});

function headlessInteractionTuning(value) {
  return TUNING[normalizeRegisterPerformanceProfile(value)];
}

const REGISTER_CONCURRENCY_CAP = 200;
const REGISTER_LAUNCH_CONCURRENCY_LIMIT = 20;

function planRegisterRuntimeLimits({
  requestedThreads,
  target,
  cloakMaxConcurrency,
  resourceConcurrency,
  performanceProfile,
  launchConcurrencyLimit,
  concurrencyCap = REGISTER_CONCURRENCY_CAP,
} = {}) {
  const cap = Math.max(1, Math.min(REGISTER_CONCURRENCY_CAP, Number.parseInt(concurrencyCap, 10) || REGISTER_CONCURRENCY_CAP));
  const configuredCloakMax = Math.max(1, Math.min(cap, Number(cloakMaxConcurrency) || 3));
  const resourceCloakMax = Math.max(1, Number(resourceConcurrency) || configuredCloakMax);
  const requested = Math.max(1, Math.min(cap, Number.parseInt(requestedThreads, 10) || 1));
  const jobTarget = Math.max(1, Number.parseInt(target, 10) || 1);
  const cloakMax = Math.min(resourceCloakMax, Math.max(configuredCloakMax, requested));
  const concurrency = Math.max(1, Math.min(requested, cloakMax, jobTarget));
  const profile = normalizeRegisterPerformanceProfile(performanceProfile);
  const launchLimit = Math.max(1, Math.min(
    REGISTER_LAUNCH_CONCURRENCY_LIMIT,
    Number.parseInt(launchConcurrencyLimit, 10) || 5,
  ));
  // Safe vs throughput only changes page timing and mailbox prefetch. Cold-start
  // stagger follows the shared launch cap so configured worker count can overlap.
  const launchConcurrency = Math.max(1, Math.min(cloakMax, concurrency, launchLimit));
  return {
    configuredCloakMax,
    resourceCloakMax,
    requestedThreads: requested,
    cloakMax,
    concurrency,
    launchConcurrency,
    performanceProfile: profile,
    resourceLimited: cloakMax < requested,
  };
}

function planRegisterMailboxPipeline({ performanceProfile, effectiveConcurrency, launchConcurrency } = {}) {
  const profile = normalizeRegisterPerformanceProfile(performanceProfile);
  const concurrency = Math.max(1, Math.floor(Number(effectiveConcurrency) || 1));
  const launch = Math.max(1, Math.min(concurrency, Math.floor(Number(launchConcurrency) || 1)));
  if (profile !== 'throughput') return { enabled: false, capacity: 0, buffered: 0, launchConcurrency: launch };
  const prefetch = Math.max(0, Math.min(50, launch));
  const capacity = Math.max(1, Math.min(concurrency, launch + prefetch));
  return { enabled: true, capacity, buffered: Math.max(0, capacity - launch), launchConcurrency: launch };
}

function createRegisterMailboxPipeline(plan = {}) {
  if (plan.enabled !== true) return null;
  const capacity = Math.max(1, Number(plan.capacity) || 1);
  let active = 0;
  const queue = [];
  let stopped = false;
  const cancelledError = () => Object.assign(new Error('任务已取消'), { code: 'JOB_CANCELLED' });
  const drain = () => {
    while (!stopped && active < capacity && queue.length) {
      active += 1;
      queue.shift().resolve();
    }
  };
  return {
    ...plan,
    async acquire(cancelled) {
      if (stopped || cancelled?.()) throw cancelledError();
      if (active >= capacity) {
        await new Promise((resolve, reject) => queue.push({ resolve, reject }));
      }
      else active += 1;
      if (stopped || cancelled?.()) {
        active = Math.max(0, active - 1);
        drain();
        throw cancelledError();
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
          drain();
        },
      };
    },
    cancelAll() {
      stopped = true;
      while (queue.length) queue.shift().reject(cancelledError());
    },
    stats: () => ({ capacity, active, queued: queue.length }),
  };
}

const terminal = new Set(['success', 'failed', 'partial', 'cancelled', 'skipped']);
const timeMs = value => Number.isFinite(Date.parse(String(value || ''))) ? Date.parse(String(value)) : 0;
const rounded = value => Math.round(value * 100) / 100;

function calculateRegisterThroughput(batch = {}, results = [], { nowMs = Date.now(), capacity = 0, targetPerMinute = 100 } = {}) {
  const rows = Array.isArray(results) ? results : [];
  const start = timeMs(batch.created_at) || nowMs;
  const end = batch.finished ? (timeMs(batch.finished_at) || timeMs(batch.updated_at) || nowMs) : nowMs;
  const done = rows.filter(row => terminal.has(String(row?.status || '')));
  const successes = done.filter(row => row.status === 'success');
  const rowTimes = done.flatMap(row => [timeMs(row.started_at) || timeMs(row.created_at), timeMs(row.finished_at) || timeMs(row.updated_at)]).filter(Boolean);
  const lowerBound = rowTimes.length > 1 ? (Math.max(...rowTimes) - Math.min(...rowTimes)) / 1000 : 0;
  const elapsed = Math.max(1, (Math.max(start, end) - start) / 1000, lowerBound);
  let slotSeconds = 0;
  let samples = 0;
  for (const row of done) {
    const rowStart = timeMs(row.started_at) || timeMs(row.created_at);
    const rowEnd = timeMs(row.finished_at) || timeMs(row.updated_at);
    if (rowStart && rowEnd >= rowStart) { slotSeconds += (rowEnd - rowStart) / 1000; samples += 1; }
  }
  const perSuccess = successes.length && samples ? slotSeconds / successes.length : 0;
  const target = Math.max(1, Number(targetPerMinute) || 100);
  const slots = Math.max(0, Math.floor(Number(capacity) || 0));
  const required = perSuccess ? Math.ceil(perSuccess * target / 60) : 0;
  const windowSeconds = Math.max(1, Math.min(60, elapsed));
  const windowStart = end - windowSeconds * 1000;
  const rolling = successes.filter(row => {
    const value = timeMs(row.finished_at) || timeMs(row.updated_at);
    return value >= windowStart && value <= end;
  }).length;
  return {
    elapsed_seconds: rounded(elapsed),
    completed_per_minute: rounded(done.length * 60 / elapsed),
    success_per_minute: rounded(successes.length * 60 / elapsed),
    rolling_success_per_minute: rounded(rolling * 60 / windowSeconds),
    success_rate: done.length ? rounded(successes.length * 100 / done.length) : 0,
    observed_slot_seconds: rounded(slotSeconds),
    slot_seconds_per_success: rounded(perSuccess),
    duration_samples: samples,
    target_success_per_minute: target,
    required_concurrency: required,
    projected_capacity_per_minute: perSuccess && slots ? rounded(slots * 60 / perSuccess) : 0,
    target_feasible_at_current_capacity: required > 0 && slots >= required,
  };
}

exports.REGISTER_PERFORMANCE_PROFILES = REGISTER_PERFORMANCE_PROFILES;
exports.REGISTER_PERFORMANCE_PROFILE_NAMES = REGISTER_PERFORMANCE_PROFILE_NAMES;
exports.REGISTER_CONCURRENCY_CAP = REGISTER_CONCURRENCY_CAP;
exports.REGISTER_LAUNCH_CONCURRENCY_LIMIT = REGISTER_LAUNCH_CONCURRENCY_LIMIT;
exports.normalizeRegisterPerformanceProfile = normalizeRegisterPerformanceProfile;
exports.headlessInteractionTuning = headlessInteractionTuning;
exports.planRegisterRuntimeLimits = planRegisterRuntimeLimits;
exports.planRegisterMailboxPipeline = planRegisterMailboxPipeline;
exports.createRegisterMailboxPipeline = createRegisterMailboxPipeline;
exports.calculateRegisterThroughput = calculateRegisterThroughput;
