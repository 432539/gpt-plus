const crypto = require('node:crypto');

const EXTRACT_CONCURRENCY_CAP = 5;
const CHATGPT_RETRY_ATTEMPTS = 5;
const PROVIDER_RETRY_ATTEMPTS = 5;
const PAYPAL_FULL_CHECKOUT_ATTEMPTS = 5;
const PAYPAL_URL_POLL_ATTEMPTS = 5;
const GCASH_FAILURE_ATTEMPTS = 10;
const GCASH_ELIGIBILITY_ATTEMPTS = 3;
const CHATGPT_TIMEOUT_MS = 45000;
const STRIPE_TIMEOUT_MS = 30000;
const CAMPAIGN_ID = 'plus-1-month-free';
const PLAN_NAME = 'chatgptplusplan';
const GB = 'GB';
const GBP = 'GBP';

const CHATGPT_CLIENT_VERSION = 'prod-46437587156517d920436051cb9ab60a95f0503a';
const CHATGPT_CLIENT_BUILD_NUMBER = '7904904';

function clientVersionFromHtml(html) {
  const match = String(html || '').match(/prod-[a-f0-9]{32,}/);
  return match ? match[0] : '';
}

function clientBuildFromHtml(html) {
  const match = String(html || '').match(
    /(?:oai-client-build-number|clientBuildNumber|buildNumber)["'\s:=]+(\d{6,8})/i,
  );
  return match ? match[1] : '';
}

function applyLiveClientVersion(session, html) {
  if (!session) return '';
  const version = clientVersionFromHtml(html);
  if (version) session.liveClientVersion = version;
  const build = clientBuildFromHtml(html);
  if (build) session.liveClientBuild = build;
  return version;
}
const DEFAULT_STRIPE_RUNTIME_VERSION = '6f8494a281';
const STRIPE_VERSION_FULL = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';
const STRIPE_VERSION_BASE = '2025-03-31.basil';
const STRIPE_CLIENT_BETAS = Object.freeze([
  'custom_checkout_server_updates_1',
  'custom_checkout_manual_approval_1',
]);
const STRIPE_ADDITIONAL_ELEMENTS = Object.freeze(['expressCheckout', 'payment', 'address']);

const GB_PAYPAL = Object.freeze({
  linkType: 'paypal_uk',
  billingCountry: GB,
  paymentMethodCountry: GB,
  currency: GBP,
  checkoutUiMode: 'custom',
  paymentLocale: 'en',
  browserLocale: 'en-US',
  elementsLocale: 'en',
  timezone: 'Europe/London',
  acceptLanguage: 'en-GB,en;q=0.9',
  oaiLanguage: 'en-GB',
  planName: PLAN_NAME,
  promoCampaignId: CAMPAIGN_ID,
});

const GCASH_CHAT = Object.freeze({
  billingCountry: 'PH',
  currency: 'PHP',
  paymentLocale: 'en',
  timezone: 'Asia/Manila',
  acceptLanguage: 'fil-PH,en;q=0.9',
  oaiLanguage: 'fil-PH',
  planName: PLAN_NAME,
  promoCampaignId: CAMPAIGN_ID,
  processorEntity: 'openai_ie',
  promoHome: `https://chatgpt.com/?promo_campaign=${CAMPAIGN_ID}`,
  promoPath: `/?promo_campaign=${CAMPAIGN_ID}`,
  clientBuildNumber: CHATGPT_CLIENT_BUILD_NUMBER,
  sentinelCreateFlow: 'chatgpt_checkout',
  sentinelConfirmFlow: 'checkout_session_approval',
});

function gcashChatgptExtra(extra = {}) {
  return {
    'Accept-Language': GCASH_CHAT.acceptLanguage,
    'oai-language': GCASH_CHAT.oaiLanguage,
    'oai-client-build-number': GCASH_CHAT.clientBuildNumber,
    ...extra,
  };
}

function gcashProcessorEntity(checkout) {
  return processorEntityForCountry(
    checkout?.billing_country || GCASH_CHAT.billingCountry,
    checkout?.processor_entity || '',
  );
}

function applyGcashProcessorEntity(checkout) {
  if (!checkout || typeof checkout !== 'object') return checkout;
  if (!String(checkout.processor_entity || '').trim()) {
    checkout.processor_entity = gcashProcessorEntity(checkout);
  }
  return checkout;
}

function gcashSentinelState(session, deviceId, pageUrl) {
  const { createSentinelState } = require('./protocolRt/sentinel');
  return createSentinelState({
    deviceId,
    userAgent: session?.fingerprint?.userAgent || '',
    language: 'fil-PH',
    languages: 'fil-PH,en',
    timezone: GCASH_CHAT.timezone,
    pageUrl: pageUrl || 'https://chatgpt.com/',
  });
}

async function gcashSentinelHeaders(session, deviceId, pageUrl, flow) {
  if (!session || session.transport === 'fixture') return {};
  try {
    const { sentinelHeaders } = require('./protocolRt/sentinel');
    return await sentinelHeaders(
      session,
      gcashSentinelState(session, deviceId, pageUrl),
      flow || GCASH_CHAT.sentinelCreateFlow,
    );
  } catch {
    return {};
  }
}

async function sessionCookieHeader(session, deviceId) {
  let raw = '';
  try {
    if (typeof session?.cookies === 'function') {
      const list = await session.cookies();
      raw = (Array.isArray(list) ? list : [])
        .filter((item) => item && item.name)
        .map((item) => `${item.name}=${item.value || ''}`)
        .join('; ');
    } else if (typeof session?.cookieJar?.getCookieString === 'function') {
      raw = session.cookieJar.getCookieString('https://chatgpt.com/') || '';
    }
  } catch {
    raw = '';
  }
  return chatgptCookieHeader({ sessionCookie: raw, deviceId });
}

async function sessionCookieEntries(session, deviceId) {
  let list = [];
  try {
    if (typeof session?.cookies === 'function') {
      const loaded = await session.cookies();
      if (Array.isArray(loaded)) list = loaded;
    }
  } catch {
    list = [];
  }
  const filtered = list
    .filter((item) => item?.name && CHATGPT_PAYMENT_COOKIE_NAMES.has(String(item.name)))
    .map((item) => ({ ...item, name: String(item.name), value: String(item.value || '') }));
  const id = String(deviceId || '').trim() || newId();
  const device = filtered.find((item) => item.name === 'oai-did');
  if (device) {
    device.value = id;
  } else {
    filtered.unshift({
      name: 'oai-did',
      value: id,
      domain: 'chatgpt.com',
      path: '/',
      secure: true,
      hostOnly: true,
    });
  }
  if (filtered.length > 1) return filtered;
  const header = await sessionCookieHeader(session, id);
  return cookieHeaderToEntries(header);
}

async function gcashRequestExtra(session, deviceId, extra = {}) {
  const cookie = await sessionCookieHeader(session, deviceId);
  return gcashChatgptExtra({
    ...(cookie ? { Cookie: cookie } : {}),
    ...(session?.liveClientVersion ? { 'oai-client-version': session.liveClientVersion } : {}),
    ...(session?.liveClientBuild ? { 'oai-client-build-number': session.liveClientBuild } : {}),
    ...extra,
  });
}

const CHATGPT_PAYMENT_COOKIE_NAMES = new Set([
  'oai-did',
  'oai-hlib',
  'oai-sc',
  'oaicom-stable-id',
  '_account',
  '_account_is_fedramp',
  '__Secure-oai-is',
  '__Secure-next-auth.session-token',
  '__cf_bm',
  '__cflb',
  '_cfuvid',
  '__oailb',
  'cf_clearance',
]);

const BILLING_EMAIL_DOMAINS = Object.freeze(['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me']);
const GENERIC_BILLING_NAMES = Object.freeze([
  ['Alex', 'Morgan'],
  ['Daniel', 'Lee'],
  ['Emma', 'Martin'],
  ['Lucas', 'Brown'],
  ['Mia', 'Wilson'],
  ['Noah', 'Clark'],
  ['Olivia', 'Taylor'],
  ['Sofia', 'Garcia'],
]);
const GENERIC_STREET_NAMES = Object.freeze(['Central', 'Market', 'Park', 'Station', 'King', 'Queen', 'Liberty', 'Main', 'Garden', 'River']);
const GB_BILLING_PROFILE = Object.freeze({
  city: 'London',
  state: 'England',
  postalCode: 'SW1A 1AA',
  phonePrefix: '+44',
});
const PH_BILLING_PROFILE = Object.freeze({
  city: 'Manila',
  state: 'Metro Manila',
  postalCode: '1000',
  phonePrefix: '+63',
});

const PAY_GROUP_RE = /支付|paypal|pay(?:ment)?(?:[\s_-]?(?:gb|uk))?/i;
const REGISTER_GROUP_RE = /注册|register|\bjp\b|japan/i;

function protoError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function newId() {
  return crypto.randomUUID();
}

function nestedValue(payload, path) {
  let current = payload;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function normalizeCountry(value, fallback = GB) {
  const country = String(value || '').replace(/[^A-Za-z]/g, '').toUpperCase();
  return country.length === 2 ? country : fallback;
}

function chatgptAccountIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const auth = payload?.['https://api.openai.com/auth'] || {};
    return String(
      auth.chatgpt_account_id
      || payload['https://api.openai.com/auth.chatgpt_account_id']
      || payload.chatgpt_account_id
      || payload.chatgptAccountId
      || payload.account_id
      || payload.accountId
      || '',
    ).trim();
  } catch {
    return '';
  }
}

function accountEmailFromAccessToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const profile = payload?.['https://api.openai.com/profile'] || {};
    for (const value of [profile.email, payload.email, payload.preferred_username, payload.upn]) {
      if (String(value || '').includes('@')) return String(value).trim();
    }
  } catch { /* ignore */ }
  return '';
}

function filterChatgptPaymentCookieHeader(cookieHeader) {
  const values = {};
  for (const item of String(cookieHeader || '').split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name && rest.length && CHATGPT_PAYMENT_COOKIE_NAMES.has(name)) values[name] = rest.join('=');
  }
  return Object.entries(values).map(([name, value]) => `${name}=${value}`).join('; ');
}

function replaceCookieHeaderValue(cookieHeader, name, value) {
  const parts = [];
  let replaced = false;
  for (const item of String(cookieHeader || '').split(';')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key === name) {
      if (!replaced) parts.push(`${name}=${value}`);
      replaced = true;
      continue;
    }
    if (rest.length) parts.push(trimmed);
  }
  if (!replaced) parts.unshift(`${name}=${value}`);
  return parts.join('; ');
}

