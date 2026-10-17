'use strict';

const db = require('../db');
const { summaryForUser } = require('./accountSyncs');
const { aggregateSuffixStats, suffixStatsForUser } = require('./suffixPick');
const { readSettings } = require('./settings');
const accountPipeline = require('./accountPipeline');
const { pipelineCaps } = require('./pipelineCaps');
const registerJob = require('./registerJob');
const oauthJob = require('./oauthJob');
const activateJob = require('./activateJob');
const accountRtJob = require('./accountRtJob');
const { config: automationConfig } = require('../automation/config');

const STAGE_KEYS = Object.freeze(['register', 'extract', 'pay', 'acquire_rt']);
const ALERT_CATEGORY_LABELS = Object.freeze({
  pull: '邮箱轮询',
  register: '注册',
  oauth: '提链',
  activate: '支付',
  account: '账号检测',
});
const KNOWN_ERROR_LABELS = Object.freeze({
  ACCOUNT_ACCESS_TOKEN_MISSING: '账号缺少 AT',
  ACCOUNT_RT_MISSING_PASSWORD: '拿 RT 缺少密码',
  ACCOUNT_RT_MISSING_TOTP: '拿 RT 缺少 TOTP',
  ACCOUNT_RT_FAILED: '拿 RT 失败',
  CHATGPT_PLUS_NOT_SYNCED: 'Plus 状态未同步',
  DAILY_REGISTER_CAP: '达到今日注册上限',
  EXTRACT_INTERVAL: '提链冷却中',
  EXTRACT_PROXY_EMPTY: '支付代理不可用',
  JOB_CANCELLED: '任务已取消',
  MAILBOX_OTP_NOT_RECEIVED: '未收到邮箱验证码',
  PAYMENT_OUTCOME_UNKNOWN: '支付结果待核验',
  PIPELINE_WATCHDOG: '流水线看门狗中断',
  PROXY_EXIT_ACQUIRE_EXHAUSTED: '动态代理出口耗尽',
  REGISTER_BATCH_ABORTED: '注册批次提前结束',
});

function tableExists(database, table) {
  try {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table));
  } catch {
    return false;
  }
}

