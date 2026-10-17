// mail.com 母号/子号编排:同步、拉满、回收已用、换新、收件缓存。
// 基于本地 DB(emails/email_mails)与 MailcomClient 协议客户端。
const db = require('../db');
const { decrypt } = require('./crypto');
const { readSettings, recordUnavailableSuffixes } = require('./settings');
const { ImapFlow } = require('imapflow');
const {
  MailcomClient,
  MailcomError,
  RetryableMailcomError,
  ALIAS_CAP,
  randomLocal,
  toMatches,
  suffixOf,
  parseAliasAddResult,
  httpLooksLikeAssistance,
} = require('./mailcom');
const { createMailcomSessionStore } = require('./mailcomSession');
const { ImapFallbackCoordinator, withSafeImapClient } = require('./mailcomImap');
const { enabledSuffixes, hydrateDomains, selectPullSuffixes, classifyAliasAddStatus } = require('./mailcomDomains');
const { pickPullSuffix, countUsage } = require('./suffixPick');
const { pickQuotaSuffix, consumeSuffixSlot } = require('./suffixQuota');
const { proxyLabel } = require('./mailcomProxy');
const { isPaymentProxyGroup } = require('./paymentProxy');
const { isAutoProxyGroup } = require('./dynamicProxy');
const opLog = require('./opLog');
const imapFallbacks = new ImapFallbackCoordinator({ backoffMs: 20000 });
const MAILCOM_DIRECT_RE = /^(直连|direct|none|__none__)$/i;

function getMother(userId, motherId) {
  return db.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ? AND is_mother = 1').get(motherId, userId);
}
function listChildren(userId, motherId) {
  return db.prepare('SELECT * FROM emails WHERE user_id = ? AND mother_id = ? ORDER BY id').all(userId, motherId);
}

function decryptCredential(payload, label) {
  try {
    return decrypt(payload || '');
  } catch {
    throw new MailcomError(`${label} 的凭据无法解密，请重新保存`);
  }
}

function isMailcomProxyDisabled(requested) {
  const want = String(requested || '').trim();
  if (!want || MAILCOM_DIRECT_RE.test(want)) return true;
  // 邮箱轮询绝不用注册动态池（IPRocket / __auto__:GB）。
  if (isAutoProxyGroup(want)) return true;
  return false;
}

function resolveMailcomProxyGroup(userId, requested) {
  const want = String(requested || '').trim();
  if (isMailcomProxyDisabled(want)) return '';
  if (isPaymentProxyGroup(want)) {
    throw new MailcomError(`mail.com 不能使用支付代理分组「${want}」`, { code: 'MAILCOM_PAYMENT_PROXY_FORBIDDEN' });
  }
  return want;
}

function proxiesForMailcomClient(userId, { direct = false, proxyGroup } = {}) {
  if (direct) return [];
  const requested = proxyGroup !== undefined
    ? proxyGroup
    : (readSettings(userId).mailcom || {}).proxy_group;
  const group = resolveMailcomProxyGroup(userId, requested);
  return group ? loadMailcomProxies(userId, group) : [];
}

function mailcomProxySummary(userId, requested) {
  const group = resolveMailcomProxyGroup(userId, requested);
  if (!group) return { group: '', count: 0 };
  const count = Number(
    db.prepare('SELECT COUNT(*) AS n FROM proxies WHERE user_id = ? AND group_name = ?').get(userId, group)?.n || 0
  );
  return { group, count };
}

function loadMailcomProxies(userId, groupName) {
  const group = String(groupName || '').trim();
  if (!group) return [];
  const rows = db
    .prepare('SELECT * FROM proxies WHERE user_id = ? AND group_name = ? ORDER BY id')
    .all(userId, group);
  if (!rows.length) throw new MailcomError(`mail.com 代理分组「${group}」不存在或没有代理`);
  return rows.map((row) => {
    const type = String(row.proxy_type || 'http').toLowerCase();
    if (!['http', 'https', 'socks5'].includes(type)) {
      throw new MailcomError(`mail.com 不支持 ${type} 代理（${proxyLabel(row)}）`);
    }
    return {
      id: row.id,
      proxy_type: type,
      host: String(row.host || '').trim(),
      port: Number(row.port),
      username: String(row.username || ''),
      password: decryptCredential(row.password_enc, `代理 ${proxyLabel(row)}`),
    };
  });
}

