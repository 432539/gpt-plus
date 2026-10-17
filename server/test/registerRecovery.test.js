'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { RegisterFlow, verifyRefreshCredential } = require('../src/automation/flows/register');
const { driveHeadlessSignup, waitForStage, detectStage } = require('../src/automation/flows/register-headless');
const { enableTotp } = require('../src/automation/flows/account-security');

const CHATGPT = 'https://chatgpt.com';
const AUTH = 'https://auth.openai.com';
const AUTHORIZE = `${AUTH}/api/accounts/authorize?client_id=fixture`;
const CALLBACK = `${CHATGPT}/api/auth/callback/openai?code=fixture`;
const SESSION = `${CHATGPT}/api/auth/session`;
const REFRESH = `${SESSION}?refresh=true`;
const PROBE = `${CHATGPT}/backend-api/accounts/check/v4-2023-04-27`;
const OTP = `${AUTH}/api/accounts/email-otp/validate`;

function token({ signup = false } = {}) {
  return `x.${Buffer.from(JSON.stringify({
    exp: 1893456000,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_fixture',
      chatgpt_plan_type: 'free',
      ...(signup ? { is_signup: true } : {}),
    },
  })).toString('base64url')}.x`;
}

const ok = (data = {}, url = '') => ({ ok: true, status: 200, data, text: JSON.stringify(data), headers: {}, url });

function protocolHarness(overrides = {}, { sentinel = false } = {}) {
  const normalToken = token();
  const requests = [];
  let pageUrl = '';
  const routes = {
    [`${CHATGPT}/api/auth/providers`]: () => ok({ openai: {} }),
    [`${CHATGPT}/api/auth/csrf`]: () => ok({ csrfToken: 'csrf' }),
    [`${CHATGPT}/api/auth/signin/openai`]: () => ok({ url: AUTHORIZE }),
    [AUTHORIZE]: () => {
      pageUrl = `${AUTH}/email-verification`;
      return ok({}, pageUrl);
    },
    [`${AUTH}/api/accounts/email-otp/send`]: () => ok({}),
    [OTP]: () => ok({ page: { type: 'about_you' } }),
    [`${AUTH}/api/accounts/create_account`]: () => ok({ continue_url: CALLBACK }),
    [CALLBACK]: () => ok({}, CALLBACK),
    [SESSION]: () => ok({ accessToken: normalToken }),
    [REFRESH]: () => ok({ accessToken: normalToken }),
    [PROBE]: () => ok({ usable: true }),
    ...overrides,
  };
  const session = {
    page: { url: () => pageUrl, evaluate: async () => '' },
    wait: async () => {},
    cookies: async () => [{ name: 'oai-did', value: 'device-fixture' }],
    newPage: async () => ({
      page: {
        addInitScript: async () => {},
        context: () => ({ addCookies: async () => {}, cookies: async () => [] }),
        evaluate: async (_callback, input) => sentinel
          ? { token: JSON.stringify({ p: 'pow', c: 'challenge', t: 'turnstile', id: 'device-fixture', flow: input.flow }), so: null }
          : '',
      },
      goto: async () => {},
      request: sessionRequest,
      closePage: async () => {},
    }),
    request: sessionRequest,
  };
  async function sessionRequest(url, options = {}) {
    requests.push({ url: String(url), options });
    const route = routes[String(url)] || routes[String(url).split('?')[0]];
    if (!route) throw new Error(`missing route ${url}`);
    return route(options);
  }
  const runtime = { withSession: async (_task, callback) => callback(session) };
  const flow = new RegisterFlow(runtime, { sentinel: { enabled: sentinel, timeoutMs: 50, soTimeoutMs: 10 } });
  flow.mailbox = { wait: async () => ({ code: '123456' }) };
  return { flow, session, requests, setPageUrl: value => { pageUrl = value; } };
}

