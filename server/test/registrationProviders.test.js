'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDynamicProxy,
  ProxyExitLeaseManager,
} = require('../src/utils/dynamicProxy');
const { normalizeProxyGeo, detectProxyGeo, clearProxyGeoCache } = require('../src/utils/proxyGeo');
const {
  createMailChannel,
  createPhoneChannel,
  parseImportedMailboxList,
  settleChannel,
} = require('../src/automation/channels/providers');
const { continueAuthorize } = require('../src/automation/flows/auth-continue');

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'text/plain' },
  text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  json: async () => typeof body === 'string' ? JSON.parse(body) : body,
});

test('dynamic proxy builders match all supported sticky username contracts', () => {
  const providers = {
    '1024proxy': { username: 'U', password: 'P', sticky_minutes: 30, session_id: 'SESSION_1' },
    b2proxy: { username: 'U', password: 'P', sticky_minutes: 20, session_id: '12345678' },
    cliproxy: { username: 'U', password: 'P', sticky_minutes: 15, session_id: 'Cli_1234' },
    iprocket: { username: 'U', password: 'P', sticky_minutes: 5, session_id: '123456789' },
  };
  assert.equal(buildDynamicProxy('us', { active_pool: '1024proxy', providers }).username, 'U-region-US-sid-SESSION_1-t-30');
  assert.equal(buildDynamicProxy('us', { active_pool: 'b2proxy', providers }).username, 'U-zone-custom-region-US-session-12345678-sessTime-20-sessAuto-1');
  assert.equal(buildDynamicProxy('jp', { active_pool: 'cliproxy', providers }).username, 'U-region-JP-sid-Cli_1234-t-15');
  assert.equal(buildDynamicProxy('gb', { active_pool: 'iprocket', providers }).username, 'U-res-GB-Lsid-123456789-TTL-300');
  assert.equal(buildDynamicProxy('de', { active_pool: '1024proxy', providers }, 'job-1').session_id,
    buildDynamicProxy('de', { active_pool: '1024proxy', providers }, 'job-1').session_id);
});

test('proxy geo and egress lease collision are fully mockable', async () => {
  clearProxyGeoCache();
  let requests = 0;
  const session = {
    request: async () => {
      requests += 1;
      return { ok: true, data: { ip: '203.0.113.9', country: 'US', currency: 'USD' } };
    },
  };
  const proxy = { dynamic: true, region: 'US', proxy_type: 'socks5', host: 'proxy.test', port: 1, username: 'u', password: 'p' };
  const firstGeo = await detectProxyGeo(session, proxy, { urls: ['https://fixture.invalid/'] });
  const secondGeo = await detectProxyGeo(session, proxy, { urls: ['https://fixture.invalid/'] });
  assert.equal(firstGeo.country, 'US');
  assert.equal(secondGeo.cached, true);
  assert.equal(requests, 1);
  assert.deepEqual(normalizeProxyGeo({ query: '203.0.113.9', countryCode: 'us' }).country, 'US');

  const leases = new ProxyExitLeaseManager({ probe: async () => firstGeo });
  const claimed = await leases.claim({}, proxy, { country: 'US', jobId: 'a' });
  await assert.rejects(
    leases.claim({}, proxy, { country: 'US', jobId: 'b' }),
    error => error.code === 'PROXY_EXIT_COLLISION',
  );
  claimed.release();
  (await leases.claim({}, proxy, { country: 'US', jobId: 'b' })).release();
});

test('imported URL/IMAP/mail.com parsing and CF Worker transport stay offline', async () => {
  const parsed = parseImportedMailboxList([
    'url----url@example.test----https://smsbower.page/mail/1',
    'imap@example.test----imap.example.test:993----app-pass',
    'mailcom----owner@mail.com----mail-pass',
  ].join('\n'));
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.entries.map(item => item.kind), ['url', 'imap', 'mailcom']);
  const imap = createMailChannel('imported', {}, { entry: parsed.entries[1] }, {
    imapFactory: () => ({
      connect: async () => {},
      getMailboxLock: async () => ({ release() {} }),
      search: async () => [1],
      fetch: async function* () {
        yield { source: Buffer.from('OpenAI verification code: 456789'), envelope: { subject: 'Verify' } };
      },
      logout: async () => {},
    }),
  });
  assert.equal((await imap.wait({ wait: async () => {} }, {}, {}, { timeoutMs: 10000 })).code, '456789');

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/admin/new_address')) return response({ email: 'worker@example.test' });
    return response({ results: [{ subject: 'OpenAI verification', content: 'Your code is 123456' }] });
  };
  const channel = createMailChannel('cfworker', {
    cfworker_mail: { api_url: 'https://worker.fixture', api_key: 'secret', domain: 'example.test' },
  }, {}, { fetchImpl });
  assert.equal((await channel.acquire()).email, 'worker@example.test');
  assert.equal((await channel.wait({ wait: async () => {} }, {}, {}, { timeoutMs: 10000 })).code, '123456');
  assert.equal(await settleChannel(channel, true), true);
  assert.ok(calls.every(call => !call.url.includes('secret')));
});

