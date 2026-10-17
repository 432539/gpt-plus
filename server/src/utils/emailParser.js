// 邮箱批量导入解析(移植自参考项目 email_import.py,按形状识别)
// 支持:
//   邮箱
//   邮箱----密码
//   邮箱----取件链接
//   邮箱----标签----取件链接
//   邮箱----密码----client_id----refresh_token
//   空格/逗号/分号/竖线/Tab 分隔
//   JSON 数组或 {data|emails|items|list|accounts} 包裹
//   CSV(含表头 email/url/password/client_id/refresh_token)

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i;
const URL_RE = /https?:\/\/[^\s,;|"'<>]+/i;

const ADDRESS_KEYS = ['email', 'address', 'mail', 'mailbox', 'account', 'username', 'user', '邮箱'];
const URL_KEYS = ['url', 'link', 'href', 'fetch_url', 'mailbox_url', 'inbox_url', 'mail_url', 'auth_url', 'latest', '取件链接'];
const LABEL_KEYS = ['label', 'tag', 'name', 'remark', 'note', 'title', '标签'];
const PASSWORD_KEYS = ['password', 'pwd', 'pass', 'app_password', 'apppassword', '密码'];
const CLIENT_KEYS = ['client_id', 'clientid', 'client'];
const REFRESH_KEYS = ['refresh_token', 'refreshtoken', 'rt', 'refresh'];
const LIST_KEYS = ['data', 'emails', 'items', 'list', 'accounts', 'mailboxes', 'result', 'rows', 'records'];

const isUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());
const looksEmail = (v) => {
  const t = String(v || '').trim();
  return Boolean(t) && t.includes('@') && t.split('@').pop().includes('.');
};
const isRefreshToken = (v) => {
  const t = String(v || '').trim();
  if (!t || isUrl(t)) return false;
  if (t.startsWith('M.') && t.length > 40) return true;
  return t.length >= 80;
};
const firstEmail = (t) => {
  const m = EMAIL_RE.exec(String(t || ''));
  return m ? m[0] : '';
};
const firstUrl = (t) => {
  const m = URL_RE.exec(String(t || ''));
  return m ? m[0].replace(/[).,\]}>"']+$/, '') : '';
};
const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
const { looksMailcomAddress } = require('./mailcomDomains');

const emptyRow = (address) => ({ address, label: '', url: '', password: '', client_id: '', refresh_token: '' });

function pick(obj, names) {
  const wanted = new Set(names.map(normKey));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(normKey(key))) {
      const t = String(value ?? '').trim();
      if (t) return t;
    }
  }
  return '';
}

function rowFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let address = pick(obj, ADDRESS_KEYS);
  if (!looksEmail(address)) {
    const joined = Object.values(obj).filter((v) => typeof v === 'string').join(' ');
    address = firstEmail(address) || firstEmail(joined);
  }
  if (!looksEmail(address)) return null;
  const out = emptyRow(address);
  let url = pick(obj, URL_KEYS);
  if (!isUrl(url)) {
    const joined = Object.values(obj).filter((v) => typeof v === 'string').join(' ');
    url = firstUrl(url) || firstUrl(joined);
  }
  if (isUrl(url)) out.url = url;
  out.label = pick(obj, LABEL_KEYS);
  out.password = pick(obj, PASSWORD_KEYS);
  out.client_id = pick(obj, CLIENT_KEYS);
  out.refresh_token = pick(obj, REFRESH_KEYS);
  return out;
}

function walkJson(payload, out, depth = 0) {
  if (depth > 6) return;
  const row = rowFromObject(payload);
  if (row) {
    out.push(row);
    return;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) walkJson(item, out, depth + 1);
    return;
  }
  if (payload && typeof payload === 'object') {
    for (const key of LIST_KEYS) {
      const nested = payload[key];
      if (Array.isArray(nested) || (nested && typeof nested === 'object')) {
        walkJson(nested, out, depth + 1);
        if (out.length) return;
      }
    }
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) || (value && typeof value === 'object')) walkJson(value, out, depth + 1);
    }
  }
}

function parseJson(text) {
  const raw = String(text || '').replace(/^\ufeff/, '').trim();
  if (!raw || !'{['.includes(raw[0])) return [];
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = [];
  walkJson(payload, rows);
  return rows;
}

