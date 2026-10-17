'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-blockers-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '9'.repeat(64);

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');
const { HeroSmsGuard } = require('../src/automation/lib/herosms-guard');
const {
  planRegisterMailboxPipeline,
  createRegisterMailboxPipeline,
} = require('../src/automation/lib/register-performance');
const {
  registerRetryDelayMs,
  registerFailureRetryDelayMs,
} = require('../src/automation/lib/retry-policy');
const { DEFAULTS } = require('../src/utils/settings');
const { getSmsMailOptions, getSmsPhoneCountries } = require('../src/automation/channels/providers');
const accountRtJob = require('../src/utils/accountRtJob');

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

function fixtureJob() {
  db.prepare(
    `INSERT INTO registration_runs (run_id,user_id,target,concurrency,running,started_at)
     VALUES ('settlement-batch',?,1,1,1,datetime('now','localtime'))`
  ).run(userId);
  db.prepare(
    `INSERT INTO registration_batches (batch_id,user_id,run_id,status,total,concurrency,queued)
     VALUES ('settlement-batch',?,'settlement-batch','running',1,1,1)`
  ).run(userId);
  db.prepare(
    `INSERT INTO registration_jobs (job_id,batch_id,user_id,email,status)
     VALUES ('settlement-job','settlement-batch',?,'paid@example.test','running')`
  ).run(userId);
}

test('settlement is persisted and terminal lifecycle is idempotent', async () => {
  fixtureJob();
  let finishes = 0;
  let cancels = 0;
  const channel = {
    mailId: 'mail-order-1',
    finish: async () => { finishes += 1; return true; },
    cancel: async () => { cancels += 1; return true; },
  };
  registerJob._test.persistSettlement('settlement-job', userId, 'mail', 'herosms', channel, 'cancel', 'open');
  await registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: true, log() {},
  });
  await registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: false, log() {},
  });
  assert.equal(finishes, 1);
  assert.equal(cancels, 0, 'finished paid resource must never be cancelled again');
  const row = db.prepare('SELECT * FROM registration_settlements WHERE job_id=?').get('settlement-job');
  assert.equal(row.action, 'finish');
  assert.equal(row.status, 'finished');
});

test('restart cleanup retries persisted pending settlements offline', async () => {
  db.prepare(
    `UPDATE registration_settlements SET status='pending',action='cancel',retry_at=''
     WHERE job_id='settlement-job'`
  ).run();
  let cancelled = 0;
  const result = await registerJob.reconcilePendingSettlements({
    channelFactory: async () => ({ cancel: async () => { cancelled += 1; return true; } }),
  });
  assert.equal(result.settled, 1);
  assert.equal(cancelled, 1);
  assert.equal(
    db.prepare('SELECT status FROM registration_settlements WHERE job_id=?').get('settlement-job').status,
    'cancelled'
  );
});

test('settlement reconcile obeys finish action and CAS prevents concurrent double settlement', async () => {
  db.prepare(
    `UPDATE registration_settlements SET status='ambiguous',action='finish',retry_at='',
     claim_token='',claim_until='' WHERE job_id='settlement-job'`
  ).run();
  let finishes = 0;
  let cancels = 0;
  const factory = async () => ({
    finish: async () => { finishes += 1; await new Promise(resolve => setImmediate(resolve)); return true; },
    cancel: async () => { cancels += 1; return true; },
  });
  await Promise.all([
    registerJob.reconcilePendingSettlements({ channelFactory: factory }),
    registerJob.reconcilePendingSettlements({ channelFactory: factory }),
  ]);
  assert.equal(finishes, 1);
  assert.equal(cancels, 0);
  const row = db.prepare('SELECT * FROM registration_settlements WHERE job_id=?').get('settlement-job');
  assert.equal(row.status, 'finished');
  assert.equal(row.settle_attempt >= 1, true);
  assert.equal(row.claim_token, '');
});

