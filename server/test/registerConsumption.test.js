const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-register-consumption-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');

const db = require('../src/db');
const registerJob = require('../src/utils/registerJob');
const { readSettings, writeSettings } = require('../src/utils/settings');
const { enabledSuffixes } = require('../src/utils/mailcomDomains');
const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

function addChild(address) {
  const mother = db.prepare(
    `INSERT INTO emails (user_id, address, status, is_mother) VALUES (?, ?, 'active', 1)`
  ).run(userId, `mother-${address}`).lastInsertRowid;
  const id = db.prepare(
    `INSERT INTO emails (user_id, address, status, is_mother, mother_id)
     VALUES (?, ?, '未使用', 0, ?)`
  ).run(userId, address, mother).lastInsertRowid;
  return db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
}

test('pre-consumption registration failure leaves email unused', () => {
  const row = addChild('before-password@example.test');
  assert.equal(registerJob._test.listUnusedChildren(userId).some((item) => item.id === row.id), true);
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(row.id).status, '未使用');
});

test('password checkpoint marks once, keeps current row retryable, and excludes future jobs', () => {
  const row = addChild('password-stage@example.test');
  const notes = [];
  assert.equal(
    registerJob._test.consumeEmailAtCheckpoint(userId, row, 'password_submission', (message) => notes.push(message)),
    true
  );
  assert.equal(registerJob._test.consumeEmailAtCheckpoint(userId, row, 'password_submission'), false);
  assert.equal(row.address, 'password-stage@example.test');
  assert.equal(row._emailConsumed, true);
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /password-stage@example\.test|密码|token/i);
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(row.id).status, '已使用');
  assert.equal(registerJob._test.listUnusedChildren(userId).some((item) => item.id === row.id), false);
});

test('passwordless OTP-send checkpoint and successful completion remain idempotently used', () => {
  const row = addChild('passwordless@example.test');
  assert.equal(
    registerJob._test.consumeEmailAtCheckpoint(userId, row, 'passwordless_email_otp_send'),
    true
  );
  assert.equal(registerJob._test.markEmailUsed(userId, row.id), 0);
  const stored = db.prepare('SELECT status, used_at FROM emails WHERE id = ?').get(row.id);
  assert.equal(stored.status, '已使用');
  assert.ok(stored.used_at);
});

test('no matching OTP mail marks the child used and picks the next unused alias', () => {
  const dead = addChild('no-otp@safrica.com');
  const next = addChild('next-unused@safrica.com');
  const notes = [];
  assert.equal(registerJob._test.isMailboxOtpNotReceived({ code: 'MAILBOX_OTP_NOT_RECEIVED' }), true);
  assert.equal(registerJob._test.isMailboxOtpNotReceived({ code: 'MAILBOX_OTP_FETCH_FAILED' }), false);
  assert.equal(
    registerJob._test.skipMailboxWithoutOtp(userId, dead, (message) => notes.push(message)),
    true
  );
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(dead.id).status, '已使用');
  assert.equal(registerJob._test.listUnusedChildren(userId).some((item) => item.id === dead.id), false);
  assert.match(notes[0], /未收到验证邮件，邮箱已标记为已使用，跳过/);
  const claimed = new Set(registerJob._test.listUnusedChildren(userId).map((item) => item.id));
  claimed.add(dead.id);
  claimed.delete(next.id);
  const replacement = registerJob._test.pickReplacementChild(userId, claimed);
  assert.equal(replacement.id, next.id);
  assert.equal(replacement.address, 'next-unused@safrica.com');
});

test('IMAP fetch failure does not mark the mailbox used', () => {
  const row = addChild('imap-error@safrica.com');
  assert.equal(registerJob._test.isMailboxOtpNotReceived({
    code: 'MAILBOX_OTP_FETCH_FAILED',
    message: '等待验证邮件超时（最后一次收件错误：ETIMEDOUT）',
  }), false);
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(row.id).status, '未使用');
  assert.equal(registerJob._test.listUnusedChildren(userId).some((item) => item.id === row.id), true);
});

test('successful OTP path does not mark used until account save or existing checkpoint', () => {
  const row = addChild('otp-ok@safrica.com');
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(row.id).status, '未使用');
  assert.equal(registerJob._test.markEmailUsed(userId, row.id), 1);
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(row.id).status, '已使用');
});