test('authorize timeout keeps committed auth landing and does not replay GET', async () => {
  let calls = 0;
  let harness;
  harness = protocolHarness({
    [AUTHORIZE]: () => {
      calls += 1;
      harness.setPageUrl(`${AUTH}/email-verification`);
      throw Object.assign(new Error('net::ERR_TIMED_OUT after commit'), { code: 'PROTOCOL_REQUEST_TIMEOUT' });
    },
  });
  const result = await harness.flow.run(
    { email: 'fixture@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    {},
  );
  assert.equal(result.access_token, token());
  assert.equal(calls, 1);
});

test('callback lost response reconciles server session in the same context', async () => {
  let callbackCalls = 0;
  const harness = protocolHarness({
    [CALLBACK]: () => {
      callbackCalls += 1;
      throw Object.assign(new Error('Failed to fetch'), { code: 'PROTOCOL_REQUEST_NETWORK' });
    },
  });
  const result = await harness.flow.run(
    { email: 'fixture@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    {},
  );
  assert.equal(result.access_token, token());
  assert.equal(callbackCalls, 1, 'settled session must prevent callback replay');
});

test('lost session refresh response is reconciled by a plain session read', async () => {
  let plainReads = 0;
  let refreshReads = 0;
  const signupToken = token({ signup: true });
  const normalToken = token();
  const harness = protocolHarness({
    [SESSION]: () => {
      plainReads += 1;
      return ok({ accessToken: plainReads === 1 ? signupToken : normalToken });
    },
    [REFRESH]: () => {
      refreshReads += 1;
      throw Object.assign(new Error('refresh response lost'), { code: 'PROTOCOL_REQUEST_TIMEOUT' });
    },
  });
  const result = await harness.flow.run(
    { email: 'fixture@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    {},
  );
  assert.equal(result.access_token, normalToken);
  assert.equal(refreshReads, 1);
  assert.equal(plainReads, 2);
});

test('AuthAPI mutation retry reuses invocation id and Sentinel token', async () => {
  let otpCalls = 0;
  const harness = protocolHarness({
    [OTP]: options => {
      otpCalls += 1;
      if (otpCalls === 1) throw Object.assign(new Error('response lost'), { code: 'PROTOCOL_REQUEST_NETWORK' });
      return ok({ page: { type: 'about_you' } });
    },
  }, { sentinel: true });
  await harness.flow.run(
    { email: 'fixture@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    {},
  );
  const attempts = harness.requests.filter(item => item.url === OTP);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].options.headers['X-Access-Flow-Invocation-Id'], attempts[1].options.headers['X-Access-Flow-Invocation-Id']);
  assert.ok(attempts[0].options.headers['OpenAI-Sentinel-Token']);
  assert.equal(attempts[0].options.headers['OpenAI-Sentinel-Token'], attempts[1].options.headers['OpenAI-Sentinel-Token']);
});

test('first valid AT checkpoint commits before any security work', async () => {
  const harness = protocolHarness();
  const timeline = [];
  await harness.flow.run(
    { email: 'fixture@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    {
      onCredentialCheckpoint: async value => {
        if (value.access_token && value.credentials_ready === false) timeline.push('at-checkpoint');
      },
    },
  );
  assert.equal(timeline[0], 'at-checkpoint');
});

function headlessPage() {
  let stage = 'password';
  let current = `${AUTH}/create-account/password`;
  const values = new Map();
  const visibleFor = selector => {
    if (stage === 'password') return /password/.test(selector);
    if (stage === 'otp') return /one-time-code|name="code"|inputmode="numeric"|type="tel"/.test(selector);
    if (stage === 'about') {
      return /name="name"|autocomplete="name"|aria-label\*="name"|name="age"|id\*="age"|aria-label\*="age"/i.test(selector);
    }
    return false;
  };
  return {
    url: () => current,
    recoverLanding() {
      stage = 'landing';
      current = `${CHATGPT}/`;
      return true;
    },
    locator(selector) {
      const key = /^(?:button|form button)|type="submit"/.test(selector) ? 'submit'
        : /password/.test(selector) ? 'password'
        : /one-time-code|name="code"|inputmode="numeric"|type="tel"/.test(selector) ? 'otp'
          : /age/.test(selector) ? 'age' : /name/.test(selector) ? 'name' : 'submit';
      return {
        first() { return this; },
        async isVisible() { return visibleFor(selector) || (/^(?:button|form button)|type="submit"/.test(selector) && stage !== 'landing'); },
        async fill(value) { values.set(key, String(value)); },
        async inputValue() { return values.get(key) || ''; },
        async click() {
          if (key !== 'submit') return;
          if (/create-account\/password/.test(current)) { stage = 'otp'; current = `${AUTH}/email-verification`; }
          else if (/email-verification/.test(current)) { stage = 'about'; current = `${AUTH}/about-you`; }
          else if (/about-you/.test(current)) { stage = 'landing'; current = `${CHATGPT}/`; }
        },
        async press(keyName) { if (keyName === 'Enter') return this.click(); },
      };
    },
  };
}

test('headless password transport emits consumption before submit', async () => {
  const page = headlessPage();
  const timeline = [];
  const result = await driveHeadlessSignup({
    session: { page, wait: async () => {} },
    account: { email: 'fixture@example.test', password: 'Fixed-Password-29!' },
    identity: { name: 'Fixture User', birthdate: '1991-05-20' },
    waitForOtp: async () => '123456',
    checkpoint: async fields => timeline.push(fields.password_set === false ? 'password-pending' : 'password-set'),
    onConsumptionCheckpoint: async value => timeline.push(value.stage),
    recoverLanding: async () => page.recoverLanding(),
    performanceProfile: 'throughput',
    stepTimeoutMs: 50,
  });
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.deepEqual(timeline.slice(0, 3), ['password-pending', 'password_submission', 'password-set']);
});

class EntryRacePage extends EventEmitter {
  constructor({
    remountEmail = false, entryMode = 'direct', autoSubmitOtp = false, bodyNeverSettles = false,
    otpRetryEnterFails = false, genericAbout = '',
  } = {}) {
    super();
    this.stage = 'entry';
    this.current = `${CHATGPT}/auth/login`;
    this.values = new Map();
    this.actions = [];
    this.remountEmail = remountEmail;
    this.emailGeneration = 0;
    this.emailFillCalls = 0;
    this.entryMode = entryMode;
    this.autoSubmitOtp = autoSubmitOtp;
    this.bodyNeverSettles = bodyNeverSettles;
    this.otpRetryEnterFails = otpRetryEnterFails;
    this.otpSubmitNoopRemaining = otpRetryEnterFails ? 1 : 0;
    this.genericAbout = genericAbout;
    this.genericFields = genericAbout === 'name-only'
      ? [{ name: 'profile', ariaLabel: 'Display Name', role: 'textbox' }]
      : genericAbout === 'regional-birthday'
        ? [
          { name: 'display', ariaLabel: 'Tam Ad', role: 'textbox' },
          { name: 'year-segment', ariaLabel: 'Yıl', role: 'spinbutton' },
          { name: 'month-segment', ariaLabel: 'Ay', role: 'spinbutton' },
          { name: 'day-segment', ariaLabel: 'Gün', role: 'spinbutton' },
        ]
        : [];
  }

  url() { return this.current; }

  visible(selector, key) {
    if (this.stage === 'entry') {
      if (key === 'email') return true;
      if (key === 'submit') return this.entryMode !== 'requestSubmit';
      return false;
    }
    if (this.stage === 'password') return key === 'password' || key === 'submit';
    if (this.stage === 'otp') return key === 'otp' || key === 'submit';
    if (this.stage === 'about') {
      if (this.genericAbout) return key === 'submit';
      return ['name', 'age', 'submit'].includes(key);
    }
    return false;
  }

  key(selector) {
    if (/^(?:button|form button)|type="submit"/.test(selector)) return 'submit';
    if (/type="email"|name="email"|username|inputmode="email"|mail/i.test(selector)) return 'email';
    if (/password/i.test(selector)) return 'password';
    if (/one-time-code|name="code"|inputmode="numeric"|type="tel"|code/i.test(selector)) return 'otp';
    if (/bday-month|name\*="month"|aria-label\*="month"|aria-label="月"|aria-label="Ay"/i.test(selector)) return 'month';
    if (/bday-day|name\*="day"|aria-label\*="day"|aria-label="日"|aria-label="Gün"/i.test(selector)) return 'day';
    if (/bday-year|name\*="year"|aria-label\*="year"|aria-label="年"|aria-label="Yıl"/i.test(selector)) return 'year';
    if (/age/i.test(selector)) return 'age';
    if (/name|氏名|名前|Ad Soyad/i.test(selector)) return 'name';
    return 'other';
  }

  request(url) {
    this.emit('request', { url: () => url });
  }

  response(url, status, body, delayMs = 0) {
    this.emit('response', {
      url: () => url,
      status: () => status,
      json: () => delayMs === null
        ? new Promise(() => {})
        : new Promise(resolve => setTimeout(() => resolve(body), delayMs)),
    });
  }

  enterAuth() {
    this.stage = 'password';
    this.current = `${AUTH}/create-account/password`;
  }

  recoverLanding() {
    this.stage = 'landing';
    this.current = `${CHATGPT}/`;
    this.actions.push('callback:reconciled');
    return true;
  }

  submitEntry(method) {
    this.actions.push(`entry:${method}`);
    if (this.entryMode === 'responseRace') {
      this.request(`${CHATGPT}/api/auth/providers`);
      this.response(`${CHATGPT}/api/auth/providers`, 200, {});
      this.request(`${CHATGPT}/api/auth/signin/openai`);
      this.response(`${CHATGPT}/api/auth/signin/openai`, 200, { url: AUTHORIZE }, 60);
      return;
    }
    this.request(`${AUTH}/api/accounts/authorize?fixture=1`);
    this.enterAuth();
  }

  locator(selector) {
    const page = this;
    if (selector.includes('[contenteditable="true"]')) {
      const genericLocator = index => {
        const descriptor = page.genericFields[index];
        const valueKey = `generic:${index}`;
        return {
          async isVisible() { return page.stage === 'about' && Boolean(descriptor); },
          async isEnabled() { return true; },
          async getAttribute(name) {
            return {
              type: descriptor?.type || '',
              name: descriptor?.name || '',
              id: descriptor?.id || '',
              autocomplete: descriptor?.autocomplete || '',
              inputmode: descriptor?.inputmode || '',
              placeholder: descriptor?.placeholder || '',
              'aria-label': descriptor?.ariaLabel || '',
              'aria-labelledby': descriptor?.labelText || '',
              'data-type': descriptor?.dataType || '',
              role: descriptor?.role || '',
              'data-testid': descriptor?.testId || '',
              contenteditable: descriptor?.contentEditable || '',
            }[name] || '';
          },
          async fill(value) { page.values.set(valueKey, String(value)); },
          async inputValue() { return page.values.get(valueKey) || ''; },
          async click() {},
          async press() {},
        };
      };
      return {
        async count() { return page.stage === 'about' ? page.genericFields.length : 0; },
        nth(index) { return genericLocator(index); },
        first() { return genericLocator(0); },
      };
    }
    const key = this.key(selector);
    const generation = this.emailGeneration;
    return {
      first() { return this; },
      async isVisible() {
        if (key === 'email' && generation !== page.emailGeneration) return false;
        return page.visible(selector, key);
      },
      async fill(value) {
        if (key === 'email') {
          page.emailFillCalls += 1;
          if (page.remountEmail && page.emailFillCalls === 1) {
            page.emailGeneration += 1;
            page.values.delete('email');
            page.actions.push('email:remount');
            return;
          }
        }
        page.values.set(key, String(value));
        if (key === 'otp' && page.autoSubmitOtp) {
          page.actions.push('otp:auto-submit');
          page.stage = 'about';
          page.current = `${AUTH}/about-you`;
        }
      },
      async inputValue() {
        if (key === 'email' && generation !== page.emailGeneration) throw new Error('detached');
        return page.values.get(key) || '';
      },
      async click() {
        const isSubmit = /^(?:button|form button)|type="submit"/.test(selector);
        if (!isSubmit) return;
        if (page.stage === 'entry') return page.submitEntry('click');
        const route = /create-account\/password/.test(page.current) ? 'password'
          : /email-verification/.test(page.current) ? 'otp'
            : /about-you/.test(page.current) ? 'about' : page.stage;
        page.actions.push(`${route}:click`);
        if (route === 'password') {
          page.request(`${AUTH}/api/accounts/email-otp/send`);
          page.response(`${AUTH}/api/accounts/email-otp/send`, 429, {
            error: { code: 'RATE_LIMITED', message: 'fixture@example.test https://secret.invalid' },
          }, page.bodyNeverSettles ? null : 700);
          page.stage = 'otp';
          page.current = `${AUTH}/email-verification`;
        } else if (route === 'otp') {
          if (page.otpSubmitNoopRemaining > 0) {
            page.otpSubmitNoopRemaining -= 1;
            page.actions.push('otp:first-submit-noop');
            return;
          }
          page.stage = 'about';
          page.current = `${AUTH}/about-you`;
        } else if (route === 'about') {
          page.stage = 'landing';
          page.current = `${CHATGPT}/`;
        }
      },
      async press(value) {
        if (page.stage === 'entry' && page.entryMode === 'requestSubmit') {
          page.actions.push('entry:enter-failed');
          throw new Error('detached during Enter');
        }
        if (key === 'otp' && value === 'Enter' && page.otpRetryEnterFails) {
          page.actions.push('otp:retry-enter-failed');
          throw new Error('detached OTP field during Enter');
        }
        if (value === 'Enter') return this.click();
      },
      async evaluate() {
        if (page.stage === 'entry' && page.entryMode === 'requestSubmit') {
          page.submitEntry('requestSubmit');
          return true;
        }
        if (key === 'otp' && page.otpRetryEnterFails && /email-verification/.test(page.current)) {
          page.actions.push('otp:requestSubmit');
          page.stage = 'about';
          page.current = `${AUTH}/about-you`;
          return true;
        }
        return false;
      },
    };
  }
}

const raceSession = page => ({
  page,
  wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 25))),
  goto: async url => {
    page.actions.push('entry:goto-authorize');
    assert.equal(url, AUTHORIZE);
    page.enterAuth();
  },
});