test('lost finish response persists ambiguous and restart completes the same action', async () => {
  const channel = {
    mailId: 'mail-order-ambiguous',
    finish: async () => { throw Object.assign(new Error('finish response lost'), { code: 'REQUEST_TIMEOUT' }); },
    cancel: async () => true,
  };
  registerJob._test.persistSettlement('settlement-job', userId, 'mail', 'herosms', channel, 'finish', 'open');
  await assert.rejects(registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: true, log() {},
  }));
  let row = db.prepare("SELECT * FROM registration_settlements WHERE external_id='mail-order-ambiguous'").get();
  assert.equal(row.status, 'ambiguous');
  db.prepare("UPDATE registration_settlements SET retry_at='' WHERE settlement_id=?").run(row.settlement_id);
  let recoveredFinish = 0;
  await registerJob.reconcilePendingSettlements({
    channelFactory: async () => ({
      finish: async () => { recoveredFinish += 1; return true; },
      cancel: async () => assert.fail('ambiguous finish must not become cancel'),
    }),
  });
  row = db.prepare('SELECT * FROM registration_settlements WHERE settlement_id=?').get(row.settlement_id);
  assert.equal(recoveredFinish, 1);
  assert.equal(row.status, 'finished');
});

test('opposite settlement action cannot overwrite an active claimed action', async () => {
  let releaseFinish;
  let finishStarted;
  const started = new Promise(resolve => { finishStarted = resolve; });
  const release = new Promise(resolve => { releaseFinish = resolve; });
  let finishes = 0;
  let cancels = 0;
  const channel = {
    mailId: 'mail-order-opposite-race',
    finish: async () => { finishes += 1; finishStarted(); await release; return true; },
    cancel: async () => { cancels += 1; return true; },
  };
  const finishing = registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: true, log() {}, leaseMs: 1000,
  });
  await started;
  registerJob._test.persistSettlement(
    'settlement-job', userId, 'mail', 'herosms', channel, 'cancel', 'open'
  );
  const opposite = await registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: false, log() {}, leaseMs: 1000,
  });
  assert.equal(opposite.claimed, false);
  assert.equal(opposite.conflict, true);
  assert.equal(opposite.action, 'finish');
  releaseFinish();
  await finishing;
  assert.equal(finishes, 1);
  assert.equal(cancels, 0);
});

test('timeout keeps renewing claim until an unabortable provider settles without double settlement', async () => {
  let releaseProvider;
  const providerDone = new Promise(resolve => { releaseProvider = resolve; });
  let finishes = 0;
  const channel = {
    mailId: 'mail-order-call-timeout',
    finish: async (_session, meta) => {
      finishes += 1;
      assert.equal(meta.signal instanceof AbortSignal, true);
      await providerDone;
      return true;
    },
    cancel: async () => true,
  };
  const settling = registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: true, log() {}, callTimeoutMs: 100, leaseMs: 300,
  });
  await new Promise(resolve => setTimeout(resolve, 450));
  let replayed = 0;
  await registerJob.reconcilePendingSettlements({
    leaseMs: 300,
    channelFactory: async () => ({
      finish: async () => { replayed += 1; return true; },
    }),
  });
  assert.equal(replayed, 0, 'reconciler must not replay while timed-out provider call still runs');
  assert.equal(finishes, 1);
  releaseProvider();
  await assert.rejects(settling, error => error.code === 'SETTLEMENT_CALL_TIMEOUT');
  const row = db.prepare("SELECT * FROM registration_settlements WHERE external_id='mail-order-call-timeout'").get();
  assert.equal(row.status, 'ambiguous');
  assert.equal(row.claim_token, '');
  assert.equal(row.action, 'finish');
});

