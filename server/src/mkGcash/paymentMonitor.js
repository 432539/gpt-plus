'use strict';

/**
 * Corresponds to payment_monitor.py:PaymentMonitorManager.
 * Headless Chromium (Playwright) opens Adyen/GCash, captures QR, waits for
 * the page's own return, then falls back to HTTP continue like the open source.
 */

const {
  MONITOR_TTL_SECONDS,
  MONITOR_REFRESH_GRACE_SECONDS,
  INITIAL_QR_CAPTURE_TIMEOUT,
  REFRESH_QR_CAPTURE_TIMEOUT,
  MONITOR_READY_TIMEOUT,
  MONITOR_REFRESH_TIMEOUT,
  CHECKOUT_STATUS_POLL_SECONDS,
  CALLBACK_CONFIRM_TIMEOUT_SECONDS,
  TERMINAL_STATUSES,
  CALLBACK_SUCCESS_STATUSES,
  CALLBACK_ACCEPTED_STATUSES,
  PNG_SIGNATURE,
  FRONTEND_CONTEXT_COOKIE_NAMES,
  sanitizeContinueContextHeaders,
  extractRedirectResult,
  extractContinueActionResult,
  gcashUrl,
  qrCandidateScore,
  qrCandidateIsStrong,
  decodePngDataUrl,
  fallbackQrPng,
  shortHash,
  routeLabel,
  safeLogError,
  payloadStatus,
  tokenUrlSafe,
  sleep,
} = require('./protocol');
const { MAX_ACTIVE_MONITORS } = require('./limits');
const { playwrightLaunchProxy } = require('./proxyAdapt');

const QR_SELECTOR = (
  'canvas, img, svg, [role="img"], '
  + '[class*="qr" i], [id*="qr" i], [data-testid*="qr" i]'
);

const QR_METADATA_JS = `element => {
                        const parent = element.parentElement || {};
                        const grandparent = parent.parentElement || {};
                        return {
                          tag: (element.tagName || '').toLowerCase(),
                          id: element.id || '',
                          class_name: typeof element.className === 'string' ? element.className : '',
                          alt: element.getAttribute?.('alt') || '',
                          title: element.getAttribute?.('title') || '',
                          aria_label: element.getAttribute?.('aria-label') || '',
                          test_id: element.getAttribute?.('data-testid') || '',
                          src: String(element.currentSrc || element.getAttribute?.('src') || '').slice(0, 256),
                          parent_id: parent.id || '',
                          parent_class: typeof parent.className === 'string' ? parent.className : '',
                          grandparent_id: grandparent.id || '',
                          grandparent_class: typeof grandparent.className === 'string' ? grandparent.className : '',
                          parent_text: String(parent.innerText || '').slice(0, 160)
                        };
                    }`;

const QR_SOURCE_JS = `element => {
                    if ((element.tagName || '').toLowerCase() === 'canvas') {
                      try { return element.toDataURL('image/png'); } catch (_) { return ''; }
                    }
                    return String(element.currentSrc || element.getAttribute?.('src') || '');
                }`;

