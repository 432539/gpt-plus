const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-test-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = '1'.repeat(64);

const db = require('../src/db');
const { toColumns, toDetail } = require('../src/utils/accountFields');
const { buildExport } = require('../src/utils/accountExport');
const { parseAccounts } = require('../src/utils/accountParser');
const {
  classifyRemoteResponse,
  refreshTransportRetryable,
  persistRefreshResult,
  refreshEligibility,
} = require('../src/utils/accountJob');

test('schema migration adds security and lifecycle columns idempotently', () => {
  const columns = new Set(db.prepare('PRAGMA table_info(gpt_accounts)').all().map(row => row.name));
  for (const name of ['totp_secret_enc', 'mfa_enabled', 'password_set', 'security_ready', 'hardening_status', 'last_detected_at', 'last_refresh_at', 'has_trial', 'progress', 'extract_link', 'extracted_at', 'activated_at', 'extract_failed_at', 'extract_attempts', 'skip_platform_sync', 'pay_attempts', 'rt_attempts', 'activation_retry_after_free_rt', 'extract_attempted_at', 'nvtokens_listed_at', 'nvtokens_list_attempts']) {
    assert.ok(columns.has(name), name);
  }
  assert.doesNotThrow(() => require('../src/db'));
});

test('account password and mailbox password remain separate credentials', () => {
  const mailboxPassword = 'mailbox-only';
  const columns = toColumns({ email: 'fixture@example.test', password: 'chatgpt-only' });
  const detail = toDetail({ id: 1, ...columns });
  assert.equal(detail.password, 'chatgpt-only');
  assert.notEqual(detail.password, mailboxPassword);
});

