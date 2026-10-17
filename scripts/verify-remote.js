const { Client } = require('../server/node_modules/ssh2');
const conn = new Client();
conn.on('ready', () => {
  conn.exec([
    'systemctl is-active gpt-plus',
    'curl -s -o /dev/null -w "local:%{http_code}\\n" http://127.0.0.1:8585/',
    `curl -sI -o /dev/null -w "site:%{http_code}\\n" --max-time 20 ${JSON.stringify(require('./deploy-env').publicUrl || 'http://127.0.0.1:8585/')} || true`,
    `cd /opt/gpt-plus/server && node -e "const fs=require('fs');const db=require('./src/db');const cloak=require('./node_modules/cloakbrowser/package.json');const register=fs.readFileSync('./src/utils/registerJob.js','utf8');const progress=fs.readFileSync('./src/utils/accountProgress.js','utf8');const active=db.prepare('SELECT COUNT(*) AS n FROM registration_runs WHERE running = 1').get().n;const accounts=db.prepare('SELECT COUNT(*) AS n FROM gpt_accounts').get().n;console.log('cloak:'+cloak.version);console.log('active-registration:'+active);console.log('accounts:'+accounts);console.log('free-fix:'+(/plan_type:\\\\s*'Free'/.test(register)&&register.includes('PROGRESS.REGISTERED')));console.log('activated-at-fix:'+progress.includes('if (hasActivated(row)) return PROGRESS.PAID'));db.close();"`,
    'test -d /opt/gpt-plus/backups && echo backup-dir:ok',
    'test ! -d /tmp/gpt-plus-deploy && echo staging-clean:yes',
  ].join(' ; echo --- ; '), (err, stream) => {
    if (err) {
      console.error(err.message || err);
      conn.end();
      return;
    }
    stream.on('close', () => conn.end()).on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stderr.write(d));
  });
}).connect({
  host: require('./deploy-env').host,
  port: 22,
  username: 'root',
  password: process.env.DEPLOY_SSH_PASSWORD,
});
