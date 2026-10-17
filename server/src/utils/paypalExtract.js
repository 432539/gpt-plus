const crypto = require('node:crypto');
const { promoCampaignId } = require('./accountCheck');
const {
  CHATGPT_RETRY_ATTEMPTS,
  PROVIDER_RETRY_ATTEMPTS,
  PAYPAL_FULL_CHECKOUT_ATTEMPTS,
  PAYPAL_URL_POLL_ATTEMPTS,
  CHATGPT_TIMEOUT_MS,
  STRIPE_TIMEOUT_MS,
  CAMPAIGN_ID,
  GB,
  GBP,
  GB_PAYPAL,
  protoError,
  newId,
  chatgptAccountIdFromToken,
  accountEmailFromAccessToken,
  chatgptCookieHeader,
  cookieHeaderToEntries,
  processorEntityForCountry,
  chatgptCheckoutShortUrl,
  isPaypalBaApproveUrl,
  isPaypalProviderRedirectUrl,
  isStripeHostedCheckoutUrl,
  extractRedirectToUrl,
  paypalLinkFromText,
  copyablePaymentLink,
  extractStripePublishableKey,
  parseCheckoutResponse,
  openaiCheckoutStateFromHtml,
  isStripeCheckoutSessionId,
  isOaicsSessionId,
  isStripeCheckoutTicket,
  shouldApproveFirstCheckout,
  checkoutCreateBody,
  checkoutUpdateBody,
  chatgptCheckoutHeaders,
  redactCheckoutId,
  classifyApproveResult,
  gbBilling,
  snapshotBody,
  ensurePaypalAvailable,
  ensureAmountZero,
  evaluateCheckoutUpdateResponse,
  findSubmissionAttempt,
  stripeInitBody,
  stripeContext,
  stripeElementsSessionParams,
  stripePaypalPaymentMethodBody,
  stripeConfirmationTokenBody,
  stripePaypalTaxRegionBody,
  stripeCustomTaxRegionBody,
  applyCustomTaxRegionAmount,
  stripeIntentConfirmBody,
  stripePaypalCustomConfirmBody,
  stripeHostedConfirmBody,
  stripePaymentPageParams,
  intentConfirmPath,
  toOpenaiPayUrl,
  chatgptHeaders,
  recoverableExtractError,
  classifyCheckoutError,
  looksLikeHtmlChallenge,
} = require('./paymentLink');
const { EXTRACT_BROWSER, EXTRACT_USER_AGENT, EXTRACT_CHROME_PROFILES, withExtractSession, randomChromeFingerprint, chromeFingerprintFor, isUnsupportedImpersonateError, rememberUnsupportedImpersonate } = require('./extractHttp');
const { freshStickyProxy, maskStickyUsername } = require('./stickyProxy');
const { defaultPaypalProfile, resolvePaypalProfile } = require('./paypalProfiles');

const CHATGPT_ORIGIN = 'https://chatgpt.com/';
const STRIPE_JS_ORIGIN = 'https://js.stripe.com/';
const CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const CHECKOUT_PATH = '/backend-api/payments/checkout';
const ELIGIBILITY_RETRIES = 1;
const ELIGIBILITY_COUNTRIES = Object.freeze(['GB']);
const CLOUDFLARE_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const ADDRESSGEN_API_URL = process.env.OPENAI_PAY_ADDRESSGEN_API_URL || 'https://addressgen.top/api/v1/address';
const ADDRESSGEN_TIMEOUT_MS = Math.max(1000, Number(process.env.OPENAI_PAY_ADDRESSGEN_API_TIMEOUT || 5) * 1000);
const CHECKOUT_PROXY_SPACING_MS = 2500;
const checkoutProxyQueues = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function proxyIdentity(proxy) {
  const username = maskStickyUsername(proxy?.username);
  return `${proxy?.host || ''}:${proxy?.port || ''}:${username}`;
}

function proxyForRegion(proxy, country) {
  if (!proxy) return proxy;
  const region = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) return { ...proxy };
  let username = String(proxy.username || '');
  username = username
    .replace(/region-[A-Za-z]{2}/g, `region-${region}`)
    .replace(/-res-(?:[A-Za-z]{2}|any)(?=-Lsid-)/ig, `-res-${region}`)
    .replace(/_g-[A-Za-z]{2}/g, `_g-${region}`)
    .replace(/-res-(?:[A-Za-z]{2}|any)$/i, `-res-${region.toLowerCase()}`);
  const numericSession = String(crypto.randomInt(10_000_000, 100_000_000));
  const hasRegionSid = /-region-[A-Za-z]{2}-sid-[A-Za-z0-9_-]+-t-\d+$/i.test(username);
  if (/region-[A-Za-z]{2}/.test(username) && !hasRegionSid) {
    username = /session-\d+/.test(username)
      ? username.replace(/session-\d+/, `session-${numericSession}`)
      : `${username}-session-${numericSession}`;
  }
  if (/_g-[A-Za-z]{2}_f-\d+_sid-\d+_l-\d+$/.test(username)) {
    username = username.replace(/_sid-\d+/, `_sid-${numericSession}`);
  }
  return freshStickyProxy({ ...proxy, username });
}

function cloudflareTraceCountry(text) {
  const match = String(text || '').match(/(?:^|\n)loc=([A-Za-z]{2})(?:\n|$)/);
  return String(match?.[1] || '').toUpperCase();
}

async function verifyProxyCountry(session, country, emit, label = '资格') {
  const response = await session.request(CLOUDFLARE_TRACE_URL, {
    method: 'GET',
    headers: { 'x-gpt-plus-proxy-country-check': country },
    timeout: CHATGPT_TIMEOUT_MS,
  });
  const status = Number(response.status) || 0;
  if (status >= 400) {
    throw protoError(`${country} ${label}代理出口预检 HTTP ${status}`, {
      status,
      code: 'ELIGIBILITY_PROXY_PREFLIGHT',
      recoverable: true,
    });
  }
  const actualCountry = cloudflareTraceCountry(response.text);
  if (actualCountry !== country) {
    throw protoError(`${country} ${label}代理真实出口不匹配：${actualCountry || '未知'}`, {
      status: 502,
      code: 'ELIGIBILITY_PROXY_COUNTRY',
      recoverable: true,
    });
  }
  emit('proxy', `${country} ${label}代理真实出口地理校验通过。`);
}

async function serializeCheckout(proxy, handler, spacingMs = CHECKOUT_PROXY_SPACING_MS) {
  const key = proxyIdentity(proxy);
  const previous = checkoutProxyQueues.get(key) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => turn);
  checkoutProxyQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await handler();
  } finally {
    if (spacingMs > 0) await sleep(spacingMs);
    release();
    if (checkoutProxyQueues.get(key) === queued) checkoutProxyQueues.delete(key);
  }
}

function cancelledError() {
  return protoError('任务已取消', { code: 'JOB_CANCELLED' });
}

function staleCheckoutError(error) {
  const detail = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /checkout_not_active|inactive_session|session.*expir|checkout 已失效/.test(detail);
}

function assertActive(cancelled) {
  if (cancelled?.()) throw cancelledError();
}

function compactText(value, limit = 280) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function responseDetail(response) {
  return compactText(response?.data?.detail || response?.data?.error?.message || response?.text);
}

function cookieNameValue(header, name) {
  const target = String(name || '');
  if (!target) return '';
  for (const item of String(header || '').split(';')) {
    const trimmed = item.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0 && trimmed.slice(0, eq).trim() === target) return trimmed.slice(eq + 1).trim();
  }
  return '';
}

function resolveExtractDeviceId(detail) {
  const explicit = String(detail?.device_id || '').trim();
  if (explicit) return explicit;
  const raw = String(detail?.session_token || '').trim();
  if (raw.includes('=')) {
    const did = cookieNameValue(raw, 'oai-did');
    if (did) return did;
  }
  return newId();
}

