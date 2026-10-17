const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-pipeline-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '4'.repeat(64);

const {
  EXTRACT_RETRY_MS,
  EXTRACT_INTERVAL_MS,
  REGISTER_CONCURRENCY,
  STEP_RETRY_CAP,
  normalizePipeline,
  isExtractRetryDue,
  registerWaveSize,
  selectExtractIds,
  selectPayIds,
  selectRtIds,
  tickUser,
  notePaidForRt,
  watchdogUser,
  paySkipReason,
} = require('../src/utils/accountPipeline');
const { PROGRESS } = require('../src/utils/accountProgress');
const {
  shouldSkipPay,
  shouldSkipExtract,
  markActivationRetryAfterFreeRt,
} = require('../src/utils/pipelineState');
const db = require('../src/db');

const PAY_LINK = 'https://www.paypal.com/agreements/approve?ba_token=BA-TEST';

function stampAgo(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

function mockJobs(started, initial = {}) {
  const running = { register: false, rebind: false, extract: false, pay: false, rt: false, ...initial };
  return {
    register: {
      status: () => ({ running: running.register }),
      isLive: () => running.register,
      stop: () => { running.register = false; },
      start: async (_user, body) => { running.register = true; started.push(['register', body]); },
    },
    rebind: {
      status: () => ({ running: running.rebind }),
      isLive: () => running.rebind,
      stop: () => { running.rebind = false; },
      start: async (_user, body) => { running.rebind = true; started.push(['rebind', body]); },
    },
    extract: {
      status: () => ({ running: running.extract }),
      isLive: () => running.extract,
      stop: () => { running.extract = false; },
      start: async (_user, body) => { running.extract = true; started.push(['extract', body]); },
    },
    pay: {
      status: () => ({ running: running.pay }),
      isLive: () => running.pay,
      stop: () => { running.pay = false; },
      start: async (_user, body) => { running.pay = true; started.push(['pay', body]); },
    },
    rt: {
      status: () => ({ running: running.rt }),
      isLive: () => running.rt,
      stop: () => { running.rt = false; },
      start: async (_user, body) => { running.rt = true; started.push(['rt', body]); },
    },
  };
}

test('pipeline defaults are all off', () => {
  assert.deepEqual(normalizePipeline(), {
    register: false, rebind: false, extract: false, pay: false, acquire_rt: false,
  });
  assert.equal(normalizePipeline({ register: true, extract: 1 }).register, true);
  assert.equal(normalizePipeline({ extract: 1 }).extract, false);
});

test('extract retry waits 10 minutes after last extract attempt', () => {
  assert.equal(EXTRACT_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(EXTRACT_RETRY_MS, EXTRACT_INTERVAL_MS);
  assert.equal(isExtractRetryDue({}), true);
  assert.equal(isExtractRetryDue({ extract_failed_at: stampAgo(60 * 1000) }), false);
  assert.equal(isExtractRetryDue({ extract_failed_at: stampAgo(6 * 60 * 1000) }), false);
  assert.equal(isExtractRetryDue({ extract_failed_at: stampAgo(11 * 60 * 1000) }), true);
  assert.equal(isExtractRetryDue({ extract_attempted_at: stampAgo(2 * 60 * 1000) }, Date.now(), 3 * 60 * 1000), false);
  assert.equal(isExtractRetryDue({ extract_attempted_at: stampAgo(4 * 60 * 1000) }, Date.now(), 3 * 60 * 1000), true);
});

test('extract selects trial accounts that are 已注册 or expired extract, after cooldown', () => {
  const nowMs = Date.now();
  const ids = selectExtractIds([
    { id: 1, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED },
    { id: 2, has_trial: 0, access_token: 'at', progress: PROGRESS.REGISTERED },
    { id: 3, has_trial: 1, access_token: '', progress: PROGRESS.REGISTERED },
    { id: 4, has_trial: 1, access_token: 'at', extract_link: PAY_LINK, extracted_at: stampAgo(0) },
    {
      id: 5, has_trial: 1, access_token: 'at', extract_link: PAY_LINK,
      extracted_at: stampAgo(91 * 60 * 1000),
    },
    {
      id: 6, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED,
      extract_failed_at: stampAgo(60 * 1000),
    },
    { id: 7, has_trial: 1, access_token: 'at', progress: PROGRESS.PAID, activated_at: stampAgo(0) },
  ], nowMs);
  assert.deepEqual(ids, [1, 5]);
});

test('extract gate: switch off skips rebind; switch on blocks until ok', () => {
  const nowMs = Date.now();
  const ready = { id: 1, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED };
  assert.deepEqual(selectExtractIds([ready], nowMs), [1]);
  assert.deepEqual(selectExtractIds([{ ...ready, rebind_status: 'failed' }], nowMs), [1]);
  assert.deepEqual(selectExtractIds([ready], nowMs, { rebindRequired: true }), []);
  assert.deepEqual(selectExtractIds([{ ...ready, rebind_status: 'pending' }], nowMs, { rebindRequired: true }), []);
  assert.deepEqual(selectExtractIds([{ ...ready, rebind_status: 'failed' }], nowMs, { rebindRequired: true }), []);
  assert.deepEqual(selectExtractIds([{ ...ready, rebind_status: 'ok' }], nowMs, { rebindRequired: true }), [1]);
  assert.deepEqual(selectExtractIds([{ ...ready, rebind_status: 'skipped' }], nowMs, { rebindRequired: true }), [1]);
});

test('pay selects valid extract links; RT selects paid accounts with password+totp and no RT', () => {
  const nowMs = Date.now();
  const pay = selectPayIds([
    { id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0) },
    { id: 2, extract_link: PAY_LINK, extracted_at: stampAgo(91 * 60 * 1000) },
    { id: 3, progress: PROGRESS.REGISTERED },
    { id: 5, progress: PROGRESS.EXTRACTED },
    { id: 6, progress: PROGRESS.PAYMENT_REVIEW, extract_link: PAY_LINK, extracted_at: stampAgo(0) },
  ], nowMs);
  assert.deepEqual(pay, [1]);

  const extracted = {
    id: 11, extract_link: PAY_LINK, extracted_at: stampAgo(0),
    password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
    progress: PROGRESS.EXTRACTED,
  };
  const rt = selectRtIds([
    {
      id: 8, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
    },
    {
      id: 9, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: 'rt',
    },
    { id: 10, progress: PROGRESS.PAID, activated_at: stampAgo(0), password_enc: 'x' },
    extracted,
  ], nowMs);
  assert.deepEqual(rt, [8]);
  assert.deepEqual(selectRtIds([extracted], nowMs, [11]), []);
});

test('tickUser starts nothing when all toggles are off', async () => {
  const started = [];
  await tickUser(1, {
    readSettings: () => ({ pipeline: {}, cloak: { max_concurrency: 3 } }),
    accountRows: () => [{ id: 1, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED }],
    jobs: mockJobs(started),
    startRegister: async () => { started.push('register'); },
    startExtract: async () => { started.push('extract'); },
    startPay: async () => { started.push('pay'); },
    startRt: async () => { started.push('rt'); },
  });
  assert.deepEqual(started, []);
});

test('tickUser skips rebind when switch is off and still extracts', async () => {
  const started = [];
  await tickUser(1, {
    readSettings: () => ({ pipeline: { extract: true }, cloak: { max_concurrency: 3 } }),
    accountRows: () => [{ id: 1, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED }],
    jobs: mockJobs(started),
    startRebind: async () => { started.push('rebind'); },
    startExtract: async () => { started.push('extract'); },
    startPay: async () => { started.push('pay'); },
    startRt: async () => { started.push('rt'); },
    startRegister: async () => { started.push('register'); },
  });
  assert.deepEqual(started, ['extract']);
});

test('tickUser starts rebind and does not extract while rebind is pending', async () => {
  const started = [];
  await tickUser(1, {
    readSettings: () => ({ pipeline: { rebind: true, extract: true }, cloak: { max_concurrency: 3 } }),
    accountRows: () => [{
      id: 2, has_trial: 1, access_token: 'at', password_enc: 'x', totp_secret_enc: 'y',
      progress: PROGRESS.REGISTERED, rebind_status: '',
    }],
    jobs: mockJobs(started),
    startRebind: async (_uid, ids) => { started.push(['rebind', ids]); },
    startExtract: async (_uid, ids) => { started.push(['extract', ids]); },
    startPay: async () => { started.push('pay'); },
    startRt: async () => { started.push('rt'); },
    startRegister: async () => { started.push('register'); },
  });
  assert.deepEqual(started, [['rebind', [2]]]);
});

test('leftover 已提链 still pays while register job is live', async () => {
  const started = [];
  await tickUser(41, {
    readSettings: () => ({ pipeline: { register: true, pay: true }, cloak: {} }),
    accountRows: () => [{ id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0) }],
    jobs: mockJobs(started, { register: true }),
    startRegister: async () => { started.push(['register']); },
  });
  const pay = started.find((item) => item[0] === 'pay');
  assert.ok(pay);
  assert.deepEqual(pay[1].ids, [1]);
  assert.equal(pay[1].pipeline, true);
});

