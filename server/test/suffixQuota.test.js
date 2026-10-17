'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-suffix-quota-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '8'.repeat(64);

const db = require('../src/db');
const { writeSettings } = require('../src/utils/settings');
const {
  constrainSuffixPool,
  consumeSuffixSlot,
  pickQuotaSuffix,
  selectUnusedUnderQuota,
  suffixQuotaView,
} = require('../src/utils/suffixQuota');

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;
const at = new Date('2026-08-21T10:15:00');

test('each suffix can generate only N mailboxes per hour', () => {
  writeSettings(userId, { suffix_quota: { hourly: 2, daily: 10 } });
  const settings = { suffix_quota: { hourly: 2, daily: 10 } };
  const pool = ['alpha.example', 'beta.example'];
  assert.equal(pickQuotaSuffix(userId, pool, { settings, at, preferred: 'alpha.example', mode: 'generate' }), 'alpha.example');
  assert.equal(pickQuotaSuffix(userId, pool, { settings, at, preferred: 'alpha.example', mode: 'generate' }), 'alpha.example');
  const third = pickQuotaSuffix(userId, pool, { settings, at, preferred: 'alpha.example', mode: 'generate' });
  assert.equal(third, 'beta.example');
  assert.deepEqual(constrainSuffixPool(userId, pool, settings, at, { mode: 'generate' }), ['beta.example']);
});

test('generate cap does not block registering the same suffix', () => {
  const other = db.prepare(
    "INSERT INTO users (username, password_hash, role, level) VALUES (?, ?, 'user', 1)"
  ).run('quota-split', 'x').lastInsertRowid;
  writeSettings(other, { suffix_quota: { hourly: 1, daily: 1 } });
  const settings = { suffix_quota: { hourly: 1, daily: 1 } };
  assert.equal(consumeSuffixSlot(other, 'dr.com', { mode: 'generate', settings, at }), true);
  assert.deepEqual(constrainSuffixPool(other, ['dr.com'], settings, at, { mode: 'generate' }), []);
  assert.deepEqual(constrainSuffixPool(other, ['dr.com'], settings, at, { mode: 'register' }), ['dr.com']);
  assert.equal(consumeSuffixSlot(other, 'dr.com', { mode: 'register', settings, at }), true);
  assert.deepEqual(constrainSuffixPool(other, ['dr.com'], settings, at, { mode: 'register' }), []);
  const view = suffixQuotaView(other, settings, at);
  assert.equal(view.hourly, 1);
  assert.equal(view.hour_generated_peak, 1);
  assert.equal(view.hour_registered_peak, 1);
});

test('register selection skips suffixes that already hit the hourly cap', () => {
  const other = db.prepare(
    "INSERT INTO users (username, password_hash, role, level) VALUES (?, ?, 'user', 1)"
  ).run('quota-reg', 'x').lastInsertRowid;
  writeSettings(other, { suffix_quota: { hourly: 1, daily: 5 } });
  const settings = { suffix_quota: { hourly: 1, daily: 5 } };
  const unused = [
    { id: 1, address: 'a@dr.com' },
    { id: 2, address: 'b@dr.com' },
    { id: 3, address: 'c@alpha.example' },
  ];
  const picked = selectUnusedUnderQuota(other, unused, [], 3, settings, () => 0);
  assert.equal(picked.length, 2);
  assert.equal(picked.filter((row) => row.address.endsWith('@dr.com')).length, 1);
  assert.equal(picked.some((row) => row.address.endsWith('@alpha.example')), true);
});

test('zero quota leaves every suffix open', () => {
  const other = db.prepare(
    "INSERT INTO users (username, password_hash, role, level) VALUES (?, ?, 'user', 1)"
  ).run('quota-open', 'x').lastInsertRowid;
  writeSettings(other, { suffix_quota: { hourly: 0, daily: 0 } });
  const settings = { suffix_quota: { hourly: 0, daily: 0 } };
  const pool = ['alpha.example', 'beta.example'];
  assert.deepEqual(constrainSuffixPool(other, pool, settings, at, { mode: 'generate' }), pool);
  assert.equal(pickQuotaSuffix(other, pool, { settings, at, preferred: 'beta.example', mode: 'both' }), 'beta.example');
});
