'use strict';

/**
 * Scheduler caps from MK app.py / gcash_chain.py / payment_monitor.py.
 *
 * Open-source physical uppers: concurrency 12, monitors 24, queue 200.
 * Defaults stay 1:1 with open source. Concurrency upper is 20 so MK_MAX_CONCURRENCY=20
 * can run on this machine (open source MAX_WORKERS was 12).
 */

function boundedEnvInt(name, defaultValue, upper) {
  try {
    const parsed = parseInt(process.env[name] ?? String(defaultValue), 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(1, Math.min(parsed, upper));
  } catch {
    return defaultValue;
  }
}

// gcash_chain.py MAX_WORKERS was 12. Raised to 20 so env can reach 20.
const MAX_WORKERS = 20;
const MAX_QUEUE_SIZE = 200;
const MAX_ATTEMPTS = 5;

const MAX_CONCURRENCY = boundedEnvInt('MK_MAX_CONCURRENCY', 4, MAX_WORKERS);
const MAX_ACCOUNTS = boundedEnvInt('MK_MAX_ACCOUNTS', 50, 50);
const MAX_SESSION_CONCURRENCY = boundedEnvInt(
  'MK_MAX_SESSION_CONCURRENCY',
  Math.min(4, MAX_CONCURRENCY),
  MAX_WORKERS,
);
const MAX_QUEUE = boundedEnvInt('MK_MAX_QUEUE', 50, MAX_QUEUE_SIZE);
const MAX_ACTIVE_MONITORS = boundedEnvInt('GCASH_MAX_ACTIVE_MONITORS', 12, 24);
const MAX_PROXIES = 100;

module.exports = {
  boundedEnvInt,
  MAX_WORKERS,
  MAX_QUEUE_SIZE,
  MAX_ATTEMPTS,
  MAX_CONCURRENCY,
  MAX_ACCOUNTS,
  MAX_SESSION_CONCURRENCY,
  MAX_QUEUE,
  MAX_ACTIVE_MONITORS,
  MAX_PROXIES,
};