function chatgptCookieHeader({ sessionCookie = '', deviceId = '' } = {}) {
  const raw = String(sessionCookie || '').trim();
  const id = String(deviceId || '').trim() || newId();
  if (raw && !raw.split(';', 1)[0].includes('=')) {
    return `oai-did=${id}; __Secure-next-auth.session-token=${raw}`;
  }
  const filtered = filterChatgptPaymentCookieHeader(raw);
  if (!filtered) return `oai-did=${id}`;
  return replaceCookieHeaderValue(filtered, 'oai-did', id);
}

function cookieHeaderToEntries(cookieHeader) {
  const entries = [];
  for (const item of String(cookieHeader || '').split(';')) {
    const trimmed = item.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const name = trimmed.slice(0, trimmed.indexOf('=')).trim();
    const value = trimmed.slice(trimmed.indexOf('=') + 1);
    if (name) entries.push({ name, value, domain: '.chatgpt.com', path: '/', secure: true });
  }
  return entries;
}

function processorEntityForCountry(country, processorEntity = '') {
  const entity = String(processorEntity || '').trim();
  if (entity) return entity;
  return String(country || '').toUpperCase() === 'US' ? 'openai_llc' : 'openai_ie';
}

function chatgptCheckoutShortUrl(csId, country, processorEntity = '') {
  const entity = processorEntityForCountry(country, processorEntity);
  return `https://chatgpt.com/checkout/${entity}/${csId}`;
}

function chatgptSuccessReturnUrl(csId, country, processorEntity = '') {
  const entity = processorEntityForCountry(country, processorEntity);
  return `https://chatgpt.com/checkout/verify?stripe_session_id=${csId}&processor_entity=${entity}&plan_type=plus`;
}

function toOpenaiPayUrl(stripeHostedUrl) {
  const url = String(stripeHostedUrl || '').trim();
  if (!url) return '';
  if (url.startsWith('https://checkout.stripe.com')) {
    return `https://pay.openai.com${url.slice('https://checkout.stripe.com'.length)}`;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() === 'checkout.stripe.com') {
      parsed.hostname = 'pay.openai.com';
      return parsed.toString();
    }
  } catch { /* ignore */ }
  return url;
}

function isExternalUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isPaypalMeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'paypal.me' || host.endsWith('.paypal.me') || host === 'py.pl' || host.endsWith('.py.pl');
  } catch {
    return false;
  }
}

function isPaypalUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'paypal.com' || host.endsWith('.paypal.com')
      || host === 'paypalobjects.com' || host.endsWith('.paypalobjects.com')
      || host === 'paypal.me' || host.endsWith('.paypal.me')
      || host === 'py.pl' || host.endsWith('.py.pl');
  } catch {
    return false;
  }
}

function isStripeHostedCheckoutUrl(value) {
  const text = String(value || '').trim();
  if (/^(cs_live_|cs_test_)/i.test(text) && text.length > 8) return true;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || '';
    if (host === 'checkout.stripe.com' || host === 'pay.openai.com') return true;
    if ((host === 'chatgpt.com' || host.endsWith('.chatgpt.com')) && /\/checkout\//i.test(path)) return true;
    return /\/c\/pay\/cs_(?:live|test)_/i.test(path);
  } catch {
    return false;
  }
}

function isPaypalBaApproveUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'paypal.com' || host.endsWith('.paypal.com'))) return false;
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return path === '/agreements/approve' && Boolean(parsed.searchParams.get('ba_token'));
  } catch {
    return false;
  }
}

function isIgnoredResourceUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const ignoredHosts = new Set([
      'checkout.stripe.com', 'stripe-camo.global.ssl.fastly.net', 'files.stripe.com',
      'q.stripe.com', 'js.stripe.com', 'm.stripe.network',
    ]);
    const ignoredSuffixes = ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico', '.css', '.js', '.woff', '.woff2'];
    if (ignoredHosts.has(host) || [...ignoredHosts].some((item) => host.endsWith(`.${item}`))) return true;
    if (host === 'cloudfront.net' || host.endsWith('.cloudfront.net')) return true;
    if ((host === 'stripe.com' || host === 'www.stripe.com') && path.startsWith('/docs/')) return true;
    return ignoredSuffixes.some((suffix) => path.endsWith(suffix));
  } catch {
    return false;
  }
}

function isPaypalProviderRedirectUrl(value) {
  return isPaypalUrl(value) && !isIgnoredResourceUrl(value);
}

function collectUrls(payload, found = []) {
  if (typeof payload === 'string') {
    for (const match of payload.match(/https?:\/\/[^\s"'<>]+/g) || []) found.push(match.replace(/[),.;\]]+$/, ''));
  } else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload)) {
      for (const item of payload) collectUrls(item, found);
    } else {
      for (const [key, value] of Object.entries(payload)) {
        if (['url', 'return_url', 'redirect_url', 'redirect_to_url'].includes(key) && typeof value === 'string' && isExternalUrl(value)) {
          found.push(value);
        } else collectUrls(value, found);
      }
    }
  }
  return found;
}

function extractRedirectToUrl(payload) {
  if (!payload || typeof payload !== 'object') {
    const urls = collectUrls(payload);
    return urls.find((item) => isPaypalBaApproveUrl(item)) || urls.find((item) => isPaypalUrl(item) && !isIgnoredResourceUrl(item)) || '';
  }
  const nextAction = payload.next_action;
  if (nextAction && typeof nextAction === 'object' && nextAction.type === 'redirect_to_url') {
    const redirect = nextAction.redirect_to_url || {};
    const url = String(redirect.url || '').trim();
    if (url) return url;
  }
  for (const key of ['setup_intent', 'payment_intent']) {
    if (payload[key] && typeof payload[key] === 'object') {
      const nested = extractRedirectToUrl(payload[key]);
      if (nested) return nested;
    }
  }
  const urls = collectUrls(payload);
  return urls.find((item) => isPaypalBaApproveUrl(item)) || urls.find((item) => isPaypalUrl(item) && !isIgnoredResourceUrl(item)) || '';
}

function paypalLinkFromText(payload) {
  const extracted = extractRedirectToUrl(payload);
  if (extracted && (isPaypalBaApproveUrl(extracted) || isPaypalProviderRedirectUrl(extracted))) {
    return extracted;
  }
  const text = typeof payload === 'string'
    ? payload
    : payload && typeof payload === 'object'
      ? (() => {
        try { return JSON.stringify(payload); } catch { return ''; }
      })()
      : '';
  const ba = String(text || '').match(/ba_token=([A-Za-z0-9_-]+)/i);
  if (ba) return `https://www.paypal.com/agreements/approve?ba_token=${ba[1]}`;
  const short = String(text || '').match(/https?:\/\/(?:www\.)?(?:paypal\.me|py\.pl)\/[^\s"'<>]+/i);
  return short ? short[0].replace(/[),.;\]]+$/, '') : '';
}

function copyablePaymentLink(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (isPaypalBaApproveUrl(value) || isPaypalProviderRedirectUrl(value)) return value;
  const parsed = paypalLinkFromText(value);
  if (parsed && (isPaypalBaApproveUrl(parsed) || isPaypalProviderRedirectUrl(parsed))) return parsed;
  return '';
}

function extractProcessorEntity(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = data.processor_entity || data.processorEntity;
  if (direct) return String(direct).trim();
  for (const key of ['checkout_session', 'session', 'checkout', 'data']) {
    if (data[key] && typeof data[key] === 'object') {
      const found = extractProcessorEntity(data[key]);
      if (found) return found;
    }
  }
  return '';
}

function extractStripePublishableKey(data) {
  if (typeof data === 'string') {
    const match = data.match(/pk_(?:live|test)_[A-Za-z0-9]+/);
    return match ? match[0] : '';
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = extractStripePublishableKey(item);
      if (found) return found;
    }
    return '';
  }
  if (data && typeof data === 'object') {
    for (const key of ['stripe_publishable_key', 'publishable_key', 'publishableKey', 'stripePublishableKey', 'key']) {
      const found = extractStripePublishableKey(data[key]);
      if (found) return found;
    }
    for (const value of Object.values(data)) {
      const found = extractStripePublishableKey(value);
      if (found) return found;
    }
  }
  return '';
}

const CHECKOUT_DUE_AMOUNT_PATHS = Object.freeze([
  ['checkout_session', 'checkout_state', 'total', 'due'],
  ['checkout_state', 'total', 'due'],
  ['checkout_session', 'total', 'due'],
  ['total', 'due'],
  ['total_summary', 'due'],
  ['totalSummary', 'due'],
  ['invoice', 'amount_due'],
  ['invoice', 'amountDue'],
  ['checkout_session', 'amount_due'],
  ['amount_due'],
  ['amountDue'],
]);

const CHECKOUT_AMOUNT_TOTAL_PATHS = Object.freeze([
  ['checkout_session', 'amount_total'],
  ['checkout_session', 'amountTotal'],
  ['checkoutSession', 'amount_total'],
  ['amount_total'],
  ['amountTotal'],
  ['checkout_amount_minor'],
]);

const CHECKOUT_ZEROABLE_CATALOG_TOTAL_PATHS = Object.freeze([
  ['checkout_session', 'checkout_state', 'total', 'total'],
  ['checkout_state', 'total', 'total'],
  ['total', 'total'],
]);

const CHECKOUT_PAYABLE_AMOUNT_PATHS = Object.freeze([
  ...CHECKOUT_AMOUNT_TOTAL_PATHS,
  ...CHECKOUT_DUE_AMOUNT_PATHS,
  ...CHECKOUT_ZEROABLE_CATALOG_TOTAL_PATHS,
]);

const CHECKOUT_CATALOG_AMOUNT_PATHS = Object.freeze([
  ['total', 'total'],
  ['total', 'taxInclusive'],
  ['total', 'taxInclusiveAmount'],
  ['checkout_state', 'total', 'total'],
  ['checkout_state', 'total', 'taxInclusive'],
  ['checkout_session', 'checkout_state', 'total', 'total'],
  ['checkout_snapshot', 'total', 'total'],
]);

const CHECKOUT_AMOUNT_WRAPPERS = Object.freeze([
  'checkout_session', 'checkoutSession', 'session', 'checkout',
  'data', 'result', 'payload', 'response',
  'checkout_state', 'checkoutState', 'checkout_snapshot', 'checkoutSnapshot',
]);

const CHECKOUT_UPDATE_AMOUNT_PROBES = Object.freeze([
  ['checkout_session.amount_total', ['checkout_session', 'amount_total']],
  ['amount_total', ['amount_total']],
  ['total.due', ['total', 'due']],
  ['checkout_state.total.due', ['checkout_state', 'total', 'due']],
  ['checkout_session.checkout_state.total.due', ['checkout_session', 'checkout_state', 'total', 'due']],
  ['total.total', ['total', 'total']],
  ['checkout_state.total.total', ['checkout_state', 'total', 'total']],
  ['checkout_session.checkout_state.total.total', ['checkout_session', 'checkout_state', 'total', 'total']],
  ['checkout_snapshot.total.total', ['checkout_snapshot', 'total', 'total']],
  ['total.taxInclusive', ['total', 'taxInclusive']],
  ['total.taxInclusiveAmount', ['total', 'taxInclusiveAmount']],
  ['lineItems', ['lineItems']],
  ['checkout_amount_minor', ['checkout_amount_minor']],
]);

