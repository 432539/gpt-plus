const { updateStateFromCookies } = require('./paypalProfile');

const EUAT_COOKIE = 'AV894Kt2TSumQQrJwe-8mzmyREO';
const PAYPAL_ORIGIN = 'https://www.paypal.com/';

function headerValue(headers, name) {
  if (!headers) return '';
  const wanted = String(name).toLowerCase();
  if (typeof headers.get === 'function') return String(headers.get(name) || headers.get(wanted) || '');
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return String(value || '');
  }
  return '';
}

function firstItem(payload) {
  return Array.isArray(payload) ? payload[0] : payload;
}

class PayPalSession {
  constructor(cloakSession, state, { country = 'GB', locale = 'en_GB', userAgent = '', emit } = {}) {
    this.cloak = cloakSession;
    this.state = state;
    this.country = country;
    this.locale = locale;
    this.userAgent = userAgent;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.lastGraphqlMeta = {};
  }

  async syncCookies() {
    try {
      const cookies = await this.cloak.cookies();
      updateStateFromCookies(this.state, cookies);
    } catch { /* ignore */ }
  }

  async setEuatToken(token) {
    const value = String(token || '');
    this.state.euat_token = value;
    if (!value || typeof this.cloak.page?.context !== 'function') return;
    try {
      await this.cloak.page.context().addCookies([{
        name: EUAT_COOKIE,
        value,
        domain: '.paypal.com',
        path: '/',
        secure: true,
      }]);
    } catch { /* ignore */ }
  }

  async request(url, {
    method = 'GET',
    headers = {},
    json,
    form,
    body,
    params,
    redirect = 'manual',
  } = {}) {
    const result = await this.cloak.request(url, {
      method,
      headers,
      json,
      form,
      body,
      params,
      redirect,
      timeout: 30000,
      contextUrl: PAYPAL_ORIGIN,
      referrer: headers.Referer || headers.referer || PAYPAL_ORIGIN,
    });
    await this.syncCookies();
    return result;
  }

  async get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  // Cross-origin merchant return (Stripe / ChatGPT checkout) must be a real
  // browser navigation. PayPalSession.request() always pins contextUrl to
  // paypal.com and uses page.evaluate(fetch), which CORS-blocks stripe.com
  // and is why production logged 「跟随商户回跳失败」.
  // Desktop\gpt session.get uses a 30s HTTP timeout per hop and waits for the
  // document body; 8s+commit aborted ChatGPT checkout/verify before the
  // callback landed. Default matches followMerchantReturn: load + 90s cap.
  async navigate(url, { headers = {}, timeout = 90_000, waitUntil = 'load' } = {}) {
    const result = await this.cloak.request(url, {
      method: 'GET',
      headers,
      timeout,
      waitUntil,
    });
    await this.syncCookies();
    return result;
  }

  async post(url, options = {}) {
    return this.request(url, { ...options, method: 'POST' });
  }

  async postGzip(url, buffer, headers = {}) {
    if (typeof this.cloak.page?.evaluate !== 'function') {
      return this.post(url, { body: buffer.toString('binary'), headers });
    }
    const bytes = Array.from(buffer);
    const result = await this.cloak.page.evaluate(async ({ target, requestHeaders, payload }) => {
      const body = new Uint8Array(payload);
      const response = await fetch(target, {
        method: 'POST',
        headers: requestHeaders,
        body,
        credentials: 'include',
        redirect: 'manual',
      });
      const outHeaders = {};
      response.headers.forEach((value, key) => { outHeaders[key] = value; });
      return { status: response.status, headers: outHeaders, text: await response.text(), url: response.url };
    }, { target: url, requestHeaders: headers, payload: bytes });
    await this.syncCookies();
    let data = null;
    try { data = JSON.parse(result.text); } catch { /* ignore */ }
    return { ...result, data };
  }

  async graphql(operationName, query, variables, {
    extraHeaders = {},
    extraBody = null,
    batched = false,
    endpoint = '',
  } = {}) {
    let url = endpoint || 'https://www.paypal.com/graphql';
    if (operationName && !endpoint) url = `${url}?${operationName}`;
    const contextToken = String(
      variables.token || variables.billingAgreementId || this.state.ec_token || this.state.ba_token || '',
    );
    const referer = this.state.ec_token
      ? (this.state.signup_url || PAYPAL_ORIGIN)
      : `https://www.paypal.com/pay?token=${this.state.ba_token}&ul=1`;
    const headers = {
      'Content-Type': 'application/json',
      'X-App-Name': operationName === 'authorize' ? 'checkoutuinodeweb' : 'checkoutuinodeweb_weasley',
      'X-Requested-With': 'fetch',
      'PayPal-Client-Context': contextToken,
      // Match Desktop\gpt session.py: checkoutweb/weasley GraphQL uses the EC/BA
      // token for both client context headers. A random metadata UUID breaks
      // createMemberAccount with OAS_ERROR/CONTEXT_REBUILD after OTP.
      'PayPal-Client-Metadata-Id': contextToken,
      'X-Country': this.country,
      'X-Locale': this.locale,
      Origin: 'https://www.paypal.com',
      Referer: referer,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    };
    if (this.state.euat_token) headers['X-PayPal-Internal-EUAT'] = this.state.euat_token;
    for (const [key, value] of Object.entries(extraHeaders || {})) {
      if (value == null) delete headers[key];
      else headers[key] = value;
    }
    const payloadItem = { operationName, variables, query };
    if (extraBody && typeof extraBody === 'object') Object.assign(payloadItem, extraBody);
    const resp = await this.post(url, { json: batched ? [payloadItem] : payloadItem, headers });
    const debugId = headerValue(resp.headers, 'paypal-debug-id');
    this.lastGraphqlMeta = { operation: operationName, status: resp.status, paypal_debug_id: debugId };
    // Desktop\gpt session.py: empty/non-JSON body raises PAYPAL_GRAPHQL_NON_JSON_RESPONSE,
    // not a parsed authorize result. Do not treat a blank HTTP body as AUTHORIZE_EMPTY.
    if (resp.data == null) {
      const prefix = String(resp.text || '').trim().slice(0, 200).toLowerCase();
      const code = prefix.startsWith('<!doctype html') || prefix.startsWith('<html')
        ? 'PAYPAL_GRAPHQL_HTML_CHALLENGE'
        : 'PAYPAL_GRAPHQL_NON_JSON_RESPONSE';
      throw Object.assign(
        new Error(`${code}: operation=${operationName} status=${resp.status} paypal_debug_id=${debugId || '<missing>'}`),
        { code, status: resp.status, recoverable: true },
      );
    }
    return resp.data;
  }

  diagnosticSnapshot() {
    return { last_graphql: { ...this.lastGraphqlMeta } };
  }
}

async function followRedirects(session, response, { max = 8, referer = PAYPAL_ORIGIN, headers = {} } = {}) {
  let current = response;
  let currentReferer = referer;
  for (let i = 0; i < max; i += 1) {
    if (![301, 302, 303, 307, 308].includes(Number(current.status))) return current;
    const location = headerValue(current.headers, 'location');
    if (!location) return current;
    const nextUrl = new URL(location.split(';')[0], current.url || PAYPAL_ORIGIN).href;
    current = await session.get(nextUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: currentReferer,
        'Upgrade-Insecure-Requests': '1',
        ...headers,
      },
    });
    currentReferer = nextUrl;
  }
  return current;
}

module.exports = { PayPalSession, headerValue, firstItem, followRedirects, EUAT_COOKIE };
