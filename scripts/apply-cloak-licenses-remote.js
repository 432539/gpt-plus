#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const KEYS = String(process.env.CLOAK_LICENSE_KEYS || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(2);
}
if (KEYS.length < 2) {
  console.error('CLOAK_LICENSE_KEYS must contain at least 2 keys');
  process.exit(2);
}

const REMOTE_JS = `'use strict';
const fs = require('fs');
const payloadPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
try { fs.unlinkSync(payloadPath); } catch {}
const keys = (payload.keys || []).map((item) => String(item || '').trim()).filter(Boolean);
if (keys.length < 2) {
  console.error('LICENSE_COUNT_INVALID');
  process.exit(2);
}
const db = require('/opt/gpt-plus/server/src/db');
const {
  writeSettings, persistCloakLicenses, cloakLicenseKeys, publicView, readSettings,
} = require('/opt/gpt-plus/server/src/utils/settings');
const user = db.prepare("SELECT id FROM users WHERE username='admin'").get()
  || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const saved = writeSettings(user.id, { cloak: persistCloakLicenses({ license_keys: keys }) });
const view = publicView(saved);
const blob = JSON.stringify(view) + JSON.stringify(saved.pipeline || {});
for (const key of keys) {
  if (blob.includes(key)) {
    console.error('LICENSE_LEAK');
    process.exit(3);
  }
}
const reset = db.prepare([
  "UPDATE gpt_accounts SET rt_attempts = 0, updated_at = datetime('now','localtime')",
  "WHERE user_id = ?",
  "AND (COALESCE(activated_at,'') != '' OR progress = '已支付')",
  "AND COALESCE(refresh_token,'') = ''",
  "AND COALESCE(remark,'') != '已拿RT'",
  "AND COALESCE(rt_attempts, 0) > 0",
].join(' ')).run(user.id);
const after = readSettings(user.id);
console.log('HONEY_ID=' + user.id);
console.log('LICENSE_COUNT=' + cloakLicenseKeys(saved.cloak).length);
console.log('LICENSE_CONFIGURED=' + Boolean(view.cloak.license_configured));
console.log('RT_ATTEMPTS_RESET=' + reset.changes);
console.log('SAVED_LICENSE_COUNT=' + cloakLicenseKeys(after.cloak).length);
db.close();
`;

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`exit ${code}: ${(stderr || stdout).slice(0, 240)}`));
      });
      stream.on('data', (d) => { stdout += d; });
      stream.stderr.on('data', (d) => { stderr += d; });
    });
  });
}

function writeRemote(sftp, remotePath, content) {
  return new Promise((resolve, reject) => {
    const write = sftp.createWriteStream(remotePath, { mode: 0o600 });
    write.on('close', resolve);
    write.on('error', reject);
    write.end(content);
  });
}

async function main() {
  const conn = await new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({ host: require('./deploy-env').host, port: 22, username: 'root', password: PASSWORD });
  });
  const stamp = Date.now();
  const jsPath = `/tmp/gpt-plus-cloak-apply-${stamp}.js`;
  const jsonPath = `/tmp/gpt-plus-cloak-payload-${stamp}.json`;
  try {
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, ftp) => (err ? reject(err) : resolve(ftp)));
    });
    await writeRemote(sftp, jsPath, REMOTE_JS);
    await writeRemote(sftp, jsonPath, JSON.stringify({ keys: KEYS }));
    await exec(conn, `cd /opt/gpt-plus/server && node ${jsPath} ${jsonPath}; rm -f ${jsPath} ${jsonPath}`);
  } finally {
    conn.end();
  }
}

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 240));
  process.exit(1);
});
