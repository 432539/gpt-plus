const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-syncs-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '7'.repeat(64);

const db = require('../src/db');
const {
  recordAccountSync,
  listAccountSyncs,
  SYNC_PUBLIC_KEYS,
} = require('../src/utils/accountSyncs');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

test('list API payload has no tokens and paginates by kind', () => {
  recordAccountSync(user.id, {
    email: 'free-sync@example.test',
    kind: 'regular',
    reason: '没试用',
    remote_ok: true,
    access_token: 'at-secret-must-not-persist',
    refresh_token: 'rt-secret-must-not-persist',
  });
  recordAccountSync(user.id, {
    email: 'plus-sync@example.test',
    kind: 'plus',
    reason: 'nvtokens 上架 21.00',
    price_yuan: '21.00',
    remote_ok: true,
    remote_id: 'card-9',
    access_token: 'at-plus-secret',
    refresh_token: 'rt-plus-secret',
  });

  const cols = db.prepare('PRAGMA table_info(account_syncs)').all().map((row) => row.name);
  assert.equal(cols.includes('access_token'), false);
  assert.equal(cols.includes('refresh_token'), false);

  const all = listAccountSyncs(user.id, { page: 1, page_size: 20 });
  const blob = JSON.stringify(all);
  assert.equal(blob.includes('at-secret'), false);
  assert.equal(blob.includes('rt-secret'), false);
  assert.equal(blob.includes('access_token'), false);
  assert.equal(blob.includes('refresh_token'), false);
  assert.equal(all.summary.regular_count, 1);
  assert.equal(all.summary.plus_count, 1);
  assert.equal(all.summary.plus_amount_yuan, '21.00');
  assert.ok(all.items.every((item) => Object.keys(item).every((key) => SYNC_PUBLIC_KEYS.includes(key))));

  const plus = listAccountSyncs(user.id, { kind: 'plus', page: 1, page_size: 10 });
  assert.equal(plus.total, 1);
  assert.equal(plus.items[0].email, 'plus-sync@example.test');
  assert.equal(plus.items[0].kind, 'plus');
  assert.equal(plus.items[0].price_yuan, '21.00');
  assert.equal(plus.items[0].remote_id, 'card-9');
  assert.equal(plus.items[0].status, '已上架');
  assert.equal('access_token' in plus.items[0], false);
  assert.equal('refresh_token' in plus.items[0], false);

  const regular = listAccountSyncs(user.id, { kind: 'regular', page: 1 });
  assert.equal(regular.total, 1);
  assert.equal(regular.items[0].reason, '没试用');
  assert.equal(regular.items[0].status, '已同步');
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
