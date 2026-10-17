'use strict';

const db = require('../db');
const { maskEmail } = require('./dashboardStats');
const { isGbPaymentProxy, isPaymentProxyGroup } = require('./paymentProxy');
const { readSettings } = require('./settings');
const engine = require('./globalExtractEngine');
const { PAYPAL_MONITOR_CHANNELS } = require('./paypalProfiles');

const STATUS_LABEL = Object.freeze({
  ok: '成功',
  rate: '限流',
  risk: '风控',
  no_trial: '无试用号',
  no_proxy: '无代理',
  idle: '待探测',
});

const FAMILY_LABEL = Object.freeze({
  paypal: 'PayPal',
  local: '本地支付',
});

const LOCAL_CHANNEL_CATALOG = Object.freeze([
  {
    id: 'ideal',
    family: 'local',
    method: 'ideal',
    method_label: 'iDEAL',
    country: 'NL',
    country_name: '荷兰',
    currency: 'EUR',
    result_host: 'stripe.com',
    connected: true,
    probe: 'ideal',
    phase: '已接入',
    source: 'monitor',
    detail: 'NL/EUR，银行锁 ING，Safari 17 指纹。checkout/provider 走 NL sticky，优惠 update 走 VN。结果只写监控表。',
  },
  {
    id: 'gcash',
    family: 'local',
    method: 'gcash',
    method_label: 'GCash',
    country: 'PH',
    country_name: '菲律宾',
    currency: 'PHP',
    result_host: 'adyen.com',
    connected: true,
    probe: 'gcash',
    phase: '已接入',
    source: 'monitor',
    detail: 'PH/PHP 走 Adyen：资格只看 cpmt_，出码重新 create oaics_ 后同 PH 会话 checkout/update，再 confirm → start 抽 QR。全程 PH sticky，不再 JP。',
  },
  {
    id: 'upi',
    family: 'local',
    method: 'upi',
    method_label: 'UPI',
    country: 'IN',
    country_name: '印度',
    currency: 'INR',
    result_host: 'stripe.com',
    connected: true,
    probe: 'upi',
    phase: '已接入',
    source: 'monitor',
    detail: 'IN/INR Stripe UPI。主链路 IN sticky，优惠 update 走 VN。结果取 hosted_instructions_url。',
  },
  {
    id: 'pix',
    family: 'local',
    method: 'pix',
    method_label: 'PIX',
    country: 'BR',
    country_name: '巴西',
    currency: 'BRL',
    result_host: 'stripe.com',
    connected: true,
    probe: 'pix',
    phase: '已接入',
    source: 'monitor',
    detail: 'BR/BRL Stripe PIX，confirm 带 CPF tax_id。主链路 BR sticky，优惠 update 走 VN。',
  },
  {
    id: 'blik',
    family: 'local',
    method: 'blik',
    method_label: 'BLIK',
    country: 'PL',
    country_name: '波兰',
    currency: 'PLN',
    result_host: 'stripe.com',
    connected: true,
    probe: 'blik',
    phase: '已接入',
    source: 'monitor',
    detail: 'PL/PLN Stripe BLIK。blik_authorize 为 App 内授权，监控记探测成功主机 stripe.com，不当作可复制外链。',
  },
  {
    id: 'twint',
    family: 'local',
    method: 'twint',
    method_label: 'TWINT',
    country: 'CH',
    country_name: '瑞士',
    currency: 'CHF',
    result_host: 'stripe.com',
    connected: true,
    probe: 'twint',
    phase: '已接入',
    source: 'monitor',
    detail: 'CH/CHF Stripe TWINT。全程 CH sticky，资格 plus-1-month-free。',
  },
  {
    id: 'kakao_pay',
    family: 'local',
    method: 'kakao_pay',
    method_label: 'Kakao Pay',
    country: 'KR',
    country_name: '韩国',
    currency: 'KRW',
    result_host: 'stripe.com',
    connected: true,
    probe: 'kakao_pay',
    phase: '已接入',
    source: 'monitor',
    detail: 'KR/KRW Stripe Kakao Pay。全程 KR sticky。',
  },
  {
    id: 'naver_pay',
    family: 'local',
    method: 'naver_pay',
    method_label: 'Naver Pay',
    country: 'KR',
    country_name: '韩国',
    currency: 'KRW',
    result_host: 'stripe.com',
    connected: true,
    probe: 'naver_pay',
    phase: '已接入',
    source: 'monitor',
    detail: 'KR/KRW Stripe Naver Pay。全程 KR sticky。',
  },
]);

