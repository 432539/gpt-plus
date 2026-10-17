const {
  EXTRACT_CONCURRENCY_CAP,
  GB_PAYPAL,
  protoError,
  newId,
  chatgptHeaders,
  chatgptAccountIdFromToken,
  chatgptCookieHeader,
  cookieHeaderToEntries,
  isPaypalBaApproveUrl,
} = require('./paymentLink');
const { parseAccountCheck, accountCheckPayloadUsable, activatedPlanFromCheck, subscriptionExpiresFromCheck } = require('./accountCheck');
const {
  PROGRESS,
  isExtractLinkExpired,
  extractLinkState,
} = require('./accountProgress');
const { SmsBowerClient, resolveSmsbowerConfig } = require('./smsbower');
const { generateUser, generateCard, generateAddress, createSessionState } = require('./paypalProfile');
const { PayPalSession } = require('./paypalSession');
const { PayPalFlow, baTokenFromLink } = require('./paypalFlow');
const { USER_AGENT } = require('./paypalSignals');
const {
  CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
  isCloakSessionClosedError,
  isCloakTransportRetryError,
  cloakRetryMessage,
  cloakRetryExhaustedMessage,
  exhaustedCloakSlotError,
} = require('./cloakErrors');

const PAY_CONCURRENCY_CAP = EXTRACT_CONCURRENCY_CAP;
const PIPELINE_UNLIMITED_CAP = 1000;
const SMS_TIMEOUT_SECONDS = 180;
const SMS_PHASE_TIMEOUT_SECONDS = 600;
const CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const CHATGPT_ORIGIN = 'https://chatgpt.com/';
const PLUS_POLL_ATTEMPTS = 12;
const PLUS_POLL_INTERVAL_MS = 5000;
const CHECKOUT_VERIFY_TIMEOUT_MS = 90_000;
const MERCHANT_SETTLE_MS = 30_000;
const CHECKOUT_VERIFY_WAIT_UNTIL = 'load';
const MAX_JOB_ATTEMPTS = 1;
const CONTEXT_REBUILD_MAX_JOB_ATTEMPTS = 1;
const JOB_RETRY_DELAY_MS = 3000;
const OAS_RETRY_DELAY_MS = 30000;
const PAYPAL_CHALLENGE_RETRY_DELAY_MS = 30000;
const TERMINAL_PAY_CODES = new Set([
  'JOB_CANCELLED',
  'PAY_LINK_MISSING',
  'PAY_LINK_EXPIRED',
  'PAY_LINK_INVALID',
  'EXTRACT_PROXY_EMPTY',
  'SMS_KEY_MISSING',
  'CHATGPT_PLUS_NOT_SYNCED',
  'CHATGPT_PLUS_VERIFY_FAILED',
  'AUTHORIZE_EMPTY',
  'PAYMENT_OUTCOME_UNKNOWN',
  'RISK_DISALLOWED',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorHaystack(error) {
  return `${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`.toLowerCase();
}

function isPayBusinessRejectError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === 'AUTHORIZE_EMPTY' || code === 'RISK_DISALLOWED') return true;
  const hay = errorHaystack(error);
  return hay.includes('authorize_empty') || hay.includes('risk_disallowed');
}

function isTransportPayError(error) {
  if (!error) return false;
  if (isCloakSessionClosedError(error)) return true;
  if (['PROTOCOL_REQUEST_TIMEOUT', 'PROTOCOL_REQUEST_NETWORK', 'SMS_TRANSPORT', 'CLOAK_SESSION_CLOSED', 'JOB_CANCELLED'].includes(error.code)) {
    return true;
  }
  return /timeout|timed out|failed to fetch|net::|socket hang up|econnreset|proxy|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(String(error.message || ''));
}

