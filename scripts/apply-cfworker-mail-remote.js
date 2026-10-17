#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const API_URL = String(process.env.CFWORKER_MAIL_API_URL || '').trim().replace(/\/$/, '');
const API_KEY = String(process.env.CFWORKER_MAIL_API_KEY || '').trim();
const DOMAINS = String(process.env.CFWORKER_MAIL_DOMAINS || '')
  .split(',')
  .map((item) => String(item || '').trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);

if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(2);
}
if (!API_URL || !API_KEY || !DOMAINS.length) {
  console.error('CFWORKER_MAIL_API_URL, CFWORKER_MAIL_API_KEY and CFWORKER_MAIL_DOMAINS are required');
  process.exit(2);
}

const REMOTE_JS = `'use strict';
const fs = require('fs');
const payloadPath = process.argv[2];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
try { fs.unlinkSync(payloadPath); } catch {}
const apiUrl = String(payload.api_url || '').trim().replace(/\\/$/, '');
const apiKey = String(payload.api_key || '').trim();
const domains = (payload.domains || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
if (!apiUrl || !apiKey || !domains.length) {
  console.error('CFWORKER_PAYLOAD_INVALID');
  process.exit(2);
}
const db = require('/opt/gpt-plus/server/src/db');
const { writeSettings, publicView, readSettings } = require('/opt/gpt-plus/server/src/utils/settings');
const user = db.prepare("SELECT id FROM users WHERE username='admin'").get()
  || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
const patch = {
  cfworker_mail: {
    api_url: apiUrl,
    api_key: apiKey,
    domain: domains[0],
    domains: domains.map((domain) => ({ domain, enabled: true })),
    disabled_suffixes: [],
  },
};
if (payload.set_mix === true) {
  patch.registration = {
    mail_provider: 'mix',
    mailcom_share: 5,
    cfworker_share: 5,
  };
}
const saved = writeSettings(user.id, patch);
const view = publicView(saved, user.id);
const blob = JSON.stringify(view);
if (blob.includes(apiKey)) {
  console.error('CFWORKER_KEY_LEAK');
  process.exit(3);
}
const after = readSettings(user.id);
console.log('HONEY_ID=' + user.id);
console.log('CFWORKER_URL=' + (after.cfworker_mail?.api_url || ''));
console.log('CFWORKER_KEY_CONFIGURED=' + (after.cfworker_mail?.api_key ? '1' : '0'));
console.log('CFWORKER_DOMAIN_COUNT=' + (Array.isArray(after.cfworker_mail?.domains) ? after.cfworker_mail.domains.length : 0));
console.log('CFWORKER_READY=' + (view.cfworker_mail?.ready ? '1' : '0'));
console.log('MAIL_PROVIDER=' + (after.registration?.mail_provider || ''));
console.log('MAILCOM_SHARE=' + (after.registration?.mailcom_share ?? ''));
console.log('CFWORKER_SHARE=' + (after.registration?.cfworker_share ?? ''));
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
  const jsPath = `/tmp/gpt-plus-cfworker-apply-${stamp}.js`;
  const jsonPath = `/tmp/gpt-plus-cfworker-payload-${stamp}.json`;
  try {
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, ftp) => (err ? reject(err) : resolve(ftp)));
    });
    await writeRemote(sftp, jsPath, REMOTE_JS);
    await writeRemote(sftp, jsonPath, JSON.stringify({
      api_url: API_URL,
      api_key: API_KEY,
      domains: DOMAINS,
      set_mix: process.env.APPLY_MAIL_MIX === '1',
    }));
    await exec(conn, `cd /opt/gpt-plus/server && node ${jsPath} ${jsonPath}; rm -f ${jsPath} ${jsonPath}`);
  } finally {
    conn.end();
  }
}

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 240));
  process.exit(1);
});
