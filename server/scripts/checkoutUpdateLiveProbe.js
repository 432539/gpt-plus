#!/usr/bin/env node
/**
 * One-shot checkout/update probe. Prints only HTTP status + amount field names.
 * Never prints access tokens, cs_live ids, PayPal URLs, proxy passwords, or JWTs.
 */
const Database = require('better-sqlite3');
const { decrypt } = require('../src/utils/crypto');
const { promoCampaignId } = require('../src/utils/accountCheck');
const {
  chatgptAccountIdFromToken,
  chatgptHeaders,
  checkoutCreateBody,
  checkoutUpdateBody,
  chatgptCheckoutHeaders,
  evaluateCheckoutUpdateResponse,
  checkoutResponseAmountMinor,
  GB,
  GBP,
  CAMPAIGN_ID,
} = require('../src/utils/paymentLink');
const { createChromeTransport } = require('../src/utils/mailcomProxy');

const EMAIL = process.argv[2] || '';
if (!EMAIL.includes('@')) {
  console.log(JSON.stringify({ ok: false, error: 'email_required' }));
  process.exit(2);
}

function redactId(value) {
  const text = String(value || '');
  if (text.startsWith('cs_')) return 'cs_redacted';
  if (text.startsWith('oaics_')) return 'oaics_redacted';
  return text ? 'id_present' : '';
}

function loadAccount(email) {
  const db = new Database(require('../src/config').dbPath, { readonly: true });
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE email = ? COLLATE NOCASE LIMIT 1').get(email);
  const proxy = db.prepare(
    "SELECT * FROM proxies WHERE group_name LIKE '%支付%' AND status != 'disabled' ORDER BY id LIMIT 1",
  ).get();
  db.close();
  if (!row) return { error: 'account_not_found' };
  const accessToken = decrypt(row.access_token || '');
  if (!accessToken) return { error: 'access_token_missing' };
  if (!proxy) return { error: 'pay_proxy_missing' };
  return {
    accessToken,
    accountId: row.chatgpt_account_id || chatgptAccountIdFromToken(accessToken),
    proxy: {
      proxy_type: proxy.proxy_type || 'http',
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || '',
      password: decrypt(proxy.password_enc || ''),
    },
  };
}

async function chatgptJson(transport, detail, deviceId, path, { method = 'POST', json, extra = {} } = {}) {
  const headers = chatgptHeaders({
    accessToken: detail.accessToken,
    deviceId,
    accountId: detail.accountId,
    extra,
  });
  delete headers.Origin;
  const response = await transport.fetch(`https://chatgpt.com${path}`, {
    method,
    headers: {
      ...headers,
      ...(json ? { 'content-type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  return { status: Number(response.status) || 0, data, text };
}

(async () => {
  const loaded = loadAccount(EMAIL);
  if (loaded.error) {
    console.log(JSON.stringify({ ok: false, error: loaded.error }));
    process.exit(1);
  }
  const deviceId = require('node:crypto').randomUUID();
  const transport = createChromeTransport(loaded.proxy, { timeoutMs: 45000 });
  const eligibility = await chatgptJson(transport, loaded, deviceId, '/backend-api/accounts/check/v4-2023-04-27', {
    method: 'GET',
    extra: { Referer: 'https://chatgpt.com/' },
  });
  const campaign = promoCampaignId(eligibility.data, loaded.accountId) || '';
  const checkout = await chatgptJson(transport, loaded, deviceId, '/backend-api/payments/checkout', {
    json: checkoutCreateBody({ country: GB, currency: GBP, uiMode: 'custom', promoEnabled: false }),
    extra: {
      Referer: 'https://chatgpt.com/',
      'x-openai-target-path': '/backend-api/payments/checkout',
      'x-openai-target-route': '/backend-api/payments/checkout',
    },
  });
  const csId = String(checkout.data?.checkout_session_id || checkout.data?.session_id || checkout.data?.id || '');
  const processor = String(checkout.data?.processor_entity || '');
  let update = { status: 0, data: null, text: '' };
  let evaluated = null;
  if (csId) {
    const fakeCheckout = { cs_id: csId, processor_entity: processor, billing_country: GB };
    update = await chatgptJson(transport, loaded, deviceId, '/backend-api/payments/checkout/update', {
      json: checkoutUpdateBody(csId, processor),
      extra: chatgptCheckoutHeaders(fakeCheckout, '/backend-api/payments/checkout/update'),
    });
    evaluated = evaluateCheckoutUpdateResponse(update.status, update.data, update.text);
  }
  console.log(JSON.stringify({
    ok: Boolean(evaluated?.ok),
    eligibility_http: eligibility.status,
    campaign: campaign === CAMPAIGN_ID ? CAMPAIGN_ID : (campaign ? 'other_campaign' : ''),
    checkout_http: checkout.status,
    checkout_kind: redactId(csId),
    checkout_create_amount: checkoutResponseAmountMinor(checkout.data),
    update_http: update.status,
    update_ok: Boolean(evaluated?.ok),
    update_deferred: Boolean(evaluated?.deferred),
    update_amount: evaluated?.amount ?? null,
    update_code: evaluated?.code || '',
    update_reason: evaluated?.logReason || '',
    html_challenge: /<!doctype|<html|cloudflare|just a moment/i.test(String(update.text || checkout.text || eligibility.text || '')),
    proxy_type: loaded.proxy.proxy_type || '',
  }));
})().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: 'probe_failed', kind: error.name || 'Error' }));
  process.exit(1);
});
