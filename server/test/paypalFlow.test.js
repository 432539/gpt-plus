const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  baTokenFromLink,
  extractEcToken,
  extractWindowInitialData,
  consumeSignupResult,
  parseAuthorizeResult,
  parseMerchantSettlement,
  merchantReturnHeaders,
  reviewContextHeaders,
  followMerchantReturn,
  MERCHANT_RETURN_TIMEOUT_MS,
  MERCHANT_RETURN_WAIT_UNTIL,
  MERCHANT_RETURN_HARD_SLACK_MS,
  findAccessToken,
  graphqlErrorMessages,
  fundingSummary,
  isCardRelatedSignupError,
  isCreateMemberOasError,
  isRetryableAddressError,
  isGraphqlChallengeError,
  paceSignupSubmission,
  resetSignupPaceForTests,
  SIGNUP_SUBMIT_INTERVAL_MS,
  PayPalFlow,
} = require('../src/utils/paypalFlow');
const {
  generateCard,
  luhnChecksum,
  parsePhone,
  gbBillingLine1,
  createSessionState,
  loadRegionalBinRanges,
  GB_FIRST_NAMES,
  GB_LAST_NAMES,
  GB_ADDRESSES,
} = require('../src/utils/paypalProfile');
const { SIGNUP_NEW_MEMBER_MUTATION } = require('../src/utils/paypalGraphql');

const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'paypal-pay-sanitized.json'),
  'utf8',
));

function luhnValid(number) {
  let sum = 0;
  let alt = false;
  for (let i = String(number).length - 1; i >= 0; i -= 1) {
    let digit = Number(String(number)[i]);
    if (alt) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alt = !alt;
  }
  return sum % 10 === 0;
}

test('BA token and EC token extract from sanitized PayPal URLs', () => {
  assert.equal(baTokenFromLink(FIXTURES.approve_link), 'BA-UNITTESTTOKEN');
  assert.equal(extractEcToken('https://www.paypal.com/checkoutnow?token=EC-1SANITIZEDTOKEN', ''), 'EC-1SANITIZEDTOKEN');
  assert.equal(extractEcToken('', FIXTURES.guest_html), 'EC-1SANITIZEDTOKEN');
});

test('signup HTML yields BILLING_WITHOUT_PURCHASE initial data', () => {
  const data = extractWindowInitialData(FIXTURES.signup_html);
  assert.equal(data.checkoutSession.checkoutSessionType, 'BILLING_WITHOUT_PURCHASE');
  assert.equal(data.signupTerms.contentIdentifier, 'signupTerms-gb-en');
});

test('2FA PENDING/CONFIRMED fixtures and signup EUAT are consumed', () => {
  const initiated = FIXTURES.initiate_2fa_pending.data.initiateRiskBasedTwoFactorPhoneConfirmation;
  assert.equal(initiated.state, 'PENDING');
  assert.equal(FIXTURES.confirm_2fa.data.confirmRiskBasedTwoFactorPhoneConfirmation.state, 'CONFIRMED');
  const state = {};
  let euat = '';
  const consumed = consumeSignupResult(FIXTURES.signup_success, state, (token) => { euat = token; });
  assert.equal(consumed.success, true);
  assert.equal(state.user_id, 'buyer-fixture');
  assert.equal(euat, 'euat-fixture-token');
});

test('partial signup EUAT is extracted from card-rejected errorData', () => {
  const token = findAccessToken(FIXTURES.signup_card_rejected_with_euat.errors);
  assert.equal(token, 'euat-partial-after-addcard-failure');
});

