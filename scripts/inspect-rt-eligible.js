#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
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

async function main() {
  const conn = await new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({ host: require('./deploy-env').host, port: 22, username: 'root', password: PASSWORD });
  });
  try {
    await exec(conn, `cd /opt/gpt-plus/server && node - <<'NODE'
const db = require('./src/db');
const { readSettings } = require('./src/utils/settings');
const { canAcquireRt, selectRtIds } = require('./src/utils/accountPipeline');
const { pipelineCaps } = require('./src/utils/pipelineCaps');
const { isPaidReadyForRt, shouldSkipRt } = require('./src/utils/pipelineState');
const user = db.prepare("SELECT id FROM users WHERE username='admin'").get();
const settings = readSettings(user.id);
const caps = pipelineCaps(settings);
console.log('RT_ATTEMPTS_CAP=' + caps.rt_attempts);
console.log('EXTRACT_ATTEMPTS=' + caps.extract_attempts);
console.log('PAY_ATTEMPTS=' + caps.pay_attempts);
const rows = db.prepare("SELECT * FROM gpt_accounts WHERE user_id=?").all(user.id);
const nowMs = Date.now();
const picked = selectRtIds(rows, nowMs, [], caps);
console.log('SELECT_RT_IDS=' + picked.length);
console.log('SELECT_RT_ID_LIST=' + picked.join(','));
const unpaidExtracted = rows.filter((row) => String(row.progress || '').includes('提链') && !String(row.activated_at || '').trim()).length;
console.log('UNPAID_EXTRACTED=' + unpaidExtracted);
const candidates = rows.filter((row) => String(row.activated_at || '').trim() || row.progress === '已支付');
const summary = candidates.map((row) => {
  const hasRt = Boolean(String(row.refresh_token || '').trim()) || String(row.remark || '').trim() === '已拿RT';
  return {
    id: row.id,
    progress: row.progress,
    plan: row.plan_type,
    has_rt: hasRt,
    rt_attempts: Number(row.rt_attempts) || 0,
    has_password: Boolean(String(row.password_enc || '').trim()),
    has_totp: Boolean(String(row.totp_secret_enc || '').trim()),
    activated: Boolean(String(row.activated_at || '').trim()),
    ready: isPaidReadyForRt(row, nowMs, caps),
    skip_rt: shouldSkipRt(row, caps),
    can: canAcquireRt(row, nowMs, caps),
  };
});
console.log('PAID_SUMMARY=' + JSON.stringify(summary));
const jobs = db.prepare([
  "SELECT j.status, j.error_code, substr(j.error,1,120) AS error, j.finished_at, j.account_id",
  "FROM registration_jobs j JOIN registration_batches b ON b.batch_id=j.batch_id",
  "WHERE b.user_id=? AND j.kind='account-rt' ORDER BY j.updated_at DESC LIMIT 20",
].join(' ')).all(user.id);
console.log('RT_JOBS=' + JSON.stringify(jobs));
const starts = db.prepare([
  "SELECT created_at, category, substr(message,1,160) AS message FROM operation_logs",
  "WHERE user_id=? AND (message LIKE '%流水线协议拿 RT%' OR message LIKE '%流水线拿 RT%' OR message LIKE '%未启动%' OR message LIKE '%看门狗：拿RT%')",
  "ORDER BY id DESC LIMIT 15",
].join(' ')).all(user.id);
console.log('RT_START_LOGS=' + JSON.stringify(starts));
const extractLive = db.prepare(
  "SELECT COUNT(*) AS n FROM registration_batches WHERE user_id=? AND kind IN ('extract','oauth') AND status='running'"
).get(user.id).n;
console.log('RUNNING_EXTRACT_BATCHES=' + extractLive);
db.close();
NODE`);
  } finally {
    conn.end();
  }
}

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 400));
  process.exit(1);
});
