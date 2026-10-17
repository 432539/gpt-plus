'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  freshStickyProxy,
  maskStickyUsername,
} = require('../src/utils/stickyProxy');

const CLIPROXY_SIDS = [
  'Ab12Cd34',
  'zY98Xw76',
  '0aB1cD2E',
  'Q7r8S9t0',
];

test('CliProxy refresh replaces only each alphanumeric SID value', () => {
  for (const previousSid of CLIPROXY_SIDS) {
    const original = {
      id: 42,
      group_name: '支付',
      proxy_type: 'socks5',
      host: 'proxy.example.test',
      port: 3010,
      username: `demo-region-GB-sid-${previousSid}-t-5`,
      password: 'test-pass',
      source: 'test-fixture',
    };

    const refreshed = freshStickyProxy(original);
    const match = refreshed.username.match(
      /^demo-region-GB-sid-([A-Za-z0-9]{8})-t-5$/,
    );

    assert.ok(match, refreshed.username);
    assert.notEqual(match[1], previousSid);
    assert.equal(original.username, `demo-region-GB-sid-${previousSid}-t-5`);
    const { username: _oldUsername, ...originalFields } = original;
    const { username: _newUsername, ...refreshedFields } = refreshed;
    assert.deepEqual(refreshedFields, originalFields);
  }
});

test('CliProxy refresh keeps hyphenated SID and -t-* suffix', () => {
  const refreshed = freshStickyProxy({
    username: 'clip-user-region-GB-sid-d-dc4mwc-t-30',
  });
  assert.match(refreshed.username, /^clip-user-region-GB-sid-[A-Za-z0-9_-]+-t-30$/);
  assert.notEqual(refreshed.username, 'clip-user-region-GB-sid-d-dc4mwc-t-30');
  assert.doesNotMatch(refreshed.username, /-session-\d+$/);
});

test('CliProxy refresh preserves arbitrary country and sticky minutes', () => {
  const refreshed = freshStickyProxy({
    username: 'demo-region-DE-sid-A1b2C3d4-t-10',
  });

  assert.match(
    refreshed.username,
    /^demo-region-DE-sid-[A-Za-z0-9]{8}-t-10$/,
  );
});

test('IPRocket refresh replaces only Lsid and preserves TTL', () => {
  const original = {
    id: 'iprocket-fixture',
    group_name: '支付',
    proxy_type: 'socks5',
    host: 'proxy.example.test',
    port: 9595,
    username: 'demo-res-GB-Lsid-A1b2C3d4-TTL-300',
    password: 'test-pass',
  };

  const refreshed = freshStickyProxy(original);
  assert.match(
    refreshed.username,
    /^demo-res-GB-Lsid-[0-9]{9}-TTL-300$/,
  );
  const { username: _oldUsername, ...originalFields } = original;
  const { username: _newUsername, ...refreshedFields } = refreshed;
  assert.deepEqual(refreshedFields, originalFields);
});

test('sticky identity masking preserves provider suffixes', () => {
  assert.equal(
    maskStickyUsername('demo-region-GB-sid-Ab12Cd34-t-5'),
    'demo-region-GB-sid-*-t-5',
  );
  assert.equal(
    maskStickyUsername('demo-res-GB-Lsid-A1b2C3d4-TTL-300'),
    'demo-res-GB-Lsid-*-TTL-300',
  );
});
