'use strict';

const db = require('../db');
const opLog = require('./opLog');
const { readSettings } = require('./settings');
const { toDetail } = require('./accountFields');
const { hasActivated, hasRefreshToken, hasExtractLink, extractLinkState, stageAttemptsExhausted, normalizeProgress, PROGRESS } = require('./accountProgress');
const { pipelineCaps, stageCap } = require('./pipelineCaps');
const {
  EXTRACT_FAIL_SKIP_SYNC,
  KEEP_ACCOUNT_SQL,
  shouldSkipPlatformSync,
  applySkipPlatformSync,
  extractFailCount,
} = require('./accountRetention');
const { trialKnown, normalizeTrialFlag, isTrialUnset } = require('./accountCheck');

const DUMP_BATCH = 20;
const PREMIUM_PLANS = Object.freeze(['Plus', 'Pro', 'Team']);
const PREMIUM_PLAN_SQL = `lower(trim(ifnull(plan_type, ''))) IN ('plus', 'pro', 'team')`;
const PAYMENT_PIPELINE_SQL = `progress IN ('${PROGRESS.PAID}', '${PROGRESS.PAYING}', '${PROGRESS.PAYMENT_REVIEW}')`;
// Keep activated paid rows and Plus/Pro/Team even if progress was never stamped 已支付
// (a Plus row can stay 已提链 with a dead token and must not be dumped).
const PAID_ACCOUNT_SQL = `(${PAYMENT_PIPELINE_SQL} OR (activated_at IS NOT NULL AND TRIM(activated_at) != '') OR (${PREMIUM_PLAN_SQL}))`;
const INVALID_TOKEN_SQL = `(status IN ('令牌失效', '已过期') OR token_invalidated = 1
      OR (status = '检测失败' AND last_security_state IN ('invalid_token', 'token_invalidated', 'expired_confirmed')))`;
const BLOCKED_DUMP_STATUSES = new Set(['已封禁', '已停用', '令牌失效', '检测失败']);
const SKIP_PLATFORM_KEEP_SQL = `(COALESCE(skip_platform_sync, 0) = 1
  OR COALESCE(extract_attempts, 0) >= ${EXTRACT_FAIL_SKIP_SYNC})`;

function isPremiumPlan(planType) {
  return PREMIUM_PLANS.includes(String(planType || '').trim());
}

function isPaymentPipeline(row = {}) {
  const progress = String(row.progress || '').trim();
  return progress === PROGRESS.PAID || progress === PROGRESS.PAYING || progress === PROGRESS.PAYMENT_REVIEW;
}

function isPaidAccount(row = {}) {
  return hasActivated(row) || isPremiumPlan(row.plan_type) || isPaymentPipeline(row);
}

function isInvalidTokenRow(row = {}) {
  if (Number(row.token_invalidated) === 1) return true;
  const status = String(row.status || '');
  if (status === '令牌失效') return true;
  if (status === '检测失败') {
    return ['invalid_token', 'token_invalidated', 'expired_confirmed'].includes(String(row.last_security_state || ''));
  }
  return false;
}

function isConfirmedNoTrial(value) {
  if (isTrialUnset(value)) return false;
  return normalizeTrialFlag(value) === 0;
}

function dumpTrialAllowed(value, includeTrial = false) {
  const flag = normalizeTrialFlag(value);
  if (flag === 0) return true;
  if (includeTrial && flag === 1) return true;
  return false;
}

function isDumpCandidate(row = {}, detail = {}, options = {}) {
  if (shouldSkipPlatformSync(row)) return false;
  // Number(null) === 0 and Number('') === 0 — never treat 未检测 as 无试用
  if (!dumpTrialAllowed(row.has_trial, Boolean(options.includeTrial))) return false;
  if (isPaidAccount(row)) return false;
  if (isInvalidTokenRow(row)) return false;
  if (BLOCKED_DUMP_STATUSES.has(String(row.status || ''))) return false;
  const accessToken = String(detail.access_token || '').trim();
  if (!accessToken) return false;
  return true;
}

function isExtractExhaustedEligible(row = {}, detail = {}, caps = {}) {
  if (isTrialUnset(row.has_trial) || (!trialKnown(row.has_trial) && normalizeTrialFlag(row.has_trial) == null)) {
    return false;
  }
  if (isPaidAccount(row)) return false;
  if (isPremiumPlan(row.plan_type)) return false;
  if (hasRefreshToken(detail) || hasRefreshToken(row)) return false;
  if (isInvalidTokenRow(row)) return false;
  if (BLOCKED_DUMP_STATUSES.has(String(row.status || ''))) return false;
  if (!String(detail.access_token || '').trim()) return false;
  if (hasExtractLink(row) || hasExtractLink(detail)) return false;
  if (String(row.extracted_at || '').trim()) return false;
  if (extractLinkState({ ...row, extract_link: detail.extract_link || row.extract_link }) === 'valid') return false;
  const progress = normalizeProgress(row.progress);
  if (progress === PROGRESS.EXTRACTED || progress === PROGRESS.EXTRACTED_EXPIRED) return false;
  const cap = stageCap('extract', caps);
  if (!stageAttemptsExhausted(row, 'extract', cap)) return false;
  return true;
}

