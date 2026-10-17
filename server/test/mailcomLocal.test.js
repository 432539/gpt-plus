const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GIVEN_NAMES,
  MAILCOM_LOCAL_MAX_LENGTH,
  SURNAMES,
  randomLocal,
} = require('../src/utils/mailcom');

test('randomLocal creates readable mail.com-safe name aliases', () => {
  const samples = Array.from({ length: 300 }, () => randomLocal());
  const knownNames = [...GIVEN_NAMES, ...SURNAMES];

  for (const local of samples) {
    assert.match(local, /^[a-z0-9]+(?:\.[a-z0-9]+)?$/);
    assert.ok(local.length >= 5 && local.length <= MAILCOM_LOCAL_MAX_LENGTH);
    assert.match(local, /\d{2,4}$/);
    assert.ok(knownNames.some((name) => local.includes(name)), `${local} should contain a common English name`);
    assert.ok(GIVEN_NAMES.some((name) => local.startsWith(name)), `${local} should not be pure gibberish`);
  }

  assert.ok(new Set(samples).size > 250, 'samples should have useful random variation');
  assert.ok(samples.some((local) => local.includes('.')), 'some aliases should use given.surname form');
  assert.ok(samples.some((local) => !local.includes('.')), 'some aliases should use compact form');
});