function isPaymentContextRebuildError(error) {
  const hay = errorHaystack(error);
  return [
    'identity_elevation_ec_missing',
    'paypal_graphql_html_challenge',
    'paypal_graphql_non_json_response',
    'paypal_page_challenge',
    'paypal_otp_context_rebuild',
    'paypal_onboarding_context_rebuild',
    'operation timed out',
    'curl: (28)',
    'protocol_request_timeout',
  ].some((marker) => hay.includes(marker));
}

function retryDelayForFailedJob(error) {
  const hay = errorHaystack(error);
  if (['paypal_page_challenge', 'paypal_graphql_html_challenge', 'paypal_graphql_non_json_response'].some((marker) => hay.includes(marker))) {
    return PAYPAL_CHALLENGE_RETRY_DELAY_MS;
  }
  if (hay.includes('paypal_onboarding_context_rebuild')) return OAS_RETRY_DELAY_MS;
  return JOB_RETRY_DELAY_MS;
}

function shouldRetryFailedJob({
  jobAttempt,
  maxJobAttempts = MAX_JOB_ATTEMPTS,
  error,
  cancelled,
} = {}) {
  if (cancelled?.() || error?.code === 'JOB_CANCELLED' || String(error?.message || '').toLowerCase().includes('task cancelled')) {
    return { retry: false, maxJobAttempts };
  }
  if (TERMINAL_PAY_CODES.has(String(error?.code || '')) || isPayBusinessRejectError(error)) {
    return { retry: false, maxJobAttempts: Math.max(1, Number(maxJobAttempts) || MAX_JOB_ATTEMPTS) };
  }
  // Context rebuild / challenge errors require a fresh proxy+SMS session; fail fast
  // instead of auto-looping and burning extra SMSBower numbers.
  if (isPaymentContextRebuildError(error)) {
    return { retry: false, maxJobAttempts: Math.max(1, Number(maxJobAttempts) || CONTEXT_REBUILD_MAX_JOB_ATTEMPTS) };
  }
  if (isCloakTransportRetryError(error)) {
    const nextMax = Math.max(
      CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
      Math.max(1, Number(maxJobAttempts) || MAX_JOB_ATTEMPTS),
    );
    return {
      retry: Number(jobAttempt) < nextMax,
      maxJobAttempts: nextMax,
    };
  }
  const nextMax = Math.max(1, Number(maxJobAttempts) || MAX_JOB_ATTEMPTS);
  return {
    retry: Number(jobAttempt) < nextMax,
    maxJobAttempts: nextMax,
  };
}

function paypalAuthorizeSucceeded(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.status === 'success') return true;
  if (result.paypal_authorized === true) return true;
  return String(result.error_code || '') === 'MERCHANT_CHECKOUT_FAILED';
}

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

function preservePayError(error, extra = {}) {
  const wrapped = protoError(String(error?.message || error || 'PayPal 开通失败'), {
    code: error?.code || extra.code || 'PAYPAL_AUTHORIZE_FAILED',
    recoverable: extra.recoverable === false ? false : true,
    status: extra.status || error?.status,
  });
  return wrapped;
}

function paymentOutcomeUnknown(result, cause) {
  return protoError(
    'PayPal 最终授权返回不确定结果，且 ChatGPT Plus 尚未确认。已冻结重复支付，请稍后点击“核验”而不是重新扣款。',
    {
      code: 'PAYMENT_OUTCOME_UNKNOWN',
      recoverable: false,
      original_code: result?.error_code || 'AUTHORIZE_EMPTY',
      paypal_debug_id: result?.paypal_debug_id || '',
      paypal_http_status: result?.http_status || '',
      verify_error: String(cause?.message || cause || '').slice(0, 240),
    },
  );
}

function plusExpiresFromCheck(data, fallbackDays = 30) {
  return subscriptionExpiresFromCheck(data, fallbackDays);
}

