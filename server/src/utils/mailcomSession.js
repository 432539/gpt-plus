// Per-mother mail.com sid/token cache (mail_query session_cache.json semantics).
// Payload is AES-GCM encrypted; never log sid, tokens, or cookies.
const db = require('../db');
const { encrypt, decrypt } = require('./crypto');

const TOKEN_SKEW_SEC = 60;
const memory = new Map();
const exclusive = new Map();

function cacheKey(userId, address) {
  return `${Number(userId) || 0}:${String(address || '').trim().toLowerCase()}`;
}

function cloneSession(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    sid: String(data.sid || ''),
    auth_id: String(data.auth_id || data.authId || ''),
    tokens: data.tokens && typeof data.tokens === 'object' ? { ...data.tokens } : {},
    saved_at: String(data.saved_at || ''),
  };
}

function isUsable(data) {
  return Boolean(data && data.sid);
}

function loadFromMemory(key) {
  return cloneSession(memory.get(key));
}

function loadFromDb(userId, motherKey) {
  const row = db
    .prepare('SELECT payload_enc FROM mailcom_sessions WHERE user_id = ? AND mother_key = ?')
    .get(Number(userId) || 0, motherKey);
  if (!row || !row.payload_enc) return null;
  try {
    const parsed = JSON.parse(decrypt(row.payload_enc) || '');
    return isUsable(parsed) ? cloneSession(parsed) : null;
  } catch {
    return null;
  }
}

function persistDb(userId, motherKey, data) {
  const payload = {
    sid: String(data.sid || ''),
    auth_id: String(data.auth_id || ''),
    tokens: data.tokens && typeof data.tokens === 'object' ? data.tokens : {},
    saved_at: data.saved_at || new Date().toISOString(),
  };
  const payloadEnc = encrypt(JSON.stringify(payload));
  db.prepare(
    `INSERT INTO mailcom_sessions (user_id, mother_key, payload_enc, updated_at)
     VALUES (?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(user_id, mother_key) DO UPDATE SET
       payload_enc = excluded.payload_enc,
       updated_at = excluded.updated_at`
  ).run(Number(userId) || 0, motherKey, payloadEnc);
}

function clearDb(userId, motherKey) {
  db.prepare('DELETE FROM mailcom_sessions WHERE user_id = ? AND mother_key = ?').run(
    Number(userId) || 0,
    motherKey
  );
}

function runExclusive(key, fn) {
  const previous = exclusive.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  exclusive.set(key, next);
  return next.finally(() => {
    if (exclusive.get(key) === next) exclusive.delete(key);
  });
}

function createMailcomSessionStore(userId, address) {
  const motherKey = String(address || '').trim().toLowerCase();
  const key = cacheKey(userId, motherKey);
  return {
    load() {
      const hit = loadFromMemory(key);
      if (hit) return hit;
      const stored = loadFromDb(userId, motherKey);
      if (stored) memory.set(key, stored);
      return cloneSession(stored);
    },
    save(data) {
      const payload = cloneSession(data);
      if (!isUsable(payload)) return;
      payload.saved_at = payload.saved_at || new Date().toISOString();
      memory.set(key, payload);
      persistDb(userId, motherKey, payload);
    },
    clear() {
      memory.delete(key);
      clearDb(userId, motherKey);
    },
    runExclusive(fn) {
      return runExclusive(key, fn);
    },
  };
}

function createMemorySessionStore(initial = null) {
  let data = cloneSession(initial);
  return {
    load() {
      return cloneSession(data);
    },
    save(next) {
      const payload = cloneSession(next);
      if (!isUsable(payload)) return;
      payload.saved_at = payload.saved_at || new Date().toISOString();
      data = payload;
    },
    clear() {
      data = null;
    },
    snapshot() {
      return cloneSession(data);
    },
  };
}

module.exports = {
  TOKEN_SKEW_SEC,
  cacheKey,
  createMailcomSessionStore,
  createMemorySessionStore,
};
