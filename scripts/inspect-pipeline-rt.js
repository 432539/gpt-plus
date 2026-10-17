#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const HOST = require('./deploy-env').host;
const USER = 'root';
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const REMOTE_ROOT = process.env.DEPLOY_REMOTE_ROOT || '/opt/gpt-plus';

if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(2);
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`exit ${code}: ${stderr || stdout}`));
      });
      stream.on('data', (d) => { stdout += d; process.stdout.write(d); });
      stream.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    });
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    conn.connect({ host: HOST, port: 22, username: USER, password: PASSWORD });
  });
}

async function main() {
  const conn = await connect();
  try {
    await exec(conn, `cd ${REMOTE_ROOT}/server && node - <<'NODE'
const fs = require('fs');
const db = require('./src/db');
const { readSettings, cloakLicenseKeys } = require('./src/utils/settings');
const cloakSrc = fs.readFileSync('./src/automation/cloak.js', 'utf8');
const pipeSrc = fs.readFileSync('./src/utils/accountPipeline.js', 'utf8');
console.log('HAS_LICENSE_POOL=' + cloakSrc.includes('class LicensePool'));
console.log('HAS_CLOSE_CLOAK_HANDLES=' + cloakSrc.includes('function closeCloakHandles'));
console.log('HAS_WATCHDOG_RT=' + pipeSrc.includes("kind === 'acquire_rt'"));
console.log('HAS_NOTE_PAID_FOR_RT=' + pipeSrc.includes('function notePaidForRt'));
const users = db.prepare('SELECT id, username, status FROM users ORDER BY id').all();
console.log('USER_COUNT=' + users.length);
const picked = users.find((row) => String(row.username || '').toLowerCase() === 'admin') || users[0];
console.log('USER_ID=' + picked.id);
console.log('USER_NAME=' + picked.username);
for (const user of users) {
  const settings = readSettings(user.id);
  const keys = cloakLicenseKeys(settings.cloak || {});
  console.log('USER_PIPE ' + user.id + ' ' + user.username + ' ' + JSON.stringify({
    register: settings.pipeline?.register === true,
    extract: settings.pipeline?.extract === true,
    pay: settings.pipeline?.pay === true,
    acquire_rt: settings.pipeline?.acquire_rt === true,
    cloak_count: keys.length,
    cloak_configured: keys.length > 0,
  }));
}
const uid = picked.id;
const paid = db.prepare("SELECT COUNT(*) AS n FROM gpt_accounts WHERE user_id=?").get(uid).n;
const paidReady = db.prepare([
  "SELECT COUNT(*) AS n FROM gpt_accounts WHERE user_id=?",
  "AND (COALESCE(activated_at,'') != '' OR progress = '已支付')",
].join(' ')).get(uid).n;
const paidNoRt = db.prepare([
  "SELECT COUNT(*) AS n FROM gpt_accounts WHERE user_id=?",
  "AND (COALESCE(activated_at,'') != '' OR progress = '已支付')",
  "AND COALESCE(refresh_token,'') = ''",
  "AND COALESCE(remark,'') != '已拿RT'",
].join(' ')).get(uid).n;
const paidNoRtCreds = db.prepare([
  "SELECT COUNT(*) AS n FROM gpt_accounts WHERE user_id=?",
  "AND (COALESCE(activated_at,'') != '' OR progress = '已支付')",
  "AND COALESCE(refresh_token,'') = ''",
  "AND COALESCE(remark,'') != '已拿RT'",
  "AND COALESCE(password_enc,'') != ''",
  "AND COALESCE(totp_secret_enc,'') != ''",
].join(' ')).get(uid).n;
const paidNoRtCapped = db.prepare([
  "SELECT COUNT(*) AS n FROM gpt_accounts WHERE user_id=?",
  "AND (COALESCE(activated_at,'') != '' OR progress = '已支付')",
  "AND COALESCE(refresh_token,'') = ''",
  "AND COALESCE(rt_attempts,0) >= 5",
].join(' ')).get(uid).n;
console.log('ACCOUNTS=' + paid);
console.log('PAID_OR_ACTIVATED=' + paidReady);
console.log('PAID_NO_RT=' + paidNoRt);
console.log('PAID_NO_RT_WITH_CREDS=' + paidNoRtCreds);
console.log('PAID_NO_RT_CAPPED=' + paidNoRtCapped);
const batches = db.prepare([
  "SELECT kind, status, total, queued, substr(message,1,80) AS message, created_at",
  "FROM registration_batches WHERE user_id=? ORDER BY created_at DESC LIMIT 12",
].join(' ')).all(uid);
console.log('BATCHES=' + JSON.stringify(batches));
const runningRt = db.prepare(
  "SELECT COUNT(*) AS n FROM registration_batches WHERE user_id=? AND kind='account-rt' AND status='running'"
).get(uid).n;
console.log('RUNNING_ACCOUNT_RT_BATCHES=' + runningRt);
const logs = db.prepare([
  "SELECT created_at, category, level, substr(message,1,180) AS message",
  "FROM operation_logs WHERE user_id=?",
  "AND (message LIKE '%看门狗%' OR message LIKE '%拿 RT%' OR message LIKE '%拿RT%'",
  "OR message LIKE '%ACCOUNT_RT%' OR message LIKE '%协议拿%' OR category='refresh')",
  "ORDER BY id DESC LIMIT 25",
].join(' ')).all(uid);
console.log('LOGS=' + JSON.stringify(logs));
db.close();
NODE`);
    await exec(conn, 'systemctl is-active gpt-plus; curl -sS -o /dev/null -w LOCAL_HTTP=%{http_code}\\n --max-time 10 http://127.0.0.1:8585/ || true');
  } finally {
    conn.end();
  }
}

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 400));
  process.exit(1);
});
