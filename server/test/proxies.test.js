const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-proxies-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '3'.repeat(64);

const db = require('../src/db');
const router = require('../src/routes/proxies');
const { encrypt } = require('../src/utils/crypto');
const { parseProxyLine } = require('../src/utils/proxyParser');
const {
  loadMailcomProxies,
  resolveMailcomProxyGroup,
  isMailcomProxyDisabled,
  proxiesForMailcomClient,
} = require('../src/utils/mailcomService');
const { createMailcomTransport, createProxyDispatcher } = require('../src/utils/mailcomProxy');

const userId = db.prepare(
  "INSERT INTO users (username, password_hash, role, level) VALUES ('proxy-test', 'x', 'user', 1)"
).run().lastInsertRowid;

function invokePost(routePath, body) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods.post);
  assert.ok(layer, `POST ${routePath} route should exist`);
  let payload;
  let statusCode = 200;
  const req = { body, user: { id: userId } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };
  layer.route.stack[0].handle(req, res);
  assert.equal(statusCode, 200);
  return payload;
}

test('batch import creates available proxies and preserves existing statuses', () => {
  db.prepare(
    `INSERT INTO proxies (user_id, host, port, status) VALUES (?, 'old.example.test', 80, '未检测')`
  ).run(userId);

  const result = invokePost('/batch-import', {
    group_name: '导入测试',
    text: 'http://user:pass@proxy-a.example.test:8080\nproxy-b.example.test:1080',
  });

  assert.deepEqual(result, { success: 2, total: 2, status: '可用' });
  const rows = db.prepare('SELECT host, status FROM proxies WHERE user_id = ? ORDER BY id').all(userId);
  assert.deepEqual(rows, [
    { host: 'old.example.test', status: '未检测' },
    { host: 'proxy-a.example.test', status: '可用' },
    { host: 'proxy-b.example.test', status: '可用' },
  ]);
});

test('single create explicitly creates an available proxy', () => {
  const result = invokePost('/', {
    group_name: '单条测试',
    proxy_type: 'socks5',
    host: 'single.example.test',
    port: 1080,
  });

  assert.equal(result.status, '可用');
  assert.equal(
    db.prepare('SELECT status FROM proxies WHERE id = ?').get(result.id).status,
    '可用'
  );
});

test('parser normalizes socks5h and decodes encoded special credentials', () => {
  const parsed = parseProxyLine(
    'socks5h://user%40tenant:p%40ss%3Aword%2F%25@proxy.example.test:1080',
    '邮箱'
  );
  assert.deepEqual(parsed, {
    group_name: '邮箱',
    proxy_type: 'socks5',
    host: 'proxy.example.test',
    port: 1080,
    username: 'user@tenant',
    password: 'p@ss:word/%',
    status: '可用',
  });
});

test('parser rejects unknown schemes instead of converting them to HTTP', () => {
  assert.equal(parseProxyLine('ftp://proxy.example.test:21'), null);
});

test('mail.com proxy loader accepts encrypted SOCKS5 credentials', () => {
  db.prepare(
    `INSERT INTO proxies
      (user_id, group_name, proxy_type, host, port, username, password_enc)
     VALUES (?, '邮箱-SOCKS', 'socks5', 'mail-proxy.example.test', 1080, 'mail-user', ?)`
  ).run(userId, encrypt('mail-secret'));
  assert.deepEqual(loadMailcomProxies(userId, '邮箱-SOCKS'), [{
    id: db.prepare("SELECT id FROM proxies WHERE group_name = '邮箱-SOCKS'").get().id,
    proxy_type: 'socks5',
    host: 'mail-proxy.example.test',
    port: 1080,
    username: 'mail-user',
    password: 'mail-secret',
  }]);
});

