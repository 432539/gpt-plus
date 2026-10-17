'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  captureGcashH5Screenshot,
  readGcashH5Callback,
  followScanRedirectInPage,
  submitGcashContinueInPage,
  closeGcashH5,
  isParkedH5Alive,
  ingestGcashH5Rpc,
  isGcashCheckoutSuccessUrl,
  playwrightNeedsHttpBridge,
  playwrightChromiumLaunchOptions,
  playwrightChromiumLaunchError,
  launchPlaywrightChromium,
  playwrightCookiesFromEntries,
  chatgptIdentityHeaders,
  chatgptSessionPayload,
  installChatgptIdentity,
  bootstrapChatgptIdentity,
  attachH5Handle,
  writeGcashQrImage,
  waitForGcashQrFrame,
  isUsableGcashQrDataUrl,
  FIXTURE_JPEG,
} = require('../src/utils/gcashH5Screenshot');

const VERIFY = 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result';

test('H5 callback parser keeps redirectResult off the kind and reads verify vs success', () => {
  const verifyHit = readGcashH5Callback({ currentUrl: () => VERIFY });
  assert.equal(verifyHit.kind, 'verify');
  assert.equal(verifyHit.checkoutSessionId, 'oaics_fixture');
  assert.equal(verifyHit.redirectResult, 'fixture-result');
  const successHit = readGcashH5Callback({
    currentUrl: () => 'https://chatgpt.com/payments/success',
  });
  assert.equal(successHit.kind, 'success');
  assert.equal(isGcashCheckoutSuccessUrl('https://chatgpt.com/?reason=checkout_success'), true);
  assert.equal(readGcashH5Callback({ currentUrl: () => 'https://m.gcash.com/gcashapp/x' }), null);
  const adyenHit = readGcashH5Callback({
    currentUrl: () => 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn?redirectResult=fixture-result',
  });
  assert.equal(adyenHit.kind, 'adyen');
  assert.equal(Boolean(adyenHit.redirectResult), true);
});

test('H5 DOM redirectResult is treated as scanned without leaving the auth URL', async () => {
  const { ingestH5ScanProgress, h5UrlKind } = require('../src/utils/gcashH5Screenshot');
  const logs = [];
  const h5 = {
    currentUrl: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture',
    page: {
      url: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture',
      content: async () => '<div data-x="redirectResult=fixture-secret"></div>',
    },
  };
  const result = await ingestH5ScanProgress(h5, (_s, m) => logs.push(m), { id: 'dom-scan' });
  assert.equal(h5UrlKind(h5.currentUrl()), 'gcash_auth');
  assert.equal(result.hasRedirect, true);
  assert.equal(result.source, 'dom');
  assert.equal(h5.scanComplete, true);
  assert.ok(logs.some((line) => /H5 DOM 已出现扫码回跳标记/.test(line)));
  assert.equal(logs.some((line) => /fixture-secret/.test(line)), false);
});

test('screenshotImpl can return the H5 landing URL without keeping a browser', async () => {
  const landing = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client';
  const shot = await captureGcashH5Screenshot({
    url: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture',
    screenshotImpl: async () => ({
      qr: 'data:image/png;base64,aaa',
      finalUrl: landing,
    }),
  });
  assert.equal(shot.source, 'screenshot-impl');
  assert.match(shot.finalUrl, /gcash-merchants-auth/);
  assert.equal(shot.finalUrl.includes('checkoutshopper-live.adyen.com'), false);
  assert.equal(shot.h5, null);
});

test('fixture screenshot path does not keep a browser handle', async () => {
  const shot = await captureGcashH5Screenshot({
    url: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect',
    fetchImpl: async () => ({}),
    keepOpen: true,
  });
  assert.equal(shot.source, 'playwright-fixture');
  assert.equal(shot.qr, FIXTURE_JPEG);
  assert.equal(shot.h5, null);
});

