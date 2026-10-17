const db = require('/opt/gpt-plus/server/src/db');
const runId = process.argv[2] || 'acb78a2a-9298-4697-990d-8ca463794ad9';
const redact = (value) => String(value || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => m.replace(/^(.{3}).*(@.*)$/, '$1***$2'));
const run = db.prepare('SELECT run_id, running, success, failed, target, message, started_at FROM registration_runs WHERE run_id=?').get(runId);
const jobs = db.prepare('SELECT email, status, progress, error_code, substr(error,1,160) AS error FROM registration_jobs WHERE batch_id=? ORDER BY rowid').all(runId);
const logs = db.prepare("SELECT created_at, substr(message,1,240) AS message FROM operation_logs WHERE category='register' AND run_id=? ORDER BY id").all(runId);
const interesting = logs.filter((row) => /步骤|输入邮箱|密码|验证码|资料|TOTP|2FA|未收到|已标记|跳过|email-verification|尚未进入|无头模拟|注册选项|页面注册|成功|失败|partial/.test(row.message));
console.log(JSON.stringify({
  run: run ? { ...run, message: redact(run.message) } : null,
  jobs: jobs.map((row) => ({ ...row, email: redact(row.email), error: redact(row.error) })),
  interesting: interesting.map((row) => ({ ...row, message: redact(row.message) })),
}, null, 2));
