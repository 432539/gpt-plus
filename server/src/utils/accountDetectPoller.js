// 账号验活轮询：用 access token 调 accounts/check，不启动 Cloak。
// 传输/代理失败不改状态。试用资格只在 has_trial 仍为空时写一次。
// 验活间隔由 accounts.detect_poll_minutes 控制（0 = 关闭验活）。
// 试用未检测（has_trial 为空，含空字符串）每 2 分钟单独探测一次，不受验活间隔关闭影响。
// 一律走设置里的 CliProxy 动态池（GB=region-GB），未配置则跳过本轮，不回退手工检测/支付组或直连。
const db = require('../db');
const { readSettings } = require('./settings');
const opLog = require('./opLog');
const { trialUnsetSql } = require('./accountCheck');
const {
  detectViaToken,
  status: accountJobStatus,
  DETECT_HTTP_CONCURRENCY,
} = require('./accountJob');
const { cliproxyConfigured, loadChannelProxies } = require('./channelProxy');

const REGISTER_DETECT_GRACE_HOURS = 12;
const TRIAL_UNSET_POLL_MS = 2 * 60 * 1000;
const SKIP_LOG_MS = 2 * 60 * 1000;
const lastLiveness = new Map();
const lastTrialUnset = new Map();
const lastSkipLog = new Map();
let running = false;
let timer = null;

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const n = Math.max(1, Math.min(Number(limit) || 1, queue.length || 1));
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  }));
}

function logSkip(userId, key, message) {
  const stamp = `${userId}:${key}`;
  const prev = lastSkipLog.get(stamp) || 0;
  if (Date.now() - prev < SKIP_LOG_MS) return;
  lastSkipLog.set(stamp, Date.now());
  opLog.account(userId, 'warning', message, { source: key.startsWith('trial') ? 'trial-backfill' : 'liveness' });
}

function selectTrialUnsetTargets(userId) {
  return db.prepare(
    `SELECT id FROM gpt_accounts
     WHERE user_id = ? AND ${trialUnsetSql()}
       AND access_token IS NOT NULL AND access_token != ''
       AND COALESCE(channel, 'gb') = 'gb'
     ORDER BY id`
  ).all(userId).map((row) => row.id);
}

function selectTargets(userId, trialOnly) {
  if (trialOnly) return selectTrialUnsetTargets(userId);
  const grace = `-${REGISTER_DETECT_GRACE_HOURS} hours`;
  return db.prepare(
    `SELECT id FROM gpt_accounts
     WHERE user_id = ? AND access_token IS NOT NULL AND access_token != ''
       AND datetime(created_at) <= datetime('now','localtime', ?)
       AND COALESCE(channel, 'gb') = 'gb'
     ORDER BY id`
  ).all(userId, grace).map((row) => row.id);
}

function pickTrialProxies(userId) {
  if (!cliproxyConfigured(userId)) {
    return { group: '', proxies: [], reason: 'dynamic_missing' };
  }
  try {
    return {
      group: '__auto__:GB',
      proxies: loadChannelProxies(userId, 'GB', DETECT_HTTP_CONCURRENCY, `detect-poller:${userId}`),
      reason: 'cliproxy',
    };
  } catch {
    return { group: '', proxies: [], reason: 'dynamic_missing' };
  }
}