function clientForMother(userId, motherRow, password, { direct = false } = {}) {
  const cfg = readSettings(userId).mailcom || {};
  const proxies = proxiesForMailcomClient(userId, { direct, proxyGroup: cfg.proxy_group });
  return new MailcomClient(
    motherRow.address,
    password === undefined ? decryptCredential(motherRow.password_enc, motherRow.address) : password,
    undefined,
    {
      proxies,
      sessionStore: createMailcomSessionStore(userId, motherRow.address),
    }
  );
}

function insertChild(userId, motherRow, address) {
  const suffix = (address.split('@')[1] || '').toLowerCase();
  const info = db
    .prepare(
      `INSERT INTO emails (user_id, address, mailbox_type, provider, status, is_mother, mother_id, label)
       VALUES (?, ?, 'mailcom', ?, '未使用', 0, ?, ?)`
    )
    .run(userId, address, suffix, motherRow.id, motherRow.label || '');
  return info.lastInsertRowid;
}

// 按 mail.com 现有别名对齐本地子号:新增缺失、删除幽灵
async function syncChildren(userId, motherId, { client: providedClient } = {}) {
  const mother = getMother(userId, motherId);
  if (!mother) throw new MailcomError('母号不存在');
  const client = providedClient || clientForMother(userId, mother);
  try {
    const remote = (await client.listAliases()).map((a) => a.toLowerCase());
    const remoteSet = new Set(remote);
    const local = listChildren(userId, motherId);
    const localSet = new Set(local.map((c) => c.address.toLowerCase()));

    let added = 0;
    let pruned = 0;
    const tx = db.transaction(() => {
      // 远端有、本地无 → 新增(排除母号自身地址)
      for (const addr of remote) {
        if (addr === mother.address.toLowerCase()) continue;
        if (!localSet.has(addr)) {
          insertChild(userId, mother, addr);
          added += 1;
        }
      }
      // 本地有、远端无 → 删除幽灵
      for (const child of local) {
        if (!remoteSet.has(child.address.toLowerCase())) {
          db.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?').run(child.id, userId);
          pruned += 1;
        }
      }
    });
    tx();
    opLog.pull(
      userId,
      added || pruned ? 'success' : 'info',
      `同步子号 ${mother.address}：远端 ${remoteSet.size}，本地新增 ${added}，清理 ${pruned}`,
      { ref: mother.address }
    );
    return { added, pruned, total: remoteSet.size };
  } finally {
    if (!providedClient) await client.close();
  }
}