function isExtractExhaustedDumpCandidate(row = {}, detail = {}, caps = {}) {
  if (!isExtractExhaustedEligible(row, detail, caps)) return false;
  return !shouldSkipPlatformSync(row);
}

function importDumpConfig(settings = {}) {
  const cfg = settings.import_dump || {};
  const url = String(cfg.url || '').trim();
  const apiKey = String(cfg.api_key || cfg.apiKey || '').trim();
  return { url, apiKey, configured: Boolean(url && apiKey) };
}

function toImportPayload(detail = {}) {
  return {
    access_token: String(detail.access_token || ''),
    refresh_token: String(detail.refresh_token || ''),
    email: String(detail.email || '').trim(),
    status: '正常',
  };
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [];
}

function emailOf(item) {
  if (typeof item === 'string') return item.trim().toLowerCase();
  if (!item || typeof item !== 'object') return '';
  return String(item.email || item.account || item.address || '').trim().toLowerCase();
}

function parseAcceptedEmails(payload, sent) {
  const sentEmails = sent.map((item) => String(item.email || '').trim().toLowerCase()).filter(Boolean);
  const sentSet = new Set(sentEmails);
  if (payload == null || payload === '') return sentEmails;
  if (typeof payload !== 'object') return sentEmails;

  const rejected = new Set();
  for (const item of [
    ...asList(payload.failed),
    ...asList(payload.errors),
    ...asList(payload.rejected),
  ]) {
    const email = emailOf(item);
    if (email && sentSet.has(email)) rejected.add(email);
  }

  const named = [];
  for (const key of ['added', 'imported', 'accepted', 'skipped', 'created', 'accounts', 'data']) {
    for (const item of asList(payload[key])) {
      const email = emailOf(item);
      if (email && sentSet.has(email) && !rejected.has(email)) named.push(email);
    }
  }
  if (named.length) return [...new Set(named)];

  const addedN = typeof payload.added === 'number' ? payload.added : null;
  const skippedN = typeof payload.skipped === 'number' ? payload.skipped : null;
  if (addedN != null || skippedN != null) {
    const accounted = (addedN || 0) + (skippedN || 0);
    if (!rejected.size && accounted >= sentEmails.length) return sentEmails;
    return [];
  }

  if (payload.ok === false || payload.success === false) return [];
  return sentEmails.filter((email) => !rejected.has(email));
}

function responseSummary(status, payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      status,
      keys: Object.keys(payload).slice(0, 20),
      ok: payload.ok,
      success: payload.success,
      message: String(payload.message || payload.error || payload.msg || '').slice(0, 180),
      imported: payload.imported ?? payload.accepted ?? payload.count,
    };
  }
  return { status, type: typeof payload, message: typeof payload === 'string' ? payload.slice(0, 180) : '' };
}

async function postImportAccounts(url, apiKey, accounts, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ accounts }),
  });
  const status = Number(response.status) || 0;
  const text = String(await response.text());
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    payload,
    summary: responseSummary(status, payload),
  };
}

function loadMatchingRows(userId, ids, match) {
  const wanted = Array.isArray(ids) ? [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))] : [];
  const sql = wanted.length
    ? `SELECT * FROM gpt_accounts WHERE user_id = ? AND id IN (${wanted.map(() => '?').join(',')})`
    : 'SELECT * FROM gpt_accounts WHERE user_id = ? ORDER BY id';
  const rows = db.prepare(sql).all(userId, ...wanted);
  return rows.map((row) => {
    const detail = toDetail(row);
    return { row, detail, candidate: match(row, detail) };
  }).filter((item) => item.candidate);
}

function loadCandidateRows(userId, ids = []) {
  return loadMatchingRows(userId, ids, isDumpCandidate);
}

function loadAllDumpRows(userId, ids = []) {
  return loadMatchingRows(userId, ids, (row, detail) => isDumpCandidate(row, detail, { includeTrial: true }));
}

function loadExtractExhaustedRows(userId, ids, caps) {
  return loadMatchingRows(userId, ids, (row, detail) => isExtractExhaustedEligible(row, detail, caps));
}