const ZERO_DECIMAL_CURRENCIES = Object.freeze(new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]));

function moneyMinorUnits(value) {
  if (typeof value === 'boolean') return null;
  if (Array.isArray(value)) return null;
  if (value && typeof value === 'object') {
    for (const key of ['minorUnitsAmount', 'minor_units_amount', 'amount', 'due', 'value', 'taxInclusive', 'taxInclusiveAmount']) {
      if (value[key] != null) {
        const nested = moneyMinorUnits(value[key]);
        if (nested != null) return nested;
      }
    }
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  }
  return null;
}

function lineItemsAmountMinor(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const items = payload.lineItems || payload.line_items;
  if (!Array.isArray(items)) return null;
  let total = 0;
  let found = false;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const key of ['total', 'unitAmount', 'unit_amount', 'subtotal']) {
      const amount = moneyMinorUnits(item[key]);
      if (amount != null) {
        total += amount;
        found = true;
        break;
      }
    }
  }
  return found ? total : null;
}

function joinAmountSource(prefix, path) {
  const label = Array.isArray(path) ? path.join('.') : String(path || '');
  if (!prefix) return label;
  if (!label) return prefix;
  return label.startsWith(`${prefix}.`) ? label : `${prefix}.${label}`;
}

function extractCheckoutCurrency(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const candidates = [
    data.currency,
    data.checkout_session?.currency,
    data.checkoutSession?.currency,
    data.checkout_state?.currency,
    data.checkout_snapshot?.currency,
    data.checkoutSnapshot?.currency,
    data.total?.currency,
    data.total?.total?.currency,
  ];
  for (const item of candidates) {
    const value = String(item || '').trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(value)) return value;
  }
  return '';
}