// 把母号补到 cap 个地址(含母号)
async function fillAliases(userId, motherId, cap = ALIAS_CAP, { client: providedClient, random } = {}) {
  const mother = getMother(userId, motherId);
  if (!mother) throw new MailcomError('母号不存在');
  opLog.pull(
    userId,
    'info',
    `开始拉子号 ${mother.address}，目标 ${cap} 个地址(含母号)`,
    { ref: mother.address }
  );
  const client = providedClient || clientForMother(userId, mother);
  try {
  let aliases;
  try {
    aliases = (await client.listAliases()).map((a) => a.toLowerCase());
  } catch (e) {
    opLog.pull(userId, 'error', `拉子号失败 ${mother.address}：${String(e.message || e).slice(0, 160)}`, { ref: mother.address });
    throw e;
  }

  let live = [];
  try {
    live = await client.listDomains();
    if (live.length) hydrateDomains(live);
  } catch (e) {
    opLog.pull(
      userId,
      'warning',
      `${mother.address} 拉远程后缀目录失败，回退本地启用列表：${String(e.message || e).slice(0, 120)}`,
      { ref: mother.address }
    );
  }

  const wanted = enabledSuffixes(readSettings(userId).mailcom);
  if (!wanted.length) {
    opLog.pull(userId, 'error', `拉子号失败 ${mother.address}：没有可拉的后缀`, { ref: mother.address });
    throw new MailcomError('没有可拉的后缀,请在「个人设置 → 邮箱轮询」中启用 mail.com 后缀');
  }

  const selection = selectPullSuffixes({
    enabled: wanted,
    live,
    existing: aliases.map(suffixOf),
  });
  if (selection.blocked.length) {
    opLog.pull(
      userId,
      'info',
      `${mother.address} 账号目录未列出 ${selection.blocked.length} 个启用后缀，将在目录内后缀用尽后尝试（例如 ${selection.blocked.slice(0, 3).join(', ')}）`,
      { ref: mother.address }
    );
  }

  const pool = selection.pool;
  if (!pool.length) {
    opLog.pull(
      userId,
      selection.usedLiveCatalog ? 'warning' : 'info',
      `拉子号完成 ${mother.address}：没有可拉的允许后缀，现 ${aliases.length}/${cap}`,
      { ref: mother.address }
    );
    return { added: 0, addresses: [], errors: [] };
  }

  const added = [];
  const errors = [];
  const skipped = new Set();
  const validateFails = new Map();
  const attemptedCandidates = new Set(aliases);
  const usage = countUsage(aliases);
  let guard = 0;
  while (aliases.length < cap && guard < cap + 40) {
    guard += 1;
    const remaining = pool.filter((domain) => !skipped.has(domain));
    if (!remaining.length) break;
    const domain = pickQuotaSuffix(userId, remaining, {
      usage,
      random: random || Math.random,
      settings: readSettings(userId),
      mode: 'generate',
      consume: false,
    });
    if (!domain) {
      opLog.pull(
        userId,
        'warning',
        `${mother.address} 每个后缀本时段生成额度已用完，停止继续拉子号`,
        { ref: mother.address },
      );
      break;
    }
    let cand;
    do {
      cand = `${randomLocal()}@${domain}`;
    } while (attemptedCandidates.has(cand.toLowerCase()));
    attemptedCandidates.add(cand.toLowerCase());
    try {
      if (!(await client.validateAddress(cand))) {
        const fails = (validateFails.get(domain) || 0) + 1;
        validateFails.set(domain, fails);
        if (fails >= 3) {
          skipped.add(domain);
          recordUnavailableSuffixes(userId, [domain], {
            reason: 'validate_rejected',
            error: 'mail.com 校验拒绝该后缀地址',
          });
          opLog.pull(userId, 'warning', `${mother.address} 后缀 ${domain} 连续校验失败，已跳过`, {
            ref: mother.address,
          });
        }
        continue;
      }
      const { status, body } = parseAliasAddResult(await client.addAlias(cand));
      const verdict = classifyAliasAddStatus(status);
      if (verdict === 'ok') {
        added.push(cand);
        aliases.push(cand.toLowerCase());
        usage.set(domain, (usage.get(domain) || 0) + 1);
        consumeSuffixSlot(userId, domain, { mode: 'generate', settings: readSettings(userId) });
        opLog.pull(userId, 'success', `已添加子号 ${cand}`, { ref: mother.address });
        await new Promise((r) => setTimeout(r, 400));
      } else if (verdict === 'full') {
        opLog.pull(userId, 'warning', `${mother.address} 远端已满(HTTP 409)`, { ref: mother.address });
        break;
      } else {
        skipped.add(domain);
        recordUnavailableSuffixes(userId, [domain], {
          reason: status === 400 ? 'http_400' : `http_${status}`,
          status,
          error: body || `HTTP ${status}`,
        });
        const detail = body ? `：${body}` : '';
        errors.push(`${domain} HTTP ${status}${detail}`);
        opLog.pull(
          userId,
          'warning',
          `${mother.address} 添加失败 HTTP ${status} ${domain}${detail}，已跳过该后缀`,
          { ref: mother.address }
        );
      }
    } catch (e) {
      const msg = String(e.message || e).slice(0, 120);
      errors.push(msg);
      opLog.pull(userId, 'error', `${mother.address} ${msg}`, { ref: mother.address });
      break;
    }
  }
  // 本地登记新别名
  const tx = db.transaction(() => {
    const localSet = new Set(listChildren(userId, motherId).map((c) => c.address.toLowerCase()));
    for (const addr of added) {
      if (!localSet.has(addr.toLowerCase())) insertChild(userId, mother, addr);
    }
  });
  tx();
  opLog.pull(
    userId,
    added.length ? 'success' : errors.length ? 'error' : 'info',
    `拉子号完成 ${mother.address}：新增 ${added.length} 个，现 ${aliases.length}/${cap}`,
    { ref: mother.address }
  );
    return { added: added.length, addresses: added, errors };
  } finally {
    if (!providedClient) await client.close();
  }
}

