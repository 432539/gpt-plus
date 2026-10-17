const { normalizePlan } = require('./accountFields');

// 从 JWT payload 读取公开 claims；失败时不猜测。
function decodeJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const auth = payload?.['https://api.openai.com/auth'] || {};
    const profile = payload?.['https://api.openai.com/profile'] || {};
    const rawPlan = auth.chatgpt_plan_type;
    return {
      plan: rawPlan ? normalizePlan(rawPlan) : null,
      expires_at: payload.exp ? new Date(payload.exp * 1000).toISOString().replace('T', ' ').slice(0, 19) : '',
      expire_date: payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : '',
      email: profile.email || payload.email || '',
      account_id: auth.chatgpt_account_id || '',
    };
  } catch {
    return { plan: null, expires_at: '', expire_date: '', email: '', account_id: '' };
  }
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeJsonAccount(x) {
      if (!x || typeof x !== 'object') return null;
      const credentials = x.credentials || {};
      const providerType = String(x.platform || x.type || '').toLowerCase();
      if (providerType && !['openai', 'codex', 'oauth'].includes(providerType)) {
        return { email: '' };
      }
      const token = credentials.access_token || x.access_token || '';
      const jwt = decodeJwt(token);
      const idJwt = decodeJwt(credentials.id_token || x.id_token || '');
      const totp = String(x.totp_secret || credentials.totp_secret || '').replace(/[\s-]+/g, '').toUpperCase();
      const expiresAt = normalizeTimestamp(
        credentials.expires_at ?? x.expires_at ?? x.expired ?? x.expire_date
      ) || jwt.expires_at;
      return {
        email: String(x.extra?.email || credentials.email || x.email || jwt.email || idJwt.email || x.name || '').trim(),
        password: x.password || '',
        email_type: x.account_type || x.source || x.email_type || '',
        plan_type: x.plan_type || credentials.plan_type || x.plan || jwt.plan || idJwt.plan || 'Free',
        expires_at: expiresAt,
        status: x.status || '未检测',
        remark: x.platform || x.remark || '',
        access_token: token,
        refresh_token: credentials.refresh_token || x.refresh_token || '',
        id_token: credentials.id_token || x.id_token || '',
        session_token: credentials.session_token || x.session_token || '',
        client_id: credentials.client_id || x.client_id || '',
        client_secret: x.client_secret || '',
        chatgpt_account_id: credentials.chatgpt_account_id || x.chatgpt_account_id || x.account_id || jwt.account_id || idJwt.account_id || '',
        vmail_id: x.vmail_id || x.mailbox_id || '',
        vmail_token: x.vmail_token || x.mailbox_token || '',
        gmail_access_token: x.gmail_access_token || '',
        gmail_refresh_token: x.gmail_refresh_token || '',
        gmail_client_id: x.gmail_client_id || '',
        gmail_client_secret: x.gmail_client_secret || '',
        totp_secret: totp,
        mfa_factor_id: x.mfa_factor_id || '',
        mfa_factor_type: x.mfa_factor_type || (totp ? 'totp' : ''),
        mfa_enabled: x.mfa_enabled === true || Boolean(totp),
        password_set: x.password_set === undefined ? Boolean(x.password) : x.password_set === true,
        security_ready: x.security_ready === true || (Boolean(x.password) && Boolean(totp)),
        hardening_status: x.hardening_status || (totp ? 'complete' : ''),
        hardening_error_code: x.hardening_error_code || '',
        hardening_error: x.hardening_error || '',
        hardening_updated_at: x.hardening_updated_at || '',
        mfa_enrolled_at: x.mfa_enrolled_at || '',
        last_detected_at: x.last_detected_at || '',
        last_refresh_at: x.last_refresh_at || '',
        last_security_state: x.last_security_state || '',
        token_invalidated: x.token_invalidated === true,
        has_trial: x.has_trial,
        trial_label: x.trial_label || '',
        progress: x.progress || '',
        extract_link: x.extract_link || x.payment_link || '',
      };
}