function formatPaymentAmount(amount, currency) {
  const cur = String(currency || '').trim().toUpperCase();
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount ?? '');
  if (!cur) return String(Math.trunc(value));
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) return `${Math.trunc(value)} ${cur}`;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(value));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} ${cur}`;
}

function firstAmountAlong(data, paths, prefix = '') {
  for (const path of paths) {
    const amount = moneyMinorUnits(nestedValue(data, path));
    if (amount != null) {
      return { amount, source: joinAmountSource(prefix, path) };
    }
  }
  return null;
}

function inspectPayableAmount(data, prefix = '', currency = '') {
  // Due/amount_due is the UI payable ("本次支付"). Catalog list price must not override it.
  const due = firstAmountAlong(data, CHECKOUT_DUE_AMOUNT_PATHS, prefix);
  if (due) return { ...due, currency };

  const amountTotal = firstAmountAlong(data, CHECKOUT_AMOUNT_TOTAL_PATHS, prefix);
  const catalog = firstAmountAlong(data, CHECKOUT_ZEROABLE_CATALOG_TOTAL_PATHS, prefix);
  // Historical free signals: amount_total===0 OR checkout_state.total.total===0.
  // A non-zero amount_total/list price must not block those zeros.
  // taxInclusive=0 is catalog chrome, never payable.
  if (amountTotal && Number(amountTotal.amount) === 0) return { ...amountTotal, currency };
  if (catalog && Number(catalog.amount) === 0) return { ...catalog, currency };
  if (amountTotal) return { ...amountTotal, currency };
  return { amount: null, source: '', currency };
}

function inspectCheckoutAmount(data, visited = new WeakSet(), prefix = '', options = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { amount: null, source: '', currency: '' };
  }
  if (visited.has(data)) return { amount: null, source: '', currency: '' };
  visited.add(data);
  const payableOnly = options.payableOnly === true;
  const currency = extractCheckoutCurrency(data);
  if (payableOnly) {
    const payable = inspectPayableAmount(data, prefix, currency);
    if (payable.amount != null) return payable;
  } else {
    for (const path of CHECKOUT_PAYABLE_AMOUNT_PATHS) {
      const amount = moneyMinorUnits(nestedValue(data, path));
      if (amount != null) {
        return { amount, source: joinAmountSource(prefix, path), currency };
      }
    }
    const fromLines = lineItemsAmountMinor(data)
      ?? lineItemsAmountMinor(nestedValue(data, ['checkout_state']))
      ?? lineItemsAmountMinor(nestedValue(data, ['checkout_session', 'checkout_state']))
      ?? lineItemsAmountMinor(nestedValue(data, ['checkout_snapshot']));
    if (fromLines != null) {
      return { amount: fromLines, source: joinAmountSource(prefix, 'lineItems'), currency };
    }
  }
  for (const key of CHECKOUT_AMOUNT_WRAPPERS) {
    if (data[key] && typeof data[key] === 'object') {
      const nested = inspectCheckoutAmount(data[key], visited, joinAmountSource(prefix, key), options);
      if (nested.amount != null) {
        return { amount: nested.amount, source: nested.source, currency: nested.currency || currency };
      }
    }
  }
  if (!payableOnly) {
    for (const path of CHECKOUT_CATALOG_AMOUNT_PATHS) {
      const amount = moneyMinorUnits(nestedValue(data, path));
      if (amount != null) {
        return { amount, source: joinAmountSource(prefix, path), currency };
      }
    }
  }
  return { amount: null, source: '', currency };
}

function inspectCheckoutPayableAmount(data) {
  return inspectCheckoutAmount(data, new WeakSet(), '', { payableOnly: true });
}

function checkoutResponseAmountMinor(data) {
  return inspectCheckoutAmount(data).amount;
}

function checkoutDiscountAmountMinor(data) {
  if (!data || typeof data !== 'object') return 0;
  const amount = moneyMinorUnits(nestedValue(data, ['total', 'discount']))
    ?? moneyMinorUnits(nestedValue(data, ['checkout_state', 'total', 'discount']))
    ?? moneyMinorUnits(nestedValue(data, ['checkout_snapshot', 'total', 'discount']))
    ?? moneyMinorUnits(nestedValue(data, ['checkout_session', 'checkout_state', 'total', 'discount']));
  return amount == null ? 0 : amount;
}

function checkoutStateTotalNumbers(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { total: null, due: null, amountTotal: null, taxInclusive: null, discount: null };
  }
  const total = moneyMinorUnits(
    nestedValue(payload, ['checkout_session', 'checkout_state', 'total', 'total'])
    ?? nestedValue(payload, ['checkout_state', 'total', 'total'])
    ?? nestedValue(payload, ['total', 'total']),
  );
  const due = moneyMinorUnits(
    nestedValue(payload, ['checkout_session', 'checkout_state', 'total', 'due'])
    ?? nestedValue(payload, ['checkout_state', 'total', 'due'])
    ?? nestedValue(payload, ['total', 'due']),
  );
  const amountTotal = moneyMinorUnits(
    nestedValue(payload, ['checkout_session', 'amount_total'])
    ?? nestedValue(payload, ['amount_total']),
  );
  const taxInclusive = moneyMinorUnits(
    nestedValue(payload, ['checkout_session', 'checkout_state', 'total', 'taxInclusive'])
    ?? nestedValue(payload, ['checkout_state', 'total', 'taxInclusive'])
    ?? nestedValue(payload, ['total', 'taxInclusive']),
  );
  return {
    total,
    due,
    amountTotal,
    taxInclusive,
    discount: checkoutDiscountAmountMinor(payload),
  };
}

function formatStateAmount(value) {
  return value == null ? '无' : String(value);
}

function presentCheckoutUpdateFields(payload) {
  const present = [];
  const missing = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { present, missing: CHECKOUT_UPDATE_AMOUNT_PROBES.map(([label]) => label) };
  }
  for (const [label, path] of CHECKOUT_UPDATE_AMOUNT_PROBES) {
    const value = nestedValue(payload, path);
    if (value != null && value !== '') present.push(label);
    else missing.push(label);
  }
  if (payload.success != null) present.push('success');
  const sessionStatus = nestedValue(payload, ['checkout_session', 'status']);
  if (sessionStatus != null && sessionStatus !== '') present.push('checkout_session.status');
  if (payload.promo_campaign != null) present.push('promo_campaign');
  return { present, missing };
}

function checkoutUpdateAttemptReason(status, payload, extra = '') {
  const { present, missing } = presentCheckoutUpdateFields(payload);
  const numbers = checkoutStateTotalNumbers(payload);
  const presentText = present.length ? `有 ${present.slice(0, 8).join(', ')}` : '无金额相关字段';
  const missingText = missing.length ? `缺 ${missing.slice(0, 6).join(', ')}` : '';
  const extraText = extra ? `，${extra}` : '';
  const numberText = `amount_total=${formatStateAmount(numbers.amountTotal)} checkout_state.total.total=${formatStateAmount(numbers.total)} due=${formatStateAmount(numbers.due)} taxInclusive=${formatStateAmount(numbers.taxInclusive)} discount=${formatStateAmount(numbers.discount)}`;
  return `HTTP ${Number(status) || 0}${extraText}，${numberText}，${presentText}${missingText ? `；${missingText}` : ''}`;
}

function evaluateCheckoutUpdateResponse(status, payload, text = '', options = {}) {
  const code = Number(status) || 0;
  const payableOnly = options.payableOnly === true;
  const inspected = inspectCheckoutAmount(payload, new WeakSet(), '', { payableOnly });
  const currency = String(options.currency || inspected.currency || GBP).toUpperCase();
  const htmlLike = looksLikeHtmlChallenge(text) || looksLikeHtmlChallenge(typeof payload === 'string' ? payload : '');
  if (htmlLike) {
    return {
      ok: false,
      deferred: false,
      recoverable: true,
      code: 'CHECKOUT_PROMOTION',
      status: code || 502,
      amount: null,
      source: '',
      currency,
      formatted: '',
      message: 'checkout/update 返回验证页而非 JSON',
      logReason: checkoutUpdateAttemptReason(code, payload, '响应像 Cloudflare/HTML 挑战'),
    };
  }
  if (code >= 400) {
    return {
      ok: false,
      deferred: false,
      recoverable: true,
      code: 'CHECKOUT_PROMOTION',
      status: code,
      amount: null,
      source: '',
      currency,
      formatted: '',
      message: `checkout/update 失败：HTTP ${code}`,
      logReason: checkoutUpdateAttemptReason(code, payload, '请求被拒绝'),
    };
  }
  if (payloadHasInvalidPromotion(payload)) {
    return {
      ok: false,
      deferred: false,
      recoverable: true,
      code: 'CHECKOUT_PROMOTION',
      status: 409,
      amount: null,
      source: '',
      currency,
      formatted: '',
      message: 'checkout/update returned invalid_promotion',
      logReason: checkoutUpdateAttemptReason(code || 200, payload, 'invalid_promotion'),
    };
  }
  if (payload && typeof payload === 'object' && payload.success === false) {
    return {
      ok: false,
      deferred: false,
      recoverable: true,
      code: 'CHECKOUT_PROMOTION',
      status: 502,
      amount: null,
      source: '',
      currency,
      formatted: '',
      message: 'checkout/update 被拒绝',
      logReason: checkoutUpdateAttemptReason(code || 200, payload, 'success=false'),
    };
  }
  const amount = inspected.amount;
  if (amount != null && Number(amount) !== 0) {
    return {
      ok: false,
      deferred: false,
      recoverable: false,
      code: 'PAYMENT_AMOUNT_NOT_ZERO',
      status: 409,
      amount,
      source: inspected.source,
      currency,
      formatted: formatPaymentAmount(amount, currency),
      message: `checkout/update 后支付金额不是0元，当前 ${formatPaymentAmount(amount, currency)}`,
      logReason: checkoutUpdateAttemptReason(
        code || 200,
        payload,
        `金额 ${amount} 非 0 source=${inspected.source || 'unknown'}`,
      ),
    };
  }
  if (amount != null && Number(amount) === 0) {
    return {
      ok: true,
      deferred: false,
      recoverable: false,
      code: '',
      status: code || 200,
      amount: 0,
      source: inspected.source,
      currency,
      formatted: formatPaymentAmount(0, currency),
      message: '',
      logReason: checkoutUpdateAttemptReason(
        code || 200,
        payload,
        `金额 0 已确认 source=${inspected.source || 'unknown'}`,
      ),
    };
  }
  return {
    ok: true,
    deferred: true,
    recoverable: false,
    code: '',
    status: code || 200,
    amount: null,
    source: '',
    currency,
    formatted: '',
    message: '',
    logReason: checkoutUpdateAttemptReason(
      code || 200,
      payload,
      payableOnly
        ? '未返回 checkout_session.amount_total 等应付字段，将重试 update，不把 lineItems/catalog 当应付'
        : '未返回明确金额，延后到 Stripe/PayPal 步骤确认 0 元',
    ),
  };
}

function parseCheckoutResponse(data, attemptCountry = GB, currency = GBP, isCouponFromQueryParam = false) {
  const csId = data?.checkout_session_id || data?.session_id || data?.id;
  const id = String(csId || '');
  if (!id || !(id.startsWith('cs_') || id.startsWith('oaics_'))) {
    throw protoError(`checkout response missing cs_id`, { status: 502, code: 'EXTRACT_CHECKOUT_INVALID' });
  }
  return {
    cs_id: id,
    processor_entity: extractProcessorEntity(data),
    stripe_publishable_key: extractStripePublishableKey(data),
    billing_country: attemptCountry,
    currency,
    checkout_amount_minor: checkoutResponseAmountMinor(data),
    checkout_discount_minor: checkoutDiscountAmountMinor(data),
    one_click_trial_eligible: Boolean(data?.one_click_trial_eligible),
    immediate_discount_settings: data?.immediate_discount_settings ?? null,
    scheduled_discount_preview: data?.scheduled_discount_preview ?? null,
    promo_campaign: data?.promo_campaign ?? null,
    promo_credit_grant: data?.promo_credit_grant ?? null,
    promo_query_param: isCouponFromQueryParam,
    checkout_url: String(data?.url || '').trim(),
    confirm_return_url: String(data?.confirm_return_url || '').trim(),
    client_secret: String(data?.client_secret || '').trim(),
    customer_session_client_secret: String(data?.customer_session_client_secret || '').trim(),
    checkout_provider: String(data?.checkout_provider || '').trim(),
    payment_method_types: (data?.payment_method_types || []).map((item) => String(item)).filter(Boolean),
    custom_payment_methods: data?.custom_payment_methods || [],
  };
}

function checkoutHasPromoSignal(checkout) {
  return checkout?.checkout_amount_minor === 0
    || Number(checkout?.checkout_discount_minor || 0) > 0
    || checkout?.promo_credit_grant != null
    || checkout?.immediate_discount_settings != null
    || checkout?.scheduled_discount_preview != null
    || Boolean(checkout?.one_click_trial_eligible);
}

function decodeReactRouterFlattenedPayload(payload) {
  if (!Array.isArray(payload)) return null;
  const resolved = new Map();
  const resolve = (reference) => {
    if (!Number.isInteger(reference)) return reference;
    if (reference < 0 || reference >= payload.length) return null;
    if (resolved.has(reference)) return resolved.get(reference);
    const value = payload[reference];
    if (Array.isArray(value)) {
      const output = [];
      resolved.set(reference, output);
      output.push(...value.map(resolve));
      return output;
    }
    if (value && typeof value === 'object') {
      const output = {};
      resolved.set(reference, output);
      for (const [encodedKey, encodedValue] of Object.entries(value)) {
        if (!/^_\d+$/.test(encodedKey)) continue;
        const key = resolve(Number(encodedKey.slice(1)));
        if (key != null) output[String(key)] = resolve(encodedValue);
      }
      return output;
    }
    resolved.set(reference, value);
    return value;
  };
  return resolve(0);
}

function openaiCheckoutStateFromHtml(html) {
  const pattern = /window\.__reactRouterContext\.streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/gs;
  for (const match of String(html || '').matchAll(pattern)) {
    try {
      const rawPayload = JSON.parse(match[1]);
      if (typeof rawPayload !== 'string' || !rawPayload.trimStart().startsWith('[')) continue;
      const decoded = decodeReactRouterFlattenedPayload(JSON.parse(rawPayload));
      const routeData = decoded?.loaderData?.['routes/checkout.$entity.$checkoutId'];
      const checkoutState = routeData?.checkoutSession?.checkout_state;
      if (checkoutState && typeof checkoutState === 'object') return checkoutState;
    } catch {
      // Ignore unrelated or malformed streaming chunks.
    }
  }
  return {};
}

function openaiCheckoutPageAmountMinor(html, checkout = {}) {
  const checkoutState = openaiCheckoutStateFromHtml(html);
  const totalSummary = checkoutState.total && typeof checkoutState.total === 'object'
    ? checkoutState.total
    : {};
  let total = totalSummary.total;
  if (!total || typeof total !== 'object') total = totalSummary;
  const raw = total && typeof total === 'object' ? total.minorUnitsAmount : undefined;
  const currency = String(checkoutState.currency || checkout.currency || '').toUpperCase();
  if (raw == null || raw === '') return { amount: null, currency, checkoutState };
  const amount = Number(raw);
  if (!Number.isFinite(amount)) {
    throw protoError(`OpenAI checkout 页面金额无法解析: ${raw}`, { status: 502, recoverable: true });
  }
  return { amount, currency, checkoutState };
}

function isStripeCheckoutSessionId(value) {
  return String(value || '').trim().startsWith('cs_');
}

function isOaicsSessionId(value) {
  return String(value || '').trim().startsWith('oaics_');
}

function isStripeHostedSessionUrl(value) {
  const text = String(value || '').trim();
  if (/^(cs_live_|cs_test_)/i.test(text) && text.length > 8) return true;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname || '';
    if (host === 'checkout.stripe.com' || host === 'pay.openai.com') return true;
    return /\/c\/pay\/cs_(?:live|test)_/i.test(path);
  } catch {
    return false;
  }
}

function isStripeCheckoutTicket(checkout) {
  const csId = String(checkout?.cs_id || '').trim();
  const url = String(checkout?.checkout_url || '').trim();
  if (isStripeCheckoutSessionId(csId) || isStripeHostedSessionUrl(csId)) return true;
  return isStripeHostedSessionUrl(url);
}

function shouldApproveFirstCheckout(checkout) {
  if (isStripeCheckoutTicket(checkout)) return false;
  return isOaicsSessionId(checkout?.cs_id);
}

function checkoutCreateBody({ country = GB, currency = GBP, uiMode = 'custom', promoEnabled = false, promoQuery = false } = {}) {
  const body = {
    entry_point: 'all_plans_pricing_modal',
    plan_name: PLAN_NAME,
    billing_details: { country, currency },
    checkout_ui_mode: uiMode,
  };
  if (promoEnabled) {
    body.promo_campaign = { promo_campaign_id: CAMPAIGN_ID, is_coupon_from_query_param: promoQuery };
  }
  return body;
}

function checkoutUpdateBody(csId, processorEntity, country = GB) {
  return {
    checkout_session_id: csId,
    processor_entity: processorEntityForCountry(country, processorEntity),
    plan_name: PLAN_NAME,
    price_interval: 'month',
    seat_quantity: 1,
    promo_campaign: { promo_campaign_id: CAMPAIGN_ID, is_coupon_from_query_param: false },
  };
}

function gcashConfirmBody(csId, cpmId) {
  return {
    checkout_session_id: csId,
    selected_payment_method_type: cpmId,
  };
}

function gcashStartBody(csId, cpmId) {
  return {
    checkout_session_id: csId,
    custom_payment_method_type_id: cpmId,
  };
}

function chatgptCheckoutHeaders(checkout, path) {
  const csId = String(checkout?.cs_id || '');
  const processorEntity = processorEntityForCountry(checkout?.billing_country || GB, checkout?.processor_entity || '');
  return {
    Referer: `https://chatgpt.com/checkout/${processorEntity}/${csId}`,
    'x-openai-target-path': path,
    'x-openai-target-route': path,
  };
}

function redactCheckoutId(value) {
  const text = String(value || '').trim();
  if (/^(cs_live_|cs_test_|oaics_)/i.test(text) && text.length > 12) return `${text.slice(0, 8)}…`;
  return text;
}

function classifyApproveResult(payload, status) {
  const http = Number(status) || 0;
  if (http >= 400) {
    const rebuild = [500, 502, 503, 504].includes(http);
    const retryable = !rebuild && [403, 429].includes(http);
    return {
      ok: false,
      result: '',
      http,
      retryable,
      rebuild,
      code: 'CHECKOUT_APPROVE_HTTP',
      message: `checkout/approve HTTP ${http}`,
    };
  }
  const result = String(payload?.result || '').trim().toLowerCase();
  if (result === 'approved') {
    return { ok: true, result, http, retryable: false, rebuild: false, code: '', message: '' };
  }
  if (result === 'expired') {
    return {
      ok: false,
      result,
      http,
      retryable: true,
      rebuild: false,
      code: 'CHECKOUT_APPROVE_EXPIRED',
      message: 'chatgpt approve result expired',
    };
  }
  if (result === 'invalid_promotion') {
    return {
      ok: false,
      result,
      http,
      retryable: false,
      rebuild: true,
      code: 'CHECKOUT_PROMOTION',
      message: 'checkout/approve returned invalid_promotion',
    };
  }
  return {
    ok: false,
    result: result || 'blocked',
    http,
    retryable: true,
    rebuild: true,
    code: 'CHECKOUT_APPROVE_BLOCKED',
    message: `chatgpt approve unexpected result: '${result || 'blocked'}'`,
  };
}

