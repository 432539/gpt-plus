const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSampler,
  getServerMetrics,
  parseMeminfo,
} = require('../src/utils/serverMetrics');

test('server metrics exposes a safe cross-platform shape', () => {
  const metrics = getServerMetrics();
  assert.equal(typeof metrics.sampled_at, 'string');
  assert.ok(Number.isFinite(metrics.cpu.percent));
  assert.ok(metrics.cpu.percent >= 0 && metrics.cpu.percent <= 100);
  assert.ok(Number.isInteger(metrics.cpu.cores) && metrics.cpu.cores > 0);
  assert.ok(Number.isFinite(metrics.memory.total_bytes));
  assert.ok(Number.isFinite(metrics.memory.used_bytes));
  assert.ok(Number.isFinite(metrics.process.rss_bytes));
  assert.ok(metrics.disk === null || Number.isFinite(metrics.disk.used_percent));
  assert.doesNotMatch(JSON.stringify(metrics), /password|access_token|refresh_token|license_key/i);
});

test('sampler calculates CPU deltas and unrefs its timer', () => {
  let user = 100;
  let idle = 100;
  const fakeOs = {
    cpus: () => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }],
    totalmem: () => 1000,
    freemem: () => 400,
    loadavg: () => [1.234, 0.5, 0.25],
    uptime: () => 123,
    availableParallelism: () => 1,
  };
  const sampler = createSampler({ osModule: fakeOs, autoStart: false, intervalMs: 250 });
  user = 150;
  idle = 150;
  const metrics = sampler.sample();
  assert.equal(metrics.cpu.percent, 50);
  assert.equal(metrics.cpu.load1, 1.23);
  assert.equal(metrics.memory.used_bytes, 600);
  const timer = sampler.start();
  if (typeof timer.hasRef === 'function') assert.equal(timer.hasRef(), false);
  sampler.stop();
});

test('Linux meminfo parser returns available memory and swap usage', () => {
  const parsed = parseMeminfo([
    'MemTotal:       1000 kB',
    'MemAvailable:    600 kB',
    'SwapTotal:       200 kB',
    'SwapFree:         50 kB',
  ].join('\n'));
  assert.equal(parsed.available_bytes, 600 * 1024);
  assert.equal(parsed.swap_total_bytes, 200 * 1024);
  assert.equal(parsed.swap_used_bytes, 150 * 1024);
});
