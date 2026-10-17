'use strict';

const db = require('../db');
const opLog = require('./opLog');
const { readSettings, writeSettings } = require('./settings');
const { toDetail } = require('./accountFields');
const { PROGRESS } = require('./accountProgress');
const { maskEmail, safeMessage } = require('./dashboardStats');
const { buildDynamicProxy } = require('./dynamicProxy');
const { freshStickyProxy } = require('./stickyProxy');
const { channelSpec, wiredLocalChannelIds, extractLocalProvider } = require('./localProviderExtract');
const { paypalProfile, wiredPaypalChannelIds } = require('./paypalProfiles');

const TICK_MS = 20 * 1000;
const PROCESS_CAP = 20;
const MIN_INTERVAL_MINUTES = 5;
const ACCOUNT_COOL_MS = 30 * 60 * 1000;
const CLIPROXY_POOL = 'cliproxy';
const SUCCESS_LIST_LIMIT = 200;
const LIVE_PROGRESS = new Set([PROGRESS.EXTRACTING, PROGRESS.PAYING]);
const COOLDOWN_MS = Object.freeze({
  rate_limited: 20 * 60 * 1000,
  unusual_activity: 60 * 60 * 1000,
  update_400: 30 * 60 * 1000,
  geo_mismatch: 60 * 60 * 1000,
  failed: 20 * 60 * 1000,
});

const slots = [];
let ticking = false;
let timer = null;

function nowSql(ms = Date.now()) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function parseStamp(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = /T/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function clampInterval(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 60;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(1440, n));
}

