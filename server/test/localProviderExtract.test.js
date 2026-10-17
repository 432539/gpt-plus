'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHANNEL_SPECS,
  channelSpec,
  impersonateForChannel,
  checkoutBodyForChannel,
  updateCountryForChannel,
  skipCheckoutUpdateForChannel,
  localPaymentMethodBody,
  localConfirmBody,
  generateBrazilCpf,
  extractUpiRedirectUrl,
  extractPixRedirectUrl,
  extractIdealRedirectUrl,
  extractBlikRedirectUrl,
  isAdyenGcashRedirect,
  extractLocalProvider,
} = require('../src/utils/localProviderExtract');
const { CAMPAIGN_ID, checkoutCreateBody, gcashConfirmBody, gcashStartBody, GCASH_FAILURE_ATTEMPTS } = require('../src/utils/paymentLink');
const { EXTRACT_BROWSER, EXTRACT_SAFARI_IMPERSONATE } = require('../src/utils/extractHttp');
const { CHECK_PATH, CHECKOUT_PATH } = require('../src/utils/paypalExtract');
const { FIXTURE_JPEG } = require('../src/utils/gcashH5Screenshot');

const PK = 'pk_test_fixture';
const ACCOUNT_ID = 'acct_local_extract';

function fixtureToken() {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID },
    email: 'local@example.test',
  })).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.x`;
}

function header(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value);
  }
  return '';
}

function jsonResponse(data, { status = 200, url = '' } = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify(data),
    url,
  };
}

function pathname(url) {
  return new URL(url, 'https://chatgpt.com').pathname.replace(/\/+$/, '') || '/';
}

function parseForm(body) {
  const text = String(body || '');
  const out = {};
  for (const part of text.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
    const value = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : '');
    out[key] = value;
  }
  return out;
}

function parseJson(body) {
  try {
    return JSON.parse(String(body || '{}'));
  } catch {
    return {};
  }
}

test('channel specs lock country, currency, update hop, bank and Safari', () => {
  assert.equal(channelSpec('upi').country, 'IN');
  assert.equal(channelSpec('upi').currency, 'INR');
  assert.equal(updateCountryForChannel('upi'), 'VN');
  assert.equal(channelSpec('pix').country, 'BR');
  assert.equal(channelSpec('pix').currency, 'BRL');
  assert.equal(updateCountryForChannel('pix'), 'VN');
  assert.equal(channelSpec('ideal').country, 'NL');
  assert.equal(channelSpec('ideal').currency, 'EUR');
  assert.equal(channelSpec('ideal').bank, 'ing');
  assert.equal(impersonateForChannel('ideal'), EXTRACT_SAFARI_IMPERSONATE);
  assert.equal(updateCountryForChannel('ideal'), 'VN');
  assert.equal(channelSpec('twint').country, 'CH');
  assert.equal(channelSpec('blik').country, 'PL');
  assert.equal(channelSpec('kakao_pay').country, 'KR');
  assert.equal(channelSpec('naver_pay').currency, 'KRW');
  assert.equal(channelSpec('gcash').country, 'PH');
  assert.equal(channelSpec('gcash').flow, 'adyen');
  assert.equal(channelSpec('gcash').skipCheckoutUpdate, false);
  assert.equal(impersonateForChannel('gcash'), EXTRACT_BROWSER);
  assert.equal(impersonateForChannel('gcash'), 'chrome136');
  assert.equal(skipCheckoutUpdateForChannel('gcash'), false);
  assert.equal(updateCountryForChannel('gcash'), 'PH');
  assert.equal(skipCheckoutUpdateForChannel('upi'), false);
  assert.equal(Object.keys(CHANNEL_SPECS).includes('paypal_uk'), false);
});

test('checkout and payment-method bodies keep campaign plus country/currency', () => {
  const upiCheckout = checkoutBodyForChannel('upi');
  assert.equal(upiCheckout.billing_details.country, 'IN');
  assert.equal(upiCheckout.billing_details.currency, 'INR');
  assert.equal(upiCheckout.promo_campaign.promo_campaign_id, CAMPAIGN_ID);
  const gcashCheckout = checkoutBodyForChannel('gcash');
  assert.equal(gcashCheckout.billing_details.country, 'PH');
  assert.equal(gcashCheckout.billing_details.currency, 'PHP');
  assert.equal(gcashCheckout.promo_campaign, undefined);
  const pixPm = localPaymentMethodBody(
    channelSpec('pix'),
    { cs_id: 'cs_live_fixture' },
    PK,
    { name: 'Joao', email: 'a@b.c', country: 'BR', line1: 'x', city: 'Sao Paulo', postal_code: '01310-100', state: 'SP', tax_id: '390.533.447-05' },
    { stripe_js_id: 'js', elements_session_id: 'el', elements_session_config_id: 'cfg', guid: 'g', muid: 'm', sid: 's' },
  );
  assert.equal(pixPm.type, 'pix');
  assert.equal(pixPm['billing_details[tax_id]'], '390.533.447-05');
  const idealPm = localPaymentMethodBody(
    channelSpec('ideal'),
    { cs_id: 'cs_live_fixture' },
    PK,
    { name: 'Jan', email: 'a@b.c', country: 'NL', line1: 'Damrak 88', city: 'Amsterdam', postal_code: '1012 LP', state: 'NH' },
    { stripe_js_id: 'js', elements_session_id: 'el', elements_session_config_id: 'cfg' },
  );
  assert.equal(idealPm.type, 'ideal');
  assert.equal(idealPm['ideal[bank]'], 'ing');
  const confirm = localConfirmBody(
    channelSpec('upi'),
    { cs_id: 'cs_live_fixture' },
    PK,
    { total_summary: { due: 0 } },
    { stripe_js_id: 'js', elements_session_id: 'el', elements_session_config_id: 'cfg', checkout_amount: '0' },
    'pm_fixture',
    'https://checkout.stripe.com/c/pay/cs_live_fixture',
  );
  assert.equal(confirm.expected_payment_method_type, 'upi');
  assert.equal(confirm.payment_method, 'pm_fixture');
  const cpf = generateBrazilCpf();
  assert.match(cpf, /^\d{3}\.\d{3}\.\d{3}-\d{2}$/);
});

test('redirect extractors match reference UPI / PIX / iDEAL / BLIK / GCash hosts', () => {
  assert.equal(
    extractUpiRedirectUrl({
      next_action: {
        upi_handle_redirect_or_display_qr_code: {
          hosted_instructions_url: 'https://hooks.stripe.com/upi/hosted',
        },
      },
    }),
    'https://hooks.stripe.com/upi/hosted',
  );
  assert.equal(
    extractPixRedirectUrl({
      next_action: { pix_display_qr_code: { hosted_instructions_url: 'https://hooks.stripe.com/pix/qr' } },
    }),
    'https://hooks.stripe.com/pix/qr',
  );
  assert.equal(
    extractIdealRedirectUrl({
      next_action: { type: 'redirect_to_url', redirect_to_url: { url: 'https://ideal.ing.nl/pay' } },
    }),
    'https://ideal.ing.nl/pay',
  );
  const blik = extractBlikRedirectUrl({ next_action: { type: 'blik_authorize' } });
  assert.equal(blik.inApp, true);
  assert.equal(isAdyenGcashRedirect('https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=x'), true);
});

function createLocalFixture(channelId, extra = {}) {
  const spec = channelSpec(channelId);
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const path = pathname(url);
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { host = ''; }
    const headers = opts.headers || {};
    const raw = String(opts.body || '');
    const parsedJson = raw.startsWith('{') || raw.startsWith('[') ? parseJson(raw) : {};
    const parsedForm = raw && !raw.startsWith('{') ? parseForm(raw) : {};
    calls.push({
      url: String(url),
      method,
      path,
      headers,
      body: Object.keys(parsedJson).length ? parsedJson : parsedForm,
      form: parsedForm,
      impersonateHint: header(headers, 'user-agent'),
    });
    if (method === 'GET' && (path === '/' || path === '')) {
      return {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'cf_clearance=gcash-home; Path=/; Domain=chatgpt.com; Secure',
        },
        text: '<html><body>chatgpt prod-46437587156517d920436051cb9ab60a95f0503a</body></html>',
        url: String(url),
      };
    }
    if (path === '/backend-api/sentinel/ping') {
      return jsonResponse({ ok: true });
    }
    if (path === '/cdn-cgi/trace') {
      const country = header(headers, 'x-gpt-plus-proxy-country-check') || spec.country;
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: `fl=fixture\nip=203.0.113.8\nloc=${country}\n`,
        url: String(url),
      };
    }
    if (method === 'GET' && /\/checkout\/[^/]+\/oaics_/.test(path)) {
      extra.checkoutPageGets = Number(extra.checkoutPageGets || 0) + 1;
      return {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'oai-sc=gcash-page; Path=/; Domain=chatgpt.com; Secure',
        },
        text: extra.checkoutPageHtml || '<html><body>checkout</body></html>',
        url: String(url),
      };
    }
    if (path === '/backend-api/me' && method === 'GET') {
      extra.meGets = Number(extra.meGets || 0) + 1;
      return jsonResponse({
        id: ACCOUNT_ID,
        email: 'local@example.test',
      });
    }
    if (path === CHECK_PATH && method === 'GET') {
      return jsonResponse(extra.checkPayload || {
        accounts: {
          [ACCOUNT_ID]: { eligible_promo_campaigns: { plus: { id: 'plus-1-month-free' } } },
          default: { eligible_promo_campaigns: { plus: { id: 'plus-1-month-free' } } },
        },
      }, { status: extra.checkStatus || 200 });
    }
    if (path === CHECKOUT_PATH && method === 'POST') {
      extra.checkoutPosts = Number(extra.checkoutPosts || 0) + 1;
      if (extra.unusualFirst && extra.checkoutPosts === 1) {
        return jsonResponse({ detail: 'Your request was flagged as unusual activity.' }, { status: 403 });
      }
      const defaultCsId = spec.id === 'gcash' ? 'oaics_gcash_local' : 'cs_live_local';
      const payload = {
        checkout_session_id: extra.csId || defaultCsId,
        stripe_publishable_key: PK,
        processor_entity: spec.id === 'gcash' ? 'openai_llc' : 'openai_ie',
        payment_method_types: [spec.method, 'card'],
        custom_payment_methods: extra.customMethods || (spec.flow === 'adyen' ? [{ id: 'cpmt_gcash_fixture' }] : []),
      };
      if (spec.id === 'gcash') {
        if (extra.createBody && typeof extra.createBody === 'object') {
          Object.assign(payload, extra.createBody);
        } else if (extra.omitCreateAmount !== true) {
          payload.checkout_session = extra.checkoutSession || {
            amount_total: extra.amountTotal === undefined ? 0 : extra.amountTotal,
            currency: 'php',
          };
        }
      }
      return jsonResponse(payload);
    }
    if (path === '/backend-api/payments/checkout/update') {
      extra.updateCalls = Number(extra.updateCalls || 0) + 1;
      if (typeof extra.updateFactory === 'function') {
        return jsonResponse(extra.updateFactory(extra.updateCalls));
      }
      return jsonResponse(extra.updateBody || {
        success: true,
        checkout_amount_minor: 0,
        total: { total: 0 },
      });
    }
    if (path === '/backend-api/payments/checkout/taxes') {
      return jsonResponse(extra.taxesBody || { ok: true });
    }
    if (path === '/backend-api/payments/checkout/snapshot') {
      return jsonResponse({ ok: true });
    }
    if (path === '/backend-api/payments/checkout/confirm') {
      extra.confirmCalls = Number(extra.confirmCalls || 0) + 1;
      if (typeof extra.confirmFactory === 'function') {
        return jsonResponse(extra.confirmFactory(extra.confirmCalls), {
          status: extra.confirmStatus || 200,
        });
      }
      return jsonResponse(extra.confirmBody || { status: 'success' });
    }
    if (path === '/backend-api/payments/checkout/custom_payment_method/start') {
      extra.startCalls = Number(extra.startCalls || 0) + 1;
      if (typeof extra.startFactory === 'function') {
        const built = extra.startFactory(extra.startCalls) || {};
        return jsonResponse(built.data || built, { status: built.status || 200 });
      }
      if (extra.startError) {
        return jsonResponse({ detail: extra.startError }, { status: extra.startStatus || 409 });
      }
      return jsonResponse({
        next_action: {
          paymentMethodType: 'gcash',
          url: extra.adyenUrl || 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture',
        },
      });
    }
    if (host.includes('mgs-gw.paas.mynt.xyz') || host.includes('mynt.xyz')) {
      if (extra.consultPayload) {
        return jsonResponse(extra.consultPayload);
      }
      if (extra.consultQr) {
        return jsonResponse({
          success: true,
          qrCode: extra.consultQr,
          uuid: extra.consultUuid || '1787490363225-6111-10.76.6.30-227477200',
          errorActions: [],
          extendInfo: {},
          traceId: 'fixture-trace',
        });
      }
      return jsonResponse({
        success: true,
        errorActions: [],
        extendInfo: {},
        traceId: 'fixture-trace',
      });
    }
    if (host.includes('adyen.com') || host.includes('gcash.com')) {
      if (extra.adyenNoQr) {
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          text: extra.adyenHtml || '<html><body><p>Adyen checkout</p></body></html>',
          url: String(url),
        };
      }
      const png = extra.adyenQr
        || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        text: extra.adyenHtml || `<html><body><img class="adyen-checkout__qr-code__image" alt="QR Code" src="${png}" /></body></html>`,
        url: String(url),
      };
    }
    if (path === '/backend-api/payments/checkout/approve') return jsonResponse({ result: 'approved' });
    if (path === '/v1/elements/sessions') {
      return jsonResponse({
        session_id: 'elements_session_fixture',
        config_id: 'cfg_fixture',
        payment_method_types: [spec.method, 'card'],
      });
    }
    if (path === '/v1/payment_methods') return jsonResponse({ id: 'pm_local_fixture' });
    if (path.endsWith('/init') && path.includes('/v1/payment_pages/')) {
      return jsonResponse({
        payment_method_types: [spec.method, 'card'],
        total_summary: { due: 0, total: 0 },
        stripe_hosted_url: 'https://checkout.stripe.com/c/pay/cs_live_local',
        stripe_publishable_key: PK,
      });
    }
    if (path.endsWith('/confirm') && path.includes('/v1/payment_pages/')) {
      if (spec.method === 'upi') {
        return jsonResponse({
          next_action: {
            upi_handle_redirect_or_display_qr_code: {
              hosted_instructions_url: extra.redirect || 'https://hooks.stripe.com/upi/hosted',
            },
          },
        });
      }
      if (spec.method === 'pix') {
        return jsonResponse({
          next_action: { pix_display_qr_code: { hosted_instructions_url: extra.redirect || 'https://hooks.stripe.com/pix/qr' } },
        });
      }
      if (spec.method === 'ideal') {
        return jsonResponse({
          next_action: { type: 'redirect_to_url', redirect_to_url: { url: extra.redirect || 'https://ideal.ing.nl/pay' } },
        });
      }
      return jsonResponse({
        next_action: { type: 'redirect_to_url', redirect_to_url: { url: extra.redirect || `https://pay.${spec.method}.example/pay` } },
      });
    }
    if (path.includes('/v1/payment_pages/')) return jsonResponse({ total_summary: { due: 0 } });
    if (String(url).includes('addressgen.top')) {
      return jsonResponse({
        data: {
          firstname: 'Local',
          lastname: 'Buyer',
          email: 'generated@example.test',
          tax_id: spec.country === 'BR' ? '390.533.447-05' : '',
          address: {
            country_code: spec.country,
            street: 'Main 1',
            city: 'City',
            state: 'ST',
            zipcode: '10000',
          },
        },
      });
    }
    return jsonResponse({ ok: true });
  };
  return { calls, fetchImpl };
}

