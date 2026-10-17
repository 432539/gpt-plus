#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(1);
}
const conn = new Client();
const cmd = `
set -e
echo '=== SERVICE ==='
systemctl is-active gpt-plus || true
journalctl -u gpt-plus -n 5 --no-pager 2>/dev/null | sed 's/[^[:print:]\\t]/?/g' | tail -8
echo '=== DB REGISTER LOGS ==='
cd /opt/gpt-plus/server
node <<'NODE'
const db = require('./src/db');
const runs = db.prepare(\`
  SELECT run_id, target, success, failed, retried, running, finished, message, started_at, finished_at
  FROM registration_runs
  ORDER BY started_at DESC LIMIT 8
\`).all();
console.log('RUNS=' + JSON.stringify(runs, null, 2));
const jobs = db.prepare(\`
  SELECT job_id, email, status, progress, error_code, substr(error,1,160) AS error, started_at, finished_at
  FROM registration_jobs
  WHERE started_at >= datetime('now','-1 day') OR created_at >= datetime('now','-1 day')
  ORDER BY rowid DESC LIMIT 20
\`).all();
console.log('JOBS=' + JSON.stringify(jobs.map((row) => ({
  ...row,
  email: String(row.email || '').replace(/^(.{3}).*(@.*)$/, '$1***$2'),
})), null, 2));
const logs = db.prepare(\`
  SELECT created_at, level, substr(ref,1,3) || '***' AS ref, substr(message,1,220) AS message
  FROM operation_logs
  WHERE category='register' AND created_at >= datetime('now','-1 day')
  ORDER BY id DESC LIMIT 80
\`).all();
console.log('LOGS=' + JSON.stringify(logs, null, 2));
const unused = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE is_mother=0 AND mother_id IS NOT NULL AND mother_id != 0 AND status='未使用'").get();
const used = db.prepare("SELECT COUNT(*) AS n FROM emails WHERE is_mother=0 AND status='已使用'").get();
console.log('UNUSED_CHILDREN=' + unused.n);
console.log('USED_CHILDREN=' + used.n);
const active = db.prepare('SELECT COUNT(*) AS n FROM registration_runs WHERE running=1').get();
console.log('ACTIVE_REGISTRATION=' + active.n);
NODE
`;
conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error(err.message);
      conn.end();
      process.exit(1);
    }
    stream.on('close', (code) => {
      conn.end();
      process.exit(code || 0);
    }).on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stderr.write(d));
  });
}).on('error', (err) => {
  console.error(err.message);
  process.exit(1);
}).connect({ host: require('./deploy-env').host, port: 22, username: 'root', password: PASSWORD });
