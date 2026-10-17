#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/mailpit
SMTP_IP="${SMTP_IP:-}"
MX_HOST="${MX_HOST:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
SETTINGS_USER="${DEPLOY_SETTINGS_USER:-admin}"
UI_USER=admin
GPT_PLUS=/opt/gpt-plus

if [[ -z "${SMTP_IP}" || -z "${MX_HOST}" || -z "${CERTBOT_EMAIL}" ]]; then
  echo "SMTP_IP, MX_HOST and CERTBOT_EMAIL are required"
  exit 1
fi

echo "==> install Mailpit into ${ROOT}"
mkdir -p "${ROOT}/data" /var/www/html
id mailpit >/dev/null 2>&1 || useradd --system --home "${ROOT}" --shell /usr/sbin/nologin mailpit

ARCH=$(uname -m)
case "${ARCH}" in
  x86_64|amd64) ASSET=mailpit-linux-amd64.tar.gz ;;
  aarch64|arm64) ASSET=mailpit-linux-arm64.tar.gz ;;
  *) echo "unsupported arch ${ARCH}"; exit 1 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT
curl -fsSL "https://github.com/axllent/mailpit/releases/latest/download/${ASSET}" -o "${TMP}/mailpit.tgz"
tar -xzf "${TMP}/mailpit.tgz" -C "${TMP}"
install -m 0755 "${TMP}/mailpit" "${ROOT}/mailpit"
setcap cap_net_bind_service=+ep "${ROOT}/mailpit" || true

if [[ ! -s "${ROOT}/ui.password" ]]; then
  python3 - <<'PY'
import secrets, pathlib
pathlib.Path("/opt/mailpit/ui.password").write_text(secrets.token_urlsafe(18) + "\n")
PY
fi
if [[ ! -s "${ROOT}/webhook.secret" ]]; then
  python3 - <<'PY'
import secrets, pathlib
pathlib.Path("/opt/mailpit/webhook.secret").write_text(secrets.token_urlsafe(24) + "\n")
PY
fi
chmod 600 "${ROOT}/ui.password" "${ROOT}/webhook.secret"
cp -a "${ROOT}/ui.password" /root/mailpit-ui-password
chmod 600 /root/mailpit-ui-password

python3 - <<'PY'
import hashlib, base64, pathlib
password = pathlib.Path("/opt/mailpit/ui.password").read_text().strip()
digest = base64.b64encode(hashlib.sha1(password.encode()).digest()).decode()
pathlib.Path("/opt/mailpit/auth.htpasswd").write_text(f"admin:{{SHA}}{digest}\n")
PY
chmod 640 "${ROOT}/auth.htpasswd"

UI_PASS=$(tr -d '\n' < "${ROOT}/ui.password")
WH_SECRET=$(tr -d '\n' < "${ROOT}/webhook.secret")

cat > "${ROOT}/mailpit.env" <<EOF
MP_SMTP_BIND_ADDR=0.0.0.0:25
MP_UI_BIND_ADDR=127.0.0.1:8025
MP_DATABASE=${ROOT}/data/mailpit.db
MP_MAX_MESSAGES=20000
MP_MAX_AGE=7d
MP_UI_AUTH_FILE=${ROOT}/auth.htpasswd
MP_WEBHOOK_URL=http://127.0.0.1:8585/api/mailpit/webhook?token=${WH_SECRET}
EOF
chmod 640 "${ROOT}/mailpit.env"

escaped_mx=$(printf '%s' "${MX_HOST}" | sed 's/\./\\./g')
printf 'MP_SMTP_ALLOWED_RECIPIENTS=@%s$\n' "${escaped_mx}" > "${ROOT}/recipients.env"
chmod 644 "${ROOT}/recipients.env"

install -m 0644 "$(dirname "$0")/mailpit.service" /etc/systemd/system/mailpit.service

if ss -lnt | awk '{print $4}' | grep -Eq '(:|^)25$'; then
  if systemctl is-active --quiet postfix; then
    echo "==> stopping postfix so Mailpit can bind :25"
    systemctl stop postfix
    systemctl disable postfix || true
  fi
fi

chown -R mailpit:mailpit "${ROOT}"
chmod 750 "${ROOT}"
# gpt-plus may rewrite recipients.env
if id gpt-plus >/dev/null 2>&1; then
  usermod -aG mailpit gpt-plus || true
  chgrp mailpit "${ROOT}/recipients.env"
  chmod 664 "${ROOT}/recipients.env"
fi

systemctl daemon-reload
systemctl enable mailpit
systemctl restart mailpit
sleep 1
systemctl --no-pager --full status mailpit | head -n 20

if command -v ufw >/dev/null 2>&1; then
  ufw allow 25/tcp comment 'mailpit smtp' || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

NGINX_MAIL="/etc/nginx/conf.d/${MX_HOST}.conf"
if [[ -f "${NGINX_MAIL}" ]] && grep -q ssl_certificate "${NGINX_MAIL}"; then
  echo "==> keeping existing TLS nginx config ${NGINX_MAIL}"
else
  sed "s/__MAIL_HOST__/${MX_HOST}/g" "$(dirname "$0")/nginx-mailpit.conf" > "${NGINX_MAIL}"
  chmod 0644 "${NGINX_MAIL}"
fi
nginx -t
systemctl reload nginx

if command -v certbot >/dev/null 2>&1; then
  if getent hosts "${MX_HOST}" >/dev/null 2>&1; then
    certbot --nginx -d "${MX_HOST}" --non-interactive --agree-tos --redirect --keep-until-expiring \
      -m "${CERTBOT_EMAIL}" || echo "CERTBOT_WARN=${MX_HOST} certificate not issued yet"
  else
    echo "CERTBOT_SKIP=DNS for ${MX_HOST} is not visible yet"
  fi
else
  echo "CERTBOT_SKIP=certbot not installed"
fi

ss -lntup | grep -E ':(25|8025|443|80)\b' || true
echo "MAILPIT_UI_USER=${UI_USER}"
echo "MAILPIT_UI_PASSWORD_FILE=/root/mailpit-ui-password"
echo "MAILPIT_SMTP_IP=${SMTP_IP}"

if [[ -f "${GPT_PLUS}/server/src/utils/settings.js" ]]; then
  echo "==> seed gpt-plus Mailpit settings"
  cd "${GPT_PLUS}/server"
  SMTP_IP="${SMTP_IP}" MX_HOST="${MX_HOST}" SETTINGS_USER="${SETTINGS_USER}" node - <<'NODE'
const fs = require('fs');
const db = require('./src/db');
const { writeSettings, readSettings } = require('./src/utils/settings');
const password = fs.readFileSync('/opt/mailpit/ui.password', 'utf8').trim();
const secret = fs.readFileSync('/opt/mailpit/webhook.secret', 'utf8').trim();
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(process.env.SETTINGS_USER)
  || db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
if (!user) {
  console.log('SEED_SKIP=no user');
  process.exit(0);
}
writeSettings(user.id, {
  mailpit: {
    url: 'http://127.0.0.1:8025',
    username: 'admin',
    password,
    webhook_secret: secret,
    smtp_host: process.env.SMTP_IP,
    mx_host: process.env.MX_HOST,
    ui_url: 'https://' + process.env.MX_HOST,
  },
});
const saved = readSettings(user.id);
if (saved.mailpit.password !== password) throw new Error('seed password mismatch');
console.log('SEEDED_MAILPIT_USER=' + user.id);
NODE
fi

echo "==> Mailpit install done"