function splitExtractDumpRows(userId, rows) {
  const found = [];
  for (const item of rows) {
    if (shouldSkipPlatformSync(item.row)) {
      applySkipPlatformSync(userId, item.row.id, extractFailCount(item.row));
      continue;
    }
    found.push(item);
  }
  return found;
}

function deleteAccepted(userId, emails, options = {}) {
  const list = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return 0;
  const paid = PAID_ACCOUNT_SQL;
  const keepSql = options.allowTrialDelete ? SKIP_PLATFORM_KEEP_SQL : KEEP_ACCOUNT_SQL;
  const tx = db.transaction(() => {
    const stmt = db.prepare(
      `DELETE FROM gpt_accounts
       WHERE user_id = ? AND lower(email) = ? AND NOT (${paid}) AND NOT (${keepSql})`
    );
    let deleted = 0;
    for (const email of list) deleted += stmt.run(userId, email).changes;
    return deleted;
  });
  return tx();
}

async function dumpFoundRows(userId, found, cfg, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { skipped: true, reason: 'no_fetch', pushed: 0, deleted: 0, emails: [] };
  }
  if (!found.length) return { skipped: false, pushed: 0, deleted: 0, emails: [], reason: 'empty' };

  const pushed = [];
  let deletedCount = 0;
  const failed = [];
  const logSource = options.logSource || 'import-dump';
  const failLog = options.failLog || ((error) => `无试用普号导出失败：${String(error.message || error).slice(0, 160)}`);
  const httpLog = options.httpLog || ((result) => `无试用普号导出 HTTP ${result.status}：${result.summary.message || '远程未接受'}`);
  const successLog = options.successLog || ((accepted) => (
    `无试用普号已导出 ${accepted.length} 个并删除 ${accepted.length} 个：${accepted.join(', ') || '无'}`
  ));

  for (let i = 0; i < found.length; i += DUMP_BATCH) {
    const batch = found.slice(i, i + DUMP_BATCH);
    const accounts = batch.map((item) => toImportPayload(item.detail));
    let result;
    try {
      result = await postImportAccounts(cfg.url, cfg.apiKey, accounts, fetchImpl);
    } catch (error) {
      failed.push(...batch.map((item) => item.detail.email));
      opLog.account(userId, 'error', failLog(error), { source: logSource });
      continue;
    }
    if (!result.ok) {
      failed.push(...batch.map((item) => item.detail.email));
      opLog.account(userId, 'warning', httpLog(result), { source: logSource });
      continue;
    }
    const accepted = parseAcceptedEmails(result.payload, accounts);
    try {
      require('./accountSyncs').recordAccountSyncs(userId, accepted, {
        kind: options.syncKind || 'regular',
        reason: options.syncReason || '没试用',
        remote_ok: true,
      });
    } catch {
      /* history is best-effort; dump still deletes */
    }
    deletedCount += deleteAccepted(userId, accepted, { allowTrialDelete: Boolean(options.allowTrialDelete) });
    pushed.push(...accepted);
    opLog.account(userId, 'success', String(successLog(accepted)).slice(0, 900), { source: logSource });
  }
  return {
    skipped: false,
    pushed: pushed.length,
    deleted: deletedCount,
    emails: pushed,
    failed: failed.length,
    failed_emails: failed,
  };
}

async function dumpNoTrialAccounts(userId, options = {}) {
  const settings = options.settings || readSettings(userId);
  const cfg = importDumpConfig(settings);
  if (!cfg.configured) {
    return { skipped: true, reason: 'not_configured', pushed: 0, deleted: 0, emails: [] };
  }
  const found = loadCandidateRows(userId, options.ids);
  return dumpFoundRows(userId, found, cfg, {
    ...options,
    logSource: options.logSource || 'dump-no-trial',
    syncKind: options.syncKind || 'regular',
    syncReason: options.syncReason || '没试用',
    allowTrialDelete: false,
  });
}

async function dumpAllAccounts(userId, options = {}) {
  const settings = options.settings || readSettings(userId);
  const cfg = importDumpConfig(settings);
  if (!cfg.configured) {
    return { skipped: true, reason: 'not_configured', pushed: 0, deleted: 0, emails: [] };
  }
  const found = loadAllDumpRows(userId, options.ids);
  return dumpFoundRows(userId, found, cfg, {
    ...options,
    logSource: options.logSource || 'dump-all',
    syncKind: options.syncKind || 'regular',
    syncReason: options.syncReason || '全部账号',
    allowTrialDelete: true,
    failLog: (error) => `全部账号导出失败：${String(error.message || error).slice(0, 160)}`,
    httpLog: (result) => `全部账号导出 HTTP ${result.status}：${result.summary.message || '远程未接受'}`,
    successLog: (accepted) => (
      `全部账号已导出 ${accepted.length} 个并删除 ${accepted.length} 个：${accepted.join(', ') || '无'}`
    ),
  });
}