test('Playwright launch stays on bundled Chromium with no-sandbox, never Google Chrome', () => {
  const launch = playwrightChromiumLaunchOptions({ server: 'http://127.0.0.1:9' });
  assert.equal(launch.channel, undefined);
  assert.equal(launch.headless, true);
  assert.ok(launch.args.includes('--no-sandbox'));
  assert.ok(launch.args.includes('--disable-dev-shm-usage'));
  assert.deepEqual(launch.proxy, { server: 'http://127.0.0.1:9' });
  const err = playwrightChromiumLaunchError(
    new Error("Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome"),
    '/root/.cache/ms-playwright/chromium-x/chrome-linux/chrome',
  );
  assert.match(err.message, /playwright-core install chromium/);
  assert.match(err.message, /不是 Google Chrome/);
  assert.doesNotMatch(err.message, /npx playwright install chrome/);
});

test('missing bundled Chromium fails before channel chrome fallback', async () => {
  const expected = '/tmp/gpt-plus-missing-playwright-chromium/chrome';
  await assert.rejects(
    () => launchPlaywrightChromium({
      executablePath: () => expected,
      async launch() { throw new Error('should not launch'); },
    }, playwrightChromiumLaunchOptions()),
    /Playwright Chromium 启动失败|bundled Chromium is not installed/,
  );
});

test('launchPlaywrightChromium pins bundled executablePath and never sets channel', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const fake = path.join(os.tmpdir(), `pw-chrome-${Date.now()}`);
  fs.writeFileSync(fake, '');
  let received;
  try {
    await launchPlaywrightChromium({
      executablePath: () => fake,
      async launch(opts) {
        received = opts;
        return { ok: true };
      },
    }, playwrightChromiumLaunchOptions({ server: 'http://127.0.0.1:9' }));
  } finally {
    fs.unlinkSync(fake);
  }
  assert.equal(received.channel, undefined);
  assert.equal(received.executablePath, fake);
  assert.equal(received.headless, true);
  assert.ok(received.args.includes('--no-sandbox'));
  assert.deepEqual(received.proxy, { server: 'http://127.0.0.1:9' });
});

test('authenticated SOCKS5 needs a local HTTP bridge for Chromium', () => {
  assert.equal(playwrightNeedsHttpBridge({
    host: 'proxy.example.test',
    port: 3010,
    proxy_type: 'socks5',
    username: 'user-region-PH',
    password: 'x',
  }), true);
  assert.equal(playwrightNeedsHttpBridge({
    host: 'proxy.example.test',
    port: 8080,
    proxy_type: 'http',
    username: 'user',
    password: 'x',
  }), false);
});

test('Adyen interstitial after wait is not treated as a QR screenshot', async () => {
  const logs = [];
  const page = {
    url: () => 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect',
    evaluate: async () => '',
    screenshot: async () => Buffer.from('interstitial'),
    waitForTimeout: async () => {},
  };
  const waited = await waitForGcashQrFrame(page, (_step, message) => logs.push(String(message)), { timeoutMs: 250 });
  assert.equal(waited.qr, '');
  assert.match(waited.url, /adyen\.com/);
  assert.ok(logs.some((line) => /过渡页/.test(line)));
});

test('GCash page screenshot is used when DOM has no canvas', async () => {
  const fatJpeg = Buffer.alloc(9000, 0x20);
  fatJpeg[0] = 0xff;
  fatJpeg[1] = 0xd8;
  fatJpeg[2] = 0xff;
  fatJpeg[3] = 0xd9;
  const page = {
    url: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=x&clientId=y',
    evaluate: async () => '',
    screenshot: async () => fatJpeg,
    waitForTimeout: async () => {},
  };
  const waited = await waitForGcashQrFrame(page, () => {}, { timeoutMs: 250 });
  assert.match(waited.qr, /^data:image\/jpeg;base64,/);
  assert.match(waited.url, /gcash\.com/);
});

test('blank GCash loading screenshot is not treated as a QR', async () => {
  const logs = [];
  const page = {
    url: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=x&clientId=y',
    evaluate: async () => '',
    screenshot: async () => Buffer.from('tiny'),
    waitForTimeout: async () => {},
  };
  const waited = await waitForGcashQrFrame(page, (_step, message) => logs.push(String(message)), { timeoutMs: 250 });
  assert.equal(waited.qr, '');
  assert.ok(logs.some((line) => /空白/.test(line)));
});

