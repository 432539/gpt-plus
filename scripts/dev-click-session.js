'use strict';

const http = require('http');
const path = require('path');
const serverRoot = path.join(__dirname, '..', 'server');
module.paths.unshift(path.join(serverRoot, 'node_modules'));
const jwt = require('jsonwebtoken');
const config = require('../server/src/config');
const db = require('../server/src/db');
const { encrypt } = require('../server/src/utils/crypto');
const { markGcashExtracted } = require('../server/src/utils/accountProgress');

const user = db.prepare("SELECT id, username, role, level FROM users WHERE username = 'admin'").get()
  || db.prepare('SELECT id, username, role, level FROM users ORDER BY id LIMIT 1').get();

if (!user) {
  console.error('NO_USER');
  process.exit(1);
}

const email = 'gc-click-fixture@example.invalid';
const existing = db.prepare('SELECT id FROM gpt_accounts WHERE user_id = ? AND email = ?').get(user.id, email);
let id = existing && existing.id;
if (!id) {
  id = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress, channel, has_trial, monitor_pool, access_token)
     VALUES (?, ?, 'Free', 'gmail', '正常', '已提链', 'gc', 1, 0, ?)`
  ).run(user.id, email, encrypt('fixture-click-at')).lastInsertRowid;
}

markGcashExtracted(user.id, id, {
  gcash_link: 'https://example.invalid/gcash-fixture',
  gcash_qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FAAhKDveksOjrAAAAAElFTkSuQmCC',
  gcash_cs_id: '',
});

const token = jwt.sign(
  { id: user.id, username: user.username, role: user.role },
  config.jwtSecret,
  { expiresIn: '2h' }
);
const payload = JSON.stringify({
  token,
  user: { id: user.id, username: user.username, role: user.role, level: user.level },
});

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/session') {
    res.setHeader('Content-Type', 'application/json');
    res.end(payload);
    return;
  }
  res.statusCode = 404;
  res.end('missing');
});

server.listen(18765, '127.0.0.1', () => {
  console.log(`SESSION_READY user=${user.username} fixture=${id}`);
});
