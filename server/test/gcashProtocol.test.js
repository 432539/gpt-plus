'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GCASH_QR_TTL_MS,
  GCASH_URL_TTL_MS,
  formatCountdown,
  remainingTtlMs,
  qrNeedsRefresh,
  GCASH_AUTH_STATELESS_CONSULT,
  GCASH_QUERY_RESULT,
  GCASH_QUERY_ACCESS_TOKEN,
  CHATGPT_CONTINUE_PATH,
  PROTOCOL_KEYS,
  parseGcashAuthPage,
  preferReadyGcashLink,
  authPageQueryString,
  isGcashScanComplete,
  protocolKeyList,
  redirectFlag,
  extractRedirectResult,
  protocolSuccessFlag,
  buildGcashConsultRequest,
  buildGcashPollRequest,
  buildGcashContinueRequest,
  rememberConsultSession,
  consultGcashQr,
  consultQrPayload,
  consultQrKind,
  continueRequestSafeView,
  continueResponseSafeView,
  parseCheckoutVerifyUrl,
  checkoutVerifySafeView,
  chatgptVerifyHeaders,
  followScanRedirect,
  pollGcashScan,
} = require('../src/utils/gcashProtocol');

const AUTH_URL = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5&redirectUrl=https%3A%2F%2Fcheckoutshopper-live.adyen.com%2Fcheckoutshopper%2FcheckoutPaymentReturn';

