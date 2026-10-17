const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  EXTRACT_CONCURRENCY_CAP,
  parseCheckoutResponse,
  extractRedirectToUrl,
  isPaypalBaApproveUrl,
  isPaypalProviderRedirectUrl,
  isPaypalMeUrl,
  isStripeHostedCheckoutUrl,
  isStripeCheckoutTicket,
  shouldApproveFirstCheckout,
  copyablePaymentLink,
  paypalLinkFromText,
  checkoutCreateBody,
  checkoutUpdateBody,
  gcashConfirmBody,
  gcashStartBody,
  taxesBody,
  phBilling,
  PH_BILLING_PROFILE,
  gcashChatgptExtra,
  gcashRequestExtra,
  sessionCookieEntries,
  clientVersionFromHtml,
  applyLiveClientVersion,
  chatgptCookieHeader,
  resolveExtractProxyGroup,
  ensureAmountZero,
  ensureCheckoutUpdateAmountZero,
  evaluateCheckoutUpdateResponse,
  inspectCheckoutAmount,
  inspectCheckoutPayableAmount,
  checkoutStateTotalNumbers,
  checkoutResponseAmountMinor,
  decodeReactRouterFlattenedPayload,
  openaiCheckoutStateFromHtml,
  openaiCheckoutPageAmountMinor,
  recoverableExtractError,
  gcashConfirmStatus,
  isGcashConfirmSuccess,
  isGcashConfirmRejected,
  describeGcashConfirm,
  classifyCheckoutError,
  applyGcashProcessorEntity,
  gcashProcessorEntity,
  clientBuildFromHtml,
  GCASH_CHAT,
  GB,
  GBP,
  CAMPAIGN_ID,
  PAYPAL_FULL_CHECKOUT_ATTEMPTS,
  GCASH_FAILURE_ATTEMPTS,
} = require('../src/utils/paymentLink');

const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'checkout-update-sanitized.json'),
  'utf8',
));

test('GCash browser handoff preserves real cookie attributes', async () => {
  const entries = await sessionCookieEntries({
    cookies: async () => [{
      name: '__Secure-next-auth.session-token',
      value: 'fixture-session',
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
      sameSite: 'Lax',
      expires: 2000000000,
      hostOnly: true,
    }],
  }, 'fixture-device');
  const session = entries.find((item) => item.name === '__Secure-next-auth.session-token');
  assert.equal(session.domain, 'chatgpt.com');
  assert.equal(session.secure, true);
  assert.equal(session.sameSite, 'Lax');
  assert.equal(session.expires, 2000000000);
  assert.equal(session.hostOnly, true);
});

test('GB checkout body defers promo and uses custom ui', () => {
  const body = checkoutCreateBody({ country: GB, currency: GBP, uiMode: 'custom', promoEnabled: false });
  assert.equal(body.entry_point, 'all_plans_pricing_modal');
  assert.equal(body.plan_name, 'chatgptplusplan');
  assert.equal(body.billing_details.country, 'GB');
  assert.equal(body.billing_details.currency, 'GBP');
  assert.equal(body.checkout_ui_mode, 'custom');
  assert.equal(body.promo_campaign, undefined);
  const update = checkoutUpdateBody('oaics_test', '');
  assert.equal(update.promo_campaign.promo_campaign_id, CAMPAIGN_ID);
  assert.equal(update.processor_entity, 'openai_ie');
  const gcashHeaders = gcashChatgptExtra({ Referer: 'https://chatgpt.com/' });
  assert.equal(gcashHeaders['oai-language'], 'fil-PH');
  assert.equal(gcashHeaders['Accept-Language'], 'fil-PH,en;q=0.9');
  assert.equal(gcashHeaders['oai-client-build-number'], '7904904');
  assert.equal(gcashHeaders.Referer, 'https://chatgpt.com/');
  assert.equal(GCASH_CHAT.processorEntity, 'openai_ie');
  assert.equal(GCASH_CHAT.sentinelCreateFlow, 'chatgpt_checkout');
  assert.equal(GCASH_CHAT.sentinelConfirmFlow, 'checkout_session_approval');
  assert.match(GCASH_CHAT.promoHome, /promo_campaign=plus-1-month-free/);
  assert.equal(gcashProcessorEntity({}), 'openai_ie');
  assert.equal(gcashProcessorEntity({ processor_entity: 'openai_ie' }), 'openai_ie');
  assert.equal(gcashProcessorEntity({ processor_entity: 'openai_llc' }), 'openai_llc');
  assert.equal(applyGcashProcessorEntity({ cs_id: 'oaics_x' }).processor_entity, 'openai_ie');
  assert.equal(applyGcashProcessorEntity({ cs_id: 'oaics_x', processor_entity: 'openai_llc' }).processor_entity, 'openai_llc');
  const captureCreate = checkoutCreateBody({
    country: 'PH',
    currency: 'PHP',
    uiMode: 'custom',
    promoEnabled: true,
    promoQuery: false,
  });
  assert.equal(Buffer.byteLength(JSON.stringify(captureCreate)), 245);
  const eligibilityCreate = checkoutCreateBody({
    country: 'PH',
    currency: 'PHP',
    uiMode: 'custom',
    promoEnabled: true,
    promoQuery: false,
  });
  assert.equal(eligibilityCreate.promo_campaign.promo_campaign_id, CAMPAIGN_ID);
  assert.equal(Buffer.byteLength(JSON.stringify(eligibilityCreate)), 245);
  const harCs = 'oaics_752449962cdc426c98928c16bed473a8';
  const harCpm = 'cpmt_1TOgstC6h1nxGoI3WUVEY2cJ';
  assert.equal(Buffer.byteLength(JSON.stringify(gcashConfirmBody(harCs, harCpm))), 127);
  assert.equal(Buffer.byteLength(JSON.stringify(gcashStartBody(harCs, harCpm))), 128);
});

