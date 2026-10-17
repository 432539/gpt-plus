const {
  CHECKOUT_SESSION_DATA_QUERY,
  BUYER_CONTEXT_QUERY,
  BUYER_FUNDING_CONTEXT_QUERY,
  GRIFFIN_METADATA_QUERY,
  SUPPORTED_FUNDING_SOURCES_QUERY,
  INSTALLMENT_OPTIONS_QUERY,
  ADDRESS_AUTOCOMPLETE_FROM_POSTAL_CODE_QUERY,
  DEFERRED_FEATURE_QUERY,
  INITIATE_2FA_PHONE_MUTATION,
  CONFIRM_2FA_PHONE_MUTATION,
  SIGNUP_NEW_MEMBER_MUTATION,
  AUTHORIZE_BILLING_MUTATION,
} = require('./paypalGraphql');
const { PayPalSession, headerValue, firstItem, followRedirects } = require('./paypalSession');
const {
  cardIssuerType,
  createSessionState,
  gbBillingLine1,
  generateCard,
  generateAddress,
  parsePhone,
} = require('./paypalProfile');
const {
  USER_AGENT,
  createDeviceSignals,
  buildFnSyncData,
  buildSignupFnSyncData,
  sendTealeafData,
  sendDeviceFingerprint,
  sendSignupFieldEvents,
  sendAnalyticsTs,
  sendObservabilityEmit,
  sendWeasleyLog,
} = require('./paypalSignals');

const GB_PROFILE = Object.freeze({
  locale: 'en_GB',
  lang: 'en',
  phone_code: '+44',
  accept_language: 'en-GB,en;q=0.9,en-US;q=0.8',
});

const SIGNUP_SUBMIT_INTERVAL_MS = 1500;
let lastSignupSubmitAt = 0;
let signupPaceTail = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetSignupPaceForTests() {
  lastSignupSubmitAt = 0;
  signupPaceTail = Promise.resolve();
}

function paceSignupSubmission({ now = Date.now, wait = sleep } = {}) {
  const run = async () => {
    const waitMs = Math.max(0, lastSignupSubmitAt + SIGNUP_SUBMIT_INTERVAL_MS - now());
    if (waitMs > 0) await wait(waitMs);
    lastSignupSubmitAt = now();
    return waitMs;
  };
  const next = signupPaceTail.then(run, run);
  signupPaceTail = next.then(() => undefined, () => undefined);
  return next;
}

function isGraphqlChallengeError(error) {
  const hay = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return [
    'paypal_graphql_html_challenge',
    'paypal_graphql_non_json_response',
    'paypal_page_challenge',
  ].some((marker) => hay.includes(marker));
}

function protoError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function extractWindowInitialData(html) {
  const marker = String(html || '').match(/window\.__INITIAL_DATA__\s*=/);
  if (!marker) return {};
  const start = html.indexOf('{', marker.index + marker[0].length);
  if (start < 0) return {};
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let idx = start; idx < html.length; idx += 1) {
    const ch = html[idx];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, idx + 1)); } catch { return {}; }
      }
    }
  }
  return {};
}

function extractContentIdentifier(html, country = 'GB', lang = 'en') {
  const text = String(html || '');
  const patterns = [
    /"contentIdentifier"\s*:\s*"([^"]*signupTerms[^"]*)"/i,
    /\\"contentIdentifier\\"\s*:\s*\\"([^"\\]*signupTerms[^"\\]*)\\"/i,
    /([A-Z]{2}:[a-z]{2}:[0-9a-f]{16,64}:compliance\.signupTerms)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/\\\//g, '/');
  }
  return `${country}:${lang}:compliance.signupTerms`;
}

function extractEcToken(url, html) {
  const decodedUrl = decodeURIComponent(String(url || ''));
  const decodedHtml = decodeURIComponent(String(html || ''));
  const fromUrl = decodedUrl.match(/(?:token=|[?&]token%3D)(EC-[A-Za-z0-9_-]+)/i);
  if (fromUrl) return fromUrl[1];
  const fromHtml = decodedHtml.match(/EC-[A-Za-z0-9_-]+/);
  return fromHtml ? fromHtml[0] : '';
}

function findAccessToken(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAccessToken(item);
      if (found) return found;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  for (const [key, item] of Object.entries(value)) {
    if (key === 'accessToken' && typeof item === 'string' && item) return item;
    const found = findAccessToken(item);
    if (found) return found;
  }
  return '';
}

function hasBuyerNotSet(result) {
  const items = Array.isArray(result) ? result : [result];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const err of item.errors || []) {
      if (!err || typeof err !== 'object') continue;
      const data = err.data && typeof err.data === 'object' ? err.data : {};
      if (data.contingency === 'BUYER_NOT_SET' || err.message === 'BUYER_NOT_SET') return true;
    }
  }
  return false;
}

function graphqlErrorMessages(result) {
  const items = Array.isArray(result) ? result : [result];
  const messages = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    for (const err of item.errors || []) {
      if (!err || typeof err !== 'object') continue;
      const message = String(err.message || err.name || '').trim();
      if (message) messages.push(message);
    }
  }
  return messages;
}

function fundingSummary(checkout) {
  const options = checkout?.fundingOptions && typeof checkout.fundingOptions === 'object'
    ? checkout.fundingOptions
    : {};
  const selected = options.fundingInstrument && typeof options.fundingInstrument === 'object'
    ? options.fundingInstrument
    : {};
  const availableIds = new Set();
  for (const plan of options.allPlans || []) {
    if (!plan || typeof plan !== 'object') continue;
    for (const source of plan.fundingSources || []) {
      if (!source || typeof source !== 'object') continue;
      const instrument = source.fundingInstrument && typeof source.fundingInstrument === 'object'
        ? source.fundingInstrument
        : {};
      const instrumentId = String(instrument.id || '');
      if (instrumentId) availableIds.add(instrumentId);
    }
  }
  return {
    selected: Boolean(selected.id),
    available: availableIds.size > 0,
    available_count: availableIds.size,
  };
}

function graphqlData(result, path = []) {
  let current = firstItem(result);
  if (!current || typeof current !== 'object') return {};
  current = current.data && typeof current.data === 'object' ? current.data : current;
  for (const key of path) {
    if (!current || typeof current !== 'object') return {};
    current = current[key];
  }
  return current && typeof current === 'object' ? current : {};
}

function dictContainsCardField(value) {
  if (Array.isArray(value)) return value.some(dictContainsCardField);
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    const compact = String(key).toLowerCase().replace(/[_-]/g, '');
    if (['cardnumber', 'card', 'cardnumberfield'].includes(compact)) return true;
    if (typeof item === 'string' && ['cardnumber', 'card_generic_error'].includes(item.toLowerCase())) return true;
    if (dictContainsCardField(item)) return true;
  }
  return false;
}

