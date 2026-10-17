const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-liveness-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '2'.repeat(64);

const db = require('../src/db');
const { toColumns, toDetail } = require('../src/utils/accountFields');
const {
  classifyRemoteResponse,
  persistDetectResult,
  detectViaToken,
  persistPlanAfterRt,
  persistRefreshResult,
  isTokenInvalidatedError,
  recheckAfterTokenInvalidated,
} = require('../src/utils/accountJob');
const { writeSettings, readSettings, DEFAULTS } = require('../src/utils/settings');

function freeCheck(campaign = '') {
  const promo = campaign ? { plus: { id: campaign } } : {};
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'free' },
        entitlement: { subscription_plan: 'chatgptfreeplan' },
        eligible_promo_campaigns: promo,
      },
    },
  };
}

function insertAccount(userId, email, extra = {}) {
  const cols = toColumns({
    email,
    password: 'pw',
    access_token: extra.access_token || 'access-token',
    status: extra.status || '正常',
    plan_type: extra.plan_type || 'Free',
    has_trial: extra.has_trial,
  });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts
     (user_id, email, password_enc, email_type, plan_type, status, access_token, has_trial, trial_label)
     VALUES (?, ?, ?, 'gmail', ?, ?, ?, ?, ?)`
  ).run(
    userId,
    cols.email,
    cols.password_enc,
    cols.plan_type,
    cols.status,
    cols.access_token,
    extra.has_trial === 0 || extra.has_trial === 1 ? extra.has_trial : null,
    extra.trial_label || '',
  );
  return db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
}

test('default account detect poll is 15 minutes and 0 stays off', () => {
  const defaults = DEFAULTS();
  assert.equal(defaults.accounts.detect_poll_minutes, 15);
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  writeSettings(user.id, { accounts: { detect_poll_minutes: 0 } });
  assert.equal(readSettings(user.id).accounts.detect_poll_minutes, 0);
  writeSettings(user.id, { accounts: { detect_poll_minutes: 12 } });
  assert.equal(readSettings(user.id).accounts.detect_poll_minutes, 12);
});

test('liveness persist does not flip status on transport errors', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'transport-live@example.test');
  const result = persistDetectResult(user.id, row.id, row, toDetail(row), {
    response: { status: 0, text: 'socket hang up' },
  });
  assert.equal(result.transport, true);
  const saved = db.prepare('SELECT status, has_trial, plan_type FROM gpt_accounts WHERE id = ?').get(row.id);
  assert.equal(saved.status, '正常');
  assert.equal(saved.has_trial, null);
  assert.equal(saved.plan_type, 'Free');
});

test('cloudflare html is transport, not dead', () => {
  assert.equal(classifyRemoteResponse({ status: 403, text: '<!DOCTYPE html>Just a moment' }).transportFailure, true);
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'cf-live@example.test', { status: '正常' });
  persistDetectResult(user.id, row.id, row, toDetail(row), {
    response: { status: 403, text: '<html>cloudflare cf-ray</html>' },
  });
  assert.equal(db.prepare('SELECT status FROM gpt_accounts WHERE id = ?').get(row.id).status, '正常');
});

test('trial is persisted once and a later eligible payload does not overwrite 否', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'trial-once@example.test');
  const first = persistDetectResult(user.id, row.id, row, toDetail(row), {
    response: { ok: true, status: 200, data: freeCheck() },
  });
  assert.equal(first.has_trial, 0);
  assert.equal(first.status, '正常');
  const afterFirst = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(row.id);
  const second = persistDetectResult(user.id, afterFirst.id, afterFirst, toDetail(afterFirst), {
    response: { ok: true, status: 200, data: freeCheck('plus-1-month-free') },
  });
  assert.equal(second.has_trial, 0);
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id = ?').get(row.id).has_trial, 0);
});

test('token detect writes 是 from plus-1-month-free and skips trial when already known', async () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'token-trial@example.test');
  const first = await detectViaToken(user.id, row.id, {
    fetchImpl: async () => ({
      status: 200,
      async text() { return JSON.stringify(freeCheck('plus-1-month-free')); },
    }),
  });
  assert.equal(first.has_trial, 1);
  assert.equal(first.transport, false);
  const second = await detectViaToken(user.id, row.id, {
    trialOnly: true,
    fetchImpl: async () => {
      throw new Error('should not refetch trial');
    },
  });
  assert.equal(second.reason, 'trial_known');
  assert.equal(second.has_trial, 1);
});

test('token detect transport error leaves status and unknown trial unchanged', async () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'token-transport@example.test', { status: '正常' });
  const result = await detectViaToken(user.id, row.id, {
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(result.transport, true);
  const saved = db.prepare('SELECT status, has_trial FROM gpt_accounts WHERE id = ?').get(row.id);
  assert.equal(saved.status, '正常');
  assert.equal(saved.has_trial, null);
});

test('detect does not stamp Plus on an unactivated Free account', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const inserted = insertAccount(user.id, 'unactivated-plus-stamp@example.test');
  db.prepare("UPDATE gpt_accounts SET progress = '已支付', activated_at = '' WHERE id = ?").run(inserted.id);
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.id);
  persistDetectResult(user.id, row.id, row, toDetail(row), {
    updatePlan: true,
    response: {
      ok: true,
      status: 200,
      data: {
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
      },
    },
  });
  const saved = db.prepare('SELECT plan_type FROM gpt_accounts WHERE id = ?').get(row.id);
  assert.equal(saved.plan_type, 'Free');
});

function plusCheck(expires = '2026-09-20T00:00:00Z') {
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: {
          subscription_plan: 'chatgptplusplan',
          has_active_subscription: true,
          billing_period: 'monthly',
          expires_at: expires,
        },
      },
    },
  };
}

test('persistRefreshResult writes 已拿RT without taking Plus from JWT', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const cols = toColumns({
    email: 'rt-remark@example.test',
    password: 'pw',
    access_token: 'old-at',
    plan_type: 'Free',
  });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts
     (user_id, email, password_enc, email_type, plan_type, status, access_token, remark)
     VALUES (?, ?, ?, 'gmail', 'Free', '正常', ?, '')`
  ).run(user.id, cols.email, cols.password_enc, cols.access_token);
  const token = `x.${Buffer.from(JSON.stringify({
    exp: 1893456000,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-rt' },
    'https://api.openai.com/profile': { email: cols.email },
  })).toString('base64url')}.x`;
  const raw = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  persistRefreshResult(user.id, inserted.lastInsertRowid, raw, {
    access_token: token,
    refresh_token: 'new-rt',
  });
  const saved = toDetail(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid));
  assert.equal(saved.remark, '已拿RT');
  assert.equal(saved.plan_type, 'Free');
  assert.equal(saved.refresh_token, 'new-rt');
  assert.equal(saved.extract_link || '', '');
});