test('UPI extract uses IN checkout, VN update hop, and does not return a PayPal flow', async () => {
  const { calls, fetchImpl } = createLocalFixture('upi');
  const result = await extractLocalProvider({
    channelId: 'upi',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-GB-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
  });
  assert.equal(result.flow, 'stripe');
  assert.match(result.link, /hooks\.stripe\.com/);
  const checkout = calls.find((item) => item.path === CHECKOUT_PATH);
  assert.equal(checkout.body.billing_details.country, 'IN');
  assert.equal(checkout.body.billing_details.currency, 'INR');
  assert.equal(checkout.body.promo_campaign.promo_campaign_id, 'plus-1-month-free');
  const traces = calls.filter((item) => item.path === '/cdn-cgi/trace').map((item) => header(item.headers, 'x-gpt-plus-proxy-country-check'));
  assert.ok(traces.includes('IN'));
  assert.ok(traces.includes('VN'));
  const pm = calls.find((item) => item.path === '/v1/payment_methods');
  assert.equal(pm.form.type || pm.body.type, 'upi');
});

test('iDEAL extract pins Safari 17 and ING, never Chrome Client Hints', async () => {
  const { calls, fetchImpl } = createLocalFixture('ideal');
  const result = await extractLocalProvider({
    channelId: 'ideal',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-GB-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
  });
  assert.match(result.link, /ing\.nl/);
  const safariCalls = calls.filter((item) => /Version\/17\.0 Safari/.test(item.impersonateHint));
  assert.ok(safariCalls.length > 0);
  assert.equal(safariCalls.some((item) => header(item.headers, 'sec-ch-ua')), false);
  const checkout = calls.find((item) => item.path === CHECKOUT_PATH);
  assert.equal(checkout.body.billing_details.country, 'NL');
  assert.equal(checkout.body.billing_details.currency, 'EUR');
  const pm = calls.find((item) => item.path === '/v1/payment_methods');
  assert.equal(pm.form.type || pm.body.type, 'ideal');
  assert.equal(pm.form['ideal[bank]'] || pm.body['ideal[bank]'], 'ing');
});

