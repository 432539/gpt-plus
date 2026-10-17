const db = require('./src/db');

function redactEmail(value) {
  return String(value || '').replace(/^(.{3}).*(@.*)$/, '$1***$2');
}

const batchId = '2a54f8a7-070c-42ae-bb6a-0dccdae36ff4';
const cols = db.prepare('PRAGMA table_info(registration_jobs)').all().map((row) => row.name);
console.log('JOB_COLS=' + cols.join(','));

const jobs = db.prepare(
  `SELECT job_id, email, status, progress, error_code, substr(error,1,180) AS error, started_at, finished_at, batch_id
   FROM registration_jobs WHERE batch_id = ? ORDER BY rowid`
).all(batchId);
console.log(JSON.stringify({
  jobs: jobs.map((row) => ({ ...row, email: redactEmail(row.email) })),
}, null, 2));

const logs = db.prepare(
  `SELECT created_at, level, substr(message,1,240) AS message
   FROM operation_logs WHERE category='register' AND run_id=? ORDER BY id`
).all(batchId);
console.log('BATCH_LOG_COUNT=' + logs.length);
const step = logs.filter((row) => /输入邮箱|密码|验证码|资料|about|email-verification|等待 mail|无头模拟|步骤/.test(row.message));
console.log(JSON.stringify({ recent: logs.slice(-40), steps: step.slice(-40) }, null, 2));
