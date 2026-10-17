'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-channel-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '5'.repeat(64);

const db = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { jobSlotKey, normalizeChannel } = require('../src/utils/accountChannel');
const { checkoutBody, checkGcashTrial, gcashMethodId, FORBIDDEN } = require('../src/utils/checkGcashTrial');
const { CHECKOUT_PATH, CHECK_PATH } = require('../src/utils/paypalExtract');
const { accountRows } = require('../src/utils/accountPipeline');
const gcPipeline = require('../src/utils/accountGcPipeline');
const engine = require('../src/utils/globalExtractEngine');
const { selectTargets, selectTrialUnsetTargets } = require('../src/utils/accountDetectPoller');
const registerJob = require('../src/utils/registerJob');
const {
  markGcashExtracted, clearGcashExtract, extractCopyValue, extractLinkState, PROGRESS,
} = require('../src/utils/accountProgress');
const { toDetail, toListItem } = require('../src/utils/accountFields');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

function insertAccount(email, extra = {}) {
  return db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress, access_token, channel, has_trial, extract_link)
     VALUES (?, ?, 'Free', 'gmail', '正常', ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    email,
    extra.progress || '已注册',
    extra.access_token || encrypt('fixture-at'),
    extra.channel || 'gb',
    extra.has_trial === undefined ? 1 : extra.has_trial,
    extra.extract_link || '',
  ).lastInsertRowid;
}

test('job slots keep default GB key and isolate GC', () => {
  assert.equal(normalizeChannel(''), 'gb');
  assert.equal(normalizeChannel('GC'), 'gc');
  assert.equal(jobSlotKey(7, 'gb'), 7);
  assert.equal(jobSlotKey(7, ''), 7);
  assert.equal(jobSlotKey(7, 'gc'), '7:gc');
  assert.notEqual(jobSlotKey(7, 'gb'), jobSlotKey(7, 'gc'));
});

test('resolveRegisterProxyGroup default stays __auto__:GB', () => {
  assert.equal(registerJob.resolveRegisterProxyGroup(''), '__auto__:GB');
  assert.equal(registerJob.resolveRegisterProxyGroup('直连'), '__auto__:GB');
  assert.equal(registerJob.normalizeStartOptions({}).proxy_group, '__auto__:GB');
  assert.equal(registerJob.normalizeStartOptions({ channel: 'gc', proxy_group: '__auto__:PH' }).proxy_group, '__auto__:PH');
});

test('checkGcashTrial body is PH/PHP with promo and only POST checkout', async () => {
  const body = checkoutBody();
  assert.equal(body.billing_details.country, 'PH');
  assert.equal(body.billing_details.currency, 'PHP');
  assert.equal(body.promo_campaign.promo_campaign_id, 'plus-1-month-free');
  assert.equal(body.promo_campaign.is_coupon_from_query_param, false);
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 245);
  const paths = [];
  const logs = [];
  const result = await checkGcashTrial({
    detail: { access_token: 'at', email: 'gc@example.test' },
    log: (message) => logs.push(String(message)),
    fetchImpl: async (url, init) => {
      const parsed = new URL(url, 'https://chatgpt.com');
      paths.push(`${init?.method || 'GET'} ${parsed.pathname}`);
      assert.equal(init?.method, 'POST');
      const payload = typeof init?.json === 'object' ? init.json : JSON.parse(init?.body || '{}');
      assert.equal(payload.billing_details.country, 'PH');
      assert.equal(payload.billing_details.currency, 'PHP');
      assert.equal(payload.promo_campaign.promo_campaign_id, 'plus-1-month-free');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          checkout_session_id: 'cs_test_gcash',
          custom_payment_methods: [{ id: 'cpmt_gcash_ph' }],
        }),
        url: `https://chatgpt.com${CHECKOUT_PATH}`,
      };
    },
  });
  assert.equal(result.has_trial, 1);
  assert.equal(result.payment_method_id, 'cpmt_gcash_ph');
  assert.equal(gcashMethodId(result.checkout), 'cpmt_gcash_ph');
  assert.ok(paths.every((item) => item.includes(CHECKOUT_PATH)));
  assert.equal(paths.some((item) => item.includes(CHECK_PATH)), false);
  assert.ok(FORBIDDEN.every((item) => paths.every((path) => !path.includes(item))));
  assert.ok(logs.some((line) => /PH \/ GCash/.test(line)));
  assert.equal(logs.some((line) => /GB 代理检查试用资格/.test(line)), false);
});

