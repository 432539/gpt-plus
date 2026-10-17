'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createPkce,
  credentialsFromTokens,
  refreshDurableCredentials,
} = require('../src/automation/lib/chatgpt-oauth');
const {
  AUTH_PAGES,
  classifyAuthPage,
  continueAuthorize,
  parseAuthSessionId,
} = require('../src/automation/flows/auth-continue');
  const {
    normalizeRegisterPerformanceProfile,
    planRegisterMailboxPipeline,
    planRegisterRuntimeLimits,
  } = require('../src/automation/lib/register-performance');
const { classifyRegisterFailure } = require('../src/automation/lib/retry-policy');
const { RegisterFlow } = require('../src/automation/flows/register');

function jwt(extra = {}) {
  const payload = {
    client_id: 'app_fixture',
    exp: 1893456000,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_fixture',
      chatgpt_plan_type: 'plus',
    },
    ...extra,
  };
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.x`;
}

test('automation modules expose CommonJS contracts', () => {
  assert.equal(typeof require('../src/automation/cloak').CloakRuntime, 'function');
  assert.equal(typeof require('../src/automation/flows/register-headless').driveHeadlessSignup, 'function');
  assert.equal(typeof require('../src/automation/flows/auth-continue').continueAuthorize, 'function');
});

test('PKCE and refresh encoding match reference behavior', async () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[0-9a-f]{128}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));

  const requests = [];
  const access = jwt();
  const session = {
    page: { route: async () => {} },
    request: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, data: { access_token: access, refresh_token: 'rt.rotated' } };
    },
  };
  const result = await refreshDurableCredentials(session, {
    previous: { refresh_token: 'rt.old', client_id: 'app_fixture' },
  });
  assert.equal(requests[0].options.form.refresh_token, 'rt.old');
  assert.equal(requests[0].options.json, undefined);
  assert.equal(result.refresh_token, 'rt.rotated');
  assert.equal(credentialsFromTokens({}, { previous: { access_token: access, refresh_token: 'rt.old' } }).refresh_token, 'rt.old');
});

test('auth continuation selects session and preserves Sentinel header contract', async () => {
  let current = 'https://auth.openai.com/choose-an-account';
  const requests = [];
  const session = {
    page: {
      url: () => current,
      evaluate: async () => '<input name="session_id" value="us_SelectMe123456789">',
    },
    request: async (url, options) => {
      requests.push({ url, options });
      current = 'http://localhost:1455/auth/callback?code=done&state=S';
      return { ok: true, status: 200, data: {} };
    },
  };
  const result = await continueAuthorize(session, {
    state: 'S',
    sentinel: async () => ({
      'OpenAI-Sentinel-Token': 'main',
      'OpenAI-Sentinel-SO-Token': 'must-be-removed',
    }),
  });
  assert.equal(result.code, 'done');
  assert.equal(parseAuthSessionId('authsess_bad us_SelectMe123456789'), 'us_SelectMe123456789');
  assert.equal(classifyAuthPage(current), AUTH_PAGES.CALLBACK);
  assert.equal(requests[0].options.json.session_id, 'us_SelectMe123456789');
  assert.equal(requests[0].options.headers['OpenAI-Sentinel-Token'], 'main');
  assert.equal('OpenAI-Sentinel-SO-Token' in requests[0].options.headers, false);
});

test('performance and retry policies retain deterministic source decisions', () => {
  assert.equal(normalizeRegisterPerformanceProfile('unknown'), 'safe');
  assert.deepEqual(planRegisterMailboxPipeline({
    performanceProfile: 'throughput',
    effectiveConcurrency: 32,
    launchConcurrency: 5,
  }), { enabled: true, capacity: 10, buffered: 5, launchConcurrency: 5 });
  assert.equal(classifyRegisterFailure({ code: 'AUTH_CONTINUE_RATE_LIMITED' }).terminal, true);
  assert.equal(classifyRegisterFailure({ code: 'PROTOCOL_REQUEST_NETWORK' }).retryable, true);
});

test('register runtime limits keep configured workers overlapping in safe mode', () => {
  const safe = planRegisterRuntimeLimits({
    requestedThreads: 8,
    target: 20,
    cloakMaxConcurrency: 5,
    resourceConcurrency: 32,
    performanceProfile: 'safe',
    launchConcurrencyLimit: 5,
  });
  assert.equal(safe.concurrency, 8);
  assert.equal(safe.cloakMax, 8);
  assert.equal(safe.launchConcurrency, 5);
  assert.equal(safe.performanceProfile, 'safe');
  assert.equal(safe.resourceLimited, false);

  const throughput = planRegisterRuntimeLimits({
    requestedThreads: 8,
    target: 20,
    cloakMaxConcurrency: 5,
    resourceConcurrency: 32,
    performanceProfile: 'throughput',
    launchConcurrencyLimit: 5,
  });
  assert.equal(throughput.launchConcurrency, 5);
  assert.equal(throughput.concurrency, 8);

  const tightHost = planRegisterRuntimeLimits({
    requestedThreads: 10,
    target: 10,
    cloakMaxConcurrency: 10,
    resourceConcurrency: 1,
    performanceProfile: 'safe',
    launchConcurrencyLimit: 5,
  });
  assert.equal(tightHost.concurrency, 1);
  assert.equal(tightHost.launchConcurrency, 1);
  assert.equal(tightHost.resourceLimited, true);
});

test('RegisterFlow accepts new and legacy registration contracts without external I/O', async () => {
  const token = jwt();
  const requests = [];
  const session = {
    page: { evaluate: async () => '' },
    cookies: async () => [],
    wait: async () => {},
    newPage: async () => ({ page: { evaluate: async () => '' }, closePage: async () => {} }),
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/api/auth/csrf')) return { ok: true, data: { csrfToken: 'csrf' } };
      if (url.includes('/api/auth/signin/openai')) return { ok: true, data: { url: 'https://auth.openai.com/authorize' } };
      if (url === 'https://auth.openai.com/authorize') return { ok: true, url, data: {} };
      if (url.endsWith('/user/register')) return { ok: true, status: 200, data: {} };
      if (url.endsWith('/email-otp/send')) return { ok: true, status: 200, data: {} };
      if (url.endsWith('/email-otp/validate')) return { ok: true, data: { page: { type: 'about_you' } } };
      if (url.endsWith('/create_account')) return { ok: true, data: { continue_url: 'https://chatgpt.com/callback' } };
      if (url === 'https://chatgpt.com/callback') return { ok: true, status: 200, data: {} };
      if (url.includes('/api/auth/session')) return { ok: true, data: { accessToken: token } };
      if (url.includes('/backend-api/accounts/check/')) return { ok: true, status: 200, data: { ok: true } };
      throw new Error(`unexpected request ${url}`);
    },
  };
  const runtime = { withSession: async (_options, handler) => handler(session) };
  const credentialCheckpoints = [];
  const securityCheckpoints = [];
  let mailCalls = 0;
  const result = await new RegisterFlow(runtime, { sentinel: { enabled: false } }).run(
    { email: 'fixture@example.test', password: 'Fixed-password_123' },
    {
      password_signup: true,
      register_mode: 'protocol',
      enable_totp_2fa: false,
    },
    {
      mailChannel: {
        wait: async () => {
          mailCalls += 1;
          return { code: '123456' };
        },
      },
      onCredentialCheckpoint: async value => credentialCheckpoints.push(value),
      onSecurityCheckpoint: async value => securityCheckpoints.push(value),
    },
  );
  assert.equal(result.email, 'fixture@example.test');
  assert.equal(result.password_set, true);
  assert.equal(mailCalls, 1);
  assert.ok(credentialCheckpoints.some(value => value.password_set === true));
  assert.ok(securityCheckpoints.some(value => value.password_set === true));
  assert.ok(requests.some(item => item.url.endsWith('/user/register')));
});
