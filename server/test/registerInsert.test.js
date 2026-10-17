const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-insert-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '5'.repeat(64);

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');
const { PROGRESS } = require('../src/utils/accountProgress');
const { CAMPAIGN_ID } = require('../src/utils/accountCheck');

function jwtPlusTrial() {
  return `x.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_plus_on_free_trial: true,
      chatgpt_account_id: 'acct-reg',
    },
  })).toString('base64url')}.x`;
}

function trialCheck() {
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
        eligible_promo_campaigns: { plus: { id: CAMPAIGN_ID } },
      },
    },
  };
}

test('new register stores Free + 已注册 even if JWT/check look like Plus', () => {
  const payload = registerJob._test.buildRegisterAccountPayload({
    email: 'fresh-reg@example.test',
    password: 'pw',
    result: {
      access_token: jwtPlusTrial(),
      refresh_token: 'rt',
      plan_type: 'Plus',
      plan: 'Plus',
      progress: PROGRESS.PAID,
      activated_at: '2026-08-20 08:00:00',
      check: trialCheck(),
      session_key: jwtPlusTrial(),
      chatgpt_account_id: 'acct-reg',
    },
    securityCheckpoint: {
      plan_type: 'Plus',
      progress: PROGRESS.PAID,
      activated_at: '2026-08-20 08:00:00',
    },
  });
  assert.equal(payload.plan_type, 'Free');
  assert.equal(payload.progress, PROGRESS.REGISTERED);
  assert.equal(payload.activated_at, '');
  assert.equal(payload.has_trial, 1);
  assert.equal(payload.email, 'fresh-reg@example.test');

  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  // Even a caller bypassing the payload builder cannot override the final
  // registration insertion invariants.
  payload.plan_type = 'Plus';
  payload.progress = PROGRESS.PAID;
  payload.activated_at = '2026-08-20 08:00:00';
  registerJob._test.insertAccount(user.id, payload);
  const saved = db.prepare(
    'SELECT plan_type, progress, has_trial, activated_at FROM gpt_accounts WHERE user_id = ? AND email = ?'
  ).get(user.id, payload.email);
  assert.equal(saved.plan_type, 'Free');
  assert.equal(saved.progress, PROGRESS.REGISTERED);
  assert.equal(saved.has_trial, 1);
  assert.equal(saved.activated_at || '', '');
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