async function runEntryRace(page) {
  try {
    return await driveHeadlessSignup({
      session: raceSession(page),
      account: { email: 'fixture@example.test', password: 'Fixed-Password-29!' },
      identity: { name: 'Fixture User', birthdate: '1991-05-20' },
      waitForOtp: async () => '123456',
      stepTimeoutMs: 1200,
      performanceProfile: 'throughput',
      recoverLanding: async () => page.recoverLanding(),
    });
  } catch (error) {
    error.actions = page.actions;
    throw error;
  }
}

test('production entry survives a React email input remount', async () => {
  const page = new EntryRacePage({ remountEmail: true });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(page.actions.includes('email:remount'), true);
  assert.ok(page.emailFillCalls >= 2);
  assert.equal(page.values.get('email'), 'fixture@example.test');
});

test('production OTP auto-submit prevents a duplicate Continue click', async () => {
  const page = new EntryRacePage({ autoSubmitOtp: true });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(page.actions.includes('otp:auto-submit'), true);
  assert.equal(page.actions.includes('otp:click'), false);
});

test('production OTP retry falls back after Enter detaches without double click', async () => {
  const page = new EntryRacePage({ otpRetryEnterFails: true });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(page.actions.filter(item => item === 'otp:first-submit-noop').length, 1);
  assert.equal(page.actions.filter(item => item === 'otp:retry-enter-failed').length, 1);
  assert.equal(page.actions.filter(item => item === 'otp:requestSubmit').length, 1);
  assert.equal(page.actions.filter(item => item === 'otp:click').length, 1);
});

