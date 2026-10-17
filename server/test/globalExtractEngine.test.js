'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-global-engine-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '5'.repeat(64);

const db = require('../src/db');
const { writeSettings } = require('../src/utils/settings');
const engine = require('../src/utils/globalExtractEngine');

const SECRET_LINK = 'https://www.paypal.com/approve?token=PAYMENT-LINK-SECRET&ba_token=BA-SECRET';

const userId = db.prepare(
  "INSERT INTO users (username,password_hash,role,level,status) VALUES ('eng-user','x','user',1,1)"
).run().lastInsertRowid;
const otherId = db.prepare(
  "INSERT INTO users (username,password_hash,role,level,status) VALUES ('eng-other','x','user',1,1)"
).run().lastInsertRowid;

function insertAccount(uid, email, extra = {}) {
  return db.prepare(
    `INSERT INTO gpt_accounts (
       user_id,email,plan_type,status,password_enc,access_token,refresh_token,
       has_trial,progress,extract_link,extracted_at,monitor_pool,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
  ).run(
    uid,
    email,
    'Free',
    '正常',
    extra.password_enc || '',
    extra.access_token || 'AT-PLACEHOLDER',
    extra.refresh_token || '',
    extra.has_trial === undefined ? 1 : extra.has_trial,
    extra.progress || '已注册',
    extra.extract_link || SECRET_LINK,
    extra.extracted_at || '',
    extra.monitor_pool || 0,
  ).lastInsertRowid;
}

function insertProxy(uid) {
  db.prepare(
    `INSERT INTO proxies (user_id,group_name,host,port,username,password_enc,status,region)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(uid, '支付', 'proxy-secret.example', 8080, 'user-region-GB-session-1', '', '可用', 'GB');
}

function writeCliproxy(uid) {
  writeSettings(uid, {
    dynamic_proxy: {
      providers: {
        cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
      },
    },
  });
}

insertAccount(userId, 'ready@example.test', { extract_link: SECRET_LINK, monitor_pool: 1 });
insertAccount(otherId, 'other@example.test', { extract_link: SECRET_LINK });
insertProxy(userId);
insertProxy(otherId);
writeCliproxy(userId);
writeCliproxy(otherId);
writeSettings(userId, { global_extract: { enabled: true, interval_minutes: 60, concurrency: 1 } });
writeSettings(otherId, { global_extract: { enabled: true, interval_minutes: 60, concurrency: 1 } });
engine.savePlan(userId, { enabled: true, interval_minutes: 60, concurrency: 1 });
engine.savePlan(otherId, { enabled: true, interval_minutes: 60, concurrency: 1 });

test('classifies checkout errors into monitor statuses', () => {
  assert.equal(engine.classifyError({ status: 429 }), 'rate_limited');
  assert.equal(engine.classifyError({ code: 'EXTRACT_CHECKOUT_UNUSUAL' }), 'unusual_activity');
  assert.equal(engine.classifyError({ code: 'CHECKOUT_PROMOTION' }), 'update_400');
  assert.equal(engine.classifyError({ code: 'ELIGIBILITY_PROXY_COUNTRY' }), 'geo_mismatch');
  assert.equal(engine.classifyError({ code: 'DYNAMIC_PROXY_NOT_CONFIGURED' }), 'geo_mismatch');
  assert.equal(engine.classifyError({ code: 'ACCOUNT_NOT_ELIGIBLE' }), 'not_eligible');
  assert.equal(engine.statusFromClass('rate_limited'), 'rate');
  assert.equal(engine.statusFromClass('unusual_activity'), 'risk');
  assert.equal(engine.statusFromClass('geo_mismatch'), 'no_proxy');
  assert.equal(engine.statusFromClass(''), 'ok');
  assert.equal(engine.hostnameOnly(SECRET_LINK), 'www.paypal.com');
});

test('clamps interval to 5–1440 and concurrency to 1–20', () => {
  assert.equal(engine.clampInterval(3), 5);
  assert.equal(engine.clampInterval(5), 5);
  assert.equal(engine.clampInterval(2000), 1440);
  assert.equal(engine.clampConcurrency(0), 1);
  assert.equal(engine.clampConcurrency(20), 20);
  assert.equal(engine.clampConcurrency(99), 20);
  const plan = engine.savePlan(userId, { interval_minutes: 3, concurrency: 50 });
  assert.equal(plan.interval_minutes, 5);
  assert.equal(plan.concurrency, 20);
  engine.savePlan(userId, { interval_minutes: 60, concurrency: 1 });
});

test('monitor ignores payment-group proxies and requires CliProxy credentials', async () => {
  const bareId = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES ('eng-bare','x','user',1,1)"
  ).run().lastInsertRowid;
  insertAccount(bareId, 'bare@example.test', { extract_link: SECRET_LINK, monitor_pool: 1 });
  insertProxy(bareId);
  writeSettings(bareId, { global_extract: { enabled: true, interval_minutes: 60, concurrency: 1 } });
  const outcome = await engine.runChannel(bareId, 'paypal_uk', {
    extractPaymentLink: async () => ({ link: SECRET_LINK }),
  });
  assert.equal(outcome.status, 'no_proxy');
  assert.equal(engine.cliproxyConfigured(bareId), false);
  const dummy = engine.loadMonitorProxies(bareId);
  assert.equal(dummy.some((item) => item.host === 'proxy-secret.example'), false);
});