function tableColumns(database, table) {
  if (!tableExists(database, table)) return new Set();
  try {
    return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function scoped(scope, alias = '') {
  if (scope.allUsers) return { sql: '1=1', params: [] };
  return {
    sql: `${alias ? `${alias}.` : ''}user_id = ?`,
    params: [scope.userId],
  };
}

function gbAccountSql(columns, alias = '') {
  const col = alias ? `${alias}.channel` : 'channel';
  if (columns && !columns.has('channel')) return '1=1';
  return `COALESCE(${col}, 'gb') = 'gb'`;
}

function safeSection(run, fallback) {
  try {
    return run();
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

function selectedColumn(columns, name, fallback = "''", alias = name) {
  return columns.has(name) ? name : `${fallback} AS ${alias}`;
}

function markerColumn(columns, name, alias = name) {
  return columns.has(name)
    ? `CASE WHEN TRIM(COALESCE(${name}, '')) != '' THEN '1' ELSE '' END AS ${alias}`
    : `'' AS ${alias}`;
}

function accountMarkerRows(database, scope) {
  const columns = tableColumns(database, 'gpt_accounts');
  if (!columns.size) return [];
  const where = scoped(scope);
  const planColumn = columns.has('plan_type')
    ? 'plan_type'
    : columns.has('account_type') ? 'account_type AS plan_type' : "'Free' AS plan_type";
  const isToday = columns.has('created_at')
    ? "CASE WHEN date(created_at) = date('now','localtime') THEN 1 ELSE 0 END AS is_today"
    : '0 AS is_today';
  return database.prepare(
    `SELECT
       ${selectedColumn(columns, 'id', 'rowid')},
       ${selectedColumn(columns, 'user_id', '0')},
       ${selectedColumn(columns, 'email')},
       ${planColumn},
       ${selectedColumn(columns, 'status')},
       ${selectedColumn(columns, 'has_trial', 'NULL')},
       ${selectedColumn(columns, 'progress')},
       ${selectedColumn(columns, 'remark')},
       ${selectedColumn(columns, 'created_at')},
       ${selectedColumn(columns, 'activated_at')},
       ${selectedColumn(columns, 'extracted_at')},
       ${selectedColumn(columns, 'extract_failed_at')},
       ${selectedColumn(columns, 'extract_attempted_at')},
       ${selectedColumn(columns, 'extract_attempts', '0')},
       ${selectedColumn(columns, 'pay_attempts', '0')},
       ${selectedColumn(columns, 'rt_attempts', '0')},
       ${markerColumn(columns, 'access_token')},
       ${markerColumn(columns, 'refresh_token')},
       ${markerColumn(columns, 'extract_link')},
       ${markerColumn(columns, 'password_enc')},
       ${markerColumn(columns, 'totp_secret_enc')},
       ${selectedColumn(columns, 'token_invalidated', '0')},
       ${selectedColumn(columns, 'activation_retry_after_free_rt', '0')},
       ${isToday}
     FROM gpt_accounts
     WHERE ${where.sql} AND ${gbAccountSql(columns)}`
  ).all(...where.params);
}

function isPaid(row = {}) {
  return Boolean(String(row.activated_at || '').trim())
    || String(row.progress || '').trim() === '已支付';
}

function hasRt(row = {}) {
  return Boolean(String(row.refresh_token || '').trim())
    || String(row.remark || '').trim() === '已拿RT';
}

function isExtracted(row = {}) {
  if (String(row.extracted_at || '').trim() || isPaid(row)) return true;
  return ['已提链', '已提链(已过期)', '支付中', '支付待核验'].includes(
    String(row.progress || '').trim()
  );
}

function trialValue(value) {
  if (value === 1 || value === true || value === '1') return 1;
  if (value === 0 || value === false || value === '0') return 0;
  return null;
}

function scopeUserIds(database, scope, rows = []) {
  if (!scope.allUsers) return [scope.userId];
  const fromRows = [...new Set(rows.map((row) => Number(row.user_id)).filter((id) => id > 0))];
  if (!tableExists(database, 'users')) return fromRows;
  const ids = safeSection(
    () => database.prepare('SELECT id FROM users WHERE status = 1 ORDER BY id').all().map((row) => Number(row.id)),
    fromRows
  );
  return [...new Set(ids.filter((id) => id > 0))];
}

function readyToExtractCount(rows, database, scope) {
  if (database !== db) return rows.filter((row) => (
    row.access_token && trialValue(row.has_trial) === 1 && !isPaid(row) && !hasRt(row)
  )).length;
  let total = 0;
  const byUser = new Map();
  for (const row of rows) {
    const uid = Number(row.user_id) || scope.userId;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(row);
  }
  for (const [uid, items] of byUser) {
    const settings = readSettings(uid);
    const caps = { ...pipelineCaps(settings), rebindRequired: settings.pipeline?.rebind === true };
    total += accountPipeline.selectExtractIds(items, Date.now(), caps).length;
  }
  return total;
}

function inventoryAndFunnel(database, scope) {
  const rows = accountMarkerRows(database, scope);
  const inventory = {
    total: rows.length,
    free: 0,
    plus: 0,
    pro: 0,
    team: 0,
    normal: 0,
    token_invalid: 0,
    disabled: 0,
    paid_without_rt: 0,
    trial_unknown: 0,
    ready_to_extract: 0,
    extracted_waiting_pay: 0,
  };
  const funnel = {
    registered: 0,
    trial_yes: 0,
    trial_no: 0,
    trial_unknown: 0,
    extracted: 0,
    paid: 0,
    got_rt: 0,
    synced_regular: 0,
    listed_plus: 0,
    synced_total: 0,
    failures: [],
  };

  for (const row of rows) {
    const plan = String(row.plan_type || 'Free').trim().toLowerCase();
    if (plan === 'plus') inventory.plus += 1;
    else if (plan === 'pro') inventory.pro += 1;
    else if (plan === 'team') inventory.team += 1;
    else inventory.free += 1;

    const status = String(row.status || '').trim().toLowerCase();
    if (status === '正常' || status === 'active' || status === 'normal') inventory.normal += 1;
    if (
      status === '令牌失效'
      || /token.*invalid|令牌.*失效/.test(status)
      || Number(row.token_invalidated) === 1
    ) inventory.token_invalid += 1;
    if (/disabled|已过期|封禁|停用|禁用|deleted/.test(status)) inventory.disabled += 1;

    const trial = trialValue(row.has_trial);
    if (trial == null) inventory.trial_unknown += 1;
    if (isPaid(row) && !hasRt(row)) inventory.paid_without_rt += 1;
    if (isExtracted(row) && !isPaid(row) && !hasRt(row)) inventory.extracted_waiting_pay += 1;

    if (!Number(row.is_today)) continue;
    funnel.registered += 1;
    if (trial === 1) funnel.trial_yes += 1;
    else if (trial === 0) funnel.trial_no += 1;
    else funnel.trial_unknown += 1;
    if (isExtracted(row)) funnel.extracted += 1;
    if (isPaid(row)) funnel.paid += 1;
    if (hasRt(row)) funnel.got_rt += 1;
  }
  inventory.ready_to_extract = readyToExtractCount(rows, database, scope);
  return { rows, inventory, funnel };
}

function todayFunnelSyncs(database, scope) {
  const accountColumns = tableColumns(database, 'gpt_accounts');
  const syncColumns = tableColumns(database, 'account_syncs');
  if (
    !accountColumns.has('email')
    || !accountColumns.has('created_at')
    || !syncColumns.has('email')
    || !syncColumns.has('kind')
  ) return { regular: 0, plus: 0 };
  const where = scoped(scope, 'a');
  const remote = syncColumns.has('remote_ok') ? 'AND COALESCE(s.remote_ok, 0) = 1' : '';
  const rows = database.prepare(
    `SELECT lower(s.kind) AS kind, COUNT(DISTINCT s.user_id || ':' || lower(s.email)) AS count
     FROM account_syncs s
     JOIN gpt_accounts a
       ON a.user_id = s.user_id AND lower(a.email) = lower(s.email)
     WHERE ${where.sql}
       AND ${gbAccountSql(accountColumns, 'a')}
       AND date(a.created_at) = date('now','localtime')
       ${remote}
     GROUP BY lower(s.kind)`
  ).all(...where.params);
  const counts = Object.fromEntries(rows.map((row) => [row.kind, Number(row.count) || 0]));
  return { regular: counts.regular || 0, plus: counts.plus || 0 };
}

function normalizeErrorCode(value, fallback = 'UNKNOWN') {
  const code = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_.:-]/g, '_').slice(0, 80);
  return code || fallback;
}

function errorLabel(code, category = '') {
  if (KNOWN_ERROR_LABELS[code]) return KNOWN_ERROR_LABELS[code];
  if (code.startsWith('LOG_')) return ALERT_CATEGORY_LABELS[category] || '业务告警';
  return code;
}

function alertCounts(database, scope, modifier, limit = 8) {
  const counts = new Map();
  const add = (key, category, count) => {
    const safeKey = normalizeErrorCode(key, `LOG_${String(category || 'UNKNOWN').toUpperCase()}`);
    const id = `${category}:${safeKey}`;
    const previous = counts.get(id) || { key: safeKey, category, count: 0 };
    previous.count += Number(count) || 0;
    counts.set(id, previous);
  };

  const jobColumns = tableColumns(database, 'registration_jobs');
  if (jobColumns.has('error_code') && jobColumns.has('updated_at')) {
    const where = scoped(scope);
    const statusFilter = jobColumns.has('status')
      ? "AND status IN ('failed','partial','skipped','cancelled')" : '';
    const rows = safeSection(
      () => database.prepare(
        `SELECT error_code AS key, COUNT(*) AS count
         FROM registration_jobs
         WHERE ${where.sql}
           AND TRIM(COALESCE(error_code, '')) != ''
           AND datetime(updated_at) >= datetime('now','localtime', ?)
           ${statusFilter}
         GROUP BY error_code`
      ).all(...where.params, modifier),
      []
    );
    for (const row of rows) add(row.key, 'register', row.count);
  }

  const logColumns = tableColumns(database, 'operation_logs');
  if (logColumns.has('category') && logColumns.has('created_at')) {
    const where = scoped(scope);
    const levelFilter = logColumns.has('level')
      ? "AND level IN ('warning','error')" : '';
    const rows = safeSection(
      () => database.prepare(
        `SELECT category, COUNT(*) AS count
         FROM operation_logs
         WHERE ${where.sql}
           AND datetime(created_at) >= datetime('now','localtime', ?)
           ${levelFilter}
         GROUP BY category`
      ).all(...where.params, modifier),
      []
    );
    for (const row of rows) add(`LOG_${String(row.category || 'unknown').toUpperCase()}`, row.category, row.count);
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((item) => ({ ...item, label: errorLabel(item.key, item.category) }));
}

function syncStats(database, scope) {
  const columns = tableColumns(database, 'account_syncs');
  const empty = {
    regular_count: 0,
    plus_count: 0,
    plus_amount_yuan: '0.00',
    successful_regular: 0,
    listed_plus: 0,
    listing_total_yuan: '0.00',
    today_regular: 0,
    today_plus: 0,
    today_amount_yuan: '0.00',
    failures: 0,
    listing_failures: 0,
  };
  if (!columns.has('kind')) return empty;
  const where = scoped(scope);
  const rows = database.prepare(
    `SELECT
       lower(kind) AS kind,
       ${columns.has('remote_ok') ? 'remote_ok' : '1 AS remote_ok'},
       ${columns.has('price_yuan') ? 'price_yuan' : "'' AS price_yuan"},
       ${columns.has('synced_at') ? "CASE WHEN date(synced_at)=date('now','localtime') THEN 1 ELSE 0 END" : '0'} AS is_today
     FROM account_syncs
     WHERE ${where.sql}`
  ).all(...where.params);
  const result = { ...empty };
  for (const row of rows) {
    const kind = row.kind === 'plus' ? 'plus' : 'regular';
    const ok = Number(row.remote_ok) === 1;
    const amount = Number(String(row.price_yuan || '').replace(/[^\d.-]/g, '')) || 0;
    if (kind === 'plus') result.plus_count += 1;
    else result.regular_count += 1;
    if (!ok) {
      result.failures += 1;
      if (kind === 'plus') result.listing_failures += 1;
      continue;
    }
    if (kind === 'plus') {
      result.listed_plus += 1;
      result.listing_total_yuan = (Number(result.listing_total_yuan) + amount).toFixed(2);
      if (row.is_today) {
        result.today_plus += 1;
        result.today_amount_yuan = (Number(result.today_amount_yuan) + amount).toFixed(2);
      }
    } else {
      result.successful_regular += 1;
      if (row.is_today) result.today_regular += 1;
    }
  }
  if (!scope.allUsers && database === db) {
    const reused = safeSection(() => summaryForUser(scope.userId), {});
    result.regular_count = Number(reused.regular_count) || result.regular_count;
    result.plus_count = Number(reused.plus_count) || result.plus_count;
    result.plus_amount_yuan = reused.plus_amount_yuan || result.listing_total_yuan;
  } else {
    result.plus_amount_yuan = rows
      .filter((row) => row.kind === 'plus')
      .reduce((sum, row) => sum + (Number(String(row.price_yuan || '').replace(/[^\d.-]/g, '')) || 0), 0)
      .toFixed(2);
  }
  return result;
}

function publicDomainStat(item = {}) {
  return {
    suffix: String(item.suffix || '').slice(0, 253),
    mailbox_count: Number(item.mailbox_count) || 0,
    unused_count: Number(item.unused_count) || 0,
    account_count: Number(item.account_count) || 0,
    trial_detected: Number(item.trial_detected) || 0,
    trial_yes: Number(item.trial_yes) || 0,
    trial_rate: item.trial_rate == null ? null : Number(item.trial_rate),
    extract_ok: Number(item.extract_ok) || 0,
    extract_rate: item.extract_rate == null ? null : Number(item.extract_rate),
  };
}

function scopedSuffixStats(database, scope) {
  if (!scope.allUsers && database === db) {
    return safeSection(() => suffixStatsForUser(scope.userId), []);
  }
  const emailColumns = tableColumns(database, 'emails');
  const accountColumns = tableColumns(database, 'gpt_accounts');
  const emailWhere = scoped(scope);
  const accountWhere = scoped(scope);
  const emails = emailColumns.has('address')
    ? database.prepare(
      `SELECT address, ${selectedColumn(emailColumns, 'status')}, ${selectedColumn(emailColumns, 'is_mother', '0')}
       FROM emails WHERE ${emailWhere.sql}`
    ).all(...emailWhere.params)
    : [];
  const accounts = accountColumns.has('email')
    ? database.prepare(
      `SELECT email, ${selectedColumn(accountColumns, 'has_trial', 'NULL')},
              ${selectedColumn(accountColumns, 'progress')}, ${selectedColumn(accountColumns, 'extracted_at')}
       FROM gpt_accounts WHERE ${accountWhere.sql} AND ${gbAccountSql(accountColumns)}`
    ).all(...accountWhere.params)
    : [];
  return aggregateSuffixStats({ emails, accounts });
}

function mailHealth(database, scope) {
  const columns = tableColumns(database, 'emails');
  const result = {
    total: 0,
    mothers: 0,
    children: 0,
    unused: 0,
    used: 0,
    poll_failures_1h: 0,
    poll_failures_24h: 0,
    domain_top: [],
    domain_bottom: [],
  };
  if (columns.size) {
    const where = scoped(scope);
    const rows = database.prepare(
      `SELECT ${selectedColumn(columns, 'status')}, ${selectedColumn(columns, 'is_mother', '0')}
       FROM emails WHERE ${where.sql}`
    ).all(...where.params);
    result.total = rows.length;
    for (const row of rows) {
      if (Number(row.is_mother) === 1) result.mothers += 1;
      else result.children += 1;
      if (String(row.status || '') === '已使用') result.used += 1;
      else if (Number(row.is_mother) !== 1) result.unused += 1;
    }
  }

  const logColumns = tableColumns(database, 'operation_logs');
  if (logColumns.has('category') && logColumns.has('created_at')) {
    const where = scoped(scope);
    const source = logColumns.has('source') ? "AND source='poller'" : '';
    const level = logColumns.has('level') ? "AND level IN ('warning','error')" : '';
    const counts = safeSection(
      () => database.prepare(
        `SELECT
           SUM(datetime(created_at) >= datetime('now','localtime','-1 hour')) AS h1,
           SUM(datetime(created_at) >= datetime('now','localtime','-24 hours')) AS h24
         FROM operation_logs
         WHERE ${where.sql} AND category='pull' ${source} ${level}`
      ).get(...where.params),
      {}
    );
    result.poll_failures_1h = Number(counts?.h1) || 0;
    result.poll_failures_24h = Number(counts?.h24) || 0;
  }

  const stats = scopedSuffixStats(database, scope).map(publicDomainStat);
  const scored = stats.filter((item) => item.account_count > 0);
  result.domain_top = [...scored]
    .sort((a, b) => (
      (b.trial_rate ?? -1) - (a.trial_rate ?? -1)
      || (b.extract_rate ?? -1) - (a.extract_rate ?? -1)
      || b.account_count - a.account_count
    ))
    .slice(0, 3);
  result.domain_bottom = [...scored]
    .filter((item) => item.trial_rate != null || item.extract_rate != null)
    .sort((a, b) => (
      (a.trial_rate ?? 2) - (b.trial_rate ?? 2)
      || (a.extract_rate ?? 2) - (b.extract_rate ?? 2)
      || b.account_count - a.account_count
    ))
    .slice(0, 3);
  return result;
}

function proxyHealth(database, scope) {
  const result = { total: 0, available: 0, unavailable: 0, testing: 0, average_latency_ms: null };
  const columns = tableColumns(database, 'proxies');
  if (!columns.size) return result;
  const where = scoped(scope);
  const rows = database.prepare(
    `SELECT ${selectedColumn(columns, 'status')}, ${selectedColumn(columns, 'latency', 'NULL')}
     FROM proxies WHERE ${where.sql}`
  ).all(...where.params);
  const latencies = [];
  result.total = rows.length;
  for (const row of rows) {
    const status = String(row.status || '').trim();
    if (status === '可用') result.available += 1;
    else if (status === '测试中') result.testing += 1;
    else result.unavailable += 1;
    const latency = Number(row.latency);
    if (status === '可用' && Number.isFinite(latency) && latency > 0) latencies.push(latency);
  }
  if (latencies.length) {
    result.average_latency_ms = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
  }
  return result;
}

function emptyInventoryAndFunnel() {
  return {
    rows: [],
    inventory: {
      total: 0, free: 0, plus: 0, pro: 0, team: 0, normal: 0,
      token_invalid: 0, disabled: 0, paid_without_rt: 0, trial_unknown: 0,
      ready_to_extract: 0, extracted_waiting_pay: 0,
    },
    funnel: {
      registered: 0, trial_yes: 0, trial_no: 0, trial_unknown: 0,
      extracted: 0, paid: 0, got_rt: 0, synced_regular: 0,
      listed_plus: 0, synced_total: 0, failures: [],
    },
  };
}

function emptySyncStats() {
  return {
    regular_count: 0, plus_count: 0, plus_amount_yuan: '0.00',
    successful_regular: 0, listed_plus: 0, listing_total_yuan: '0.00',
    today_regular: 0, today_plus: 0, today_amount_yuan: '0.00',
    failures: 0, listing_failures: 0,
  };
}

function getDashboardStats(userId, { allUsers = false, database = db } = {}) {
  const scope = { userId: Number(userId), allUsers: Boolean(allUsers) };
  const account = safeSection(
    () => inventoryAndFunnel(database, scope),
    emptyInventoryAndFunnel
  );
  const synced = safeSection(() => todayFunnelSyncs(database, scope), { regular: 0, plus: 0 });
  account.funnel.synced_regular = synced.regular;
  account.funnel.listed_plus = synced.plus;
  account.funnel.synced_total = synced.regular + synced.plus;
  account.funnel.failures = alertCounts(database, scope, 'start of day', 8);
  return {
    generated_at: new Date().toISOString(),
    scope: scope.allUsers ? 'all' : 'user',
    funnel: account.funnel,
    inventory: account.inventory,
    sync: safeSection(() => syncStats(database, scope), emptySyncStats),
    mail: safeSection(() => mailHealth(database, scope), {
      total: 0, mothers: 0, children: 0, unused: 0, used: 0,
      poll_failures_1h: 0, poll_failures_24h: 0, domain_top: [], domain_bottom: [],
    }),
    proxy: safeSection(() => proxyHealth(database, scope), {
      total: 0, available: 0, unavailable: 0, testing: 0, average_latency_ms: null,
    }),
    alerts: {
      last_hour: alertCounts(database, scope, '-1 hour', 8),
      last_24h: alertCounts(database, scope, '-24 hours', 8),
    },
  };
}

function maskEmail(value) {
  const text = String(value || '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0) return text ? '***' : '';
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function safeMessage(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email));
  text = text.replace(/https?:\/\/\S+/gi, '[链接]');
  text = text.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:（[^）]{0,64}）|\([^)]{0,64}\))?/g,
    '[代理]'
  );
  text = text.replace(
    /\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+):\d{2,5}(?:（[^）]{0,64}）|\([^)]{0,64}\))?/gi,
    '[代理]'
  );
  text = text.replace(
    /\b(password|passwd|token|secret|license|cookie|authorization|api[_ -]?key)\b\s*[:=]\s*\S+/gi,
    '$1=<redacted>'
  );
  text = text.replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '<redacted>');
  return text.slice(0, 180);
}