test('checkGcashTrial treats cpmt_ as GCash availability even when catalog amount is 110000', async () => {
  const logs = [];
  const result = await checkGcashTrial({
    detail: { access_token: 'at', email: 'gc@example.test' },
    log: (message) => logs.push(String(message)),
    fetchImpl: async (url, init) => {
      assert.equal(init?.method, 'POST');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          checkout_session_id: 'oaics_catalog_price',
          custom_payment_methods: [{ id: 'cpmt_gcash_nonzero' }],
          checkout_session: {
            amount_total: 110000,
            currency: 'php',
            checkout_state: { total: { total: { amount: 110000 } } },
          },
        }),
        url: `https://chatgpt.com${CHECKOUT_PATH}`,
      };
    },
  });
  assert.equal(result.has_trial, 1);
  assert.equal(result.payment_method_id, 'cpmt_gcash_nonzero');
  assert.equal(result.checkout.checkout_amount_minor, 110000);
  assert.ok(logs.some((line) => /cpmt_ 只表示能走 GCash，不等于应付已是 0/.test(line)));
  assert.ok(logs.some((line) => /应付 110000 source=checkout_session\.amount_total/.test(line)));
});

test('GC pipeline without extract only detects and never extracts', async () => {
  assert.equal(gcPipeline.allowGcashExtract({ pipeline_gc: { extract: false } }, { pipeline: true }), false);
  assert.equal(gcPipeline.allowGcashExtract({ pipeline_gc: { extract: true } }, { pipeline: true }), true);
  assert.equal(gcPipeline.allowGcashExtract({ pipeline_gc: { extract: false } }, {}), true);
  assert.deepEqual(gcPipeline.selectDetectIds([
    { id: 11, has_trial: null, access_token: 'at' },
    { id: 12, has_trial: 1, access_token: 'at' },
    { id: 13, has_trial: 0, access_token: 'at' },
    { id: 14, has_trial: null, access_token: '' },
  ]), [11]);

  const started = [];
  await gcPipeline.tickUser(user.id, {
    readSettings: () => ({ pipeline_gc: { register: true, extract: false } }),
    accountRows: () => [
      { id: 11, has_trial: null, access_token: 'at', progress: '已注册' },
      { id: 12, has_trial: 1, access_token: 'at', progress: '已注册' },
    ],
    jobs: {
      register: { isLive: () => true, status: () => ({ running: true }), stop() {}, start: async () => {} },
      extract: { isLive: () => false, status: () => ({ running: false }), stop() {}, start: async () => { started.push('extract'); } },
      pay: { isLive: () => false, status: () => ({ running: false }), stop() {}, start: async () => {} },
      rt: { isLive: () => false, status: () => ({ running: false }), stop() {}, start: async () => {} },
      detect: { isLive: () => false, status: () => ({ running: false }), stop() {}, start: async () => { started.push('detect-job'); } },
    },
    startRegister: async () => { started.push('register'); },
    startExtract: async () => { started.push('extract'); },
    startDetect: async (_uid, ids) => { started.push(['detect', ids]); },
    startPay: async () => { started.push('pay'); },
    startRt: async () => { started.push('rt'); },
  });
  assert.deepEqual(started, [['detect', [11]], 'register']);

  const extractStarted = [];
  const skipped = await gcPipeline.startExtract(user.id, [12], {
    readSettings: () => ({ pipeline_gc: { extract: false } }),
    extract: { start: async () => { extractStarted.push('extract'); } },
  });
  assert.equal(skipped.reason, 'extract_off');
  assert.deepEqual(extractStarted, []);
});

test('GB pipeline and monitor skip channel=gc', () => {
  const gbId = insertAccount('gb-keep@example.test', { channel: 'gb' });
  const gcId = insertAccount('gc-skip@example.test', { channel: 'gc', has_trial: 1 });
  const gbRows = accountRows(user.id);
  assert.ok(gbRows.some((row) => row.id === gbId));
  assert.equal(gbRows.some((row) => row.id === gcId), false);
  const gcRows = gcPipeline.accountRows(user.id);
  assert.ok(gcRows.some((row) => row.id === gcId));
  assert.equal(gcRows.some((row) => row.id === gbId), false);
  const picked = engine.selectMonitorAccount(user.id);
  assert.ok(picked);
  assert.notEqual(picked.id, gcId);
  assert.notEqual(picked.channel, 'gc');
  assert.equal(selectTargets(user.id, true).includes(gcId), false);
  assert.equal(selectTrialUnsetTargets(user.id).includes(gcId), false);
});