function isCardRelatedSignupError(errors) {
  const messages = new Set([
    'CARD_GENERIC_ERROR',
    'INSTRUMENT_SHARING_LIMIT_EXCEEDED',
    'CC_LINKED_TO_FULL_ACCOUNT',
    'CREATE_CARD_ACCOUNT_CANDIDATE_VALIDATION_ERROR',
  ]);
  for (const err of errors || []) {
    if (!err || typeof err !== 'object') continue;
    const checkpoints = new Set(err.checkpoints || []);
    if ([...checkpoints].some((item) => ['addCard', 'validate.fi', 'card', 'fi'].includes(item))) return true;
    if (messages.has(String(err.message || ''))) return true;
    if (dictContainsCardField(err.errorData)) return true;
  }
  return false;
}

function hasSignupErrorMessage(errors, message) {
  return (errors || []).some((err) => err && typeof err === 'object' && String(err.message || '') === message);
}

function isRetryableAddressError(errors) {
  return ['RESIDENTIAL_ADDRESS_NOT_FOUND', 'RESIDENTIAL_ADDRESS_VALIDATION_ERROR']
    .some((message) => hasSignupErrorMessage(errors, message));
}

function isCreateMemberOasError(errors) {
  return (errors || []).some((err) => (
    err && typeof err === 'object'
    && String(err.message || err._name || '').toUpperCase() === 'OAS_ERROR'
    && (err.checkpoints || []).includes('createMemberAccount')
  ));
}

function fundingConfirmationContext(errors) {
  for (const err of errors || []) {
    if (err && typeof err === 'object' && String(err.message || '') === 'FI_CONFIRMATION_CONTINGENCY') {
      return err.errorData && typeof err.errorData === 'object' ? err.errorData : {};
    }
  }
  return {};
}

function applyNormalizedAddress(address, normalized) {
  if (!normalized || typeof normalized !== 'object') return false;
  const line1 = String(normalized.line1 || '').trim();
  if (line1) {
    const match = line1.match(/^([0-9]+(?:\/[0-9A-Za-z-]+)?[A-Za-z]?(?:-[0-9]+[A-Za-z]?)?)\s+(.+)$/);
    if (match) {
      address.house_number = match[1];
      address.street = match[2].trim();
    } else {
      address.street = line1;
    }
  }
  if (normalized.line2 != null) address.district = String(normalized.line2 || '').trim();
  if (normalized.city) address.city = normalized.city;
  if (normalized.state) address.state = normalized.state;
  if (normalized.postalCode) address.postal_code = normalized.postalCode;
  return true;
}

function consumeSignupResult(signupResult, state, setEuat) {
  const resultObj = firstItem(signupResult);
  if (!resultObj || typeof resultObj !== 'object') {
    return { success: false, errors: [{ message: 'UNEXPECTED_RESPONSE_TYPE' }] };
  }
  const onboard = resultObj.data?.onboardAccount;
  if (onboard && typeof onboard === 'object') {
    const buyer = onboard.buyer && typeof onboard.buyer === 'object' ? onboard.buyer : {};
    state.user_id = buyer.userId || state.user_id;
    const auth = buyer.auth && typeof buyer.auth === 'object' ? buyer.auth : {};
    if (auth.accessToken) setEuat(auth.accessToken);
    return { success: true, errors: [] };
  }
  const errors = (resultObj.errors || []).filter((item) => item && typeof item === 'object');
  return { success: false, errors };
}

function parseAuthorizeResult(result) {
  const resultObj = firstItem(result);
  const authData = resultObj?.data?.billing?.authorize;
  if (!authData || typeof authData !== 'object') {
    const graphqlErrors = graphqlErrorMessages(result);
    const buyerNotSet = hasBuyerNotSet(result);
    return {
      status: 'error',
      error_code: buyerNotSet ? 'BUYER_NOT_SET' : 'AUTHORIZE_EMPTY',
      error: graphqlErrors.length
        ? `authorize returned empty result: ${graphqlErrors.join(', ')}`
        : 'authorize returned empty result',
      stage: 'final_authorization',
      retryable: buyerNotSet,
      graphql_errors: graphqlErrors,
      raw_response: result,
    };
  }
  return {
    status: 'success',
    ba_token: authData.billingAgreementToken,
    user_id: authData.buyer?.userId || '',
    return_url: authData.returnURL?.href || '',
    payment_action: authData.paymentAction,
    raw_authorize: authData,
  };
}

function parseMerchantSettlement(finalRedirectUrl) {
  const empty = {
    redirect_status: '',
    verification_url: '',
    pending_url: '',
    settlement_status: 'authorization_only',
  };
  if (!finalRedirectUrl) return empty;
  try {
    const parsed = new URL(finalRedirectUrl);
    const redirectStatus = String(parsed.searchParams.get('redirect_status') || '').toLowerCase();
    const providerStatus = String(parsed.searchParams.get('status') || '').toLowerCase();
    let verificationUrl = String(parsed.searchParams.get('success_return_url') || '');
    const host = (parsed.hostname || '').toLowerCase();
    if (!verificationUrl && host === 'chatgpt.com' && parsed.pathname.startsWith('/checkout/verify')) {
      verificationUrl = finalRedirectUrl;
    }
    let settlementStatus = 'authorization_only';
    if (redirectStatus === 'success' || redirectStatus === 'succeeded'
      || (host === 'pm-redirects.stripe.com' && ['success', 'succeeded'].includes(providerStatus))) {
      settlementStatus = 'confirmed';
    } else if (['failed', 'failure', 'canceled', 'cancelled'].includes(redirectStatus)) {
      settlementStatus = 'failed';
    } else if (['pending', 'processing', 'requires_action'].includes(redirectStatus) || verificationUrl) {
      settlementStatus = 'pending_verification';
    }
    let pendingUrl = '';
    for (const candidate of [verificationUrl, finalRedirectUrl]) {
      try {
        const item = new URL(String(candidate || ''));
        if (item.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com', 'pay.openai.com'].includes(item.hostname.toLowerCase())) {
          pendingUrl = String(candidate);
          break;
        }
      } catch { /* ignore */ }
    }
    return {
      redirect_status: redirectStatus,
      verification_url: verificationUrl,
      pending_url: pendingUrl,
      settlement_status: settlementStatus,
    };
  } catch {
    return empty;
  }
}

function navHeaders(acceptLanguage, extra = {}) {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-User': '?1',
    ...extra,
  };
}

// Desktop\gpt paypal/flow.py _load_review_context: HTML Accept + Referer only.
function reviewContextHeaders(referer = '') {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
  };
  if (referer) headers.Referer = referer;
  return headers;
}

// Desktop\gpt paypal/flow.py merchant return: HTML navigation headers only.
// Do not send Sec-Fetch-Site: same-origin — the hop is PayPal → Stripe/ChatGPT.
function merchantReturnHeaders(referer = '') {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
  };
  if (referer) headers.Referer = referer;
  return headers;
}

function merchantHost(url) {
  try {
    return new URL(String(url || '')).hostname || '';
  } catch {
    return '';
  }
}

// Desktop\gpt paypal/flow.py: session.get timeout 30s/hop, follow up to 8
// redirects, no page.goto abort. An 8s Playwright cap returned after ~10s
// and about:blank killed checkout/verify before ChatGPT could sync Plus.
const MERCHANT_RETURN_TIMEOUT_MS = 30_000;
const MERCHANT_RETURN_WAIT_UNTIL = 'load';
const MERCHANT_RETURN_HARD_SLACK_MS = 10_000;

