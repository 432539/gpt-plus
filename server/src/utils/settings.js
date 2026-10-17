const db = require('../db');
const { encrypt, decrypt } = require('./crypto');
const { normalizeSessionCookie, sessionLast4 } = require('./nvtokensPool');
const {
  DEFAULT_PULL_SUFFIXES,
  catalogMailcomDomains,
  normalizeSuffixList,
  suffixCatalog,
} = require('./mailcomDomains');

const DEFAULTS = () => ({
  cloak: { license_key: '', license_keys: [], headless: true, max_concurrency: 3, humanize: true, human_preset: 'careful' },
  registration: {
    set_password: true,
    enable_totp_2fa: true,
    asset_optimization: true,
    mail_provider: 'herosms',
    mailcom_share: 5,
    cfworker_share: 5,
    performance_profile: 'safe',
    attempts: 3,
  },
  sms: {
    provider: 'auto',
    phone_provider: 'auto',
    api_url: 'https://hero-sms.com/stubs/handler_api.php',
    api_key: '',
    country: 'usa',
    product: 'openai',
  },
  herosms: {
    api_url: 'https://hero-sms.com', api_key: '', country: 'usa', service: 'openai',
    site: 'openai.com', domain: 'outlook.com', max_reorders: 4, acquire_attempts: 3,
    requests_per_second: 12, max_request_concurrency: 16, max_active_activations: 20,
    ban_cooldown_ms: 1800000, rate_cooldown_ms: 12000,
  },
  smsbower: { api_url: 'https://smsbower.app/stubs/handler_api.php', api_key: '', country: 'gb', service: 'dr', domain: '', max_price: '' },
  cfworker_mail: { api_url: '', api_key: '', domain: '', disabled_suffixes: [], domains: [] },
  imported_mail: { mailboxes: '', allow_unsafe_url: false },
  dynamic_proxy: {
    active_pool: '1024proxy',
    providers: {
      '1024proxy': { username: '', password: '', sticky_minutes: 30 },
      b2proxy: { username: '', password: '', sticky_minutes: 30 },
      cliproxy: { username: '', password: '', sticky_minutes: 30 },
      iprocket: { username: '', password: '', sticky_minutes: 5 },
    },
  },
  email_domains: { mode: 'all', allow: [], deny: [] }, // mode: all | whitelist | blacklist
  mailpit: {
    url: 'http://127.0.0.1:8025',
    username: '',
    password: '',
    webhook_secret: '',
    smtp_host: '',
    mx_host: '',
    ui_url: '',
    domains: [],
  },
  mailcom: {
    oauth_secret: '',
    proxy_group: '', // 空 / 直连 = 不使用代理。仅明确选择分组时走该组，不回退注册/支付/验活/动态代理
    poll_minutes: 0, // 0 = 关闭轮询
    auto_delete_used: false, // 自动删除已使用子号
    auto_repull: false, // 删除后自动拉满子号
    cap: 10, // 每个母号最多地址数(含母号)
    enabled_suffixes: [...DEFAULT_PULL_SUFFIXES],
    disabled_suffixes: [],
    unavailable_suffixes: {},
  },
  suffix_quota: {
    hourly: 0,
    daily: 0,
  },
  accounts: {
    detect_poll_minutes: 15, // 0 = 关闭验活；试用未检测仍每 2 分钟探测
    detect_proxy_group: '', // 已废弃：验活/回填走 CliProxy 动态池，不再读手工检测组
  },
  import_dump: {
    url: '',
    api_key: '',
  },
  pipeline: {
    register: false,
    rebind: false,
    extract: false,
    pay: false,
    acquire_rt: false,
    daily_register_limit: 0, // 0 = 不限制
    register_concurrency: 5, // 流水线自动注册并发，默认 5
    extract_attempts: 5,
    extract_interval_minutes: 10,
    pay_attempts: 5,
    rt_attempts: 5,
  },
  pipeline_gc: {
    register: false,
    rebind: false,
    extract: false,
    pay: false,
    acquire_rt: false,
  },
  global_extract: {
    enabled: false,
    interval_minutes: 60,
    concurrency: 1, // 设置最大 20，引擎硬顶 PROCESS_CAP=20
    enabled_channels: [],
  },
  nvtokens: {
    auto_list_plus: false,
    min_price_yuan: '20.00',
    api_key: '',
    session_cookie: '',
  },
});

function shareOrDefault(value, fallback = 5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
}

