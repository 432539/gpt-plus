'use strict';

const db = require('../db');
const { utcStamp } = require('./datetime');

const KIND_REGULAR = 'regular';
const KIND_PLUS = 'plus';
const SYNC_PUBLIC_KEYS = Object.freeze([
  'id', 'email', 'kind', 'kind_label', 'reason', 'price_yuan',
  'remote_ok', 'remote_id', 'synced_at', 'status',
]);

function nowStamp() {
  return utcStamp();
}

function normalizeKind(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === KIND_PLUS || text === 'plus' || text === '已同步plus') return KIND_PLUS;
  if (text === KIND_REGULAR || text === 'free' || text === '普通' || text === '已同步普通') return KIND_REGULAR;
  return '';
}

function kindLabel(kind) {
  return kind === KIND_PLUS ? 'PLUS' : '普通';
}

function statusText(kind, remoteOk) {
  if (!remoteOk) return '失败';
  return kind === KIND_PLUS ? '已上架' : '已同步';
}

function formatYuan(value) {
  if (value == null || value === '') return '';
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function remoteListId(result = {}) {
  const payload = result.payload && typeof result.payload === 'object' ? result.payload : {};
  return firstText(
    result.remote_id,
    payload.id,
    payload.card_id,
    payload.card?.id,
    payload.data?.id,
  ).slice(0, 80);
}

function toPublicRow(row = {}) {
  const kind = normalizeKind(row.kind) || KIND_REGULAR;
  const remoteOk = Number(row.remote_ok) === 1;
  const publicRow = {
    id: Number(row.id) || 0,
    email: String(row.email || '').trim(),
    kind,
    kind_label: kindLabel(kind),
    reason: String(row.reason || ''),
    price_yuan: formatYuan(row.price_yuan) || String(row.price_yuan || ''),
    remote_ok: remoteOk,
    remote_id: String(row.remote_id || ''),
    synced_at: String(row.synced_at || row.created_at || ''),
    status: statusText(kind, remoteOk),
  };
  return publicRow;
}

function assertNoSecrets(row) {
  const keys = Object.keys(row || {});
  for (const key of keys) {
    if (!SYNC_PUBLIC_KEYS.includes(key)) delete row[key];
  }
  return row;
}

function recordAccountSync(userId, input = {}) {
  const uid = Number(userId);
  const email = String(input.email || '').trim().toLowerCase();
  if (!Number.isInteger(uid) || uid <= 0 || !email) return null;
  const kind = normalizeKind(input.kind) || KIND_REGULAR;
  const reason = String(input.reason || '').trim().slice(0, 200);
  const priceYuan = kind === KIND_PLUS ? formatYuan(input.price_yuan) : '';
  const remoteOk = input.remote_ok === false ? 0 : 1;
  const remoteId = String(input.remote_id || '').trim().slice(0, 80);
  const syncedAt = String(input.synced_at || nowStamp());
  const info = db.prepare(
    `INSERT INTO account_syncs
     (user_id, email, kind, reason, price_yuan, remote_ok, remote_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uid, email, kind, reason, priceYuan, remoteOk, remoteId, syncedAt);
  return info.lastInsertRowid;
}

function recordAccountSyncs(userId, emails, extra = {}) {
  const list = [...new Set((emails || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))];
  let inserted = 0;
  for (const email of list) {
    try {
      if (recordAccountSync(userId, { ...extra, email })) inserted += 1;
    } catch {
      /* history is best-effort */
    }
  }
  return inserted;
}

function summaryForUser(userId) {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN kind = 'regular' THEN 1 ELSE 0 END) AS regular_count,
       SUM(CASE WHEN kind = 'plus' THEN 1 ELSE 0 END) AS plus_count,
       SUM(CASE WHEN kind = 'plus' AND price_yuan IS NOT NULL AND TRIM(price_yuan) != ''
                THEN CAST(price_yuan AS REAL) ELSE 0 END) AS plus_amount
     FROM account_syncs
     WHERE user_id = ?`
  ).get(userId) || {};
  const plusAmount = Number(row.plus_amount) || 0;
  return {
    regular_count: Number(row.regular_count) || 0,
    plus_count: Number(row.plus_count) || 0,
    plus_amount: plusAmount,
    plus_amount_yuan: plusAmount.toFixed(2),
  };
}

function listAccountSyncs(userId, query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(query.pageSize ?? query.page_size, 10) || 20));
  const kind = normalizeKind(query.kind);
  const where = ['user_id = ?'];
  const params = [userId];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS c FROM account_syncs WHERE ${whereSql}`).get(...params)?.c) || 0;
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(
    `SELECT id, email, kind, reason, price_yuan, remote_ok, remote_id, synced_at
     FROM account_syncs
     WHERE ${whereSql}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset);
  return {
    items: rows.map((row) => assertNoSecrets(toPublicRow(row))),
    total,
    page,
    page_size: pageSize,
    kind: kind || '',
    summary: summaryForUser(userId),
  };
}

module.exports = {
  KIND_REGULAR,
  KIND_PLUS,
  SYNC_PUBLIC_KEYS,
  normalizeKind,
  remoteListId,
  toPublicRow,
  recordAccountSync,
  recordAccountSyncs,
  summaryForUser,
  listAccountSyncs,
};
