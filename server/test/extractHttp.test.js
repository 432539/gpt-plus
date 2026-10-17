const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXTRACT_BROWSER,
  EXTRACT_USER_AGENT,
  EXTRACT_CHROME_PROFILES,
  EXTRACT_SAFARI_IMPERSONATE,
  EXTRACT_SAFARI_USER_AGENT,
  createExtractCookieJar,
  createExtractSession,
  resolveExtractBrowser,
  randomChromeFingerprint,
  chromeFingerprintFor,
  fingerprintFor,
  safari17Fingerprint,
  chromeMajorFromImpersonate,
  isUnsupportedImpersonateError,
  rememberUnsupportedImpersonate,
  resetUnsupportedImpersonates,
  buildProxyUrl,
} = require('../src/utils/extractHttp');
const { recoverableExtractError } = require('../src/utils/paymentLink');

test('extract impersonate pins reference-aligned Chrome 136 headers', () => {
  assert.equal(EXTRACT_BROWSER, 'chrome136');
  assert.equal(resolveExtractBrowser(''), 'chrome136');
  assert.match(EXTRACT_USER_AGENT, /Windows NT 10\.0.+Chrome\/136\.0\.0\.0/);
  assert.equal(
    chromeFingerprintFor('chrome136').secChUa,
    '"Google Chrome";v="136", "Chromium";v="136", "Not_A Brand";v="99"',
  );
  assert.equal(chromeFingerprintFor('chrome136').headers['sec-ch-ua-full-version-list'], undefined);
});

test('extract fingerprint pool is chrome131/136 primary with optional 142', () => {
  resetUnsupportedImpersonates();
  const impersonates = EXTRACT_CHROME_PROFILES.map((item) => item.impersonate);
  assert.deepEqual(impersonates, ['chrome131', 'chrome136', 'chrome142']);
  assert.equal(impersonates.includes('chrome145'), false);
  assert.equal(impersonates.includes('chrome146'), false);
  assert.equal(impersonates.includes('chrome120'), false);
  for (const profile of EXTRACT_CHROME_PROFILES) {
    const mapped = chromeFingerprintFor(profile.impersonate);
    assert.equal(mapped.impersonate, profile.impersonate);
    assert.equal(mapped.chromeMajor, profile.major);
    assert.equal(chromeMajorFromImpersonate(mapped.impersonate), profile.major);
    assert.match(mapped.userAgent, new RegExp(`Chrome/${profile.major}\\.0\\.0\\.0`));
    assert.equal(
      mapped.secChUa,
      `"Google Chrome";v="${profile.major}", "Chromium";v="${profile.major}", "Not_A Brand";v="99"`,
    );
    assert.equal(mapped.headers['Accept-Language'], 'en-GB,en;q=0.9');
    assert.equal(mapped.headers['sec-ch-ua-platform'], '"Windows"');
    assert.equal(mapped.headers['sec-ch-ua-mobile'], '?0');
    assert.equal(mapped.headers['sec-ch-ua-full-version-list'], undefined);
  }
  const stale = chromeFingerprintFor('chrome120');
  assert.equal(stale.impersonate, 'chrome136');
  assert.match(stale.userAgent, /Chrome\/136\.0\.0\.0/);
  assert.equal(chromeFingerprintFor('chrome146').impersonate, 'chrome136');
  assert.equal(chromeFingerprintFor('chrome145').impersonate, 'chrome136');
  const first = randomChromeFingerprint();
  assert.equal(first.headers['sec-ch-ua-platform'], '"Windows"');
  assert.equal(['chrome131', 'chrome136', 'chrome142'].includes(first.impersonate), true);
  const session = createExtractSession({
    impersonate: 'chrome142',
    fetchImpl: async () => ({ status: 200, text: '{}', headers: {}, url: 'https://example.test' }),
  });
  assert.equal(session.fingerprint.impersonate, 'chrome142');
  assert.notEqual(session.fingerprint.userAgent, EXTRACT_USER_AGENT);
});

test('Safari 17 fingerprint has no Chrome Client Hints and is pinned for iDEAL', () => {
  resetUnsupportedImpersonates();
  assert.equal(EXTRACT_SAFARI_IMPERSONATE, 'safari17_0');
  assert.equal(resolveExtractBrowser('safari17_0'), 'safari17_0');
  const safari = fingerprintFor('safari17_0');
  assert.equal(safari.impersonate, 'safari17_0');
  assert.equal(safari.browser, 'safari');
  assert.equal(safari.userAgent, EXTRACT_SAFARI_USER_AGENT);
  assert.match(safari.userAgent, /Version\/17\.0 Safari\/605\.1\.15/);
  assert.equal(safari.headers['sec-ch-ua'], undefined);
  assert.equal(safari.headers['sec-ch-ua-mobile'], undefined);
  assert.equal(safari.headers['sec-ch-ua-platform'], undefined);
  assert.equal(safari17Fingerprint().impersonate, 'safari17_0');
  rememberUnsupportedImpersonate('safari17_0');
  assert.equal(resolveExtractBrowser('safari17_0'), 'safari17_0');
  resetUnsupportedImpersonates();
  const session = createExtractSession({
    impersonate: 'safari17_0',
    fetchImpl: async () => ({ status: 200, text: '{}', headers: {}, url: 'https://example.test' }),
  });
  assert.equal(session.fingerprint.impersonate, 'safari17_0');
  assert.equal(session.fingerprint.headers['sec-ch-ua'], undefined);
});

