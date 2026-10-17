const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-housekeeping-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '5'.repeat(64);

const db = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { writeSettings, publicView, DEFAULTS } = require('../src/utils/settings');
const { PROGRESS } = require('../src/utils/accountProgress');
const { resolveSmsCountry, COUNTRY_IDS } = require('../src/utils/smsbower');
const { PHONE_COUNTRY_FALLBACK } = require('../src/automation/channels/providers');
const { ensureRtPhoneChannel } = require('../src/automation/flows/existing-account-login');
const { batchDeleteSpec } = require('../src/routes/accounts');
const {
  isPaidAccount,
  isInvalidTokenRow,
  isConfirmedNoTrial,
  isDumpCandidate,
  isExtractExhaustedDumpCandidate,
  toImportPayload,
  parseAcceptedEmails,
  dumpNoTrialAccounts,
  dumpAllAccounts,
  dumpExtractExhaustedAccounts,
  cleanInvalidUnpaidAccounts,
  importDumpConfig,
} = require('../src/utils/accountHousekeeping');
const {
  EXTRACT_FAIL_SKIP_SYNC,
  deleteBlockReason,
  shouldSkipPlatformSync,
  isLocallyProtected,
  applySkipPlatformSync,
} = require('../src/utils/accountRetention');

const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();