test('GCash request extra writes payment cookies back onto the header', async () => {
  const extra = await gcashRequestExtra({
    cookies: async () => ([
      { name: 'oai-did', value: 'device-1' },
      { name: 'oai-sc', value: 'sc-1' },
      { name: 'unrelated', value: 'drop-me' },
    ]),
  }, 'device-1', { Referer: 'https://chatgpt.com/' });
  assert.equal(extra['oai-language'], 'fil-PH');
  assert.match(extra.Cookie, /oai-did=device-1/);
  assert.match(extra.Cookie, /oai-sc=sc-1/);
  assert.equal(/unrelated=/.test(extra.Cookie), false);
  const live = await gcashRequestExtra({
    transport: 'curl_cffi',
    cookies: async () => ([{ name: 'oai-did', value: 'device-1' }, { name: 'oai-sc', value: 'sc-live' }]),
  }, 'device-1');
  assert.match(live.Cookie, /oai-did=device-1/);
  assert.match(live.Cookie, /oai-sc=sc-live/);
  assert.equal(live['oai-language'], 'fil-PH');
});

test('GCash request extra uses sniffed live client version', async () => {
  const html = '<html>prod-46437587156517d920436051cb9ab60a95f0503a</html>';
  assert.equal(clientVersionFromHtml(html), 'prod-46437587156517d920436051cb9ab60a95f0503a');
  const session = { cookies: async () => ([{ name: 'oai-did', value: 'device-1' }]) };
  applyLiveClientVersion(session, html);
  const extra = await gcashRequestExtra(session, 'device-1');
  assert.equal(extra['oai-client-version'], 'prod-46437587156517d920436051cb9ab60a95f0503a');
  assert.equal(extra['oai-client-build-number'], '7904904');
  assert.equal(clientBuildFromHtml('oai-client-build-number":9723596'), '9723596');
  const withBuild = {};
  applyLiveClientVersion(withBuild, 'prod-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa oai-client-build-number":9723596');
  assert.equal(withBuild.liveClientBuild, '9723596');
});

test('checkout parser accepts oaics_ and cs_ ids', () => {
  const oaics = parseCheckoutResponse({
    checkout_session_id: 'oaics_abc',
    processor_entity: 'openai_ie',
    stripe_publishable_key: 'pk_live_abc',
    total: { total: { amount: 0 }, discount: { amount: 2300 } },
  }, 'GB', 'GBP', false);
  assert.equal(oaics.cs_id, 'oaics_abc');
  assert.equal(oaics.checkout_amount_minor, 0);
  const cs = parseCheckoutResponse({ id: 'cs_live_abc', url: 'https://checkout.stripe.com/c/pay/cs_live_abc' });
  assert.equal(cs.cs_id, 'cs_live_abc');
  assert.throws(() => parseCheckoutResponse({ id: 'nope' }), /missing cs_id/);
});