function requirePayLink(detail) {
  const link = String(detail?.extract_link || '').trim();
  if (!link || extractLinkState(detail) === 'none') {
    throw protoError('请先重新提链', { status: 400, code: 'PAY_LINK_MISSING' });
  }
  if (isExtractLinkExpired(detail) || extractLinkState(detail) === 'expired') {
    throw protoError('提链已过期（90 分钟），请先重新提链', { status: 400, code: 'PAY_LINK_EXPIRED' });
  }
  const baToken = baTokenFromLink(link);
  if (!baToken) {
    throw protoError('请先重新提链', { status: 400, code: 'PAY_LINK_INVALID' });
  }
  if (!isPaypalBaApproveUrl(link) && !/^BA-/i.test(baToken)) {
    throw protoError('请先重新提链', { status: 400, code: 'PAY_LINK_INVALID' });
  }
  return { link, baToken };
}

function createSmsAdapter(client, { cancelled, emit, maxRotations = 10 }) {
  const used = new Set();
  let rotations = 0;
  let activation = null;
  const phaseStarted = Date.now();
  const remaining = () => Math.max(0, SMS_PHASE_TIMEOUT_SECONDS * 1000 - (Date.now() - phaseStarted));

  async function reserveUnique() {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const candidate = await client.reserveMatchingNumber();
      if (!used.has(candidate.phone)) {
        used.add(candidate.phone);
        activation = candidate;
        return candidate;
      }
      await client.cancelActivation();
      emit?.('sms', `SMSBower 返回了本任务已用过的号码，已释放并重取（${attempt}/10）`);
    }
    throw protoError('SMSBower 反复返回本任务已用过的号码', { code: 'SMS_DUPLICATE_PHONE' });
  }

  return {
    client,
    used,
    get activation() {
      return activation;
    },
    async reserve() {
      if (activation?.activationId && activation?.phone) return activation;
      return reserveUnique();
    },
    async waitForCode() {
      if (remaining() <= 0) {
        const error = new Error('SMS verification session exceeded its time budget; rebuilding the full payment context');
        error.name = 'TimeoutError';
        error.code = 'SMS_TIMEOUT';
        throw error;
      }
      const timeout = Math.min(SMS_TIMEOUT_SECONDS, remaining() / 1000);
      return client.waitForCode(timeout);
    },
    async rotatePhone(reason) {
      if (remaining() <= 0) {
        const error = new Error('SMS verification session exceeded its time budget; rebuilding the full payment context');
        error.name = 'TimeoutError';
        error.code = 'SMS_TIMEOUT';
        throw error;
      }
      if (rotations >= maxRotations) {
        throw protoError(`SMSBower auto-rotation limit reached (${maxRotations})`, { code: 'SMS_ROTATE_LIMIT' });
      }
      emit?.('sms', `SMSBower 正在更换号码：${String(reason || '').slice(0, 120)}`);
      let next = null;
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const candidate = await client.rotateNumber();
        if (!used.has(candidate.phone)) {
          used.add(candidate.phone);
          next = candidate;
          break;
        }
        await client.cancelActivation();
      }
      if (!next) throw protoError('SMSBower 换号失败', { code: 'SMS_ROTATE_FAILED' });
      activation = next;
      rotations += 1;
      emit?.('sms', `SMSBower 已换号（${rotations}/${maxRotations}）`);
      return activation.phone;
    },
    async requestAnother() {
      await client.requestAnotherSms();
    },
    async finish() {
      await client.finishActivation();
    },
    async cancel() {
      await client.cancelActivation();
    },
  };
}

async function seedChatgpt(session, detail, deviceId) {
  const cookies = cookieHeaderToEntries(chatgptCookieHeader({
    sessionCookie: detail.session_token || '',
    deviceId,
  }));
  if (cookies.length) await session.page.context().addCookies(cookies).catch(() => {});
  await session.goto(CHATGPT_ORIGIN, { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
}

async function chatgptCheck(session, detail, deviceId) {
  const headers = chatgptHeaders({
    accessToken: detail.access_token,
    deviceId,
    accountId: detail.chatgpt_account_id || chatgptAccountIdFromToken(detail.access_token),
    extra: { Referer: CHATGPT_ORIGIN },
  });
  delete headers.Origin;
  return session.request(`https://chatgpt.com${CHECK_PATH}`, {
    method: 'GET',
    headers,
    timeout: 45000,
    contextUrl: CHATGPT_ORIGIN,
    referrer: CHATGPT_ORIGIN,
  });
}

function checkoutVerifyUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (['chatgpt.com', 'chat.openai.com', 'pay.openai.com', 'checkout.stripe.com', 'pm-redirects.stripe.com'].includes(host)) {
      return value;
    }
  } catch {
    return '';
  }
  return /chatgpt\.com|openai\.com|stripe\.com/i.test(value) ? value : '';
}