test('unsupported impersonate errors are rebuildable instead of failing the job', () => {
  resetUnsupportedImpersonates();
  const error = new Error('Impersonating chrome142 is not supported');
  assert.equal(isUnsupportedImpersonateError(error), true);
  assert.equal(recoverableExtractError(error), true);
  rememberUnsupportedImpersonate('chrome142');
  assert.equal(resolveExtractBrowser('chrome142'), 'chrome136');
  resetUnsupportedImpersonates();
});

test('sticky HTTP proxy URL keeps encoded credentials out of the host field', () => {
  const url = buildProxyUrl({
    proxy_type: 'http',
    host: '127.0.0.1',
    port: 8002,
    username: 'user-sid-gb1',
    password: 'p@ss:word',
  });
  assert.equal(url, 'http://user-sid-gb1:p%40ss%3Aword@127.0.0.1:8002');
});

test('curl_cffi SOCKS proxy URL forces remote DNS resolution', () => {
  const url = buildProxyUrl({
    proxy_type: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'user@tenant',
    password: 'p@ss:word',
  });
  assert.equal(url, 'socks5h://user%40tenant:p%40ss%3Aword@127.0.0.1:1080');
});

test('cookie jar seeds chatgpt cookies without leaking them to stripe.com', async () => {
  const jar = createExtractCookieJar();
  await jar.setCookie('oai-did=did-1; Domain=.chatgpt.com; Path=/; Secure', 'https://chatgpt.com/');
  await jar.setCookie('sid=stripe-sid; Domain=.stripe.com; Path=/; Secure', 'https://api.stripe.com/');
  assert.match(jar.getCookieString('https://chatgpt.com/backend-api/payments/checkout'), /oai-did=did-1/);
  assert.doesNotMatch(jar.getCookieString('https://chatgpt.com/backend-api/payments/checkout'), /stripe-sid/);
  assert.match(jar.getCookieString('https://api.stripe.com/v1/payment_methods'), /sid=stripe-sid/);
  const dumped = jar.dump();
  assert.equal(dumped.some((row) => row.name === 'oai-did' && row.value === 'did-1'), true);
});

test('extract session encodes JSON and form bodies for protocol requests', async () => {
  const seen = [];
  const session = createExtractSession({
    fetchImpl: async (url, opts) => {
      seen.push({ url, method: opts.method, body: opts.body, headers: opts.headers });
      return { status: 200, text: '{"ok":true}', headers: { 'content-type': 'application/json' }, url };
    },
  });
  await session.seedCookies([{ name: 'oai-did', value: 'did-1', domain: '.chatgpt.com' }]);
  const jsonResp = await session.request('https://chatgpt.com/backend-api/payments/checkout', {
    method: 'POST',
    json: { plan_name: 'chatgptplusplan' },
    headers: { Authorization: 'Bearer at' },
  });
  assert.equal(jsonResp.data.ok, true);
  assert.equal(seen[0].body, '{"plan_name":"chatgptplusplan"}');
  assert.match(String(seen[0].headers['content-type']), /application\/json/);
  const formResp = await session.request('https://api.stripe.com/v1/payment_methods', {
    method: 'POST',
    form: { type: 'paypal', key: 'pk_test' },
  });
  assert.equal(formResp.status, 200);
  assert.equal(seen[1].body, 'type=paypal&key=pk_test');
  assert.match(String(seen[1].headers['content-type']), /x-www-form-urlencoded/);
});

test('GET eligibility does not send a JSON content-type or body', async () => {
  const seen = [];
  const session = createExtractSession({
    fetchImpl: async (url, opts) => {
      seen.push({ url, method: opts.method, body: opts.body, headers: opts.headers });
      return { status: 200, text: '{"ok":true}', headers: { 'content-type': 'application/json' }, url };
    },
  });
  await session.request('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', {
    method: 'GET',
    headers: {
      Authorization: 'Bearer at',
      'Content-Type': 'application/json',
      'ChatGPT-Account-ID': 'acct',
    },
  });
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].body, undefined);
  assert.equal(seen[0].headers['Content-Type'], undefined);
  assert.equal(seen[0].headers['content-type'], undefined);
});

test('PayPal device signals stay on modern GPUs and a realistic audio cluster', () => {
  const { createDeviceSignals, WEBGL_POOL } = require('../src/utils/paypalSignals');
  assert.equal(WEBGL_POOL.some((item) => /GTX 1080 Ti/.test(item)), false);
  assert.ok(WEBGL_POOL.every((item) => /ANGLE \((NVIDIA|AMD|Intel), .+ Direct3D11/.test(item)));
  const samples = Array.from({ length: 12 }, () => createDeviceSignals());
  assert.ok(new Set(samples.map((item) => item.webgl)).size >= 2);
  for (const signals of samples) {
    assert.ok(WEBGL_POOL.includes(signals.webgl));
    const audio = Number(signals.audio);
    assert.ok(audio > 124.04347 && audio < 124.04348);
  }
});