test('production about flow accepts a generic name-only form', async () => {
  const page = new EntryRacePage({ genericAbout: 'name-only' });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(page.values.get('generic:0'), 'Fixture User');
  assert.equal(page.actions.includes('about:click'), true);
});

test('production about flow classifies and verifies generic regional birthday segments', async () => {
  const page = new EntryRacePage({ genericAbout: 'regional-birthday' });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(page.values.get('generic:0'), 'Fixture User');
  assert.equal(page.values.get('generic:1'), '1991');
  assert.equal(page.values.get('generic:2'), '05');
  assert.equal(page.values.get('generic:3'), '20');
  assert.equal(page.actions.includes('about:click'), true);
});

test('production entry waits for delayed signin body and replays authorize once', async () => {
  const page = new EntryRacePage({ entryMode: 'responseRace' });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(page.actions.filter(item => item === 'entry:goto-authorize').length, 1);
  assert.equal(result.email_otp_send.last_error_code, 'RATE_LIMITED');
  assert.equal(result.email_otp_send.last_error.includes('fixture@example.test'), false);
  assert.equal(result.email_otp_send.last_error.includes('secret.invalid'), false);
  assert.equal(result.email_otp_send.settle_timed_out, false);
});

test('production OTP observer bounds a response body that never settles', async () => {
  const page = new EntryRacePage({ bodyNeverSettles: true });
  const started = Date.now();
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(result.email_otp_send.observed, true);
  assert.equal(result.email_otp_send.pending_bodies, 1);
  assert.equal(result.email_otp_send.settle_timed_out, true);
  assert.ok(Date.now() - started < 5000, 'a stuck response body must not hang the browser slot');
});