function stageFromStatus(key, status = {}, toggle = false, eligible = 0) {
  const running = Boolean(status.running);
  const unlimited = eligible === Infinity || eligible === Number.POSITIVE_INFINITY;
  const eligibleCount = unlimited ? 0 : Math.max(0, Number(eligible) || 0);
  const batchTarget = Number(status.target) || Number(status.total) || 0;
  const target = running ? batchTarget : eligibleCount;
  const completed = Number(status.completed ?? status.attempted) || 0;
  const inferredActive = running
    ? Math.min(Number(status.concurrency) || 1, Math.max(1, target - completed))
    : 0;
  const active = Number(status.active ?? status.running_count) || inferredActive;
  const queued = running
    ? Number(status.queued) || Math.max(0, target - completed - active)
    : eligibleCount;
  return {
    key,
    toggle: Boolean(toggle),
    running,
    target,
    queued,
    active,
    completed,
    success: Number(status.success) || 0,
    failed: Number(status.failed) || 0,
    skipped: Number(status.skipped ?? status.cancelled) || 0,
    concurrency: Number(status.concurrency ?? status.effective_concurrency) || 0,
    current_email: maskEmail(status.current_email),
    message: safeMessage(status.message),
    continuous: Boolean(toggle && unlimited),
    needs_watchdog: Boolean(toggle && !running && (eligibleCount > 0 || unlimited)),
  };
}

