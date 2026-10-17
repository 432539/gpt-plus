#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
const TOKEN = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const WORKER_NAME = 'gpt-plus-mail';
const DOMAINS = String(process.env.CF_MAIL_DOMAINS || [
  '057o.com',
  '1kqj.com',
  '5zkj.com',
  '7nsc.com',
  '7twg.com',
  '953o.com',
  '97tn.com',
  'ntw8.com',
  'rha8.com',
  'wi26.com',
].join(',')).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);

if (!ACCOUNT_ID || !TOKEN || !ADMIN_TOKEN) {
  console.error('Need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ADMIN_TOKEN');
  process.exit(1);
}

async function cf(method, urlPath, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${urlPath}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const err = data.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`${method} ${urlPath}: ${err}`);
  }
  return data.result;
}

function wrangler(args) {
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  };
  const result = spawnSync('npx', ['--yes', 'wrangler@4', ...args], {
    cwd: ROOT, env, encoding: 'utf8', shell: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed`);
  }
  return result.stdout || '';
}

async function main() {
  let databaseId = '';
  const existing = await cf('GET', `/accounts/${ACCOUNT_ID}/d1/database`).catch(() => []);
  const found = (Array.isArray(existing) ? existing : []).find((item) => item.name === WORKER_NAME);
  if (found) databaseId = found.uuid || found.id;
  else {
    const created = await cf('POST', `/accounts/${ACCOUNT_ID}/d1/database`, { name: WORKER_NAME });
    databaseId = created.uuid || created.id;
  }
  const toml = `name = "${WORKER_NAME}"
main = "src/index.js"
compatibility_date = "2026-08-01"
account_id = "${ACCOUNT_ID}"

[vars]
DOMAINS = "${DOMAINS.join(',')}"

[[d1_databases]]
binding = "DB"
database_name = "${WORKER_NAME}"
database_id = "${databaseId}"
`;
  fs.writeFileSync(path.join(ROOT, 'wrangler.toml'), toml);
  wrangler(['d1', 'execute', WORKER_NAME, '--remote', '--file', 'schema.sql']);
  wrangler(['secret', 'put', 'ADMIN_TOKEN']);
  wrangler(['deploy']);
}

if (process.argv.includes('--skip-secret')) {
  process.env.WRANGLER_SEND_METRICS = 'false';
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