async function openCheckoutVerify(session, verificationUrl, emit, timeoutMs = CHECKOUT_VERIFY_TIMEOUT_MS) {
  const target = checkoutVerifyUrl(verificationUrl);
  if (!target) return false;
  emit?.('verify', '正在打开 ChatGPT checkout 校验页');
  const budget = Math.max(1, Number(timeoutMs) || CHECKOUT_VERIFY_TIMEOUT_MS);
  try {
    // Desktop\gpt waits for the checkout/verify HTTP body (30s/hop). load lets
    // the ChatGPT callback finish; 8s+commit+about:blank aborted it.
    await raceTimeout(
      session.request(target, {
        method: 'GET',
        timeout: budget,
        waitUntil: CHECKOUT_VERIFY_WAIT_UNTIL,
      }),
      budget + Math.min(10_000, Math.max(80, budget)),
      `checkout verify timed out (${budget}ms)`,
    );
    return true;
  } catch {
    emit?.('verify', 'checkout 校验页未完成，继续确认套餐');
    return false;
  }
}

async function readActivatedPlan(session, detail, deviceId) {
  const response = await chatgptCheck(session, detail, deviceId);
  if (!accountCheckPayloadUsable(response.data)) {
    return { error: `HTTP ${response.status}` };
  }
  const parsed = parseAccountCheck(response.data);
  const planType = activatedPlanFromCheck(response.data);
  if (planType) {
    return {
      plan_type: planType,
      expires_at: plusExpiresFromCheck(response.data),
      parsed,
    };
  }
  return { parsed, error: `plan=${parsed.plan_label || 'Free'}` };
}

async function verifyChatgptPlus(session, detail, {
  verificationUrl = '',
  emit,
  cancelled,
  sleep: sleepFn,
  verifyTimeoutMs = CHECKOUT_VERIFY_TIMEOUT_MS,
} = {}) {
  const wait = typeof sleepFn === 'function' ? sleepFn : sleep;
  const deviceId = newId();
  await seedChatgpt(session, detail, deviceId);
  let lastError = '';
  let lastParsed = null;
  for (let attempt = 1; attempt <= PLUS_POLL_ATTEMPTS; attempt += 1) {
    if (cancelled?.()) throw protoError('任务已取消', { code: 'JOB_CANCELLED' });
    emit?.('verify', `正在确认 ChatGPT Plus 套餐（${attempt}/${PLUS_POLL_ATTEMPTS}）`);
    try {
      const hit = await readActivatedPlan(session, detail, deviceId);
      lastParsed = hit.parsed || lastParsed;
      if (hit.plan_type) return hit;
      lastError = hit.error || lastError;
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      lastError = error.message;
    }
    if (attempt === 1) {
      await openCheckoutVerify(session, verificationUrl, emit, verifyTimeoutMs);
    }
    if (attempt < PLUS_POLL_ATTEMPTS) await wait(PLUS_POLL_INTERVAL_MS);
  }
  const stillFree = lastParsed && String(lastParsed.plan_label || 'Free') === 'Free';
  const code = stillFree ? 'CHATGPT_PLUS_NOT_SYNCED' : 'CHATGPT_PLUS_VERIFY_FAILED';
  throw protoError(
    `PayPal 已授权，但 ChatGPT 套餐仍未同步（${lastError || 'plan=Free'}），开通失败`,
    { code, recoverable: true },
  );
}

