const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractPaymentLink,
  checkEligibility,
  CHECK_PATH,
  CHECKOUT_PATH,
  ELIGIBILITY_COUNTRIES,
  proxyForRegion,
  cloudflareTraceCountry,
  billingForPaypalCountry,
} = require('../src/utils/paypalExtract');
const { EXTRACT_BROWSER, randomChromeFingerprint, chromeFingerprintFor } = require('../src/utils/extractHttp');
const { PAYPAL_FULL_CHECKOUT_ATTEMPTS } = require('../src/utils/paymentLink');

const PAYPAL_BA = 'https://www.paypal.com/agreements/approve?ba_token=BA-FIXTURE';
const PK = 'pk_test_fixture';
const ACCOUNT_ID = 'acct_extract_test';

test('eligibility log uses actual exit country instead of hardcoded GB', async () => {
  const logs = [];
  await checkEligibility(
    {},
    { access_token: fixtureToken(), chatgpt_account_id: ACCOUNT_ID },
    'device',
    'session',
    (step, message) => logs.push(`${step}: ${message}`),
    () => false,
    {},
    {
      exitCountry: 'TH',
      eligibilityRequest: async () => ({
        status: 200,
        data: {
          accounts: {
            [ACCOUNT_ID]: { eligible_promo_campaigns: { plus: { id: 'plus-1-month-free' } } },
          },
        },
        text: '{}',
      }),
    },
  );
  assert.ok(logs.some((line) => /正在通过 TH 代理检查试用资格/.test(line)));
  assert.equal(logs.some((line) => /正在通过 GB 代理检查试用资格/.test(line)), false);
});

test('PayPal eligibility is GB-only', () => {
  assert.deepEqual(ELIGIBILITY_COUNTRIES, ['GB']);
  assert.equal(
    proxyForRegion({ username: 'customer-region-US-session-123' }, 'GB').username.includes('region-GB'),
    true,
  );
  assert.equal(
    proxyForRegion({ username: 'customer-res-any' }, 'GB').username,
    'customer-res-gb',
  );
  assert.equal(cloudflareTraceCountry('ip=203.0.113.8\nloc=GB\n'), 'GB');
});

test('PayPal region rewrite does not append session after CliProxy -t-*', () => {
  const hyphenSid = proxyForRegion({
    username: 'clip-user-region-US-sid-d-dc4mwc-t-30',
  }, 'GB');
  assert.match(hyphenSid.username, /^clip-user-region-GB-sid-[A-Za-z0-9_-]+-t-30$/);
  assert.doesNotMatch(hyphenSid.username, /-session-\d+$/);
});

test('PayPal region refresh preserves CliProxy minutes and IPRocket TTL', () => {
  const cliProxy = proxyForRegion({
    id: 7,
    group_name: '支付',
    proxy_type: 'socks5',
    host: 'proxy.example.test',
    port: 3010,
    username: 'demo-region-US-sid-Ab12Cd34-t-10',
    password: 'test-pass',
  }, 'GB');
  assert.match(
    cliProxy.username,
    /^demo-region-GB-sid-[A-Za-z0-9]{8}-t-10$/,
  );
  assert.equal(cliProxy.id, 7);
  assert.equal(cliProxy.proxy_type, 'socks5');
  assert.equal(cliProxy.host, 'proxy.example.test');
  assert.equal(cliProxy.port, 3010);
  assert.equal(cliProxy.password, 'test-pass');

  const iprocketProxy = proxyForRegion({
    username: 'demo-res-US-Lsid-A1b2C3d4-TTL-300',
  }, 'GB');
  assert.match(
    iprocketProxy.username,
    /^demo-res-GB-Lsid-[0-9]{9}-TTL-300$/,
  );
});

test('PayPal billing uses addressgen data and keeps the account email', async () => {
  const billing = await billingForPaypalCountry('GB', 'account@example.test', async (url) => {
    assert.equal(new URL(url).searchParams.get('country_code'), 'gb');
    return jsonResponse({
      data: {
        firstname: 'Alice',
        lastname: 'Smith',
        email: 'generated@example.test',
        phone: '+44 7700 900123',
        address: {
          country_code: 'GB',
          street: '10 Downing Street',
          city: 'London',
          state: 'England',
          zipcode: 'SW1A 2AA',
        },
      },
    });
  });
  assert.equal(billing.name, 'Alice Smith');
  assert.equal(billing.email, 'account@example.test');
  assert.equal(billing.line1, '10 Downing Street');
  assert.equal(billing.postal_code, 'SW1A 2AA');
});