test('card rejected with partial EUAT keeps flow and session state aligned', async () => {
  const state = createSessionState('BA-UNITTESTTOKEN');
  const session = {
    state,
    setEuatToken: async (token) => { state.euat_token = String(token || ''); },
    graphql: async (operationName) => {
      if (operationName === 'SignUpNewMemberMutation') return FIXTURES.signup_card_rejected_with_euat;
      return {};
    },
    diagnosticSnapshot: () => ({}),
  };
  const logs = [];
  const flow = new PayPalFlow({
    session,
    baToken: 'BA-UNITTESTTOKEN',
    user: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone_local: '7700900123',
      phone_country_code: '44',
      email: 'ada@example.test',
      password: 'fixture',
      dob: '01/01/1990',
    },
    card: { number: '4111111111111111', expiry: '12/2030', cvv: '123', card_type: 'CREDIT' },
    sms: null,
    cancelled: () => false,
    emit: (step, message, level) => logs.push({ step, message, level: level || 'info' }),
  });
  flow.sendSignupAttempt = async () => FIXTURES.signup_card_rejected_with_euat;
  await flow.signupWithCardRetry('EC-1SANITIZEDTOKEN', 'https://www.paypal.com/checkoutweb/signup');
  assert.equal(flow.state.euat_token, 'euat-partial-after-addcard-failure');
  assert.equal(session.state.euat_token, 'euat-partial-after-addcard-failure');
  assert.ok(logs.some((row) => row.level === 'debug' && /卡片被拒但会员已创建/.test(row.message)));
  assert.ok(logs.some((row) => row.level !== 'debug' && row.message === '会员已创建，继续授权'));
  assert.equal(logs.some((row) => row.level !== 'debug' && /卡片被拒/.test(row.message)), false);
  await assert.doesNotReject(async () => {
    flow.state.signup_context_ready = true;
    flow.state.ec_token = 'EC-1SANITIZEDTOKEN';
    flow.confirmPhoneWithRetry = async () => {};
    flow.signupWithCardRetry = async () => {};
    await flow.phase3SignupAnd2fa();
  });
});

test('authorize returnURL is treated as confirmed merchant settlement', () => {
  const authorized = parseAuthorizeResult(FIXTURES.authorize_success);
  assert.equal(authorized.status, 'success');
  assert.match(authorized.return_url, /redirect_status=succeeded/);
  const settlement = parseMerchantSettlement(authorized.return_url);
  assert.equal(settlement.settlement_status, 'confirmed');
  assert.equal(settlement.pending_url, 'https://chatgpt.com/checkout/verify?session_id=cs_test');
});

test('merchant return headers are cross-origin navigation, not PayPal same-origin fetch', () => {
  const headers = merchantReturnHeaders('https://www.paypal.com/webapps/hermes#/billingweb/review');
  assert.equal(headers['Sec-Fetch-Site'], undefined);
  assert.equal(headers['Upgrade-Insecure-Requests'], '1');
  assert.equal(headers.Referer, 'https://www.paypal.com/webapps/hermes#/billingweb/review');
});

test('merchant return uses session.navigate and keeps checkout/verify URL', async () => {
  const returnUrl = FIXTURES.authorize_success.data.billing.authorize.returnURL.href;
  let captured = null;
  const result = await followMerchantReturn({
    navigate: async (url, options) => {
      captured = { url, options };
      return { status: 200, url: 'https://chatgpt.com/checkout/verify?session_id=cs_test' };
    },
  }, returnUrl, { referer: 'https://www.paypal.com/webapps/hermes', log: () => {} });
  assert.equal(result.followed, true);
  assert.equal(result.finalRedirectUrl, 'https://chatgpt.com/checkout/verify?session_id=cs_test');
  assert.equal(captured.url, returnUrl);
  assert.equal(captured.options.headers['Sec-Fetch-Site'], undefined);
  assert.equal(captured.options.waitUntil, MERCHANT_RETURN_WAIT_UNTIL);
  assert.equal(captured.options.waitUntil, 'load');
  assert.equal(captured.options.timeout, MERCHANT_RETURN_TIMEOUT_MS);
  assert.equal(MERCHANT_RETURN_TIMEOUT_MS, 30_000);
  assert.ok(MERCHANT_RETURN_HARD_SLACK_MS <= 15_000);
});

