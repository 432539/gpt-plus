'use strict';

const db = require('../db');
const {
  STAGE_ATTEMPT_LIMIT,
  hasActivated,
  hasRefreshToken,
  hasGotRtRemark,
  stageAttemptCount,
  bumpStageAttempt,
  deriveProgress,
  PROGRESS,
} = require('./accountProgress');
const { isPaidPlan } = require('./accountCheck');
const { stageCap } = require('./pipelineCaps');

const GOT_RT = '已拿RT';
const ACTIVATION_RETRY = Object.freeze({
  NONE: 0,
  PENDING: 1,
  USED: 2,
});

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function stageName(step) {
  if (step === 'rt' || step === 'acquire_rt') return 'acquire_rt';
  return step;
}

function hasGotRt(row = {}) {
  return hasRefreshToken(row) || hasGotRtRemark(row) || String(row.remark || '').trim() === GOT_RT;
}

function activationRetryState(row = {}) {
  const value = Number(row.activation_retry_after_free_rt);
  if (value === ACTIVATION_RETRY.PENDING) return ACTIVATION_RETRY.PENDING;
  if (value === ACTIVATION_RETRY.USED) return ACTIVATION_RETRY.USED;
  return ACTIVATION_RETRY.NONE;
}

function isActivationRetryPending(row = {}) {
  return activationRetryState(row) === ACTIVATION_RETRY.PENDING && !isPaidPlan(row.plan_type);
}

function stepAttempts(row = {}, step) {
  return stageAttemptCount(row, stageName(step));
}

function underRetryCap(row = {}, step, limit) {
  const max = stageCap(step, {
    extract_attempts: limit,
    pay_attempts: limit,
    rt_attempts: limit,
  });
  const explicit = Number(limit);
  const cap = Number.isFinite(explicit) && explicit > 0 ? explicit : max;
  return stepAttempts(row, step) < cap;
}

function shouldSkipExtract(row = {}, caps = {}) {
  if (!underRetryCap(row, 'extract', caps.extract_attempts)) return true;
  if (isActivationRetryPending(row)) return false;
  return hasGotRt(row) || hasActivated(row);
}

function shouldSkipPay(row = {}, caps = {}) {
  if (!underRetryCap(row, 'pay', caps.pay_attempts)) return true;
  if (isActivationRetryPending(row)) return false;
  if (hasActivated(row)) return true;
  if (hasGotRt(row) && isPaidPlan(row.plan_type)) return true;
  return false;
}

function shouldSkipRt(row = {}, caps = {}) {
  if (!underRetryCap(row, 'rt', caps.rt_attempts)) return true;
  return hasGotRt(row);
}

function isPaidReadyForRt(row = {}, nowMs = Date.now(), caps = {}) {
  if (shouldSkipRt(row, caps)) return false;
  if (hasActivated(row)) return true;
  return deriveProgress(row, nowMs) === PROGRESS.PAID;
}

function recordStepFailure(userId, accountId, step) {
  return bumpStageAttempt(userId, accountId, stageName(step));
}

function markActivationRetryAfterFreeRt(userId, accountId, planType) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { changed: false };
  if (isPaidPlan(planType)) {
    const info = db.prepare(
      `UPDATE gpt_accounts
       SET activation_retry_after_free_rt = CASE
         WHEN COALESCE(activation_retry_after_free_rt, 0) = ? THEN ?
         ELSE COALESCE(activation_retry_after_free_rt, 0)
       END, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(ACTIVATION_RETRY.PENDING, ACTIVATION_RETRY.USED, stamp(), id, userId);
    return { changed: info.changes > 0, state: ACTIVATION_RETRY.USED, plan_type: planType };
  }
  const info = db.prepare(
    `UPDATE gpt_accounts
     SET activation_retry_after_free_rt = ?, updated_at = ?
     WHERE id = ? AND user_id = ?
       AND COALESCE(activation_retry_after_free_rt, 0) = ?`
  ).run(ACTIVATION_RETRY.PENDING, stamp(), id, userId, ACTIVATION_RETRY.NONE);
  const row = db.prepare(
    'SELECT activation_retry_after_free_rt FROM gpt_accounts WHERE id = ? AND user_id = ?'
  ).get(id, userId) || {};
  return {
    changed: info.changes > 0,
    state: activationRetryState(row),
    plan_type: planType || 'Free',
  };
}

function consumeActivationRetry(userId, accountId) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const info = db.prepare(
    `UPDATE gpt_accounts
     SET activation_retry_after_free_rt = ?, updated_at = ?
     WHERE id = ? AND user_id = ?
       AND COALESCE(activation_retry_after_free_rt, 0) = ?`
  ).run(ACTIVATION_RETRY.USED, stamp(), id, userId, ACTIVATION_RETRY.PENDING);
  return info.changes > 0;
}

module.exports = {
  STEP_RETRY_CAP: STAGE_ATTEMPT_LIMIT,
  GOT_RT,
  ACTIVATION_RETRY,
  hasRefreshToken,
  hasGotRt,
  activationRetryState,
  isActivationRetryPending,
  stepAttempts,
  underRetryCap,
  shouldSkipExtract,
  shouldSkipPay,
  shouldSkipRt,
  isPaidReadyForRt,
  recordStepFailure,
  markActivationRetryAfterFreeRt,
  consumeActivationRetry,
};