function fixtureToken(accountId = ACCOUNT_ID) {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    email: 'extract@example.test',
  })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.x`;
}

function header(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value);
  }
  return '';
}

function jsonResponse(data, { status = 200, url = '' } = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(data),
    url,
  };
}

function checkoutPageResponse(amount = 0, url = '') {
  const flattened = [
    { _1: 2 },
    'loaderData',
    { _3: 4 },
    'routes/checkout.$entity.$checkoutId',
    { _5: 6 },
    'checkoutSession',
    { _7: 8 },
    'checkout_state',
    { _9: 10, _11: 12 },
    'total',
    { _9: 13 },
    'currency',
    'GBP',
    { _14: 15 },
    'minorUnitsAmount',
    String(amount),
  ];
  const chunk = JSON.stringify(JSON.stringify(flattened));
  return {
    status: 200,
    headers: { 'content-type': 'text/html' },
    text: `<script>window.__reactRouterContext.streamController.enqueue(${chunk})</script>`,
    url,
  };
}

function pathname(url) {
  return new URL(url, 'https://chatgpt.com').pathname.replace(/\/+$/, '') || '/';
}

function hostOf(url) {
  try { return new URL(url, 'https://chatgpt.com').hostname.toLowerCase(); } catch { return ''; }
}

const STRIPE_INIT = {
  payment_method_types: ['paypal', 'card'],
  total_summary: { due: 0, total: 0 },
  stripe_hosted_url: 'https://checkout.stripe.com/c/pay/cs_live_fixture',
  stripe_publishable_key: PK,
  session_id: 'elements_session_fixture',
  config_id: 'cfg_fixture',
  customer: { customer_session: { customer: 'cus_fixture' } },
};

function createFixtureFetch(mode = 'oaics-redirect') {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const path = pathname(url);
    const headers = opts.headers || {};
    calls.push({ url: String(url), method, path, headers, body: opts.body || '' });

    if (path === '/cdn-cgi/trace') {
      const country = header(headers, 'x-gpt-plus-proxy-country-check') || 'GB';
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: `fl=fixture\nip=203.0.113.8\nloc=${country}\n`,
        url: String(url),
      };
    }
    if (path === '/backend-api/accounts/check' && !path.includes('/v4')) {
      return jsonResponse({ detail: 'Method Not Allowed' }, { status: 405, url: String(url) });
    }
    if (path === CHECK_PATH && method === 'GET') {
      return jsonResponse({
        accounts: {
          [ACCOUNT_ID]: { eligible_promo_campaigns: { plus: { id: 'plus-1-month-free' } } },
          default: { eligible_promo_campaigns: { plus: { id: 'plus-1-month-free' } } },
        },
      });
    }
    if (path === '/backend-api/sentinel/ping') return jsonResponse({ ok: true });
    if (path === '/backend-api/payments/checkout' && method === 'POST') {
      const csId = mode.startsWith('oaics') ? 'oaics_fixture_session' : 'cs_live_fixture';
      return jsonResponse({
        checkout_session_id: csId,
        stripe_publishable_key: PK,
        processor_entity: 'openai_ie',
        payment_method_types: ['paypal', 'card'],
        customer_session_client_secret: 'cuss_fixture',
      });
    }
    if (path === '/backend-api/payments/checkout/update') {
      return jsonResponse({ success: true, total: { amount: 0 } });
    }
    if (path.startsWith('/checkout/')) return checkoutPageResponse(0, String(url));
    if (path === '/backend-api/payments/checkout/taxes' || path === '/backend-api/payments/checkout/snapshot') {
      return jsonResponse({ ok: true });
    }
    if (path === '/backend-api/payments/checkout/confirm') {
      return jsonResponse({
        status: 'ok',
        client_secret: 'seti_fixture_secret_abc',
      });
    }
    if (path === '/backend-api/payments/checkout/approve') {
      return jsonResponse({ result: 'approved' });
    }
    if (path === '/v1/elements/sessions') {
      return jsonResponse({
        session_id: 'elements_session_fixture',
        config_id: 'cfg_fixture',
        payment_method_types: ['paypal', 'card'],
        customer: { customer_session: { customer: 'cus_fixture' } },
      });
    }
    if (path === '/v1/payment_methods') return jsonResponse({ id: 'pm_fixture' });
    if (path === '/v1/confirmation_tokens') return jsonResponse({ id: 'ctoken_fixture' });
    if (path.endsWith('/init') && path.includes('/v1/payment_pages/')) return jsonResponse(STRIPE_INIT);
    if (path.endsWith('/confirm') && path.includes('/v1/setup_intents/')) {
      if (mode === 'oaics-requires-approval') {
        return jsonResponse({ submission_attempt: { state: 'requires_approval' } });
      }
      return jsonResponse({
        next_action: { type: 'redirect_to_url', redirect_to_url: { url: PAYPAL_BA } },
        submission_attempt: { state: 'requires_approval' },
      });
    }
    if (path.endsWith('/pre_confirm') && path.includes('/v1/payment_pages/')) return jsonResponse({ ok: true });
    if (path.endsWith('/confirm') && path.includes('/v1/payment_pages/')) {
      if (mode === 'cs-requires-approval') {
        return jsonResponse({ submission_attempt: { state: 'requires_approval' } });
      }
      if (mode === 'cs-stripe-hop') {
        return jsonResponse({
          next_action: {
            type: 'redirect_to_url',
            redirect_to_url: { url: 'https://checkout.stripe.com/c/pay/cs_live_hop' },
          },
        });
      }
      if (mode === 'cs-paypal-me') {
        return jsonResponse({
          next_action: {
            type: 'redirect_to_url',
            redirect_to_url: { url: 'https://www.paypal.me/openaiplus' },
          },
        });
      }
      if (mode === 'cs-html-ba') {
        return jsonResponse({
          next_action: {
            type: 'redirect_to_url',
            redirect_to_url: { url: 'https://checkout.stripe.com/c/pay/cs_live_html' },
          },
        });
      }
      return jsonResponse({
        next_action: { type: 'redirect_to_url', redirect_to_url: { url: PAYPAL_BA } },
        submission_attempt: { state: 'requires_approval' },
      });
    }
    if (hostOf(url) === 'checkout.stripe.com') {
      if (mode === 'cs-html-ba') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: '<html>continue ba_token=BA-FROMHTML</html>',
          url: String(url),
        };
      }
      return {
        status: 302,
        headers: { location: PAYPAL_BA, 'content-type': 'text/html' },
        text: '',
        url: String(url),
      };
    }
    if (path.includes('/v1/payment_pages/')) {
      if (method === 'GET') {
        return jsonResponse({
          next_action: { type: 'redirect_to_url', redirect_to_url: { url: PAYPAL_BA } },
        });
      }
      return jsonResponse({ total_summary: { due: 0, total: 0 } });
    }
    return jsonResponse({ ok: true }, { url: String(url) });
  };
  return { fetchImpl, calls };
}

function paymentApiCalls(calls) {
  return calls.filter((item) => item.path.startsWith('/backend-api/payments/'));
}

test('extract uses protocol HTTP and never opens a Cloak session', async () => {
  const { fetchImpl, calls } = createFixtureFetch('oaics-redirect');
  let cloakSessions = 0;
  const logs = [];
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken(), email: 'extract@example.test' },
    proxy: { host: '127.0.0.1', port: 8080, proxy_type: 'http' },
    fetchImpl,
    log: (message) => logs.push(String(message)),
    runtime: {
      withSession: async () => {
        cloakSessions += 1;
        throw new Error('browser.newPage: Target page, context or browser has been closed');
      },
    },
  });
  assert.equal(cloakSessions, 0);
  assert.equal(result.flow, 'oaics');
  assert.equal(result.link, PAYPAL_BA);
  assert.ok(logs.some((row) => /协议 HTTP（fixture curl_cffi chrome\d+/.test(row)));
  assert.ok(logs.some((row) => /不占用 Cloak 席位/.test(row)));
  assert.equal(calls.some((item) => item.path === CHECK_PATH), true);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/approve'), true);
  const approveAt = logs.findIndex((row) => /优先提交 ChatGPT checkout\/approve/.test(row));
  const stripeAt = logs.findIndex((row) => /stripe_init|回退 OAICS|回退 Custom PayPal|正在初始化 Stripe/.test(row));
  assert.ok(approveAt >= 0);
  assert.ok(stripeAt < 0 || approveAt < stripeAt);
});

test('cs_ Stripe checkout skips ChatGPT approve and goes to stripe_init', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-redirect');
  const logs = [];
  let approveCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/approve') {
      approveCalls += 1;
      calls.push({
        url: String(url),
        method: 'POST',
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ result: 'blocked' });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'cs');
  assert.equal(result.link, PAYPAL_BA);
  assert.equal(approveCalls, 0);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/approve'), false);
  assert.equal(logs.some((row) => /优先提交 ChatGPT checkout\/approve/.test(row)), false);
  assert.ok(logs.some((row) => /跳过 ChatGPT approve.*Custom PayPal \/ stripe_init/.test(row)));
  assert.ok(logs.some((row) => /正在初始化 Stripe/.test(row)));
});

test('requires_approval without URL approves with oai-session-id and no Account-ID on payment APIs', async () => {
  const { fetchImpl, calls } = createFixtureFetch('cs-requires-approval');
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    impersonate: 'chrome136',
  });
  assert.equal(result.link, PAYPAL_BA);
  const eligibility = calls.find((item) => item.path === CHECK_PATH);
  assert.equal(header(eligibility.headers, 'ChatGPT-Account-ID'), ACCOUNT_ID);
  const approve = calls.find((item) => item.path === '/backend-api/payments/checkout/approve');
  assert.ok(approve);
  assert.match(header(approve.headers, 'oai-session-id'), /^[0-9a-f-]{36}$/i);
  assert.equal(header(approve.headers, 'ChatGPT-Account-ID'), '');
  assert.equal(header(approve.headers, 'oai-language'), 'en-GB');
  assert.equal(header(approve.headers, 'oai-client-version'), 'prod-46437587156517d920436051cb9ab60a95f0503a');
  assert.equal(header(approve.headers, 'oai-client-build-number'), '7904904');
  assert.equal(header(approve.headers, 'Origin'), 'https://chatgpt.com');
  assert.equal(header(approve.headers, 'sec-ch-ua'), '"Google Chrome";v="136", "Chromium";v="136", "Not_A Brand";v="99"');
  assert.equal(header(approve.headers, 'sec-ch-ua-mobile'), '?0');
  assert.equal(header(approve.headers, 'sec-ch-ua-platform'), '"Windows"');
  assert.equal(header(approve.headers, 'sec-ch-ua-full-version-list'), '');
  assert.match(header(approve.headers, 'User-Agent'), /Chrome\/136\.0\.0\.0/);
  assert.match(header(approve.headers, 'Referer'), /\/checkout\/openai_ie\//);
  const checkout = calls.find((item) => item.path === CHECKOUT_PATH);
  assert.equal(header(checkout.headers, 'x-openai-target-path'), CHECKOUT_PATH);
  assert.equal(header(checkout.headers, 'sec-ch-ua'), header(approve.headers, 'sec-ch-ua'));
  for (const item of paymentApiCalls(calls)) {
    assert.equal(header(item.headers, 'ChatGPT-Account-ID'), '', item.path);
    assert.match(header(item.headers, 'oai-session-id'), /^[0-9a-f-]{36}$/i, item.path);
  }
});

test('OAICS requires_approval without URL also approves instead of following an empty redirect', async () => {
  const { fetchImpl, calls } = createFixtureFetch('oaics-requires-approval');
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(result.flow, 'oaics');
  assert.equal(result.link, PAYPAL_BA);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/approve'), true);
});

test('extract TLS stack defaults to chrome136 and randomizes fingerprints per job', () => {
  assert.equal(EXTRACT_BROWSER, 'chrome136');
  assert.equal(chromeFingerprintFor('').impersonate, 'chrome136');
  assert.equal(chromeFingerprintFor('chrome999').impersonate, 'chrome136');
  assert.equal(chromeFingerprintFor('chrome120').impersonate, 'chrome136');
  assert.equal(chromeFingerprintFor('chrome146').impersonate, 'chrome136');
  const seen = new Set(Array.from({ length: 24 }, () => randomChromeFingerprint().impersonate));
  assert.ok(seen.size >= 2);
  assert.equal([...seen].every((item) => ['chrome131', 'chrome136', 'chrome142'].includes(item)), true);
  const session = require('../src/utils/extractHttp').createExtractSession({
    impersonate: 'chrome142',
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  assert.equal(session.browser, 'chrome142');
  assert.match(session.fingerprint.userAgent, /Chrome\/142\.0\.0\.0/);
});

test('monitor PayPal profiles unlock TH exit and BR hosted without writing GB defaults', async () => {
  const { fetchImpl, calls } = createFixtureFetch('cs-redirect');
  await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    paypalProfile: 'paypal_th',
    maxCheckoutAttempts: 1,
  });
  const checkout = calls.find((item) => item.path === CHECKOUT_PATH);
  const body = JSON.parse(checkout.body || '{}');
  assert.equal(body.billing_details.country, 'DE');
  assert.equal(body.billing_details.currency, 'EUR');
  assert.equal(body.checkout_ui_mode, 'custom');
  const traces = calls
    .filter((item) => item.path === '/cdn-cgi/trace')
    .map((item) => header(item.headers, 'x-gpt-plus-proxy-country-check'));
  assert.ok(traces.includes('TH'));

  const hosted = createFixtureFetch('cs-redirect');
  await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl: hosted.fetchImpl,
    paypalProfile: 'paypal_hosted',
    maxCheckoutAttempts: 1,
  });
  const hostedCheckout = hosted.calls.find((item) => item.path === CHECKOUT_PATH);
  const hostedBody = JSON.parse(hostedCheckout.body || '{}');
  assert.equal(hostedBody.billing_details.country, 'BR');
  assert.equal(hostedBody.billing_details.currency, 'BRL');
  assert.equal(hostedBody.checkout_ui_mode, 'hosted');
  const hostedTraces = hosted.calls
    .filter((item) => item.path === '/cdn-cgi/trace')
    .map((item) => header(item.headers, 'x-gpt-plus-proxy-country-check'));
  assert.ok(hostedTraces.includes('BR'));

  const generic = createFixtureFetch('cs-redirect');
  await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl: generic.fetchImpl,
    paypalProfile: 'paypal',
    maxCheckoutAttempts: 1,
  });
  const genericCheckout = generic.calls.find((item) => item.path === CHECKOUT_PATH);
  const genericBody = JSON.parse(genericCheckout.body || '{}');
  assert.equal(genericBody.billing_details.country, 'DE');
  assert.equal(genericBody.billing_details.currency, 'EUR');
  assert.equal(genericBody.checkout_ui_mode, 'custom');
  const genericTraces = generic.calls
    .filter((item) => item.path === '/cdn-cgi/trace')
    .map((item) => header(item.headers, 'x-gpt-plus-proxy-country-check'));
  assert.ok(genericTraces.includes('BR'));
  assert.ok(genericTraces.includes('TR'));
});

test('eligibility is GET v4 check and checkout create is POST payments/checkout', async () => {
  const { fetchImpl, calls } = createFixtureFetch('oaics-redirect');
  await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(CHECK_PATH, '/backend-api/accounts/check/v4-2023-04-27');
  assert.equal(CHECKOUT_PATH, '/backend-api/payments/checkout');
  const eligibility = calls.find((item) => item.path === CHECK_PATH);
  const checkout = calls.find((item) => item.path === CHECKOUT_PATH);
  assert.ok(eligibility);
  assert.ok(checkout);
  assert.equal(eligibility.method, 'GET');
  assert.equal(checkout.method, 'POST');
  assert.equal(header(eligibility.headers, 'content-type'), '');
  assert.equal(header(eligibility.headers, 'ChatGPT-Account-ID'), ACCOUNT_ID);
  assert.match(header(eligibility.headers, 'Authorization'), /^Bearer /);
  assert.match(header(eligibility.headers, 'oai-device-id'), /^[0-9a-f-]{36}$/i);
  assert.match(header(eligibility.headers, 'oai-session-id'), /^[0-9a-f-]{36}$/i);
  assert.match(String(header(checkout.headers, 'content-type')), /application\/json/i);
  assert.equal(header(checkout.headers, 'ChatGPT-Account-ID'), '');
  assert.equal(header(checkout.headers, 'x-openai-target-path'), CHECKOUT_PATH);
  assert.equal(header(checkout.headers, 'x-openai-target-route'), CHECKOUT_PATH);
  assert.equal(JSON.parse(checkout.body).entry_point, 'all_plans_pricing_modal');
  assert.equal(JSON.parse(checkout.body).promo_campaign, undefined);
  assert.equal(JSON.parse(checkout.body).billing_details.country, 'GB');
  assert.equal(calls.some((item) => item.path === '/backend-api/accounts/check'), false);
});

test('eligibility HTTP 405 fails and does not create checkout', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const path = pathname(url);
    calls.push({ path, method, headers: opts.headers || {} });
    if (path === '/cdn-cgi/trace') {
      const country = header(opts.headers, 'x-gpt-plus-proxy-country-check') || 'GB';
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: `ip=203.0.113.8\nloc=${country}\n`,
        url: String(url),
      };
    }
    if (path === CHECK_PATH) {
      return jsonResponse({ detail: 'Method Not Allowed' }, { status: 405, url: String(url) });
    }
    return jsonResponse({ ok: true }, { url: String(url) });
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      fetchImpl,
    }),
    (error) => {
      assert.match(String(error.message), /Method Not Allowed/);
      assert.equal(error.status, 405);
      assert.equal(error.recoverable, false);
      assert.equal(error.code, 'ACCOUNT_ELIGIBILITY_CHECK');
      return true;
    },
  );
  assert.equal(calls.every((item) => item.path !== CHECKOUT_PATH), true);
  assert.equal(calls.some((item) => item.path === CHECK_PATH && item.method === 'GET'), true);
});

test('eligibility transport failure uses at most five GB full attempts and never creates checkout', async () => {
  const calls = [];
  const logs = [];
  let proxyRotations = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = pathname(url);
    calls.push({
      path,
      country: header(opts.headers, 'x-gpt-plus-proxy-country-check'),
    });
    if (path === '/cdn-cgi/trace') {
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: 'ip=203.0.113.8\nloc=GB\n',
        url: String(url),
      };
    }
    if (path === CHECK_PATH) {
      return jsonResponse({ detail: 'temporary upstream failure' }, {
        status: 502,
        url: String(url),
      });
    }
    return jsonResponse({ ok: true }, { url: String(url) });
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      proxy: { host: 'gb-proxy-a.test', port: 8000 },
      nextProxy: () => {
        proxyRotations += 1;
        return { host: 'gb-proxy-b.test', port: 8000 };
      },
      fetchImpl,
      log: (message) => logs.push(String(message)),
    }),
    (error) => error?.code === 'ACCOUNT_ELIGIBILITY_CHECK',
  );
  assert.equal(calls.filter((item) => item.path === CHECK_PATH).length, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
  assert.equal(calls.some((item) => item.path === CHECKOUT_PATH), false);
  assert.equal(proxyRotations, PAYPAL_FULL_CHECKOUT_ATTEMPTS - 1);
  assert.deepEqual(
    calls.filter((item) => item.path === '/cdn-cgi/trace').map((item) => item.country),
    Array.from({ length: PAYPAL_FULL_CHECKOUT_ATTEMPTS }, () => 'GB'),
  );
  assert.equal(logs.some((message) => /\b(?:JP|TR)\b/.test(message)), false);
});

test('PayPal main flow rejects a proxy whose real exit is not GB', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('oaics-redirect');
  const fetchImpl = async (url, opts = {}) => {
    if (
      pathname(url) === '/cdn-cgi/trace'
      && header(opts.headers, 'x-gpt-plus-proxy-country-check') === 'GB'
    ) {
      calls.push({
        url: String(url),
        method: 'GET',
        path: '/cdn-cgi/trace',
        headers: opts.headers || {},
        body: '',
      });
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: 'ip=203.0.113.9\nloc=US\n',
        url: String(url),
      };
    }
    return baseFetch(url, opts);
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      fetchImpl,
    }),
    (error) => error?.code === 'ELIGIBILITY_PROXY_COUNTRY',
  );
  assert.equal(calls.some((item) => item.path === CHECKOUT_PATH), false);
  assert.equal(
    calls.filter((item) => (
      item.path === '/cdn-cgi/trace'
      && header(item.headers, 'x-gpt-plus-proxy-country-check') === 'GB'
    )).length,
    5,
  );
});

test('deferred checkout update verifies zero amount from the OpenAI checkout page', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('oaics-redirect');
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/update') {
      calls.push({
        url: String(url),
        method: String(opts.method || 'GET').toUpperCase(),
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ success: true }, { url: String(url) });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'oaics');
  assert.equal(calls.some((item) => item.path.startsWith('/checkout/')), true);
  assert.equal(logs.some((message) => /页面载荷确认支付金额为 0/.test(message)), true);
});

test('cs PayPal defers a missing update amount directly to Stripe init', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-redirect');
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/update') {
      calls.push({
        url: String(url),
        method: String(opts.method || 'GET').toUpperCase(),
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ success: true }, { url: String(url) });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'cs');
  assert.equal(logs.some((message) => /cs_ PayPal.*Stripe init 确认 0 元/.test(message)), true);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/approve'), false);
  assert.ok(logs.some((message) => /跳过 ChatGPT approve.*stripe_init/.test(message)));
});

test('cs PayPal ignores update-stage amount noise and trusts Stripe init', async () => {
  const { fetchImpl: baseFetch } = createFixtureFetch('cs-redirect');
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/update') {
      return jsonResponse({ success: true, total: { total: 1999 } }, { url: String(url) });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'cs');
  assert.equal(logs.some((message) => /忽略该阶段金额.*Stripe init/.test(message)), true);
});

test('final Stripe init retries in place after a transient failure', async () => {
  const { fetchImpl: baseFetch } = createFixtureFetch('cs-redirect');
  let initCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = pathname(url);
    if (path.endsWith('/init') && path.includes('/v1/payment_pages/')) {
      initCalls += 1;
      if (initCalls === 2) {
        return jsonResponse({ error: { message: 'temporary init failure' } }, {
          status: 502,
          url: String(url),
        });
      }
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(result.flow, 'cs');
  assert.equal(initCalls, 3);
});

test('provider transport failure retries on the same checkout before rebuilding', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-redirect');
  let elementsCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = pathname(url);
    if (path === '/v1/elements/sessions') {
      elementsCalls += 1;
      if (elementsCalls === 1) {
        return jsonResponse({ error: { message: 'temporary elements failure' } }, {
          status: 502,
          url: String(url),
        });
      }
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(result.flow, 'cs');
  assert.equal(elementsCalls, 2);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH).length, 1);
});

test('custom PayPal confirm failure rebuilds instead of falling back to hosted confirm', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-redirect');
  const fetchImpl = async (url, opts = {}) => {
    const path = pathname(url);
    if (path.endsWith('/confirm') && path.includes('/v1/payment_pages/')) {
      calls.push({
        url: String(url),
        method: String(opts.method || 'GET').toUpperCase(),
        path,
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ error: { message: 'generic_decline' } }, {
        status: 402,
        url: String(url),
      });
    }
    return baseFetch(url, opts);
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      fetchImpl,
    }),
    (error) => error?.code === 'STRIPE_RISK_RETRYABLE',
  );
  assert.equal(calls.some((item) => item.path.endsWith('/pre_confirm')), false);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH).length, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
});

test('unusual activity rebuilds checkout with a fresh proxy and reuses eligibility', async () => {
  const { fetchImpl: successFetch, calls } = createFixtureFetch('oaics-redirect');
  let checkoutAttempts = 0;
  let proxyRotations = 0;
  const fetchImpl = async (url, opts) => {
    if (pathname(url) === CHECKOUT_PATH) {
      checkoutAttempts += 1;
      if (checkoutAttempts === 1) {
        calls.push({ url: String(url), method: 'POST', path: CHECKOUT_PATH, headers: opts.headers || {}, body: opts.body || '' });
        return jsonResponse({ detail: 'Our systems have detected unusual activity. Please try again later.' }, {
          status: 403,
          url: String(url),
        });
      }
    }
    return successFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    proxy: { host: 'proxy-a.test', port: 8000, username: 'user-sid-old', password: 'secret' },
    nextProxy: () => {
      proxyRotations += 1;
      return { host: 'proxy-b.test', port: 8000, username: 'user-sid-other', password: 'secret' };
    },
    fetchImpl,
  });
  assert.equal(result.flow, 'oaics');
  assert.equal(checkoutAttempts, 2);
  assert.equal(proxyRotations, 1);
  assert.equal(calls.filter((item) => item.path === CHECK_PATH).length, 1);
  const checkoutCalls = calls.filter((item) => item.path === CHECKOUT_PATH);
  assert.equal(checkoutCalls.length, 2);
  assert.equal(
    header(checkoutCalls[0].headers, 'oai-device-id'),
    header(checkoutCalls[1].headers, 'oai-device-id'),
  );
  assert.ok(header(checkoutCalls[0].headers, 'oai-device-id'));
});

test('recoverable checkout failures stop after five full attempts', async () => {
  const { fetchImpl: successFetch } = createFixtureFetch('oaics-redirect');
  let checkoutAttempts = 0;
  let proxyRotations = 0;
  const fetchImpl = async (url, opts) => {
    if (pathname(url) === CHECKOUT_PATH) {
      checkoutAttempts += 1;
      return jsonResponse({ detail: 'Our systems have detected unusual activity. Please try again later.' }, {
        status: 403,
        url: String(url),
      });
    }
    return successFetch(url, opts);
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      proxy: { host: 'proxy-a.test', port: 8000, username: 'user-sid-old', password: 'secret' },
      nextProxy: () => {
        proxyRotations += 1;
        return { host: 'proxy-b.test', port: 8000, username: 'user-sid-other', password: 'secret' };
      },
      fetchImpl,
    }),
    (error) => error?.code === 'EXTRACT_CHECKOUT_UNUSUAL',
  );
  assert.equal(checkoutAttempts, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
  assert.equal(proxyRotations, PAYPAL_FULL_CHECKOUT_ATTEMPTS - 1);
});

test('missing exact eligibility campaign is terminal without proxy rotation', async () => {
  const calls = [];
  let proxyRotations = 0;
  const fetchImpl = async (url, opts = {}) => {
    const path = pathname(url);
    calls.push({ path });
    if (path === '/cdn-cgi/trace') {
      const country = header(opts.headers, 'x-gpt-plus-proxy-country-check') || 'GB';
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: `ip=203.0.113.8\nloc=${country}\n`,
        url: String(url),
      };
    }
    if (path === CHECK_PATH) {
      return jsonResponse({
        accounts: {
          [ACCOUNT_ID]: { eligible_promo_campaigns: { plus: { id: 'different-campaign' } } },
        },
      });
    }
    return jsonResponse({ ok: true });
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      proxy: { host: 'proxy-a.test', port: 8000, username: 'user-sid-old', password: 'secret' },
      nextProxy: () => {
        proxyRotations += 1;
        return { host: 'proxy-b.test', port: 8000, username: 'user-sid-other', password: 'secret' };
      },
      fetchImpl,
    }),
    (error) => error?.code === 'ACCOUNT_NOT_ELIGIBLE',
  );
  assert.equal(calls.filter((item) => item.path === CHECK_PATH).length, 1);
  assert.equal(calls.some((item) => item.path === CHECKOUT_PATH), false);
  assert.equal(proxyRotations, 0);
});

test('eligibility reads the flat namespaced account id claim', async () => {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth.chatgpt_account_id': 'acct_namespaced',
  })).toString('base64url');
  const token = `header.${payload}.signature`;
  const { fetchImpl, calls } = createFixtureFetch('oaics-redirect');
  await extractPaymentLink({ detail: { access_token: token }, fetchImpl });
  const eligibility = calls.find((item) => item.path === CHECK_PATH);
  assert.equal(header(eligibility.headers, 'ChatGPT-Account-ID'), 'acct_namespaced');
});

test('approve HTTP 500 rebuilds checkout instead of retrying the same session five times', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-requires-approval');
  let approveCalls = 0;
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/approve') {
      approveCalls += 1;
      calls.push({
        url: String(url),
        method: 'POST',
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      if (approveCalls === 1) return jsonResponse({ error: 'internal' }, { status: 500 });
      return jsonResponse({ result: 'approved' });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.link, PAYPAL_BA);
  assert.equal(approveCalls, 2);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH).length, 2);
  assert.ok(logs.some((message) => /作废 checkout 并重建/.test(message)));
  assert.equal(logs.some((message) => /更换 oai-session-id/.test(message)), false);
  assert.ok(logs.some((message) => /TLS 指纹/.test(message)));
});

test('approve HTTP 500 does not burn one checkout five times before giving up', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-requires-approval');
  let approveCalls = 0;
  const sessionIds = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/approve') {
      approveCalls += 1;
      sessionIds.push(header(opts.headers, 'oai-session-id'));
      calls.push({
        url: String(url),
        method: 'POST',
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ error: 'internal' }, { status: 500 });
    }
    return baseFetch(url, opts);
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      fetchImpl,
    }),
    (error) => error?.code === 'CHECKOUT_APPROVE_HTTP',
  );
  assert.equal(approveCalls, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH).length, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
  assert.equal(new Set(sessionIds).size, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
});

test('approve blocked rebuilds checkout instead of retrying the same session five times', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-requires-approval');
  let approveCalls = 0;
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/approve') {
      approveCalls += 1;
      calls.push({
        url: String(url),
        method: 'POST',
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      if (approveCalls === 1) return jsonResponse({ result: 'blocked' });
      return jsonResponse({ result: 'approved' });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.link, PAYPAL_BA);
  assert.equal(approveCalls, 2);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH).length, 2);
  assert.ok(logs.some((message) => /blocked/.test(message)));
  assert.ok(logs.some((message) => /TLS 指纹/.test(message)));
});

test('approve blocked does not burn one checkout five times before giving up', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('cs-requires-approval');
  let approveCalls = 0;
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/approve') {
      approveCalls += 1;
      calls.push({
        url: String(url),
        method: 'POST',
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ result: 'blocked' });
    }
    return baseFetch(url, opts);
  };
  await assert.rejects(
    () => extractPaymentLink({
      detail: { access_token: fixtureToken() },
      fetchImpl,
    }),
    (error) => error?.code === 'CHECKOUT_APPROVE_BLOCKED',
  );
  assert.equal(approveCalls, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH).length, PAYPAL_FULL_CHECKOUT_ATTEMPTS);
});

test('cs_ Stripe checkout URL is followed to a PayPal BA approve link', async () => {
  const { fetchImpl, calls } = createFixtureFetch('cs-stripe-hop');
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(result.flow, 'cs');
  assert.equal(result.link, PAYPAL_BA);
  assert.equal(
    calls.some((item) => hostOf(item.url) === 'checkout.stripe.com'),
    true,
  );
});

test('cs_ hosted HTML containing ba_token is parsed into a PayPal approve link', async () => {
  const { fetchImpl } = createFixtureFetch('cs-html-ba');
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(result.flow, 'cs');
  assert.equal(result.link, 'https://www.paypal.com/agreements/approve?ba_token=BA-FROMHTML');
});

test('paypal.me short links are accepted as the extracted payment link', async () => {
  const { fetchImpl } = createFixtureFetch('cs-paypal-me');
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
  });
  assert.equal(result.flow, 'cs');
  assert.equal(result.link, 'https://www.paypal.me/openaiplus');
});

test('oaics approve-first PayPal BA skips Stripe/OAICS provider', async () => {
  const { fetchImpl: baseFetch, calls } = createFixtureFetch('oaics-redirect');
  const logs = [];
  const fetchImpl = async (url, opts = {}) => {
    if (pathname(url) === '/backend-api/payments/checkout/approve') {
      calls.push({
        url: String(url),
        method: 'POST',
        path: pathname(url),
        headers: opts.headers || {},
        body: opts.body || '',
      });
      return jsonResponse({ result: 'approved', url: PAYPAL_BA });
    }
    return baseFetch(url, opts);
  };
  const result = await extractPaymentLink({
    detail: { access_token: fixtureToken() },
    fetchImpl,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'approve');
  assert.equal(result.link, PAYPAL_BA);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/approve'), true);
  assert.equal(calls.some((item) => item.path.endsWith('/init') && item.path.includes('/v1/payment_pages/')), false);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/confirm'), false);
  assert.ok(logs.some((row) => /优先提交 ChatGPT checkout\/approve/.test(row)));
  assert.ok(logs.some((row) => /跳过 Stripe/.test(row)));
});
