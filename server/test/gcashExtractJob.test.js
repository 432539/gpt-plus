'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-gcash-extract-job-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '4'.repeat(64);

const db = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { decodeExtractLink } = require('../src/utils/accountFields');
const { writeSettings } = require('../src/utils/settings');
const { PROGRESS } = require('../src/utils/accountProgress');
const localProviderExtract = require('../src/utils/localProviderExtract');
const job = require('../src/utils/gcashExtractJob');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const ADYEN = 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture';
const QR = 'data:image/png;base64,fixture-qr';

writeSettings(user.id, {
  dynamic_proxy: {
    active_pool: 'cliproxy',
    providers: {
      cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
    },
  },
});

function insertGcAccount(email) {
  return db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress, access_token, channel)
     VALUES (?, ?, 'Free', 'gmail', '正常', ?, ?, 'gc')`
  ).run(user.id, email, PROGRESS.REGISTERED, encrypt('fixture-at')).lastInsertRowid;
}

async function waitForJobIdle(timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = job.status(user.id);
    if (!status.running && status.finished) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('extract job did not finish');
}

test('empty QR is a recoverable extract failure and is not marked extracted', async (t) => {
  const orig = localProviderExtract.extractLocalProvider;
  let closed = 0;
  t.after(() => {
    localProviderExtract.extractLocalProvider = orig;
  });
  localProviderExtract.extractLocalProvider = async () => ({
    link: ADYEN,
    qr: '',
    cs_id: 'oaics_empty',
    h5: { async close() { closed += 1; } },
  });
  const id = insertGcAccount('empty-qr@example.test');
  await job.start({ id: user.id }, { ids: [id], channel: 'gc' });
  const status = await waitForJobIdle();
  assert.equal(status.failed, 1);
  assert.equal(status.success, 0);
  assert.match(status.message || '', /完成/);
  const row = db.prepare(
    'SELECT progress, gcash_link, gcash_qr, gcash_cs_id, extract_failed_at FROM gpt_accounts WHERE id = ?'
  ).get(id);
  assert.equal(row.progress, PROGRESS.REGISTERED);
  assert.equal(row.gcash_qr, '');
  assert.equal(row.gcash_link || '', '');
  assert.equal(row.gcash_cs_id || '', '');
  assert.ok(row.extract_failed_at);
  assert.equal(closed, 1);
});

test('unavailable pay monitor slot prevents start and QR publication', async (t) => {
  const payJob = require('../src/utils/gcashPayJob');
  assert.equal(payJob.GCASH_PAY_MONITOR_LIMIT, 20);
  const orig = localProviderExtract.extractLocalProvider;
  let extracts = 0;
  const held = Array.from({ length: payJob.GCASH_PAY_MONITOR_LIMIT }, (_, i) => 9101 + i);
  t.after(() => {
    localProviderExtract.extractLocalProvider = orig;
    for (const heldId of held) payJob.releaseGcashPayMonitorReservation(user.id, heldId);
  });
  for (const heldId of held) assert.equal(payJob.reserveGcashPayMonitor(user.id, heldId).ok, true);
  localProviderExtract.extractLocalProvider = async () => {
    extracts += 1;
    return { link: ADYEN, qr: QR, cs_id: 'oaics_should_not_publish' };
  };
  const id = insertGcAccount('monitor-full@example.test');
  await job.start({ id: user.id }, { ids: [id], channel: 'gc' });
  const status = await waitForJobIdle();
  assert.equal(status.failed, 1);
  assert.equal(extracts, 0);
  const row = db.prepare('SELECT gcash_link, gcash_qr, gcash_cs_id FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(row.gcash_link || '', '');
  assert.equal(row.gcash_qr || '', '');
  assert.equal(row.gcash_cs_id || '', '');
});

test('extract persists H5 merchants-auth landing as gcash_link', async (t) => {
  const orig = localProviderExtract.extractLocalProvider;
  const payJob = require('../src/utils/gcashPayJob');
  const origPay = payJob.ensureGcashPayMonitor;
  t.after(() => {
    localProviderExtract.extractLocalProvider = orig;
    payJob.ensureGcashPayMonitor = origPay;
  });
  payJob.ensureGcashPayMonitor = async () => ({ ok: true });
  const landing = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5';
  localProviderExtract.extractLocalProvider = async () => ({
    link: landing,
    qr: QR,
    cs_id: 'oaics_landed',
  });
  const id = insertGcAccount('landed-url@example.test');
  await job.start({ id: user.id }, { ids: [id], channel: 'gc' });
  const status = await waitForJobIdle();
  assert.equal(status.success, 1);
  const row = db.prepare('SELECT gcash_link, gcash_cs_id FROM gpt_accounts WHERE id = ?').get(id);
  const stored = decodeExtractLink(row.gcash_link);
  assert.match(stored, /m\.gcash\.com\/gcashapp\/gcash-merchants-auth\/index\.html/);
  assert.equal(/adyen\.com/i.test(stored), false);
  assert.equal(row.gcash_cs_id, 'oaics_landed');
});

test('data:image QR is extract success', async (t) => {
  const orig = localProviderExtract.extractLocalProvider;
  const payJob = require('../src/utils/gcashPayJob');
  const origPay = payJob.ensureGcashPayMonitor;
  const payStarted = [];
  t.after(() => {
    localProviderExtract.extractLocalProvider = orig;
    payJob.ensureGcashPayMonitor = origPay;
  });
  payJob.ensureGcashPayMonitor = async (_user, accountId) => {
    payStarted.push(Number(accountId));
    return { ok: true };
  };
  localProviderExtract.extractLocalProvider = async () => ({
    link: ADYEN,
    qr: QR,
    cs_id: 'oaics_ok',
  });
  const id = insertGcAccount('has-qr@example.test');
  await job.start({ id: user.id }, { ids: [id], channel: 'gc' });
  const status = await waitForJobIdle();
  assert.equal(status.success, 1);
  assert.equal(status.failed, 0);
  const row = db.prepare(
    'SELECT progress, gcash_qr, gcash_cs_id FROM gpt_accounts WHERE id = ?'
  ).get(id);
  assert.equal(row.progress, PROGRESS.EXTRACTED);
  assert.equal(row.gcash_qr, QR);
  assert.equal(row.gcash_cs_id, 'oaics_ok');
  assert.deepEqual(payStarted, [id]);
});

test('extract success parks H5 and starts pay without closing the browser', async (t) => {
  const orig = localProviderExtract.extractLocalProvider;
  const payJob = require('../src/utils/gcashPayJob');
  const { getGcashSession, releaseGcashSession } = require('../src/utils/gcashSessionStore');
  const origPay = payJob.ensureGcashPayMonitor;
  let closed = 0;
  const payStarted = [];
  t.after(async () => {
    localProviderExtract.extractLocalProvider = orig;
    payJob.ensureGcashPayMonitor = origPay;
  });
  payJob.ensureGcashPayMonitor = async (_user, accountId) => {
    payStarted.push(Number(accountId));
    return { ok: true };
  };
  const h5 = new EventEmitter();
  h5.consultUuid = 'h5-consult-uuid';
  h5.context = { identity: 'same-context' };
  h5.page = { identity: 'same-page' };
  h5.close = async () => { closed += 1; };
  const listener = () => {};
  h5.on('verify', listener);
  localProviderExtract.extractLocalProvider = async () => ({
    link: ADYEN,
    qr: QR,
    cs_id: 'oaics_park',
    session: { async close() {} },
    protocol: { ready: true },
    h5,
    payment_method_id: 'cpmt_x',
    device_id: 'did',
    session_id: 'sid',
  });
  const id = insertGcAccount('park-h5@example.test');
  await job.start({ id: user.id }, { ids: [id], channel: 'gc' });
  const status = await waitForJobIdle();
  assert.equal(status.success, 1);
  assert.equal(closed, 0);
  assert.deepEqual(payStarted, [id]);
  const parked = getGcashSession(user.id, id);
  assert.equal(parked.h5, h5);
  assert.equal(parked.h5.context, h5.context);
  assert.equal(parked.h5.page, h5.page);
  assert.equal(parked.h5.listenerCount('verify'), 1);
  assert.equal(parked.auth.consultUuid, 'h5-consult-uuid');
  await releaseGcashSession(user.id, id);
  assert.equal(closed, 1);
});

test('dumpGcashQrFile writes a png into the dump dir without keeping the data URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-gcash-qr-'));
  const previous = process.env.GCASH_QR_DUMP_DIR;
  process.env.GCASH_QR_DUMP_DIR = dir;
  try {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const file = job.dumpGcashQrFile('otp93b32@example.test', png);
    assert.ok(file.startsWith(dir));
    assert.match(path.basename(file), /^otp93b32-\d+\.png$/);
    assert.ok(fs.statSync(file).size > 20);
    assert.equal(fs.readFileSync(file).includes(Buffer.from('otp93b32')), false);
  } finally {
    process.env.GCASH_QR_DUMP_DIR = previous;
  }
});