test('merchant return failure still parses authorize return_url instead of dropping checkout/verify', async () => {
  const returnUrl = FIXTURES.authorize_success.data.billing.authorize.returnURL.href;
  const logs = [];
  const result = await followMerchantReturn({
    navigate: async () => {
      throw new Error('Failed to fetch');
    },
  }, returnUrl, {
    referer: 'https://www.paypal.com/webapps/hermes',
    log: (msg, level) => logs.push({ msg, level: level || 'info' }),
  });
  assert.equal(result.followed, false);
  assert.equal(result.finalRedirectUrl, returnUrl);
  const settlement = parseMerchantSettlement(result.finalRedirectUrl);
  assert.equal(settlement.settlement_status, 'confirmed');
  assert.equal(settlement.verification_url, 'https://chatgpt.com/checkout/verify?session_id=cs_test');
  assert.ok(logs.some((row) => row.level === 'debug' && /跟随商户回跳失败/.test(row.msg)));
  assert.ok(logs.some((row) => row.level !== 'debug' && /商户回跳未完成，等待 30 秒后按到账确认开通/.test(row.msg)));
});

test('merchant return hard-times out instead of hanging on navigate', async () => {
  const returnUrl = FIXTURES.authorize_success.data.billing.authorize.returnURL.href;
  const started = Date.now();
  const result = await followMerchantReturn({
    navigate: () => new Promise(() => {}),
  }, returnUrl, { timeoutMs: 40, log: () => {} });
  assert.equal(result.followed, false);
  assert.equal(result.finalRedirectUrl, returnUrl);
  assert.ok(Date.now() - started < 2000);
});

test('GB card generator is Luhn-valid and billing line1 is house + street', () => {
  const card = generateCard('GB');
  assert.equal(luhnValid(card.number), true);
  assert.equal(card.number.slice(-1), luhnChecksum(card.number.slice(0, -1)));
  assert.equal(card.card_type, 'CREDIT');
  assert.equal(card.issuer_country, 'GB');
  assert.match(card.expiry, /^(0[1-9]|1[0-2])\/(2027|2028|2029|2030|2031)$/);
  assert.match(card.cvv, /^\d{3}$/);
  const prefixes = loadRegionalBinRanges().GB.map((row) => row[0]);
  assert.ok(prefixes.length >= 43);
  assert.ok(prefixes.some((prefix) => card.number.startsWith(prefix)));
  const phone = parsePhone('+447700900123', 'GB');
  assert.equal(phone.phone_country_code, '+44');
  assert.equal(phone.phone_local, '7700900123');
  const withTrunk = parsePhone('+4407700900123', 'GB');
  assert.equal(withTrunk.phone_local, '7700900123');
  assert.equal(gbBillingLine1({ house_number: '12', street: 'Arundel Gardens' }), '12 Arundel Gardens');
});

test('GB names and addresses match Desktop gpt fixtures', () => {
  assert.deepEqual(GB_FIRST_NAMES.slice(), [
    'Oliver', 'George', 'Harry', 'Jack', 'Noah', 'Charlie', 'Thomas',
    'James', 'William', 'Henry', 'Amelia', 'Olivia', 'Isla', 'Emily',
    'Sophie', 'Grace', 'Charlotte', 'Ella', 'Lucy', 'Alice',
  ]);
  assert.deepEqual(GB_LAST_NAMES.slice(), [
    'Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson',
    'Davies', 'Patel', 'Robinson', 'Wright', 'Thompson', 'Evans',
    'Walker', 'White', 'Edwards', 'Green', 'Hall', 'Thomas', 'Clarke',
  ]);
  assert.deepEqual(GB_ADDRESSES[0], ['Arundel Gardens', '12', 'Notting Hill', 'London', 'Greater London', 'W11 2LW']);
  assert.equal(GB_ADDRESSES.length, 6);
});

