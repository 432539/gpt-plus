'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GCASH_CONCURRENCY_CAP,
  gcashConcurrencyCap,
  gcashJobConcurrency,
} = require('../src/utils/gcashConcurrency');

test('GCash concurrency defaults to 20 and clamps env to 20', (t) => {
  const prevConcurrency = process.env.GCASH_MAX_CONCURRENCY;
  const prevMonitors = process.env.GCASH_MAX_ACTIVE_MONITORS;
  t.after(() => {
    if (prevConcurrency == null) delete process.env.GCASH_MAX_CONCURRENCY;
    else process.env.GCASH_MAX_CONCURRENCY = prevConcurrency;
    if (prevMonitors == null) delete process.env.GCASH_MAX_ACTIVE_MONITORS;
    else process.env.GCASH_MAX_ACTIVE_MONITORS = prevMonitors;
  });

  delete process.env.GCASH_MAX_CONCURRENCY;
  delete process.env.GCASH_MAX_ACTIVE_MONITORS;
  assert.equal(GCASH_CONCURRENCY_CAP, 20);
  assert.equal(gcashConcurrencyCap(), 20);
  assert.equal(gcashJobConcurrency({ pipeline: true }), 20);
  assert.equal(gcashJobConcurrency({}), 20);
  assert.equal(gcashJobConcurrency({ ids: [1, 2, 3] }), 3);
  assert.equal(gcashJobConcurrency({ concurrency: 20, ids: Array.from({ length: 20 }, (_, i) => i + 1) }), 20);

  process.env.GCASH_MAX_CONCURRENCY = '999';
  assert.equal(gcashConcurrencyCap(), 20);
  process.env.GCASH_MAX_CONCURRENCY = '8';
  assert.equal(gcashConcurrencyCap(), 8);
  assert.equal(gcashJobConcurrency({ concurrency: 20 }), 8);
});
