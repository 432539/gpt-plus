const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-plus-mail-otp-'));
process.env.GPT_PLUS_DB_PATH = path.join(temp, 'test.db');

const { pollMailboxOtp, extract } = require('../src/utils/mailOtp');

test('retries transient inbox errors and then returns the OTP', async () => {
  let attempts = 0;
  const logs = [];
  const result = await pollMailboxOtp({
    lockKey: 'retry-success',
    timeoutMs: 100,
    intervalMs: 1,
    minIntervalMs: 1,
    fetchInboxFn: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('halogin 换 sid 失败');
        error.retryable = true;
        throw error;
      }
      return { mails: [{ id: '1', subject: 'Your verification code is 123456' }] };
    },
    fetchBodyFn: async () => '',
    sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message, level) => logs.push({ message, level }),
  });

  assert.equal(result.code, '123456');
  assert.equal(attempts, 3);
  assert.ok(logs.some((entry) => entry.level === 'warning' && /登录失败|换 sid/.test(entry.message)));
});

test('exhausts transient retries with one final timeout and no noisy warnings', async () => {
  const logs = [];
  let finalErrors = 0;
  try {
    await pollMailboxOtp({
      lockKey: 'retry-timeout',
      timeoutMs: 12,
      intervalMs: 1,
      minIntervalMs: 1,
      fetchInboxFn: async () => {
        throw new Error('ETIMEDOUT while reading inbox');
      },
      fetchBodyFn: async () => '',
      sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message, level) => logs.push({ message, level }),
    });
  } catch (error) {
    finalErrors += 1;
    assert.match(error.message, /等待验证邮件超时/);
    assert.match(error.message, /ETIMEDOUT/);
  }

  assert.equal(finalErrors, 1);
  assert.equal(logs.some((entry) => ['warn', 'warning', 'error'].includes(entry.level)), false);
});

test('surfaces retryable mail.com login/assistance errors instead of a silent wait loop', async () => {
  const logs = [];
  await assert.rejects(
    pollMailboxOtp({
      timeoutMs: 12,
      intervalMs: 1,
      minIntervalMs: 1,
      fetchInboxFn: async () => {
        const error = new Error('mail.com 登录被重定向（HTTP 302 → support.mail.com/assistance）');
        error.retryable = true;
        throw error;
      },
      fetchBodyFn: async () => '',
      sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message, level) => logs.push({ message, level }),
    }),
    /等待验证邮件超时.*assistance/,
  );
  assert.ok(logs.some((entry) => entry.level === 'warning' && /登录失败/.test(entry.message)));
  assert.equal(logs.some((entry) => entry.message === '等待 mail.com 验证邮件…'), false);
});

test('fails terminal mailbox credentials immediately', async () => {
  let attempts = 0;
  await assert.rejects(
    pollMailboxOtp({
      lockKey: 'terminal',
      timeoutMs: 100,
      intervalMs: 1,
      minIntervalMs: 1,
      fetchInboxFn: async () => {
        attempts += 1;
        const error = new Error('mail.com 账号或密码错误');
        error.code = 'MAILCOM_BAD_CREDENTIALS';
        throw error;
      },
      fetchBodyFn: async () => '',
      sleepFn: async () => {},
    }),
    /邮箱读取失败.*账号或密码错误/
  );
  assert.equal(attempts, 1);
});

test('five mailbox workers poll independently when aliases share a mother', async () => {
  let active = 0;
  let maxActive = 0;
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, (_, worker) =>
      pollMailboxOtp({
        lockKey: 'shared-mother',
        timeoutMs: 100,
        intervalMs: 1,
        minIntervalMs: 1,
        fetchInboxFn: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { mails: [{ id: String(worker), subject: `Verification code: 12345${worker}` }] };
        },
        fetchBodyFn: async () => '',
      })
    )
  );

  assert.equal(maxActive, 5);
  assert.deepEqual(outcomes.map((result) => result.code), ['123450', '123451', '123452', '123453', '123454']);
});