test('React Router checkout page payload decodes the fallback amount', () => {
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
    '0',
  ];
  const decoded = decodeReactRouterFlattenedPayload(flattened);
  assert.equal(
    decoded.loaderData['routes/checkout.$entity.$checkoutId']
      .checkoutSession.checkout_state.total.total.minorUnitsAmount,
    '0',
  );
  const encodedChunk = JSON.stringify(JSON.stringify(flattened));
  const html = `<script>window.__reactRouterContext.streamController.enqueue(${encodedChunk})</script>`;
  const state = openaiCheckoutStateFromHtml(html);
  assert.equal(state.total.total.minorUnitsAmount, '0');
  assert.equal(state.currency, 'GBP');
  const pageAmount = openaiCheckoutPageAmountMinor(html, { currency: 'PHP' });
  assert.equal(pageAmount.amount, 0);
  assert.equal(pageAmount.currency, 'GBP');
});

test('PayPal BA approve URL is preferred copyable link', () => {
  const ba = 'https://www.paypal.com/agreements/approve?ba_token=BA-1AB2CD3EF4GH';
  const generic = 'https://www.paypal.com/checkoutnow?token=EC-123';
  const ignored = 'https://q.stripe.com/pixel.gif';
  assert.equal(isPaypalBaApproveUrl(ba), true);
  assert.equal(isPaypalProviderRedirectUrl(generic), true);
  assert.equal(isPaypalProviderRedirectUrl(ignored), false);
  assert.equal(extractRedirectToUrl({
    next_action: { type: 'redirect_to_url', redirect_to_url: { url: ba } },
  }), ba);
  assert.equal(extractRedirectToUrl({ setup_intent: { next_action: { type: 'redirect_to_url', redirect_to_url: { url: generic } } } }), generic);
  assert.equal(copyablePaymentLink(ba), ba);
  assert.equal(isPaypalMeUrl('https://www.paypal.me/openaiplus'), true);
  assert.equal(isPaypalProviderRedirectUrl('https://www.paypal.me/openaiplus'), true);
  assert.equal(isStripeHostedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_live_abc'), true);
  assert.equal(isStripeHostedCheckoutUrl('cs_live_abc'), true);
  assert.equal(shouldApproveFirstCheckout({ cs_id: 'oaics_abc' }), true);
  assert.equal(shouldApproveFirstCheckout({ cs_id: 'cs_live_abc' }), false);
  assert.equal(shouldApproveFirstCheckout({ cs_id: 'cs_test_abc' }), false);
  assert.equal(shouldApproveFirstCheckout({
    cs_id: 'oaics_abc',
    checkout_url: 'https://checkout.stripe.com/c/pay/cs_live_abc',
  }), false);
  assert.equal(isStripeCheckoutTicket({ cs_id: 'cs_live_abc' }), true);
  assert.equal(isStripeCheckoutTicket({ cs_id: 'oaics_abc' }), false);
  assert.equal(copyablePaymentLink('cs_live_abc'), '');
  assert.equal(copyablePaymentLink('https://checkout.stripe.com/c/pay/cs_live_abc'), '');
  assert.equal(
    paypalLinkFromText('redirect ba_token=BA-HTMLTOKEN and ignore stripe'),
    'https://www.paypal.com/agreements/approve?ba_token=BA-HTMLTOKEN',
  );
  assert.equal(EXTRACT_CONCURRENCY_CAP, 5);
  assert.equal(PAYPAL_FULL_CHECKOUT_ATTEMPTS, 5);
  assert.equal(GCASH_FAILURE_ATTEMPTS, 10);
});

test('cookie helper keeps payment cookies and injects device id', () => {
  const header = chatgptCookieHeader({
    sessionCookie: 'oai-did=old; __Secure-next-auth.session-token=sess; ignore=1',
    deviceId: 'device-1',
  });
  assert.match(header, /oai-did=device-1/);
  assert.match(header, /__Secure-next-auth\.session-token=sess/);
  assert.doesNotMatch(header, /ignore=/);
});

test('resolveExtractProxyGroup requires 支付 GB and rejects 注册 JP', () => {
  const groups = [
    { group_name: '注册 JP+GB' },
    { group_name: '邮箱 GB' },
    { group_name: '支付 GB' },
  ];
  assert.equal(resolveExtractProxyGroup(groups), '支付 GB');
  assert.equal(resolveExtractProxyGroup(groups, '支付 GB'), '支付 GB');
  assert.throws(() => resolveExtractProxyGroup(groups, '注册 JP+GB'), /支付/);
  assert.throws(() => resolveExtractProxyGroup(groups, '邮箱 GB'), /支付/);
  assert.throws(() => resolveExtractProxyGroup([]), /支付/);
  assert.equal(EXTRACT_CONCURRENCY_CAP, 5);
});

test('PayPal zero-amount guard stops without rebuilding a paid checkout', () => {
  assert.equal(ensureAmountZero({ total_summary: { due: 0 } }, 'GBP'), '0.00 GBP');
  assert.throws(
    () => ensureAmountZero({ total_summary: { due: 1999 } }, 'GBP'),
    (error) => error?.code === 'PAYMENT_AMOUNT_NOT_ZERO' && error?.recoverable === false,
  );
  assert.equal(ensureCheckoutUpdateAmountZero({ checkout_amount_minor: 0 }), '0.00 GBP');
  const paid = classifyCheckoutError({ status: 400, data: { detail: 'User is already paid' } });
  assert.equal(paid.code, 'ACCOUNT_ALREADY_PAID');
  assert.equal(paid.skip, true);
});

test('checkout create unusual activity matches JSON detail only, not HTML or empty 403', () => {
  const jsonUnusual = classifyCheckoutError({
    status: 403,
    headers: { 'content-type': 'application/json' },
    data: { detail: 'Our systems have detected unusual activity. Please try again later.' },
    text: JSON.stringify({ detail: 'Our systems have detected unusual activity. Please try again later.' }),
  });
  assert.equal(jsonUnusual.code, 'EXTRACT_CHECKOUT_UNUSUAL');
  assert.equal(jsonUnusual.recoverable, true);
  assert.match(jsonUnusual.message, /Our systems have detected unusual activity/);
  assert.match(jsonUnusual.message, /status=403/);

  const emptyForbidden = classifyCheckoutError({
    status: 403,
    headers: { 'content-type': 'application/json' },
    data: null,
    text: '',
  });
  assert.equal(emptyForbidden.code, 'EXTRACT_CHECKOUT_FAILED');
  assert.equal(emptyForbidden.recoverable, true);
  assert.match(emptyForbidden.message, /empty_body/);
  assert.doesNotMatch(emptyForbidden.message, /unusual activity/);

  const htmlForbidden = classifyCheckoutError({
    status: 403,
    headers: { 'content-type': 'text/html' },
    data: null,
    text: '<!doctype html><html><title>Just a moment</title>Cloudflare challenge-platform unusual activity</html>',
  });
  assert.equal(htmlForbidden.code, 'EXTRACT_CHECKOUT_FAILED');
  assert.equal(htmlForbidden.recoverable, true);
  assert.match(htmlForbidden.message, /html_challenge/);
  assert.doesNotMatch(htmlForbidden.message, /rejected as unusual activity/);
});

test('checkout/update parser recognizes nested 0 GBP promo fixtures', () => {
  assert.equal(checkoutResponseAmountMinor(FIXTURES.snapshotZeroGbp.body), 0);
  assert.equal(checkoutResponseAmountMinor(FIXTURES.nestedSessionZeroGbp.body), 0);
  assert.equal(checkoutResponseAmountMinor(FIXTURES.lineItemsZeroGbp.body), 0);
  assert.equal(checkoutResponseAmountMinor(FIXTURES.wrappedDataZeroGbp.body), 0);
  assert.equal(ensureCheckoutUpdateAmountZero(FIXTURES.snapshotZeroGbp.body), '0.00 GBP');
  assert.equal(ensureCheckoutUpdateAmountZero(FIXTURES.nestedSessionZeroGbp.body), '0.00 GBP');
});

test('source checkout/update 200 without total is accepted and not treated as expired', () => {
  const evaluated = evaluateCheckoutUpdateResponse(
    FIXTURES.sourcePayPalUpdateNoTotal.httpStatus,
    FIXTURES.sourcePayPalUpdateNoTotal.body,
  );
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.deferred, true);
  assert.equal(evaluated.amount, null);
  assert.equal(evaluated.code, '');
  assert.match(evaluated.logReason, /HTTP 200/);
  assert.match(evaluated.logReason, /缺 checkout_session\.amount_total/);
  assert.match(evaluated.logReason, /total\.total/);
  assert.match(evaluated.logReason, /有 success, checkout_session\.status/);
  assert.equal(recoverableExtractError({
    code: 'CHECKOUT_PROMOTION',
    message: 'checkout/update 没有返回明确金额，无法确认 0 元优惠',
    recoverable: false,
  }), false);
});