async function runUser(userId, cfg, { trialOnly = false, fetchImpl, jobStatus } = {}) {
  const detectRunning = Boolean((jobStatus || accountJobStatus)(userId)?.running);
  if (!trialOnly && detectRunning) {
    logSkip(userId, 'liveness-manual-job', '账号验活跳过：检测任务正在运行');
    return { skipped: true, reason: 'manual_job' };
  }
  const ids = selectTargets(userId, trialOnly);
  if (!ids.length) return { skipped: false, target: 0, success: 0, failed: 0, transport: 0 };

  const picked = pickTrialProxies(userId);
  const proxies = picked.proxies;
  const proxyReason = picked.reason;
  if (!proxies.length) {
    logSkip(
      userId,
      trialOnly ? 'trial-no-dynamic' : 'liveness-no-dynamic',
      `${trialOnly ? '试用资格回填' : '账号验活'}失败：动态代理 CliProxy 未配置，不会回退手工检测组或直连`,
    );
    return { skipped: true, reason: 'dynamic_proxy_not_configured', proxyReason };
  }

  let cursor = 0;
  const nextProxy = () => (proxies.length ? proxies[(cursor++) % proxies.length] : null);
  let success = 0;
  let failed = 0;
  let transport = 0;
  let trialYes = 0;
  let trialNo = 0;
  await mapLimit(ids, DETECT_HTTP_CONCURRENCY, async (id) => {
    try {
      const result = await detectViaToken(userId, id, {
        proxy: nextProxy(),
        fetchImpl,
        trialOnly,
      });
      if (result?.transport || result?.skipped) {
        if (result.transport) transport += 1;
        else if (result?.reason && result.reason !== 'trial_known') {
          logSkip(userId, `trial-row-${result.reason}`, `试用资格回填跳过账号 ${id}：${result.reason}`);
        }
        return;
      }
      success += 1;
      if (result.has_trial === 1) trialYes += 1;
      if (result.has_trial === 0) trialNo += 1;
    } catch (error) {
      failed += 1;
      opLog.account(userId, 'error', `验活失败 ${id}：${String(error.message || error).slice(0, 160)}`, {
        source: trialOnly ? 'trial-backfill' : 'liveness',
      });
    }
  });
  const label = trialOnly ? '试用资格回填' : '账号验活';
  opLog.account(
    userId,
    failed ? 'warning' : 'info',
    `${label}完成：目标 ${ids.length}，成功 ${success}，传输跳过 ${transport}，失败 ${failed}`
      + (trialOnly ? `，是 ${trialYes}，否 ${trialNo}` : ''),
    { source: trialOnly ? 'trial-backfill' : 'liveness' },
  );
  return { skipped: false, target: ids.length, success, failed, transport, trialYes, trialNo, proxyReason };
}

function resetPollerState() {
  lastLiveness.clear();
  lastTrialUnset.clear();
  lastSkipLog.clear();
  running = false;
}

async function tick(deps = {}) {
  if (running) return;
  running = true;
  const summary = [];
  try {
    const users = db.prepare('SELECT id FROM users').all();
    const nowMs = deps.nowMs != null ? Number(deps.nowMs) : Date.now();
    for (const u of users) {
      const cfg = readSettings(u.id).accounts || {};
      const minutes = Number(cfg.detect_poll_minutes) || 0;
      const lastLive = lastLiveness.get(u.id);
      const lastTrial = lastTrialUnset.get(u.id);
      const dueLiveness = minutes > 0 && (lastLive == null || nowMs - lastLive >= minutes * 60 * 1000);
      const dueTrialUnset = lastTrial == null || nowMs - lastTrial >= TRIAL_UNSET_POLL_MS;
      const row = { userId: u.id, dueLiveness, dueTrialUnset, liveness: null, trial: null };
      if (dueLiveness) {
        lastLiveness.set(u.id, nowMs);
        row.liveness = await runUser(u.id, cfg, {
          trialOnly: false,
          fetchImpl: deps.fetchImpl,
          jobStatus: deps.jobStatus,
        });
      }
      if (dueTrialUnset) {
        lastTrialUnset.set(u.id, nowMs);
        row.trial = await runUser(u.id, cfg, {
          trialOnly: true,
          fetchImpl: deps.fetchImpl,
          jobStatus: deps.jobStatus,
        });
      }
      summary.push(row);
    }
    return summary;
  } finally {
    running = false;
  }
}

function startPoller() {
  if (timer) return timer;
  setTimeout(() => { tick().catch(() => {}); }, 2000);
  timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  startPoller, tick, runUser, mapLimit, selectTargets, selectTrialUnsetTargets,
  pickTrialProxies, resetPollerState, REGISTER_DETECT_GRACE_HOURS, TRIAL_UNSET_POLL_MS,
};