function splitLoose(line) {
  for (const sep of ['----', '|', '\t', ';', ',']) {
    if (line.includes(sep)) {
      const parts = line.split(sep).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) return parts;
    }
  }
  return line.split(/\s+/).map((p) => p.trim()).filter(Boolean);
}

function parseLine(line) {
  const raw = String(line || '').replace(/^\ufeff/, '').trim();
  if (!raw || raw.startsWith('#')) return null;

  const url = firstUrl(raw);
  const address = firstEmail(raw);
  if (address && url) {
    const out = emptyRow(address);
    out.url = url;
    if (raw.includes('----')) {
      const parts = raw.split('----').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 3 && looksEmail(parts[0]) && !isUrl(parts[1])) out.label = parts[1];
    }
    return out;
  }

  let parts = raw.split('----').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) parts = splitLoose(raw);
  if (!parts.length) return null;
  if (!looksEmail(parts[0])) {
    if (!address) return null;
    parts = [address, ...parts.filter((p) => p !== address)];
  }
  const out = emptyRow(parts[0]);
  if (parts.length === 1) return out;

  const urlIdx = parts.findIndex((p, i) => i > 0 && isUrl(p));
  if (urlIdx > 0) {
    if (urlIdx === 1) out.url = raw.includes('----') ? parts.slice(1).join('----') : parts[urlIdx];
    else {
      out.label = parts[1];
      out.url = raw.includes('----') ? parts.slice(urlIdx).join('----') : parts[urlIdx];
    }
    return out;
  }

  if (parts.length >= 4 && (UUID_RE.test(parts[2]) || isRefreshToken(parts[3]))) {
    out.password = parts[1];
    out.client_id = parts[2];
    out.refresh_token = parts.slice(3).join('----');
    return out;
  }

  if (parts.length === 2) {
    // 两段:mail.com 视为密码,否则视为标签
    if (looksMailcomAddress(parts[0])) out.password = parts[1];
    else out.label = parts[1];
    return out;
  }
  out.label = parts[1];
  out.url = parts.slice(2).join('----');
  return out;
}

function parseCsv(text) {
  const sample = String(text || '').replace(/^\ufeff/, '').replace(/^\s+/, '');
  const first = sample.split(/\r?\n/)[0] || '';
  if (!first || first.includes('----')) return [];
  const header = normKey(first);
  if (!['email', 'address', 'mail', '邮箱'].some((k) => header.includes(normKey(k)))) return [];
  // 简单 CSV:按 , ; \t | 检测分隔符
  const delim = [',', ';', '\t', '|'].find((d) => first.includes(d)) || ',';
  const lines = sample.split(/\r?\n/).filter((l) => l.trim());
  const cols = lines[0].split(delim).map((c) => c.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = lines[i].split(delim);
    const obj = {};
    cols.forEach((c, idx) => {
      obj[c] = (values[idx] || '').trim();
    });
    const parsed = rowFromObject(obj);
    if (parsed) rows.push(parsed);
  }
  return rows;
}

function parseEmailImport(text) {
  const raw = String(text || '').replace(/^\ufeff/, '');
  if (!raw.trim()) return [];
  let rows = parseJson(raw);
  if (rows.length) return rows.map(finalize);
  rows = parseCsv(raw);
  if (rows.length) return rows.map(finalize);
  const parsed = [];
  for (const line of raw.split(/\r?\n/)) {
    const item = parseLine(line);
    if (item) parsed.push(finalize(item));
  }
  return parsed;
}

// 补全 mailbox_type
function finalize(row) {
  const out = { ...row };
  if (out.url) out.mailbox_type = 'url';
  else if (out.client_id && out.refresh_token) out.mailbox_type = 'outlook';
  else if (out.password && looksMailcomAddress(out.address)) out.mailbox_type = 'mailcom';
  else if (out.password) out.mailbox_type = 'password';
  else out.mailbox_type = 'unknown';
  return out;
}

// 是否具备收件能力
function canFetch(row) {
  if (!row) return false;
  if (String(row.fetch_url || row.url || '').trim()) return true;
  if (String(row.refresh_token || '').trim() && String(row.client_id || '').trim()) return true;
  if (String(row.password || '').trim() && looksMailcomAddress(row.address)) return true;
  return false;
}

module.exports = { parseEmailImport, canFetch, looksMailcom: looksMailcomAddress, finalize };
