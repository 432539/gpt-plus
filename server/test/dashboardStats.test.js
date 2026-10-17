const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-dashboard-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '8'.repeat(64);

const db = require('../src/db');
const { writeSettings } = require('../src/utils/settings');
const {
  getDashboardStats,
  getDashboardLive,
  safeMessage,
} = require('../src/utils/dashboardStats');
const dashboardRoute = require('../src/routes/dashboard')._test;

const userId = db.prepare(
  "INSERT INTO users (username,password_hash,role,level,status) VALUES ('dashboard-user','x','user',1,1)"
).run().lastInsertRowid;
const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);

const insertAccount = db.prepare(
  `INSERT INTO gpt_accounts (
     user_id,email,plan_type,status,password_enc,access_token,refresh_token,
     has_trial,progress,extract_link,extracted_at,activated_at,created_at
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

db.transaction(() => {
  const today = db.prepare("SELECT datetime('now','localtime') AS value").get().value;
  insertAccount.run(
    userId, 'ready@example.test', 'Free', '正常', 'PASSWORD-SECRET',
    'AT-SUPER-SECRET', '', 1, '已注册', '', '', '', today
  );
  insertAccount.run(
    userId, 'regular@example.test', 'Free', '正常', '',
    'AT-REGULAR-SECRET', '', 0, '已注册', '', '', '', today
  );
  insertAccount.run(
    userId, 'extract@example.test', 'Free', '正常', '',
    'AT-EXTRACT-SECRET', '', 1, '已提链', 'PAYMENT-LINK-SECRET', today, '', today
  );
  insertAccount.run(
    userId, 'paid@example.test', 'Plus', '正常', 'PASSWORD-PAID-SECRET',
    'AT-PAID-SECRET', '', 1, '已支付', '', '', today, today
  );
  insertAccount.run(
    userId, 'rt@example.test', 'Plus', '正常', 'PASSWORD-RT-SECRET',
    'AT-RT-SECRET', 'RT-SUPER-SECRET', 1, '已支付', '', '', today, today
  );
  insertAccount.run(
    userId, 'old@example.test', 'Free', '令牌失效', '',
    '', '', null, '已注册', '', '', '', '2020-01-01 00:00:00'
  );

  db.prepare(
    "INSERT INTO account_syncs (user_id,email,kind,remote_ok,synced_at,price_yuan) VALUES (?,?,?,1,datetime('now','localtime'),?)"
  ).run(userId, 'regular@example.test', 'regular', '');
  db.prepare(
    "INSERT INTO account_syncs (user_id,email,kind,remote_ok,synced_at,price_yuan) VALUES (?,?,?,1,datetime('now','localtime'),?)"
  ).run(userId, 'rt@example.test', 'plus', '21.50');
  db.prepare(
    "INSERT INTO account_syncs (user_id,email,kind,remote_ok,synced_at,price_yuan) VALUES (?,?,?,0,datetime('now','localtime'),?)"
  ).run(userId, 'failed@example.test', 'plus', '99.00');

  db.prepare(
    "INSERT INTO emails (user_id,address,status,is_mother) VALUES (?,?,?,?)"
  ).run(userId, 'mother@example.test', 'active', 1);
  db.prepare(
    "INSERT INTO emails (user_id,address,status,is_mother,mother_id) VALUES (?,?,?,0,1)"
  ).run(userId, 'child@example.test', '未使用');
  db.prepare(
    "INSERT INTO emails (user_id,address,status,is_mother,mother_id) VALUES (?,?,?,0,1)"
  ).run(userId, 'used@example.test', '已使用');

  db.prepare(
    `INSERT INTO proxies
     (user_id,group_name,host,port,username,password_enc,status,latency)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(userId, 'secret-group', 'proxy-secret.example', 8080, 'PROXY-USER-SECRET', 'PROXY-PASSWORD-SECRET', '可用', 120);
  db.prepare(
    `INSERT INTO proxies
     (user_id,group_name,host,port,username,password_enc,status,latency)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(userId, 'secret-group', 'proxy-failed.example', 8081, 'user2', 'pass2', '失败', null);

  db.prepare(
    `INSERT INTO operation_logs (user_id,category,level,source,message)
     VALUES (?,'pull','error','poller',?)`
  ).run(userId, '轮询失败 ready@example.test token=LOG-TOKEN-SECRET https://secret.example/path');

  db.prepare(
    `INSERT INTO registration_runs
     (run_id,user_id,target,concurrency,completed,success,failed,running,finished,message,started_at)
     VALUES ('dashboard-run',?,?,?,?,?,?,0,1,?,datetime('now','localtime'))`
  ).run(userId, 1, 20, 1, 0, 1, '注册失败 ready@example.test token=RUN-TOKEN-SECRET');
  db.prepare(
    `INSERT INTO registration_batches
     (batch_id,user_id,run_id,kind,status,total,concurrency,completed,failed,message)
     VALUES ('dashboard-run',?,'dashboard-run','register','completed',1,20,1,1,?)`
  ).run(userId, '注册失败 ready@example.test token=BATCH-TOKEN-SECRET');
  db.prepare(
    `INSERT INTO registration_jobs
     (job_id,batch_id,user_id,kind,email,status,progress,error_code,error)
     VALUES ('dashboard-job','dashboard-run',?,'register',?,'failed',100,'MAILBOX_OTP_NOT_RECEIVED',?)`
  ).run(userId, 'ready@example.test', 'ERROR-TEXT-SECRET');
})();

writeSettings(userId, {
  pipeline: { register: true, extract: true, pay: true, acquire_rt: true, register_concurrency: 20 },
  cloak: { max_concurrency: 3 },
});

test('dashboard aggregates today funnel, inventory, sync, mail and proxy health', () => {
  const result = getDashboardStats(userId);
  assert.equal(result.scope, 'user');
  assert.deepEqual(
    {
      registered: result.funnel.registered,
      trial_yes: result.funnel.trial_yes,
      trial_no: result.funnel.trial_no,
      extracted: result.funnel.extracted,
      paid: result.funnel.paid,
      got_rt: result.funnel.got_rt,
      synced_regular: result.funnel.synced_regular,
      listed_plus: result.funnel.listed_plus,
    },
    {
      registered: 5,
      trial_yes: 4,
      trial_no: 1,
      extracted: 3,
      paid: 2,
      got_rt: 1,
      synced_regular: 1,
      listed_plus: 1,
    }
  );
  assert.equal(result.inventory.total, 6);
  assert.equal(result.inventory.plus, 2);
  assert.equal(result.inventory.token_invalid, 1);
  assert.equal(result.inventory.paid_without_rt, 1);
  assert.equal(result.inventory.extracted_waiting_pay, 1);
  assert.equal(result.inventory.ready_to_extract, 1);
  assert.equal(result.sync.successful_regular, 1);
  assert.equal(result.sync.listed_plus, 1);
  assert.equal(result.sync.listing_total_yuan, '21.50');
  assert.equal(result.sync.listing_failures, 1);
  assert.equal(result.mail.total, 3);
  assert.equal(result.mail.poll_failures_1h, 1);
  assert.equal(result.proxy.available, 1);
  assert.equal(result.proxy.unavailable, 1);
  assert.equal(result.proxy.average_latency_ms, 120);
  assert.ok(result.alerts.last_hour.some((item) => item.key === 'MAILBOX_OTP_NOT_RECEIVED'));
});

test('live dashboard distinguishes configured, effective and active concurrency', () => {
  const result = getDashboardLive(userId);
  const register = result.stages.register;
  assert.equal(register.configured_concurrency, 20);
  assert.equal(register.active_browsers, 0);
  assert.equal(register.running, false);
  assert.ok(register.effective_concurrency <= register.configured_concurrency);
  assert.ok(register.slot_capacity >= register.effective_concurrency);
  assert.ok(register.resource_slot_capacity >= register.slot_capacity);
  assert.equal(register.continuous, false);
  assert.equal(register.toggle, true);
  assert.equal(result.stages.extract.toggle, true);
  assert.equal(result.stages.pay.toggle, true);
  assert.equal(result.stages.acquire_rt.toggle, true);
});

test('dashboard API handlers never return stored tokens, passwords, proxy credentials or raw alert messages', () => {
  let summaryPayload;
  let livePayload;
  dashboardRoute.summaryHandler({ user }, { json: (value) => { summaryPayload = value; } });
  dashboardRoute.liveHandler({ user }, { json: (value) => { livePayload = value; } });
  const blob = JSON.stringify({ summaryPayload, livePayload });
  for (const secret of [
    'AT-SUPER-SECRET',
    'RT-SUPER-SECRET',
    'PASSWORD-SECRET',
    'PROXY-USER-SECRET',
    'PROXY-PASSWORD-SECRET',
    'proxy-secret.example',
    'PAYMENT-LINK-SECRET',
    'LOG-TOKEN-SECRET',
    'RUN-TOKEN-SECRET',
    'BATCH-TOKEN-SECRET',
    'ERROR-TEXT-SECRET',
  ]) {
    assert.equal(blob.includes(secret), false, `response leaked ${secret}`);
  }
  assert.doesNotMatch(
    blob,
    /"(access_token|refresh_token|password|password_enc|proxy_password|license_key|session_cookie|payment_link)":/i
  );
  const scrubbed = safeMessage(
    '正在注册 ready@example.test（proxy-secret.example:8080（PROXY-USER-SECRET）） token=LOG-TOKEN-SECRET'
  );
  assert.equal(scrubbed.includes('proxy-secret.example'), false);
  assert.equal(scrubbed.includes('PROXY-USER-SECRET'), false);
  assert.equal(scrubbed.includes('LOG-TOKEN-SECRET'), false);
});

test('dashboard stats tolerate an older minimal schema', () => {
  const legacy = new Database(':memory:');
  legacy.exec(`
    CREATE TABLE gpt_accounts (id INTEGER PRIMARY KEY, user_id INTEGER, email TEXT, created_at TEXT);
    CREATE TABLE emails (user_id INTEGER, address TEXT);
    CREATE TABLE proxies (user_id INTEGER, status TEXT);
    CREATE TABLE account_syncs (user_id INTEGER, email TEXT, kind TEXT);
    INSERT INTO gpt_accounts VALUES (1, 7, 'legacy@example.test', datetime('now','localtime'));
    INSERT INTO emails VALUES (7, 'legacy@example.test');
    INSERT INTO proxies VALUES (7, '可用');
    INSERT INTO account_syncs VALUES (7, 'legacy@example.test', 'regular');
  `);
  const result = getDashboardStats(7, { database: legacy });
  assert.equal(result.funnel.registered, 1);
  assert.equal(result.inventory.total, 1);
  assert.equal(result.inventory.trial_unknown, 1);
  assert.equal(result.proxy.available, 1);
  legacy.close();
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