function protocolSession() {
  return {
    page: { evaluate: async () => '' },
    request: async (url) => {
      if (url.endsWith('/api/auth/csrf')) return { ok: true, data: { csrfToken: 'csrf' } };
      if (url.includes('/api/auth/signin/openai')) {
        return { ok: true, data: { url: 'https://auth.openai.com/authorize' } };
      }
      if (url === 'https://auth.openai.com/authorize') {
        return { ok: true, url: 'https://auth.openai.com/authorize', data: {} };
      }
      throw new Error('simulated transport failure');
    },
    cookies: async () => [],
    wait: async () => {},
    newPage: async () => ({ closePage: async () => {} }),
  };
}

function runtimeWith(session) {
  return {
    withSession: async (_options, callback) => callback(session),
  };
}

test('RegisterFlow emits no checkpoint before password stage and explicit signals at consuming stages', async () => {
  const { RegisterFlow } = await import('../src/automation/flows/register.js');

  const earlySignals = [];
  const early = protocolSession();
  early.request = async () => ({ ok: false, status: 503, text: 'unavailable' });
  await assert.rejects(
    new RegisterFlow(runtimeWith(early)).run(
      { email: 'early@example.test', password: 'safe-generated-value' },
      { set_password: true },
      { onConsumptionCheckpoint: async (signal) => earlySignals.push(signal) }
    )
  );
  assert.deepEqual(earlySignals, []);

  const passwordSignals = [];
  await assert.rejects(
    new RegisterFlow(runtimeWith(protocolSession())).run(
      { email: 'password@example.test', password: 'safe-generated-value' },
      { set_password: true },
      { onConsumptionCheckpoint: async (signal) => passwordSignals.push(signal) }
    )
  );
  assert.deepEqual(passwordSignals, [{ stage: 'password_submission' }]);

  const passwordlessSignals = [];
  await assert.rejects(
    new RegisterFlow(runtimeWith(protocolSession())).run(
      { email: 'passwordless@example.test', password: '' },
      { set_password: false },
      { onConsumptionCheckpoint: async (signal) => passwordlessSignals.push(signal) }
    )
  );
  assert.deepEqual(passwordlessSignals, [{ stage: 'passwordless_email_otp_send' }]);
});

test('password-signup classifier accepts only the exact normalized HTTP 400 business failure', async () => {
  const { classifyPasswordSignupFailure } = await import('../src/automation/flows/register.js');
  const expected = { code: 'REGISTER_ACCOUNT_CREATION_REJECTED', stage: 'password_submission' };

  assert.deepEqual(
    classifyPasswordSignupFailure({
      status: 400,
      upstreamMessage: '  FAILED to CREATE account!!! Please try AGAIN... ',
    }),
    expected
  );
  assert.deepEqual(
    classifyPasswordSignupFailure({
      status: 400,
      upstreamMessage: 'Failed to create account. Please try again',
    }),
    expected
  );
  assert.equal(
    classifyPasswordSignupFailure({ status: 400, upstreamMessage: 'Invalid request. Please try again.' }),
    null
  );
  assert.equal(
    classifyPasswordSignupFailure({ status: 429, upstreamMessage: 'Failed to create account. Please try again.' }),
    null
  );
  assert.equal(
    classifyPasswordSignupFailure({ code: 'PROTOCOL_REQUEST_NETWORK', message: 'Failed to fetch' }),
    null
  );
});

test('exact account-creation rejection disables one known suffix once and preserves job data', () => {
  writeSettings(userId, {
    cloak: { license_key: 'preserved-license', headless: false, max_concurrency: 7 },
    registration: { set_password: true, enable_totp_2fa: false },
    mailcom: {
      proxy_group: 'preserved-group',
      poll_minutes: 37,
      auto_delete_used: true,
      auto_repull: true,
      cap: 8,
      enabled_suffixes: ['brew-meister.com', 'dr.com'],
      disabled_suffixes: [],
    },
  });
  const row = addChild('failed-alias@brew-meister.com');
  registerJob._test.consumeEmailAtCheckpoint(userId, row, 'password_submission');
  const queue = [row];
  const counters = { success: 0, failed: 0, attempted: 0, retried: 0 };
  const failure = {
    code: 'REGISTER_ACCOUNT_CREATION_REJECTED',
    stage: 'password_submission',
  };

  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(userId, row, failure, 'suffix-test-run'),
    true
  );
  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(userId, row, failure, 'suffix-test-run'),
    false
  );

  const settings = readSettings(userId);
  assert.deepEqual(enabledSuffixes(settings.mailcom), ['dr.com']);
  assert.deepEqual(settings.mailcom.disabled_suffixes, ['brew-meister.com']);
  assert.equal(settings.mailcom.proxy_group, 'preserved-group');
  assert.equal(settings.mailcom.poll_minutes, 37);
  assert.equal(settings.mailcom.auto_delete_used, true);
  assert.equal(settings.mailcom.auto_repull, true);
  assert.equal(settings.mailcom.cap, 8);
  assert.equal(settings.cloak.license_key, 'preserved-license');
  assert.equal(settings.cloak.headless, false);
  assert.equal(settings.cloak.max_concurrency, 7);
  assert.equal(settings.registration.enable_totp_2fa, false);
  assert.equal(queue[0].id, row.id);
  assert.deepEqual(counters, { success: 0, failed: 0, attempted: 0, retried: 0 });
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(row.id).status, '已使用');

  const logs = db.prepare(
    `SELECT level, source, message FROM operation_logs
     WHERE user_id = ? AND run_id = ? AND source = 'settings'`
  ).all(userId, 'suffix-test-run');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warning');
  assert.equal(logs[0].message, '已自动禁用 mail.com 拉取后缀：brew-meister.com');
  assert.doesNotMatch(logs[0].message, /failed-alias|@|password|token/i);
});

