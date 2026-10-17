const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectPullSuffixes,
  classifyAliasAddStatus,
  suffixCatalog,
} = require('../src/utils/mailcomDomains');
const { parseAliasAddResult, summarizeMailcomBody } = require('../src/utils/mailcom');

test('pull pool intersects enabled suffixes with the live listDomains catalog', () => {
  const selected = selectPullSuffixes({
    enabled: ['dr.com', 'programmer.com', 'usa.com', 'clubmember.org'],
    live: ['usa.com', 'programmer.com', 'dr.com'],
    existing: ['mom@mail.com', 'old@dr.com'],
  });
  assert.deepEqual(selected.blocked, ['clubmember.org']);
  assert.deepEqual(selected.fallback, ['clubmember.org']);
  assert.deepEqual(selected.pool, ['programmer.com', 'usa.com', 'dr.com', 'clubmember.org']);
  assert.equal(selected.usedLiveCatalog, true);
});

test('empty live catalog falls back to enabled suffixes instead of blocking the fill', () => {
  const selected = selectPullSuffixes({
    enabled: ['dr.com', 'usa.com'],
    live: [],
    existing: ['old@dr.com'],
  });
  assert.equal(selected.usedLiveCatalog, false);
  assert.deepEqual(selected.blocked, []);
  assert.deepEqual(selected.pool, ['usa.com', 'dr.com']);
});

test('HTTP 400 skips the suffix while 409 still means the mailbox is full', () => {
  assert.equal(classifyAliasAddStatus(201), 'ok');
  assert.equal(classifyAliasAddStatus(400), 'skip_suffix');
  assert.equal(classifyAliasAddStatus(409), 'full');
});

test('summarizes mail.com 400 JSON bodies without keeping the raw payload', () => {
  assert.equal(
    summarizeMailcomBody('{"message":"domain not allowed","trace":"secret-id"}'),
    'domain not allowed'
  );
  assert.equal(
    summarizeMailcomBody('{"type":"urn:problem:mam:cats:invalid-request-data"}'),
    'invalid-request-data'
  );
  assert.equal(parseAliasAddResult(400).status, 400);
  assert.equal(parseAliasAddResult({ status: 400, body: '{"error":"not permitted"}' }).body, 'not permitted');
});

test('suffix catalog exposes unavailable stats for one-click disable', () => {
  const cat = suffixCatalog({
    enabled_suffixes: ['dr.com', 'programmer.com'],
    disabled_suffixes: [],
    unavailable_suffixes: {
      'programmer.com': {
        count: 4,
        reason: 'http_400',
        last_error: 'domain not allowed',
      },
    },
  });
  const blocked = cat.items.find((item) => item.suffix === 'programmer.com');
  assert.equal(blocked.enabled, true);
  assert.equal(blocked.unavailable, true);
  assert.equal(blocked.unavailable_count, 4);
  assert.equal(cat.unavailable_enabled_count, 1);
});
