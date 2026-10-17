const test = require('node:test');
const assert = require('node:assert/strict');
const { MailcomClient } = require('../src/utils/mailcom');
const {
  buildProxyUrl,
  createMemoryCookieJar,
  createProxyDispatcher,
  createMailcomTransport,
} = require('../src/utils/mailcomProxy');

const proxies = [
  { id: 1, proxy_type: 'http', host: '127.0.0.1', port: 18081, username: '', password: '' },
  { id: 2, proxy_type: 'http', host: '127.0.0.1', port: 18082, username: 'user-sid-safe123', password: 'secret' },
];

test('direct mailbox transport has no dispatcher and omits proxy host on failure', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError('simulated network failure');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(createProxyDispatcher(null), undefined);
  const transport = createMailcomTransport(null, { fetch: global.fetch });
  assert.equal(transport.dispatcher, undefined);

  const client = new MailcomClient('mother@mail.com', 'password', { proxies: [], fetch: global.fetch });
  t.after(() => client.close());
  assert.equal(client.proxy, null);
  assert.equal(client.dispatcher, undefined);
  const selected = client.proxy;
  await assert.rejects(
    client._request('https://example.test/fail'),
    (error) => error.retryable === true
      && error.message === 'mail.com 传输失败'
      && !/iprocket|prem\.country|sid-/i.test(error.message)
  );
  assert.equal(client.proxy, selected);
});

test('encodes sticky proxy credentials in the transport URL without logging them', () => {
  const url = buildProxyUrl({
    proxy_type: 'http',
    host: '127.0.0.1',
    port: 18082,
    username: 'user-sid-safe123',
    password: 'p@ss:word',
  });
  assert.equal(url, 'http://user-sid-safe123:p%40ss%3Aword@127.0.0.1:18082');
  assert.equal(buildProxyUrl(null), '');
});

test('SOCKS transport URL uses remote DNS and preserves encoded credentials', async () => {
  const proxy = {
    proxy_type: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'user@tenant',
    password: 'p@ss:word',
  };
  assert.equal(
    buildProxyUrl(proxy),
    'socks5h://user%40tenant:p%40ss%3Aword@127.0.0.1:1080'
  );
  const dispatcher = createProxyDispatcher(proxy);
  assert.equal(dispatcher.constructor.name, 'Socks5ProxyAgent');
  await dispatcher.close();
});

test('memory cookie jar stores names without exposing other fields', () => {
  const jar = createMemoryCookieJar();
  jar.setCookie('sid=safe-sid; Path=/; Domain=.mail.com');
  jar.setCookie('other=1');
  assert.equal(jar.getCookieString(), 'sid=safe-sid; other=1');
});

test('keeps one sticky proxy across successful requests', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 200 });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await client._request('https://example.test/one');
  await client._request('https://example.test/two');
  assert.equal(client.proxy.id, selected);
});

test('rotates only after a retryable transport failure', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new TypeError('simulated network failure');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(
    client._request('https://example.test/fail'),
    (error) => error.retryable === true && !error.message.includes('secret')
  );
  assert.notEqual(client.proxy.id, selected);
});

test('replays a high-level operation after transport rotation', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('simulated network failure');
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  const response = await client._retryOperation(() => client._request('https://example.test/retry'));
  assert.equal(response.status, 204);
  assert.equal(calls, 2);
  assert.notEqual(client.proxy.id, selected);
});

test('does not rotate for an ordinary rejected login', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response('<input name="statistics" value="safe">', { status: 200 })
      : new Response(null, { status: 401 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(client.login(3), /账号或密码错误/);
  assert.equal(calls, 2);
  assert.equal(client.proxy.id, selected);
});

test('rotates after halogin fails to return a sid', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('<input name="statistics" value="safe">', { status: 200 });
    if (calls === 2) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://callback.mail.com/login?ott=safe-token' },
      });
    }
    return new Response(null, { status: 503 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(client.login(1), /halogin 换 sid 失败/);
  assert.notEqual(client.proxy.id, selected);
});
