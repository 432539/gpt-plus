'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pageType, factorIdFromBody, apiErrorCode, continueUrl,
  isPhoneStep, isConsentStep, isRtGateBlock, isCodexCallbackUrl,
} = require('../src/utils/protocolRt/parse');
const { buildCodexAuthorizeUrl, newPkceState } = require('../src/utils/protocolRt/pkce');
const { CODEX_CLIENT_ID, CODEX_REDIRECT_URI } = require('../src/utils/protocolRt/constants');
const { acquireRefreshTokenByLogin } = require('../src/utils/protocolRt/login');
const { paymentSmsCredentials, createRtSmsClient, OPENAI_RT_COUNTRY, OPENAI_RT_SERVICE } = require('../src/utils/protocolRt/sms');
const { localeDateString } = require('../src/utils/protocolRt/sentinelPoW');

function fakeJwt(email = 'paid@example.test') {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    client_id: CODEX_CLIENT_ID,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus' },
    'https://api.openai.com/profile': { email },
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function mockSession(handler) {
  const calls = [];
  return {
    calls,
    async seedCookies() {},
    async cookies() { return []; },
    async request(url, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      calls.push({ method, url: String(url), options });
      return handler(method, String(url), options, calls.length);
    },
  };
}

test('Codex authorize URL is CLI client, not web/platform', () => {
  const { challenge, state } = newPkceState();
  const url = buildCodexAuthorizeUrl(challenge, state, 'did-1');
  assert.match(url, new RegExp(CODEX_CLIENT_ID));
  assert.match(url, /codex_cli_simplified_flow=true/);
  assert.match(url, /localhost/);
  assert.match(url, /1455/);
  assert.match(url, /offline_access/);
  assert.equal(isCodexCallbackUrl(`${CODEX_REDIRECT_URI}?code=abc&state=${state}`), true);
  assert.equal(isCodexCallbackUrl(url), false);
});

test('phone vs consent page typing matches Codex HAR', () => {
  const phone = { page: { type: 'add_phone' }, continue_url: 'https://auth.openai.com/add-phone' };
  assert.equal(pageType(phone), 'add_phone');
  assert.equal(isPhoneStep(pageType(phone), phone), true);
  assert.equal(isConsentStep(pageType(phone), phone) && !isPhoneStep(pageType(phone), phone), false);
  const emptyPhone = { continue_url: 'https://auth.openai.com/add-phone' };
  assert.equal(isPhoneStep('', emptyPhone), true);
  assert.equal(isConsentStep('', emptyPhone), false);
  const consent = {
    page: { type: 'sign_in_with_chatgpt_codex_consent' },
    continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
  };
  assert.equal(isPhoneStep(pageType(consent), consent), false);
  assert.equal(isConsentStep(pageType(consent), consent), true);
  assert.equal(factorIdFromBody({
    page: { type: 'mfa_challenge', payload: { factors: [{ id: 'fac-1', type: 'totp' }] } },
  }), 'fac-1');
  assert.equal(apiErrorCode({ error: { code: 'phone_number_in_use' } }), 'phone_number_in_use');
  assert.equal(continueUrl({ continue_url: 'https://auth.openai.com/x' }), 'https://auth.openai.com/x');
});

test('403 door is retryable sid rotate', () => {
  assert.equal(isRtGateBlock('登录小门被门禁拦住了（HTTP 403）'), true);
  assert.equal(isRtGateBlock(new Error('邮箱登录被拒绝（HTTP 403）')), true);
  assert.equal(isRtGateBlock('密码核对没通过'), false);
});

test('RT SMS reuses payment key but forces Chile OpenAI service dr', () => {
  const source = paymentSmsCredentials({
    sms: { api_key: 'pay-key', api_url: 'https://smsbower.app/stubs/handler_api.php', country: 'gb', product: 'ts' },
    smsbower: { api_key: 'other', country: 'gb', service: 'ts' },
  });
  assert.equal(source.api_key, 'pay-key');
  const client = createRtSmsClient({
    sms: { api_key: 'pay-key', api_url: 'https://smsbower.app/stubs/handler_api.php', country: 'GB', product: 'ts' },
  });
  assert.equal(client.country, OPENAI_RT_COUNTRY);
  assert.equal(client.service, OPENAI_RT_SERVICE);
  assert.equal(client.apiKey, 'pay-key');
});

test('sentinel JP date string uses Monday-first weekday', () => {
  const text = localeDateString(Date.parse('2026-08-17T03:00:00Z'));
  assert.match(text, /GMT\+0900 \(Japan Standard Time\)/);
  assert.match(text, /Mon Aug 17 2026/);
});

test('sentinel PH date string uses Manila offset and keeps Monday-first weekday', () => {
  const text = localeDateString(Date.parse('2026-08-17T03:00:00Z'), 'Asia/Manila');
  assert.match(text, /GMT\+0800 \(Philippine Standard Time\)/);
  assert.match(text, /Mon Aug 17 2026/);
});

test('protocol login password+TOTP skips SMS when OpenAI does not ask for phone', async () => {
  const at = fakeJwt();
  let smsFactoryCalls = 0;
  const session = mockSession(async (method, url) => {
    if (url.includes('sentinel.openai.com')) {
      return { status: 200, headers: {}, data: { token: 'chal-1' }, text: '{"token":"chal-1"}' };
    }
    if (method === 'GET' && url.includes('/oauth/authorize')) {
      return { status: 200, headers: {}, data: {}, text: '<html>login</html>' };
    }
    if (method === 'POST' && url.endsWith('/api/accounts/authorize/continue')) {
      return { status: 200, headers: {}, data: { page: { type: 'login_password' } }, text: '{}' };
    }
    if (method === 'POST' && url.endsWith('/api/accounts/password/verify')) {
      return {
        status: 200, headers: {},
        data: { page: { type: 'mfa_challenge', payload: { factor_id: 'fac-1' } } },
        text: '{}',
      };
    }
    if (method === 'POST' && url.endsWith('/api/accounts/mfa/issue_challenge')) {
      return { status: 200, headers: {}, data: {}, text: '{}' };
    }
    if (method === 'POST' && url.endsWith('/api/accounts/mfa/verify')) {
      return {
        status: 200, headers: {},
        data: {
          page: { type: 'sign_in_with_chatgpt_codex_consent' },
          continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        },
        text: '{}',
      };
    }
    if (method === 'GET' && url.includes('/sign-in-with-chatgpt/codex/consent')) {
      return {
        status: 302,
        headers: { location: `${CODEX_REDIRECT_URI}?code=AUTHCODE&state=x` },
        data: {},
        text: '',
      };
    }
    if (method === 'POST' && url.endsWith('/oauth/token')) {
      return {
        status: 200, headers: {},
        data: { access_token: at, refresh_token: 'rt-1', id_token: 'id-1' },
        text: '{}',
      };
    }
    return { status: 200, headers: {}, data: {}, text: '' };
  });
  const tokens = await acquireRefreshTokenByLogin({
    session,
    email: 'paid@example.test',
    password: 'secret-pass',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
    smsFactory: () => { smsFactoryCalls += 1; throw new Error('should not buy SMS'); },
    logger() {},
  });
  assert.equal(tokens.refresh_token, 'rt-1');
  assert.equal(tokens.access_token, at);
  assert.equal(smsFactoryCalls, 0);
  assert.equal(tokens.phone_verified, false);
});

test('protocol login buys SMS only after add_phone', async () => {
  const at = fakeJwt();
  let reserved = 0;
  const smsClient = {
    country: 'CL',
    activation: null,
    async reserveMatchingNumber() {
      reserved += 1;
      this.activation = { phone: '+56911112222', activationId: 'act-1' };
      return this.activation;
    },
    async waitForCode() { return '123456'; },
    async finishActivation() { return true; },
    async cancelActivation() {},
  };
  const session = mockSession(async (method, url) => {
    if (url.includes('sentinel.openai.com')) {
      return { status: 200, headers: {}, data: { token: 'chal-1' }, text: '{}' };
    }
    if (method === 'GET' && url.includes('/oauth/authorize')) {
      return { status: 200, headers: {}, data: {}, text: '' };
    }
    if (method === 'POST' && url.endsWith('/authorize/continue')) {
      return { status: 200, headers: {}, data: { page: { type: 'login_password' } }, text: '{}' };
    }
    if (method === 'POST' && url.endsWith('/password/verify')) {
      return {
        status: 200, headers: {},
        data: { page: { type: 'mfa_challenge', payload: { factor_id: 'fac-1' } } },
        text: '{}',
      };
    }
    if (method === 'POST' && url.endsWith('/mfa/issue_challenge')) {
      return { status: 200, headers: {}, data: {}, text: '{}' };
    }
    if (method === 'POST' && url.endsWith('/mfa/verify')) {
      return { status: 200, headers: {}, data: { page: { type: 'add_phone' } }, text: '{}' };
    }
    if (method === 'POST' && url.endsWith('/add-phone/send')) {
      return { status: 200, headers: {}, data: { page: { type: 'phone_otp_verification' } }, text: '{}' };
    }
    if (method === 'POST' && url.endsWith('/phone-otp/validate')) {
      return {
        status: 200, headers: {},
        data: {
          page: { type: 'sign_in_with_chatgpt_codex_consent' },
          continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        },
        text: '{}',
      };
    }
    if (method === 'GET' && url.includes('/sign-in-with-chatgpt/codex/consent')) {
      return {
        status: 302,
        headers: { location: `${CODEX_REDIRECT_URI}?code=AUTHCODE` },
        data: {},
        text: '',
      };
    }
    if (method === 'POST' && url.endsWith('/oauth/token')) {
      return {
        status: 200, headers: {},
        data: { access_token: at, refresh_token: 'rt-2' },
        text: '{}',
      };
    }
    return { status: 200, headers: {}, data: {}, text: '' };
  });
  const tokens = await acquireRefreshTokenByLogin({
    session,
    email: 'paid@example.test',
    password: 'secret-pass',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
    smsFactory: () => smsClient,
    logger() {},
  });
  assert.equal(reserved, 1);
  assert.equal(tokens.refresh_token, 'rt-2');
  assert.equal(tokens.phone_verified, true);
});