test('RFC6238 TOTP and secure password generation match source behavior', async () => {
  const { totpSnapshot } = await import('../src/automation/lib/totp.js');
  const { generateAccountPassword } = await import('../src/automation/flows/account-security.js');
  assert.equal(totpSnapshot('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', { now: 59000, digits: 8 }).code, '94287082');
  const password = generateAccountPassword();
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /\d/);
  assert.match(password, /[!@#$%*]/);
  assert.equal(password.includes('-'), false);
  assert.equal(password.includes('_'), false);
  assert.equal(password.length, 20);
  for (let i = 0; i < 40; i += 1) {
    const next = generateAccountPassword();
    assert.equal(/[-_]/.test(next), false);
    assert.match(next, /[a-z]/);
    assert.match(next, /[A-Z]/);
    assert.match(next, /\d/);
    assert.match(next, /[!@#$%*]/);
  }
});

test('TOTP enrollment parses and confirms factor without exposing OTP', async () => {
  const { enableTotp } = await import('../src/automation/flows/account-security.js');
  let infoReads = 0;
  const session = {
    wait: async () => {},
    request: async (url) => {
      if (url.endsWith('/mfa_info')) {
        infoReads += 1;
        return infoReads === 1
          ? { ok: true, data: { mfa_enabled: false, factors: [] } }
          : { ok: true, data: { mfa_enabled_v2: true, factors: [{ id: 'factor-1', factor_type: 'totp' }] } };
      }
      if (url.endsWith('/enroll')) return { ok: true, data: { secret: 'JBSWY3DPEHPK3PXP', session_id: 'session-1', factor: { id: 'factor-1' } } };
      return { ok: true, data: {} };
    },
  };
  const result = await enableTotp(session, { accessToken: 'token', deviceId: 'device' });
  assert.deepEqual(result, {
    totp_secret: 'JBSWY3DPEHPK3PXP', mfa_factor_id: 'factor-1', mfa_factor_type: 'totp', mfa_enabled: true,
  });
});

test('JSON, CSV, TXT, and Excel export include security fields as plaintext semantics', () => {
  const columns = toColumns({
    email: 'roundtrip@example.test', password: 'account-password', totp_secret: 'JBSWY3DPEHPK3PXP',
    mfa_enabled: true, password_set: true, security_ready: true, hardening_status: 'security_complete',
  });
  const row = { id: 1, ...columns };
  for (const format of ['json', 'csv', 'txt', 'xlsx']) {
    const exported = buildExport([row], format);
    assert.ok(exported.content_base64);
    assert.doesNotMatch(Buffer.from(exported.content_base64, 'base64').toString('utf8'), /password_enc|totp_secret_enc/);
  }
  const text = Buffer.from(buildExport([row], 'json').content_base64, 'base64').toString('utf8');
  const [parsed] = parseAccounts(text);
  assert.equal(parsed.password, 'account-password');
  assert.equal(parsed.totp_secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(parsed.mfa_enabled, true);
});

test('detection classification never converts transport failures into account failures', () => {
  assert.equal(classifyRemoteResponse({ status: 0 }).transportFailure, true);
  assert.equal(classifyRemoteResponse({ status: 503 }).transportFailure, true);
  assert.equal(classifyRemoteResponse({ status: 429 }).transportFailure, true);
  assert.equal(classifyRemoteResponse({ status: 403, text: '<html>cloudflare</html>' }).transportFailure, true);
  assert.equal(classifyRemoteResponse({ status: 401 }).accountStatus, '令牌失效');
  assert.equal(classifyRemoteResponse({ status: 403, text: 'account deactivated' }).accountStatus, '已停用');
});

function loginSession({ initial = 'password', afterPassword = 'landing', otpKind = 'totp', badPassword = false } = {}) {
  let stage = initial;
  const fills = [];
  const url = () => ({
    email: 'https://auth.openai.com/log-in',
    password: 'https://auth.openai.com/log-in',
    otp: 'https://auth.openai.com/email-verification',
    landing: 'https://chatgpt.com/',
  })[stage];
  const matches = (selector) => {
    if (stage === 'email') return /email|username/.test(selector);
    if (stage === 'password') return /password/.test(selector);
    if (stage === 'otp') return /one-time-code|name="code"|inputmode="numeric"|type="tel"/.test(selector);
    return false;
  };
  return {
    fills,
    page: {
      url,
      locator(selector) {
        return {
          first() { return this; },
          async isVisible() { return matches(selector) || (stage !== 'landing' && /button|submit/.test(selector)); },
          async fill(value) { fills.push({ stage, value: String(value) }); },
          async click() {
            if (stage === 'email') stage = 'password';
            else if (stage === 'password') stage = badPassword ? 'password' : afterPassword;
            else if (stage === 'otp') stage = 'landing';
          },
          async press() { return this.click(); },
        };
      },
      async evaluate(fn) {
        const source = String(fn);
        if (source.includes('document.body')) return otpKind === 'email' ? 'We sent a verification code to your email inbox' : 'Enter your authenticator code';
        if (source.includes('incorrect|invalid')) return badPassword ? 'Incorrect password' : '';
        return '';
      },
    },
    async wait() {},
  };
}

test('existing-account driver submits stored ChatGPT password', async () => {
  const { driveExistingAccountLogin } = await import('../src/automation/flows/existing-account-login.js');
  const session = loginSession({ afterPassword: 'landing' });
  await driveExistingAccountLogin({
    session,
    account: { email: 'login@example.test', password: 'correct-password' },
    stepTimeoutMs: 50,
  });
  assert.ok(session.fills.some(item => item.stage === 'password' && item.value === 'correct-password'));
});

test('existing-account driver obtains and submits email OTP', async () => {
  const { driveExistingAccountLogin } = await import('../src/automation/flows/existing-account-login.js');
  const session = loginSession({ initial: 'otp', otpKind: 'email' });
  let requested = 0;
  await driveExistingAccountLogin({
    session,
    account: { email: 'email-otp@example.test', password: 'password' },
    getEmailOtp: async () => { requested += 1; return { code: '123456' }; },
    stepTimeoutMs: 50,
  });
  assert.equal(requested, 1);
  assert.ok(session.fills.some(item => item.stage === 'otp' && item.value === '123456'));
});

test('existing-account driver generates and submits stored TOTP', async () => {
  const { driveExistingAccountLogin } = await import('../src/automation/flows/existing-account-login.js');
  const session = loginSession({ initial: 'otp', otpKind: 'totp' });
  await driveExistingAccountLogin({
    session,
    account: { email: 'totp-login@example.test', password: 'password', totp_secret: 'JBSWY3DPEHPK3PXP' },
    stepTimeoutMs: 50,
  });
  assert.match(session.fills.find(item => item.stage === 'otp').value, /^\d{6}$/);
});

test('refresh eligibility safely skips passwordless records', () => {
  assert.deepEqual(refreshEligibility({ password: '', refresh_token: '' }), {
    eligible: false,
    mode: '',
    code: 'ACCOUNT_REFRESH_PASSWORDLESS',
    reason: '账号没有 ChatGPT 密码或 refresh token',
  });
  assert.equal(refreshEligibility({ password: 'stored', refresh_token: '' }).mode, 'login');
});

test('bad password is terminal and never transport-retryable', async () => {
  const { driveExistingAccountLogin } = await import('../src/automation/flows/existing-account-login.js');
  const session = loginSession({ badPassword: true });
  await assert.rejects(
    driveExistingAccountLogin({
      session,
      account: { email: 'bad-password@example.test', password: 'wrong-password' },
      stepTimeoutMs: 50,
    }),
    error => error.code === 'ACCOUNT_RT_BAD_CREDENTIALS' && error.terminal === true,
  );
  assert.equal(refreshTransportRetryable({ code: 'ACCOUNT_RT_BAD_CREDENTIALS' }), false);
});

test('refresh retry classification accepts transport failures only', () => {
  assert.equal(refreshTransportRetryable({ code: 'PROTOCOL_REQUEST_TIMEOUT' }), true);
  assert.equal(refreshTransportRetryable({ code: 'CLOAK_BROWSER_DISCONNECTED' }), true);
  assert.equal(refreshTransportRetryable({ code: 'ACCOUNT_RT_TOTP_MISSING', actionable: true }), false);
});

test('atomic refresh update preserves old RT for partial session-only results', () => {
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const old = toColumns({
    email: 'atomic-refresh@example.test',
    password: 'password',
    refresh_token: 'old-refresh',
    access_token: 'old-access',
  });
  const inserted = db.prepare(`INSERT INTO gpt_accounts
    (user_id, email, password_enc, email_type, plan_type, status, access_token, refresh_token)
    VALUES (?, ?, ?, 'gmail', 'Free', '未检测', ?, ?)`).run(
    user.id, 'atomic-refresh@example.test', old.password_enc, old.access_token, old.refresh_token,
  );
  const token = `x.${Buffer.from(JSON.stringify({
    exp: 1893456000,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-atomic' },
    'https://api.openai.com/profile': { email: 'atomic-refresh@example.test' },
  })).toString('base64url')}.x`;
  const raw = db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid);
  persistRefreshResult(user.id, inserted.lastInsertRowid, raw, { access_token: token, partial: true });
  const saved = toDetail(db.prepare('SELECT * FROM gpt_accounts WHERE id = ?').get(inserted.lastInsertRowid));
  assert.equal(saved.access_token, token);
  assert.equal(saved.refresh_token, 'old-refresh');
  assert.equal(saved.plan_type, 'Free');
  assert.equal(saved.last_security_state, 'refreshed_session_only');
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
