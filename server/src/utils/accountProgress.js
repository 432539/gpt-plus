const db = require('../db');

const PROGRESS = Object.freeze({
  REGISTERED: '已注册',
  EXTRACTING: '提链中',
  EXTRACTED: '已提链',
  EXTRACTED_EXPIRED: '已提链(已过期)',
  PAYING: '支付中',
  PAYMENT_REVIEW: '支付待核验',
  PAID: '已支付',
});

const EXTRACT_LINK_TTL_MS = 90 * 60 * 1000;
const GCASH_URL_TTL_MS = 24 * 60 * 60 * 1000;

const REMARK_GOT_RT = '已拿RT';
const STAGE_ATTEMPT_LIMIT = 5;
const STAGE_ATTEMPT_COLUMNS = Object.freeze({
  extract: 'extract_attempts',
  pay: 'pay_attempts',
  acquire_rt: 'rt_attempts',
});

const TERMINAL = new Set([
  PROGRESS.REGISTERED,
  PROGRESS.EXTRACTED,
  PROGRESS.EXTRACTED_EXPIRED,
  PROGRESS.PAYMENT_REVIEW,
  PROGRESS.PAID,
]);
const LIVE = new Set([PROGRESS.EXTRACTING, PROGRESS.PAYING]);
const RANK = {
  '': 0,
  [PROGRESS.REGISTERED]: 1,
  [PROGRESS.EXTRACTING]: 2,
  [PROGRESS.EXTRACTED_EXPIRED]: 3,
  [PROGRESS.EXTRACTED]: 4,
  [PROGRESS.PAYING]: 5,
  [PROGRESS.PAYMENT_REVIEW]: 6,
  [PROGRESS.PAID]: 7,
};

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function parseStamp(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = /T/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function hasTokens(row = {}) {
  return Boolean(row.access_token || row.refresh_token || row.has_token);
}

function accountChannelOf(row = {}) {
  return String(row.channel || 'gb').trim().toLowerCase() === 'gc' ? 'gc' : 'gb';
}

function hasExtractLink(row = {}) {
  if (accountChannelOf(row) === 'gc') {
    return Boolean(row.gcash_link || row.gcash_qr || row.has_gcash_link);
  }
  return Boolean(row.extract_link || row.has_extract_link);
}

function lastExtractStamp(row = {}) {
  const times = [row.extract_attempted_at, row.extract_failed_at, row.extracted_at]
    .concat(accountChannelOf(row) === 'gc' ? [row.gcash_extracted_at] : [])
    .map((value) => parseStamp(value))
    .filter((ms) => ms != null);
  return times.length ? Math.max(...times) : null;
}

function isExtractRetryDue(row, nowMs = Date.now(), intervalMs = 10 * 60 * 1000) {
  const wait = Number(intervalMs);
  const needed = Number.isFinite(wait) && wait >= 0 ? wait : 10 * 60 * 1000;
  if (needed <= 0) return true;
  const stamp = lastExtractStamp(row);
  if (stamp == null) return true;
  return nowMs - stamp >= needed;
}

function extractLinkTtlMs(row = {}) {
  return accountChannelOf(row) === 'gc' ? GCASH_URL_TTL_MS : EXTRACT_LINK_TTL_MS;
}

function extractLinkState(row = {}, at = Date.now()) {
  if (!hasExtractLink(row)) return 'none';
  const start = parseStamp(accountChannelOf(row) === 'gc' ? row.gcash_extracted_at : row.extracted_at);
  if (start == null) return 'expired';
  if (at - start >= extractLinkTtlMs(row)) return 'expired';
  return 'valid';
}

function isExtractLinkExpired(row = {}, at = Date.now()) {
  return extractLinkState(row, at) === 'expired';
}

function hasActivated(row = {}) {
  if (String(row.activated_at || '').trim()) return true;
  return normalizeProgress(row.progress) === PROGRESS.PAID;
}

function hasRefreshToken(row = {}) {
  return Boolean(String(row.refresh_token || '').trim()) || row.has_refresh_token === true;
}

function hasGotRtRemark(row = {}) {
  return String(row.remark || '').trim() === REMARK_GOT_RT;
}

// Plus on a fresh JWT/trial is not payment proof. Skip extract/pay only when
// the account already has RT, 已拿RT, or a recorded activation.
function isPipelineComplete(row = {}) {
  return hasRefreshToken(row) || hasGotRtRemark(row) || hasActivated(row);
}

function stageAttemptCount(row = {}, stage) {
  const column = STAGE_ATTEMPT_COLUMNS[stage];
  if (!column) return 0;
  const value = Number(row[column]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function stageAttemptsExhausted(row = {}, stage, limit = STAGE_ATTEMPT_LIMIT) {
  const cap = Number(limit);
  const max = Number.isFinite(cap) && cap > 0 ? cap : STAGE_ATTEMPT_LIMIT;
  return stageAttemptCount(row, stage) >= max;
}

function bumpStageAttempt(userId, id, stage) {
  const column = STAGE_ATTEMPT_COLUMNS[stage];
  if (!column) return 0;
  const stamp = now();
  if (stage === 'extract') {
    db.prepare(
      `UPDATE gpt_accounts SET ${column} = COALESCE(${column}, 0) + 1,
       extract_attempted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(stamp, stamp, id, userId);
  } else {
    db.prepare(
      `UPDATE gpt_accounts SET ${column} = COALESCE(${column}, 0) + 1, updated_at = ? WHERE id = ? AND user_id = ?`
    ).run(stamp, id, userId);
  }
  const row = db.prepare(
    `SELECT ${column} AS n FROM gpt_accounts WHERE id = ? AND user_id = ?`
  ).get(id, userId);
  return Number(row?.n) || 0;
}

function stampExtractAttempt(userId, id) {
  const stamp = now();
  const info = db.prepare(
    `UPDATE gpt_accounts SET extract_attempted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(stamp, stamp, id, userId);
  return info.changes > 0;
}

function resetStageAttempt(userId, id, stage) {
  const column = STAGE_ATTEMPT_COLUMNS[stage];
  if (!column) return false;
  const extra = stage === 'extract' ? ', skip_platform_sync = 0' : '';
  const info = db.prepare(
    `UPDATE gpt_accounts SET ${column} = 0${extra}, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(now(), id, userId);
  return info.changes > 0;
}

function deriveProgress(row = {}, at = Date.now()) {
  if (normalizeProgress(row.progress) === PROGRESS.PAYMENT_REVIEW) return PROGRESS.PAYMENT_REVIEW;
  const extract = extractLinkState(row, at);
  if (extract === 'valid') return PROGRESS.EXTRACTED;
  if (extract === 'expired') return PROGRESS.EXTRACTED_EXPIRED;
  // 已支付 only after activate success (activated_at / stored 已支付).
  // Never infer from plan_type: JWT/trial Plus on a fresh register is still 已注册.
  if (hasActivated(row)) return PROGRESS.PAID;
  const stored = normalizeProgress(row.progress);
  if (stored === PROGRESS.EXTRACTED || stored === PROGRESS.EXTRACTED_EXPIRED) return PROGRESS.EXTRACTED_EXPIRED;
  if (stored === PROGRESS.REGISTERED || row.email || hasTokens(row)) return PROGRESS.REGISTERED;
  return '';
}

function normalizeProgress(value) {
  const text = String(value || '').trim();
  return Object.values(PROGRESS).includes(text) ? text : '';
}

function collectJobTargets(state) {
  const emails = [];
  const ids = [];
  if (!state || typeof state !== 'object') return { running: false, emails, ids, run_id: '' };
  const running = Boolean(state.running);
  const pushEmail = (value) => {
    const email = String(value || '').trim().toLowerCase();
    if (email && !emails.includes(email)) emails.push(email);
  };
  const pushId = (value) => {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  };
  pushEmail(state.current_email);
  for (const email of state.current_emails || state.emails || []) pushEmail(email);
  for (const id of state.current_ids || state.ids || []) pushId(id);
  if (state.current_id != null) pushId(state.current_id);
  return { running, emails, ids, kind: state.kind || '', run_id: String(state.run_id || '') };
}

function tryJobStatus(moduleName, userId) {
  try {
    const mod = require(`./${moduleName}`);
    if (typeof mod.status !== 'function') return null;
    return collectJobTargets(mod.status(userId));
  } catch {
    return null;
  }
}

function collectLiveJobs(userId, channel = 'gb') {
  const extract = { running: false, emails: [], ids: [], run_id: '' };
  const activate = { running: false, emails: [], ids: [], run_id: '' };
  const merge = (target, extra) => {
    if (!extra) return;
    if (extra.running) target.running = true;
    if (extra.run_id && !target.run_id) target.run_id = extra.run_id;
    for (const email of extra.emails || []) {
      if (!target.emails.includes(email)) target.emails.push(email);
    }
    for (const id of extra.ids || []) {
      if (!target.ids.includes(id)) target.ids.push(id);
    }
  };
  const gc = String(channel || 'gb').trim().toLowerCase() === 'gc';
  if (gc) {
    merge(extract, tryJobStatus('gcashExtractJob', userId));
    merge(activate, tryJobStatus('gcashPayJob', userId));
  } else {
    for (const name of ['oauthJob', 'extractJob']) merge(extract, tryJobStatus(name, userId));
    for (const name of ['activateJob', 'payJob', 'paymentJob']) merge(activate, tryJobStatus(name, userId));
  }
  const detect = { running: false, emails: [], ids: [], run_id: '' };
  const accountOp = tryJobStatus('accountJob', userId);
  if (accountOp?.kind === 'detect' && !gc) merge(detect, accountOp);
  if (gc) merge(detect, tryJobStatus('gcashDetectJob', userId));
  return { extract, activate, detect };
}

function matchesLive(item, live) {
  if (!live?.running) return false;
  const email = String(item.email || '').trim().toLowerCase();
  const id = Number(item.id);
  if (email && live.emails.includes(email)) return true;
  return Number.isInteger(id) && live.ids.includes(id);
}

function isPaySettled(row = {}) {
  return hasActivated(row) || hasRefreshToken(row) || hasGotRtRemark(row);
}

function displayProgress(item = {}, live = collectLiveJobs(), at = Date.now()) {
  if (matchesLive(item, live.extract)) return PROGRESS.EXTRACTING;
  if (matchesLive(item, live.activate) && !isPaySettled(item)) return PROGRESS.PAYING;
  const stored = normalizeProgress(item.progress);
  if (stored === PROGRESS.PAYMENT_REVIEW) return PROGRESS.PAYMENT_REVIEW;
  const extract = extractLinkState(item, at);
  if (extract === 'valid') return PROGRESS.EXTRACTED;
  if (extract === 'expired') return PROGRESS.EXTRACTED_EXPIRED;
  if (hasActivated(item) || stored === PROGRESS.PAID) return PROGRESS.PAID;
  if (stored === PROGRESS.EXTRACTED || stored === PROGRESS.EXTRACTED_EXPIRED) return PROGRESS.EXTRACTED_EXPIRED;
  if (stored === PROGRESS.REGISTERED) return PROGRESS.REGISTERED;
  return deriveProgress(item, at);
}

function setAccountProgress(userId, id, progress, extra = {}) {
  const next = normalizeProgress(progress);
  if (!next) return false;
  const set = ['progress = ?', 'updated_at = ?'];
  const params = [next, now()];
  let extractedAt = extra.extracted_at;
  if (extra.extract_link !== undefined) {
    set.push('extract_link = ?');
    params.push(String(extra.extract_link || ''));
    if (extractedAt === undefined) extractedAt = extra.extract_link ? now() : '';
  }
  if (extractedAt !== undefined) {
    set.push('extracted_at = ?');
    params.push(String(extractedAt || ''));
  }
  if (extra.plan_type) {
    set.push('plan_type = ?');
    params.push(extra.plan_type);
  }
  if (extra.expires_at !== undefined) {
    set.push('expires_at = ?');
    params.push(extra.expires_at || null);
  }
  if (extra.activated_at !== undefined) {
    set.push('activated_at = ?');
    params.push(String(extra.activated_at || ''));
  }
  if (extra.extract_failed_at !== undefined) {
    set.push('extract_failed_at = ?');
    params.push(String(extra.extract_failed_at || ''));
  }
  params.push(id, userId);
  const info = db.prepare(
    `UPDATE gpt_accounts SET ${set.join(', ')} WHERE id = ? AND user_id = ?`
  ).run(...params);
  return info.changes > 0;
}

function markRegistered(userId, id) {
  return setAccountProgress(userId, id, PROGRESS.REGISTERED);
}

function markExtracting(userId, id) {
  return setAccountProgress(userId, id, PROGRESS.EXTRACTING);
}

function markExtracted(userId, id, extra = {}) {
  return setAccountProgress(userId, id, PROGRESS.EXTRACTED, { ...extra, extract_failed_at: '' });
}

function markExtractFailed(userId, id) {
  const stamp = now();
  const info = db.prepare(
    `UPDATE gpt_accounts SET extract_failed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(stamp, stamp, id, userId);
  return info.changes > 0;
}

function markPaying(userId, id) {
  return setAccountProgress(userId, id, PROGRESS.PAYING);
}

function markPaid(userId, id, extra = {}) {
  return setAccountProgress(userId, id, PROGRESS.PAID, {
    ...extra,
    extract_link: extra.extract_link !== undefined ? extra.extract_link : '',
    extracted_at: extra.extracted_at !== undefined ? extra.extracted_at : '',
    activated_at: extra.activated_at !== undefined ? extra.activated_at : now(),
  });
}

function persistDerivedProgress(userId, id, row = {}) {
  const current = normalizeProgress(row.progress);
  if (current === PROGRESS.EXTRACTING || current === PROGRESS.PAYING) return current;
  const next = deriveProgress(row);
  if (!next) return current;
  if (next === current) return current;
  if (current === PROGRESS.PAID && next !== PROGRESS.PAID && !hasExtractLink(row)) return current;
  setAccountProgress(userId, id, next);
  return next;
}

function extractCopyValue(detail = {}, at = Date.now()) {
  if (accountChannelOf(detail) === 'gc') return '';
  const link = String(detail.extract_link || '').trim();
  if (!link) return '';
  if (extractLinkState(detail, at) !== 'valid') return '';
  return link;
}

function markGcashExtracted(userId, id, extra = {}) {
  const stamp = extra.gcash_extracted_at || now();
  const info = db.prepare(
    `UPDATE gpt_accounts
     SET progress = ?, gcash_link = ?, gcash_qr = ?, gcash_cs_id = ?, gcash_extracted_at = ?,
         extract_failed_at = '', updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    PROGRESS.EXTRACTED,
    String(extra.gcash_link || ''),
    String(extra.gcash_qr || ''),
    String(extra.gcash_cs_id || ''),
    stamp,
    now(),
    id,
    userId,
  );
  return info.changes > 0;
}

function updateGcashQrImage(userId, id, qr) {
  const info = db.prepare(
    `UPDATE gpt_accounts SET gcash_qr = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(String(qr || ''), now(), id, userId);
  return info.changes > 0;
}

function clearGcashExtract(userId, id) {
  const info = db.prepare(
    `UPDATE gpt_accounts
     SET gcash_link = '', gcash_qr = '', gcash_cs_id = '', gcash_extracted_at = '', updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(now(), id, userId);
  return info.changes > 0;
}

module.exports = {
  PROGRESS,
  REMARK_GOT_RT,
  STAGE_ATTEMPT_LIMIT,
  STAGE_ATTEMPT_COLUMNS,
  TERMINAL,
  LIVE,
  RANK,
  EXTRACT_LINK_TTL_MS,
  GCASH_URL_TTL_MS,
  parseStamp,
  extractLinkTtlMs,
  hasActivated,
  hasRefreshToken,
  hasGotRtRemark,
  isPaySettled,
  isPipelineComplete,
  stageAttemptCount,
  stageAttemptsExhausted,
  bumpStageAttempt,
  stampExtractAttempt,
  resetStageAttempt,
  deriveProgress,
  normalizeProgress,
  displayProgress,
  collectLiveJobs,
  setAccountProgress,
  markRegistered,
  markExtracting,
  markExtracted,
  markExtractFailed,
  markPaying,
  markPaid,
  persistDerivedProgress,
  extractCopyValue,
  extractLinkState,
  isExtractLinkExpired,
  isExtractRetryDue,
  lastExtractStamp,
  hasTokens,
  hasExtractLink,
  accountChannelOf,
  markGcashExtracted,
  updateGcashQrImage,
  clearGcashExtract,
};