test('GCash DOM image is used before any viewport screenshot', async () => {
  let screenshots = 0;
  const page = {
    url: () => 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=x&clientId=y',
    evaluate: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    screenshot: async () => {
      screenshots += 1;
      return Buffer.from('should-not-use');
    },
    waitForTimeout: async () => {},
  };
  const waited = await waitForGcashQrFrame(page, () => {}, { timeoutMs: 250 });
  assert.match(waited.qr, /^data:image\/png;base64,/);
  assert.equal(screenshots, 0);
});

test('tiny jpeg data URLs are not usable GCash QR images', () => {
  assert.equal(isUsableGcashQrDataUrl(FIXTURE_JPEG), false);
  assert.equal(isUsableGcashQrDataUrl('data:image/png;base64,aaa'), true);
  assert.equal(isUsableGcashQrDataUrl(''), false);
});

test('closeGcashH5 is idempotent', async () => {
  let closed = 0;
  const h5 = {
    async close() { closed += 1; },
  };
  await closeGcashH5(h5);
  await closeGcashH5(h5);
  assert.equal(closed, 1);
});

test('H5 RPC ingest keeps consult uuid and scan redirect on the handle', () => {
  const h5 = {};
  ingestGcashH5Rpc(h5, JSON.stringify({
    result: { uuid: 'consult-uuid-1', success: true, qrCode: '000201fixture' },
  }));
  assert.equal(h5.consultUuid, 'consult-uuid-1');
  ingestGcashH5Rpc(h5, {
    success: true,
    errorActions: [],
    extendInfo: {},
    traceId: 't',
    redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
  });
  assert.equal(h5.scanComplete, true);
  assert.match(String(h5.scanRedirectUrl), /checkoutPaymentReturn/);
  assert.equal(isParkedH5Alive(null), false);
  assert.equal(isParkedH5Alive({ _closed: true, currentUrl: () => 'https://m.gcash.com/x' }), false);
  assert.equal(isParkedH5Alive({ currentUrl: () => 'https://m.gcash.com/x' }), true);
});

test('Playwright cookies preserve host scope and security attributes', () => {
  const cookies = playwrightCookiesFromEntries([
    {
      name: '__Secure-next-auth.session-token',
      value: 'sess',
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
      sameSite: 'lax',
      expires: 2000000000,
      hostOnly: true,
    },
    { name: 'oai-did', value: 'did', domain: '.chatgpt.com', secure: false },
    { name: '', value: 'x' },
  ]);
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies[0], {
    name: '__Secure-next-auth.session-token',
    value: 'sess',
    domain: 'chatgpt.com',
    path: '/',
    secure: true,
    expires: 2000000000,
    sameSite: 'Lax',
  });
  assert.equal(cookies[1].domain, '.chatgpt.com');
  assert.equal(cookies[1].secure, false);
});

test('identity headers only hit ChatGPT APIs', () => {
  const headers = chatgptIdentityHeaders(
    'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
    { referer: 'https://chatgpt.com/checkout/verify' },
    { accessToken: 'tok', accountId: 'acct', deviceId: 'did', sessionId: 'sid' },
  );
  assert.equal(headers.authorization, 'Bearer tok');
  assert.equal(headers['chatgpt-account-id'], 'acct');
  assert.equal(headers['oai-device-id'], 'did');
  assert.equal(headers['oai-session-id'], 'sid');
  const native = chatgptIdentityHeaders(
    'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
    {
      authorization: 'Bearer native',
      'chatgpt-account-id': 'native-account',
      'oai-web-deployment-attestation': 'native-attestation',
      'x-oai-is-client-observation': 'native-observation',
    },
    { accessToken: 'fallback', accountId: 'fallback-account', deviceId: 'did', sessionId: 'sid' },
  );
  assert.equal(native.authorization, 'Bearer native');
  assert.equal(native['chatgpt-account-id'], 'native-account');
  assert.equal(native['oai-web-deployment-attestation'], 'native-attestation');
  assert.equal(native['x-oai-is-client-observation'], 'native-observation');
  const gcash = chatgptIdentityHeaders('https://m.gcash.com/gcashapp/x', { referer: 'x' }, { accessToken: 'tok' });
  assert.equal(gcash.authorization, undefined);
});