test('GCash payable amount ignores catalog taxInclusive=0 when amount_total is missing', () => {
  const body = {
    success: true,
    checkout_session: {
      status: 'open',
      currency: 'php',
      checkout_state: {
        total: {
          total: { amount: 110000, currency: 'PHP' },
          taxInclusive: { minorUnitsAmount: 0, amount: '₱0.00' },
        },
      },
    },
  };
  const evaluated = evaluateCheckoutUpdateResponse(200, body, '', { currency: 'PHP', payableOnly: true });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.deferred, true);
  assert.equal(evaluated.amount, null);
  assert.notEqual(evaluated.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  const payable = inspectCheckoutPayableAmount(body);
  assert.equal(payable.amount, null);
});

test('GCash payable amount ignores catalog checkout_state.total.total=110000 without amount_total', () => {
  const body = {
    success: true,
    checkout_session: {
      status: 'open',
      currency: 'php',
      checkout_state: {
        total: { total: { amount: 110000, currency: 'PHP' } },
      },
    },
  };
  const evaluated = evaluateCheckoutUpdateResponse(200, body, '', { currency: 'PHP', payableOnly: true });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.deferred, true);
  assert.equal(evaluated.amount, null);
  assert.notEqual(evaluated.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  assert.match(evaluated.logReason, /不把 lineItems\/catalog 当应付/);
  const payable = inspectCheckoutPayableAmount(body);
  assert.equal(payable.amount, null);
});

