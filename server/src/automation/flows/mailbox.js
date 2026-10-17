const { extractVerificationMessage } = require('../../utils/verificationMail');

const text = value => value === undefined || value === null ? '' : String(value).trim();

const ACCOUNT_TYPES = Object.freeze({ GMAIL: 'gmail', VMAIL: 'vmail' });
const VMAIL_DEFAULTS = Object.freeze({
  createPath: '/api/v1/mailboxes',
  messagesPath: '/api/v1/mailboxes/{id}/messages',
  messageDetailPath: '/api/v1/mailboxes/{id}/messages/{messageId}',
  configPath: '/config',
  authHeader: 'X-API-Key',
  authScheme: '',
});

function normalizeAccountType(value, account = {}) {
  const explicit = text(value || account.account_type || account.source).toLowerCase();
  if (explicit === ACCOUNT_TYPES.VMAIL || account.vmail_id || account.vmail_token) return ACCOUNT_TYPES.VMAIL;
  return ACCOUNT_TYPES.GMAIL;
}

/**
 * 注册浏览器里应当绕开代理直连的主机。
 *
 * 注册全程必须留在 CloakBrowser + 代理上（ChatGPT 侧要靠代理出口决定地区和信誉），
 * 但验证码轮询打的是自建 VMAIL：绕代理只是白多一跳，还会把代理抖动变成「等待验证邮件
 * 超时」。给这一个主机加 --proxy-bypass-list，就能在同一个浏览器里让它走直连。
 */
function mailboxProxyBypass(settings = {}) {
  const raw = text(settings.vmail_api_url || settings.apiUrl);
  if (!raw) return '';
  try { return new URL(raw).hostname; } catch { return ''; }
}