test('route interception preserves native dynamic and identity headers', async () => {
  const handlers = [];
  const context = {
    route: async (_pattern, handler) => handlers.push(handler),
  };
  await installChatgptIdentity(context, {
    accessToken: 'fallback-token',
    accountId: 'fallback-account',
    deviceId: 'fallback-device',
    sessionId: 'fallback-session',
  });
  let continued;
  await handlers[0]({
    request: () => ({
      url: () => 'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
      method: () => 'POST',
      headers: () => ({
        authorization: 'Bearer native-token',
        'chatgpt-account-id': 'native-account',
        'oai-device-id': 'native-device',
        'oai-session-id': 'native-session',
        'oai-web-deployment-attestation': 'native-attestation',
        'x-oai-is-client-observation': 'native-observation',
      }),
    }),
    continue: async (options) => { continued = options; },
  });
  assert.equal(continued.headers.authorization, 'Bearer native-token');
  assert.equal(continued.headers['chatgpt-account-id'], 'native-account');
  assert.equal(continued.headers['oai-device-id'], 'native-device');
  assert.equal(continued.headers['oai-session-id'], 'native-session');
  assert.equal(continued.headers['oai-web-deployment-attestation'], 'native-attestation');
  assert.equal(continued.headers['x-oai-is-client-observation'], 'native-observation');
});

test('session bootstrap prefers the real authenticated response over the fallback stub', async () => {
  const handlers = [];
  const context = { route: async (_pattern, handler) => handlers.push(handler) };
  await installChatgptIdentity(context, { accessToken: 'fallback-token', accountId: 'fallback-account' });
  let fulfilled;
  await handlers[0]({
    request: () => ({
      url: () => 'https://chatgpt.com/api/auth/session',
      method: () => 'GET',
      headers: () => ({ accept: '*/*' }),
    }),
    fetch: async () => ({
      status: () => 200,
      text: async () => JSON.stringify({ accessToken: 'native-token', account: { id: 'native-account' } }),
    }),
    fulfill: async (options) => { fulfilled = options; },
  });
  assert.ok(fulfilled.response);
  assert.match(fulfilled.body, /native-account/);
  assert.equal(fulfilled.status, undefined);
});

test('context-level listeners capture popup verify and its continue response', () => {
  const context = new EventEmitter();
  const original = new EventEmitter();
  original.url = () => 'https://m.gcash.com/gcashapp/x';
  context.pages = () => [original];
  const h5 = attachH5Handle({}, context, original, {});
  const popup = new EventEmitter();
  popup.url = () => 'about:blank';
  context.emit('page', popup);
  popup.emit('request', { url: () => VERIFY });
  popup.emit('response', {
    url: () => 'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
    status: () => 200,
  });
  const hit = readGcashH5Callback(h5);
  assert.equal(hit.kind, 'verify');
  assert.equal(hit.checkoutSessionId, 'oaics_fixture');
  assert.equal(h5.callbackPage, popup);
  assert.equal(h5.browserContinueSeen, true);
  assert.equal(h5.browserContinueHttp, 200);
});

test('native continue 4xx records only safe response keys and code', async () => {
  const context = new EventEmitter();
  const page = new EventEmitter();
  page.url = () => VERIFY;
  context.pages = () => [page];
  const logs = [];
  const h5 = attachH5Handle({}, context, page, {}, (_step, message) => logs.push(String(message)));
  page.emit('response', {
    url: () => 'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
    status: () => 422,
    json: async () => ({
      detail: 'redirectResult=must-not-log',
      error: { code: 'unprocessable_continue', message: 'secret body' },
    }),
  });
  await h5.browserContinueDetailPromise;
  assert.equal(h5.browserContinueSeen, true);
  assert.equal(h5.browserContinueHttp, 422);
  assert.deepEqual(h5.browserContinueError, {
    status: 422,
    body_keys: ['detail', 'error'],
    error_code: 'unprocessable_continue',
  });
  assert.ok(logs.some((line) => /HTTP 422 keys=\[detail,error\] code=unprocessable_continue/.test(line)));
  assert.equal(logs.some((line) => /must-not-log|secret body|redirectResult=/.test(line)), false);
});

