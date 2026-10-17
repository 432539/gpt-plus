const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-state-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');
const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

test('reconciles a stale running job and writes one interruption summary', () => {
  db.prepare(
    `INSERT INTO registration_runs (
       run_id, user_id, target, concurrency, completed, success, failed, retried,
       running, finished, message, started_at
     ) VALUES (?, ?, 5, 5, 2, 1, 1, 3, 1, 0, '正在注册', '2026-08-20 01:00:00')`
  ).run('stale-run', userId);

  assert.equal(registerJob.reconcileStaleRuns(), 1);
  assert.equal(registerJob.reconcileStaleRuns(), 0);

  const state = registerJob.status(userId);
  assert.equal(state.run_id, 'stale-run');
  assert.equal(state.running, false);
  assert.equal(state.finished, true);
  assert.equal(state.interrupted, true);
  assert.equal(state.completed, 2);
  assert.match(state.message, /服务重启，任务中断/);

  const summaries = db
    .prepare(
      `SELECT * FROM operation_logs
       WHERE user_id = ? AND category = 'register' AND run_id = ? AND message LIKE '服务重启，任务中断%'`
    )
    .all(userId, 'stale-run');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].level, 'warning');
});

test('returns the latest persisted checkpoint when no in-memory job exists', () => {
  const state = {
    run_id: 'persisted-run',
    target: 5,
    concurrency: 5,
    attempted: 4,
    success: 3,
    failed: 1,
    retried: 2,
    running: false,
    finished: true,
    interrupted: false,
    proxy_group: 'safe-group',
    message: '已结束，成功 3/5，失败 1',
    started_at: '2026-08-20 02:00:00',
    finished_at: '2026-08-20 02:05:00',
  };
  registerJob.persistState(userId, state);

  const persisted = registerJob.status(userId);
  assert.equal(persisted.run_id, 'persisted-run');
  assert.equal(persisted.completed, 4);
  assert.equal(persisted.success, 3);
  assert.equal(persisted.failed, 1);
  assert.equal(persisted.retried, 2);
  assert.equal(persisted.message, state.message);
  assert.equal('current_email' in persisted, true);
  assert.equal(persisted.current_email, '');
});