function genericStreetLine() {
  const number = 10 + Math.floor(Math.random() * 980);
  return `${number} ${randomItem(GENERIC_STREET_NAMES)} ${randomItem(['Street', 'Road', 'Avenue', 'Lane', 'Plaza', 'Boulevard'])}`;
}

function gbBilling(overrides = {}) {
  const [firstName, lastName] = randomItem(GENERIC_BILLING_NAMES);
  const suffix = 10000 + Math.floor(Math.random() * 90000);
  const emailName = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
  return {
    name: `${firstName} ${lastName}`,
    email: `${emailName}${suffix}@${randomItem(BILLING_EMAIL_DOMAINS)}`,
    phone: `${GB_BILLING_PROFILE.phonePrefix} ${2000000 + Math.floor(Math.random() * 997999999)}`,
    tax_id: '',
    country: GB,
    line1: genericStreetLine(),
    line2: '',
    city: GB_BILLING_PROFILE.city,
    state: GB_BILLING_PROFILE.state,
    postal_code: GB_BILLING_PROFILE.postalCode,
    ...overrides,
  };
}

function phBilling(overrides = {}) {
  const [firstName, lastName] = randomItem(GENERIC_BILLING_NAMES);
  const suffix = 10000 + Math.floor(Math.random() * 90000);
  const emailName = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
  return {
    name: `${firstName} ${lastName}`,
    email: `${emailName}${suffix}@${randomItem(BILLING_EMAIL_DOMAINS)}`,
    phone: `${PH_BILLING_PROFILE.phonePrefix} ${2000000 + Math.floor(Math.random() * 997999999)}`,
    tax_id: '',
    country: 'PH',
    line1: genericStreetLine(),
    line2: '',
    city: PH_BILLING_PROFILE.city,
    state: PH_BILLING_PROFILE.state,
    postal_code: PH_BILLING_PROFILE.postalCode,
    ...overrides,
  };
}

function taxesBody(checkout, billing) {
  const country = normalizeCountry(billing?.country || checkout?.billing_country, GB);
  const processorEntity = processorEntityForCountry(checkout?.billing_country || country, checkout?.processor_entity || '');
  return {
    checkout_session_id: checkout.cs_id,
    checkout_email: billing?.email || 'buyer@example.com',
    billing_country: country,
    billing_name: billing?.name || 'Alex Morgan',
    currency: String(checkout?.currency || GBP).toUpperCase(),
    tax_id: null,
    processor_entity: processorEntity,
    billing_address: {
      country,
      line1: billing?.line1 || '10 Downing Street',
      line2: billing?.line2 || '',
      city: billing?.city || 'London',
      state: billing?.state || '',
      postal_code: billing?.postal_code || GB_BILLING_PROFILE.postalCode,
    },
  };
}

function snapshotBody(billing) {
  return {
    snapshot: {
      billing_address: {
        name: billing?.name || 'Alex Morgan',
        address: {
          line1: billing?.line1 || '',
          line2: billing?.line2 || '',
          city: billing?.city || '',
          country: String(billing?.country || GB).toUpperCase(),
          postal_code: billing?.postal_code || '',
          state: billing?.state || '',
        },
      },
    },
  };
}

function detectedExpectedAmount(initPayload) {
  if (!initPayload || typeof initPayload !== 'object') return null;
  const elementsSession = initPayload.elements_session;
  if (elementsSession && typeof elementsSession === 'object') {
    if (elementsSession.amount != null) return String(elementsSession.amount);
    for (const key of ['payment_intent', 'setup_intent']) {
      if (elementsSession[key]?.amount != null) return String(elementsSession[key].amount);
    }
  }
  if (initPayload.total_summary?.due != null) return String(initPayload.total_summary.due);
  if (initPayload.invoice?.amount_due != null) return String(initPayload.invoice.amount_due);
  const lineItems = initPayload.line_items || initPayload.display_items;
  if (Array.isArray(lineItems)) {
    let total = 0;
    let found = false;
    for (const item of lineItems) {
      if (item && typeof item === 'object' && item.amount != null) {
        const amount = Number(item.amount);
        if (Number.isFinite(amount)) {
          total += amount;
          found = true;
        }
      }
    }
    if (found) return String(total);
  }
  return null;
}

function expectedAmount(initPayload) {
  return detectedExpectedAmount(initPayload) || '0';
}

function collectPaymentMethodTypes(payload, found = new Set()) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (typeof item === 'string' && item.trim()) found.add(item.trim().toLowerCase());
      else collectPaymentMethodTypes(item, found);
    }
    return found;
  }
  if (!payload || typeof payload !== 'object') return found;
  for (const [key, value] of Object.entries(payload)) {
    const normalized = String(key || '').toLowerCase();
    if (['payment_method_types', 'payment_method_types_array', 'ordered_payment_method_types', 'payment_method_specs', 'custom_payment_methods'].includes(normalized) && Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) found.add(item.trim().toLowerCase());
        else if (item && typeof item === 'object' && item.type) found.add(String(item.type).toLowerCase());
      }
    } else if ((normalized === 'type' || normalized === 'payment_method_type') && typeof value === 'string') {
      found.add(value.trim().toLowerCase());
    }
    collectPaymentMethodTypes(value, found);
  }
  return found;
}

function availablePaymentMethodTypes(initPayload) {
  const found = collectPaymentMethodTypes(initPayload);
  return new Set([...found].filter((item) => ['paypal', 'card', 'link', 'ideal'].includes(item)));
}

function ensurePaypalAvailable(initPayload) {
  const available = availablePaymentMethodTypes(initPayload);
  if (available.size && !available.has('paypal')) {
    throw protoError(
      `当前 checkout session 不支持 PayPal。可用支付方式：${[...available].sort().join(', ')}。`,
      { status: 409, code: 'PAYMENT_METHOD_UNAVAILABLE', recoverable: true },
    );
  }
}

function ensureAmountZero(initPayload, currency = GBP) {
  const amount = detectedExpectedAmount(initPayload);
  if (amount == null) {
    throw protoError('Stripe init 未返回明确金额，无法确认 0 元优惠', { status: 409, code: 'CHECKOUT_PROMOTION', recoverable: true });
  }
  const amountValue = Number(amount);
  if (!Number.isFinite(amountValue)) {
    throw protoError(`支付金额无法解析: ${amount}`, { status: 502, code: 'EXTRACT_AMOUNT_INVALID' });
  }
  if (amountValue !== 0) {
    throw protoError(`支付金额不是0元，当前 ${amountValue} ${currency}，已停止流程。`, {
      status: 409, code: 'PAYMENT_AMOUNT_NOT_ZERO', recoverable: false,
    });
  }
  return `0.00 ${currency}`;
}

function ensureCheckoutUpdateAmountZero(updatePayload, currency = GBP, options = {}) {
  const evaluated = evaluateCheckoutUpdateResponse(200, updatePayload, '', { currency, ...options });
  if (evaluated.ok && !evaluated.deferred) return evaluated.formatted || formatPaymentAmount(0, currency);
  if (evaluated.ok && evaluated.deferred) {
    if (options.allowMissing) return evaluated.formatted || '';
    throw protoError('checkout/update 没有返回明确金额，无法确认 0 元优惠', {
      status: 409, code: 'CHECKOUT_PROMOTION', recoverable: false,
    });
  }
  throw protoError(evaluated.message, {
    status: evaluated.status || 409,
    code: evaluated.code || 'CHECKOUT_PROMOTION',
    recoverable: evaluated.recoverable === true,
  });
}

function payloadHasInvalidPromotion(payload) {
  if (typeof payload === 'string') return payload.trim().toLowerCase() === 'invalid_promotion';
  if (Array.isArray(payload)) return payload.some(payloadHasInvalidPromotion);
  if (payload && typeof payload === 'object') return Object.values(payload).some(payloadHasInvalidPromotion);
  return false;
}

function findSubmissionAttempt(payload) {
  if (Array.isArray(payload)) {
    for (const value of payload) {
      const found = findSubmissionAttempt(value);
      if (found && Object.keys(found).length) return found;
    }
    return {};
  }
  if (!payload || typeof payload !== 'object') return {};
  if (payload.submission_attempt && typeof payload.submission_attempt === 'object') return payload.submission_attempt;
  for (const value of Object.values(payload)) {
    const found = findSubmissionAttempt(value);
    if (found && Object.keys(found).length) return found;
  }
  return {};
}

function stripeHostedDisplayAmounts(initPayload) {
  const totalSummary = initPayload?.total_summary && typeof initPayload.total_summary === 'object' ? initPayload.total_summary : {};
  const invoice = initPayload?.invoice && typeof initPayload.invoice === 'object' ? initPayload.invoice : {};
  const toInt = (value, fallback = 0) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : fallback;
  };
  const due = toInt(totalSummary.due, toInt(invoice.amount_due));
  const total = toInt(totalSummary.total, due);
  const subtotal = toInt(totalSummary.subtotal, total);
  return {
    subtotal: String(subtotal),
    total_exclusive_tax: '0',
    total_inclusive_tax: '0',
    total_discount_amount: String(Math.max(subtotal - total, 0)),
    shipping_rate_amount: '0',
  };
}

function stripeHostedExpectedAmounts(initPayload) {
  const totalSummary = initPayload?.total_summary && typeof initPayload.total_summary === 'object' ? initPayload.total_summary : {};
  const invoice = initPayload?.invoice && typeof initPayload.invoice === 'object' ? initPayload.invoice : {};
  let expected = detectedExpectedAmount(initPayload) || '0';
  if (totalSummary.due != null) expected = String(totalSummary.due);
  const amountDue = invoice.amount_due;
  if (amountDue != null && invoice.billing_cycle_anchor && !invoice.has_prorations) {
    return [String(totalSummary.due || '0'), String(amountDue)];
  }
  if (amountDue != null && totalSummary.due == null) expected = String(amountDue);
  return [expected, ''];
}

function stripeHostedConfirmUrl(csId, initPayload, stripeHostedUrl) {
  const raw = String(initPayload?.url || initPayload?.hosted_checkout_url || initPayload?.stripe_hosted_url || stripeHostedUrl || `https://pay.openai.com/c/pay/${csId}`).trim();
  const parsed = new URL(toOpenaiPayUrl(raw) || `https://pay.openai.com/c/pay/${csId}`);
  parsed.searchParams.delete('redirect_pm_type');
  parsed.searchParams.delete('lid');
  parsed.searchParams.delete('ui_mode');
  parsed.searchParams.set('redirect_pm_type', 'paypal');
  parsed.searchParams.set('lid', randomHex(12));
  parsed.searchParams.set('ui_mode', String(initPayload?.ui_mode || 'hosted'));
  return parsed.toString();
}