test('GCash paywall link writes back H5 merchants-auth landing, not Adyen start URL', async () => {
  const landing = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5';
  const domQr = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const protocolQr = 'data:image/png;base64,cHJvdG9jb2wtcXItZml4dHVyZQ==';
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    consultQr: protocolQr,
    consultUuid: 'consult-uuid-fixture',
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    screenshotImpl: async () => ({ qr: domQr, finalUrl: landing }),
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  const start = calls.find((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start');
  assert.ok(start);
  assert.equal(start.body.custom_payment_method_type_id, 'cpmt_gcash_fixture');
  assert.match(result.link, /m\.gcash\.com\/gcashapp\/gcash-merchants-auth\/index\.html/);
  assert.equal(/adyen\.com/i.test(result.link), false);
  assert.equal(result.protocol.ready, true);
  assert.equal(result.protocol.browserVersion, '136');
  assert.equal(result.protocol.consultUuid, 'consult-uuid-fixture');
  assert.equal(result.qr, protocolQr);
  assert.equal(result.qr_source, 'protocol-consult');
  assert.ok(logs.some((line) => /纯协议二维码已生成：has_uuid=true/.test(line)));
  assert.ok(logs.some((line) => /支付墙改存落地链/.test(line)));
  assert.equal(logs.some((line) => /redirectData=|netAuthId=|signature=|gpid=/.test(line)), false);
});

test('GCash extract uses Adyen start, not Stripe payment_methods', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash');
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-GB-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.match(result.link, /adyen\.com/);
  assert.equal(result.qr, FIXTURE_JPEG);
  assert.equal(result.qr_source, 'playwright-fixture');
  assert.equal(calls.some((item) => item.path === '/v1/payment_methods'), false);
  assert.equal(calls.some((item) => item.path === CHECK_PATH && item.method === 'GET'), true);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/update'), true);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/snapshot'), true);
  assert.equal(logs.some((line) => /零元校验通过 amount=0/.test(line)), true);
  const start = calls.find((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start');
  assert.ok(start);
  assert.equal(start.body.custom_payment_method_type_id, 'cpmt_gcash_fixture');
  const checkoutPosts = calls.filter((item) => item.path === CHECKOUT_PATH && item.method === 'POST');
  assert.equal(checkoutPosts.length, 1);
  assert.ok(checkoutPosts.every((item) => item.body.billing_details.country === 'PH'));
  assert.ok(checkoutPosts.every((item) => item.body.billing_details.currency === 'PHP'));
  assert.ok(checkoutPosts.every((item) => item.body.promo_campaign == null));
  assert.ok(checkoutPosts.every((item) => item.body.checkout_ui_mode === 'custom'));
  assert.ok(checkoutPosts.every((item) => item.body.entry_point === 'all_plans_pricing_modal'));
  assert.ok(checkoutPosts.every((item) => header(item.headers, 'oai-language') === 'fil-PH'));
  assert.ok(checkoutPosts.every((item) => header(item.headers, 'accept-language').startsWith('fil-PH')));
  assert.equal(calls.some((item) => item.method === 'GET' && /\/checkout\//.test(item.path)), false);
  const traces = calls.filter((item) => item.path === '/cdn-cgi/trace')
    .map((item) => header(item.headers, 'x-gpt-plus-proxy-country-check'));
  assert.ok(traces.includes('PH'));
  assert.equal(traces.includes('JP'), false);
  assert.ok(logs.some((line) => /正在创建 gcash checkout/.test(line)));
  assert.equal(logs.some((line) => /复用资格 checkout/.test(line)), false);
  assert.equal(logs.some((line) => /GB 代理检查试用资格/.test(line)), false);
  assert.equal(logs.some((line) => /\bJP\b/.test(line)), false);
  const confirm = calls.find((item) => item.path === '/backend-api/payments/checkout/confirm');
  const taxesCalls = calls.filter((item) => item.path === '/backend-api/payments/checkout/taxes');
  const update = calls.find((item) => item.path === '/backend-api/payments/checkout/update');
  const accountsCheck = calls.find((item) => item.path === CHECK_PATH && item.method === 'GET');
  assert.equal(taxesCalls.length, 1);
  assert.equal(header(confirm.headers, 'oai-language'), 'fil-PH');
  assert.equal(header(taxesCalls[0].headers, 'oai-language'), 'fil-PH');
  assert.equal(header(start.headers, 'oai-language'), 'fil-PH');
  assert.equal(header(confirm.headers, 'accept-language').startsWith('fil-PH'), true);
  assert.equal(header(start.headers, 'accept-language').startsWith('fil-PH'), true);
  assert.deepEqual(Object.keys(confirm.body).sort(), ['checkout_session_id', 'selected_payment_method_type']);
  assert.deepEqual(Object.keys(start.body).sort(), ['checkout_session_id', 'custom_payment_method_type_id']);
  assert.equal(update.body.promo_campaign.promo_campaign_id, CAMPAIGN_ID);
  assert.equal(update.body.promo_campaign.is_coupon_from_query_param, false);
  assert.equal(taxesCalls[0].body.processor_entity, 'openai_llc');
  assert.equal(taxesCalls[0].body.billing_address.city, 'Manila');
  assert.equal(taxesCalls[0].body.billing_address.state, 'Metro Manila');
  assert.equal(taxesCalls[0].body.billing_address.postal_code, '1000');
  assert.equal(taxesCalls[0].body.billing_address.country, 'PH');
  assert.equal(calls.some((item) => /addressgen/i.test(item.url)), false);
  assert.match(header(confirm.headers, 'referer'), /\/checkout\/openai_llc\/oaics_/);
  assert.match(header(start.headers, 'referer'), /\/checkout\/openai_llc\/oaics_/);
  assert.equal(header(checkoutPosts[0].headers, 'referer').includes('promo_campaign='), false);
  assert.equal(header(confirm.headers, 'oai-client-build-number'), '7904904');
  assert.equal(header(start.headers, 'oai-client-build-number'), '7904904');
  assert.equal(header(checkoutPosts[0].headers, 'oai-client-build-number'), '7904904');
  assert.equal(header(checkoutPosts[0].headers, 'chatgpt-account-id'), '');
  assert.equal(header(taxesCalls[0].headers, 'chatgpt-account-id'), '');
  assert.equal(header(confirm.headers, 'chatgpt-account-id'), '');
  assert.equal(header(start.headers, 'chatgpt-account-id'), '');
  assert.equal(header(taxesCalls[0].headers, 'openai-sentinel-token'), '');
  assert.equal(header(confirm.headers, 'openai-sentinel-token'), '');
  assert.equal(header(start.headers, 'openai-sentinel-token'), '');
  assert.equal(header(confirm.headers, 'oai-telemetry'), '');
  assert.equal(header(start.headers, 'oai-telemetry'), '');
  assert.equal(
    calls.some((item) => /short\.dynamic\.link/.test(JSON.stringify(item.body || {}))),
    false,
  );
  assert.ok(accountsCheck);
  assert.equal(header(accountsCheck.headers, 'chatgpt-account-id'), ACCOUNT_ID);
  assert.match(header(confirm.headers, 'cookie'), /oai-did=/);
  assert.ok(logs.some((line) => /accounts\/check HTTP/.test(line)));
  assert.equal(logs.some((line) => /checkout 页 GET HTTP/.test(line)), false);
  assert.equal(logs.some((line) => /\/backend-api\/me HTTP/.test(line)), false);
  assert.equal(logs.some((line) => /ChatGPT 首页 GET HTTP/.test(line)), false);
  assert.equal(calls.some((item) => item.method === 'GET' && item.path === '/backend-api/me'), false);
  assert.equal(calls.some((item) => item.method === 'GET' && (item.path === '/' || item.path === '')), false);
  assert.ok(checkoutPosts.every((item) => header(item.headers, 'oai-client-version') === 'prod-46437587156517d920436051cb9ab60a95f0503a'));
  assert.equal(GCASH_FAILURE_ATTEMPTS, 10);
  const harCs = 'oaics_752449962cdc426c98928c16bed473a8';
  const harCpm = 'cpmt_1TOgstC6h1nxGoI3WUVEY2cJ';
  assert.equal(Buffer.byteLength(JSON.stringify(gcashConfirmBody(harCs, harCpm))), 127);
  assert.equal(Buffer.byteLength(JSON.stringify(gcashStartBody(harCs, harCpm))), 128);
  assert.equal(Buffer.byteLength(JSON.stringify(checkoutCreateBody({
    country: 'PH', currency: 'PHP', uiMode: 'custom', promoEnabled: true, promoQuery: false,
  }))), 245);
});

test('GCash create with catalog 110000 still passes when amount_total is 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    checkoutSession: {
      status: 'open',
      amount_total: 0,
      currency: 'php',
      checkout_state: { total: { total: { amount: 110000, currency: 'PHP' } } },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
  assert.equal(logs.some((line) => /\bGBP\b/.test(line)), false);
});

test('GCash create catalog 110000 without amount_total still taxes and can confirm 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    checkoutSession: {
      status: 'open',
      currency: 'php',
      checkout_state: { total: { total: { amount: 110000, currency: 'PHP' } } },
    },
    taxesBody: {
      checkout_session: {
        status: 'open',
        amount_total: 0,
        currency: 'php',
        checkout_state: { total: { total: { amount: 110000, currency: 'PHP' } } },
      },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/update'), true);
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/taxes').length, 1);
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.equal(logs.some((line) => /支付金额不是0元/.test(line)), false);
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
});

test('GCash taxes catalog 110000 still passes when due is 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    checkoutSession: {
      status: 'open',
      currency: 'php',
      checkout_state: {
        total: {
          total: { amount: 110000, currency: 'PHP' },
          taxInclusive: { minorUnitsAmount: 0, amount: '₱0.00' },
        },
      },
    },
    taxesBody: {
      success: true,
      checkout_session: {
        status: 'open',
        amount_total: 110000,
        currency: 'php',
        checkout_state: {
          total: {
            total: { amount: 110000, currency: 'PHP' },
            due: { amount: 0, currency: 'PHP' },
            taxInclusive: { minorUnitsAmount: 0, amount: '₱0.00' },
            discount: { amount: 110000, currency: 'PHP' },
          },
        },
      },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
  assert.equal(logs.some((line) => /PAYMENT_AMOUNT_NOT_ZERO|1100\.00 PHP/.test(line)), false);
});

