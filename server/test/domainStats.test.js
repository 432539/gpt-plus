'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-domain-stats-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '8'.repeat(64);

const db = require('../src/db');
const bcrypt = require('bcryptjs');
const { domainStatsForUser } = require('../src/utils/domainStats');

const hash = bcrypt.hashSync('passpass', 4);
const userId = db.prepare(
  'INSERT INTO users (username, password_hash, role, level) VALUES (?, ?, ?, ?)'
).run('stats-user', hash, 'user', 1).lastInsertRowid;

db.prepare(
  `INSERT INTO registration_batches (batch_id, user_id, run_id, status, total, concurrency, queued)
   VALUES (?, ?, ?, 'finished', 2, 1, 0)`
).run('batch-1', userId, 'run-1');

db.prepare(
  `INSERT INTO registration_jobs (job_id, batch_id, user_id, email, status)
   VALUES (?, 'batch-1', ?, ?, 'success'), (?, 'batch-1', ?, ?, 'failed')`
).run('j1', userId, 'a@alpha.example', 'j2', userId, 'b@alpha.example');

db.prepare(
  `INSERT INTO gpt_accounts (user_id, email, has_trial, progress, activated_at)
   VALUES (?, 'a@alpha.example', 1, '已支付', '2026-08-21 00:00:00'),
          (?, 'c@beta.example', 0, '已注册', '')`
).run(userId, userId);

test('domain stats reports register, trial and pay rates by suffix', () => {
  const rows = domainStatsForUser(userId);
  const edu0 = rows.find((row) => row.suffix === 'alpha.example');
  const edu1 = rows.find((row) => row.suffix === 'beta.example');
  assert.equal(edu0.register_total, 2);
  assert.equal(edu0.register_success, 1);
  assert.equal(edu0.register_rate, 50);
  assert.equal(edu0.trial_yes, 1);
  assert.equal(edu0.trial_detected, 1);
  assert.equal(edu0.trial_rate, 100);
  assert.equal(edu0.paid_count, 1);
  assert.equal(edu0.pay_rate, 100);
  assert.equal(edu1.account_count, 1);
  assert.equal(edu1.trial_yes, 0);
  assert.equal(edu1.trial_rate, 0);
  assert.equal(edu1.paid_count, 0);
});