function stripeInitBody({ stripePk, stripeJsId, timezone = GB_PAYPAL.timezone, hosted = false } = {}) {
  return {
    browser_locale: GB_PAYPAL.browserLocale,
    browser_timezone: timezone,
    'elements_session_client[client_betas][0]': STRIPE_CLIENT_BETAS[0],
    'elements_session_client[client_betas][1]': STRIPE_CLIENT_BETAS[1],
    'elements_session_client[elements_init_source]': 'custom_checkout',
    'elements_session_client[referrer_host]': 'chatgpt.com',
    'elements_session_client[stripe_js_id]': stripeJsId,
    'elements_session_client[locale]': GB_PAYPAL.elementsLocale,
    'elements_session_client[is_aggregation_expected]': 'false',
    'elements_options_client[saved_payment_method][enable_save]': 'auto',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'auto',
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
  };
}

function stripeContext(csId, initPayload = {}) {
  const local = initPayload._local_client_context && typeof initPayload._local_client_context === 'object'
    ? initPayload._local_client_context
    : {};
  return {
    stripe_js_id: String(local.stripe_js_id || newId()),
    elements_session_id: `elements_session_${randomHex(6).slice(0, 11)}`,
    elements_session_config_id: String(initPayload.config_id || newId()),
    guid: String(local.guid || randomHex(16)),
    muid: String(local.muid || randomHex(16)),
    sid: String(local.sid || randomHex(16)),
    config_id: initPayload.config_id || '',
    init_checksum: initPayload.init_checksum || '',
    currency: String(initPayload.currency || GBP).toLowerCase(),
    checkout_amount: expectedAmount(initPayload),
    locale: GB_PAYPAL.elementsLocale,
    runtime_version: DEFAULT_STRIPE_RUNTIME_VERSION,
  };
}

function stripeElementsClientParams(ctx) {
  return {
    'elements_session_client[client_betas][0]': STRIPE_CLIENT_BETAS[0],
    'elements_session_client[client_betas][1]': STRIPE_CLIENT_BETAS[1],
    'elements_session_client[elements_init_source]': 'custom_checkout',
    'elements_session_client[referrer_host]': 'chatgpt.com',
    'elements_session_client[session_id]': String(ctx?.elements_session_id || ''),
    'elements_session_client[stripe_js_id]': String(ctx?.stripe_js_id || ''),
    'elements_session_client[locale]': String(ctx?.locale || 'en'),
    'elements_session_client[is_aggregation_expected]': 'false',
    'elements_options_client[saved_payment_method][enable_save]': 'auto',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'auto',
  };
}

function stripeAdditionalElementsParams(prefix) {
  const body = {};
  STRIPE_ADDITIONAL_ELEMENTS.forEach((value, index) => {
    body[`${prefix}[merchant_integration_additional_elements][${index}]`] = value;
  });
  return body;
}

function stripeElementsSessionParams(checkout, ctx, stripePk) {
  const isOaics = isOaicsSessionId(checkout.cs_id);
  const methods = [...availablePaymentMethodTypes(checkout)].sort();
  const list = methods.length ? methods : ['card', 'paypal'];
  const amount = String(ctx.checkout_amount || expectedAmount(checkout) || '0');
  const params = {
    key: stripePk,
    _stripe_version: isOaics ? STRIPE_VERSION_BASE : STRIPE_VERSION_FULL,
    elements_init_source: isOaics ? 'stripe.elements' : 'custom_checkout',
    referrer_host: 'chatgpt.com',
    stripe_js_id: String(ctx.stripe_js_id || newId()),
    locale: String(ctx.locale || 'en'),
    type: 'deferred_intent',
    'deferred_intent[mode]': 'subscription',
    'deferred_intent[amount]': amount,
    'deferred_intent[currency]': String(ctx.currency || checkout.currency || GBP).toLowerCase(),
    'deferred_intent[setup_future_usage]': 'off_session',
    currency: String(ctx.currency || checkout.currency || GBP).toLowerCase(),
  };
  if (!isOaics) {
    params['client_betas[0]'] = STRIPE_CLIENT_BETAS[0];
    params['client_betas[1]'] = STRIPE_CLIENT_BETAS[1];
    params.checkout_session_id = checkout.cs_id;
  } else {
    const customerSecret = String(checkout.customer_session_client_secret || '').trim();
    if (customerSecret) params.customer_session_client_secret = customerSecret;
  }
  list.forEach((method, index) => {
    params[`deferred_intent[payment_method_types][${index}]`] = method;
  });
  return params;
}

function stripePaypalPaymentMethodBody(csId, stripePk, billing, ctx) {
  const runtime = ctx.runtime_version || DEFAULT_STRIPE_RUNTIME_VERSION;
  return {
    guid: ctx.guid || randomHex(16),
    muid: ctx.muid || randomHex(16),
    sid: ctx.sid || randomHex(16),
    'billing_details[name]': billing.name || 'Alex Morgan',
    'billing_details[email]': billing.email || 'buyer@example.com',
    'billing_details[phone]': billing.phone || '',
    'billing_details[address][country]': billing.country || GB,
    'billing_details[address][line1]': billing.line1 || '10 Downing Street',
    'billing_details[address][line2]': billing.line2 || '',
    'billing_details[address][city]': billing.city || 'London',
    'billing_details[address][postal_code]': billing.postal_code || GB_BILLING_PROFILE.postalCode,
    'billing_details[address][state]': billing.state || 'England',
    type: 'paypal',
    payment_user_agent: `stripe.js/${runtime}; stripe-js-v3/${runtime}; payment-element; deferred-intent`,
    referrer: 'https://chatgpt.com',
    time_on_page: String(25000 + Math.floor(Math.random() * 30000)),
    'client_attribution_metadata[checkout_session_id]': csId,
    'client_attribution_metadata[client_session_id]': ctx.stripe_js_id,
    'client_attribution_metadata[elements_session_id]': ctx.elements_session_id,
    'client_attribution_metadata[elements_session_config_id]': ctx.elements_session_config_id,
    'client_attribution_metadata[merchant_integration_source]': 'elements',
    'client_attribution_metadata[merchant_integration_subtype]': 'payment-element',
    'client_attribution_metadata[merchant_integration_version]': '2021',
    'client_attribution_metadata[payment_intent_creation_flow]': 'deferred',
    'client_attribution_metadata[payment_method_selection_flow]': 'automatic',
    'client_attribution_metadata[merchant_integration_additional_elements][0]': 'payment',
    'client_attribution_metadata[merchant_integration_additional_elements][1]': 'address',
    key: stripePk,
    _stripe_version: STRIPE_VERSION_BASE,
  };
}

function stripeConfirmationTokenBody(checkout, stripePk, ctx, billing) {
  const csId = checkout.cs_id;
  const processorEntity = processorEntityForCountry(checkout.billing_country || GB, checkout.processor_entity || '');
  const returnUrl = String(checkout.confirm_return_url || '').trim() || chatgptSuccessReturnUrl(csId, checkout.billing_country || GB, processorEntity);
  const methods = (checkout.payment_method_types || []).map((item) => String(item).toLowerCase());
  const list = methods.length ? methods : ['card', 'paypal'];
  const runtime = DEFAULT_STRIPE_RUNTIME_VERSION;
  const body = {
    'payment_method_data[type]': 'paypal',
    'payment_method_data[billing_details][name]': billing.name || 'Alex Morgan',
    'payment_method_data[billing_details][email]': billing.email || 'buyer@example.com',
    'payment_method_data[billing_details][phone]': billing.phone || '',
    'payment_method_data[billing_details][address][line1]': billing.line1 || '10 Downing Street',
    'payment_method_data[billing_details][address][line2]': billing.line2 || '',
    'payment_method_data[billing_details][address][city]': billing.city || 'London',
    'payment_method_data[billing_details][address][state]': billing.state || 'England',
    'payment_method_data[billing_details][address][postal_code]': billing.postal_code || GB_BILLING_PROFILE.postalCode,
    'payment_method_data[billing_details][address][country]': billing.country || GB,
    'payment_method_data[payment_user_agent]': `stripe.js/${runtime}; stripe-js-v3/${runtime}; payment-element; deferred-intent`,
    'payment_method_data[referrer]': 'https://chatgpt.com',
    'payment_method_data[time_on_page]': String(45000 + Math.floor(Math.random() * 40000)),
    'payment_method_data[guid]': ctx.guid || randomHex(16),
    'payment_method_data[muid]': ctx.muid || randomHex(16),
    'payment_method_data[sid]': ctx.sid || randomHex(16),
    setup_future_usage: 'off_session',
    'mandate_data[customer_acceptance][type]': 'online',
    'mandate_data[customer_acceptance][online][infer_from_client]': 'true',
    key: stripePk,
    return_url: returnUrl,
    'client_context[currency]': String(checkout.currency || GBP).toLowerCase(),
    'client_context[mode]': 'subscription',
    'client_attribution_metadata[client_session_id]': ctx.stripe_js_id,
    'client_attribution_metadata[merchant_integration_source]': 'elements',
    'client_attribution_metadata[merchant_integration_subtype]': 'payment-element',
    'client_attribution_metadata[merchant_integration_version]': '2021',
    'client_attribution_metadata[payment_intent_creation_flow]': 'deferred',
    'client_attribution_metadata[payment_method_selection_flow]': 'merchant_specified',
    'client_attribution_metadata[elements_session_id]': ctx.elements_session_id,
    'client_attribution_metadata[elements_session_config_id]': ctx.elements_session_config_id,
    'client_attribution_metadata[merchant_integration_additional_elements][0]': 'expressCheckout',
    'client_attribution_metadata[merchant_integration_additional_elements][1]': 'payment',
    'client_attribution_metadata[merchant_integration_additional_elements][2]': 'address',
    set_as_default_payment_method: 'false',
    _stripe_version: STRIPE_VERSION_BASE,
  };
  list.forEach((method, index) => {
    body[`client_context[payment_method_types][${index}]`] = method;
  });
  if (ctx.customer_id) body['client_context[customer]'] = String(ctx.customer_id);
  return body;
}

function stripeConfirmReturnUrl(csId, checkout, stripeHostedUrl) {
  const hostedUrl = toOpenaiPayUrl(stripeHostedUrl)
    || chatgptCheckoutShortUrl(csId, checkout?.billing_country || GB, checkout?.processor_entity);
  if (hostedUrl.includes('pay.openai.com/') || hostedUrl.includes('checkout.stripe.com/')) {
    try {
      const parsed = new URL(hostedUrl);
      if (!parsed.searchParams.get('success_return_url')) {
        parsed.searchParams.set(
          'success_return_url',
          chatgptSuccessReturnUrl(csId, checkout?.billing_country || GB, checkout?.processor_entity),
        );
      }
      return parsed.toString();
    } catch { /* ignore */ }
  }
  return hostedUrl;
}

