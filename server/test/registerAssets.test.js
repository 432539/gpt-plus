'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  BoundedByteLruCache,
  createTelemetry,
  isCacheableStaticResponse,
  isImmutableStaticRequest,
  shouldBlockRegistrationResource,
} = require('../src/automation/lib/register-assets');
const {
  submitEntryEmail,
  waitForStableVisibleInputNode,
} = require('../src/automation/flows/register-headless');

const STATIC_URL = 'https://cdn.oaistatic.com/assets/app-0123456789abcdef.js';

test('immutable cache policy admits only safe public JS/CSS bytes', () => {
  assert.equal(isImmutableStaticRequest({
    url: STATIC_URL, method: 'GET', resourceType: 'script',
  }), true);
  assert.equal(isCacheableStaticResponse({
    url: STATIC_URL,
    status: 200,
    headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
    bodyLength: 100,
  }), true);

  const rejected = [
    { url: 'https://auth.openai.com/api/account-0123456789abcdef.js', headers: { 'content-type': 'application/javascript' } },
    { url: 'https://cdn.oaistatic.com/assets/challenge-0123456789abcdef.js', headers: { 'content-type': 'application/javascript' } },
    { url: STATIC_URL, headers: { 'content-type': 'text/html', 'cache-control': 'immutable' } },
    { url: STATIC_URL, headers: { 'content-type': 'application/javascript', 'cache-control': 'private, no-store, immutable' } },
    { url: STATIC_URL, headers: { 'content-type': 'application/javascript', 'cache-control': 'immutable', 'set-cookie': 'session=secret' } },
    { url: STATIC_URL, headers: { 'content-type': 'application/javascript', 'cache-control': 'immutable', vary: 'Cookie' } },
  ];
  for (const fixture of rejected) {
    assert.equal(isCacheableStaticResponse({
      status: 200, bodyLength: 100, ...fixture,
    }), false);
  }
  assert.equal(isImmutableStaticRequest({
    url: `${STATIC_URL}?token=secret`, method: 'GET', resourceType: 'script',
  }), false);
  assert.equal(isImmutableStaticRequest({
    url: STATIC_URL, method: 'GET', resourceType: 'xhr',
  }), false);
  assert.equal(isImmutableStaticRequest({
    url: STATIC_URL,
    method: 'GET',
    resourceType: 'script',
    headers: { authorization: 'Bearer secret' },
  }), false);
});

test('bounded byte LRU evicts least recently used entries and expires them', () => {
  let now = 1000;
  const cache = new BoundedByteLruCache({
    maxEntries: 2, maxBytes: 4, ttlMs: 100, now: () => now,
  });
  cache.set('a', { body: Buffer.from('aa') });
  cache.set('b', { body: Buffer.from('bb') });
  assert.equal(cache.get('a').body.toString(), 'aa');
  cache.set('c', { body: Buffer.from('cc') });
  assert.equal(cache.get('b'), null);
  assert.equal(cache.stats().entries, 2);
  assert.ok(cache.stats().bytes <= 4);
  now += 101;
  assert.equal(cache.get('a'), null);
});

test('media blocker preserves scripts, styles, XHR, fonts, and challenge assets', () => {
  assert.equal(shouldBlockRegistrationResource({
    url: 'https://chatgpt.com/hero.webp', resourceType: 'image',
  }), true);
  assert.equal(shouldBlockRegistrationResource({
    url: 'https://chatgpt.com/intro.mp4', resourceType: 'media',
  }), true);
  for (const resourceType of ['script', 'stylesheet', 'xhr', 'fetch', 'document', 'font']) {
    assert.equal(shouldBlockRegistrationResource({
      url: 'https://chatgpt.com/app.js', resourceType,
    }), false);
  }
  assert.equal(shouldBlockRegistrationResource({
    url: 'https://challenges.cloudflare.com/turnstile/image.png', resourceType: 'image',
  }), false);
});