const ENGLISH_TM_BODY = [
  'Enter this temporary verification code to continue:',
  '405780',
  'Please ignore this email if this wasn’t you trying to create a ChatGPT account.',
  '',
  'Best,',
  'The ChatGPT team',
  'https://url3243.email.openai.com/ls/click?upn=ABCDEFGauthXYZ3243123456',
].join('\n');

test('extracts 405780 from English tm.openai.com ChatGPT mail and ignores tracking URLs', () => {
  const hit = extract({
    from: 'ChatGPT <noreply@tm.openai.com>',
    subject: 'Your temporary ChatGPT verification code',
    text: ENGLISH_TM_BODY,
    html: `<p>Enter this temporary verification code to continue:</p><span style="font-size:32px">405780</span><a href="https://url3243.email.openai.com/ls/click?upn=x">x</a>`,
  });
  assert.equal(hit.code, '405780');
  assert.equal(hit.url, '');
});

test('pollMailboxOtp recognizes the English ChatGPT verification mail', async () => {
  const result = await pollMailboxOtp({
    timeoutMs: 50,
    intervalMs: 1,
    minIntervalMs: 1,
    fetchInboxFn: async () => ({
      mails: [{
        id: 'live-1',
        from: 'ChatGPT <noreply@tm.openai.com>',
        subject: 'Your temporary ChatGPT verification code',
        date: new Date().toISOString(),
      }],
    }),
    fetchBodyFn: async () => ENGLISH_TM_BODY,
    sleepFn: async () => {},
  });
  assert.equal(result.code, '405780');
});

test('timeout with a readable empty inbox marks MAILBOX_OTP_NOT_RECEIVED', async () => {
  await assert.rejects(
    pollMailboxOtp({
      expectedTo: 'child@safrica.com',
      timeoutMs: 12,
      intervalMs: 1,
      minIntervalMs: 1,
      fetchInboxFn: async () => ({ mails: [] }),
      fetchBodyFn: async () => '',
      sleepFn: async () => {},
    }),
    (error) => error.code === 'MAILBOX_OTP_NOT_RECEIVED' && /未收到验证邮件/.test(error.message),
  );
});

test('ChatGPT OTP for a different alias does not satisfy this child', async () => {
  await assert.rejects(
    pollMailboxOtp({
      expectedTo: 'child@safrica.com',
      timeoutMs: 12,
      intervalMs: 1,
      minIntervalMs: 1,
      fetchInboxFn: async () => ({
        mails: [{
          id: 'other-1',
          from: 'ChatGPT <noreply@tm.openai.com>',
          subject: 'Your temporary ChatGPT verification code',
          to: [{ address: 'someone-else@safrica.com' }],
        }],
      }),
      fetchBodyFn: async () => ENGLISH_TM_BODY,
      sleepFn: async () => {},
    }),
    (error) => error.code === 'MAILBOX_OTP_NOT_RECEIVED' && error.otherAliasChatgpt >= 1,
  );
});

test('IMAP/fetch errors stay MAILBOX_OTP_FETCH_FAILED and are not treated as unused mailbox', async () => {
  await assert.rejects(
    pollMailboxOtp({
      expectedTo: 'child@safrica.com',
      timeoutMs: 12,
      intervalMs: 1,
      minIntervalMs: 1,
      fetchInboxFn: async () => {
        throw new Error('ETIMEDOUT while reading inbox');
      },
      fetchBodyFn: async () => '',
      sleepFn: async () => {},
    }),
    (error) => error.code === 'MAILBOX_OTP_FETCH_FAILED' && /等待验证邮件超时/.test(error.message),
  );
});

test('matching ChatGPT OTP for this alias is returned and is not a timeout', async () => {
  const result = await pollMailboxOtp({
    expectedTo: 'child@safrica.com',
    timeoutMs: 50,
    intervalMs: 1,
    minIntervalMs: 1,
    fetchInboxFn: async () => ({
      mails: [{
        id: 'mine-1',
        from: 'ChatGPT <noreply@tm.openai.com>',
        subject: 'Your temporary ChatGPT verification code',
        to: [{ address: 'child@safrica.com' }],
      }],
    }),
    fetchBodyFn: async () => ENGLISH_TM_BODY,
    sleepFn: async () => {},
  });
  assert.equal(result.code, '405780');
});

