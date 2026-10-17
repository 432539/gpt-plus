'use strict';

const db = require('../db');
const { PROGRESS } = require('./accountProgress');
const { normalizeSuffixList } = require('./mailcomDomains');

const MIN_SUCCESS_SAMPLES = 3;

function suffixOfAddress(address) {
  const text = String(address || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return '';
  return text.slice(at + 1).replace(/^@/, '');
}

function emptyStat(suffix) {
  return {
    suffix,
    mailbox_count: 0,
    unused_count: 0,
    account_count: 0,
    trial_detected: 0,
    trial_yes: 0,
    trial_rate: null,
    extract_ok: 0,
    extract_rate: null,
  };
}

function rate(yes, total) {
  const n = Number(total) || 0;
  if (n <= 0) return null;
  return (Number(yes) || 0) / n;
}

function increment(map, suffix, field, n = 1) {
  if (!suffix) return;
  if (!map.has(suffix)) map.set(suffix, emptyStat(suffix));
  map.get(suffix)[field] += n;
}

function countUsage(addresses) {
  const map = new Map();
  for (const item of addresses || []) {
    const suffix = typeof item === 'string'
      ? suffixOfAddress(item)
      : suffixOfAddress(item?.address || item?.email);
    if (!suffix) continue;
    map.set(suffix, (map.get(suffix) || 0) + 1);
  }
  return map;
}

function mostUsedFromMap(usageMap, among) {
  const allow = new Set(among || []);
  let best = '';
  let max = -1;
  let ties = 0;
  for (const suffix of allow) {
    const n = Number(usageMap.get(suffix) || 0) || 0;
    if (n > max) {
      max = n;
      best = suffix;
      ties = 1;
    } else if (n === max && n > 0) {
      ties += 1;
    }
  }
  return max > 0 && ties === 1 ? best : '';
}

function mostUsedSuffix(statsList, among = null) {
  const usage = new Map();
  for (const stat of statsList || []) {
    usage.set(stat.suffix, Number(stat.mailbox_count) || 0);
  }
  return mostUsedFromMap(usage, among || [...usage.keys()]);
}

function pickWeightedRandom(items, weightFn, random = Math.random) {
  const list = Array.isArray(items) ? items.filter((item) => item !== undefined && item !== null && item !== '') : [];
  if (!list.length) return '';
  const weights = list.map((item) => {
    const w = Number(weightFn(item));
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  }
  let cursor = random() * total;
  for (let i = 0; i < list.length; i += 1) {
    cursor -= weights[i];
    if (cursor < 0) return list[i];
  }
  return list[list.length - 1];
}

function pickPullSuffix(pool, usage = new Map(), random = Math.random) {
  const remaining = normalizeSuffixList(pool);
  if (!remaining.length) return '';
  const usageMap = usage instanceof Map ? usage : countUsage(usage);
  const most = mostUsedFromMap(usageMap, remaining);
  return pickWeightedRandom(
    remaining,
    (suffix) => {
      const used = Number(usageMap.get(suffix) || 0) || 0;
      let w = 1 / (1 + used);
      if (most && suffix === most && remaining.length > 1) w *= 0.2;
      return w;
    },
    random,
  );
}

function registerWeight(stat, mostUsed, poolSize) {
  const samples = Math.max(Number(stat?.trial_detected) || 0, Number(stat?.account_count) || 0);
  let w = 1;
  if (samples >= MIN_SUCCESS_SAMPLES) {
    const trial = stat.trial_rate == null ? 0.5 : Number(stat.trial_rate);
    const extract = stat.extract_rate == null ? 0.5 : Number(stat.extract_rate);
    w = 0.5 + trial + extract;
  }
  if (mostUsed && stat?.suffix === mostUsed && poolSize > 1) w *= 0.25;
  return w;
}

function isExtractSuccess(row = {}) {
  const progress = String(row.progress || '').trim();
  if (progress === PROGRESS.EXTRACTED || progress === PROGRESS.EXTRACTED_EXPIRED) return true;
  return Boolean(String(row.extracted_at || '').trim());
}

function aggregateSuffixStats({ emails = [], accounts = [] } = {}) {
  const map = new Map();
  for (const row of emails) {
    const suffix = suffixOfAddress(row.address || row.email);
    if (!suffix) continue;
    increment(map, suffix, 'mailbox_count');
    const unused = Number(row.is_mother) !== 1 && String(row.status || '') !== '已使用';
    if (unused) increment(map, suffix, 'unused_count');
  }
  for (const row of accounts) {
    const suffix = suffixOfAddress(row.email);
    if (!suffix) continue;
    increment(map, suffix, 'account_count');
    if (row.has_trial === 1 || row.has_trial === true) {
      increment(map, suffix, 'trial_detected');
      increment(map, suffix, 'trial_yes');
    } else if (row.has_trial === 0 || row.has_trial === false) {
      increment(map, suffix, 'trial_detected');
    }
    if (isExtractSuccess(row)) increment(map, suffix, 'extract_ok');
  }
  for (const stat of map.values()) {
    stat.trial_rate = rate(stat.trial_yes, stat.trial_detected);
    stat.extract_rate = rate(stat.extract_ok, stat.account_count);
  }
  return [...map.values()].sort((a, b) => a.suffix.localeCompare(b.suffix));
}

function suffixStatsForUser(userId) {
  const emails = db.prepare(
    'SELECT address, status, is_mother FROM emails WHERE user_id = ?'
  ).all(userId);
  const accounts = db.prepare(
    'SELECT email, has_trial, progress, extracted_at FROM gpt_accounts WHERE user_id = ?'
  ).all(userId);
  return aggregateSuffixStats({ emails, accounts });
}

function statsMap(stats) {
  const map = new Map();
  for (const item of stats || []) {
    if (item?.suffix) map.set(item.suffix, item);
  }
  return map;
}

function attachSuffixStats(items, stats) {
  const map = statsMap(stats);
  return (items || []).map((item) => {
    const stat = map.get(item.suffix) || emptyStat(item.suffix);
    return { ...item, ...stat, suffix: item.suffix };
  });
}

function selectUnusedForRegister(unused, stats, count, random = Math.random) {
  const remaining = Array.isArray(unused) ? unused.slice() : [];
  const want = Math.max(0, Number(count) || 0);
  const picked = [];
  const batchUsage = new Map();
  const list = Array.isArray(stats) ? stats : [...(stats && typeof stats.values === 'function' ? stats.values() : [])];
  const bySuffix = statsMap(list);

  while (picked.length < want && remaining.length) {
    const groups = new Map();
    for (const row of remaining) {
      const suffix = suffixOfAddress(row.address);
      if (!suffix) continue;
      if (!groups.has(suffix)) groups.set(suffix, []);
      groups.get(suffix).push(row);
    }
    const suffixes = [...groups.keys()];
    if (!suffixes.length) break;
    const most = mostUsedSuffix(
      list.length ? list : suffixes.map((suffix) => ({
        suffix,
        mailbox_count: groups.get(suffix).length,
      })),
      suffixes,
    );
    const suffix = pickWeightedRandom(suffixes, (item) => {
      const stat = bySuffix.get(item) || emptyStat(item);
      let w = registerWeight({ ...stat, suffix: item }, most, suffixes.length);
      w /= (1 + (batchUsage.get(item) || 0));
      return w;
    }, random);
    const group = groups.get(suffix) || remaining;
    const chosen = group[Math.min(group.length - 1, Math.floor(random() * group.length))];
    if (!chosen) break;
    picked.push(chosen);
    batchUsage.set(suffix, (batchUsage.get(suffix) || 0) + 1);
    const idx = remaining.indexOf(chosen);
    if (idx >= 0) remaining.splice(idx, 1);
    else remaining.shift();
  }
  return picked;
}

module.exports = {
  MIN_SUCCESS_SAMPLES,
  suffixOfAddress,
  emptyStat,
  countUsage,
  pickWeightedRandom,
  pickPullSuffix,
  registerWeight,
  aggregateSuffixStats,
  suffixStatsForUser,
  attachSuffixStats,
  selectUnusedForRegister,
  mostUsedSuffix,
};
