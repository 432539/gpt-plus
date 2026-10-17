'use strict';

const db = require('../db');
const opLog = require('./opLog');

// GB：oauth / extract_link 提链失败计入 extract_attempts。
// GC：gcash 出码失败同样走 bumpStageAttempt('extract')，满 20 次同样不同步、不可删。
const EXTRACT_FAIL_SKIP_SYNC = 20;

const KEEP_ACCOUNT_SQL = `(COALESCE(has_trial, 0) = 1
  OR COALESCE(skip_platform_sync, 0) = 1
  OR COALESCE(extract_attempts, 0) >= ${EXTRACT_FAIL_SKIP_SYNC})`;

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function extractFailCount(row = {}) {
  const value = Number(row.extract_attempts);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasTrial(row = {}) {
  return row.has_trial === 1 || row.has_trial === true;
}

function shouldSkipPlatformSync(row = {}) {
  return Number(row.skip_platform_sync) === 1 || extractFailCount(row) >= EXTRACT_FAIL_SKIP_SYNC;
}

function isLocallyProtected(row = {}) {
  return hasTrial(row) || shouldSkipPlatformSync(row);
}

function skipPlatformSyncReason(row = {}) {
  if (!shouldSkipPlatformSync(row)) return '';
  const n = Math.max(extractFailCount(row), EXTRACT_FAIL_SKIP_SYNC);
  return `试用提链失败满 ${n} 次，不同步到平台`;
}

function deleteBlockReason(row = {}) {
  if (hasTrial(row)) return '有试用，已保留';
  if (shouldSkipPlatformSync(row)) return '提链失败已满 20 次，已保留';
  return '';
}

function applySkipPlatformSync(userId, id, attempts) {
  const n = Number(attempts);
  const count = Number.isFinite(n) && n > 0 ? n : 0;
  if (count < EXTRACT_FAIL_SKIP_SYNC) {
    return { skipped: false, attempts: count };
  }
  const row = db.prepare(
    'SELECT email, skip_platform_sync FROM gpt_accounts WHERE id = ? AND user_id = ?'
  ).get(id, userId);
  if (!row) return { skipped: true, attempts: count };
  db.prepare(
    `UPDATE gpt_accounts SET skip_platform_sync = 1, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(now(), id, userId);
  if (Number(row.skip_platform_sync) !== 1) {
    opLog.account(
      userId,
      'warning',
      `${row.email}：${skipPlatformSyncReason({ extract_attempts: count, skip_platform_sync: 1 })}`,
      { source: 'extract-fail' },
    );
  }
  return { skipped: true, attempts: count };
}

function retentionView(row = {}) {
  const skip = shouldSkipPlatformSync(row);
  return {
    extract_attempts: extractFailCount(row),
    skip_platform_sync: skip,
    can_delete: !isLocallyProtected(row),
  };
}

module.exports = {
  EXTRACT_FAIL_SKIP_SYNC,
  KEEP_ACCOUNT_SQL,
  extractFailCount,
  hasTrial,
  shouldSkipPlatformSync,
  isLocallyProtected,
  skipPlatformSyncReason,
  deleteBlockReason,
  applySkipPlatformSync,
  retentionView,
};