test('verify diagnostics expose only app readiness counters', async () => {
  const context = new EventEmitter();
  const page = new EventEmitter();
  page.url = () => VERIFY;
  page.evaluate = async () => ({ ready_state: 'complete', script_count: 14, has_app_root: true });
  context.pages = () => [page];
  const h5 = attachH5Handle({}, context, page, {});
  page.emit('console', { type: () => 'error' });
  page.emit('pageerror', new Error('hidden sensitive page error'));
  assert.deepEqual(await h5.verifyDiagnostics(), {
    url_kind: 'verify',
    ready_state: 'complete',
    script_count: 14,
    has_app_root: true,
    console_errors: 1,
    page_errors: 1,
  });
});

test('route interception keeps cookies and native dynamic headers from allHeaders', async () => {
  const handlers = [];
  const context = { route: async (_pattern, handler) => handlers.push(handler) };
  await installChatgptIdentity(context, {
    accessToken: 'fallback-token',
    accountId: 'fallback-account',
    deviceId: 'fallback-device',
    sessionId: 'fallback-session',
  });
  let continued;
  await handlers[0]({
    request: () => ({
      url: () => 'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
      method: () => 'POST',
      headers: () => ({
        authorization: 'Bearer native-token',
        'chatgpt-account-id': 'native-account',
      }),
      allHeaders: async () => ({
        authorization: 'Bearer native-token',
        cookie: '__Secure-next-auth.session-token=sess',
        'chatgpt-account-id': 'native-account',
        'oai-device-id': 'native-device',
        'oai-session-id': 'native-session',
        'oai-web-deployment-attestation': 'native-attestation',
        'x-oai-is-client-observation': 'native-observation',
      }),
    }),
    continue: async (options) => { continued = options; },
  });
  assert.equal(continued.headers.cookie, '__Secure-next-auth.session-token=sess');
  assert.equal(continued.headers.authorization, 'Bearer native-token');
  assert.equal(continued.headers['oai-web-deployment-attestation'], 'native-attestation');
  assert.equal(continued.headers['x-oai-is-client-observation'], 'native-observation');
});

test('H5 waits for native Adyen return instead of forcing page.goto', async () => {
  const logs = [];
  let url = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html';
  const h5 = {
    currentUrl: () => url,
    page: {
      url: () => url,
      goto: async () => { throw new Error('must not goto Adyen return'); },
    },
  };
  setTimeout(() => { url = VERIFY; }, 40);
  const landed = await followScanRedirectInPage(
    h5,
    'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    (_step, message) => logs.push(String(message)),
    { timeoutMs: 800 },
  );
  assert.equal(landed.kind, 'verify');
  assert.equal(landed.checkoutSessionId, 'oaics_fixture');
  assert.ok(logs.some((line) => /自行回跳/.test(line)));
  assert.equal(logs.some((line) => /checkoutPaymentReturn/.test(line)), false);
});

test('failed native continue is replayed once with its dynamic headers in the same page', async () => {
  const logs = [];
  const context = new EventEmitter();
  const page = new EventEmitter();
  page.url = () => VERIFY;
  let replayCount = 0;
  page.evaluate = async (_fn, request) => {
    replayCount += 1;
    assert.match(request.url, /custom_payment_method\/continue$/);
    assert.equal(request.headers['oai-web-deployment-attestation'], 'same-request-attestation');
    assert.equal(request.headers['x-oai-is-client-observation'], 'same-request-observation');
    assert.equal(request.headers.cookie, undefined);
    assert.equal(JSON.parse(request.body).checkout_session_id, 'oaics_fixture');
    return { status: 200, keys: ['status', 'next_action'], errorCode: '' };
  };
  context.pages = () => [page];
  const h5 = attachH5Handle({}, context, page, {}, (_step, message) => logs.push(String(message)));
  const failed = {
    url: () => 'https://chatgpt.com/backend-api/payments/checkout/custom_payment_method/continue',
    method: () => 'POST',
    postData: () => JSON.stringify({
      checkout_session_id: 'oaics_fixture',
      custom_payment_method_type_id: 'cpmt_x',
      redirect_result: 'fixture-result',
    }),
    headers: () => ({ 'content-type': 'application/json' }),
    allHeaders: async () => ({
      'content-type': 'application/json',
      cookie: 'not-replayed-directly',
      'oai-web-deployment-attestation': 'same-request-attestation',
      'x-oai-is-client-observation': 'same-request-observation',
    }),
  };
  page.emit('requestfailed', failed);
  await new Promise((resolve) => setImmediate(resolve));
  const result = await submitGcashContinueInPage(h5, {
    path: '/backend-api/payments/checkout/custom_payment_method/continue',
    json: {},
  }, (_step, message) => logs.push(String(message)));
  assert.equal(result.ok, true);
  assert.equal(result.via, 'native-request-replay');
  assert.equal(h5.browserContinueSeen, true);
  assert.equal(h5.browserContinueHttp, 200);
  assert.equal(replayCount, 1);
  const second = await h5.retryFailedContinue();
  assert.equal(second.skipped, true);
  assert.equal(replayCount, 1);
  assert.ok(logs.some((line) => /原样重试.*成功/.test(line)));
});

