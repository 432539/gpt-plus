const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-progress-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '3'.repeat(64);

const db = require('../src/db');
const { toColumns, toListItem, toDetail, encodeExtractLink, decodeExtractLink } = require('../src/utils/accountFields');
const { buildExport } = require('../src/utils/accountExport');
const { parseAccounts } = require('../src/utils/accountParser');
const {
  deriveProgress,
  displayProgress,
  isPaySettled,
  PROGRESS,
  EXTRACT_LINK_TTL_MS,
  GCASH_URL_TTL_MS,
  extractCopyValue,
  extractLinkState,
  persistDerivedProgress,
  collectLiveJobs,
  markExtracted,
  markPaid,
  bumpStageAttempt,
  STAGE_ATTEMPT_LIMIT,
} = require('../src/utils/accountProgress');

const PAY_LINK = 'https://www.paypal.com/agreements/approve?ba_token=BA-TEST';

function stampAgo(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

test('schema has extracted_at for 90-minute extract cache', () => {
  const columns = db.prepare('PRAGMA table_info(gpt_accounts)').all().map((row) => row.name);
  assert.equal(columns.includes('extracted_at'), true);
  assert.equal(columns.includes('activated_at'), true);
  assert.equal(columns.includes('extract_attempts'), true);
  assert.equal(columns.includes('pay_attempts'), true);
  assert.equal(columns.includes('rt_attempts'), true);
  assert.equal(EXTRACT_LINK_TTL_MS, 90 * 60 * 1000);
  assert.equal(GCASH_URL_TTL_MS, 24 * 60 * 60 * 1000);
});

test('GCash payment URL stays valid for 24 hours while GB extract stays 90 minutes', () => {
  const gcFresh = {
    channel: 'gc',
    gcash_link: 'https://checkoutshopper-live.adyen.com/x',
    gcash_extracted_at: stampAgo(2 * 60 * 60 * 1000),
  };
  const gcOld = {
    channel: 'gc',
    gcash_link: 'https://checkoutshopper-live.adyen.com/x',
    gcash_extracted_at: stampAgo(GCASH_URL_TTL_MS + 1000),
  };
  assert.equal(extractLinkState(gcFresh), 'valid');
  assert.equal(extractLinkState(gcOld), 'expired');
});

test('register without tokens is 已注册; payment link becomes 已提链; paid plan is 已支付', () => {
  assert.equal(deriveProgress({ email: 'a@example.test', plan_type: 'Free' }), PROGRESS.REGISTERED);
  assert.equal(deriveProgress({ email: 'a@example.test', plan_type: 'Free', access_token: 'at' }), PROGRESS.REGISTERED);
  assert.equal(deriveProgress({
    email: 'a@example.test',
    plan_type: 'Free',
    extract_link: PAY_LINK,
    extracted_at: stampAgo(0),
  }), PROGRESS.EXTRACTED);
  assert.equal(deriveProgress({ email: 'a@example.test', plan_type: 'Plus' }), PROGRESS.REGISTERED);
  assert.equal(deriveProgress({
    email: 'a@example.test',
    plan_type: 'Plus',
    progress: PROGRESS.PAID,
    activated_at: stampAgo(0),
  }), PROGRESS.PAID);
});

test('Plus plan_type does not override a valid extract link to 已支付', () => {
  const row = {
    email: 'plus@example.test',
    plan_type: 'Plus',
    progress: PROGRESS.PAID,
    extract_link: PAY_LINK,
    extracted_at: stampAgo(60 * 1000),
  };
  assert.equal(deriveProgress(row), PROGRESS.EXTRACTED);
  assert.equal(displayProgress(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: false, emails: [], ids: [] },
  }), PROGRESS.EXTRACTED);
  assert.equal(toColumns({
    email: 'plus-import@example.test',
    plan_type: 'Plus',
    extract_link: PAY_LINK,
  }).progress, PROGRESS.EXTRACTED);
});

test('expired extract link is 已提链(已过期) and is not copyable', () => {
  const expired = {
    email: 'old@example.test',
    plan_type: 'Plus',
    progress: PROGRESS.EXTRACTED,
    extract_link: PAY_LINK,
    extracted_at: stampAgo(EXTRACT_LINK_TTL_MS + 1000),
  };
  assert.equal(extractLinkState(expired), 'expired');
  assert.equal(deriveProgress(expired), PROGRESS.EXTRACTED_EXPIRED);
  assert.equal(displayProgress(expired, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: false, emails: [], ids: [] },
  }), PROGRESS.EXTRACTED_EXPIRED);
  assert.equal(extractCopyValue(expired), '');
});

