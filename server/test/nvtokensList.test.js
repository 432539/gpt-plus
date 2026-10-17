const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-nvtokens-list-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '8'.repeat(64);
const prevKey = process.env.NVTOKENS_API_KEY;
const prevSession = process.env.NVTOKENS_SESSION;
delete process.env.NVTOKENS_API_KEY;
delete process.env.NVTOKENS_SESSION;

const db = require('../src/db');
const { toColumns } = require('../src/utils/accountFields');
const { writeSettings } = require('../src/utils/settings');
const { resolveListPrice } = require('../src/utils/nvtokensPool');
const {
  LIST_ATTEMPT_CAP, listIfEligible, sweepUser, credentials,
} = require('../src/utils/nvtokensList');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

function insertAccount(email, extra = {}) {
  const cols = toColumns({
    email,
    password: 'pw',
    access_token: extra.access_token === undefined ? 'at-live' : extra.access_token,
    refresh_token: extra.refresh_token || '',
    plan_type: extra.plan_type || 'Free',
  });
  const info = db.prepare(
    `INSERT INTO gpt_accounts
     (user_id, email, password_enc, email_type, plan_type, status, access_token, refresh_token, nvtokens_listed_at, nvtokens_list_attempts)
     VALUES (?, ?, ?, 'gmail', ?, '正常', ?, ?, ?, ?)`
  ).run(
    user.id,
    cols.email,
    cols.password_enc,
    cols.plan_type,
    extra.access_token === '' ? '' : cols.access_token,
    extra.refresh_token ? cols.refresh_token : '',
    extra.listed_at || '',
    extra.list_attempts || 0,
  );
  return db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(info.lastInsertRowid);
}

function enableAutoList(min = '20.00') {
  writeSettings(user.id, {
    nvtokens: {
      auto_list_plus: true,
      min_price_yuan: min,
      api_key: 'irk-unit-test-inventory',
      session_cookie: 'dummy-scm-session',
    },
  });
}

function mockFetch(handler) {
  return async (url, options = {}) => {
    const result = handler(String(url), options) || { status: 404, body: { error: 'missing' } };
    return {
      status: result.status,
      async text() {
        return typeof result.body === 'string' ? result.body : JSON.stringify(result.body || {});
      },
    };
  };
}

test('auto-list skips non-Plus, no RT, and already listed', async () => {
  enableAutoList();
  const freeRt = insertAccount('free-rt@example.test', { plan_type: 'Free', refresh_token: 'rt' });
  const plusNoRt = insertAccount('plus-nort@example.test', { plan_type: 'Plus', refresh_token: '' });
  const listed = insertAccount('plus-listed@example.test', {
    plan_type: 'Plus', refresh_token: 'rt', listed_at: '2026-08-21 00:00:00',
  });
  const calls = [];
  const fetchImpl = mockFetch((url, options) => {
    calls.push(url);
    assert.equal(JSON.stringify(options.headers || {}).includes('dummy-scm-session'), true);
    return { status: 200, body: { board: { plans: [] } } };
  });
  assert.equal((await listIfEligible(user.id, freeRt.id, { fetchImpl })).reason, 'not_listable');
  assert.equal((await listIfEligible(user.id, plusNoRt.id, { fetchImpl })).reason, 'not_listable');
  assert.equal((await listIfEligible(user.id, listed.id, { fetchImpl })).reason, 'listed');
  assert.equal(calls.some((url) => url.includes('/api/inventory/cards/pool')), false);
});

test('list price is board min only and never example 10', async () => {
  enableAutoList('20.00');
  const plus = insertAccount('plus-rt@example.test', { plan_type: 'Plus', refresh_token: 'rt' });
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/api/pool/price-board')) {
      return {
        status: 200,
        body: { board: { plans: [{ plan: 'plus', min_cents: 1800, p25_cents: 2500, median_cents: 2800 }] } },
      };
    }
    if (url.includes('/api/inventory/cards/pool')) {
      return { status: 200, body: { ok: true, id: 'card-1' } };
    }
    return { status: 404, body: {} };
  });
  const result = await listIfEligible(user.id, plus.id, { fetchImpl });
  assert.equal(result.listed, true);
  assert.equal(result.price_yuan, '18.00');
  assert.notEqual(result.price_yuan, '10.00');
  assert.notEqual(result.price_yuan, '25.00');
  const saved = db.prepare('SELECT nvtokens_listed_at FROM gpt_accounts WHERE id = ?').get(plus.id);
  assert.ok(String(saved.nvtokens_listed_at || '').trim());
  const sync = db.prepare(
    'SELECT email, kind, price_yuan, remote_id, remote_ok FROM account_syncs WHERE email = ?'
  ).get('plus-rt@example.test');
  assert.equal(sync.kind, 'plus');
  assert.equal(sync.price_yuan, '18.00');
  assert.equal(sync.remote_id, 'card-1');
  assert.equal(sync.remote_ok, 1);
  const again = await listIfEligible(user.id, plus.id, { fetchImpl });
  assert.equal(again.reason, 'listed');
});

