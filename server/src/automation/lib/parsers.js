const PLAN_TYPES = ['Free', 'Plus', 'Pro', 'Team'];
const normalizePlan = (value) => PLAN_TYPES.find(x => x.toLowerCase() === String(value || '').trim().toLowerCase()) || 'Free';
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const nextId = (list) => list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;

function decodeJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const rawPlan = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type;
    const wall = payload.exp ? new Date(payload.exp * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';
    return { payload, plan: rawPlan ? normalizePlan(rawPlan) : null, expires_at: wall, expire_date: wall ? wall.slice(0, 10) : '' };
  } catch { return { payload: null, plan: null, expires_at: '', expire_date: '' }; }
}

function parseSub2Api(data) {
  const source = Array.isArray(data) ? data : data?.accounts || data?.data || [];
  return source.filter(x => x && typeof x === 'object').map(x => {
    const credentials = x.credentials || {}; const token = credentials.access_token || ''; const jwt = decodeJwt(token);
    return { email: String(x.extra?.email || x.name || x.email || '').trim(), password: x.password || '', account_type: x.account_type || x.source || '', source: x.source || '', vmail_id: x.vmail_id || x.mailbox_id || '', vmail_token: x.vmail_token || x.mailbox_token || '', gmail_access_token: x.gmail_access_token || '', gmail_refresh_token: x.gmail_refresh_token || '', gmail_client_id: x.gmail_client_id || '', gmail_client_secret: x.gmail_client_secret || '', plan_type: jwt.plan || x.plan_type || x.plan || 'Free', expire_date: jwt.expire_date || timestampDate(credentials.expires_at) || x.expire_date || '', status: '未检测', remark: x.platform || '', access_token: token, refresh_token: credentials.refresh_token || x.refresh_token || '', client_id: credentials.client_id || x.client_id || '', client_secret: x.client_secret || '', chatgpt_account_id: credentials.chatgpt_account_id || '' };
  }).filter(x => x.email);
}

function parseAccounts(text) {
  const value = String(text || '').trim(); if (!value) return [];
  if (/^[\[{]/.test(value)) { try { return parseSub2Api(JSON.parse(value)); } catch (e) { throw new Error(`JSON 格式解析失败: ${e.message}`); } }
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const parts = (line.includes('----') ? line.split('----') : line.includes('\t') ? line.split('\t') : line.split(',')).map(x => x.trim());
    return { email: parts[0] || '', password: parts[1] || '', plan_type: normalizePlan(parts[2]), expire_date: parts[3] || '', status: '未检测', remark: parts[4] || '', account_type: parts[5] || '' };
  }).filter(x => x.email);
}

function parseRegisterEmails(text) {
  const rows = [], errors = [];
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    const line = raw.trim(); if (!line) continue; const p = line.split('----').map(x => x.trim());
    if (!p[0] || !p[0].includes('@')) { errors.push(`第 ${index + 1} 行邮箱格式错误`); continue; }
    rows.push({ email: p[0], password: p[1] || '', refresh_token: p[2] || '', client_id: p[3] || '', import_token: p[4] || '', account_type: 'gmail', source: 'gmail', vmail_id: '' });
  }
  return { rows, errors };
}

function parseActivationItems(text, defaultCountry = 'BR', options = {}) {
  const rows = [], errors = [];
  const fallbackCountry = String(defaultCountry || 'BR').trim().toUpperCase() || 'BR';
  const automaticPhoneOnly = options?.automaticPhoneOnly === true;
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (automaticPhoneOnly) {
      const fields = line.includes('----')
        ? line.split('----')
        : line.includes('\t')
          ? line.split('\t')
          : line.includes(',')
            ? line.split(',')
            : line.split(/\s+/);
      if (fields.map(value => value.trim()).filter(Boolean).length !== 1) {
        errors.push(`第 ${index + 1} 行仅需 BA Token 或协议链接；手机号和国家由开通参数自动处理`);
        continue;
      }
      rows.push({ ba: fields[0].trim(), phone: '', country: fallbackCountry });
      continue;
    }
    let parts;
    if (line.includes('----')) parts = line.split('----');
    else if (line.includes('\t')) parts = line.split('\t');
    else if (line.includes(',')) parts = line.split(',');
    else parts = line.split(/\s+/);
    parts = parts.map(value => value.trim()).filter((value, position) => value || position === 0);
    const ba = parts[0] || '';
    if (!ba) { errors.push(`第 ${index + 1} 行缺少 BA Token 或协议链接`); continue; }
    let phone = parts[1] || '';
    let country = parts[2] || fallbackCountry;
    if (!parts[2] && /^[A-Za-z]{2}$/.test(phone)) { country = phone; phone = ''; }
    country = String(country || fallbackCountry).trim().toUpperCase();
    phone = String(phone || '').replace(/[\s().-]+/g, '');
    if (!/^[A-Z]{2}$/.test(country)) { errors.push(`第 ${index + 1} 行国家代码格式错误`); continue; }
    if (phone && !/^\+?\d{7,18}$/.test(phone)) { errors.push(`第 ${index + 1} 行手机号格式错误`); continue; }
    rows.push({ ba, phone, country });
  }
  return { rows, errors };
}

function parseProxyLine(raw, group = '默认分组') {
  let line = String(raw || '').trim(); if (!line) return null;
  const original = line; let proxy_type = 'http'; let host = '', port = 0, username = '', password = '';
  try {
    if (/^[a-z]+:\/\//i.test(line)) { const u = new URL(line); proxy_type = u.protocol.replace(':','').replace('socks5h','socks5'); if (!['http','https','socks5'].includes(proxy_type)) return null; host = u.hostname; port = Number(u.port); username = decodeURIComponent(u.username); password = decodeURIComponent(u.password); }
    else if (line.includes('@')) { const at = line.lastIndexOf('@'); const auth = line.slice(0, at); const addr = line.slice(at + 1); const colon = addr.lastIndexOf(':'); const h = addr.slice(0, colon); const p = addr.slice(colon + 1); const cut = auth.indexOf(':'); host=h; port=Number(p); username=cut>=0?auth.slice(0,cut):auth; password=cut>=0?auth.slice(cut+1):''; }
    else { const p = line.split(':'); if (p.length >= 4) { [host, port, username] = p; password = p.slice(3).join(':'); port = Number(port); } else { [host, port] = p; port = Number(port); } }
  } catch { return null; }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { name: '', group_name: group, proxy_type, host, port, username, password, status: '未检测', latency: null, remark: '', region: '', raw: original };
}
const parseProxies = (text, group) => String(text || '').split(/\r?\n/).map(x => parseProxyLine(x, group)).filter(Boolean);

exports.normalizePlan = normalizePlan;
exports.now = now;
exports.nextId = nextId;
exports.decodeJwt = decodeJwt;
exports.parseSub2Api = parseSub2Api;
exports.parseAccounts = parseAccounts;
exports.parseRegisterEmails = parseRegisterEmails;
exports.parseActivationItems = parseActivationItems;
exports.parseProxyLine = parseProxyLine;
exports.parseProxies = parseProxies;
function timestampDate(v) { const n = Number(v); if (!n) return ''; try { return new Date(n * (n < 1e12 ? 1000 : 1)).toISOString().slice(0,10); } catch { return ''; } }
