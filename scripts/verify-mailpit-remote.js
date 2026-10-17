#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const { host, mailHost } = require('./deploy-env');
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const MAIL = mailHost();
if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(1);
}

const remote = `
set -e
echo AUTH_NONE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8025/api/v1/info || true)
PASS=$(tr -d '\\n' < /opt/mailpit/ui.password)
echo AUTH_OK=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -u "admin:\${PASS}" http://127.0.0.1:8025/api/v1/info || true)
echo PUBLIC_8025=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://${host}:8025/api/v1/info || echo down)
echo NGINX_MAIL=$(nginx -T 2>/dev/null | grep -c 'server_name ${MAIL}' || true)
echo DIG=$(dig +short A ${MAIL} @8.8.8.8 || true)
ls -l /opt/mailpit/data
cat /opt/mailpit/recipients.env
ss -lntp | grep -E ':(25|8025) ' || true
cd /opt/gpt-plus/server
node - <<'NODE'
const Database = require('better-sqlite3');
const config = require('./src/config');
const db = new Database(config.dbPath, { readonly: true });
console.log('ACTIVE_REG=' + db.prepare('SELECT COUNT(*) AS n FROM registration_runs WHERE running = 1').get().n);
db.close();
NODE
`;

const conn = new Client();
conn.on('ready', () => {
  conn.exec(remote, (err, stream) => {
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
}).connect({ host, port: 22, username: 'root', password: PASSWORD });