// 支持 Sub2 聚合、CPA 单对象/数组，以及标准完整备份。
function parseJsonAccounts(data) {
  const source = Array.isArray(data)
    ? data
    : Array.isArray(data?.accounts)
      ? data.accounts
      : Array.isArray(data?.data)
        ? data.data
        : data && typeof data === 'object'
          ? [data]
          : [];
  return source.map(normalizeJsonAccount).filter(Boolean);
}

function csvParts(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { out.push(current); current = ''; }
    else current += character;
  }
  out.push(current);
  return out.map((x) => x.trim());
}

function parseDelimitedLines(lines) {
  const first = lines[0]?.replace(/^\uFEFF/, '') || '';
  const header = first.includes(',') ? csvParts(first).map((x) => x.trim().toLowerCase()) : [];
  if (header.includes('email')) {
    return lines.slice(1).map((line) => {
      const values = csvParts(line);
      const row = Object.fromEntries(header.map((name, index) => [name, values[index] || '']));
      for (const field of ['mfa_enabled', 'password_set', 'security_ready', 'token_invalidated']) {
        row[field] = /^(?:1|true|yes)$/i.test(row[field] || '');
      }
      if (row.has_trial === '' || row.has_trial == null) delete row.has_trial;
      else if (/^(?:1|true|yes|有试用|是)$/i.test(String(row.has_trial))) row.has_trial = true;
      else if (/^(?:0|false|no|没试用|否)$/i.test(String(row.has_trial))) row.has_trial = false;
      return normalizeJsonAccount(row);
    }).filter(Boolean);
  }
  return lines.map((line) => {
    const parts = (line.includes('----')
      ? line.split('----')
      : line.includes('\t')
        ? line.split('\t')
        : csvParts(line)
    ).map((x) => x.trim());
    const totp = String(parts[2] || '').replace(/[\s-]+/g, '').toUpperCase();
    const thirdIsTotp = /^[A-Z2-7]{16,128}$/.test(totp);
    const thirdIsLegacyJwt = String(parts[2] || '').split('.').length === 3;
    return {
      email: parts[0] || '',
      password: parts[1] || '',
      totp_secret: thirdIsTotp ? totp : '',
      access_token: thirdIsTotp ? (parts[3] || '') : (thirdIsLegacyJwt ? parts[2] : ''),
      refresh_token: thirdIsTotp ? (parts[4] || '') : (thirdIsLegacyJwt ? (parts[3] || '') : ''),
      plan_type: thirdIsTotp || thirdIsLegacyJwt ? 'Free' : normalizePlan(parts[2]),
      expire_date: thirdIsTotp || thirdIsLegacyJwt ? '' : (parts[3] || ''),
      status: '未检测',
      remark: thirdIsTotp || thirdIsLegacyJwt ? '' : (parts[4] || ''),
      email_type: thirdIsTotp || thirdIsLegacyJwt ? '' : (parts[5] || ''),
      password_set: Boolean(parts[1]),
      mfa_factor_type: thirdIsTotp ? 'totp' : '',
      mfa_enabled: thirdIsTotp,
      security_ready: Boolean(parts[1]) && thirdIsTotp,
      hardening_status: thirdIsTotp ? 'complete' : '',
    };
  });
}

// 自动识别 JSON、JSONL、----、CSV 与旧版 JWT/RT 行。
function parseAccountsDetailed(text) {
  const value = String(text || '').trim();
  if (!value) return { rows: [], invalid: 0 };
  if (/^[[{]/.test(value)) {
    try {
      const raw = parseJsonAccounts(JSON.parse(value));
      return { rows: raw.filter((x) => x.email), invalid: raw.filter((x) => !x.email).length };
    } catch (e) {
      const jsonl = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      try {
        const raw = jsonl.flatMap((line) => parseJsonAccounts(JSON.parse(line)));
        return { rows: raw.filter((x) => x.email), invalid: raw.filter((x) => !x.email).length };
      } catch {
        throw new Error(`JSON/JSONL 格式解析失败: ${e.message}`);
      }
    }
  }
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const raw = parseDelimitedLines(lines);
  return { rows: raw.filter((x) => x.email), invalid: raw.filter((x) => !x.email).length };
}

function parseAccounts(text) {
  return parseAccountsDetailed(text).rows;
}

module.exports = { parseAccounts, parseAccountsDetailed, parseJsonAccounts, decodeJwt, normalizeTimestamp };