test('expired extract is not paid and is logged as 已提链(已过期)', async () => {
  const started = [];
  const row = {
    id: 9,
    has_trial: 1,
    access_token: 'at',
    extract_link: PAY_LINK,
    extracted_at: stampAgo(91 * 60 * 1000),
    progress: PROGRESS.EXTRACTED,
  };
  assert.equal(paySkipReason(row), 'extract_expired');
  require('../src/utils/accountPipeline')._test.lastSkipLog.clear();
  await tickUser(1, {
    readSettings: () => ({ pipeline: { pay: true, extract: true }, cloak: {} }),
    accountRows: () => [row],
    jobs: mockJobs(started),
  });
  assert.equal(started.some((item) => item[0] === 'pay'), false);
  const extract = started.find((item) => item[0] === 'extract');
  assert.ok(extract);
  assert.deepEqual(extract[1].ids, [9]);
  const logs = db.prepare(
    "SELECT message FROM operation_logs WHERE user_id = 1 AND (message LIKE '%已过期%' OR message LIKE '%支付跳过%')"
  ).all();
  assert.ok(logs.some((row) => /已提链已过期|改走重新提链|extract_expired/.test(row.message)));
});

test('unpaid 已提链 with leftover RT still pays unless already activated', () => {
  const nowMs = Date.now();
  assert.deepEqual(selectPayIds([{
    id: 1,
    extract_link: PAY_LINK,
    extracted_at: stampAgo(0),
    refresh_token: 'rt',
    remark: '已拿RT',
    plan_type: 'Free',
    activated_at: '',
    progress: PROGRESS.EXTRACTED,
  }], nowMs), [1]);
});