function rtBatchStatus(database, userId, basic = {}) {
  const batchColumns = tableColumns(database, 'registration_batches');
  const jobColumns = tableColumns(database, 'registration_jobs');
  if (!batchColumns.has('batch_id') || !batchColumns.has('kind')) return basic;
  const requested = String(basic.batch_id || '').trim();
  const row = safeSection(
    () => database.prepare(
      `SELECT * FROM registration_batches
       WHERE user_id=? AND kind='account-rt' ${requested ? 'AND batch_id=?' : ''}
       ORDER BY created_at DESC, updated_at DESC LIMIT 1`
    ).get(...(requested ? [userId, requested] : [userId])),
    null
  );
  if (!row) return basic;
  let currentEmail = '';
  if (jobColumns.has('batch_id') && jobColumns.has('status')) {
    currentEmail = safeSection(
      () => database.prepare(
        "SELECT email FROM registration_jobs WHERE batch_id=? AND status='running' ORDER BY rowid LIMIT 1"
      ).get(row.batch_id)?.email,
      ''
    );
  }
  return {
    ...basic,
    running: Boolean(basic.running) || row.status === 'running',
    target: Number(row.total) || 0,
    completed: Number(row.completed) || 0,
    success: Number(row.success) || 0,
    failed: Number(row.failed) || 0,
    skipped: (Number(row.cancelled) || 0) + (Number(row.skipped) || 0),
    queued: Number(row.queued) || 0,
    active: Number(row.running) || 0,
    concurrency: Number(row.concurrency) || Number(basic.concurrency) || 0,
    current_email: currentEmail,
    message: row.message || basic.message || '',
  };
}

