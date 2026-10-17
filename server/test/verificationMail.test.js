const test = require('node:test');
const assert = require('node:assert/strict');
const { extractVerificationMessage, looksLikeChatgptVerification } = require('../src/utils/verificationMail');
const { extractVerification } = require('../src/automation/flows/mailbox');

const ENGLISH_TM_MAIL = {
  from: 'ChatGPT <noreply@tm.openai.com>',
  subject: 'Your temporary ChatGPT verification code',
  text: [
    'Enter this temporary verification code to continue:',
    '405780',
    'Please ignore this email if this wasn’t you trying to create a ChatGPT account.',
    '',
    'Best,',
    'The ChatGPT team',
    'https://url3243.email.openai.com/ls/click?upn=ABCDEFGauthXYZ3243123456',
  ].join('\n'),
};

const HTML_VARIANT = {
  from: 'ChatGPT <noreply@openai.com>',
  subject: 'Your temporary ChatGPT verification code',
  html: `<html><body>
    <img src="https://url3243.email.openai.com/wf/open?upn=trackingauth123456" />
    <p>Enter this temporary verification code to continue:</p>
    <td style="font-size:32px;font-weight:bold">405780</td>
    <a href="https://url3243.email.openai.com/ls/click?upn=clickauth654321">Help center</a>
  </body></html>`,
};

test('extracts 405780 from the live English tm.openai.com ChatGPT mail', () => {
  const hit = extractVerificationMessage(ENGLISH_TM_MAIL);
  assert.equal(hit.code, '405780');
  assert.equal(hit.url, '');
  assert.equal(looksLikeChatgptVerification(ENGLISH_TM_MAIL), true);
});

test('extractVerification shares the same 405780 fixture', () => {
  assert.equal(extractVerification([ENGLISH_TM_MAIL]).code, '405780');
});

test('does not treat url3243 tracking tokens as the OTP', () => {
  const hit = extractVerificationMessage({
    from: 'ChatGPT <noreply@tm.openai.com>',
    subject: 'Your temporary ChatGPT verification code',
    html: HTML_VARIANT.html,
  });
  assert.equal(hit.code, '405780');
  assert.notEqual(hit.code, '3243');
  assert.equal(/email\.openai\.com/.test(hit.url), false);
});

test('reads a 6-digit code from a large HTML table cell', () => {
  assert.equal(extractVerificationMessage(HTML_VARIANT).code, '405780');
});

test('still matches classic noreply@openai.com and Chinese subjects', () => {
  assert.equal(
    extractVerificationMessage({
      from: 'OpenAI <noreply@openai.com>',
      subject: 'ChatGPT 验证码',
      text: '您的验证码是 246801，请勿泄露。',
    }).code,
    '246801'
  );
});
