'use strict';

/**
 * Corresponds to gcash_chain.py:GCashChain and GCashSessionManager.
 */

const crypto = require('node:crypto');
const {
  OPENAI_BASE,
  CHECKOUT_BASE,
  CONTINUE_PATH,
  ENTITLEMENT_URL,
  PROCESSOR_ENTITY,
  PLAN_NAME,
  PROMO_CAMPAIGN,
  QR_TTL_SECONDS,
  CALLBACK_MAX_ATTEMPTS,
  CALLBACK_RETRY_DELAYS,
  CALLBACK_VERIFY_DELAYS,
  BROWSER_PROFILE,
  CHROME_USER_AGENT,
  TokenRevokedError,
  QueueFullError,
  sleep,
  headers: buildHeaders,
  ensureFullChainProxySupported,
  proxyUrl,
  verifyPageContext,
  extractCheckoutId,
  extractPrefixedString,
  extractProcessorEntity,
  extractCpmt,
  checkoutMethodDiag,
  checkoutAmount,
  isAdyenCheckoutRedirect,
  isGcashUrl,
  retryDecision,
  callbackErrorIsRetryable,
  callbackActionResult,
  explicitPaymentStatus,
  activePlusEntitlement,
  sanitizeContinueContextHeaders,
  payloadStatus,
  CALLBACK_SUCCESS_STATUSES,
  CALLBACK_ACCEPTED_STATUSES,
  randBits63,
  tokenHex,
} = require('./protocol');
const {
  MAX_ATTEMPTS,
  MAX_WORKERS,
  MAX_QUEUE_SIZE,
  MAX_CONCURRENCY,
  MAX_SESSION_CONCURRENCY,
  MAX_QUEUE,
} = require('./limits');
const { createCurlCffiSession, browserCookies, sessionCookieHeader, requestJson } = require('./httpSession');
const { mintSentinelSync } = require('./sentinel');
const paymentMonitor = require('./paymentMonitor').manager;

