'use strict';

const { SmsBowerClient, resolveSmsbowerConfig, DEFAULT_API_URL } = require('../smsbower');
const { RtLoginError, cuteSmsError } = require('./parse');

const OPENAI_RT_COUNTRY = 'CL';
const OPENAI_RT_SERVICE = 'dr';

function paymentSmsCredentials(settings = {}) {
  const sms = settings.sms || {};
  const bower = settings.smsbower || {};
  const smsKey = String(sms.api_key || sms.apiKey || '').trim();
  const bowerKey = String(bower.api_key || bower.apiKey || '').trim();
  if (smsKey) {
    return {
      api_key: smsKey,
      api_url: sms.api_url || sms.apiUrl || bower.api_url || bower.apiUrl || DEFAULT_API_URL,
      max_price: sms.max_price ?? bower.max_price,
    };
  }
  return {
    api_key: bowerKey,
    api_url: bower.api_url || bower.apiUrl || sms.api_url || DEFAULT_API_URL,
    max_price: bower.max_price ?? sms.max_price,
  };
}

function createRtSmsClient(settings = {}, { cancelled, log, fetchImpl } = {}) {
  const source = paymentSmsCredentials(settings);
  let cfg;
  try {
    cfg = resolveSmsbowerConfig(source, { countryFallback: OPENAI_RT_COUNTRY, serviceFallback: OPENAI_RT_SERVICE });
  } catch (error) {
    throw new RtLoginError(cuteSmsError(error), error.code || 'SMS_KEY_MISSING', { cause: error });
  }
  const maxRaw = source.max_price;
  const maxPrice = maxRaw === '' || maxRaw == null || Number(maxRaw) === 0 ? null : Number(maxRaw);
  try {
    return new SmsBowerClient({
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      country: OPENAI_RT_COUNTRY,
      service: OPENAI_RT_SERVICE,
      maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
      timeoutSeconds: 180,
      pollInterval: 3,
      cancelled: typeof cancelled === 'function' ? cancelled : () => false,
      statusCallback: typeof log === 'function' ? log : null,
      fetchImpl,
    });
  } catch (error) {
    throw new RtLoginError(cuteSmsError(error), error.code || 'SMS_CLIENT_FAILED', { cause: error });
  }
}

function assertRtSmsConfigured(settings = {}) {
  createRtSmsClient(settings, { cancelled: () => false, log() {} });
  return true;
}

module.exports = {
  OPENAI_RT_COUNTRY,
  OPENAI_RT_SERVICE,
  paymentSmsCredentials,
  createRtSmsClient,
  assertRtSmsConfigured,
};