test('production entry falls back to native requestSubmit after detached Enter', async () => {
  const page = new EntryRacePage({ entryMode: 'requestSubmit' });
  const result = await runEntryRace(page);
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.deepEqual(page.actions.filter(item => item.startsWith('entry:')), [
    'entry:enter-failed',
    'entry:requestSubmit',
  ]);
});

test('email-verification URL without OTP controls is not treated as the OTP step', async () => {
  const session = {
    wait: async () => {},
    page: {
      url: () => `${AUTH}/email-verification`,
      locator() {
        return {
          first() { return this; },
          async isVisible() { return false; },
        };
      },
    },
  };
  const stage = await waitForStage(session, ['password', 'otp', 'about', 'landing'], { timeoutMs: 40 });
  assert.equal(stage, '');
  assert.equal(await detectStage(session), 'transition');
});

test('password page React Aria inputs are not treated as about-you', async () => {
  const session = {
    wait: async () => {},
    page: {
      url: () => `${AUTH}/create-account/password`,
      locator(selector) {
        return {
          first() { return this; },
          async isVisible() {
            return /type="password"|new-password|name="password"|react-aria-TextField/i.test(selector);
          },
        };
      },
    },
  };
  assert.equal(await detectStage(session), 'password');
  assert.equal(await waitForStage(session, ['otp', 'about', 'landing'], { timeoutMs: 40 }), '');
});