function clampConcurrency(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(PROCESS_CAP, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostnameOnly(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = text.includes('://') ? new URL(text) : new URL(`https://${text}`);
    return String(url.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}

function classifyError(error = {}) {
  const code = String(error.code || '');
  const status = Number(error.status) || Number(error.http) || 0;
  const message = String(error.message || '').toLowerCase();
  if (status === 429 || /rate.?limit|too many requests/.test(message)) return 'rate_limited';
  if (code === 'EXTRACT_CHECKOUT_UNUSUAL' || /unusual activity/.test(message)) return 'unusual_activity';
  if (code === 'CHECKOUT_PROMOTION' || /invalid_promotion|优惠更新无效/.test(message)) return 'update_400';
  if (code === 'ACCOUNT_NOT_ELIGIBLE' || code === 'ACCOUNT_ALREADY_PAID') return 'not_eligible';
  if (
    code === 'ELIGIBILITY_PROXY_COUNTRY'
    || code === 'EXTRACT_GB_PROXY_REQUIRED'
    || code === 'EXTRACT_PROXY_EMPTY'
    || code === 'EXTRACT_PROXY_REQUIRED'
    || code === 'DYNAMIC_PROXY_NOT_CONFIGURED'
    || code === 'DYNAMIC_PROXY_COUNTRY_REQUIRED'
    || /出口不匹配|没有.*支付代理|动态代理/.test(message)
  ) return 'geo_mismatch';
  if (code === 'ACCOUNT_TOKEN_INVALIDATED' || code === 'ACCOUNT_ACCESS_TOKEN_MISSING') return 'token_dead';
  return 'failed';
}

function wiredChannelIds() {
  return [...wiredPaypalChannelIds(), ...wiredLocalChannelIds()];
}

function channelCountry(channelId) {
  const paypal = paypalProfile(channelId);
  if (paypal) return paypal.checkoutCountry || paypal.country;
  try {
    return channelSpec(channelId).country;
  } catch {
    return '';
  }
}

function normalizeEnabledChannels(value) {
  const wired = new Set(wiredChannelIds());
  const list = Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter((id) => wired.has(id)) : [];
  return list.length ? [...new Set(list)] : wiredChannelIds();
}

function enabledChannelIds(plan = {}) {
  return normalizeEnabledChannels(plan.enabled_channels);
}

function statusFromClass(errorClass) {
  if (!errorClass) return 'ok';
  if (errorClass === 'rate_limited' || errorClass === 'failed' || errorClass === 'update_400') return 'rate';
  if (errorClass === 'unusual_activity') return 'risk';
  if (errorClass === 'not_eligible' || errorClass === 'token_dead') return 'no_trial';
  if (errorClass === 'geo_mismatch') return 'no_proxy';
  return 'rate';
}

function logMonitor(userId, level, message, runId = '') {
  opLog.oauth(userId, level, safeMessage(message), { source: 'global-extract', run_id: String(runId || '') });
}

function upsertPlanRow(userId, plan, extra = {}) {
  const current = db.prepare('SELECT * FROM global_extract_plans WHERE user_id = ?').get(userId) || {};
  db.prepare(
    `INSERT INTO global_extract_plans
       (user_id, enabled, interval_minutes, concurrency, last_run_at, next_run_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled,
       interval_minutes = excluded.interval_minutes,
       concurrency = excluded.concurrency,
       last_run_at = excluded.last_run_at,
       next_run_at = excluded.next_run_at,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    plan.enabled ? 1 : 0,
    plan.interval_minutes,
    plan.concurrency,
    extra.last_run_at !== undefined ? extra.last_run_at : (current.last_run_at || ''),
    extra.next_run_at !== undefined ? extra.next_run_at : (current.next_run_at || ''),
  );
}

function planState(userId, settings = readSettings(userId)) {
  const row = db.prepare('SELECT * FROM global_extract_plans WHERE user_id = ?').get(userId);
  const enabled = settings.global_extract?.enabled === true;
  const interval_minutes = clampInterval(settings.global_extract?.interval_minutes);
  const concurrency = clampConcurrency(settings.global_extract?.concurrency);
  const last_run_at = String(row?.last_run_at || '').trim() || null;
  const lastMs = parseStamp(last_run_at);
  const nextMs = lastMs == null ? Date.now() : lastMs + interval_minutes * 60 * 1000;
  const enabled_channels = normalizeEnabledChannels(settings.global_extract?.enabled_channels);
  return {
    enabled,
    interval_minutes,
    concurrency,
    enabled_channels,
    last_run_at,
    next_run_at: enabled ? nowSql(nextMs) : null,
    schedulable: enabled,
  };
}

function savePlan(userId, body = {}) {
  const patch = { global_extract: {} };
  if (body.enabled !== undefined) patch.global_extract.enabled = Boolean(body.enabled);
  if (body.interval_minutes !== undefined) patch.global_extract.interval_minutes = clampInterval(body.interval_minutes);
  if (body.concurrency !== undefined) patch.global_extract.concurrency = clampConcurrency(body.concurrency);
  if (body.enabled_channels !== undefined) {
    patch.global_extract.enabled_channels = normalizeEnabledChannels(body.enabled_channels);
  }
  if (body.enable_all === true) {
    patch.global_extract.enabled = true;
    patch.global_extract.enabled_channels = wiredChannelIds();
  }
  const next = Object.keys(patch.global_extract).length
    ? writeSettings(userId, patch)
    : readSettings(userId);
  const plan = planState(userId, next);
  upsertPlanRow(userId, plan);
  return plan;
}

function productionBusyIds(userId) {
  const ids = new Set();
  try {
    const extract = require('./oauthJob').status(userId);
    if (extract?.running) {
      if (extract.current_id) ids.add(Number(extract.current_id));
      for (const id of extract.ids || []) ids.add(Number(id));
    }
  } catch {
    /* optional */
  }
  try {
    const pay = require('./activateJob').status(userId);
    if (pay?.running) {
      if (pay.current_id) ids.add(Number(pay.current_id));
      for (const id of pay.ids || []) ids.add(Number(id));
    }
  } catch {
    /* optional */
  }
  return ids;
}

function productionBusy(userId) {
  return productionBusyIds(userId).size > 0;
}

function tableHas(table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function selectMonitorAccount(userId, nowMs = Date.now(), extra = {}) {
  if (!tableHas('gpt_accounts', 'has_trial')) return null;
  const busy = productionBusyIds(userId);
  const exclude = extra.excludeIds instanceof Set ? extra.excludeIds : new Set();
  const hasPool = tableHas('gpt_accounts', 'monitor_pool');
  const hasCool = tableHas('gpt_accounts', 'monitor_cool_until');
  const rows = db.prepare(
    `SELECT *
       FROM gpt_accounts
      WHERE user_id = ?
        AND has_trial = 1
        AND TRIM(COALESCE(access_token, '')) != ''
        AND COALESCE(token_invalidated, 0) = 0
        AND COALESCE(channel, 'gb') = 'gb'
      ORDER BY ${hasPool ? 'monitor_pool DESC,' : ''} id ASC`
  ).all(userId);
  for (const row of rows) {
    if (exclude.has(Number(row.id))) continue;
    if (busy.has(Number(row.id))) continue;
    if (LIVE_PROGRESS.has(String(row.progress || '').trim())) continue;
    if (hasCool) {
      const coolMs = parseStamp(row.monitor_cool_until);
      if (coolMs && coolMs > nowMs) continue;
    }
    return row;
  }
  return null;
}

function coolAccount(userId, accountId, ms = ACCOUNT_COOL_MS) {
  if (!tableHas('gpt_accounts', 'monitor_cool_until')) return;
  db.prepare(
    `UPDATE gpt_accounts SET monitor_cool_until = ? WHERE user_id = ? AND id = ?`
  ).run(nowSql(Date.now() + ms), userId, accountId);
}

function cliproxyCredentials(userId, settings = readSettings(userId)) {
  const creds = settings?.dynamic_proxy?.providers?.cliproxy || {};
  const username = String(creds.username || '').trim();
  const password = String(creds.password || '').trim();
  if (!username || !password) return null;
  return {
    username,
    password,
    sticky_minutes: creds.sticky_minutes,
  };
}

function cliproxyConfigured(userId, settings) {
  return Boolean(cliproxyCredentials(userId, settings || readSettings(userId)));
}

function cliproxyPoolView(userId, settings = readSettings(userId)) {
  const creds = settings?.dynamic_proxy?.providers?.cliproxy || {};
  return {
    cliproxy_configured: Boolean(String(creds.username || '').trim() && String(creds.password || '').trim()),
    cliproxy_username_set: Boolean(String(creds.username || '').trim()),
    cliproxy_sticky_minutes: Math.max(1, Math.min(120, Number.parseInt(creds.sticky_minutes, 10) || 30)),
  };
}

function buildMonitorProxy(userId, country, settings) {
  const creds = cliproxyCredentials(userId, settings || readSettings(userId));
  const region = String(country || '').trim().toUpperCase();
  if (!creds || !/^[A-Z]{2}$/.test(region)) return null;
  try {
    return freshStickyProxy(buildDynamicProxy(region, {
      active_pool: CLIPROXY_POOL,
      providers: { cliproxy: creds },
    }));
  } catch {
    return null;
  }
}

function loadMonitorProxies(userId) {
  return cliproxyConfigured(userId) ? [{ source: 'cliproxy-auto', automated_pool: CLIPROXY_POOL }] : [];
}

function countPaymentProxies(userId) {
  return cliproxyConfigured(userId) ? 1 : 0;
}

function loadResult(userId, channelId) {
  return db.prepare(
    'SELECT * FROM global_extract_results WHERE user_id = ? AND channel_id = ?'
  ).get(userId, channelId) || null;
}

function loadResults(userId) {
  return db.prepare(
    'SELECT * FROM global_extract_results WHERE user_id = ?'
  ).all(userId);
}

function loadSuccesses(userId, limit = SUCCESS_LIST_LIMIT) {
  const cap = Math.max(1, Math.min(SUCCESS_LIST_LIMIT, Number(limit) || SUCCESS_LIST_LIMIT));
  return db.prepare(
    `SELECT r.id, r.channel_id, r.account_id, r.started_at, r.finished_at,
            r.verified_exit, r.result_host, r.duration_ms, a.email
       FROM global_extract_runs r
       LEFT JOIN gpt_accounts a ON a.id = r.account_id
      WHERE r.user_id = ? AND r.status = 'ok'
      ORDER BY r.id DESC
      LIMIT ?`
  ).all(userId, cap)
    .map((row) => ({
      id: row.id,
      channel_id: row.channel_id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      verified_exit: row.verified_exit || '',
      result_host: hostnameOnly(row.result_host) || row.result_host || '',
      duration_ms: Number(row.duration_ms) || 0,
      account_email_mask: maskEmail(row.email),
    }));
}

function loadRecentRuns(userId, channelId, limit = 5) {
  return db.prepare(
    `SELECT r.id, r.channel_id, r.account_id, r.started_at, r.finished_at, r.status,
            r.error_class, r.verified_exit, r.result_host, r.duration_ms, a.email
       FROM global_extract_runs r
       LEFT JOIN gpt_accounts a ON a.id = r.account_id
      WHERE r.user_id = ? AND r.channel_id = ?
      ORDER BY r.id DESC
      LIMIT ?`
  ).all(userId, channelId, Math.max(1, Math.min(20, Number(limit) || 5)))
    .map((row) => ({
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status,
      error_class: row.error_class || '',
      verified_exit: row.verified_exit || '',
      result_host: row.result_host || '',
      duration_ms: Number(row.duration_ms) || 0,
      account_email_mask: maskEmail(row.email),
    }));
}

function persistOutcome(userId, channelId, accountId, startedAt, outcome) {
  const finished = nowSql();
  const duration = Math.max(0, Date.now() - (parseStamp(startedAt) || Date.now()));
  const insert = db.prepare(
    `INSERT INTO global_extract_runs
       (user_id, channel_id, account_id, started_at, finished_at, status, error_class, verified_exit, result_host, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    channelId,
    accountId || null,
    startedAt,
    finished,
    outcome.status,
    outcome.error_class || '',
    outcome.verified_exit || '',
    outcome.result_host || '',
    duration,
  );
  const prev = loadResult(userId, channelId);
  const failed = outcome.status !== 'ok';
  const consecutive = failed ? (Number(prev?.consecutive_failures) || 0) + 1 : 0;
  const coolMs = failed ? COOLDOWN_MS[outcome.error_class] : 0;
  db.prepare(
    `INSERT INTO global_extract_results
       (user_id, channel_id, last_status, last_error_class, last_ok_at, last_at, last_account_id,
        verified_exit, result_host, consecutive_failures, cooldown_until, last_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET
       last_status = excluded.last_status,
       last_error_class = excluded.last_error_class,
       last_ok_at = excluded.last_ok_at,
       last_at = excluded.last_at,
       last_account_id = excluded.last_account_id,
       verified_exit = excluded.verified_exit,
       result_host = excluded.result_host,
       consecutive_failures = excluded.consecutive_failures,
       cooldown_until = excluded.cooldown_until,
       last_run_id = excluded.last_run_id`
  ).run(
    userId,
    channelId,
    outcome.status,
    outcome.error_class || '',
    outcome.status === 'ok' ? finished : (prev?.last_ok_at || ''),
    finished,
    accountId || null,
    outcome.verified_exit || '',
    outcome.result_host || '',
    consecutive,
    coolMs ? nowSql(Date.now() + coolMs) : '',
    insert.lastInsertRowid,
  );
  return insert.lastInsertRowid;
}

function channelDue(userId, channelId, nowMs, intervalMinutes) {
  const row = loadResult(userId, channelId);
  if (!row) return true;
  const coolMs = parseStamp(row.cooldown_until);
  if (coolMs && coolMs > nowMs) return false;
  if (intervalMinutes == null) return true;
  const lastMs = parseStamp(row.last_at);
  if (lastMs == null) return true;
  return nowMs - lastMs >= intervalMinutes * 60 * 1000;
}

function pickDueChannel(userId, plan, nowMs, force = false) {
  const ids = enabledChannelIds(plan);
  for (const id of ids) {
    if (force || channelDue(userId, id, nowMs, plan.interval_minutes)) return id;
  }
  return force ? ids[0] : '';
}

function dueChannelIds(userId, plan, nowMs, force = false) {
  const ids = enabledChannelIds(plan);
  if (force) return ids.filter((id) => channelDue(userId, id, nowMs));
  return ids.filter((id) => channelDue(userId, id, nowMs, plan.interval_minutes));
}

function userDue(userId, plan, nowMs, force = false) {
  if (!plan.enabled) return false;
  if (force) return dueChannelIds(userId, plan, nowMs, true).length > 0 || enabledChannelIds(plan).length > 0;
  return dueChannelIds(userId, plan, nowMs, false).length > 0;
}

async function probePaypalChannel({ userId, account, buildProxy, cancelled, channelId, extractPaymentLink }) {
  const profile = paypalProfile(channelId) || paypalProfile('paypal_uk');
  const exitCountry = profile.checkoutCountry || profile.country || 'GB';
  const nextProxy = () => {
    const proxy = buildProxy(exitCountry);
    if (!proxy) {
      throw Object.assign(new Error('动态代理 CliProxy 未配置或国家无效'), {
        code: 'DYNAMIC_PROXY_NOT_CONFIGURED',
        status: 400,
      });
    }
    return proxy;
  };
  const extract = extractPaymentLink || require('./paypalExtract').extractPaymentLink;
  const result = await extract({
    detail: toDetail(account),
    proxy: nextProxy(),
    nextProxy,
    cancelled,
    maxCheckoutAttempts: 2,
    paypalProfile: profile,
    log: (message, level = 'info') => {
      if (level === 'debug') return;
      logMonitor(userId, level === 'error' ? 'error' : 'info', `${account.email || account.id}：${message}`);
    },
  });
  return {
    status: 'ok',
    error_class: '',
    verified_exit: exitCountry,
    result_host: hostnameOnly(result?.link) || 'paypal.com',
  };
}

async function probeLocalChannel({ userId, account, buildProxy, cancelled, channelId, extractLocalProvider: extractFn }) {
  const spec = channelSpec(channelId);
  const nextProxy = () => {
    const proxy = buildProxy(spec.country);
    if (!proxy) {
      throw Object.assign(new Error('动态代理 CliProxy 未配置或国家无效'), {
        code: 'DYNAMIC_PROXY_NOT_CONFIGURED',
        status: 400,
      });
    }
    return proxy;
  };
  const extract = extractFn || extractLocalProvider;
  const result = await extract({
    channelId,
    detail: toDetail(account),
    proxy: nextProxy(),
    nextProxy,
    cancelled,
    maxCheckoutAttempts: 2,
    log: (message, level = 'info') => {
      if (level === 'debug') return;
      logMonitor(userId, level === 'error' ? 'error' : 'info', `${account.email || account.id}：${message}`);
    },
  });
  return {
    status: 'ok',
    error_class: '',
    verified_exit: spec.country,
    result_host: hostnameOnly(result?.link) || result?.result_host || spec.resultHost,
  };
}

async function dispatchProbe({ userId, account, buildProxy, cancelled, channelId, deps }) {
  if (paypalProfile(channelId)) {
    return probePaypalChannel({
      userId,
      account,
      buildProxy,
      cancelled,
      channelId,
      extractPaymentLink: deps.extractPaymentLink,
    });
  }
  return probeLocalChannel({
    userId,
    account,
    buildProxy,
    cancelled,
    channelId,
    extractLocalProvider: deps.extractLocalProvider,
  });
}

async function runChannel(userId, channelId, deps = {}) {
  const startedAt = nowSql();
  const extractLinkBefore = (accountId) => {
    if (!accountId) return '';
    return String(db.prepare('SELECT extract_link FROM gpt_accounts WHERE id = ?').get(accountId)?.extract_link || '');
  };
  let account = null;
  try {
    const settings = (deps.readSettings || readSettings)(userId);
    const buildProxy = deps.buildProxy || ((country) => buildMonitorProxy(userId, country, settings));
    const exitCountry = channelCountry(channelId) || 'GB';
    if (!buildProxy(exitCountry)) {
      persistOutcome(userId, channelId, null, startedAt, {
        status: 'no_proxy',
        error_class: 'geo_mismatch',
        verified_exit: '',
        result_host: '',
      });
      return { status: 'no_proxy' };
    }
    account = await (deps.selectAccount || selectMonitorAccount)(userId);
    if (!account) {
      persistOutcome(userId, channelId, null, startedAt, {
        status: 'no_trial',
        error_class: 'not_eligible',
        verified_exit: '',
        result_host: '',
      });
      return { status: 'no_trial' };
    }
    const before = extractLinkBefore(account.id);
    try {
      const outcome = await dispatchProbe({
        userId,
        account,
        buildProxy,
        cancelled: deps.cancelled || (() => false),
        channelId,
        deps,
      });
      const after = extractLinkBefore(account.id);
      if (after !== before) {
        db.prepare('UPDATE gpt_accounts SET extract_link = ? WHERE id = ?').run(before, account.id);
        logMonitor(userId, 'warning', `${account.email || account.id}：监控探测试图改写 extract_link，已回滚`);
      }
      persistOutcome(userId, channelId, account.id, startedAt, outcome);
      if (!deps.skipAccountCool) coolAccount(userId, account.id);
      return { ...outcome, account_id: account.id };
    } catch (error) {
      const after = extractLinkBefore(account.id);
      if (after !== before) {
        db.prepare('UPDATE gpt_accounts SET extract_link = ? WHERE id = ?').run(before, account.id);
      }
      throw error;
    }
  } catch (error) {
    const errorClass = classifyError(error);
    const status = statusFromClass(errorClass);
    if (account?.id && !deps.skipAccountCool) {
      coolAccount(userId, account.id, errorClass === 'unusual_activity' ? 60 * 60 * 1000 : ACCOUNT_COOL_MS);
    }
    persistOutcome(userId, channelId, account?.id || null, startedAt, {
      status,
      error_class: errorClass,
      verified_exit: errorClass === 'geo_mismatch' ? '' : channelCountry(channelId),
      result_host: '',
    });
    logMonitor(userId, 'warning', `${account?.email || channelId}：探测失败 ${errorClass}`);
    return { status, error_class: errorClass, account_id: account?.id || null };
  }
}

function activeCount() {
  return slots.length;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: n }, () => run()));
  return results;
}

async function runUserProbe(userId, deps = {}) {
  const settings = (deps.readSettings || readSettings)(userId);
  const plan = planState(userId, settings);
  const nowMs = Number(deps.nowMs) || Date.now();
  if (!userDue(userId, plan, nowMs, deps.force)) return { skipped: true, reason: 'interval' };
  const queue = deps.channelId
    ? [String(deps.channelId)]
    : dueChannelIds(userId, plan, nowMs, deps.force);
  if (!queue.length) return { skipped: true, reason: 'cooldown' };
  if (slots.some((item) => item.userId === userId)) {
    return { skipped: true, reason: 'concurrency' };
  }
  const slot = { userId, channelId: queue[0], startedAt: nowMs };
  slots.push(slot);
  upsertPlanRow(userId, plan, {
    last_run_at: nowSql(nowMs),
    next_run_at: nowSql(nowMs + plan.interval_minutes * 60 * 1000),
  });
  const workers = clampConcurrency(plan.concurrency);
  const busyAccounts = new Set();
  const used = new Map();
  const selectAccount = async () => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const row = selectMonitorAccount(userId, Date.now(), { excludeIds: busyAccounts });
      if (row) {
        busyAccounts.add(Number(row.id));
        return row;
      }
      if (!busyAccounts.size) return null;
      await sleep(20);
    }
    return null;
  };
  try {
    const outcomes = await mapLimit(queue, workers, async (channelId) => {
      slot.channelId = channelId;
      const outcome = await runChannel(userId, channelId, {
        ...deps,
        skipAccountCool: true,
        selectAccount: deps.selectAccount || selectAccount,
      });
      if (outcome.account_id) {
        const coolMs = outcome.error_class === 'unusual_activity' ? 60 * 60 * 1000 : ACCOUNT_COOL_MS;
        used.set(outcome.account_id, Math.max(used.get(outcome.account_id) || 0, coolMs));
        busyAccounts.delete(Number(outcome.account_id));
      }
      return outcome;
    });
    for (const [accountId, coolMs] of used.entries()) coolAccount(userId, accountId, coolMs);
    return { skipped: false, outcome: outcomes[0], channelId: queue[0], outcomes, channelIds: queue };
  } finally {
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
  }
}