function eligibleForUser(userId, rows, settings) {
  const caps = {
    ...pipelineCaps(settings),
    rebindRequired: settings.pipeline?.rebind === true,
  };
  let register = 0;
  try {
    register = accountPipeline.registerSupply(userId, settings);
  } catch {
    register = 0;
  }
  return {
    register: Math.max(0, register),
    extract: accountPipeline.selectExtractIds(rows, Date.now(), caps).length,
    pay: accountPipeline.selectPayIds(rows, Date.now(), caps).length,
    acquire_rt: accountPipeline.selectRtIds(rows, Date.now(), [], caps).length,
  };
}

function liveForUser(userId, rows) {
  const settings = readSettings(userId);
  const pipeline = accountPipeline.normalizePipeline(settings.pipeline);
  const eligible = eligibleForUser(userId, rows, settings);
  const registerStatus = safeSection(() => registerJob.status(userId), {});
  const activity = safeSection(() => registerJob.runtimeActivity(userId), { cloak: {}, activities: [] });
  const runningActivity = (activity.activities || []).find((item) => item.status === 'running');
  if (!registerStatus.current_email && runningActivity?.label) registerStatus.current_email = runningActivity.label;
  if (Array.isArray(registerStatus.results)) {
    registerStatus.active = registerStatus.results.filter((item) => item.status === 'running').length;
  }

  const stages = {
    register: stageFromStatus('register', registerStatus, pipeline.register, eligible.register),
    extract: stageFromStatus(
      'extract',
      safeSection(() => oauthJob.status(userId), {}),
      pipeline.extract,
      eligible.extract
    ),
    pay: stageFromStatus(
      'pay',
      safeSection(() => activateJob.status(userId), {}),
      pipeline.pay,
      eligible.pay
    ),
    acquire_rt: stageFromStatus(
      'acquire_rt',
      rtBatchStatus(db, userId, safeSection(() => accountRtJob.status(userId), {})),
      pipeline.acquire_rt,
      eligible.acquire_rt
    ),
  };

  const configured = Math.max(1, Math.min(200, Number(settings.pipeline?.register_concurrency) || 5));
  const cloakConfigured = Math.max(1, Math.min(200, Number(settings.cloak?.max_concurrency) || 3));
  const liveResource = stages.register.running ? Number(activity.cloak?.resource_max_slots) : 0;
  const resourceMax = Math.max(1, Number(
    liveResource
    || automationConfig.cloak.resourceConcurrency
    || cloakConfigured
  ) || 1);
  const idleMax = Math.min(resourceMax, Math.max(cloakConfigured, configured));
  const liveMax = stages.register.running ? Number(activity.cloak?.max_slots) : 0;
  const maxSlots = liveMax || idleMax;
  const activeBrowsers = Number(
    activity.cloak?.active_browsers ?? activity.cloak?.reserved_slots
  ) || 0;
  const supply = Number.isFinite(eligible.register) ? eligible.register : Infinity;
  const effective = stages.register.running
    ? stages.register.concurrency
    : Math.min(configured, maxSlots, Number.isFinite(supply) ? supply : configured);
  Object.assign(stages.register, {
    configured_concurrency: configured,
    effective_concurrency: Math.max(0, effective),
    cloak_configured_concurrency: cloakConfigured,
    slot_capacity: maxSlots,
    resource_slot_capacity: resourceMax,
    active_browsers: activeBrowsers,
    available_slots: stages.register.running && Number.isFinite(Number(activity.cloak?.available_slots))
      ? Number(activity.cloak.available_slots)
      : Math.max(0, maxSlots - activeBrowsers),
    slot_queue: Number(activity.cloak?.queued_slots) || 0,
    resource_limited: Boolean(activity.cloak?.resource_limited) || maxSlots < configured,
  });
  if (stages.register.continuous) {
    if (!stages.register.running) {
      stages.register.queued = configured;
      if (/已停止|已结束/.test(stages.register.message || '')) {
        stages.register.message = '开关开启，持续注册，等待下一波';
      } else if (!stages.register.message) {
        stages.register.message = '开关开启，持续注册，等待下一波';
      }
    } else if (/已启动，目标/.test(stages.register.message || '')) {
      stages.register.message = `持续注册中，本波并发 ${stages.register.concurrency || configured}`;
    }
  }

  for (const stage of Object.values(stages)) {
    if (!stage.message) {
      stage.message = stage.running
        ? '任务运行中'
        : stage.queued > 0 ? '等待流水线调度' : '暂无待处理账号';
    }
  }
  return stages;
}

