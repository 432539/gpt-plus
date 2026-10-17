'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-gcash-pay-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '4'.repeat(64);

const {
  parkGcashSession,
  getGcashSession,
  releaseGcashSession,
} = require('../src/utils/gcashSessionStore');
const {
  GCASH_QR_TTL_MS,
  parseGcashAuthPage,
} = require('../src/utils/gcashProtocol');
const {
  refreshParkedQr,
  maybeRefreshParkedQr,
  pollParkedScan,
  submitParkedContinue,
  refreshPaywallQr,
  refreshPaywallWall,
  paywallWall,
  paywallView,
  refreshCapability,
  shouldPollEntitlement,
  scanWorkInFlight,
} = require('../src/utils/gcashPayJob');

const AUTH_URL = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5';
const PNG = 'data:image/png;base64,fixture-qr';

function mockSession(handler) {
  return {
    request: async (url, opts = {}) => handler(String(url), opts),
    close: async () => {},
  };
}

test('5-minute QR refresh consults again and does not close the session', async () => {
  let consults = 0;
  let closed = false;
  const session = mockSession(async (url) => {
    if (url.includes('mgw.htm')) {
      consults += 1;
      return {
        status: 200,
        data: {
          success: true,
          qrCode: PNG,
          uuid: `refreshed-uuid-${consults}`,
          errorActions: [],
          extendInfo: {},
          traceId: 'r',
        },
      };
    }
    return { status: 200, data: {} };
  });
  session.close = async () => { closed = true; };
  parkGcashSession(1, 9, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
  });
  const lease = getGcashSession(1, 9);
  lease.auth.consultUuid = 'original-uuid';
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  const logs = [];
  const refreshed = await maybeRefreshParkedQr(1, 9, lease, (_s, m) => logs.push(m));
  assert.equal(refreshed.refreshed, true);
  assert.equal(consults, 1);
  assert.equal(closed, false);
  assert.equal(lease.auth.consultUuid, 'refreshed-uuid-1');
  assert.ok(getGcashSession(1, 9).qrIssuedAt > Date.now() - 1000);
  assert.ok(logs.some((line) => /倒计时重置/.test(line)));
  await releaseGcashSession(1, 9);
});

test('expired QR never screenshots or consults after H5 leaves GCash', async () => {
  let consults = 0;
  parkGcashSession(1, 20, {
    session: mockSession(async () => {
      consults += 1;
      return { status: 200, data: { success: true, qrCode: PNG, uuid: 'new-uuid' } };
    }),
    auth: parseGcashAuthPage(AUTH_URL),
    h5: {
      currentUrl: () => 'https://chatgpt.com/',
      page: { url: () => 'https://chatgpt.com/' },
    },
  });
  const lease = getGcashSession(1, 20);
  lease.auth.consultUuid = 'old-uuid';
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  const logs = [];
  const refreshed = await maybeRefreshParkedQr(1, 20, lease, (_s, m) => logs.push(m));
  assert.equal(refreshed.refreshed, false);
  assert.equal(consults, 0);
  assert.equal(lease.auth.consultUuid, 'old-uuid');
  assert.equal(refreshed.code, 'SCAN_IN_FLIGHT');
  assert.ok(logs.some((line) => /扫码进行中|离开 GCash/.test(line)));
  await releaseGcashSession(1, 20);
});