function raceTimeout(promise, ms, message) {
  const budget = Math.max(1, Number(ms) || 0);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message || `timed out (${budget}ms)`);
      error.code = 'TIMEOUT';
      error.name = 'TimeoutError';
      reject(error);
    }, budget);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function unstickNavigation(session) {
  try {
    const target = session?.cloak && typeof session.cloak.goto === 'function'
      ? session.cloak
      : session;
    if (typeof target?.goto === 'function') {
      await target.goto('about:blank', { waitUntil: 'commit', timeout: 2500 });
    }
  } catch { /* ignore */ }
}

async function followMerchantReturn(session, returnUrl, {
  referer = '',
  log,
  timeoutMs = MERCHANT_RETURN_TIMEOUT_MS,
  waitUntil = MERCHANT_RETURN_WAIT_UNTIL,
} = {}) {
  const target = String(returnUrl || '').trim();
  if (!target) return { finalRedirectUrl: '', followed: false };
  log?.('跟随商户回跳 URL');
  const headers = merchantReturnHeaders(referer);
  const budget = Math.max(1, Number(timeoutMs) || MERCHANT_RETURN_TIMEOUT_MS);
  const hardMs = budget + Math.min(MERCHANT_RETURN_HARD_SLACK_MS, Math.max(80, budget));
  try {
    const work = typeof session.navigate === 'function'
      ? session.navigate(target, { headers, timeout: budget, waitUntil })
      : (async () => {
        const first = await session.get(target, { headers });
        return followRedirects(session, first, {
          referer: target,
          max: 8,
          headers,
        });
      })();
    const resp = await raceTimeout(work, hardMs, `merchant return timed out (${hardMs}ms)`);
    const finalRedirectUrl = String(resp?.url || target);
    const host = merchantHost(finalRedirectUrl);
    log?.(host ? `商户回跳完成（${host}）` : '商户回跳完成');
    return { finalRedirectUrl, followed: true };
  } catch (error) {
    log?.(`跟随商户回跳失败：${String(error?.message || error).slice(0, 160)}`, 'debug');
    log?.('商户回跳未完成，等待 30 秒后按到账确认开通');
    // Only unstick after the long budget so checkout/verify can finish.
    // vs95 hung ~50min without a cap; do not wait unbounded.
    await unstickNavigation(session);
    return { finalRedirectUrl: target, followed: false, error };
  }
}

class PayPalFlow {
  constructor(options = {}) {
    this.baToken = String(options.baToken || '').trim();
    this.user = options.user;
    this.card = options.card;
    this.address = options.address || generateAddress('GB');
    this.country = 'GB';
    this.locale = GB_PROFILE.locale;
    this.lang = GB_PROFILE.lang;
    this.phoneCode = GB_PROFILE.phone_code;
    this.acceptLanguage = GB_PROFILE.accept_language;
    this.maxCardAttempts = Math.max(1, Number(options.maxCardAttempts) || 5);
    this.maxPhoneRotations = Math.max(0, Math.min(Number(options.maxPhoneRotations) || 10, 10));
    this.generateCard = options.generateCard || generateCard;
    this.generateAddress = options.generateAddress || generateAddress;
    this.sms = options.sms || null;
    this.emit = typeof options.emit === 'function' ? options.emit : () => {};
    this.cancelled = typeof options.cancelled === 'function' ? options.cancelled : () => false;
    this.userAgent = options.userAgent || USER_AGENT;
    this.signals = options.signals || createDeviceSignals({
      userAgent: this.userAgent,
      timezone: 'Europe/London',
    });
    if (options.session) {
      this.session = options.session;
      // Match Desktop\gpt: flow and session must share one SessionState so EUAT,
      // EC token, and cookies stay aligned after partial signup (card rejected).
      this.state = options.state || options.session.state || createSessionState(this.baToken);
    } else {
      this.state = options.state || createSessionState(this.baToken);
      this.session = new PayPalSession(options.cloakSession, this.state, {
        country: this.country,
        locale: this.locale,
        userAgent: this.userAgent,
        emit: this.emit,
      });
    }
    this.addressNormalized = false;
    this.strictBuyerContext = options.strictBuyerContext !== false;
    this.sleep = typeof options.sleep === 'function' ? options.sleep : sleep;
  }

  async loadReviewContext(url, referer) {
    const headers = reviewContextHeaders(referer);
    return followRedirects(
      this.session,
      await this.session.get(url, { headers }),
      {
        referer,
        headers: {
          Accept: headers.Accept,
          'Upgrade-Insecure-Requests': '1',
        },
      },
    );
  }

  assertActive() {
    if (this.cancelled()) throw protoError('任务已取消', { code: 'JOB_CANCELLED' });
  }

  log(message, level = 'info') {
    this.emit('paypal', message, level);
  }

  updateUserPhone(phone) {
    Object.assign(this.user, parsePhone(phone, 'GB'));
    if (String(this.user.phone_local || '').length < 8) throw new Error('phone number is too short');
  }

  buildSignupUrl() {
    const params = new URLSearchParams();
    if (this.state.ssrt) params.set('ssrt', this.state.ssrt);
    params.set('ul', '1');
    params.set('modxo_redirect_reason', 'guest_user');
    params.set('locale.x', this.locale);
    params.set('country.x', this.country);
    params.set('ba_token', this.baToken);
    params.set('token', this.state.ec_token);
    params.set('rcache', '1');
    params.set('cookieBannerVariant', 'hidden');
    return `https://www.paypal.com/checkoutweb/signup?${params}`;
  }

  buildSignupVariables(token) {
    const addressQuality = {
      autoCompleteType: this.addressNormalized ? 'ANS' : 'MANUAL',
      isUserModified: !this.addressNormalized,
    };
    const billingAddress = {
      postalCode: this.address.postal_code,
      line1: gbBillingLine1(this.address),
      line2: '',
      city: this.address.city,
      state: this.address.state,
      accountQuality: { ...addressQuality },
      country: this.country,
      familyName: this.user.last_name,
      givenName: this.user.first_name,
    };
    return {
      card: {
        cardNumber: this.card.number,
        expirationDate: this.card.expiry,
        securityCode: this.card.cvv,
        type: cardIssuerType(this.card.number),
        productClass: this.card.card_type || 'CREDIT',
      },
      country: this.country,
      email: this.user.email,
      firstName: this.user.first_name,
      lastName: this.user.last_name,
      phone: {
        countryCode: String(this.user.phone_country_code || '44').replace(/^\+/, ''),
        number: this.user.phone_local,
        type: 'MOBILE',
      },
      supportedThreeDsExperiences: ['IFRAME'],
      token,
      billingAddress,
      shippingAddress: {
        postalCode: '',
        line1: '',
        city: '',
        state: '',
        accountQuality: { autoCompleteType: 'MANUAL', isUserModified: false },
        country: this.country,
        familyName: this.user.last_name,
        givenName: this.user.first_name,
      },
      contentIdentifier: this.state.content_identifier || `${this.country}:${this.lang}:compliance.signupTerms`,
      marketingOptOut: false,
      password: this.user.password,
      dateOfBirth: (() => {
        const parts = String(this.user.dob || '').split('/');
        return parts.length === 3 ? { day: parts[0], month: parts[1], year: parts[2] } : {};
      })(),
      identityDocument: null,
      crsData: null,
      legalAgreements: {},
      residentialAddress: {
        ...billingAddress,
        accountQuality: { ...addressQuality },
      },
    };
  }