test('SignUpNewMember mutation keeps Desktop gpt 3DS/funding fragments', () => {
  assert.match(SIGNUP_NEW_MEMBER_MUTATION, /fundingContingencies/);
  assert.match(SIGNUP_NEW_MEMBER_MUTATION, /requestParams/);
  assert.match(SIGNUP_NEW_MEMBER_MUTATION, /deviceDataCollectionUrl/);
  assert.match(SIGNUP_NEW_MEMBER_MUTATION, /bankIdentificationNumber/);
});

test('card-related signup errors are retryable', () => {
  assert.equal(isCardRelatedSignupError([{ message: 'CARD_GENERIC_ERROR' }]), true);
  assert.equal(isCardRelatedSignupError([{ message: 'UNRELATED' }]), false);
});

test('createMemberAccount OAS_ERROR requires a full onboarding context rebuild', () => {
  assert.equal(isCreateMemberOasError([{ message: 'OAS_ERROR', checkpoints: ['createMemberAccount'] }]), true);
  assert.equal(isCreateMemberOasError([{ message: 'OAS_ERROR', checkpoints: ['addCard'] }]), false);
  assert.equal(isRetryableAddressError([{ message: 'RESIDENTIAL_ADDRESS_NOT_FOUND' }]), true);
  assert.equal(isGraphqlChallengeError({
    code: 'PAYPAL_GRAPHQL_HTML_CHALLENGE',
    message: 'PAYPAL_GRAPHQL_HTML_CHALLENGE: operation=SignUpNewMemberMutation',
  }), true);
});

test('signup pacing spaces only the final SignUpNewMember mutation', async () => {
  resetSignupPaceForTests();
  let clock = 10000;
  let slept = 0;
  const now = () => clock;
  const wait = async (ms) => { slept = ms; clock += ms; };
  assert.equal(await paceSignupSubmission({ now, wait }), 0);
  clock = 10000 + 200;
  const waited = await paceSignupSubmission({ now, wait });
  assert.equal(waited, SIGNUP_SUBMIT_INTERVAL_MS - 200);
  assert.equal(slept, SIGNUP_SUBMIT_INTERVAL_MS - 200);
});

test('OTP HTML/non-JSON challenge rebuilds context instead of rotating the phone', async () => {
  let rotated = false;
  const flow = new PayPalFlow({
    baToken: 'BA-UNITTESTTOKEN',
    user: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone_local: '7700900123',
      phone_country_code: '44',
      email: 'ada@example.test',
      password: 'fixture',
      dob: '01/01/1990',
    },
    card: { number: '4111111111111111', expiry: '12/2030', cvv: '123', card_type: 'CREDIT' },
    session: { graphql: async () => ({}), diagnosticSnapshot: () => ({}) },
    sms: {
      rotatePhone: async () => { rotated = true; return '+447700900124'; },
      waitForCode: async () => '654321',
    },
    cancelled: () => false,
    emit: () => {},
  });
  flow.initiate2fa = async () => {
    throw Object.assign(new Error('PAYPAL_GRAPHQL_HTML_CHALLENGE: operation=InitiateRiskBasedTwoFactorPhoneConfirmationMutation'), {
      code: 'PAYPAL_GRAPHQL_HTML_CHALLENGE',
      recoverable: true,
    });
  };
  await assert.rejects(
    () => flow.confirmPhoneWithRetry('EC-1SANITIZEDTOKEN', 'https://www.paypal.com/checkoutweb/signup'),
    (error) => {
      assert.equal(error.code, 'PAYPAL_OTP_CONTEXT_REBUILD');
      assert.equal(error.recoverable, true);
      assert.match(error.message, /PAYPAL_OTP_CONTEXT_REBUILD/);
      return true;
    },
  );
  assert.equal(rotated, false);
});

