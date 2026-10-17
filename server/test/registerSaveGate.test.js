const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-save-gate-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '3'.repeat(64);

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');
const { CAMPAIGN_ID } = require('../src/utils/accountCheck');
const { PROGRESS } = require('../src/utils/accountProgress');

const {
  persistRegisteredAccount,
  shouldPersistRegisterAccount,
  isTotpSuccessfullyEnrolled,
  checkTrialAfterRegister,
  isSafeRegisterTrialProxy,
} = registerJob._test;

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
const TOTP = 'JBSWY3DPEHPK3PXP';

function rowByEmail(email) {
  return db.prepare(
    'SELECT * FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
  ).get(userId, email);
}

function plusPaidCheck() {
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: {
          subscription_plan: 'chatgptplusplan',
          has_active_subscription: true,
          billing_period: 'monthly',
        },
      },
    },
  };
}

function trialYesCheck() {
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'free' },
        entitlement: { subscription_plan: 'chatgptfreeplan' },
        eligible_promo_campaigns: { plus: { id: CAMPAIGN_ID } },
      },
    },
  };
}

function trialNoCheck() {
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'free' },
        entitlement: { subscription_plan: 'chatgptfreeplan' },
        eligible_promo_campaigns: {},
      },
    },
  };
}

test('2FA requested without totp does not persist even when AT is present', () => {
  const email = '2fa-missing-totp@example.test';
  assert.equal(shouldPersistRegisterAccount(true, {
    access_token: 'AT-PRESENT',
    password: 'pw',
    mfa_enabled: false,
  }), false);
  const persist = persistRegisteredAccount(userId, email, {
    access_token: 'AT-PRESENT',
    password: 'pw',
    password_set: true,
    mfa_enabled: false,
    hardening_status: 'failed',
  }, { enableTotp2fa: true });
  assert.equal(persist.saved, false);
  assert.equal(persist.reason, 'totp_incomplete');
  assert.equal(rowByEmail(email), undefined);
});

test('enrolling totp secret without activation is not a successful 2FA enroll', () => {
  assert.equal(isTotpSuccessfullyEnrolled({
    totp_secret: TOTP,
    mfa_enabled: false,
    hardening_status: 'mfa_enrolling',
  }), false);
  const persist = persistRegisteredAccount(userId, '2fa-enrolling@example.test', {
    access_token: 'AT-PRESENT',
    totp_secret: TOTP,
    mfa_enabled: false,
    hardening_status: 'mfa_enrolling',
  }, { enableTotp2fa: true });
  assert.equal(persist.saved, false);
  assert.equal(rowByEmail('2fa-enrolling@example.test'), undefined);
});

test('2FA requested with saved totp persists then runs trial check', async () => {
  const email = '2fa-ok-trial@example.test';
  const persist = persistRegisteredAccount(userId, email, {
    access_token: 'AT-PRESENT',
    password: 'pw',
    totp_secret: TOTP,
    mfa_enabled: true,
    hardening_status: 'security_complete',
    security_ready: true,
  }, { enableTotp2fa: true });
  assert.equal(persist.saved, true);
  assert.ok(rowByEmail(email));

  let seen = null;
  const trial = await checkTrialAfterRegister(userId, email, {
    proxy: { host: '10.0.0.8', port: 1080, group_name: '注册-GB' },
    detectViaTokenFn: async (uid, id, opts) => {
      seen = { uid, id, opts };
      db.prepare('UPDATE gpt_accounts SET has_trial = 1, trial_label = ? WHERE id = ?')
        .run(CAMPAIGN_ID, id);
      return { id, has_trial: 1, skipped: false };
    },
  });
  assert.equal(seen.uid, userId);
  assert.equal(seen.id, persist.id);
  assert.equal(seen.opts.trialOnly, true);
  assert.equal(seen.opts.proxy.host, '10.0.0.8');
  assert.equal(seen.opts.proxy.group_name, '注册-GB');
  assert.equal(trial.has_trial, 1);
  assert.equal(rowByEmail(email).has_trial, 1);
  assert.equal(rowByEmail(email).plan_type, 'Free');
  assert.equal(rowByEmail(email).progress, PROGRESS.REGISTERED);
});

