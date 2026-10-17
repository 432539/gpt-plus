'use strict';

const db = require('../db');
const { normalizeSuffixList } = require('./mailcomDomains');
const { pickPullSuffix, selectUnusedForRegister, suffixOfAddress } = require('./suffixPick');

function pad(value) {
  return String(value).padStart(2, '0');
}

function windowKeys(at = new Date()) {
  const year = at.getFullYear();
  const month = pad(at.getMonth() + 1);
  const day = pad(at.getDate());
  const hour = pad(at.getHours());
  return {
    hour: `${year}-${month}-${day}T${hour}`,
    day: `${year}-${month}-${day}`,
  };
}

function quotaOf(settings = {}) {
  const raw = settings.suffix_quota && typeof settings.suffix_quota === 'object'
    ? settings.suffix_quota
    : {};
  const n = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return Math.min(10000, parsed);
  };
  return {
    hourly: n(raw.hourly),
    daily: n(raw.daily),
  };
}

function normalizeSuffix(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

function readUsage(userId, kind, key, suffix) {
  if (!userId || !suffix) return { generated: 0, registered: 0 };
  const row = db.prepare(
    `SELECT generated, registered FROM suffix_windows
     WHERE user_id = ? AND window_kind = ? AND window_key = ? AND suffix = ?`
  ).get(userId, kind, key, suffix);
  return {
    generated: Number(row?.generated) || 0,
    registered: Number(row?.registered) || 0,
  };
}

function listUsage(userId, kind, key) {
  if (!userId) return [];
  return db.prepare(
    `SELECT suffix, generated, registered FROM suffix_windows
     WHERE user_id = ? AND window_kind = ? AND window_key = ?
     ORDER BY (generated + registered) DESC, suffix`
  ).all(userId, kind, key).map((row) => ({
    suffix: String(row.suffix || '').toLowerCase(),
    generated: Number(row.generated) || 0,
    registered: Number(row.registered) || 0,
  })).filter((row) => row.suffix);
}

function usedForMode(row, mode) {
  const generated = Number(row?.generated) || 0;
  const registered = Number(row?.registered) || 0;
  if (mode === 'register') return registered;
  if (mode === 'generate') return generated;
  return Math.max(generated, registered);
}

function remainingSlots(userId, suffix, quota, keys, mode = 'generate') {
  const domain = normalizeSuffix(suffix);
  if (!domain) return 0;
  if (!quota.hourly && !quota.daily) return Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  if (quota.hourly) {
    left = Math.min(left, Math.max(0, quota.hourly - usedForMode(readUsage(userId, 'hour', keys.hour, domain), mode)));
  }
  if (quota.daily) {
    left = Math.min(left, Math.max(0, quota.daily - usedForMode(readUsage(userId, 'day', keys.day, domain), mode)));
  }
  return left;
}

function constrainSuffixPool(userId, candidates, settings = {}, at = new Date(), options = {}) {
  const quota = quotaOf(settings);
  const keys = windowKeys(at);
  const mode = options.mode || 'generate';
  return normalizeSuffixList(candidates).filter((suffix) => remainingSlots(userId, suffix, quota, keys, mode) > 0);
}

function bumpUsage(userId, kind, key, suffix, generate, register) {
  db.prepare(
    `INSERT INTO suffix_windows (user_id, window_kind, window_key, suffix, generated, registered, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(user_id, window_kind, window_key, suffix) DO UPDATE SET
       generated = generated + excluded.generated,
       registered = registered + excluded.registered`
  ).run(userId, kind, key, suffix, generate ? 1 : 0, register ? 1 : 0);
}

function consumeSuffixSlot(userId, suffix, options = {}) {
  const domain = normalizeSuffix(suffix);
  if (!userId || !domain) return false;
  const settings = options.settings || require('./settings').readSettings(userId);
  const quota = quotaOf(settings);
  const at = options.at || new Date();
  const keys = windowKeys(at);
  const mode = options.mode || 'generate';
  const generate = mode === 'generate' || mode === 'both';
  const register = mode === 'register' || mode === 'both';
  return db.transaction(() => {
    if (generate && remainingSlots(userId, domain, quota, keys, 'generate') <= 0) return false;
    if (register && remainingSlots(userId, domain, quota, keys, 'register') <= 0) return false;
    bumpUsage(userId, 'hour', keys.hour, domain, generate, register);
    bumpUsage(userId, 'day', keys.day, domain, generate, register);
    return true;
  })();
}

function pickQuotaSuffix(userId, candidates, options = {}) {
  const settings = options.settings || (userId ? require('./settings').readSettings(userId) : {});
  const mode = options.mode || 'generate';
  const consume = options.consume !== false;
  let pool = constrainSuffixPool(userId, candidates, settings, options.at, { mode });
  const preferredFirst = String(options.preferred || '').trim().toLowerCase().replace(/^@/, '');
  let preferred = preferredFirst;
  while (pool.length) {
    const picked = preferred && pool.includes(preferred)
      ? preferred
      : pickPullSuffix(pool, options.usage || new Map(), options.random || Math.random);
    preferred = '';
    if (!picked) return '';
    if (!consume) return picked;
    if (consumeSuffixSlot(userId, picked, { mode, settings, at: options.at })) return picked;
    pool = pool.filter((item) => item !== picked);
  }
  return '';
}

function selectUnusedUnderQuota(userId, unused, stats, count, settings, random = Math.random) {
  const want = Math.max(0, Number(count) || 0);
  const cfg = settings || (userId ? require('./settings').readSettings(userId) : {});
  let remaining = Array.isArray(unused) ? unused.slice() : [];
  const picked = [];
  while (picked.length < want && remaining.length) {
    const allowedSuffixes = new Set(constrainSuffixPool(
      userId,
      remaining.map((row) => suffixOfAddress(row.address)),
      cfg,
      undefined,
      { mode: 'register' },
    ));
    const allowedRows = remaining.filter((row) => allowedSuffixes.has(suffixOfAddress(row.address)));
    if (!allowedRows.length) break;
    const next = selectUnusedForRegister(allowedRows, stats, 1, random)[0];
    if (!next) break;
    const suffix = suffixOfAddress(next.address);
    if (!consumeSuffixSlot(userId, suffix, { mode: 'register', settings: cfg })) {
      remaining = remaining.filter((row) => suffixOfAddress(row.address) !== suffix);
      continue;
    }
    picked.push(next);
    remaining = remaining.filter((row) => row !== next);
  }
  return picked;
}

function suffixQuotaView(userId, settings = {}, at = new Date()) {
  const quota = quotaOf(settings);
  const keys = windowKeys(at);
  const hourUsage = userId ? listUsage(userId, 'hour', keys.hour) : [];
  const dayUsage = userId ? listUsage(userId, 'day', keys.day) : [];
  const peak = (rows, field) => rows.reduce((max, row) => Math.max(max, Number(row[field]) || 0), 0);
  const capped = (rows, field, limit) => (limit ? rows.filter((row) => (Number(row[field]) || 0) >= limit).length : 0);
  return {
    hourly: quota.hourly,
    daily: quota.daily,
    hour_key: keys.hour,
    day_key: keys.day,
    hour_usage: hourUsage,
    day_usage: dayUsage,
    hour_generated_peak: peak(hourUsage, 'generated'),
    hour_registered_peak: peak(hourUsage, 'registered'),
    day_generated_peak: peak(dayUsage, 'generated'),
    day_registered_peak: peak(dayUsage, 'registered'),
    hour_generate_capped: capped(hourUsage, 'generated', quota.hourly),
    hour_register_capped: capped(hourUsage, 'registered', quota.hourly),
    day_generate_capped: capped(dayUsage, 'generated', quota.daily),
    day_register_capped: capped(dayUsage, 'registered', quota.daily),
  };
}

module.exports = {
  windowKeys,
  quotaOf,
  remainingSlots,
  constrainSuffixPool,
  consumeSuffixSlot,
  pickQuotaSuffix,
  selectUnusedUnderQuota,
  suffixQuotaView,
};