test('CliProxy username is rewritten per channel country with unique SIDs', async () => {
  db.prepare("UPDATE gpt_accounts SET monitor_cool_until = '' WHERE user_id = ?").run(userId);
  const names = [];
  const outcome = await engine.runChannel(userId, 'paypal_th', {
    extractPaymentLink: async (opts) => {
      names.push(opts.proxy.username);
      assert.equal(opts.proxy.host, 'sg.cliproxy.io');
      assert.match(opts.proxy.username, /-region-TH-sid-[A-Za-z0-9]+-t-30$/);
      const retry = opts.nextProxy();
      names.push(retry.username);
      assert.match(retry.username, /-region-TH-sid-[A-Za-z0-9]+-t-30$/);
      assert.notEqual(retry.username, opts.proxy.username);
      return { link: SECRET_LINK };
    },
  });
  assert.equal(outcome.status, 'ok');
  assert.equal(names.length, 2);
  const blob = JSON.stringify(engine.loadRecentRuns(userId, 'paypal_th'));
  assert.equal(blob.includes('clip-secret'), false);
  assert.equal(blob.includes('sg.cliproxy.io'), false);
});

test('monitor account prefers monitor_pool and skips extracting rows', () => {
  db.prepare("UPDATE gpt_accounts SET monitor_cool_until = '' WHERE user_id = ?").run(userId);
  const busyId = insertAccount(userId, 'busy@example.test', { progress: '提链中', monitor_pool: 1 });
  const picked = engine.selectMonitorAccount(userId);
  assert.ok(picked);
  assert.notEqual(picked.id, busyId);
  assert.equal(picked.email, 'ready@example.test');
});

test('successful probe stores host only and never writes extract_link', async () => {
  db.prepare("UPDATE gpt_accounts SET monitor_cool_until = '' WHERE user_id = ?").run(userId);
  const before = db.prepare('SELECT extract_link FROM gpt_accounts WHERE email = ?').get('ready@example.test');
  const outcome = await engine.runChannel(userId, 'paypal_uk', {
    extractPaymentLink: async () => ({ link: SECRET_LINK }),
  });
  assert.equal(outcome.status, 'ok');
  const after = db.prepare('SELECT extract_link FROM gpt_accounts WHERE email = ?').get('ready@example.test');
  assert.equal(after.extract_link, before.extract_link);
  const result = engine.loadResult(userId, 'paypal_uk');
  assert.equal(result.last_status, 'ok');
  assert.equal(result.result_host, 'www.paypal.com');
  const blob = JSON.stringify(engine.loadRecentRuns(userId, 'paypal_uk'));
  assert.equal(blob.includes('PAYMENT-LINK-SECRET'), false);
  assert.equal(blob.includes(SECRET_LINK), false);
});