test('2FA not requested still persists password-only accounts without totp', () => {
  const email = 'password-only@example.test';
  assert.equal(shouldPersistRegisterAccount(false, {
    access_token: 'AT-PRESENT',
    password: 'pw',
  }), true);
  const persist = persistRegisteredAccount(userId, email, {
    access_token: 'AT-PRESENT',
    password: 'pw',
    password_set: true,
    mfa_enabled: false,
    hardening_status: 'security_complete',
    security_ready: true,
  }, { enableTotp2fa: false });
  assert.equal(persist.saved, true);
  const saved = rowByEmail(email);
  assert.ok(saved);
  assert.equal(saved.plan_type, 'Free');
  assert.equal(saved.totp_secret_enc || '', '');
});

test('trial check after insert writes 是/否 and does not flip Free to Plus', async () => {
  const yesEmail = 'trial-yes@example.test';
  const noEmail = 'trial-no-plus@example.test';
  persistRegisteredAccount(userId, yesEmail, {
    access_token: 'plain-at',
    password: 'pw',
    totp_secret: TOTP,
    mfa_enabled: true,
    hardening_status: 'security_complete',
  }, { enableTotp2fa: true });
  persistRegisteredAccount(userId, noEmail, {
    access_token: 'plain-at',
    password: 'pw',
    totp_secret: TOTP,
    mfa_enabled: true,
    hardening_status: 'security_complete',
    plan_type: 'Plus',
  }, { enableTotp2fa: true });
  assert.equal(rowByEmail(noEmail).plan_type, 'Free');

  const registerProxy = { host: '10.0.0.9', port: 2080, group_name: '注册' };
  const yes = await checkTrialAfterRegister(userId, yesEmail, {
    proxy: registerProxy,
    fetchImpl: async () => ({
      status: 200,
      async text() { return JSON.stringify(trialYesCheck()); },
    }),
  });
  const no = await checkTrialAfterRegister(userId, noEmail, {
    proxy: registerProxy,
    fetchImpl: async () => ({
      status: 200,
      async text() { return JSON.stringify(plusPaidCheck()); },
    }),
  });
  assert.equal(yes.has_trial, 1);
  assert.equal(no.has_trial, 0);
  assert.equal(rowByEmail(yesEmail).has_trial, 1);
  assert.equal(rowByEmail(noEmail).has_trial, 0);
  assert.equal(rowByEmail(yesEmail).plan_type, 'Free');
  assert.equal(rowByEmail(noEmail).plan_type, 'Free');
  assert.equal(rowByEmail(noEmail).progress, PROGRESS.REGISTERED);
});

test('trial check refuses payment JP/TR mix and does not hit accounts/check from VPS', async () => {
  const email = 'no-pay-proxy@example.test';
  persistRegisteredAccount(userId, email, {
    access_token: 'plain-at',
    password: 'pw',
  }, { enableTotp2fa: false });
  assert.equal(isSafeRegisterTrialProxy({ host: '1.1.1.1', port: 80, group_name: '支付-JP' }), false);
  assert.equal(isSafeRegisterTrialProxy({ host: '1.1.1.1', port: 80, group_name: 'PayPal-TR' }), false);
  assert.equal(isSafeRegisterTrialProxy({ host: '1.1.1.1', port: 80, group_name: '注册-GB' }), true);

  let called = false;
  const result = await checkTrialAfterRegister(userId, email, {
    proxy: { host: '1.1.1.1', port: 80, group_name: '支付-JP' },
    detectViaTokenFn: async () => {
      called = true;
      return { has_trial: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(result.reason, 'no_register_proxy');
  assert.equal(rowByEmail(email).has_trial, null);
});

test('trial no-offer payload writes 否 via the same check-once path', async () => {
  const email = 'trial-none@example.test';
  persistRegisteredAccount(userId, email, {
    access_token: 'plain-at',
    password: 'pw',
    totp_secret: TOTP,
    mfa_enabled: true,
    hardening_status: 'security_complete',
  }, { enableTotp2fa: true });
  const result = await checkTrialAfterRegister(userId, email, {
    proxy: { host: '10.0.0.10', port: 1080, group_name: '注册-GB' },
    fetchImpl: async () => ({
      status: 200,
      async text() { return JSON.stringify(trialNoCheck()); },
    }),
  });
  assert.equal(result.has_trial, 0);
  assert.equal(rowByEmail(email).has_trial, 0);
  assert.equal(rowByEmail(email).plan_type, 'Free');
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
