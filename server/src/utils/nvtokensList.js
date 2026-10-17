'use strict';

const db = require('../db');
const opLog = require('./opLog');
const { readSettings } = require('./settings');
const { toDetail } = require('./accountFields');
const {
  formatYuan,
  maskApiKey,
  isListablePlusAccount,
  resolveListPrice,
  fetchPriceBoard,
  postPoolCard,
  disableFallbackPoolDefault,
  normalizeSessionCookie,
} = require('./nvtokensPool');

const LIST_ATTEMPT_CAP = 3;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const missingKeyLogged = new Set();

function credentials(settings = {}) {
  const cfg = settings.nvtokens || {};
  return {
    autoList: cfg.auto_list_plus === true,
    minPrice: formatYuan(cfg.min_price_yuan) || '20.00',
    apiKey: String(cfg.api_key || '').trim() || String(process.env.NVTOKENS_API_KEY || '').trim(),
    session: normalizeSessionCookie(cfg.session_cookie) || normalizeSessionCookie(process.env.NVTOKENS_SESSION),
  };
}

function alreadyListed(row = {}) {
  return Boolean(String(row.nvtokens_listed_at || '').trim());
}

function listAttempts(row = {}) {
  const n = Number(row.nvtokens_list_attempts);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function selectListableRows(userId) {
  return db.prepare(
    `SELECT * FROM gpt_accounts
     WHERE user_id = ?
       AND lower(plan_type) = 'plus'
       AND refresh_token IS NOT NULL AND TRIM(refresh_token) != ''
       AND (nvtokens_listed_at IS NULL OR TRIM(nvtokens_listed_at) = '')
       AND COALESCE(nvtokens_list_attempts, 0) < ?
     ORDER BY id`
  ).all(userId, LIST_ATTEMPT_CAP);
}

function stampListed(userId, id) {
  const stamp = now();
  db.prepare(
    `UPDATE gpt_accounts SET nvtokens_listed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(stamp, stamp, id, userId);
}

function bumpListAttempt(userId, id) {
  const stamp = now();
  db.prepare(
    `UPDATE gpt_accounts
     SET nvtokens_list_attempts = COALESCE(nvtokens_list_attempts, 0) + 1, updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(stamp, id, userId);
  const row = db.prepare(
    'SELECT nvtokens_list_attempts AS n FROM gpt_accounts WHERE id = ? AND user_id = ?'
  ).get(id, userId);
  return Number(row?.n) || 0;
}

function isListSuccess(result) {
  if (result?.ok) return true;
  const status = Number(result?.status) || 0;
  if (status === 409) return true;
  const blob = `${result?.payload?.code || ''} ${result?.payload?.error || ''}`.toLowerCase();
  return /already|duplicate|exists/.test(blob);
}

function isPermanentListError(result) {
  const status = Number(result?.status) || 0;
  return status === 401 || status === 422;
}

async function boardPlus(creds, fetchImpl) {
  if (!creds.session) return null;
  try {
    const result = await fetchPriceBoard({
      session: creds.session,
      omitApiKey: true,
      fetchImpl,
    });
    if (!result.ok) return null;
    return result.plus || null;
  } catch {
    return null;
  }
}

function rowToPoolAccount(row) {
  const detail = toDetail(row);
  return {
    type: 'codex',
    email: detail.email,
    access_token: detail.access_token,
    refresh_token: detail.refresh_token,
    plan_type: detail.plan_type || row.plan_type,
  };
}

async function listOne(userId, row, { creds, plus, fetchImpl } = {}) {
  if (!row || alreadyListed(row) || listAttempts(row) >= LIST_ATTEMPT_CAP) {
    return { skipped: true, reason: alreadyListed(row) ? 'listed' : 'cap' };
  }
  const account = rowToPoolAccount(row);
  if (!isListablePlusAccount(account) || !account.access_token || !account.email) {
    return { skipped: true, reason: 'not_listable' };
  }
  if (!creds?.apiKey) return { skipped: true, reason: 'no_key' };
  try {
    await disableFallbackPoolDefault({
      session: creds.session,
      omitApiKey: true,
      fetchImpl,
    });
  } catch {
    /* listing still sends fallback_pool_enabled: false */
  }
  const price = resolveListPrice(creds.minPrice, plus);
  if (!price || Number(price) <= 0) {
    return { skipped: true, reason: 'below_min' };
  }
  const result = await postPoolCard(account, price, {
    apiKey: creds.apiKey,
    fetchImpl,
  });
  if (isListSuccess(result)) {
    stampListed(userId, row.id);
    try {
      const { recordAccountSync, remoteListId } = require('./accountSyncs');
      recordAccountSync(userId, {
        email: account.email,
        kind: 'plus',
        reason: `nvtokens 上架 ${price}`,
        price_yuan: price,
        remote_ok: true,
        remote_id: remoteListId(result),
      });
    } catch {
      /* history is best-effort */
    }
    opLog.account(userId, 'success', `${account.email}：已上架 nvtokens，价格 ${price}`, {
      source: 'nvtokens',
    });
    return { skipped: false, listed: true, price_yuan: price, status: result.status };
  }
  const attempts = bumpListAttempt(userId, row.id);
  const permanent = isPermanentListError(result);
  opLog.account(
    userId,
    'warning',
    `${account.email}：nvtokens 上架失败 HTTP ${result.status || 0}${permanent ? '（不再循环）' : ''}，第 ${attempts}/${LIST_ATTEMPT_CAP} 次，密钥 ${maskApiKey(creds.apiKey)}`,
    { source: 'nvtokens' },
  );
  return {
    skipped: false,
    listed: false,
    status: result.status,
    attempts,
    permanent,
  };
}

async function listIfEligible(userId, id, options = {}) {
  const settings = options.settings || readSettings(userId);
  const creds = credentials(settings);
  if (!creds.autoList && options.manual !== true) return { skipped: true, reason: 'off' };
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return { skipped: true, reason: 'missing' };
  const plus = options.plus !== undefined ? options.plus : await boardPlus(creds, options.fetchImpl);
  return listOne(userId, row, { creds, plus, fetchImpl: options.fetchImpl });
}

async function sweepUser(userId, options = {}) {
  const settings = options.settings || readSettings(userId);
  const creds = credentials(settings);
  if (!creds.autoList && options.manual !== true) return { skipped: true, reason: 'off' };
  if (!creds.apiKey) {
    if (!missingKeyLogged.has(userId)) {
      missingKeyLogged.add(userId);
      opLog.account(userId, 'warning', '手工上架 PLUS 未配置 nvtokens 库存密钥', { source: 'nvtokens' });
    }
    return { skipped: true, reason: 'no_key' };
  }
  const plus = options.plus !== undefined ? options.plus : await boardPlus(creds, options.fetchImpl);
  const rows = selectListableRows(userId);
  const summary = { skipped: false, listed: 0, failed: 0, skipped_rows: 0 };
  for (const row of rows) {
    const result = await listOne(userId, row, { creds, plus, fetchImpl: options.fetchImpl });
    if (result.listed) summary.listed += 1;
    else if (result.skipped) summary.skipped_rows += 1;
    else summary.failed += 1;
  }
  return summary;
}

async function tick() {
  return [];
}

function kick() {
  return undefined;
}

function startPoller() {
  return null;
}

module.exports = {
  LIST_ATTEMPT_CAP,
  credentials,
  alreadyListed,
  selectListableRows,
  listOne,
  listIfEligible,
  sweepUser,
  tick,
  kick,
  startPoller,
};
