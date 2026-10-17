#!/usr/bin/env node
const { Client } = require('../server/node_modules/ssh2');

const targetEmail = String(process.env.TARGET_EMAIL || '').trim();
if (!targetEmail) {
  console.error('TARGET_EMAIL is required');
  process.exit(1);
}

const remoteSource = `
const jwt = require("jsonwebtoken");
const db = require("./src/db");
const config = require("./src/config");
const target = ${JSON.stringify(targetEmail)};

(async () => {
  const account = db.prepare(
    "SELECT user_id, id FROM gpt_accounts WHERE lower(email) = lower(?) ORDER BY id DESC LIMIT 1"
  ).get(target);
  if (!account) {
    console.log("ACCOUNT_FOUND=false");
    db.close();
    return;
  }
  const user = db.prepare(
    "SELECT id, username, role, status FROM users WHERE id = ?"
  ).get(account.user_id);
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: "5m" }
  );
  const call = async (path, method = "GET") => {
    const response = await fetch("http://127.0.0.1:8585" + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
    });
    return { http: response.status, data: await response.json() };
  };

  let result = await call("/api/accounts/operations/extract/status");
  const state = result.data || {};
  const exact = Boolean(state.running) && (
    String(state.current_email || "").toLowerCase() === target
    || (Array.isArray(state.emails) && state.emails.map((value) => String(value).toLowerCase()).includes(target))
    || (Array.isArray(state.ids) && state.ids.map(Number).includes(Number(account.id)))
  );
  console.log("ACCOUNT_FOUND=true");
  console.log("JOB_RUNNING=" + Boolean(state.running));
  console.log("JOB_EXACT_MATCH=" + exact);
  console.log("JOB_RUN_ID=" + String(state.run_id || ""));
  console.log("JOB_PROGRESS=" + Number(state.completed || 0) + "/" + Number(state.target || 0));

  if (exact) {
    const stopped = await call("/api/accounts/operations/extract/stop", "POST");
    console.log("STOP_HTTP=" + stopped.http);
    console.log("STOP_SENT=" + Boolean(stopped.data && stopped.data.ok));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await call("/api/accounts/operations/extract/status");
      if (!result.data.running) break;
    }
    console.log("JOB_RUNNING_AFTER_STOP=" + Boolean(result.data && result.data.running));
  }
  db.close();
})().catch((error) => {
  console.error("SAFE_CHECK_ERROR=" + String(error.message || error).replace(/[^A-Za-z0-9 _.:/@-]/g, "?"));
  try { db.close(); } catch {}
  process.exit(1);
});
`;

if (!process.env.DEPLOY_SSH_PASSWORD) {
  throw new Error('DEPLOY_SSH_PASSWORD is required');
}

const conn = new Client();
conn.on('ready', () => {
  const payload = Buffer.from(remoteSource).toString('base64');
  conn.exec(
    `cd /opt/gpt-plus/server && printf %s ${payload} | base64 -d | node`,
    (error, stream) => {
      if (error) throw error;
      stream
        .on('close', (code) => {
          conn.end();
          process.exitCode = code;
        })
        .on('data', (data) => process.stdout.write(data));
      stream.stderr.on('data', (data) => process.stderr.write(data));
    },
  );
}).on('error', (error) => {
  console.error(`SSH_ERROR=${error.message}`);
  process.exit(1);
}).connect({
  host: require('./deploy-env').host,
  port: 22,
  username: 'root',
  password: process.env.DEPLOY_SSH_PASSWORD,
});
