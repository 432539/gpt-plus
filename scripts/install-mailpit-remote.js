#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Client } = require('../server/node_modules/ssh2');

const HOST = require('./deploy-env').host;
const USER = 'root';
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const REMOTE = '/opt/mailpit-install';
const FILES = [
  'deploy/mailpit/install.sh',
  'deploy/mailpit/mailpit.service',
  'deploy/mailpit/nginx-mailpit.conf',
  'deploy/mailpit/issue-cert.sh',
];

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`exit ${code}: ${stderr || stdout}`));
      });
      stream.on('data', (d) => { stdout += d; process.stdout.write(d); });
      stream.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    });
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', reject);
    conn.connect({ host: HOST, port: 22, username: USER, password: PASSWORD });
  });
}

function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function uploadWithSftp(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const read = fs.createReadStream(localPath);
    const write = sftp.createWriteStream(remotePath);
    write.on('close', resolve);
    write.on('error', reject);
    read.on('error', reject);
    read.pipe(write);
  });
}

async function main() {
  if (!PASSWORD) throw new Error('DEPLOY_SSH_PASSWORD is required');
  const root = path.resolve(__dirname, '..');
  const conn = await connect();
  try {
    await exec(conn, `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
    const sftp = await openSftp(conn);
    for (const rel of FILES) {
      const local = path.join(root, rel);
      const remote = `${REMOTE}/${path.posix.basename(rel.replace(/\\/g, '/'))}`;
      console.log(`==> upload ${rel}`);
      await uploadWithSftp(sftp, local, remote);
    }
    await exec(conn, `chmod +x ${REMOTE}/install.sh ${REMOTE}/issue-cert.sh && sed -i 's/\\r$//' ${REMOTE}/* && bash ${REMOTE}/install.sh && cp ${REMOTE}/issue-cert.sh /opt/mailpit/issue-cert.sh && chmod +x /opt/mailpit/issue-cert.sh`);
    console.log('==> mailpit install done');
  } finally {
    conn.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
