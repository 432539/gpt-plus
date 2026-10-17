'use strict';

// Open-source MK GCash Link: extract workers cap 12, monitors default 12 (env up to 24).
// Local gpt-plus runs on a bigger box; keep a hard cap of 20 parallel extract/pay/H5 sessions.
const GCASH_CONCURRENCY_CAP = 20;

function envCap(name, fallback) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(GCASH_CONCURRENCY_CAP, Math.floor(n)));
}

function gcashConcurrencyCap() {
  return envCap('GCASH_MAX_CONCURRENCY', envCap('GCASH_MAX_ACTIVE_MONITORS', GCASH_CONCURRENCY_CAP));
}

function gcashJobConcurrency(body = {}) {
  const cap = gcashConcurrencyCap();
  const requested = Number(body.concurrency);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(1, Math.min(cap, Math.floor(requested)));
  }
  if (body.pipeline === true) return cap;
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).length : 0;
  return Math.max(1, Math.min(cap, ids || cap));
}

module.exports = {
  GCASH_CONCURRENCY_CAP,
  gcashConcurrencyCap,
  gcashJobConcurrency,
};
