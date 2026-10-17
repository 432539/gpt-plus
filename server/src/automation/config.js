// Cloak / Sentinel 默认项。运行时由 registerJob 把用户设置里的 licenseKey、并发、无头模式覆盖进来。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLOAK_MIN_CONCURRENCY = 1;
const CLOAK_MAX_CONCURRENCY_LIMIT = 200;
const CLOAK_LAUNCH_CONCURRENCY_LIMIT = 20;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CLOAK_SLOT_MEMORY_BUDGET_BYTES = 512 * MIB;

function readMemoryLimit(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw || raw === 'max') return Infinity;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : Infinity;
  } catch {
    return Infinity;
  }
}

function resolveCgroupV2Directory(cgroupText, mountRoot = '/sys/fs/cgroup') {
  const entry = String(cgroupText || '').split(/\r?\n/).find(line => /^\d+::/.test(line));
  if (!entry) return '';
  const cgroupPath = entry.slice(entry.indexOf('::') + 2).trim();
  const root = path.resolve(mountRoot);
  const directory = path.resolve(root, cgroupPath.replace(/^[/\\]+/, ''));
  return directory === root || directory.startsWith(`${root}${path.sep}`) ? directory : '';
}

function hostMemoryCapacity() {
  let cgroupDirectory = '';
  try {
    cgroupDirectory = resolveCgroupV2Directory(fs.readFileSync('/proc/self/cgroup', 'utf8'));
  } catch {}
  const files = new Set([
    ...(cgroupDirectory ? [path.join(cgroupDirectory, 'memory.high'), path.join(cgroupDirectory, 'memory.max')] : []),
    '/sys/fs/cgroup/memory.high',
    '/sys/fs/cgroup/memory.max',
  ]);
  return Math.min(os.totalmem(), ...[...files].map(readMemoryLimit));
}

function planCloakResourceConcurrency({
  cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
  memoryCapacityBytes = hostMemoryCapacity(),
  minConcurrency = CLOAK_MIN_CONCURRENCY,
  maxConcurrency = CLOAK_MAX_CONCURRENCY_LIMIT,
  slotMemoryBytes = CLOAK_SLOT_MEMORY_BUDGET_BYTES,
} = {}) {
  const minimum = Math.max(1, Math.floor(Number(minConcurrency) || 1));
  const maximum = Math.max(minimum, Math.floor(Number(maxConcurrency) || minimum));
  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1));
  const memoryBytes = Math.max(0, Math.floor(Number(memoryCapacityBytes) || 0));
  const perSlotBytes = Math.max(128 * MIB, Math.floor(Number(slotMemoryBytes) || CLOAK_SLOT_MEMORY_BUDGET_BYTES));
  const reserveBytes = Math.min(memoryBytes, Math.max(2 * GIB, Math.floor(memoryBytes * 0.2)));
  const cpuLimit = Math.max(minimum, cpus * 2);
  const memoryLimit = Math.max(minimum, Math.floor(Math.max(0, memoryBytes - reserveBytes) / perSlotBytes));
  const recommendedConcurrency = Math.max(minimum, Math.min(maximum, cpuLimit, memoryLimit));
  return {
    cpuCount: cpus, memoryCapacityBytes: memoryBytes, reserveBytes,
    slotMemoryBytes: perSlotBytes, cpuLimit, memoryLimit, recommendedConcurrency,
  };
}

const detectedResourcePlan = planCloakResourceConcurrency();
const resourceOverride = Number.parseInt(process.env.CLOAK_RESOURCE_CONCURRENCY || '', 10);
const resourceConcurrency = Number.isFinite(resourceOverride)
  ? Math.max(CLOAK_MIN_CONCURRENCY, Math.min(CLOAK_MAX_CONCURRENCY_LIMIT, resourceOverride))
  : detectedResourcePlan.recommendedConcurrency;
const profileRoot = path.resolve(
  String(process.env.CLOAK_PROFILE_ROOT || '').trim()
    || path.join(__dirname, 'runtime', 'cloak-profiles'),
);

const config = Object.freeze({
  cloak: {
    licenseKey: '',
    browserVersion: '150.0.7871.114.3',
    headless: true,
    timeoutMs: 120000,
    maxConcurrency: 3,
    resourceConcurrency,
    resourcePlan: Object.freeze({
      ...detectedResourcePlan,
      autoRecommendedConcurrency: detectedResourcePlan.recommendedConcurrency,
      recommendedConcurrency: resourceConcurrency,
      overridden: Number.isFinite(resourceOverride),
    }),
    launchConcurrency: Math.max(1, Math.min(
      CLOAK_LAUNCH_CONCURRENCY_LIMIT,
      Number.parseInt(process.env.CLOAK_LAUNCH_CONCURRENCY || '', 10) || 5,
    )),
    profileCleanupConcurrency: Math.max(
      1,
      Math.min(32, Number.parseInt(process.env.CLOAK_PROFILE_CLEANUP_CONCURRENCY || '', 10) || 4),
    ),
    profileRoot,
    locale: 'en-US',
    timezone: 'America/New_York',
    humanize: true,
    humanPreset: 'careful',
  },
  sentinel: {
    enabled: true,
    sdkVersion: '20260219f9f6',
    timeoutMs: 60000,
    soTimeoutMs: 15000,
  },
});

exports.CLOAK_MIN_CONCURRENCY = CLOAK_MIN_CONCURRENCY;
exports.CLOAK_MAX_CONCURRENCY_LIMIT = CLOAK_MAX_CONCURRENCY_LIMIT;
exports.CLOAK_LAUNCH_CONCURRENCY_LIMIT = CLOAK_LAUNCH_CONCURRENCY_LIMIT;
exports.resolveCgroupV2Directory = resolveCgroupV2Directory;
exports.planCloakResourceConcurrency = planCloakResourceConcurrency;
exports.config = config;