test('GCash taxes still fail when due is actually 110000', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    omitCreateAmount: true,
    updateBody: {
      success: true,
      checkout_amount_minor: 0,
      total: { total: 0 },
    },
    taxesBody: {
      success: true,
      checkout_session: {
        status: 'open',
        amount_total: 110000,
        currency: 'php',
        checkout_state: {
          total: {
            total: { amount: 110000, currency: 'PHP' },
            due: { amount: 110000, currency: 'PHP' },
            taxInclusive: { minorUnitsAmount: 0, amount: '₱0.00' },
          },
        },
      },
    },
  });
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 1,
      log: () => {},
    }),
    (error) => error?.code === 'PAYMENT_AMOUNT_NOT_ZERO'
      && /1100\.00 PHP/.test(error.message)
      && !/\bGBP\b/.test(error.message),
  );
  assert.equal(calls.some((item) => item.path.includes('checkout/confirm')), false);
});

test('GCash with cpmt_ still stops when payable amount_total is not 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    amountTotal: 110000,
    updateBody: {
      success: true,
      checkout_session: {
        amount_total: 110000,
        currency: 'php',
        checkout_state: {
          total: {
            total: { amount: 110000, currency: 'PHP' },
            due: { amount: 110000, currency: 'PHP' },
          },
        },
      },
    },
  });
  const logs = [];
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 1,
      log: (message) => logs.push(String(message)),
    }),
    (error) => error?.code === 'PAYMENT_AMOUNT_NOT_ZERO'
      && /1100\.00 PHP/.test(error.message)
      && !/\bGBP\b/.test(error.message),
  );
  assert.equal(calls.some((item) => item.path.includes('checkout/confirm')), false);
  assert.equal(calls.some((item) => item.path.includes('custom_payment_method/start')), false);
});