const extractDumpSkipLogged = new Set();

async function dumpExtractExhaustedAccounts(userId, options = {}) {
  const settings = options.settings || readSettings(userId);
  const cfg = importDumpConfig(settings);
  const caps = pipelineCaps(settings);
  const found = splitExtractDumpRows(userId, loadExtractExhaustedRows(userId, options.ids, caps));
  if (!cfg.configured) {
    if (options.logSkip !== false) {
      for (const item of found) {
        const key = `${userId}:${item.row.id}`;
        if (extractDumpSkipLogged.has(key)) continue;
        extractDumpSkipLogged.add(key);
        opLog.account(
          userId,
          'info',
          `${item.detail.email}：提链次数用尽，未配置传送，跳过`,
          { source: 'import-dump' },
        );
      }
    }
    return { skipped: true, reason: 'not_configured', pushed: 0, deleted: 0, emails: [] };
  }
  if (typeof (options.fetchImpl || globalThis.fetch) !== 'function') {
    return { skipped: true, reason: 'no_fetch', pushed: 0, deleted: 0, emails: [] };
  }
  const result = await dumpFoundRows(userId, found, cfg, {
    ...options,
    syncKind: 'regular',
    syncReason: '提链次数用尽',
    failLog: (error) => `提链次数用尽后传送失败：${String(error.message || error).slice(0, 160)}`,
    httpLog: (res) => `提链次数用尽后传送 HTTP ${res.status}：${res.summary.message || '远程未接受'}`,
    successLog: (accepted) => accepted.map((email) => `${email}：提链次数用尽，已传送`).join('；') || '提链次数用尽，已传送',
  });
  return result;
}

function cleanInvalidUnpaidAccounts(userId, options = {}) {
  const wanted = Array.isArray(options.ids)
    ? [...new Set(options.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  const idSql = wanted.length ? ` AND id IN (${wanted.map(() => '?').join(',')})` : '';
  const select = db.prepare(
    `SELECT id, email FROM gpt_accounts
     WHERE user_id = ? AND (${INVALID_TOKEN_SQL}) AND NOT (${PAID_ACCOUNT_SQL}) AND NOT (${KEEP_ACCOUNT_SQL})${idSql}`
  );
  const rows = select.all(userId, ...wanted);
  if (!rows.length) return { deleted: 0, emails: [] };
  const tx = db.transaction(() => {
    const del = db.prepare(
      `DELETE FROM gpt_accounts
       WHERE user_id = ? AND id = ? AND (${INVALID_TOKEN_SQL}) AND NOT (${PAID_ACCOUNT_SQL}) AND NOT (${KEEP_ACCOUNT_SQL})`
    );
    let deleted = 0;
    for (const row of rows) deleted += del.run(userId, row.id).changes;
    return deleted;
  });
  const deleted = tx();
  const emails = rows.map((row) => row.email);
  if (deleted) {
    opLog.account(
      userId,
      'info',
      `已自动清理 ${deleted} 个未支付令牌失效账号：${emails.join(', ')}`.slice(0, 900),
      { source: 'token-cleanup' },
    );
  }
  return { deleted, emails };
}

async function afterAccountChange(userId, id, options = {}) {
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE user_id = ? AND id = ?').get(userId, id);
  if (!row) return { missing: true };
  if (isInvalidTokenRow(row) && !isPaidAccount(row)) {
    return { cleaned: true, ...cleanInvalidUnpaidAccounts(userId, { ids: [id] }) };
  }
  // 导出/推送只走后台手工按钮，检测后和流水线不再自动 dump
  return { skipped: true, reason: 'no_action' };
}

module.exports = {
  PAID_ACCOUNT_SQL,
  INVALID_TOKEN_SQL,
  PREMIUM_PLANS,
  DUMP_BATCH,
  isPaidAccount,
  isPremiumPlan,
  isInvalidTokenRow,
  isConfirmedNoTrial,
  dumpTrialAllowed,
  isDumpCandidate,
  isExtractExhaustedEligible,
  isExtractExhaustedDumpCandidate,
  importDumpConfig,
  toImportPayload,
  parseAcceptedEmails,
  dumpNoTrialAccounts,
  dumpAllAccounts,
  dumpExtractExhaustedAccounts,
  cleanInvalidUnpaidAccounts,
  afterAccountChange,
  postImportAccounts,
};
