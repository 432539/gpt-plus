const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CloakRuntime } = require('../src/automation/cloak');

const fingerprint = Object.freeze({
  ua: 'fixture',
  platform: 'Win32',
  language: 'en-US',
  languages: ['en-US'],
  timezone: 'UTC',
  screen: '1280x720@1',
  cores: 4,
  memory: 8,
  vendor: 'fixture',
  maxTouchPoints: 0,
  webdriver: false,
});

function contextFixture(onLaunch = null, onClose = null) {
  return async options => {
    await onLaunch?.(options);
    let context;
    const page = {
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      async goto() {},
      async evaluate() { return fingerprint; },
      context: () => context,
      async close() {},
    };
    context = {
      pages: () => [page],
      async newPage() { return page; },
      browser: () => context,
      async close() { await onClose?.(); },
    };
    return context;
  };
}

function browserFixture(onLaunch = null, onClose = null) {
  return async options => {
    await onLaunch?.(options);
    let context;
    const page = {
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      async goto() {},
      async evaluate() { return fingerprint; },
      context: () => context,
      async close() {},
    };
    context = {
      pages: () => [page],
      async newPage() { return page; },
      async close() {},
    };
    return {
      async newContext() { return context; },
      async close() { await onClose?.(); },
    };
  };
}

test('persistent profiles use configured root and clean asynchronously', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-plus-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let launchedPath = '';
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launchConcurrency: 1,
    profileRoot: root,
    licenseSessionCount: async () => null,
    launchPersistentContext: contextFixture(async options => {
      launchedPath = options.userDataDir;
      await fs.mkdir(launchedPath, { recursive: true });
      await fs.writeFile(path.join(launchedPath, 'fixture'), 'profile data');
    }),
  });

  await runtime.withSession({
    profileKey: 'person@example.test',
    role: 'register',
    proxy: { host: 'proxy.test', port: 8080, username: 'person' },
    cleanupProfile: true,
  }, async () => {});

  assert.equal(path.dirname(launchedPath), root);
  assert.equal(runtime.slotStats().reservedSlots, 0);
  await runtime.drainProfileCleanups();
  await assert.rejects(fs.access(launchedPath));
  await runtime.closeAll();
});

test('profile deletion does not hold a closed browser slot', async () => {
  let cleanupStartedResolve;
  let allowCleanupResolve;
  const cleanupStarted = new Promise(resolve => { cleanupStartedResolve = resolve; });
  const allowCleanup = new Promise(resolve => { allowCleanupResolve = resolve; });
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launchConcurrency: 1,
    licenseSessionCount: async () => null,
    launchPersistentContext: contextFixture(),
    profileCleanup: async () => {
      cleanupStartedResolve();
      await allowCleanup;
      return true;
    },
  });

  const first = runtime.withSession({ profileKey: 'slow-cleanup', cleanupProfile: true }, async () => {});
  await cleanupStarted;
  assert.equal(runtime.slotStats().reservedSlots, 0);
  assert.equal(runtime.profileCleanupStats().pending, 1);
  await first;

  let secondStarted = false;
  await runtime.withSession({ profileKey: 'next-profile' }, async () => { secondStarted = true; });
  assert.equal(secondStarted, true);
  allowCleanupResolve();
  await runtime.drainProfileCleanups();
  await runtime.closeAll();
});

test('same persistent profile is locked against concurrent reuse', async () => {
  let launches = 0;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const runtime = new CloakRuntime({
    maxConcurrency: 2,
    launchConcurrency: 2,
    licenseSessionCount: async () => null,
    launchPersistentContext: contextFixture(() => { launches += 1; }),
  });
  const first = runtime.withSession({ profileKey: 'same', role: 'register' }, () => firstGate);
  while (launches < 1) await new Promise(resolve => setTimeout(resolve, 1));
  const second = runtime.withSession({ profileKey: 'same', role: 'register' }, async () => {});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(launches, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(launches, 2);
  await runtime.closeAll();
});

test('cold launch semaphore is independent from business slots', async () => {
  let launching = 0;
  let maxLaunching = 0;
  const runtime = new CloakRuntime({
    maxConcurrency: 3,
    launchConcurrency: 1,
    licenseSessionCount: async () => null,
    launch: browserFixture(async () => {
      launching += 1;
      maxLaunching = Math.max(maxLaunching, launching);
      await new Promise(resolve => setTimeout(resolve, 10));
      launching -= 1;
    }),
  });
  await Promise.all(Array.from({ length: 3 }, (_, index) =>
    runtime.withSession({ activity: { jobId: `job-${index}` } }, async () => {})));
  assert.equal(maxLaunching, 1);
  assert.equal(runtime.launchStats().reservedSlots, 0);
  await runtime.closeAll();
});

test('session wall watchdog closes resources and releases slot', async () => {
  let closeCalls = 0;
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launchConcurrency: 1,
    cleanupForceTimeoutMs: 10,
    licenseSessionCount: async () => null,
    launch: browserFixture(null, () => { closeCalls += 1; }),
  });
  await assert.rejects(
    runtime.withSession({ sessionWallTimeoutMs: 20 }, () => new Promise(() => {})),
    error => error.code === 'CLOAK_SESSION_WALL_TIMEOUT' && error.timeout_ms === 20,
  );
  assert.ok(closeCalls >= 1);
  assert.equal(runtime.slotStats().reservedSlots, 0);
  assert.equal(runtime.launchStats().reservedSlots, 0);
  await runtime.closeAll();
});

test('remote license capacity waits before launching without consuming a business retry', async () => {
  const counts = [5, 0];
  let launches = 0;
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launchConcurrency: 1,
    licenseSessionLimitBaseDelayMs: 1,
    licenseSessionLimitMaxDelayMs: 1,
    licenseSessionProbeIntervalMs: 0,
    licenseSessionCount: async () => counts.shift() ?? 0,
    launch: browserFixture(() => { launches += 1; }),
  });
  const admission = await runtime.acquireLaunchAdmission({ kind: 'register' });
  await runtime.withSession({ launchAdmission: admission }, async () => {});
  assert.equal(launches, 1);
  assert.equal(runtime.licenseCapacity.consecutive, 0);
  await runtime.closeAll();
});

test('closeByJobIds targets only matching active resources', async () => {
  const closed = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = new CloakRuntime({
    maxConcurrency: 2,
    launchConcurrency: 2,
    licenseSessionCount: async () => null,
    launch: async () => browserFixture(null, () => { closed.push('closed'); })(),
  });
  const running = runtime.withSession({
    activity: { jobId: 'wanted-job', label: 'wanted' },
  }, () => gate);
  while (!runtime.active.size) await new Promise(resolve => setTimeout(resolve, 1));
  const result = await runtime.closeByJobIds(['wanted-job'], { timeoutMs: 5 });
  assert.equal(result.closed, false);
  assert.ok(closed.length >= 1);
  release();
  await running;
  assert.equal(runtime.slotStats().reservedSlots, 0);
  await runtime.closeAll();
});