test('GC extract writes gcash_* and never extract_link', () => {
  const id = insertAccount('gc-extract@example.test', { channel: 'gc', extract_link: '' });
  markGcashExtracted(user.id, id, {
    gcash_link: 'https://checkoutshopper-live.adyen.com/checkoutshopper/pay/gcash',
    gcash_qr: 'data:image/png;base64,aaa',
    gcash_cs_id: 'cs_gcash_1',
  });
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(row.extract_link, '');
  assert.ok(String(row.gcash_link || ''));
  assert.equal(row.gcash_cs_id, 'cs_gcash_1');
  assert.equal(row.progress, PROGRESS.EXTRACTED);
  const detail = toDetail(row);
  assert.equal(extractCopyValue(detail), '');
  assert.equal(extractLinkState(detail), 'valid');
  assert.equal(toListItem(row).progress, PROGRESS.EXTRACTED);
  assert.equal(toListItem(row).has_gcash_link, true);
  clearGcashExtract(user.id, id);
  const cleared = db.prepare('SELECT extract_link, gcash_link, gcash_qr, gcash_cs_id FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(cleared.extract_link, '');
  assert.equal(cleared.gcash_link, '');
  assert.equal(cleared.gcash_qr, '');
});

test('persistRegisteredAccount stores channel=gc and leaves GB default', () => {
  const gb = registerJob._test.persistRegisteredAccount(user.id, 'persist-gb@example.test', {
    password: 'x',
    access_token: 'at',
    totp_secret: 'MFRGGZDFMZTWQ2LK',
    mfa_enabled: true,
    hardening_status: 'security_complete',
  }, { enableTotp2fa: true, channel: 'gb' });
  const gc = registerJob._test.persistRegisteredAccount(user.id, 'persist-gc@example.test', {
    password: 'x',
    access_token: 'at',
    totp_secret: 'MFRGGZDFMZTWQ2LK',
    mfa_enabled: true,
    hardening_status: 'security_complete',
  }, { enableTotp2fa: true, channel: 'gc' });
  const gbRow = db.prepare('SELECT channel, extract_link, monitor_pool FROM gpt_accounts WHERE id = ?').get(gb.id);
  const gcRow = db.prepare('SELECT channel, extract_link, monitor_pool FROM gpt_accounts WHERE id = ?').get(gc.id);
  assert.equal(gbRow.channel, 'gb');
  assert.equal(gcRow.channel, 'gc');
  assert.equal(gcRow.extract_link || '', '');
  assert.equal(Number(gcRow.monitor_pool || 0), 0);
});

test('GC register trial check uses checkout cpmt_ and does not extract', async () => {
  const email = 'gc-trial-after-reg@example.test';
  const persist = registerJob._test.persistRegisteredAccount(user.id, email, {
    password: 'x',
    access_token: 'at',
    totp_secret: 'MFRGGZDFMZTWQ2LK',
    mfa_enabled: true,
    hardening_status: 'security_complete',
  }, { enableTotp2fa: true, channel: 'gc' });
  const paths = [];
  const result = await registerJob._test.checkTrialAfterRegister(user.id, email, {
    fetchImpl: async (url, init) => {
      const parsed = new URL(url, 'https://chatgpt.com');
      paths.push(`${init?.method || 'GET'} ${parsed.pathname}`);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: JSON.stringify({
          checkout_session_id: 'cs_after_reg',
          custom_payment_methods: [{ id: 'cpmt_after_reg' }],
        }),
        url: `https://chatgpt.com${CHECKOUT_PATH}`,
      };
    },
  });
  assert.equal(result.has_trial, 1);
  assert.equal(paths.some((item) => item.includes(CHECK_PATH)), false);
  assert.ok(paths.every((item) => item.includes(CHECKOUT_PATH)));
  const row = db.prepare('SELECT has_trial, trial_label, progress, gcash_link FROM gpt_accounts WHERE id = ?').get(persist.id);
  assert.equal(row.has_trial, 1);
  assert.equal(row.trial_label, 'gcash-cpmt');
  assert.equal(row.progress, '已注册');
  assert.equal(row.gcash_link || '', '');
});