test('429 cools the channel and does not start a second overlapping probe', async () => {
  db.prepare('DELETE FROM global_extract_results WHERE user_id = ?').run(otherId);
  db.prepare("UPDATE global_extract_plans SET last_run_at = '' WHERE user_id = ?").run(otherId);
  let concurrent = 0;
  let max = 0;
  const hang = [];
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let paypalCalls = 0;
  const extractPaymentLink = async () => {
    paypalCalls += 1;
    if (paypalCalls > 1) return { link: SECRET_LINK };
    concurrent += 1;
    max = Math.max(max, concurrent);
    started();
    await new Promise((resolve) => hang.push(resolve));
    concurrent -= 1;
    throw Object.assign(new Error('rate limited'), { status: 429 });
  };
  const extractLocalProvider = async () => ({ link: 'https://hooks.stripe.com/monitor' });
  const first = engine.runUserProbe(otherId, { extractPaymentLink, extractLocalProvider, force: true });
  await startedPromise;
  const second = await engine.runUserProbe(otherId, { extractPaymentLink, extractLocalProvider, force: true });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'concurrency');
  hang.forEach((resolve) => resolve());
  const done = await first;
  assert.equal(done.outcome.status, 'rate');
  assert.equal(max, 1);
  const result = engine.loadResult(otherId, 'paypal_uk');
  assert.equal(result.last_error_class, 'rate_limited');
  assert.ok(String(result.cooldown_until || '').trim());
});

test('local channel probe stores host only and never writes extract_link', async () => {
  db.prepare("UPDATE gpt_accounts SET monitor_cool_until = '' WHERE user_id = ?").run(userId);
  const before = db.prepare('SELECT extract_link FROM gpt_accounts WHERE email = ?').get('ready@example.test');
  const outcome = await engine.runChannel(userId, 'upi', {
    extractLocalProvider: async (opts) => {
      assert.equal(opts.channelId, 'upi');
      assert.equal(opts.maxCheckoutAttempts, 2);
      return { link: 'https://js.stripe.com/v3/hosted-instructions/upi' };
    },
  });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.verified_exit, 'IN');
  const after = db.prepare('SELECT extract_link FROM gpt_accounts WHERE email = ?').get('ready@example.test');
  assert.equal(after.extract_link, before.extract_link);
  const result = engine.loadResult(userId, 'upi');
  assert.equal(result.result_host, 'js.stripe.com');
  const blob = JSON.stringify(engine.loadRecentRuns(userId, 'upi'));
  assert.equal(blob.includes('hosted-instructions'), false);
});

test('iDEAL channel is dispatched to the local extractor not PayPal', async () => {
  db.prepare("UPDATE gpt_accounts SET monitor_cool_until = '' WHERE user_id = ?").run(userId);
  let seen = '';
  const outcome = await engine.runChannel(userId, 'ideal', {
    extractPaymentLink: async () => {
      throw new Error('paypal extract must not run for iDEAL');
    },
    extractLocalProvider: async (opts) => {
      seen = opts.channelId;
      return { link: 'https://ideal.ing.nl/pay' };
    },
  });
  assert.equal(seen, 'ideal');
  assert.equal(outcome.verified_exit, 'NL');
  assert.equal(engine.loadResult(userId, 'ideal').result_host, 'ideal.ing.nl');
});