function insertAccount(email, extra = {}) {
  const info = db.prepare(
    `INSERT INTO gpt_accounts (
      user_id, email, status, plan_type, has_trial, progress, activated_at,
      token_invalidated, last_security_state, access_token, refresh_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    email,
    extra.status || '正常',
    extra.plan_type || 'Free',
    extra.has_trial === undefined ? 0 : extra.has_trial,
    extra.progress || '',
    extra.activated_at || '',
    extra.token_invalidated || 0,
    extra.last_security_state || '',
    extra.access_token ? encrypt(extra.access_token) : encrypt('at-live'),
    extra.refresh_token ? encrypt(extra.refresh_token) : '',
  );
  return info.lastInsertRowid;
}

test('Chile SMS country maps to SMS-Activate id 151', () => {
  assert.equal(COUNTRY_IDS.CL, 151);
  assert.equal(resolveSmsCountry('CL'), 'CL');
  assert.equal(resolveSmsCountry('chile'), 'CL');
  assert.equal(resolveSmsCountry('智利'), 'CL');
  assert.equal(resolveSmsCountry('151'), 'CL');
  assert.equal(PHONE_COUNTRY_FALLBACK.some((item) => item.value === 'CL'), true);
});

test('paid accounts are never dump candidates or invalid-token cleanup targets', () => {
  const unpaidInvalid = { status: '令牌失效', has_trial: 0, progress: PROGRESS.REGISTERED };
  const paidInvalid = { status: '令牌失效', has_trial: 0, progress: PROGRESS.PAID, activated_at: '2026-08-01 00:00:00' };
  const freeNoTrial = { status: '正常', has_trial: 0, progress: PROGRESS.REGISTERED };
  const trialYes = { status: '正常', has_trial: 1, progress: PROGRESS.REGISTERED };
  const paidPlus = { status: '正常', has_trial: 0, progress: PROGRESS.PAID, activated_at: '2026-08-01 00:00:00', plan_type: 'Plus' };
  const plusExtracted = { status: '令牌失效', has_trial: 1, progress: PROGRESS.EXTRACTED, plan_type: 'Plus' };

  assert.equal(isPaidAccount(unpaidInvalid), false);
  assert.equal(isPaidAccount(paidInvalid), true);
  assert.equal(isPaidAccount(plusExtracted), true);
  assert.equal(isInvalidTokenRow(unpaidInvalid), true);
  assert.equal(isInvalidTokenRow(paidInvalid), true);
  assert.equal(isDumpCandidate(unpaidInvalid, { access_token: 'at' }), false);
  assert.equal(isDumpCandidate(paidInvalid, { access_token: 'at' }), false);
  assert.equal(isDumpCandidate(freeNoTrial, { access_token: 'at' }), true);
  assert.equal(isDumpCandidate(trialYes, { access_token: 'at' }), false);
  assert.equal(isDumpCandidate(paidPlus, { access_token: 'at' }), false);
  assert.equal(isDumpCandidate(plusExtracted, { access_token: 'at' }), false);
  assert.equal(isDumpCandidate(freeNoTrial, { access_token: '' }), false);
});

test('未检测 / empty / unknown has_trial are never dump candidates', () => {
  const token = { access_token: 'at' };
  assert.equal(isConfirmedNoTrial(0), true);
  assert.equal(isConfirmedNoTrial(false), true);
  assert.equal(isConfirmedNoTrial('0'), true);
  assert.equal(isConfirmedNoTrial(null), false);
  assert.equal(isConfirmedNoTrial(undefined), false);
  assert.equal(isConfirmedNoTrial(''), false);
  assert.equal(isConfirmedNoTrial('unknown'), false);
  assert.equal(isConfirmedNoTrial(1), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: null }, token), false);
  assert.equal(isDumpCandidate({ status: '未检测', has_trial: null }, token), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: '' }, token), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: undefined }, token), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 'unknown' }, token), false);
  assert.equal(isDumpCandidate({ status: '检测失败', has_trial: null }, token), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1 }, token), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 0 }, token), true);
  const unsetRow = { status: '正常', has_trial: null, extract_attempts: 5, progress: PROGRESS.REGISTERED };
  assert.equal(isExtractExhaustedDumpCandidate(unsetRow, token, { extract_attempts: 3 }), false);
});

test('unpaid 令牌失效 can be cleaned; 已支付 令牌失效 cannot', () => {
  const unpaid = insertAccount('unpaid-dead@example.test', { status: '令牌失效', token_invalidated: 1 });
  const paid = insertAccount('paid-dead@example.test', {
    status: '令牌失效', token_invalidated: 1, progress: PROGRESS.PAID, activated_at: '2026-08-20 00:00:00',
  });
  const plusExtracted = insertAccount('plus-extracted-dead@example.test', {
    status: '令牌失效', token_invalidated: 1, progress: PROGRESS.EXTRACTED, plan_type: 'Plus',
  });
  const result = cleanInvalidUnpaidAccounts(user.id, { ids: [unpaid, paid, plusExtracted] });
  assert.equal(result.deleted, 1);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(unpaid), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(paid));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(plusExtracted));
});

test('batch delete invalid excludes 已支付', () => {
  const unpaid = insertAccount('batch-unpaid-dead@example.test', { status: '令牌失效' });
  const paid = insertAccount('batch-paid-dead@example.test', {
    status: '令牌失效', progress: PROGRESS.PAID, activated_at: '2026-08-20 00:00:00',
  });
  const plusExtracted = insertAccount('batch-plus-extracted-dead@example.test', {
    status: '令牌失效', progress: PROGRESS.EXTRACTED, plan_type: 'Plus',
  });
  const spec = batchDeleteSpec('invalid');
  db.prepare(`DELETE FROM gpt_accounts WHERE user_id = ? AND ${spec.predicate}`).run(user.id);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(unpaid), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(paid));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(plusExtracted));
});

test('import dump candidate filter and remote accept then local delete', async () => {
  const dumpId = insertAccount('free-no-trial@example.test', { has_trial: 0, access_token: 'at-dump' });
  insertAccount('trial-yes-keep@example.test', { has_trial: 1, access_token: 'at-keep' });
  insertAccount('paid-keep@example.test', {
    has_trial: 0, progress: PROGRESS.PAID, activated_at: '2026-08-20 00:00:00', access_token: 'at-paid',
  });
  writeSettings(user.id, {
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
  });
  const view = publicView(DEFAULTS());
  assert.equal(view.import_dump.configured, false);
  assert.equal('api_key' in publicView(writeSettings(user.id, {})).import_dump, false);

  const calls = [];
  const dumped = await dumpNoTrialAccounts(user.id, {
    ids: [dumpId],
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), hasKey: Boolean(options.headers['X-API-Key']), body: JSON.parse(options.body) });
      assert.equal(JSON.stringify(options.body).includes('test-import-key'), false);
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, imported: 1 }),
      };
    },
  });
  assert.equal(dumped.pushed, 1);
  assert.deepEqual(dumped.emails, ['free-no-trial@example.test']);
  assert.equal(calls[0].body.accounts[0].email, 'free-no-trial@example.test');
  assert.equal(calls[0].body.accounts[0].status, '正常');
  assert.equal(calls[0].body.accounts[0].refresh_token, '');
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(dumpId), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('trial-yes-keep@example.test'));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE email = ?').get('paid-keep@example.test'));
  const sync = db.prepare(
    'SELECT email, kind, reason, remote_ok, price_yuan FROM account_syncs WHERE email = ?'
  ).get('free-no-trial@example.test');
  assert.equal(sync.kind, 'regular');
  assert.equal(sync.reason, '没试用');
  assert.equal(sync.remote_ok, 1);
  assert.equal(sync.price_yuan, '');
  assert.equal(Object.prototype.hasOwnProperty.call(sync, 'access_token'), false);
});

test('parseAcceptedEmails never treats a failed remote payload as accepted', () => {
  const sent = [{ email: 'a@example.test' }, { email: 'b@example.test' }];
  assert.deepEqual(parseAcceptedEmails({ ok: false }, sent), []);
  assert.deepEqual(parseAcceptedEmails({ success: false, errors: ['a@example.test'] }, sent), []);
  assert.deepEqual(parseAcceptedEmails({ imported: ['b@example.test'] }, sent), ['b@example.test']);
  assert.deepEqual(parseAcceptedEmails({ added: 1, skipped: 0, errors: [] }, [{ email: 'a@example.test' }]), ['a@example.test']);
  assert.deepEqual(parseAcceptedEmails({ added: 0, skipped: 1, errors: [] }, [{ email: 'a@example.test' }]), ['a@example.test']);
  assert.deepEqual(parseAcceptedEmails({ added: 0, skipped: 0, errors: [] }, sent), []);
  assert.deepEqual(toImportPayload({ email: 'x@example.test', access_token: 'at', refresh_token: '' }).refresh_token, '');
  assert.equal(importDumpConfig({ import_dump: { url: 'http://x', api_key: 'k' } }).configured, true);
});

test('extract-exhausted unpaid account dumps to import-api but keeps has_trial', async () => {
  writeSettings(user.id, {
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
    pipeline: { extract_attempts: 3 },
  });
  const dumpId = insertAccount('extract-dead@dr.com', { has_trial: 1, access_token: 'at-extract' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 3, progress = ? WHERE id = ?').run(PROGRESS.REGISTERED, dumpId);
  const plusId = insertAccount('extract-plus@dr.com', {
    has_trial: 1, plan_type: 'Plus', access_token: 'at-plus',
  });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 5 WHERE id = ?').run(plusId);
  const rtId = insertAccount('extract-rt@dr.com', {
    has_trial: 1, access_token: 'at-rt', refresh_token: 'rt-keep',
  });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 5 WHERE id = ?').run(rtId);
  const linkedId = insertAccount('extract-linked@dr.com', { has_trial: 1, access_token: 'at-link' });
  db.prepare(
    "UPDATE gpt_accounts SET extract_attempts = 5, extract_link = ?, extracted_at = ?, progress = ? WHERE id = ?"
  ).run(encrypt('https://paypal.test/pay'), '2026-08-21 00:00:00', PROGRESS.EXTRACTED, linkedId);

  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(dumpId);
  assert.equal(isExtractExhaustedDumpCandidate(row, { access_token: 'at-extract' }, { extract_attempts: 3 }), true);
  assert.equal(isDumpCandidate(row, { access_token: 'at-extract' }), false);

  const calls = [];
  const dumped = await dumpExtractExhaustedAccounts(user.id, {
    ids: [dumpId, plusId, rtId, linkedId],
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      assert.equal(JSON.stringify(options.body).includes('test-import-key'), false);
      return { status: 200, text: async () => JSON.stringify({ ok: true, imported: 1 }) };
    },
  });
  assert.equal(dumped.pushed, 1);
  assert.deepEqual(dumped.emails, ['extract-dead@dr.com']);
  assert.equal(calls[0].body.accounts[0].email, 'extract-dead@dr.com');
  assert.equal(calls[0].body.accounts[0].refresh_token, '');
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(dumpId));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(plusId));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(rtId));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(linkedId));
  const sync = db.prepare(
    'SELECT email, kind, reason, remote_ok FROM account_syncs WHERE email = ?'
  ).get('extract-dead@dr.com');
  assert.equal(sync.kind, 'regular');
  assert.equal(sync.reason, '提链次数用尽');
  assert.equal(sync.remote_ok, 1);
  assert.equal(db.prepare('SELECT 1 FROM account_syncs WHERE email = ?').get('extract-plus@dr.com'), undefined);
  const logs = db.prepare(
    "SELECT message FROM operation_logs WHERE user_id = ? AND message LIKE '%提链次数用尽%'"
  ).all(user.id);
  assert.ok(logs.some((row) => /提链次数用尽，已传送/.test(row.message)));
});

test('extract-exhausted dump skips when import-api is not configured', async () => {
  writeSettings(user.id, { import_dump: { url: '', api_key: '' } });
  const id = insertAccount('extract-skip@usa.com', { has_trial: 1, access_token: 'at-skip' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 5 WHERE id = ?').run(id);
  const result = await dumpExtractExhaustedAccounts(user.id, {
    ids: [id],
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_configured');
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(id));
});

test('extract fail under 20 still dumps; 20 skips platform sync and stays local', async () => {
  writeSettings(user.id, {
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
    pipeline: { extract_attempts: 5 },
  });
  const under = insertAccount('extract-under20@dr.com', { has_trial: 0, access_token: 'at-under' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 19, progress = ? WHERE id = ?').run(PROGRESS.REGISTERED, under);
  const full = insertAccount('extract-full20@dr.com', { has_trial: 1, access_token: 'at-full' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = ?, progress = ? WHERE id = ?')
    .run(EXTRACT_FAIL_SKIP_SYNC, PROGRESS.REGISTERED, full);

  const underRow = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(under);
  const fullRow = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(full);
  assert.equal(isExtractExhaustedDumpCandidate(underRow, { access_token: 'at-under' }, { extract_attempts: 5 }), true);
  assert.equal(isExtractExhaustedDumpCandidate(fullRow, { access_token: 'at-full' }, { extract_attempts: 5 }), false);
  assert.equal(shouldSkipPlatformSync(fullRow), true);
  assert.equal(isLocallyProtected(fullRow), true);
  assert.equal(deleteBlockReason(fullRow), '有试用，已保留');

  const calls = [];
  const dumped = await dumpExtractExhaustedAccounts(user.id, {
    ids: [under, full],
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return { status: 200, text: async () => JSON.stringify({ ok: true, imported: 1 }) };
    },
  });
  assert.equal(dumped.pushed, 1);
  assert.deepEqual(dumped.emails, ['extract-under20@dr.com']);
  assert.equal(calls.length, 1);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(under), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(full));
  assert.equal(db.prepare('SELECT skip_platform_sync FROM gpt_accounts WHERE id = ?').get(full).skip_platform_sync, 1);
  assert.equal(db.prepare('SELECT 1 FROM account_syncs WHERE email = ?').get('extract-full20@dr.com'), undefined);
  const logs = db.prepare(
    "SELECT message FROM operation_logs WHERE user_id = ? AND message LIKE '%不同步到平台%'"
  ).all(user.id);
  assert.ok(logs.some((row) => /extract-full20@dr.com/.test(row.message) && /20/.test(row.message)));
  assert.equal(JSON.stringify(logs).includes('at-full'), false);
});

test('has_trial and extract-fail-20 cannot be deleted by cleanup or batch', () => {
  const trial = insertAccount('trial-keep@example.test', {
    has_trial: 1, status: '令牌失效', token_invalidated: 1,
  });
  const fail20 = insertAccount('fail20-keep@example.test', {
    has_trial: 0, status: '令牌失效', token_invalidated: 1,
  });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = ? WHERE id = ?').run(EXTRACT_FAIL_SKIP_SYNC, fail20);
  const freeDead = insertAccount('free-dead-delete@example.test', {
    has_trial: 0, status: '令牌失效', token_invalidated: 1,
  });

  assert.equal(deleteBlockReason(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(trial)), '有试用，已保留');
  assert.equal(deleteBlockReason(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(fail20)), '提链失败已满 20 次，已保留');
  assert.equal(deleteBlockReason(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(freeDead)), '');

  const cleaned = cleanInvalidUnpaidAccounts(user.id, { ids: [trial, fail20, freeDead] });
  assert.equal(cleaned.deleted, 1);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(trial));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(fail20));
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(freeDead), undefined);

  const spec = batchDeleteSpec('selected', [trial, fail20]);
  const deleted = db.prepare(
    `DELETE FROM gpt_accounts WHERE user_id = ? AND ${spec.predicate}`
  ).run(user.id, ...spec.ids).changes;
  assert.equal(deleted, 0);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(trial));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(fail20));
});

test('dumpNoTrialAccounts skips 未检测 and only deletes confirmed 无试用', async () => {
  writeSettings(user.id, {
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
  });
  const noTrial = insertAccount('confirmed-no-trial@example.test', { has_trial: 0, access_token: 'at-no' });
  const unset = insertAccount('unset-trial@example.test', { has_trial: null, access_token: 'at-unset' });
  const yes = insertAccount('has-trial@example.test', { has_trial: 1, access_token: 'at-yes' });
  db.prepare('UPDATE gpt_accounts SET has_trial = ? WHERE id = ?').run('', unset);

  const dumped = await dumpNoTrialAccounts(user.id, {
    ids: [noTrial, unset, yes],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.accounts.map((item) => item.email), ['confirmed-no-trial@example.test']);
      return { status: 200, text: async () => JSON.stringify({ ok: true, imported: body.accounts.length }) };
    },
  });
  assert.deepEqual(dumped.emails, ['confirmed-no-trial@example.test']);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(noTrial), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(unset));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(yes));
  assert.equal(db.prepare('SELECT has_trial FROM gpt_accounts WHERE id = ?').get(unset).has_trial, '');
});

test('dump-all candidate filter includes 有试用 and still excludes unsafe rows', () => {
  const token = { access_token: 'at' };
  const all = { includeTrial: true };
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 0 }, token, all), true);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1 }, token, all), true);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1 }, token), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: null }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: '' }, token, all), false);
  assert.equal(isDumpCandidate({ status: '检测失败', has_trial: 1 }, token, all), false);
  assert.equal(isDumpCandidate({ status: '已封禁', has_trial: 1 }, token, all), false);
  assert.equal(isDumpCandidate({ status: '已停用', has_trial: 0 }, token, all), false);
  assert.equal(isDumpCandidate({ status: '令牌失效', has_trial: 1 }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, progress: PROGRESS.PAID }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, progress: PROGRESS.PAYING }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, plan_type: 'Plus' }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, plan_type: 'Pro' }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, plan_type: 'Team' }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, progress: PROGRESS.PAYMENT_REVIEW }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, skip_platform_sync: 1 }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1, extract_attempts: EXTRACT_FAIL_SKIP_SYNC }, token, all), false);
  assert.equal(isDumpCandidate({ status: '正常', has_trial: 1 }, { access_token: '' }, all), false);
});

test('dumpAllAccounts pushes GB+GC trial accounts then deletes; dump-no-trial still skips them', async () => {
  writeSettings(user.id, {
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
  });
  const gbTrial = insertAccount('all-gb-trial@example.test', { has_trial: 1, access_token: 'at-gb-trial' });
  const gcTrial = insertAccount('all-gc-trial@example.test', { has_trial: 1, access_token: 'at-gc-trial' });
  const gbNone = insertAccount('all-gb-none@example.test', { has_trial: 0, access_token: 'at-gb-none' });
  const unset = insertAccount('all-unset@example.test', { has_trial: null, access_token: 'at-unset' });
  const paid = insertAccount('all-paid@example.test', {
    has_trial: 1, progress: PROGRESS.PAID, activated_at: '2026-08-20 00:00:00', access_token: 'at-paid',
  });
  const plus = insertAccount('all-plus@example.test', { has_trial: 1, plan_type: 'Plus', access_token: 'at-plus' });
  const banned = insertAccount('all-banned@example.test', { has_trial: 1, status: '已封禁', access_token: 'at-ban' });
  const skip = insertAccount('all-skip@example.test', { has_trial: 1, access_token: 'at-skip' });
  const noAt = insertAccount('all-noat@example.test', { has_trial: 1 });
  db.prepare("UPDATE gpt_accounts SET channel = 'gc' WHERE id = ?").run(gcTrial);
  db.prepare('UPDATE gpt_accounts SET skip_platform_sync = 1 WHERE id = ?').run(skip);
  db.prepare("UPDATE gpt_accounts SET access_token = '' WHERE id = ?").run(noAt);
  db.prepare('UPDATE gpt_accounts SET has_trial = ? WHERE id = ?').run('', unset);

  const ids = [gbTrial, gcTrial, gbNone, unset, paid, plus, banned, skip, noAt];
  const noTrial = await dumpNoTrialAccounts(user.id, {
    ids,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.accounts.map((item) => item.email), ['all-gb-none@example.test']);
      return { status: 200, text: async () => JSON.stringify({ ok: true, imported: body.accounts.length }) };
    },
  });
  assert.deepEqual(noTrial.emails, ['all-gb-none@example.test']);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(gbNone), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(gbTrial));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(gcTrial));
  const noTrialLogs = db.prepare(
    "SELECT source, message FROM operation_logs WHERE user_id = ? AND source = 'dump-no-trial'"
  ).all(user.id);
  assert.ok(noTrialLogs.some((row) => /无试用普号已导出/.test(row.message)));
  assert.equal(JSON.stringify(noTrialLogs).includes('at-gb-none'), false);

  const dumped = await dumpAllAccounts(user.id, {
    ids,
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.stringify(options.body).includes('test-import-key'), false);
      const body = JSON.parse(options.body);
      const emails = body.accounts.map((item) => item.email).sort();
      assert.deepEqual(emails, ['all-gb-trial@example.test', 'all-gc-trial@example.test']);
      assert.equal(body.accounts.every((item) => item.status === '正常'), true);
      return { status: 200, text: async () => JSON.stringify({ ok: true, imported: emails.length }) };
    },
  });
  assert.equal(dumped.pushed, 2);
  assert.equal(dumped.deleted, 2);
  assert.deepEqual([...dumped.emails].sort(), ['all-gb-trial@example.test', 'all-gc-trial@example.test']);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(gbTrial), undefined);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(gcTrial), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(unset));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(paid));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(plus));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(banned));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(skip));
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(noAt));
  const trialSync = db.prepare(
    'SELECT email, kind, reason, remote_ok FROM account_syncs WHERE email = ?'
  ).get('all-gb-trial@example.test');
  assert.equal(trialSync.kind, 'regular');
  assert.equal(trialSync.reason, '全部账号');
  assert.equal(trialSync.remote_ok, 1);
  const allLogs = db.prepare(
    "SELECT source, message FROM operation_logs WHERE user_id = ? AND source = 'dump-all'"
  ).all(user.id);
  assert.ok(allLogs.some((row) => /全部账号已导出/.test(row.message)));
  assert.equal(allLogs.some((row) => /无试用普号已导出/.test(row.message)), false);
  assert.equal(JSON.stringify(allLogs).includes('at-gb-trial'), false);
  assert.equal(JSON.stringify(allLogs).includes('at-gc-trial'), false);
});

test('dumpAllAccounts skips when import-api is not configured', async () => {
  writeSettings(user.id, { import_dump: { url: '', api_key: '' } });
  const id = insertAccount('all-skip-cfg@example.test', { has_trial: 1, access_token: 'at-cfg' });
  const result = await dumpAllAccounts(user.id, {
    ids: [id],
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_configured');
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(id));
});

test('accounts routes keep dump-no-trial and add dump-all-accounts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/accounts.js'), 'utf8');
  assert.match(source, /router\.post\('\/dump-no-trial'/);
  assert.match(source, /dumpNoTrialAccounts/);
  assert.match(source, /router\.post\('\/dump-all-accounts'/);
  assert.match(source, /dumpAllAccounts/);
});

test('no-trial dump still syncs under 20 fails and skips at 20', async () => {
  writeSettings(user.id, {
    import_dump: { url: 'http://127.0.0.1:9/api/accounts/import-api', api_key: 'test-import-key' },
  });
  const under = insertAccount('notrial-under20@example.test', { has_trial: 0, access_token: 'at-notrial' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 7 WHERE id = ?').run(under);
  const full = insertAccount('notrial-full20@example.test', { has_trial: 0, access_token: 'at-skipdump' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = ? WHERE id = ?').run(EXTRACT_FAIL_SKIP_SYNC, full);

  const underRow = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(under);
  const fullRow = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(full);
  assert.equal(isDumpCandidate(underRow, { access_token: 'at-notrial' }), true);
  assert.equal(isDumpCandidate(fullRow, { access_token: 'at-skipdump' }), false);

  const dumped = await dumpNoTrialAccounts(user.id, {
    ids: [under, full],
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.stringify(options.body).includes('test-import-key'), false);
      return { status: 200, text: async () => JSON.stringify({ ok: true, imported: 1 }) };
    },
  });
  assert.equal(dumped.pushed, 1);
  assert.deepEqual(dumped.emails, ['notrial-under20@example.test']);
  assert.equal(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(under), undefined);
  assert.ok(db.prepare('SELECT 1 FROM gpt_accounts WHERE id = ?').get(full));
});

test('applySkipPlatformSync marks skip at 20 and extract success can clear it', () => {
  const id = insertAccount('skip-flag@example.test', { has_trial: 1, access_token: 'at-skip' });
  db.prepare('UPDATE gpt_accounts SET extract_attempts = 19 WHERE id = ?').run(id);
  assert.equal(applySkipPlatformSync(user.id, id, 19).skipped, false);
  assert.equal(db.prepare('SELECT skip_platform_sync FROM gpt_accounts WHERE id = ?').get(id).skip_platform_sync, 0);
  assert.equal(applySkipPlatformSync(user.id, id, EXTRACT_FAIL_SKIP_SYNC).skipped, true);
  assert.equal(db.prepare('SELECT skip_platform_sync FROM gpt_accounts WHERE id = ?').get(id).skip_platform_sync, 1);
  const { resetStageAttempt } = require('../src/utils/accountProgress');
  resetStageAttempt(user.id, id, 'extract');
  const saved = db.prepare('SELECT extract_attempts, skip_platform_sync FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(saved.extract_attempts, 0);
  assert.equal(saved.skip_platform_sync, 0);
});

test('lazy SMS factory is not used until OpenAI asks for phone', async () => {
  let created = 0;
  const ctx = {
    getPhoneChannel: async () => {
      created += 1;
      return { id: 'phone' };
    },
  };
  assert.equal(await ensureRtPhoneChannel({ phone_required: false }, ctx), null);
  assert.equal(created, 0);
  assert.equal((await ensureRtPhoneChannel({ phone_required: true }, ctx)).id, 'phone');
  assert.equal(created, 1);
  assert.equal((await ensureRtPhoneChannel({ phone_required: true }, ctx)).id, 'phone');
  assert.equal(created, 1);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
