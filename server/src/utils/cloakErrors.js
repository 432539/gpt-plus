const CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS = 3;
const CLOAK_RETRY_DELAY_MS = 500;
const CLOAK_SLOT_FAIL_MESSAGE = 'Cloak 席位不足或会话已关闭';

function errorHaystack(error) {
  return `${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`.toLowerCase();
}

function isCloakCapacityError(error) {
  if (!error) return false;
  const hay = errorHaystack(error);
  return /session limit reached|too many sessions|concurrent session|full capacity|席位不足|席位暂满|cloakbrowser pro: session limit/i.test(hay)
    || String(error.code || '') === 'CLOAK_LICENSE_SESSION_LIMIT';
}

function isCloakSessionClosedError(error) {
  if (!error) return false;
  if (String(error.code || '') === 'CLOAK_SESSION_CLOSED') return true;
  const hay = errorHaystack(error);
  return /cloak_session_closed|targetclosederror|browser has been closed|target closed|context or browser has been closed|协议上下文加载失败|session closed|target page, context or browser|browser\.newpage/i.test(hay)
    || isCloakCapacityError(error);
}

function isCloakTransportRetryError(error) {
  return isCloakSessionClosedError(error) || isCloakCapacityError(error);
}

function cloakRetryMessage(nextAttempt, maxAttempts = CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS) {
  return `Cloak 页面被关闭，换会话重试（${nextAttempt}/${maxAttempts}）`;
}

function cloakRetryExhaustedMessage(maxAttempts = CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS) {
  return `Cloak 页面被关闭，已换会话重试仍失败（${maxAttempts}/${maxAttempts}）`;
}

function exhaustedCloakSlotError(cause) {
  const error = new Error(CLOAK_SLOT_FAIL_MESSAGE);
  error.code = 'CLOAK_SESSION_CLOSED';
  error.recoverable = true;
  if (cause) error.cause = cause;
  return error;
}

async function runWithCloakTransportRetry({
  maxAttempts = CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
  cancelled,
  log,
  proxy,
  nextProxy,
  delayMs = CLOAK_RETRY_DELAY_MS,
  sleep: sleepFn,
  run,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('runWithCloakTransportRetry 缺少 run');
  const wait = typeof sleepFn === 'function' ? sleepFn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempts = Math.max(1, Number(maxAttempts) || CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (cancelled?.()) {
      const error = new Error('任务已取消');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    const currentProxy = attempt === 1
      ? proxy
      : (typeof nextProxy === 'function' ? (nextProxy() || proxy) : proxy);
    try {
      return await run(currentProxy, attempt);
    } catch (error) {
      lastError = error;
      if (error?.code === 'JOB_CANCELLED' || cancelled?.()) throw error;
      if (!isCloakTransportRetryError(error) || attempt >= attempts) {
        if (isCloakTransportRetryError(error) && attempt >= attempts) {
          log?.(cloakRetryExhaustedMessage(attempts), 'error');
          throw exhaustedCloakSlotError(error);
        }
        throw error;
      }
      log?.(cloakRetryMessage(attempt + 1, attempts), 'warning');
      if (delayMs > 0) await wait(delayMs);
    }
  }
  log?.(cloakRetryExhaustedMessage(attempts), 'error');
  throw exhaustedCloakSlotError(lastError);
}

module.exports = {
  CLOAK_TRANSPORT_MAX_JOB_ATTEMPTS,
  CLOAK_RETRY_DELAY_MS,
  CLOAK_SLOT_FAIL_MESSAGE,
  isCloakCapacityError,
  isCloakSessionClosedError,
  isCloakTransportRetryError,
  cloakRetryMessage,
  cloakRetryExhaustedMessage,
  exhaustedCloakSlotError,
  runWithCloakTransportRetry,
};
