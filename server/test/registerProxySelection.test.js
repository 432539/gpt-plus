'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-proxy-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '7'.repeat(64);

const db = require('../src/db');
const { writeSettings } = require('../src/utils/settings');
const {
  keepRegistrationProxy,
  isPaymentProxyGroup,
  isForbiddenRegisterCountry,
} = require('../src/utils/paymentProxy');
const registerJob = require('../src/utils/registerJob');
const { registrationIdentity } = require('../src/automation/flows/register');
const { selectTargets, REGISTER_DETECT_GRACE_HOURS } = require('../src/utils/accountDetectPoller');

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

function insertProxy({ group_name, username = '', status = '可用', region = '', host = '127.0.0.1', port = 8000 }) {
  return db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status, region)
     VALUES (?, ?, 'socks5', ?, ?, ?, '', ?, ?)`
  ).run(userId, group_name, host, port, username, status, region).lastInsertRowid;
}

test('payment groups stay forbidden but GB auto and GB register exits are allowed', () => {
  assert.equal(isPaymentProxyGroup('支付 GB'), true);
  assert.equal(isPaymentProxyGroup('注册 JP'), false);
  assert.equal(isForbiddenRegisterCountry('GB'), true);
  assert.equal(keepRegistrationProxy({
    username: 'user-region-GB-sid-abc-t-30',
    status: '可用',
    group_name: '注册',
  }, '注册'), true);
  assert.equal(keepRegistrationProxy({
    username: 'user-region-JP-sid-abc-t-30',
    status: '可用',
    group_name: '注册',
  }, '注册'), true);
  assert.throws(
    () => registerJob.assertRegistrationProxySelection('支付 GB', 'GB'),
    (error) => error.code === 'REGISTER_PAYMENT_PROXY_FORBIDDEN',
  );
  assert.throws(
    () => registerJob.assertRegistrationProxySelection('', ''),
    (error) => error.code === 'REGISTER_PROXY_REQUIRED',
  );
  assert.doesNotThrow(
    () => registerJob.assertRegistrationProxySelection('__auto__:GB', 'GB', { dynamicProxy: true }),
  );
});

test('loadRegistrationProxies keeps GB exits in register groups and still rejects 支付', () => {
  insertProxy({
    group_name: '注册 JP+GB',
    username: 'user-region-JP-sid-jp1-t-30',
    host: '10.0.0.2',
    port: 1001,
  });
  insertProxy({
    group_name: '注册 JP+GB',
    username: 'user-region-GB-sid-gb1-t-30',
    host: '10.0.0.3',
    port: 1002,
  });
  insertProxy({
    group_name: '支付 GB',
    username: 'user-region-GB-sid-pay-t-30',
    host: '10.0.0.4',
    port: 1003,
  });
  const proxies = registerJob.loadRegistrationProxies(userId, '注册 JP+GB');
  assert.equal(proxies.length, 2);
  assert.deepEqual(proxies.map((item) => item.port).sort(), [1001, 1002]);
  assert.throws(
    () => registerJob.loadRegistrationProxies(userId, '支付 GB'),
    (error) => error.code === 'REGISTER_PAYMENT_PROXY_FORBIDDEN',
  );
});

test('registration identity stays Japanese for JP and English for GB/US', () => {
  const jp = registrationIdentity('JP');
  const us = registrationIdentity('US');
  const gb = registrationIdentity('GB');
  const fallback = registrationIdentity('');
  assert.match(jp.name, /[一-龯]/);
  assert.match(us.name, /^[A-Za-z]+ [A-Za-z]+$/);
  assert.match(gb.name, /^[A-Za-z]+ [A-Za-z]+$/);
  assert.match(fallback.name, /[一-龯]/);
});

test('empty proxy_group defaults to __auto__:GB even if a named 注册 group exists', () => {
  assert.equal(registerJob.resolveRegisterProxyGroup(''), '__auto__:GB');
  assert.equal(registerJob.resolveRegisterProxyGroup('   '), '__auto__:GB');
  assert.equal(registerJob.resolveRegisterProxyGroup('', [
    { group_name: '支付 GB', count: 4 },
    { group_name: '注册 JP', count: 6 },
  ]), '__auto__:GB');
  assert.equal(registerJob.resolveRegisterProxyGroup('', [
    { group_name: '支付 GB', count: 4 },
    { group_name: '邮箱', count: 2 },
  ]), '__auto__:GB');
  assert.equal(registerJob.normalizeStartOptions({}).proxy_group, '__auto__:GB');
  assert.equal(registerJob.normalizeStartOptions({}).register_mode, 'headless_click');
  assert.equal(registerJob.normalizeStartOptions({ proxy_group: '' }).proxy_group, '__auto__:GB');
  assert.equal(registerJob.normalizeStartOptions({ proxy_group: '__auto__:US' }).proxy_group, '__auto__:US');
  assert.equal(registerJob.normalizeStartOptions({}, {}, [
    { group_name: '注册 JP', count: 2 },
  ]).proxy_group, '__auto__:GB');
  assert.equal(registerJob.normalizeStartOptions({ register_mode: 'protocol' }).register_mode, 'protocol');
  assert.equal(registerJob.normalizeStartOptions({ quantity: 3000 }).count, 2000);
  assert.equal(registerJob.normalizeStartOptions({}).humanize, true);
});

test('dynamic auto proxy start log names the provider instead of 0 exits', () => {
  assert.equal(
    registerJob.describeRegisterProxySelection({
      proxyGroup: '__auto__:GB',
      dynamicProxy: true,
      dynamicSettings: { active_pool: 'iprocket' },
      proxies: [],
    }),
    '动态代理 GB（iprocket）',
  );
  assert.equal(
    registerJob.describeRegisterProxySelection({
      proxyGroup: '注册',
      dynamicProxy: false,
      proxies: [{ id: 1 }, { id: 2 }],
    }),
    '注册 2 条出口',
  );
});

test('start without explicit group does not fail as 没有选择代理', async () => {
  db.prepare(
    `INSERT INTO users (username, password_hash, role, status)
     VALUES ('proxy-default-user', 'x', 'user', 'active')`
  ).run();
  const otherId = db.prepare("SELECT id FROM users WHERE username='proxy-default-user'").get().id;
  writeSettings(otherId, { cloak: { license_key: 'cb_test_license' } });
  db.prepare(
    `INSERT INTO emails (user_id, address, status, is_mother, mother_id)
     VALUES (?, 'child-default-proxy@mail.com', '未使用', 0, 1)`
  ).run(otherId);
  await assert.rejects(
    () => registerJob.start({ id: otherId }, { quantity: 1, mail_provider: 'mailcom' }),
    (error) => {
      assert.notEqual(error.code, 'REGISTER_PROXY_REQUIRED');
      assert.doesNotMatch(String(error.message || ''), /没有选择代理/);
      assert.equal(error.code, 'DYNAMIC_PROXY_NOT_CONFIGURED');
      return true;
    },
  );
});

test('detect poller skips freshly registered accounts', () => {
  db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, access_token, created_at)
     VALUES (?, 'fresh@example.test', 'token-fresh', datetime('now','localtime'))`
  ).run(userId);
  db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, access_token, created_at)
     VALUES (?, 'old@example.test', 'token-old', datetime('now','localtime', '-13 hours'))`
  ).run(userId);
  const ids = selectTargets(userId, false);
  const emails = ids.map((id) => db.prepare('SELECT email FROM gpt_accounts WHERE id=?').get(id).email);
  assert.deepEqual(emails, ['old@example.test']);
  assert.equal(REGISTER_DETECT_GRACE_HOURS, 12);
});