function isMethodNotAllowed(response, error) {
  const status = Number(response?.status || error?.status) || 0;
  const detail = `${responseDetail(response) || error?.message || ''}`.toLowerCase();
  return status === 405 || /method not allowed/.test(detail);
}

function dropContentType(headers = {}) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'content-type') delete next[key];
  }
  return next;
}

function eligibilityFailedError(message, extra = {}) {
  return protoError(message, {
    status: extra.status || 502,
    code: extra.code || 'ACCOUNT_ELIGIBILITY_CHECK',
    recoverable: extra.recoverable === true,
    skip: extra.skip === true,
  });
}

function stripePublishableKey(checkout, extra) {
  return String(
    checkout?.stripe_publishable_key
    || extractStripePublishableKey(extra)
    || extractStripePublishableKey(checkout)
    || '',
  ).trim();
}

function applyElementsContext(ctx, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.session_id || payload.id) ctx.elements_session_id = String(payload.session_id || payload.id);
  if (payload.config_id) {
    ctx.elements_session_config_id = String(payload.config_id);
    ctx.config_id = String(payload.config_id);
  }
  const customer = payload.customer && typeof payload.customer === 'object' ? payload.customer : {};
  const customerSession = customer.customer_session && typeof customer.customer_session === 'object'
    ? customer.customer_session
    : {};
  if (customerSession.customer) ctx.customer_id = String(customerSession.customer);
  return payload;
}

function raiseIfSubmissionFailed(payload, label) {
  const submission = findSubmissionAttempt(payload);
  const state = String(submission?.state || '').toLowerCase();
  if (['failed', 'canceled', 'cancelled'].includes(state)) {
    throw protoError(`${label} submission_state=${state}`, { status: 409, code: 'STRIPE_RISK_RETRYABLE', recoverable: true });
  }
  const blob = compactText(JSON.stringify(payload || {})).toLowerCase();
  if (blob.includes('generic_decline') || blob.includes('setup_attempt_failed')) {
    throw protoError(`${label} 被 Stripe generic_decline 拒绝`, { status: 409, code: 'STRIPE_RISK_RETRYABLE', recoverable: true });
  }
}

function mergeCheckout(checkout, payload) {
  if (!payload || typeof payload !== 'object') return checkout;
  const next = { ...checkout };
  if (payload.processor_entity) next.processor_entity = String(payload.processor_entity);
  const pk = extractStripePublishableKey(payload);
  if (pk) next.stripe_publishable_key = pk;
  try {
    const parsed = parseCheckoutResponse({
      ...payload,
      checkout_session_id: checkout.cs_id,
      id: checkout.cs_id,
    }, checkout.billing_country, checkout.currency, false);
    return {
      ...next,
      ...parsed,
      cs_id: checkout.cs_id,
      chatgpt_account_id: next.chatgpt_account_id || checkout.chatgpt_account_id || '',
      processor_entity: parsed.processor_entity || next.processor_entity || checkout.processor_entity || '',
      stripe_publishable_key: parsed.stripe_publishable_key || next.stripe_publishable_key || checkout.stripe_publishable_key || '',
      custom_payment_methods: (parsed.custom_payment_methods && parsed.custom_payment_methods.length)
        ? parsed.custom_payment_methods
        : (next.custom_payment_methods || checkout.custom_payment_methods || []),
      payment_method_types: (parsed.payment_method_types && parsed.payment_method_types.length)
        ? parsed.payment_method_types
        : (next.payment_method_types || checkout.payment_method_types || []),
    };
  } catch {
    return next;
  }
}

async function openaiCheckoutPageAmountMinor(session, checkout) {
  const url = chatgptCheckoutShortUrl(
    checkout.cs_id,
    checkout.billing_country,
    checkout.processor_entity,
  );
  const response = await session.request(url, {
    method: 'GET',
    headers: { Referer: CHATGPT_ORIGIN },
    timeout: CHATGPT_TIMEOUT_MS,
  });
  if (Number(response.status) >= 400) {
    throw protoError(`OpenAI checkout 页面金额查询失败: ${responseDetail(response)}`, {
      status: response.status || 502,
      recoverable: true,
    });
  }
  const state = openaiCheckoutStateFromHtml(response.text);
  const totalSummary = state?.total;
  const total = totalSummary?.total && typeof totalSummary.total === 'object'
    ? totalSummary.total
    : totalSummary;
  const amount = total?.minorUnitsAmount;
  const currency = String(state?.currency || checkout.currency || '').toUpperCase();
  if (amount == null) return { amount: null, currency };
  const parsed = Number(amount);
  if (!Number.isInteger(parsed)) {
    throw protoError(`OpenAI checkout 页面金额无法解析: ${String(amount)}`, {
      status: 502,
      recoverable: true,
    });
  }
  return { amount: parsed, currency };
}

async function billingForPaypalCountry(country, accountEmail = '', fetchImpl) {
  const normalizedCountry = String(country || GB).trim().toUpperCase() || GB;
  const fallback = gbBilling({ email: accountEmail || undefined });
  try {
    const client = typeof fetchImpl === 'function' ? fetchImpl : require('undici').fetch;
    const target = new URL(ADDRESSGEN_API_URL);
    target.searchParams.set('country_code', normalizedCountry.toLowerCase());
    const options = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': EXTRACT_USER_AGENT,
      },
      timeout: ADDRESSGEN_TIMEOUT_MS,
    };
    if (typeof AbortSignal?.timeout === 'function') options.signal = AbortSignal.timeout(ADDRESSGEN_TIMEOUT_MS);
    const response = await client(target.toString(), options);
    const status = Number(response?.status) || 0;
    if (status >= 400) throw new Error(`addressgen HTTP ${status}`);
    let payload = response?.data;
    if (!payload && typeof response?.json === 'function') payload = await response.json();
    if (!payload && response?.text) payload = JSON.parse(String(response.text));
    const data = payload?.data;
    const address = data?.address;
    if (!data || typeof data !== 'object' || !address || typeof address !== 'object') {
      throw new Error('addressgen response missing data.address');
    }
    const responseCountry = String(address.country_code || '').trim().toUpperCase();
    if (responseCountry && responseCountry !== normalizedCountry) {
      throw new Error(`addressgen returned country ${responseCountry}`);
    }
    const street = String(address.street || '').trim() || [
      address.street_name,
      address.building_number,
    ].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
    const city = String(address.city || '').trim();
    const postalCode = String(address.zipcode || '').trim();
    if (!street || !city || !postalCode) throw new Error('addressgen response missing address fields');
    const generatedName = [data.firstname, data.lastname]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
    return {
      name: generatedName || fallback.name,
      email: accountEmail || (String(data.email || '').includes('@') ? String(data.email).trim() : fallback.email),
      phone: String(data.phone || '').trim() || fallback.phone,
      tax_id: String(data.tax_id || '').trim(),
      country: normalizedCountry,
      line1: street,
      line2: String(address.line2 || '').trim(),
      city,
      state: String(address.state || '').trim() || fallback.state,
      postal_code: postalCode,
    };
  } catch {
    return fallback;
  }
}

async function withRetries(attempts, cancelled, fn) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertActive(cancelled);
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (error?.skip || error?.code === 'JOB_CANCELLED' || !recoverableExtractError(error) || attempt >= attempts) {
        throw error;
      }
    }
  }
  throw lastError;
}

function chatgptRequestHeaders(detail, deviceId, sessionId, extra = {}, { includeAccountId = false, fingerprint } = {}) {
  return chatgptHeaders({
    accessToken: detail.access_token,
    deviceId,
    sessionId,
    accountId: includeAccountId
      ? (detail.chatgpt_account_id || chatgptAccountIdFromToken(detail.access_token))
      : '',
    extra,
    fingerprint,
  });
}

