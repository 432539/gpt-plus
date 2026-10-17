const test = require('node:test');
const assert = require('node:assert/strict');
const { PayPalSession } = require('../src/utils/paypalSession');
const { createSessionState } = require('../src/utils/paypalProfile');

test('checkoutweb GraphQL uses EC token for PayPal-Client-Metadata-Id', async () => {
  const state = createSessionState('BA-UNITTESTTOKEN');
  state.ec_token = 'EC-1SANITIZEDTOKEN';
  state.signup_url = 'https://www.paypal.com/checkoutweb/signup?token=EC-1SANITIZEDTOKEN';
  state.paypal_client_metadata_id = '11111111-2222-3333-4444-555555555555';

  let capturedHeaders = null;
  const cloak = {
    request: async (_url, options) => {
      capturedHeaders = options.headers;
      return { status: 200, headers: {}, text: '{}', data: {} };
    },
    cookies: async () => [],
  };

  const session = new PayPalSession(cloak, state, { country: 'GB', locale: 'en_GB' });
  await session.graphql('SignUpNewMemberMutation', 'mutation SignUp {}', { token: state.ec_token });

  assert.equal(capturedHeaders['PayPal-Client-Context'], 'EC-1SANITIZEDTOKEN');
  assert.equal(capturedHeaders['PayPal-Client-Metadata-Id'], 'EC-1SANITIZEDTOKEN');
  assert.notEqual(capturedHeaders['PayPal-Client-Metadata-Id'], state.paypal_client_metadata_id);
});

test('navigate uses Cloak page.goto and does not pin PayPal contextUrl', async () => {
  const state = createSessionState('BA-UNITTESTTOKEN');
  let captured = null;
  const cloak = {
    request: async (url, options) => {
      captured = { url, options };
      return { status: 200, url, headers: {}, text: '', data: null };
    },
    cookies: async () => [],
  };
  const session = new PayPalSession(cloak, state, { country: 'GB', locale: 'en_GB' });
  await session.navigate('https://pm-redirects.stripe.com/redirect?redirect_status=succeeded');
  assert.equal(captured.options.contextUrl, undefined);
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.timeout, 90_000);
  assert.equal(captured.options.waitUntil, 'load');
});

test('authorize override can still supply paypal_client_metadata_id', async () => {
  const state = createSessionState('BA-UNITTESTTOKEN');
  state.ec_token = 'EC-1SANITIZEDTOKEN';
  state.paypal_client_metadata_id = '11111111-2222-3333-4444-555555555555';

  let capturedHeaders = null;
  const cloak = {
    request: async (_url, options) => {
      capturedHeaders = options.headers;
      return { status: 200, headers: {}, text: '{}', data: {} };
    },
    cookies: async () => [],
  };

  const session = new PayPalSession(cloak, state, { country: 'GB', locale: 'en_GB' });
  await session.graphql('BuyerContextQuery', 'query BuyerContext {}', { token: state.ec_token }, {
    extraHeaders: {
      'PayPal-Client-Metadata-Id': state.paypal_client_metadata_id,
    },
  });

  assert.equal(capturedHeaders['PayPal-Client-Metadata-Id'], state.paypal_client_metadata_id);
});

test('empty GraphQL body is a non-JSON challenge, not AUTHORIZE_EMPTY', async () => {
  const state = createSessionState('BA-UNITTESTTOKEN');
  const session = new PayPalSession({
    request: async () => ({ status: 200, headers: {}, text: '', data: null }),
    cookies: async () => [],
  }, state, { country: 'GB', locale: 'en_GB' });
  await assert.rejects(
    () => session.graphql('authorize', 'mutation authorize { billing { authorize } }', { billingAgreementId: 'EC-1' }),
    (error) => {
      assert.equal(error.code, 'PAYPAL_GRAPHQL_NON_JSON_RESPONSE');
      return true;
    },
  );
});