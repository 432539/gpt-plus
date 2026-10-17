const test = require('node:test');
const assert = require('node:assert/strict');
const {
  toPoolData,
  toPoolPayload,
  plusMerchantCount,
  summarizePlusPlan,
  suggestListPrice,
  resolveListPrice,
  isListablePlusAccount,
  maskApiKey,
  redact,
  cookieHeader,
  normalizeSessionCookie,
  sessionLast4,
  testPlusPriceBoard,
  disableFallbackPoolDefault,
} = require('../src/utils/nvtokensPool');

test('Sub2 account maps to CPA-style pool data', () => {
  const data = toPoolData({
    platform: 'openai',
    type: 'oauth',
    name: 'plus@example.test',
    credentials: {
      access_token: 'at-real',
      refresh_token: 'rt-real',
      email: 'plus@example.test',
      plan_type: 'Plus',
      chatgpt_account_id: 'acct-1',
      expires_at: '2027-01-01T00:00:00Z',
    },
    extra: { email: 'plus@example.test' },
  });
  assert.equal(data.type, 'codex');
  assert.equal(data.access_token, 'at-real');
  assert.equal(data.refresh_token, 'rt-real');
  assert.equal(data.email, 'plus@example.test');
  assert.equal(data.account_id, 'acct-1');
  assert.equal(data.plan_type, 'Plus');
});

test('CPA object and pool wrapper stay flat under data', () => {
  const cpa = toPoolPayload({
    type: 'codex',
    email: 'cpa@example.test',
    access_token: 'access-a',
    refresh_token: 'refresh-a',
  }, 20);
  assert.equal(cpa.price_yuan, '20.00');
  assert.equal(cpa.fallback_pool_enabled, false);
  assert.equal('fallback_pool_multiplier' in cpa, false);
  assert.equal(cpa.data.type, 'codex');
  assert.equal(cpa.data.email, 'cpa@example.test');
  assert.equal(toPoolData({ data: cpa.data }).email, 'cpa@example.test');
});

test('full Sub2 export is nested under data without flattening', () => {
  const document = {
    exported_at: '2026-08-21T00:00:00.000Z',
    proxies: [],
    accounts: [{
      platform: 'openai',
      type: 'oauth',
      name: 'plus@example.test',
      credentials: { access_token: 'at-real', refresh_token: 'rt-real', email: 'plus@example.test' },
      extra: { email: 'plus@example.test' },
    }],
  };
  const payload = toPoolPayload(document, '20.00');
  assert.equal(payload.data.accounts.length, 1);
  assert.equal(payload.fallback_pool_enabled, false);
  assert.equal(payload.data.accounts[0].type, 'oauth');
  assert.equal(payload.data.proxies.length, 0);
});

test('Plus merchant count uses sale_plan_counts/stats', () => {
  const n = plusMerchantCount({
    rankings: [
      { sale_plan_counts: { plus: 2 }, sale_plan_stats: { plus: { available_count: 2 } } },
      { sale_plan_counts: { plus: 0 }, sale_plan_stats: { plus: { available_count: 0 } } },
      { sale_plan_counts: { plus: 1 } },
    ],
  });
  assert.equal(n, 2);
});