async function chatgptRequest(session, detail, deviceId, sessionId, path, {
  method = 'POST', json, extra = {}, timeout = CHATGPT_TIMEOUT_MS, includeAccountId = false,
} = {}) {
  const verb = String(method || 'POST').toUpperCase();
  let headers = chatgptRequestHeaders(detail, deviceId, sessionId, extra, {
    includeAccountId,
    fingerprint: session?.fingerprint,
  });
  if (verb === 'GET' || verb === 'HEAD') headers = dropContentType(headers);
  const options = {
    method: verb,
    headers,
    timeout,
    contextUrl: CHATGPT_ORIGIN,
    referrer: extra.Referer || CHATGPT_ORIGIN,
  };
  if (verb !== 'GET' && verb !== 'HEAD' && json !== undefined) options.json = json;
  return session.request(`https://chatgpt.com${path}`, options);
}

async function stripeRequest(session, path, { method = 'POST', form, params, extra = {}, timeout = STRIPE_TIMEOUT_MS } = {}) {
  return session.request(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(extra.Origin ? { Origin: extra.Origin } : {}),
      ...(extra.Referer ? { Referer: extra.Referer } : {}),
    },
    form,
    params,
    timeout,
    contextUrl: STRIPE_JS_ORIGIN,
    referrer: extra.Referer || STRIPE_JS_ORIGIN,
  });
}

async function seedSession(session, detail, deviceId) {
  const cookies = cookieHeaderToEntries(chatgptCookieHeader({
    sessionCookie: detail.session_token || '',
    deviceId,
  }));
  if (cookies.length && typeof session.seedCookies === 'function') {
    await session.seedCookies(cookies);
  }
}

async function checkEligibility(
  session,
  detail,
  deviceId,
  sessionId,
  emit,
  cancelled,
  cache = {},
  { eligibilityRequest, exitCountry } = {},
) {
  const accountId = detail.chatgpt_account_id || chatgptAccountIdFromToken(detail.access_token);
  if (!accountId) {
    emit('eligibility', '当前凭据未解析到 ChatGPT-Account-ID，跳过资格接口检查。');
    return { skipped: true };
  }
  if (String(cache.promo_campaign_id || '').toLowerCase() === CAMPAIGN_ID) {
    emit('eligibility', `资格预检已通过：复用 ${cache.country || '已缓存'} 结果，后续重试不再重复检查。`);
    return cache;
  }
  const errors = [];
  const noCampaignCountries = [];
  for (const country of ELIGIBILITY_COUNTRIES) {
    for (let attempt = 1; attempt <= ELIGIBILITY_RETRIES; attempt += 1) {
      assertActive(cancelled);
      const exit = String(exitCountry || country || '').trim().toUpperCase() || country;
      emit('eligibility', `正在通过 ${exit} 代理检查试用资格（${attempt}/${ELIGIBILITY_RETRIES}）。`);
      try {
        const send = (activeSession) => chatgptRequest(
          activeSession,
          detail,
          deviceId,
          sessionId,
          CHECK_PATH,
          {
            method: 'GET',
            extra: {
              Accept: 'application/json',
              Origin: 'https://chatgpt.com',
              Referer: CHATGPT_ORIGIN,
            },
            includeAccountId: true,
          },
        );
        const response = typeof eligibilityRequest === 'function'
          ? await eligibilityRequest(country, attempt, send)
          : await send(session);
        const status = Number(response.status) || 0;
        if (status === 401) {
          throw protoError('账号 Token 已被作废，请重新导入有效的 Access Token', {
            status: 401, code: 'ACCOUNT_TOKEN_INVALIDATED', skip: true,
          });
        }
        if (isMethodNotAllowed(response)) {
          throw eligibilityFailedError(
            `资格接口 HTTP 405 Method Not Allowed：应对 ${CHECK_PATH} 使用 GET，已中止提链（不会继续创建 checkout）`,
            { status: 405, recoverable: false },
          );
        }
        if (status >= 400 || looksLikeHtmlChallenge(response.text)) {
          throw protoError(responseDetail(response) || `HTTP ${status}`, {
            status,
            recoverable: true,
          });
        }
        let payload;
        try {
          payload = response.data && typeof response.data === 'object'
            ? response.data
            : JSON.parse(response.text || '{}');
        } catch {
          throw protoError(`${country} 资格接口返回非 JSON`, {
            status: 502,
            recoverable: true,
          });
        }
        const campaign = promoCampaignId(payload, accountId);
        if (String(campaign || '').trim().toLowerCase() === CAMPAIGN_ID) {
          emit('eligibility', `资格预检完成：${country} 确认账号可使用 ${campaign}。`);
          Object.assign(cache, { country, promo_campaign_id: campaign });
          return cache;
        }
        noCampaignCountries.push(country);
        break;
      } catch (error) {
        if (error?.skip || error?.code === 'JOB_CANCELLED') throw error;
        if (isMethodNotAllowed(null, error) || error?.recoverable === false) throw error;
        errors.push(`${country} 第 ${attempt}/${ELIGIBILITY_RETRIES} 次：${compactText(error.message, 160)}`);
        if (!recoverableExtractError(error) || attempt >= ELIGIBILITY_RETRIES) break;
      }
    }
  }
  if (noCampaignCountries.length === ELIGIBILITY_COUNTRIES.length) {
    throw protoError('账号没有 plus-1-month-free 试用资格', {
      status: 409,
      code: 'ACCOUNT_NOT_ELIGIBLE',
      recoverable: false,
    });
  }
  throw eligibilityFailedError(`资格接口检查失败：${errors.join('；') || 'GB 未返回有效结果'}`, {
    recoverable: true,
  });
}

async function createCheckout(session, detail, deviceId, sessionId, emit, cancelled, proxy, profile = defaultPaypalProfile()) {
  const body = checkoutCreateBody({
    country: profile.billingCountry || GB,
    currency: profile.currency || GBP,
    uiMode: profile.uiMode || GB_PAYPAL.checkoutUiMode,
    promoEnabled: false,
  });
  assertActive(cancelled);
  return serializeCheckout(proxy, async () => {
    emit('checkout', `正在创建 ChatGPT checkout（${profile.billingCountry || GB}/${profile.currency || GBP}，${profile.uiMode || 'custom'}）。`);
    const response = await chatgptRequest(session, detail, deviceId, sessionId, CHECKOUT_PATH, {
      method: 'POST',
      json: body,
      extra: {
        Referer: CHATGPT_ORIGIN,
        'x-openai-target-path': CHECKOUT_PATH,
        'x-openai-target-route': CHECKOUT_PATH,
      },
    });
    if (Number(response.status) >= 400 || !response.data) {
      const error = classifyCheckoutError(response);
      emit('checkout', compactText(error.message, 240));
      throw error;
    }
    const checkout = parseCheckoutResponse(response.data, profile.billingCountry || GB, profile.currency || GBP, false);
    checkout.chatgpt_account_id = detail.chatgpt_account_id || chatgptAccountIdFromToken(detail.access_token) || '';
    emit('checkout', `checkout 创建成功：${redactCheckoutId(checkout.cs_id)} / ${checkout.billing_country} / ${checkout.currency}。`);
    return checkout;
  }, session.transport === 'curl_cffi' ? CHECKOUT_PROXY_SPACING_MS : 0);
}

