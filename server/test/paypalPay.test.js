const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-pay-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '4'.repeat(64);

const db = require('../src/db');
const { encodeExtractLink } = require('../src/utils/accountFields');
const { EXTRACT_LINK_TTL_MS, markExtracted, markPaid, PROGRESS } = require('../src/utils/accountProgress');
const {
  requirePayLink,
  runActivateAccount,
  isTransportPayError,
  isPaymentContextRebuildError,
  retryDelayForFailedJob,
  shouldRetryFailedJob,
  plusExpiresFromCheck,
  MAX_JOB_ATTEMPTS,
  CONTEXT_REBUILD_MAX_JOB_ATTEMPTS,
  CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
  OAS_RETRY_DELAY_MS,
  JOB_RETRY_DELAY_MS,
  PAYPAL_CHALLENGE_RETRY_DELAY_MS,
  MERCHANT_SETTLE_MS,
  verifyChatgptPlus,
  paypalAuthorizeSucceeded,
  PLUS_POLL_ATTEMPTS,
  PLUS_POLL_INTERVAL_MS,
  CHECKOUT_VERIFY_TIMEOUT_MS,
  CHECKOUT_VERIFY_WAIT_UNTIL,
} = require('../src/utils/paypalPay');
const {
  ACTIVATE_CONGRATS_COPY,
  isHiddenActivateCopy,
  activateOpLogLevel,
  activateCongratsMessage,
} = require('../src/utils/activateJob');

const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'paypal-pay-sanitized.json'),
  'utf8',
));

