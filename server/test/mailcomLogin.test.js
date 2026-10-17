const test = require('node:test');
const assert = require('node:assert/strict');
const { MailcomClient, loginRedirectInfo, isLoginOttRedirect, isRetryableLoginBounce } = require('../src/utils/mailcom');

const proxies = [
  { id: 1, proxy_type: 'http', host: '127.0.0.1', port: 18081, username: '', password: '' },
  { id: 2, proxy_type: 'http', host: '127.0.0.1', port: 18082, username: 'user-sid-safe123', password: 'secret' },
  { id: 3, proxy_type: 'http', host: '127.0.0.1', port: 18083, username: '', password: '' },
];

function htmlPage() {
  return new Response('<input name="statistics" value="safe">', { status: 200 });
}

function redirect(status, location) {
  return new Response(null, { status, headers: location ? { location } : {} });
}

test('loginRedirectInfo keeps host+path and drops query secrets', () => {
  const info = loginRedirectInfo('https://navigator-lxa.mail.com/login?ott=SECRET&sid=SECRET');
  assert.equal(info.summary, 'navigator-lxa.mail.com/login');
  assert.equal(info.hasOtt, true);
  assert.equal(info.ls, '');
  assert.ok(!JSON.stringify(info).includes('SECRET'));
});

test('support.mail.com login bounce is retryable and has no ott', () => {
  const info = loginRedirectInfo('https://support.mail.com/account/login/index.html');
  assert.equal(info.summary, 'support.mail.com/account/login/index.html');
  assert.equal(info.hasOtt, false);
  assert.equal(isRetryableLoginBounce(302, info), true);
  assert.equal(isLoginOttRedirect(info), false);
});

test('interception+ott is a bounce, not a successful login ott', () => {
  const info = loginRedirectInfo(
    'https://interception-lxa.mail.com/logininterceptionfrontend/?ott=SECRET&interceptiontype=BotDetection'
  );
  assert.equal(info.summary, 'interception-lxa.mail.com/logininterceptionfrontend/');
  assert.equal(info.hasOtt, true);
  assert.equal(info.interceptionType, 'BotDetection');
  assert.equal(isLoginOttRedirect(info), false);
  assert.equal(isRetryableLoginBounce(303, info), true);
  assert.ok(!JSON.stringify(info).includes('SECRET'));
});

test('TwoFa interception is not retryable', () => {
  const info = loginRedirectInfo(
    'https://interception-lxa.mail.com/logininterceptionfrontend/?ott=SECRET&interceptiontype=TwoFaCodeInterception'
  );
  assert.equal(info.interceptionType, 'TwoFaCodeInterception');
  assert.equal(isRetryableLoginBounce(303, info), false);
});

test('MtanObligation interception is not retryable', () => {
  const info = loginRedirectInfo(
    'https://interception-lxa.mail.com/logininterceptionfrontend/?ott=SECRET&interceptiontype=MtanObligation'
  );
  assert.equal(info.interceptionType, 'MtanObligation');
  assert.equal(isRetryableLoginBounce(303, info), false);
  assert.equal(isLoginOttRedirect(info), false);
});

test('empty Location on 302 is retryable', () => {
  const info = loginRedirectInfo('');
  assert.equal(info.summary, '(empty)');
  assert.equal(isRetryableLoginBounce(302, info), true);
});

test('logout ls=wd stays a credential failure', () => {
  const info = loginRedirectInfo('https://www.mail.com/logout?ls=wd');
  assert.equal(info.ls, 'wd');
  assert.equal(isRetryableLoginBounce(302, info), false);
});

test('injected fetch stays on Node transport; default client uses Chrome TLS', async (t) => {
  const injected = new MailcomClient('mother@mail.com', 'password', {
    proxies,
    fetch: async () => new Response(null, { status: 204 }),
  });
  t.after(() => injected.close());
  assert.equal(injected.impersonated, false);

  const native = new MailcomClient('mother@mail.com', 'password');
  t.after(() => native.close());
  assert.equal(native.impersonated, true);
});

test('exchanges 302+ott into a sid', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return htmlPage();
    if (calls === 2) {
      return redirect(302, 'https://navigator-lxa.mail.com/login?ott=safe-token&foo=1');
    }
    return redirect(302, 'https://navigator-lxa.mail.com/?sid=safe-sid');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  const sid = await client.login(3);
  assert.equal(sid, 'safe-sid');
  assert.equal(calls, 3);
  assert.equal(client.proxy.id, selected);
});

test('302 without ott is retryable and rotates proxy', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls % 2 === 1) return htmlPage();
    return redirect(302, 'https://support.mail.com/account/login/index.html');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(
    client.login(2),
    (error) =>
      error.retryable === true &&
      /HTTP 302 → support\.mail\.com\/account\/login\/index\.html/.test(error.message) &&
      !error.message.includes('secret')
  );
  assert.equal(calls, 4);
  assert.notEqual(client.proxy.id, selected);
});

test('interception+ott rotates proxy and does not exchange ott', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls % 2 === 1) return htmlPage();
    return redirect(
      303,
      'https://interception-lxa.mail.com/logininterceptionfrontend/?ott=SECRET&interceptiontype=BotDetection'
    );
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(
    client.login(2),
    (error) =>
      error.retryable === true &&
      /interception-lxa\.mail\.com\/logininterceptionfrontend\//.test(error.message) &&
      !error.message.includes('SECRET') &&
      !/halogin/.test(error.message)
  );
  assert.equal(calls, 4);
  assert.notEqual(client.proxy.id, selected);
});

