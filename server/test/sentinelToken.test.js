'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSentinelState,
  requirementsToken,
  solveProof,
  fnv1aHex,
  decodePowPayload,
  localeDateString,
} = require('../src/utils/protocolRt/sentinelPoW');
const { tokenBundle, sentinelHeaders } = require('../src/utils/protocolRt/sentinel');
const { gcashSentinelHeaders, GCASH_CHAT } = require('../src/utils/paymentLink');
const {
  confirmGcashCheckout,
  startGcashCustomPayment,
} = require('../src/utils/localProviderExtract');

function sampleState(overrides = {}) {
  return createSentinelState({
    deviceId: 'did-sentinel-1',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/136.0.0.0 Safari/537.36',
    language: 'en-PH',
    languages: 'en-PH,en',
    timezone: 'Asia/Manila',
    pageUrl: 'https://chatgpt.com/?promo_campaign=plus-1-month-free',
    ...overrides,
  });
}

function mockSentinelSession(handler) {
  const calls = [];
  return {
    calls,
    transport: 'curl_cffi',
    fingerprint: { userAgent: sampleState().userAgent },
    async request(url, options = {}) {
      calls.push({
        url: String(url),
        method: String(options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        body: options.body,
        json: options.json,
      });
      return handler(String(url), options, calls.length);
    },
  };
}

function header(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value);
  }
  return '';
}

test('sentinel FNV mix matches SDK avalanche, not raw FNV-1a', () => {
  assert.equal(fnv1aHex('0'), '64f08f61');
  assert.equal(fnv1aHex('seed'), 'd9b133b8');
});

test('requirements token is gAAAAAC + 25-item PoW payload + ~S', () => {
  const token = requirementsToken(sampleState());
  assert.match(token, /^gAAAAAC/);
  assert.match(token, /~S$/);
  const payload = decodePowPayload(token);
  assert.equal(payload.length, 25);
  assert.equal(payload[0], 3000);
  assert.equal(typeof payload[0], 'number');
  assert.equal(payload[4].includes('Chrome/136'), true);
  assert.equal(payload[6], null);
  assert.equal(payload[7], 'en-PH');
  assert.equal(payload[8], 'en-PH,en');
  assert.equal(String(payload[10]).includes('\u2212'), true);
  assert.equal(payload[15], 'promo_campaign');
  assert.equal(payload[16], 8);
  assert.deepEqual(payload.slice(18), [0, 0, 0, 0, 0, 0, 0]);
});

test('enforcement token uses gAAAAAB prefix and SDK hash prefix check', () => {
  const seed = '0.424242';
  const token = solveProof(sampleState(), seed, '0');
  assert.match(token, /^gAAAAAB/);
  assert.match(token, /~S$/);
  const encoded = token.slice('gAAAAAB'.length, -2);
  const digest = fnv1aHex(`${seed}${encoded}`);
  assert.equal(digest.slice(0, 1) <= '0', true);
});

test('localeDateString still emits timezone-labeled JS Date text', () => {
  const tokyo = localeDateString(Date.parse('2026-08-17T03:00:00Z'));
  assert.match(tokyo, /GMT\+0900 \(Japan Standard Time\)/);
  assert.match(tokyo, /Mon Aug 17 2026/);
  const manila = localeDateString(Date.parse('2026-08-17T03:00:00Z'), 'Asia/Manila');
  assert.match(manila, /GMT\+0800 \(Philippine Standard Time\)/);
  assert.match(manila, /Mon Aug 17 2026/);
});

test('tokenBundle posts compact {p,id,flow}, omits empty t, keeps c/id/flow', async () => {
  const session = mockSentinelSession(async (url) => {
    if (url.includes('sentinel.openai.com')) {
      return {
        status: 200,
        headers: {},
        data: {
          token: 'chal-create',
          proofofwork: { required: true, seed: '0.1', difficulty: '0' },
        },
        text: '{}',
      };
    }
    return { status: 200, headers: {}, data: {}, text: '{}' };
  });
  const bundle = await tokenBundle(session, sampleState(), 'chatgpt_checkout');
  const req = session.calls.find((item) => item.url.includes('/sentinel/req'));
  assert.ok(req);
  const posted = JSON.parse(String(req.body || '{}'));
  assert.equal(posted.id, 'did-sentinel-1');
  assert.equal(posted.flow, 'chatgpt_checkout');
  assert.match(String(posted.p || ''), /^gAAAAAC/);
  assert.match(String(posted.p || ''), /~S$/);
  assert.match(header(req.headers, 'cookie'), /oai-did=did-sentinel-1/);
  const token = JSON.parse(bundle.sentinelToken);
  assert.equal(token.c, 'chal-create');
  assert.equal(token.id, 'did-sentinel-1');
  assert.equal(token.flow, 'chatgpt_checkout');
  assert.match(token.p, /^gAAAAAB/);
  assert.equal(Object.prototype.hasOwnProperty.call(token, 't'), false);
  assert.deepEqual(Object.keys(token).sort(), ['c', 'flow', 'id', 'p']);
});

