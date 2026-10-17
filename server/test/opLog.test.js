const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-oplog-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');

const db = require('../src/db');
const opLog = require('../src/utils/opLog');
const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

test('five concurrent workers retain every log and outcome across ten-row pages', async () => {
  const outcomes = [];
  await Promise.all(
    Array.from({ length: 5 }, async (_, worker) => {
      const email = `worker-${worker}@example.test`;
      for (let step = 1; step <= 4; step += 1) {
        await Promise.resolve();
        opLog.register(userId, step === 4 ? 'success' : 'info', `${email}: step ${step}`, { ref: email });
      }
      outcomes.push({ email, success: true });
    })
  );

  const first = opLog.page(userId, { category: 'register', limit: 10, offset: 0 });
  const second = opLog.page(userId, { category: 'register', limit: 10, offset: 10 });
  const all = [...first.items, ...second.items];

  assert.equal(outcomes.length, 5);
  assert.equal(outcomes.every((outcome) => outcome.success), true);
  assert.equal(first.total, 20);
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 10);
  assert.equal(new Set(all.map((row) => row.id)).size, 20);
  assert.deepEqual(
    all.map((row) => row.id),
    [...all.map((row) => row.id)].sort((a, b) => b - a)
  );
  for (let worker = 0; worker < 5; worker += 1) {
    assert.equal(all.filter((row) => row.ref === `worker-${worker}@example.test`).length, 4);
  }
});

test('oauth run_id filter works like register logs', () => {
  for (let index = 0; index < 3; index += 1) {
    opLog.oauth(userId, 'info', `extract ${index}`, { source: 'extract', run_id: 'run-extract' });
  }
  opLog.oauth(userId, 'info', 'other extract', { source: 'extract', run_id: 'run-other' });
  const filtered = opLog.latest(userId, { category: 'oauth', runId: 'run-extract', limit: 100 });
  assert.equal(filtered.total, 3);
  assert.equal(filtered.items.every((row) => row.run_id === 'run-extract'), true);
});

test('latest log snapshot reports filtered total and renders oldest-to-newest', () => {
  for (let index = 0; index < 112; index += 1) {
    opLog.register(userId, 'info', `current ${index}`, { run_id: 'run-current' });
  }
  for (let index = 0; index < 4; index += 1) {
    opLog.register(userId, 'info', `older ${index}`, { run_id: 'run-older' });
  }

  const current = opLog.latest(userId, {
    category: 'register',
    runId: 'run-current',
    limit: 1000,
  });
  assert.equal(current.total, 112);
  assert.equal(current.items.length, 100);
  assert.equal(current.items.every((row) => row.run_id === 'run-current'), true);
  assert.deepEqual(
    current.items.map((row) => row.id),
    [...current.items.map((row) => row.id)].sort((a, b) => a - b)
  );
  assert.equal(current.items[0].message, 'current 12');
  assert.equal(current.items.at(-1).message, 'current 111');
});