function stripePaymentPageParams(stripePk, ctx) {
  return {
    ...stripeElementsClientParams({
      ...ctx,
      locale: ctx?.locale || GB_PAYPAL.elementsLocale,
    }),
    'elements_options_client[saved_payment_method][enable_save]': 'never',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'never',
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
  };
}

function stripePaypalCustomConfirmBody(checkout, stripePk, initPayload, ctx, billing, stripeHostedUrl) {
  const runtime = ctx.runtime_version || DEFAULT_STRIPE_RUNTIME_VERSION;
  const csId = checkout.cs_id;
  const returnUrl = stripeConfirmReturnUrl(csId, checkout, stripeHostedUrl);
  const body = {
    guid: ctx.guid || randomHex(16),
    muid: ctx.muid || randomHex(16),
    sid: ctx.sid || randomHex(16),
    init_checksum: String(initPayload?.init_checksum || ctx.init_checksum || ''),
    version: runtime,
    expected_amount: String(ctx.checkout_amount || expectedAmount(initPayload)),
    expected_payment_method_type: 'paypal',
    return_url: returnUrl,
    link_brand: 'link',
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
    'consent[terms_of_service]': 'accepted',
    ...stripeElementsClientParams(ctx),
    'client_attribution_metadata[client_session_id]': String(ctx.stripe_js_id || ''),
    'client_attribution_metadata[checkout_session_id]': String(csId || ''),
    'client_attribution_metadata[checkout_config_id]': String(ctx.config_id || ''),
    'client_attribution_metadata[elements_session_id]': String(ctx.elements_session_id || ''),
    'client_attribution_metadata[elements_session_config_id]': String(ctx.elements_session_config_id || ''),
    'client_attribution_metadata[merchant_integration_source]': 'checkout',
    'client_attribution_metadata[merchant_integration_subtype]': 'payment-element',
    'client_attribution_metadata[merchant_integration_version]': 'custom',
    'client_attribution_metadata[payment_intent_creation_flow]': 'deferred',
    'client_attribution_metadata[payment_method_selection_flow]': 'automatic',
    ...stripeAdditionalElementsParams('client_attribution_metadata'),
    'payment_method_data[client_attribution_metadata][client_session_id]': String(ctx.stripe_js_id || ''),
    'payment_method_data[client_attribution_metadata][checkout_session_id]': String(csId || ''),
    'payment_method_data[client_attribution_metadata][checkout_config_id]': String(ctx.config_id || ''),
    'payment_method_data[client_attribution_metadata][elements_session_id]': String(ctx.elements_session_id || ''),
    'payment_method_data[client_attribution_metadata][elements_session_config_id]': String(ctx.elements_session_config_id || ''),
    'payment_method_data[client_attribution_metadata][merchant_integration_source]': 'elements',
    'payment_method_data[client_attribution_metadata][merchant_integration_subtype]': 'payment-element',
    'payment_method_data[client_attribution_metadata][merchant_integration_version]': '2021',
    'payment_method_data[client_attribution_metadata][payment_intent_creation_flow]': 'deferred',
    'payment_method_data[client_attribution_metadata][payment_method_selection_flow]': 'automatic',
    ...stripeAdditionalElementsParams('payment_method_data[client_attribution_metadata]'),
    'payment_method_data[type]': 'paypal',
    'payment_method_data[billing_details][name]': billing.name || 'Alex Morgan',
    'payment_method_data[billing_details][email]': billing.email || 'buyer@example.com',
    'payment_method_data[billing_details][phone]': billing.phone || '',
    'payment_method_data[billing_details][address][line1]': billing.line1 || '10 Downing Street',
    'payment_method_data[billing_details][address][line2]': billing.line2 || '',
    'payment_method_data[billing_details][address][city]': billing.city || 'London',
    'payment_method_data[billing_details][address][state]': billing.state || 'England',
    'payment_method_data[billing_details][address][postal_code]': billing.postal_code || GB_BILLING_PROFILE.postalCode,
    'payment_method_data[billing_details][address][country]': billing.country || GB,
    'payment_method_data[payment_user_agent]': `stripe.js/${runtime}; stripe-js-v3/${runtime}; payment-element; deferred-intent`,
    'payment_method_data[referrer]': 'https://chatgpt.com',
    'payment_method_data[time_on_page]': String(45000 + Math.floor(Math.random() * 75001)),
  };
  return body;
}

function stripeHostedConfirmBody(csId, stripePk, initPayload, billing, stripeHostedUrl) {
  const latest = { ...initPayload };
  const [expectedAmountValue, expectedAmountOnBca] = stripeHostedExpectedAmounts(latest);
  const displayed = stripeHostedDisplayAmounts(latest);
  const returnUrl = stripeHostedConfirmUrl(csId, latest, stripeHostedUrl);
  const body = {
    eid: 'NA',
    key: stripePk,
    init_checksum: String(latest.init_checksum || ''),
    expected_amount: expectedAmountValue,
    expected_payment_method_type: 'paypal',
    'payment_method_data[type]': 'paypal',
    'payment_method_data[billing_details][email]': billing.email || 'buyer@example.com',
    'payment_method_data[billing_details][address][country]': billing.country || GB,
    'payment_method_data[billing_details][address][postal_code]': billing.postal_code || GB_BILLING_PROFILE.postalCode,
    'payment_method_data[billing_details][address][state]': billing.state || 'England',
    'payment_method_data[billing_details][address][city]': billing.city || 'London',
    'payment_method_data[billing_details][address][line1]': billing.line1 || '10 Downing Street',
    'payment_method_data[billing_details][address][line2]': billing.line2 || '',
    'consent[terms_of_service]': 'accepted',
    'last_displayed_line_item_group_details[subtotal]': displayed.subtotal,
    'last_displayed_line_item_group_details[total_exclusive_tax]': displayed.total_exclusive_tax,
    'last_displayed_line_item_group_details[total_inclusive_tax]': displayed.total_inclusive_tax,
    'last_displayed_line_item_group_details[total_discount_amount]': displayed.total_discount_amount,
    'last_displayed_line_item_group_details[shipping_rate_amount]': displayed.shipping_rate_amount,
    return_url: returnUrl,
  };
  if (expectedAmountOnBca) body.expected_amount_on_bca = expectedAmountOnBca;
  return body;
}

function stripePaypalTaxRegionBody(csId, stripePk, billing) {
  return {
    eid: 'NA',
    'tax_region[country]': billing.country || GB,
    'tax_region[postal_code]': billing.postal_code || GB_BILLING_PROFILE.postalCode,
    'tax_region[line1]': billing.line1 || '10 Downing Street',
    'tax_region[city]': billing.city || 'London',
    key: stripePk,
  };
}

function stripeCustomTaxRegionBody(ctx, billing, stripePk) {
  const data = {
    ...stripeElementsClientParams(ctx),
    ...stripeAdditionalElementsParams('client_attribution_metadata'),
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
  };
  for (const field of ['country', 'line1', 'city', 'postal_code', 'state']) {
    const value = String(billing?.[field] || '').trim();
    if (value) data[`tax_region[${field}]`] = value;
  }
  return data;
}

function applyCustomTaxRegionAmount(ctx, payload) {
  const summary = payload?.total_summary && typeof payload.total_summary === 'object' ? payload.total_summary : {};
  const amount = summary.total ?? summary.due;
  if (amount != null && ctx && typeof ctx === 'object') ctx.checkout_amount = String(amount);
  return ctx;
}

function stripeIntentConfirmBody(clientSecret, stripePk, checkout, ctoken, ctx) {
  const processorEntity = processorEntityForCountry(checkout.billing_country || GB, checkout.processor_entity || '');
  const returnUrl = String(checkout.confirm_return_url || '').trim()
    || chatgptSuccessReturnUrl(checkout.cs_id, checkout.billing_country || GB, processorEntity);
  const body = {
    client_secret: clientSecret,
    key: stripePk,
    _stripe_version: STRIPE_VERSION_FULL,
    return_url: returnUrl,
  };
  if (ctoken) {
    body.confirmation_token = ctoken;
    body['client_attribution_metadata[client_session_id]'] = String(ctx?.stripe_js_id || '');
  }
  return body;
}

function intentConfirmPath(clientSecret) {
  const intentId = String(clientSecret || '').split('_secret_')[0];
  if (clientSecret.startsWith('seti_')) return `/v1/setup_intents/${intentId}/confirm`;
  if (clientSecret.startsWith('pi_')) return `/v1/payment_intents/${intentId}/confirm`;
  throw protoError(`OAICS intent client_secret 无法识别: ${String(clientSecret).slice(0, 40)}`, { status: 502, code: 'EXTRACT_INTENT_UNKNOWN' });
}

function chatgptHeaders({ accessToken, deviceId, sessionId, accountId, extra = {}, fingerprint } = {}) {
  const headers = {
    Accept: '*/*',
    'Accept-Language': GB_PAYPAL.acceptLanguage,
    Authorization: `Bearer ${accessToken}`,
    Origin: 'https://chatgpt.com',
    Referer: extra.Referer || 'https://chatgpt.com/',
    'Content-Type': 'application/json',
    'oai-device-id': deviceId,
    'oai-language': GB_PAYPAL.oaiLanguage,
    'oai-client-version': CHATGPT_CLIENT_VERSION,
    'oai-client-build-number': CHATGPT_CLIENT_BUILD_NUMBER,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...(fingerprint?.headers || {}),
    ...extra,
  };
  if (sessionId) headers['oai-session-id'] = sessionId;
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  return headers;
}

function isRetryableStatus(status) {
  return [401, 403, 408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status) || 0);
}

function looksLikeHtmlChallenge(text) {
  const value = String(text || '').toLowerCase();
  return /cloudflare|just a moment|attention required|challenge-platform|cf-ray|<!doctype|<html/.test(value);
}

const GCASH_CONFIRM_SUCCESS = new Set(['success', 'succeeded', 'ok', 'confirmed', 'complete', 'completed']);
const GCASH_CONFIRM_REJECTED = new Set(['blocked', 'failed', 'canceled', 'cancelled', 'expired', 'invalid']);

function gcashConfirmStatus(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  return String(data.status || data.result || data.checkout_session?.status || '').trim().toLowerCase();
}

function isGcashConfirmSuccess(payload) {
  return GCASH_CONFIRM_SUCCESS.has(gcashConfirmStatus(payload));
}

function isGcashConfirmRejected(payload) {
  return GCASH_CONFIRM_REJECTED.has(gcashConfirmStatus(payload));
}

