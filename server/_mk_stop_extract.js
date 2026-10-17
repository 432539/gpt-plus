'use strict';
process.env.GPT_PLUS_DB_PATH = process.env.GPT_PLUS_DB_PATH
  || 'C:\\Users\\Administrator\\Desktop\\gpt-plus\\server\\data\\app.prod-sync.db';
const jwt = require('jsonwebtoken');
const db = require('./src/db');
const config = require('./src/config');
const user = db.prepare('SELECT id, username, role FROM users WHERE id = 1').get();
const token = jwt.sign(
  { id: user.id, username: user.username, role: user.role },
  config.jwtSecret,
  { expiresIn: '10m' },
);
fetch('http://127.0.0.1:8595/api/accounts/operations/extract/stop', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ channel: 'gc' }),
}).then(async (res) => {
  const body = await res.json().catch(() => ({}));
  console.log('STOP', res.status, JSON.stringify({
    ok: body.ok,
    running: body.running,
    finished: body.finished,
  }));
}).catch((error) => {
  console.log('STOP_UNREACHABLE', String(error.message || error).slice(0, 120));
  process.exit(0);
});