test('settlement completion CAS loss is surfaced and recoverable after lease expiry', async () => {
  let settlementId = '';
  const channel = {
    mailId: 'mail-order-completion-cas',
    finish: async () => {
      settlementId = db.prepare(
        "SELECT settlement_id FROM registration_settlements WHERE external_id='mail-order-completion-cas'"
      ).get().settlement_id;
      db.prepare("UPDATE registration_settlements SET claim_token='stolen-token' WHERE settlement_id=?").run(settlementId);
      return true;
    },
    cancel: async () => true,
  };
  await assert.rejects(registerJob._test.settleJobChannel({
    jobId: 'settlement-job', userId, type: 'mail', provider: 'herosms',
    channel, success: true, log() {},
  }), error => error.code === 'SETTLEMENT_COMPLETION_CAS_LOST');
  db.prepare(
    "UPDATE registration_settlements SET claim_until='2000-01-01T00:00:00.000Z',retry_at='' WHERE settlement_id=?"
  ).run(settlementId);
  let recovered = 0;
  const result = await registerJob.reconcilePendingSettlements({
    channelFactory: async () => ({ finish: async () => { recovered += 1; return true; } }),
  });
  assert.equal(recovered, 1);
  assert.equal(result.conflicts, 0);
  assert.equal(db.prepare('SELECT status FROM registration_settlements WHERE settlement_id=?').get(settlementId).status, 'finished');
});

test('HeroSMS guard retries reads but never replays ambiguous paid purchase', async () => {
  let now = 0;
  const guard = new HeroSmsGuard({
    requestsPerSecond: 10,
    maxTransientRetries: 2,
    now: () => now,
    wait: async ms => { now += ms; },
    random: () => 0,
  });
  let reads = 0;
  const read = await guard.request(
    'https://hero-sms.com/api/v1/emails/1',
    { method: 'GET' },
    async () => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' });
      return { ok: true, status: 200, data: {} };
    }
  );
  assert.equal(read.ok, true);
  assert.equal(reads, 2);

  let purchases = 0;
  await assert.rejects(
    guard.request('https://hero-sms.com/api/v1/emails', { method: 'POST' }, async () => {
      purchases += 1;
      throw Object.assign(new Error('lost response'), { code: 'REQUEST_TIMEOUT' });
    }),
    error => error.code === 'REQUEST_TIMEOUT'
  );
  assert.equal(purchases, 1);
});

