#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
if (!PASSWORD) {
  console.error('DEPLOY_SSH_PASSWORD is required');
  process.exit(1);
}
const conn = new Client();
const cmd = process.argv.slice(2).join(' ') || 'echo missing-command';
conn.on('ready', () => {
  conn.exec(cmd, (err, stream) => {
    if (err) {
      console.error(err.message);
      conn.end();
      process.exit(1);
    }
    stream.on('close', (code) => {
      conn.end();
      process.exit(code || 0);
    }).on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stderr.write(d));
  });
}).on('error', (err) => {
  console.error(err.message);
  process.exit(1);
}).connect({ host: require('./deploy-env').host, port: 22, username: 'root', password: PASSWORD });
