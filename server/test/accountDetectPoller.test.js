const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-detect-poller-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '3'.repeat(64);

const db = require('../src/db');
const { toColumns } = require('../src/utils/accountFields');
const { writeSettings } = require('../src/utils/settings');
const {
  tick,
  selectTargets,
  selectTrialUnsetTargets,
  resetPollerState,
  REGISTER_DETECT_GRACE_HOURS,
  TRIAL_UNSET_POLL_MS,
} = require('../src/utils/accountDetectPoller');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const TWO_MIN = TRIAL_UNSET_POLL_MS;

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

function plusCheck() {
  return {
    account_ordering: ['acc-1'],
    accounts: {
      'acc-1': {
        account: { plan_type: 'plus' },
        entitlement: {
          subscription_plan: 'chatgptplusplan',
          has_active_subscription: true,
          billing_period: 'monthly',
          expires_at: '2026-09-20T00:00:00Z',
        },
      },
    },
  };
}

function insertAccount(email, extra = {}) {
  const cols = toColumns({
    email,
    password: 'pw',
    access_token: extra.access_token === undefined ? 'access-token' : extra.access_token,
    status: extra.status || '正常',
    plan_type: extra.plan_type || 'Free',
    has_trial: extra.has_trial,
  });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts
     (user_id, email, password_enc, email_type, plan_type, status, access_token, has_trial, trial_label, created_at)
     VALUES (?, ?, ?, 'gmail', ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    cols.email,
    cols.password_enc,
    cols.plan_type,
    cols.status,
    extra.access_token === '' ? '' : cols.access_token,
    extra.has_trial === 0 || extra.has_trial === 1 ? extra.has_trial : null,
    extra.trial_label || '',
    extra.created_at || db.prepare("SELECT datetime('now','localtime') AS t").get().t,
  );
  return db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
}

function writeCliproxy(minutes = 0, extraAccounts = {}) {
  writeSettings(user.id, {
    accounts: { detect_poll_minutes: minutes, detect_proxy_group: extraAccounts.detect_proxy_group ?? 'detect' },
    dynamic_proxy: {
      active_pool: 'cliproxy',
      providers: {
        cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 },
      },
    },
  });
}

