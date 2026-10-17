#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Client } = require('../server/node_modules/ssh2');

const HOST = require('./deploy-env').host;
const USER = 'root';
const PASSWORD = process.env.DEPLOY_SSH_PASSWORD;
const REMOTE_ROOT = process.env.DEPLOY_REMOTE_ROOT || '/opt/gpt-plus';
const FILES = ['server/package.json', 'server/package-lock.json', 'server/requirements-extract.txt'];

function collectFiles(root, relativeDir) {
  const base = path.join(root, relativeDir);
  const files = [];
  const skipDir = (rel) => {
    const n = rel.replace(/\\/g, '/');
    return n === 'server/src/automation/runtime'
      || n.startsWith('server/src/automation/runtime/')
      || /(^|\/)node_modules(\/|$)/.test(n);
  };
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!skipDir(rel)) walk(full);
      } else if (!skipDir(rel)) {
        files.push(rel);
      }
    }
  };
  walk(base);
  return files;
}

function collectWebDist(root) {
  return collectFiles(root, 'web/dist');
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
  const deployFiles = [...FILES, ...collectFiles(root, 'server/src'), ...collectWebDist(root)];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const conn = await connect();
  const backupDir = `${REMOTE_ROOT}/backups/${stamp}`;
  const stageDir = `/tmp/gpt-plus-deploy-${stamp}`;
  try {
    console.log('==> preflight');
    await exec(conn, `test -d ${REMOTE_ROOT} && test -f ${REMOTE_ROOT}/server/src/app.js`);
    const preflight = await exec(conn, `cd ${REMOTE_ROOT}/server && node - <<'NODE'
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./src/config');
const db = new Database(config.dbPath, { readonly: true });
const active = db.prepare('SELECT COUNT(*) AS n FROM registration_runs WHERE running = 1').get().n;
const accounts = db.prepare('SELECT COUNT(*) AS n FROM gpt_accounts').get().n;
const register = fs.readFileSync('./src/utils/registerJob.js', 'utf8');
const dbSource = fs.readFileSync('./src/db.js', 'utf8');
const accountType = db.prepare('PRAGMA table_info(gpt_accounts)').all().find((row) => row.name === 'account_type');
const insertBoundary = register.slice(register.indexOf('function insertAccount'), register.indexOf('function markEmailUsed'));
const backupRoot = path.resolve('../backups');
const prior = fs.existsSync(backupRoot)
  ? fs.readdirSync(backupRoot).map((name) => {
      const full = path.join(backupRoot, name);
      return fs.statSync(full).isDirectory() ? fs.statSync(full).mtimeMs : 0;
    }).reduce((max, value) => Math.max(max, value), 0)
  : 0;
console.log('ACTIVE_REGISTRATION=' + active);
console.log('ACCOUNT_COUNT_BEFORE=' + accounts);
console.log('REMOTE_FINAL_INSERT_GUARD=' + (
  insertBoundary.indexOf('...payload') >= 0
  && insertBoundary.indexOf("plan_type: 'Free'") > insertBoundary.indexOf('...payload')
  && insertBoundary.indexOf('progress: PROGRESS.REGISTERED') > insertBoundary.indexOf("plan_type: 'Free'")
  && insertBoundary.indexOf("activated_at: ''") > insertBoundary.indexOf('progress: PROGRESS.REGISTERED')
));
console.log('REMOTE_REPEAT_LEGACY_PLAN_MIGRATION=' + (
  dbSource.includes("if (cols.includes('account_type'))")
));
console.log('REMOTE_ACCOUNT_TYPE_DEFAULT=' + (accountType?.dflt_value || 'none'));
console.log('PRIOR_BACKUP_EPOCH=' + Math.floor(prior / 1000));
db.close();
if (active && ${process.env.DEPLOY_ALLOW_ACTIVE_REGISTRATION === '1' ? 'false' : 'true'}) process.exit(42);
NODE`);
    if (process.env.DEPLOY_ALLOW_ACTIVE_REGISTRATION !== '1' && !/ACTIVE_REGISTRATION=0(?:\r?\n|$)/.test(preflight.stdout)) {
      throw new Error('active registration job detected; deployment aborted');
    }
    if (process.env.DEPLOY_ALLOW_ACTIVE_REGISTRATION === '1' && !/ACTIVE_REGISTRATION=0(?:\r?\n|$)/.test(preflight.stdout)) {
      console.log('ACTIVE_REGISTRATION_OVERRIDE=1');
    }
    const priorBackupEpoch = Number(preflight.stdout.match(/PRIOR_BACKUP_EPOCH=(\d+)/)?.[1] || 0);
    if (!priorBackupEpoch) throw new Error('could not determine prior deployment boundary');

    console.log(`==> backup ${stamp}`);
    await exec(conn, `mkdir -p ${backupDir}`);
    await exec(conn, `tar -czf ${backupDir}/app.tar.gz --exclude='./backups' --exclude='./server/node_modules' --exclude='./web/node_modules' --exclude='./server/src/automation/runtime' -C ${REMOTE_ROOT} . || test $? -eq 1`);
    await exec(conn, `cd ${REMOTE_ROOT}/server && BACKUP_DB=${backupDir}/database.sqlite node - <<'NODE'
const Database = require('better-sqlite3');
const config = require('./src/config');
(async () => {
  const db = new Database(config.dbPath);
  db.pragma('busy_timeout = 10000');
  db.pragma('wal_checkpoint(TRUNCATE)');
  await db.backup(process.env.BACKUP_DB);
  console.log('DB_BACKUP_OK');
  db.close();
})().catch((error) => { console.error(error); process.exit(1); });
NODE`);

    console.log(`==> stage ${deployFiles.length} files`);
    await exec(conn, `rm -rf ${stageDir} && mkdir -p ${stageDir}`);
    const sftp = await openSftp(conn);
    for (const rel of deployFiles) {
      const local = path.join(root, rel);
      const remote = `${stageDir}/${rel.replace(/\\/g, '/')}`;
      await exec(conn, `mkdir -p ${path.posix.dirname(remote)}`);
      console.log(`==> upload ${rel}`);
      await uploadWithSftp(sftp, local, remote);
    }

    console.log('==> validate staged JavaScript');
    await exec(conn, deployFiles.filter((rel) => rel.endsWith('.js'))
      .map((rel) => `node --check ${stageDir}/${rel}`).join(' && '));

    console.log('==> publish staged files');
    await exec(conn, deployFiles.map((rel) => {
      const target = `${REMOTE_ROOT}/${rel}`;
      return `install -D -m 0644 ${stageDir}/${rel} ${target}`;
    }).join(' && '));

    console.log('==> install locked server dependencies');
    await exec(conn, `cd ${REMOTE_ROOT}/server && npm ci --omit=dev --no-audit --no-fund`);
    await exec(conn, `cd ${REMOTE_ROOT}/server && npm run check`);

    console.log('==> install Playwright Chromium for GCash H5');
    try {
      await exec(conn, `cd ${REMOTE_ROOT}/server && node ./node_modules/playwright-core/cli.js install-deps chromium`);
    } catch (error) {
      console.log('PW_INSTALL_DEPS_SKIPPED=' + String(error.message || error).replace(/\s+/g, ' ').slice(0, 180));
    }
    await exec(conn, `sudo -u gptplus -H bash -c 'cd ${REMOTE_ROOT}/server && node ./node_modules/playwright-core/cli.js install chromium'`);
    await exec(conn, `cat > ${REMOTE_ROOT}/server/.verify-pw-chromium.js <<'NODE'
const fs = require('fs');
const { chromium } = require('playwright-core');
(async () => {
  const expected = chromium.executablePath();
  console.log('PW_HOME=' + process.env.HOME);
  console.log('PW_CHROMIUM=' + expected);
  console.log('PW_CHROMIUM_EXISTS=' + fs.existsSync(expected));
  if (!fs.existsSync(expected)) throw new Error('Playwright Chromium missing after install');
  const browser = await chromium.launch({
    headless: true,
    executablePath: expected,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  console.log('PW_LAUNCH_OK');
  await browser.close();
})().catch((error) => {
  console.error(String(error && error.message || error));
  process.exit(1);
});
NODE
chown gptplus:gptplus ${REMOTE_ROOT}/server/.verify-pw-chromium.js
sudo -u gptplus -H bash -c 'cd ${REMOTE_ROOT}/server && node .verify-pw-chromium.js'
rm -f ${REMOTE_ROOT}/server/.verify-pw-chromium.js`);

    console.log('==> install extract python deps');
    await exec(conn, `cd ${REMOTE_ROOT} && python3 - <<'PY'
import os, subprocess, sys
from pathlib import Path
root = Path(${JSON.stringify(REMOTE_ROOT)})
req = root / 'server' / 'requirements-extract.txt'
candidates = [root / '.venv' / 'bin' / 'python3', Path('/usr/bin/python3'), Path(sys.executable)]
python = next((str(item) for item in candidates if item.exists()), 'python3')
subprocess.check_call([python, '-m', 'pip', 'install', '-q', '-r', str(req)])
version = subprocess.check_output([python, '-c', 'import curl_cffi; print(curl_cffi.__version__)'], text=True).strip()
print('CURL_CFFI=' + version)
print('EXTRACT_PYTHON=' + python)
PY`);

    console.log('==> restart systemd service');
    await exec(conn, 'systemctl restart gpt-plus && systemctl is-active gpt-plus');

    console.log('==> verify deployment');
    await exec(conn, `cd ${REMOTE_ROOT}/server && node - <<'NODE'
const fs = require('fs');
const db = require('./src/db');
const pkg = require('./node_modules/cloakbrowser/package.json');
const columns = new Set(db.prepare('PRAGMA table_info(gpt_accounts)').all().map((row) => row.name));
const required = ['has_trial', 'activated_at', 'plan_type', 'progress'];
const accounts = db.prepare('SELECT COUNT(*) AS n FROM gpt_accounts').get().n;
const source = fs.readFileSync('./src/utils/registerJob.js', 'utf8');
const insertBoundary = source.slice(source.indexOf('function insertAccount'), source.indexOf('function markEmailUsed'));
const proxyDefault = db.prepare('PRAGMA table_info(proxies)').all().find((row) => row.name === 'status')?.dflt_value;
const candidates = db.prepare([
  "SELECT a.id FROM gpt_accounts a",
  "WHERE a.created_at >= datetime(?, 'unixepoch', 'localtime')",
  "AND a.plan_type IN ('Plus', 'Pro', 'Team')",
  "AND COALESCE(a.activated_at, '') = ''",
  "AND COALESCE(a.extract_link, '') = ''",
  "AND COALESCE(a.progress, '') IN ('', '已注册', '已支付')",
  "AND EXISTS (SELECT 1 FROM operation_logs r",
  "  WHERE r.user_id = a.user_id AND r.category = 'register'",
  "  AND r.level = 'success' AND lower(r.ref) = lower(a.email)",
  "  AND r.message LIKE '%注册成功%')",
  "AND NOT EXISTS (SELECT 1 FROM operation_logs p",
  "  WHERE p.user_id = a.user_id AND p.category = 'activate'",
  "  AND p.level = 'success' AND p.message LIKE a.email || '：%开通成功%')",
].join(' ')).all(${priorBackupEpoch});
const corrected = db.transaction((ids) => {
  const update = db.prepare([
    "UPDATE gpt_accounts",
    "SET plan_type = 'Free', progress = '已注册', activated_at = '', updated_at = datetime('now','localtime')",
    "WHERE id = ? AND plan_type IN ('Plus', 'Pro', 'Team') AND COALESCE(activated_at, '') = ''",
  ].join(' '));
  let count = 0;
  for (const row of ids) count += update.run(row.id).changes;
  return count;
})(candidates);
console.log('CLOAK_VERSION=' + pkg.version);
console.log('MIGRATIONS_OK=' + required.every((name) => columns.has(name)));
console.log('ACCOUNT_COUNT_AFTER=' + accounts);
console.log('FREE_REGISTER_FINAL_GUARD=' + (
  insertBoundary.indexOf('...payload') >= 0
  && insertBoundary.indexOf("plan_type: 'Free'") > insertBoundary.indexOf('...payload')
  && insertBoundary.indexOf('progress: PROGRESS.REGISTERED') > insertBoundary.indexOf("plan_type: 'Free'")
  && insertBoundary.indexOf("activated_at: ''") > insertBoundary.indexOf('progress: PROGRESS.REGISTERED')
));
console.log('FALSE_PLUS_CANDIDATES=' + candidates.length);
console.log('FALSE_PLUS_CORRECTED=' + corrected);
console.log('FALSE_PLUS_REMAINING=' + candidates.filter((row) => (
  db.prepare("SELECT plan_type FROM gpt_accounts WHERE id = ?").get(row.id)?.plan_type !== 'Free'
)).length);
console.log('PROXY_DEFAULT_AVAILABLE=' + (proxyDefault === "'可用'"));
db.close();
NODE`);
    await exec(conn, `node - <<'NODE'
const { execSync } = require('child_process');
function httpCode(url) {
  try {
    return String(execSync(
      'curl -sS -o /dev/null -w %{http_code} --max-time 20 ' + JSON.stringify(url),
      { encoding: 'utf8' },
    )).trim();
  } catch (error) {
    const text = String(error.stdout || error.status || '000');
    return text.trim() || '000';
  }
}
const started = Date.now();
let local = '000';
let https = '000';
while (Date.now() - started < 90000) {
  local = httpCode('http://127.0.0.1:8585/');
  https = httpCode(${JSON.stringify(require('./deploy-env').publicUrl || 'http://127.0.0.1:8585/')});
  console.log('WAIT_HEALTH LOCAL_HTTP=' + local + ' HTTPS=' + https);
  if (local === '200' && https === '200') break;
  execSync('sleep 3');
}
if (local !== '200' || https !== '200') {
  throw new Error('health check failed LOCAL_HTTP=' + local + ' HTTPS=' + https);
}
console.log('LOCAL_HTTP=' + local);
console.log('HTTPS=' + https);
NODE
systemctl is-active gpt-plus`);
    console.log(`BACKUP_STAMP=${stamp}`);
    console.log('==> done');
  } finally {
    try {
      await exec(conn, `rm -rf ${stageDir}`);
    } catch {}
    conn.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