class GCashChain {
  constructor({
    token,
    clientAccountId,
    phProxy = null,
    vnProxy = null,
    accountId = null,
    billingEmail = '',
    billingName = '',
    onUpdate = null,
    proxy = null,
    cancelCheck = null,
    requestImpl = null,
    mintSentinel = null,
    monitor = null,
  }) {
    this.token = token;
    this.clientAccountId = clientAccountId;
    this.accountId = String(accountId || '');
    this.proxy = proxy || phProxy || vnProxy;
    this.phProxy = this.proxy;
    this.vnProxy = this.proxy;
    this.cid = null;
    this.cpmt = null;
    this.processorEntity = PROCESSOR_ENTITY;
    this.promoApplied = false;
    this.checkoutAmount = null;
    this.checkoutAmountSource = '';
    this.billingEmail = String(billingEmail || '').trim();
    this.billingName = String(billingName || '').trim() || 'GCash User';
    this.adyenUrl = null;
    this.gcashUrl = null;
    this.paymentRoute = '';
    this.qrText = null;
    this.qrShort = null;
    this.netAuthId = null;
    this.qrExpiresAt = null;
    this.monitorId = null;
    this.callbackStatus = 'unavailable';
    this.status = 'pending';
    this.errorMessage = '';
    this.currentStep = 'init';
    this.steps = [];
    [this.tlsImpersonate, this.chromeMajor, this.chromeFullVersion] = BROWSER_PROFILE;
    this.userAgent = (
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) '
      + `Chrome/${this.chromeFullVersion} Safari/537.36`
    );
    this.deviceId = crypto.randomUUID();
    this.oaiSessionId = crypto.randomUUID();
    this.datadogTraceId = randBits63();
    this.datadogParentId = randBits63();
    this.frontendContext = {};
    this._frontendContextPrepared = false;
    this.preflightProxyTrace = { country: '', ip: '' };
    this._session = null;
    this._cookies = [];
    this._sessionTransferred = false;
    this._onUpdate = onUpdate;
    this._cancelCheck = cancelCheck;
    this._requestImpl = requestImpl;
    this._mintSentinel = mintSentinel || mintSentinelSync;
    this._monitor = monitor || paymentMonitor;
    this._closed = false;
  }

  /** gcash_chain.py:GCashChain._fingerprint_headers */
  _fingerprintHeaders() {
    return {
      'User-Agent': this.userAgent,
      'oai-device-id': this.deviceId,
      'oai-language': 'en-US',
      'sec-ch-ua': (
        `"Google Chrome";v="${this.chromeMajor}", `
        + `"Chromium";v="${this.chromeMajor}", "Not.A/Brand";v="24"`
      ),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      priority: 'u=1, i',
    };
  }

  /** gcash_chain.py:GCashChain._frontend_api_context_headers */
  _frontendApiContextHeaders() {
    const headers = {
      'oai-session-id': this.oaiSessionId,
      'x-datadog-origin': 'rum',
      'x-datadog-sampling-priority': '1',
      'x-datadog-trace-id': this.datadogTraceId,
      'x-datadog-parent-id': this.datadogParentId,
    };
    const canonical = {
      'oai-session-id': 'oai-session-id',
      'oai-web-deployment-attestation': 'oai-web-deployment-attestation',
      'x-oai-is-client-observation': 'x-oai-is-client-observation',
      'oai-client-build-number': 'oai-client-build-number',
      'oai-client-version': 'oai-client-version',
    };
    for (const [source, target] of Object.entries(canonical)) {
      const value = String(this.frontendContext[source] || '').trim();
      if (value) headers[target] = value;
    }
    return headers;
  }

  async _ensureSession() {
    if (this._session || this._requestImpl) {
      if (!this._session && this._requestImpl) {
        this._session = {
          impersonate: this.tlsImpersonate,
          async setCookie() {},
          async cookies() { return []; },
          async close() {},
        };
      }
      return this._session;
    }
    this._session = await createCurlCffiSession(this.tlsImpersonate);
    try {
      await this._session.setCookie('oai-did', this.deviceId, { domain: '.chatgpt.com', path: '/' });
    } catch { /* open source swallows */ }
    return this._session;
  }

  async _http(method, url, reqHeaders, data = null, extra = {}) {
    const impl = this._requestImpl || requestJson;
    const session = extra.useSession === false ? null : await this._ensureSession();
    const result = await impl(method, url, reqHeaders, data, {
      timeout: extra.timeout,
      proxy: extra.proxy ?? this.proxy,
      followRedirect: extra.followRedirect,
      session,
      impersonate: this.tlsImpersonate,
    });
    if (session && typeof session.cookies === 'function') {
      try { this._cookies = await session.cookies(); } catch { /* keep previous */ }
    }
    return result;
  }

  async _prepareFrontendContext() {
    if (this._frontendContextPrepared) return;
    this._frontendContextPrepared = true;
    try {
      const context = await this._monitor.collectFrontendContext({
        proxy: this.proxy,
        token: this.token,
        accountId: this.accountId,
        cookies: browserCookies(this._cookies),
        deviceId: this.deviceId,
        userAgent: this.userAgent,
      });
      const native = sanitizeContinueContextHeaders((context || {}).headers);
      const nativeAccountId = native['chatgpt-account-id'] || '';
      const nativeDeviceId = native['oai-device-id'] || '';
      if (this.accountId && nativeAccountId !== this.accountId) return;
      if (nativeDeviceId && nativeDeviceId !== this.deviceId) return;
      Object.assign(this.frontendContext, native);
      this._mergeBrowserCookies(context);
    } catch {
      return;
    }
  }

  async _bootstrap(proxy, pageUrl = null) {
    pageUrl = pageUrl || `${OPENAI_BASE}/`;
    const reqHeaders = buildHeaders({ token: null, contentType: null, html: true });
    Object.assign(reqHeaders, this._fingerprintHeaders());
    reqHeaders['Sec-Fetch-Site'] = 'none';
    const { text } = await this._http('GET', pageUrl, reqHeaders, null, {
      proxy,
      followRedirect: true,
    });
    const pageContext = verifyPageContext(text);
    const headerMap = {
      oai_session_id: 'oai-session-id',
      web_deployment_attestation: 'oai-web-deployment-attestation',
      client_build_number: 'oai-client-build-number',
      client_version: 'oai-client-version',
    };
    for (const [source, target] of Object.entries(headerMap)) {
      const value = String(pageContext[source] || '').trim();
      if (value && !this.frontendContext[target]) this.frontendContext[target] = value;
    }
  }

  async _preflightProxy() {
    if (!this.proxy) return { country: '', ip: '' };
    ensureFullChainProxySupported(this.proxy);
    const reqHeaders = buildHeaders({ token: null, contentType: null, html: true });
    Object.assign(reqHeaders, this._fingerprintHeaders());
    reqHeaders['Sec-Fetch-Site'] = 'none';
    const { text } = await this._http('GET', `${OPENAI_BASE}/cdn-cgi/trace`, reqHeaders, null, {
      proxy: this.proxy,
      followRedirect: true,
    });
    const trace = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx > 0) trace[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    const country = String(trace.loc || '').toUpperCase();
    if (country !== 'PH') {
      const detected = country || 'unknown';
      throw new Error(`代理预检失败：出口不是 PH（检测到 ${detected}）`);
    }
    const ip = String(trace.ip || '').trim();
    if (!ip) throw new Error('代理预检失败：ChatGPT trace 未返回出口 IP');
    return { country, ip };
  }

  async _verifyProxyStability() {
    if (!this.proxy) return;
    const baselineIp = String((this.preflightProxyTrace || {}).ip || '').trim();
    if (!baselineIp) throw new Error('代理预检失败：缺少可复核的初始出口 IP');
    const current = await this._preflightProxy();
    if (String(current.ip || '').trim() !== baselineIp) {
      throw new Error('PROXY_EXIT_DRIFT: 代理出口在建单前发生变化，已阻止 Checkout 请求');
    }
  }

  _checkoutHeaders(locale = 'en-US,en;q=0.9', includeAccount = true) {
    const reqHeaders = buildHeaders({
      token: this.token,
      accountId: includeAccount ? this.accountId : null,
    });
    Object.assign(reqHeaders, this._fingerprintHeaders(), this._frontendApiContextHeaders());
    reqHeaders['Accept-Language'] = locale;
    if (this.cid) {
      reqHeaders.Referer = `${OPENAI_BASE}/checkout/${this.processorEntity}/${this.cid}`;
    }
    return reqHeaders;
  }

  _mergeBrowserCookies(context) {
    for (const cookie of (context || {}).cookies || []) {
      this._cookies.push({
        name: String(cookie.name || ''),
        value: String(cookie.value || ''),
        domain: String(cookie.domain || '.chatgpt.com'),
        path: String(cookie.path || '/'),
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        expires: cookie.expires,
      });
      if (this._session && typeof this._session.setCookie === 'function') {
        this._session.setCookie(cookie.name, cookie.value, {
          domain: cookie.domain || '.chatgpt.com',
          path: cookie.path || '/',
        }).catch(() => {});
      }
    }
  }

  async _sentinelHeaders(flow, pageUrl) {
    let main;
    let so;
    try {
      ({ main, so } = await this._mintSentinel({
        flow,
        deviceId: this.deviceId,
        userAgent: this.userAgent,
        proxy: proxyUrl(this.proxy) || '',
        pageUrl,
        language: 'en-PH',
        timezone: 'Asia/Manila',
        cookieHeader: sessionCookieHeader(this._cookies),
        timeoutS: 120,
      }));
    } catch (exc) {
      throw new Error(`Sentinel 生成失败（flow=${flow}）：${String(exc?.message || exc).slice(0, 160)}`);
    }
    const reqHeaders = {
      'OpenAI-Sentinel-Token': main,
      'OAI-Telemetry': '[1,null]',
    };
    if (so) reqHeaders['OpenAI-Sentinel-So-Token'] = so;
    return reqHeaders;
  }

  _mergeCheckoutResponse(response) {
    const cpmt = extractCpmt(response);
    if (cpmt) this.cpmt = cpmt;
    const { amount, source } = checkoutAmount(response);
    if (source) {
      this.checkoutAmount = amount;
      this.checkoutAmountSource = source;
      this.promoApplied = amount === 0;
    }
  }

  _notify() {
    if (!this._onUpdate) return;
    try { this._onUpdate(this._result()); } catch { /* ignore */ }
  }

  _raiseIfCancelled() {
    if (this._cancelCheck && this._cancelCheck()) {
      throw new Error('TASK_CANCELLED: 用户已停止任务');
    }
  }

  _addStep(key, label) {
    this.currentStep = key;
    this.steps.push({ key, label, state: 'active' });
    this._notify();
  }

  _setStepDone(key) {
    for (const step of this.steps) {
      if (step.key === key) step.state = 'done';
    }
    this._notify();
  }

  _setStepError(key, msg) {
    for (const step of this.steps) {
      if (step.key === key) step.state = 'error';
    }
    this.errorMessage = msg;
    this._notify();
  }

  async run() {
    try {
      this.status = 'running';
      this._notify();

      this._raiseIfCancelled();
      this._addStep('proxy_test', '验证 PH 代理出口');
      this.preflightProxyTrace = await this._preflightProxy();
      this._setStepDone('proxy_test');

      this._raiseIfCancelled();
      this._addStep('create_checkout', '创建 Checkout');
      await this._createCheckout();
      this._setStepDone('create_checkout');

      this._raiseIfCancelled();
      this._addStep('configure_taxes', '同步 PH/PHP 税费');
      await this._syncCheckoutTaxes();
      this._setStepDone('configure_taxes');

      this._raiseIfCancelled();
      this._addStep('confirm_payment', '确认支付方式');
      await this._confirmPayment();
      this._setStepDone('confirm_payment');

      this._raiseIfCancelled();
      this._addStep('start_payment', '启动支付');
      await this._startPayment();
      this._setStepDone('start_payment');

      this._raiseIfCancelled();
      this._addStep('follow_redirect', '启动 GCash 扫码监控');
      await this._followRedirect();
      this._setStepDone('follow_redirect');

      this.errorMessage = '';
      this.status = 'success';
      this._notify();
      return this._result();
    } catch (error) {
      this.status = 'failed';
      this._setStepError(this.currentStep, String(error?.message || error));
      return this._result();
    } finally {
      if (!this._sessionTransferred) await this._closeSession();
    }
  }

  async _closeSession() {
    if (this._closed) return;
    this._closed = true;
    if (this._session && typeof this._session.close === 'function') {
      try { await this._session.close(); } catch { /* ignore */ }
    }
  }

  /** gcash_chain.py:GCashChain._create_checkout */
  async _createCheckout() {
    const url = CHECKOUT_BASE;
    const body = {
      entry_point: 'all_plans_pricing_modal',
      plan_name: PLAN_NAME,
      billing_details: { country: 'PH', currency: 'PHP' },
      promo_campaign: { ...PROMO_CAMPAIGN },
      checkout_ui_mode: 'custom',
      check_card_proxy: true,
    };
    const proxy = this.proxy;
    const checkoutPageUrl = `${OPENAI_BASE}/?promo_campaign=${encodeURIComponent(PROMO_CAMPAIGN.promo_campaign_id)}`;
    try {
      await this._prepareFrontendContext();
      await this._bootstrap(proxy, checkoutPageUrl);
      await this._verifyProxyStability();
      const reqHeaders = this._checkoutHeaders('en-PH');
      reqHeaders.Accept = '*/*';
      reqHeaders.Referer = checkoutPageUrl;
      let resp;
      let usedSentinel = false;
      try {
        ({ json: resp } = await this._http('POST', url, reqHeaders, body, { proxy }));
      } catch (exc) {
        if (!String(exc?.message || exc).toLowerCase().includes('unusual activity')) throw exc;
        Object.assign(reqHeaders, await this._sentinelHeaders('chatgpt_checkout', checkoutPageUrl));
        usedSentinel = true;
        ({ json: resp } = await this._http('POST', url, reqHeaders, body, { proxy }));
      }
      let cid = extractCheckoutId(resp);
      let cpmt = extractCpmt(resp);
      this._createDiag = checkoutMethodDiag(resp);
      if (cid && !cpmt && !usedSentinel) {
        Object.assign(reqHeaders, await this._sentinelHeaders('chatgpt_checkout', checkoutPageUrl));
        ({ json: resp } = await this._http('POST', url, reqHeaders, body, { proxy }));
        cid = extractCheckoutId(resp);
        cpmt = extractCpmt(resp);
        this._createDiag = `sentinel_empty_cpmt ${checkoutMethodDiag(resp)}`;
      }
      if (!cid) {
        const stripeCid = extractPrefixedString(resp, 'cs_');
        if (stripeCid) throw new Error('创建 checkout 失败：账号被分配到 Stripe，无法使用 GCash');
        throw new Error(`创建 checkout 失败：未获取到 cid（响应：${JSON.stringify(resp).slice(0, 300)}）`);
      }
      this.cid = cid;
      this.processorEntity = extractProcessorEntity(resp) || PROCESSOR_ENTITY;
      this.cpmt = cpmt;
      this._mergeCheckoutResponse(resp);
    } catch (exc) {
      if (String(exc?.message || exc).toLowerCase().includes('unusual activity')) {
        const context = this._frontendApiContextHeaders();
        throw new Error(
          `${exc.message} [frontend_context `
          + `observation=${Boolean(context['x-oai-is-client-observation'])} `
          + `session=${Boolean(context['oai-session-id'])} `
          + `build=${Boolean(context['oai-client-build-number'])}]`,
        );
      }
      if (exc instanceof Error && (
        String(exc.message).includes('创建 checkout')
        || String(exc.message).includes('HTTP ')
        || String(exc.message).includes('连接')
        || String(exc.message).includes('Sentinel')
        || String(exc.message).includes('PROXY_')
        || String(exc.message).includes('代理')
      )) {
        throw exc;
      }
      throw new Error(`创建 checkout 异常：${String(exc?.message || exc)}`);
    }
  }

  /** gcash_chain.py:GCashChain._sync_checkout_taxes */
  async _syncCheckoutTaxes() {
    if (!this.cid) throw new Error('缺少 checkout ID，无法同步 taxes');
    const body = {
      checkout_session_id: this.cid,
      checkout_email: this.billingEmail || null,
      billing_country: 'PH',
      billing_name: this.billingName || null,
      currency: 'PHP',
      tax_id: null,
      processor_entity: this.processorEntity,
      billing_address: { country: 'PH' },
    };
    const { json: taxesResp, status: taxesStatus } = await this._http(
      'POST',
      `${CHECKOUT_BASE}/taxes`,
      this._checkoutHeaders('en-PH,en;q=0.9'),
      body,
      { proxy: this.proxy },
    );
    this._mergeCheckoutResponse(taxesResp);
    if (!this.promoApplied) {
      const amount = this.checkoutAmount != null ? this.checkoutAmount : 'unknown';
      throw new Error(`promo_not_applied: taxes 后 checkout 金额未变为 0（amount=${amount}）`);
    }
    if (!this.cpmt) {
      throw new Error(
        `GCASH_CUSTOM_METHOD_MISSING: taxes 后仍未出现 GCash cpmt_（HTTP ${taxesStatus || 200} `
        + `create=${this._createDiag || 'n/a'} taxes=${checkoutMethodDiag(taxesResp)}）`,
      );
    }
  }

  /** gcash_chain.py:GCashChain._confirm_payment — always mints checkout_session_approval */
  async _confirmPayment() {
    if (!this.cid) throw new Error('缺少 checkout ID，无法确认支付');
    if (!this.cpmt) throw new Error('缺少 GCash 支付方式，无法确认支付');
    const url = `${CHECKOUT_BASE}/confirm`;
    const body = {
      checkout_session_id: this.cid,
      selected_payment_method_type: this.cpmt,
    };
    const proxy = this.proxy;
    const checkoutPageUrl = `${OPENAI_BASE}/checkout/${this.processorEntity}/${this.cid}`;
    await this._bootstrap(proxy, checkoutPageUrl);
    const reqHeaders = this._checkoutHeaders('en-PH');
    reqHeaders.Accept = '*/*';
    Object.assign(reqHeaders, await this._sentinelHeaders('checkout_session_approval', checkoutPageUrl));
    try {
      const { json: resp } = await this._http('POST', url, reqHeaders, body, { proxy });
      const status = String(resp.status || '').toLowerCase();
      if (status === 'blocked') throw new Error('confirm_blocked: OAICS confirm status=blocked');
      if (status !== 'success' && !resp.confirm_return_url) {
        throw new Error(`确认支付失败：status=${status || 'unknown'}`);
      }
    } catch (exc) {
      if (exc instanceof Error && (
        String(exc.message).includes('confirm')
        || String(exc.message).includes('确认支付')
        || String(exc.message).includes('HTTP ')
        || String(exc.message).includes('Sentinel')
        || String(exc.message).includes('连接')
      )) {
        throw exc;
      }
      throw new Error(`确认支付异常：${String(exc?.message || exc)}`);
    }
  }

  /** gcash_chain.py:GCashChain._start_payment */
  async _startPayment() {
    if (!this.cid) throw new Error('缺少 checkout ID，无法启动支付');
    const url = `${CHECKOUT_BASE}/custom_payment_method/start`;
    const body = {
      checkout_session_id: this.cid,
      custom_payment_method_type_id: this.cpmt,
    };
    const reqHeaders = this._checkoutHeaders('en-PH,en;q=0.9');
    try {
      const { json: resp } = await this._http('POST', url, reqHeaders, body, { proxy: this.proxy });
      const status = String(resp.status || '').toLowerCase();
      const nextAction = resp.next_action || {};
      const navigationUrl = nextAction.url || resp.redirect_url || resp.url || '';
      const paymentMethod = String(nextAction.paymentMethodType || '').toLowerCase();
      const actionType = String(nextAction.type || '').toLowerCase();
      const actionMethod = String(nextAction.method || '').toUpperCase();
      if (status !== 'requires_action') {
        throw new Error(`启动支付返回异常状态：${status || 'unknown'}`);
      }
      if (paymentMethod !== 'gcash' || actionType !== 'redirect' || actionMethod !== 'GET') {
        throw new Error('启动支付未返回标准 GCash redirect action');
      }
      if (!isAdyenCheckoutRedirect(navigationUrl)) {
        throw new Error('启动支付未返回可信的 Adyen CheckoutShopper 长链');
      }
      this.adyenUrl = navigationUrl;
      this.paymentRoute = 'adyen_redirect';
    } catch (exc) {
      if (exc instanceof Error && (
        String(exc.message).includes('启动支付')
        || String(exc.message).includes('HTTP ')
        || String(exc.message).includes('连接')
      )) {
        throw exc;
      }
      throw new Error(`启动支付异常：${String(exc?.message || exc)}`);
    }
  }

  async _fetchEntitlementState() {
    const reqHeaders = this._checkoutHeaders();
    reqHeaders['Cache-Control'] = 'no-cache';
    reqHeaders.Pragma = 'no-cache';
    const { json: state } = await this._http('GET', ENTITLEMENT_URL, reqHeaders, null, {
      proxy: this.phProxy,
    });
    return state;
  }

  async _verifiedEntitlementState(attempts, delays) {
    for (const delay of delays) {
      if (delay) await sleep(delay);
      let state;
      try { state = await this._fetchEntitlementState(); } catch { continue; }
      if (activePlusEntitlement(state, this.accountId)) {
        return {
          status: 'completed',
          _callback_attempts: attempts,
          _callback_verified_by: 'plus_entitlement',
          _entitlement_verified: true,
        };
      }
    }
    return null;
  }

  async _verifyExternalCallbackState() {
    return this._verifiedEntitlementState(0, [0]);
  }

  async _loadCheckoutVerifyContext(redirectResult) {
    const query = new URLSearchParams({
      stripe_session_id: this.cid,
      processor_entity: this.processorEntity,
      plan_type: 'plus',
      currency: 'PHP',
      redirectResult,
    }).toString();
    const verifyUrl = `${OPENAI_BASE}/checkout/verify?${query}`;
    const reqHeaders = buildHeaders({
      token: this.token,
      accountId: this.accountId,
      contentType: null,
      html: true,
    });
    Object.assign(reqHeaders, this._fingerprintHeaders());
    reqHeaders.Referer = 'https://m.gcash.com/';
    const { text } = await this._http('GET', verifyUrl, reqHeaders, null, {
      proxy: this.proxy,
      followRedirect: true,
    });
    const context = verifyPageContext(text);
    const verifyAccountId = context.account_id || '';
    if (this.accountId && verifyAccountId && verifyAccountId !== this.accountId) {
      throw new Error('checkout verify 账号与提链账号不一致');
    }
    return { verifyUrl, context };
  }

  _continueHeaders(verifyUrl, verifyContext, nativeContextHeaders = null) {
    const reqHeaders = this._checkoutHeaders('en-PH,en;q=0.9');
    reqHeaders.Referer = verifyUrl;
    reqHeaders['x-openai-target-path'] = CONTINUE_PATH;
    reqHeaders['x-openai-target-route'] = CONTINUE_PATH;
    const headerMap = {
      account_id: 'ChatGPT-Account-Id',
      oai_session_id: 'oai-session-id',
      web_deployment_attestation: 'oai-web-deployment-attestation',
      client_build_number: 'oai-client-build-number',
      client_version: 'oai-client-version',
    };
    for (const [key, header] of Object.entries(headerMap)) {
      const value = String((verifyContext || {})[key] || '').trim();
      if (value) reqHeaders[header] = value;
    }
    let native = sanitizeContinueContextHeaders(nativeContextHeaders);
    const nativeAccountId = native['chatgpt-account-id'] || '';
    const expectedAccountId = String(this.accountId || (verifyContext || {}).account_id || '');
    const nativeDeviceId = native['oai-device-id'] || '';
    if (Object.keys(native).length && (
      !expectedAccountId
      || nativeAccountId !== expectedAccountId
      || (this.deviceId && nativeDeviceId !== this.deviceId)
    )) {
      native = {};
    }
    const canonicalHeaders = {
      'oai-session-id': 'oai-session-id',
      'oai-web-deployment-attestation': 'oai-web-deployment-attestation',
      'x-oai-is-client-observation': 'x-oai-is-client-observation',
      'oai-client-build-number': 'oai-client-build-number',
      'oai-client-version': 'oai-client-version',
      'oai-device-id': 'oai-device-id',
    };
    for (const [sourceName, targetName] of Object.entries(canonicalHeaders)) {
      const value = native[sourceName] || '';
      if (!value) continue;
      if (sourceName === 'oai-device-id' && this.deviceId && value !== this.deviceId) continue;
      reqHeaders[targetName] = value;
    }
    return reqHeaders;
  }

  static _acceptedCallbackResponse(status, attempts) {
    return {
      status: 'callback_processing',
      _callback_accepted: true,
      _continue_status: String(status || 'accepted').slice(0, 40),
      _callback_attempts: attempts,
      _callback_verified_by: 'continue_accepted',
    };
  }

  /** gcash_chain.py:GCashChain._continue_payment — HTTP continue fallback used by the monitor */
  async _continuePayment(redirectResult, nativeActionResult = null, nativeContextHeaders = null) {
    if (!this.cid || !redirectResult) throw new Error('支付回调参数不完整');
    const body = {
      checkout_session_id: this.cid,
      action_result: callbackActionResult(redirectResult, nativeActionResult),
    };
    const verifiedNow = await this._verifiedEntitlementState(0, [0]);
    if (verifiedNow) return verifiedNow;
    let lastError = null;
    let verifyUrl = '';
    let verifyContext = {};
    for (let attempt = 1; attempt <= CALLBACK_MAX_ATTEMPTS; attempt += 1) {
      try {
        if (!verifyUrl) {
          ({ verifyUrl, context: verifyContext } = await this._loadCheckoutVerifyContext(redirectResult));
        }
        const { json: response } = await this._http(
          'POST',
          `${CHECKOUT_BASE}/custom_payment_method/continue`,
          this._continueHeaders(verifyUrl, verifyContext, nativeContextHeaders),
          body,
          { proxy: this.proxy },
        );
        const status = payloadStatus(response);
        const paymentStatus = explicitPaymentStatus(response);
        const acceptedStatus = paymentStatus || status;
        if (CALLBACK_SUCCESS_STATUSES.has(paymentStatus) || CALLBACK_ACCEPTED_STATUSES.has(status)) {
          const verified = await this._verifiedEntitlementState(attempt, CALLBACK_VERIFY_DELAYS);
          if (verified) return verified;
          return GCashChain._acceptedCallbackResponse(acceptedStatus, attempt);
        }
        const verified = await this._verifiedEntitlementState(attempt, CALLBACK_VERIFY_DELAYS);
        if (verified) return verified;
        throw new Error(`continue 回调未被明确受理：${status || paymentStatus || 'unknown'}`);
      } catch (exc) {
        lastError = exc;
        const retryable = callbackErrorIsRetryable(exc);
        const delays = attempt >= CALLBACK_MAX_ATTEMPTS
          ? CALLBACK_VERIFY_DELAYS
          : CALLBACK_VERIFY_DELAYS.slice(0, 2);
        const verified = await this._verifiedEntitlementState(attempt, delays);
        if (verified) return verified;
        if (!retryable || attempt >= CALLBACK_MAX_ATTEMPTS) throw exc;
        await sleep(CALLBACK_RETRY_DELAYS[attempt - 1]);
      }
    }
    throw lastError || new Error('continue 回调失败');
  }

  /** gcash_chain.py:GCashChain._follow_redirect */
  async _followRedirect() {
    const navigationUrl = this.adyenUrl || this.gcashUrl;
    if (!navigationUrl) throw new Error('缺少 Adyen 或 GCash 支付页面 URL');
    try {
      this._sessionTransferred = true;
      const { monitorId, gcashUrl, expiresAt } = await this._monitor.start({
        navigationUrl,
        proxy: this.proxy,
        token: this.token,
        accountId: this.accountId,
        clientAccountId: this.clientAccountId,
        deviceId: this.deviceId,
        userAgent: this.userAgent,
        cookies: browserCookies(this._cookies),
        continueCallback: (redirectResult, nativeActionResult, nativeContextHeaders) => (
          this._continuePayment(redirectResult, nativeActionResult, nativeContextHeaders)
        ),
        verifyCallback: () => this._verifyExternalCallbackState(),
        closeCallback: () => { this._closeSession(); },
      });
      this.monitorId = monitorId;
      this.callbackStatus = 'waiting_scan';
      this.gcashUrl = gcashUrl;
      this._parseGcashUrl(gcashUrl);
      this.qrExpiresAt = expiresAt;
    } catch (exc) {
      if (exc instanceof Error && (
        String(exc.message).includes('GCash')
        || String(exc.message).includes('后台')
        || String(exc.message).includes('支付')
      )) {
        throw exc;
      }
      throw new Error(`跟随跳转异常：${String(exc?.message || exc)}`);
    }
  }

  _parseGcashUrl(url) {
    if (!isGcashUrl(url)) throw new Error('返回链接不是可信的 GCash 域名');
    const parsed = new URL(url);
    const netAuth = parsed.searchParams.get('netAuthId') || '';
    if (netAuth) this.netAuthId = netAuth;
    this.qrText = url;
    this.qrExpiresAt = Math.floor(Date.now() / 1000) + QR_TTL_SECONDS;
  }

  _result() {
    return {
      client_account_id: this.clientAccountId,
      status: this.status,
      current_step: this.currentStep,
      steps: this.steps,
      error_message: this.errorMessage,
      gcash_url: this.gcashUrl || '',
      qr_text: this.qrText || '',
      qr_short: this.qrShort || '',
      net_auth_id: this.netAuthId || '',
      qr_expires_at: this.qrExpiresAt,
      monitor_id: this.monitorId || '',
      callback_status: this.callbackStatus,
      payment_route: this.paymentRoute,
    };
  }
}