test('mail.com mailbox proxy is off unless explicitly selected; never falls back to 注册/支付/IPRocket', () => {
  const other = db.prepare(
    "INSERT INTO users (username, password_hash, role, level) VALUES ('mailcom-proxy-user', 'x', 'user', 1)"
  ).run().lastInsertRowid;
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status)
     VALUES (?, '支付', 'socks5', 'pay.example.test', 1080, 'pay-user', '', '可用')`
  ).run(other);
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status)
     VALUES (?, '注册', 'socks5', 'prem.country.iprocket.io', 9595, 'user-res-GB-Lsid-abc123-TTL-300', '', '可用')`
  ).run(other);
  db.prepare(
    `INSERT INTO proxies (user_id, group_name, proxy_type, host, port, username, password_enc, status)
     VALUES (?, '邮箱', 'http', 'mail.example.test', 8080, 'mail-user', '', '可用')`
  ).run(other);
  assert.equal(isMailcomProxyDisabled(''), true);
  assert.equal(isMailcomProxyDisabled('直连'), true);
  assert.equal(isMailcomProxyDisabled('__auto__:GB'), true);
  assert.equal(resolveMailcomProxyGroup(other, ''), '');
  assert.equal(resolveMailcomProxyGroup(other, '直连'), '');
  assert.equal(resolveMailcomProxyGroup(other, '__auto__:GB'), '');
  assert.deepEqual(proxiesForMailcomClient(other, { proxyGroup: '' }), []);
  assert.deepEqual(proxiesForMailcomClient(other, { proxyGroup: '直连' }), []);
  assert.equal(createProxyDispatcher(null), undefined);
  const transport = createMailcomTransport(null, { fetch: async () => new Response(null, { status: 200 }) });
  assert.equal(transport.dispatcher, undefined);
  assert.throws(
    () => resolveMailcomProxyGroup(other, '支付'),
    (error) => error.code === 'MAILCOM_PAYMENT_PROXY_FORBIDDEN',
  );
  assert.equal(resolveMailcomProxyGroup(other, '邮箱'), '邮箱');
  assert.equal(resolveMailcomProxyGroup(other, '注册'), '注册');
  const mailbox = proxiesForMailcomClient(other, { proxyGroup: '邮箱' });
  assert.equal(mailbox.length, 1);
  assert.equal(mailbox[0].host, 'mail.example.test');
});

test('fresh proxy schema defaults status to available', () => {
  const statusColumn = db.prepare('PRAGMA table_info(proxies)').all().find((column) => column.name === 'status');
  assert.equal(statusColumn.dflt_value, "'可用'");
});

test('legacy schema migration changes only the default and preserves stored status', () => {
  const legacyPath = path.join(temp, 'legacy.db');
  const dbModule = path.join(__dirname, '..', 'src', 'db.js');
  const sqliteModule = require.resolve('better-sqlite3');
  const script = `
    const Database = require(${JSON.stringify(sqliteModule)});
    const legacy = new Database(${JSON.stringify(legacyPath)});
    legacy.exec(\`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
        level INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE proxies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_name TEXT NOT NULL DEFAULT '默认分组', name TEXT DEFAULT '',
        proxy_type TEXT NOT NULL DEFAULT 'http', host TEXT NOT NULL, port INTEGER NOT NULL,
        username TEXT DEFAULT '', password_enc TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT '未检测', latency INTEGER, region TEXT DEFAULT '',
        remark TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX idx_proxies_user ON proxies(user_id);
      INSERT INTO users (username, password_hash) VALUES ('legacy-user', 'x');
      INSERT INTO proxies (user_id, host, port, status) VALUES (1, 'legacy.example.test', 80, '失败');
    \`);
    legacy.close();
    process.env.GPT_PLUS_DB_PATH = ${JSON.stringify(legacyPath)};
    process.env.AES_KEY = '${'4'.repeat(64)}';
    const migrated = require(${JSON.stringify(dbModule)});
    const column = migrated.prepare('PRAGMA table_info(proxies)').all().find((item) => item.name === 'status');
    const row = migrated.prepare('SELECT status FROM proxies WHERE host = ?').get('legacy.example.test');
    process.stdout.write('\\nMIGRATION_RESULT=' + JSON.stringify({ defaultValue: column.dflt_value, status: row.status }));
    migrated.close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const payload = result.stdout.slice(result.stdout.lastIndexOf('MIGRATION_RESULT=') + 'MIGRATION_RESULT='.length);
  assert.deepEqual(JSON.parse(payload), { defaultValue: "'可用'", status: '失败' });
});
