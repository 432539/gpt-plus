const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-pipeline-settings-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '7'.repeat(64);

const db = require('../src/db');
const prevNvtokensKey = process.env.NVTOKENS_API_KEY;
const prevNvtokensSession = process.env.NVTOKENS_SESSION;
delete process.env.NVTOKENS_API_KEY;
delete process.env.NVTOKENS_SESSION;
const { readSettings, writeSettings, publicView, DEFAULTS } = require('../src/utils/settings');
const {
  pipelineCaps, remainingDailyRegisters, countTodayRegisters, extractIntervalMs,
} = require('../src/utils/pipelineCaps');
const registerJob = require('../src/utils/registerJob');
const { startRegister } = require('../src/utils/accountPipeline');
const { TRIAL_UNSET_POLL_MS } = require('../src/utils/accountDetectPoller');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

test('trial unset poll stays 2 minutes', () => {
  assert.equal(TRIAL_UNSET_POLL_MS, 2 * 60 * 1000);
});

test('settings defaults and publicView hide nvtokens secrets', () => {
  const defaults = DEFAULTS();
  assert.equal(defaults.pipeline.daily_register_limit, 0);
  assert.equal(defaults.pipeline.register_concurrency, 5);
  assert.equal(defaults.pipeline.extract_attempts, 5);
  assert.equal(defaults.pipeline.extract_interval_minutes, 10);
  assert.equal(defaults.pipeline.pay_attempts, 5);
  assert.equal(defaults.pipeline.rt_attempts, 5);
  assert.equal(defaults.nvtokens.auto_list_plus, false);
  assert.equal(defaults.nvtokens.min_price_yuan, '20.00');
  const view = publicView(defaults);
  assert.equal('api_key' in view.nvtokens, false);
  assert.equal('session_cookie' in view.nvtokens, false);
  assert.equal(view.nvtokens.has_session, false);
  assert.equal(view.nvtokens.session_last4, '');
  assert.equal(view.nvtokens.min_price_yuan, '20.00');
  assert.equal(view.pipeline.extract_interval_minutes, 10);
  assert.equal(view.pipeline.register_concurrency, 5);
  assert.equal(defaults.pipeline.rebind, false);
  assert.equal(defaults.pipeline_gc.register, false);
  assert.equal(defaults.pipeline_gc.rebind, false);
  assert.equal(defaults.pipeline_gc.pay, false);
  assert.equal(view.pipeline.rebind, false);
  assert.equal(view.pipeline_gc.register, false);
  assert.equal(view.pipeline_gc.extract, false);
  assert.equal(view.pipeline_gc.rebind, false);
});

test('publicView keeps mail mix share 0 instead of falling back to 5', () => {
  const view = publicView({
    ...DEFAULTS(),
    registration: { mail_provider: 'cfworker', mailcom_share: 0, cfworker_share: 5 },
  });
  assert.equal(view.registration.mail_provider, 'cfworker');
  assert.equal(view.registration.mailcom_share, 0);
  assert.equal(view.registration.cfworker_share, 5);
});

test('settings read/write pipeline caps and encrypted nvtokens fields', () => {
  writeSettings(user.id, {
    pipeline: {
      daily_register_limit: 12,
      register_concurrency: 8,
      extract_attempts: 3,
      extract_interval_minutes: 8,
      pay_attempts: 4,
      rt_attempts: 6,
    },
    nvtokens: {
      auto_list_plus: true,
      min_price_yuan: '22.5',
      api_key: 'irk-unit-test-key',
      session_cookie: 'dummy-session-value',
    },
  });
  const saved = readSettings(user.id);
  assert.equal(saved.pipeline.daily_register_limit, 12);
  assert.equal(saved.pipeline.register_concurrency, 8);
  assert.equal(saved.pipeline.extract_attempts, 3);
  assert.equal(saved.pipeline.extract_interval_minutes, 8);
  assert.equal(saved.pipeline.pay_attempts, 4);
  assert.equal(saved.pipeline.rt_attempts, 6);
  assert.equal(saved.nvtokens.auto_list_plus, true);
  assert.equal(saved.nvtokens.min_price_yuan, '22.5');
  assert.equal(saved.nvtokens.api_key, 'irk-unit-test-key');
  const view = publicView(saved);
  assert.equal(view.nvtokens.api_key_configured, true);
  assert.equal(view.nvtokens.session_configured, true);
  assert.equal(view.nvtokens.has_session, true);
  assert.equal(view.nvtokens.session_last4, 'alue');
  assert.equal(view.nvtokens.min_price_yuan, '22.50');
  assert.equal(view.pipeline.register_concurrency, 8);
  assert.equal('api_key' in view.nvtokens, false);
  assert.equal('session_cookie' in view.nvtokens, false);
  assert.equal(JSON.stringify(view).includes('irk-unit-test-key'), false);
  assert.equal(JSON.stringify(view).includes('dummy-session-value'), false);
  const caps = pipelineCaps(saved);
  assert.equal(caps.extract_attempts, 3);
  assert.equal(caps.register_concurrency, 8);
  assert.equal(extractIntervalMs(caps), 8 * 60 * 1000);
});

test('register daily cap counts successful inserts today', () => {
  writeSettings(user.id, { pipeline: { daily_register_limit: 1 } });
  db.prepare('DELETE FROM gpt_accounts WHERE user_id = ?').run(user.id);
  assert.equal(countTodayRegisters(user.id), 0);
  assert.equal(remainingDailyRegisters(user.id, readSettings(user.id)), 1);
  const first = registerJob._test.persistRegisteredAccount(user.id, 'cap-one@example.test', {
    password: 'pw', email: 'cap-one@example.test',
  }, { enableTotp2fa: false });
  assert.equal(first.saved, true);
  assert.equal(countTodayRegisters(user.id), 1);
  assert.equal(remainingDailyRegisters(user.id, readSettings(user.id)), 0);
  const second = registerJob._test.persistRegisteredAccount(user.id, 'cap-two@example.test', {
    password: 'pw', email: 'cap-two@example.test',
  }, { enableTotp2fa: false });
  assert.equal(second.saved, false);
  assert.equal(second.reason, 'daily_cap');
  assert.equal(countTodayRegisters(user.id), 1);
});

