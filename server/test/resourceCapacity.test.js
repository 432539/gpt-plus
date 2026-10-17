const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  planCloakResourceConcurrency,
  resolveCgroupV2Directory,
} = require('../src/automation/config');
const { CloakRuntime } = require('../src/automation/cloak');

const GIB = 1024 ** 3;

test('cgroup v2 resolver follows service path and rejects traversal', () => {
  assert.equal(
    resolveCgroupV2Directory('0::/system.slice/gpt-plus.service\n', '/sys/fs/cgroup'),
    path.resolve('/sys/fs/cgroup/system.slice/gpt-plus.service'),
  );
  assert.equal(resolveCgroupV2Directory('0::/../../etc\n', '/sys/fs/cgroup'), '');
  assert.equal(resolveCgroupV2Directory('2:memory:/legacy\n', '/sys/fs/cgroup'), '');
});

test('resource planner applies CPU, memory, minimum, and product bounds', () => {
  const large = planCloakResourceConcurrency({ cpuCount: 16, memoryCapacityBytes: 24 * GIB });
  assert.equal(large.cpuLimit, 32);
  assert.equal(large.memoryLimit, 38);
  assert.equal(large.recommendedConcurrency, 32);

  const small = planCloakResourceConcurrency({ cpuCount: 4, memoryCapacityBytes: 4 * GIB });
  assert.equal(small.recommendedConcurrency, 4);
  assert.equal(planCloakResourceConcurrency({
    cpuCount: 128, memoryCapacityBytes: 1024 * GIB,
  }).recommendedConcurrency, 200);
  assert.equal(planCloakResourceConcurrency({
    cpuCount: 1, memoryCapacityBytes: GIB,
  }).recommendedConcurrency, 1);
});

test('license session ceiling follows resource concurrency instead of 5', async () => {
  const runtime = new CloakRuntime({
    maxConcurrency: 3,
    resourceMaxConcurrency: 50,
    licenseSessionCount: async () => null,
  });
  assert.equal(runtime.info().licenseMaxSessions, 50);
  await runtime.closeAll();
});

test('runtime reports configured and effective resource capacity', async () => {
  const runtime = new CloakRuntime({
    maxConcurrency: 3,
    configuredMaxConcurrency: 5,
    resourceMaxConcurrency: 3,
    launchConcurrency: 1,
    licenseSessionCount: async () => null,
  });
  const info = runtime.info();
  assert.equal(info.configuredMaxConcurrency, 5);
  assert.equal(info.resourceMaxConcurrency, 3);
  assert.equal(info.resourceLimited, true);
  assert.equal(info.launchConcurrency, 1);
  await runtime.closeAll();
});