test('401/422 count toward list attempt cap and stop looping', async () => {
  enableAutoList('20.00');
  const plus = insertAccount('plus-422@example.test', { plan_type: 'Plus', refresh_token: 'rt' });
  let posts = 0;
  const fetchImpl = mockFetch((url) => {
    if (url.includes('/api/pool/price-board')) {
      return { status: 200, body: { board: { plans: [{ plan: 'plus', min_cents: 1800, p25_cents: 1800 }] } } };
    }
    if (url.includes('/api/inventory/cards/pool')) {
      posts += 1;
      return { status: 422, body: { error: 'invalid_codex' } };
    }
    return { status: 404, body: {} };
  });
  for (let i = 0; i < 5; i += 1) {
    await listIfEligible(user.id, plus.id, { plus: { p25_cents: 1800, min_cents: 1800 }, fetchImpl });
  }
  assert.equal(posts, LIST_ATTEMPT_CAP);
  const saved = db.prepare('SELECT nvtokens_listed_at, nvtokens_list_attempts FROM gpt_accounts WHERE id = ?').get(plus.id);
  assert.equal(String(saved.nvtokens_listed_at || '').trim(), '');
  assert.equal(saved.nvtokens_list_attempts, LIST_ATTEMPT_CAP);
});

test('listing POST disables fallback pool even if nvtokens default is on', async () => {
  enableAutoList('20.00');
  const plus = insertAccount('plus-no-fallback@example.test', { plan_type: 'Plus', refresh_token: 'rt' });
  const patches = [];
  const bodies = [];
  const fetchImpl = mockFetch((url, options) => {
    if (url.includes('/api/pool/price-board')) {
      return { status: 200, body: { board: { plans: [{ plan: 'plus', min_cents: 1800, p25_cents: 2000 }] } } };
    }
    if (url.includes('/api/supplier/settings') && (!options.method || options.method === 'GET')) {
      return {
        status: 200,
        body: { settings: { default_warranty_channel_id: 'chan-1', fallback_pool_enabled: true } },
      };
    }
    if (url.includes('/api/supplier/settings') && String(options.method || '').toUpperCase() === 'PATCH') {
      patches.push(JSON.parse(options.body));
      return { status: 200, body: { settings: { fallback_pool_enabled: false } } };
    }
    if (url.includes('/api/inventory/cards/pool')) {
      bodies.push(JSON.parse(options.body));
      return { status: 200, body: { ok: true, id: 'card-direct' } };
    }
    return { status: 404, body: {} };
  });
  const result = await listIfEligible(user.id, plus.id, { fetchImpl });
  assert.equal(result.listed, true);
  assert.equal(result.price_yuan, '18.00');
  assert.equal(patches.length, 1);
  assert.equal(patches[0].fallback_pool_enabled, false);
  assert.equal(bodies[0].fallback_pool_enabled, false);
  assert.equal(bodies[0].price_yuan, '18.00');
  assert.equal('fallback_pool_multiplier' in bodies[0], false);
});