test('pipeline startRegister skips when daily cap is reached', async () => {
  writeSettings(user.id, { pipeline: { daily_register_limit: 1 } });
  db.prepare('DELETE FROM gpt_accounts WHERE user_id = ?').run(user.id);
  registerJob._test.persistRegisteredAccount(user.id, 'cap-start@example.test', {
    password: 'pw', email: 'cap-start@example.test',
  }, { enableTotp2fa: false });
  const started = [];
  const result = await startRegister(user.id, readSettings(user.id), {
    register: {
      isLive: () => false,
      start: async () => { started.push('register'); },
    },
    pay: { isLive: () => false },
    rt: { isLive: () => false },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'daily_cap');
  assert.deepEqual(started, []);
});

test('daily_register_limit 0 is unlimited', () => {
  writeSettings(user.id, { pipeline: { daily_register_limit: 0 } });
  assert.equal(remainingDailyRegisters(user.id, readSettings(user.id)), Infinity);
});

test('pipeline register switch ignores daily_register_limit', async () => {
  writeSettings(user.id, {
    pipeline: { register: true, daily_register_limit: 1, register_concurrency: 3 },
  });
  db.prepare('DELETE FROM gpt_accounts WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM emails WHERE user_id = ?').run(user.id);
  registerJob._test.persistRegisteredAccount(user.id, 'cap-ignore@example.test', {
    password: 'pw', email: 'cap-ignore@example.test',
  }, { enableTotp2fa: false });
  const motherId = db.prepare(
    `INSERT INTO emails (user_id, address, status, is_mother) VALUES (?, 'mother-ignore@mail.com', '未使用', 1)`
  ).run(user.id).lastInsertRowid;
  db.prepare(
    `INSERT INTO emails (user_id, address, status, is_mother, mother_id)
     VALUES (?, 'child-ignore@mail.com', '未使用', 0, ?)`
  ).run(user.id, motherId);
  assert.equal(remainingDailyRegisters(user.id, readSettings(user.id)), Infinity);
  const started = [];
  const result = await startRegister(user.id, readSettings(user.id), {
    register: {
      isLive: () => false,
      start: async (_u, body) => { started.push(body); },
    },
    pay: { isLive: () => false },
    rt: { isLive: () => false },
  });
  assert.equal(result.skipped, false);
  assert.equal(started.length, 1);
  assert.equal(started[0].pipeline, true);
  assert.equal(started[0].quantity, 1);
});

test('pipeline startRegister uses register_concurrency from settings', async () => {
  writeSettings(user.id, { pipeline: { daily_register_limit: 0, register_concurrency: 8 } });
  db.prepare('DELETE FROM gpt_accounts WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM emails WHERE user_id = ?').run(user.id);
  const motherId = db.prepare(
    `INSERT INTO emails (user_id, address, status, is_mother) VALUES (?, 'mother@mail.com', '未使用', 1)`
  ).run(user.id).lastInsertRowid;
  for (let i = 0; i < 10; i += 1) {
    db.prepare(
      `INSERT INTO emails (user_id, address, status, is_mother, mother_id)
       VALUES (?, ?, '未使用', 0, ?)`
    ).run(user.id, `child${i}@mail.com`, motherId);
  }
  const started = [];
  const result = await startRegister(user.id, readSettings(user.id), {
    register: {
      isLive: () => false,
      start: async (_u, body) => { started.push(body); },
    },
    pay: { isLive: () => false },
    rt: { isLive: () => false },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.concurrency, 8);
  assert.equal(started.length, 1);
  assert.equal(started[0].concurrency, 8);
  assert.equal(started[0].quantity, 10);
  assert.equal(started[0].performance_profile, 'safe');
  assert.equal(started[0].mailcom_share, 5);
  assert.equal(started[0].cfworker_share, 5);
});

test('publicView attaches per-suffix trial and extract rates for the user', () => {
  db.prepare("DELETE FROM gpt_accounts WHERE user_id = ?").run(user.id);
  db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, status, has_trial, progress, extracted_at)
     VALUES (?, 'a@dr.com', 'Free', '正常', 1, '已提链', '2026-08-21 00:00:00'),
            (?, 'b@dr.com', 'Free', '正常', 0, '已注册', '')`
  ).run(user.id, user.id);
  const view = publicView(readSettings(user.id), user.id);
  const dr = view.mailcom.suffixes.find((item) => item.suffix === 'dr.com');
  assert.ok(dr);
  assert.equal(dr.account_count, 2);
  assert.equal(dr.trial_detected, 2);
  assert.equal(dr.trial_yes, 1);
  assert.equal(dr.trial_rate, 0.5);
  assert.equal(dr.extract_ok, 1);
  assert.equal(dr.extract_rate, 0.5);
  assert.equal('session_cookie' in view.nvtokens, false);
});

test.after(() => {
  if (prevNvtokensKey !== undefined) process.env.NVTOKENS_API_KEY = prevNvtokensKey;
  else delete process.env.NVTOKENS_API_KEY;
  if (prevNvtokensSession !== undefined) process.env.NVTOKENS_SESSION = prevNvtokensSession;
  else delete process.env.NVTOKENS_SESSION;
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