test('Plus plan_type without activate stays 已注册; 已支付 only after activate', () => {
  const idle = { extract: { running: false, emails: [], ids: [] }, activate: { running: false, emails: [], ids: [] } };
  const freshPlus = { email: 'fresh-plus@example.test', plan_type: 'Plus', progress: PROGRESS.REGISTERED };
  assert.equal(deriveProgress(freshPlus), PROGRESS.REGISTERED);
  assert.equal(displayProgress(freshPlus, idle), PROGRESS.REGISTERED);
  assert.equal(displayProgress({
    email: 'paid@example.test',
    plan_type: 'Plus',
    progress: PROGRESS.PAID,
    activated_at: stampAgo(0),
  }, idle), PROGRESS.PAID);
});

test('支付待核验 outranks a reusable extract link until reconciliation finishes', () => {
  const pending = {
    email: 'pending-payment@example.test',
    plan_type: 'Free',
    progress: PROGRESS.PAYMENT_REVIEW,
    extract_link: PAY_LINK,
    extracted_at: stampAgo(60 * 1000),
  };
  const idle = {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: false, emails: [], ids: [] },
  };
  assert.equal(deriveProgress(pending), PROGRESS.PAYMENT_REVIEW);
  assert.equal(displayProgress(pending, idle), PROGRESS.PAYMENT_REVIEW);
  assert.equal(toColumns(pending).progress, PROGRESS.PAYMENT_REVIEW);
});

test('live jobs overlay 提链中 ahead of 支付中 without rewriting stored progress', () => {
  const row = { id: 9, email: 'live@example.test', plan_type: 'Free', progress: '已注册', has_token: false };
  assert.equal(displayProgress(row, {
    extract: { running: true, emails: ['live@example.test'], ids: [9], run_id: 'run-extract' },
    activate: { running: true, emails: ['live@example.test'], ids: [9] },
  }), PROGRESS.EXTRACTING);
  assert.equal(displayProgress(row, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: [], ids: [9] },
  }), PROGRESS.PAYING);
  assert.equal(row.progress, '已注册');
});

test('已支付 / activated_at / 已拿RT win over live 支付中 overlay', () => {
  const livePay = {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['paid@example.test'], ids: [42] },
  };
  assert.equal(displayProgress({
    id: 42,
    email: 'paid@example.test',
    progress: PROGRESS.PAID,
    activated_at: stampAgo(0),
  }, livePay), PROGRESS.PAID);
  assert.equal(displayProgress({
    id: 42,
    email: 'paid@example.test',
    progress: PROGRESS.REGISTERED,
    activated_at: stampAgo(0),
  }, livePay), PROGRESS.PAID);
  assert.equal(displayProgress({
    id: 42,
    email: 'paid@example.test',
    progress: PROGRESS.PAID,
    remark: '已拿RT',
    has_refresh_token: true,
  }, livePay), PROGRESS.PAID);
  assert.equal(displayProgress({
    id: 42,
    email: 'paid@example.test',
    progress: PROGRESS.REGISTERED,
    remark: '已拿RT',
  }, livePay), PROGRESS.REGISTERED);
  assert.equal(isPaySettled({
    progress: PROGRESS.PAID,
    activated_at: stampAgo(0),
  }), true);
  assert.equal(displayProgress({
    id: 9,
    email: 'unpaid@example.test',
    progress: PROGRESS.REGISTERED,
  }, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: true, emails: ['unpaid@example.test'], ids: [9] },
  }), PROGRESS.PAYING);
});

test('unknown trial stays null; explicit 0 is 没试用', () => {
  const unknown = toColumns({ email: 'u@example.test', password: 'pw' });
  assert.equal(unknown.has_trial, null);
  const none = toColumns({ email: 'n@example.test', has_trial: 0 });
  assert.equal(none.has_trial, 0);
  const yes = toColumns({ email: 'y@example.test', has_trial: 1, access_token: 'at' });
  assert.equal(yes.has_trial, 1);
  assert.equal(yes.progress, PROGRESS.REGISTERED);
  assert.equal(toColumns({ email: 'r@example.test' }).progress, PROGRESS.REGISTERED);
  assert.equal(toColumns({ email: 'p@example.test', plan_type: 'Plus' }).progress, PROGRESS.REGISTERED);
  assert.equal(toColumns({
    email: 'paid@example.test',
    plan_type: 'Plus',
    progress: PROGRESS.PAID,
    activated_at: stampAgo(0),
  }).progress, PROGRESS.PAID);
  assert.equal(toColumns({ email: 'link@example.test', extract_link: PAY_LINK }).progress, PROGRESS.EXTRACTED);
});

