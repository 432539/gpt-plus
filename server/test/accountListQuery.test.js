const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-list-query-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '4'.repeat(64);

const db = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { writeSettings } = require('../src/utils/settings');
const { parseHasTrialFilter, buildListWhere } = require('../src/routes/accounts');

test('trial filter values stay independent from account status 未检测', () => {
  assert.equal(parseHasTrialFilter(''), null);
  assert.equal(parseHasTrialFilter('全部资格'), null);
  assert.equal(parseHasTrialFilter('1'), 1);
  assert.equal(parseHasTrialFilter('是'), 1);
  assert.equal(parseHasTrialFilter('0'), 0);
  assert.equal(parseHasTrialFilter('否'), 0);
  assert.equal(parseHasTrialFilter('unset'), 'unset');
  assert.equal(parseHasTrialFilter('未检测'), 'unset');
  assert.equal(parseHasTrialFilter('正常'), null);
  assert.equal(parseHasTrialFilter('已封禁'), null);

  const defaults = buildListWhere({}, 1);
  assert.equal(defaults.pageSize, 10);
  assert.equal(defaults.page, 1);

  const statusOnly = buildListWhere({ status: '未检测', page_size: 10 }, 1);
  assert.match(statusOnly.whereSql, /status = \?/);
  assert.match(statusOnly.whereSql, /COALESCE\(channel, 'gb'\) = \?/);
  assert.doesNotMatch(statusOnly.whereSql, /has_trial/);
  assert.equal(statusOnly.params[1], 'gb');
  assert.equal(statusOnly.params[2], '未检测');
  assert.equal(statusOnly.pageSize, 10);
  assert.equal(defaults.channel, 'gb');
  assert.equal(buildListWhere({ channel: 'gc' }, 1).channel, 'gc');

  const trialUnset = buildListWhere({ has_trial: 'unset' }, 1);
  assert.match(trialUnset.whereSql, /has_trial IS NULL/);
  assert.match(trialUnset.whereSql, /CAST\(has_trial AS TEXT\)/);
  assert.doesNotMatch(trialUnset.whereSql, /status = \?/);

  const both = buildListWhere({ status: '正常', has_trial: '1' }, 1);
  assert.match(both.whereSql, /status = \?/);
  assert.match(both.whereSql, /has_trial = 1/);
});

test('extract job requires a target id before starting cloak', async () => {
  const oauthJob = require('../src/utils/oauthJob');
  await assert.rejects(() => oauthJob.start({ id: 1 }, {}), /请指定要处理的账号/);
});

test('payment proxy region normalizes UK and trusts credential region over stale DB metadata', () => {
  const {
    normalizeProxyRegion,
    effectiveProxyRegion,
    isGbPaymentProxy,
  } = require('../src/utils/paymentProxy');
  assert.equal(normalizeProxyRegion('UK / England / London'), 'GB');
  assert.equal(normalizeProxyRegion('United Kingdom'), 'GB');
  assert.equal(effectiveProxyRegion({
    username: 'customer-region-UK-session-123',
    region: 'JP / Tokyo',
    group_name: '支付',
  }), 'GB');
  assert.equal(isGbPaymentProxy({
    username: 'customer-region-JP-session-123',
    region: 'GB / England',
    group_name: '支付',
    status: '可用',
  }), false);
});

