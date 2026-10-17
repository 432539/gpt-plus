const test = require('node:test');
const assert = require('node:assert/strict');
const { jwtMetadata } = require('../src/utils/accountJob');

test('jwtMetadata stores token exp as YYYY-MM-DD HH:mm:ss without timezone conversion', () => {
  const exp = Date.UTC(2026, 7, 29, 14, 30, 8) / 1000;
  const token = `x.${Buffer.from(JSON.stringify({
    exp,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc-1' },
  })).toString('base64url')}.x`;
  const meta = jwtMetadata(token);
  assert.equal(meta.expiresAt, '2026-08-29 14:30:08');
  assert.equal(meta.planType, 'Plus');
  assert.equal(meta.accountId, 'acc-1');
});
