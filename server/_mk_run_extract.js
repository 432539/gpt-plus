'use strict';

/**
 * Local-only: trigger MK GCash extract for the three reboud accounts via 8595.
 * Does not print AT / proxy passwords / full emails.
 */

process.env.GPT_PLUS_DB_PATH = process.env.GPT_PLUS_DB_PATH
  || 'C:\\Users\\Administrator\\Desktop\\gpt-plus\\server\\data\\app.prod-sync.db';
process.env.MK_GCASH = process.env.MK_GCASH || '1';

const jwt = require('jsonwebtoken');
const db = require('./src/db');
const config = require('./src/config');
const { toDetail } = require('./src/utils/accountFields');

const BASE = process.env.MK_EXTRACT_BASE || 'http://127.0.0.1:8595';
const PREFIXES = ['otp412e1', 'otpa7969', 'otp93b32'];

function prefixOf(email) {
  return String(email || '').slice(0, 8);
}

function atMeta(token) {
  try {
    const part = String(token || '').split('.')[1] || '';
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    const exp = Number(payload.exp);
    const now = Math.floor(Date.now() / 1000);
    return {
      has_at: Boolean(token),
      at_len: token ? String(token).length : 0,
      exp_in_s: Number.isFinite(exp) ? exp - now : null,
      expired: Number.isFinite(exp) ? exp <= now : null,
    };
  } catch {
    return { has_at: Boolean(token), at_len: token ? String(token).length : 0, exp_in_s: null, expired: null };
  }
}

async function main() {
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = 1').get();
  if (!user) throw new Error('user 1 missing');
  const accounts = PREFIXES.map((prefix) => {
    const row = db.prepare('SELECT * FROM gpt_accounts WHERE email LIKE ? LIMIT 1').get(`${prefix}%`);
    if (!row) throw new Error(`missing ${prefix}`);
    const detail = toDetail(row);
    return {
      id: row.id,
      prefix: prefixOf(detail.email),
      progress: row.progress,
      plan_type: row.plan_type,
      rebind_status: row.rebind_status,
      at: atMeta(detail.access_token),
    };
  });
  console.log('ACCOUNTS', JSON.stringify(accounts));
  if (accounts.some((item) => !item.at.has_at || item.at.expired)) {
    throw new Error('AT missing or expired; will not start extract');
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: '2h' },
  );
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const stopRes = await fetch(`${BASE}/api/accounts/operations/extract/stop`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ channel: 'gc' }),
  });
  console.log('STOP', stopRes.status);

  const startRes = await fetch(`${BASE}/api/accounts/operations/extract`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ids: accounts.map((item) => item.id),
      channel: 'gc',
      concurrency: 1,
    }),
  });
  const startBody = await startRes.json().catch(() => ({}));
  console.log('START', startRes.status, JSON.stringify({
    ok: startBody.ok,
    message: startBody.message,
    target: startBody.target,
    run_id: startBody.run_id,
    enqueued: startBody.enqueued,
  }));
  if (!startRes.ok) process.exit(2);

  const deadline = Date.now() + 18 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const statusRes = await fetch(`${BASE}/api/accounts/operations/extract/status?channel=gc`, { headers });
    const status = await statusRes.json().catch(() => ({}));
    const snap = JSON.stringify({
      running: status.running,
      finished: status.finished,
      success: status.success,
      failed: status.failed,
      target: status.target,
      message: String(status.message || '').slice(0, 180),
    });
    if (snap !== last) {
      last = snap;
      console.log('STATUS', snap);
    }
    if (status.running === false && status.finished) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const latest = db.prepare(`
    SELECT substr(message,1,8) AS prefix_hint, level, substr(message,1,220) AS msg, created_at
    FROM operation_logs
    WHERE (message LIKE 'otp412e1%' OR message LIKE 'otpa7969%' OR message LIKE 'otp93b32%')
    ORDER BY id DESC
    LIMIT 30
  `).all();
  console.log('LATEST_LOGS', JSON.stringify(latest, null, 2));

  for (const prefix of PREFIXES) {
    const row = db.prepare(`
      SELECT substr(email,1,8) AS prefix, progress, plan_type,
             CASE WHEN gcash_link IS NULL OR gcash_link='' THEN 0 ELSE 1 END AS has_link,
             CASE WHEN gcash_qr IS NULL OR gcash_qr='' THEN 0 ELSE 1 END AS has_qr,
             CASE WHEN gcash_cs_id IS NULL OR gcash_cs_id='' THEN 0 ELSE 1 END AS has_cs
      FROM gpt_accounts WHERE email LIKE ? LIMIT 1
    `).get(`${prefix}%`);
    const err = db.prepare(`
      SELECT level, substr(message,1,240) AS msg, created_at
      FROM operation_logs
      WHERE message LIKE ? AND level IN ('error','success','warning')
      ORDER BY id DESC LIMIT 3
    `).all(`${prefix}%`);
    console.log('RESULT', JSON.stringify({ row, events: err }));
  }
}

main().catch((error) => {
  console.error('RUN_FAILED', String(error && error.message ? error.message : error).slice(0, 240));
  process.exit(1);
});
