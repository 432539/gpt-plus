#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const { host, mailHost } = require('./deploy-env');
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const MAIL = mailHost();
const APEX = String(process.env.MAIL_APEX || MAIL).trim();
if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(1);
}

const remote = `
set +e
echo '==> DNS'
echo -n 'A_GOOGLE='; dig +short A ${MAIL} @8.8.8.8
echo -n 'MX_GOOGLE='; dig +short MX ${MAIL} @8.8.8.8
echo -n 'TXT_GOOGLE='; dig +short TXT ${MAIL} @8.8.8.8
echo -n 'A_CF='; dig +short A ${MAIL} @1.1.1.1
echo -n 'A_APEX='; dig +short A ${APEX} @8.8.8.8
echo -n 'HOSTENT='; getent hosts ${MAIL} || true
echo
echo '==> local vhost'
curl -sS -o /tmp/mail-http.body -w 'LOCAL_HTTP_HOST_MAIL=%{http_code} ct=%{content_type}\\n' --max-time 8 -H 'Host: ${MAIL}' http://127.0.0.1/ || true
head -c 180 /tmp/mail-http.body; echo
curl -sk -o /tmp/mail-https.body -w 'LOCAL_HTTPS_HOST_MAIL=%{http_code} ct=%{content_type}\\n' --max-time 8 -H 'Host: ${MAIL}' https://127.0.0.1/ || true
head -c 180 /tmp/mail-https.body; echo
curl -sS -o /dev/null -w 'LOCAL_8025_NOAUTH=%{http_code}\\n' --max-time 5 http://127.0.0.1:8025/ || true
echo
echo '==> public'
curl -sS -o /tmp/pub-http.body -w 'PUB_HTTP=%{http_code} redir=%{redirect_url}\\n' --max-time 15 -H 'Host: ${MAIL}' http://${MAIL}/ || true
head -c 160 /tmp/pub-http.body; echo
curl -sk -o /tmp/pub-https.body -w 'PUB_HTTPS=%{http_code} redir=%{redirect_url}\\n' --max-time 15 https://${MAIL}/ || true
head -c 160 /tmp/pub-https.body; echo
echo
echo '==> nginx mail server_names'
grep -n 'server_name' /etc/nginx/conf.d/*.conf
echo
echo '==> mailpit'
systemctl is-active mailpit
ss -lntp | grep -E ':(25|8025) ' || true
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