test('unrelated failures and invalid or unknown suffixes never alter suffix settings', () => {
  writeSettings(userId, {
    mailcom: {
      enabled_suffixes: ['dr.com'],
      disabled_suffixes: ['brew-meister.com'],
    },
  });
  const before = JSON.stringify(readSettings(userId));
  const known = addChild('other-400@dr.com');
  const unknown = addChild('unknown@not-in-mailcom-catalog.test');

  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(
      userId,
      known,
      { code: 'REGISTER_HEADLESS_PASSWORD_STALLED', stage: 'password_submission' },
      'ignored-run'
    ),
    false
  );
  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(
      userId,
      known,
      { code: 'REGISTER_PASSWORD_FAILED', stage: 'password_submission', status: 400 },
      'ignored-run'
    ),
    false
  );
  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(
      userId,
      known,
      { code: 'PROTOCOL_REQUEST_NETWORK', stage: 'password_submission' },
      'ignored-run'
    ),
    false
  );
  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(
      userId,
      unknown,
      { code: 'REGISTER_ACCOUNT_CREATION_REJECTED', stage: 'password_submission' },
      'ignored-run'
    ),
    false
  );
  assert.equal(JSON.stringify(readSettings(userId)), before);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM operation_logs WHERE user_id = ? AND run_id = 'ignored-run'`).get(userId).count,
    0
  );
});

test('headless OpenAI create-account reject disables the suffix and skips remaining aliases', () => {
  writeSettings(userId, {
    mailcom: {
      enabled_suffixes: ['catlover.com', 'brew-meister.com'],
      disabled_suffixes: [],
    },
  });
  const marked = addChild('liammoore0767@catlover.com');
  const next = addChild('keep-going@brew-meister.com');
  const sameSuffix = addChild('another@catlover.com');

  assert.equal(
    registerJob._test.isAccountCreationRejectedFailure({
      code: 'REGISTER_HEADLESS_PASSWORD_STALLED',
      inline_error: 'Failed to create account. Please try again',
      stage: 'password_submission',
    }),
    true
  );
  assert.equal(
    registerJob._test.disableSuffixForAccountCreationFailure(
      userId,
      marked,
      {
        code: 'REGISTER_HEADLESS_PASSWORD_STALLED',
        inline_error: 'Failed to create account. Please try again',
        stage: 'password_submission',
      },
      'headless-reject-run'
    ),
    true
  );

  const settings = readSettings(userId);
  assert.deepEqual(enabledSuffixes(settings.mailcom), ['brew-meister.com']);
  assert.deepEqual(settings.mailcom.disabled_suffixes, ['catlover.com']);
  assert.equal(
    registerJob._test.listRegisterableChildren(userId).some((item) => item.id === sameSuffix.id),
    false
  );
  assert.equal(
    registerJob._test.listUnusedChildren(userId).some((item) => item.id === sameSuffix.id),
    true
  );

  const claimed = new Set(registerJob._test.listUnusedChildren(userId).map((item) => item.id));
  claimed.add(marked.id);
  claimed.delete(next.id);
  const replacement = registerJob._test.pickReplacementChild(userId, claimed);
  assert.equal(replacement.id, next.id);
  assert.equal(replacement.address, 'keep-going@brew-meister.com');
});