test('tickUser extract-only starts extract for trial accounts', async () => {
  const started = [];
  await tickUser(7, {
    readSettings: () => ({ pipeline: { extract: true }, cloak: { max_concurrency: 3 } }),
    accountRows: () => [
      { id: 4, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED },
      { id: 5, has_trial: 0, access_token: 'at', progress: PROGRESS.REGISTERED },
    ],
    jobs: mockJobs(started),
    startRegister: async () => { started.push(['register']); },
    startExtract: async (_userId, ids) => { started.push(['extract', ids]); },
    startPay: async () => { started.push(['pay']); },
    startRt: async () => { started.push(['rt']); },
  });
  assert.deepEqual(started, [['extract', [4]]]);
});

test('register pipeline reads concurrency from settings', () => {
  assert.equal(REGISTER_CONCURRENCY, 5);
  assert.equal(STEP_RETRY_CAP, 5);
  assert.deepEqual(registerWaveSize(20), { count: 20, concurrency: 5 });
  assert.deepEqual(registerWaveSize(3), { count: 3, concurrency: 3 });
  assert.deepEqual(registerWaveSize(0), { count: 0, concurrency: 0 });
  assert.deepEqual(registerWaveSize(20, { pipeline: { register_concurrency: 8 } }), { count: 20, concurrency: 8 });
  assert.deepEqual(registerWaveSize(3, { pipeline: { register_concurrency: 8 } }), { count: 3, concurrency: 3 });
  assert.deepEqual(registerWaveSize(20, { pipeline: { register_concurrency: 1 } }), { count: 20, concurrency: 1 });
  assert.deepEqual(registerWaveSize(500, { pipeline: { register_concurrency: 999 } }), { count: 500, concurrency: 200 });
});