function paidActivationResult(plus, paypal = {}) {
  return {
    paid: true,
    plan_type: plus.plan_type,
    expires_at: plus.expires_at,
    paypal,
  };
}

async function reconcilePendingPayment({
  detail,
  runtime,
  proxy,
  cancelled,
  log,
  sleep: sleepFn,
} = {}) {
  if (!proxy) {
    throw protoError('支付代理分组没有可用代理', { status: 400, code: 'EXTRACT_PROXY_EMPTY' });
  }
  log?.('verify: 检测到“支付待核验”，本次只查询 ChatGPT Plus，不会再次请求 PayPal 扣款', 'warning');
  return runtime.withSession({
    proxy,
    kind: 'activate',
    locale: 'en-GB',
    timezone: GB_PAYPAL.timezone,
    cancelled,
    timeoutMs: 180000,
    log: (message, level) => {
      if (level === 'error' || level === 'warn') log?.(message, level);
    },
  }, async (session) => {
    try {
      const plus = await verifyChatgptPlus(session, detail, {
        emit: (step, message, level = 'info') => log?.(`${step}: ${message}`, level),
        cancelled,
        sleep: sleepFn,
      });
      return paidActivationResult(plus, {
        outcome: 'reconciled_pending_payment',
      });
    } catch (error) {
      if (error?.code === 'JOB_CANCELLED') throw error;
      throw paymentOutcomeUnknown(null, error);
    }
  });
}