test('OTP-first email-verification clicks 设置密码 and fills password before waitForOtp', async () => {
  const notes = [];
  let otpWaited = 0;
  let passwordFilled = false;
  let stage = 'otp';
  let current = `${AUTH}/email-verification`;
  const values = new Map();
  const page = {
    url: () => current,
    recoverLanding() {
      stage = 'landing';
      current = `${CHATGPT}/`;
      return true;
    },
    locator(selector) {
      const isPasswordChoice = /create-account\/password|Continue with password|设置密码/.test(selector);
      const isPasswordField = /type="password"|new-password|name="password"|placeholder\*="password"/.test(selector)
        && !isPasswordChoice;
      const isOtp = /one-time-code|name="code"|inputmode="numeric"|type="tel"/.test(selector);
      const isName = /name="name"|autocomplete="name"|aria-label\*="name"/.test(selector);
      const isAge = /name="age"|id\*="age"|aria-label\*="age"/.test(selector);
      const isSubmit = /^(?:button|form button)|type="submit"/.test(selector);
      return {
        first() { return this; },
        async isVisible() {
          if (stage === 'otp') return isPasswordChoice || isOtp || isSubmit;
          if (stage === 'password') return isPasswordField || isSubmit;
          if (stage === 'about') return isName || isAge || isSubmit;
          return false;
        },
        async fill(value) {
          if (isPasswordField) {
            passwordFilled = true;
            values.set('password', String(value));
          }
          if (isOtp) values.set('otp', String(value));
          if (isName) values.set('name', String(value));
          if (isAge) values.set('age', String(value));
        },
        async inputValue() {
          if (isPasswordField) return values.get('password') || '';
          if (isOtp) return values.get('otp') || '';
          if (isName) return values.get('name') || '';
          if (isAge) return values.get('age') || '';
          return '';
        },
        async click() {
          if (stage === 'otp' && isPasswordChoice) {
            stage = 'password';
            current = `${AUTH}/create-account/password`;
            return;
          }
          if (!isSubmit) return;
          if (stage === 'password') {
            stage = 'otp';
            current = `${AUTH}/email-verification`;
          } else if (stage === 'otp') {
            stage = 'about';
            current = `${AUTH}/about-you`;
          } else if (stage === 'about') {
            stage = 'landing';
            current = `${CHATGPT}/`;
          }
        },
        async press(key) { if (key === 'Enter') return this.click(); },
      };
    },
    async evaluate() { return false; },
  };
  const result = await driveHeadlessSignup({
    session: {
      page,
      wait: async () => {},
      goto: async () => { throw new Error('should click 设置密码 instead of goto'); },
    },
    account: { email: 'fixture@example.test', password: 'FixedPass29!' },
    identity: { name: 'Fixture User', birthdate: '1991-05-20' },
    waitForOtp: async () => {
      otpWaited += 1;
      assert.equal(passwordFilled, true, 'must fill password before OTP wait');
      return '123456';
    },
    log: msg => notes.push(String(msg)),
    recoverLanding: async () => page.recoverLanding(),
    performanceProfile: 'throughput',
    stepTimeoutMs: 800,
  });
  assert.equal(result.landing, `${CHATGPT}/`);
  assert.equal(otpWaited, 1);
  assert.equal(passwordFilled, true);
  const passwordStep = notes.findIndex(item => /第2步：正在填写密码/.test(item));
  const otpStep = notes.findIndex(item => /第3步：正在等邮箱验证码/.test(item));
  assert.ok(passwordStep >= 0 && otpStep > passwordStep);
});