test('GCash payable amount treats live taxes catalog 110000 as free when due is 0', () => {
  const body = FIXTURES.phpLiveTaxesCatalog110000DueZero.body;
  const evaluated = evaluateCheckoutUpdateResponse(200, body, '', { currency: 'PHP', payableOnly: true });
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.deferred, false);
  assert.equal(evaluated.amount, 0);
  assert.equal(evaluated.source, 'checkout_session.checkout_state.total.due');
  assert.equal(evaluated.formatted, '0.00 PHP');
  assert.notEqual(evaluated.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  assert.match(evaluated.logReason, /amount_total=110000/);
  assert.match(evaluated.logReason, /due=0/);
  const payable = inspectCheckoutPayableAmount(body);
  assert.equal(payable.amount, 0);
  assert.equal(payable.source, 'checkout_session.checkout_state.total.due');
  const numbers = checkoutStateTotalNumbers(body);
  assert.equal(numbers.amountTotal, 110000);
  assert.equal(numbers.total, 110000);
  assert.equal(numbers.due, 0);
  assert.equal(numbers.taxInclusive, 0);
});

test('GCash payable amount treats amount_total=110000 as catalog when total.total is 0', () => {
  const evaluated = evaluateCheckoutUpdateResponse(
    200,
    FIXTURES.phpLiveTaxesAmountTotal110000TotalZero.body,
    '',
    { currency: 'PHP', payableOnly: true },
  );
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.deferred, false);
  assert.equal(evaluated.amount, 0);
  assert.equal(evaluated.source, 'checkout_session.checkout_state.total.total');
  assert.notEqual(evaluated.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  const payable = inspectCheckoutPayableAmount(FIXTURES.phpLiveTaxesAmountTotal110000TotalZero.body);
  assert.equal(payable.amount, 0);
  assert.equal(payable.source, 'checkout_session.checkout_state.total.total');
});

test('GCash payable amount still fails when due is actually 110000', () => {
  const evaluated = evaluateCheckoutUpdateResponse(
    200,
    FIXTURES.phpLiveTaxesDue110000.body,
    '',
    { currency: 'PHP', payableOnly: true },
  );
  assert.equal(evaluated.ok, false);
  assert.equal(evaluated.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  assert.equal(evaluated.amount, 110000);
  assert.equal(evaluated.source, 'checkout_session.checkout_state.total.due');
  assert.equal(evaluated.formatted, '1100.00 PHP');
  assert.match(evaluated.logReason, /due=110000/);
  const payable = inspectCheckoutPayableAmount(FIXTURES.phpLiveTaxesDue110000.body);
  assert.equal(payable.amount, 110000);
  assert.equal(payable.source, 'checkout_session.checkout_state.total.due');
});

test('GCash payable amount accepts checkout_state.total.total=0 without amount_total', () => {
  const evaluated = evaluateCheckoutUpdateResponse(
    200,
    FIXTURES.phpCheckoutStateTotalZeroNoAmountTotal.body,
    '',
    { currency: 'PHP', payableOnly: true },
  );
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.deferred, false);
  assert.equal(evaluated.amount, 0);
  assert.equal(evaluated.source, 'checkout_session.checkout_state.total.total');
  assert.equal(evaluated.formatted, '0.00 PHP');
  assert.match(evaluated.logReason, /checkout_state\.total\.total=0/);
  assert.match(evaluated.logReason, /due=无/);
  const payable = inspectCheckoutPayableAmount(FIXTURES.phpCheckoutStateTotalZeroNoAmountTotal.body);
  assert.equal(payable.amount, 0);
  assert.equal(payable.source, 'checkout_session.checkout_state.total.total');
  const numbers = checkoutStateTotalNumbers(FIXTURES.phpCheckoutStateTotalZeroNoAmountTotal.body);
  assert.equal(numbers.total, 0);
  assert.equal(numbers.due, null);
});