async function updateCheckoutPromotion(session, detail, deviceId, sessionId, checkout, emit, cancelled, profile = defaultPaypalProfile()) {
  const path = '/backend-api/payments/checkout/update';
  const body = checkoutUpdateBody(checkout.cs_id, checkout.processor_entity, profile.billingCountry || GB);
  const updateCountry = profile.updateCountry || profile.checkoutCountry || GB;
  return withRetries(CHATGPT_RETRY_ATTEMPTS, cancelled, async (attempt) => {
    emit('promotion', `正在通过 ${updateCountry} 调用 checkout/update（${attempt}/${CHATGPT_RETRY_ATTEMPTS}）。`);
    const response = await chatgptRequest(session, detail, deviceId, sessionId, path, {
      json: body,
      extra: chatgptCheckoutHeaders(checkout, path),
    });
    const status = Number(response.status) || 0;
    const evaluated = evaluateCheckoutUpdateResponse(status, response.data, response.text, {
      currency: profile.currency || GBP,
    });
    emit('promotion', `checkout/update ${evaluated.logReason}。`);
    if (!evaluated.ok) {
      if (evaluated.code === 'PAYMENT_AMOUNT_NOT_ZERO' && isStripeCheckoutSessionId(checkout.cs_id)) {
        emit('promotion', 'cs_ PayPal checkout/update 返回了非零金额字段；按参考流程忽略该阶段金额，延后到 Stripe init 最终确认。');
        return mergeCheckout(checkout, response.data);
      }
      throw protoError(evaluated.message, {
        status: evaluated.status || status || 502,
        code: evaluated.code || 'CHECKOUT_PROMOTION',
        recoverable: evaluated.recoverable === true,
      });
    }
    const merged = mergeCheckout(checkout, response.data);
    if (evaluated.amount === 0) merged.checkout_amount_minor = 0;
    if (evaluated.deferred && isOaicsSessionId(merged.cs_id)) {
      const pageAmount = await openaiCheckoutPageAmountMinor(session, merged);
      if (pageAmount.amount == null) {
        emit('promotion', 'GB checkout/update HTTP 200 已接受优惠更新；页面载荷也未返回金额，延后到 Stripe init 确认 0 元。');
      } else if (pageAmount.amount !== 0) {
        throw protoError(
          `checkout/update 后支付金额不是0元，页面载荷金额=${pageAmount.amount} ${pageAmount.currency || GBP}，已停止流程。`,
          { status: 409, code: 'PAYMENT_AMOUNT_NOT_ZERO', recoverable: false },
        );
      } else {
        merged.checkout_amount_minor = 0;
        emit('promotion', 'checkout/update 未返回金额，已从 OpenAI checkout 页面载荷确认支付金额为 0。');
      }
    } else if (evaluated.deferred) {
      emit('promotion', 'GB checkout/update HTTP 200 已接受优惠更新；cs_ PayPal 按参考流程延后到 Stripe init 确认 0 元。');
    } else {
      emit('promotion', `GB checkout/update 金额检测通过：${evaluated.formatted}。`);
    }
    return merged;
  });
}

async function submitTaxes(session, detail, deviceId, sessionId, checkout, billing, emit, extraHeaders = {}, options = {}) {
  const path = '/backend-api/payments/checkout/taxes';
  const extra = { ...chatgptCheckoutHeaders(checkout, path), ...extraHeaders };
  const response = await chatgptRequest(session, detail, deviceId, sessionId, path, {
    json: {
      checkout_session_id: checkout.cs_id,
      checkout_email: billing.email || '',
      billing_country: billing.country || GB,
      billing_name: billing.name || '',
      currency: String(checkout.currency || GBP).toUpperCase(),
      tax_id: null,
      processor_entity: processorEntityForCountry(checkout.billing_country || GB, checkout.processor_entity),
      billing_address: {
        country: billing.country || GB,
        line1: billing.line1 || '',
        line2: billing.line2 || '',
        city: billing.city || '',
        state: billing.state || '',
        postal_code: billing.postal_code || '',
      },
    },
    extra,
    includeAccountId: options.includeAccountId === true,
  });
  if (Number(response.status) >= 400) {
    throw protoError(`chatgpt checkout taxes failed: ${responseDetail(response)}`, {
      status: response.status || 502,
      recoverable: true,
    });
  }
  emit('billing', `账单已提交：${billing.country} ${billing.city}。`);
}

async function snapshotBilling(session, detail, deviceId, sessionId, checkout, billing, extraHeaders = {}, options = {}) {
  const path = '/backend-api/payments/checkout/snapshot';
  await chatgptRequest(session, detail, deviceId, sessionId, path, {
    json: snapshotBody(billing),
    extra: { ...chatgptCheckoutHeaders(checkout, path), ...extraHeaders },
    includeAccountId: options.includeAccountId === true,
  }).catch(() => {});
}

async function chatgptApprove(session, detail, deviceId, sessionId, checkout, emit, cancelled) {
  let last;
  for (let attempt = 1; attempt <= CHATGPT_RETRY_ATTEMPTS; attempt += 1) {
    assertActive(cancelled);
    const attemptSessionId = attempt === 1 ? sessionId : newId();
    emit('approve', `approve 第 ${attempt}/${CHATGPT_RETRY_ATTEMPTS} 次：${attempt === 1 ? '复用 checkout 会话' : '更换 oai-session-id 后重试'}。`);
    await chatgptRequest(session, detail, deviceId, attemptSessionId, '/backend-api/sentinel/ping', {
      json: {},
      extra: {
        Referer: CHATGPT_ORIGIN,
        'x-openai-target-path': '/backend-api/sentinel/ping',
        'x-openai-target-route': '/backend-api/sentinel/ping',
      },
    }).catch(() => {});
    emit('approve', `正在使用同一个全程代理提交 approve。`);
    const path = '/backend-api/payments/checkout/approve';
    const response = await chatgptRequest(session, detail, deviceId, attemptSessionId, path, {
      json: {
        checkout_session_id: checkout.cs_id,
        processor_entity: processorEntityForCountry(checkout.billing_country || GB, checkout.processor_entity),
      },
      extra: chatgptCheckoutHeaders(checkout, path),
    });
    last = classifyApproveResult(response.data, response.status);
    if (last.ok) {
      emit('approve', 'ChatGPT approve 已通过，继续轮询 PayPal 跳转链（BA approve 优先）。');
      return response.data || { result: last.result };
    }
    if (last.rebuild) {
      const reason = last.result || (last.http >= 400 ? `HTTP ${last.http}` : 'blocked');
      emit('approve', `approve 返回 ${reason}，作废 checkout 并重建（更换 GB sticky 与 TLS 指纹）。`);
      throw protoError(last.message, {
        status: 409,
        code: last.code,
        recoverable: true,
        http: last.http,
      });
    }
    if (last.retryable && attempt < CHATGPT_RETRY_ATTEMPTS) {
      emit('approve', `approve 第 ${attempt} 次被 ChatGPT 拒绝或返回异常页面，准备更换会话重试：${last.message}`);
      continue;
    }
    break;
  }
  throw protoError(
    `ChatGPT approve 连续 ${CHATGPT_RETRY_ATTEMPTS} 次失败，当前 checkout 已作废: ${last?.message || "chatgpt approve unexpected result: 'blocked'"}`,
    {
      status: 504,
      code: last?.code || 'CHECKOUT_APPROVE_BLOCKED',
      recoverable: true,
    },
  );
}

async function stripeElements(stripeSession, checkout, ctx, emit, reuse = false) {
  const pk = stripePublishableKey(checkout);
  if (!pk) throw protoError('checkout 未返回 Stripe publishable key', { status: 502, recoverable: true });
  const params = stripeElementsSessionParams(checkout, ctx, pk);
  if (reuse && ctx.elements_session_id) params.session_id = ctx.elements_session_id;
  const response = await stripeRequest(stripeSession, '/v1/elements/sessions', { method: 'GET', params });
  if (Number(response.status) >= 400) {
    throw protoError(`Stripe Elements session failed: ${responseDetail(response)}`, {
      status: response.status || 502,
      recoverable: true,
    });
  }
  applyElementsContext(ctx, response.data);
  emit('elements', `Stripe Elements session 已初始化：${ctx.elements_session_id || 'unknown'}。`);
  return response.data || {};
}