async function tick(deps = {}) {
  if (ticking) return;
  ticking = true;
  try {
    const users = deps.users || db.prepare('SELECT id FROM users WHERE status = 1').all();
    const nowMs = Number(deps.nowMs) || Date.now();
    const due = [];
    for (const user of users) {
      const plan = planState(user.id, (deps.readSettings || readSettings)(user.id));
      if (userDue(user.id, plan, nowMs, deps.force) && (pickDueChannel(user.id, plan, nowMs, deps.force) || deps.force)) {
        due.push({ id: user.id, concurrency: plan.concurrency });
      }
    }
    const tasks = [];
    for (const user of due) {
      if (slots.some((item) => item.userId === user.id)) continue;
      if (slots.length + tasks.length >= PROCESS_CAP) break;
      tasks.push(runUserProbe(user.id, { ...deps, nowMs }));
    }
    await Promise.all(tasks);
  } finally {
    ticking = false;
  }
}

function kick(userId) {
  Promise.resolve()
    .then(() => (userId ? runUserProbe(userId, { force: true }) : tick({ force: true })))
    .catch((error) => {
      if (userId) logMonitor(userId, 'warning', `监控调度未启动：${String(error.message || error).slice(0, 160)}`);
    });
}

function startPoller() {
  if (timer) return;
  setTimeout(() => { tick().catch(() => {}); }, 4000);
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

function engineSnapshot(userId) {
  const running = slots.filter((slot) => !userId || slot.userId === Number(userId));
  const plan = userId ? planState(userId) : null;
  return {
    connected: true,
    label: running.length ? '探测运行中' : '待命',
    concurrency: plan?.concurrency || 1,
    running: running.length,
    current_channel: running[0]?.channelId || '',
    proxy_source: 'cliproxy',
    note: '独立探测引擎走设置里的 CliProxy 动态池，按通道改写 region/sid。并发硬顶 20，成功只写入监控表，不覆盖账号 extract_link。',
  };
}

module.exports = {
  TICK_MS,
  PROCESS_CAP,
  MIN_INTERVAL_MINUTES,
  SUCCESS_LIST_LIMIT,
  ACCOUNT_COOL_MS,
  hostnameOnly,
  classifyError,
  statusFromClass,
  wiredChannelIds,
  channelCountry,
  pickDueChannel,
  dueChannelIds,
  enabledChannelIds,
  normalizeEnabledChannels,
  clampInterval,
  clampConcurrency,
  planState,
  savePlan,
  selectMonitorAccount,
  productionBusy,
  productionBusyIds,
  loadMonitorProxies,
  countPaymentProxies,
  cliproxyConfigured,
  cliproxyPoolView,
  buildMonitorProxy,
  loadResult,
  loadResults,
  loadRecentRuns,
  loadSuccesses,
  persistOutcome,
  runChannel,
  runUserProbe,
  tick,
  kick,
  startPoller,
  engineSnapshot,
  activeCount,
  _test: {
    slots,
    nowSql,
    parseStamp,
    userDue,
    channelDue,
    pickDueChannel,
  },
};