test('GCash create flow name is chatgpt_checkout like pay153', async () => {
  const session = mockSentinelSession(async () => ({
    status: 200,
    headers: {},
    data: {
      token: 'chal-gcash',
      proofofwork: { required: true, seed: '0.2', difficulty: '0' },
    },
    text: '{}',
  }));
  const headers = await gcashSentinelHeaders(
    session, 'did-sentinel-1', GCASH_CHAT.promoHome, GCASH_CHAT.sentinelCreateFlow,
  );
  const req = session.calls.find((item) => item.url.includes('/sentinel/req'));
  assert.equal(JSON.parse(String(req.body || '{}')).flow, 'chatgpt_checkout');
  const token = JSON.parse(headers['openai-sentinel-token']);
  assert.equal(token.flow, 'chatgpt_checkout');
});

test('GCash confirm and start omit HAR sentinel', async () => {
  const session = mockSentinelSession(async (url) => {
    if (url.includes('sentinel.openai.com')) {
      return {
        status: 200,
        headers: {},
        data: {
          token: 'chal-confirm',
          proofofwork: { required: true, seed: '0.3', difficulty: '0' },
        },
        text: '{}',
      };
    }
    if (url.includes('/payments/checkout/confirm')) {
      return { status: 200, headers: {}, data: { status: 'success' }, text: '{"status":"success"}' };
    }
    if (url.includes('/custom_payment_method/start')) {
      return {
        status: 200,
        headers: {},
        data: { next_action: { url: 'https://checkoutshopper-live.adyen.com/x' } },
        text: '{}',
      };
    }
    return { status: 200, headers: {}, data: {}, text: '{}' };
  });
  const checkout = {
    cs_id: 'oaics_sentinel',
    billing_country: 'PH',
    processor_entity: 'openai_llc',
  };
  const detail = { access_token: 'eyJhbGciOiJub25lIn0.e30.x' };
  await confirmGcashCheckout(session, detail, 'did-sentinel-1', 'sid-1', checkout, 'cpmt_x', () => {});
  const beforeStart = session.calls.length;
  await startGcashCustomPayment(session, detail, 'did-sentinel-1', 'sid-1', checkout, 'cpmt_x', () => {});
  const sentinelCalls = session.calls.filter((item) => item.url.includes('sentinel.openai.com'));
  const confirm = session.calls.find((item) => item.url.includes('/checkout/confirm'));
  const start = session.calls.find((item) => item.url.includes('/custom_payment_method/start'));
  assert.equal(sentinelCalls.length, 0);
  assert.equal(header(confirm.headers, 'openai-sentinel-token'), '');
  assert.equal(header(start.headers, 'openai-sentinel-token'), '');
  assert.equal(header(confirm.headers, 'oai-telemetry'), '');
  assert.equal(header(start.headers, 'oai-telemetry'), '');
  assert.deepEqual(Object.keys(confirm.json || {}).sort(), [
    'checkout_session_id',
    'selected_payment_method_type',
  ]);
  assert.equal(session.calls.slice(beforeStart).some((item) => item.url.includes('sentinel.openai.com')), false);
});

test('sentinelHeaders skips so header when VM yields nothing', async () => {
  const session = mockSentinelSession(async () => ({
    status: 200,
    headers: {},
    data: { token: 'chal', proofofwork: { required: true, seed: '0.4', difficulty: '0' } },
    text: '{}',
  }));
  const headers = await sentinelHeaders(session, sampleState(), 'chatgpt_checkout');
  assert.ok(headers['openai-sentinel-token']);
  assert.equal(headers['openai-sentinel-so-token'], undefined);
});
