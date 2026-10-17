'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-global-extract-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '6'.repeat(64);

const db = require('../src/db');
const { writeSettings, publicView, DEFAULTS } = require('../src/utils/settings');
const {
  CHANNEL_CATALOG,
  buildOverview,
  savePlan,
} = require('../src/utils/globalExtractMonitor');
const route = require('../src/routes/globalExtract')._test;
const engine = require('../src/utils/globalExtractEngine');
const originalKick = engine.kick;
engine.kick = () => {};

const SECRET_LINK = 'https://www.paypal.com/approve?token=PAYMENT-LINK-SECRET&ba_token=BA-SECRET';
const SECRETS = [
  'AT-SUPER-SECRET',
  'RT-SUPER-SECRET',
  'PASSWORD-SECRET',
  'PROXY-USER-SECRET',
  'PROXY-PASSWORD-SECRET',
  'proxy-secret.example',
  'PAYMENT-LINK-SECRET',
  'BA-SECRET',
  SECRET_LINK,
  'clip-secret',
];

const userId = db.prepare(
  "INSERT INTO users (username,password_hash,role,level,status) VALUES ('gem-user','x','user',1,1)"
).run().lastInsertRowid;
const emptyUserId = db.prepare(
  "INSERT INTO users (username,password_hash,role,level,status) VALUES ('gem-empty','x','user',1,1)"
).run().lastInsertRowid;
const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);

