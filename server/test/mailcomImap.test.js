const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  ImapFallbackCoordinator,
  withSafeImapClient,
} = require('../src/utils/mailcomImap');

class FakeImap extends EventEmitter {
  constructor({ connect, logout } = {}) {
    super();
    this.connectImpl = connect || (async () => {});
    this.logoutImpl = logout || (async () => {});
  }

  connect() {
    return this.connectImpl(this);
  }

  logout() {
    return this.logoutImpl(this);
  }
}

test('IMAP emitted errors during connect reject without becoming unhandled', async () => {
  const client = new FakeImap({
    connect: async (self) => {
      const error = new Error('Socket timeout during connect');
      error.code = 'ETIMEOUT';
      self.emit('error', error);
      await new Promise(() => {});
    },
  });

  await assert.rejects(
    withSafeImapClient(() => client, async () => []),
    /Socket timeout during connect/
  );
  assert.equal(client.listenerCount('error') > 0, true);
});

test('IMAP emitted errors during fetch and logout reject safely', async () => {
  const fetchClient = new FakeImap();
  await assert.rejects(
    withSafeImapClient(() => fetchClient, async () => {
      fetchClient.emit('error', new Error('fetch socket failed'));
      await new Promise(() => {});
    }),
    /fetch socket failed/
  );

  const logoutClient = new FakeImap({
    logout: async (self) => {
      self.emit('error', new Error('late logout socket failed'));
      await new Promise(() => {});
    },
  });
  await assert.rejects(
    withSafeImapClient(() => logoutClient, async () => 'ok'),
    /late logout socket failed/
  );
});

test('a late IMAP error after a completed logout remains handled', async () => {
  const client = new FakeImap();
  assert.equal(await withSafeImapClient(() => client, async () => 'ok'), 'ok');
  assert.doesNotThrow(() => client.emit('error', new Error('post-logout socket event')));
});

test('coalesces fallback sockets and applies per-mother timeout backoff', async () => {
  let now = 1000;
  let sockets = 0;
  const coordinator = new ImapFallbackCoordinator({ backoffMs: 20000, now: () => now });
  const failOnce = async () => {
    sockets += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const error = new Error('Socket timeout');
    error.code = 'ETIMEOUT';
    throw error;
  };

  const first = await Promise.allSettled(
    Array.from({ length: 5 }, () => coordinator.runInbox('user:mother', failOnce))
  );
  assert.equal(sockets, 1);
  assert.equal(first.every((result) => result.status === 'rejected' && result.reason.retryable), true);

  await assert.rejects(
    coordinator.runInbox('user:mother', async () => {
      sockets += 1;
      return [];
    }),
    (error) => error.code === 'MAILCOM_IMAP_BACKOFF' && error.retryable
  );
  assert.equal(sockets, 1);

  now += 20001;
  const rawMotherInbox = [{ id: '1', to: [{ address: 'alias@example.test' }] }];
  const result = await coordinator.runInbox('user:mother', async () => {
    sockets += 1;
    return rawMotherInbox;
  });
  assert.equal(sockets, 2);
  assert.equal(result, rawMotherInbox);
});
