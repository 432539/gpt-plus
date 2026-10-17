#!/bin/sh
set -e
node --check /opt/gpt-plus/server/src/automation/flows/register-headless.js
node --check /opt/gpt-plus/server/src/automation/flows/register.js
grep -c 'email-verification is transitional' /opt/gpt-plus/server/src/automation/flows/register-headless.js
grep -c '开始创建并激活 TOTP 2FA' /opt/gpt-plus/server/src/automation/flows/register.js
grep -c 'MAILBOX_OTP_NOT_RECEIVED' /opt/gpt-plus/server/src/utils/mailOtp.js
grep -c '未收到验证邮件，邮箱已标记为已使用' /opt/gpt-plus/server/src/utils/registerJob.js
systemctl restart gpt-plus
sleep 2
systemctl is-active gpt-plus
curl -fsS -o /dev/null -w 'LOCAL=%{http_code}\n' http://127.0.0.1:8585/
node /tmp/tmp-prod-inspect.cjs