test('GCash extract stays on PH sticky, applies checkout/update, and never hops JP', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', { csId: 'oaics_gcash_fresh' });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 2,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.cs_id, 'oaics_gcash_fresh');
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH && item.method === 'POST').length, 1);
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/update').length, 1);
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/taxes').length, 1);
  assert.ok(calls.some((item) => item.path === '/backend-api/payments/checkout/snapshot'));
  assert.ok(calls.some((item) => item.path === '/backend-api/payments/checkout/confirm'));
  assert.ok(calls.some((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start'));
  assert.equal(logs.some((line) => /\bJP\b/.test(line)), false);
  assert.equal(logs.some((line) => /更换/.test(line) && /sticky/.test(line)), false);
  assert.equal(result.qr, FIXTURE_JPEG);
});

test('GCash Adyen URL is extract success even without scraped QR', async () => {
  const { fetchImpl } = createLocalFixture('gcash', { adyenNoQr: true });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.match(result.link, /adyen\.com/);
  assert.equal(result.qr, FIXTURE_JPEG);
  assert.equal(logs.some((line) => /checkoutPaymentRedirect\?redirectData=/.test(line)), false);
});

test('GCash merchant-auth loader is not treated as a QR; Adyen/GCash URL still succeeds', async () => {
  const loader = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png';
  const { fetchImpl } = createLocalFixture('gcash', {
    adyenUrl: 'https://m.gcash.com/gcashapp/gcash-merchants-auth',
    adyenHtml: `<html><body><img class="gcash-qr" src="${loader}" /></body></html>`,
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.match(result.link, /m\.gcash\.com/);
  assert.equal(result.qr_source, 'playwright-fixture');
  assert.equal(logs.some((line) => /gcat_loader/.test(line)), false);
});

test('GCash eligibility without cpmt_ does not confirm, start, or rebuild', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', { customMethods: [] });
  const logs = [];
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 2,
      log: (message) => logs.push(String(message)),
    }),
    (error) => error?.code === 'ACCOUNT_NOT_ELIGIBLE',
  );
  assert.equal(calls.some((item) => item.path === CHECK_PATH && item.method === 'GET'), true);
  assert.equal(calls.some((item) => item.path.includes('checkout/update')), false);
  assert.equal(calls.some((item) => item.path.includes('checkout/taxes')), false);
  assert.equal(calls.some((item) => item.path.includes('checkout/confirm')), false);
  assert.equal(calls.some((item) => item.path.includes('custom_payment_method/start')), false);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH && item.method === 'POST').length, 1);
  assert.ok(logs.some((line) => /未返回 cpmt_/.test(line)));
  assert.equal(logs.some((line) => /GB 代理检查试用资格/.test(line)), false);
  assert.equal(logs.some((line) => /更换/.test(line) && /sticky/.test(line)), false);
  assert.equal(logs.some((line) => /通过 JP/.test(line)), false);
});

