// 业务运行日志:按用户隔离。写失败不影响主流程。
const db = require('../db');
const { prettifyRegisterLog } = require('./registerLogCopy');
const { utcStamp } = require('./datetime');

const CATEGORIES = ['pull', 'register', 'oauth', 'activate', 'account'];
const LEVELS = ['info', 'success', 'warning', 'error'];

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function messageLimit() {
  return envInt('OP_LOG_MESSAGE_LIMIT', 1000, 200, 8000);
}

function latestCap() {
  return envInt('OP_LOG_LATEST_LIMIT', 100, 1, 5000);
}

function write(userId, { category, level = 'info', source = '', ref = '', run_id = '', message = '' } = {}) {
  try {
    const cat = CATEGORIES.includes(category) ? category : 'pull';
    const lv = LEVELS.includes(level) ? level : 'info';
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) return;
    db.prepare(
      `INSERT INTO operation_logs (user_id, category, level, source, ref, run_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uid,
      cat,
      lv,
      String(source || '').slice(0, 80),
      String(ref || '').slice(0, 160),
      String(run_id || '').slice(0, 80),
      String(message || '').slice(0, messageLimit()),
      utcStamp(),
    );
  } catch {
    /* 日志失败静默 */
  }
}

function list(userId, { category, limit = 10, offset = 0, runId = '' } = {}) {
  const cat = CATEGORIES.includes(category) ? category : 'pull';
  const n = Math.min(200, Math.max(1, Number(limit) || 10));
  const skip = Math.max(0, Number(offset) || 0);
  const runFilter = String(runId || '').trim();
  return db
    .prepare(
      `SELECT id, category, level, source, ref, run_id, message, created_at
       FROM operation_logs
       WHERE user_id = ? AND category = ?${runFilter ? ' AND run_id = ?' : ''}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...(runFilter ? [userId, cat, runFilter, n, skip] : [userId, cat, n, skip]));
}

function count(userId, category, runId = '') {
  const cat = CATEGORIES.includes(category) ? category : 'pull';
  const runFilter = String(runId || '').trim();
  return db
    .prepare(
      `SELECT COUNT(*) AS c FROM operation_logs
       WHERE user_id = ? AND category = ?${runFilter ? ' AND run_id = ?' : ''}`
    )
    .get(...(runFilter ? [userId, cat, runFilter] : [userId, cat])).c;
}

// Count and rows must come from one SQLite snapshot while workers are writing.
const readPage = db.transaction((userId, { category, limit = 10, offset = 0, metaOnly = false, runId = '' } = {}) => {
  const total = count(userId, category, runId);
  const items = metaOnly ? [] : list(userId, { category, limit, offset, runId });
  return { total, items };
});

function page(userId, options = {}) {
  return readPage(userId, options);
}

// The log console contract is a single latest-N snapshot rendered oldest-to-newest.
// Count and rows share one SQLite snapshot so `total` describes the returned window.
const readLatest = db.transaction((userId, { category, limit = 100, runId = '' } = {}) => {
  const cat = CATEGORIES.includes(category) ? category : 'pull';
  const cap = latestCap();
  const n = Math.min(cap, Math.max(1, Number(limit) || cap));
  const runFilter = String(runId || '').trim();
  const total = count(userId, cat, runFilter);
  const items = db
    .prepare(
      `SELECT id, category, level, source, ref, run_id, message, created_at
       FROM (
         SELECT id, category, level, source, ref, run_id, message, created_at
         FROM operation_logs
         WHERE user_id = ? AND category = ?${runFilter ? ' AND run_id = ?' : ''}
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`
    )
    .all(...(runFilter ? [userId, cat, runFilter, n] : [userId, cat, n]));
  return { total, items };
});

function latest(userId, options = {}) {
  return readLatest(userId, options);
}

function clear(userId, category) {
  const cat = CATEGORIES.includes(category) ? category : '';
  if (cat) {
    return db.prepare('DELETE FROM operation_logs WHERE user_id = ? AND category = ?').run(userId, cat).changes;
  }
  return db.prepare('DELETE FROM operation_logs WHERE user_id = ?').run(userId).changes;
}

function pull(userId, level, message, extra = {}) {
  write(userId, { category: 'pull', level, source: extra.source || 'mailcom', ref: extra.ref || '', run_id: extra.run_id || '', message });
}

function register(userId, level, message, extra = {}) {
  const pretty = prettifyRegisterLog(message);
  if (!pretty) return;
  write(userId, { category: 'register', level, source: extra.source || 'register', ref: extra.ref || '', run_id: extra.run_id || '', message: pretty });
}

function oauth(userId, level, message, extra = {}) {
  write(userId, { category: 'oauth', level, source: extra.source || 'oauth', ref: extra.ref || '', run_id: extra.run_id || '', message });
}

function activate(userId, level, message, extra = {}) {
  write(userId, { category: 'activate', level, source: extra.source || 'activate', ref: extra.ref || '', run_id: extra.run_id || '', message });
}

function account(userId, level, message, extra = {}) {
  write(userId, { category: 'account', level, source: extra.source || 'account', ref: extra.ref || '', run_id: extra.run_id || '', message });
}

module.exports = { CATEGORIES, write, list, count, page, latest, clear, pull, register, oauth, activate, account };