test('AUTHORIZE_EMPTY keeps GraphQL errors and is not treated as success', () => {
  const empty = parseAuthorizeResult([{ data: { billing: { authorize: null } } }]);
  assert.equal(empty.status, 'error');
  assert.equal(empty.error_code, 'AUTHORIZE_EMPTY');
  assert.equal(empty.retryable, false);
  assert.equal(empty.error, 'authorize returned empty result');

  const declined = parseAuthorizeResult([{
    data: { billing: { authorize: null } },
    errors: [{ message: 'RISK_DISALLOWED' }, { message: 'NEED_CREDIT_CARD' }],
  }]);
  assert.equal(declined.status, 'error');
  assert.equal(declined.error_code, 'AUTHORIZE_EMPTY');
  assert.deepEqual(declined.graphql_errors, ['RISK_DISALLOWED', 'NEED_CREDIT_CARD']);
  assert.match(declined.error, /RISK_DISALLOWED/);
  assert.equal(graphqlErrorMessages(declined.raw_response).includes('NEED_CREDIT_CARD'), true);

  const buyerNotSet = parseAuthorizeResult([{
    data: { billing: {} },
    errors: [{ message: 'BUYER_NOT_SET', data: { contingency: 'BUYER_NOT_SET' } }],
  }]);
  assert.equal(buyerNotSet.error_code, 'BUYER_NOT_SET');
  assert.equal(buyerNotSet.retryable, true);
});

test('review context headers match Desktop gpt Hermes HTML navigation', () => {
  const headers = reviewContextHeaders('https://www.paypal.com/checkoutweb/signup');
  assert.equal(headers['Sec-Fetch-Site'], undefined);
  assert.match(headers.Accept, /image\/apng/);
  assert.equal(headers.Referer, 'https://www.paypal.com/checkoutweb/signup');
  assert.deepEqual(fundingSummary({
    fundingOptions: {
      fundingInstrument: { id: 'FI-1' },
      allPlans: [{ fundingSources: [{ fundingInstrument: { id: 'FI-1' } }] }],
    },
  }), { selected: true, available: true, available_count: 1 });
});

test('phase4 authorize reloads review after EUAT and does not fake success on empty authorize', async () => {
  const gets = [];
  const operations = [];
  const state = createSessionState('BA-UNITTESTTOKEN');
  state.ec_token = 'EC-1SANITIZEDTOKEN';
  state.euat_token = 'euat-fixture-token';
  state.signup_url = 'https://www.paypal.com/checkoutweb/signup?token=EC-1SANITIZEDTOKEN';
  state.signup_context_ready = true;
  state.ssrt = 'ssrt-fixture';
  state.paypal_client_metadata_id = '11111111-2222-3333-4444-555555555555';
  const session = {
    state,
    lastGraphqlMeta: { paypal_debug_id: 'debug-fixture' },
    setEuatToken: async (token) => { state.euat_token = String(token || ''); },
    get: async (url) => {
      gets.push(String(url));
      return { status: 200, url, headers: {}, text: '' };
    },
    postGzip: async () => ({ status: 204 }),
    post: async () => ({ status: 204 }),
    graphql: async (operationName) => {
      operations.push(operationName);
      if (operationName === 'BuyerFundingContextQuery' || operationName === 'BuyerContextQuery') {
        return {
          data: {
            checkoutSession: {
              buyer: { userId: 'buyer-fixture', auth: { accessToken: 'euat-fixture-token' } },
              fundingOptions: {
                fundingInstrument: { id: 'FI-1' },
                allPlans: [{ fundingSources: [{ fundingInstrument: { id: 'FI-1' } }] }],
              },
            },
          },
        };
      }
      if (operationName === 'authorize') {
        return [{ data: { billing: { authorize: null } }, errors: [{ message: 'RISK_DISALLOWED' }] }];
      }
      return {};
    },
    diagnosticSnapshot: () => ({}),
  };
  const logs = [];
  const flow = new PayPalFlow({
    session,
    baToken: 'BA-UNITTESTTOKEN',
    user: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone_local: '7700900123',
      phone_country_code: '44',
      email: 'ada@example.test',
      password: 'fixture',
      dob: '01/01/1990',
    },
    card: { number: '4111111111111111', expiry: '12/2030', cvv: '123', card_type: 'CREDIT' },
    sms: null,
    cancelled: () => false,
    emit: (step, message, level) => logs.push({ step, message, level: level || 'info' }),
    sleep: async () => {},
  });
  const result = await flow.phase4Authorize();
  assert.equal(result.status, 'error');
  assert.equal(result.error_code, 'AUTHORIZE_EMPTY');
  assert.equal(result.paypal_authorized, undefined);
  assert.match(result.error, /RISK_DISALLOWED/);
  assert.equal(operations.filter((name) => name === 'authorize').length, 1);
  const hermesGets = gets.filter((url) => url.includes('/webapps/hermes'));
  assert.ok(hermesGets.length >= 3);
  assert.ok(hermesGets.some((url) => url.includes('addFIContingency=noretry')));
  assert.ok(logs.some((row) => /身份提升完成/.test(row.message)));
  assert.ok(logs.some((row) => /RISK_DISALLOWED/.test(row.message)));
  assert.equal(logs.some((row) => /跟随商户回跳/.test(row.message)), false);
});

