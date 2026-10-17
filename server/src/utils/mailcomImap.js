class RetryableImapError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.code = options.code || 'MAILCOM_IMAP_TRANSIENT';
    this.retryable = true;
  }
}

function isTransientImapError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error);
  return (
    ['ETIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code) ||
    /timeout|timed out|socket|connection|network|econn|closed unexpectedly/i.test(message)
  );
}

function asRetryableImapError(error) {
  if (error?.retryable) return error;
  return new RetryableImapError(`mail.com IMAP 暂时不可用：${String(error?.message || error)}`, {
    cause: error,
  });
}

async function withSafeImapClient(createClient, operation) {
  const client = createClient();
  let rejectEmitted;
  const emittedError = new Promise((_, reject) => {
    rejectEmitted = reject;
  });
  // Keep this listener attached for the entire client lifetime. Promise.race
  // installs a rejection handler, so even a late error after logout is handled.
  client.on('error', (error) => rejectEmitted(error));

  let result;
  let primaryError = null;
  try {
    result = await Promise.race([
      (async () => {
        await client.connect();
        return operation(client);
      })(),
      emittedError,
    ]);
  } catch (error) {
    primaryError = error;
  }

  try {
    await Promise.race([
      Promise.resolve(client.logout()).catch((error) => {
        throw error;
      }),
      emittedError,
    ]);
  } catch (error) {
    if (!primaryError) primaryError = error;
  }

  if (primaryError) throw primaryError;
  return result;
}

class ImapFallbackCoordinator {
  constructor({ backoffMs = 20000, now = () => Date.now() } = {}) {
    this.backoffMs = Math.max(1000, Number(backoffMs) || 20000);
    this.now = now;
    this.inbox = new Map();
    this.body = new Map();
    this.blockedUntil = new Map();
    this.lastError = new Map();
  }

  runInbox(motherKey, operation) {
    return this.#run(this.inbox, String(motherKey), String(motherKey), operation);
  }

  runBody(motherKey, mailId, operation) {
    return this.#run(this.body, `${motherKey}:${mailId}`, String(motherKey), operation);
  }

  #run(inflightMap, inflightKey, motherKey, operation) {
    const existing = inflightMap.get(inflightKey);
    if (existing) return existing;

    const blockedUntil = this.blockedUntil.get(motherKey) || 0;
    if (blockedUntil > this.now()) {
      const last = this.lastError.get(motherKey);
      return Promise.reject(
        new RetryableImapError(
          `mail.com IMAP 失败退避中：${String(last?.message || last || '稍后重试')}`,
          { code: 'MAILCOM_IMAP_BACKOFF', cause: last }
        )
      );
    }

    const promise = Promise.resolve()
      .then(operation)
      .catch((error) => {
        if (isTransientImapError(error)) {
          this.lastError.set(motherKey, error);
          this.blockedUntil.set(motherKey, this.now() + this.backoffMs);
          throw asRetryableImapError(error);
        }
        throw error;
      })
      .finally(() => {
        if (inflightMap.get(inflightKey) === promise) inflightMap.delete(inflightKey);
      });
    inflightMap.set(inflightKey, promise);
    return promise;
  }
}

module.exports = {
  ImapFallbackCoordinator,
  RetryableImapError,
  asRetryableImapError,
  isTransientImapError,
  withSafeImapClient,
};