test('pipeline does not select RT / Plus+RT accounts for extract or pay', () => {
  const nowMs = Date.now();
  const plusRt = {
    id: 68,
    email: 'plus-rt@example.test',
    has_trial: 1,
    access_token: 'at',
    extract_link: PAY_LINK,
    extracted_at: stampAgo(0),
    refresh_token: 'rt',
    remark: '已拿RT',
    plan_type: 'Plus',
    activated_at: stampAgo(0),
    progress: PROGRESS.PAID,
  };
  assert.equal(shouldSkipPay(plusRt), true);
  assert.equal(shouldSkipExtract(plusRt), true);
  assert.deepEqual(selectPayIds([plusRt, {
    id: 2, extract_link: PAY_LINK, extracted_at: stampAgo(0),
  }], nowMs), [2]);
  assert.deepEqual(selectExtractIds([
    plusRt,
    { id: 3, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED },
  ], nowMs), [3]);
});

test('RT selects 已支付 even if a leftover extract link still looks 已提链', () => {
  const nowMs = Date.now();
  const rt = selectRtIds([
    {
      id: 8,
      progress: PROGRESS.PAID,
      activated_at: stampAgo(0),
      extract_link: PAY_LINK,
      extracted_at: stampAgo(0),
      password_enc: 'x',
      totp_secret_enc: 'y',
      refresh_token: '',
    },
  ], nowMs);
  assert.deepEqual(rt, [8]);
});

test('per-account extract/pay/rt retry cap is 5', () => {
  const nowMs = Date.now();
  assert.deepEqual(selectExtractIds([
    { id: 1, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED, extract_attempts: 5 },
    { id: 2, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED, extract_attempts: 4 },
  ], nowMs), [2]);
  assert.deepEqual(selectPayIds([
    { id: 3, extract_link: PAY_LINK, extracted_at: stampAgo(0), pay_attempts: 5 },
    { id: 4, extract_link: PAY_LINK, extracted_at: stampAgo(0), pay_attempts: 1 },
  ], nowMs), [4]);
  assert.deepEqual(selectRtIds([
    {
      id: 5, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '', rt_attempts: 5,
    },
    {
      id: 6, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '', rt_attempts: 2,
    },
  ], nowMs), [6]);
});

test('extract/pay/rt caps and extract interval come from settings', () => {
  const nowMs = Date.now();
  const caps = { extract_attempts: 3, pay_attempts: 2, rt_attempts: 4, extract_interval_minutes: 3 };
  assert.deepEqual(selectExtractIds([
    { id: 1, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED, extract_attempts: 3 },
    { id: 2, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED, extract_attempts: 2 },
    {
      id: 7, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED,
      extract_failed_at: stampAgo(2 * 60 * 1000),
    },
    {
      id: 8, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED,
      extract_failed_at: stampAgo(4 * 60 * 1000),
    },
  ], nowMs, caps), [2, 8]);
  assert.deepEqual(selectPayIds([
    { id: 3, extract_link: PAY_LINK, extracted_at: stampAgo(0), pay_attempts: 2 },
    { id: 4, extract_link: PAY_LINK, extracted_at: stampAgo(0), pay_attempts: 1 },
  ], nowMs, caps), [4]);
  assert.deepEqual(selectRtIds([
    {
      id: 5, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '', rt_attempts: 4,
    },
    {
      id: 6, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '', rt_attempts: 3,
    },
  ], nowMs, [], caps), [6]);
});

test('Free-after-RT allows exactly one more extract+pay cycle', () => {
  const nowMs = Date.now();
  const pending = {
    id: 1,
    access_token: 'at',
    extract_link: PAY_LINK,
    extracted_at: stampAgo(0),
    refresh_token: 'rt',
    remark: '已拿RT',
    plan_type: 'Free',
    activated_at: stampAgo(0),
    activation_retry_after_free_rt: 1,
  };
  const used = { ...pending, id: 2, activation_retry_after_free_rt: 2 };
  const plus = { ...pending, id: 3, plan_type: 'Plus' };
  assert.deepEqual(selectPayIds([pending, used, plus], nowMs), [1]);

  const needExtract = {
    id: 4,
    access_token: 'at',
    refresh_token: 'rt',
    remark: '已拿RT',
    plan_type: 'Free',
    activated_at: stampAgo(0),
    activation_retry_after_free_rt: 1,
    progress: PROGRESS.PAID,
  };
  assert.deepEqual(selectExtractIds([needExtract], nowMs), [4]);
  assert.deepEqual(selectExtractIds([used], nowMs), []);
});

