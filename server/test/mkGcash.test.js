'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECKOUT_BASE,
  isAdyenCheckoutRedirect,
  extractCpmt,
  checkoutAmount,
  fallbackQrPng,
  PNG_SIGNATURE,
  extractRedirectResult,
  payloadStatus,
  activePlusEntitlement,
  PLAN_NAME,
  PROMO_CAMPAIGN,
  parseProxy,
  proxyUrl,
  ensureFullChainProxySupported,
  retryDecision,
} = require('../src/mkGcash/protocol');
const { GCashChain } = require('../src/mkGcash/gcashChain');
const { parseAccounts, parseProxyPool } = require('../src/mkGcash/appApi');
const { GCashSessionManager } = require('../src/mkGcash/gcashChain');
const { PaymentMonitorManager } = require('../src/mkGcash/paymentMonitor');
const { toChainProxy, needsHttpBridge } = require('../src/mkGcash/proxyAdapt');
const { buildProxyUrl } = require('../src/utils/mailcomProxy');

function checkoutResponse() {
  return {
    checkout_session_id: 'oaics_fixture',
    processor_entity: 'openai_llc',
    checkout_session: {
      amount_total: 0,
      custom_payment_methods: [
        { id: 'cpmt_fixture', options: { type: 'static' } },
      ],
    },
  };
}