test('paywall link prefers ready merchants-auth landing over Adyen first hop', () => {
  const adyen = 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture';
  assert.equal(preferReadyGcashLink(adyen, AUTH_URL), AUTH_URL);
  assert.equal(preferReadyGcashLink(adyen, adyen), adyen);
  assert.equal(preferReadyGcashLink(adyen, 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html'), adyen);
});

test('auth page parser keeps ids in memory and only exposes query keys', () => {
  const auth = parseGcashAuthPage(AUTH_URL);
  assert.equal(auth.ready, true);
  assert.equal(auth.bindingId, 'fixture-bind');
  assert.equal(auth.authId, 'fixture-client');
  assert.ok(auth.queryKeys.includes('netAuthId'));
  assert.ok(auth.queryKeys.includes('clientId'));
  assert.ok(auth.queryKeys.includes('redirectUrl'));
  assert.equal(auth.scopes, 'AGREEMENT_PAY');
});

test('consult request uses HAR form envelope, aggregator channel, and envInfo', () => {
  const auth = parseGcashAuthPage(AUTH_URL);
  const built = buildGcashConsultRequest(auth);
  assert.equal(built.method, 'POST');
  assert.match(built.url, /mgs-gw\.paas\.mynt\.xyz\/mgw\.htm$/);
  assert.match(built.headers['Content-Type'], /x-www-form-urlencoded/);
  assert.equal(built.form.operationType, GCASH_AUTH_STATELESS_CONSULT);
  assert.equal(built.form.version, '2.0');
  assert.equal(built.form.appId, 'D54528A131559');
  assert.equal(built.form.workspaceId, 'PROD');
  assert.equal(built.form.tenantId, 'MYNTPH');
  const payload = JSON.parse(built.form.requestData);
  assert.equal(payload[0].bizType, 'ACQUIRING');
  assert.equal(payload[0].channel, 'aggregator');
  assert.equal(payload[0].expireSeconds, 300);
  assert.deepEqual(payload[0].extParams, {});
  assert.equal(payload[0].envInfo.osType, 'WindowsNT');
  assert.equal(payload[0].envInfo.osVersion, '10.0');
  assert.equal(payload[0].envInfo.browserType, 'Chrome');
  assert.equal(payload[0].envInfo.browserVersion, '136');
  assert.equal(payload[0].envInfo.terminalType, 'WEB');
  assert.equal(payload[0].envInfo.tokenId, auth.tokenId);
  assert.ok(payload[0].envInfo.tokenId);
  assert.equal(payload[0].originalUrl, AUTH_URL);
  assert.equal(typeof payload[0].urlParameters, 'string');
  assert.match(payload[0].urlParameters, /terminalType=H5/);
  assert.match(payload[0].urlParameters, /(?:^|&)netAuthId=/);
  assert.equal(payload[0].urlParameters.startsWith('?'), false);
  assert.equal(payload[0].urlParameters.startsWith('http'), false);
  assert.notEqual(payload[0].urlParameters, payload[0].originalUrl);
  assert.equal(JSON.stringify(built).includes('cookie'), false);
  assert.equal(JSON.stringify(built).includes('Bearer'), false);
});

test('consult urlParameters is the auth page query string, not a key map', () => {
  const auth = parseGcashAuthPage(AUTH_URL);
  const built = buildGcashConsultRequest(auth);
  const payload = JSON.parse(built.form.requestData);
  const query = authPageQueryString(AUTH_URL);
  assert.equal(payload[0].urlParameters, query);
  assert.equal(query.startsWith('?'), false);
  assert.match(query, /clientId=fixture-client/);
  assert.equal(query.includes('https://'), false);
});

test('consult prefers EMV, then short.dynamic.link, then GCSHLNKV', () => {
  assert.equal(consultQrKind('00020101021226580014com.gcash.www0111payload'), 'emv');
  assert.equal(consultQrKind('GCSHLNKVabcdefgh'), 'gcshlnkv');
  assert.equal(consultQrKind('https://short.dynamic.link/GCSHLNKVabcdefgh'), 'short_url');
  assert.equal(
    consultQrPayload({
      qrCode: 'GCSHLNKVabcdefgh',
      shortUrl: 'https://short.dynamic.link/GCSHLNKVabcdefgh',
    }),
    'https://short.dynamic.link/GCSHLNKVabcdefgh',
  );
  assert.equal(
    consultQrPayload({
      qrCode: '00020101021226580014com.gcash.www0111payload',
      shortUrl: 'https://short.dynamic.link/GCSHLNKVabcdefgh',
    }),
    '00020101021226580014com.gcash.www0111payload',
  );
  assert.equal(consultQrPayload({ qrCode: 'GCSHLNKVabcdefgh' }), 'GCSHLNKVabcdefgh');
});

test('poll request uses gka.query.result form body from the successful HAR', () => {
  const auth = parseGcashAuthPage(AUTH_URL);
  auth.consultUuid = '1787490363225-6111-10.76.6.30-227477200';
  const built = buildGcashPollRequest(auth);
  assert.equal(built.form.operationType, GCASH_QUERY_RESULT);
  assert.equal(built.form.operationType, GCASH_QUERY_ACCESS_TOKEN);
  assert.equal(built.form.version, '2.0');
  assert.equal(built.form.appId, 'D54528A131559');
  assert.equal(built.form.workspaceId, 'PROD');
  assert.equal(built.form.tenantId, 'MYNTPH');
  assert.match(built.headers['Content-Type'], /x-www-form-urlencoded/);
  const payload = JSON.parse(built.form.requestData);
  assert.equal(payload[0].envInfo.terminalType, 'WEB');
  assert.equal(payload[0].envInfo.osType, 'WindowsNT');
  assert.equal(payload[0].envInfo.tokenId, auth.tokenId);
  assert.ok(payload[0].envInfo.tokenId);
  assert.equal(payload[0].uuid, '1787490363225-6111-10.76.6.30-227477200');
  assert.deepEqual(payload[0].extParams, {});
});

test('consult envInfo.tokenId and result.uuid are reused by every query.result poll', async () => {
  const auth = parseGcashAuthPage(AUTH_URL);
  const consult = buildGcashConsultRequest(auth);
  const consultPayload = JSON.parse(consult.form.requestData)[0];
  const sessionUuid = '1787490363225-6111-10.76.6.30-227477200';
  const session = {
    request: async () => ({
      status: 200,
      data: {
        resultStatus: 1000,
        result: {
          success: true,
          qrCode: 'data:image/png;base64,fixture-qr',
          uuid: sessionUuid,
          errorActions: [],
          extendInfo: {},
          traceId: 'fixture-trace',
        },
      },
    }),
  };
  await consultGcashQr(session, auth);
  assert.equal(auth.consultUuid, sessionUuid);
  assert.equal(auth.tokenId, consultPayload.envInfo.tokenId);
  const first = JSON.parse(buildGcashPollRequest(auth).form.requestData)[0];
  const second = JSON.parse(buildGcashPollRequest(auth).form.requestData)[0];
  assert.deepEqual(first.envInfo, consultPayload.envInfo);
  assert.equal(first.uuid, sessionUuid);
  assert.equal(second.uuid, sessionUuid);
  assert.equal(second.envInfo.tokenId, first.envInfo.tokenId);
  rememberConsultSession(auth, {
    result: { success: true, qrCode: 'data:image/png;base64,next', uuid: '1787490363225-6111-10.76.6.30-999999999' },
  });
  const afterRefresh = JSON.parse(buildGcashPollRequest(auth).form.requestData)[0];
  assert.equal(afterRefresh.uuid, '1787490363225-6111-10.76.6.30-999999999');
  assert.equal(afterRefresh.envInfo.tokenId, consultPayload.envInfo.tokenId);
});

test('continue request shape matches custom_payment_method/continue', () => {
  const built = buildGcashContinueRequest({
    checkoutSessionId: 'oaics_fixture',
    customPaymentMethodTypeId: 'cpmt_gcash_fixture',
    redirectResult: 'fixture-result',
    verifyUrl: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&redirectResult=fixture-result',
  });
  assert.equal(built.method, 'POST');
  assert.equal(built.path, CHATGPT_CONTINUE_PATH);
  assert.deepEqual(built.json, {
    checkout_session_id: 'oaics_fixture',
    custom_payment_method_type_id: 'cpmt_gcash_fixture',
    redirect_result: 'fixture-result',
  });
  assert.match(built.verifyUrl, /\/checkout\/verify/);
  assert.deepEqual(continueRequestSafeView(built), {
    path: CHATGPT_CONTINUE_PATH,
    method: 'POST',
    body_keys: ['checkout_session_id', 'custom_payment_method_type_id', 'redirect_result'],
  });
});

test('continue 422 safe view keeps keys and error code without redirectResult', () => {
  const view = continueResponseSafeView({
    status: 422,
    data: {
      error: { code: 'redirect_already_used', message: 'redirectResult=secret-result' },
      detail: 'unprocessable',
    },
    text: '{"error":{"code":"redirect_already_used"}}',
  });
  assert.deepEqual(view.body_keys, ['detail', 'error']);
  assert.equal(view.status, 422);
  assert.equal(view.error_code, 'redirect_already_used');
  assert.equal(JSON.stringify(view).includes('secret-result'), false);
});

test('checkout/verify parser keeps redirectResult off the safe view', () => {
  const parsed = parseCheckoutVerifyUrl(
    'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=secret-result',
  );
  assert.equal(parsed.checkoutSessionId, 'oaics_fixture');
  assert.equal(parsed.currency, 'PHP');
  assert.equal(parsed.redirectResult, 'secret-result');
  assert.deepEqual(checkoutVerifySafeView(parsed), {
    has_verify: true,
    has_redirect_result: true,
    checkout_session_id: 'oaics_fixture',
    processor_entity: 'openai_llc',
    currency: 'PHP',
  });
  const headers = chatgptVerifyHeaders(parsed.verifyUrl, CHATGPT_CONTINUE_PATH);
  assert.match(headers.Referer, /\/checkout\/verify/);
  assert.equal(headers['oai-language'], 'fil-PH');
  assert.equal(headers['Accept-Language'], 'fil-PH,en;q=0.9');
});

test('scan is incomplete when success is true but redirect is missing', () => {
  const waiting = {
    errorActions: [],
    extendInfo: {},
    success: true,
    traceId: 'fixture-trace',
  };
  assert.equal(isGcashScanComplete(waiting), false);
  assert.equal(redirectFlag(waiting), '无');
  assert.equal(protocolSuccessFlag(waiting), true);
  assert.deepEqual(protocolKeyList(waiting), ['errorActions', 'extendInfo', 'success', 'traceId']);
  assert.ok(PROTOCOL_KEYS.includes('redirectUrl'));
  assert.equal(Boolean(extractRedirectResult('https://example.test/return?redirectResult=fixture-secret')), true);
  assert.equal(Boolean(extractRedirectResult('<script>redirectResult=fixture-secret</script>')), true);
  assert.equal(extractRedirectResult('https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html'), '');
});

test('scan completes only after redirectUrl appears', () => {
  const done = {
    errorActions: [],
    extendInfo: {},
    redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    success: true,
    traceId: 'fixture-trace',
  };
  assert.equal(isGcashScanComplete(done), true);
  assert.equal(redirectFlag(done), '有');
  assert.deepEqual(protocolKeyList(done), ['errorActions', 'extendInfo', 'redirectUrl', 'success', 'traceId']);
});

test('pollGcashScan only fires continue when redirect is present', async () => {
  const payloads = [
    { success: true, errorActions: [], extendInfo: {}, traceId: 'a' },
    {
      success: true,
      errorActions: [],
      extendInfo: {},
      traceId: 'b',
      redirectUrl: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    },
  ];
  const logs = [];
  const session = {
    request: async () => {
      const data = payloads.shift();
      return { status: 200, data, text: JSON.stringify(data) };
    },
  };
  const auth = parseGcashAuthPage(AUTH_URL);
  const first = await pollGcashScan(session, auth, (_step, message) => logs.push(String(message)));
  assert.equal(first.complete, false);
  assert.equal(logs.some((line) => /continue/.test(line)), false);
  const second = await pollGcashScan(session, auth, (_step, message) => logs.push(String(message)));
  assert.equal(second.complete, true);
  assert.ok(logs.some((line) => /协议轮询检测到扫码完成/.test(line)));
  assert.ok(logs.some((line) => /checkout\/verify/.test(line) || /Adyen return/.test(line)));
  assert.equal(logs.some((line) => /checkoutPaymentReturn/.test(line)), false);
});

test('followScanRedirect lands on checkout/verify and returns redirectResult', async () => {
  const session = {
    request: async (url) => ({
      status: 200,
      data: {},
      url: 'https://chatgpt.com/checkout/verify?stripe_session_id=oaics_fixture&processor_entity=openai_llc&plan_type=plus&currency=PHP&redirectResult=fixture-result',
      text: '',
    }),
  };
  const logs = [];
  const followed = await followScanRedirect(
    session,
    'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentReturn',
    (_step, message) => logs.push(String(message)),
  );
  assert.equal(followed.ok, true);
  assert.equal(followed.checkoutSessionId, 'oaics_fixture');
  assert.equal(followed.redirectResult, 'fixture-result');
  assert.match(followed.verifyUrl, /\/checkout\/verify/);
  assert.ok(logs.some((line) => /\/checkout\/verify/.test(line)));
});

test('QR countdown is 5 minutes and URL lasts 24 hours', () => {
  assert.equal(GCASH_QR_TTL_MS, 5 * 60 * 1000);
  assert.equal(GCASH_URL_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(formatCountdown(GCASH_QR_TTL_MS), '5:00');
  const issued = Date.now() - 60 * 1000;
  assert.equal(qrNeedsRefresh(issued, Date.now(), GCASH_QR_TTL_MS), false);
  assert.equal(qrNeedsRefresh(issued - GCASH_QR_TTL_MS, Date.now(), GCASH_QR_TTL_MS), true);
  assert.ok(remainingTtlMs(issued, GCASH_QR_TTL_MS) <= 4 * 60 * 1000);
  assert.ok(remainingTtlMs(Date.now(), GCASH_URL_TTL_MS) > 23 * 60 * 60 * 1000);
});
