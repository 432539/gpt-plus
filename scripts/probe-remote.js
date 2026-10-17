#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const conn = new Client();
conn.on('ready', () => {
  conn.exec([
    'ls -la /opt/gpt-plus',
    'ls -la /root/gpt-plus',
    'find /opt/gpt-plus /root/gpt-plus -name paypalFlow.js 2>/dev/null',
    'bash -lc "which pm2; pm2 list"',
    'bash -lc "systemctl status gpt-plus 2>&1 | head -15"',
    'bash -lc "ls /etc/systemd/system/*gpt* 2>/dev/null"',
    'bash -lc "ss -tlnp | grep -E \':3000|:8080|:80\'"',
  ].join(' ; echo === ; '), (err, stream) => {
    stream.on('close', () => conn.end()).on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stderr.write(d));
  });
}).connect({ host: require('./deploy-env').host, port: 22, username: 'root', password: PASSWORD });
