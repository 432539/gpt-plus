const test = require('node:test');
const assert = require('node:assert/strict');

test('Cloak runtime exposes the reference resource ceiling', async () => {
  const { CLOAK_MAX_CONCURRENCY_LIMIT } = await import('../src/automation/config.js');
  assert.equal(CLOAK_MAX_CONCURRENCY_LIMIT, 200);
});

test('Cloak SOCKS launch config keeps auth encoded and protocol intact', async () => {
  const { proxyLaunchConfig, proxyUrl } = await import('../src/automation/cloak.js');
  const proxy = {
    proxy_type: 'socks5',
    host: 'proxy.example.test',
    port: 1080,
    username: 'user@tenant',
    password: 'p@ss:word',
  };
  assert.equal(
    proxyUrl(proxy),
    'socks5://user%40tenant:p%40ss%3Aword@proxy.example.test:1080'
  );
  assert.deepEqual(proxyLaunchConfig(proxy, 'localhost'), {
    server: 'socks5://proxy.example.test:1080',
    bypass: 'localhost',
    username: 'user@tenant',
    password: 'p@ss:word',
  });
});

function mockPage(context) {
  const page = {
    closed: false,
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    goto: async () => {},
    evaluate: async () => ({
      ua: 'Mozilla/5.0',
      platform: 'Win32',
      language: 'en-GB',
      timezone: 'Europe/London',
      screen: '1920x1080@1',
      cores: 4,
      webdriver: false,
    }),
    context: () => context,
    close: async () => { page.closed = true; },
  };
  return page;
}

function mockBrowser({ failNewPage = false } = {}) {
  const contexts = [];
  const createContext = () => {
    const pages = [];
    const context = {
      closed: false,
      closeCalls: 0,
      pages: () => pages.filter((item) => !item.closed),
      close: async () => {
        context.closeCalls += 1;
        context.closed = true;
      },
      cookies: async () => [],
      addCookies: async () => {},
      newPage: async () => {
        if (failNewPage || browser.closed) {
          throw new Error('browser.newPage: Target page, context or browser has been closed');
        }
        const next = mockPage(context);
        pages.push(next);
        return next;
      },
    };
    contexts.push(context);
    return context;
  };
  const browser = {
    closed: false,
    closeCalls: 0,
    killed: false,
    newContext: async () => createContext(),
    newPage: async () => createContext().newPage(),
    contexts: () => contexts.filter((item) => !item.closed),
    close: async () => {
      browser.closeCalls += 1;
      browser.closed = true;
      for (const context of contexts) context.closed = true;
    },
    isConnected: () => !browser.closed,
    process: () => ({
      kill: () => { browser.killed = true; },
    }),
  };
  return browser;
}

test('newPage failure closes the half-open browser before releasing the slot', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  const browsers = [];
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launch: async () => {
      const browser = mockBrowser({ failNewPage: true });
      browsers.push(browser);
      return browser;
    },
  });
  await assert.rejects(
    () => runtime.withSession({ kind: 'extract' }, async () => {}),
    /browser\.newPage/,
  );
  assert.equal(browsers.length, 1);
  assert.equal(browsers[0].closed, true);
  assert.ok(browsers[0].closeCalls >= 1);
  assert.equal(runtime.semaphore.stats().reservedSlots, 0);
  await runtime.closeAll();
});

test('extra page contexts are closed in withSession finally', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  let extraClosed = false;
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launch: async () => mockBrowser(),
  });
  await runtime.withSession({ kind: 'extract' }, async (session) => {
    const extra = await session.newPage();
    extra.closePage = async () => { extraClosed = true; };
    throw new Error('CHECKOUT_APPROVE_BLOCKED');
  }).catch((error) => {
    assert.match(String(error.message), /CHECKOUT_APPROVE_BLOCKED/);
  });
  assert.equal(extraClosed, true);
  assert.equal(runtime.semaphore.stats().reservedSlots, 0);
  await runtime.closeAll();
});

test('helper pages reuse the live registration context', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launch: async () => mockBrowser(),
  });
  await runtime.withSession({ kind: 'register' }, async (session) => {
    const extra = await session.newPage();
    assert.equal(extra.page.context(), session.page.context());
  });
  await runtime.closeAll();
});

