const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { getPlanContext } = require('../utils/plan');

const router = express.Router();

router.get('/', (req, res) => {
  const ctx = getPlanContext(req.user);
  const row = db
    .prepare('SELECT id, username, role, level, plan_id, plan_expires_at, created_at FROM users WHERE id = ?')
    .get(req.user.id);
  res.json({
    ...row,
    plan: ctx.plan
      ? {
          name: ctx.plan.name,
          level: ctx.plan.level,
          max_accounts: ctx.plan.max_accounts,
          max_emails: ctx.plan.max_emails,
        }
      : null,
    planExpired: ctx.expired,
  });
});

router.put('/password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ message: '请填写原密码和新密码' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: '新密码长度至少 6 位' });
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(oldPassword), user.password_hash)) {
    return res.status(400).json({ message: '原密码错误' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    bcrypt.hashSync(String(newPassword), 10),
    req.user.id
  );
  res.json({ ok: true });
});

module.exports = router;
