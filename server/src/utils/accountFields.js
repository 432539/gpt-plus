const { encrypt, decrypt } = require('./crypto');
const { normalizeTrialFlag, resolveTrial } = require('./accountCheck');
const { deriveProgress, displayProgress, extractLinkState, normalizeProgress } = require('./accountProgress');
const { normalizeChannel } = require('./accountChannel');
const { retentionView } = require('./accountRetention');

const PLAN_TYPES = ['Free', 'Plus', 'Pro', 'Team'];
const EMAIL_TYPES = ['gmail', 'vmail'];
const STATUSES = ['未检测', '正常', '已过期', '已停用', '令牌失效', '已封禁', '检测失败'];

// 明文列(直接存)
const PLAIN_FIELDS = [
  'email',
  'email_type',
  'plan_type',
  'status',
  'expires_at',
  'remark',
  'client_id',
  'chatgpt_account_id',
  'vmail_id',
  'gmail_client_id',
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
  'has_trial',
  'trial_label',
  'progress',
  'extracted_at',
  'activated_at',
  'channel',
  'gcash_link',
  'gcash_qr',
  'gcash_cs_id',
  'gcash_extracted_at',
  'original_email',
  'rebind_email',
  'rebind_status',
  'rebind_error',
  'rebind_attempts',
  'rebind_attempted_at',
  'rebind_done_at',
];

// 敏感列 -> 存储列名(密文)。password 单独用 password_enc 列
const ENCRYPTED_FIELDS = {
  access_token: 'access_token',
  refresh_token: 'refresh_token',
  id_token: 'id_token',
  session_token: 'session_token',
  client_secret: 'client_secret',
  vmail_token: 'vmail_token',
  gmail_access_token: 'gmail_access_token',
  gmail_refresh_token: 'gmail_refresh_token',
  gmail_client_secret: 'gmail_client_secret',
  totp_secret: 'totp_secret_enc',
};

const INSERT_COLUMNS = [
  'user_id',
  'email',
  'email_type',
  'plan_type',
  'status',
  'expires_at',
  'remark',
  'password_enc',
  'client_id',
  'chatgpt_account_id',
  'vmail_id',
  'gmail_client_id',
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
  'has_trial',
  'trial_label',
  'progress',
  'extract_link',
  'extracted_at',
  'activated_at',
  'channel',
  'gcash_link',
  'gcash_qr',
  'gcash_cs_id',
  'gcash_extracted_at',
  ...Object.values(ENCRYPTED_FIELDS),
];

const normalizePlan = (v) =>
  PLAN_TYPES.find((x) => x.toLowerCase() === String(v || '').trim().toLowerCase()) || 'Free';
const normalizeEmailType = (v, row = {}) => {
  const explicit = String(v || row.email_type || row.account_type || row.source || '').toLowerCase();
  if (explicit === 'vmail' || row.vmail_id || row.vmail_token) return 'vmail';
  return 'gmail';
};
const normalizeStatus = (v) => (STATUSES.includes(String(v || '').trim()) ? String(v).trim() : '未检测');

function encodeExtractLink(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text) && text.includes(':') && text.split(':').length >= 3) return text;
  return encrypt(text);
}

function decodeExtractLink(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return decrypt(raw) || '';
  } catch {
    return '';
  }
}

function trialOut(row) {
  if (row.has_trial === 1 || row.has_trial === true) return 1;
  if (row.has_trial === 0 || row.has_trial === false) return 0;
  return null;
}

