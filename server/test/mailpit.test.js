const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-mailpit-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');
process.env.AES_KEY = 'a'.repeat(64);
process.env.MAILPIT_SKIP_RESTART = '1';
process.env.MAILPIT_RECIPIENTS_ENV = path.join(temp, 'recipients.env');

const { DEFAULTS, publicView, writeSettings, readSettings } = require('../src/utils/settings');
const {
  dnsRecordsFor,
  allowedRecipientsRegex,
  allocateMailpitAddresses,
  mailpitReady,
  waitMailpitOtp,
  checkDomainDns,
  syncMailpitAllowlist,
  publicMailpitView,
} = require('../src/utils/mailpit');
const { startRegister } = require('../src/utils/accountPipeline');
const db = require('../src/db');

const user = db.prepare("SELECT id FROM users WHERE username = 'admin'").get()
  || db.prepare("SELECT id FROM users ORDER BY id").get();

const SAMPLE_DNS = { smtp_host: '203.0.113.10', mx_host: 'mail.example.it.com' };

test('dns records for mail.example.it.com use host mail in example.it.com zone', () => {
  const spec = dnsRecordsFor('mail.example.it.com', SAMPLE_DNS);
  assert.equal(spec.host, 'mail');
  assert.equal(spec.zone, 'example.it.com');
  assert.deepEqual(spec.records.map((row) => row.type), ['A', 'MX', 'TXT']);
  assert.equal(spec.records[0].value, '203.0.113.10');
  assert.equal(spec.records[1].value, '10 mail.example.it.com');
  assert.match(spec.records[2].value, /v=spf1 ip4:203\.0\.113\.10/);
  assert.equal(spec.records[0].required, true);
});

test('extra domains MX to the configured mail host and do not require A', () => {
  const spec = dnsRecordsFor('otp.example.com', SAMPLE_DNS);
  assert.equal(spec.host, 'otp');
  assert.equal(spec.records.find((row) => row.type === 'A').required, false);
  assert.equal(spec.records.find((row) => row.type === 'MX').required, true);
});

test('allowlist regex covers enabled domains only', () => {
  const regex = allowedRecipientsRegex({
    mailpit: {
      domains: [
        { domain: 'mail.example.it.com', enabled: true },
        { domain: 'otp.example.com', enabled: true },
        { domain: 'skip.test', enabled: false },
      ],
    },
  });
  assert.equal(regex, '@(mail\\.example\\.it\\.com|otp\\.example\\.com)$');
  assert.match('user@mail.example.it.com', new RegExp(regex));
  assert.doesNotMatch('user@skip.test', new RegExp(regex));
});

test('allocateMailpitAddresses generates unique catch-all addresses', () => {
  const rows = allocateMailpitAddresses({
    mailpit: { domains: [{ domain: 'mail.example.it.com', enabled: true }] },
  }, 8);
  assert.equal(rows.length, 8);
  const set = new Set(rows.map((row) => row.address));
  assert.equal(set.size, 8);
  for (const row of rows) {
    assert.match(row.address, /@mail\.example\.it\.com$/);
    assert.equal(row.id, null);
  }
});

test('publicView hides Mailpit password', () => {
  writeSettings(user.id, {
    mailpit: {
      username: 'admin',
      password: 'super-secret-mailpit',
      domains: [{ domain: 'mail.example.it.com', enabled: true }],
    },
  });
  const view = publicView(readSettings(user.id));
  assert.equal(view.mailpit.password_configured, true);
  assert.equal('password' in view.mailpit, false);
  assert.doesNotMatch(JSON.stringify(view), /super-secret-mailpit/);
  assert.equal(mailpitReady(readSettings(user.id)), true);
});

test('waitMailpitOtp extracts ChatGPT code from Mailpit search API', async () => {
  const settings = {
    mailpit: { url: 'http://127.0.0.1:8025', domains: [{ domain: 'mail.example.it.com', enabled: true }] },
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/v1/search')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          messages: [{
            ID: 'msg1',
            From: { Address: 'noreply@tm.openai.com' },
            To: [{ Address: 'otp123@mail.example.it.com' }],
            Subject: 'Your temporary ChatGPT verification code',
            Created: new Date().toISOString(),
          }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        Text: 'Enter this temporary verification code to continue: 847291',
        HTML: '',
      }),
    };
  };
  const hit = await waitMailpitOtp(settings, 'otp123@mail.example.it.com', {
    timeoutMs: 2000,
    intervalMs: 10,
    fetchImpl,
  });
  assert.equal(hit.code, '847291');
});

test('checkDomainDns compares MX/A/SPF against this server', async () => {
  const resolver = {
    resolve4: async (name) => (name.includes('mail.example') ? ['203.0.113.10'] : []),
    resolveMx: async () => [{ priority: 10, exchange: 'mail.example.it.com.' }],
    resolveTxt: async () => [['v=spf1 ip4:203.0.113.10 -all']],
  };
  const result = await checkDomainDns('mail.example.it.com', { resolver, ...SAMPLE_DNS });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.checks.mx.ok, true);
  assert.equal(result.checks.spf.ok, true);
});

test('syncMailpitAllowlist writes recipients env without restart in tests', async () => {
  const result = await syncMailpitAllowlist(DEFAULTS());
  assert.equal(result.written, true);
  assert.match(fs.readFileSync(process.env.MAILPIT_RECIPIENTS_ENV, 'utf8'), /MP_SMTP_ALLOWED_RECIPIENTS=/);
});

test('pipeline startRegister with mailpit does not require unused children', async () => {
  writeSettings(user.id, {
    registration: { mail_provider: 'mailpit' },
    pipeline: { daily_register_limit: 0, register_concurrency: 3 },
    mailpit: {
      url: 'http://127.0.0.1:8025',
      username: '',
      password: '',
      domains: [{ domain: 'mail.example.it.com', enabled: true }],
    },
  });
  db.prepare('DELETE FROM emails WHERE user_id = ?').run(user.id);
  const started = [];
  const result = await startRegister(user.id, readSettings(user.id), {
    register: {
      isLive: () => false,
      start: async (_u, body) => { started.push(body); },
    },
    pay: { isLive: () => false },
    rt: { isLive: () => false },
  });
  assert.equal(result.skipped, false);
  assert.equal(started[0].mail_provider, 'mailpit');
  assert.equal(started[0].quantity, 3);
});

test('publicMailpitView has no default receiving domain', () => {
  const view = publicMailpitView(DEFAULTS());
  assert.deepEqual(view.domains, []);
  assert.equal(view.ready, false);
});

test.after(() => {
  try { db.close(); } catch {}
  fs.rmSync(temp, { recursive: true, force: true });
});