const today = db.prepare("SELECT datetime('now','localtime') AS value").get().value;
db.prepare(
  `INSERT INTO gpt_accounts (
     user_id,email,plan_type,status,password_enc,access_token,refresh_token,
     has_trial,progress,extract_link,extracted_at,activated_at,created_at
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  userId, 'extract@example.test', 'Free', '正常', 'PASSWORD-SECRET',
  'AT-SUPER-SECRET', '', 1, '已提链', SECRET_LINK, today, '', today
);
db.prepare(
  `INSERT INTO gpt_accounts (
     user_id,email,plan_type,status,password_enc,access_token,refresh_token,
     has_trial,progress,extract_link,extracted_at,activated_at,created_at
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
).run(
  userId, 'ready@example.test', 'Free', '正常', 'PASSWORD-SECRET',
  'AT-SUPER-SECRET', 'RT-SUPER-SECRET', 1, '已注册', '', '', '', today
);
db.prepare(
  `INSERT INTO proxies
   (user_id,group_name,host,port,username,password_enc,status,region)
   VALUES (?,?,?,?,?,?,?,?)`
).run(userId, '支付', 'proxy-secret.example', 8080, 'PROXY-USER-SECRET', 'PROXY-PASSWORD-SECRET', '可用', 'GB');
writeSettings(userId, {
  dynamic_proxy: {
    providers: {
      cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
    },
  },
});

function assertNoSecrets(payload) {
  const blob = JSON.stringify(payload);
  for (const secret of SECRETS) {
    assert.equal(blob.includes(secret), false, `response leaked ${secret}`);
  }
  assert.doesNotMatch(
    blob,
    /"(extract_link|access_token|refresh_token|password|password_enc|username|host|token|payment_url)":/i
  );
}

test('settings defaults include a disabled global extract plan', () => {
  const defaults = DEFAULTS();
  assert.equal(defaults.global_extract.enabled, false);
  assert.equal(defaults.global_extract.interval_minutes, 60);
  assert.equal(defaults.global_extract.concurrency, 1);
  const view = publicView(defaults);
  assert.equal(view.global_extract.enabled, false);
  assert.equal(view.global_extract.concurrency, 1);
  const capped = publicView({
    ...defaults,
    global_extract: { enabled: true, interval_minutes: 3, concurrency: 99, enabled_channels: [] },
  });
  assert.equal(capped.global_extract.interval_minutes, 5);
  assert.equal(capped.global_extract.concurrency, 20);
});

test('catalog wires GB PayPal, local methods, and curated PayPal countries', () => {
  const live = CHANNEL_CATALOG.filter((item) => item.connected);
  const liveIds = live.map((item) => item.id);
  assert.ok(liveIds.includes('paypal_uk'));
  assert.ok(liveIds.includes('paypal'));
  assert.ok(liveIds.includes('paypal_th'));
  assert.ok(liveIds.includes('paypal_hosted'));
  assert.ok(liveIds.includes('paypal_us'));
  assert.ok(liveIds.includes('ideal'));
  assert.ok(liveIds.includes('gcash'));
  const gcash = CHANNEL_CATALOG.find((item) => item.id === 'gcash');
  assert.match(String(gcash?.detail || ''), /PH sticky/);
  assert.equal(/update 走 JP/.test(String(gcash?.detail || '')), false);
  assert.equal(CHANNEL_CATALOG.every((item) => item.connected), true);
  assert.equal(CHANNEL_CATALOG.filter((item) => !item.connected).length, 0);
});

test('overview does not treat production extract_link as a monitor success', () => {
  const overview = buildOverview(userId);
  const gb = overview.channels.find((row) => row.id === 'paypal_uk');
  const upi = overview.channels.find((row) => row.id === 'upi');
  const paypalGeneric = overview.channels.find((row) => row.id === 'paypal');
  assert.equal(overview.engine.connected, true);
  assert.equal(overview.plan.schedulable, false);
  assert.equal(gb.connected, true);
  assert.ok(gb.status === 'idle' || gb.status === 'ok' || gb.status === 'no_proxy' || gb.status === 'no_trial');
  assert.notEqual(gb.source, 'production_readonly');
  assert.equal(upi.connected, true);
  assert.equal(upi.status_label, '待探测');
  assert.equal(paypalGeneric.connected, true);
  assert.ok(overview.counts.connected >= 20);
  assert.equal(overview.counts.unwired, 0);
  assert.equal(overview.pool.cliproxy_configured, true);
  assert.equal(overview.pool.cliproxy_sticky_minutes, 30);
  assert.equal(Array.isArray(overview.successes), true);
  assertNoSecrets(overview);
});

test('empty user still exposes the GB channel without inventing a probe', () => {
  const overview = buildOverview(emptyUserId);
  const gb = overview.channels.find((row) => row.id === 'paypal_uk');
  assert.equal(gb.connected, true);
  assert.equal(overview.engine.connected, true);
  assert.equal(overview.plan.enabled, false);
});

test('saving the plan makes it schedulable', () => {
  const plan = savePlan(userId, { enabled: true, interval_minutes: 90, concurrency: 1 });
  assert.equal(plan.enabled, true);
  assert.equal(plan.interval_minutes, 90);
  assert.equal(plan.schedulable, true);
  const overview = buildOverview(userId);
  assert.equal(overview.plan.enabled, true);
  assert.equal(overview.plan.schedulable, true);
});

test('success list only includes ok monitor runs and never leaks payment URLs', () => {
  engine.persistOutcome(userId, 'paypal_uk', null, engine._test.nowSql(), {
    status: 'ok',
    error_class: '',
    verified_exit: 'GB',
    result_host: 'www.paypal.com',
  });
  engine.persistOutcome(userId, 'upi', null, engine._test.nowSql(), {
    status: 'rate',
    error_class: 'rate_limited',
    verified_exit: '',
    result_host: '',
  });
  const overview = buildOverview(userId);
  assert.ok(overview.successes.some((row) => row.channel_id === 'paypal_uk' && row.method_label));
  assert.equal(overview.successes.some((row) => row.channel_id === 'upi'), false);
  assert.ok(overview.counts.successes >= 1);
  assertNoSecrets(overview);
});

test('API handlers never return tokens, proxy credentials or full payment URLs', () => {
  writeSettings(userId, { global_extract: { enabled: false, interval_minutes: 60, concurrency: 1 } });
  let overviewPayload;
  let planPayload;
  route.overviewHandler({ user }, { json: (value) => { overviewPayload = value; } });
  route.savePlanHandler(
    { user, body: { enabled: true, interval_minutes: 120, concurrency: 1 } },
    { json: (value) => { planPayload = value; } }
  );
  assert.equal(planPayload.plan.enabled, true);
  assert.equal(planPayload.plan.interval_minutes, 120);
  assert.match(planPayload.message, /不会写入 extract_link|计划已开启|计划已关闭/);
  assertNoSecrets({ overviewPayload, planPayload });
});

test.after(() => {
  engine.kick = originalKick;
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