test('stored 已提链 without a valid link displays 已提链(已过期)', () => {
  assert.equal(deriveProgress({
    email: 'stale-link@example.test',
    progress: PROGRESS.EXTRACTED,
  }), PROGRESS.EXTRACTED_EXPIRED);
  assert.equal(displayProgress({
    email: 'stale-link@example.test',
    progress: PROGRESS.EXTRACTED,
  }, {
    extract: { running: false, emails: [], ids: [] },
    activate: { running: false, emails: [], ids: [] },
  }), PROGRESS.EXTRACTED_EXPIRED);
  assert.equal(deriveProgress({
    email: 'expired-link@example.test',
    extract_link: PAY_LINK,
    extracted_at: stampAgo(EXTRACT_LINK_TTL_MS + 1000),
    progress: PROGRESS.EXTRACTED,
  }), PROGRESS.EXTRACTED_EXPIRED);
});

test('list item shows trial/progress and keeps email_type internally', () => {
  const cols = toColumns({ email: 'list@example.test', email_type: 'gmail', access_token: 'at', has_trial: 1 });
  const item = toListItem({ id: 1, ...cols });
  assert.equal(item.email_type, 'gmail');
  assert.equal(item.has_trial, 1);
  assert.equal(item.can_delete, false);
  assert.equal(item.skip_platform_sync, false);
  assert.equal(item.progress, PROGRESS.REGISTERED);
  assert.equal(item.has_extract_link, false);
  assert.equal(item.has_refresh_token, false);
  assert.equal(item.extract_link, undefined);
  const linked = toListItem({ id: 2, ...toColumns({ email: 'link@example.test', extract_link: PAY_LINK }) });
  assert.equal(linked.progress, PROGRESS.EXTRACTED);
  assert.equal(linked.has_extract_link, true);
  assert.equal(linked.extract_expired, false);
  assert.equal(linked.extract_link, undefined);
  assert.ok(linked.extracted_at);
  const withRt = toListItem({
    id: 3,
    ...toColumns({ email: 'rt@example.test', refresh_token: 'rt-value', remark: '已拿RT' }),
  });
  assert.equal(withRt.has_refresh_token, true);
  assert.equal(withRt.remark, '已拿RT');
});

test('JSON export keeps email_type and adds trial/progress extras', () => {
  const row = { id: 1, ...toColumns({ email: 'ex@example.test', email_type: 'vmail', has_trial: 0, progress: '已注册', remark: 'keep-me' }) };
  const exported = JSON.parse(Buffer.from(buildExport([row], 'json').content_base64, 'base64').toString('utf8'));
  assert.equal(exported.accounts[0].email_type, 'vmail');
  assert.equal(exported.accounts[0].remark, 'keep-me');
  assert.equal(exported.accounts[0].has_trial, 0);
  assert.equal(exported.accounts[0].progress, '已注册');
  const parsed = parseAccounts(JSON.stringify(exported));
  assert.equal(parsed[0].email_type, 'vmail');
  assert.equal(Number(parsed[0].has_trial), 0);
  assert.equal(parsed[0].progress, '已注册');
});

test('collectLiveJobs exposes detect separately from extract/activate', () => {
  const live = collectLiveJobs(1);
  assert.equal(live.extract.running, false);
  assert.equal(live.activate.running, false);
  assert.equal(live.detect.running, false);
  assert.equal(live.extract.run_id, '');
  assert.deepEqual(live.detect.ids, []);
});

test('extract copy uses stored payment link only while unexpired', () => {
  const fresh = stampAgo(0);
  assert.equal(extractCopyValue({ extract_link: 'https://example.test/pay', extracted_at: fresh }), 'https://example.test/pay');
  assert.equal(extractCopyValue({ extract_link: 'https://example.test/pay', extracted_at: stampAgo(EXTRACT_LINK_TTL_MS + 5000) }), '');
  assert.equal(extractCopyValue({ access_token: 'at-only' }), '');
  assert.equal(extractCopyValue({}), '');
});

