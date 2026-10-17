const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COUNTRY_IDS,
  DEFAULT_API_URL,
  SmsBowerClient,
  normalizeSmsUrl,
  resolveSmsCountry,
  resolveSmsService,
  resolveSmsbowerConfig,
} = require('../src/utils/smsbower');

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    const params = Object.fromEntries(parsed.searchParams.entries());
    calls.push({ action: params.action, status: params.status, country: params.country, service: params.service, id: params.id });
    const result = await handler(params, parsed);
    if (result && typeof result === 'object' && result.body != null) {
      return {
        status: result.status || 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? result.contentType || 'text/plain' : '') },
        text: async () => String(result.body),
      };
    }
    return {
      status: 200,
      headers: { get: () => 'text/plain' },
      text: async () => String(result),
    };
  };
  return { fetchImpl, calls };
}

test('SMSBower maps GB/UK to country 16 and paypal/openai to service ts', () => {
  assert.equal(COUNTRY_IDS.GB, 16);
  assert.equal(COUNTRY_IDS.UK, 16);
  assert.equal(COUNTRY_IDS.CL, 151);
  assert.equal(resolveSmsCountry('uk'), 'GB');
  assert.equal(resolveSmsCountry('usa'), 'GB');
  assert.equal(resolveSmsCountry('us'), 'US');
  assert.equal(resolveSmsCountry('CL'), 'CL');
  assert.equal(resolveSmsCountry('chile'), 'CL');
  assert.equal(resolveSmsCountry('智利'), 'CL');
  assert.equal(resolveSmsService('paypal'), 'ts');
  assert.equal(resolveSmsService('openai'), 'ts');
  assert.equal(resolveSmsService('chatgpt'), 'ts');
  assert.equal(normalizeSmsUrl('https://smsbower.app'), `${DEFAULT_API_URL}`);
});

test('resolveSmsbowerConfig requires a saved key and never invents one', () => {
  assert.throws(() => resolveSmsbowerConfig({}), /请先在设置中配置 SMSBower API Key/);
  const cfg = resolveSmsbowerConfig({
    api_key: 'test-sms-key',
    api_url: 'https://smsbower.page',
    country: 'gb',
    product: 'openai',
  });
  assert.equal(cfg.country, 'GB');
  assert.equal(cfg.service, 'ts');
  assert.match(cfg.apiUrl, /handler_api\.php$/);
  assert.equal(cfg.apiKey, 'test-sms-key');
});

test('reserveNumber parses ACCESS_NUMBER and waitForCode reads STATUS_OK', async () => {
  const { fetchImpl, calls } = mockFetch(async (params) => {
    if (params.action === 'getNumberV2') {
      assert.equal(params.country, '16');
      assert.equal(params.service, 'ts');
      return 'ACCESS_NUMBER:act-1:447700900123';
    }
    if (params.action === 'getStatus') return 'STATUS_OK:654321';
    if (params.action === 'setStatus') return 'ACCESS_CANCEL';
    return 'ERROR';
  });
  const client = new SmsBowerClient({
    apiKey: 'test-sms-key',
    country: 'GB',
    service: 'ts',
    apiUrl: DEFAULT_API_URL,
    fetchImpl,
    pollInterval: 1,
    timeoutSeconds: 30,
  });
  const reserved = await client.reserveNumber();
  assert.equal(reserved.activationId, 'act-1');
  assert.equal(reserved.phone, '+447700900123');
  const code = await client.waitForCode(30);
  assert.equal(code, '654321');
  await client.cancelActivation();
  assert.equal(calls.some((item) => item.action === 'setStatus' && item.status === '8'), true);
});

test('JSON getNumberV2 payload is accepted and finish uses status 6', async () => {
  const { fetchImpl, calls } = mockFetch(async (params) => {
    if (params.action === 'getNumberV2') {
      return {
        contentType: 'application/json',
        body: JSON.stringify({ activationId: 'act-json', phoneNumber: '447700900999', activationCost: 0.15 }),
      };
    }
    if (params.action === 'setStatus') return 'ACCESS_ACTIVATION';
    return 'STATUS_WAIT_CODE';
  });
  const client = new SmsBowerClient({
    apiKey: 'test-sms-key',
    country: 'GB',
    service: 'ts',
    fetchImpl,
  });
  const reserved = await client.reserveNumber();
  assert.equal(reserved.activationId, 'act-json');
  assert.equal(reserved.phone, '+447700900999');
  await client.finishActivation();
  assert.equal(calls.at(-1).action, 'setStatus');
  assert.equal(calls.at(-1).status, '6');
});
