const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REGISTER_ACCOUNT_CREATION_REJECTED,
  PASSWORD_SUBMISSION_STAGE,
  isExactAccountCreationRejectedMessage,
  isAccountCreationRejectedMessage,
  isAccountCreationRejectedFailure,
} = require('../src/automation/lib/account-creation-reject');
const { inferHeadlessFailureCode } = require('../src/automation/flows/register-headless');
const { classifyRegisterFailure } = require('../src/automation/lib/retry-policy');

test('account-creation reject matches OpenAI inline text even with extra alerts', () => {
  assert.equal(isExactAccountCreationRejectedMessage('Failed to create account. Please try again'), true);
  assert.equal(isExactAccountCreationRejectedMessage('  FAILED to CREATE account!!! Please try AGAIN... '), true);
  assert.equal(isExactAccountCreationRejectedMessage('Invalid request. Please try again.'), false);
  assert.equal(
    isAccountCreationRejectedMessage('密码提交后页面未进入验证码步骤：Failed to create account. Please try again | Continue'),
    true
  );
  assert.equal(isAccountCreationRejectedMessage('password page timed out'), false);
});

test('headless password stall with OpenAI reject text becomes terminal account-creation failure', () => {
  assert.equal(
    inferHeadlessFailureCode('REGISTER_HEADLESS_PASSWORD_STALLED', 'Failed to create account. Please try again'),
    REGISTER_ACCOUNT_CREATION_REJECTED
  );
  assert.equal(
    inferHeadlessFailureCode('REGISTER_HEADLESS_PASSWORD_STALLED', '请稍后再试'),
    'REGISTER_HEADLESS_PASSWORD_STALLED'
  );
  assert.equal(
    isAccountCreationRejectedFailure({
      code: 'REGISTER_HEADLESS_PASSWORD_STALLED',
      inline_error: 'Failed to create account. Please try again',
      stage: PASSWORD_SUBMISSION_STAGE,
    }),
    true
  );
  assert.equal(
    isAccountCreationRejectedFailure({
      code: 'REGISTER_HEADLESS_PASSWORD_STALLED',
      message: '密码提交后页面未进入验证码步骤',
    }),
    false
  );
  const verdict = classifyRegisterFailure({ code: REGISTER_ACCOUNT_CREATION_REJECTED });
  assert.equal(verdict.terminal, true);
  assert.equal(verdict.retryable, false);
});