test('GCash protocol consult turns merchants-auth page into a real QR', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    adyenUrl: 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5',
    adyenHtml: '<html><body><img class="gcash-qr" src="https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png" /></body></html>',
    consultQr: '00020101021226580014com.gcash.www0111payload',
  });
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
  });
  assert.match(result.qr, /^data:image\/png;base64,/);
  assert.equal(result.protocol.ready, true);
  assert.ok(calls.some((item) => String(item.url).includes('mgs-gw.paas.mynt.xyz')));
  const rpc = calls.find((item) => String(item.url).includes('/mgw.htm'));
  assert.equal(rpc.body.operationType, 'ap.mobilewallet.gka.authorisation.stateless.consult');
  assert.equal(rpc.body.version, '2.0');
  assert.equal(rpc.body.workspaceId, 'PROD');
  assert.equal(rpc.body.appId, 'D54528A131559');
  assert.equal(rpc.body.tenantId, 'MYNTPH');
  const consultPayload = JSON.parse(rpc.body.requestData);
  assert.equal(consultPayload[0].channel, 'aggregator');
  assert.equal(consultPayload[0].bizType, 'ACQUIRING');
  assert.equal(consultPayload[0].envInfo.osType, 'WindowsNT');
  assert.equal(consultPayload[0].envInfo.terminalType, 'WEB');
  assert.ok(consultPayload[0].envInfo.tokenId);
  assert.equal(typeof consultPayload[0].urlParameters, 'string');
  assert.match(consultPayload[0].urlParameters, /terminalType=H5/);
  assert.equal(consultPayload[0].urlParameters.startsWith('?'), false);
  assert.equal(result.protocol.tokenId, consultPayload[0].envInfo.tokenId);
  assert.equal(result.protocol.consultUuid, '1787490363225-6111-10.76.6.30-227477200');
});

test('GCash consult GCSHLNKV short code is encoded as a displayable QR', async () => {
  const { fetchImpl } = createLocalFixture('gcash', {
    adyenUrl: 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5',
    adyenHtml: '<html><body><img class="gcash-qr" src="https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png" /></body></html>',
    consultQr: 'GCSHLNKVabcdefgh',
  });
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
  });
  assert.match(result.qr, /^data:image\/png;base64,/);
  assert.equal(result.qr_kind, 'gcshlnkv');
});

test('GCash consult short.dynamic.link is encoded as a displayable QR', async () => {
  const { fetchImpl } = createLocalFixture('gcash', {
    adyenUrl: 'https://m.gcash.com/gcashapp/gcash-merchants-auth/index.html?netAuthId=fixture-bind&clientId=fixture-client&scopes=AGREEMENT_PAY&terminalType=H5',
    adyenHtml: '<html><body><img class="gcash-qr" src="https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png" /></body></html>',
    consultPayload: {
      success: true,
      qrCode: 'GCSHLNKVabcdefgh',
      shortUrl: 'https://short.dynamic.link/GCSHLNKVabcdefgh',
      uuid: '1787490363225-6111-10.76.6.30-227477200',
      errorActions: [],
      extendInfo: {},
      traceId: 'fixture-trace',
    },
  });
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
  });
  assert.match(result.qr, /^data:image\/png;base64,/);
  assert.equal(result.qr_kind, 'short_url');
});

test('GCash update catalog 110000 still confirms when due is 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    amountTotal: 110000,
    updateBody: {
      success: true,
      checkout_session: {
        amount_total: 110000,
        currency: 'php',
        checkout_state: {
          total: {
            total: { amount: 110000, currency: 'PHP' },
            due: { amount: 0, currency: 'PHP' },
            discount: { amount: 110000, currency: 'PHP' },
          },
        },
      },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
  assert.equal(logs.some((line) => /PAYMENT_AMOUNT_NOT_ZERO/.test(line)), false);
});

test('GCash accounts/check 401 is eligibility check, not missing plus', async () => {
  const { fetchImpl } = createLocalFixture('gcash', {
    checkStatus: 401,
    checkPayload: { detail: 'Unauthorized' },
  });
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 1,
      log: () => {},
    }),
    (error) => error?.code === 'ACCOUNT_ELIGIBILITY_CHECK' && error?.status === 401,
  );
});