function parseLicenseKeyText(value) {
  return String(value || '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cloakLicenseKeys(cloak = {}) {
  const seen = new Set();
  const keys = [];
  const add = (value) => {
    const list = Array.isArray(value) ? value : parseLicenseKeyText(value);
    for (const item of list) {
      const key = String(item || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  };
  add(cloak.license_keys);
  add(cloak.license_key);
  return keys;
}

function cloakLicenseConfigured(cloak = {}) {
  return cloakLicenseKeys(cloak).length > 0;
}

function persistCloakLicenses(input = {}) {
  const keys = cloakLicenseKeys(input);
  return { license_key: keys[0] || '', license_keys: keys };
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function readSettings(userId) {
  const row = db.prepare('SELECT data_enc FROM user_settings WHERE user_id = ?').get(userId);
  if (!row || !row.data_enc) return DEFAULTS();
  try {
    return deepMerge(DEFAULTS(), JSON.parse(decrypt(row.data_enc)));
  } catch {
    return DEFAULTS();
  }
}

function writeSettings(userId, patch) {
  const current = readSettings(userId);
  const next = deepMerge(current, patch);
  const enc = encrypt(JSON.stringify(next));
  db.prepare(
    `INSERT INTO user_settings (user_id, data_enc, updated_at)
     VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(user_id) DO UPDATE SET data_enc = excluded.data_enc, updated_at = excluded.updated_at`
  ).run(userId, enc);
  return next;
}

function addressDomain(address) {
  const value = String(address || '').trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '';
  const domain = value.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) || domain.includes('..')) return '';
  return domain;
}

// Disable only a currently enabled, catalog-backed pull suffix. This never changes
// mailbox rows or mother-account identity; `mail.com` is treated like any other
// suffix only when the failed alias itself uses it and it is currently enabled.
const disableMailcomPullSuffixTx = db.transaction((userId, address) => {
  const domain = addressDomain(address);
  if (!domain || !catalogMailcomDomains().includes(domain)) {
    return { changed: false, domain: '' };
  }
  const current = readSettings(userId);
  const catalog = suffixCatalog(current.mailcom);
  if (!catalog.items.some((item) => item.suffix === domain && item.enabled)) {
    return { changed: false, domain };
  }
  const enabled = normalizeSuffixList(current.mailcom.enabled_suffixes).filter((suffix) => suffix !== domain);
  const disabled = normalizeSuffixList([...(current.mailcom.disabled_suffixes || []), domain]);
  writeSettings(userId, {
    mailcom: {
      enabled_suffixes: enabled,
      disabled_suffixes: disabled,
    },
  });
  return { changed: true, domain };
});

function disableMailcomPullSuffix(userId, address) {
  return disableMailcomPullSuffixTx(userId, address);
}

// 脱敏视图:不回传明文密钥,只回传是否已配置
function stampUnavailable(prev, meta = {}) {
  return {
    count: (Number(prev?.count) || 0) + 1,
    reason: String(meta.reason || prev?.reason || 'not_allowed'),
    last_status: Number(meta.status || prev?.last_status) || 0,
    last_error: String(meta.error || prev?.last_error || '').slice(0, 240),
    last_seen_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
}

const recordUnavailableSuffixesTx = db.transaction((userId, domains, meta = {}) => {
  const list = normalizeSuffixList(domains);
  if (!list.length) return { changed: false, domains: [], count: 0 };
  const current = readSettings(userId);
  const map = { ...(current.mailcom.unavailable_suffixes || {}) };
  for (const suffix of list) {
    map[suffix] = stampUnavailable(map[suffix], meta);
  }
  writeSettings(userId, { mailcom: { unavailable_suffixes: map } });
  return { changed: true, domains: list, count: list.length };
});

function recordUnavailableSuffixes(userId, domains, meta = {}) {
  return recordUnavailableSuffixesTx(userId, domains, meta);
}

function publicView(settings, userId) {
  const cat = suffixCatalog(settings.mailcom);
  let suffixes = cat.items;
  if (userId) {
    const { suffixStatsForUser, attachSuffixStats } = require('./suffixPick');
    suffixes = attachSuffixStats(cat.items, suffixStatsForUser(userId));
  }
  return {
    cloak: {
      license_configured: cloakLicenseConfigured(settings.cloak),
      license_count: cloakLicenseKeys(settings.cloak).length,
      headless: settings.cloak.headless,
      max_concurrency: settings.cloak.max_concurrency,
      humanize: settings.cloak.humanize !== false,
      human_preset: settings.cloak.human_preset || 'careful',
    },
    registration: {
      set_password: settings.registration?.set_password !== false,
      enable_totp_2fa: settings.registration?.enable_totp_2fa !== false,
      mail_provider: settings.registration?.mail_provider || 'herosms',
      mailcom_share: shareOrDefault(settings.registration?.mailcom_share),
      cfworker_share: shareOrDefault(settings.registration?.cfworker_share),
      performance_profile: settings.registration?.performance_profile || 'safe',
      attempts: Number(settings.registration?.attempts) || 3,
    },
    sms: {
      provider: settings.sms.provider,
      phone_provider: settings.sms.phone_provider || 'auto',
      api_url: settings.sms.api_url,
      api_key_configured: Boolean(settings.sms.api_key),
      country: settings.sms.country,
      product: settings.sms.product,
    },
    herosms: {
      api_url: settings.herosms?.api_url || '',
      api_key_configured: Boolean(settings.herosms?.api_key),
      country: settings.herosms?.country || '',
      service: settings.herosms?.service || '',
      domain: settings.herosms?.domain || '',
      site: settings.herosms?.site || 'openai.com',
      max_reorders: Number(settings.herosms?.max_reorders) || 4,
      acquire_attempts: Number(settings.herosms?.acquire_attempts) || 3,
      requests_per_second: Number(settings.herosms?.requests_per_second) || 12,
      max_request_concurrency: Number(settings.herosms?.max_request_concurrency) || 16,
      max_active_activations: Number(settings.herosms?.max_active_activations) || 20,
      max_transient_retries: Number(settings.herosms?.max_transient_retries) || 2,
      transient_retry_base_ms: Number(settings.herosms?.transient_retry_base_ms) || 500,
      ban_cooldown_ms: Number(settings.herosms?.ban_cooldown_ms) || 1800000,
      rate_cooldown_ms: Number(settings.herosms?.rate_cooldown_ms) || 12000,
    },
    smsbower: {
      api_url: settings.smsbower?.api_url || '',
      api_key_configured: Boolean(settings.smsbower?.api_key),
      country: settings.smsbower?.country || '',
      service: settings.smsbower?.service || '',
      domain: settings.smsbower?.domain || '',
      max_price: settings.smsbower?.max_price ?? '',
    },
    cfworker_mail: (() => {
      const { cfMailCatalog, cfMailReady } = require('./cfMail');
      const catalog = cfMailCatalog(settings);
      return {
        api_url: settings.cfworker_mail?.api_url || '',
        api_key_configured: Boolean(settings.cfworker_mail?.api_key),
        domain: settings.cfworker_mail?.domain || '',
        ready: cfMailReady(settings),
        domains: catalog,
        enabled_count: catalog.filter((item) => item.enabled).length,
        suffix_total: catalog.length,
        disabled_suffixes: catalog.filter((item) => !item.enabled).map((item) => item.domain),
      };
    })(),
    imported_mail: {
      configured: Boolean(settings.imported_mail?.mailboxes),
      allow_unsafe_url: settings.imported_mail?.allow_unsafe_url === true,
    },
    dynamic_proxy: {
      active_pool: settings.dynamic_proxy?.active_pool || '1024proxy',
      providers: Object.fromEntries(
        ['1024proxy', 'b2proxy', 'cliproxy', 'iprocket'].map((id) => [id, {
          username: settings.dynamic_proxy?.providers?.[id]?.username || '',
          password_configured: Boolean(settings.dynamic_proxy?.providers?.[id]?.password),
          sticky_minutes: settings.dynamic_proxy?.providers?.[id]?.sticky_minutes || (id === 'iprocket' ? 5 : 30),
        }])
      ),
    },
    email_domains: settings.email_domains,
    suffix_quota: (() => {
      const { suffixQuotaView } = require('./suffixQuota');
      return suffixQuotaView(userId, settings);
    })(),
    mailpit: (() => {
      const { publicMailpitView } = require('./mailpit');
      return publicMailpitView(settings);
    })(),
    mailcom: {
      oauth_builtin: true,
      proxy_group: String(settings.mailcom.proxy_group || ''),
      poll_minutes: settings.mailcom.poll_minutes,
      auto_delete_used: settings.mailcom.auto_delete_used,
      auto_repull: settings.mailcom.auto_repull,
      cap: settings.mailcom.cap,
      suffixes,
      enabled_count: cat.enabled_count,
      unavailable_enabled_count: cat.unavailable_enabled_count,
      suffix_total: cat.total,
    },
    accounts: {
      detect_poll_minutes: Number.isFinite(Number(settings.accounts?.detect_poll_minutes))
        ? Math.max(0, Math.min(1440, Number(settings.accounts.detect_poll_minutes)))
        : 15,
      detect_proxy_group: String(settings.accounts?.detect_proxy_group || ''),
    },
    import_dump: {
      configured: Boolean(String(settings.import_dump?.url || '').trim() && String(settings.import_dump?.api_key || '').trim()),
    },
    pipeline: {
      register: settings.pipeline?.register === true,
      rebind: settings.pipeline?.rebind === true,
      extract: settings.pipeline?.extract === true,
      pay: settings.pipeline?.pay === true,
      acquire_rt: settings.pipeline?.acquire_rt === true,
      daily_register_limit: Number.isFinite(Number(settings.pipeline?.daily_register_limit))
        ? Math.max(0, Math.min(10000, Number.parseInt(settings.pipeline.daily_register_limit, 10) || 0))
        : 0,
      register_concurrency: Number.isFinite(Number(settings.pipeline?.register_concurrency))
        ? Math.max(1, Math.min(200, Number.parseInt(settings.pipeline.register_concurrency, 10) || 5))
        : 5,
      extract_attempts: Math.max(1, Math.min(50, Number.parseInt(settings.pipeline?.extract_attempts, 10) || 5)),
      extract_interval_minutes: Number.isFinite(Number(settings.pipeline?.extract_interval_minutes))
        ? Math.max(0, Math.min(1440, Number.parseInt(settings.pipeline.extract_interval_minutes, 10) || 0))
        : 10,
      pay_attempts: Math.max(1, Math.min(50, Number.parseInt(settings.pipeline?.pay_attempts, 10) || 5)),
      rt_attempts: Math.max(1, Math.min(50, Number.parseInt(settings.pipeline?.rt_attempts, 10) || 5)),
    },
    pipeline_gc: {
      register: settings.pipeline_gc?.register === true,
      rebind: settings.pipeline_gc?.rebind === true,
      extract: settings.pipeline_gc?.extract === true,
      pay: settings.pipeline_gc?.pay === true,
      acquire_rt: settings.pipeline_gc?.acquire_rt === true,
    },
    global_extract: {
      enabled: settings.global_extract?.enabled === true,
      interval_minutes: Number.isFinite(Number(settings.global_extract?.interval_minutes))
        ? Math.max(5, Math.min(1440, Number.parseInt(settings.global_extract.interval_minutes, 10) || 60))
        : 60,
      concurrency: Number.isFinite(Number(settings.global_extract?.concurrency))
        ? Math.max(1, Math.min(20, Number.parseInt(settings.global_extract.concurrency, 10) || 1))
        : 1,
      enabled_count: Array.isArray(settings.global_extract?.enabled_channels)
        ? settings.global_extract.enabled_channels.length
        : 0,
    },
    nvtokens: (() => {
      const session = normalizeSessionCookie(settings.nvtokens?.session_cookie)
        || normalizeSessionCookie(process.env.NVTOKENS_SESSION);
      const hasSession = Boolean(session);
      return {
        auto_list_plus: settings.nvtokens?.auto_list_plus === true,
        min_price_yuan: (() => {
          const n = Number(String(settings.nvtokens?.min_price_yuan || '').replace(/[^\d.-]/g, ''));
          if (!Number.isFinite(n) || n <= 0) return '20.00';
          return n.toFixed(2);
        })(),
        api_key_configured: Boolean(String(settings.nvtokens?.api_key || '').trim()
          || String(process.env.NVTOKENS_API_KEY || '').trim()),
        session_configured: hasSession,
        has_session: hasSession,
        session_last4: sessionLast4(session),
      };
    })(),
  };
}

// 根据用户域名后缀配置判断某邮箱是否允许导入
function domainAllowed(settings, address) {
  const cfg = settings.email_domains || { mode: 'all' };
  const at = String(address || '').split('@')[1];
  if (!at) return false;
  const domain = at.toLowerCase();
  const match = (list) => (list || []).some((s) => {
    const suffix = String(s || '').trim().toLowerCase().replace(/^@/, '');
    // 精确匹配或子域匹配(点边界),避免 gmail.com 命中 mail.com
    return suffix && (domain === suffix || domain.endsWith('.' + suffix));
  });
  if (cfg.mode === 'whitelist') return match(cfg.allow);
  if (cfg.mode === 'blacklist') return !match(cfg.deny);
  return true;
}

module.exports = {
  readSettings,
  writeSettings,
  publicView,
  domainAllowed,
  disableMailcomPullSuffix,
  recordUnavailableSuffixes,
  cloakLicenseKeys,
  cloakLicenseConfigured,
  persistCloakLicenses,
  DEFAULTS,
};
