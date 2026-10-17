#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Client } = require('../server/node_modules/ssh2');

const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const local = process.argv[2];
const remote = process.argv[3];
if (!PASSWORD || !local || !remote) {
  console.error('usage: ssh-put.js <local> <remote>');
  process.exit(1);
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`exit ${code}: ${stderr || stdout}`));
      }).on('data', (d) => { stdout += d; }).stderr.on('data', (d) => { stderr += d; });
    });
  });
}

const conn = new Client();
conn.on('ready', async () => {
  try {
    const dir = path.posix.dirname(remote);
    await exec(conn, `mkdir -p ${JSON.stringify(dir)}`);
    await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(path.resolve(local), remote, (putErr) => putErr ? reject(putErr) : resolve());
      });
    });
    console.log(`uploaded ${remote}`);
    conn.end();
  } catch (error) {
    console.error(error.message);
    conn.end();
    process.exit(1);
  }
}).on('error', (err) => {
  console.error(err.message);
  process.exit(1);
}).connect({ host: require('./deploy-env').host, port: 22, username: 'root', password: PASSWORD });