async function stripeInit(stripeSession, checkout, emit, options = {}) {
  const pk = stripePublishableKey(checkout);
  if (!pk) throw protoError('checkout 未返回 Stripe publishable key', { status: 502, recoverable: true });
  const stripeJsId = newId();
  const response = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}/init`, {
    form: stripeInitBody({
      stripePk: pk,
      stripeJsId,
      timezone: options.timezone || GB_PAYPAL.timezone,
      hosted: options.hosted === true,
    }),
  });
  if (Number(response.status) >= 400) {
    throw protoError(`stripe init failed: ${responseDetail(response)}`, {
      status: response.status || 502,
      recoverable: true,
    });
  }
  const payload = response.data && typeof response.data === 'object' ? response.data : {};
  payload._local_client_context = { ...(payload._local_client_context || {}), stripe_js_id: stripeJsId };
  emit('stripe_init', 'Stripe payment page 初始化成功。');
  return payload;
}

async function createPaymentMethod(stripeSession, checkout, ctx, billing) {
  const pk = stripePublishableKey(checkout);
  const response = await stripeRequest(stripeSession, '/v1/payment_methods', {
    form: stripePaypalPaymentMethodBody(checkout.cs_id, pk, billing, ctx),
  });
  if (Number(response.status) >= 400) {
    throw protoError(`stripe payment_methods failed: ${responseDetail(response)}`, {
      status: response.status || 502,
      recoverable: true,
    });
  }
  const pmId = String(response.data?.id || '');
  if (!pmId.startsWith('pm_')) {
    throw protoError('stripe payment_methods 未返回 pm_ id', { status: 502, recoverable: true });
  }
  return pmId;
}

async function createConfirmationToken(stripeSession, checkout, ctx, billing) {
  const pk = stripePublishableKey(checkout);
  const response = await stripeRequest(stripeSession, '/v1/confirmation_tokens', {
    form: stripeConfirmationTokenBody(checkout, pk, ctx, billing),
  });
  if (Number(response.status) >= 400) {
    throw protoError(`stripe confirmation_tokens failed: ${responseDetail(response)}`, {
      status: response.status || 502,
      recoverable: true,
    });
  }
  const tokenId = String(response.data?.id || '');
  if (!tokenId.startsWith('ctoken_')) {
    throw protoError('stripe confirmation_tokens 未返回 ctoken_', { status: 502, recoverable: true });
  }
  return tokenId;
}

async function pollPaypalRedirect(stripeSession, checkout, stripePk, ctx, emit, cancelled, { afterApprove = false } = {}) {
  const params = stripePaymentPageParams(stripePk, ctx);
  let lastErr = '';
  for (let attempt = 1; attempt <= PAYPAL_URL_POLL_ATTEMPTS; attempt += 1) {
    assertActive(cancelled);
    const response = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}`, { method: 'GET', params });
    if (Number(response.status) === 200) {
      const payload = response.data || {};
      const redirect = extractRedirectToUrl(payload);
      if (redirect) return redirect;
      const submission = findSubmissionAttempt(payload);
      const state = String(submission.state || '').toLowerCase();
      if (state === 'requires_approval' && !afterApprove) {
        throw protoError('payment page requires ChatGPT approval', { status: 409, code: 'STRIPE_REQUIRES_APPROVAL', recoverable: true });
      }
      if (['failed', 'canceled', 'cancelled'].includes(state)) {
        throw protoError(`Stripe submission_state=${state}`, { status: 409, code: 'STRIPE_RISK_RETRYABLE', recoverable: true });
      }
      lastErr = `poll ${attempt}/${PAYPAL_URL_POLL_ATTEMPTS} empty`;
      emit('redirect', `轮询响应未包含 PayPal URL（${attempt}/${PAYPAL_URL_POLL_ATTEMPTS}），继续等待。`);
    } else {
      lastErr = `http ${response.status}: ${responseDetail(response)}`;
    }
    if (attempt < PAYPAL_URL_POLL_ATTEMPTS) {
      const waitScheduleMs = afterApprove
        ? [3000, 6000, 12000, 24000]
        : [2000, 4000, 8000, 16000];
      await sleep(waitScheduleMs[attempt - 1] || 0);
    }
  }
  throw protoError(`轮询仍未包含 PayPal URL: ${lastErr}`, { status: 502, recoverable: true });
}

function locationHeader(headers) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get('location') || headers.get('Location') || '').trim();
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === 'location') return String(value || '').trim();
  }
  return '';
}

function preferredPaypalUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (isPaypalBaApproveUrl(value) || isPaypalProviderRedirectUrl(value)) return value;
  return paypalLinkFromText(value);
}

async function followPaypalRedirect(session, url, emit) {
  let current = String(url || '').trim();
  if (!current) return '';
  const immediate = preferredPaypalUrl(current);
  if (immediate && (isPaypalBaApproveUrl(immediate) || isPaypalProviderRedirectUrl(immediate))) {
    return immediate;
  }
  emit('redirect', '正在跟随 Stripe 跳转并解析 PayPal 链（BA approve 优先）。');
  for (let hop = 1; hop <= 8; hop += 1) {
    if (!current) return '';
    const already = preferredPaypalUrl(current);
    if (already && (isPaypalBaApproveUrl(already) || isPaypalProviderRedirectUrl(already))) {
      return already;
    }
    let response;
    try {
      response = await session.request(current, {
        method: 'GET',
        timeout: STRIPE_TIMEOUT_MS,
        redirect: 'manual',
      });
    } catch {
      return current;
    }
    const finalUrl = String(response.url || current);
    const fromFinal = preferredPaypalUrl(finalUrl);
    if (fromFinal && (isPaypalBaApproveUrl(fromFinal) || isPaypalProviderRedirectUrl(fromFinal))) {
      return fromFinal;
    }
    const fromBody = paypalLinkFromText(response.data || response.text || '');
    if (fromBody && (isPaypalBaApproveUrl(fromBody) || isPaypalProviderRedirectUrl(fromBody))) {
      return fromBody;
    }
    const status = Number(response.status) || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = locationHeader(response.headers);
      if (location) {
        try {
          current = new URL(location.split(';')[0], finalUrl || current).href;
          continue;
        } catch {
          return current;
        }
      }
    }
    if (isStripeHostedCheckoutUrl(finalUrl) && fromBody) {
      current = fromBody;
      continue;
    }
    return fromBody || fromFinal || finalUrl || current;
  }
  return current;
}

async function resolvePaypalLink(chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, confirmPayload, ctx, emit, cancelled) {
  let redirect = extractRedirectToUrl(confirmPayload);
  if (redirect) return followPaypalRedirect(stripeSession, redirect, emit);
  raiseIfSubmissionFailed(confirmPayload, 'PayPal confirm');
  const submission = findSubmissionAttempt(confirmPayload);
  const pk = stripePublishableKey(checkout);
  if (String(submission.state || '') === 'requires_approval') {
    emit('approve', `Stripe 要求 ChatGPT approve，正在使用 GB 代理提交 approve。`);
    await chatgptApprove(chatgptSession, detail, deviceId, sessionId, checkout, emit, cancelled);
    redirect = await pollPaypalRedirect(stripeSession, checkout, pk, ctx, emit, cancelled, { afterApprove: true });
    return followPaypalRedirect(stripeSession, redirect, emit);
  }
  try {
    redirect = await pollPaypalRedirect(stripeSession, checkout, pk, ctx, emit, cancelled);
  } catch (error) {
    if (error?.code !== 'STRIPE_REQUIRES_APPROVAL') throw error;
    emit('approve', '轮询 payment page 发现 requires_approval，正在提交 ChatGPT approve。');
    await chatgptApprove(chatgptSession, detail, deviceId, sessionId, checkout, emit, cancelled);
    redirect = await pollPaypalRedirect(stripeSession, checkout, pk, ctx, emit, cancelled, { afterApprove: true });
  }
  return followPaypalRedirect(stripeSession, redirect, emit);
}