test('saved verify URL recovers a mistaken ChatGPT homepage redirect in the same page', async () => {
  const context = new EventEmitter();
  const original = new EventEmitter();
  let current = 'https://m.gcash.com/gcashapp/x';
  const navigations = [];
  original.url = () => current;
  original.goto = async (url) => {
    navigations.push(url);
    current = url;
  };
  context.pages = () => [original];
  const h5 = attachH5Handle({}, context, original, {});
  original.emit('request', { url: () => VERIFY });
  current = 'https://chatgpt.com/';
  assert.equal(await h5.recoverVerify(), true);
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0], VERIFY);
  assert.equal(h5.context, context);
  assert.equal(h5.page, original);
});

test('frame navigation captures verify even when the top page never changes', () => {
  const context = new EventEmitter();
  const original = new EventEmitter();
  original.url = () => 'https://m.gcash.com/gcashapp/x';
  context.pages = () => [original];
  const h5 = attachH5Handle({}, context, original, {});
  original.emit('framenavigated', { url: () => VERIFY });
  assert.equal(readGcashH5Callback(h5).kind, 'verify');
});

test('Adyen Location header is captured as checkout verify without forcing goto', () => {
  const context = new EventEmitter();
  const page = new EventEmitter();
  page.url = () => 'https://m.gcash.com/gcashapp/x';
  context.pages = () => [page];
  const h5 = attachH5Handle({}, context, page, {});
  page.emit('response', {
    url: () => 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    headers: () => ({ location: VERIFY }),
  });
  assert.equal(readGcashH5Callback(h5).kind, 'verify');
  assert.equal(h5.callback.checkoutSessionId, 'oaics_fixture');
});

test('session payload keeps accessToken for the headed /api/auth/session stub', () => {
  const payload = {
    sub: 'user_x',
    exp: 2000000000,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'free' },
    'https://api.openai.com/profile': { email: 'a@example.test' },
  };
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
  const session = chatgptSessionPayload(token, 'acct-1');
  assert.equal(session.accessToken, token);
  assert.equal(session.account.id, 'acct-1');
  assert.equal(session.user.email, 'a@example.test');
});

test('browser bootstrap requires both session stub and real backend account context', async () => {
  const logs = [];
  const ready = await bootstrapChatgptIdentity({
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => ({
      sessionStatus: 200,
      sessionAuthenticated: true,
      backendStatuses: [200, 404],
    }),
  }, (_step, message) => logs.push(String(message)));
  assert.equal(ready, true);
  assert.ok(logs.some((line) => /登录态已验证/.test(line)));

  const missing = await bootstrapChatgptIdentity({
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => ({
      sessionStatus: 200,
      sessionAuthenticated: true,
      backendStatuses: [401, 403],
    }),
  }, (_step, message) => logs.push(String(message)));
  assert.equal(missing, false);
  assert.ok(logs.some((line) => /backend=\[401,403\]/.test(line)));
});

test('writeGcashQrImage writes a jpeg from a data URL', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dest = path.join(os.tmpdir(), `gcash-qr-${Date.now()}.jpg`);
  const written = writeGcashQrImage(FIXTURE_JPEG, dest);
  assert.equal(written, dest);
  assert.ok(fs.statSync(dest).size > 10);
  fs.unlinkSync(dest);
});