test('list price uses board min/floor and ignores user min when board exists', () => {
  const plus = summarizePlusPlan({
    plan: 'plus', min_cents: 1799, p25_cents: 2000, median_cents: 2288, avg_cents: 2541, max_cents: 99900,
  });
  assert.equal(plus.min_yuan, '17.99');
  assert.equal(suggestListPrice(plus), '17.99');
  assert.equal(suggestListPrice(plus, 'p25'), '20.00');
  assert.equal(suggestListPrice(plus, 'floor'), '17.99');
  assert.equal(resolveListPrice('20.00', plus), '17.99');
  assert.equal(resolveListPrice('18.00', plus), '17.99');
  assert.equal(resolveListPrice('25.00', plus), '17.99');
  assert.equal(resolveListPrice('20.00', null), '20.00');
  assert.notEqual(resolveListPrice('', null), '10.00');
  assert.equal(isListablePlusAccount({ plan_type: 'Plus', refresh_token: 'rt' }), true);
  assert.equal(isListablePlusAccount({ plan_type: 'Plus', access_token: 'at' }), false);
  assert.equal(isListablePlusAccount({ plan_type: 'Free', refresh_token: 'rt' }), false);
  assert.equal(isListablePlusAccount({ refresh_token: 'rt' }), false);
  assert.equal(maskApiKey('irk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'irk-****aaaa');
  assert.equal(redact({ access_token: 'secret-token', ok: true }).access_token, 'REDACTED:12');
  assert.equal(redact({ access_token: 'secret-token', ok: true }).ok, true);
});

test('cookie helper stores raw token and last4 only', () => {
  const token = 'eyJsession-token-value-abcd';
  assert.equal(normalizeSessionCookie(`Cookie: scm_session=${token}`), token);
  assert.equal(sessionLast4(`scm_session=${token}`), 'abcd');
  assert.deepEqual(cookieHeader(token), { cookie: `scm_session=${token}` });
});

test('testPlusPriceBoard returns yuan range and maps 401', async () => {
  const token = 'unit-session-token-xxxx';
  const fetchOk = async (url, options) => {
    assert.match(options.headers.cookie, /^scm_session=unit-session-token-xxxx$/);
    assert.equal(options.headers['x-api-key'], undefined);
    if (String(url).includes('/api/pool/price-board')) {
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            board: { plans: [{ plan: 'plus', inventory_label: '现货充足', min_cents: 1799, max_cents: 99900, avg_cents: 2541, p25_cents: 2000 }] },
          });
        },
      };
    }
    return {
      status: 200,
      async text() {
        return JSON.stringify({ rankings: [{ sale_plan_stats: { plus: { available_count: 1 } } }] });
      },
    };
  };
  const ok = await testPlusPriceBoard({ session: token, fetchImpl: fetchOk });
  assert.deepEqual(ok, {
    ok: true,
    min: '17.99',
    max: '999.00',
    avg: '25.41',
    p25: '20.00',
    inventory_label: '现货充足',
    merchants: 1,
    text: 'Plus 最低 17.99 – 最高 999.00 – 均价 25.41 – P25 20.00 – 库存 现货充足，商家 1',
  });
  assert.equal(JSON.stringify(ok).includes(token), false);

  const expired = await testPlusPriceBoard({
    session: token,
    fetchImpl: async () => ({ status: 401, async text() { return '{"error":"unauthorized"}'; } }),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.message, '价格查询 token 已失效，请重新填写');
});

test('direct sale payload never enables fallback pool or 0.08 multiplier', () => {
  const payload = toPoolPayload({
    type: 'codex',
    email: 'sale@example.test',
    access_token: 'at',
    refresh_token: 'rt',
  }, '21.00');
  assert.equal(payload.price_yuan, '21.00');
  assert.equal(payload.fallback_pool_enabled, false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'fallback_pool_multiplier'), false);
  assert.equal(JSON.stringify(payload).includes('0.08'), false);
  assert.equal(JSON.stringify(payload).includes('0.0800'), false);
});

test('disableFallbackPoolDefault PATCHes only when the checkbox is on', async () => {
  const token = 'unit-session-token-yyyy';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
    assert.match(options.headers.cookie, /^scm_session=unit-session-token-yyyy$/);
    assert.equal(options.headers['x-api-key'], undefined);
    if (String(url).includes('/api/supplier/settings') && (!options.method || options.method === 'GET')) {
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            settings: {
              default_warranty_channel_id: 'chan-1',
              fallback_pool_enabled: true,
              fallback_pool_multiplier: 0.08,
            },
          });
        },
      };
    }
    if (String(url).includes('/api/supplier/settings') && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      assert.equal(body.fallback_pool_enabled, false);
      assert.equal(body.default_warranty_channel_id, 'chan-1');
      assert.equal('fallback_pool_multiplier' in body, false);
      return { status: 200, async text() { return JSON.stringify({ settings: body }); } };
    }
    return { status: 404, async text() { return '{}'; } };
  };
  const patched = await disableFallbackPoolDefault({ session: token, fetchImpl });
  assert.equal(patched.ok, true);
  assert.equal(patched.skipped, false);
  assert.equal(patched.fallback_pool_enabled, false);
  assert.equal(calls.filter((item) => item.method === 'PATCH').length, 1);

  const alreadyOff = await disableFallbackPoolDefault({
    session: token,
    fetchImpl: async (url, options = {}) => {
      assert.equal(options.method || 'GET', 'GET');
      return {
        status: 200,
        async text() {
          return JSON.stringify({ settings: { fallback_pool_enabled: false } });
        },
      };
    },
  });
  assert.equal(alreadyOff.ok, true);
  assert.equal(alreadyOff.reason, 'already_off');
});
