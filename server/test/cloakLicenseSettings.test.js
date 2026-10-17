const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-cloak-license-settings-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '5'.repeat(64);

const db = require('../src/db');
const {
  readSettings, writeSettings, publicView, cloakLicenseKeys, persistCloakLicenses,
} = require('../src/utils/settings');
const router = require('../src/routes/settings');

const userId = db.prepare(
  "INSERT INTO users (username, password_hash, role, level) VALUES ('cloak-license-settings', 'x', 'user', 1)"
).run().lastInsertRowid;

const KEY_A = 'cb_saved_alpha_aaaaaaa1';
const KEY_B = 'cb_saved_beta_bbbbbbbb2';

async function invoke(method, routePath, { body } = {}) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} should exist`);
  let payload;
  let statusCode = 200;
  const req = { body: body || {}, user: { id: userId } };
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
  await layer.route.stack[0].handle(req, res);
  return { statusCode, payload };
}

function assertNoLicenseLeak(value) {
  const blob = JSON.stringify(value);
  assert.equal(blob.includes(KEY_A), false);
  assert.equal(blob.includes(KEY_B), false);
}

test('cloakLicenseKeys parses multiline and array without duplicating', () => {
  assert.deepEqual(cloakLicenseKeys({
    license_key: `${KEY_A}\n\n${KEY_B}\n${KEY_A}`,
  }), [KEY_A, KEY_B]);
  assert.deepEqual(persistCloakLicenses({ license_keys: [KEY_B, KEY_A], license_key: KEY_A }), {
    license_key: KEY_B,
    license_keys: [KEY_B, KEY_A],
  });
});

test('publicView reports license count and never returns keys', () => {
  writeSettings(userId, { cloak: persistCloakLicenses({ license_key: `${KEY_A}\n${KEY_B}` }) });
  const saved = readSettings(userId);
  assert.deepEqual(cloakLicenseKeys(saved.cloak), [KEY_A, KEY_B]);
  const view = publicView(saved);
  assert.equal(view.cloak.license_configured, true);
  assert.equal(view.cloak.license_count, 2);
  assert.equal('license_key' in view.cloak, false);
  assert.equal('license_keys' in view.cloak, false);
  assertNoLicenseLeak(view);
});

test('PUT /cloak replaces keys from textarea and keeps them encrypted', async () => {
  const { statusCode, payload } = await invoke('put', '/cloak', {
    body: { license_key: `${KEY_A}\n${KEY_B}`, headless: true, max_concurrency: 4 },
  });
  assert.equal(statusCode, 200);
  assert.equal(payload.cloak.license_configured, true);
  assert.equal(payload.cloak.license_count, 2);
  assertNoLicenseLeak(payload);
  const saved = readSettings(userId);
  assert.deepEqual(cloakLicenseKeys(saved.cloak), [KEY_A, KEY_B]);
  const empty = await invoke('put', '/cloak', { body: { headless: false } });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(cloakLicenseKeys(readSettings(userId).cloak), [KEY_A, KEY_B]);
});

test('DELETE /cloak clears every stored license', async () => {
  writeSettings(userId, { cloak: persistCloakLicenses({ license_keys: [KEY_A, KEY_B] }) });
  const { statusCode, payload } = await invoke('delete', '/cloak');
  assert.equal(statusCode, 200);
  assert.equal(payload.cloak.license_configured, false);
  assert.equal(payload.cloak.license_count, 0);
  assert.deepEqual(cloakLicenseKeys(readSettings(userId).cloak), []);
  assertNoLicenseLeak(payload);
});
