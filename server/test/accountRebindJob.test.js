'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-rebind-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '6'.repeat(64);

const db = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { writeSettings } = require('../src/utils/settings');
const { jobSlotKey } = require('../src/utils/accountChannel');
const { PROGRESS } = require('../src/utils/accountProgress');
const { selectExtractIds } = require('../src/utils/accountPipeline');
const {
  selectRebindIds,
  rebindBlocksExtract,
  persistEmailAfterVerify,
  persistRebindAccessToken,
  emailAlreadyRebound,
  classifyRebindSelection,
  clampRebindConcurrency,
  DEFAULT_REBIND_CONCURRENCY,
  MAX_REBIND_WORKERS,
  start,
  stop,
  resolveRebindSource,
  rebindLoginGap,
  summarizeLoginSkipMessage,
  _test,
} = require('../src/utils/accountRebindJob');
const accountJob = require('../src/utils/accountJob');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

function insertAccount(email, extra = {}) {
  return db.prepare(
    `INSERT INTO gpt_accounts (
       user_id, email, plan_type, email_type, status, progress,
       access_token, password_enc, totp_secret_enc, channel, has_trial, rebind_status
     ) VALUES (?, ?, 'Free', 'gmail', '正常', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    email,
    extra.progress || PROGRESS.REGISTERED,
    extra.access_token === '' ? '' : encrypt(extra.access_token || 'fixture-at'),
    extra.password_enc === '' ? '' : encrypt(extra.password || 'pw'),
    extra.totp_secret_enc === '' ? '' : encrypt(extra.totp || 'MFRGGZDFMZTWQ2LK'),
    extra.channel || 'gb',
    extra.has_trial === undefined ? 1 : extra.has_trial,
    extra.rebind_status || '',
  ).lastInsertRowid;
}

function fakeJwt(accountId = 'acct_rebind', email = 'new@example.test') {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    'https://api.openai.com/profile': { email },
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

test('job slots keep GB/GC rebind isolated', () => {
  assert.equal(jobSlotKey(9, 'gb'), 9);
  assert.equal(jobSlotKey(9, 'gc'), '9:gc');
});

test('no trial does not enter rebind', () => {
  const ids = selectRebindIds([
    {
      id: 1, has_trial: 0, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y',
    },
    {
      id: 2, has_trial: null, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y',
    },
    {
      id: 3, has_trial: 1, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y',
    },
  ]);
  assert.deepEqual(ids, [3]);
});

test('classifyRebindSelection counts no-trial skips and keeps eligible', () => {
  const classified = classifyRebindSelection([
    { row: { id: 1, has_trial: 0, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y' } },
    { row: { id: 2, has_trial: 1, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y' } },
    { row: { id: 3, has_trial: 1, rebind_status: 'ok', access_token: 'at', password_enc: 'x', totp_secret_enc: 'y' } },
  ], Date.now(), { source: 'pipeline' });
  assert.equal(classified.source, 'pipeline');
  assert.deepEqual(classified.skipped_no_trial, [1]);
  assert.deepEqual(classified.skipped_other, [3]);
  assert.deepEqual(classified.eligible.map((found) => found.row.id), [2]);
});

test('batch classify runs undetected and no-trial, skips only login gaps', () => {
  assert.equal(resolveRebindSource({ pipeline: true }), 'pipeline');
  assert.equal(resolveRebindSource({ source: 'batch' }), 'batch');
  const classified = classifyRebindSelection([
    { row: { id: 1, has_trial: 0, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y' } },
    { row: { id: 2, has_trial: null, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y' } },
    { row: { id: 3, has_trial: 1, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y' } },
    { row: { id: 4, has_trial: null, access_token: '', password_enc: '', totp_secret_enc: '' } },
    { row: { id: 5, has_trial: null, access_token: '', password_enc: 'x', totp_secret_enc: 'y' } },
    { row: { id: 6, has_trial: 1, access_token: '', password_enc: 'x', totp_secret_enc: '' } },
  ], Date.now(), { source: 'batch' });
  assert.equal(classified.source, 'batch');
  assert.deepEqual(classified.skipped_no_trial, []);
  assert.deepEqual(classified.skipped_other, [4, 6]);
  assert.deepEqual(classified.eligible.map((found) => found.row.id), [1, 2, 3, 5]);
  assert.match(classified.skip_reasons.find((item) => item.id === 4).reason, /缺少密码、TOTP/);
  assert.doesNotMatch(classified.skip_reasons.find((item) => item.id === 4).reason, /AT/);
  assert.match(classified.skip_reasons.find((item) => item.id === 6).reason, /缺少TOTP/);
  assert.doesNotMatch(classified.skip_reasons.find((item) => item.id === 6).reason, /AT|密码/);
});

test('rebindLoginGap requires password and TOTP, not AT', () => {
  assert.equal(rebindLoginGap({
    password_enc: 'x', totp_secret_enc: 'y', access_token: '',
  }, {}), '');
  assert.match(rebindLoginGap({
    password_enc: 'x', totp_secret_enc: '', access_token: '',
  }, {}), /缺少TOTP/);
  assert.match(rebindLoginGap({
    password_enc: '', totp_secret_enc: 'y', access_token: 'at',
  }, {}), /缺少密码/);
  assert.doesNotMatch(rebindLoginGap({
    password_enc: '', totp_secret_enc: '',
  }, {}), /AT/);
  assert.match(summarizeLoginSkipMessage([
    { id: 1, reason: '缺少TOTP，无法登录' },
    { id: 2, reason: '缺少TOTP，无法登录' },
  ]), /已跳过 2 个：缺少TOTP/);
});

test('pipeline still requires trial but not AT', () => {
  const ids = selectRebindIds([
    {
      id: 21, has_trial: 1, access_token: '', password_enc: 'x', totp_secret_enc: 'y',
    },
    {
      id: 22, has_trial: 0, access_token: '', password_enc: 'x', totp_secret_enc: 'y',
    },
    {
      id: 23, has_trial: 1, access_token: '', password_enc: 'x', totp_secret_enc: '',
    },
  ]);
  assert.deepEqual(ids, [21]);
});

test('clampRebindConcurrency defaults to 10 and caps at 20', () => {
  assert.equal(DEFAULT_REBIND_CONCURRENCY, 10);
  assert.equal(MAX_REBIND_WORKERS, 20);
  assert.equal(clampRebindConcurrency(), 10);
  assert.equal(clampRebindConcurrency(0), 10);
  assert.equal(clampRebindConcurrency(99), 20);
  assert.equal(clampRebindConcurrency(7, 3), 3);
});

test('pipeline start still skips no-trial, does not delete, and requires ids', async () => {
  const noTrial = insertAccount('pipeline-no-trial@example.test', { has_trial: 0 });
  const unset = insertAccount('pipeline-unset-trial@example.test', { has_trial: null });
  await assert.rejects(
    () => start({ id: user.id }, { ids: [], channel: 'gb' }),
    /请先选择至少一个账号/,
  );
  const result = await start({ id: user.id }, {
    ids: [noTrial, unset], channel: 'gb', concurrency: 10, pipeline: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'pipeline');
  assert.equal(result.accepted, 0);
  assert.equal(result.skipped_no_trial, 2);
  assert.equal(result.skipped, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM gpt_accounts WHERE id = ?').get(noTrial).c, 1);
  assert.equal(Boolean(_test.runtimes.get(jobSlotKey(user.id, 'gb'))?.running), false);
  const row = db.prepare('SELECT email, password_enc FROM gpt_accounts WHERE id = ?').get(noTrial);
  assert.equal(row.email, 'pipeline-no-trial@example.test');
  assert.ok(row.password_enc);
  assert.doesNotMatch(JSON.stringify(result), /password|pw|secret/i);
});

test('batch start accepts imported accounts with password+TOTP and no AT', async () => {
  writeSettings(user.id, {
    dynamic_proxy: {
      active_pool: 'cliproxy',
      providers: {
        cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
      },
    },
  });
  _test.hooks.loginForAccessToken = async () => {
    throw Object.assign(new Error('login stub'), { code: 'REBIND_LOGIN_STUB' });
  };
  try {
    const id = insertAccount('batch-no-at@example.test', { access_token: '', has_trial: null });
    const result = await start({ id: user.id }, {
      ids: [id], channel: 'gb', concurrency: 1, source: 'batch',
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'batch');
    assert.equal(result.accepted, 1);
    assert.equal(result.skipped, 0);
    stop(user.id, 'gb');
    const deadline = Date.now() + 5000;
    while (_test.runtimes.get(jobSlotKey(user.id, 'gb'))?.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.doesNotMatch(JSON.stringify(result), /password|pw|secret|MFRGGZDF/i);
  } finally {
    _test.hooks.loginForAccessToken = null;
  }
});

test('batch start skip message names missing TOTP, not AT', async () => {
  const first = insertAccount('batch-no-totp-a@example.test', { totp_secret_enc: '', access_token: '' });
  const second = insertAccount('batch-no-totp-b@example.test', { totp_secret_enc: '', access_token: '' });
  const result = await start({ id: user.id }, {
    ids: [first, second], channel: 'gb', concurrency: 1, source: 'batch',
  });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, 0);
  assert.equal(result.skipped, 2);
  assert.match(result.message, /已跳过 2 个：缺少TOTP/);
  assert.doesNotMatch(result.message, /AT/);
  assert.doesNotMatch(JSON.stringify(result), /password|pw|secret|MFRGGZDF/i);
});

test('runRebindOne without AT logs in then continues rebind', async () => {
  const id = insertAccount('run-no-at@example.test', { access_token: '', has_trial: null });
  const found = accountJob.accountRow(user.id, id);
  let loginCalls = 0;
  _test.hooks.loginForAccessToken = async () => {
    loginCalls += 1;
    return { access_token: fakeJwt('acct_login', 'run-no-at@example.test') };
  };
  _test.hooks.acquireRebindMailbox = async () => {
    throw Object.assign(new Error('mailbox stub'), { code: 'REBIND_MAIL_STUB' });
  };
  try {
    await assert.rejects(
      () => _test.runRebindOne(found, { userId: user.id, source: 'batch', log() {} }),
      /mailbox stub/,
    );
    assert.equal(loginCalls, 1);
    const row = db.prepare('SELECT access_token, rebind_status FROM gpt_accounts WHERE id = ?').get(id);
    assert.ok(row.access_token);
    assert.notEqual(row.rebind_status, 'ok');
  } finally {
    _test.hooks.loginForAccessToken = null;
    _test.hooks.acquireRebindMailbox = null;
  }
});

test('runRebindOne with AT tries protocol before login', async () => {
  const id = insertAccount('run-has-at@example.test');
  const found = accountJob.accountRow(user.id, id);
  let loginCalls = 0;
  _test.hooks.loginForAccessToken = async () => {
    loginCalls += 1;
    return { access_token: fakeJwt('acct_login', 'run-has-at@example.test') };
  };
  _test.hooks.acquireRebindMailbox = async () => {
    throw Object.assign(new Error('mailbox stub'), { code: 'REBIND_MAIL_STUB' });
  };
  try {
    await assert.rejects(
      () => _test.runRebindOne(found, { userId: user.id, source: 'batch', log() {} }),
      /mailbox stub/,
    );
    assert.equal(loginCalls, 0);
  } finally {
    _test.hooks.loginForAccessToken = null;
    _test.hooks.acquireRebindMailbox = null;
  }
});

test('runRebindOne skips only when TOTP is missing', async () => {
  const id = insertAccount('run-no-totp@example.test', { totp_secret_enc: '', access_token: '' });
  const found = accountJob.accountRow(user.id, id);
  await assert.rejects(
    () => _test.runRebindOne(found, { userId: user.id, source: 'batch', log() {} }),
    (error) => {
      assert.match(String(error.message), /缺少TOTP/);
      assert.doesNotMatch(String(error.message), /AT/);
      assert.equal(error.code, 'REBIND_MISSING_SECRETS');
      assert.equal(error.skip, true);
      return true;
    },
  );
});

test('batch start executes undetected accounts', async () => {
  writeSettings(user.id, {
    dynamic_proxy: {
      active_pool: 'cliproxy',
      providers: {
        cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
      },
    },
  });
  const unset = insertAccount('batch-unset-trial@example.test', { has_trial: null });
  const result = await start({ id: user.id }, {
    ids: [unset], channel: 'gb', concurrency: 1, source: 'batch',
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'batch');
  assert.equal(result.accepted, 1);
  assert.equal(result.skipped_no_trial, 0);
  stop(user.id, 'gb');
  const deadline = Date.now() + 5000;
  while (_test.runtimes.get(jobSlotKey(user.id, 'gb'))?.running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const row = db.prepare('SELECT email, has_trial FROM gpt_accounts WHERE id = ?').get(unset);
  assert.equal(row.email, 'batch-unset-trial@example.test');
  assert.equal(row.has_trial, null);
  assert.doesNotMatch(JSON.stringify(result), /password|pw|secret|fixture-at/i);
});

test('switch off does not block extract; switch on does until ok', () => {
  const row = {
    id: 11,
    has_trial: 1,
    access_token: 'at',
    progress: PROGRESS.REGISTERED,
    rebind_status: 'failed',
  };
  assert.equal(rebindBlocksExtract(row, false), false);
  assert.equal(rebindBlocksExtract(row, true), true);
  assert.equal(rebindBlocksExtract({ ...row, rebind_status: 'ok' }, true), false);
  assert.deepEqual(selectExtractIds([row], Date.now()), [11]);
  assert.deepEqual(selectExtractIds([row], Date.now(), { rebindRequired: true }), []);
});

test('verify success updates email in place and keeps original_email', () => {
  const id = insertAccount('old-rebind@example.test');
  persistEmailAfterVerify(user.id, id, {
    originalEmail: 'old-rebind@example.test',
    newEmail: 'new-rebind@mail.example.test',
  });
  persistRebindAccessToken(user.id, id, fakeJwt('acct_rebind', 'new-rebind@mail.example.test'));
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(row.email, 'new-rebind@mail.example.test');
  assert.equal(row.original_email, 'old-rebind@example.test');
  assert.equal(row.rebind_email, 'new-rebind@mail.example.test');
  assert.equal(row.rebind_status, 'ok');
  assert.equal(emailAlreadyRebound({
    ...row,
    rebind_status: 'pending',
    rebind_done_at: '',
  }, { email: row.email }), true);
  const second = db.prepare('SELECT COUNT(*) AS c FROM gpt_accounts WHERE user_id = ? AND email LIKE ?')
    .get(user.id, '%rebind@mail.example.test');
  assert.equal(second.c, 1);
});

test('accounts route exposes selected-id batch rebind', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/accounts.js'), 'utf8');
  assert.match(source, /router\.post\('\/operations\/rebind'/);
  assert.match(source, /router\.get\('\/operations\/rebind\/status'/);
  assert.match(source, /router\.post\('\/operations\/rebind\/stop'/);
  assert.match(source, /accountRebindJob/);
});

test('failed rebind blocks extract when the switch is on', () => {
  const id = insertAccount('block-extract@example.test', { rebind_status: 'cooling' });
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(id);
  assert.deepEqual(selectExtractIds([row], Date.now(), { rebindRequired: true }), []);
  assert.deepEqual(selectExtractIds([{ ...row, rebind_status: 'ok' }], Date.now(), { rebindRequired: true }), [id]);
});

test.after(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(temp, { recursive: true, force: true });
});