test('closing a helper page does not close the shared registration context', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    launch: async () => mockBrowser(),
  });
  await runtime.withSession({ kind: 'register' }, async (session) => {
    const context = session.page.context();
    const extra = await session.newPage();
    await extra.closePage();
    assert.equal(extra.page.closed, true);
    assert.equal(session.page.closed, false);
    assert.equal(context.closed, false);
  });
  await runtime.closeAll();
});

test('proxy launch delegates locale and timezone to geoip', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  let launchOptions;
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    locale: 'en-US',
    timezone: 'America/New_York',
    launch: async (options) => {
      launchOptions = options;
      return mockBrowser();
    },
  });
  await runtime.withSession({
    kind: 'register',
    proxy: { proxy_type: 'http', host: 'proxy.example', port: 8080 },
  }, async () => {});
  assert.equal(launchOptions.geoip, true);
  assert.equal(launchOptions.humanize, true);
  assert.equal(launchOptions.locale, undefined);
  assert.equal(launchOptions.timezone, undefined);
  await runtime.closeAll();
});

test('direct launch keeps configured locale and timezone', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  let launchOptions;
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    locale: 'en-US',
    timezone: 'America/New_York',
    launch: async (options) => {
      launchOptions = options;
      return mockBrowser();
    },
  });
  await runtime.withSession({ kind: 'register' }, async () => {});
  assert.equal(launchOptions.locale, 'en-US');
  assert.equal(launchOptions.timezone, 'America/New_York');
  await runtime.closeAll();
});

test('thrown withSession job closes context then browser without force-kill', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  const order = [];
  let browser;
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    licenseSessionCount: async () => null,
    launch: async () => {
      browser = mockBrowser();
      const origBrowserClose = browser.close.bind(browser);
      browser.close = async () => {
        order.push('browser');
        await origBrowserClose();
      };
      const origNewContext = browser.newContext.bind(browser);
      browser.newContext = async () => {
        const context = await origNewContext();
        const origContextClose = context.close.bind(context);
        context.close = async () => {
          order.push('context');
          await origContextClose();
        };
        return context;
      };
      return browser;
    },
  });
  await assert.rejects(
    () => runtime.withSession({ kind: 'extract' }, async () => {
      throw new Error('job-failed');
    }),
    /job-failed/,
  );
  assert.deepEqual(order, ['context', 'browser']);
  assert.equal(browser.closed, true);
  assert.equal(browser.killed, false);
  assert.equal(runtime.semaphore.stats().reservedSlots, 0);
  await runtime.closeAll();
});

test('license rotator skips to next key on seat-full without printing keys', async () => {
  const { CloakRuntime } = await import('../src/automation/cloak.js');
  const keyA = 'cb_unit_alpha_aaaaaaa1';
  const keyB = 'cb_unit_beta_bbbbbbbb2';
  const used = [];
  const logs = [];
  const runtime = new CloakRuntime({
    maxConcurrency: 1,
    licenseKey: keyA,
    licenseKeys: [keyA, keyB],
    licenseSessionLimitAttempts: 4,
    licenseSessionLimitBaseDelayMs: 1,
    licenseSessionLimitMaxDelayMs: 1,
    licenseSessionCount: async () => null,
    launch: async (options) => {
      used.push(options.licenseKey);
      if (options.licenseKey === keyA) {
        throw new Error('process did exit: exitCode=76');
      }
      return mockBrowser();
    },
  });
  await runtime.withSession({
    kind: 'register',
    log: (message) => logs.push(String(message || '')),
  }, async () => {});
  assert.deepEqual(used, [keyA, keyB]);
  const blob = `${logs.join('\n')}\n${JSON.stringify(runtime.info())}`;
  assert.equal(blob.includes(keyA), false);
  assert.equal(blob.includes(keyB), false);
  assert.equal(runtime.info().licenseCount, 2);
  assert.match(logs.join('\n'), /席位暂满，改用授权/);
  await runtime.closeAll();
});