test('throughput mailbox pipeline is bounded separately from launch slots', async () => {
  const plan = planRegisterMailboxPipeline({
    performanceProfile: 'throughput', effectiveConcurrency: 100, launchConcurrency: 20,
  });
  assert.deepEqual(plan, { enabled: true, capacity: 40, buffered: 20, launchConcurrency: 20 });
  const pipeline = createRegisterMailboxPipeline({ enabled: true, capacity: 1 });
  const first = await pipeline.acquire();
  let admitted = false;
  const secondPromise = pipeline.acquire().then(permit => { admitted = true; return permit; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false);
  first.release();
  const second = await secondPromise;
  assert.equal(admitted, true);
  second.release();
});

test('pipeline cancellation wakes queued mailbox prefetch waiters', async () => {
  const pipeline = createRegisterMailboxPipeline({ enabled: true, capacity: 1 });
  const first = await pipeline.acquire();
  const queued = pipeline.acquire();
  pipeline.cancelAll();
  await assert.rejects(queued, error => error.code === 'JOB_CANCELLED');
  first.release();
  await assert.rejects(pipeline.acquire(), error => error.code === 'JOB_CANCELLED');
});

test('sms mail options returns live normalized inventory and safe fallback without secrets', async () => {
  const settings = DEFAULTS();
  settings.herosms.api_key = 'top-secret';
  const live = await getSmsMailOptions(settings, { provider: 'herosms' }, {
    fetchImpl: async (_url, options) => {
      assert.match(options.headers.authorization, /top-secret/);
      return {
        ok: true,
        json: async () => ({ data: [
          { name: 'outlook.com', cost: 0.1, count: 8 },
          { name: 'gmail.com', cost: 0.05, count: 99 },
        ] }),
      };
    },
  });
  assert.deepEqual(live.domains, [{ name: 'outlook.com', cost: 0.1, count: 8 }]);
  assert.equal(live.blocked[0].name, 'gmail.com');
  assert.equal(JSON.stringify(live).includes('top-secret'), false);
  const fallback = await getSmsMailOptions(settings, { provider: 'herosms' }, {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(fallback.domains.every(item => item.fallback), true);
  assert.match(fallback.warning, /安全回退/);
});

test('sms phone countries uses mockable live vendor contract and timeout fallback', async () => {
  const settings = DEFAULTS();
  settings.sms.provider = 'smsbower';
  settings.smsbower.api_key = 'country-secret';
  settings.smsbower.api_url = 'https://smsbower.test/handler_api.php';
  const live = await getSmsPhoneCountries(settings, {
    provider: 'smsbower',
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('action'), 'getCountries');
      assert.equal(url.searchParams.get('api_key'), 'country-secret');
      return { ok: true, json: async () => [{ id: 6, iso: 'JP', eng: 'Japan', chn: '日本', dialCode: '+81' }] };
    },
  });
  assert.equal(live.source, 'smsbower');
  assert.equal(live.items[0].value, 'JP');
  assert.equal(JSON.stringify(live).includes('country-secret'), false);
  const fallback = await getSmsPhoneCountries(settings, {
    provider: 'smsbower', timeoutMs: 100, fetchImpl: async () => new Promise(() => {}),
  });
  assert.equal(fallback.source, 'fallback');
  assert.match(fallback.warning, /超时/);
  assert.equal(fallback.items.some(item => item.value === 'JP'), true);
  assert.equal(fallback.items.some(item => item.value === 'CL'), true);
});

test('account RT eligibility reports stable preflight skip reasons', () => {
  assert.equal(accountRtJob._test.accountRtEligibility(null, 7).code, 'ACCOUNT_NOT_FOUND');
  assert.equal(accountRtJob._test.accountRtEligibility({
    detail: { email: 'has-rt@example.test', refresh_token: 'rt', password: 'pw' },
  }, 8).code, 'ACCOUNT_RT_ALREADY_AVAILABLE');
  assert.equal(accountRtJob._test.accountRtEligibility({
    detail: { email: 'has-rt@example.test', refresh_token: 'rt', password: 'pw', totp_secret: 'JBSWY3DPEHPK3PXP' },
  }, 8, { allowExistingRt: true }).eligible, true);
  assert.equal(accountRtJob._test.accountRtEligibility({
    detail: { email: 'no-password@example.test', refresh_token: '', password: '' },
  }, 9).code, 'ACCOUNT_RT_MISSING_PASSWORD');
  assert.equal(accountRtJob._test.accountRtEligibility({
    detail: { email: 'no-totp@example.test', refresh_token: '', password: 'pw', totp_secret: '' },
  }, 10).code, 'ACCOUNT_RT_MISSING_TOTP');
  assert.equal(accountRtJob._test.accountRtEligibility({
    row: { progress: '已支付', activated_at: '2026-08-21 00:00:00' },
    detail: { email: 'eligible@example.test', refresh_token: '', password: 'pw', totp_secret: 'JBSWY3DPEHPK3PXP' },
  }, 11).eligible, true);
  assert.equal(accountRtJob._test.accountRtEligibility({
    row: { progress: '已提链', extract_link: 'https://www.paypal.com/agreements/approve?ba_token=BA-TEST' },
    detail: { email: 'extracted@example.test', refresh_token: '', password: 'pw', totp_secret: 'JBSWY3DPEHPK3PXP' },
  }, 12).code, 'ACCOUNT_RT_NOT_PAID');
});

test('retry delays and reference defaults are deterministic', () => {
  assert.equal(registerRetryDelayMs(1, () => 0), 500);
  assert.equal(registerRetryDelayMs(3, () => 1), 2251);
  assert.equal(registerFailureRetryDelayMs({ code: 'CLOAK_LICENSE_SESSION_LIMIT' }, 1, () => 0), 15000);
  const settings = DEFAULTS();
  assert.equal(settings.sms.provider, 'auto');
  assert.equal(settings.sms.country, 'usa');
  assert.equal(settings.sms.product, 'openai');
  assert.equal(settings.registration.mail_provider, 'herosms');
  assert.equal(settings.dynamic_proxy.providers.iprocket.sticky_minutes, 5);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