test('GCash accounts/check token_invalidated stops without rebuild', async () => {
  const { fetchImpl } = createLocalFixture('gcash', {
    checkStatus: 401,
    checkPayload: { detail: 'token_invalidated' },
  });
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 2,
      log: () => {},
    }),
    (error) => error?.code === 'ACCOUNT_TOKEN_INVALIDATED',
  );
});

test('GCash empty eligible_promo_campaigns skips extract unless debug', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    checkPayload: {
      accounts: {
        [ACCOUNT_ID]: { eligible_promo_campaigns: {} },
        default: { eligible_promo_campaigns: {} },
      },
    },
  });
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 1,
      log: () => {},
    }),
    (error) => error?.code === 'ACCOUNT_NOT_ELIGIBLE',
  );
  assert.equal(calls.some((item) => item.path === CHECKOUT_PATH && item.method === 'POST'), false);

  const debugCalls = [];
  const debugFixture = createLocalFixture('gcash', {
    checkPayload: {
      accounts: {
        [ACCOUNT_ID]: { eligible_promo_campaigns: {} },
        default: { eligible_promo_campaigns: {} },
      },
    },
  });
  debugCalls.push(debugFixture.calls);
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl: debugFixture.fetchImpl,
    maxCheckoutAttempts: 1,
    debug: true,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.ok(debugFixture.calls.some((item) => item.path === CHECKOUT_PATH && item.method === 'POST'));
  assert.ok(logs.some((line) => /DEBUG 继续：accounts\/check 未返回/.test(line)));
});

test('GCash lineItems 98214 still passes when amount_total is 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    checkoutSession: {
      status: 'open',
      amount_total: 0,
      currency: 'php',
      checkout_state: { total: { total: { amount: 98214, currency: 'PHP' } } },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
  assert.equal(logs.some((line) => /PAYMENT_AMOUNT_NOT_ZERO|982\.14/.test(line)), false);
});

test('GCash create with checkout_state.total.total=0 passes without amount_total', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    checkoutSession: {
      status: 'open',
      currency: 'php',
      checkout_state: {
        total: { total: { minorUnitsAmount: 0, amount: '₱0.00' } },
        lineItems: [{ total: { minorUnitsAmount: 98214, amount: '₱982.14' } }],
      },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
  assert.equal(logs.some((line) => /982\.14 PHP/.test(line)), false);
});

test('GCash taxes can confirm amount_total=0 when create has no payable field', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    omitCreateAmount: true,
    taxesBody: {
      checkout_session: {
        status: 'open',
        amount_total: 0,
        currency: 'php',
        checkout_state: { total: { total: { minorUnitsAmount: 0, amount: '₱0.00' } } },
      },
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/update'), true);
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/taxes').length, 1);
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
});

test('GCash still calls checkout/update after create even when amount_total is already 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash');
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/update').length, 1);
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/taxes').length, 1);
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
});

test('GCash does not false-kill when taxes only have lineItems 98214 if create already is 0', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    taxesBody: {
      checkout_session: { status: 'open', currency: 'php' },
      lineItems: [{ total: { amount: 98214, currency: 'PHP' } }],
    },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/update').length, 1);
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(logs.some((line) => /零元校验通过 amount=0/.test(line)));
});

test('GCash extract rejects cs_live_ checkout', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', { csId: 'cs_live_should_reject' });
  const logs = [];
  await assert.rejects(
    () => extractLocalProvider({
      channelId: 'gcash',
      detail: { access_token: fixtureToken(), email: 'local@example.test' },
      proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
      fetchImpl,
      maxCheckoutAttempts: 1,
      log: (message) => logs.push(String(message)),
    }),
    (error) => error?.code === 'GCASH_OAICS_REQUIRED' && /oaics_/.test(error.message),
  );
  assert.equal(calls.some((item) => item.path.includes('checkout/update')), false);
  assert.equal(calls.some((item) => item.path.includes('checkout/confirm')), false);
  assert.equal(calls.some((item) => item.path.includes('custom_payment_method/start')), false);
  assert.ok(logs.some((line) => /需要 oaics_/.test(line)));
});

test('GCash unusual_activity retries once with Sentinel then continues', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', { unusualFirst: true });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 2,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH && item.method === 'POST').length, 2);
  assert.ok(logs.some((line) => /unusual_activity/.test(line)));
});

function gcashExtractArgs(fetchImpl, logs) {
  return {
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  };
}

test('GCash confirm status=blocked still starts custom payment like the reference', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    confirmBody: { status: 'blocked' },
  });
  const logs = [];
  const result = await extractLocalProvider({
    ...gcashExtractArgs(fetchImpl, logs),
    stopAfterStart: true,
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(result.stopped_after_start, true);
  assert.match(result.link, /adyen\.com|m\.gcash\.com/);
  assert.equal(calls.some((item) => item.path === '/backend-api/payments/checkout/confirm'), true);
  const start = calls.filter((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start');
  assert.equal(start.length, 1);
  assert.ok(logs.some((line) => /confirm status=blocked，按参考仍 start/.test(line)));
  assert.ok(logs.some((line) => /正在启动 GCash custom payment method 流程/.test(line)));
});

test('GCash confirm HTTP 200 starts immediately even when status is not success', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    confirmBody: { status: 'success' },
  });
  const logs = [];
  const result = await extractLocalProvider(gcashExtractArgs(fetchImpl, logs));
  assert.equal(result.flow, 'adyen');
  const confirm = calls.filter((item) => item.path === '/backend-api/payments/checkout/confirm');
  const start = calls.filter((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start');
  assert.equal(confirm.length, 1);
  assert.equal(start.length, 1);
  assert.equal(start[0].body.custom_payment_method_type_id, 'cpmt_gcash_fixture');
  assert.ok(logs.some((line) => /confirm HTTP 200 status=success/.test(line)));
});

test('GCash start 409 is reported and does not reconfirm', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    confirmFactory: () => ({ status: 'success' }),
    startFactory: () => ({
      status: 409,
      data: { detail: 'Checkout session must be confirmed before starting custom payment method flow.' },
    }),
  });
  const logs = [];
  await assert.rejects(
    () => extractLocalProvider(gcashExtractArgs(fetchImpl, logs)),
    (error) => error?.code === 'GCASH_START_UNCONFIRMED' || error?.code === 'GCASH_START_FAILED',
  );
  const confirms = calls.filter((item) => item.path === '/backend-api/payments/checkout/confirm');
  const starts = calls.filter((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start');
  assert.equal(confirms.length, 1);
  assert.equal(starts.length, 1);
  assert.ok(logs.some((line) => /custom_payment_method\/start HTTP 409/.test(line)));
});

