'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-channel-proxy-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '8'.repeat(64);

const db = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { writeSettings } = require('../src/utils/settings');
const {
  channelCountry,
  channelAutoGroup,
  cliproxyConfigured,
  requireChannelDynamicProxy,
  loadChannelProxies,
} = require('../src/utils/channelProxy');
const oauthJob = require('../src/utils/oauthJob');
const { prepareActivateJob } = require('../src/utils/paypalPay');
const accountRebindJob = require('../src/utils/accountRebindJob');
const { pickTrialProxies } = require('../src/utils/accountDetectPoller');
const { pickPlanCheckProxy } = require('../src/utils/accountJob');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

function writeCliproxy(uid = user.id) {
  writeSettings(uid, {
    dynamic_proxy: {
      active_pool: 'cliproxy',
      providers: {
        cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
      },
    },
  });
}

function insertPayGroup() {
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status, region)
     VALUES (?, '支付 GB', 'http', 'pay.example.test', 8002, 'pay-region-GB-session-1', '', '可用', 'GB')`
  ).run(user.id);
}

test('channel country and auto group follow GB/GC', () => {
  assert.equal(channelCountry('gb'), 'GB');
  assert.equal(channelCountry('gc'), 'PH');
  assert.equal(channelAutoGroup('gb'), '__auto__:GB');
  assert.equal(channelAutoGroup('gc'), '__auto__:PH');
});

test('GB rebind/detect use region-GB; GC uses region-PH; payment group is ignored', () => {
  writeCliproxy();
  insertPayGroup();
  const gb = requireChannelDynamicProxy(user.id, 'GB', 'rebind-gb');
  const gc = requireChannelDynamicProxy(user.id, 'PH', 'rebind-gc');
  assert.equal(gb.host, 'sg.cliproxy.io');
  assert.equal(gc.host, 'sg.cliproxy.io');
  assert.match(gb.username, /-region-GB-sid-[A-Za-z0-9_-]+-t-30$/);
  assert.match(gc.username, /-region-PH-sid-[A-Za-z0-9_-]+-t-30$/);
  assert.doesNotMatch(gb.username, /pay-region/);
  assert.notEqual(gb.username, gc.username);
  const retry = requireChannelDynamicProxy(user.id, 'GB', 'rebind-gb-retry');
  assert.match(retry.username, /-region-GB-sid-[A-Za-z0-9_-]+-t-30$/);
  assert.notEqual(retry.username, gb.username);

  const detect = pickTrialProxies(user.id);
  assert.equal(detect.reason, 'cliproxy');
  assert.equal(detect.group, '__auto__:GB');
  assert.ok(detect.proxies.length);
  assert.match(detect.proxies[0].username, /-region-GB-sid-[A-Za-z0-9_-]+-t-30$/);
  assert.notEqual(detect.proxies[0].host, 'pay.example.test');

  const plan = pickPlanCheckProxy(user.id, 'gc');
  assert.match(plan.username, /-region-PH-sid-[A-Za-z0-9_-]+-t-30$/);
});

test('missing CliProxy fails and does not read 支付组', () => {
  const bareId = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES ('proxy-bare','x','user',1,1)"
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status, region)
     VALUES (?, '支付', 'http', 'pay.example.test', 8080, 'pay-user', '', '可用', 'GB')`
  ).run(bareId);
  assert.equal(cliproxyConfigured(bareId), false);
  assert.throws(
    () => requireChannelDynamicProxy(bareId, 'GB', 'extract'),
    (error) => error?.code === 'DYNAMIC_PROXY_NOT_CONFIGURED' && /不会回退/.test(error.message),
  );
  const picked = pickTrialProxies(bareId);
  assert.equal(picked.reason, 'dynamic_missing');
  assert.equal(picked.proxies.length, 0);
});

test('extract and pay prepare jobs no longer require 支付 group', () => {
  writeCliproxy();
  const extract = oauthJob.prepareExtractJob(user.id, { concurrency: 3 });
  assert.equal(extract.proxy_group, '__auto__:GB');
  assert.equal(extract.concurrency, 3);
  const pay = prepareActivateJob(user.id, { concurrency: 2 });
  assert.equal(pay.proxy_group, '__auto__:GB');
  assert.equal(pay.concurrency, 2);
});

test('rebind start forces channel country and requires CliProxy', async () => {
  writeCliproxy();
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (
       user_id, email, plan_type, email_type, status, progress,
       access_token, password_enc, totp_secret_enc, channel, has_trial
     ) VALUES (?, 'rebind-proxy@example.test', 'Free', 'gmail', '正常', '已注册', ?, ?, ?, 'gb', 1)`
  ).run(user.id, encrypt('fixture-at'), encrypt('pw'), encrypt('MFRGGZDFMZTWQ2LK')).lastInsertRowid;
  const started = await accountRebindJob.start({ id: user.id }, {
    ids: [inserted],
    channel: 'gb',
    concurrency: 1,
    source: 'batch',
  });
  assert.equal(started.proxy_country, 'GB');
  assert.equal(started.dynamic_proxy, true);
  accountRebindJob.stop(user.id, 'gb');

  const gcId = db.prepare(
    `INSERT INTO gpt_accounts (
       user_id, email, plan_type, email_type, status, progress,
       access_token, password_enc, totp_secret_enc, channel, has_trial
     ) VALUES (?, 'rebind-proxy-gc@example.test', 'Free', 'gmail', '正常', '已注册', ?, ?, ?, 'gc', 1)`
  ).run(user.id, encrypt('fixture-at'), encrypt('pw'), encrypt('MFRGGZDFMZTWQ2LK')).lastInsertRowid;
  const gcStarted = await accountRebindJob.start({ id: user.id }, {
    ids: [gcId],
    channel: 'gc',
    concurrency: 1,
    source: 'batch',
  });
  assert.equal(gcStarted.proxy_country, 'PH');
  assert.equal(gcStarted.dynamic_proxy, true);
  accountRebindJob.stop(user.id, 'gc');
});

test('loadChannelProxies keeps sticky minutes suffix', () => {
  writeCliproxy();
  const list = loadChannelProxies(user.id, 'GB', 2, 'sid-test');
  assert.equal(list.length, 2);
  assert.match(list[0].username, /-t-30$/);
  assert.match(list[1].username, /-t-30$/);
  assert.notEqual(list[0].username, list[1].username);
});

test.after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(temp, { recursive: true, force: true });
});