test('MK protocol: create body has plus-1-month-free and confirm uses checkout_session_approval', async () => {
  const requests = [];
  const sentinelCalls = [];
  const chain = new GCashChain({
    token: 'fixture-token',
    clientAccountId: 'fixture-client',
    accountId: 'fixture-account',
    billingEmail: 'holder@example.com',
    billingName: 'Fixture Holder',
    requestImpl: async (method, url, headers, data) => {
      requests.push({ method, url, headers: { ...headers }, body: data });
      if (url === CHECKOUT_BASE) {
        if (requests.filter((item) => item.url === CHECKOUT_BASE).length === 1) {
          throw new Error('HTTP 400 unusual activity');
        }
        return { json: checkoutResponse(), headers: {} };
      }
      if (url.endsWith('/taxes')) return { json: checkoutResponse(), headers: {} };
      if (url.endsWith('/confirm')) {
        return {
          json: { status: 'success', confirm_return_url: 'https://chatgpt.com/checkout/verify' },
          headers: {},
        };
      }
      if (url.endsWith('/custom_payment_method/start')) {
        return {
          json: {
            status: 'requires_action',
            next_action: {
              paymentMethodType: 'gcash',
              method: 'GET',
              type: 'redirect',
              url: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture',
            },
          },
          headers: {},
        };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    },
    mintSentinel: async (kwargs) => {
      sentinelCalls.push(kwargs);
      return { main: `{"flow":"${kwargs.flow}"}`, so: '' };
    },
  });
  chain._preflightProxy = async () => ({ country: 'PH', ip: '' });
  chain._verifyProxyStability = async () => {};
  chain._prepareFrontendContext = async () => {};
  chain._bootstrap = async () => {};
  chain._followRedirect = async () => {
    chain.gcashUrl = 'https://m.gcash.com/gcash-login-web/index.html?netAuthId=fixture';
    chain.callbackStatus = 'waiting_scan';
  };

  const result = await chain.run();
  assert.equal(result.status, 'success');
  assert.equal(result.error_message, '');
  assert.deepEqual(requests.map((item) => item.url), [
    CHECKOUT_BASE,
    CHECKOUT_BASE,
    `${CHECKOUT_BASE}/taxes`,
    `${CHECKOUT_BASE}/confirm`,
    `${CHECKOUT_BASE}/custom_payment_method/start`,
  ]);
  assert.equal(requests.some((item) => item.url.endsWith('/update')), false);
  assert.deepEqual(sentinelCalls.map((item) => item.flow), ['chatgpt_checkout', 'checkout_session_approval']);

  const [firstCreate, create, taxes, confirm, start] = requests;
  assert.equal('OpenAI-Sentinel-Token' in firstCreate.headers, false);
  assert.equal(create.headers['ChatGPT-Account-Id'], 'fixture-account');
  assert.equal(create.headers['OpenAI-Sentinel-Token'], '{"flow":"chatgpt_checkout"}');
  assert.equal(create.body.promo_campaign.promo_campaign_id, 'plus-1-month-free');
  assert.equal(create.body.promo_campaign.is_coupon_from_query_param, true);
  assert.equal(create.body.check_card_proxy, true);
  assert.deepEqual(create.body.billing_details, { country: 'PH', currency: 'PHP' });
  assert.equal(create.headers.Referer, 'https://chatgpt.com/?promo_campaign=plus-1-month-free');

  assert.equal('OpenAI-Sentinel-Token' in taxes.headers, false);
  assert.equal(taxes.body.checkout_email, 'holder@example.com');
  assert.equal(taxes.body.billing_name, 'Fixture Holder');
  assert.deepEqual(taxes.body.billing_address, { country: 'PH' });
  assert.equal(taxes.body.tax_id, null);

  assert.equal(confirm.headers['ChatGPT-Account-Id'], 'fixture-account');
  assert.equal(confirm.headers['OpenAI-Sentinel-Token'], '{"flow":"checkout_session_approval"}');
  assert.equal(confirm.body.selected_payment_method_type, 'cpmt_fixture');
  assert.equal('OpenAI-Sentinel-Token' in start.headers, false);
  assert.equal(chain.paymentRoute, 'adyen_redirect');
  assert.equal(sentinelCalls[0].deviceId, chain.deviceId);
  assert.equal(sentinelCalls[1].deviceId, chain.deviceId);
  assert.equal(sentinelCalls[1].pageUrl, 'https://chatgpt.com/checkout/openai_llc/oaics_fixture');
  assert.equal(PROMO_CAMPAIGN.promo_campaign_id, 'plus-1-month-free');
});

test('MK protocol: Adyen redirect requires exact host, path, and redirectData', () => {
  const valid = 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture';
  assert.equal(isAdyenCheckoutRedirect(valid), true);
  assert.equal(isAdyenCheckoutRedirect(valid.replace('redirectData=fixture', 'x=1')), false);
  assert.equal(isAdyenCheckoutRedirect(valid.replace('checkoutshopper-live', 'evil')), false);
});

test('MK protocol: create does not mint sentinel for non-risk failure', async () => {
  let minted = 0;
  const chain = new GCashChain({
    token: 'fixture-token',
    clientAccountId: 'fixture-client',
    proxy: 'proxy.example:8080:user:pass',
    requestImpl: async () => {
      throw new Error('HTTP 403 Cloudflare');
    },
    mintSentinel: async () => {
      minted += 1;
      return { main: '{}', so: '' };
    },
  });
  chain._prepareFrontendContext = async () => {};
  chain._bootstrap = async () => {};
  chain._verifyProxyStability = async () => {};
  await assert.rejects(() => chain._createCheckout(), /403/);
  assert.equal(minted, 0);
});

test('MK protocol: create mints chatgpt_checkout sentinel when first 200 has no GCash cpmt', async () => {
  const requests = [];
  const sentinelCalls = [];
  const chain = new GCashChain({
    token: 'fixture-token',
    clientAccountId: 'fixture-client',
    accountId: 'fixture-account',
    requestImpl: async (method, url, headers, data) => {
      requests.push({ method, url, headers: { ...headers }, body: data });
      if (url === CHECKOUT_BASE) {
        if (requests.filter((item) => item.url === CHECKOUT_BASE).length === 1) {
          return {
            json: {
              checkout_session_id: 'oaics_empty_methods',
              processor_entity: 'openai_llc',
              checkout_session: { amount_total: 0 },
            },
            headers: {},
          };
        }
        return { json: checkoutResponse(), headers: {} };
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    },
    mintSentinel: async (kwargs) => {
      sentinelCalls.push(kwargs);
      return { main: `{"flow":"${kwargs.flow}"}`, so: '' };
    },
  });
  chain._preflightProxy = async () => ({ country: 'PH', ip: '' });
  chain._verifyProxyStability = async () => {};
  chain._prepareFrontendContext = async () => {};
  chain._bootstrap = async () => {};
  await chain._createCheckout();
  assert.equal(requests.length, 2);
  assert.equal('OpenAI-Sentinel-Token' in requests[0].headers, false);
  assert.equal(requests[1].headers['OpenAI-Sentinel-Token'], '{"flow":"chatgpt_checkout"}');
  assert.deepEqual(sentinelCalls.map((item) => item.flow), ['chatgpt_checkout']);
  assert.equal(chain.cid, 'oaics_fixture');
  assert.equal(chain.cpmt, 'cpmt_fixture');
});

test('MK protocol: cpmt prefers GCash-labelled method', () => {
  assert.equal(extractCpmt({
    methods: [
      { id: 'cpmt_other', brand: 'grab' },
      { id: 'cpmt_gcash', type: 'gcash' },
    ],
  }), 'cpmt_gcash');
});

test('MK protocol: cpmt pairs GCash when type is nested under options', () => {
  assert.equal(extractCpmt({
    custom_payment_methods: [
      { id: 'cpmt_card', options: { type: 'card' } },
      { id: 'cpmt_gcash', options: { type: 'gcash' } },
    ],
  }), 'cpmt_gcash');
});

test('MK protocol: checkout amount reads checkout_session.amount_total', () => {
  const { amount, source } = checkoutAmount(checkoutResponse());
  assert.equal(amount, 0);
  assert.equal(source, 'checkout_session.amount_total');
});

test('MK protocol: fallback QR is a PNG for a GCash link and rejects others', () => {
  const link = 'https://m.gcash.com/gcash-login-web/index.html?netAuthId=synthetic-test-value';
  const png = fallbackQrPng(link);
  assert.equal(png.subarray(0, 8).equals(PNG_SIGNATURE), true);
  assert.ok(png.length > 300);
  assert.throws(() => fallbackQrPng('https://example.com/not-gcash'), /非 GCash/);
});

test('MK protocol: extractRedirectResult and payloadStatus', () => {
  assert.equal(
    extractRedirectResult('https://chatgpt.com/checkout/verify?redirectResult=abc%2Bdef'),
    'abc+def',
  );
  assert.equal(payloadStatus({ nested: { status: 'Accepted' } }), 'accepted');
});

test('MK protocol: Plus entitlement requires plan plus and chatgptplusplan', () => {
  assert.equal(activePlusEntitlement({
    accounts: {
      acc1: {
        entitlement: { has_active_subscription: true, subscription_plan: PLAN_NAME },
        account: { plan_type: 'plus' },
      },
    },
  }, 'acc1'), true);
  assert.equal(activePlusEntitlement({
    accounts: {
      acc1: {
        entitlement: { has_active_subscription: true, subscription_plan: PLAN_NAME },
        account: { plan_type: 'free' },
      },
    },
  }, 'acc1'), false);
});

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('MK app parser accepts text accounts and rejects expired tokens', () => {
  const token = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/profile': { email: 'claim@example.com' },
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-private' },
  });
  const second = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'second@example.com',
  });
  const { accounts, warnings } = parseAccounts({
    tokens: `display@example.com|${token}\n${second}`,
  });
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].email, 'display@example.com');
  assert.equal(accounts[0].account_id, 'account-private');
  assert.equal(accounts[0].token, token);
  assert.deepEqual(warnings, []);

  const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 1 });
  assert.throws(() => parseAccounts({ tokens: expired }), /AT 已过期/);
  assert.throws(() => parseAccounts({ tokens: 'not-a-token' }), /未找到 JWT AT/);
});

