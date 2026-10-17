'use strict';

const fs = require('node:fs');
const os = require('node:os');

const DEFAULT_INTERVAL_MS = 5000;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(finiteNumber(value) * factor) / factor;
}

function cpuTotals(cpus = []) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    const times = cpu?.times || {};
    for (const value of Object.values(times)) total += finiteNumber(value);
    idle += finiteNumber(times.idle);
  }
  return { idle, total };
}

function cpuPercent(previous, current) {
  if (!previous || !current) return 0;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return 0;
  return round(Math.max(0, Math.min(100, ((total - idle) / total) * 100)));
}

function parseMeminfo(text = '') {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s*(kB)?/);
    if (!match) continue;
    values[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  const swapTotal = finiteNumber(values.SwapTotal);
  const swapFree = finiteNumber(values.SwapFree);
  return {
    available_bytes: Number.isFinite(values.MemAvailable) ? values.MemAvailable : null,
    swap_total_bytes: swapTotal,
    swap_free_bytes: swapFree,
    swap_used_bytes: Math.max(0, swapTotal - swapFree),
  };
}

function linuxMemory(fsModule = fs) {
  if (process.platform !== 'linux') {
    return {
      available_bytes: null,
      swap_total_bytes: null,
      swap_free_bytes: null,
      swap_used_bytes: null,
    };
  }
  try {
    return parseMeminfo(fsModule.readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return {
      available_bytes: null,
      swap_total_bytes: null,
      swap_free_bytes: null,
      swap_used_bytes: null,
    };
  }
}

function diskMetrics(fsModule = fs) {
  if (process.platform !== 'linux' || typeof fsModule.statfsSync !== 'function') return null;
  try {
    const stat = fsModule.statfsSync('/');
    const blockSize = finiteNumber(stat.bsize || stat.frsize);
    const total = finiteNumber(stat.blocks) * blockSize;
    const free = finiteNumber(stat.bavail ?? stat.bfree) * blockSize;
    if (total <= 0) return null;
    const used = Math.max(0, total - free);
    return {
      path: '/',
      total_bytes: total,
      used_bytes: used,
      free_bytes: free,
      used_percent: round((used / total) * 100),
    };
  } catch {
    return null;
  }
}

function createSampler({
  osModule = os,
  fsModule = fs,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => new Date(),
  autoStart = true,
} = {}) {
  let previousCpu = cpuTotals(osModule.cpus());
  let cached = null;
  let timer = null;

  function sample() {
    const cpus = osModule.cpus() || [];
    const currentCpu = cpuTotals(cpus);
    const totalBytes = Math.max(0, finiteNumber(osModule.totalmem()));
    const freeBytes = Math.max(0, finiteNumber(osModule.freemem()));
    const linux = linuxMemory(fsModule);
    const availableBytes = linux.available_bytes == null
      ? freeBytes
      : Math.max(0, Math.min(totalBytes, linux.available_bytes));
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    const load = (osModule.loadavg?.() || [0, 0, 0]).map((value) => round(value, 2));
    const memoryUsage = process.memoryUsage();

    cached = {
      sampled_at: now().toISOString(),
      platform: process.platform,
      cpu: {
        percent: cpuPercent(previousCpu, currentCpu),
        cores: cpus.length || finiteNumber(osModule.availableParallelism?.(), 1) || 1,
        load1: load[0] || 0,
        load5: load[1] || 0,
        load15: load[2] || 0,
      },
      memory: {
        total_bytes: totalBytes,
        used_bytes: usedBytes,
        free_bytes: freeBytes,
        available_bytes: availableBytes,
        used_percent: totalBytes > 0 ? round((usedBytes / totalBytes) * 100) : 0,
        swap_total_bytes: linux.swap_total_bytes,
        swap_used_bytes: linux.swap_used_bytes,
        swap_free_bytes: linux.swap_free_bytes,
      },
      uptime_seconds: Math.max(0, Math.floor(finiteNumber(osModule.uptime()))),
      process: {
        pid: process.pid,
        uptime_seconds: Math.max(0, Math.floor(process.uptime())),
        rss_bytes: finiteNumber(memoryUsage.rss),
        heap_used_bytes: finiteNumber(memoryUsage.heapUsed),
        heap_total_bytes: finiteNumber(memoryUsage.heapTotal),
        external_bytes: finiteNumber(memoryUsage.external),
      },
      disk: diskMetrics(fsModule),
    };
    previousCpu = currentCpu;
    return cached;
  }

  function start() {
    if (timer) return timer;
    sample();
    timer = setInterval(sample, Math.max(250, finiteNumber(intervalMs, DEFAULT_INTERVAL_MS)));
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function get() {
    if (!cached) sample();
    return cached;
  }

  if (autoStart) start();
  return { get, sample, start, stop };
}

const sampler = createSampler();

module.exports = {
  DEFAULT_INTERVAL_MS,
  getServerMetrics: sampler.get,
  createSampler,
  parseMeminfo,
  cpuTotals,
  cpuPercent,
  _sampler: sampler,
};
