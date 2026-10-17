'use strict';

const { ImapFlow } = require('imapflow');
const { extractVerification } = require('../flows/mailbox');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_URL_HOSTS = new Set([
  'icloud-api.top', 'www.icloud-api.top', 'icloudapi.kuudianfa.com',
  'smsbower.page', 'www.smsbower.page',
]);
const text = value => String(value ?? '').trim();
const wait = (session, ms) => session?.wait
  ? session.wait(ms)
  : new Promise(resolve => setTimeout(resolve, ms));

function safeUrl(value, allowUnsafe = false) {
  try {
    const url = new URL(text(value));
    return allowUnsafe || (url.protocol === 'https:' && SAFE_URL_HOSTS.has(url.hostname.toLowerCase()))
      ? url : null;
  } catch {
    return null;
  }
}

function parseImportedMailboxList(input, { allowUnsafeUrl = false } = {}) {
  const entries = [];
  const errors = [];
  String(input || '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('----').map(text);
    let kind = '';
    let email = '';
    let credential = '';
    if (/^(mail_url|url|http|https)$/i.test(parts[0])) {
      kind = 'url'; email = parts[1]; credential = parts.slice(2).join('----');
    } else if (/^(mailcom|mail\.com|protocol)$/i.test(parts[0])) {
      kind = 'mailcom'; email = parts[1]; credential = parts.slice(2).join('----');
    } else {
      email = parts[0];
      credential = parts.slice(1).join('----');
      kind = /^https?:\/\//i.test(credential) ? 'url'
        : /@(?:mail\.com|usa\.com|email\.com|myself\.com)$/i.test(email) ? 'mailcom'
          : 'imap';
    }
    if (!EMAIL_RE.test(email) || !credential) {
      errors.push({ line: index + 1, reason: !EMAIL_RE.test(email) ? '邮箱格式无效' : '缺少收信凭据' });
      return;
    }
    if (kind === 'url' && !safeUrl(credential, allowUnsafeUrl)) {
      errors.push({ line: index + 1, reason: '收信链接域名不受支持' });
      return;
    }
    if (kind === 'url') entries.push({ email, kind, url: credential });
    else if (kind === 'mailcom') entries.push({ email, kind, password: credential });
    else {
      const explicitHost = parts.length >= 3 && /^(?:imap\.)?[a-z0-9.-]+(?::\d+)?$/i.test(parts[1])
        ? parts[1] : '';
      const [imapHost, port] = explicitHost.split(':');
      entries.push({
        email, kind, password: explicitHost ? parts.slice(2).join('----') : credential,
        imapHost: imapHost || (/@(icloud|me|mac)\.com$/i.test(email) ? 'imap.mail.me.com' : `imap.${email.split('@')[1]}`),
        imapPort: Number(port || 993),
      });
    }
  });
  return { entries, errors };
}

class ImportedMailChannel {
  constructor(entry, options = {}) {
    this.entry = entry;
    this.email = entry.email;
    this.mailId = `imported:${entry.email}`;
    this.codesRead = 0;
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.createImapClient = options.imapFactory || options.createImapClient || (config => new ImapFlow(config));
    this.localWait = options.localWait;
    this.allowUnsafeUrl = options.allowUnsafeUrl === true;
    this.baseline = new Set();
  }

  async acquire() {
    if (this.entry.kind === 'url') {
      const hit = await this.#urlHit().catch(() => ({}));
      if (hit.code) this.baseline.add(hit.code);
    }
    return { email: this.email, id: this.mailId, provider: 'imported' };
  }

  async wait(session, account, settings, options = {}) {
    if (this.entry.kind === 'mailcom' && this.localWait) {
      const result = await this.localWait(session, account, settings, options);
      this.codesRead += 1;
      return result;
    }
    const deadline = Date.now() + Math.max(10000, Number(options.timeoutMs) || 300000);
    const after = Number(options.after) || Date.now() - 60000;
    while (Date.now() < deadline) {
      if (options.cancelled?.()) throw Object.assign(new Error('邮箱取码已取消'), { code: 'JOB_CANCELLED' });
      const hit = this.entry.kind === 'url' ? await this.#urlHit() : await this.#imapHit(after);
      if ((hit.code && !this.baseline.has(hit.code)) || hit.url) {
        this.codesRead += 1;
        return { ...hit, email: this.email };
      }
      await wait(session, Math.max(1000, Number(options.intervalMs) || 3000));
    }
    throw Object.assign(new Error('等待导入邮箱验证码超时'), { code: 'IMPORTED_MAIL_CODE_TIMEOUT' });
  }