async function extractOaicsLink(chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, emit, cancelled) {
  const ctx = stripeContext(checkout.cs_id, checkout);
  const elements = await stripeElements(stripeSession, checkout, ctx, emit);
  ensurePaypalAvailable(elements || checkout);
  await submitTaxes(chatgptSession, detail, deviceId, sessionId, checkout, billing, emit);
  await snapshotBilling(chatgptSession, detail, deviceId, sessionId, checkout, billing);
  await stripeElements(stripeSession, checkout, ctx, emit, true);
  emit('payment_method', '正在创建 PayPal payment_method。');
  const pmId = await createPaymentMethod(stripeSession, checkout, ctx, billing);
  emit('payment_method', 'PayPal payment_method 创建成功。');
  const ctoken = await createConfirmationToken(stripeSession, checkout, ctx, billing);
  emit('confirm', '正在通过 ChatGPT checkout/confirm 创建 Stripe intent。');
  const path = '/backend-api/payments/checkout/confirm';
  const confirmResponse = await chatgptRequest(chatgptSession, detail, deviceId, sessionId, path, {
    json: {
      checkout_session_id: checkout.cs_id,
      confirm_token: ctoken,
      selected_payment_method_type: 'paypal',
    },
    extra: chatgptCheckoutHeaders(checkout, path),
  });
  if (Number(confirmResponse.status) >= 400) {
    throw protoError(`chatgpt checkout confirm failed: ${responseDetail(confirmResponse)}`, {
      status: confirmResponse.status || 502,
      recoverable: true,
    });
  }
  const confirmPayload = confirmResponse.data || {};
  if (String(confirmPayload.status || '').toLowerCase() === 'blocked') {
    throw protoError('OAICS checkout/confirm 返回 status=blocked', {
      status: 409, code: 'STRIPE_RISK_RETRYABLE', recoverable: true,
    });
  }
  const clientSecret = String(confirmPayload.client_secret || '').trim();
  if (!clientSecret || !clientSecret.includes('_secret_')) {
    throw protoError('OAICS checkout/confirm 未返回 intent client_secret', { status: 502, recoverable: true });
  }
  const pk = stripePublishableKey(checkout);
  const intentPath = intentConfirmPath(clientSecret);
  const intentResponse = await stripeRequest(stripeSession, intentPath, {
    form: stripeIntentConfirmBody(clientSecret, pk, checkout, ctoken, ctx),
  });
  if (Number(intentResponse.status) >= 400) {
    const detailText = responseDetail(intentResponse).toLowerCase();
    if (detailText.includes('generic_decline') || detailText.includes('setup_attempt_failed')) {
      throw protoError('Stripe PayPal confirm 被 generic_decline 拒绝', {
        status: 409, code: 'STRIPE_RISK_RETRYABLE', recoverable: true,
      });
    }
    throw protoError(`stripe intent confirm failed: ${responseDetail(intentResponse)}`, {
      status: intentResponse.status || 502,
      recoverable: true,
    });
  }
  emit('redirect', '正在跟随 Stripe 跳转并解析 PayPal 链（BA approve 优先）。');
  const providerUrl = await resolvePaypalLink(
    chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, intentResponse.data || {}, ctx, emit, cancelled,
  );
  if (!isPaypalProviderRedirectUrl(providerUrl)) {
    throw protoError(`未提取到 PayPal 跳转链；当前结果: ${providerUrl || ''}`, { status: 502, recoverable: true });
  }
  return { link: copyablePaymentLink(providerUrl), cs_id: checkout.cs_id, flow: 'oaics', payment_method_id: pmId };
}