function apiBase(settings = {}) {
  const raw = text(settings.vmail_api_url || settings.apiUrl || settings.base || settings.upstream);
  if (!raw) throw new Error('VMAIL API 地址未配置');
  let url;
  try { url = new URL(raw); } catch { throw new Error('VMAIL API 地址格式错误'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('VMAIL API 地址协议错误');
  return url.href.replace(/\/$/, '');
}

function endpoint(settings, pathValue) {
  return new URL(pathValue, `${apiBase(settings)}/`).href;
}

function vmailHeaders(settings = {}, mailboxToken = '') {
  const key = text(mailboxToken || settings.vmail_key || settings.apiKey || settings.key);
  if (!key) return { Accept: 'application/json' };
  const header = text(settings.vmail_auth_header || settings.authHeader) || VMAIL_DEFAULTS.authHeader;
  const configuredScheme = settings.vmail_auth_scheme ?? settings.authScheme;
  const scheme = configuredScheme === undefined
    ? (header.toLowerCase() === 'authorization' ? 'Bearer' : VMAIL_DEFAULTS.authScheme)
    : text(configuredScheme);
  return { Accept: 'application/json', [header]: scheme ? `${scheme} ${key}` : key };
}

function replaceMailboxPath(template, account) {
  const id = text(account.vmail_id || account.mailbox_id || account.email);
  const email = text(account.email);
  return String(template || VMAIL_DEFAULTS.messagesPath)
    .replaceAll('{id}', encodeURIComponent(id))
    .replaceAll('{mailbox}', encodeURIComponent(id))
    .replaceAll('{email}', encodeURIComponent(email));
}

function replaceMessageDetailPath(template, account, message) {
  return replaceMailboxPath(template || VMAIL_DEFAULTS.messageDetailPath, account)
    .replaceAll('{messageId}', encodeURIComponent(text(message?.id)))
    .replaceAll('{message_id}', encodeURIComponent(text(message?.id)));
}

function nestedData(value) {
  if (!value || typeof value !== 'object') return value;
  return value.data ?? value.result ?? value;
}

function listFromResponse(value) {
  const root = nestedData(value);
  if (Array.isArray(root)) return root;
  for (const candidate of [root?.messages, root?.items, root?.emails, root?.data]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizeMessage(message = {}) {
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  return {
    ...message,
    id: text(message.id || message.message_id || message.messageId),
    subject: text(message.subject || message.title),
    html: text(message.html || message.html_body || body.html || body.content),
    text: text(message.text || message.text_body || message.bodyPreview || message.preview || (typeof message.body === 'string' ? message.body : body.text)),
    received_at: text(message.received_at || message.receivedAt || message.created_at || message.createdAt || message.date),
  };
}

function responseMessage(response = {}) {
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  return text(data.error?.message || data.message || data.error?.code || response.text).slice(0, 200);
}

function responseError(action, response = {}) {
  const status = Number(response.status) || 0;
  const upstream = responseMessage(response);
  let message = `${action}失败 HTTP ${status || 'unknown'}${upstream ? `: ${upstream}` : ''}`;
  let code = 'VMAIL_API_ERROR';
  if (/site is locked/i.test(upstream)) {
    message = 'VMAIL 请求触发站点锁定，请检查 API 地址，并确认接口路径使用 /api/v1/mailboxes';
    code = 'VMAIL_SITE_LOCKED';
  } else if (status === 401) {
    message = 'VMAIL API Key 校验失败（HTTP 401），请确认密钥属于当前 VMAIL 站点';
    code = 'VMAIL_AUTH_FAILED';
  } else if (status === 403 && /OPENAPI_DISABLED|open.?api/i.test(upstream)) {
    message = 'VMAIL 站点尚未启用 Open API（HTTP 403），请在 VMAIL 服务端开启 API';
    code = 'VMAIL_OPENAPI_DISABLED';
  } else if (status === 429) {
    message = 'VMAIL 请求达到频率限制（HTTP 429），请稍后重试或减少注册数量';
    code = 'VMAIL_RATE_LIMITED';
  }
  const error = new Error(message);
  error.code = code;
  error.status = status;
  const retryAfter = Number(response.headers?.['retry-after'] || response.headers?.['Retry-After']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = Math.min(60000, retryAfter * 1000);
  return error;
}

function domainList(value) {
  const root = nestedData(value) || {};
  const raw = root.emailDomain ?? root.emailDomains ?? root.domains ?? [];
  const items = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return [...new Set(items.map(text).filter(Boolean))];
}

function decodeBase64Url(value) {
  const raw = text(value);
  if (!raw) return '';
  try { return Buffer.from(raw, 'base64url').toString('utf8'); } catch { return ''; }
}

function gmailBody(part = {}) {
  const chunks = [];
  if (part.body?.data) chunks.push(decodeBase64Url(part.body.data));
  for (const child of Array.isArray(part.parts) ? part.parts : []) chunks.push(gmailBody(child));
  return chunks.filter(Boolean).join('\n');
}

function gmailHeader(message, name) {
  const wanted = String(name).toLowerCase();
  return text((message.payload?.headers || []).find(item => String(item.name || '').toLowerCase() === wanted)?.value);
}

class MailboxFlow {
  accountType(account) { return normalizeAccountType(account?.account_type, account); }

  async messages(session, account, settings = {}) {
    return this.accountType(account) === ACCOUNT_TYPES.VMAIL
      ? this.vmail(session, account, settings)
      : this.gmail(session, account, settings);
  }

  async gmailAccessToken(session, account) {
    const direct = text(account.gmail_access_token || account.mail_access_token);
    if (direct) return direct;
    const refreshToken = text(account.gmail_refresh_token || account.refresh_token);
    const clientId = text(account.gmail_client_id || account.client_id);
    const clientSecret = text(account.gmail_client_secret || account.client_secret);
    if (!refreshToken || !clientId) throw new Error('Gmail 邮箱缺少 refresh_token/client_id');
    const token = await session.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      form: {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });
    if (!token.ok) throw new Error(`Gmail 令牌刷新失败 HTTP ${token.status}`);
    const access = text(token.data?.access_token);
    if (!access) throw new Error('Gmail 令牌响应缺少 access_token');
    return access;
  }

  async gmail(session, account) {
    const access = await this.gmailAccessToken(session, account);
    const headers = { Authorization: `Bearer ${access}`, Accept: 'application/json' };
    const list = await session.request('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=newer_than%3A2d', { headers });
    if (!list.ok) throw new Error(`Gmail 收件箱读取失败 HTTP ${list.status}`);
    const refs = Array.isArray(list.data?.messages) ? list.data.messages.slice(0, 20) : [];
    const messages = [];
    for (const ref of refs) {
      const id = text(ref?.id);
      if (!id) continue;
      const response = await session.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, { headers });
      if (!response.ok) continue;
      const message = response.data || {};
      const body = gmailBody(message.payload);
      messages.push({
        id,
        subject: gmailHeader(message, 'subject'),
        html: body,
        text: text(message.snippet) || body,
        received_at: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : gmailHeader(message, 'date'),
      });
    }
    return messages;
  }

  async vmail(session, account, settings = {}) {
    const pathValue = replaceMailboxPath(settings.vmail_messages_path || settings.messagesPath, account);
    const response = await session.request(endpoint(settings, pathValue), {
      headers: vmailHeaders(settings, account.vmail_token),
      timeout: Number(settings.vmail_timeout_ms || settings.timeoutMs) || 30000,
    });
    if (!response.ok) throw responseError('VMAIL 收件箱读取', response);
    const messages = listFromResponse(response.data).map(normalizeMessage);
    const detailTemplate = settings.vmail_message_detail_path || settings.messageDetailPath || VMAIL_DEFAULTS.messageDetailPath;
    for (let index = 0; index < Math.min(messages.length, 10); index += 1) {
      const message = messages[index];
      if (!message.id || this.extract([message]).url || this.extract([message]).code) continue;
      const detail = await session.request(endpoint(settings, replaceMessageDetailPath(detailTemplate, account, message)), {
        headers: vmailHeaders(settings, account.vmail_token),
        timeout: Number(settings.vmail_timeout_ms || settings.timeoutMs) || 30000,
      });
      if (!detail.ok) continue;
      messages[index] = normalizeMessage({ ...message, ...(nestedData(detail.data) || {}) });
    }
    return messages;
  }

  extract(messages) {
    for (const message of messages) {
      const hit = extractVerificationMessage(message);
      if (hit.url || hit.code) return hit;
    }
    return { url: '', code: '', message: null };
  }

  async wait(session, account, settings, { timeoutMs = 120000, intervalMs = 3000, after = 0, log = () => {}, cancelled = null } = {}) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (cancelled?.()) throw new Error('邮箱验证码等待已取消');
      const messages = await this.messages(session, account, settings);
      const recent = messages.filter(message => {
        const receivedAt = message.received_at || message.date;
        return !after || !receivedAt || new Date(receivedAt).getTime() >= after;
      });
      const hit = this.extract(recent);
      if (hit.url || hit.code) return { ...hit, account_type: this.accountType(account) };
      log(`等待 ${this.accountType(account) === ACCOUNT_TYPES.VMAIL ? 'VMAIL' : 'Gmail'} 验证邮件…`, 'debug');
      await session.wait(intervalMs);
    }
    throw new Error('等待验证邮件超时');
  }

  async createVmail(session, settings = {}) {
    const key = text(settings.vmail_key || settings.apiKey || settings.key);
    if (!key) throw new Error('VMAIL API Key 未配置');
    const localPart = text(settings.local_part || settings.localPart);
    const domain = text(settings.domain || settings.vmail_domain);
    const createPath = settings.vmail_create_path || settings.createPath || VMAIL_DEFAULTS.createPath;
    const configPath = settings.vmail_config_path || settings.configPath || VMAIL_DEFAULTS.configPath;
    const response = await session.request(endpoint(settings, createPath), {
      method: 'POST',
      headers: vmailHeaders(settings),
      json: {
        ...(localPart ? { localPart } : {}),
        ...(domain ? { domain } : {}),
      },
      timeout: Number(settings.vmail_timeout_ms || settings.timeoutMs) || 30000,
      contextUrl: endpoint(settings, configPath),
    });
    if (!response.ok) throw responseError('创建 VMAIL 邮箱', response);
    const root = nestedData(response.data) || {};
    const address = text(root.address || root.email || root.email_address || root.mailbox);
    const id = text(root.id || root.mailbox_id || root.mailboxId || address);
    const token = text(root.token || root.access_token || root.mailbox_token);
    if (!address) throw new Error('VMAIL 响应缺少邮箱地址');
    return { ...root, address, email: address, id, mailbox_id: id, token };
  }

  async domains(session, settings = {}) {
    const configPath = settings.vmail_config_path || settings.configPath || VMAIL_DEFAULTS.configPath;
    const response = await session.request(endpoint(settings, configPath), {
      headers: { Accept: 'application/json' },
      timeout: Number(settings.vmail_timeout_ms || settings.timeoutMs) || 30000,
    });
    if (!response.ok) throw responseError('读取 VMAIL 域名配置', response);
    const root = nestedData(response.data) || {};
    const domains = domainList(root);
    return {
      domains,
      default_domain: domains[0] || '',
      open_api_enabled: root.openApiEnabled !== false,
      status: response.status,
      endpoint: endpoint(settings, configPath),
    };
  }

  async test(session, settings = {}) {
    let configResult;
    try {
      configResult = await this.domains(session, settings);
    } catch (error) {
      return { ok: false, connected: false, status: error.status || 0, endpoint: apiBase(settings), message: error.message, domains: [] };
    }
    if (!configResult.open_api_enabled) {
      return { ...configResult, ok: false, connected: false, status: 403, message: 'VMAIL 站点尚未启用 Open API' };
    }
    const createPath = settings.vmail_create_path || settings.createPath || VMAIL_DEFAULTS.createPath;
    const probePath = `${String(createPath).replace(/\/$/, '')}/__codex_probe__`;
    const response = await session.request(endpoint(settings, probePath), {
      headers: vmailHeaders(settings),
      timeout: Number(settings.vmail_timeout_ms || settings.timeoutMs) || 30000,
    });
    const ok = response.ok || [404, 405].includes(response.status);
    return {
      ...configResult,
      ok,
      connected: ok,
      status: ok ? configResult.status : response.status,
      probe_status: response.status,
      endpoint: endpoint(settings, createPath),
      message: ok ? `VMAIL API 鉴权通过，可用域名 ${configResult.domains.length} 个` : responseError('VMAIL API 鉴权测试', response).message,
    };
  }
}

exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
exports.VMAIL_DEFAULTS = VMAIL_DEFAULTS;
exports.normalizeAccountType = normalizeAccountType;
exports.mailboxProxyBypass = mailboxProxyBypass;
exports.MailboxFlow = MailboxFlow;
exports.extractVerification = messages => new MailboxFlow().extract(Array.isArray(messages) ? messages : []);