function removeLocalEmail(userId, emailId) {
  db.prepare('DELETE FROM email_mails WHERE email_id = ? AND user_id = ?').run(emailId, userId);
  db.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?').run(emailId, userId);
}

// 删除指定子号(远端删别名 + 本地删行)。返回 {deleted, errors}
async function deleteChildren(userId, childIds, { forceLocal = false, client: providedClient } = {}) {
  if (!childIds.length) return { deleted: 0, errors: [] };
  const rows = db
    .prepare(
      `SELECT * FROM emails WHERE user_id = ? AND id IN (${childIds.map(() => '?').join(',')}) AND is_mother = 0 AND mother_id IS NOT NULL`
    )
    .all(userId, ...childIds);
  let deleted = 0;
  const errors = [];
  // 按母号分组,复用会话
  const byMother = new Map();
  for (const r of rows) {
    if (!byMother.has(r.mother_id)) byMother.set(r.mother_id, []);
    byMother.get(r.mother_id).push(r);
  }
  for (const [motherId, children] of byMother.entries()) {
    const mother = getMother(userId, motherId);
    if (!mother) {
      if (forceLocal) {
        for (const child of children) {
          removeLocalEmail(userId, child.id);
          deleted += 1;
        }
      }
      continue;
    }
    const client = providedClient || clientForMother(userId, mother);
    try {
      for (const child of children) {
        try {
          await client.deleteAlias(child.address);
        } catch (e) {
          const missing = /没有这个别名/.test(String(e.message));
          if (!missing) errors.push(`${child.address}: ${String(e.message).slice(0, 80)}`);
          if (!forceLocal && !missing) continue;
        }
        removeLocalEmail(userId, child.id);
        deleted += 1;
      }
    } finally {
      if (!providedClient) await client.close();
    }
  }
  return { deleted, errors };
}

function deletePlainEmails(userId, ids) {
  const tx = db.transaction(() => {
    for (const id of ids) removeLocalEmail(userId, id);
  });
  tx();
  return ids.length;
}

async function deleteUsed(userId) {
  const childIds = db
    .prepare(
      "SELECT id FROM emails WHERE user_id = ? AND is_mother = 0 AND mother_id IS NOT NULL AND status = '已使用'"
    )
    .all(userId)
    .map((r) => r.id);
  const plains = db
    .prepare(
      "SELECT id FROM emails WHERE user_id = ? AND is_mother = 0 AND (mother_id IS NULL OR mother_id = 0) AND status = '已使用'"
    )
    .all(userId)
    .map((r) => r.id);
  let del = { deleted: 0, errors: [] };
  if (childIds.length) del = await deleteChildren(userId, childIds, { forceLocal: true });
  const plainCount = plains.length ? deletePlainEmails(userId, plains) : 0;
  return {
    deleted: del.deleted + plainCount,
    children: del.deleted,
    plains: plainCount,
    errors: del.errors,
  };
}

async function clearAll(userId, includeMothers) {
  const childIds = db
    .prepare('SELECT id FROM emails WHERE user_id = ? AND is_mother = 0 AND mother_id IS NOT NULL')
    .all(userId)
    .map((r) => r.id);
  const plains = db
    .prepare(
      'SELECT id FROM emails WHERE user_id = ? AND is_mother = 0 AND (mother_id IS NULL OR mother_id = 0)'
    )
    .all(userId)
    .map((r) => r.id);
  const mothers = includeMothers
    ? db.prepare('SELECT id FROM emails WHERE user_id = ? AND is_mother = 1').all(userId).map((r) => r.id)
    : [];

  let del = { deleted: 0, errors: [] };
  if (childIds.length) del = await deleteChildren(userId, childIds, { forceLocal: true });
  const plainCount = plains.length ? deletePlainEmails(userId, plains) : 0;
  const motherCount = mothers.length ? deletePlainEmails(userId, mothers) : 0;
  return {
    deleted: del.deleted + plainCount + motherCount,
    children: del.deleted,
    plains: plainCount,
    mothers: motherCount,
    errors: del.errors,
  };
}

