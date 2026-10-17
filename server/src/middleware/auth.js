const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

const getUserStmt = () =>
  db.prepare('SELECT id, username, role, level, plan_id, plan_expires_at, status FROM users WHERE id = ?');

// JWT 认证:校验 token 并从数据库读取最新用户状态(保证禁用/降权即时生效)
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: '未登录' });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ message: '登录已过期,请重新登录' });
  }

  const user = getUserStmt().get(payload.id);
  if (!user) return res.status(401).json({ message: '用户不存在' });
  if (user.status !== 1) return res.status(403).json({ message: '账号已被禁用' });

  req.user = user;
  next();
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: '需要管理员权限' });
  }
  next();
}

module.exports = { authRequired, adminRequired };
