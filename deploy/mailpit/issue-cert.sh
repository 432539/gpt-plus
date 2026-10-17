#!/usr/bin/env bash
set -euo pipefail
HOST="${MAIL_HOST:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
if [[ -z "${HOST}" || -z "${CERTBOT_EMAIL}" ]]; then
  echo "MAIL_HOST and CERTBOT_EMAIL are required"
  exit 1
fi
if ! getent hosts "${HOST}" >/dev/null 2>&1; then
  echo "DNS for ${HOST} is not visible yet"
  exit 2
fi
certbot --nginx -d "${HOST}" --non-interactive --agree-tos --redirect --keep-until-expiring -m "${CERTBOT_EMAIL}"
nginx -t
systemctl reload nginx
echo "CERT_OK=${HOST}"
