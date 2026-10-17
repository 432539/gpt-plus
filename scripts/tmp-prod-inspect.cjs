const db = require('/opt/gpt-plus/server/src/db');
const redact = (value) => String(value || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => m.replace(/^(.{3}).*(@.*)$/, '$1***$2'));
const unused = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE is_mother = 0 AND mother_id IS NOT NULL AND mother_id != 0 AND status = '未使用'").get();
const byStatus = db.prepare("SELECT COALESCE(status,'') AS status, is_mother, COUNT(*) AS n FROM emails GROUP BY COALESCE(status,''), is_mother").all();
const runs = db.prepare('SELECT run_id, started_at, running, success, failed, target, finished FROM registration_runs ORDER BY started_at DESC LIMIT 6').all();
console.log(JSON.stringify({ unused, byStatus, runs }, null, 2));
for (const run of runs.slice(0, 3)) {
  const batch = db.prepare('SELECT batch_id FROM registration_batches WHERE run_id=? OR batch_id=?').get(run.run_id, run.run_id);
  const batchId = batch?.batch_id || run.run_id;
  const jobs = db.prepare('SELECT email, status, progress, error_code, substr(error,1,140) AS error FROM registration_jobs WHERE batch_id=? ORDER BY rowid').all(batchId);
  const logs = db.prepare("SELECT created_at, substr(message,1,220) AS message FROM operation_logs WHERE category='register' AND run_id=? ORDER BY id").all(run.run_id);
  const interesting = logs.filter((row) => /步骤|输入邮箱|密码|验证码|资料|TOTP|2FA|未收到|已标记|跳过|email-verification|尚未进入|无头模拟|注册选项|页面注册/.test(row.message));
  console.log(JSON.stringify({
    run_id: run.run_id,
    jobs: jobs.map((row) => ({ ...row, email: redact(row.email), error: redact(row.error) })),
    interesting: interesting.map((row) => ({ ...row, message: redact(row.message) })),
  }, null, 2));
}