test('BUYER_NOT_SET retries authorize with client context then still fails empty', async () => {
  const authorizeHeaders = [];
  const state = createSessionState('BA-UNITTESTTOKEN');
  state.ec_token = 'EC-1SANITIZEDTOKEN';
  state.euat_token = 'euat-fixture-token';
  state.signup_url = 'https://www.paypal.com/checkoutweb/signup?token=EC-1SANITIZEDTOKEN';
  state.signup_context_ready = true;
  state.ssrt = 'ssrt-fixture';
  state.paypal_client_metadata_id = '11111111-2222-3333-4444-555555555555';
  let authorizeCalls = 0;
  const session = {
    state,
    lastGraphqlMeta: {},
    setEuatToken: async (token) => { state.euat_token = String(token || ''); },
    get: async (url) => ({ status: 200, url, headers: {}, text: '' }),
    postGzip: async () => ({ status: 204 }),
    post: async () => ({ status: 204 }),
    graphql: async (operationName, _query, _variables, options = {}) => {
      if (operationName === 'BuyerFundingContextQuery' || operationName === 'BuyerContextQuery') {
        return {
          data: {
            checkoutSession: {
              buyer: { userId: 'buyer-fixture', auth: { accessToken: 'euat-fixture-token' } },
            },
          },
        };
      }
      if (operationName === 'authorize') {
        authorizeCalls += 1;
        authorizeHeaders.push(options.extraHeaders || {});
        if (authorizeCalls === 1) {
          return [{ errors: [{ message: 'BUYER_NOT_SET', data: { contingency: 'BUYER_NOT_SET' } }] }];
        }
        return [{ data: { billing: { authorize: null } } }];
      }
      return {};
    },
    diagnosticSnapshot: () => ({}),
  };
  const flow = new PayPalFlow({
    session,
    baToken: 'BA-UNITTESTTOKEN',
    user: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      phone_local: '7700900123',
      phone_country_code: '44',
      email: 'ada@example.test',
      password: 'fixture',
      dob: '01/01/1990',
    },
    card: { number: '4111111111111111', expiry: '12/2030', cvv: '123', card_type: 'CREDIT' },
    cancelled: () => false,
    emit: () => {},
    sleep: async () => {},
  });
  const result = await flow.phase4Authorize();
  assert.equal(authorizeCalls, 2);
  assert.equal(authorizeHeaders[0]['PayPal-Client-Context'], null);
  assert.equal(authorizeHeaders[1]['PayPal-Client-Context'], 'EC-1SANITIZEDTOKEN');
  assert.equal(result.error_code, 'AUTHORIZE_EMPTY');
  assert.equal(result.status, 'error');
});