test('stable email lookup skips hidden or disabled nth=0 and reacquires nth=1', async () => {
  const session = {
    wait: async () => {},
    page: {
      locator() {
        const candidates = [
          { async isVisible() { return true; }, async isEnabled() { return false; } },
          {
            async isVisible() { return true; },
            async isEnabled() { return true; },
            async boundingBox() { return { x: 10, y: 20, width: 240, height: 40 }; },
          },
        ];
        return {
          async count() { return candidates.length; },
          nth(index) { return candidates[index]; },
        };
      },
    },
  };
  const found = await waitForStableVisibleInputNode(session, ['input[type=email]'], {
    timeoutMs: 1000, settleMs: 50,
  });
  assert.equal(found.index, 1);
});

test('covered email interaction retries once in the same page', async () => {
  class Page extends EventEmitter {
    constructor() {
      super();
      this.current = 'https://chatgpt.com/auth/login';
      this.submitCalls = 0;
      this.value = '';
    }

    url() { return this.current; }

    locator(selector) {
      const page = this;
      const email = /type="email"|name="email"|username|inputmode="email"/i.test(selector);
      const submit = /^(?:button|form button)|type="submit"/.test(selector);
      const consent = /Accept All|Accept all|Allow all|同意全部|接受全部/i.test(selector);
      const locator = email ? {
        async isVisible() { return true; },
        async isEnabled() { return true; },
        async boundingBox() { return { x: 1, y: 1, width: 200, height: 30 }; },
        async fill(value) { page.value = value; },
        async inputValue() { return page.value; },
        async press() { throw new Error('element is covered by <BUTTON>'); },
      } : submit ? {
        async isVisible() { return true; },
        async isEnabled() { return true; },
        async click() {
          page.submitCalls += 1;
          if (page.submitCalls === 1) throw new Error('pointer_events check: element is covered by <BUTTON>');
          page.emit('request', { url: () => 'https://auth.openai.com/api/accounts/authorize' });
          page.current = 'https://auth.openai.com/create-account/password';
        },
      } : {
        async isVisible() { return !consent && false; },
        async isEnabled() { return false; },
      };
      return {
        async count() { return email || submit ? 1 : 0; },
        nth() { return locator; },
        first() { return locator; },
      };
    }

    async evaluate() { return false; }
  }

  const page = new Page();
  const telemetry = createTelemetry();
  const result = await submitEntryEmail({
    page,
    wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))),
    goto: async () => {},
  }, 'fixture@example.test', {
    timeoutMs: 15000,
    telemetry,
  });
  assert.match(result, /^https:\/\/auth\.openai\.com\//);
  assert.equal(page.submitCalls, 2);
  assert.equal(telemetry.summary('SUCCESS').dom_in_page_retries, 1);
});

test('telemetry summary contains aggregates only and sanitizes final codes', () => {
  const telemetry = createTelemetry();
  telemetry.hit(123);
  telemetry.miss();
  telemetry.blocked();
  telemetry.noteDomRetry();
  const output = JSON.stringify(telemetry.summary('https://secret.invalid/?token=credential'));
  assert.match(output, /REGISTER_ASSET_OPT_V1/);
  assert.match(output, /"final_code":"UNKNOWN"/);
  assert.doesNotMatch(output, /secret|token=|credential/);
});

test('static route already-handled fulfill does not throw', async () => {
  const { installRegistrationAssetOptimization } = require('../src/automation/lib/register-assets');
  let handler;
  const page = {
    async route(_pattern, fn) { handler = fn; },
    async unroute() {},
  };
  const cache = {
    get() {
      return {
        body: Buffer.from('ok'),
        contentType: 'application/javascript',
        cacheControl: 'public, max-age=1800, immutable',
      };
    },
  };
  await installRegistrationAssetOptimization(page, { cache });
  const route = {
    request() {
      return { url: STATIC_URL, method: 'GET', resourceType: 'script', headers: {} };
    },
    async fulfill() { throw new Error('Route is already handled!'); },
    async continue() { throw new Error('Route is already handled!'); },
    async fallback() { throw new Error('Route is already handled!'); },
  };
  await handler(route);
});