function aggregateStages(perUser) {
  const result = {};
  for (const key of STAGE_KEYS) {
    const items = perUser.map((entry) => entry[key]);
    const runningUsers = items.filter((item) => item.running).length;
    const toggleUsers = items.filter((item) => item.toggle).length;
    const stage = {
      key,
      toggle: toggleUsers > 0,
      toggle_users: toggleUsers,
      running: runningUsers > 0,
      running_users: runningUsers,
      target: items.reduce((sum, item) => sum + item.target, 0),
      queued: items.reduce((sum, item) => sum + item.queued, 0),
      active: items.reduce((sum, item) => sum + item.active, 0),
      completed: items.reduce((sum, item) => sum + item.completed, 0),
      success: items.reduce((sum, item) => sum + item.success, 0),
      failed: items.reduce((sum, item) => sum + item.failed, 0),
      skipped: items.reduce((sum, item) => sum + item.skipped, 0),
      concurrency: items.reduce((sum, item) => sum + item.concurrency, 0),
      current_email: items.find((item) => item.current_email)?.current_email || '',
      needs_watchdog: items.some((item) => item.needs_watchdog),
      message: items.length === 1
        ? items[0].message
        : runningUsers > 0 ? `${runningUsers} 个用户的任务正在运行` : '当前没有运行中的任务',
    };
    if (key === 'register') {
      for (const field of [
        'configured_concurrency', 'effective_concurrency', 'cloak_configured_concurrency',
        'slot_capacity', 'resource_slot_capacity', 'active_browsers', 'available_slots', 'slot_queue',
      ]) {
        stage[field] = items.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
      }
      stage.resource_limited = items.some((item) => item.resource_limited);
      stage.continuous = items.some((item) => item.continuous);
    }
    result[key] = stage;
  }
  return result;
}