  async run() {
    this.log('开始 GB PayPal 协议授权');
    await this.phase0InitialLoad();
    await this.phase1RiskControls();
    await this.phase2CreateAccount();
    await this.phase3SignupAnd2fa();
    return this.phase4Authorize();
  }

  async phase0InitialLoad() {
    this.assertActive();
    this.log('加载 PayPal BA 授权页');
    const url = `https://www.paypal.com/agreements/approve?${new URLSearchParams({
      ba_token: this.baToken,
      'country.x': this.country,
      'locale.x': this.locale,
    })}`;
    const payReferer = `https://www.paypal.com/pay/?token=${encodeURIComponent(this.baToken)}&ul=1`;
    let resp = await this.session.get(url, { headers: navHeaders(this.acceptLanguage, { Referer: payReferer }) });
    if (Number(resp.status) === 403) {
      this.log('遇到 DataDome 403，尝试协议回退');
      resp = await this.session.post(`${url}&YWRzZGRjYXB0Y2hh=1`, {
        form: { adsddtoken: '' },
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://www.paypal.com',
        },
      });
    }
    if (Number(resp.status) === 403) {
      throw protoError('PAYPAL_PAGE_CHALLENGE: DataDome challenge blocked the agreement page', {
        code: 'PAYPAL_PAGE_CHALLENGE',
        recoverable: true,
      });
    }
    resp = await followRedirects(this.session, resp, { referer: payReferer });
    const html = String(resp.text || '');
    this.approveHtml = html;
    this.approveUrl = String(resp.url || url);
    const ctx = html.match(/"ctxId"[^"]*"([^"]+)"/);
    if (ctx) this.state.ctx_id = ctx[1];
    const ssrt = String(resp.url || '').match(/ssrt=(\d+)/) || html.match(/ssrt=(\d+)/);
    if (ssrt) this.state.ssrt = ssrt[1];
    const onboard = html.match(/onboardingLink"\s*:\s*"([^"]*?\/agreements\/approve\?[^"]+)/i)
      || html.match(/href=["']([^"']*?ulOnboardRedirect=true[^"']*)["']/i);
    if (onboard) {
      const onboardUrl = new URL(onboard[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/'), resp.url || url);
      onboardUrl.searchParams.set('ul', '1');
      onboardUrl.searchParams.set('modxo_redirect_reason', 'guest_user');
      onboardUrl.searchParams.set('ulOnboardRedirect', 'true');
      onboardUrl.searchParams.set('ba_token', this.baToken);
      onboardUrl.searchParams.set('locale.x', this.locale);
      onboardUrl.searchParams.set('country.x', this.country);
      this.state.onboarding_url = onboardUrl.toString();
    } else {
      const params = new URLSearchParams();
      if (this.state.ssrt) params.set('ssrt', this.state.ssrt);
      params.set('ul', '1');
      params.set('modxo_redirect_reason', 'guest_user');
      params.set('ulOnboardRedirect', 'true');
      params.set('ba_token', this.baToken);
      params.set('locale.x', this.locale);
      params.set('country.x', this.country);
      this.state.onboarding_url = `https://www.paypal.com/agreements/approve?${params}`;
    }
    this.log('访客开通路由已准备');
  }

  async phase1RiskControls() {
    this.assertActive();
    this.log('发送设备指纹与风险信标');
    await sendDeviceFingerprint(this.session, this.baToken, {
      userAgent: this.userAgent,
      signals: this.signals,
    });
    const pageUrl = `https://www.paypal.com/pay?ssrt=${this.state.ssrt}&token=${this.baToken}&ul=1`;
    await sendTealeafData(this.session, pageUrl);
    await sendAnalyticsTs(this.session, 'main:xo:modxo:login', this.baToken, { signals: this.signals });
    await sendObservabilityEmit(this.session, this.baToken);
  }

  async phase2CreateAccount() {
    this.assertActive();
    this.log('进入访客开通并提取 EC token');
    const payUrl = `https://www.paypal.com/pay/?ssrt=${this.state.ssrt}&token=${this.baToken}&ul=1&ctxId=${this.state.ctx_id}&country.x=${this.country}`;
    let resp = null;
    let compactFallbackUsed = false;
    if (this.state.onboarding_url) {
      try {
        resp = await this.session.get(this.state.onboarding_url, {
          headers: navHeaders(this.acceptLanguage, { Referer: payUrl }),
        });
        if (![200, 301, 302, 303, 307, 308].includes(Number(resp.status))) resp = null;
      } catch {
        resp = null;
      }
    }
    if (!resp) {
      compactFallbackUsed = true;
      resp = await this.session.post(
        `https://www.paypal.com/pay?ssrt=${this.state.ssrt}&token=${this.baToken}&ul=1&paypal_client_cfci=modxo_vaulted_not_recurring-Pay_With_Card`,
        {
          form: {
            ctxId: this.state.ctx_id,
            formName: 'createAccountAction',
            fn_sync_data: buildFnSyncData(this.baToken, { userAgent: this.userAgent, signals: this.signals }),
          },
          headers: {
            Origin: 'https://www.paypal.com',
            Referer: `https://www.paypal.com/pay?ssrt=${this.state.ssrt}&token=${this.baToken}&ul=1`,
          },
        },
      );
    }
    resp = await followRedirects(this.session, resp, { referer: payUrl });
    this.state.ec_token = extractEcToken(resp.url, resp.text);
    if (!this.state.ec_token && !compactFallbackUsed) {
      this.log('开通页未返回 EC token，改走 compact create-account');
      const compact = await this.session.post(
        `https://www.paypal.com/pay?ssrt=${this.state.ssrt}&token=${this.baToken}&ul=1&paypal_client_cfci=modxo_vaulted_not_recurring-Pay_With_Card`,
        {
          form: {
            ctxId: this.state.ctx_id,
            formName: 'createAccountAction',
            fn_sync_data: buildFnSyncData(this.baToken, { userAgent: this.userAgent, signals: this.signals }),
          },
          headers: {
            Origin: 'https://www.paypal.com',
            Referer: `https://www.paypal.com/pay?ssrt=${this.state.ssrt}&token=${this.baToken}&ul=1`,
          },
        },
      );
      resp = await followRedirects(this.session, compact, { referer: payUrl });
      this.state.ec_token = extractEcToken(resp.url, resp.text);
    }
    if (this.state.ec_token) {
      const signupUrl = this.buildSignupUrl();
      this.state.signup_url = signupUrl;
      this.log('加载 checkoutweb 注册页（写入访客 checkout cookie）');
      let signupResp = await this.session.get(signupUrl, {
        headers: navHeaders(this.acceptLanguage, { Referer: String(resp.url || payUrl) }),
      });
      signupResp = await followRedirects(this.session, signupResp, { referer: String(resp.url || payUrl) });
      if (String(signupResp.url || '').includes('/checkoutweb/signup')) {
        this.state.signup_url = String(signupResp.url).split('#')[0];
      } else if ([301, 302, 303, 307, 308].includes(Number(signupResp.status))) {
        const location = headerValue(signupResp.headers, 'location');
        if (location) {
          const next = new URL(location, signupUrl).href;
          if (next.includes('/checkoutweb/signup')) this.state.signup_url = next;
        }
      }
      const initial = extractWindowInitialData(signupResp.text);
      if (initial.contentHash) this.state.content_hash = initial.contentHash;
      let contentId = extractContentIdentifier(signupResp.text, this.country, this.lang);
      if (this.state.content_hash && contentId.endsWith(':compliance.signupTerms') && !contentId.includes(this.state.content_hash)) {
        contentId = `${this.country}:${this.lang}:${this.state.content_hash}:compliance.signupTerms`;
      }
      this.state.content_identifier = contentId;
    }
    await sendTealeafData(this.session, this.state.signup_url || String(resp.url || ''));
    await sendObservabilityEmit(this.session, this.baToken);
    if (this.state.ec_token) {
      await sendWeasleyLog(this.session, this.state.ec_token, this.state.signup_url, [
        'weasley_client_eligibility_check_success',
        'WEASLEY_PAGE_INTERACTIVE_FPTI',
        'WEASLEY_PREPARE_BILLING_PAGE_FPTI',
        'weasley_payment_request_api_available',
      ]);
      await sendDeviceFingerprint(this.session, this.state.ec_token, {
        appId: 'CHECKOUTUINODEWEB_ONBOARDING_LITE',
        referer: this.state.signup_url,
        wrapped: true,
        userAgent: this.userAgent,
        signals: this.signals,
      });
    }
    const token = this.state.ec_token || this.baToken;
    for (const [name, query, variables] of [
      ['DeferredFeature', DEFERRED_FEATURE_QUERY, {
        channel: 'WEB',
        countryCodeAsString: this.country,
        integrationType: 'XoSignupAuth',
        isBaslAsString: 'false',
        isForcedGuest: 'false',
        token,
      }],
      ['CheckoutSessionDataQuery', CHECKOUT_SESSION_DATA_QUERY, { token }],
      ['GriffinMetadataQuery', GRIFFIN_METADATA_QUERY, {
        countryCode: this.country, languageCode: this.lang, shippingCountryCode: this.country,
      }],
      ['SupportedFundingSourcesQuery', SUPPORTED_FUNDING_SOURCES_QUERY, { token, userCountry: this.country }],
    ]) {
      try { await this.session.graphql(name, query, variables); } catch { /* warm-up */ }
    }
    try { await this.normalizeAddress(token); } catch { /* optional */ }
    if (!this.state.ec_token || !this.state.ec_token.startsWith('EC-')) {
      throw protoError('IDENTITY_ELEVATION_EC_MISSING: onboarding did not produce an EC checkout token', {
        code: 'IDENTITY_ELEVATION_EC_MISSING',
      });
    }
    const checkoutResult = await this.session.graphql('CheckoutSessionDataQuery', CHECKOUT_SESSION_DATA_QUERY, {
      token: this.state.ec_token,
    });
    const checkout = graphqlData(checkoutResult, ['checkoutSession']);
    if (checkout.checkoutSessionType && checkout.checkoutSessionType !== 'BILLING_WITHOUT_PURCHASE') {
      throw protoError('IDENTITY_ELEVATION_CONTEXT_TYPE_MISMATCH', { code: 'IDENTITY_ELEVATION_CONTEXT_TYPE_MISMATCH' });
    }
    if (!this.state.signup_url || !this.state.content_identifier) {
      throw protoError('IDENTITY_ELEVATION_SIGNUP_CONTEXT_MISSING', { code: 'IDENTITY_ELEVATION_SIGNUP_CONTEXT_MISSING' });
    }
    this.state.signup_context_ready = true;
    this.log('身份提升 EC/signup 上下文已校验');
  }

  async normalizeAddress(token) {
    const result = await this.session.graphql(
      'AddressAutocompleteFromPostalCodeQuery',
      ADDRESS_AUTOCOMPLETE_FROM_POSTAL_CODE_QUERY,
      { country: this.country, postalCode: this.address.postal_code, token },
    );
    const normalized = graphqlData(result, ['addressNormalization']);
    if (normalized.line1 || normalized.city) {
      this.addressNormalized = applyNormalizedAddress(this.address, normalized);
    }
  }

  async initiate2fa(token, signupUrl) {
    this.log('发起 PayPal SMS 二次验证');
    await sendWeasleyLog(this.session, this.state.ec_token, signupUrl, [
      'weasley_risk_based_phone_confirmation_modal_component_mounted',
      'weasley_initiate_phone_confirmation_start',
      'weasley_api_request_initiate_risk_based_two_factor_phone_confirmation_mutation',
    ], { country: this.country, lang: this.lang });
    const result = await this.session.graphql(
      'InitiateRiskBasedTwoFactorPhoneConfirmationMutation',
      INITIATE_2FA_PHONE_MUTATION,
      {
        phoneNumber: this.user.phone_local,
        locale: { country: this.country, lang: this.lang },
        phoneCountry: this.country,
        token,
      },
    );
    const data = graphqlData(result, ['initiateRiskBasedTwoFactorPhoneConfirmation']);
    const state = String(data.state || '');
    if (state !== 'PENDING') {
      if (state === 'SMS_LIMIT_EXCEEDED') {
        throw protoError('SMS_LIMIT_EXCEEDED: this phone/session has reached the SMS send limit; use a new phone', {
          code: 'SMS_LIMIT_EXCEEDED',
        });
      }
      throw protoError(`2FA initiation was not accepted: state=${state || '<missing>'}`, { code: 'SMS_INIT_FAILED' });
    }
    if (!data.authId || !data.challengeId) {
      throw protoError('Failed to get authId/challengeId from 2FA initiation', { code: 'SMS_INIT_FAILED' });
    }
    return { authId: data.authId, challengeId: data.challengeId };
  }

  async confirm2fa(token, signupUrl, authId, challengeId, otp) {
    await sendWeasleyLog(this.session, this.state.ec_token, signupUrl, [
      'weasley_confirm_phone_confirmation_start',
      'weasley_api_request_confirm_risk_based_two_factor_phone_confirmation_mutation',
    ]);
    const result = await this.session.graphql(
      'ConfirmRiskBasedTwoFactorPhoneConfirmationMutation',
      CONFIRM_2FA_PHONE_MUTATION,
      { pin: otp, authId, challengeId, token },
    );
    const data = graphqlData(result, ['confirmRiskBasedTwoFactorPhoneConfirmation']);
    return String(data.state || '') === 'CONFIRMED';
  }

  async confirmPhoneWithRetry(token, signupUrl) {
    let rotations = 0;
    while (!this.cancelled()) {
      this.assertActive();
      let challenge;
      try {
        challenge = await this.initiate2fa(token, signupUrl);
      } catch (error) {
        if (isGraphqlChallengeError(error)) {
          throw protoError(
            'PAYPAL_OTP_CONTEXT_REBUILD: PayPal returned an HTML/non-JSON challenge; rebuilding the full payment context',
            { code: 'PAYPAL_OTP_CONTEXT_REBUILD', recoverable: true },
          );
        }
        if (!this.sms?.rotatePhone || rotations >= this.maxPhoneRotations) throw error;
        this.log('发送验证码失败，正在更换 SMSBower 号码');
        const next = await this.sms.rotatePhone(String(error.message || ''));
        this.updateUserPhone(next);
        rotations += 1;
        continue;
      }
      this.log('短信已发送，正在等待 SMSBower 验证码');
      let code;
      try {
        code = await this.sms.waitForCode();
      } catch (error) {
        if (error?.code === 'JOB_CANCELLED') throw error;
        if (!this.sms?.rotatePhone || rotations >= this.maxPhoneRotations) throw error;
        this.log('等待验证码超时，正在更换号码');
        const next = await this.sms.rotatePhone(String(error.message || 'SMS code was not received'));
        this.updateUserPhone(next);
        rotations += 1;
        continue;
      }
      if (await this.confirm2fa(token, signupUrl, challenge.authId, challenge.challengeId, code)) {
        await this.sms.finish?.();
        this.log('SMS OTP 已确认');
        return;
      }
      this.log('验证码未通过，尝试同一号码的下一条短信');
      try { await this.sms.requestAnother?.(); } catch { /* ignore */ }
      try {
        const again = await this.sms.waitForCode();
        if (await this.confirm2fa(token, signupUrl, challenge.authId, challenge.challengeId, again)) {
          await this.sms.finish?.();
          this.log('SMS OTP 已确认');
          return;
        }
      } catch { /* rotate */ }
      if (!this.sms?.rotatePhone || rotations >= this.maxPhoneRotations) {
        throw protoError('PayPal OTP 验证失败', { code: 'SMS_OTP_FAILED' });
      }
      const next = await this.sms.rotatePhone('OTP confirmation failed');
      this.updateUserPhone(next);
      rotations += 1;
    }
    throw protoError('任务已取消', { code: 'JOB_CANCELLED' });
  }

  async sendSignupAttempt(token, signupUrl) {
    try {
      await this.session.graphql('InstallmentOptionsQuery', INSTALLMENT_OPTIONS_QUERY, {
        buyerCountry: this.country,
        cardNumber: this.card.number,
        cardType: cardIssuerType(this.card.number),
        token,
      });
    } catch { /* optional */ }
    await sendSignupFieldEvents(this.session, token, [
      'email', 'phone', 'cardNumber', 'cardExpiry', 'cardCvv', 'password',
      'firstName', 'lastName', 'billingLine1', 'billingCity', 'billingPostalCode', 'billingState', 'dateOfBirth',
    ]);
    await sendWeasleyLog(this.session, this.state.ec_token, signupUrl, [
      'weasley_create_account_and_pay_submit',
      'weasley_api_request_sign_up_new_member_mutation',
    ], { country: this.country, lang: this.lang });
    const pacedMs = await paceSignupSubmission();
    if (pacedMs > 0) this.log(`注册提交间隔 ${((pacedMs) / 1000).toFixed(2)}s`);
    return this.session.graphql(
      'SignUpNewMemberMutation',
      SIGNUP_NEW_MEMBER_MUTATION,
      this.buildSignupVariables(token),
      { extraBody: { fn_sync_data: buildSignupFnSyncData(token, this.userAgent, this.signals) } },
    );
  }

  async signupWithCardRetry(token, signupUrl) {
    await this.session.setEuatToken('');
    let lastErrors = [];
    let lastAccess = '';
    for (let attempt = 1; attempt <= this.maxCardAttempts; attempt += 1) {
      this.assertActive();
      this.log(`提交注册资料与卡片（${attempt}/${this.maxCardAttempts}）`);
      const signupResult = await this.sendSignupAttempt(token, signupUrl);
      const consumed = consumeSignupResult(signupResult, this.state, (value) => this.session.setEuatToken(value));
      if (consumed.success) return;
      lastErrors = consumed.errors;
      const access = findAccessToken(consumed.errors);
      if (access) lastAccess = access;
      const confirmation = fundingConfirmationContext(consumed.errors);
      if (Object.keys(confirmation).length) {
        if (access) {
          await this.session.setEuatToken(access);
          this.log('资金工具需要额外确认，但已拿到会员 token，继续授权');
          return;
        }
        throw protoError('FUNDING_INSTRUMENT_3DS_REQUIRED_WITHOUT_EUAT', { code: 'FUNDING_3DS' });
      }
      if (hasSignupErrorMessage(consumed.errors, 'ACCOUNT_ALREADY_EXISTS')) {
        if (lastAccess) await this.session.setEuatToken(lastAccess);
        throw protoError('Signup failed: ACCOUNT_ALREADY_EXISTS', { code: 'ACCOUNT_ALREADY_EXISTS' });
      }
      if (isCardRelatedSignupError(consumed.errors)) {
        if (access) {
          await this.session.setEuatToken(access);
          this.log('卡片被拒但会员已创建，继续 Hermes 授权', 'debug');
          this.log('会员已创建，继续授权');
          return;
        }
        this.card = this.generateCard(this.country);
        this.log('卡片被拒，已更换地区 BIN 卡片重试', 'debug');
        continue;
      }
      if (isRetryableAddressError(consumed.errors)) {
        this.address = this.generateAddress(this.country);
        this.addressNormalized = false;
        try { await this.normalizeAddress(token); } catch { /* ignore */ }
        this.log('地址未被识别，已更换 GB 地址重试');
        continue;
      }
      if (isCreateMemberOasError(consumed.errors)) {
        const diagnostic = this.session.diagnosticSnapshot?.() || {};
        this.log(
          `OAS diagnostic: ec=${Boolean(this.state.ec_token)} ctx=${Boolean(this.state.ctx_id)} ssrt=${Boolean(this.state.ssrt)} debug_id=${diagnostic.last_graphql?.paypal_debug_id || '<missing>'}`,
        );
        throw protoError(
          'PAYPAL_ONBOARDING_CONTEXT_REBUILD: PayPal createMemberAccount rejected the current onboarding context (OAS_ERROR); rebuild a clean proxy, phone and session context',
          { code: 'PAYPAL_ONBOARDING_CONTEXT_REBUILD', recoverable: true },
        );
      }
      if (access) {
        await this.session.setEuatToken(access);
        this.log('注册响应含会员 token，继续授权');
        return;
      }
      break;
    }
    throw protoError(`Signup failed: no usable access token obtained. Last errors: ${JSON.stringify(lastErrors).slice(0, 400)}`, {
      code: 'SIGNUP_FAILED',
    });
  }

  async phase3SignupAnd2fa() {
    this.assertActive();
    if (!this.state.ec_token?.startsWith('EC-')) {
      throw protoError('IDENTITY_ELEVATION_EC_MISSING: signup requires an EC checkout token', {
        code: 'IDENTITY_ELEVATION_EC_MISSING',
      });
    }
    if (!this.state.signup_context_ready) {
      throw protoError('IDENTITY_ELEVATION_SIGNUP_CONTEXT_NOT_READY', { code: 'IDENTITY_ELEVATION_SIGNUP_CONTEXT_NOT_READY' });
    }
    const signupUrl = this.state.signup_url || 'https://www.paypal.com/checkoutweb/signup';
    await sendTealeafData(this.session, signupUrl);
    const token = this.state.ec_token || this.baToken;
    await this.confirmPhoneWithRetry(token, signupUrl);
    await this.signupWithCardRetry(token, signupUrl);
    if (!this.state.euat_token) {
      throw protoError('Signup failed: no access token obtained.', { code: 'SIGNUP_NO_EUAT' });
    }
    await this.session.setEuatToken(this.state.euat_token);
    await sendAnalyticsTs(this.session, 'main:billing:hagrid:billingwithoutpurchase:member:review', this.baToken, {
      ecToken: this.state.ec_token,
      userId: this.state.user_id,
      signals: this.signals,
    });
  }

  async syncBuyerContext(token, referer) {
    if (!this.state.euat_token) return false;
    await this.session.setEuatToken(this.state.euat_token);
    try {
      const result = await this.session.graphql('BuyerContextQuery', BUYER_CONTEXT_QUERY, { token }, {
        extraHeaders: {
          Referer: referer,
          'X-App-Name': 'checkoutuinodeweb',
          'X-PayPal-Internal-EUAT': this.state.euat_token,
          'PayPal-Client-Context': token,
          'PayPal-Client-Metadata-Id': this.state.paypal_client_metadata_id,
          'X-Country': this.country,
          'X-Locale': this.locale,
        },
        endpoint: 'https://www.paypal.com/graphql/',
      });
      const checkout = graphqlData(result, ['checkoutSession']);
      const buyer = checkout.buyer && typeof checkout.buyer === 'object' ? checkout.buyer : {};
      const auth = buyer.auth && typeof buyer.auth === 'object' ? buyer.auth : {};
      if (auth.accessToken) await this.session.setEuatToken(auth.accessToken);
      if (buyer.userId) {
        this.state.user_id = buyer.userId;
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async queryElevatedContext(token, referer) {
    const result = await this.session.graphql('BuyerFundingContextQuery', BUYER_FUNDING_CONTEXT_QUERY, { token }, {
      extraHeaders: {
        Referer: referer,
        'X-App-Name': 'checkoutuinodeweb',
        'X-PayPal-Internal-EUAT': this.state.euat_token,
        'PayPal-Client-Context': token,
        'PayPal-Client-Metadata-Id': this.state.paypal_client_metadata_id,
        'X-Country': this.country,
        'X-Locale': this.locale,
      },
      endpoint: 'https://www.paypal.com/graphql/',
    });
    let checkout = graphqlData(result, ['checkoutSession']);
    let buyer = checkout.buyer && typeof checkout.buyer === 'object' ? checkout.buyer : {};
    if (!buyer.userId) {
      const fallback = await this.session.graphql('BuyerContextQuery', BUYER_CONTEXT_QUERY, { token }, {
        extraHeaders: {
          Referer: referer,
          'X-App-Name': 'checkoutuinodeweb',
          'X-PayPal-Internal-EUAT': this.state.euat_token,
          'PayPal-Client-Context': token,
          'PayPal-Client-Metadata-Id': this.state.paypal_client_metadata_id,
          'X-Country': this.country,
          'X-Locale': this.locale,
        },
        endpoint: 'https://www.paypal.com/graphql/',
      });
      checkout = graphqlData(fallback, ['checkoutSession']);
      buyer = checkout.buyer && typeof checkout.buyer === 'object' ? checkout.buyer : {};
    }
    const auth = buyer.auth && typeof buyer.auth === 'object' ? buyer.auth : {};
    if (auth.accessToken) await this.session.setEuatToken(auth.accessToken);
    if (buyer.userId) this.state.user_id = buyer.userId;
    const item = firstItem(result) || {};
    const fundingErrors = (item.errors || []).filter((err) => err && typeof err === 'object');
    const messages = fundingErrors.map((err) => String(err.message || err.name || '').trim()).filter(Boolean);
    const fatal = messages.find((msg) => [
      'PAYER_ACCOUNT_RESTRICTED', 'PAYER_INVALID_FOR_PAYMENT', 'TRANSACTION_REFUSED', 'ACCOUNT_RESTRICTED', 'ACCOUNT_LOCKED',
    ].includes(msg)) || '';
    const funding = fundingSummary(checkout);
    return {
      buyer_ready: Boolean(buyer.userId && this.state.euat_token),
      user_id: buyer.userId || '',
      auth_refreshed: Boolean(auth.accessToken),
      funding_selected: funding.selected,
      funding_available: funding.available,
      funding_available_count: funding.available_count,
      funding_errors: messages,
      fatal_contingency: fatal,
    };
  }

  async protocolIdentityElevation() {
    const token = this.state.ec_token;
    if (!token?.startsWith('EC-')) throw protoError('IDENTITY_ELEVATION_EC_MISSING', { code: 'IDENTITY_ELEVATION_EC_MISSING' });
    if (!this.state.euat_token) throw protoError('IDENTITY_ELEVATION_EUAT_MISSING', { code: 'IDENTITY_ELEVATION_EUAT_MISSING' });
    if (!this.state.signup_context_ready) {
      throw protoError('IDENTITY_ELEVATION_SIGNUP_CONTEXT_NOT_READY', { code: 'IDENTITY_ELEVATION_SIGNUP_CONTEXT_NOT_READY' });
    }
    this.log('身份提升：访客 checkout → 会员 checkout');
    await this.session.setEuatToken(this.state.euat_token);
    const signupUrl = this.state.signup_url || this.buildSignupUrl();
    await this.session.get(signupUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: signupUrl,
        'Upgrade-Insecure-Requests': '1',
      },
    });
    const reviewReferer = `https://www.paypal.com/webapps/hermes?${new URLSearchParams({
      ssrt: this.state.ssrt,
      ul: '1',
      modxo_redirect_reason: 'guest_user',
      'locale.x': this.locale,
      'country.x': this.country,
      ba_token: this.baToken,
      token,
      rcache: '1',
      cookieBannerVariant: 'hidden',
      fromSignupLite: 'true',
      billingLite: '1',
    })}`;
    await this.loadReviewContext(reviewReferer, signupUrl);
    const context = await this.queryElevatedContext(token, reviewReferer);
    this.log(
      `身份提升完成（buyer=${context.buyer_ready} funding=${context.funding_available_count || 0}）`,
    );
    if (context.funding_errors?.length) {
      this.log(`身份提升 funding：${context.funding_errors.join(', ')}`, 'debug');
    }
    if (context.fatal_contingency) {
      throw protoError(`IDENTITY_ELEVATION_PAYER_RESTRICTED: ${context.fatal_contingency}`, {
        code: 'IDENTITY_ELEVATION_PAYER_RESTRICTED',
      });
    }
    if (!context.buyer_ready) {
      throw protoError('IDENTITY_ELEVATION_FAILED: member identity was not attached to the EC checkout', {
        code: 'IDENTITY_ELEVATION_FAILED',
      });
    }
    return context;
  }

  async phase4Authorize() {
    this.assertActive();
    this.log('最终授权 Billing Agreement');
    const elevation = await this.protocolIdentityElevation();
    const hermesBase = `https://www.paypal.com/webapps/hermes?ssrt=${this.state.ssrt}&ul=1&modxo_redirect_reason=guest_user&locale.x=${this.locale}&country.x=${this.country}&ba_token=${this.baToken}&token=${this.state.ec_token}&rcache=1&cookieBannerVariant=hidden&fromSignupLite=true&fallback=1&reason=Q0FSRF9HRU5FUklDX0VSUk9S`;
    const hermesContingency = `${hermesBase}&addFIContingency=noretry&redirectToHermes=true`;
    const reviewReferer = `${hermesBase}&billingLite=1`;
    try {
      await this.loadReviewContext(hermesContingency, this.state.signup_url);
      await this.loadReviewContext(reviewReferer, hermesContingency);
    } catch (error) {
      this.log(`加载 Hermes/Hagrid review 失败：${String(error?.message || error).slice(0, 160)}`, 'debug');
    }
    await this.session.setEuatToken(this.state.euat_token);
    try {
      await this.loadReviewContext(reviewReferer, hermesBase);
    } catch (error) {
      this.log(`EUAT 同步后重新加载 review 失败：${String(error?.message || error).slice(0, 160)}`, 'debug');
    }
    await sendTealeafData(this.session, `${reviewReferer}#/billingweb/review`);
    const billingAgreementId = this.state.ec_token || this.baToken;
    let buyerSynced = await this.syncBuyerContext(billingAgreementId, reviewReferer);
    if (this.strictBuyerContext && !buyerSynced) {
      throw protoError('BUYER_CONTEXT_SYNC_FAILED: member identity is not attached to the billing checkout', {
        code: 'BUYER_CONTEXT_SYNC_FAILED',
      });
    }
    const sendAuthorize = (includeClientContext = false) => {
      const extraHeaders = {
        Referer: reviewReferer,
        'X-App-Name': 'checkoutuinodeweb',
        'PayPal-Client-Metadata-Id': this.state.paypal_client_metadata_id,
      };
      if (includeClientContext) {
        extraHeaders['PayPal-Client-Context'] = billingAgreementId;
        extraHeaders['X-Country'] = this.country;
        extraHeaders['X-Locale'] = this.locale;
      } else {
        extraHeaders['PayPal-Client-Context'] = null;
        extraHeaders['X-Country'] = null;
        extraHeaders['X-Locale'] = null;
      }
      return this.session.graphql('authorize', AUTHORIZE_BILLING_MUTATION, {
        billingAgreementId,
        fundingPreference: { balancePreference: 'OPT_IN' },
        legalAgreements: {},
      }, { extraHeaders, batched: true, endpoint: 'https://www.paypal.com/graphql/' });
    };
    let result = await sendAuthorize(false);
    for (let retry = 1; retry <= 2 && hasBuyerNotSet(result); retry += 1) {
      this.log(`authorize 返回 BUYER_NOT_SET，重建会员上下文（${retry}/2）`);
      try {
        await this.loadReviewContext(reviewReferer, hermesBase);
        await this.session.setEuatToken(this.state.euat_token);
        buyerSynced = await this.syncBuyerContext(billingAgreementId, reviewReferer);
        if (this.strictBuyerContext && !buyerSynced) {
          throw protoError('BUYER_CONTEXT_SYNC_FAILED during BUYER_NOT_SET recovery', { code: 'BUYER_CONTEXT_SYNC_FAILED' });
        }
        await this.sleep(retry * 1000);
      } catch (error) {
        if (error?.code === 'BUYER_CONTEXT_SYNC_FAILED' || error?.code === 'JOB_CANCELLED') throw error;
        this.log(`Reloading billingLite review context failed: ${String(error?.message || error).slice(0, 160)}`, 'debug');
      }
      result = await sendAuthorize(true);
    }
    const parsed = parseAuthorizeResult(result);
    if (parsed.status !== 'success') {
      const debugId = this.session.lastGraphqlMeta?.paypal_debug_id || '';
      const httpStatus = this.session.lastGraphqlMeta?.status || '';
      const detail = parsed.graphql_errors?.length ? parsed.graphql_errors.join(', ') : 'empty';
      this.log(`authorize 空结果（errors=${detail}${httpStatus ? ` http=${httpStatus}` : ''}${debugId ? ` debug_id=${debugId}` : ''}）`);
      parsed.http_status = httpStatus;
      parsed.paypal_debug_id = debugId;
      parsed.buyer_mode = 'identity_elevation';
      parsed.identity_elevation = elevation;
      return parsed;
    }
    this.state.return_url = parsed.return_url;
    this.state.user_id = parsed.user_id || this.state.user_id;
    const reviewUrl = `${reviewReferer}#/billingweb/review`;
    const merchant = await followMerchantReturn(this.session, this.state.return_url, {
      referer: reviewUrl,
      log: (message, level) => this.log(message, level),
    });
    const finalRedirectUrl = merchant.finalRedirectUrl || this.state.return_url;
    const settlement = parseMerchantSettlement(finalRedirectUrl);
    await sendAnalyticsTs(
      this.session,
      'main:billing:hagrid:billingwithoutpurchase:member:submitButtonFullEvent',
      this.baToken,
      { ecToken: this.state.ec_token, userId: this.state.user_id, event: 'cl', signals: this.signals },
    );
    // Bounce URL is best-effort. After merchant return we wait 30s then
    // treat PayPal authorization as Plus success (accounts/check 401 is ignored).
    return {
      status: 'success',
      ba_token: parsed.ba_token,
      ec_token: this.state.ec_token,
      user_id: this.state.user_id,
      return_url: this.state.return_url,
      final_redirect_url: finalRedirectUrl,
      ...settlement,
      payment_action: parsed.payment_action,
      buyer_mode: 'identity_elevation',
      identity_elevation: elevation,
      paypal_authorized: true,
      merchant_followed: merchant.followed === true,
    };
  }
}

function baTokenFromLink(link) {
  const value = String(link || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return String(parsed.searchParams.get('ba_token') || '').trim();
  } catch {
    const match = value.match(/ba_token=([^&\s]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

module.exports = {
  PayPalFlow,
  GB_PROFILE,
  SIGNUP_SUBMIT_INTERVAL_MS,
  MERCHANT_RETURN_TIMEOUT_MS,
  MERCHANT_RETURN_WAIT_UNTIL,
  MERCHANT_RETURN_HARD_SLACK_MS,
  extractWindowInitialData,
  extractContentIdentifier,
  extractEcToken,
  findAccessToken,
  hasBuyerNotSet,
  graphqlErrorMessages,
  fundingSummary,
  consumeSignupResult,
  parseAuthorizeResult,
  parseMerchantSettlement,
  merchantReturnHeaders,
  reviewContextHeaders,
  followMerchantReturn,
  raceTimeout,
  applyNormalizedAddress,
  isCardRelatedSignupError,
  isRetryableAddressError,
  isCreateMemberOasError,
  isGraphqlChallengeError,
  paceSignupSubmission,
  resetSignupPaceForTests,
  baTokenFromLink,
};
