const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-mailcom-session-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');

const db = require('../src/db');
const { createMailcomSessionStore } = require('../src/utils/mailcomSession');
const { httpLooksLikeAssistance, RetryableMailcomError } = require('../src/utils/mailcom');
const { classifyImapFallbackError } = require('../src/utils/mailcomService');

const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get().id;

test('persists sid/tokens encrypted and restores the mail_query cache shape', () => {
  const store = createMailcomSessionStore(userId, 'Mom@mail.com');
  store.save({
    sid: 'SECRET_SID_VALUE',
    auth_id: 'auth-1',
    tokens: { mail_mailbox_r: 'SECRET_TOKEN_VALUE' },
  });

  const row = db
    .prepare('SELECT mother_key, payload_enc FROM mailcom_sessions WHERE user_id = ?')
    .get(userId);
  assert.equal(row.mother_key, 'mom@mail.com');
  assert.equal(String(row.payload_enc).includes('SECRET_SID_VALUE'), false);
  assert.equal(String(row.payload_enc).includes('SECRET_TOKEN_VALUE'), false);

  const loaded = store.load();
  assert.equal(loaded.sid, 'SECRET_SID_VALUE');
  assert.equal(loaded.auth_id, 'auth-1');
  assert.equal(loaded.tokens.mail_mailbox_r, 'SECRET_TOKEN_VALUE');
  assert.equal(Boolean(loaded.saved_at), true);

  store.clear();
  assert.equal(store.load(), null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS c FROM mailcom_sessions WHERE user_id = ?').get(userId).c,
    0
  );
});

test('IMAP auth failure after assistance stays retryable, not bad password', () => {
  const httpErr = new RetryableMailcomError(
    'mail.com 登录被重定向（HTTP 302 → support.mail.com/account/login/index.html）'
  );
  assert.equal(httpLooksLikeAssistance(httpErr), true);
  const imapErr = new Error('authentication failed');
  assert.throws(
    () => classifyImapFallbackError(httpErr, imapErr, '收件'),
    (error) => error.retryable === true && error.code !== 'MAILCOM_BAD_CREDENTIALS'
  );
});

test('IMAP auth failure after a credential HTTP error stays bad password', () => {
  const httpErr = new Error('mail.com 账号或密码错误');
  httpErr.code = 'MAILCOM_BAD_CREDENTIALS';
  const imapErr = new Error('authentication failed');
  assert.equal(httpLooksLikeAssistance(httpErr), false);
  assert.throws(
    () => classifyImapFallbackError(httpErr, imapErr, '收件'),
    (error) => error.code === 'MAILCOM_BAD_CREDENTIALS' && error.retryable !== true
  );
});