function getDashboardLive(userId, { allUsers = false, database = db } = {}) {
  const scope = { userId: Number(userId), allUsers: Boolean(allUsers) };
  if (database !== db) {
    return {
      generated_at: new Date().toISOString(),
      scope: scope.allUsers ? 'all' : 'user',
      stages: aggregateStages([]),
    };
  }
  const rows = accountMarkerRows(database, scope);
  const ids = scopeUserIds(database, scope, rows);
  const grouped = new Map(ids.map((id) => [id, []]));
  for (const row of rows) {
    const uid = Number(row.user_id) || scope.userId;
    if (!grouped.has(uid)) grouped.set(uid, []);
    grouped.get(uid).push(row);
  }
  const stages = [...grouped.entries()].map(([uid, items]) => liveForUser(uid, items));
  return {
    generated_at: new Date().toISOString(),
    scope: scope.allUsers ? 'all' : 'user',
    user_count: grouped.size,
    stages: aggregateStages(stages),
  };
}

module.exports = {
  getDashboardStats,
  getDashboardLive,
  maskEmail,
  safeMessage,
  tableColumns,
  accountMarkerRows,
  inventoryAndFunnel,
  alertCounts,
  syncStats,
  mailHealth,
  proxyHealth,
  _test: {
    isPaid,
    hasRt,
    isExtracted,
    trialValue,
    normalizeErrorCode,
    stageFromStatus,
    todayFunnelSyncs,
  },
};
