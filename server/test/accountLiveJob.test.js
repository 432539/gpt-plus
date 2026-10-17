const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-live-job-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '5'.repeat(64);

const db = require('../src/db');
const { createLiveJob } = require('../src/utils/accountLiveJob');
const { PROGRESS } = require('../src/utils/accountProgress');

function userId() {
  return db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
}

function insertAccount(email, extra = {}) {
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress, activated_at)
     VALUES (?, ?, 'Free', 'gmail', '正常', ?, ?)`
  ).run(userId(), email, extra.progress || PROGRESS.EXTRACTED, extra.activated_at || '');
  return inserted.lastInsertRowid;
}

async function waitFor(fn, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('timed out');
}

test('successful pay immediately drops email from live activate overlay', async () => {
  const id = insertAccount('paid-live@example.test');
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const job = createLiveJob({
    kind: 'activate',
    log() {},
    source: 'activate',
    runOne: async () => { finished(); },
    configure: () => ({ skipCloak: true }),
  });
  await job.start({ id: userId() }, { ids: [id] });
  await done;
  await waitFor(() => {
    const status = job.status(userId());
    return status.success >= 1 && !status.emails.includes('paid-live@example.test');
  });
  const status = job.status(userId());
  assert.equal(status.ids.includes(id), false);
  assert.equal(status.emails.includes('paid-live@example.test'), false);
});

test('dropSettled removes already-paid ids from a running pay job', async () => {
  const hangingId = insertAccount('hanging-pay@example.test');
  const paidId = insertAccount('already-paid@example.test', {
    progress: PROGRESS.PAID,
    activated_at: '2026-08-21 05:00:00',
  });
  let releaseHang;
  const hanging = new Promise((resolve) => { releaseHang = resolve; });
  const job = createLiveJob({
    kind: 'activate',
    log() {},
    source: 'activate',
    runOne: async ({ id }) => {
      if (Number(id) === Number(hangingId)) await hanging;
    },
    configure: () => ({ skipCloak: true }),
  });
  await job.start({ id: userId() }, { ids: [hangingId, paidId], concurrency: 1 });
  await waitFor(() => Number(job.status(userId()).current_id) === Number(hangingId));
  const dropped = job.dropSettled(userId());
  assert.ok(dropped.dropped >= 1);
  const status = job.status(userId());
  assert.equal(status.ids.includes(paidId), false);
  assert.equal(status.emails.includes('already-paid@example.test'), false);
  assert.equal(status.ids.includes(hangingId), true);
  releaseHang();
  await waitFor(() => job.status(userId()).success >= 1);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
