// mail.com 轮询 worker:按每个用户设置的分钟间隔,同步子号、
// 自动删除已使用子号、自动拉满。缺少 OAuth 密钥或无母号时静默跳过。
const db = require('../db');
const { readSettings } = require('./settings');
const mailcom = require('./mailcomService');
const opLog = require('./opLog');

const lastRun = new Map(); // userId -> epoch ms
const lastPollError = new Map(); // userId:motherId -> { at, msg }
const POLL_ERROR_DEBOUNCE_MS = 2 * 60 * 1000;
let running = false;

function logPollerFailure(userId, mother, error, proxyOn) {
  const msg = String(error?.message || error).slice(0, 160);
  const key = `${userId}:${mother.id}`;
  const now = Date.now();
  const prev = lastPollError.get(key);
  if (!proxyOn && prev && prev.msg === msg && now - prev.at < POLL_ERROR_DEBOUNCE_MS) return;
  lastPollError.set(key, { at: now, msg });
  opLog.pull(userId, proxyOn ? 'error' : 'warning', `轮询失败 ${mother.address || mother.id}：${msg}`, {
    source: 'poller',
    ref: mother.address || String(mother.id),
  });
}

async function runUser(userId, cfg) {
  const proxyOn = !mailcom.isMailcomProxyDisabled(cfg?.proxy_group);
  const mothers = db
    .prepare('SELECT id, address FROM emails WHERE user_id = ? AND is_mother = 1')
    .all(userId);
  for (const m of mothers) {
    try {
      await mailcom.runPollerMother(userId, m.id, cfg);
    } catch (e) {
      logPollerFailure(userId, m, e, proxyOn);
      if (process.env.MAILCOM_DEBUG) console.warn(`[mailcom-poll] user ${userId} mother ${m.id}:`, e.message);
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const users = db.prepare('SELECT id FROM users').all();
    const now = Date.now();
    for (const u of users) {
      const cfg = readSettings(u.id).mailcom;
      const minutes = Number(cfg.poll_minutes) || 0;
      if (minutes <= 0) continue;
      const due = now - (lastRun.get(u.id) || 0) >= minutes * 60 * 1000;
      if (!due) continue;
      lastRun.set(u.id, now);
      await runUser(u.id, cfg);
    }
  } finally {
    running = false;
  }
}

function startPoller() {
  setInterval(() => {
    tick().catch(() => {});
  }, 60 * 1000);
}

module.exports = { startPoller, _test: { runUser, logPollerFailure, lastPollError } };
