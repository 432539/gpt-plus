'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDomainList } = require('../src/utils/cfMailDns');

test('parseDomainList accepts lines, commas and mixed punctuation', () => {
  assert.deepEqual(
    parseDomainList('gamma.example\nmail.example.com, foo.bar;baz.site'),
    ['gamma.example', 'mail.example.com', 'foo.bar', 'baz.site'],
  );
});

test('parseDomainList keeps multi-part suffixes used by CF mail', () => {
  assert.deepEqual(parseDomainList('ns.example app.example'), ['ns.example', 'app.example']);
});

test('parseDomainList drops junk and duplicates', () => {
  assert.deepEqual(parseDomainList('@Gamma.Example.\ngamma.example\nnot a domain\nhttps://x'), ['gamma.example']);
});