async function extractCsLink(chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, emit, cancelled, profile = defaultPaypalProfile()) {
  const currency = profile.currency || checkout.currency || GBP;
  const hosted = profile.uiMode === 'hosted';
  const brazilHosted = hosted && profile.checkoutCountry === 'BR';
  let initPayload = {};
  await withRetries(PROVIDER_RETRY_ATTEMPTS, cancelled, async (attempt) => {
    emit('stripe_init', `正在初始化 Stripe（${attempt}/${PROVIDER_RETRY_ATTEMPTS}）。`);
    initPayload = await stripeInit(stripeSession, checkout, emit, {
      timezone: profile.timezone,
      hosted,
    });
    ensurePaypalAvailable(initPayload);
    const amount = ensureAmountZero(initPayload, currency);
    emit('provider', `优惠更新后金额检测通过：${amount}。`);
    return initPayload;
  });
  emit('tax', `正在同步 Stripe PayPal tax_region：${billing.country}。`);
  const pk = stripePublishableKey(checkout, initPayload);
  await withRetries(PROVIDER_RETRY_ATTEMPTS, cancelled, async () => {
    const tax = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}`, {
      form: stripePaypalTaxRegionBody(checkout.cs_id, pk, billing),
    });
    if (Number(tax.status) >= 400) {
      throw protoError(`stripe paypal tax region failed: ${responseDetail(tax)}`, {
        status: tax.status || 502,
        recoverable: true,
      });
    }
    return tax.data;
  });
  emit('tax', 'PayPal tax_region 同步完成，正在获取 confirm 前最终 Stripe init。');
  await withRetries(PROVIDER_RETRY_ATTEMPTS, cancelled, async (attempt) => {
    emit('stripe_init', `正在获取 confirm 前最终 Stripe init（${attempt}/${PROVIDER_RETRY_ATTEMPTS}）。`);
    initPayload = await stripeInit(stripeSession, checkout, emit, {
      timezone: profile.timezone,
      hosted,
    });
    ensurePaypalAvailable(initPayload);
    ensureAmountZero(initPayload, currency);
    return initPayload;
  });
  const stripeHostedUrl = String(initPayload.stripe_hosted_url || '').trim();
  if (!stripeHostedUrl) {
    throw protoError('stripe init 未返回 stripe_hosted_url', { status: 502, recoverable: true });
  }
  let lastProviderError;
  for (let providerAttempt = 1; providerAttempt <= PROVIDER_RETRY_ATTEMPTS; providerAttempt += 1) {
    assertActive(cancelled);
    try {
      emit('provider', `正在创建 Stripe/Provider 会话（第 ${providerAttempt}/${PROVIDER_RETRY_ATTEMPTS} 次）。`);
      const ctx = stripeContext(checkout.cs_id, initPayload);
      emit('elements', '正在初始化 PayPal Custom Elements session。');
      const elements = await stripeElements(stripeSession, checkout, ctx, emit);
      ensurePaypalAvailable(elements || initPayload);
      const initialElementsAmount = String(ctx.checkout_amount || '');
      emit('tax', '正在同步 PayPal Custom 税区与账单。');
      const customTax = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}`, {
        form: stripeCustomTaxRegionBody(ctx, billing, pk),
        extra: { Origin: 'https://js.stripe.com', Referer: STRIPE_JS_ORIGIN },
      });
      if (Number(customTax.status) >= 400) {
        emit('tax', `Stripe custom tax_region 返回 HTTP ${customTax.status}，继续使用 checkout 金额。`);
      } else {
        applyCustomTaxRegionAmount(ctx, customTax.data || {});
      }
      await submitTaxes(chatgptSession, detail, deviceId, sessionId, checkout, billing, emit);
      await snapshotBilling(chatgptSession, detail, deviceId, sessionId, checkout, billing);
      const finalElementsAmount = String(ctx.checkout_amount || '');
      if (finalElementsAmount !== initialElementsAmount) {
        emit('elements', `PayPal Custom Elements 金额已变化（${initialElementsAmount || '未知'} -> ${finalElementsAmount || '未知'}），刷新 session。`);
        await stripeElements(stripeSession, checkout, ctx, emit, true);
      } else {
        emit('elements', `PayPal Custom Elements refresh skipped：金额未变化（${finalElementsAmount || '未知'}）。`);
      }
      emit('payment_method', '正在创建 PayPal payment_method。');
      const pmId = await createPaymentMethod(stripeSession, checkout, ctx, billing);
      emit('payment_method', `PayPal payment_method 创建成功。`);
      emit('confirm', hosted && !brazilHosted
        ? '正在通过 Hosted 协议提交 PayPal confirm。'
        : '正在通过 Custom 协议提交 PayPal confirm。');
      const confirmReferer = toOpenaiPayUrl(stripeHostedUrl) || 'https://pay.openai.com/';
      const confirmBody = hosted && !brazilHosted
        ? stripeHostedConfirmBody(checkout.cs_id, pk, initPayload, billing, stripeHostedUrl)
        : stripePaypalCustomConfirmBody(checkout, pk, initPayload, ctx, billing, stripeHostedUrl);
      const confirmResponse = await stripeRequest(stripeSession, `/v1/payment_pages/${checkout.cs_id}/confirm`, {
        form: confirmBody,
        extra: { Referer: confirmReferer },
      });
      if (Number(confirmResponse.status) >= 400) {
        throw protoError(`stripe custom PayPal confirm failed: ${responseDetail(confirmResponse)}`, {
          status: confirmResponse.status || 502,
          code: 'STRIPE_RISK_RETRYABLE',
          recoverable: true,
        });
      }
      emit('confirm', 'Stripe confirm 已返回，正在解析 PayPal 跳转。');
      const providerUrl = await resolvePaypalLink(
        chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, confirmResponse.data || {}, ctx, emit, cancelled,
      );
      if (!isPaypalProviderRedirectUrl(providerUrl)) {
        throw protoError(`未提取到 PayPal 跳转链；当前结果: ${providerUrl || ''}`, { status: 502, recoverable: true });
      }
      return { link: copyablePaymentLink(providerUrl), cs_id: checkout.cs_id, flow: 'cs', payment_method_id: pmId };
    } catch (error) {
      if (
        error?.code === 'JOB_CANCELLED'
        || error?.code === 'STRIPE_RISK_RETRYABLE'
        || error?.code === 'CHECKOUT_APPROVE_BLOCKED'
        || error?.code === 'CHECKOUT_APPROVE_HTTP'
        || error?.code === 'CHECKOUT_APPROVE_EXPIRED'
        || error?.code === 'CHECKOUT_PROMOTION'
        || error?.recoverable === false
      ) {
        throw error;
      }
      const status = Number(error?.status) || 0;
      const retryableProviderError = error?.recoverable === true
        || [408, 425, 429, 500, 502, 503, 504].includes(status);
      if (!retryableProviderError) throw error;
      lastProviderError = error;
      if (providerAttempt >= PROVIDER_RETRY_ATTEMPTS) break;
      emit(
        'provider',
        `PayPal provider 第 ${providerAttempt}/${PROVIDER_RETRY_ATTEMPTS} 次失败，保留当前 checkout 继续重试：${compactText(error.message, 160)}`,
      );
    }
  }
  throw protoError(
    `provider 阶段连续重试 ${PROVIDER_RETRY_ATTEMPTS} 次仍失败，当前 checkout 已作废: ${compactText(lastProviderError?.message, 200)}`,
    {
      status: Number(lastProviderError?.status) || 502,
      code: 'STRIPE_RISK_RETRYABLE',
      recoverable: true,
    });
}

function paypalLinkFromUnknown(value) {
  if (!value) return '';
  const fromRedirect = extractRedirectToUrl(value);
  const fromText = paypalLinkFromText(value);
  const candidate = fromRedirect || fromText;
  if (isPaypalBaApproveUrl(candidate) || isPaypalProviderRedirectUrl(candidate)) {
    return copyablePaymentLink(candidate);
  }
  return '';
}

async function tryApproveFirstPayPalLink(
  chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, emit, cancelled,
) {
  emit('approve', 'oaics_ / ChatGPT 原生 checkout：优先提交 ChatGPT checkout/approve（chatgptplusplan / 试用优惠）。');
  const payload = await chatgptApprove(chatgptSession, detail, deviceId, sessionId, checkout, emit, cancelled);
  const fromPayload = paypalLinkFromUnknown(payload);
  if (fromPayload) {
    emit('approve', 'ChatGPT approve 已直接返回 PayPal 链，跳过 Stripe cs_ Custom 初始化。');
    return { link: fromPayload, cs_id: checkout.cs_id, flow: 'approve' };
  }
  try {
    const pageUrl = chatgptCheckoutShortUrl(
      checkout.cs_id,
      checkout.billing_country || GB,
      checkout.processor_entity,
    );
    const page = await chatgptSession.request(pageUrl, {
      method: 'GET',
      headers: { Referer: CHATGPT_ORIGIN },
      timeout: CHATGPT_TIMEOUT_MS,
    });
    const fromPage = paypalLinkFromUnknown(page?.text)
      || paypalLinkFromUnknown(openaiCheckoutStateFromHtml(page?.text));
    if (fromPage) {
      emit('approve', 'ChatGPT approve 后从 checkout 页面解析到 PayPal 链，跳过 Stripe init。');
      return { link: fromPage, cs_id: checkout.cs_id, flow: 'approve' };
    }
  } catch {
    /* checkout 页面没有 PayPal 链时回退 Stripe provider */
  }
  emit('approve', 'ChatGPT approve 已通过，但未直接得到 PayPal BA/短链，回退 Stripe provider。');
  return null;
}

async function extractOnce({
  chatgptSession,
  stripeSession,
  detail,
  deviceId,
  sessionId,
  emit,
  cancelled,
  proxy,
  addressFetch,
  profile = defaultPaypalProfile(),
  nextProxy,
  fetchImpl,
}) {
  let checkout = await createCheckout(chatgptSession, detail, deviceId, sessionId, emit, cancelled, proxy, profile);
  const updateCountry = profile.updateCountry || profile.checkoutCountry || GB;
  const checkoutCountry = profile.checkoutCountry || GB;
  if (updateCountry && updateCountry !== checkoutCountry) {
    const updateProxy = freshStickyProxy(proxyForRegion(
      typeof nextProxy === 'function' ? (nextProxy() || proxy) : proxy,
      updateCountry,
    ));
    await withExtractSession({
      proxy: updateProxy,
      timeoutMs: CHATGPT_TIMEOUT_MS,
      fetchImpl: addressFetch || fetchImpl,
      impersonate: EXTRACT_BROWSER,
    }, async (updateSession) => {
      await seedSession(updateSession, detail, deviceId);
      await verifyProxyCountry(updateSession, updateCountry, emit, '优惠 update');
      checkout = await updateCheckoutPromotion(
        updateSession, detail, deviceId, sessionId, checkout, emit, cancelled, profile,
      );
    });
  } else {
    checkout = await updateCheckoutPromotion(
      chatgptSession, detail, deviceId, sessionId, checkout, emit, cancelled, profile,
    );
  }
  const billing = await billingForPaypalCountry(
    profile.billingCountry || GB,
    accountEmailFromAccessToken(detail.access_token) || detail.email || '',
    addressFetch,
  );
  emit('billing', `已生成 ${billing.country} 账单资料：${billing.city} ${billing.postal_code}。`);
  if (shouldApproveFirstCheckout(checkout)) {
    const approved = await tryApproveFirstPayPalLink(
      chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, emit, cancelled,
    );
    if (approved?.link) return approved;
    emit('stripe_init', `approve 未给出 PayPal 链，checkout 为 OpenAI oaics_ session（${redactCheckoutId(checkout.cs_id)}），回退 OAICS PayPal 协议。`);
    return extractOaicsLink(chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, emit, cancelled);
  }
  if (isOaicsSessionId(checkout.cs_id)) {
    emit('provider', `oaics_ checkout 含 Stripe session，跳过 ChatGPT approve，走 OAICS PayPal 协议（${redactCheckoutId(checkout.cs_id)}）。`);
    return extractOaicsLink(chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, emit, cancelled);
  }
  if (!isStripeCheckoutSessionId(checkout.cs_id) && !isStripeCheckoutTicket(checkout)) {
    throw protoError(`当前 OpenAI checkout 返回 ${checkout.cs_id}，不是 cs_/oaics_ session。`, { status: 400 });
  }
  emit('provider', `checkout 为 Stripe cs_ session（${redactCheckoutId(checkout.cs_id)}），跳过 ChatGPT approve，按参考流程走 ${profile.uiMode === 'hosted' ? 'Hosted' : 'Custom'} PayPal / stripe_init。`);
  return extractCsLink(chatgptSession, stripeSession, detail, deviceId, sessionId, checkout, billing, emit, cancelled, profile);
}

