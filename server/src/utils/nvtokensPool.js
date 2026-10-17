const DEFAULT_BASE = 'https://nvtokens.com';
const PRICE_BOARD_PATH = '/api/pool/price-board';
const MERCHANT_RANKINGS_PATH = '/api/merchant-rankings';
const POOL_PATH = '/api/inventory/cards/pool';
const POOL_SCHEMA_PATH = '/api/inventory/cards/pool/schema';
const IMPORT_SCHEMA_PATH = '/api/inventory/cards/import/schema';
const SUPPLIER_SETTINGS_PATH = '/api/supplier/settings';

// 整号直卖：不加入兜底池。省略该字段时 nvtokens 会按后台默认倍率 0.08 入兜底池。
const DIRECT_SALE_FLAGS = Object.freeze({
  fallback_pool_enabled: false,
});

const BROWSER_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json',
  origin: 'https://nvtokens.com',
  referer: 'https://nvtokens.com/workspace',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
};

const SECRET_KEY = /access_token|refresh_token|id_token|session_token|api[_-]?key|password|authorization|cookie|selection_token/i;

function maskApiKey(key) {
  const text = String(key || '').trim();
  if (!text) return '(empty)';
  if (text.length <= 8) return `${text.slice(0, 3)}****`;
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEY.test(key)
        ? (typeof nested === 'string' ? `REDACTED:${nested.length}` : '[redacted]')
        : redact(nested),
    ]));
  }
  return value;
}

function centsToYuan(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return (n / 100).toFixed(2);
}

function formatYuan(value) {
  const n = Number(String(value || '').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function stripEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

function isSub2Document(input) {
  return Boolean(input && typeof input === 'object' && Array.isArray(input.accounts));
}

function unwrapAccount(input = {}) {
  if (!input || typeof input !== 'object') return {};
  if (isSub2Document(input) && input.accounts[0]) return unwrapAccount(input.accounts[0]);
  if (input.credentials && typeof input.credentials === 'object') {
    return {
      ...input.credentials,
      email: firstText(input.extra?.email, input.credentials.email, input.email, input.name),
      type: input.type,
      platform: input.platform,
    };
  }
  if (input.data && typeof input.data === 'object' && (input.data.access_token || input.data.refresh_token || input.data.email || isSub2Document(input.data))) {
    return unwrapAccount(input.data);
  }
  return input;
}

function toPoolData(account) {
  if (isSub2Document(account)) return account;
  const src = unwrapAccount(account);
  return stripEmpty({
    type: 'codex',
    access_token: firstText(src.access_token),
    refresh_token: firstText(src.refresh_token),
    email: firstText(src.email, src.name),
    id_token: firstText(src.id_token),
    session_token: firstText(src.session_token),
    account_id: firstText(src.account_id, src.chatgpt_account_id),
    expired: firstText(src.expired, src.expires_at),
    plan_type: firstText(src.plan_type, src.plan),
  });
}

function toPoolPayload(account, priceYuan) {
  return {
    price_yuan: formatYuan(priceYuan),
    fallback_pool_enabled: DIRECT_SALE_FLAGS.fallback_pool_enabled,
    data: toPoolData(account),
  };
}

function plusPlanFromBoard(board) {
  const plans = board?.board?.plans || board?.plans || [];
  return plans.find((item) => String(item?.plan || '').toLowerCase() === 'plus') || null;
}

function summarizePlusPlan(plus) {
  if (!plus) return null;
  return {
    plan: plus.plan,
    available: plus.available === true,
    inventory_label: plus.inventory_label || '',
    inventory_level: plus.inventory_level || '',
    inventory_token_count: Number(plus.inventory_token_count) || 0,
    min_yuan: centsToYuan(plus.min_cents),
    p25_yuan: centsToYuan(plus.p25_cents),
    median_yuan: centsToYuan(plus.median_cents),
    p75_yuan: centsToYuan(plus.p75_cents),
    max_yuan: centsToYuan(plus.max_cents),
    avg_yuan: centsToYuan(plus.avg_cents),
    min_cents: Number(plus.min_cents) || 0,
    p25_cents: Number(plus.p25_cents) || 0,
    median_cents: Number(plus.median_cents) || 0,
    p75_cents: Number(plus.p75_cents) || 0,
    max_cents: Number(plus.max_cents) || 0,
    avg_cents: Number(plus.avg_cents) || 0,
  };
}

function plusMerchantCount(payload) {
  const rankings = Array.isArray(payload?.rankings) ? payload.rankings : [];
  return rankings.filter((row) => {
    const available = Number(row?.sale_plan_stats?.plus?.available_count || row?.sale_plan_counts?.plus || 0);
    return available > 0;
  }).length;
}

function suggestListPrice(plus, strategy = 'floor') {
  const stats = plus?.min_cents != null ? plus : summarizePlusPlan(plus) || {};
  const table = {
    floor: stats.min_cents,
    p25: stats.p25_cents,
    median: stats.median_cents,
    p75: stats.p75_cents,
    average: stats.avg_cents,
  };
  const selected = Number(table[strategy]);
  const cents = Number.isFinite(selected) && selected > 0
    ? selected
    : (Number(table.floor) > 0 ? Number(table.floor) : 0);
  return cents > 0 ? centsToYuan(cents) : null;
}

async function parseResponse(response) {
  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    payload: redact(payload),
    raw_type: typeof payload,
    raw_keys: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).slice(0, 24) : null,
  };
}

