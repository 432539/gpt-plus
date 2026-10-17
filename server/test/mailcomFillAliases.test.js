const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-mailcom-fill-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');

const db = require('../src/db');
const mailcom = require('../src/utils/mailcomService');
const { readSettings, writeSettings, publicView, recordUnavailableSuffixes } = require('../src/utils/settings');

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

function addMother(address) {
  return db.prepare(
    `INSERT INTO emails (user_id, address, mailbox_type, provider, status, is_mother)
     VALUES (?, ?, 'mailcom', 'mail.com', 'active', 1)`
  ).run(userId, address).lastInsertRowid;
}

test('records unavailable suffixes so the settings list can disable them in one click', () => {
  recordUnavailableSuffixes(userId, ['programmer.com', 'clubmember.org'], {
    reason: 'not_in_listDomains',
    error: 'mail.com 该账号后缀目录未开放',
  });
  const view = publicView(readSettings(userId));
  const blocked = view.mailcom.suffixes.filter((item) => item.unavailable);
  assert.ok(blocked.some((item) => item.suffix === 'programmer.com'));
  assert.ok(view.mailcom.unavailable_enabled_count >= 1);
});

test('fillAliases skips a 400 suffix, keeps the body, and still adds the next allowed domain', async () => {
  writeSettings(userId, {
    mailcom: {
      enabled_suffixes: ['clubmember.org', 'dr.com', 'programmer.com', 'usa.com'],
      disabled_suffixes: [],
    },
  });
  const motherId = addMother('mom-fill@mail.com');
  const attempted = [];
  const client = {
    async listAliases() {
      return ['mom-fill@mail.com', 'kept@dr.com'];
    },
    async listDomains() {
      return ['dr.com', 'programmer.com', 'usa.com'];
    },
    async validateAddress() {
      return true;
    },
    async addAlias(address) {
      attempted.push(address);
      if (String(address).endsWith('@programmer.com') || String(address).endsWith('@clubmember.org')) {
        return { status: 400, body: '{"message":"domain not allowed"}' };
      }
      return { status: 201, body: '' };
    },
    async close() {},
  };

  const result = await mailcom.fillAliases(userId, motherId, 4, { client, random: () => 0 });
  assert.ok(result.added >= 1);
  assert.ok(result.addresses.some((address) => /@usa\.com$/.test(address)));
  assert.equal(attempted.filter((address) => address.endsWith('@programmer.com')).length >= 1, true);

  const children = db.prepare('SELECT address FROM emails WHERE mother_id = ?').all(motherId).map((row) => row.address);
  assert.equal(children.some((address) => address.endsWith('@usa.com')), true);

  const settings = readSettings(userId);
  assert.equal(settings.mailcom.unavailable_suffixes['programmer.com'].reason, 'http_400');
  assert.match(settings.mailcom.unavailable_suffixes['programmer.com'].last_error, /domain not allowed/);

  const logs = db.prepare(
    "SELECT level, message FROM operation_logs WHERE category = 'pull' AND message LIKE '%programmer.com%'"
  ).all();
  assert.ok(logs.some((row) => /HTTP 400/.test(row.message) && /domain not allowed/.test(row.message)));
  assert.ok(logs.some((row) => row.level === 'warning'));
});

test('fillAliases regenerates a readable candidate after validation collisions', async () => {
  writeSettings(userId, {
    mailcom: {
      enabled_suffixes: ['usa.com'],
      disabled_suffixes: [],
    },
  });
  const motherId = addMother('mom-collision@mail.com');
  const validated = [];
  const client = {
    async listAliases() {
      return ['mom-collision@mail.com'];
    },
    async listDomains() {
      return ['usa.com'];
    },
    async validateAddress(address) {
      validated.push(address);
      return validated.length >= 3;
    },
    async addAlias() {
      return { status: 201, body: '' };
    },
    async close() {},
  };

  const result = await mailcom.fillAliases(userId, motherId, 2, { client });
  assert.equal(result.added, 1);
  assert.equal(validated.length, 3);
  assert.equal(new Set(validated).size, validated.length);
  for (const address of validated) {
    assert.match(address, /^[a-z]+(?:\.[a-z]+)?\d{2,4}@usa\.com$/);
  }
});