function stampAgo(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

function validDetail(extra = {}) {
  return {
    email: 'pay@example.test',
    access_token: 'at-fixture',
    session_token: '',
    extract_link: FIXTURES.approve_link,
    extracted_at: stampAgo(60 * 1000),
    ...extra,
  };
}

test('expired or missing 提链 tells the user to re-extract', () => {
  assert.throws(
    () => requirePayLink({ extract_link: '', extracted_at: '' }),
    /请先重新提链/,
  );
  assert.throws(
    () => requirePayLink({
      extract_link: FIXTURES.approve_link,
      extracted_at: stampAgo(EXTRACT_LINK_TTL_MS + 5000),
    }),
    /请先重新提链/,
  );
  const ok = requirePayLink(validDetail());
  assert.equal(ok.baToken, 'BA-UNITTESTTOKEN');
});

test('PayPal job refuses to start without a saved SMSBower key', async () => {
  await assert.rejects(
    () => runActivateAccount({
      detail: validDetail(),
      proxy: { host: '127.0.0.1', port: 8080 },
      settings: { sms: { api_key: '' } },
      runtime: { withSession: async () => { throw new Error('should not launch Cloak'); } },
    }),
    /请先在设置中配置 SMSBower API Key/,
  );
});

test('successful mocked authorization marks Plus with trial expiry', async () => {
  let cancelledSms = false;
  const result = await runActivateAccount({
    detail: validDetail(),
    proxy: { host: '127.0.0.1', port: 8080 },
    settings: { sms: { api_key: 'test-sms-key' } },
    smsFactory: () => ({
      reserveMatchingNumber: async () => ({ activationId: 'act-1', phone: '+447700900123' }),
      waitForCode: async () => '654321',
      rotateNumber: async () => ({ activationId: 'act-2', phone: '+447700900124' }),
      cancelActivation: async () => { cancelledSms = true; },
      finishActivation: async () => {},
      requestAnotherSms: async () => {},
    }),
    flowFactory: () => ({
      run: async () => ({
        status: 'success',
        settlement_status: 'confirmed',
        buyer_mode: 'identity_elevation',
        verification_url: 'https://chatgpt.com/checkout/verify?session_id=cs_test',
      }),
    }),
    sleep: async () => {},
    runtime: {
      withSession: async (_opts, handler) => handler({
        goto: async () => {},
        fingerprint: async () => ({ ua: 'Mozilla/5.0' }),
        request: async (url) => {
          if (String(url).includes('/backend-api/accounts/check')) {
            return { status: 200, data: FIXTURES.accounts_check_plus };
          }
          return { status: 200, data: {} };
        },
        page: { context: () => ({ addCookies: async () => {} }) },
      }),
    },
  });
  assert.equal(result.paid, true);
  assert.equal(result.plan_type, 'Plus');
  assert.equal(result.paypal.outcome, 'merchant_return_settled');
  assert.match(result.expires_at, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(cancelledSms, false);
});

test('PayPal authorize success waits 30s then marks Plus without ChatGPT check', async () => {
  let checkCalls = 0;
  const waits = [];
  const result = await runActivateAccount({
    detail: validDetail(),
    proxy: { host: '127.0.0.1', port: 8080 },
    settings: { sms: { api_key: 'test-sms-key' } },
    sleep: async (ms) => { waits.push(ms); },
    smsFactory: mockSmsFactory(),
    flowFactory: () => ({
      run: async () => ({
        status: 'success',
        settlement_status: 'confirmed',
        buyer_mode: 'identity_elevation',
        verification_url: 'https://chatgpt.com/checkout/verify?session_id=cs_test',
        return_url: FIXTURES.authorize_success.data.billing.authorize.returnURL.href,
      }),
    }),
    runtime: {
      withSession: async (_opts, handler) => handler({
        goto: async () => {},
        fingerprint: async () => ({ ua: 'Mozilla/5.0' }),
        request: async (url) => {
          if (String(url).includes('/backend-api/accounts/check')) {
            checkCalls += 1;
            return { status: 401, data: {} };
          }
          return { status: 200, data: {} };
        },
        page: { context: () => ({ addCookies: async () => {} }) },
      }),
    },
  });
  assert.equal(result.paid, true);
  assert.equal(result.plan_type, 'Plus');
  assert.equal(result.paypal.outcome, 'merchant_return_settled');
  assert.equal(checkCalls, 0);
  assert.deepEqual(waits, [MERCHANT_SETTLE_MS]);
  assert.equal(MERCHANT_SETTLE_MS, 30_000);
});

test('Plus verify polling is slower than the old 5x2s window', () => {
  assert.equal(PLUS_POLL_ATTEMPTS, 12);
  assert.equal(PLUS_POLL_INTERVAL_MS, 5000);
  assert.ok(PLUS_POLL_ATTEMPTS * PLUS_POLL_INTERVAL_MS >= 60_000);
  assert.equal(CHECKOUT_VERIFY_TIMEOUT_MS, 90_000);
  assert.equal(CHECKOUT_VERIFY_WAIT_UNTIL, 'load');
});

test('paypalAuthorizeSucceeded treats merchant bounce failure as authorized', () => {
  assert.equal(paypalAuthorizeSucceeded({ status: 'success' }), true);
  assert.equal(paypalAuthorizeSucceeded({
    status: 'error',
    error_code: 'MERCHANT_CHECKOUT_FAILED',
    paypal_authorized: true,
  }), true);
  assert.equal(paypalAuthorizeSucceeded({ status: 'error', error_code: 'AUTHORIZE_EMPTY' }), false);
});

test('merchant bounce failed still succeeds when accounts/check is Plus', async () => {
  const result = await runActivateAccount({
    detail: validDetail(),
    proxy: { host: '127.0.0.1', port: 8080 },
    settings: { sms: { api_key: 'test-sms-key' } },
    sleep: async () => {},
    smsFactory: mockSmsFactory(),
    flowFactory: () => ({
      run: async () => ({
        status: 'error',
        error_code: 'MERCHANT_CHECKOUT_FAILED',
        paypal_authorized: true,
        settlement_status: 'failed',
        verification_url: 'https://chatgpt.com/checkout/verify?session_id=cs_test',
        return_url: FIXTURES.authorize_success.data.billing.authorize.returnURL.href,
      }),
    }),
    runtime: mockRuntime(),
  });
  assert.equal(result.paid, true);
  assert.equal(result.plan_type, 'Plus');
  assert.equal(result.paypal.outcome, 'merchant_return_settled');
  assert.match(result.expires_at, /^\d{4}-\d{2}-\d{2}/);
});

test('verifyChatgptPlus returns immediately when first check is Plus even if checkout verify hangs', async () => {
  let checkCalls = 0;
  let verifyStarted = false;
  const plus = await verifyChatgptPlus({
    goto: async () => {},
    request: async (url) => {
      if (String(url).includes('/backend-api/accounts/check')) {
        checkCalls += 1;
        return { status: 200, data: FIXTURES.accounts_check_plus };
      }
      verifyStarted = true;
      await new Promise(() => {});
      return { status: 200, data: {} };
    },
    page: { context: () => ({ addCookies: async () => {} }) },
  }, validDetail(), {
    verificationUrl: 'https://chatgpt.com/checkout/verify?session_id=cs_test',
    sleep: async () => {},
  });
  assert.equal(plus.plan_type, 'Plus');
  assert.equal(checkCalls, 1);
  assert.equal(verifyStarted, false);
});

test('verifyChatgptPlus checkout verify timeout still succeeds after Plus recheck', async () => {
  let checkCalls = 0;
  const plus = await verifyChatgptPlus({
    goto: async () => {},
    request: async (url) => {
      if (String(url).includes('/backend-api/accounts/check')) {
        checkCalls += 1;
        if (checkCalls === 1) return { status: 200, data: FIXTURES.accounts_check_free };
        return { status: 200, data: FIXTURES.accounts_check_plus };
      }
      await new Promise(() => {});
      return { status: 200, data: {} };
    },
    page: { context: () => ({ addCookies: async () => {} }) },
  }, validDetail(), {
    verificationUrl: 'https://chatgpt.com/checkout/verify?session_id=cs_test',
    sleep: async () => {},
    verifyTimeoutMs: 40,
  });
  assert.equal(plus.plan_type, 'Plus');
  assert.ok(checkCalls >= 2);
});

test('verifyChatgptPlus waits PLUS_POLL_INTERVAL_MS between Free checks', async () => {
  const waits = [];
  await assert.rejects(
    () => verifyChatgptPlus({
      goto: async () => {},
      request: async (url) => {
        if (String(url).includes('/backend-api/accounts/check')) {
          return { status: 200, data: FIXTURES.accounts_check_free };
        }
        return { status: 200, data: {} };
      },
      page: { context: () => ({ addCookies: async () => {} }) },
    }, validDetail(), {
      sleep: async (ms) => { waits.push(ms); },
    }),
    (error) => error.code === 'CHATGPT_PLUS_NOT_SYNCED',
  );
  assert.equal(waits.length, PLUS_POLL_ATTEMPTS - 1);
  assert.ok(waits.every((ms) => ms === PLUS_POLL_INTERVAL_MS));
});

test('activate success copy is congrats and card-reject lines stay hidden', () => {
  assert.equal(ACTIVATE_CONGRATS_COPY, '恭喜你,开通成功');
  assert.equal(activateCongratsMessage('vs95c0jdgx@humanoid.net'), 'vs95c0jdgx@humanoid.net：恭喜你,开通成功');
  assert.equal(isHiddenActivateCopy('卡片被拒但会员已创建，继续 Hermes 授权'), true);
  assert.equal(isHiddenActivateCopy('会员已创建，继续授权'), false);
  assert.equal(activateOpLogLevel('debug'), 'info');
  assert.equal(activateOpLogLevel('warning'), 'warning');
  assert.equal(activateOpLogLevel('success'), 'success');
});

test('verifyChatgptPlus succeeds only when check reports Plus', async () => {
  const plusSession = {
    goto: async () => {},
    request: async (url) => {
      if (String(url).includes('/backend-api/accounts/check')) {
        return { status: 200, data: FIXTURES.accounts_check_plus };
      }
      return { status: 200, data: {} };
    },
    page: { context: () => ({ addCookies: async () => {} }) },
  };
  const plus = await verifyChatgptPlus(plusSession, validDetail(), { sleep: async () => {} });
  assert.equal(plus.plan_type, 'Plus');

  const freeSession = {
    goto: async () => {},
    request: async (url) => {
      if (String(url).includes('/backend-api/accounts/check')) {
        return { status: 200, data: FIXTURES.accounts_check_free };
      }
      return { status: 200, data: {} };
    },
    page: { context: () => ({ addCookies: async () => {} }) },
  };
  await assert.rejects(
    () => verifyChatgptPlus(freeSession, validDetail(), { sleep: async () => {} }),
    (error) => {
      assert.equal(error.code, 'CHATGPT_PLUS_NOT_SYNCED');
      assert.notEqual(error.plan_type, 'Plus');
      return true;
    },
  );
});

test('rebuild-retry classification matches Desktop gpt and is not a ban', () => {
  assert.equal(MAX_JOB_ATTEMPTS, 1);
  assert.equal(CONTEXT_REBUILD_MAX_JOB_ATTEMPTS, 1);
  assert.equal(CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS, 3);
  assert.equal(isPaymentContextRebuildError({
    code: 'PAYPAL_ONBOARDING_CONTEXT_REBUILD',
    message: 'PAYPAL_ONBOARDING_CONTEXT_REBUILD: PayPal createMemberAccount rejected the current onboarding context',
  }), true);
  assert.equal(isPaymentContextRebuildError({
    message: 'IDENTITY_ELEVATION_EC_MISSING: no checkout token',
  }), true);
  assert.equal(isPaymentContextRebuildError({
    code: 'PAYPAL_GRAPHQL_HTML_CHALLENGE',
    message: 'PAYPAL_GRAPHQL_HTML_CHALLENGE: operation=SignUpNewMemberMutation',
  }), true);
  assert.equal(isPaymentContextRebuildError({
    code: 'PAYPAL_PAGE_CHALLENGE',
    message: 'PAYPAL_PAGE_CHALLENGE: DataDome challenge blocked the agreement page',
  }), true);
  assert.equal(isPaymentContextRebuildError({ message: 'proxy timeout' }), false);
  assert.equal(
    retryDelayForFailedJob({ code: 'PAYPAL_ONBOARDING_CONTEXT_REBUILD' }),
    OAS_RETRY_DELAY_MS,
  );
  assert.ok(OAS_RETRY_DELAY_MS > JOB_RETRY_DELAY_MS);
  assert.equal(
    retryDelayForFailedJob({ code: 'PAYPAL_GRAPHQL_HTML_CHALLENGE' }),
    PAYPAL_CHALLENGE_RETRY_DELAY_MS,
  );

  const contextRebuild = shouldRetryFailedJob({
    jobAttempt: 1,
    maxJobAttempts: 1,
    error: new Error('PAYPAL_ONBOARDING_CONTEXT_REBUILD: OAS_ERROR'),
  });
  assert.equal(contextRebuild.retry, false);
  assert.equal(contextRebuild.maxJobAttempts, 1);

  const otpRebuild = shouldRetryFailedJob({
    jobAttempt: 1,
    maxJobAttempts: 1,
    error: { code: 'PAYPAL_OTP_CONTEXT_REBUILD', message: 'PAYPAL_OTP_CONTEXT_REBUILD: fixture' },
  });
  assert.equal(otpRebuild.retry, false);

  const ordinary = shouldRetryFailedJob({
    jobAttempt: 1,
    maxJobAttempts: 1,
    error: new Error('card was rejected after 5 attempts'),
  });
  assert.equal(ordinary.retry, false);
  assert.equal(ordinary.maxJobAttempts, 1);

  const authorizeEmpty = shouldRetryFailedJob({
    jobAttempt: 1,
    maxJobAttempts: 5,
    error: { code: 'AUTHORIZE_EMPTY', message: 'RISK_DISALLOWED' },
  });
  assert.equal(authorizeEmpty.retry, false);

  const cloakClosed = shouldRetryFailedJob({
    jobAttempt: 1,
    maxJobAttempts: 1,
    error: new Error('CloakBrowser 协议上下文加载失败 https://www.paypal.com/: page.goto: Target page, context or browser has been closed'),
  });
  assert.equal(cloakClosed.retry, true);
  assert.equal(cloakClosed.maxJobAttempts, 3);
  assert.equal(shouldRetryFailedJob({
    jobAttempt: 3,
    maxJobAttempts: 3,
    error: new Error('browser.newPage: Target page, context or browser has been closed'),
  }).retry, false);
});

function mockRuntime() {
  return {
    withSession: async (_opts, handler) => handler({
      goto: async () => {},
      fingerprint: async () => ({ ua: 'Mozilla/5.0' }),
      request: async (url) => {
        if (String(url).includes('/backend-api/accounts/check')) {
          return { status: 200, data: FIXTURES.accounts_check_plus };
        }
        return { status: 200, data: {} };
      },
      page: { context: () => ({ addCookies: async () => {} }) },
    }),
  };
}

function mockSmsFactory() {
  return () => ({
    reserveMatchingNumber: async () => ({ activationId: 'act-1', phone: '+447700900123' }),
    waitForCode: async () => '654321',
    rotateNumber: async () => ({ activationId: 'act-2', phone: '+447700900124' }),
    cancelActivation: async () => {},
    finishActivation: async () => {},
    requestAnotherSms: async () => {},
  });
}

test('CONTEXT_REBUILD fails fast without auto-retry or extra SMS numbers', async () => {
  let runs = 0;
  let reserveCount = 0;
  const proxies = [];
  await assert.rejects(
    () => runActivateAccount({
      detail: validDetail(),
      proxy: { host: '127.0.0.1', port: 8080, label: 'first' },
      nextProxy: () => {
        const item = { host: '127.0.0.1', port: 8081 + proxies.length, label: `retry-${proxies.length}` };
        proxies.push(item);
        return item;
      },
      settings: { sms: { api_key: 'test-sms-key' } },
      smsFactory: () => ({
        reserveMatchingNumber: async () => {
          reserveCount += 1;
          return { activationId: 'act-1', phone: '+447700900123' };
        },
        waitForCode: async () => '654321',
        rotateNumber: async () => ({ activationId: 'act-2', phone: '+447700900124' }),
        cancelActivation: async () => {},
        finishActivation: async () => {},
        requestAnotherSms: async () => {},
      }),
      sleep: async () => {},
      flowFactory: () => ({
        run: async () => {
          runs += 1;
          throw Object.assign(new Error('PAYPAL_ONBOARDING_CONTEXT_REBUILD: PayPal createMemberAccount rejected the current onboarding context'), {
            code: 'PAYPAL_ONBOARDING_CONTEXT_REBUILD',
            recoverable: true,
          });
        },
      }),
      runtime: mockRuntime(),
    }),
    (error) => {
      assert.equal(runs, 1);
      assert.equal(reserveCount, 1);
      assert.equal(proxies.length, 0);
      assert.equal(error.code, 'PAYPAL_ONBOARDING_CONTEXT_REBUILD');
      assert.equal(error.recoverable, true);
      return true;
    },
  );
});

test('CONTEXT_REBUILD stays recoverable after single attempt and does not look like a ban', async () => {
  let runs = 0;
  await assert.rejects(
    () => runActivateAccount({
      detail: validDetail(),
      proxy: { host: '127.0.0.1', port: 8080 },
      settings: { sms: { api_key: 'test-sms-key' } },
      smsFactory: mockSmsFactory(),
      sleep: async () => {},
      flowFactory: () => ({
        run: async () => {
          runs += 1;
          throw Object.assign(new Error('PAYPAL_ONBOARDING_CONTEXT_REBUILD: PayPal rejected the current onboarding context'), {
            code: 'PAYPAL_ONBOARDING_CONTEXT_REBUILD',
            recoverable: true,
          });
        },
      }),
      runtime: mockRuntime(),
    }),
    (error) => {
      assert.equal(runs, 1);
      assert.equal(error.code, 'PAYPAL_ONBOARDING_CONTEXT_REBUILD');
      assert.equal(error.recoverable, true);
      assert.notEqual(error.code, 'ACCOUNT_BANNED');
      assert.doesNotMatch(String(error.message), /已封禁|banned/i);
      return true;
    },
  );
});

test('Cloak page-closed retries a new session, reuses SMS, then fails clearly', async () => {
  const cloakClosed = Object.assign(
    new Error('CloakBrowser 协议上下文加载失败 https://www.paypal.com/: page.goto: Target page, context or browser has been closed'),
    { name: 'TargetClosedError' },
  );
  let sessions = 0;
  let reserveCount = 0;
  let cancelCount = 0;
  const proxies = [];
  const logs = [];
  await assert.rejects(
    () => runActivateAccount({
      detail: validDetail(),
      proxy: { host: '127.0.0.1', port: 8080, label: 'first' },
      nextProxy: () => {
        const item = { host: '127.0.0.1', port: 8081 + proxies.length, label: `retry-${proxies.length}` };
        proxies.push(item);
        return item;
      },
      settings: { sms: { api_key: 'test-sms-key' } },
      sleep: async () => {},
      log: (message) => logs.push(String(message)),
      smsFactory: () => ({
        reserveMatchingNumber: async () => {
          reserveCount += 1;
          return { activationId: 'act-keep', phone: '+447700900123' };
        },
        waitForCode: async () => '654321',
        rotateNumber: async () => ({ activationId: 'act-2', phone: '+447700900124' }),
        cancelActivation: async () => { cancelCount += 1; },
        finishActivation: async () => {},
        requestAnotherSms: async () => {},
      }),
      flowFactory: () => ({
        run: async () => {
          sessions += 1;
          throw cloakClosed;
        },
      }),
      runtime: mockRuntime(),
    }),
    (error) => {
      assert.equal(sessions, 3);
      assert.equal(reserveCount, 1);
      assert.equal(cancelCount, 1);
      assert.equal(proxies.length, 2);
      assert.equal(error.code, 'CLOAK_SESSION_CLOSED');
      assert.match(error.message, /席位不足或会话已关闭/);
      return true;
    },
  );
  assert.ok(logs.some((row) => /Cloak 页面被关闭，换会话重试（2\/3）/.test(row)));
  assert.ok(logs.some((row) => /已换会话重试仍失败（3\/3）/.test(row)));
});

test('Cloak crash before SMS is reserved retries without buying a number', async () => {
  let launches = 0;
  let reserveCount = 0;
  let cancelCount = 0;
  await runActivateAccount({
    detail: validDetail(),
    proxy: { host: '127.0.0.1', port: 8080 },
    settings: { sms: { api_key: 'test-sms-key' } },
    sleep: async () => {},
    smsFactory: () => ({
      reserveMatchingNumber: async () => {
        reserveCount += 1;
        return { activationId: 'act-keep', phone: '+447700900123' };
      },
      cancelActivation: async () => { cancelCount += 1; },
      finishActivation: async () => {},
    }),
    flowFactory: () => ({
      run: async () => ({ status: 'success' }),
    }),
    runtime: {
      withSession: async (_opts, handler) => {
        launches += 1;
        if (launches === 1) {
          throw Object.assign(new Error('browser.newPage: Target page, context or browser has been closed'), {
            name: 'TargetClosedError',
          });
        }
        return mockRuntime().withSession(_opts, handler);
      },
    },
  });
  assert.equal(launches, 2);
  assert.equal(reserveCount, 1);
  assert.equal(cancelCount, 0);
});

test('AUTHORIZE_EMPTY reconciles to success when accounts/check is already Plus', async () => {
  let runs = 0;
  let reserveCount = 0;
  const result = await runActivateAccount({
    detail: validDetail(),
    proxy: { host: '127.0.0.1', port: 8080 },
    settings: { sms: { api_key: 'test-sms-key' } },
    sleep: async () => {},
    smsFactory: () => ({
      reserveMatchingNumber: async () => {
        reserveCount += 1;
        return { activationId: 'act-1', phone: '+447700900123' };
      },
      cancelActivation: async () => {},
      finishActivation: async () => {},
    }),
    flowFactory: () => ({
      run: async () => {
        runs += 1;
        return {
          status: 'error',
          error_code: 'AUTHORIZE_EMPTY',
          error: 'authorize returned empty result: 400',
          paypal_debug_id: 'debug-1',
          http_status: 400,
          retryable: false,
        };
      },
    }),
    runtime: mockRuntime(),
  });
  assert.equal(runs, 1);
  assert.equal(reserveCount, 1);
  assert.equal(result.paid, true);
  assert.equal(result.paypal.outcome, 'reconciled_after_authorize_empty');
});

test('AUTHORIZE_EMPTY staying Free becomes frozen PAYMENT_OUTCOME_UNKNOWN', async () => {
  let checkCalls = 0;
  await assert.rejects(
    () => runActivateAccount({
      detail: validDetail(),
      proxy: { host: '127.0.0.1', port: 8080 },
      settings: { sms: { api_key: 'test-sms-key' } },
      sleep: async () => {},
      smsFactory: mockSmsFactory(),
      flowFactory: () => ({
        run: async () => ({
          status: 'error',
          error_code: 'AUTHORIZE_EMPTY',
          error: 'authorize returned empty result: 400',
          paypal_debug_id: 'debug-2',
          http_status: 400,
          retryable: false,
        }),
      }),
      runtime: {
        withSession: async (_opts, handler) => handler({
          goto: async () => {},
          request: async (url) => {
            if (String(url).includes('/backend-api/accounts/check')) {
              checkCalls += 1;
              return { status: 200, data: FIXTURES.accounts_check_free };
            }
            return { status: 200, data: {} };
          },
          page: { context: () => ({ addCookies: async () => {} }) },
          fingerprint: async () => ({ ua: 'Mozilla/5.0' }),
        }),
      },
    }),
    (error) => {
      assert.equal(error.code, 'PAYMENT_OUTCOME_UNKNOWN');
      assert.equal(error.original_code, 'AUTHORIZE_EMPTY');
      assert.equal(error.paypal_debug_id, 'debug-2');
      return true;
    },
  );
  assert.equal(checkCalls, PLUS_POLL_ATTEMPTS);
});

test('支付待核验 only checks Plus and never starts PayPal or buys SMS', async () => {
  let smsStarted = false;
  let flowStarted = false;
  const result = await runActivateAccount({
    detail: validDetail({ progress: PROGRESS.PAYMENT_REVIEW }),
    proxy: { host: '127.0.0.1', port: 8080 },
    settings: { sms: { api_key: '' } },
    sleep: async () => {},
    smsFactory: () => {
      smsStarted = true;
      throw new Error('must not buy SMS');
    },
    flowFactory: () => {
      flowStarted = true;
      throw new Error('must not call PayPal');
    },
    runtime: mockRuntime(),
  });
  assert.equal(result.paid, true);
  assert.equal(result.paypal.outcome, 'reconciled_pending_payment');
  assert.equal(smsStarted, false);
  assert.equal(flowStarted, false);
});

test('proxy/transport failures stay recoverable and do not look like a ban', async () => {
  const timeout = Object.assign(new Error('PROTOCOL_REQUEST_TIMEOUT: paypal.com'), {
    code: 'PROTOCOL_REQUEST_TIMEOUT',
  });
  assert.equal(isTransportPayError(timeout), true);
  let cancelledSms = false;
  await assert.rejects(
    () => runActivateAccount({
      detail: validDetail(),
      proxy: { host: '127.0.0.1', port: 8080 },
      settings: { sms: { api_key: 'test-sms-key' } },
      sleep: async () => {},
      smsFactory: () => ({
        reserveMatchingNumber: async () => ({ activationId: 'act-1', phone: '+447700900123' }),
        cancelActivation: async () => { cancelledSms = true; },
        finishActivation: async () => {},
      }),
      flowFactory: () => ({
        run: async () => { throw timeout; },
      }),
      runtime: {
        withSession: async (_opts, handler) => handler({
          goto: async () => {},
          fingerprint: async () => ({}),
          request: async () => ({ status: 200, data: {} }),
          page: { context: () => ({ addCookies: async () => {} }) },
        }),
      },
    }),
    (error) => {
      assert.match(error.message, /支付传输失败，账号状态保持不变/);
      assert.equal(error.recoverable, true);
      assert.notEqual(error.code, 'ACCOUNT_BANNED');
      return true;
    },
  );
  assert.equal(cancelledSms, true);
});

test('markPaid writes Plus expiry and trial expires_at helper reads check payload', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()
    || (() => {
      db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('pay-test', 'x', 'user')").run();
      return db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    })();
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress)
     VALUES (?, 'paid-expiry@example.test', 'Free', 'gmail', '正常', '已注册')`
  ).run(user.id);
  const id = inserted.lastInsertRowid;
  markExtracted(user.id, id, { extract_link: encodeExtractLink(FIXTURES.approve_link) });
  const expires = plusExpiresFromCheck(FIXTURES.accounts_check_plus);
  markPaid(user.id, id, { plan_type: 'Plus', expires_at: expires });
  const paid = db.prepare('SELECT progress, plan_type, expires_at, extract_link FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(paid.progress, PROGRESS.PAID);
  assert.equal(paid.plan_type, 'Plus');
  assert.match(String(paid.expires_at), /2026-09-19/);
  assert.equal(paid.extract_link, '');
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