async function requestJson(url, { method = 'GET', headers = {}, body, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const response = await fetchFn(url, {
    method,
    headers: { ...BROWSER_HEADERS, ...headers },
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return parseResponse(response);
}

function resolveKey(options = {}) {
  if (options.omitApiKey) return '';
  if (Object.prototype.hasOwnProperty.call(options, 'apiKey')) return String(options.apiKey || '').trim();
  if (Object.prototype.hasOwnProperty.call(options, 'api_key')) return String(options.api_key || '').trim();
  return firstText(process.env.NVTOKENS_API_KEY);
}

function normalizeSessionCookie(value) {
  let text = String(value || '').trim().replace(/^Cookie:\s*/i, '');
  if (!text) return '';
  const match = text.match(/(?:^|;\s*)scm_session=([^;]+)/i);
  if (match) return String(match[1] || '').trim();
  return text;
}

function sessionLast4(value) {
  const text = normalizeSessionCookie(value);
  if (!text || text.length <= 4) return '';
  return text.slice(-4);
}

function resolveSession(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'session')) return normalizeSessionCookie(options.session);
  if (Object.prototype.hasOwnProperty.call(options, 'session_cookie')) return normalizeSessionCookie(options.session_cookie);
  return normalizeSessionCookie(firstText(process.env.NVTOKENS_SESSION));
}

function cookieHeader(session) {
  const text = normalizeSessionCookie(session);
  if (!text) return {};
  return { cookie: `scm_session=${text}` };
}

function resolveBase(options = {}) {
  return firstText(options.baseUrl, process.env.NVTOKENS_BASE_URL, DEFAULT_BASE).replace(/\/+$/, '');
}

function authHeaders(options = {}) {
  const apiKey = resolveKey(options);
  return apiKey ? { 'x-api-key': apiKey } : {};
}

function resolveListPrice(minYuan, plus) {
  const min = formatYuan(minYuan);
  const fallback = min && Number(min) > 0 ? min : '20.00';
  if (!plus) return fallback;
  const board = suggestListPrice(plus, 'floor') || '';
  if (!board || !Number.isFinite(Number(board)) || Number(board) <= 0) return fallback;
  return formatYuan(board);
}

function isListablePlusAccount(account) {
  const src = unwrapAccount(account);
  const plan = firstText(src.plan_type, src.plan).toLowerCase();
  return Boolean(firstText(src.refresh_token)) && plan === 'plus';
}

async function fetchPriceBoard(options = {}) {
  const url = `${resolveBase(options)}${PRICE_BOARD_PATH}`;
  const headers = { ...authHeaders(options), ...cookieHeader(resolveSession(options)) };
  const result = await requestJson(url, { headers, fetchImpl: options.fetchImpl });
  const plus = summarizePlusPlan(plusPlanFromBoard(result.payload));
  return { ...result, plus, url, error: result.payload?.error, code: result.payload?.code };
}

async function fetchMerchantRankings(options = {}) {
  const url = `${resolveBase(options)}${MERCHANT_RANKINGS_PATH}`;
  const headers = { ...authHeaders(options), ...cookieHeader(resolveSession(options)) };
  const result = await requestJson(url, { headers, fetchImpl: options.fetchImpl });
  return {
    ...result,
    plus_merchant_count: plusMerchantCount(result.payload),
    url,
    error: result.payload?.error,
    code: result.payload?.code,
  };
}

function plusPriceText(plus, merchants) {
  if (!plus) return '看板没有 Plus 价格';
  const stock = plus.inventory_label
    || (Number(plus.inventory_token_count) > 0 ? String(plus.inventory_token_count) : '')
    || plus.inventory_level
    || '未知';
  const merchantBit = Number.isFinite(Number(merchants)) && Number(merchants) > 0
    ? `，商家 ${Number(merchants)}`
    : '';
  return `Plus 最低 ${plus.min_yuan || '—'} – 最高 ${plus.max_yuan || '—'} – 均价 ${plus.avg_yuan || '—'} – P25 ${plus.p25_yuan || '—'} – 库存 ${stock}${merchantBit}`;
}

function priceBoardTestResult(plus, merchants) {
  const count = Number.isFinite(Number(merchants)) ? Number(merchants) : 0;
  return {
    ok: true,
    min: plus.min_yuan,
    max: plus.max_yuan,
    avg: plus.avg_yuan,
    p25: plus.p25_yuan,
    inventory_label: plus.inventory_label || '',
    merchants: count,
    text: plusPriceText(plus, count),
  };
}

async function testPlusPriceBoard(options = {}) {
  const session = resolveSession(options);
  if (!session) {
    return { ok: false, message: '请先填写或保存价格查询 Token' };
  }
  const auth = { ...options, session, omitApiKey: true };
  const board = await fetchPriceBoard(auth);
  if (board.status === 401 || board.status === 403) {
    return { ok: false, message: '价格查询 token 已失效，请重新填写' };
  }
  if (!board.ok) {
    return { ok: false, message: '价格查询失败' };
  }
  if (!board.plus) {
    return { ok: false, message: '未找到 Plus 价格' };
  }
  let merchants = plusMerchantCount(board.payload);
  try {
    const ranks = await fetchMerchantRankings(auth);
    if (ranks?.ok) merchants = ranks.plus_merchant_count;
  } catch {
    /* rankings optional */
  }
  return priceBoardTestResult(board.plus, merchants);
}

async function fetchPoolSchema(options = {}) {
  const url = `${resolveBase(options)}${POOL_SCHEMA_PATH}`;
  const result = await requestJson(url, { headers: authHeaders(options), fetchImpl: options.fetchImpl });
  return { ...result, url, api_key: maskApiKey(resolveKey(options)) };
}

async function fetchSupplierSettings(options = {}) {
  const session = resolveSession(options);
  if (!session) return { ok: false, skipped: true, reason: 'no_session', status: 0 };
  const url = `${resolveBase(options)}${SUPPLIER_SETTINGS_PATH}`;
  const headers = { ...cookieHeader(session), ...authHeaders({ ...options, omitApiKey: true }) };
  const result = await requestJson(url, { headers, fetchImpl: options.fetchImpl });
  const settings = result.payload?.settings && typeof result.payload.settings === 'object'
    ? result.payload.settings
    : (result.payload && typeof result.payload === 'object' ? result.payload : {});
  return {
    ...result,
    url,
    settings,
    fallback_pool_enabled: settings.fallback_pool_enabled === true,
  };
}

async function disableFallbackPoolDefault(options = {}) {
  const current = await fetchSupplierSettings(options);
  if (current.skipped) return current;
  if (!current.ok) return { ...current, skipped: false };
  if (current.fallback_pool_enabled !== true) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_off',
      status: current.status,
      fallback_pool_enabled: false,
    };
  }
  const url = current.url || `${resolveBase(options)}${SUPPLIER_SETTINGS_PATH}`;
  const session = resolveSession(options);
  const headers = { ...cookieHeader(session), ...authHeaders({ ...options, omitApiKey: true }) };
  const body = {
    default_warranty_channel_id: current.settings.default_warranty_channel_id || null,
    fallback_pool_enabled: false,
  };
  const patched = await requestJson(url, {
    method: 'PATCH',
    headers,
    body,
    fetchImpl: options.fetchImpl,
  });
  return {
    ...patched,
    url,
    skipped: false,
    fallback_pool_enabled: false,
    sent_keys: Object.keys(body),
  };
}

