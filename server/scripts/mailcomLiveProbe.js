// Live probe for mail.com login + aliases + inbox. Credentials come from env only.
const { MailcomClient, createMemorySessionStore, MAILBOX_SCOPE, MAILSET_SCOPE } = require('../src/utils/mailcom');

function maskAddress(address) {
  const value = String(address || '');
  const at = value.indexOf('@');
  if (at <= 1) return '***';
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}

function summarize(error) {
  return String(error?.message || error)
    .replace(/[?&](?:ott|sid|token)=[^&\s]+/gi, '')
    .replace(/\(sid-[A-Za-z0-9]+\)/gi, '')
    .slice(0, 180);
}

function loadLocalProxies(groupName) {
  const group = String(groupName || '').trim();
  if (!group) return [];
  const db = require('../src/db');
  const { decrypt } = require('../src/utils/crypto');
  const rows = db
    .prepare('SELECT * FROM proxies WHERE user_id = 1 AND group_name = ? ORDER BY id')
    .all(group);
  return rows
    .filter((row) => ['http', 'https'].includes(String(row.proxy_type || 'http').toLowerCase()))
    .map((row) => ({
      id: row.id,
      proxy_type: String(row.proxy_type || 'http').toLowerCase(),
      host: String(row.host || '').trim(),
      port: Number(row.port),
      username: String(row.username || ''),
      password: decrypt(row.password_enc || ''),
    }))
    .filter((row) => row.host && row.port);
}

async function probe(username, password, proxies) {
  const store = createMemorySessionStore();
  const options = { sessionStore: store };
  if (proxies.length) options.proxies = proxies;
  const client = new MailcomClient(username, password, options);
  const second = new MailcomClient(username, password, { ...options, sessionStore: store, loginRetries: 1 });
  const out = {
    impersonated: client.impersonated,
    proxyCount: proxies.length,
    loginMode: '',
    cacheMode: '',
    aliasCount: 0,
    childCount: 0,
    inboxCount: 0,
    ok: false,
  };
  try {
    out.loginMode = await client.ensureSession(MAILSET_SCOPE);
    const aliases = await client.listAliases();
    out.aliasCount = aliases.length;
    out.childCount = aliases.filter((addr) => String(addr).toLowerCase() !== username.toLowerCase()).length;
    const mails = await client.queryInbox(10);
    out.inboxCount = mails.length;
    out.cacheMode = await second.ensureSession(MAILBOX_SCOPE);
    out.ok =
      Boolean(out.loginMode) &&
      out.aliasCount >= 1 &&
      Array.isArray(mails) &&
      (out.cacheMode === 'cache' || out.cacheMode === 'token-refresh');
    return out;
  } catch (error) {
    error.probe = out;
    throw error;
  } finally {
    await client.close().catch(() => {});
    await second.close().catch(() => {});
  }
}

async function main() {
  const username = String(process.env.MAILCOM_TEST_USER || '').trim();
  const password = String(process.env.MAILCOM_TEST_PASS || '');
  if (!username || !password) {
    console.error('SKIP: MAILCOM_TEST_USER / MAILCOM_TEST_PASS not set');
    process.exit(2);
  }

  const requestedGroup = String(process.env.MAILCOM_TEST_PROXY_GROUP || '').trim();
  let usedGroup = requestedGroup;
  let proxies = loadLocalProxies(requestedGroup);
  let result;
  try {
    result = await probe(username, password, proxies);
  } catch (firstError) {
    const retryable = Boolean(firstError?.retryable) || /support\.mail\.com|interception|换 sid 失败|登录被重定向/i.test(String(firstError?.message || ''));
    if (!requestedGroup && retryable) {
      usedGroup = '注册';
      proxies = loadLocalProxies(usedGroup);
      if (proxies.length) {
        try {
          result = await probe(username, password, proxies);
        } catch (secondError) {
          const out = secondError.probe || {};
          console.log(JSON.stringify({
            ok: false,
            impersonated: out.impersonated,
            proxyGroup: usedGroup,
            proxyCount: proxies.length,
            loginMode: out.loginMode || '',
            cacheMode: out.cacheMode || '',
            aliasCount: out.aliasCount || 0,
            childCount: out.childCount || 0,
            inboxCount: out.inboxCount || 0,
            error: summarize(secondError),
            retryable: Boolean(secondError?.retryable),
            code: secondError?.code || '',
            mother: maskAddress(username),
          }));
          process.exit(1);
        }
      } else {
        const out = firstError.probe || {};
        console.log(JSON.stringify({
          ok: false,
          impersonated: out.impersonated,
          proxyGroup: '',
          proxyCount: 0,
          loginMode: out.loginMode || '',
          error: summarize(firstError),
          retryable: Boolean(firstError?.retryable),
          code: firstError?.code || '',
          mother: maskAddress(username),
        }));
        process.exit(1);
      }
    } else {
      const out = firstError.probe || {};
      console.log(JSON.stringify({
        ok: false,
        impersonated: out.impersonated,
        proxyGroup: usedGroup,
        proxyCount: proxies.length,
        loginMode: out.loginMode || '',
        cacheMode: out.cacheMode || '',
        aliasCount: out.aliasCount || 0,
        childCount: out.childCount || 0,
        inboxCount: out.inboxCount || 0,
        error: summarize(firstError),
        retryable: Boolean(firstError?.retryable),
        code: firstError?.code || '',
        mother: maskAddress(username),
      }));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({
    ok: result.ok,
    impersonated: result.impersonated,
    proxyGroup: usedGroup,
    proxyCount: result.proxyCount,
    loginMode: result.loginMode,
    cacheMode: result.cacheMode,
    aliasCount: result.aliasCount,
    childCount: result.childCount,
    inboxCount: result.inboxCount,
    mother: maskAddress(username),
  }));
  process.exit(result.ok ? 0 : 1);
}

main();