test('expired QR does not consult-refresh after parked H5 closed', async () => {
  let consults = 0;
  const session = mockSession(async (url) => {
    if (url.includes('mgw.htm')) {
      consults += 1;
      return { status: 200, data: { success: true, qrCode: PNG } };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 14, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: { _closed: true, currentUrl: () => '' },
  });
  const lease = getGcashSession(1, 14);
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  const logs = [];
  const refreshed = await maybeRefreshParkedQr(1, 14, lease, (_s, m) => logs.push(m));
  assert.equal(refreshed.refreshed, false);
  assert.equal(consults, 0);
  assert.ok(logs.some((line) => /H5 已关闭/.test(line)));
  await releaseGcashSession(1, 14);
});

function rpcOperation(opts = {}) {
  return String(opts.headers?.['Operation-Type'] || opts.form?.operationType || '');
}

test('expired QR polls the current UUID before consult-refresh', async () => {
  let consults = 0;
  let polls = 0;
  const session = mockSession(async (url, opts) => {
    const op = rpcOperation(opts);
    if (op.includes('query.result')) {
      polls += 1;
      return {
        status: 200,
        data: {
          success: true,
          errorActions: [],
          extendInfo: {},
          traceId: 't',
          redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
        },
      };
    }
    if (op.includes('consult')) {
      consults += 1;
      return { status: 200, data: { success: true, qrCode: PNG, uuid: 'refreshed-uuid' } };
    }
    if (url.includes('checkoutPaymentReturn')) {
      return {
        status: 200,
        data: {},
        url: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&redirectResult=fixture-result',
      };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 41, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
  });
  const lease = getGcashSession(1, 41);
  lease.auth.consultUuid = 'paid-old-uuid';
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  const logs = [];
  const result = await pollParkedScan(1, 41, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(polls, 1);
  assert.equal(consults, 0);
  assert.equal(lease.auth.consultUuid, 'paid-old-uuid');
  assert.equal(result.complete, false);
  assert.ok(logs.some((line) => /redirect=有/.test(line)));
  assert.ok(logs.some((line) => /不用 HTTP\/curl/.test(line)));
  assert.equal(logs.some((line) => /倒计时重置/.test(line)), false);
  await releaseGcashSession(1, 41);
});

test('expired QR without redirect still consult-refreshes after poll', async () => {
  let consults = 0;
  let polls = 0;
  const session = mockSession(async (_url, opts) => {
    const op = rpcOperation(opts);
    if (op.includes('query.result')) {
      polls += 1;
      return {
        status: 200,
        data: { success: true, errorActions: [], extendInfo: {}, traceId: 't' },
      };
    }
    if (op.includes('consult')) {
      consults += 1;
      return { status: 200, data: { success: true, qrCode: PNG, uuid: `after-poll-${consults}` } };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 42, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
  });
  const lease = getGcashSession(1, 42);
  lease.auth.consultUuid = 'idle-old-uuid';
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  const logs = [];
  const result = await pollParkedScan(1, 42, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(polls, 1);
  assert.equal(consults, 1);
  assert.equal(lease.auth.consultUuid, 'after-poll-1');
  assert.equal(result.complete, false);
  assert.ok(logs.some((line) => /redirect=无/.test(line)));
  assert.ok(logs.some((line) => /倒计时重置/.test(line)));
  const pollIdx = logs.findIndex((line) => /redirect=无/.test(line));
  const refreshIdx = logs.findIndex((line) => /倒计时重置/.test(line));
  assert.ok(pollIdx >= 0 && refreshIdx > pollIdx);
  await releaseGcashSession(1, 42);
});

test('redirect without a browser verify session never curl-posts continue', async () => {
  const session = mockSession(async (url) => {
    if (url.includes('chatgpt.com') && url.includes('/continue')) {
      return { status: 500, data: { detail: 'continue failed' } };
    }
    if (url.includes('mgw.htm')) {
      return {
        status: 200,
        data: {
          success: true,
          errorActions: [],
          extendInfo: {},
          traceId: 't',
          redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
        },
      };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 10, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
  });
  const lease = getGcashSession(1, 10);
  const logs = [];
  const result = await pollParkedScan(1, 10, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(result.complete, false);
  assert.equal(result.continue_ok, false);
  assert.equal(result.continue_failed, undefined);
  assert.equal(getGcashSession(1, 10).continueSubmitted, false);
  assert.notEqual(getGcashSession(1, 10).phase, 'continue_failed');
  assert.ok(logs.some((line) => /不用 HTTP\/curl/.test(line)));
  await releaseGcashSession(1, 10);
});

test('redirectUrl alone is not callback success without a browser continue', async () => {
  const calls = [];
  const verify = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result';
  const session = mockSession(async (url, opts) => {
    calls.push({ url, method: String(opts.method || 'GET').toUpperCase(), json: opts.json || null });
    if (url.includes('chatgpt.com') && url.includes('/continue')) {
      return { status: 200, data: { ok: true } };
    }
    if (url.includes('checkoutPaymentReturn')) {
      return { status: 200, data: {}, url: verify };
    }
    if (url.includes('mgw.htm')) {
      return {
        status: 200,
        data: {
          success: true,
          errorActions: [],
          extendInfo: {},
          traceId: 't',
          redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
        },
      };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 11, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
  });
  const lease = getGcashSession(1, 11);
  const logs = [];
  const result = await pollParkedScan(1, 11, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(result.complete, false);
  assert.equal(result.continue_ok, false);
  assert.equal(getGcashSession(1, 11).continueSubmitted, false);
  assert.notEqual(getGcashSession(1, 11).phase, 'continue_ok');
  assert.ok(calls.some((item) => item.url.includes('checkoutPaymentReturn') && item.method === 'GET'));
  const continued = calls.find((item) => item.url.includes('/custom_payment_method/continue') && item.method === 'POST');
  assert.equal(continued, undefined);
  assert.ok(logs.some((line) => /不用 HTTP\/curl/.test(line)));
  assert.ok(logs.some((line) => /\/checkout\/verify/.test(line)));
  const again = await submitParkedContinue(1, 11, { gcash_cs_id: 'oaics_fixture' }, getGcashSession(1, 11));
  assert.equal(again.skipped, true);
  await releaseGcashSession(1, 11);
});

test('Playwright verify waits for native continue and never uses session curl', async () => {
  const calls = [];
  let h5Closed = false;
  const verify = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result';
  const session = mockSession(async (url, opts) => {
    calls.push({ url, method: String(opts.method || 'GET').toUpperCase(), json: opts.json || null });
    if (url.includes('/continue')) return { status: 200, data: { ok: true } };
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 12, {
    session,
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: {
      currentUrl: () => verify,
      close: async () => { h5Closed = true; },
    },
  });
  const lease = getGcashSession(1, 12);
  lease.h5SuccessWaitMs = 0;
  const logs = [];
  const result = await pollParkedScan(1, 12, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(result.complete, false);
  assert.equal(result.continue_ok, false);
  assert.equal(result.source, 'h5-verify');
  assert.equal(h5Closed, false);
  const continued = calls.find((item) => item.url.includes('/custom_payment_method/continue') && item.method === 'POST');
  assert.equal(continued, undefined);
  assert.equal(calls.some((item) => String(item.url).includes('mgw.htm')), false);
  assert.ok(logs.some((line) => /Playwright 已落到 \/checkout\/verify/.test(line)));
  assert.ok(logs.some((line) => /不用裸 fetch\/curl/.test(line)));
  await releaseGcashSession(1, 12);
  assert.equal(h5Closed, true);
});

test('success URL without observed continue is not callback success', async () => {
  const calls = [];
  let url = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result';
  const session = mockSession(async (reqUrl, opts) => {
    calls.push({ url: reqUrl, method: String(opts.method || 'GET').toUpperCase() });
    if (String(reqUrl).includes('/continue')) return { status: 200, data: { ok: true } };
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 13, {
    session,
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: { currentUrl: () => url },
  });
  const lease = getGcashSession(1, 13);
  lease.h5SuccessWaitMs = 800;
  setTimeout(() => {
    url = 'https://chatgpt.com/payments/success?plan_type=plus&processor_entity=openai_llc&stripe_session_id=oaics_fixture';
  }, 50);
  const logs = [];
  const result = await pollParkedScan(1, 13, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(result.complete, false);
  assert.equal(result.continue_ok, false);
  assert.equal(result.source, 'h5-verify');
  assert.equal(calls.some((item) => String(item.url).includes('/continue')), false);
  assert.ok(logs.some((line) => /不用裸 fetch\/curl/.test(line)));
  await releaseGcashSession(1, 13);
});

test('H5 query.result waits for native return and never goto Adyen', async () => {
  const calls = [];
  const verify = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result';
  let url = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html';
  const session = mockSession(async (reqUrl, opts) => {
    calls.push({ url: reqUrl, method: String(opts.method || 'GET').toUpperCase(), json: opts.json || null });
    if (String(reqUrl).includes('/continue')) return { status: 200, data: { ok: true } };
    if (String(reqUrl).includes('checkoutPaymentReturn')) return { status: 200, data: {}, url: verify };
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 15, {
    session,
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: {
      currentUrl: () => url,
      page: {
        url: () => url,
        goto: async () => { throw new Error('must not goto Adyen return'); },
      },
      scanComplete: true,
      scanRedirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
      consultUuid: 'h5-uuid',
    },
  });
  const lease = getGcashSession(1, 15);
  lease.h5SuccessWaitMs = 250;
  setTimeout(() => {
    url = 'https://chatgpt.com/payments/success?plan_type=plus&processor_entity=openai_llc&stripe_session_id=oaics_fixture';
    lease.h5.browserContinueSeen = true;
    lease.h5.browserContinueHttp = 200;
  }, 40);
  const logs = [];
  const result = await pollParkedScan(1, 15, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(result.continue_ok, true);
  assert.equal(result.source, 'h5-success');
  assert.equal(calls.some((item) => String(item.url).includes('checkoutPaymentReturn')), false);
  assert.equal(calls.some((item) => String(item.url).includes('/continue')), false);
  assert.ok(logs.some((line) => /自行回跳|等待页面自行回跳/.test(line)));
  await releaseGcashSession(1, 15);
});

test('H5 query.result does not curl-follow return before the page lands', async () => {
  const calls = [];
  const session = mockSession(async (url, opts) => {
    calls.push({ url, method: String(opts.method || 'GET').toUpperCase() });
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 16, {
    session,
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: {
      currentUrl: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html',
      scanComplete: true,
      scanRedirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    },
  });
  const lease = getGcashSession(1, 16);
  lease.h5SuccessWaitMs = 0;
  const logs = [];
  const result = await pollParkedScan(1, 16, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(result.continue_ok, false);
  assert.equal(result.complete, false);
  assert.equal(calls.some((item) => String(item.url).includes('checkoutPaymentReturn')), false);
  assert.equal(calls.some((item) => String(item.url).includes('/continue')), false);
  assert.ok(logs.some((line) => /不抢发 continue|自行回跳/.test(line)));
  await releaseGcashSession(1, 16);
});

test('protocol redirect with a live H5 waits for native return instead of curl or goto', async () => {
  const calls = [];
  let url = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html';
  const session = mockSession(async (reqUrl, opts) => {
    calls.push({ url: reqUrl, method: String(opts.method || 'GET').toUpperCase() });
    if (String(reqUrl).includes('mgw.htm')) {
      return {
        status: 200,
        data: {
          success: true,
          errorActions: [],
          extendInfo: {},
          traceId: 't',
          redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
        },
      };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 18, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: {
      currentUrl: () => url,
      page: {
        url: () => url,
        goto: async () => { throw new Error('must not goto Adyen return'); },
      },
    },
  });
  const lease = getGcashSession(1, 18);
  lease.h5SuccessWaitMs = 200;
  setTimeout(() => {
    url = 'https://chatgpt.com/payments/success';
    lease.h5.browserContinueSeen = true;
    lease.h5.browserContinueHttp = 200;
  }, 40);
  const result = await pollParkedScan(1, 18, { gcash_cs_id: 'oaics_fixture' }, lease, () => {});
  assert.equal(result.continue_ok, true);
  assert.equal(calls.some((item) => String(item.url).includes('checkoutPaymentReturn')), false);
  assert.equal(calls.some((item) => String(item.url).includes('/continue')), false);
  assert.equal(lease.h5.scanComplete, true);
  await releaseGcashSession(1, 18);
});

test('in-flight continue lock stops a second poll from following return', async () => {
  const calls = [];
  const session = mockSession(async (url) => {
    calls.push(url);
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 19, {
    session,
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: {
      currentUrl: () => 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&redirectResult=fixture-result',
    },
  });
  const lease = getGcashSession(1, 19);
  lease.continueInFlight = true;
  lease.h5SuccessWaitMs = 0;
  const result = await pollParkedScan(1, 19, { gcash_cs_id: 'oaics_fixture' }, lease, () => {});
  assert.equal(result.complete, false);
  assert.equal(calls.some((url) => String(url).includes('/continue')), false);
  await releaseGcashSession(1, 19);
});

test('H5 that already 422s does not POST continue again', async () => {
  const calls = [];
  const verify = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result';
  const session = mockSession(async (url, opts) => {
    calls.push({ url, method: String(opts.method || 'GET').toUpperCase() });
    if (String(url).includes('/continue')) return { status: 200, data: { ok: true } };
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 17, {
    session,
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
    h5: { currentUrl: () => verify },
  });
  const lease = getGcashSession(1, 17);
  lease.continueAttempted = true;
  lease.continueStatus = 422;
  lease.continueError = 'HTTP 422 keys=[detail] code=unprocessable';
  lease.h5SuccessWaitMs = 0;
  const result = await pollParkedScan(1, 17, { gcash_cs_id: 'oaics_fixture' }, lease, () => {});
  assert.equal(result.continue_ok, false);
  assert.equal(result.continue_failed, true);
  assert.equal(calls.some((item) => String(item.url).includes('/continue')), false);
  await releaseGcashSession(1, 17);
});

test('manual refresh shares one per-account consult lock', async () => {
  let consults = 0;
  parkGcashSession(1, 31, {
    session: mockSession(async () => {
      consults += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { status: 200, data: { success: true, qrCode: PNG, uuid: 'locked-new-uuid' } };
    }),
    auth: parseGcashAuthPage(AUTH_URL),
  });
  const lease = getGcashSession(1, 31);
  lease.auth.consultUuid = 'locked-old-uuid';
  const [first, second] = await Promise.all([
    refreshParkedQr(1, 31, lease),
    refreshParkedQr(1, 31, lease),
  ]);
  assert.equal(first.refreshed, true);
  assert.equal(second.refreshed, true);
  assert.equal(consults, 1);
  await releaseGcashSession(1, 31);
});

test('expired QR does not rotate UUID while scan is in flight', async () => {
  let consults = 0;
  let polls = 0;
  const session = mockSession(async (_url, opts) => {
    const op = rpcOperation(opts);
    if (op.includes('query.result')) {
      polls += 1;
      return { status: 200, data: { success: true, errorActions: [], extendInfo: {}, traceId: 't' } };
    }
    if (op.includes('consult')) {
      consults += 1;
      return { status: 200, data: { success: true, qrCode: PNG, uuid: 'should-not-apply' } };
    }
    return { status: 200, data: {} };
  });
  parkGcashSession(1, 43, {
    session,
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'oaics_fixture' },
    cpmId: 'cpmt_x',
    deviceId: 'did',
    sessionId: 'sid',
  });
  const lease = getGcashSession(1, 43);
  lease.auth.consultUuid = 'scan-uuid';
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  lease.continueAttempted = true;
  const logs = [];
  const result = await pollParkedScan(1, 43, { gcash_cs_id: 'oaics_fixture' }, lease, (_s, m) => logs.push(m));
  assert.equal(polls, 1);
  assert.equal(consults, 0);
  assert.equal(lease.auth.consultUuid, 'scan-uuid');
  assert.equal(result.complete, false);
  assert.ok(logs.some((line) => /redirect=无/.test(line)));
  assert.ok(logs.some((line) => /扫码进行中，保持当前 query.result UUID/.test(line)));
  await releaseGcashSession(1, 43);
});

test('scan or continue in-flight makes QR non-refreshable', async () => {
  let consults = 0;
  parkGcashSession(1, 32, {
    session: mockSession(async () => {
      consults += 1;
      return { status: 200, data: {} };
    }),
    auth: parseGcashAuthPage(AUTH_URL),
    h5: {
      currentUrl: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html',
      scanComplete: true,
      scanRedirectUrl: 'https://checkoutshopper-live.adyen.com/return',
    },
  });
  const lease = getGcashSession(1, 32);
  assert.equal(refreshCapability(lease).code, 'SCAN_IN_FLIGHT');
  const result = await refreshParkedQr(1, 32, lease);
  assert.equal(result.refreshed, false);
  assert.equal(result.code, 'SCAN_IN_FLIGHT');
  assert.equal(consults, 0);
  await releaseGcashSession(1, 32);
});

test('missing parked session returns an actionable refresh failure', () => {
  const result = refreshCapability(null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SESSION_MISSING');
  assert.match(result.message, /会话已失效，需要新号重新出码/);
});

test('batch wall is user-isolated and refreshes only expiring QR codes', async () => {
  const db = require('../src/db');
  const { encodeExtractLink } = require('../src/utils/accountFields');
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-owner-${suffix}`).lastInsertRowid;
  const other = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-other-${suffix}`).lastInsertRowid;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const insert = db.prepare(
    `INSERT INTO gpt_accounts
      (user_id,email,email_type,plan_type,status,progress,channel,gcash_link,gcash_qr,gcash_cs_id,gcash_extracted_at)
     VALUES (?, ?, 'gmail', 'Free', '正常', '支付中', 'gc', ?, ?, ?, ?)`,
  );
  const due = insert.run(owner, 'due@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=due'), PNG, 'cs-due', stamp).lastInsertRowid;
  const fresh = insert.run(owner, 'fresh@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=fresh'), PNG, 'cs-fresh', stamp).lastInsertRowid;
  const foreign = insert.run(other, 'foreign@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=foreign'), PNG, 'cs-foreign', stamp).lastInsertRowid;
  const consults = new Map();
  for (const [uid, id] of [[owner, due], [owner, fresh], [other, foreign]]) {
    parkGcashSession(uid, id, {
      session: mockSession(async (_url, opts) => {
        const op = rpcOperation(opts);
        if (op.includes('consult')) {
          consults.set(id, (consults.get(id) || 0) + 1);
          return { status: 200, data: { success: true, qrCode: PNG, uuid: `uuid-${id}-new` } };
        }
        return { status: 200, data: { success: true, errorActions: [], extendInfo: {}, traceId: 't' } };
      }),
      auth: parseGcashAuthPage(AUTH_URL),
    });
    const lease = getGcashSession(uid, id);
    lease.auth.consultUuid = `uuid-${id}-old`;
    lease.qrIssuedAt = Date.now() - (Number(id) === Number(fresh) ? 60 * 1000 : GCASH_QR_TTL_MS - 5000);
  }
  const before = await paywallWall(owner);
  assert.deepEqual(new Set(before.items.map((item) => item.id)), new Set([Number(due), Number(fresh)]));
  const result = await refreshPaywallWall(owner);
  assert.equal(result.requested, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(consults.get(due), 1);
  assert.equal(consults.get(fresh) || 0, 0);
  assert.equal(consults.get(foreign) || 0, 0);
  await assert.rejects(() => refreshPaywallQr(owner, foreign), /记录不存在/);
  await Promise.all([
    releaseGcashSession(owner, due),
    releaseGcashSession(owner, fresh),
    releaseGcashSession(other, foreign),
  ]);
});

test('wall GET ticks query.result without 5-minute UUID refresh', async () => {
  const db = require('../src/db');
  const { encodeExtractLink } = require('../src/utils/accountFields');
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-tick-${suffix}`).lastInsertRowid;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(
    `INSERT INTO gpt_accounts
      (user_id,email,email_type,plan_type,status,progress,channel,gcash_link,gcash_qr,gcash_cs_id,gcash_extracted_at)
     VALUES (?, ?, 'gmail', 'Free', '正常', '支付中', 'gc', ?, ?, ?, ?)`,
  ).run(owner, 'tick@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=tick'), PNG, 'cs-tick', stamp).lastInsertRowid;
  let polls = 0;
  let consults = 0;
  parkGcashSession(owner, id, {
    session: mockSession(async (_url, opts) => {
      const op = rpcOperation(opts);
      if (op.includes('query.result')) {
        polls += 1;
        return { status: 200, data: { success: true, errorActions: [], extendInfo: {}, traceId: 't' } };
      }
      if (op.includes('consult')) {
        consults += 1;
        return { status: 200, data: { success: true, qrCode: PNG, uuid: 'wall-tick-new' } };
      }
      return { status: 200, data: {} };
    }),
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'cs-tick' },
  });
  const lease = getGcashSession(owner, id);
  lease.auth.consultUuid = 'wall-tick-old';
  lease.qrIssuedAt = Date.now() - GCASH_QR_TTL_MS - 10;
  const wall = await paywallWall(owner);
  assert.equal(polls, 1);
  assert.equal(consults, 0);
  assert.equal(lease.auth.consultUuid, 'wall-tick-old');
  const item = wall.items.find((row) => Number(row.id) === Number(id));
  assert.equal(item.status, 'refresh_failed');
  assert.equal(item.processing, false);
  await releaseGcashSession(owner, id);
});

test('wall GET poll with redirect marks processing and does not consult-refresh', async () => {
  const db = require('../src/db');
  const { encodeExtractLink } = require('../src/utils/accountFields');
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-scan-${suffix}`).lastInsertRowid;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(
    `INSERT INTO gpt_accounts
      (user_id,email,email_type,plan_type,status,progress,channel,gcash_link,gcash_qr,gcash_cs_id,gcash_extracted_at)
     VALUES (?, ?, 'gmail', 'Free', '正常', '支付中', 'gc', ?, ?, ?, ?)`,
  ).run(owner, 'scan@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=scan'), PNG, 'cs-scan', stamp).lastInsertRowid;
  let consults = 0;
  let url = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html';
  parkGcashSession(owner, id, {
    session: mockSession(async (_url, opts) => {
      const op = rpcOperation(opts);
      if (op.includes('query.result')) {
        return {
          status: 200,
          data: {
            success: true,
            redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
          },
        };
      }
      if (op.includes('consult')) {
        consults += 1;
        return { status: 200, data: { success: true, qrCode: PNG, uuid: 'must-not-refresh' } };
      }
      return { status: 200, data: {} };
    }),
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'cs-scan' },
    h5: {
      currentUrl: () => url,
      page: { url: () => url, goto: async () => { throw new Error('must not goto Adyen return'); } },
    },
  });
  const lease = getGcashSession(owner, id);
  lease.auth.consultUuid = 'scan-uuid';
  lease.h5SuccessWaitMs = 80;
  setTimeout(() => {
    url = 'https://chatgpt.com/checkout/verify?stripe_session_id=cs-scan';
  }, 20);
  const wall = await paywallWall(owner);
  assert.equal(consults, 0);
  const item = wall.items.find((row) => Number(row.id) === Number(id));
  assert.equal(item.processing, true);
  assert.equal(item.status, 'processing');
  assert.equal(item.scannable, false);
  await releaseGcashSession(owner, id);
});

test('Adyen return URL is processing, not a hidden refresh_failed card', async (t) => {
  const payJob = require('../src/utils/gcashPayJob');
  const orig = payJob.confirmGcashPaid;
  t.after(() => { payJob.confirmGcashPaid = orig; });
  payJob.confirmGcashPaid = async () => ({ paid: false, plan_type: '', expires_at: '' });
  const db = require('../src/db');
  const { encodeExtractLink } = require('../src/utils/accountFields');
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-adyen-${suffix}`).lastInsertRowid;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(
    `INSERT INTO gpt_accounts
      (user_id,email,email_type,plan_type,status,progress,channel,gcash_link,gcash_qr,gcash_cs_id,gcash_extracted_at)
     VALUES (?, ?, 'gmail', 'Free', '正常', '支付中', 'gc', ?, ?, ?, ?)`,
  ).run(owner, 'adyen@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=adyen'), PNG, 'cs-adyen', stamp).lastInsertRowid;
  parkGcashSession(owner, id, {
    session: mockSession(async () => ({
      status: 200,
      data: { success: true, errorActions: [], extendInfo: {}, traceId: 't' },
    })),
    auth: parseGcashAuthPage(AUTH_URL),
    checkout: { cs_id: 'cs-adyen' },
    h5: {
      currentUrl: () => 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn?redirectResult=fixture',
    },
  });
  getGcashSession(owner, id).h5SuccessWaitMs = 0;
  const wall = await paywallWall(owner);
  const item = wall.items.find((row) => Number(row.id) === Number(id));
  assert.equal(item.status, 'processing');
  assert.equal(item.processing, true);
  assert.equal(item.scannable, false);
  assert.equal(item.h5_url_kind, 'adyen_return');
  assert.equal(item.refresh_code, 'SCAN_IN_FLIGHT');
  await releaseGcashSession(owner, id);
});

test('entitlement poll starts after scan is in flight, not only after continue', async () => {
  parkGcashSession(1, 51, {
    session: mockSession(async () => ({ status: 200, data: {} })),
    h5: {
      currentUrl: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html',
      scanComplete: true,
      scanRedirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    },
  });
  const lease = getGcashSession(1, 51);
  assert.equal(scanWorkInFlight(lease), true);
  assert.equal(shouldPollEntitlement(lease), true);
  lease.h5.scanComplete = false;
  lease.h5.scanRedirectUrl = '';
  assert.equal(shouldPollEntitlement(lease), false);
  await releaseGcashSession(1, 51);
});

function pollUuidFromOpts(opts = {}) {
  try {
    const parsed = JSON.parse(String(opts.form?.requestData || '[]'));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return String(first?.uuid || '');
  } catch {
    return '';
  }
}

test('pay monitor slot cap is 20', () => {
  const payJob = require('../src/utils/gcashPayJob');
  assert.equal(payJob.GCASH_PAY_MONITOR_LIMIT, 20);
  assert.equal(payJob.gcashPayMonitorLimit(), 20);
});

test('wall GET polls two parked sessions with distinct consult UUIDs', async () => {
  const db = require('../src/db');
  const { encodeExtractLink } = require('../src/utils/accountFields');
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-multi-${suffix}`).lastInsertRowid;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const insert = db.prepare(
    `INSERT INTO gpt_accounts
      (user_id,email,email_type,plan_type,status,progress,channel,gcash_link,gcash_qr,gcash_cs_id,gcash_extracted_at)
     VALUES (?, ?, 'gmail', 'Free', '正常', '支付中', 'gc', ?, ?, ?, ?)`,
  );
  const first = insert.run(owner, 'one@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=one'), PNG, 'cs-one', stamp).lastInsertRowid;
  const second = insert.run(owner, 'two@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=two'), PNG, 'cs-two', stamp).lastInsertRowid;
  const polled = [];
  for (const [id, uuid] of [[first, 'uuid-one'], [second, 'uuid-two']]) {
    parkGcashSession(owner, id, {
      session: mockSession(async (_url, opts) => {
        const op = rpcOperation(opts);
        if (op.includes('query.result')) {
          polled.push({ id: Number(id), uuid: pollUuidFromOpts(opts) });
          return { status: 200, data: { success: true, errorActions: [], extendInfo: {}, traceId: 't' } };
        }
        if (op.includes('consult')) {
          throw new Error('must not consult-refresh during wall tick');
        }
        return { status: 200, data: {} };
      }),
      auth: parseGcashAuthPage(AUTH_URL),
      checkout: { cs_id: `cs-${id}` },
    });
    getGcashSession(owner, id).auth.consultUuid = uuid;
  }
  const wall = await paywallWall(owner);
  assert.deepEqual(new Set(polled.map((row) => row.uuid)), new Set(['uuid-one', 'uuid-two']));
  assert.equal(polled.find((row) => row.id === Number(first)).uuid, 'uuid-one');
  assert.equal(polled.find((row) => row.id === Number(second)).uuid, 'uuid-two');
  assert.equal(getGcashSession(owner, first).auth.consultUuid, 'uuid-one');
  assert.equal(getGcashSession(owner, second).auth.consultUuid, 'uuid-two');
  const ids = new Set(wall.items.map((item) => Number(item.id)));
  assert.equal(ids.has(Number(first)), true);
  assert.equal(ids.has(Number(second)), true);
  assert.equal(wall.items.find((item) => Number(item.id) === Number(first)).status, 'waiting_scan');
  await Promise.all([releaseGcashSession(owner, first), releaseGcashSession(owner, second)]);
});

test('wall GET Plus during scan marks the account paid', async (t) => {
  const payJob = require('../src/utils/gcashPayJob');
  const orig = payJob.confirmGcashPaid;
  t.after(() => { payJob.confirmGcashPaid = orig; });
  payJob.confirmGcashPaid = async () => ({ paid: true, plan_type: 'Plus', expires_at: '' });
  const db = require('../src/db');
  const { encodeExtractLink } = require('../src/utils/accountFields');
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = db.prepare(
    "INSERT INTO users (username,password_hash,role,level,status) VALUES (?, 'x', 'user', 1, 1)",
  ).run(`wall-plus-${suffix}`).lastInsertRowid;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const id = db.prepare(
    `INSERT INTO gpt_accounts
      (user_id,email,email_type,plan_type,status,progress,channel,gcash_link,gcash_qr,gcash_cs_id,gcash_extracted_at)
     VALUES (?, ?, 'gmail', 'Free', '正常', '支付中', 'gc', ?, ?, ?, ?)`,
  ).run(owner, 'plus@example.test', encodeExtractLink('https://m.gcash.com/pay?fixture=plus'), PNG, 'cs-plus', stamp).lastInsertRowid;
  parkGcashSession(owner, id, {
    session: mockSession(async () => ({ status: 200, data: {} })),
    auth: parseGcashAuthPage(AUTH_URL),
    h5: {
      currentUrl: () => 'https://m.gcash.com/gcashapp/x',
      scanComplete: true,
      scanRedirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    },
  });
  getGcashSession(owner, id).h5SuccessWaitMs = 0;
  const wall = await paywallWall(owner);
  assert.equal(wall.items.some((item) => Number(item.id) === Number(id)), false);
  const row = db.prepare('SELECT progress, activated_at FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(row.progress, '已支付');
  assert.ok(row.activated_at);
  assert.equal(getGcashSession(owner, id), null);
});