async function postPoolCard(account, priceYuan, options = {}) {
  const apiKey = resolveKey(options);
  const url = firstText(options.url, `${resolveBase(options)}${POOL_PATH}`);
  const payload = toPoolPayload(account, priceYuan);
  const headers = { ...authHeaders({ ...options, apiKey }), ...options.headers };
  return {
    ...(await requestJson(url, {
      method: 'POST',
      headers,
      body: options.body !== undefined ? options.body : payload,
      fetchImpl: options.fetchImpl,
    })),
    url,
    api_key: maskApiKey(apiKey),
    sent_keys: Object.keys(payload),
    data_keys: payload.data && typeof payload.data === 'object' ? Object.keys(payload.data) : [],
    price_yuan: payload.price_yuan,
    fallback_pool_enabled: payload.fallback_pool_enabled === true,
  };
}

module.exports = {
  DEFAULT_BASE,
  PRICE_BOARD_PATH,
  MERCHANT_RANKINGS_PATH,
  POOL_PATH,
  POOL_SCHEMA_PATH,
  IMPORT_SCHEMA_PATH,
  SUPPLIER_SETTINGS_PATH,
  DIRECT_SALE_FLAGS,
  maskApiKey,
  redact,
  centsToYuan,
  formatYuan,
  isSub2Document,
  toPoolData,
  toPoolPayload,
  plusPlanFromBoard,
  summarizePlusPlan,
  plusMerchantCount,
  plusPriceText,
  suggestListPrice,
  resolveListPrice,
  resolveKey,
  resolveSession,
  normalizeSessionCookie,
  sessionLast4,
  cookieHeader,
  isListablePlusAccount,
  fetchPriceBoard,
  fetchMerchantRankings,
  testPlusPriceBoard,
  fetchPoolSchema,
  fetchSupplierSettings,
  disableFallbackPoolDefault,
  postPoolCard,
};
