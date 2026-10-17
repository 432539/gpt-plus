// 收件测试:按邮箱类型选择收件方式
//   url     — 取件链接直连(HTTP GET,识别常见 JSON/文本响应)
//   outlook — client_id + refresh_token 换 access_token,IMAP XOAUTH2 拉最新邮件
//   mailcom — 需要 CloakBrowser 浏览器会话,当前版本先提示
const { ImapFlow } = require('imapflow');

const FETCH_TIMEOUT = 20000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractMailFromJson(payload) {
  // 常见取件接口返回:{data:[{subject,from,...}]} / [{...}] / {subject,...}
  const pickList = (p) => {
    if (Array.isArray(p)) return p;
    if (p && typeof p === 'object') {
      for (const k of ['data', 'emails', 'items', 'list', 'messages', 'result', 'rows']) {
        if (Array.isArray(p[k])) return p[k];
      }
    }
    return null;
  };
  const list = pickList(payload);
  const item = list ? list[0] : payload && typeof payload === 'object' ? payload : null;
  if (!item || typeof item !== 'object') return null;
  const get = (keys) => {
    for (const k of keys) {
      for (const [key, v] of Object.entries(item)) {
        if (key.toLowerCase() === k && v) return String(v);
      }
    }
    return '';
  };
  const subject = get(['subject', 'title', '主题']);
  const from = get(['from', 'sender', 'from_address', '发件人']);
  const date = get(['date', 'time', 'created_at', 'receivedat', '时间']);
  const body = get(['body', 'content', 'text', 'html', '内容']);
  if (!subject && !from && !body) return null;
  return { subject, from, date, snippet: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

async function testFetchUrl(url) {
  const resp = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, text/html;q=0.9, */*;q=0.8' },
  });
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false, message: `取件链接返回 HTTP ${resp.status}` };
  }
  let mail = null;
  try {
    mail = extractMailFromJson(JSON.parse(text));
  } catch {
    /* 非 JSON */
  }
  if (mail) {
    return { ok: true, message: '取件成功', mail };
  }
  const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return { ok: true, message: '链接可访问,但暂无邮件内容' };
  return { ok: true, message: '链接可访问', mail: { subject: '', from: '', date: '', snippet: plain.slice(0, 200) } };
}

async function getOutlookAccessToken(clientId, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
  });
  const resp = await fetchWithTimeout('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    const reason = data.error_description || data.error || `HTTP ${resp.status}`;
    throw new Error(`获取 Outlook 令牌失败: ${String(reason).split(/\r?\n/)[0].slice(0, 160)}`);
  }
  return { accessToken: data.access_token, newRefreshToken: data.refresh_token || '' };
}

async function testOutlook(address, clientId, refreshToken) {
  const { accessToken, newRefreshToken } = await getOutlookAccessToken(clientId, refreshToken);
  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: { user: address, accessToken },
    logger: false,
    socketTimeout: FETCH_TIMEOUT,
    greetingTimeout: FETCH_TIMEOUT,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists;
      let mail = null;
      if (total > 0) {
        const msg = await client.fetchOne(String(total), { envelope: true }, { uid: false });
        if (msg && msg.envelope) {
          mail = {
            subject: msg.envelope.subject || '',
            from: (msg.envelope.from || []).map((a) => a.address).join(', '),
            date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : '',
            snippet: '',
          };
        }
      }
      return { ok: true, message: `IMAP 登录成功,收件箱 ${total} 封邮件`, mail, newRefreshToken };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

async function testReceive(row) {
  const type = row.mailbox_type || 'password';
  if (row.fetch_url) {
    return testFetchUrl(row.fetch_url);
  }
  if (row.client_id && row.refresh_token) {
    return testOutlook(row.address, row.client_id, row.refresh_token);
  }
  if (type === 'mailcom') {
    return { ok: false, message: 'mail.com 收件需要 CloakBrowser 浏览器会话,该功能将在浏览器编排模块启用后支持' };
  }
  return { ok: false, message: '该邮箱缺少收件凭据(取件链接或 Outlook 卡密),无法收件测试' };
}

module.exports = { testReceive };
