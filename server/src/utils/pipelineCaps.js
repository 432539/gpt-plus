'use strict';

const db = require('../db');

const EXTRACT_INTERVAL_MINUTES_DEFAULT = 10;
const STAGE_ATTEMPT_DEFAULT = 5;
const DAILY_REGISTER_UNLIMITED = 0;
const REGISTER_CONCURRENCY_DEFAULT = 5;
const REGISTER_CONCURRENCY_MAX = 200;

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function pipelineCaps(settings = {}) {
  const p = settings.pipeline || {};
  return {
    daily_register_limit: clampInt(p.daily_register_limit, 0, 10000, DAILY_REGISTER_UNLIMITED),
    register_concurrency: clampInt(p.register_concurrency, 1, REGISTER_CONCURRENCY_MAX, REGISTER_CONCURRENCY_DEFAULT),
    extract_attempts: clampInt(p.extract_attempts, 1, 50, STAGE_ATTEMPT_DEFAULT),
    extract_interval_minutes: clampInt(p.extract_interval_minutes, 0, 1440, EXTRACT_INTERVAL_MINUTES_DEFAULT),
    pay_attempts: clampInt(p.pay_attempts, 1, 50, STAGE_ATTEMPT_DEFAULT),
    rt_attempts: clampInt(p.rt_attempts, 1, 50, STAGE_ATTEMPT_DEFAULT),
  };
}

function stageCap(stage, caps = {}) {
  if (stage === 'extract') return clampInt(caps.extract_attempts, 1, 50, STAGE_ATTEMPT_DEFAULT);
  if (stage === 'pay') return clampInt(caps.pay_attempts, 1, 50, STAGE_ATTEMPT_DEFAULT);
  if (stage === 'rt' || stage === 'acquire_rt') return clampInt(caps.rt_attempts, 1, 50, STAGE_ATTEMPT_DEFAULT);
  return STAGE_ATTEMPT_DEFAULT;
}

function extractIntervalMs(caps = {}) {
  const minutes = clampInt(caps.extract_interval_minutes, 0, 1440, EXTRACT_INTERVAL_MINUTES_DEFAULT);
  return minutes * 60 * 1000;
}

function countTodayRegisters(userId) {
  return Number(db.prepare(
    `SELECT COUNT(*) AS c FROM gpt_accounts
     WHERE user_id = ? AND date(created_at) = date('now','localtime')`
  ).get(userId)?.c) || 0;
}

function remainingDailyRegisters(userId, settings) {
  if (settings?.pipeline?.register === true || settings?.pipeline_gc?.register === true) {
    return Infinity;
  }
  const limit = pipelineCaps(settings).daily_register_limit;
  if (limit <= 0) return Infinity;
  return Math.max(0, limit - countTodayRegisters(userId));
}

module.exports = {
  EXTRACT_INTERVAL_MINUTES_DEFAULT,
  STAGE_ATTEMPT_DEFAULT,
  DAILY_REGISTER_UNLIMITED,
  REGISTER_CONCURRENCY_DEFAULT,
  REGISTER_CONCURRENCY_MAX,
  clampInt,
  pipelineCaps,
  stageCap,
  extractIntervalMs,
  countTodayRegisters,
  remainingDailyRegisters,
};