test('email-verification with OTP control is otp, not about', async () => {
  const session = {
    wait: async () => {},
    page: {
      url: () => `${AUTH}/email-verification`,
      locator(selector) {
        return {
          first() { return this; },
          async isVisible() { return /one-time-code|name="code"|inputmode="numeric"/i.test(selector); },
        };
      },
    },
  };
  assert.equal(await detectStage(session), 'otp');
  assert.equal(await waitForStage(session, ['password', 'otp', 'about'], { timeoutMs: 40 }), 'otp');
});

test('checked 2FA enrolls TOTP after signup and reports secret saved', async () => {
  const MFA_INFO = `${CHATGPT}/backend-api/accounts/mfa_info`;
  const MFA_ENROLL = `${CHATGPT}/backend-api/accounts/mfa/enroll`;
  const MFA_ACTIVATE = `${CHATGPT}/backend-api/accounts/mfa/user/activate_enrollment`;
  let infoReads = 0;
  const logs = [];
  const harness = protocolHarness({
    [MFA_INFO]: () => {
      infoReads += 1;
      return infoReads === 1
        ? ok({ mfa_enabled: false, factors: [] })
        : ok({ mfa_enabled_v2: true, factors: [{ id: 'factor-1', factor_type: 'totp' }] });
    },
    [MFA_ENROLL]: () => ok({ secret: 'JBSWY3DPEHPK3PXP', session_id: 'session-1', factor: { id: 'factor-1' } }),
    [MFA_ACTIVATE]: () => ok({}),
  });
  const result = await harness.flow.run(
    { email: 'fixture@example.test', password: 'Fixed-Password-29!' },
    { set_password: false, enable_totp_2fa: true },
    { log: (msg) => logs.push(String(msg)) },
  );
  assert.equal(result.mfa_enabled, true);
  assert.equal(result.has_totp_secret, true);
  assert.equal(result.security_ready, true);
  assert.ok(harness.requests.some(item => item.url.endsWith('/mfa/enroll')));
  assert.ok(logs.some(item => /二次验证已经打开啦/.test(item)));
});

test('MFA activation lost response is reconciled by confirmed state', async () => {
  let infoReads = 0;
  const result = await enableTotp({
    wait: async () => {},
    request: async url => {
      if (url.endsWith('/mfa_info')) {
        infoReads += 1;
        return infoReads === 1
          ? ok({ mfa_enabled: false, factors: [] })
          : ok({ mfa_enabled: true, factors: [{ id: 'factor-1', factor_type: 'totp' }] });
      }
      if (url.endsWith('/enroll')) return ok({ secret: 'JBSWY3DPEHPK3PXP', session_id: 'session-1', factor: { id: 'factor-1' } });
      throw Object.assign(new Error('activation response lost'), { code: 'PROTOCOL_REQUEST_NETWORK' });
    },
  }, { accessToken: 'at', deviceId: 'device', now: () => 1000 });
  assert.equal(result.mfa_enabled, true);
  assert.equal(infoReads, 2);
});

test('RT verification failure is never returned as verified credentials', async () => {
  await assert.rejects(
    verifyRefreshCredential({
      page: { route: async () => {} },
      request: async () => ({ ok: false, status: 401, data: { error: { code: 'refresh_token_invalidated' } } }),
    }, {
      access_token: token(),
      refresh_token: 'rt.invalid',
      client_id: 'app_fixture',
    }),
    error => error.code === 'ACCOUNT_RT_REFRESH_VERIFY_FAILED',
  );
});