function ensureDetectProxy(minutes = 0) {
  writeCliproxy(minutes);
  const existing = db.prepare('SELECT id FROM proxies WHERE user_id = ? AND group_name = ?').get(user.id, 'detect');
  if (existing) return;
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status)
     VALUES (?, 'detect', 'http', '127.0.0.1', 9, '', '', '可用')`
  ).run(user.id);
}

function clearAccounts() {
  db.prepare('DELETE FROM gpt_accounts').run();
}

function mockFetch(payload, onCall) {
  return async (url) => {
    if (typeof onCall === 'function') onCall(url);
    return {
      status: 200,
      async text() { return JSON.stringify(payload); },
    };
  };
}

test('trial-unset select includes fresh 未检测 rows and skips known trial / no token', () => {
  const fresh = insertAccount('fresh-unset@example.test');
  const known = insertAccount('known-trial@example.test', { has_trial: 1 });
  const noToken = insertAccount('no-token@example.test', { access_token: '' });
  const old = insertAccount('old-unset@example.test', {
    created_at: db.prepare("SELECT datetime('now','localtime','-13 hours') AS t").get().t,
  });
  const unsetIds = selectTrialUnsetTargets(user.id);
  const unsetEmails = unsetIds.map((id) => db.prepare('SELECT email FROM gpt_accounts WHERE id=?').get(id).email);
  assert.equal(unsetEmails.includes(fresh.email), true);
  assert.equal(unsetEmails.includes(old.email), true);
  assert.equal(unsetEmails.includes(known.email), false);
  assert.equal(unsetEmails.includes(noToken.email), false);
  assert.equal(selectTargets(user.id, true).includes(fresh.id), true);

  const liveIds = selectTargets(user.id, false);
  const liveEmails = liveIds.map((id) => db.prepare('SELECT email FROM gpt_accounts WHERE id=?').get(id).email);
  assert.equal(liveEmails.includes(fresh.email), false);
  assert.equal(liveEmails.includes(old.email), true);
  assert.equal(REGISTER_DETECT_GRACE_HOURS, 12);
  assert.equal(TWO_MIN, 2 * 60 * 1000);
});

test('detect_poll_minutes=0 still polls 未检测 every 2 minutes', async () => {
  ensureDetectProxy(0);
  resetPollerState();
  clearAccounts();
  const row = insertAccount('trial-poll@example.test');
  const known = insertAccount('liveness-should-skip@example.test', {
    has_trial: 0,
    created_at: db.prepare("SELECT datetime('now','localtime','-13 hours') AS t").get().t,
  });
  const seen = [];
  const fetchImpl = mockFetch(freeCheck(), (url) => seen.push(url));

  const first = await tick({ nowMs: 1, fetchImpl, skipDump: true });
  const mine = first.find((item) => item.userId === user.id);
  assert.equal(mine.dueLiveness, false);
  assert.equal(mine.dueTrialUnset, true);
  assert.equal(mine.liveness, null);
  assert.ok(mine.trial.target >= 1);
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id).has_trial, 0);
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(known.id).has_trial, 0);
  assert.equal(seen.length, 1);

  seen.length = 0;
  const second = await tick({ nowMs: 1 + TWO_MIN - 1, fetchImpl, skipDump: true });
  assert.equal(second.find((item) => item.userId === user.id).dueTrialUnset, false);
  assert.equal(seen.length, 0);

  const leftover = insertAccount('still-unset@example.test');
  seen.length = 0;
  const third = await tick({ nowMs: 1 + TWO_MIN, fetchImpl, skipDump: true });
  const thirdMine = third.find((item) => item.userId === user.id);
  assert.equal(thirdMine.dueLiveness, false);
  assert.equal(thirdMine.dueTrialUnset, true);
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(leftover.id).has_trial, 0);
  assert.equal(selectTrialUnsetTargets(user.id).includes(leftover.id), false);
  assert.equal(selectTrialUnsetTargets(user.id).includes(row.id), false);
  assert.equal(seen.length, 1);
});

test('transport errors leave 未检测 for the next trial tick', async () => {
  ensureDetectProxy(0);
  resetPollerState();
  clearAccounts();
  const row = insertAccount('trial-transport@example.test');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error('ECONNRESET');
  };
  await tick({ nowMs: 10, fetchImpl, skipDump: true });
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id).has_trial, null);
  assert.equal(selectTrialUnsetTargets(user.id).includes(row.id), true);
  assert.equal(calls, 1);
  await tick({ nowMs: 10 + TWO_MIN, fetchImpl, skipDump: true });
  assert.equal(calls, 2);
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id).has_trial, null);
});

test('liveness interval stays independent of the 2-minute trial-unset poll', async () => {
  ensureDetectProxy(15);
  resetPollerState();
  clearAccounts();
  insertAccount('old-known-live@example.test', {
    has_trial: 1,
    created_at: db.prepare("SELECT datetime('now','localtime','-13 hours') AS t").get().t,
  });
  const seen = [];
  const fetchImpl = mockFetch(freeCheck(), () => seen.push('check'));
  const first = await tick({ nowMs: 100, fetchImpl, skipDump: true });
  const mine = first.find((item) => item.userId === user.id);
  assert.equal(mine.dueLiveness, true);
  assert.equal(mine.dueTrialUnset, true);
  assert.equal(mine.trial.target, 0);
  assert.equal(seen.length, 1);
  seen.length = 0;
  const second = await tick({ nowMs: 100 + TWO_MIN, fetchImpl, skipDump: true });
  const secondMine = second.find((item) => item.userId === user.id);
  assert.equal(secondMine.dueLiveness, false);
  assert.equal(secondMine.dueTrialUnset, true);
  assert.equal(seen.length, 0);
});

function clearCliproxy(minutes = 0, detectGroup = '') {
  writeSettings(user.id, {
    accounts: { detect_poll_minutes: minutes, detect_proxy_group: detectGroup },
    dynamic_proxy: {
      active_pool: '',
      providers: { cliproxy: { username: '', password: '' } },
    },
  });
}

test('empty detect_proxy_group does not fall back to direct HTTP', async () => {
  clearCliproxy(0, '');
  resetPollerState();
  clearAccounts();
  const row = insertAccount('direct-unset@example.test');
  const first = await tick({ nowMs: 30, fetchImpl: mockFetch(freeCheck()), skipDump: true });
  const mine = first.find((item) => item.userId === user.id);
  assert.equal(mine.trial.skipped, true);
  assert.equal(mine.trial.reason, 'dynamic_proxy_not_configured');
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id).has_trial, null);
});

test('trial-only poller does not stamp Plus without activated_at', async () => {
  ensureDetectProxy(0);
  resetPollerState();
  clearAccounts();
  const row = insertAccount('no-plus-stamp@example.test');
  db.prepare("UPDATE gpt_accounts SET progress = '已支付', activated_at = '' WHERE id = ?").run(row.id);
  await tick({ nowMs: 20, fetchImpl: mockFetch(plusCheck()), skipDump: true });
  const saved = db.prepare('SELECT has_trial, plan_type, activated_at FROM gpt_accounts WHERE id=?').get(row.id);
  assert.equal(saved.has_trial, 0);
  assert.equal(saved.plan_type, 'Free');
  assert.equal(String(saved.activated_at || '').trim(), '');
});
test('empty-string has_trial is treated as 未检测 and polled', async () => {
  writeCliproxy(0, { detect_proxy_group: '' });
  resetPollerState();
  clearAccounts();
  const row = insertAccount('blank-trial@example.test');
  db.prepare('UPDATE gpt_accounts SET has_trial = ? WHERE id = ?').run('', row.id);
  assert.equal(selectTrialUnsetTargets(user.id).includes(row.id), true);
  await tick({ nowMs: 40, fetchImpl: mockFetch(freeCheck()), skipDump: true });
  const saved = db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id);
  assert.equal(saved.has_trial, 0);
});

test('trial-only still runs when a Cloak detect job is marked running', async () => {
  writeCliproxy(0, { detect_proxy_group: '' });
  resetPollerState();
  clearAccounts();
  const row = insertAccount('detect-lock@example.test');
  const first = await tick({
    nowMs: 50,
    fetchImpl: mockFetch(freeCheck()),
    skipDump: true,
    jobStatus: () => ({ running: true }),
  });
  const mine = first.find((item) => item.userId === user.id);
  assert.equal(mine.dueTrialUnset, true);
  assert.equal(mine.trial.skipped, false);
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id).has_trial, 0);
});

test('poller tick never auto-dumps 无试用 or 未检测 accounts', async () => {
  writeCliproxy(15);
  writeSettings(user.id, {
    accounts: { detect_poll_minutes: 15 },
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
    dynamic_proxy: {
      active_pool: 'cliproxy',
      providers: { cliproxy: { username: 'clip-user', password: 'clip-secret', sticky_minutes: 30 } },
    },
  });
  resetPollerState();
  clearAccounts();
  const unset = insertAccount('poller-unset@example.test', { has_trial: null });
  const noTrial = insertAccount('poller-no-trial@example.test', { has_trial: 0 });
  let importPosts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('import-api')) {
      importPosts += 1;
      return { status: 200, async text() { return JSON.stringify({ ok: true, imported: 1 }); } };
    }
    return mockFetch(freeCheck())(url, options);
  };
  await tick({ nowMs: 70, fetchImpl });
  assert.equal(importPosts, 0);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id=?').get(unset.id));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id=?').get(noTrial.id));
});

test('pay detect_proxy_group does not fall back to 支付组 or direct', async () => {
  clearCliproxy(0, '支付');
  resetPollerState();
  clearAccounts();
  const row = insertAccount('pay-group-direct@example.test');
  const first = await tick({ nowMs: 60, fetchImpl: mockFetch(freeCheck()), skipDump: true });
  const mine = first.find((item) => item.userId === user.id);
  assert.equal(mine.trial.skipped, true);
  assert.equal(mine.trial.reason, 'dynamic_proxy_not_configured');
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id=?').get(row.id).has_trial, null);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
