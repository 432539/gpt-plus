const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-log-migration-'));
const dbPath = path.join(temp, 'legacy.db');
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    source TEXT DEFAULT '',
    ref TEXT DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  INSERT INTO operation_logs (user_id, category, message)
  VALUES (1, 'register', 'legacy log survives');
`);
legacy.close();

process.env.GPT_PLUS_DB_PATH = dbPath;
const db = require('../src/db');

test('adds run_id idempotently while preserving legacy operation logs', () => {
  const columns = db.prepare('PRAGMA table_info(operation_logs)').all().map((column) => column.name);
  assert.equal(columns.includes('run_id'), true);
  const row = db.prepare('SELECT message, run_id FROM operation_logs WHERE id = 1').get();
  assert.equal(row.message, 'legacy log survives');
  assert.equal(row.run_id, '');
  assert.doesNotThrow(() => db.exec("UPDATE operation_logs SET run_id = run_id WHERE id = 1"));
});
