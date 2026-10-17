const express = require('express');
const db = require('../db');
const { getPlanContext } = require('../utils/plan');
const { getDashboardStats, getDashboardLive } = require('../utils/dashboardStats');
const { getServerMetrics } = require('../utils/serverMetrics');

const router = express.Router();

function isAdmin(user) {
  return user?.role === 'admin';
}

function buildSummary(user) {
  const uid = user.id;
  const ctx = getPlanContext(user);

  const accountCount = db.prepare('SELECT COUNT(*) AS c FROM gpt_accounts WHERE user_id = ?').get(uid).c;
  const emailCount = db.prepare('SELECT COUNT(*) AS c FROM emails WHERE user_id = ?').get(uid).c;
  // 30 天内即将过期的 GPT 账号
  const expiringSoon = db
    .prepare(
      `SELECT id, email, plan_type, expires_at FROM gpt_accounts
       WHERE user_id = ? AND expires_at IS NOT NULL AND expires_at != ''
         AND date(expires_at) <= date('now', '+30 days')
       ORDER BY expires_at ASC LIMIT 10`
    )
    .all(uid);

  const data = {
    role: user.role,
    username: user.username,
    level: user.level,
    accountCount,
    emailCount,
    maxAccounts: ctx.unlimited ? -1 : ctx.maxAccounts,
    maxEmails: ctx.unlimited ? -1 : ctx.maxEmails,
    plan: ctx.plan ? { name: ctx.plan.name, level: ctx.plan.level } : null,
    planExpiresAt: user.plan_expires_at,
    planExpired: ctx.expired,
    expiringSoon,
  };

  if (isAdmin(user)) {
    data.site = {
      totalUsers: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      activeUsers: db.prepare('SELECT COUNT(*) AS c FROM users WHERE status = 1').get().c,
      totalAccounts: db.prepare('SELECT COUNT(*) AS c FROM gpt_accounts').get().c,
      totalEmails: db.prepare('SELECT COUNT(*) AS c FROM emails').get().c,
      totalPlans: db.prepare('SELECT COUNT(*) AS c FROM plans').get().c,
      recentUsers: db
        .prepare('SELECT id, username, role, level, status, created_at FROM users ORDER BY id DESC LIMIT 5')
        .all(),
    };
  }
  Object.assign(data, getDashboardStats(uid, { allUsers: isAdmin(user) }));
  return data;
}

function buildLive(user) {
  const data = getDashboardLive(user.id, { allUsers: isAdmin(user) });
  if (isAdmin(user)) {
    data.server = {
      status: 'ok',
      service: 'GPT-Plus',
      ...getServerMetrics(),
    };
  }
  return data;
}

function summaryHandler(req, res) {
  res.json(buildSummary(req.user));
}

function liveHandler(req, res) {
  res.json(buildLive(req.user));
}

router.get('/summary', summaryHandler);
router.get('/live', liveHandler);
router.get('/', summaryHandler);

module.exports = router;
module.exports._test = {
  isAdmin,
  buildSummary,
  buildLive,
  summaryHandler,
  liveHandler,
};