test('GCash payable amount ignores lineItems 98214 unless amount_total is present', () => {
  const zero = evaluateCheckoutUpdateResponse(
    200,
    FIXTURES.phpLineItems98214AmountTotalZero.body,
    '',
    { currency: 'PHP', payableOnly: true },
  );
  assert.equal(zero.ok, true);
  assert.equal(zero.deferred, false);
  assert.equal(zero.amount, 0);
  assert.equal(zero.source, 'checkout_session.amount_total');
  assert.equal(zero.formatted, '0.00 PHP');

  const payable = inspectCheckoutPayableAmount(FIXTURES.phpLineItems98214AmountTotalZero.body);
  assert.equal(payable.amount, 0);
  assert.equal(payable.source, 'checkout_session.amount_total');

  const legacy = inspectCheckoutAmount(FIXTURES.phpLineItems98214NoAmountTotal.body);
  assert.equal(legacy.amount, 98214);
  assert.equal(legacy.source, 'lineItems');

  const missing = evaluateCheckoutUpdateResponse(
    200,
    FIXTURES.phpLineItems98214NoAmountTotal.body,
    '',
    { currency: 'PHP', payableOnly: true },
  );
  assert.equal(missing.ok, true);
  assert.equal(missing.deferred, true);
  assert.equal(missing.amount, null);
  assert.equal(missing.code, '');
  assert.notEqual(missing.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  assert.match(missing.logReason, /缺 checkout_session\.amount_total/);
  assert.match(missing.logReason, /不把 lineItems\/catalog 当应付/);
  assert.doesNotMatch(missing.logReason, /金额 98214 非 0/);
});

test('checkout/update prefers checkout_session.amount_total over catalog total', () => {
  const inspected = inspectCheckoutAmount(FIXTURES.phpAmountTotalZeroCatalog110000.body);
  assert.equal(inspected.amount, 0);
  assert.equal(inspected.source, 'checkout_session.amount_total');
  assert.equal(inspected.currency, 'PHP');
  const zero = evaluateCheckoutUpdateResponse(200, FIXTURES.phpAmountTotalZeroCatalog110000.body, '', { currency: 'PHP' });
  assert.equal(zero.ok, true);
  assert.equal(zero.amount, 0);
  assert.equal(zero.source, 'checkout_session.amount_total');
  assert.equal(zero.formatted, '0.00 PHP');
  assert.match(zero.logReason, /source=checkout_session\.amount_total/);
  assert.doesNotMatch(zero.logReason, /\bGBP\b/);

  const paid = evaluateCheckoutUpdateResponse(200, FIXTURES.phpAmountTotal110000.body, '', { currency: 'PHP' });
  assert.equal(paid.ok, false);
  assert.equal(paid.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  assert.equal(paid.amount, 110000);
  assert.equal(paid.source, 'checkout_session.amount_total');
  assert.equal(paid.formatted, '1100.00 PHP');
  assert.match(paid.message, /1100\.00 PHP/);
  assert.doesNotMatch(paid.message, /\bGBP\b/);
});

test('checkout/update nonzero amount does not rebuild paypal checkout', () => {
  const evaluated = evaluateCheckoutUpdateResponse(200, FIXTURES.nonzeroShouldReject.body);
  assert.equal(evaluated.ok, false);
  assert.equal(evaluated.code, 'PAYMENT_AMOUNT_NOT_ZERO');
  assert.equal(evaluated.recoverable, false);
  assert.equal(recoverableExtractError({
    code: evaluated.code,
    message: evaluated.message,
    recoverable: evaluated.recoverable,
  }), false);
});

test('checkout/update logs HTTP status without dumping payload', () => {
  const evaluated = evaluateCheckoutUpdateResponse(200, FIXTURES.sourcePayPalUpdateNoTotal.body);
  assert.doesNotMatch(evaluated.logReason, /pk_live|cs_live|ba_token|eyJ/);
  assert.ok(evaluated.logReason.length < 400);
});

test('checkout/approve matches sanitized source session headers and rebuilds after blocked', () => {
  const {
    classifyApproveResult,
    redactCheckoutId,
    recoverableExtractError,
    chatgptCheckoutHeaders,
    chatgptHeaders,
    stripeInitBody,
    stripeCustomTaxRegionBody,
    applyCustomTaxRegionAmount,
    extractRedirectToUrl,
    findSubmissionAttempt,
  } = require('../src/utils/paymentLink');
  const blocked = classifyApproveResult({ result: 'blocked' }, 200);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryable, true);
  assert.equal(blocked.rebuild, true);
  assert.equal(blocked.code, 'CHECKOUT_APPROVE_BLOCKED');
  assert.match(blocked.message, /unexpected result: 'blocked'/);
  assert.equal(recoverableExtractError({
    code: 'CHECKOUT_APPROVE_BLOCKED',
    message: `ChatGPT approve 连续 5 次失败，当前 checkout 已作废: ${blocked.message}`,
    recoverable: true,
  }), true);
  assert.equal(classifyApproveResult({ result: 'approved' }, 200).ok, true);
  assert.equal(classifyApproveResult({ result: 'expired' }, 200).retryable, true);
  assert.equal(classifyApproveResult({ result: 'expired' }, 200).rebuild, false);
  assert.equal(classifyApproveResult({ result: 'invalid_promotion' }, 200).rebuild, true);
  const http500 = classifyApproveResult({}, 500);
  assert.equal(http500.ok, false);
  assert.equal(http500.rebuild, true);
  assert.equal(http500.retryable, false);
  assert.equal(http500.code, 'CHECKOUT_APPROVE_HTTP');
  assert.equal(http500.message, 'checkout/approve HTTP 500');
  assert.equal(classifyApproveResult({}, 502).rebuild, true);
  assert.equal(classifyApproveResult({}, 502).retryable, false);
  assert.equal(classifyApproveResult({}, 503).rebuild, true);
  assert.equal(classifyApproveResult({}, 504).rebuild, true);
  assert.equal(classifyApproveResult({}, 403).retryable, true);
  assert.equal(classifyApproveResult({}, 403).rebuild, false);
  assert.equal(classifyApproveResult({}, 429).retryable, true);
  assert.equal(classifyApproveResult({}, 429).rebuild, false);
  assert.equal(classifyApproveResult({}, 409).retryable, false);
  assert.equal(classifyApproveResult({}, 409).rebuild, false);
  assert.equal(redactCheckoutId('cs_live_SUPERSECRETVALUE'), 'cs_live_…');
  const headers = chatgptCheckoutHeaders({
    cs_id: 'cs_live_SUPERSECRETVALUE',
    billing_country: 'GB',
    processor_entity: 'openai_ie',
    chatgpt_account_id: 'acct-1',
  }, '/backend-api/payments/checkout/approve');
  assert.equal(headers['ChatGPT-Account-ID'], undefined);
  assert.match(headers.Referer, /openai_ie\/cs_live_SUPERSECRETVALUE$/);
  assert.equal(headers['x-openai-target-path'], '/backend-api/payments/checkout/approve');
  assert.equal(headers['x-openai-target-route'], '/backend-api/payments/checkout/approve');
  const sessionHeaders = chatgptHeaders({
    accessToken: 'token',
    deviceId: 'did-1',
    sessionId: 'sid-1',
    extra: { Referer: headers.Referer },
  });
  assert.equal(sessionHeaders['oai-session-id'], 'sid-1');
  assert.equal(sessionHeaders['oai-device-id'], 'did-1');
  assert.equal(sessionHeaders['oai-language'], 'en-GB');
  assert.equal(sessionHeaders['oai-client-version'], 'prod-46437587156517d920436051cb9ab60a95f0503a');
  assert.equal(sessionHeaders['oai-client-build-number'], '7904904');
  assert.equal(sessionHeaders.Origin, 'https://chatgpt.com');
  assert.equal(sessionHeaders['ChatGPT-Account-ID'], undefined);
  const fingerprint = require('../src/utils/extractHttp').chromeFingerprintFor('chrome136');
  const aligned = chatgptHeaders({
    accessToken: 'token',
    deviceId: 'did-1',
    sessionId: 'sid-1',
    fingerprint,
    extra: { Referer: headers.Referer },
  });
  assert.equal(aligned['User-Agent'], fingerprint.userAgent);
  assert.equal(aligned['sec-ch-ua'], '"Google Chrome";v="136", "Chromium";v="136", "Not_A Brand";v="99"');
  assert.equal(aligned['sec-ch-ua-mobile'], '?0');
  assert.equal(aligned['sec-ch-ua-platform'], '"Windows"');
  assert.equal(aligned['sec-ch-ua-full-version-list'], undefined);
  assert.match(aligned['User-Agent'], /Chrome\/136\.0\.0\.0/);
  const init = stripeInitBody({ stripePk: 'pk_test', stripeJsId: 'js-1' });
  assert.equal(init['elements_options_client[saved_payment_method][enable_save]'], 'auto');
  assert.equal(init['elements_options_client[saved_payment_method][enable_redisplay]'], 'auto');
  const tax = stripeCustomTaxRegionBody({
    elements_session_id: 'elements_session_abc',
    stripe_js_id: 'js-1',
    locale: 'en',
  }, { country: 'GB', line1: '10 Downing Street', city: 'London', postal_code: 'SW1A 1AA', state: 'England' }, 'pk_test');
  assert.equal(tax.eid, undefined);
  assert.equal(tax['tax_region[country]'], 'GB');
  assert.equal(tax['elements_session_client[session_id]'], 'elements_session_abc');
  const ctx = { checkout_amount: '0' };
  applyCustomTaxRegionAmount(ctx, { total_summary: { total: 0, due: 0 } });
  assert.equal(ctx.checkout_amount, '0');
  const confirmWithRedirect = {
    next_action: { type: 'redirect_to_url', redirect_to_url: { url: 'https://www.paypal.com/agreements/approve?ba_token=BA-1' } },
    submission_attempt: { state: 'requires_approval' },
  };
  assert.equal(extractRedirectToUrl(confirmWithRedirect), 'https://www.paypal.com/agreements/approve?ba_token=BA-1');
  assert.equal(findSubmissionAttempt({ submission_attempt: { state: 'requires_approval' } }).state, 'requires_approval');
});

test('GCash confirm success only accepts Mode8 success-equivalent status', () => {
  assert.equal(gcashConfirmStatus({ status: 'blocked' }), 'blocked');
  assert.equal(isGcashConfirmSuccess({ status: 'success' }), true);
  assert.equal(isGcashConfirmSuccess({ status: 'ok' }), true);
  assert.equal(isGcashConfirmSuccess({ status: 'blocked' }), false);
  assert.equal(isGcashConfirmSuccess({}), false);
  assert.equal(isGcashConfirmRejected({ status: 'blocked' }), true);
  assert.match(describeGcashConfirm({ status: 'blocked' }, 200), /HTTP 200 status=blocked/);
  assert.match(describeGcashConfirm({ status: 'blocked', reason: 'risk_hold' }, 200), /hint=risk_hold/);
  assert.equal(recoverableExtractError({ code: 'GCASH_CONFIRM_BLOCKED', recoverable: true }), true);
  assert.equal(recoverableExtractError({
    message: 'SSLError: Failed to perform, curl: (35) BoringSSL SSL_connect: Connection closed abruptly',
  }), true);
});

test('GCash PH billing matches r19 Manila / Metro Manila / 1000', () => {
  const billing = phBilling();
  assert.equal(billing.country, 'PH');
  assert.equal(billing.city, 'Manila');
  assert.equal(billing.state, 'Metro Manila');
  assert.equal(billing.postal_code, '1000');
  assert.equal(PH_BILLING_PROFILE.postalCode, '1000');
  assert.match(billing.phone, /^\+63 /);
  assert.match(billing.line1, /^\d+ \w+ /);
  assert.equal(billing.line2, '');
  assert.match(billing.email, /@(gmail\.com|outlook\.com|hotmail\.com|icloud\.com|proton\.me)$/);
});

test('GCash taxes body keeps Mode8 address state and line2', () => {
  const body = taxesBody(
    { cs_id: 'oaics_tax', processor_entity: 'openai_ie', billing_country: 'PH', currency: 'PHP' },
    {
      email: 'buyer@example.test',
      name: 'Juan Dela Cruz',
      country: 'PH',
      line1: 'Ayala Avenue 100',
      line2: 'Unit 2',
      city: 'Makati',
      state: 'NCR',
      postal_code: '1226',
    },
  );
  assert.equal(body.billing_country, 'PH');
  assert.equal(body.billing_address.country, 'PH');
  assert.equal(body.billing_address.line2, 'Unit 2');
  assert.equal(body.billing_address.state, 'NCR');
  assert.equal(body.tax_id, null);
});