class Semaphore {
  constructor(count) {
    this.available = count;
    this.waiters = [];
  }
  async acquire() {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

class AsyncLock {
  constructor() {
    this._tail = Promise.resolve();
  }
  run(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(() => {}, () => {});
    return run;
  }
}

function toPlaywrightCookies(cookies) {
  return (cookies || []).map((cookie) => {
    const item = {
      name: String(cookie.name || ''),
      value: String(cookie.value || ''),
      domain: String(cookie.domain || ''),
      path: String(cookie.path || '/'),
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
    };
    if (cookie.expires) item.expires = Number(cookie.expires);
    return item;
  }).filter((cookie) => cookie.name && cookie.domain);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function monotonic() {
  return performance.now() / 1000;
}

/** payment_monitor.py:_capture_real_qr_png */
async function captureRealQrPng(page, timeoutSeconds = INITIAL_QR_CAPTURE_TIMEOUT) {
  const deadline = monotonic() + Math.max(1, Number(timeoutSeconds));
  let lastStats = { frames: 0, candidates: 0, visible: 0, strong: 0, best_score: -1 };
  while (monotonic() < deadline) {
    const ranked = [];
    const frames = page.frames();
    const scanStats = {
      frames: frames.length,
      candidates: 0,
      visible: 0,
      strong: 0,
      best_score: -1,
    };
    for (const frame of frames) {
      const candidates = frame.locator(QR_SELECTOR);
      let count = 0;
      try { count = Math.min(await candidates.count(), 80); } catch { count = 0; }
      scanStats.candidates += count;
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        try {
          if (!await candidate.isVisible()) continue;
          scanStats.visible += 1;
          const box = await candidate.boundingBox();
          if (!box) continue;
          const metadata = await candidate.evaluate(QR_METADATA_JS);
          const score = qrCandidateScore(metadata, box.width, box.height);
          scanStats.best_score = Math.max(scanStats.best_score, score);
          const isStrong = qrCandidateIsStrong(metadata);
          if (isStrong) scanStats.strong += 1;
          if (score >= 80 && isStrong) ranked.push({ score, candidate, metadata });
        } catch {
          continue;
        }
      }
    }
    lastStats = scanStats;
    ranked.sort((a, b) => b.score - a.score);
    for (const item of ranked) {
      try {
        const sourcePng = await item.candidate.evaluate(QR_SOURCE_JS);
        const png = decodePngDataUrl(sourcePng);
        if (png.length) return png;
      } catch { /* try screenshot */ }
      try {
        const png = await item.candidate.screenshot({
          type: 'png',
          animations: 'disabled',
          timeout: 5000,
        });
        if (Buffer.isBuffer(png) && png.subarray(0, 8).equals(PNG_SIGNATURE) && png.length >= 300) {
          return png;
        }
      } catch {
        continue;
      }
    }
    await page.waitForTimeout(350);
  }
  throw new Error(
    'GCash 页面未抓取到真实二维码'
    + `（frames=${lastStats.frames} candidates=${lastStats.candidates} `
    + `visible=${lastStats.visible} strong=${lastStats.strong} `
    + `best_score=${lastStats.best_score}）`,
  );
}

class PaymentMonitorManager {
  constructor() {
    this._states = new Map();
    this._browser = null;
    this._browserLock = new AsyncLock();
    this._semaphore = new Semaphore(MAX_ACTIVE_MONITORS);
    this._frontendContextSemaphore = new Semaphore(Math.min(4, MAX_ACTIVE_MONITORS));
  }

  async _getBrowser() {
    return this._browserLock.run(async () => {
      if (this._browser && this._browser.isConnected()) return this._browser;
      const { chromium } = require('playwright-core');
      this._browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-dev-shm-usage',
          '--disable-extensions',
        ],
      });
      return this._browser;
    });
  }

  _cloneState(monitorId) {
    const state = this._states.get(String(monitorId || ''));
    return state ? { ...state } : {};
  }

  _update(monitorId, values) {
    const state = this._states.get(monitorId);
    if (!state) return;
    const previousStatus = state.status;
    Object.assign(state, values);
    state.updated_at = nowSeconds();
    const nextStatus = state.status;
    if (nextStatus && nextStatus !== previousStatus) {
      this._audit(monitorId, 'status_change', { status: nextStatus });
    }
  }

  _audit(monitorId, event, fields = {}) {
    const state = this._cloneState(monitorId);
    const parts = [`[payment-monitor] ${String(monitorId || '').slice(0, 16)}`];
    const rest = { ...fields };
    if (rest.status) {
      parts.push(`status=${String(rest.status).slice(0, 40)}`);
      delete rest.status;
    }
    parts.push(`event=${String(event || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)}`);
    const clientAccountId = state.client_account_id;
    if (clientAccountId) {
      const safeClient = String(clientAccountId).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
      if (safeClient) parts.push(`client=${safeClient}`);
    }
    for (const [key, value] of Object.entries(rest)) {
      if (value == null || value === '') continue;
      const safeKey = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
      if (!safeKey) continue;
      let safeValue;
      if (typeof value === 'boolean') safeValue = value ? 'true' : 'false';
      else if (safeKey === 'error') safeValue = safeLogError(value);
      else safeValue = String(value).replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180);
      if (safeValue) parts.push(`${safeKey}=${safeValue}`);
    }
    console.log(parts.join(' '));
  }

  _completeVerifiedPayment(monitorId, verified, source) {
    if (!verified || typeof verified !== 'object' || verified._entitlement_verified !== true) return false;
    const businessStatus = payloadStatus(verified);
    if (!CALLBACK_SUCCESS_STATUSES.has(businessStatus)) return false;
    const verifiedBy = String(verified._callback_verified_by || 'plus_entitlement');
    this._audit(monitorId, 'callback_completed', {
      source,
      business_status: businessStatus,
      verified_by: verifiedBy,
    });
    this._update(monitorId, { status: 'completed', refresh_available: false, error: '' });
    return true;
  }

  async _verifyPaymentCompletion(monitorId, verifyCallback) {
    try {
      const verified = await verifyCallback();
      return this._completeVerifiedPayment(monitorId, verified, 'plus_entitlement_poll');
    } catch (exc) {
      this._audit(monitorId, 'entitlement_poll_failed', { error: exc });
      return false;
    }
  }

  _markCallbackUnconfirmed(monitorId) {
    this._audit(monitorId, 'callback_unconfirmed', {
      seconds: CALLBACK_CONFIRM_TIMEOUT_SECONDS,
      reason: 'plus_entitlement_not_active',
    });
    this._update(monitorId, {
      status: 'callback_unconfirmed',
      refresh_available: false,
      error: '回调已受理，但未确认 Plus 权益到账',
    });
  }

  async _upgradeRealQr(monitorId, page, timeoutSeconds, readyEvent, fallbackEvent) {
    this._audit(monitorId, 'real_qr_capture_started', { seconds: timeoutSeconds });
    let source = 'gcash_page';
    let event = readyEvent;
    let qrPng;
    try {
      qrPng = await captureRealQrPng(page, timeoutSeconds);
    } catch (exc) {
      if (exc && exc.name === 'AbortError') throw exc;
      this._audit(monitorId, 'real_qr_unavailable', { error: exc });
      const current = this._cloneState(monitorId);
      if (TERMINAL_STATUSES.has(current.status)) return;
      try {
        qrPng = fallbackQrPng(current.gcash_url);
      } catch (fallbackExc) {
        this._audit(monitorId, 'qr_fallback_failed', { error: fallbackExc });
        return;
      }
      source = 'gcash_link_fallback';
      event = fallbackEvent;
    }
    const current = this._cloneState(monitorId);
    if (TERMINAL_STATUSES.has(current.status)) return;
    const qrVersion = (Number(current.qr_version) || 0) + 1;
    this._audit(monitorId, event, {
      source,
      image_bytes: qrPng.length,
      image_ref: shortHash(qrPng),
      qr_version: qrVersion,
    });
    this._update(monitorId, {
      qr_png: qrPng,
      qr_source: source,
      qr_version: qrVersion,
      refresh_available: true,
    });
  }

  _scheduleRealQrUpgrade(monitorId, page, timeoutSeconds, readyEvent, fallbackEvent) {
    const state = this._cloneState(monitorId);
    const previous = state._qr_upgrade_task;
    if (previous && typeof previous.cancel === 'function') previous.cancel();
    let cancelled = false;
    const task = this._upgradeRealQr(monitorId, page, timeoutSeconds, readyEvent, fallbackEvent)
      .catch((error) => {
        if (!cancelled) this._audit(monitorId, 'real_qr_unavailable', { error });
      });
    task.cancel = () => { cancelled = true; };
    this._update(monitorId, { _qr_upgrade_task: task });
    return task;
  }

  /**
   * payment_monitor.py:PaymentMonitorManager.collect_frontend_context
   * Injects only oai-did + CF cookies onto chatgpt.com. Does not fake /api/auth/session.
   */
  async collectFrontendContext({
    proxy,
    token,
    accountId,
    cookies,
    deviceId = '',
    userAgent = '',
    timeout = 8,
  }) {
    timeout = Math.max(3, Math.min(Number(timeout || 8), 15));
    const captured = {};
    if (accountId) captured['chatgpt-account-id'] = String(accountId);
    if (deviceId) captured['oai-device-id'] = String(deviceId);
    let context;
    let proxyHandle = { settings: undefined, close: async () => {} };
    try {
      return await this._frontendContextSemaphore.run(async () => {
        const browser = await this._getBrowser();
        proxyHandle = await playwrightLaunchProxy(proxy);
        const options = {
          proxy: proxyHandle.settings || undefined,
          locale: 'en-PH',
          timezoneId: 'Asia/Manila',
          viewport: { width: 1280, height: 900 },
        };
        if (userAgent) options.userAgent = String(userAgent);
        context = await browser.newContext(options);
        if (cookies && cookies.length) {
          const safeCookies = toPlaywrightCookies(
            cookies.filter((cookie) => FRONTEND_CONTEXT_COOKIE_NAMES.has(cookie.name)),
          );
          if (safeCookies.length) await context.addCookies(safeCookies);
        }
        let readyResolve;
        const ready = new Promise((resolve) => { readyResolve = resolve; });
        let readySet = false;
        const markReady = () => {
          if (!readySet) {
            readySet = true;
            readyResolve();
          }
        };

        await context.route('**/*', async (route, request) => {
          let parsed;
          try { parsed = new URL(request.url()); } catch { parsed = null; }
          const isBackend = parsed
            && parsed.hostname === 'chatgpt.com'
            && parsed.pathname.startsWith('/backend-api/');
          if (!isBackend) {
            await route.continue();
            return;
          }
          const requestHeaders = await request.allHeaders();
          const contextHeaders = sanitizeContinueContextHeaders(requestHeaders);
          const nativeAccountId = contextHeaders['chatgpt-account-id'] || '';
          const nativeDeviceId = contextHeaders['oai-device-id'] || '';
          const accountMatches = !(accountId && nativeAccountId && nativeAccountId !== String(accountId));
          const deviceMatches = !(deviceId && nativeDeviceId && nativeDeviceId !== String(deviceId));
          if (accountMatches && deviceMatches) {
            delete contextHeaders['chatgpt-account-id'];
            delete contextHeaders['oai-device-id'];
            Object.assign(captured, contextHeaders);
          }
          const required = [
            'x-oai-is-client-observation',
            'oai-session-id',
            'oai-client-build-number',
            'oai-client-version',
          ];
          if (required.every((name) => captured[name])) markReady();
          const method = String(request.method() || 'GET').toUpperCase();
          if (['GET', 'HEAD', 'OPTIONS'].includes(method)) await route.continue();
          else await route.abort('blockedbyclient');
        });

        const page = await context.newPage();
        try {
          await page.goto('https://chatgpt.com/', { waitUntil: 'commit', timeout: timeout * 1000 });
        } catch { /* open source swallows */ }
        const captureDeadline = monotonic() + timeout;
        try {
          await Promise.race([
            ready,
            sleep(Math.max(0.01, timeout * 0.55)),
          ]);
        } catch { /* timeout */ }
        if (!captured['x-oai-is-client-observation']) {
          const remaining = captureDeadline - monotonic();
          if (remaining > 0) {
            try {
              await page.reload({
                waitUntil: 'commit',
                timeout: Math.max(250, Math.floor(Math.min(3, remaining) * 1000)),
              });
            } catch { /* ignore */ }
          }
        }
        const remaining = captureDeadline - monotonic();
        if (!readySet && remaining > 0) {
          try { await Promise.race([ready, sleep(remaining)]); } catch { /* ignore */ }
        }
        const browserCookies = [];
        for (const cookie of await context.cookies('https://chatgpt.com/')) {
          if (FRONTEND_CONTEXT_COOKIE_NAMES.has(cookie.name)) browserCookies.push(cookie);
        }
        return { headers: { ...captured }, cookies: browserCookies };
      });
    } finally {
      if (context) {
        try { await context.close(); } catch { /* ignore */ }
      }
      try { await proxyHandle.close(); } catch { /* ignore */ }
    }
  }

  /** payment_monitor.py:PaymentMonitorManager.start */
  async start(args) {
    const monitorId = `monitor_${tokenUrlSafe(18)}`;
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    this._cleanupLocked();
    this._states.set(monitorId, {
      status: 'starting',
      gcash_url: '',
      qr_png: Buffer.alloc(0),
      qr_source: '',
      qr_version: 0,
      expires_at: null,
      refresh_available: false,
      refresh_until: null,
      error: '',
      client_account_id: String(args.clientAccountId || ''),
      proxy_ref: shortHash(args.proxy),
      _closed: closed,
      _closedResolve: closedResolve,
      updated_at: nowSeconds(),
    });
    const runArgs = {
      monitor_id: monitorId,
      navigation_url: args.navigationUrl,
      proxy: args.proxy,
      token: args.token,
      account_id: args.accountId,
      cookies: [...(args.cookies || [])],
      continue_callback: args.continueCallback,
      verify_callback: args.verifyCallback,
      close_callback: args.closeCallback,
      device_id: String(args.deviceId || ''),
      user_agent: String(args.userAgent || ''),
      ready: readyResolve,
      closed: closedResolve,
    };
    this._audit(monitorId, 'monitor_created', {
      route: routeLabel(args.navigationUrl),
      proxy_ref: shortHash(args.proxy),
      cookie_count: runArgs.cookies.length,
    });
    const runPromise = this._runMonitor(runArgs);
    this._update(monitorId, { _monitor_future: runPromise });
    const timedOut = await Promise.race([
      ready.then(() => false),
      sleep(MONITOR_READY_TIMEOUT).then(() => true),
    ]);
    if (timedOut) {
      this._audit(monitorId, 'monitor_ready_timeout', { seconds: MONITOR_READY_TIMEOUT });
      this._update(monitorId, { status: 'failed', error: '支付页面启动超时' });
      throw new Error('后台打开 GCash 页面超时');
    }
    const state = this._cloneState(monitorId);
    if (!state.gcash_url) throw new Error(state.error || '后台未获取到 GCash 页面');
    return { monitorId, gcashUrl: state.gcash_url, expiresAt: state.expires_at };
  }

  async _runMonitor(args) {
    const monitorId = args.monitor_id;
    let context;
    let proxyHandle = { settings: undefined, close: async () => {} };
    const capture = {
      redirect_result: '',
      native_action_result: null,
      browser_context_headers: {},
      callback_completed: false,
      continue_requested_at: 0,
      continue_failed: false,
      continue_accepted: false,
      fallback_submitted: false,
      callback_confirm_started: 0,
    };
    let phase = 'browser_start';
    try {
      await this._semaphore.run(async () => {
        const browser = await this._getBrowser();
        proxyHandle = await playwrightLaunchProxy(args.proxy);
        const contextOptions = {
          proxy: proxyHandle.settings || undefined,
          locale: 'en-PH',
          timezoneId: 'Asia/Manila',
          viewport: { width: 1280, height: 900 },
        };
        if (args.user_agent) contextOptions.userAgent = args.user_agent;
        context = await browser.newContext(contextOptions);
        this._audit(monitorId, 'browser_context_ready');
        if (args.cookies && args.cookies.length) {
          await context.addCookies(toPlaywrightCookies(args.cookies));
        }

        await context.route('**/*', async (route, request) => {
          let parsed;
          try { parsed = new URL(request.url()); } catch { parsed = null; }
          if (parsed && parsed.hostname === 'chatgpt.com' && parsed.pathname.startsWith('/backend-api/')) {
            const requestHeaders = await request.allHeaders();
            requestHeaders.authorization = `Bearer ${args.token}`;
            if (args.account_id) requestHeaders['chatgpt-account-id'] = String(args.account_id);
            if (args.device_id) requestHeaders['oai-device-id'] = args.device_id;
            requestHeaders['x-openai-target-path'] = parsed.pathname;
            requestHeaders['x-openai-target-route'] = parsed.pathname;
            const contextHeaders = sanitizeContinueContextHeaders(requestHeaders);
            const previousContext = capture.browser_context_headers;
            const mergedContext = { ...previousContext, ...contextHeaders };
            capture.browser_context_headers = mergedContext;
            const isContinue = parsed.pathname.endsWith('/custom_payment_method/continue');
            const gainedObservation = Boolean(
              contextHeaders['x-oai-is-client-observation']
              && !previousContext['x-oai-is-client-observation'],
            );
            const gainedAttestation = Boolean(
              contextHeaders['oai-web-deployment-attestation']
              && !previousContext['oai-web-deployment-attestation'],
            );
            if (isContinue || gainedObservation || gainedAttestation) {
              this._audit(monitorId, 'browser_callback_context_captured', {
                source: isContinue ? 'native_continue' : 'backend_request',
                context_header_count: Object.keys(mergedContext).length,
                observation_captured: Boolean(mergedContext['x-oai-is-client-observation']),
                attestation_captured: Boolean(mergedContext['oai-web-deployment-attestation']),
              });
            }
            await route.continue({ headers: requestHeaders });
          } else {
            await route.continue();
          }
        });

        const page = await context.newPage();
        this._update(monitorId, { _page: page, _refresh_lock: new AsyncLock() });

        const recordRedirect = (found, source) => {
          if (!found || capture.redirect_result) return false;
          capture.redirect_result = found;
          this._audit(monitorId, 'redirect_captured', {
            source,
            redirect_ref: shortHash(found),
            redirect_length: found.length,
          });
          this._update(monitorId, { status: 'redirect_captured' });
          return true;
        };

        const inspectRequest = (request) => {
          const postData = request.postData() || '';
          let found = extractRedirectResult(request.url());
          let source = 'request_url';
          if (!found) {
            found = extractRedirectResult(postData);
            source = 'request_body';
          }
          recordRedirect(found, source);
          let path = '';
          try { path = new URL(request.url()).pathname; } catch { path = ''; }
          if (path.endsWith('/custom_payment_method/continue')) {
            const nativeActionResult = extractContinueActionResult(postData);
            if (nativeActionResult) {
              const nativeRedirect = nativeActionResult.redirectResult;
              if (!capture.redirect_result) recordRedirect(nativeRedirect, 'native_continue_body');
              if (capture.redirect_result === nativeRedirect) {
                capture.native_action_result = nativeActionResult;
              }
            }
            capture.continue_requested_at = monotonic();
            capture.continue_failed = false;
            this._audit(monitorId, 'native_continue_requested', {
              method: request.method(),
              route: routeLabel(request.url()),
              action_result_captured: Boolean(capture.native_action_result),
            });
            this._update(monitorId, { status: 'callback_processing' });
          }
        };

        const inspectResponse = async (response) => {
          let path = '';
          try { path = new URL(response.url()).pathname; } catch { path = ''; }
          if (path.endsWith('/custom_payment_method/continue')) {
            const headersObj = response.headers();
            const contentType = String(headersObj['content-type'] || '').toLowerCase();
            let businessStatus = '';
            if (contentType.includes('json')) {
              try { businessStatus = payloadStatus(await response.text()); } catch { /* ignore */ }
            }
            this._audit(monitorId, 'native_continue_response', {
              http_status: response.status(),
              business_status: businessStatus || 'unknown',
              content_type: contentType.split(';', 1)[0],
            });
            const callbackAccepted = CALLBACK_ACCEPTED_STATUSES.has(businessStatus);
            if (response.status() >= 200 && response.status() < 300 && callbackAccepted) {
              capture.continue_accepted = true;
              if (!capture.callback_confirm_started) capture.callback_confirm_started = monotonic();
              this._audit(monitorId, 'callback_accepted', {
                source: 'native_browser',
                http_status: response.status(),
                business_status: businessStatus || 'unknown',
              });
              this._update(monitorId, { status: 'callback_processing' });
            } else {
              capture.continue_failed = true;
              this._audit(monitorId, 'native_continue_unconfirmed', {
                http_status: response.status(),
                business_status: businessStatus || 'unknown',
              });
              this._update(monitorId, { status: 'callback_processing' });
            }
          }
          if (capture.redirect_result) return;
          const headersObj = response.headers();
          let found = extractRedirectResult(headersObj.location || '');
          let source = 'response_location';
          const contentType = String(headersObj['content-type'] || '').toLowerCase();
          const resourceType = response.request().resourceType();
          if (!found && ['document', 'xhr', 'fetch'].includes(resourceType)) {
            if (['json', 'text', 'html', 'form'].some((kind) => contentType.includes(kind))) {
              try {
                found = extractRedirectResult(await response.text());
                source = 'response_body';
              } catch { /* ignore */ }
            }
          }
          recordRedirect(found, source);
        };

        const lastNavigation = { route: '' };
        const inspectFrame = (frame) => {
          if (frame.parentFrame()) return;
          const route = routeLabel(frame.url());
          if (route && route !== lastNavigation.route) {
            lastNavigation.route = route;
            this._audit(monitorId, 'page_navigated', { route });
          }
        };
        const inspectRequestFailed = (request) => {
          const route = routeLabel(request.url());
          const isContinue = route.endsWith('/custom_payment_method/continue');
          if (isContinue) capture.continue_failed = true;
          if (isContinue || request.resourceType() === 'document') {
            this._audit(monitorId, 'network_request_failed', {
              resource: request.resourceType(),
              route,
              error: request.failure() || 'unknown',
            });
          }
        };

        page.on('request', inspectRequest);
        page.on('response', (response) => { inspectResponse(response).catch(() => {}); });
        page.on('framenavigated', inspectFrame);
        page.on('requestfailed', inspectRequestFailed);

        phase = 'initial_navigation';
        this._audit(monitorId, 'navigation_started', { route: routeLabel(args.navigation_url) });
        try {
          await page.goto(args.navigation_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (exc) {
          this._audit(monitorId, 'navigation_incomplete', { error: exc });
        }

        phase = 'gcash_discovery';
        let gcashLink = '';
        const discoverDeadline = monotonic() + 60;
        while (monotonic() < discoverDeadline && !gcashLink) {
          gcashLink = gcashUrl(page.url());
          if (!gcashLink) {
            try { gcashLink = gcashUrl(await page.content()); } catch { /* ignore */ }
          }
          if (!gcashLink) await page.waitForTimeout(400);
        }
        if (!gcashLink) throw new Error('真实支付页未进入 GCash');

        const expiresAt = nowSeconds() + MONITOR_TTL_SECONDS;
        this._audit(monitorId, 'gcash_link_ready', {
          route: routeLabel(gcashLink),
          expires_at: expiresAt,
        });
        this._update(monitorId, {
          status: 'waiting_scan',
          gcash_url: gcashLink,
          qr_png: Buffer.alloc(0),
          qr_source: 'real_qr_pending',
          qr_version: 0,
          expires_at: expiresAt,
          refresh_available: false,
          refresh_until: expiresAt + MONITOR_REFRESH_GRACE_SECONDS,
        });
        args.ready();
        this._scheduleRealQrUpgrade(
          monitorId,
          page,
          INITIAL_QR_CAPTURE_TIMEOUT,
          'qr_ready',
          'qr_fallback_ready',
        );

        phase = 'waiting_scan';
        let callbackStarted = 0;
        let lastPageScan = 0;
        let lastCheckoutPoll = 0;
        while (true) {
          const live = this._cloneState(monitorId);
          if (live.status === 'abandoned') return;
          if (capture.callback_completed) return;
          if (!capture.redirect_result && monotonic() - lastPageScan >= 1) {
            lastPageScan = monotonic();
            let found = extractRedirectResult(page.url());
            if (!found) {
              try { found = extractRedirectResult(await page.content()); } catch { /* ignore */ }
            }
            if (found) {
              const source = extractRedirectResult(page.url()) ? 'page_url' : 'page_html';
              recordRedirect(found, source);
            }
          }
          const redirectResult = capture.redirect_result;
          if (redirectResult) {
            phase = 'callback';
            if (!callbackStarted) callbackStarted = monotonic();
            const nativeStarted = capture.continue_requested_at;
            const nativeTimedOut = nativeStarted && monotonic() - nativeStarted >= 20;
            const shouldFallback = (
              !capture.continue_accepted
              && !capture.fallback_submitted
              && (
                capture.continue_failed
                || nativeTimedOut
                || (!nativeStarted && monotonic() - callbackStarted >= 4)
              )
            );
            if (shouldFallback) {
              capture.fallback_submitted = true;
              const fallbackReason = capture.continue_failed
                ? 'native_failed'
                : (nativeTimedOut ? 'native_timeout' : 'native_not_started');
              this._audit(monitorId, 'fallback_continue_started', {
                reason: fallbackReason,
                redirect_ref: shortHash(redirectResult),
                redirect_length: redirectResult.length,
                action_result_keys: 'redirectResult',
                context_header_count: Object.keys(capture.browser_context_headers).length,
                observation_captured: Boolean(capture.browser_context_headers['x-oai-is-client-observation']),
                action_result_source: capture.native_action_result ? 'native_browser' : 'server_normalized',
              });
              this._update(monitorId, { status: 'callback_processing' });
              const fallbackResponse = await args.continue_callback(
                redirectResult,
                capture.native_action_result,
                capture.browser_context_headers,
              );
              const businessStatus = payloadStatus(fallbackResponse) || 'unknown';
              const callbackAttemptValue = fallbackResponse && typeof fallbackResponse === 'object'
                ? fallbackResponse._callback_attempts
                : null;
              const callbackAttempts = callbackAttemptValue == null ? 1 : Number(callbackAttemptValue);
              const verifiedBy = fallbackResponse && typeof fallbackResponse === 'object'
                ? String(fallbackResponse._callback_verified_by || 'continue_response')
                : 'continue_response';
              this._audit(monitorId, 'fallback_continue_response', {
                business_status: businessStatus,
                attempts: callbackAttempts,
                verified_by: verifiedBy,
              });
              if (this._completeVerifiedPayment(monitorId, fallbackResponse, 'server_fallback_entitlement')) {
                capture.callback_completed = true;
                return;
              }
              const callbackAccepted = Boolean(
                fallbackResponse && typeof fallbackResponse === 'object'
                && fallbackResponse._callback_accepted === true,
              );
              if (!callbackAccepted) throw new Error('continue 回调未被明确受理');
              capture.continue_accepted = true;
              if (!capture.callback_confirm_started) capture.callback_confirm_started = monotonic();
              this._audit(monitorId, 'callback_accepted', {
                source: 'server_fallback',
                business_status: businessStatus,
                attempts: callbackAttempts,
                verified_by: verifiedBy,
              });
              this._update(monitorId, { status: 'callback_processing' });
            }
          }

          if (monotonic() - lastCheckoutPoll >= CHECKOUT_STATUS_POLL_SECONDS) {
            lastCheckoutPoll = monotonic();
            if (await this._verifyPaymentCompletion(monitorId, args.verify_callback)) {
              capture.callback_completed = true;
              return;
            }
          }

          const confirmStarted = capture.callback_confirm_started;
          if (confirmStarted && monotonic() - confirmStarted >= CALLBACK_CONFIRM_TIMEOUT_SECONDS) {
            this._markCallbackUnconfirmed(monitorId);
            return;
          }

          const current = this._cloneState(monitorId);
          const stamp = Date.now() / 1000;
          const currentStatus = current.status;
          const currentExpiry = Number(current.expires_at || 0);
          if (currentStatus === 'waiting_scan' && currentExpiry && stamp >= currentExpiry) {
            this._audit(monitorId, 'qr_expired', { expires_at: currentExpiry });
            this._update(monitorId, {
              status: 'expired',
              refresh_available: true,
              refresh_until: Math.floor(stamp) + MONITOR_REFRESH_GRACE_SECONDS,
            });
          } else if (currentStatus === 'expired') {
            const refreshUntil = Number(current.refresh_until || 0);
            if (!refreshUntil || stamp >= refreshUntil) {
              this._audit(monitorId, 'monitor_released', { reason: 'refresh_grace_expired' });
              this._update(monitorId, { refresh_available: false });
              return;
            }
          }
          await page.waitForTimeout(250);
        }
      });
    } catch (exc) {
      const current = this.status(monitorId).status;
      const status = current !== 'starting' && current !== 'failed' ? 'callback_failed' : 'failed';
      this._audit(monitorId, 'monitor_error', {
        phase,
        previous_status: current,
        next_status: status,
        error: exc,
      });
      this._update(monitorId, {
        status,
        refresh_available: false,
        error: String(exc?.message || exc).slice(0, 300),
      });
    } finally {
      args.ready();
      const qrUpgradeTask = (this._states.get(monitorId) || {})._qr_upgrade_task;
      if (qrUpgradeTask && typeof qrUpgradeTask.cancel === 'function') qrUpgradeTask.cancel();
      if (context) {
        try { await context.close(); } catch { /* ignore */ }
      }
      try { await proxyHandle.close(); } catch { /* ignore */ }
      try { args.close_callback(); } catch { /* ignore */ }
      this._audit(monitorId, 'monitor_closed', { final_status: this.status(monitorId).status });
      args.closed();
    }
  }

  async _refreshPage(monitorId) {
    const state = this._cloneState(monitorId);
    const page = state._page;
    const refreshLock = state._refresh_lock;
    if (!page || !refreshLock || page.isClosed()) {
      throw new Error('原 GCash 页面已释放，需要重新提链');
    }
    return refreshLock.run(async () => {
      let clicked = false;
      const labels = /refresh(?: qr(?: code)?)?|try again|retry|generate(?: new)? qr|new qr/i;
      const candidates = page.locator('button, [role=button], a').filter({ hasText: labels });
      const count = Math.min(await candidates.count(), 12);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        try {
          if (await candidate.isVisible()) {
            await candidate.click({ timeout: 5000 });
            clicked = true;
            break;
          }
        } catch { continue; }
      }
      if (clicked) {
        this._audit(monitorId, 'refresh_navigation', { strategy: 'page_control' });
        await page.waitForTimeout(1200);
      } else {
        this._audit(monitorId, 'refresh_navigation', { strategy: 'page_reload' });
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch { /* some GCash pages keep polling */ }
      }

      let gcashLink = '';
      const deadline = monotonic() + 12;
      while (monotonic() < deadline && !gcashLink) {
        gcashLink = gcashUrl(page.url());
        if (!gcashLink) {
          try { gcashLink = gcashUrl(await page.content()); } catch { /* ignore */ }
        }
        if (!gcashLink) await page.waitForTimeout(300);
      }
      if (!gcashLink) throw new Error('刷新后未回到可信的 GCash 页面');

      const current = this.status(monitorId);
      if (current.status === 'completed') return current;
      const expiresAt = nowSeconds() + MONITOR_TTL_SECONDS;
      this._audit(monitorId, 'refresh_gcash_link_ready', {
        route: routeLabel(gcashLink),
        expires_at: expiresAt,
      });
      this._update(monitorId, {
        status: 'waiting_scan',
        gcash_url: gcashLink,
        qr_png: Buffer.alloc(0),
        qr_source: 'real_qr_pending',
        expires_at: expiresAt,
        refresh_available: false,
        refresh_until: expiresAt + MONITOR_REFRESH_GRACE_SECONDS,
        error: '',
      });
      this._scheduleRealQrUpgrade(
        monitorId,
        page,
        REFRESH_QR_CAPTURE_TIMEOUT,
        'refresh_qr_ready',
        'refresh_qr_fallback_ready',
      );
      return this.status(monitorId);
    });
  }

  async refresh(monitorId) {
    monitorId = String(monitorId || '');
    const state = this._cloneState(monitorId);
    const status = state.status || 'unavailable';
    this._audit(monitorId, 'refresh_requested', { current_status: status });
    if (status !== 'waiting_scan' && status !== 'expired') {
      if (status === 'completed') throw new Error('支付已完成，无需刷新二维码');
      throw new Error('当前支付页面不能刷新，需要重新提链');
    }
    if (status === 'expired' && Date.now() / 1000 >= Number(state.refresh_until || 0)) {
      this._update(monitorId, { refresh_available: false });
      throw new Error('二维码刷新保留时间已结束，需要重新提链');
    }
    if (!state.refresh_available) throw new Error('原 GCash 页面已释放，需要重新提链');

    this._update(monitorId, {
      status: 'refreshing',
      qr_png: Buffer.alloc(0),
      qr_source: 'real_qr_pending',
      refresh_available: false,
      error: '',
    });
    try {
      return await Promise.race([
        this._refreshPage(monitorId),
        sleep(MONITOR_REFRESH_TIMEOUT).then(() => {
          throw new Error('刷新二维码超时');
        }),
      ]);
    } catch (exc) {
      this._audit(monitorId, 'refresh_failed', { previous_status: status, error: exc });
      const current = this._cloneState(monitorId);
      if (current.status !== 'completed') {
        const stamp = nowSeconds();
        const expiresAt = Number(current.expires_at || 0);
        const refreshUntil = Number(current.refresh_until || 0);
        const fallbackStatus = expiresAt > stamp ? 'waiting_scan' : 'expired';
        const previousPng = state.qr_png;
        const previousQrValid = (
          Buffer.isBuffer(previousPng)
          && previousPng.subarray(0, 8).equals(PNG_SIGNATURE)
          && Number(state.expires_at || 0) > stamp
        );
        this._update(monitorId, {
          status: fallbackStatus,
          qr_png: previousQrValid ? previousPng : Buffer.alloc(0),
          qr_source: previousQrValid ? (state.qr_source || '') : '',
          qr_version: Number(state.qr_version || 0),
          refresh_available: refreshUntil > stamp,
          error: String(exc?.message || exc).slice(0, 300),
        });
      }
      const message = String(exc?.message || exc).trim() || '刷新二维码超时';
      throw new Error(`刷新二维码失败：${message}`);
    }
  }

  async abandon(monitorId, timeout = 5) {
    monitorId = String(monitorId || '');
    const state = this._cloneState(monitorId);
    if (!Object.keys(state).length) return this.status(monitorId);
    const currentStatus = state.status || 'unavailable';
    if (currentStatus === 'completed') return this.status(monitorId);
    if (currentStatus !== 'abandoned') {
      this._audit(monitorId, 'monitor_abandon_requested', { previous_status: currentStatus });
      this._update(monitorId, {
        status: 'abandoned',
        refresh_available: false,
        qr_png: Buffer.alloc(0),
        qr_source: '',
        error: '',
      });
    }
    if (state._closed) {
      await Promise.race([
        state._closed,
        sleep(Math.max(0.1, Math.min(Number(timeout), 10))),
      ]);
    }
    return this.status(monitorId);
  }

  status(monitorId) {
    const state = this._cloneState(monitorId);
    const stamp = nowSeconds();
    const refreshAvailable = Boolean(
      state.refresh_available
      && ['waiting_scan', 'expired'].includes(state.status)
      && Number(state.refresh_until || 0) > stamp,
    );
    return {
      status: state.status || 'unavailable',
      expires_at: state.expires_at ?? null,
      gcash_url: state.gcash_url || '',
      qr_source: state.qr_source || '',
      qr_version: Number(state.qr_version || 0),
      qr_ready: Boolean(
        Buffer.isBuffer(state.qr_png)
        && state.qr_png.length
        && state.qr_png.subarray(0, 8).equals(PNG_SIGNATURE),
      ),
      refresh_available: refreshAvailable,
    };
  }

  qrImage(monitorId) {
    const png = (this._states.get(String(monitorId || '')) || {}).qr_png;
    if (Buffer.isBuffer(png) && png.subarray(0, 8).equals(PNG_SIGNATURE)) return png;
    return Buffer.alloc(0);
  }

  _cleanupLocked() {
    const stamp = Date.now() / 1000;
    for (const [monitorId, state] of this._states.entries()) {
      if (
        TERMINAL_STATUSES.has(state.status)
        && stamp - Number(state.updated_at || stamp) > 3600
      ) {
        this._states.delete(monitorId);
      }
    }
  }
}

const manager = new PaymentMonitorManager();

module.exports = {
  PaymentMonitorManager,
  manager,
  captureRealQrPng,
};
