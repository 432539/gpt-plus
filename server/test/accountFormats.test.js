const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-formats-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '2'.repeat(64);

const db = require('../src/db');
const { toColumns, toDetail } = require('../src/utils/accountFields');
const { parseAccounts, parseAccountsDetailed } = require('../src/utils/accountParser');
const { buildExport } = require('../src/utils/accountExport');
const { batchDeleteSpec } = require('../src/routes/accounts');

function row(input, id = 1) {
  return { id, ...toColumns(input) };
}

test('Sub2 aggregated JSON round-trips AT and RT-only accounts', () => {
  const source = [
    row({ email: 'at@example.test', access_token: 'at-real', refresh_token: 'rt-real', plan_type: 'Plus' }, 1),
    row({ email: 'rt@example.test', refresh_token: 'rt-only' }, 2),
    row({ email: 'empty@example.test' }, 3),
  ];
  const exported = buildExport(source, 'sub2');
  assert.equal(exported.exported, 2);
  assert.equal(exported.skipped, 1);
  const document = JSON.parse(Buffer.from(exported.content_base64, 'base64').toString());
  assert.ok(document.exported_at);
  assert.deepEqual(document.proxies, []);
  assert.equal(document.accounts[0].platform, 'openai');
  assert.equal(document.accounts[0].type, 'oauth');
  const parsed = parseAccounts(JSON.stringify(document));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].refresh_token, 'rt-only');
});

test('CPA single, array, JSONL, and multi-file content normalize without fabricated tokens', () => {
  const a = { type: 'codex', email: 'a@example.test', access_token: 'access-a', account_id: 'acct-a', expired: '2027-01-01T00:00:00Z' };
  const b = { type: 'codex', email: 'b@example.test', access_token: 'access-b', refresh_token: 'refresh-b', id_token: 'id-b', session_token: 'session-b' };
  assert.equal(parseAccounts(JSON.stringify(a))[0].chatgpt_account_id, 'acct-a');
  assert.equal(parseAccounts(JSON.stringify([a, b])).length, 2);
  const jsonl = parseAccounts(`${JSON.stringify(a)}\n${JSON.stringify(b)}`);
  assert.equal(jsonl.length, 2);
  assert.equal(jsonl[0].id_token, '');
  assert.equal(jsonl[1].session_token, 'session-b');
  const multiFile = [JSON.stringify(a), JSON.stringify(b)].flatMap((content) => parseAccountsDetailed(content).rows);
  assert.equal(multiFile.length, 2);

  const cpa = buildExport([row(parseAccounts(JSON.stringify(a))[0])], 'cpa');
  const zip = new AdmZip(Buffer.from(cpa.content_base64, 'base64'));
  const output = JSON.parse(zip.getEntries()[0].getData().toString());
  assert.equal(output.access_token, 'access-a');
  assert.equal(output.account_id, 'acct-a');
  assert.equal('id_token' in output, false);
  assert.equal('session_token' in output, false);
});

test('TXT detects 3, 4, 5-field TOTP layouts and legacy JWT/RT', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const parsed = parseAccounts([
    `three@example.test----pw----${secret}`,
    `four@example.test----pw----${secret}----opaque-at`,
    `five@example.test----pw----${secret}----opaque-at----opaque-rt`,
    'legacy@example.test----pw----aaa.bbb.ccc----legacy-rt',
  ].join('\n'));
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].mfa_enabled, true);
  assert.equal(parsed[1].access_token, 'opaque-at');
  assert.equal(parsed[2].refresh_token, 'opaque-rt');
  assert.equal(parsed[3].access_token, 'aaa.bbb.ccc');
  assert.equal(parsed[3].refresh_token, 'legacy-rt');
});

test('TXT presets enforce selected fields and report skipped rows', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const rows = [
    row({ email: 'ready@example.test', password: 'pw', totp_secret: secret, access_token: 'at' }, 1),
    row({ email: 'missing@example.test', password: 'pw', totp_secret: secret }, 2),
  ];
  const three = buildExport(rows, 'txt', { fields: ['email', 'password', 'totp_secret'] });
  assert.equal(three.exported, 2);
  const four = buildExport(rows, 'txt', { fields: ['email', 'password', 'totp_secret', 'access_token'] });
  assert.equal(four.exported, 1);
  assert.equal(four.skipped, 1);
  assert.equal(parseAccounts(Buffer.from(four.content_base64, 'base64').toString())[0].access_token, 'at');
});

test('full JSON, CSV, and Excel preserve security/session fields', () => {
  const original = row({
    email: 'backup@example.test', password: 'pw', totp_secret: 'JBSWY3DPEHPK3PXP',
    access_token: 'at', refresh_token: 'rt', id_token: 'id', session_token: 'session',
    mfa_enabled: true, security_ready: true, has_trial: 1, progress: '已提链',
    extract_link: 'https://www.paypal.com/agreements/approve?ba_token=BA-FORMATS',
  });
  for (const format of ['json', 'csv']) {
    const text = Buffer.from(buildExport([original], format).content_base64, 'base64').toString();
    const parsed = parseAccounts(text);
    assert.equal(parsed[0].id_token, 'id');
    assert.equal(parsed[0].session_token, 'session');
    assert.equal(parsed[0].totp_secret, 'JBSWY3DPEHPK3PXP');
    assert.equal(Boolean(parsed[0].has_trial), true);
    assert.equal(parsed[0].progress, '已提链');
    assert.ok(parsed[0].email_type);
  }
  const xlsx = Buffer.from(buildExport([original], 'xlsx').content_base64, 'base64');
  const workbook = XLSX.read(xlsx, { type: 'buffer' });
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  const [parsedExcel] = parseAccounts(JSON.stringify(data));
  assert.equal(parsedExcel.refresh_token, 'rt');
  assert.equal(parsedExcel.security_ready, true);
});

test('invalid and banned deletion predicates preserve uncertain transport failures', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const insert = db.prepare(`INSERT INTO gpt_accounts
    (user_id, email, status, last_security_state, token_invalidated)
    VALUES (?, ?, ?, ?, ?)`);
  insert.run(user.id, 'invalid@example.test', '令牌失效', '', 0);
  insert.run(user.id, 'expired@example.test', '已过期', '', 0);
  insert.run(user.id, 'paid-invalid@example.test', '令牌失效', '', 0);
  db.prepare('UPDATE gpt_accounts SET progress = ?, activated_at = ? WHERE email = ?')
    .run('已支付', '2026-08-20 00:00:00', 'paid-invalid@example.test');
  insert.run(user.id, 'transport@example.test', '检测失败', 'transport_failure', 0);
  insert.run(user.id, 'unchecked@example.test', '未检测', '', 0);
  insert.run(user.id, 'banned@example.test', '已封禁', '', 0);
  insert.run(user.id, 'deactivated@example.test', '检测失败', 'account_deactivated', 0);

  const invalid = batchDeleteSpec('invalid');
  db.prepare(`DELETE FROM gpt_accounts WHERE user_id = ? AND ${invalid.predicate}`).run(user.id);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('transport@example.test'));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('unchecked@example.test'));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('paid-invalid@example.test'));
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('invalid@example.test'), undefined);

  const banned = batchDeleteSpec('banned');
  db.prepare(`DELETE FROM gpt_accounts WHERE user_id = ? AND ${banned.predicate}`).run(user.id);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('banned@example.test'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('deactivated@example.test'), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('transport@example.test'));
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
