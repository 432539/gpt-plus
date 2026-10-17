const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-api-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '8'.repeat(64);

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');

test('registration start aliases normalize the complete compatibility request', () => {
  const value = registerJob.normalizeStartOptions({
    quantity: 9,
    concurrency: 99,
    mail_provider: 'cfworker',
    domain: ' Example.COM ',
    proxy_group: '__auto__:US',
    country: 'us',
    phone_country: 'br',
    max_price: '0.25',
    set_password: false,
    enable_totp_2fa: false,
    get_refresh_token: true,
    register_mode: 'headless_click',
    performance_profile: 'throughput',
    visible: true,
    attempts: 2,
    email_timeout: 123456,
    request_timeout_ms: 23456,
    timeout_ms: 345678,
  });

  assert.equal(value.count, 9);
  assert.equal(value.quantity, 9);
  assert.equal(value.concurrency, 99);
  assert.equal(value.mail_provider, 'cfworker');
  assert.equal(value.mail_domain, 'example.com');
  assert.equal(value.proxy_country, 'US');
  assert.equal(value.phone_country, 'BR');
  assert.equal(value.phone_max_price, '0.25');
  assert.equal(value.set_password, false);
  assert.equal(value.enable_totp_2fa, false);
  assert.equal(value.get_refresh_token, true);
  assert.equal(value.register_mode, 'headless_click');
  assert.equal(value.performance_profile, 'throughput');
  assert.equal(value.headless, false);
  assert.equal(value.humanize, true);
  assert.equal(value.attempts, 2);
  assert.equal(value.email_timeout_ms, 123456);
  assert.equal(value.protocol_timeout_ms, 23456);
  assert.equal(value.session_wall_timeout_ms, 345678);
});

test('registration start aliases accept mail.com + CF mix', () => {
  const value = registerJob.normalizeStartOptions({
    quantity: 10,
    mail_provider: 'mail-mix',
  });
  assert.equal(value.mail_provider, 'mix');
  assert.equal(value.count, 10);
});

test('batch and job views remain isolated by user and expose cancellation states', () => {
  const users = db.prepare('SELECT id FROM users ORDER BY id').all();
  const ownerId = users[0].id;
  db.prepare(
    `INSERT INTO users (username, password_hash, role, status)
     VALUES ('register-api-other', 'x', 'user', 'active')`
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE username='register-api-other'").get().id;
  db.prepare(
    `INSERT INTO registration_runs (run_id,user_id,target,concurrency,running,started_at)
     VALUES ('api-batch',?,1,1,1,datetime('now','localtime'))`
  ).run(ownerId);
  db.prepare(
    `INSERT INTO registration_batches (batch_id,user_id,run_id,status,total,concurrency,queued)
     VALUES ('api-batch',?,'api-batch','running',1,1,1)`
  ).run(ownerId);
  db.prepare(
    `INSERT INTO registration_jobs (job_id,batch_id,user_id,email,status,progress)
     VALUES ('api-job','api-batch',?,'offline@example.test','queued',0)`
  ).run(ownerId);

  assert.equal(registerJob.getBatch(otherId, 'api-batch'), null);
  assert.equal(registerJob.getJob(otherId, 'api-job'), null);
  assert.equal(registerJob.activeBatches(ownerId).length, 1);
  const cancelled = registerJob.cancelBatch(ownerId, 'api-batch');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.results[0].status, 'cancelled');
  assert.equal(cancelled.results[0].error_code, 'JOB_CANCELLED');
  assert.ok(cancelled.throughput);
  assert.ok(cancelled.cloak_capacity);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