test('persistPlanAfterRt writes Plus from accounts/check, not JWT', async () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const cols = toColumns({
    email: 'rt-plan@example.test',
    password: 'pw',
    access_token: 'session-at',
    refresh_token: 'durable-rt',
    plan_type: 'Free',
  });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts
     (user_id, email, password_enc, email_type, plan_type, status, access_token, refresh_token, remark)
     VALUES (?, ?, ?, 'gmail', 'Free', '正常', ?, ?, '')`
  ).run(user.id, cols.email, cols.password_enc, cols.access_token, cols.refresh_token);
  const result = await persistPlanAfterRt(user.id, inserted.lastInsertRowid, {
    proxy: null,
    fetchImpl: async () => ({
      status: 200,
      async text() { return JSON.stringify(plusCheck('2026-09-20T12:00:00Z')); },
    }),
  });
  assert.equal(result.plan_type, 'Plus');
  assert.equal(result.remark, '已拿RT');
  const saved = db.prepare('SELECT plan_type, remark, expires_at, activated_at, extract_link FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  assert.equal(saved.plan_type, 'Plus');
  assert.equal(saved.remark, '已拿RT');
  assert.equal(saved.expires_at, '2026-09-20 12:00:00');
  assert.ok(saved.activated_at);
  assert.equal(saved.extract_link || '', '');
});

test('ACCOUNT_TOKEN_INVALIDATED recheck keeps 正常 on 200 and does not stamp Plus', async () => {
  assert.equal(isTokenInvalidatedError({ code: 'ACCOUNT_TOKEN_INVALIDATED' }), true);
  assert.equal(isTokenInvalidatedError({
    message: '账号 Token 已被作废，请重新导入有效的 Access Token',
  }), true);
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'recheck-ok@example.test');
  db.prepare("UPDATE gpt_accounts SET status = '令牌失效', token_invalidated = 1, activated_at = '' WHERE id = ?")
    .run(row.id);
  const result = await recheckAfterTokenInvalidated(user.id, row.id, {
    proxy: null,
    fetchImpl: async () => ({
      status: 200,
      async text() { return JSON.stringify(plusCheck('2026-09-20T12:00:00Z')); },
    }),
  });
  assert.equal(result.status, '正常');
  const saved = db.prepare('SELECT status, token_invalidated, plan_type, activated_at FROM gpt_accounts WHERE id = ?').get(row.id);
  assert.equal(saved.status, '正常');
  assert.equal(saved.token_invalidated, 0);
  assert.equal(saved.plan_type, 'Free');
  assert.equal(String(saved.activated_at || '').trim(), '');
});

test('ACCOUNT_TOKEN_INVALIDATED recheck marks 令牌失效 on 401', async () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const row = insertAccount(user.id, 'recheck-dead@example.test');
  db.prepare("UPDATE gpt_accounts SET activated_at = '2026-08-21 00:00:00', progress = '已支付' WHERE id = ?")
    .run(row.id);
  const result = await recheckAfterTokenInvalidated(user.id, row.id, {
    proxy: null,
    fetchImpl: async () => ({
      status: 401,
      async text() { return JSON.stringify({ detail: 'token_invalidated' }); },
    }),
  });
  assert.equal(result.status, '令牌失效');
  const saved = db.prepare('SELECT status, token_invalidated FROM gpt_accounts WHERE id = ?').get(row.id);
  assert.equal(saved.status, '令牌失效');
  assert.equal(saved.token_invalidated, 1);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
