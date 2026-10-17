'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProxyLine } = require('../src/utils/proxyParser');

test('scheme-less userinfo proxy keeps every CliProxy field and defaults to HTTP', () => {
  const parsed = parseProxyLine(
    'demo-region-GB-sid-Ab12Cd34-t-5:test-pass@proxy.example.test:3010',
    '支付',
  );

  assert.deepEqual(parsed, {
    group_name: '支付',
    proxy_type: 'http',
    host: 'proxy.example.test',
    port: 3010,
    username: 'demo-region-GB-sid-Ab12Cd34-t-5',
    password: 'test-pass',
    status: '可用',
  });
});

test('an explicit scheme remains authoritative for proxy type', () => {
  const parsed = parseProxyLine(
    'socks5://demo-region-GB-sid-Z9y8X7w6-t-10:test-pass@proxy.example.test:3010',
  );

  assert.equal(parsed.proxy_type, 'socks5');
  assert.equal(parsed.username, 'demo-region-GB-sid-Z9y8X7w6-t-10');
  assert.equal(parsed.password, 'test-pass');
  assert.equal(parsed.host, 'proxy.example.test');
  assert.equal(parsed.port, 3010);
});