  async #urlHit() {
    const url = safeUrl(this.entry.url, this.allowUnsafeUrl);
    if (!url || typeof this.fetch !== 'function') return {};
    const response = await this.fetch(url, { headers: { accept: 'text/html,application/json,*/*' } });
    if (!response.ok) return {};
    const body = await response.text();
    return extractVerification([{ text: body, html: body }]);
  }

  async #imapHit(after) {
    const client = this.createImapClient({
      host: this.entry.imapHost, port: this.entry.imapPort || 993, secure: true,
      auth: { user: this.entry.mailboxEmail || this.email, pass: this.entry.password },
      logger: false, socketTimeout: 20000,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const ids = await client.search({ since: new Date(Math.max(0, after - 5000)) }, { uid: true });
        for await (const message of client.fetch(ids.slice(-30), { source: true, envelope: true }, { uid: true })) {
          const source = Buffer.isBuffer(message.source) ? message.source.toString('utf8') : text(message.source);
          const hit = extractVerification([{ subject: message.envelope?.subject || '', text: source, html: source }]);
          if (hit.code || hit.url) return hit;
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    return {};
  }

  async finish() { return true; }
  async cancel() { return true; }
}

class CfWorkerMailChannel {
  constructor(options = {}) {
    this.apiUrl = text(options.apiUrl || options.api_url).replace(/\/$/, '');
    this.apiKey = text(options.apiKey || options.api_key);
    this.domain = text(options.domain);
    this.fetch = options.fetchImpl || globalThis.fetch;
    this.email = '';
    this.mailId = '';
    this.codesRead = 0;
  }
  headers() {
    return {
      accept: 'application/json', 'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`, 'x-api-key': this.apiKey, 'x-admin-auth': this.apiKey,
    };
  }
  async acquire() {
    if (!this.apiKey || !this.apiUrl) throw Object.assign(new Error('CF Worker 邮箱未配置'), { code: 'CFWORKER_MAIL_NOT_CONFIGURED' });
    const response = await this.fetch(`${this.apiUrl}/admin/new_address`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(this.domain ? { domain: this.domain } : {}),
    });
    const data = response.ok ? await response.json() : {};
    this.email = text(data.email || data.address || data.inbox?.emailAddress);
    if (!this.email) throw Object.assign(new Error(`CF Worker 创建邮箱失败 HTTP ${response.status}`), { code: 'CFWORKER_MAIL_CREATE_FAILED' });
    this.mailId = `cfworker:${this.email}`;
    return { email: this.email, id: this.mailId, provider: 'cfworker' };
  }
  async wait(session, _account, _settings, options = {}) {
    const deadline = Date.now() + Math.max(10000, Number(options.timeoutMs) || 300000);
    while (Date.now() < deadline) {
      if (options.cancelled?.()) throw Object.assign(new Error('CF Worker 收码已取消'), { code: 'JOB_CANCELLED' });
      const response = await this.fetch(`${this.apiUrl}/admin/mails?address=${encodeURIComponent(this.email)}&limit=20`, { headers: this.headers() });
      if (response.ok) {
        const data = await response.json();
        for (const row of data.results || data.items || []) {
          const raw = [row.subject, row.content, row.raw, row.html].filter(Boolean).join('\n');
          const hit = extractVerification([{ subject: row.subject || '', text: raw, html: row.html || raw }]);
          if (hit.code || hit.url) { this.codesRead += 1; return { ...hit, email: this.email }; }
        }
      }
      await wait(session, Math.max(1000, Number(options.intervalMs) || 3000));
    }
    throw Object.assign(new Error('等待 CF Worker 验证邮件超时'), { code: 'CFWORKER_MAIL_CODE_TIMEOUT' });
  }
  async finish() { return true; }
  async cancel() { return true; }
}

module.exports = { parseImportedMailboxList, ImportedMailChannel, CfWorkerMailChannel, safeUrl };