class GCashSessionManager {
  constructor({
    maxConcurrency = 6,
    maxQueue = 50,
    maxSessionConcurrency = null,
  } = {}) {
    this.sessions = new Map();
    this.pendingTasks = [];
    this.activeCount = 0;
    this.activeBySession = new Map();
    this.maxConcurrency = Math.max(1, Math.min(Number(maxConcurrency) || 1, MAX_WORKERS));
    this.maxQueue = Math.max(1, Math.min(Number(maxQueue) || 1, MAX_QUEUE_SIZE));
    this.maxSessionConcurrency = maxSessionConcurrency == null
      ? this.maxConcurrency
      : Math.max(1, Math.min(Number(maxSessionConcurrency) || 1, MAX_WORKERS));
  }

  configure(maxConcurrency, maxQueue) {
    this.maxConcurrency = Math.max(1, Math.min(Number(maxConcurrency) || 1, MAX_WORKERS));
    this.maxQueue = Math.max(1, Math.min(Number(maxQueue) || 1, MAX_QUEUE_SIZE));
    this._dispatch();
    return this._queueStatus();
  }

  createSession() {
    const sessionId = `local_${tokenHex(8)}`;
    this._cleanup();
    this.sessions.set(sessionId, {
      tasks: [],
      created: Date.now() / 1000,
      done: false,
    });
    return sessionId;
  }