test('extract job start uses CliProxy GB and does not require Cloak or 支付组', async () => {
  const oauthJob = require('../src/utils/oauthJob');
  const { EXTRACT_CONCURRENCY_CAP } = require('../src/utils/paymentLink');
  const { requireGbPaymentProxies } = require('../src/utils/paymentProxy');
  const { jobConcurrency } = require('../src/utils/accountLiveJob');
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

  db.prepare(
    `INSERT INTO proxies (user_id, group_name, name, proxy_type, host, port, username, password_enc)
     VALUES (?, '注册 JP+GB', '', 'http', '127.0.0.1', 8001, '', '')`
  ).run(user.id);
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, name, proxy_type, host, port, username, password_enc)
     VALUES (?, '支付 GB', '', 'http', '127.0.0.1', 8002, '', '')`
  ).run(user.id);

  assert.deepEqual(
    requireGbPaymentProxies(user.id, '支付 GB').map((proxy) => proxy.port),
    [8002],
  );
  const defaulted = oauthJob.prepareExtractJob(user.id, {});
  assert.equal(defaulted.concurrency, 1);
  assert.equal(defaulted.proxy_group, '__auto__:GB');
  const uncapped = oauthJob.prepareExtractJob(user.id, { concurrency: 99 });
  assert.equal(uncapped.proxy_group, '__auto__:GB');
  assert.equal(uncapped.concurrency, EXTRACT_CONCURRENCY_CAP);
  assert.equal(uncapped.maxConcurrency, EXTRACT_CONCURRENCY_CAP);
  const pipelineUncapped = oauthJob.prepareExtractJob(user.id, { concurrency: 99, pipeline: true });
  assert.equal(pipelineUncapped.concurrency, 99);
  assert.ok(pipelineUncapped.maxConcurrency > EXTRACT_CONCURRENCY_CAP);

  writeSettings(user.id, {
    cloak: { max_concurrency: 5 },
    dynamic_proxy: {
      active_pool: 'cliproxy',
      providers: {
        cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
      },
    },
  });
  const prepared = oauthJob.prepareExtractJob(user.id, { concurrency: 99 });
  assert.equal(prepared.concurrency, EXTRACT_CONCURRENCY_CAP);
  assert.equal(prepared.maxConcurrency, EXTRACT_CONCURRENCY_CAP);
  assert.equal(jobConcurrency({
    requested: 1,
    defaultConcurrency: EXTRACT_CONCURRENCY_CAP,
    maxConcurrency: EXTRACT_CONCURRENCY_CAP,
    count: 1,
  }), 1);
  assert.equal(jobConcurrency({
    requested: 5,
    defaultConcurrency: EXTRACT_CONCURRENCY_CAP,
    maxConcurrency: EXTRACT_CONCURRENCY_CAP,
    count: 12,
  }), 5);
  assert.equal(jobConcurrency({
    requested: undefined,
    defaultConcurrency: EXTRACT_CONCURRENCY_CAP,
    maxConcurrency: 3,
    count: 12,
  }), 3);

  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress, access_token)
     VALUES (?, 'extract-job@example.test', 'Free', 'gmail', '正常', '已注册', ?)`
  ).run(user.id, encrypt('fixture-access-token'));
  const paypalExtract = require('../src/utils/paypalExtract');
  const originalExtract = paypalExtract.extractPaymentLink;
  let selectedProxy = null;
  paypalExtract.extractPaymentLink = async ({ proxy }) => {
    selectedProxy = proxy;
    return {
      link: 'https://www.paypal.com/agreements/approve?ba_token=BA-1',
      flow: 'oaics',
    };
  };
  try {
    const started = await oauthJob.start({ id: user.id }, { ids: [inserted.lastInsertRowid], proxy_group: '支付 GB' });
    assert.equal(started.ok, true);
    assert.equal(started.kind, 'extract');
    assert.equal(started.concurrency, 1);
    assert.equal(selectedProxy.host, 'sg.cliproxy.io');
    assert.match(selectedProxy.username, /-region-GB-sid-[A-Za-z0-9_-]+-t-30$/);
    assert.notEqual(selectedProxy.port, 8002);
    oauthJob.stop(user.id);
  } finally {
    paypalExtract.extractPaymentLink = originalExtract;
  }
});

test('GET list SQL filters has_trial yes/no/unset without mixing status', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const insert = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, status, plan_type, email_type, has_trial)
     VALUES (?, ?, ?, 'Free', 'gmail', ?)`
  );
  insert.run(user.id, 'trial-yes@example.test', '未检测', 1);
  insert.run(user.id, 'trial-no@example.test', '正常', 0);
  insert.run(user.id, 'trial-unset@example.test', '未检测', null);
  insert.run(user.id, 'trial-blank@example.test', '正常', '');

  const yes = buildListWhere({ has_trial: '1' }, user.id);
  const yesRows = db.prepare(`SELECT email FROM gpt_accounts WHERE ${yes.whereSql}`).all(...yes.params);
  assert.deepEqual(yesRows.map((row) => row.email), ['trial-yes@example.test']);

  const no = buildListWhere({ has_trial: '否' }, user.id);
  const noRows = db.prepare(`SELECT email FROM gpt_accounts WHERE ${no.whereSql}`).all(...no.params);
  assert.deepEqual(noRows.map((row) => row.email), ['trial-no@example.test']);

  const unset = buildListWhere({ has_trial: '未检测' }, user.id);
  const unsetRows = db.prepare(`SELECT email FROM gpt_accounts WHERE ${unset.whereSql}`).all(...unset.params);
  assert.ok(unsetRows.some((row) => row.email === 'trial-unset@example.test'));
  assert.ok(unsetRows.some((row) => row.email === 'trial-blank@example.test'));
  assert.equal(unsetRows.some((row) => row.email === 'trial-yes@example.test'), false);

  const statusUnchecked = buildListWhere({ status: '未检测' }, user.id);
  const statusRows = db.prepare(`SELECT email, has_trial FROM gpt_accounts WHERE ${statusUnchecked.whereSql}`).all(...statusUnchecked.params);
  assert.ok(statusRows.some((row) => row.email === 'trial-yes@example.test' && row.has_trial === 1));
  assert.ok(statusRows.some((row) => row.email === 'trial-unset@example.test' && row.has_trial == null));
  assert.equal(statusRows.some((row) => row.email === 'trial-no@example.test'), false);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