test('GCash start 409 rebuilds whole checkout with a new PH sticky like r19', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    confirmBody: { status: 'blocked' },
    startFactory: (n) => (n === 1
      ? {
        status: 409,
        data: { detail: 'Checkout session must be confirmed before starting custom payment method flow.' },
      }
      : {
        next_action: {
          paymentMethodType: 'gcash',
          url: 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=rebuilt',
        },
      }),
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 10,
    log: (message) => logs.push(String(message)),
  });
  assert.match(result.link, /redirectData=rebuilt/);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH && item.method === 'POST').length, 2);
  assert.equal(calls.filter((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start').length, 2);
  assert.ok(logs.some((line) => /confirm status=blocked，按参考仍 start/.test(line)));
  assert.ok(logs.some((line) => /更换/.test(line) && /sticky/.test(line) && /2\/10/.test(line)));
  assert.ok(logs.some((line) => /资格预检已通过：复用/.test(line)));
});

test('GCash GETs checkout page only when update lacked amount', async () => {
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
    'PHP',
    { _14: 15 },
    'minorUnitsAmount',
    '0',
  ];
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    omitCreateAmount: true,
    updateBody: { success: true },
    checkoutPageHtml: `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(flattened))})</script>`,
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 1,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(calls.filter((item) => item.method === 'GET' && /\/checkout\//.test(item.path)).length, 1);
  assert.ok(logs.some((line) => /checkout\/update 未返回金额/.test(line)));
  assert.ok(logs.some((line) => /checkout page/.test(line) && /金额检测通过/.test(line)));
});

test('GCash start success is next_action.url even when confirm status is blocked', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    confirmBody: { status: 'blocked' },
    adyenUrl: 'https://m.gcash.com/gcashapp/gcash-link-web/index.html#/confirm?code=fixture',
  });
  const logs = [];
  const result = await extractLocalProvider({
    ...gcashExtractArgs(fetchImpl, logs),
    stopAfterStart: true,
  });
  assert.match(result.link, /m\.gcash\.com|adyen\.com/);
  assert.equal(result.stopped_after_start, true);
  assert.equal(result.confirm_status, 'blocked');
  assert.ok(calls.some((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start'));
  assert.ok(logs.some((line) => /must be confirmed|confirm status=blocked|已拿到 start 支付 URL/.test(line)));
});

test('GCash confirm pending HTTP 200 starts immediately without waiting for success', async () => {
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    confirmFactory: (n) => ({ status: n === 1 ? 'pending' : 'success' }),
  });
  const logs = [];
  const result = await extractLocalProvider({
    ...gcashExtractArgs(fetchImpl, logs),
    stopAfterStart: true,
  });
  assert.equal(result.flow, 'adyen');
  const confirms = calls.filter((item) => item.path === '/backend-api/payments/checkout/confirm');
  const starts = calls.filter((item) => item.path === '/backend-api/payments/checkout/custom_payment_method/start');
  assert.equal(confirms.length, 1);
  assert.equal(starts.length, 1);
  assert.ok(logs.some((line) => /confirm HTTP 200 status=pending/.test(line)));
});

function debugTraceFile() {
  return path.join(os.tmpdir(), `gcash-debug-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

test('GCash debug continues through 110000 amount and blocked confirm still starts', async () => {
  const tracePath = debugTraceFile();
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    amountTotal: 110000,
    taxesBody: {
      success: true,
      checkout_session: {
        status: 'open',
        amount_total: 110000,
        currency: 'php',
        checkout_state: {
          total: {
            total: { amount: 110000, currency: 'PHP' },
            due: { amount: 110000, currency: 'PHP' },
          },
        },
      },
    },
    confirmBody: { status: 'blocked' },
  });
  const logs = [];
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 2,
    debug: true,
    debugTracePath: tracePath,
    log: (message) => logs.push(String(message)),
  });
  assert.equal(result.flow, 'adyen');
  assert.equal(result.confirm_status, 'blocked');
  assert.equal(result.start_http, 200);
  assert.ok(result.debug_trace_path);
  assert.ok(calls.some((item) => item.path.includes('checkout/confirm')));
  assert.ok(calls.some((item) => item.path.includes('custom_payment_method/start')));
  assert.equal(calls.some((item) => item.path.includes('custom_payment_method/continue')), false);
  assert.ok(logs.some((line) => /DEBUG 继续：建单应付非 0/.test(line)));
  assert.ok(logs.some((line) => /confirm status=blocked/.test(line)));
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  assert.ok(Array.isArray(trace.steps));
  assert.ok(trace.steps.some((step) => step.path === CHECKOUT_PATH && step.http === 200));
  assert.ok(trace.steps.some((step) => /amount_total/.test(JSON.stringify(step.response || {}))));
  fs.unlinkSync(tracePath);
});

test('GCash debug start 409 stops that branch without retry', async () => {
  const tracePath = debugTraceFile();
  const { calls, fetchImpl } = createLocalFixture('gcash', {
    amountTotal: 110000,
    taxesBody: {
      success: true,
      checkout_session: { amount_total: 110000, currency: 'php' },
    },
    startError: 'Checkout session must be confirmed before starting a custom payment method',
    startStatus: 409,
  });
  const result = await extractLocalProvider({
    channelId: 'gcash',
    detail: { access_token: fixtureToken(), email: 'local@example.test' },
    proxy: { host: 'proxy.example.test', port: 8080, username: 'user-region-PH-session-1', password: 'x' },
    fetchImpl,
    maxCheckoutAttempts: 2,
    debug: true,
    debugTracePath: tracePath,
    log: () => {},
  });
  assert.equal(result.debug_stopped, true);
  assert.equal(result.debug_stop_reason, 'start_http');
  assert.equal(result.start_http, 409);
  assert.equal(calls.filter((item) => item.path.includes('custom_payment_method/start')).length, 1);
  assert.equal(calls.filter((item) => item.path === CHECKOUT_PATH && item.method === 'POST').length, 1);
  assert.equal(calls.some((item) => item.path.includes('custom_payment_method/continue')), false);
  fs.unlinkSync(tracePath);
});