test('sweep uses min price when board session is missing', async () => {
  const prevSession = process.env.NVTOKENS_SESSION;
  delete process.env.NVTOKENS_SESSION;
  try {
    writeSettings(user.id, {
      nvtokens: {
        auto_list_plus: true,
        min_price_yuan: '21.00',
        api_key: 'irk-unit-test-inventory',
        session_cookie: '',
      },
    });
    const plus = insertAccount('plus-min-only@example.test', { plan_type: 'Plus', refresh_token: 'rt' });
    const urls = [];
    const bodies = [];
    const fetchImpl = mockFetch((url, options) => {
      urls.push(url);
      if (url.includes('/api/inventory/cards/pool')) {
        bodies.push(JSON.parse(options.body));
        return { status: 200, body: { ok: true } };
      }
      return { status: 200, body: {} };
    });
    const summary = await sweepUser(user.id, { fetchImpl });
    assert.equal(summary.listed, 1);
    assert.equal(urls.some((url) => url.includes('/api/pool/price-board')), false);
    assert.equal(bodies[0].price_yuan, '21.00');
    assert.equal(bodies[0].fallback_pool_enabled, false);
    assert.equal('fallback_pool_multiplier' in bodies[0], false);
    assert.equal(bodies[0].data.type, 'codex');
    assert.equal(bodies[0].data.email, plus.email);
    assert.equal(JSON.stringify(bodies[0]).includes('0.08'), false);
    assert.equal(JSON.stringify(bodies[0]).includes('irk-unit-test-inventory'), false);
  } finally {
    if (prevSession !== undefined) process.env.NVTOKENS_SESSION = prevSession;
    else delete process.env.NVTOKENS_SESSION;
  }
});

test('sweep and list stay off unless auto_list_plus or manual', async () => {
  writeSettings(user.id, {
    nvtokens: {
      auto_list_plus: false,
      min_price_yuan: '21.00',
      api_key: 'irk-unit-test-inventory',
      session_cookie: '',
    },
  });
  const plus = insertAccount('plus-manual-only@example.test', { plan_type: 'Plus', refresh_token: 'rt' });
  const fetchImpl = mockFetch((url, options) => {
    if (url.includes('/api/inventory/cards/pool')) {
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: {} };
  });
  assert.equal((await sweepUser(user.id, { fetchImpl })).reason, 'off');
  assert.equal((await listIfEligible(user.id, plus.id, { fetchImpl })).reason, 'off');
  const listed = await sweepUser(user.id, { fetchImpl, manual: true });
  assert.equal(listed.listed, 1);
  assert.ok(String(db.prepare('SELECT nvtokens_listed_at FROM gpt_accounts WHERE id = ?').get(plus.id).nvtokens_listed_at || '').trim());
});

test('tick and kick no longer auto-list', async () => {
  enableAutoList('20.00');
  insertAccount('plus-auto-dead@example.test', { plan_type: 'Plus', refresh_token: 'rt' });
  const { tick, kick, startPoller } = require('../src/utils/nvtokensList');
  assert.deepEqual(await tick(), []);
  assert.equal(kick(user.id), undefined);
  assert.equal(startPoller(), null);
  assert.equal(String(db.prepare(
    "SELECT nvtokens_listed_at FROM gpt_accounts WHERE email = 'plus-auto-dead@example.test'"
  ).get().nvtokens_listed_at || '').trim(), '');
});

test('resolveListPrice never falls back to example 10 yuan', () => {
  assert.equal(resolveListPrice('', null), '20.00');
  assert.equal(resolveListPrice('20.00', { p25_cents: 1800, min_cents: 1500 }), '15.00');
  assert.equal(resolveListPrice('21.00', { p25_cents: 2500, min_cents: 0 }), '21.00');
});

test('settings session is the source of truth over NVTOKENS_SESSION', () => {
  const prev = process.env.NVTOKENS_SESSION;
  process.env.NVTOKENS_SESSION = 'env-session-should-lose';
  try {
    writeSettings(user.id, { nvtokens: { session_cookie: 'settings-session-wins' } });
    assert.equal(credentials(require('../src/utils/settings').readSettings(user.id)).session, 'settings-session-wins');
    writeSettings(user.id, { nvtokens: { session_cookie: '' } });
    assert.equal(credentials(require('../src/utils/settings').readSettings(user.id)).session, 'env-session-should-lose');
  } finally {
    if (prev !== undefined) process.env.NVTOKENS_SESSION = prev;
    else delete process.env.NVTOKENS_SESSION;
  }
});

test.after(() => {
  if (prevKey !== undefined) process.env.NVTOKENS_API_KEY = prevKey;
  else delete process.env.NVTOKENS_API_KEY;
  if (prevSession !== undefined) process.env.NVTOKENS_SESSION = prevSession;
  else delete process.env.NVTOKENS_SESSION;
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