test('TwoFa interception fails without rotating', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1
      ? htmlPage()
      : redirect(
          303,
          'https://interception-lxa.mail.com/logininterceptionfrontend/?ott=SECRET&interceptiontype=TwoFaCodeInterception'
        );
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(client.login(3), (error) => {
    assert.equal(error.retryable, false);
    assert.equal(error.code, 'MAILCOM_ACCOUNT_INTERCEPTED');
    assert.match(error.message, /二次验证/);
    assert.ok(!error.message.includes('SECRET'));
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(client.proxy.id, selected);
});

test('401 still fails as bad credentials without rotating', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls === 1 ? htmlPage() : new Response(null, { status: 401 });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const client = new MailcomClient('mother@mail.com', 'password', { proxies, fetch: global.fetch });
  t.after(() => client.close());
  const selected = client.proxy.id;
  await assert.rejects(client.login(3), (error) => {
    assert.equal(error.retryable, false);
    assert.equal(error.code, 'MAILCOM_BAD_CREDENTIALS');
    assert.match(error.message, /账号或密码错误/);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(client.proxy.id, selected);
});

function jwtToken(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig',
  ].join('.');
}

test('ensureSession reuses a fresh cached sid without posting login', async (t) => {
  const { createMemorySessionStore, MAILBOX_SCOPE } = require('../src/utils/mailcom');
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('cache hit must not network');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  const store = createMemorySessionStore({
    sid: 'safe-sid',
    auth_id: 'aid-1',
    tokens: { [MAILBOX_SCOPE]: jwtToken({ auth_id: 'aid-1', exp: Math.floor(Date.now() / 1000) + 3600 }) },
  });
  const client = new MailcomClient('mother@mail.com', 'password', { fetch: global.fetch, sessionStore: store });
  t.after(() => client.close());
  assert.equal(await client.ensureSession(MAILBOX_SCOPE), 'cache');
  assert.equal(calls, 0);
  assert.equal(client.sid, 'safe-sid');
});

test('expired token refreshes via sid without posting /login', async (t) => {
  const { createMemorySessionStore, MAILBOX_SCOPE } = require('../src/utils/mailcom');
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async (url, opts = {}) => {
    urls.push(`${opts.method || 'GET'} ${String(url)}`);
    if (String(url).includes('oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: jwtToken({ auth_id: 'aid-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error('unexpected request');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  const store = createMemorySessionStore({
    sid: 'safe-sid',
    auth_id: 'aid-1',
    tokens: { [MAILBOX_SCOPE]: jwtToken({ auth_id: 'aid-1', exp: Math.floor(Date.now() / 1000) - 10 }) },
  });
  const client = new MailcomClient('mother@mail.com', 'password', { fetch: global.fetch, sessionStore: store });
  t.after(() => client.close());
  assert.equal(await client.ensureSession(MAILBOX_SCOPE), 'token-refresh');
  assert.equal(urls.some((item) => item.includes('login.mail.com/login')), false);
  assert.equal(urls.some((item) => item.includes('oauth2/token')), true);
  assert.equal(Boolean(store.snapshot()?.tokens?.[MAILBOX_SCOPE]), true);
});

test('inbox 401 invalidates cache and re-logins once', async (t) => {
  const { createMemorySessionStore, MAILBOX_SCOPE } = require('../src/utils/mailcom');
  const originalFetch = global.fetch;
  let inboxCalls = 0;
  let loginPosts = 0;
  const fresh = jwtToken({ auth_id: 'aid-2', exp: Math.floor(Date.now() / 1000) + 3600 });
  global.fetch = async (url, opts = {}) => {
    const href = String(url);
    const method = opts.method || 'GET';
    if (href.includes('Mailbox/Mail')) {
      inboxCalls += 1;
      if (inboxCalls === 1) return new Response(null, { status: 401 });
      return new Response(JSON.stringify({ mailListElements: [], totalCount: 0, unreadCount: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (href === 'https://www.mail.com/' || href === 'https://www.mail.com') return htmlPage();
    if (href.includes('login.mail.com/login') && method === 'POST') {
      loginPosts += 1;
      return redirect(302, 'https://navigator-lxa.mail.com/login?ott=safe-token');
    }
    if (href.includes('/halogin')) return redirect(302, 'https://navigator-lxa.mail.com/?sid=safe-sid-2');
    if (href.includes('oauth2/token')) {
      return new Response(JSON.stringify({ access_token: fresh }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected request');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  const store = createMemorySessionStore({
    sid: 'stale-sid',
    auth_id: 'aid-old',
    tokens: { [MAILBOX_SCOPE]: jwtToken({ auth_id: 'aid-old', exp: Math.floor(Date.now() / 1000) + 3600 }) },
  });
  const client = new MailcomClient('mother@mail.com', 'password', {
    proxies,
    fetch: global.fetch,
    sessionStore: store,
    loginRetries: 1,
  });
  t.after(() => client.close());
  const mails = await client.queryInbox(5);
  assert.deepEqual(mails, []);
  assert.equal(inboxCalls, 2);
  assert.equal(loginPosts, 1);
  assert.equal(store.snapshot()?.sid, 'safe-sid-2');
});