async function extractPaymentLink({
  detail, proxy, nextProxy, cancelled, log, fetchImpl, impersonate, maxCheckoutAttempts, paypalProfile,
}) {
  const profile = resolvePaypalProfile(paypalProfile);
  const accessToken = String(detail?.access_token || '').trim();
  if (!accessToken) {
    throw protoError('账号缺少 access token', { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
  }
  if (!proxy && typeof fetchImpl !== 'function') {
    throw protoError(
      `${profile.checkoutCountry || GB} PayPal 提链缺少已校验的支付组代理，已在资格检查前停止`,
      {
        status: 400,
        code: profile.checkoutCountry === GB ? 'EXTRACT_GB_PROXY_REQUIRED' : 'EXTRACT_PROXY_REQUIRED',
        recoverable: false,
      },
    );
  }
  const emit = (step, message) => {
    log?.(`${step}: ${message}`, 'info');
  };
  const eligibilityCache = {};
  let currentProxy = freshStickyProxy(proxy);
  let lastError;
  let checkoutFailures = 0;
  const attemptCap = Math.max(1, Number(maxCheckoutAttempts) || PAYPAL_FULL_CHECKOUT_ATTEMPTS);
  const requestedImpersonate = String(impersonate || '').trim();
  const skippedImpersonates = [];
  const deviceId = resolveExtractDeviceId(detail);
  while (true) {
    assertActive(cancelled);
    const fingerprint = requestedImpersonate
      ? chromeFingerprintFor(requestedImpersonate)
      : randomChromeFingerprint(skippedImpersonates);
    try {
      return await withExtractSession({
        proxy: currentProxy,
        timeoutMs: CHATGPT_TIMEOUT_MS,
        fetchImpl,
        impersonate: fingerprint.impersonate,
      }, async (session) => {
        emit(
          'transport',
          `提链使用协议 HTTP（${session.transport || 'fixture'} curl_cffi ${session.browser || fingerprint.impersonate || EXTRACT_BROWSER}），不占用 Cloak 席位。`,
        );
        const sessionId = newId();
        await seedSession(session, detail, deviceId);
        await verifyProxyCountry(session, profile.checkoutCountry || GB, emit, `PayPal ${profile.checkoutCountry || GB}`);
        await checkEligibility(
          session,
          detail,
          deviceId,
          sessionId,
          emit,
          cancelled,
          eligibilityCache,
          { exitCountry: profile.checkoutCountry || GB },
        );
        const result = await extractOnce({
          chatgptSession: session,
          stripeSession: session,
          detail,
          deviceId,
          sessionId,
          emit,
          cancelled,
          proxy: currentProxy,
          addressFetch: fetchImpl,
          profile,
          nextProxy,
          fetchImpl,
        });
        emit('done', isPaypalBaApproveUrl(result.link) ? '已提取到 PayPal BA approve 链。' : '已提取到普通 PayPal 跳转链。');
        return result;
      });
    } catch (error) {
      lastError = error;
      if (error?.code === 'ACCOUNT_NOT_ELIGIBLE') {
        throw error;
      }
      if (isUnsupportedImpersonateError(error)) {
        const failed = fingerprint.impersonate || '';
        rememberUnsupportedImpersonate(failed);
        if (failed) skippedImpersonates.push(failed);
        if (skippedImpersonates.length >= Math.max(3, EXTRACT_CHROME_PROFILES.length)) throw error;
        emit(
          'recovery',
          `TLS impersonate ${failed || 'unknown'} 本机不支持，立即换受支持指纹重试（不是 ChatGPT 风控）。`,
        );
        continue;
      }
      checkoutFailures += 1;
      const recoverable = staleCheckoutError(error) || recoverableExtractError(error);
      if (
        error?.skip
        || error?.code === 'JOB_CANCELLED'
        || !recoverable
        || checkoutFailures >= attemptCap
      ) {
        throw error;
      }
      const eligibilityTransport = error?.code === 'ACCOUNT_ELIGIBILITY_CHECK'
        || String(error?.code || '').startsWith('ELIGIBILITY_PROXY_');
      const reason = eligibilityTransport
        ? 'GB 资格检查传输失败'
        : error?.code === 'EXTRACT_CHECKOUT_UNUSUAL'
          ? 'checkout 被判定为异常活动'
          : error?.code === 'CHECKOUT_PROMOTION'
            ? '检测到优惠更新无效'
            : error?.code === 'CHECKOUT_APPROVE_BLOCKED'
              ? 'ChatGPT approve 返回 blocked'
            : error?.code === 'CHECKOUT_APPROVE_HTTP'
              ? `ChatGPT approve 返回 HTTP ${error.http || '5xx'}，作废 checkout 并重建`
            : error?.code === 'STRIPE_RISK_RETRYABLE'
              ? 'Stripe confirm 风控失败'
              : staleCheckoutError(error)
                ? 'checkout session 已失效'
                : '当前 checkout 或 provider 流程失败';
      emit(
        'recovery',
        `${reason}；更换支付组 GB 代理、TLS 指纹并重建 checkout（${checkoutFailures + 1}/${attemptCap}）。`,
      );
      if (!fetchImpl) await sleep(error?.code === 'EXTRACT_CHECKOUT_UNUSUAL' ? 5000 : 800);
      currentProxy = freshStickyProxy(typeof nextProxy === 'function' ? (nextProxy() || currentProxy) : currentProxy);
    }
  }
  /* c8 ignore next */
  throw lastError;
}

module.exports = {
  extractPaymentLink,
  CHECK_PATH,
  CHECKOUT_PATH,
  ELIGIBILITY_COUNTRIES,
  CLOUDFLARE_TRACE_URL,
  proxyForRegion,
  cloudflareTraceCountry,
  billingForPaypalCountry,
  resolvePaypalProfile,
  verifyProxyCountry,
  seedSession,
  checkEligibility,
  chatgptRequest,
  stripeRequest,
  stripeInit,
  serializeCheckout,
  mergeCheckout,
  stripePublishableKey,
  withRetries,
  applyElementsContext,
  raiseIfSubmissionFailed,
  submitTaxes,
  snapshotBilling,
  chatgptApprove,
  stripeElements,
  responseDetail,
  compactText,
};