// 回收已使用子号:删除 used → 可选拉满
async function recycleUsed(userId, motherId, { repull = false, cap = ALIAS_CAP, client: providedClient } = {}) {
  const used = db
    .prepare("SELECT id FROM emails WHERE user_id = ? AND mother_id = ? AND status = '已使用'")
    .all(userId, motherId)
    .map((r) => r.id);
  const mother = getMother(userId, motherId);
  if (!mother) throw new MailcomError('母号不存在');
  if (!used.length && !repull) return { deleted: 0, added: 0, errors: [] };
  const client = providedClient || clientForMother(userId, mother);
  try {
    let del = { deleted: 0, errors: [] };
    if (used.length) del = await deleteChildren(userId, used, { client });
    if (used.length) {
    opLog.pull(
      userId,
      del.deleted ? 'success' : 'info',
      `回收已用 ${mother ? mother.address : '#' + motherId}：删除 ${del.deleted} 个已使用子号`,
      { ref: mother ? mother.address : String(motherId) }
    );
    }
    let fill = { added: 0, addresses: [], errors: [] };
    if (repull) fill = await fillAliases(userId, motherId, cap, { client });
    return { deleted: del.deleted, added: fill.added, errors: [...del.errors, ...fill.errors] };
  } finally {
    if (!providedClient) await client.close();
  }
}

async function runPollerMother(userId, motherId, cfg) {
  const mother = getMother(userId, motherId);
  if (!mother) throw new MailcomError('母号不存在');
  const client = clientForMother(userId, mother);
  try {
    const sync = await syncChildren(userId, motherId, { client });
    let recycled = { deleted: 0, added: 0, errors: [] };
    if (cfg.auto_delete_used) {
      recycled = await recycleUsed(userId, motherId, { repull: false, cap: cfg.cap, client });
    }
    const estimatedTotal = Math.max(0, sync.total - recycled.deleted);
    let fill = { added: 0, addresses: [], errors: [] };
    if (cfg.auto_repull && estimatedTotal < cfg.cap) {
      fill = await fillAliases(userId, motherId, cfg.cap, { client });
    }
    return { sync, recycled, fill };
  } finally {
    await client.close();
  }
}

async function withImap(address, password, fn, { createClient } = {}) {
  return withSafeImapClient(
    () =>
      createClient?.() ||
      new ImapFlow({
        host: 'imap.mail.com',
        port: 993,
        secure: true,
        auth: { user: address, pass: password },
        logger: false,
        socketTimeout: 20000,
        greetingTimeout: 20000,
      }),
    async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    }
  );
}

async function queryInboxImap(address, password, amount = 20) {
  return withImap(address, password, async (client) => {
    const exists = client.mailbox.exists || 0;
    if (!exists) return [];
    const start = Math.max(1, exists - amount + 1);
    const out = [];
    for await (const msg of client.fetch(`${start}:*`, { envelope: true, uid: true })) {
      const env = msg.envelope || {};
      out.push({
        id: String(msg.uid),
        subject: env.subject || '',
        from: (env.from || []).map((a) => a.address).filter(Boolean).join(', '),
        to: (env.to || []).map((a) => ({ address: a.address })),
        date: env.date ? new Date(env.date).toISOString() : '',
      });
    }
    out.reverse();
    return out;
  });
}

async function getBodyImap(address, password, mailId) {
  return withImap(address, password, async (client) => {
    const msg = await client.fetchOne(String(mailId), { source: true }, { uid: true });
    const src = msg && msg.source;
    return Buffer.isBuffer(src) ? src.toString('utf8') : String(src || '');
  });
}

function cacheMails(userId, emailId, mails) {
  const upsert = db.prepare(
    `INSERT INTO email_mails (user_id, email_id, mail_uid, subject, from_addr, to_addr, mail_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email_id, mail_uid) DO UPDATE SET subject=excluded.subject, from_addr=excluded.from_addr, mail_date=excluded.mail_date`
  );
  const tx = db.transaction(() => {
    for (const m of mails) {
      upsert.run(
        userId,
        emailId,
        String(m.id || ''),
        m.subject || '',
        typeof m.from === 'string' ? m.from : JSON.stringify(m.from || ''),
        JSON.stringify(m.to || ''),
        m.date ? String(m.date) : ''
      );
    }
  });
  tx();
}

function imapAuthFailed(error) {
  return /authentication failed|invalid credentials|auth failed/i.test(
    String(error?.responseText || error?.message || error)
  );
}