test('phone channel uses unified acquire/code/finish/cancel lifecycle without exposing key', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const action = parsed.searchParams.get('action');
    if (action === 'getNumberV2') return response({ activationId: 'order-1', phoneNumber: '447700900123' });
    if (action === 'getStatus') return response('STATUS_OK:654321');
    if (action === 'setStatus') return response('ACCESS_READY');
    throw new Error(`unexpected action ${action}`);
  };
  const settings = {
    sms: { api_url: 'https://sms.fixture/stubs/handler_api.php', api_key: 'legacy-secret', country: 'gb', product: 'dr' },
  };
  const channel = createPhoneChannel('herosms', settings, {}, { fetchImpl });
  assert.equal(await channel.acquire(), '+447700900123');
  assert.equal(await channel.code(), '654321');
  assert.equal(await channel.finish(), true);
  assert.equal(calls.at(-1).searchParams.get('status'), '6');
  assert.ok(calls.every(url => url.searchParams.get('api_key') === 'legacy-secret'));
});

test('paid mail and phone settlement HTTP calls receive the abort signal', async () => {
  const mailSignals = [];
  const mail = createMailChannel('smsbower', {
    smsbower: { api_url: 'https://mail.fixture', api_key: 'mail-key' },
  }, {}, {
    fetchImpl: async (url, options = {}) => {
      mailSignals.push(options.signal);
      return String(url).includes('getActivation')
        ? response({ status: 1, mail: 'paid@example.test', mailId: 'mail-1' })
        : response({ status: 1 });
    },
  });
  await mail.acquire();
  const mailController = new AbortController();
  await mail.finish(null, { signal: mailController.signal });
  assert.equal(mailSignals.at(-1), mailController.signal);

  const phoneSignals = [];
  const phone = createPhoneChannel('smsbower', {
    smsbower: {
      api_url: 'https://sms.fixture/stubs/handler_api.php',
      api_key: 'sms-key', country: 'JP', product: 'openai',
    },
  }, {}, {
    fetchImpl: async (url, options = {}) => {
      phoneSignals.push(options.signal);
      return new URL(url).searchParams.get('action') === 'getNumberV2'
        ? response({ activationId: 'phone-1', phoneNumber: '819012345678' })
        : response('ACCESS_READY');
    },
  });
  await phone.acquire();
  const phoneController = new AbortController();
  await phone.finish(null, { signal: phoneController.signal });
  assert.equal(phoneSignals.at(-1), phoneController.signal);
});

test('auth continuation replaces a rejected number inside the same browser transaction', async () => {
  let current = 'https://auth.openai.com/add-phone';
  let sends = 0;
  let acquired = 0;
  const cancellations = [];
  const session = {
    page: { url: () => current },
    replaceRoute: async url => { current = url; },
    request: async (url) => {
      if (url.endsWith('/add-phone/send')) {
        sends += 1;
        if (sends === 1) {
          return { ok: false, status: 400, data: { message: 'phone number is already in use' } };
        }
        return { ok: true, status: 200, data: { page: { type: 'phone_otp_send' } } };
      }
      if (url.endsWith('/phone-otp/validate')) {
        return { ok: true, status: 200, data: { continue_url: 'http://localhost:1455/auth/callback?code=ok&state=S' } };
      }
      throw new Error(`unexpected request ${url}`);
    },
  };
  const result = await continueAuthorize(session, {
    state: 'S',
    phone: {
      acquire: async () => `+44770090012${++acquired}`,
      cancel: async (_session, meta) => cancellations.push(meta.reason),
      code: async () => '123456',
    },
  });
  assert.equal(result.code, 'ok');
  assert.equal(acquired, 2);
  assert.deepEqual(cancellations, ['already_in_use']);
});
