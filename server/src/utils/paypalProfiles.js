'use strict';

const COUNTRY_NAMES = Object.freeze({
  GB: '英国',
  TH: '泰国',
  BR: '巴西',
  DE: '德国',
  US: '美国',
  FR: '法国',
  NL: '荷兰',
  CA: '加拿大',
  AU: '澳洲',
  JP: '日本',
  VN: '越南',
  MX: '墨西哥',
  TR: '土耳其',
  ES: '西班牙',
  IT: '意大利',
});

const TIMEZONES = Object.freeze({
  GB: 'Europe/London',
  TH: 'Asia/Bangkok',
  BR: 'America/Sao_Paulo',
  DE: 'Europe/Berlin',
  US: 'America/New_York',
  FR: 'Europe/Paris',
  NL: 'Europe/Amsterdam',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
  JP: 'Asia/Tokyo',
  VN: 'Asia/Ho_Chi_Minh',
  MX: 'America/Mexico_City',
  TR: 'Europe/Istanbul',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
});

const CURRENCIES = Object.freeze({
  GB: 'GBP',
  TH: 'THB',
  BR: 'BRL',
  DE: 'EUR',
  US: 'USD',
  FR: 'EUR',
  NL: 'EUR',
  CA: 'CAD',
  AU: 'AUD',
  JP: 'JPY',
  VN: 'VND',
  MX: 'MXN',
  TR: 'USD',
  ES: 'EUR',
  IT: 'EUR',
});

function profile({
  id,
  method_label,
  country,
  country_name,
  currency,
  billingCountry,
  checkoutCountry,
  updateCountry,
  uiMode = 'custom',
  timezone,
  detail,
}) {
  const billing = String(billingCountry || country).toUpperCase();
  const checkout = String(checkoutCountry || country).toUpperCase();
  const update = String(updateCountry || checkout).toUpperCase();
  return Object.freeze({
    id,
    family: 'paypal',
    method: id,
    method_label,
    country,
    country_name: country_name || COUNTRY_NAMES[country] || country,
    currency,
    billingCountry: billing,
    checkoutCountry: checkout,
    updateCountry: update,
    uiMode,
    timezone: timezone || TIMEZONES[checkout] || TIMEZONES[billing] || 'Europe/London',
    result_host: 'paypal.com',
    connected: true,
    probe: id,
    phase: '已接入',
    source: 'monitor',
    detail,
  });
}

const SPECIAL_PAYPAL_CHANNELS = Object.freeze([
  profile({
    id: 'paypal_uk',
    method_label: 'PayPal 英国',
    country: 'GB',
    currency: 'GBP',
    billingCountry: 'GB',
    checkoutCountry: 'GB',
    updateCountry: 'GB',
    timezone: 'Europe/London',
    detail: '独立会话真实探测 GB PayPal。全程 GB sticky。结果只写入监控表，不覆盖账号 extract_link。',
  }),
  profile({
    id: 'paypal_th',
    method_label: 'PayPal 泰国档',
    country: 'TH',
    currency: 'EUR',
    billingCountry: 'DE',
    checkoutCountry: 'TH',
    updateCountry: 'TH',
    timezone: 'Asia/Bangkok',
    detail: '对照 paypal_th：账单 DE/EUR，出口/approve/provider/update 全程 TH sticky。',
  }),
  profile({
    id: 'paypal_hosted',
    method_label: 'PayPal 巴西 Hosted',
    country: 'BR',
    currency: 'BRL',
    billingCountry: 'BR',
    checkoutCountry: 'BR',
    updateCountry: 'BR',
    uiMode: 'hosted',
    timezone: 'America/Sao_Paulo',
    detail: '对照 paypal_hosted：BR/BRL Hosted checkout，出口 BR sticky。巴西 Hosted 仍走 Stripe confirm（参考项目不走普通 Hosted confirm 体）。',
  }),
  profile({
    id: 'paypal',
    method_label: 'PayPal 通用',
    country: 'BR',
    country_name: '巴西出口',
    currency: 'EUR',
    billingCountry: 'DE',
    checkoutCountry: 'BR',
    updateCountry: 'TR',
    timezone: 'America/Sao_Paulo',
    detail: '对照通用 paypal：账单默认 DE/EUR，主出口默认 BR，优惠 update 默认 TR。不是扫 50 国，只跑这一档默认组合。',
  }),
]);

const CURATED_PAYPAL_COUNTRIES = Object.freeze([
  ['US', 'USD'],
  ['DE', 'EUR'],
  ['FR', 'EUR'],
  ['NL', 'EUR'],
  ['CA', 'CAD'],
  ['AU', 'AUD'],
  ['JP', 'JPY'],
  ['VN', 'VND'],
  ['MX', 'MXN'],
  ['TR', 'USD'],
]);

const CURATED_PAYPAL_CHANNELS = Object.freeze(CURATED_PAYPAL_COUNTRIES.map(([code, currency]) => profile({
  id: `paypal_${code.toLowerCase()}`,
  method_label: `PayPal ${COUNTRY_NAMES[code] || code}`,
  country: code,
  currency: currency || CURRENCIES[code],
  billingCountry: code,
  checkoutCountry: code,
  updateCountry: 'TR',
  timezone: TIMEZONES[code],
  detail: `精选 PayPal 国：账单/出口 ${code}/${currency || CURRENCIES[code]}，优惠 update 默认 TR（参考 paypal_update_proxy_country）。`,
})));

const PAYPAL_MONITOR_CHANNELS = Object.freeze([
  ...SPECIAL_PAYPAL_CHANNELS,
  ...CURATED_PAYPAL_CHANNELS,
]);

const PAYPAL_PROFILE_BY_ID = Object.freeze(Object.fromEntries(
  PAYPAL_MONITOR_CHANNELS.map((item) => [item.id, item]),
));

function paypalProfile(channelId) {
  return PAYPAL_PROFILE_BY_ID[String(channelId || '').trim()] || null;
}

function wiredPaypalChannelIds() {
  return PAYPAL_MONITOR_CHANNELS.map((item) => item.id);
}

function defaultPaypalProfile() {
  return paypalProfile('paypal_uk');
}

function resolvePaypalProfile(value) {
  if (typeof value === 'string' && paypalProfile(value)) return paypalProfile(value);
  if (value && typeof value === 'object') {
    const billingCountry = String(value.billingCountry || value.country || 'GB').toUpperCase();
    const checkoutCountry = String(value.checkoutCountry || billingCountry).toUpperCase();
    return {
      id: String(value.id || 'paypal_uk'),
      billingCountry,
      currency: String(value.currency || CURRENCIES[billingCountry] || 'GBP').toUpperCase(),
      checkoutCountry,
      updateCountry: String(value.updateCountry || checkoutCountry).toUpperCase(),
      uiMode: String(value.uiMode || 'custom').toLowerCase() === 'hosted' ? 'hosted' : 'custom',
      timezone: value.timezone || TIMEZONES[checkoutCountry] || TIMEZONES[billingCountry] || 'Europe/London',
    };
  }
  return defaultPaypalProfile();
}

module.exports = {
  COUNTRY_NAMES,
  CURRENCIES,
  TIMEZONES,
  SPECIAL_PAYPAL_CHANNELS,
  CURATED_PAYPAL_CHANNELS,
  PAYPAL_MONITOR_CHANNELS,
  paypalProfile,
  wiredPaypalChannelIds,
  defaultPaypalProfile,
  resolvePaypalProfile,
};
