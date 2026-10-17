const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-nvtokens-settings-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '6'.repeat(64);

const db = require('../src/db');
const prevKey = process.env.NVTOKENS_API_KEY;
const prevSession = process.env.NVTOKENS_SESSION;
delete process.env.NVTOKENS_API_KEY;
delete process.env.NVTOKENS_SESSION;

const { readSettings, writeSettings, publicView } = require('../src/utils/settings');
const router = require('../src/routes/settings');
const { credentials } = require('../src/utils/nvtokensList');

const userId = db.prepare(
  "INSERT INTO users (username, password_hash, role, level) VALUES ('nvtokens-settings', 'x', 'user', 1)"
).run().lastInsertRowid;

const SECRET_SESSION = 'eyJunit.saved-session-token-NOT-FOR-LOGS-zzzz';
const OVERRIDE_SESSION = 'eyJunit.unsaved-override-token-NOT-FOR-LOGS-yyyy';

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

function plusBoardBody() {
  return {
    board: {
      plans: [{
        plan: 'plus',
        available: true,
        inventory_label: '现货充足',
        min_cents: 1750,
        max_cents: 99900,
        avg_cents: 2506,
        p25_cents: 2000,
      }],
    },
  };
}

async function invoke(method, routePath, { body, fetchImpl } = {}) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} should exist`);
  let payload;
  let statusCode = 200;
  const req = { body: body || {}, user: { id: userId }, fetchImpl };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  await layer.route.stack[0].handle(req, res);
  return { statusCode, payload };
}

function assertNoSecretLeak(value) {
  const blob = JSON.stringify(value);
  assert.equal(blob.includes(SECRET_SESSION), false);
  assert.equal(blob.includes(OVERRIDE_SESSION), false);
  assert.equal(blob.includes('NVTOKENS_API_KEY'), false);
  assert.doesNotMatch(blob, /scm_session=/i);
  assert.equal('session_cookie' in (value?.nvtokens || {}), false);
  assert.equal('api_key' in (value?.nvtokens || {}), false);
}

test('settings GET/PUT hide session cookie and expose has_session/last4', async () => {
  const put = await invoke('put', '/nvtokens', {
    body: {
      auto_list_plus: false,
      min_price_yuan: '20.00',
      session_cookie: `scm_session=${SECRET_SESSION}`,
    },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.payload.nvtokens.has_session, true);
  assert.equal(put.payload.nvtokens.session_configured, true);
  assert.equal(put.payload.nvtokens.session_last4, 'zzzz');
  assertNoSecretLeak(put.payload);

  const saved = readSettings(userId);
  assert.equal(saved.nvtokens.session_cookie, SECRET_SESSION);

  const keep = await invoke('put', '/nvtokens', {
    body: { session_cookie: '', auto_list_plus: false },
  });
  assert.equal(keep.statusCode, 200);
  assert.equal(readSettings(userId).nvtokens.session_cookie, SECRET_SESSION);
  assert.equal(keep.payload.nvtokens.session_last4, 'zzzz');
  assertNoSecretLeak(keep.payload);

  const get = await invoke('get', '/');
  assert.equal(get.statusCode, 200);
  assert.equal(get.payload.nvtokens.has_session, true);
  assert.equal(get.payload.nvtokens.session_last4, 'zzzz');
  assertNoSecretLeak(get.payload);
  assert.equal(JSON.stringify(publicView(readSettings(userId))).includes(SECRET_SESSION), false);
});

test('price-board-test uses saved session and returns Plus yuan stats', async () => {
  writeSettings(userId, {
    nvtokens: { session_cookie: SECRET_SESSION, api_key: 'irk-should-not-be-sent' },
  });
  const seen = [];
  const { statusCode, payload } = await invoke('post', '/nvtokens/price-board-test', {
    fetchImpl: mockFetch((url, options) => {
      seen.push({ url, headers: options.headers || {} });
      if (url.includes('/api/pool/price-board')) {
        return { status: 200, body: plusBoardBody() };
      }
      if (url.includes('/api/merchant-rankings')) {
        return {
          status: 200,
          body: {
            rankings: [
              { sale_plan_stats: { plus: { available_count: 3 } } },
              { sale_plan_counts: { plus: 0 } },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    }),
  });
  assert.equal(statusCode, 200);
  assert.deepEqual(payload, {
    ok: true,
    min: '17.50',
    max: '999.00',
    avg: '25.06',
    p25: '20.00',
    inventory_label: '现货充足',
    merchants: 1,
    text: 'Plus 最低 17.50 – 最高 999.00 – 均价 25.06 – P25 20.00 – 库存 现货充足，商家 1',
  });
  assertNoSecretLeak(payload);
  const board = seen.find((item) => item.url.includes('/api/pool/price-board'));
  assert.ok(board);
  assert.equal(board.headers.cookie, `scm_session=${SECRET_SESSION}`);
  assert.equal(board.headers['x-api-key'], undefined);
  assert.equal(credentials(readSettings(userId)).session, SECRET_SESSION);
});

test('price-board-test prefers unsaved body.session override', async () => {
  writeSettings(userId, { nvtokens: { session_cookie: SECRET_SESSION } });
  const cookies = [];
  const { statusCode, payload } = await invoke('post', '/nvtokens/price-board-test', {
    body: { session: OVERRIDE_SESSION },
    fetchImpl: mockFetch((url, options) => {
      cookies.push(options.headers?.cookie || '');
      if (url.includes('/api/pool/price-board')) {
        return { status: 200, body: plusBoardBody() };
      }
      if (url.includes('/api/merchant-rankings')) {
        return { status: 200, body: { rankings: [] } };
      }
      return { status: 404, body: {} };
    }),
  });
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.min, '17.50');
  assert.ok(cookies.every((cookie) => cookie === `scm_session=${OVERRIDE_SESSION}`));
  assert.equal(readSettings(userId).nvtokens.session_cookie, SECRET_SESSION);
  assertNoSecretLeak(payload);
});

test('price-board-test maps nvtokens 401 to 请重新填写 token', async () => {
  writeSettings(userId, { nvtokens: { session_cookie: SECRET_SESSION } });
  const { statusCode, payload } = await invoke('post', '/nvtokens/price-board-test', {
    fetchImpl: mockFetch((url) => {
      if (url.includes('/api/pool/price-board')) {
        return { status: 401, body: { error: 'unauthorized', cookie: SECRET_SESSION } };
      }
      return { status: 401, body: {} };
    }),
  });
  assert.equal(statusCode, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.message, '价格查询 token 已失效，请重新填写');
  assertNoSecretLeak(payload);
});

test('price-board-test requires a session', async () => {
  delete process.env.NVTOKENS_API_KEY;
  delete process.env.NVTOKENS_SESSION;
  writeSettings(userId, { nvtokens: { session_cookie: '', api_key: '' } });
  const { statusCode, payload } = await invoke('post', '/nvtokens/price-board-test', {
    body: {},
    fetchImpl: mockFetch(() => ({ status: 500, body: {} })),
  });
  assert.equal(statusCode, 400);
  assert.equal(payload.ok, false);
  assert.equal(payload.message, '请先填写或保存价格查询 Token');
});

test.after(() => {
  if (prevKey !== undefined) process.env.NVTOKENS_API_KEY = prevKey;
  else delete process.env.NVTOKENS_API_KEY;
  if (prevSession !== undefined) process.env.NVTOKENS_SESSION = prevSession;
  else delete process.env.NVTOKENS_SESSION;
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