async function runActivateOnce({
  baToken,
  detail,
  runtime,
  proxy,
  cancelled,
  log,
  smsConfig,
  smsFactory,
  flowFactory,
  sleep: sleepFn,
  smsAdapter: existingAdapter = null,
  onSmsAdapter,
} = {}) {
  const emit = (step, message, level = 'info') => {
    if (level === 'debug' || /卡片被拒/.test(String(message || ''))) {
      log?.(`${step}: ${message}`, 'debug');
      return;
    }
    log?.(`${step}: ${message}`, level || 'info');
  };
  let smsAdapter = existingAdapter;
  try {
    return await runtime.withSession({
      proxy,
      kind: 'activate',
      locale: 'en-GB',
      timezone: GB_PAYPAL.timezone,
      cancelled,
      timeoutMs: 180000,
      log: (message, level) => {
        if (level === 'debug') return;
        if (level === 'error' || level === 'warn') log?.(message, level);
      },
    }, async (session) => {
      await session.goto('https://www.paypal.com/', { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
      const fp = await session.fingerprint().catch(() => null);
      const userAgent = fp?.ua || USER_AGENT;
      if (!smsAdapter) {
        const client = smsFactory
          ? smsFactory(smsConfig)
          : new SmsBowerClient({
            apiKey: smsConfig.apiKey,
            apiUrl: smsConfig.apiUrl,
            country: 'GB',
            service: 'ts',
            timeoutSeconds: SMS_TIMEOUT_SECONDS,
            pollInterval: 2,
            cancelled,
            statusCallback: (message) => emit('sms', message),
          });
        smsAdapter = createSmsAdapter(client, { cancelled, emit, maxRotations: 10 });
        onSmsAdapter?.(smsAdapter);
      }
      let activation = smsAdapter.activation;
      if (!activation) {
        emit('sms', 'SMSBower 正在获取英国号码');
        activation = await smsAdapter.reserve();
      }
      const userInfo = generateUser(activation.phone, 'GB');
      const card = generateCard('GB');
      const address = generateAddress('GB');
      const state = createSessionState(baToken);
      const paypalSession = new PayPalSession(session, state, {
        country: 'GB',
        locale: 'en_GB',
        userAgent,
        emit,
      });
      const flow = flowFactory
        ? flowFactory({ session: paypalSession, baToken, user: userInfo, card, address, sms: smsAdapter, emit, cancelled })
        : new PayPalFlow({
          session: paypalSession,
          state,
          baToken,
          user: userInfo,
          card,
          address,
          sms: smsAdapter,
          emit,
          cancelled,
          userAgent,
        });
      const result = await flow.run();
      if (!paypalAuthorizeSucceeded(result)) {
        if (String(result?.error_code || '') === 'AUTHORIZE_EMPTY') {
          emit('verify', 'PayPal authorize 返回不确定结果，先核验 ChatGPT Plus，期间禁止重复支付', 'warning');
          try {
            const plus = await verifyChatgptPlus(session, detail, {
              emit,
              cancelled,
              sleep: sleepFn,
            });
            return paidActivationResult(plus, {
              outcome: 'reconciled_after_authorize_empty',
              buyer_mode: result?.buyer_mode,
              paypal_debug_id: result?.paypal_debug_id || '',
              http_status: result?.http_status || '',
            });
          } catch (error) {
            if (error?.code === 'JOB_CANCELLED') throw error;
            throw paymentOutcomeUnknown(result, error);
          }
        }
        throw protoError(result?.error || 'PayPal 协议授权失败', {
          code: result?.error_code || 'PAYPAL_AUTHORIZE_FAILED',
          recoverable: result?.retryable === true,
        });
      }
      emit('paypal', 'PayPal Billing Agreement 已授权，商户回跳后等待 30 秒确认到账');
      const wait = typeof sleepFn === 'function' ? sleepFn : sleep;
      await wait(MERCHANT_SETTLE_MS);
      if (cancelled?.()) throw protoError('任务已取消', { code: 'JOB_CANCELLED' });
      emit('paypal', '商户回跳已等待 30 秒，按到账确认开通成功');
      return paidActivationResult({
        plan_type: 'Plus',
        expires_at: plusExpiresFromCheck(null, 30),
      }, {
        settlement_status: result.settlement_status,
        buyer_mode: result.buyer_mode,
        outcome: 'merchant_return_settled',
      });
    });
  } catch (error) {
    if (isTransportPayError(error) && error?.code !== 'JOB_CANCELLED') {
      throw protoError(`支付传输失败，账号状态保持不变：${error.message}`, {
        code: isCloakTransportRetryError(error) ? 'CLOAK_SESSION_CLOSED' : (error.code || 'PROTOCOL_REQUEST_NETWORK'),
        recoverable: true,
      });
    }
    throw error;
  }
}

async function runActivateAccount({
  user,
  id,
  detail,
  runtime,
  proxy,
  nextProxy,
  cancelled,
  log,
  settings,
  smsFactory,
  flowFactory,
  sleep: sleepFn,
} = {}) {
  const wait = typeof sleepFn === 'function' ? sleepFn : sleep;
  if (String(detail?.progress || '') === PROGRESS.PAYMENT_REVIEW) {
    const reconcileProxy = proxy || nextProxy?.();
    return reconcilePendingPayment({
      detail,
      runtime,
      proxy: reconcileProxy,
      cancelled,
      log,
      sleep: wait,
    });
  }
  const { baToken } = requirePayLink(detail);
  const smsConfig = resolveSmsbowerConfig(settings?.sms || {}, { countryFallback: 'GB', serviceFallback: 'ts' });
  if (!proxy && typeof nextProxy !== 'function') {
    throw protoError('支付代理分组没有可用代理', { status: 400, code: 'EXTRACT_PROXY_EMPTY' });
  }
  let maxJobAttempts = MAX_JOB_ATTEMPTS;
  let lastError = null;
  let smsAdapter = null;
  let succeeded = false;
  try {
    for (let jobAttempt = 1; jobAttempt <= maxJobAttempts; jobAttempt += 1) {
      if (cancelled?.()) throw protoError('任务已取消', { code: 'JOB_CANCELLED' });
      const currentProxy = jobAttempt === 1
        ? (proxy || nextProxy?.())
        : (typeof nextProxy === 'function' ? (nextProxy() || proxy) : proxy);
      if (!currentProxy) throw protoError('支付代理分组没有可用代理', { status: 400, code: 'EXTRACT_PROXY_EMPTY' });
      try {
        const result = await runActivateOnce({
          baToken,
          detail,
          runtime,
          proxy: currentProxy,
          cancelled,
          log,
          smsConfig,
          smsFactory,
          flowFactory,
          sleep: wait,
          smsAdapter,
          onSmsAdapter: (adapter) => { smsAdapter = adapter; },
        });
        succeeded = true;
        return result;
      } catch (error) {
        lastError = error;
        const decision = shouldRetryFailedJob({
          jobAttempt,
          maxJobAttempts,
          error,
          cancelled,
        });
        maxJobAttempts = decision.maxJobAttempts;
        if (!decision.retry) break;
        const delayMs = retryDelayForFailedJob(error);
        if (isCloakTransportRetryError(error)) {
          log?.(cloakRetryMessage(jobAttempt + 1, decision.maxJobAttempts), 'warning');
        } else {
          log?.(
            `paypal: 执行失败，${Math.round(delayMs / 1000)} 秒后自动重试（${String(error?.code || error?.message || 'ERROR').slice(0, 120)}）`,
            'info',
          );
        }
        await wait(delayMs);
      }
    }
    if (isCloakTransportRetryError(lastError)) {
      log?.(cloakRetryExhaustedMessage(CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS), 'error');
      throw exhaustedCloakSlotError(lastError);
    }
    if (isPaymentContextRebuildError(lastError)) {
      log?.(
        'paypal: 支付上下文异常，已停止自动重试（避免重复购买接码号码）。请检查代理/环境后重新提链，再手动点击支付。',
        'info',
      );
      throw preservePayError(lastError, { code: lastError?.code || 'PAYPAL_ONBOARDING_CONTEXT_REBUILD' });
    }
    if (isTransportPayError(lastError) && lastError?.code !== 'JOB_CANCELLED') {
      throw protoError(`支付传输失败，账号状态保持不变：${lastError.message}`, {
        code: lastError.code || 'PROTOCOL_REQUEST_NETWORK',
        recoverable: true,
      });
    }
    throw lastError;
  } finally {
    if (!succeeded) {
      try { await smsAdapter?.cancel?.(); } catch { /* release best-effort */ }
    }
  }
}

function prepareActivateJob(_userId, body = {}) {
  const cap = body.pipeline === true ? PIPELINE_UNLIMITED_CAP : PAY_CONCURRENCY_CAP;
  const requested = Number(body.concurrency);
  const fallback = body.pipeline === true ? cap : PAY_CONCURRENCY_CAP;
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(requested) && requested > 0 ? requested : fallback, cap),
  );
  return { proxy_group: '__auto__:GB', concurrency, maxConcurrency: cap };
}

module.exports = {
  PAY_CONCURRENCY_CAP,
  PIPELINE_UNLIMITED_CAP,
  SMS_TIMEOUT_SECONDS,
  MAX_JOB_ATTEMPTS,
  CONTEXT_REBUILD_MAX_JOB_ATTEMPTS,
  CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
  JOB_RETRY_DELAY_MS,
  OAS_RETRY_DELAY_MS,
  PAYPAL_CHALLENGE_RETRY_DELAY_MS,
  runActivateAccount,
  prepareActivateJob,
  requirePayLink,
  isTransportPayError,
  isCloakSessionClosedError,
  isPaymentContextRebuildError,
  retryDelayForFailedJob,
  shouldRetryFailedJob,
  plusExpiresFromCheck,
  createSmsAdapter,
  verifyChatgptPlus,
  reconcilePendingPayment,
  checkoutVerifyUrl,
  paypalAuthorizeSucceeded,
  PLUS_POLL_ATTEMPTS,
  PLUS_POLL_INTERVAL_MS,
  CHECKOUT_VERIFY_TIMEOUT_MS,
  MERCHANT_SETTLE_MS,
  CHECKOUT_VERIFY_WAIT_UNTIL,
  baTokenFromLink,
};