  submitJobs(sessionId, payloads) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('会话不存在');
    const incoming = payloads.length;
    const freeWorkers = Math.max(0, this.maxConcurrency - this.activeCount);
    const sessionFree = Math.max(0, this.maxSessionConcurrency - (this.activeBySession.get(sessionId) || 0));
    const immediatelyRunnable = Math.min(freeWorkers, sessionFree);
    const waitingAfter = Math.max(0, this.pendingTasks.length + incoming - immediatelyRunnable);
    if (waitingAfter > this.maxQueue) {
      if (!session.tasks.length) this.sessions.delete(sessionId);
      throw new QueueFullError(`服务器当前繁忙，等待队列已达上限 ${this.maxQueue}，请稍后重试`);
    }
    const tasks = [];
    for (const payload of payloads) {
      const task = {
        client_account_id: payload.client_account_id || '',
        account_id: payload.account_id || '',
        billing_email: payload.billing_email || '',
        billing_name: payload.billing_name || '',
        token: payload.token || '',
        proxy: payload.proxy || payload.ph_proxy || payload.vn_proxy || '',
        proxy_pool: [...(payload.proxy_pool || payload.ph_proxy_pool || payload.vn_proxy_pool || [])],
        max_attempts: Math.max(1, Math.min(Number(payload.max_attempts || MAX_ATTEMPTS), 10)),
        status: 'queued',
        current_step: 'parse',
        steps: [],
        queue_position: null,
        error_message: '',
        gcash_url: '',
        expires_at: null,
        monitor_id: '',
        callback_status: 'unavailable',
        payment_route: '',
        attempts_used: 0,
        attempt_history: [],
        cancel_requested: false,
      };
      tasks.push(task);
      session.tasks.push(task);
      this.pendingTasks.push([sessionId, task]);
    }
    this._dispatch();
    return JSON.parse(JSON.stringify(tasks));
  }

  _dispatch() {
    while (this.pendingTasks.length && this.activeCount < this.maxConcurrency) {
      const eligibleIndex = this.pendingTasks.findIndex(([pendingSessionId]) => (
        (this.activeBySession.get(pendingSessionId) || 0) < this.maxSessionConcurrency
      ));
      if (eligibleIndex < 0) break;
      const [sessionId, task] = this.pendingTasks.splice(eligibleIndex, 1)[0];
      task.status = 'running';
      task.queue_position = null;
      this.activeCount += 1;
      this.activeBySession.set(sessionId, (this.activeBySession.get(sessionId) || 0) + 1);
      this._runTask(sessionId, task).catch(() => {});
    }
    this._refreshQueuePositions();
  }

  _refreshQueuePositions() {
    this.pendingTasks.forEach(([, task], index) => {
      task.queue_position = index + 1;
    });
  }

  cancelSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { queued_cancelled: 0, running_cancel_requested: 0 };
    const retained = [];
    let queuedCancelled = 0;
    for (const [pendingSessionId, task] of this.pendingTasks) {
      if (pendingSessionId !== sessionId) {
        retained.push([pendingSessionId, task]);
        continue;
      }
      task.cancel_requested = true;
      task.status = 'failed';
      task.current_step = 'cancelled';
      task.queue_position = null;
      task.error_message = 'TASK_CANCELLED: 用户已停止任务';
      queuedCancelled += 1;
    }
    this.pendingTasks = retained;
    let runningCancelRequested = 0;
    for (const task of session.tasks) {
      if (task.status !== 'running') continue;
      task.cancel_requested = true;
      task.status = 'canceling';
      task.current_step = 'cancelled';
      task.error_message = 'TASK_CANCELLED: 正在停止任务';
      runningCancelRequested += 1;
    }
    session.cancel_requested = true;
    if (session.tasks.every((task) => task.status === 'success' || task.status === 'failed')) {
      session.done = true;
    }
    this._refreshQueuePositions();
    this._dispatch();
    return { queued_cancelled: queuedCancelled, running_cancel_requested: runningCancelRequested };
  }

  async _runTask(sessionId, task) {
    try {
      await this._processTask(task);
    } catch {
      task.status = 'failed';
      task.error_message = '任务执行失败';
    } finally {
      this.activeCount = Math.max(0, this.activeCount - 1);
      const sessionActive = Math.max(0, (this.activeBySession.get(sessionId) || 0) - 1);
      if (sessionActive) this.activeBySession.set(sessionId, sessionActive);
      else this.activeBySession.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session && session.tasks.every((item) => item.status === 'success' || item.status === 'failed')) {
        session.done = true;
      }
      this._dispatch();
    }
  }

  _queueStatus() {
    return {
      running: this.activeCount,
      queued: this.pendingTasks.length,
      max_concurrency: this.maxConcurrency,
      max_session_concurrency: this.maxSessionConcurrency,
      max_queue: this.maxQueue,
    };
  }

  queueStatus() {
    return this._queueStatus();
  }

  discardSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.tasks.length && !session.done) return false;
    this.sessions.delete(sessionId);
    return true;
  }

  async _processTask(task) {
    let proxy = task.proxy;
    const retrySteps = [];
    const sync = (result) => {
      if (task.cancel_requested && result.status === 'running') {
        task.status = 'canceling';
        task.current_step = 'cancelled';
        task.error_message = 'TASK_CANCELLED: 正在停止任务';
        return;
      }
      task.status = result.status;
      task.current_step = result.current_step;
      task.steps = JSON.parse(JSON.stringify(retrySteps.concat(result.steps || [])));
      task.error_message = result.error_message;
      task.gcash_url = result.gcash_url;
      task.expires_at = result.qr_expires_at;
      task.monitor_id = result.monitor_id || '';
      task.callback_status = result.callback_status || 'unavailable';
      task.payment_route = result.payment_route || '';
    };

    const maxAttempts = task.max_attempts || MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (task.cancel_requested) {
        task.status = 'failed';
        task.current_step = 'cancelled';
        task.error_message = 'TASK_CANCELLED: 用户已停止任务';
        return;
      }
      task.status = 'running';
      task.current_step = 'init';
      task.steps = JSON.parse(JSON.stringify(retrySteps));
      task.error_message = '';
      const chain = new GCashChain({
        token: task.token,
        clientAccountId: task.client_account_id,
        proxy: proxy || null,
        accountId: task.account_id,
        billingEmail: task.billing_email || '',
        billingName: task.billing_name || '',
        onUpdate: sync,
        cancelCheck: () => Boolean(task.cancel_requested),
      });
      const result = await chain.run();
      sync(result);
      const { retryable, label: retryLabel } = retryDecision(result);
      task.attempts_used = attempt + 1;
      task.attempt_history.push({
        status: result.status || 'failed',
        step: result.current_step || '',
        error: result.error_message || '',
        proxy,
        payment_route: result.payment_route || '',
        retry_reason: retryLabel,
      });
      if (result.status === 'success') return;
      if (task.cancel_requested) {
        task.status = 'failed';
        task.current_step = 'cancelled';
        task.error_message = 'TASK_CANCELLED: 用户已停止任务';
        return;
      }
      if (!retryable || attempt >= maxAttempts - 1) return;
      proxy = this._rotateProxy(proxy, task.proxy_pool) || proxy;
      retrySteps.push({
        key: `retry_${attempt + 1}`,
        label: `${retryLabel} #${attempt + 1}`,
        state: 'done',
      });
      task.proxy = proxy;
      task.status = 'running';
      task.current_step = retrySteps[retrySteps.length - 1].key;
      task.steps = JSON.parse(JSON.stringify(retrySteps));
      task.error_message = '';
    }
  }

  _rotateProxy(failedProxy, pool = null) {
    const list = [...(pool || [])];
    if (!list.length) return '';
    let failedIndex = list.indexOf(failedProxy);
    if (failedIndex < 0) failedIndex = -1;
    for (let offset = 1; offset <= list.length; offset += 1) {
      const candidate = list[(failedIndex + offset) % list.length];
      if (candidate !== failedProxy) return candidate;
    }
    return '';
  }

  getTasks(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return JSON.parse(JSON.stringify(session.tasks));
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      done: session.done,
      tasks: JSON.parse(JSON.stringify(session.tasks)),
    };
  }

  monitorStatus(monitorId) {
    return this._monitorStatus(monitorId);
  }

  _monitorStatus(monitorId) {
    return paymentMonitor.status(monitorId);
  }

  monitorQrImage(monitorId) {
    return paymentMonitor.qrImage(monitorId);
  }

  refreshMonitor(monitorId) {
    return paymentMonitor.refresh(monitorId);
  }

  abandonMonitor(monitorId) {
    return paymentMonitor.abandon(monitorId);
  }

  cleanup() {
    return this._cleanup();
  }

  _cleanup() {
    const now = Date.now() / 1000;
    let removed = 0;
    for (const [key, session] of this.sessions.entries()) {
      if ((session.done && now - session.created > 1800)
        || (!session.tasks.length && now - session.created > 60)) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

const manager = new GCashSessionManager({
  maxConcurrency: MAX_CONCURRENCY,
  maxQueue: MAX_QUEUE,
  maxSessionConcurrency: Math.min(MAX_SESSION_CONCURRENCY, MAX_CONCURRENCY),
});

module.exports = {
  GCashChain,
  GCashSessionManager,
  QueueFullError,
  CHROME_USER_AGENT,
  manager,
};