test('saving enable_all schedules every wired channel and does not write extract_link', async () => {
  db.prepare("UPDATE gpt_accounts SET monitor_cool_until = '' WHERE user_id = ?").run(userId);
  const before = db.prepare('SELECT extract_link FROM gpt_accounts WHERE email = ?').get('ready@example.test');
  const plan = engine.savePlan(userId, { enable_all: true, interval_minutes: 60, concurrency: 1 });
  assert.ok(plan.enabled_channels.includes('paypal_th'));
  assert.ok(plan.enabled_channels.includes('paypal_hosted'));
  assert.ok(plan.enabled_channels.includes('upi'));
  const seen = [];
  const outcome = await engine.runUserProbe(userId, {
    force: true,
    extractPaymentLink: async (opts) => {
      seen.push(opts.paypalProfile?.id || 'paypal');
      return { link: SECRET_LINK };
    },
    extractLocalProvider: async (opts) => {
      seen.push(opts.channelId);
      return { link: 'https://hooks.stripe.com/monitor' };
    },
  });
  assert.equal(outcome.skipped, false);
  assert.ok(outcome.channelIds.includes('paypal_uk'));
  assert.ok(outcome.channelIds.includes('paypal_th'));
  assert.ok(outcome.channelIds.includes('ideal'));
  assert.ok(seen.includes('paypal_th'));
  assert.ok(seen.includes('ideal'));
  const after = db.prepare('SELECT extract_link FROM gpt_accounts WHERE email = ?').get('ready@example.test');
  assert.equal(after.extract_link, before.extract_link);
  const successes = engine.loadSuccesses(userId);
  assert.ok(successes.some((row) => row.channel_id === 'paypal_th' && row.result_host === 'www.paypal.com'));
  assert.equal(JSON.stringify(successes).includes('PAYMENT-LINK-SECRET'), false);
});

test('concurrency 3 starts three probes with distinct CliProxy SIDs', async () => {
  const parallelId = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES ('eng-par','x','user',1,1)"
  ).run().lastInsertRowid;
  insertAccount(parallelId, 'p1@example.test', { extract_link: SECRET_LINK, monitor_pool: 1 });
  insertAccount(parallelId, 'p2@example.test', { extract_link: SECRET_LINK, monitor_pool: 1 });
  insertAccount(parallelId, 'p3@example.test', { extract_link: SECRET_LINK, monitor_pool: 1 });
  writeCliproxy(parallelId);
  writeSettings(parallelId, {
    global_extract: {
      enabled: true,
      interval_minutes: 60,
      concurrency: 3,
      enabled_channels: ['paypal_uk', 'paypal_th', 'upi'],
    },
  });
  engine.savePlan(parallelId, {
    enabled: true,
    interval_minutes: 60,
    concurrency: 3,
    enabled_channels: ['paypal_uk', 'paypal_th', 'upi'],
  });
  let concurrent = 0;
  let max = 0;
  let startedCount = 0;
  let releaseStarted;
  const allStarted = new Promise((resolve) => { releaseStarted = resolve; });
  const hang = [];
  const names = [];
  const hangExtract = async (opts) => {
    if (opts.proxy?.username) names.push(opts.proxy.username);
    concurrent += 1;
    max = Math.max(max, concurrent);
    startedCount += 1;
    if (startedCount === 3) releaseStarted();
    await new Promise((resolve) => hang.push(resolve));
    concurrent -= 1;
    return { link: SECRET_LINK };
  };
  const running = engine.runUserProbe(parallelId, {
    force: true,
    extractPaymentLink: hangExtract,
    extractLocalProvider: hangExtract,
  });
  await allStarted;
  assert.equal(max, 3);
  assert.equal(new Set(names).size, 3);
  hang.forEach((resolve) => resolve());
  const done = await running;
  assert.equal(done.skipped, false);
  assert.equal(done.channelIds.length, 3);
});

test('plan becomes schedulable when enabled', () => {
  const plan = engine.savePlan(userId, { enabled: true, interval_minutes: 90, concurrency: 2 });
  assert.equal(plan.enabled, true);
  assert.equal(plan.schedulable, true);
  assert.equal(plan.interval_minutes, 90);
  assert.equal(plan.concurrency, 2);
  const snapped = engine.engineSnapshot(userId);
  assert.equal(snapped.connected, true);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
