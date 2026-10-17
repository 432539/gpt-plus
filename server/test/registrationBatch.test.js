const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-registration-batch-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '7'.repeat(64);

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');
const { decrypt } = require('../src/utils/crypto');
const {
  REGISTER_MAX_ATTEMPTS,
  CAPACITY_FAILURE_CODES,
  BATCH_INFRASTRUCTURE_FAILURE_CODES,
  classifyRegisterFailure,
} = require('../src/automation/lib/retry-policy');

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

function insertBatch(id, emails) {
  db.prepare(
    `INSERT INTO registration_runs (
       run_id, user_id, target, concurrency, running, finished, started_at
     ) VALUES (?, ?, ?, 1, 1, 0, datetime('now','localtime'))`
  ).run(id, userId, emails.length);
  db.prepare(
    `INSERT INTO registration_batches (
       batch_id, user_id, run_id, status, total, concurrency, queued
     ) VALUES (?, ?, ?, 'running', ?, 1, ?)`
  ).run(id, userId, id, emails.length, emails.length);
  const insert = db.prepare(
    `INSERT INTO registration_jobs (
       job_id, batch_id, user_id, email, status, progress
     ) VALUES (?, ?, ?, ?, 'queued', 0)`
  );
  emails.forEach((email, index) => insert.run(`${id}-job-${index}`, id, userId, email));
}

test('registration job terminal state synchronously updates batch and legacy run', () => {
  insertBatch('terminal-batch', ['one@example.test', 'two@example.test']);
  registerJob._test.patchRegistrationJob('terminal-batch-job-0', {
    status: 'success',
    progress: 100,
    attempt: 2,
    result: { access_token: 'redacted-in-real-flow' },
  });
  registerJob._test.patchRegistrationJob('terminal-batch-job-1', {
    status: 'partial',
    progress: 100,
    attempt: 1,
    partial: true,
    error_code: 'ACCOUNT_MFA_SETUP_FAILED',
    result: { success: false, partial: true },
  });

  const view = registerJob.getBatch(userId, 'terminal-batch');
  assert.equal(view.status, 'completed');
  assert.equal(view.completed, 2);
  assert.equal(view.success, 1);
  assert.equal(view.partial, 1);
  assert.equal(view.failed, 0);
  assert.equal(view.retried, 1);
  assert.deepEqual(view.results.map((job) => job.status), ['success', 'partial']);
  assert.equal(view.results[0].result.access_token, undefined);

  const legacy = db.prepare('SELECT * FROM registration_runs WHERE run_id = ?').get('terminal-batch');
  assert.equal(legacy.running, 0);
  assert.equal(legacy.finished, 1);
  assert.equal(legacy.completed, 2);
  assert.equal(legacy.success, 1);
  assert.equal(legacy.failed, 1);
});

test('credential checkpoint keeps unknown has_trial as NULL rather than empty string', () => {
  registerJob._test.upsertAccountCheckpoint(userId, 'trial-null@example.test', {
    password: 'Password-Secret',
    access_token: 'AT-Secret',
  });
  const row = db.prepare(
    'SELECT has_trial, typeof(has_trial) AS t FROM gpt_accounts WHERE user_id = ? AND email = ?'
  ).get(userId, 'trial-null@example.test');
  assert.equal(row.has_trial, null);
  assert.notEqual(row.t, 'text');
});

test('credential checkpoints upsert encrypted account data and preserve earlier fields', () => {
  registerJob._test.upsertAccountCheckpoint(userId, 'checkpoint@example.test', {
    password: 'Password-Secret',
    password_set: true,
    hardening_status: 'password_set',
  });
  registerJob._test.upsertAccountCheckpoint(userId, 'checkpoint@example.test', {
    access_token: 'AT-Secret',
    totp_secret: 'TOTPSECRET234567',
    mfa_enabled: false,
    security_ready: false,
    hardening_status: 'failed',
    hardening_error_code: 'ACCOUNT_MFA_SETUP_FAILED',
  });

  const row = db.prepare(
    'SELECT * FROM gpt_accounts WHERE user_id = ? AND email = ?'
  ).get(userId, 'checkpoint@example.test');
  assert.ok(row);
  assert.notEqual(row.password_enc, 'Password-Secret');
  assert.notEqual(row.access_token, 'AT-Secret');
  assert.notEqual(row.totp_secret_enc, 'TOTPSECRET234567');
  assert.equal(decrypt(row.password_enc), 'Password-Secret');
  assert.equal(decrypt(row.access_token), 'AT-Secret');
  assert.equal(decrypt(row.totp_secret_enc), 'TOTPSECRET234567');
  assert.equal(row.password_set, 1);
  assert.equal(row.security_ready, 0);
  assert.equal(row.hardening_error_code, 'ACCOUNT_MFA_SETUP_FAILED');
});

test('restart reconciliation cancels active children and retains terminal results', () => {
  insertBatch('restart-batch', ['done@example.test', 'running@example.test', 'queued@example.test']);
  registerJob._test.patchRegistrationJob('restart-batch-job-0', {
    status: 'success', progress: 100, result: { ok: true },
  });
  registerJob._test.patchRegistrationJob('restart-batch-job-1', {
    status: 'running', progress: 40, attempt: 1,
  });

  assert.equal(registerJob.reconcileStaleRuns(), 1);
  const view = registerJob.getBatch(userId, 'restart-batch');
  assert.equal(view.status, 'interrupted');
  assert.equal(view.success, 1);
  assert.equal(view.cancelled, 2);
  assert.deepEqual(view.results.map((job) => job.status), ['success', 'cancelled', 'cancelled']);
  assert.deepEqual(view.results.slice(1).map((job) => job.error_code), ['PROCESS_RESTARTED', 'PROCESS_RESTARTED']);
});

test('retry policy exposes business, capacity, and circuit semantics', () => {
  assert.equal(REGISTER_MAX_ATTEMPTS, 3);
  assert.ok(CAPACITY_FAILURE_CODES.includes('CLOAK_LICENSE_SESSION_LIMIT'));
  assert.ok(!BATCH_INFRASTRUCTURE_FAILURE_CODES.includes('CLOAK_LICENSE_SESSION_LIMIT'));
  assert.ok(BATCH_INFRASTRUCTURE_FAILURE_CODES.includes('CLOAK_LICENSE_UNAVAILABLE'));
  assert.equal(classifyRegisterFailure({ code: 'PROTOCOL_REQUEST_NETWORK' }).retryable, true);
  assert.equal(classifyRegisterFailure({ code: 'REGISTER_PASSWORD_FAILED' }).terminal, true);
  assert.equal(classifyRegisterFailure({ code: 'REGISTER_ACCOUNT_CREATION_REJECTED' }).terminal, true);
  assert.equal(classifyRegisterFailure({ code: 'REGISTER_ACCOUNT_CREATION_REJECTED' }).retryable, false);
  assert.equal(classifyRegisterFailure({ code: 'PHONE_PROVIDER_NOT_CONFIGURED' }).terminal, true);
  assert.equal(classifyRegisterFailure({ code: 'MAILBOX_OTP_NOT_RECEIVED' }).terminal, true);
  assert.equal(classifyRegisterFailure({ code: 'MAILBOX_OTP_NOT_RECEIVED' }).retryable, false);
  assert.equal(classifyRegisterFailure({ code: 'MAILBOX_OTP_FETCH_FAILED' }).retryable, true);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