// 数据库行 -> 列表用的安全对象(不含明文密码与令牌)
function toListItem(row) {
  const hasToken = Boolean(row.access_token || row.refresh_token || row.chatgpt_account_id);
  const item = {
    id: row.id,
    email: row.email,
    original_email: row.original_email || '',
    rebind_email: row.rebind_email || '',
    rebind_status: row.rebind_status || '',
    rebind_error: row.rebind_error || '',
    rebind_attempts: Number(row.rebind_attempts) || 0,
    rebind_attempted_at: row.rebind_attempted_at || '',
    rebind_done_at: row.rebind_done_at || '',
    email_type: row.email_type,
    plan_type: row.plan_type,
    status: row.status,
    expires_at: row.expires_at || '',
    remark: row.remark || '',
    has_token: hasToken,
    has_refresh_token: Boolean(row.refresh_token),
    has_password: Boolean(row.password_enc),
    has_totp_secret: Boolean(row.totp_secret_enc),
    channel: String(row.channel || 'gb').trim().toLowerCase() === 'gc' ? 'gc' : 'gb',
    has_extract_link: Boolean(row.extract_link),
    extracted_at: row.extracted_at || '',
    extract_expired: extractLinkState(row) === 'expired',
    has_gcash_link: Boolean(row.gcash_link || row.gcash_qr),
    gcash_extracted_at: row.gcash_extracted_at || '',
    gcash_expired: extractLinkState(row) === 'expired' && String(row.channel || '').toLowerCase() === 'gc',
    has_trial: trialOut(row),
    trial_label: row.trial_label || '',
    ...retentionView(row),
    progress: row.progress || '',
    activated_at: row.activated_at || '',
    password_set: Boolean(row.password_set),
    mfa_enabled: Boolean(row.mfa_enabled),
    security_ready: Boolean(row.security_ready),
    hardening_status: row.hardening_status || '',
    last_detected_at: row.last_detected_at || '',
    last_refresh_at: row.last_refresh_at || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  item.progress = displayProgress({
    ...item,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    extract_link: row.extract_link,
    extracted_at: row.extracted_at,
    gcash_link: row.gcash_link,
    gcash_qr: row.gcash_qr,
    gcash_extracted_at: row.gcash_extracted_at,
    channel: row.channel,
  }, { extract: { running: false, emails: [], ids: [], run_id: '' }, activate: { running: false, emails: [], ids: [], run_id: '' } });
  return item;
}

// 数据库行 -> 完整解密对象(编辑弹窗用)
function toDetail(row) {
  const out = {
    id: row.id,
    email: row.email,
    original_email: row.original_email || '',
    rebind_email: row.rebind_email || '',
    rebind_status: row.rebind_status || '',
    rebind_error: row.rebind_error || '',
    rebind_attempts: Number(row.rebind_attempts) || 0,
    rebind_attempted_at: row.rebind_attempted_at || '',
    rebind_done_at: row.rebind_done_at || '',
    email_type: row.email_type,
    plan_type: row.plan_type,
    status: row.status,
    expires_at: row.expires_at || '',
    remark: row.remark || '',
    password: decrypt(row.password_enc || ''),
    client_id: row.client_id || '',
    chatgpt_account_id: row.chatgpt_account_id || '',
    vmail_id: row.vmail_id || '',
    gmail_client_id: row.gmail_client_id || '',
    mfa_factor_id: row.mfa_factor_id || '',
    mfa_factor_type: row.mfa_factor_type || '',
    mfa_enabled: Boolean(row.mfa_enabled),
    password_set: Boolean(row.password_set),
    security_ready: Boolean(row.security_ready),
    hardening_status: row.hardening_status || '',
    hardening_error_code: row.hardening_error_code || '',
    hardening_error: row.hardening_error || '',
    hardening_updated_at: row.hardening_updated_at || '',
    mfa_enrolled_at: row.mfa_enrolled_at || '',
    last_detected_at: row.last_detected_at || '',
    last_refresh_at: row.last_refresh_at || '',
    last_security_state: row.last_security_state || '',
    token_invalidated: Boolean(row.token_invalidated),
    has_trial: trialOut(row),
    trial_label: row.trial_label || '',
    progress: row.progress || '',
    extract_link: decodeExtractLink(row.extract_link),
    extracted_at: row.extracted_at || '',
    activated_at: row.activated_at || '',
    channel: normalizeChannel(row.channel),
    gcash_link: decodeExtractLink(row.gcash_link),
    gcash_qr: String(row.gcash_qr || ''),
    gcash_cs_id: String(row.gcash_cs_id || ''),
    gcash_extracted_at: row.gcash_extracted_at || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  for (const field of Object.keys(ENCRYPTED_FIELDS)) {
    out[field] = decrypt(row[ENCRYPTED_FIELDS[field]] || '');
  }
  return out;
}

function inferredProgress(input = {}, cols = {}) {
  const explicit = normalizeProgress(input.progress);
  const derived = deriveProgress({
    progress: explicit,
    plan_type: cols.plan_type,
    access_token: input.access_token,
    refresh_token: input.refresh_token,
    extract_link: input.extract_link || input.payment_link,
    extracted_at: cols.extracted_at || input.extracted_at,
    activated_at: cols.activated_at || input.activated_at,
    email: cols.email,
  });
  if (derived) return derived;
  return explicit;
}

function inferredTrial(input = {}) {
  if (input.has_trial !== undefined && input.has_trial !== null && input.has_trial !== '') {
    return normalizeTrialFlag(input.has_trial);
  }
  return resolveTrial({
    check: input.check || input.account_check,
    accessToken: input.access_token,
  }).has_trial;
}

// 归一化输入(用于新增/导入)-> 可直接写库的列值对象
function toColumns(input = {}) {
  const cols = {
    email: String(input.email || '').trim(),
    email_type: normalizeEmailType(input.email_type ?? input.account_type ?? input.source, input),
    plan_type: normalizePlan(input.plan_type ?? input.plan),
    status: normalizeStatus(input.status),
    expires_at: input.expires_at || input.expire_date || null,
    remark: input.remark || '',
    password_enc: encrypt(input.password || ''),
    client_id: input.client_id || '',
    chatgpt_account_id: input.chatgpt_account_id || '',
    vmail_id: input.vmail_id || input.mailbox_id || '',
    gmail_client_id: input.gmail_client_id || '',
    mfa_factor_id: input.mfa_factor_id || '',
    mfa_factor_type: input.mfa_factor_type || (input.totp_secret ? 'totp' : ''),
    mfa_enabled: input.mfa_enabled === true ? 1 : 0,
    password_set: input.password_set === undefined ? (input.password ? 1 : 0) : (input.password_set ? 1 : 0),
    security_ready: input.security_ready === true ? 1 : 0,
    hardening_status: input.hardening_status || '',
    hardening_error_code: input.hardening_error_code || '',
    hardening_error: input.hardening_error || '',
    hardening_updated_at: input.hardening_updated_at || '',
    mfa_enrolled_at: input.mfa_enrolled_at || '',
    last_detected_at: input.last_detected_at || '',
    last_refresh_at: input.last_refresh_at || '',
    last_security_state: input.last_security_state || '',
    token_invalidated: input.token_invalidated === true ? 1 : 0,
    trial_label: String(input.trial_label || '').slice(0, 200),
    extract_link: encodeExtractLink(input.extract_link || input.payment_link || ''),
    extracted_at: String(input.extracted_at || '').trim()
      || ((input.extract_link || input.payment_link) ? new Date().toISOString().replace('T', ' ').slice(0, 19) : ''),
    activated_at: String(input.activated_at || '').trim(),
    channel: normalizeChannel(input.channel),
    gcash_link: encodeExtractLink(input.gcash_link || ''),
    gcash_qr: String(input.gcash_qr || ''),
    gcash_cs_id: String(input.gcash_cs_id || '').trim(),
    gcash_extracted_at: String(input.gcash_extracted_at || '').trim(),
  };
  const trial = inferredTrial(input);
  cols.has_trial = trial === 0 || trial === 1 ? trial : null;
  cols.progress = inferredProgress(input, cols);
  for (const field of Object.keys(ENCRYPTED_FIELDS)) {
    cols[ENCRYPTED_FIELDS[field]] = encrypt(input[field] || '');
  }
  return cols;
}

function valuesForInsert(userId, cols) {
  return INSERT_COLUMNS.map((column) => {
    if (column === 'user_id') return userId;
    if (column === 'has_trial') return cols.has_trial === 0 || cols.has_trial === 1 ? cols.has_trial : null;
    if (column === 'expires_at') return cols.expires_at || null;
    return cols[column] ?? '';
  });
}

module.exports = {
  PLAN_TYPES,
  EMAIL_TYPES,
  STATUSES,
  ENCRYPTED_FIELDS,
  INSERT_COLUMNS,
  normalizePlan,
  normalizeEmailType,
  normalizeStatus,
  toListItem,
  toDetail,
  toColumns,
  valuesForInsert,
  encodeExtractLink,
  decodeExtractLink,
};