test('protocol signup omits passkey capability and keeps vendor mail off the ChatGPT context', async () => {
  let extraPages = 0;
  const harness = protocolHarness();
  const originalNewPage = harness.session.newPage;
  harness.session.newPage = async (...args) => {
    extraPages += 1;
    return originalNewPage(...args);
  };
  await harness.flow.run(
    { email: 'fixture@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    { country: 'JP', mailChannel: { wait: async () => ({ code: '123456' }) } },
  );
  const signIn = harness.requests.find(item => item.url.includes('/api/auth/signin/openai'));
  assert.ok(signIn);
  assert.doesNotMatch(signIn.url, /ext-passkey-client-capabilities/);
  const created = harness.requests.find(item => item.url.endsWith('/create_account'));
  assert.match(String(created?.options?.json?.name || ''), /[一-龯]/);
  assert.equal(extraPages, 0);
});

test('US registration submits an English create_account profile', async () => {
  const harness = protocolHarness();
  await harness.flow.run(
    { email: 'us@example.test', password: '' },
    { set_password: false, enable_totp_2fa: false },
    { country: 'US' },
  );
  const created = harness.requests.find(item => item.url.endsWith('/create_account'));
  assert.match(String(created?.options?.json?.name || ''), /^[A-Za-z]+ [A-Za-z]+$/);
});

test('GB English about-you descriptors classify name and birthday', () => {
  const { classifyAboutInputDescriptors } = require('../src/automation/flows/register-headless');
  const classified = classifyAboutInputDescriptors([
    { name: 'name', ariaLabel: 'Full name', placeholder: 'Full name' },
    { name: 'birthday', ariaLabel: 'Birthday', placeholder: 'MM/DD/YYYY' },
  ], 'Tell us about you');
  assert.equal(classified.nameIndex, 0);
  assert.equal(classified.valueIndex, 1);
  assert.equal(classified.mode, 'birthdate');
});

test('about-you birthday segments fill MM/DD/YYYY in DOM order and Tab-commit', async () => {
  const { fillAboutYou } = require('../src/automation/flows/register-headless');
  const order = [];
  const values = new Map();
  let stage = 'about';
  const page = {
    url: () => 'https://auth.openai.com/about-you',
    locator(selector) {
      const isName = /name="name"|autocomplete="name"|aria-label\*="name"|full name|label:has-text\("Name"\)/i.test(selector);
      const isMonth = /bday-month|aria-label\*="month"|aria-label="Month"|aria-label="月"|aria-label="Ay"/i.test(selector);
      const isDay = /bday-day|aria-label\*="day"|aria-label="Day"|aria-label="日"|aria-label="Gün"/i.test(selector);
      const isYear = /bday-year|aria-label\*="year"|aria-label="Year"|aria-label="年"|aria-label="Yıl"/i.test(selector);
      const isSubmit = /^(?:button|form button)|type="submit"|Continue/.test(selector);
      const key = isName ? 'name' : isMonth ? 'month' : isDay ? 'day' : isYear ? 'year' : isSubmit ? 'submit' : 'other';
      return {
        first() { return this; },
        async isVisible() { return key !== 'other'; },
        async fill(value) {
          values.set(key, String(value));
          order.push(`${key}:${value}`);
        },
        async inputValue() { return values.get(key) || ''; },
        async click() {},
        async press(name) { order.push(`${key}:press:${name}`); },
        async evaluate() { return false; },
      };
    },
    async evaluate() { return { continue_enabled: true, fields: [], alerts: [] }; },
  };
  const result = await fillAboutYou({ page, wait: async () => {} }, {
    name: 'James Smith',
    birthdate: '1994-07-15',
  }, { timeoutMs: 400 });
  assert.match(result.mode, /birthdate-segments/);
  assert.equal(result.mode.includes('evaluate'), false);
  assert.equal(values.get('name'), 'James Smith');
  assert.equal(values.get('month'), '07');
  assert.equal(values.get('day'), '15');
  assert.equal(values.get('year'), '1994');
  const filled = order.filter(item => /^(?:name|month|day|year):(?!press)/.test(item));
  assert.deepEqual(filled.slice(0, 4), ['name:James Smith', 'month:07', 'day:15', 'year:1994']);
  assert.ok(order.some(item => item.includes('press:Tab')));
});
