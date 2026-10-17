#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const { host, mailHost } = require('./deploy-env');
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const MAIL = mailHost();
const CERTBOT_EMAIL = String(process.env.CERTBOT_EMAIL || '').trim();
if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(1);
}
if (!CERTBOT_EMAIL) {
  console.error('CERTBOT_EMAIL is required');
  process.exit(1);
}

const remote = `
set -e
sed -i 's/\\r$//' /opt/mailpit/issue-cert.sh
chmod +x /opt/mailpit/issue-cert.sh
echo '==> certbot'
MAIL_HOST=${JSON.stringify(MAIL)} CERTBOT_EMAIL=${JSON.stringify(CERTBOT_EMAIL)} bash /opt/mailpit/issue-cert.sh
echo '==> verify'
curl -sk -o /tmp/mail-https.body -w 'LOCAL_HTTPS_HOST_MAIL=%{http_code} ct=%{content_type}\\n' --max-time 8 -H 'Host: ${MAIL}' https://127.0.0.1/
head -c 120 /tmp/mail-https.body; echo
curl -sk -o /tmp/pub-https.body -w 'PUB_HTTPS=%{http_code}\\n' --max-time 15 https://${MAIL}/
head -c 120 /tmp/pub-https.body; echo
grep -n 'listen\\|server_name\\|ssl_certificate' /etc/nginx/conf.d/${MAIL}.conf
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
    }).on('data', (d) => process.stdout.write(d))
      .stderr.on('data', (d) => process.stderr.write(d));
  });
}).on('error', (err) => {
  console.error(err.message);
  process.exit(1);
}).connect({ host, port: 22, username: 'root', password: PASSWORD });