test('acquire_rt starts for 已支付 without RT even while pay is running', async () => {
  const started = [];
  await tickUser(9, {
    readSettings: () => ({ pipeline: { pay: true, acquire_rt: true }, cloak: { max_concurrency: 3 } }),
    accountRows: () => [
      {
        id: 8, progress: PROGRESS.PAID, activated_at: stampAgo(0),
        password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
      },
      { id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0) },
    ],
    jobs: mockJobs(started, { pay: true }),
  });
  const rt = started.find((item) => item[0] === 'rt');
  assert.ok(rt);
  assert.deepEqual(rt[1].ids, [8]);
  const pay = started.find((item) => item[0] === 'pay');
  assert.ok(pay);
  assert.deepEqual(pay[1].ids, [1]);
});

test('notePaidForRt queues into acquire_rt when the toggle is on', async () => {
  const started = [];
  const jobs = mockJobs(started);
  const result = notePaidForRt(4, 8, {
    readSettings: () => ({ pipeline: { acquire_rt: true } }),
    jobs,
    startRt: async (_userId, ids) => { started.push(['rt', ids]); },
  });
  assert.equal(result.queued, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [['rt', [8]]]);
});

test('Free after RT persists a single extra activation retry flag', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, status, refresh_token, remark)
     VALUES (?, ?, 'Free', '正常', 'rt', '已拿RT')`
  ).run(user.id, `retry-${Date.now()}@example.test`);
  const id = inserted.lastInsertRowid;
  const first = markActivationRetryAfterFreeRt(user.id, id, 'Free');
  const second = markActivationRetryAfterFreeRt(user.id, id, 'Free');
  markActivationRetryAfterFreeRt(user.id, id, 'Plus');
  assert.equal(first.state, 1);
  assert.equal(second.changed, false);
  const saved = db.prepare(
    'SELECT activation_retry_after_free_rt FROM gpt_accounts WHERE id = ?'
  ).get(id);
  assert.equal(saved.activation_retry_after_free_rt, 2);
});

test('watchdog restarts a dead stage when the toggle is on', () => {
  const { owned } = require('../src/utils/accountPipeline')._test;
  owned.extract.add(11);
  const jobs = mockJobs([]);
  const restarted = watchdogUser(11, { extract: true, pay: false, register: false, acquire_rt: false }, jobs);
  assert.deepEqual(restarted, ['extract']);
  assert.equal(owned.extract.has(11), false);
});

test('watchdog does not restart a dead stage when the toggle is off', async () => {
  const { owned } = require('../src/utils/accountPipeline')._test;
  owned.pay.add(12);
  const started = [];
  const jobs = mockJobs(started);
  const restarted = watchdogUser(12, { extract: false, pay: false, register: false, acquire_rt: false }, jobs);
  assert.deepEqual(restarted, []);
  await tickUser(12, {
    readSettings: () => ({ pipeline: { pay: false }, cloak: {} }),
    accountRows: () => [{ id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0) }],
    jobs,
    startPay: async () => { started.push('pay'); },
  });
  assert.equal(owned.pay.has(12), false);
  assert.deepEqual(started, []);
});

test('pipeline extract and pay pass uncapped pipeline concurrency', async () => {
  const started = [];
  const rows = [];
  for (let i = 1; i <= 8; i += 1) {
    rows.push({
      id: i,
      has_trial: 1,
      access_token: 'at',
      progress: PROGRESS.REGISTERED,
    });
  }
  await tickUser(3, {
    readSettings: () => ({ pipeline: { extract: true }, cloak: {} }),
    accountRows: () => rows,
    jobs: mockJobs(started),
  });
  assert.equal(started[0][0], 'extract');
  assert.equal(started[0][1].pipeline, true);
  assert.equal(started[0][1].concurrency, 8);
});

test('toggle pay ON starts pay for eligible 已提链 and ignores extract interval', async () => {
  const started = [];
  await tickUser(21, {
    readSettings: () => ({
      pipeline: { pay: true, extract_interval_minutes: 30, pay_attempts: 5 },
      cloak: {},
    }),
    accountRows: () => [
      { id: 4, extract_link: PAY_LINK, extracted_at: stampAgo(60 * 1000) },
      { id: 5, extract_link: PAY_LINK, extracted_at: stampAgo(0), refresh_token: 'rt', remark: '已拿RT', plan_type: 'Plus' },
      { id: 6, extract_link: PAY_LINK, extracted_at: stampAgo(0), progress: PROGRESS.PAID, activated_at: stampAgo(0) },
    ],
    jobs: mockJobs(started),
  });
  assert.equal(started.length, 1);
  assert.equal(started[0][0], 'pay');
  assert.deepEqual(started[0][1].ids, [4]);
  assert.equal(started[0][1].pipeline, true);
});

test('pay starts for leftover 已提链 while extract is also live', async () => {
  const started = [];
  await tickUser(22, {
    readSettings: () => ({ pipeline: { extract: true, pay: true }, cloak: {} }),
    accountRows: () => [
      { id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0) },
      { id: 2, has_trial: 1, access_token: 'at', progress: PROGRESS.REGISTERED },
    ],
    jobs: mockJobs(started, { extract: true }),
  });
  const pay = started.find((item) => item[0] === 'pay');
  const extract = started.find((item) => item[0] === 'extract');
  assert.ok(pay);
  assert.deepEqual(pay[1].ids, [1]);
  assert.ok(extract);
  assert.deepEqual(extract[1].ids, [2]);
});

test('watchdog drops settled pay targets while activate is still live', () => {
  const dropped = [];
  const jobs = mockJobs([], { pay: true });
  jobs.pay.dropSettled = (userId) => { dropped.push(userId); };
  const restarted = watchdogUser(7, { extract: false, pay: true, register: false, acquire_rt: false }, jobs);
  assert.deepEqual(restarted, []);
  assert.deepEqual(dropped, [7]);
});

test('dead pay runtime is restarted by watchdog when 支付 is still on', async () => {
  const { owned } = require('../src/utils/accountPipeline')._test;
  owned.pay.add(1);
  const started = [];
  const jobs = mockJobs(started);
  const restarted = watchdogUser(1, { extract: false, pay: true, register: false, acquire_rt: false }, jobs);
  assert.deepEqual(restarted, ['pay']);
  assert.equal(owned.pay.has(1), false);
  await tickUser(1, {
    readSettings: () => ({ pipeline: { pay: true }, cloak: {} }),
    accountRows: () => [{ id: 9, extract_link: PAY_LINK, extracted_at: stampAgo(0) }],
    jobs,
  });
  assert.equal(started[0][0], 'pay');
  assert.deepEqual(started[0][1].ids, [9]);
  const logs = db.prepare(
    "SELECT message FROM operation_logs WHERE user_id = 1 AND message LIKE '%看门狗%支付%'"
  ).all();
  assert.ok(logs.some((row) => /支付已掉线/.test(row.message)));
});

test('leftover 已提链 still pays while RT job is live', async () => {
  const started = [];
  await tickUser(23, {
    readSettings: () => ({ pipeline: { pay: true, acquire_rt: true }, cloak: {} }),
    accountRows: () => [
      { id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0) },
      {
        id: 8, progress: PROGRESS.PAID, activated_at: stampAgo(0),
        password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
      },
    ],
    jobs: mockJobs(started, { rt: true }),
  });
  const pay = started.find((item) => item[0] === 'pay');
  assert.ok(pay);
  assert.deepEqual(pay[1].ids, [1]);
  assert.equal(pay[1].pipeline, true);
  assert.equal(started.some((item) => item[0] === 'rt'), true);
});

test('pipeline pay concurrency is not capped by PAY_CONCURRENCY for 已提链 waves', async () => {
  const started = [];
  const rows = [];
  for (let i = 1; i <= 8; i += 1) {
    rows.push({ id: i, extract_link: PAY_LINK, extracted_at: stampAgo(0) });
  }
  await tickUser(24, {
    readSettings: () => ({ pipeline: { pay: true }, cloak: {} }),
    accountRows: () => rows,
    jobs: mockJobs(started),
  });
  assert.equal(started[0][0], 'pay');
  assert.equal(started[0][1].pipeline, true);
  assert.equal(started[0][1].concurrency, 8);
  assert.equal(started[0][1].ids.length, 8);
});

test('dead RT runtime is restarted when 拿RT is on and 已支付 has no RT', async () => {
  const { owned } = require('../src/utils/accountPipeline')._test;
  owned.acquire_rt.add(1);
  const started = [];
  const jobs = mockJobs(started);
  const paid = {
    id: 8, progress: PROGRESS.PAID, activated_at: stampAgo(0),
    password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
  };
  const restarted = watchdogUser(1, { extract: false, pay: false, register: false, acquire_rt: true }, jobs, {
    rows: [paid],
  });
  assert.deepEqual(restarted, ['acquire_rt']);
  await tickUser(1, {
    readSettings: () => ({ pipeline: { acquire_rt: true }, cloak: {} }),
    accountRows: () => [paid],
    jobs,
  });
  assert.equal(started[0][0], 'rt');
  assert.deepEqual(started[0][1].ids, [8]);
  const logs = db.prepare(
    "SELECT message FROM operation_logs WHERE user_id = 1 AND message LIKE '%看门狗%RT%'"
  ).all();
  assert.ok(logs.some((row) => /拿RT已掉线/.test(row.message)));
});

test('tickUser does not start RT for unpaid 已提链 when 拿RT is on', async () => {
  const started = [];
  await tickUser(31, {
    readSettings: () => ({ pipeline: { acquire_rt: true, pay: true }, cloak: {} }),
    accountRows: () => [{
      id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
      progress: PROGRESS.EXTRACTED,
    }],
    jobs: mockJobs(started),
  });
  assert.equal(started.some((item) => item[0] === 'rt'), false);
  const pay = started.find((item) => item[0] === 'pay');
  assert.ok(pay);
  assert.deepEqual(pay[1].ids, [1]);
});

test('watchdog does not restart RT when only unpaid 已提链 exist', () => {
  const { owned } = require('../src/utils/accountPipeline')._test;
  owned.acquire_rt.add(32);
  const jobs = mockJobs([]);
  const restarted = watchdogUser(32, {
    extract: false, pay: false, register: false, acquire_rt: true,
  }, jobs, {
    rows: [{
      id: 1, extract_link: PAY_LINK, extracted_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
      progress: PROGRESS.EXTRACTED,
    }],
  });
  assert.deepEqual(restarted, []);
  assert.equal(owned.acquire_rt.has(32), false);
});

test('capped paid-without-RT accounts are skipped with an explicit log', async () => {
  const started = [];
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const { lastSkipLog } = require('../src/utils/accountPipeline')._test;
  lastSkipLog.clear();
  await tickUser(user.id, {
    readSettings: () => ({ pipeline: { acquire_rt: true, rt_attempts: 2 }, cloak: {} }),
    accountRows: () => [{
      id: 9, progress: PROGRESS.PAID, activated_at: stampAgo(0),
      password_enc: 'x', totp_secret_enc: 'y', refresh_token: '',
      rt_attempts: 2,
    }],
    jobs: mockJobs(started),
  });
  assert.equal(started.some((item) => item[0] === 'rt'), false);
  const logs = db.prepare(
    "SELECT message FROM operation_logs WHERE user_id = ? AND message LIKE '%拿 RT 暂不拉起%'"
  ).all(user.id);
  assert.ok(logs.some((row) => /rt_attempts=1/.test(row.message)));
});

test('phone bind timeout is a transient RT failure', () => {
  const { isTransientRtFailure } = require('../src/utils/accountRtJob');
  assert.equal(isTransientRtFailure({
    code: 'ACCOUNT_RT_PHONE_BIND_FAILED',
    message: '绑手机没成功（TimeoutError）',
  }), true);
  assert.equal(isTransientRtFailure({
    code: 'ACCOUNT_RT_PHONE_BIND_FAILED',
    message: '绑手机没成功（invalid_auth_step）',
  }), false);
  assert.equal(isTransientRtFailure({ code: 'JOB_CANCELLED', message: '任务已取消' }), false);
});
