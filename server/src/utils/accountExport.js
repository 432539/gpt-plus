const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const { toDetail } = require('./accountFields');

const COLS = [
  'email',
  'password',
  'plan_type',
  'expires_at',
  'remark',
  'email_type',
  'status',
  'has_trial',
  'trial_label',
  'progress',
  'extract_link',
  'access_token',
  'refresh_token',
  'id_token',
  'session_token',
  'client_id',
  'client_secret',
  'chatgpt_account_id',
  'vmail_id',
  'vmail_token',
  'gmail_access_token',
  'gmail_refresh_token',
  'gmail_client_id',
  'gmail_client_secret',
  'totp_secret',
  'mfa_factor_id',
  'mfa_factor_type',
  'mfa_enabled',
  'password_set',
  'security_ready',
  'hardening_status',
  'hardening_error_code',
  'hardening_error',
  'hardening_updated_at',
  'mfa_enrolled_at',
  'last_detected_at',
  'last_refresh_at',
  'last_security_state',
  'token_invalidated',
];

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toExportRow(detail) {
  return {
    email: detail.email || '',
    password: detail.password || '',
    plan_type: detail.plan_type || 'Free',
    expires_at: detail.expires_at || '',
    expire_date: detail.expires_at || '',
    remark: detail.remark || '',
    email_type: detail.email_type || '',
    account_type: detail.email_type || '',
    status: detail.status || '',
    has_trial: detail.has_trial === 0 || detail.has_trial === 1 ? detail.has_trial : '',
    trial_label: detail.trial_label || '',
    progress: detail.progress || '',
    extract_link: detail.extract_link || '',
    access_token: detail.access_token || '',
    refresh_token: detail.refresh_token || '',
    id_token: detail.id_token || '',
    session_token: detail.session_token || '',
    client_id: detail.client_id || '',
    client_secret: detail.client_secret || '',
    chatgpt_account_id: detail.chatgpt_account_id || '',
    vmail_id: detail.vmail_id || '',
    vmail_token: detail.vmail_token || '',
    gmail_access_token: detail.gmail_access_token || '',
    gmail_refresh_token: detail.gmail_refresh_token || '',
    gmail_client_id: detail.gmail_client_id || '',
    gmail_client_secret: detail.gmail_client_secret || '',
    totp_secret: detail.totp_secret || '',
    mfa_factor_id: detail.mfa_factor_id || '',
    mfa_factor_type: detail.mfa_factor_type || '',
    mfa_enabled: Boolean(detail.mfa_enabled),
    password_set: Boolean(detail.password_set),
    security_ready: Boolean(detail.security_ready),
    hardening_status: detail.hardening_status || '',
    hardening_error_code: detail.hardening_error_code || '',
    hardening_error: detail.hardening_error || '',
    hardening_updated_at: detail.hardening_updated_at || '',
    mfa_enrolled_at: detail.mfa_enrolled_at || '',
    last_detected_at: detail.last_detected_at || '',
    last_refresh_at: detail.last_refresh_at || '',
    last_security_state: detail.last_security_state || '',
    token_invalidated: Boolean(detail.token_invalidated),
  };
}

function response(filename, mime, content, counts = {}) {
  return {
    filename,
    mime,
    content_base64: Buffer.from(content).toString('base64'),
    exported: counts.exported ?? 0,
    skipped: counts.skipped ?? 0,
  };
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

function safeName(value, fallback) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9@._-]+/g, '_').replace(/^\.+/, '').slice(0, 100);
  return clean || fallback;
}

function buildExport(rows, format, options = {}) {
  const items = rows.map((r) => toExportRow(toDetail(r)));
  const fmt = String(format || 'json').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  if (fmt === 'txt') {
    const allowed = ['email', 'password', 'totp_secret', 'access_token', 'refresh_token'];
    const fields = Array.isArray(options.fields)
      ? options.fields.filter((field) => allowed.includes(field))
      : ['email', 'password', 'totp_secret'];
    if (!fields.includes('email')) fields.unshift('email');
    const valid = items.filter((item) => fields.every((field) => {
      const value = String(item[field] || '');
      return value && !/[\r\n]/.test(value) && !value.includes('----');
    }));
    const text = valid.map((item) => fields.map((field) => item[field]).join('----')).join('\n');
    return response(`accounts-${stamp}.txt`, 'text/plain;charset=utf-8', Buffer.from(text, 'utf8'), {
      exported: valid.length, skipped: items.length - valid.length,
    });
  }

  if (fmt === 'sub2' || fmt === 'sub2api') {
    const usable = items.filter((item) => item.access_token || item.refresh_token);
    const accounts = usable.map((item) => ({
      platform: 'openai',
      type: 'oauth',
      name: item.email,
      credentials: stripEmpty({
        access_token: item.access_token,
        refresh_token: item.refresh_token,
        id_token: item.id_token,
        session_token: item.session_token,
        chatgpt_account_id: item.chatgpt_account_id,
        email: item.email,
        expires_at: item.expires_at,
        plan_type: item.plan_type,
      }),
      extra: { email: item.email },
      concurrency: 10,
      priority: 1,
      rate_multiplier: 1,
      auto_pause_on_expired: true,
    }));
    const json = JSON.stringify({ exported_at: new Date().toISOString(), proxies: [], accounts }, null, 2);
    return response(`sub2-accounts-${stamp}.json`, 'application/json;charset=utf-8', Buffer.from(json), {
      exported: accounts.length, skipped: items.length - accounts.length,
    });
  }

  if (fmt === 'cpa' || fmt === 'cliproxyapi') {
    const usable = items.filter((item) => item.access_token);
    const zip = new AdmZip();
    const names = new Set();
    usable.forEach((item, index) => {
      const document = stripEmpty({
        type: 'codex',
        access_token: item.access_token,
        refresh_token: item.refresh_token,
        id_token: item.id_token,
        session_token: item.session_token,
        email: item.email,
        account_id: item.chatgpt_account_id,
        expired: item.expires_at,
        plan_type: item.plan_type,
      });
      let filename = `codex-${safeName(item.email, `account-${index + 1}`)}.json`;
      if (names.has(filename)) filename = `codex-${safeName(item.email, 'account')}-${index + 1}.json`;
      names.add(filename);
      zip.addFile(filename, Buffer.from(JSON.stringify(document, null, 2), 'utf8'));
    });
    return response(`cpa-accounts-${stamp}.zip`, 'application/zip', zip.toBuffer(), {
      exported: usable.length, skipped: items.length - usable.length,
    });
  }

  if (fmt === 'csv') {
    const lines = [COLS.join(',')].concat(items.map((r) => COLS.map((c) => csvEscape(r[c])).join(',')));
    const text = `\uFEFF${lines.join('\n')}`;
    return response(`accounts-${stamp}.csv`, 'text/csv;charset=utf-8', Buffer.from(text, 'utf8'), {
      exported: items.length, skipped: 0,
    });
  }

  if (fmt === 'xlsx' || fmt === 'xls' || fmt === 'excel') {
    const wb = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(items.map((r) => Object.fromEntries(COLS.map((c) => [c, r[c]]))));
    XLSX.utils.book_append_sheet(wb, sheet, 'accounts');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    return response(`accounts-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf, {
      exported: items.length, skipped: 0,
    });
  }

  const json = JSON.stringify({ accounts: items }, null, 2);
  return response(`accounts-${stamp}.json`, 'application/json;charset=utf-8', Buffer.from(json, 'utf8'), {
    exported: items.length, skipped: 0,
  });
}

module.exports = { buildExport };
