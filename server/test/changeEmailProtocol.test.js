'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PATHS,
  maskEmail,
  emailDomain,
  interpretEligibility,
  interpretMutation,
  canBeginChangeEmail,
  changeEmailContext,
  checkChangeEmailEligibility,
  beginChangeEmail,
  verifyChangeEmail,
  headerValue,
} = require('../src/utils/changeEmailProtocol');

function fakeJwt(accountId = 'acct_test', email = 'old@example.test') {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    'https://api.openai.com/profile': { email },
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function mockSession() {
  const calls = [];
  return {
    calls,
    fingerprint: { headers: { 'User-Agent': 'test-agent' } },
    async request(url, options = {}) {
      calls.push({ url: String(url), method: String(options.method || 'GET').toUpperCase(), options });
      return { status: 200, data: { eligible: true }, text: '{"eligible":true}', headers: {} };
    },
  };
}

test('maskEmail and domain helpers never echo a full local part', () => {
  assert.equal(maskEmail('alpha@example.test'), 'a***@example.test');
  assert.equal(emailDomain('alpha@cf-mail.example'), 'cf-mail.example');
});

test('eligibility 200 with eligible=false must stop', () => {
  const denied = interpretEligibility({
    status: 200,
    data: { eligible: false, code: 'change_email_not_allowed', reason: 'cooldown' },
    text: '{"eligible":false}',
  });
  assert.equal(denied.eligible, false);
  assert.equal(denied.errorCode, 'change_email_not_allowed');
  assert.equal(canBeginChangeEmail(denied), false);
});

test('eligibility 200 with unknown small object can continue', () => {
  const unknown = interpretEligibility({
    status: 200,
    data: { foo: true },
    text: '{"foo":true}',
  });
  assert.equal(unknown.eligible, null);
  assert.deepEqual(unknown.keys, ['foo']);
  assert.equal(canBeginChangeEmail(unknown), true);
});

test('begin/verify treat HTTP 200 + success as ok', () => {
  const begin = interpretMutation({ status: 200, data: { success: true }, text: '{"success":true}' });
  const verify = interpretMutation({ status: 200, data: { success: true }, text: '{"success":true}' });
  assert.equal(begin.ok, true);
  assert.equal(verify.ok, true);
});

test('protocol headers: eligibility omits account id; begin/verify send HAR body', async () => {
  const session = mockSession();
  const ctx = changeEmailContext(
    { access_token: fakeJwt('acct_har') },
    { deviceId: '11111111-1111-1111-1111-111111111111', sessionId: '22222222-2222-2222-2222-222222222222' },
  );
  await checkChangeEmailEligibility(session, ctx);
  await beginChangeEmail(session, ctx, 'new@example.test');
  await verifyChangeEmail(session, ctx, { email: 'new@example.test', code: '123456' });

  const [elig, begin, verify] = session.calls;
  assert.equal(elig.method, 'GET');
  assert.match(elig.url, new RegExp(`${PATHS.eligibility}$`));
  assert.equal(elig.options.json, undefined);
  assert.match(headerValue(elig.options.headers, 'Authorization'), /^Bearer /);
  assert.equal(headerValue(elig.options.headers, 'oai-device-id'), ctx.deviceId);
  assert.equal(headerValue(elig.options.headers, 'oai-session-id'), ctx.sessionId);
  assert.equal(headerValue(elig.options.headers, 'chatgpt-account-id'), '');

  assert.equal(begin.method, 'POST');
  assert.match(begin.url, new RegExp(`${PATHS.begin}$`));
  assert.deepEqual(begin.options.json, { email: 'new@example.test' });
  assert.equal(headerValue(begin.options.headers, 'chatgpt-account-id'), 'acct_har');
  assert.equal(headerValue(begin.options.headers, 'content-type'), 'application/json');

  assert.equal(verify.method, 'POST');
  assert.match(verify.url, new RegExp(`${PATHS.verify}$`));
  assert.deepEqual(verify.options.json, { email: 'new@example.test', code: '123456' });
  assert.equal(headerValue(verify.options.headers, 'chatgpt-account-id'), 'acct_har');
});