test('persisted progress does not wipe remark', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const cols = toColumns({ email: 'remark-safe@example.test', remark: 'manual-note', access_token: 'at' });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, remark, access_token, plan_type, email_type, status, progress)
     VALUES (?, ?, ?, ?, 'Free', 'gmail', '正常', '')`
  ).run(user.id, cols.email, cols.remark, cols.access_token);
  persistDerivedProgress(user.id, inserted.lastInsertRowid, {
    email: cols.email,
    remark: cols.remark,
    access_token: 'at',
    plan_type: 'Free',
    progress: '',
  });
  const saved = db.prepare('SELECT remark, progress FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  assert.equal(saved.remark, 'manual-note');
  assert.equal(saved.progress, PROGRESS.REGISTERED);
  const detail = toDetail(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid));
  assert.equal(detail.remark, 'manual-note');
});

test('persist does not promote Plus-without-activate to 已支付', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress)
     VALUES (?, 'plus-stamp@example.test', 'Plus', 'gmail', '正常', '已注册')`
  ).run(user.id);
  persistDerivedProgress(user.id, inserted.lastInsertRowid, {
    email: 'plus-stamp@example.test',
    plan_type: 'Plus',
    progress: PROGRESS.REGISTERED,
  });
  const saved = db.prepare('SELECT progress, plan_type FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  assert.equal(saved.plan_type, 'Plus');
  assert.equal(saved.progress, PROGRESS.REGISTERED);
});

test('detect/persist does not let Plus overwrite 已提链', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const cols = toColumns({
    email: 'extract-plus@example.test',
    extract_link: PAY_LINK,
    plan_type: 'Plus',
    progress: PROGRESS.PAID,
  });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, extract_link, extracted_at, plan_type, email_type, status, progress)
     VALUES (?, ?, ?, ?, 'Plus', 'gmail', '正常', ?)`
  ).run(user.id, cols.email, cols.extract_link, cols.extracted_at, PROGRESS.PAID);
  persistDerivedProgress(user.id, inserted.lastInsertRowid, {
    email: cols.email,
    extract_link: cols.extract_link,
    extracted_at: cols.extracted_at,
    plan_type: 'Plus',
    progress: PROGRESS.PAID,
  });
  const saved = db.prepare('SELECT progress, extracted_at FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  assert.equal(saved.progress, PROGRESS.EXTRACTED);
  assert.ok(saved.extracted_at);
});

test('markExtracted stamps extracted_at; markPaid clears the cached link', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress)
     VALUES (?, 'paid-later@example.test', 'Free', 'gmail', '正常', '已注册')`
  ).run(user.id);
  const id = inserted.lastInsertRowid;
  markExtracted(user.id, id, { extract_link: encodeExtractLink(PAY_LINK) });
  const extracted = db.prepare('SELECT progress, extract_link, extracted_at FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(extracted.progress, PROGRESS.EXTRACTED);
  assert.ok(extracted.extract_link);
  assert.ok(extracted.extracted_at);
  markPaid(user.id, id, { plan_type: 'Plus', expires_at: '2026-09-19 12:00:00' });
  const paid = db.prepare('SELECT progress, plan_type, extract_link, extracted_at, expires_at, activated_at FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(paid.progress, PROGRESS.PAID);
  assert.equal(paid.plan_type, 'Plus');
  assert.equal(paid.extract_link, '');
  assert.equal(paid.extracted_at, '');
  assert.equal(paid.expires_at, '2026-09-19 12:00:00');
  assert.ok(paid.activated_at);
});

test('stage attempt counters persist and cap at 5', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, plan_type, email_type, status, progress)
     VALUES (?, 'retry-cap@example.test', 'Free', 'gmail', '正常', '已注册')`
  ).run(user.id);
  const id = inserted.lastInsertRowid;
  let n = 0;
  for (let i = 0; i < STAGE_ATTEMPT_LIMIT; i += 1) n = bumpStageAttempt(user.id, id, 'extract');
  assert.equal(n, 5);
  const saved = db.prepare('SELECT extract_attempts FROM gpt_accounts WHERE id = ?').get(id);
  assert.equal(saved.extract_attempts, 5);
});

test('extract_link is encrypted at rest and survives decode', () => {
  const link = 'https://www.paypal.com/agreements/approve?ba_token=BA-UNITTEST';
  const stored = encodeExtractLink(link);
  assert.notEqual(stored, link);
  assert.equal(decodeExtractLink(stored), link);
  assert.equal(decodeExtractLink(link), link);
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const cols = toColumns({ email: 'extract-link@example.test', extract_link: link });
  const inserted = db.prepare(
    `INSERT INTO gpt_accounts (user_id, email, extract_link, extracted_at, plan_type, email_type, status, progress)
     VALUES (?, ?, ?, ?, 'Free', 'gmail', '正常', ?)`
  ).run(user.id, cols.email, cols.extract_link, cols.extracted_at, cols.progress);
  const row = db.prepare('SELECT extract_link, progress, extracted_at FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  assert.notEqual(row.extract_link, link);
  assert.equal(row.progress, PROGRESS.EXTRACTED);
  const detail = toDetail(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid));
  assert.equal(detail.extract_link, link);
  assert.equal(extractCopyValue(detail), link);
  assert.ok(detail.extracted_at);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