const CHANNEL_CATALOG = Object.freeze([
  ...PAYPAL_MONITOR_CHANNELS,
  ...LOCAL_CHANNEL_CATALOG,
]);

const UNSUPPORTED = Object.freeze([
  { name: 'Klarna', reason: '无 link_type / 无 Stripe PM 提取器' },
  { name: 'Bancontact', reason: '无入口' },
  { name: 'Card / 卡号', reason: '不是提链目标' },
  { name: 'Bizum', reason: 'Stripe 不支持 subscription/setup' },
]);

function tableColumns(table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function countGbPaymentProxies(userId) {
  const columns = tableColumns('proxies');
  if (!columns.has('user_id') || !columns.has('status')) return 0;
  const rows = db.prepare(
    `SELECT group_name, username, region, status
       FROM proxies
      WHERE user_id = ? AND status = '可用'`
  ).all(userId);
  return rows.filter((row) => isPaymentProxyGroup(row.group_name) && isGbPaymentProxy(row)).length;
}

function accountSnapshot(userId) {
  const columns = tableColumns('gpt_accounts');
  if (!columns.has('user_id')) {
    return { total: 0, trial_yes: 0, ready: 0, monitor_ready: 0 };
  }
  const hasTrial = columns.has('has_trial');
  const hasToken = columns.has('access_token');
  const hasPool = columns.has('monitor_pool');
  const hasCool = columns.has('monitor_cool_until');
  const readyExpr = [
    hasTrial ? 'has_trial = 1' : null,
    hasToken ? "TRIM(COALESCE(access_token, '')) != ''" : null,
    columns.has('token_invalidated') ? 'COALESCE(token_invalidated, 0) = 0' : null,
  ].filter(Boolean).join(' AND ') || '0';
  const monitorExpr = [
    readyExpr,
    hasCool ? "(TRIM(COALESCE(monitor_cool_until, '')) = '' OR datetime(monitor_cool_until) <= datetime('now','localtime'))" : null,
  ].filter(Boolean).join(' AND ');
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       ${hasTrial ? 'SUM(CASE WHEN has_trial = 1 THEN 1 ELSE 0 END)' : '0'} AS trial_yes,
       SUM(CASE WHEN ${readyExpr} THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN ${monitorExpr} THEN 1 ELSE 0 END) AS monitor_ready,
       ${hasPool ? 'SUM(CASE WHEN monitor_pool = 1 THEN 1 ELSE 0 END)' : '0'} AS monitor_pool
     FROM gpt_accounts
     WHERE user_id = ?`
  ).get(userId);
  return {
    total: Number(row?.total) || 0,
    trial_yes: Number(row?.trial_yes) || 0,
    ready: Number(row?.ready) || 0,
    monitor_ready: Number(row?.monitor_ready) || 0,
    monitor_pool: Number(row?.monitor_pool) || 0,
  };
}

function channelRow(item, live) {
  const family_label = FAMILY_LABEL[item.family] || item.family;
  const result = live.results.get(item.id);
  if (!item.connected || !item.probe) {
    return {
      id: item.id,
      family: item.family,
      family_label,
      method: item.method,
      method_label: item.method_label,
      country: item.country,
      country_name: item.country_name,
      currency: item.currency,
      connected: false,
      phase: item.phase,
      status: 'idle',
      status_label: STATUS_LABEL.idle,
      last_at: null,
      last_ok_at: null,
      last_error_class: null,
      cooldown_until: null,
      verified_exit: null,
      result_host: item.result_host,
      account_email_mask: '',
      production_conflict: false,
      source: item.source,
      detail: item.detail,
      recent_runs: [],
    };
  }

  const status = result?.last_status || 'idle';
  const statusLabel = status === 'idle'
    ? '待探测'
    : (STATUS_LABEL[status] || status);
  let accountMask = '';
  if (result?.last_account_id) {
    const email = db.prepare('SELECT email FROM gpt_accounts WHERE id = ?').get(result.last_account_id)?.email;
    accountMask = maskEmail(email);
  }
  return {
    id: item.id,
    family: item.family,
    family_label,
    method: item.method,
    method_label: item.method_label,
    country: item.country,
    country_name: item.country_name,
    currency: item.currency,
    connected: true,
    phase: result ? item.phase : '已接入待探测',
    status: status === 'idle' ? 'idle' : status,
    status_label: statusLabel,
    last_at: result?.last_at || null,
    last_ok_at: result?.last_ok_at || null,
    last_error_class: result?.last_error_class || null,
    cooldown_until: result?.cooldown_until || null,
    verified_exit: result?.verified_exit || null,
    result_host: result?.result_host || item.result_host,
    account_email_mask: accountMask,
    production_conflict: live.production_busy,
    source: item.source,
    detail: item.detail,
    recent_runs: engine.loadRecentRuns(live.userId, item.id, 5),
  };
}

function countByStatus(channels) {
  const counts = {
    connected: 0,
    unwired: 0,
    ok: 0,
    rate: 0,
    risk: 0,
    no_trial: 0,
    no_proxy: 0,
    idle: 0,
  };
  for (const row of channels) {
    if (row.connected) counts.connected += 1;
    else counts.unwired += 1;
    if (counts[row.status] !== undefined) counts[row.status] += 1;
  }
  return counts;
}

function buildOverview(userId) {
  const uid = Number(userId);
  const settings = readSettings(uid);
  const snapshot = accountSnapshot(uid);
  const busy = engine.productionBusy(uid);
  const results = new Map(engine.loadResults(uid).map((row) => [row.channel_id, row]));
  const plan = engine.planState(uid, settings);
  const enabled = new Set(plan.enabled_channels || []);
  const catalogById = new Map(CHANNEL_CATALOG.map((item) => [item.id, item]));
  const channels = CHANNEL_CATALOG.map((item) => {
    const row = channelRow(item, {
      userId: uid,
      results,
      production_busy: busy,
    });
    row.plan_enabled = item.connected ? enabled.has(item.id) : false;
    return row;
  });
  const successes = engine.loadSuccesses(uid).map((row) => {
    const item = catalogById.get(row.channel_id) || {};
    return {
      ...row,
      method: item.method || row.channel_id,
      method_label: item.method_label || row.channel_id,
      family: item.family || '',
      family_label: FAMILY_LABEL[item.family] || item.family || '',
      country: item.country || row.verified_exit || '',
      country_name: item.country_name || '',
    };
  });
  const counts = countByStatus(channels);
  counts.successes = successes.length;

  return {
    generated_at: new Date().toISOString(),
    engine: engine.engineSnapshot(uid),
    plan,
    pool: {
      trial_total: snapshot.trial_yes,
      ready: snapshot.monitor_ready || snapshot.ready,
      monitor_pool: snapshot.monitor_pool || 0,
      production_busy: busy,
      ...engine.cliproxyPoolView(uid, settings),
    },
    counts,
    channels,
    successes,
    unsupported: UNSUPPORTED,
  };
}

function savePlan(userId, body = {}) {
  return engine.savePlan(userId, body);
}

module.exports = {
  CHANNEL_CATALOG,
  STATUS_LABEL,
  UNSUPPORTED,
  clampInterval: engine.clampInterval,
  normalizePlan: engine.planState,
  savePlan,
  buildOverview,
  countGbPaymentProxies,
  accountSnapshot,
};
