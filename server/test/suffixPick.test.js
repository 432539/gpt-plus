const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickPullSuffix,
  pickWeightedRandom,
  aggregateSuffixStats,
  selectUnusedForRegister,
  registerWeight,
  MIN_SUCCESS_SAMPLES,
} = require('../src/utils/suffixPick');
const { PROGRESS } = require('../src/utils/accountProgress');

test('pull suffix picker is not pinned to the first enabled domain', () => {
  const pool = ['dr.com', 'usa.com', 'toke.com'];
  const usage = new Map([['dr.com', 8], ['usa.com', 1], ['toke.com', 1]]);
  const picks = new Set();
  for (let i = 0; i < 80; i += 1) {
    picks.add(pickPullSuffix(pool, usage, Math.random));
  }
  assert.ok(picks.size >= 2, `expected multiple suffixes, got ${[...picks].join(',')}`);
  const seq = [];
  let cursor = 0;
  const values = [0.01, 0.4, 0.85, 0.2, 0.7, 0.95];
  for (let i = 0; i < 12; i += 1) {
    seq.push(pickPullSuffix(pool, usage, () => values[cursor++ % values.length]));
  }
  assert.ok(new Set(seq).size >= 2);
  assert.ok(seq.some((suffix) => suffix !== 'dr.com'));
});

test('register picker prefers higher trial+extract success but still randomizes', () => {
  const unused = [
    { id: 1, address: 'a@dr.com' },
    { id: 2, address: 'b@dr.com' },
    { id: 3, address: 'c@usa.com' },
    { id: 4, address: 'd@toke.com' },
  ];
  const stats = aggregateSuffixStats({
    emails: unused.map((row) => ({ address: row.address, status: '未使用', is_mother: 0 })),
    accounts: [
      ...Array.from({ length: 6 }, (_, i) => ({
        email: `ok${i}@usa.com`, has_trial: 1, progress: PROGRESS.EXTRACTED, extracted_at: '2026-08-21 00:00:00',
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        email: `bad${i}@dr.com`, has_trial: 0, progress: PROGRESS.REGISTERED, extracted_at: '',
      })),
    ],
  });
  const usa = stats.find((item) => item.suffix === 'usa.com');
  const dr = stats.find((item) => item.suffix === 'dr.com');
  assert.equal(usa.trial_yes, 6);
  assert.equal(usa.trial_detected, 6);
  assert.equal(usa.extract_ok, 6);
  assert.equal(usa.trial_rate, 1);
  assert.equal(dr.trial_rate, 0);
  assert.ok(registerWeight(usa, '', 2) > registerWeight(dr, '', 2));
  assert.ok(usa.account_count >= MIN_SUCCESS_SAMPLES);

  const picked = [];
  for (let i = 0; i < 24; i += 1) {
    picked.push(selectUnusedForRegister(unused, stats, 1, Math.random)[0].address.split('@')[1]);
  }
  assert.ok(new Set(picked).size >= 2);
  const batch = selectUnusedForRegister(unused, stats, 3, () => 0.1);
  assert.equal(batch.length, 3);
  assert.equal(new Set(batch.map((row) => row.address)).size, 3);
});

test('without stats, pick is uniform among enabled suffixes', () => {
  const items = ['dr.com', 'usa.com'];
  const counts = { 'dr.com': 0, 'usa.com': 0 };
  for (let i = 0; i < 200; i += 1) {
    counts[pickWeightedRandom(items, () => 1, Math.random)] += 1;
  }
  assert.ok(counts['dr.com'] > 40);
  assert.ok(counts['usa.com'] > 40);
});