function classifyImapFallbackError(httpError, imapErr, kind = '收件') {
  if (imapErr?.retryable) throw imapErr;
  if (imapAuthFailed(imapErr) && !httpLooksLikeAssistance(httpError)) {
    throw new MailcomError('mail.com 账号或密码错误', { code: 'MAILCOM_BAD_CREDENTIALS', cause: imapErr });
  }
  throw new RetryableMailcomError(
    `mail.com HTTP 与 IMAP ${kind}均失败：${String(httpError?.message || 'HTTP 失败').slice(0, 140)}；IMAP ${String(imapErr?.responseText || imapErr?.message || '失败').slice(0, 80)}`,
    { cause: imapErr }
  );
}

async function fetchInbox(userId, emailId, { amount = 20 } = {}) {
  const row = db.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?').get(emailId, userId);
  if (!row) throw new MailcomError('邮箱不存在');
  const mother = row.is_mother ? row : getMother(userId, row.mother_id);
  if (!mother) throw new MailcomError('找不到对应母号');
  const password = decryptCredential(mother.password_enc, mother.address);
  let mails = [];
  // 收件/OTP 始终直连。拉别名与轮询仅在个人设置明确选择 mail.com 代理分组时走代理。
  const client = clientForMother(userId, mother, password, { direct: true });
  try {
    mails = await client.queryInbox(amount);
  } catch (e) {
    if (['MAILCOM_BAD_CREDENTIALS', 'MAILCOM_ACCOUNT_INTERCEPTED', 'MAILCOM_LOGIN_REJECTED'].includes(e?.code)) {
      throw e;
    }
    try {
      // IMAP fallback intentionally remains direct; only mail.com HTTP is proxied.
      const motherKey = `${userId}:${mother.id}`;
      // Coalesce only the raw mother inbox. Alias filtering remains per caller.
      mails = await imapFallbacks.runInbox(motherKey, () =>
        queryInboxImap(mother.address, password, amount)
      );
    } catch (imapErr) {
      classifyImapFallbackError(e, imapErr, '收件');
    }
  } finally {
    await client.close();
  }
  const filtered = row.is_mother ? mails : mails.filter((m) => toMatches(m.to, row.address));
  cacheMails(userId, row.id, filtered);
  db.prepare("UPDATE emails SET last_check = datetime('now','localtime'), last_result = ? WHERE id = ?").run(
    `收到 ${filtered.length} 封`,
    row.id
  );
  return { count: filtered.length, mails: filtered };
}

async function fetchBody(userId, emailId, mailId) {
  const row = db.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?').get(emailId, userId);
  if (!row) throw new MailcomError('邮箱不存在');
  const mother = row.is_mother ? row : getMother(userId, row.mother_id);
  if (!mother) throw new MailcomError('找不到对应母号');
  const password = decryptCredential(mother.password_enc, mother.address);
  let body = '';
  const client = clientForMother(userId, mother, password, { direct: true });
  try {
    body = await client.getBody(mailId);
  } catch (e) {
    if (['MAILCOM_BAD_CREDENTIALS', 'MAILCOM_ACCOUNT_INTERCEPTED', 'MAILCOM_LOGIN_REJECTED'].includes(e?.code)) {
      throw e;
    }
    try {
      // IMAP fallback intentionally remains direct; only mail.com HTTP is proxied.
      const motherKey = `${userId}:${mother.id}`;
      body = await imapFallbacks.runBody(motherKey, String(mailId), () =>
        getBodyImap(mother.address, password, mailId)
      );
    } catch (imapErr) {
      classifyImapFallbackError(e, imapErr, '正文读取');
    }
  } finally {
    await client.close();
  }
  db.prepare('UPDATE email_mails SET body = ? WHERE email_id = ? AND mail_uid = ? AND user_id = ?').run(
    body,
    row.id,
    String(mailId),
    userId
  );
  return body;
}

module.exports = {
  syncChildren,
  fillAliases,
  deleteChildren,
  recycleUsed,
  runPollerMother,
  deleteUsed,
  clearAll,
  fetchInbox,
  fetchBody,
  withImap,
  getMother,
  listChildren,
  classifyImapFallbackError,
  loadMailcomProxies,
  resolveMailcomProxyGroup,
  isMailcomProxyDisabled,
  proxiesForMailcomClient,
  mailcomProxySummary,
};
