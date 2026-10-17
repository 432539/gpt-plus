'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitMailMix,
  cfMailCatalog,
  enabledCfDomains,
  cfMailReady,
  pickCfMailDomain,
} = require('../src/utils/cfMail');

test('splitMailMix keeps a 5:5 batch at half mail.com and half CF', () => {
  assert.deepEqual(splitMailMix(10, 5, 5), { mailcom: 5, cfworker: 5 });
  assert.deepEqual(splitMailMix(11, 5, 5), { mailcom: 5, cfworker: 6 });
  assert.deepEqual(splitMailMix(10, 1, 0), { mailcom: 10, cfworker: 0 });
  assert.deepEqual(splitMailMix(10, 0, 1), { mailcom: 0, cfworker: 10 });
});

test('CF catalog honors disabled suffixes like mail.com denylist', () => {
  const settings = {
    cfworker_mail: {
      api_url: 'https://worker.example',
      api_key: 'secret',
      disabled_suffixes: ['alpha.example'],
      domains: [
        { domain: 'alpha.example', enabled: true },
        { domain: 'beta.example', enabled: true },
      ],
    },
  };
  const catalog = cfMailCatalog(settings);
  assert.equal(catalog.find((item) => item.domain === 'alpha.example').enabled, false);
  assert.ok(enabledCfDomains(settings).includes('beta.example'));
  assert.ok(!enabledCfDomains(settings).includes('alpha.example'));
  assert.equal(pickCfMailDomain(settings, 'beta.example'), 'beta.example');
  assert.equal(cfMailReady(settings), true);
});