function describeGcashConfirm(payload, status) {
  const http = Number(status) || 0;
  const confirmStatus = gcashConfirmStatus(payload) || 'empty';
  const data = payload && typeof payload === 'object' ? payload : {};
  const keys = Object.keys(data).slice(0, 12).join(',');
  const hint = [data.error, data.reason, data.code, data.detail]
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim().slice(0, 40))
    .find((item) => item);
  return `HTTP ${http} status=${confirmStatus}${keys ? ` keys=${keys}` : ''}${hint ? ` hint=${hint}` : ''}`;
}

function recoverableExtractError(error) {
  if (!error) return false;
  if (error.recoverable === false) return false;
  if (error.recoverable === true) return true;
  if (['ACCOUNT_NOT_ELIGIBLE', 'ACCOUNT_ELIGIBILITY_CHECK', 'CHECKOUT_PROMOTION', 'CHECKOUT_APPROVE_HTTP', 'CHECKOUT_APPROVE_BLOCKED', 'PAYMENT_METHOD_UNAVAILABLE', 'STRIPE_RISK_RETRYABLE', 'GCASH_CONFIRM_BLOCKED', 'GCASH_CONFIRM_REJECTED', 'GCASH_CONFIRM_NOT_READY', 'GCASH_START_UNCONFIRMED'].includes(error.code)) {
    return true;
  }
  if (error.skip || error.code === 'ACCOUNT_TOKEN_INVALIDATED' || error.code === 'ACCOUNT_ALREADY_PAID') return false;
  const status = Number(error.status) || 0;
  const detail = String(error.message || '').toLowerCase();
  if (status && isRetryableStatus(status)) return true;
  return /timeout|timed out|failed to fetch|net::|socket hang up|econnreset|sslerror|ssl_connect|boringssl|curl:\s*\(35\)|cloudflare|verification page|impersonat(?:e|ing).*(?:not supported|unsupported)/.test(detail);
}

function headerValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value || '');
  }
  return '';
}

function checkoutJsonObject(response) {
  if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
    return response.data;
  }
  const text = String(response?.text || '').trim();
  if (!text || text.startsWith('<')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function checkoutJsonDetail(response) {
  const data = checkoutJsonObject(response);
  if (!data) return '';
  if (typeof data.detail === 'string' && data.detail.trim()) return data.detail.trim();
  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
  if (data.error && typeof data.error === 'object') {
    return String(data.error.message || data.error.detail || '').trim();
  }
  return '';
}

function checkoutErrorSnippet(response) {
  const status = Number(response?.status) || 0;
  const contentType = headerValue(response?.headers, 'content-type');
  const text = String(response?.text || '');
  const html = looksLikeHtmlChallenge(text);
  const parts = [`status=${status || '-'}`, `content_type=${contentType || '-'}`];
  if (html) parts.push('html_challenge');
  else if (text.trim()) parts.push(`body=${text.replace(/\s+/g, ' ').trim().slice(0, 180)}`);
  else parts.push('empty_body');
  return parts.join(' ');
}

function classifyCheckoutError(response) {
  const status = Number(response?.status) || 0;
  const jsonDetail = checkoutJsonDetail(response);
  const text = String(response?.text || '');
  const html = looksLikeHtmlChallenge(text);
  const lowerJson = jsonDetail.toLowerCase();
  if (jsonDetail === 'User is already paid') {
    return protoError('当前账号已是付费状态，ChatGPT 拒绝创建 Plus checkout', { status: 400, code: 'ACCOUNT_ALREADY_PAID', skip: true });
  }
  if (status === 401 || /token[_ -]?invalidated|invalid token/.test(lowerJson)) {
    return protoError('账号 Token 已被作废，请重新导入有效的 Access Token', { status: 401, code: 'ACCOUNT_TOKEN_INVALIDATED', skip: true });
  }
  // Match ChatGPT JSON `detail` only. Do not scan HTML/empty 403 bodies for this phrase.
  if (/unusual activity/.test(lowerJson)) {
    return protoError(
      `checkout create rejected as unusual activity: ${jsonDetail.slice(0, 180)} | ${checkoutErrorSnippet(response)}`,
      {
        status: status || 403,
        code: 'EXTRACT_CHECKOUT_UNUSUAL',
        recoverable: true,
      },
    );
  }
  const fallback = jsonDetail || (html ? 'HTML/challenge page' : text.replace(/\s+/g, ' ').trim().slice(0, 180)) || `HTTP ${status}`;
  return protoError(`checkout create failed: ${fallback.slice(0, 240)} | ${checkoutErrorSnippet(response)}`, {
    status: status || 502,
    code: 'EXTRACT_CHECKOUT_FAILED',
    recoverable: isRetryableStatus(status) || html,
  });
}

function isPayProxyGroupName(name) {
  const text = String(name || '');
  if (/注册|register/i.test(text) && !/支付|paypal|payment/i.test(text)) return false;
  return PAY_GROUP_RE.test(text);
}

function isRegisterProxyGroupName(name) {
  const text = String(name || '');
  if (isPayProxyGroupName(text)) return false;
  return /注册|register|\bjp\b|japan/i.test(text);
}

function resolveExtractProxyGroup(groups = [], requested = '') {
  const names = (Array.isArray(groups) ? groups : [])
    .map((item) => (typeof item === 'string' ? item : item?.group_name))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const asked = String(requested || '').trim();
  const payName = names.find((name) => name === '支付')
    || names.find((name) => /支付/.test(name))
    || names.find((name) => isPayProxyGroupName(name))
    || '';
  if (asked) {
    if (!names.includes(asked)) {
      throw protoError('所选代理分组没有代理', { status: 400, code: 'EXTRACT_PROXY_EMPTY' });
    }
    if (!isPayProxyGroupName(asked) || isRegisterProxyGroupName(asked)) {
      throw protoError('GB PayPal 提链/开通只能使用明确的「支付」代理分组，不能使用注册、邮箱、验活或其他分组', {
        status: 400,
        code: 'EXTRACT_PROXY_WRONG_GROUP',
      });
    }
    return asked;
  }
  if (payName) return payName;
  throw protoError('请先添加「支付」代理分组（GB）后再提链', { status: 400, code: 'EXTRACT_PROXY_REQUIRED' });
}

module.exports = {
  EXTRACT_CONCURRENCY_CAP,
  CHATGPT_RETRY_ATTEMPTS,
  PROVIDER_RETRY_ATTEMPTS,
  PAYPAL_FULL_CHECKOUT_ATTEMPTS,
  PAYPAL_URL_POLL_ATTEMPTS,
  GCASH_FAILURE_ATTEMPTS,
  GCASH_ELIGIBILITY_ATTEMPTS,
  CHATGPT_TIMEOUT_MS,
  STRIPE_TIMEOUT_MS,
  CAMPAIGN_ID,
  PLAN_NAME,
  GB,
  GBP,
  CHATGPT_CLIENT_VERSION,
  CHATGPT_CLIENT_BUILD_NUMBER,
  clientVersionFromHtml,
  clientBuildFromHtml,
  applyLiveClientVersion,
  DEFAULT_STRIPE_RUNTIME_VERSION,
  STRIPE_VERSION_FULL,
  STRIPE_VERSION_BASE,
  STRIPE_CLIENT_BETAS,
  GB_PAYPAL,
  GCASH_CHAT,
  gcashChatgptExtra,
  gcashProcessorEntity,
  applyGcashProcessorEntity,
  gcashSentinelHeaders,
  sessionCookieHeader,
  sessionCookieEntries,
  gcashRequestExtra,
  CHATGPT_PAYMENT_COOKIE_NAMES,
  protoError,
  newId,
  randomHex,
  normalizeCountry,
  chatgptAccountIdFromToken,
  accountEmailFromAccessToken,
  chatgptCookieHeader,
  filterChatgptPaymentCookieHeader,
  replaceCookieHeaderValue,
  cookieHeaderToEntries,
  processorEntityForCountry,
  chatgptCheckoutShortUrl,
  chatgptSuccessReturnUrl,
  toOpenaiPayUrl,
  isPaypalUrl,
  isPaypalMeUrl,
  isPaypalBaApproveUrl,
  isPaypalProviderRedirectUrl,
  isStripeHostedCheckoutUrl,
  isIgnoredResourceUrl,
  collectUrls,
  extractRedirectToUrl,
  paypalLinkFromText,
  copyablePaymentLink,
  extractProcessorEntity,
  extractStripePublishableKey,
  parseCheckoutResponse,
  checkoutHasPromoSignal,
  decodeReactRouterFlattenedPayload,
  openaiCheckoutStateFromHtml,
  openaiCheckoutPageAmountMinor,
  isStripeCheckoutSessionId,
  isOaicsSessionId,
  isStripeHostedSessionUrl,
  isStripeCheckoutTicket,
  shouldApproveFirstCheckout,
  checkoutCreateBody,
  checkoutUpdateBody,
  gcashConfirmBody,
  gcashStartBody,
  chatgptCheckoutHeaders,
  redactCheckoutId,
  classifyApproveResult,
  gcashConfirmStatus,
  isGcashConfirmSuccess,
  isGcashConfirmRejected,
  describeGcashConfirm,
  gbBilling,
  phBilling,
  PH_BILLING_PROFILE,
  taxesBody,
  snapshotBody,
  detectedExpectedAmount,
  expectedAmount,
  collectPaymentMethodTypes,
  availablePaymentMethodTypes,
  ensurePaypalAvailable,
  ensureAmountZero,
  ensureCheckoutUpdateAmountZero,
  evaluateCheckoutUpdateResponse,
  inspectCheckoutAmount,
  inspectCheckoutPayableAmount,
  checkoutStateTotalNumbers,
  formatPaymentAmount,
  checkoutUpdateAttemptReason,
  presentCheckoutUpdateFields,
  payloadHasInvalidPromotion,
  findSubmissionAttempt,
  stripeHostedDisplayAmounts,
  stripeHostedExpectedAmounts,
  stripeHostedConfirmUrl,
  stripeInitBody,
  stripeContext,
  stripeElementsClientParams,
  stripeElementsSessionParams,
  stripePaypalPaymentMethodBody,
  stripeConfirmationTokenBody,
  stripeConfirmReturnUrl,
  stripePaymentPageParams,
  stripePaypalCustomConfirmBody,
  stripeHostedConfirmBody,
  stripePaypalTaxRegionBody,
  stripeCustomTaxRegionBody,
  applyCustomTaxRegionAmount,
  stripeIntentConfirmBody,
  intentConfirmPath,
  chatgptHeaders,
  recoverableExtractError,
  classifyCheckoutError,
  checkoutJsonDetail,
  checkoutErrorSnippet,
  looksLikeHtmlChallenge,
  isRetryableStatus,
  isPayProxyGroupName,
  isRegisterProxyGroupName,
  resolveExtractProxyGroup,
  stripeAdditionalElementsParams,
  checkoutResponseAmountMinor,
};
