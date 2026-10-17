const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { utcStamp } = require('../utils/datetime');

const router = express.Router();

// ---------- 用户管理 ----------

router.get('/users', (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 10));
  const whereSql = keyword ? 'WHERE u.username LIKE ?' : '';
  const params = keyword ? [`%${keyword}%`] : [];
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM users u ${whereSql}`)
    .get(...params).c;
  const sql = `
    SELECT u.id, u.username, u.role, u.level, u.plan_id, u.plan_expires_at, u.status, u.created_at,
           p.name AS plan_name,
           (SELECT COUNT(*) FROM gpt_accounts a WHERE a.user_id = u.id) AS account_count,
           (SELECT COUNT(*) FROM emails e WHERE e.user_id = u.id) AS email_count
    FROM users u LEFT JOIN plans p ON p.id = u.plan_id
    ${whereSql}
    ORDER BY u.id DESC
    LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ items: rows, total, page, page_size: pageSize });
});

// 根据套餐计算到期时间
function planExpiry(planId) {
  if (!planId) return null;
  const plan = db.prepare('SELECT duration_days FROM plans WHERE id = ?').get(planId);
  if (!plan) return null;
  const d = new Date();
  d.setDate(d.getDate() + plan.duration_days);
  return utcStamp(d.getTime());
}

router.post('/users', (req, res) => {
  const { username, password, role, level, plan_id } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: '用户名和密码不能为空' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: '密码长度至少 6 位' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
  if (exists) return res.status(400).json({ message: '用户名已存在' });

  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, role, level, plan_id, plan_expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(username).trim(),
      bcrypt.hashSync(String(password), 10),
      role === 'admin' ? 'admin' : 'user',
      Number(level) || 1,
      plan_id || null,
      planExpiry(plan_id)
    );
  res.json({ id: info.lastInsertRowid });
});

router.put('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ message: '用户不存在' });

  const { role, level, plan_id, plan_expires_at, status } = req.body || {};

  // 防止管理员把自己禁用或降级导致失联
  if (target.id === req.user.id && ((status !== undefined && Number(status) !== 1) || (role && role !== 'admin'))) {
    return res.status(400).json({ message: '不能禁用或降级当前登录的管理员账号' });
  }

  // 换了套餐则重新计算到期时间;也允许手动指定到期时间
  let expiresAt = target.plan_expires_at;
  const newPlanId = plan_id !== undefined ? plan_id || null : target.plan_id;
  if (plan_id !== undefined && plan_id !== target.plan_id) {
    expiresAt = planExpiry(plan_id);
  }
  if (plan_expires_at !== undefined) {
    expiresAt = plan_expires_at || null;
  }

  db.prepare(
    'UPDATE users SET role = ?, level = ?, plan_id = ?, plan_expires_at = ?, status = ? WHERE id = ?'
  ).run(
    role === 'admin' ? 'admin' : role === 'user' ? 'user' : target.role,
    level !== undefined ? Number(level) : target.level,
    newPlanId,
    expiresAt,
    status !== undefined ? (Number(status) === 1 ? 1 : 0) : target.status,
    target.id
  );
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ message: '新密码长度至少 6 位' });
  }
  const info = db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(String(password), 10), req.params.id);
  if (info.changes === 0) return res.status(404).json({ message: '用户不存在' });
  res.json({ ok: true });
});

router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ message: '不能删除当前登录的账号' });
  }
  // 外键 ON DELETE CASCADE 会自动清理该用户的账号与邮箱数据
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ message: '用户不存在' });
  res.json({ ok: true });
});

// ---------- 套餐配置 ----------

router.get('/plans', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.page_size, 10) || 10));
  const total = db.prepare('SELECT COUNT(*) AS c FROM plans').get().c;
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM users u WHERE u.plan_id = p.id) AS user_count
       FROM plans p ORDER BY p.level ASC, p.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(pageSize, (page - 1) * pageSize);
  res.json({ items: rows, total, page, page_size: pageSize });
});

router.post('/plans', (req, res) => {
  const { name, level, max_accounts, max_emails, duration_days, remark } = req.body || {};
  if (!name) return res.status(400).json({ message: '套餐名称不能为空' });
  const info = db
    .prepare(
      'INSERT INTO plans (name, level, max_accounts, max_emails, duration_days, remark) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(name).trim(),
      Number(level) || 1,
      Number(max_accounts) || 5,
      Number(max_emails) || 5,
      Number(duration_days) || 30,
      remark || ''
    );
  res.json({ id: info.lastInsertRowid });
});

router.put('/plans/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ message: '套餐不存在' });

  const { name, level, max_accounts, max_emails, duration_days, remark } = req.body || {};
  db.prepare(
    'UPDATE plans SET name = ?, level = ?, max_accounts = ?, max_emails = ?, duration_days = ?, remark = ? WHERE id = ?'
  ).run(
    name !== undefined ? String(name).trim() : existing.name,
    level !== undefined ? Number(level) : existing.level,
    max_accounts !== undefined ? Number(max_accounts) : existing.max_accounts,
    max_emails !== undefined ? Number(max_emails) : existing.max_emails,
    duration_days !== undefined ? Number(duration_days) : existing.duration_days,
    remark ?? existing.remark,
    existing.id
  );
  res.json({ ok: true });
});

router.delete('/plans/:id', (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM users WHERE plan_id = ?').get(req.params.id).c;
  if (inUse > 0) {
    return res.status(400).json({ message: `仍有 ${inUse} 个用户使用该套餐,无法删除` });
  }
  const info = db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ message: '套餐不存在' });
  res.json({ ok: true });
});

module.exports = router;
