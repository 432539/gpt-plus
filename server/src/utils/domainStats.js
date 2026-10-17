'use strict';

const db = require('../db');
const { suffixOfAddress } = require('./suffixPick');
const { PROGRESS } = require('./accountProgress');

function pct(yes, total) {
  const n = Number(total) || 0;
  if (n <= 0) return null;
  return Math.round((Number(yes) || 0) * 1000 / n) / 10;
}

function emptyRow(suffix) {
  return {
    suffix,
    register_total: 0,
    register_success: 0,
    register_failed: 0,
    register_rate: null,
    account_count: 0,
    trial_detected: 0,
    trial_yes: 0,
    trial_rate: null,
    paid_count: 0,
    pay_rate: null,
  };
}

function isPaid(row = {}) {
  if (String(row.activated_at || '').trim()) return true;
  return String(row.progress || '').trim() === PROGRESS.PAID;
}

function domainStatsForUser(userId) {
  const map = new Map();
  const take = (suffix) => {
    if (!suffix) return null;
    if (!map.has(suffix)) map.set(suffix, emptyRow(suffix));
    return map.get(suffix);
  };

  const jobs = db.prepare(
    `SELECT email, status FROM registration_jobs WHERE user_id = ?`
  ).all(userId);
  for (const job of jobs) {
    const suffix = suffixOfAddress(job.email);
    const row = take(suffix);
    if (!row) continue;
    const status = String(job.status || '');
    if (!['success', 'failed', 'skipped', 'partial', 'cancelled'].includes(status)) continue;
    row.register_total += 1;
    if (status === 'success' || status === 'partial') row.register_success += 1;
    if (status === 'failed' || status === 'skipped') row.register_failed += 1;
  }

  const accounts = db.prepare(
    `SELECT email, has_trial, progress, activated_at FROM gpt_accounts WHERE user_id = ?`
  ).all(userId);
  for (const account of accounts) {
    const suffix = suffixOfAddress(account.email);
    const row = take(suffix);
    if (!row) continue;
    row.account_count += 1;
    if (account.has_trial === 1 || account.has_trial === true) {
      row.trial_detected += 1;
      row.trial_yes += 1;
    } else if (account.has_trial === 0 || account.has_trial === false) {
      row.trial_detected += 1;
    }
    if (isPaid(account)) row.paid_count += 1;
  }

  return [...map.values()]
    .map((row) => ({
      ...row,
      register_rate: pct(row.register_success, row.register_total),
      trial_rate: pct(row.trial_yes, row.trial_detected),
      pay_rate: pct(row.paid_count, row.account_count),
    }))
    .sort((left, right) => (right.account_count - left.account_count)
      || left.suffix.localeCompare(right.suffix));
}

module.exports = { domainStatsForUser, pct };
