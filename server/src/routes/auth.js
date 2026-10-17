const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// 登录限流:同一 IP 每 10 分钟最多 20 次尝试,防爆破
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '尝试次数过多,请 10 分钟后再试' },
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: '请输入用户名和密码' });
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username).trim());

  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ message: '用户名或密码错误' });
  }
  if (user.status !== 1) {
    return res.status(403).json({ message: '账号已被禁用,请联系管理员' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      level: user.level,
    },
  });
});

module.exports = router;
