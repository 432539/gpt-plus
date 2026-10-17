const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
  CLOAK_SLOT_FAIL_MESSAGE,
  isCloakSessionClosedError,
  isCloakCapacityError,
  isCloakTransportRetryError,
  cloakRetryMessage,
  exhaustedCloakSlotError,
  runWithCloakTransportRetry,
} = require('../src/utils/cloakErrors');

test('classifies Cloak page closed, newPage, and capacity as transport retry', () => {
  assert.equal(CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS, 3);
  assert.equal(isCloakSessionClosedError({
    message: 'CloakBrowser 协议上下文加载失败 https://www.paypal.com/: page.goto: Target page, context or browser has been closed',
  }), true);
  assert.equal(isCloakSessionClosedError({
    message: 'browser.newPage: Target page, context or browser has been closed',
  }), true);
  assert.equal(isCloakCapacityError({
    message: 'CloakBrowser Pro: session limit reached for your plan. Close another running session or upgrade your plan.',
  }), true);
  assert.equal(isCloakCapacityError({
    message: 'CloakBrowser 许可证席位暂满，暂停新浏览器冷启动 5 秒后重试',
  }), true);
  assert.equal(isCloakCapacityError({ code: 'CLOAK_LICENSE_SESSION_LIMIT' }), true);
  assert.equal(isCloakTransportRetryError({ message: 'CHECKOUT_APPROVE_BLOCKED' }), false);
  assert.equal(isCloakTransportRetryError({ code: 'AUTHORIZE_EMPTY', message: 'RISK_DISALLOWED' }), false);
  assert.equal(cloakRetryMessage(2, 3), 'Cloak 页面被关闭，换会话重试（2/3）');
  assert.equal(exhaustedCloakSlotError().message, CLOAK_SLOT_FAIL_MESSAGE);
});

test('runWithCloakTransportRetry rotates proxy twice then fails clearly', async () => {
  const proxies = [];
  const logs = [];
  let runs = 0;
  await assert.rejects(
    () => runWithCloakTransportRetry({
      delayMs: 0,
      log: (message) => logs.push(message),
      proxy: { label: 'first' },
      nextProxy: () => {
        const item = { label: `retry-${proxies.length}` };
        proxies.push(item);
        return item;
      },
      run: async () => {
        runs += 1;
        throw new Error('browser.newPage: Target page, context or browser has been closed');
      },
    }),
    (error) => {
      assert.equal(runs, 3);
      assert.equal(proxies.length, 2);
      assert.equal(error.code, 'CLOAK_SESSION_CLOSED');
      assert.equal(error.message, CLOAK_SLOT_FAIL_MESSAGE);
      return true;
    },
  );
  assert.ok(logs.some((row) => row === 'Cloak 页面被关闭，换会话重试（2/3）'));
  assert.ok(logs.some((row) => /已换会话重试仍失败（3\/3）/.test(row)));
});

test('runWithCloakTransportRetry does not retry CHECKOUT_APPROVE_BLOCKED', async () => {
  let runs = 0;
  await assert.rejects(
    () => runWithCloakTransportRetry({
      delayMs: 0,
      run: async () => {
        runs += 1;
        const error = new Error('checkout approve blocked');
        error.code = 'CHECKOUT_APPROVE_BLOCKED';
        throw error;
      },
    }),
    (error) => error.code === 'CHECKOUT_APPROVE_BLOCKED',
  );
  assert.equal(runs, 1);
});
