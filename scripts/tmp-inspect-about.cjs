const db = require('/opt/gpt-plus/server/src/db');
const redact = (value) => String(value || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => m.replace(/^(.{3}).*(@.*)$/, '$1***$2'));
const unused = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE is_mother = 0 AND mother_id IS NOT NULL AND mother_id != 0 AND status = '未使用'").get();
const running = db.prepare('SELECT run_id, running FROM registration_runs WHERE running=1').get();
const runs = db.prepare('SELECT run_id, started_at, running, success, failed, target, substr(message,1,160) AS message FROM registration_runs ORDER BY started_at DESC LIMIT 5').all();
console.log(JSON.stringify({ unused, running: running || null, runs: runs.map((row) => ({ ...row, message: redact(row.message) })) }, null, 2));
for (const run of runs.slice(0, 3)) {
  const jobs = db.prepare('SELECT email, status, progress, error_code, substr(error,1,180) AS error FROM registration_jobs WHERE batch_id=? ORDER BY rowid').all(run.run_id);
  const logs = db.prepare("SELECT created_at, substr(message,1,240) AS message FROM operation_logs WHERE category='register' AND run_id=? ORDER BY id").all(run.run_id);
  const interesting = logs.filter((row) => /步骤|密码|验证码|资料|TOTP|2FA|about-you|evaluate|校验|Continue|设置密码|成功|失败/.test(row.message));
  console.log(JSON.stringify({
    run_id: run.run_id,
    jobs: jobs.map((row) => ({ ...row, email: redact(row.email), error: redact(row.error) })),
    interesting: interesting.map((row) => ({ ...row, message: redact(row.message) })),
  }, null, 2));
}