test('MK app parser: custom proxy pool, including authenticated SOCKS5', () => {
  const pool = parseProxyPool([
    'proxy.example:8080',
    'proxy.example:8080',
    'http://user:pass@proxy.example:8081',
    'socks5://proxy.example:1080',
    'socks5://user:pass@proxy.example:1080',
    'socks5h://user:pass@proxy.example:1080',
  ]);
  assert.equal(pool.length, 5);
  const manager = new GCashSessionManager({ maxConcurrency: 1, maxQueue: 2 });
  assert.equal(manager._rotateProxy('proxy-1', ['proxy-1', 'proxy-2']), 'proxy-2');
  assert.equal(manager._rotateProxy('proxy-1', []), '');
});

test('MK proxy adapter accepts gpt-plus SOCKS5h storage and open-source HTTP forms', () => {
  const stored = {
    proxy_type: 'socks5',
    host: 'sg.example.test',
    port: 443,
    username: 'acct-region-PH-sid-abcd1234-t-5',
    password: 'fixture-pass',
  };
  const rendered = toChainProxy(stored);
  assert.equal(rendered, buildProxyUrl(stored));
  assert.match(rendered, /^socks5h:\/\//);
  const parsed = parseProxy(rendered);
  assert.equal(parsed.type, 'socks5');
  assert.equal(parsed.host, 'sg.example.test');
  assert.equal(parsed.port, 443);
  assert.equal(parsed.user, stored.username);
  ensureFullChainProxySupported(rendered);
  const url = proxyUrl(rendered);
  assert.match(url, /^socks5h:\/\//);
  assert.equal(url.includes('sg.example.test:443'), true);
  assert.equal(needsHttpBridge(rendered), true);
  assert.equal(needsHttpBridge('socks5://proxy.example:1080'), false);

  const httpColon = parseProxy('proxy.example:8080:user:p:ss');
  assert.equal(httpColon.type, 'http');
  assert.equal(httpColon.host, 'proxy.example');
  assert.equal(httpColon.port, 8080);
  assert.equal(httpColon.user, 'user');
  assert.equal(httpColon.password, 'p:ss');
  assert.equal(parseProxy('user:pass@proxy.example:8080').type, 'http');
  assert.throws(() => proxyUrl('not-a-proxy'), /代理格式无效/);
  assert.equal(retryDecision({
    current_step: 'proxy_test',
    error_message: '连接失败：代理格式无效',
  }).retryable, false);
  assert.equal(retryDecision({
    current_step: 'proxy_test',
    error_message: '代理预检失败：出口不是 PH（检测到 US）',
  }).retryable, true);
});

test('MK payment monitor abandon marks terminal and clears QR', async () => {
  const manager = new PaymentMonitorManager();
  let closed = false;
  manager._states.set('monitor-test', {
    status: 'waiting_scan',
    qr_png: Buffer.concat([PNG_SIGNATURE, Buffer.from('test')]),
    qr_source: 'gcash_page',
    refresh_available: true,
    refresh_until: Math.floor(Date.now() / 1000) + 60,
    _closed: new Promise((resolve) => {
      closed = true;
      resolve();
    }),
    updated_at: Math.floor(Date.now() / 1000),
  });
  const result = await manager.abandon('monitor-test', 0.1);
  assert.equal(result.status, 'abandoned');
  assert.equal(result.qr_ready, false);
  assert.equal(result.refresh_available, false);
  assert.equal(closed, true);
});
