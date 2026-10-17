export const PAY_GROUP_RE = /支付|paypal|pay(?:ment)?(?:[\s_-]?(?:gb|uk))?/i;
export const REGISTER_GROUP_RE = /注册|register|\bjp\b|japan/i;
export const DEFAULT_REGISTER_PROXY_GROUP = '__auto__:GB';
export const REGISTER_COUNT_MAX = 2000;

export const REGISTER_AUTO_COUNTRIES = Object.freeze([
  { code: 'JP', label: '日本' },
  { code: 'GB', label: '英国' },
  { code: 'US', label: '美国' },
  { code: 'TR', label: '土耳其' },
  { code: 'PH', label: '菲律宾' },
]);

export const DYNAMIC_PROXY_LABELS = Object.freeze({
  '1024proxy': '1024proxy',
  b2proxy: 'b2proxy',
  cliproxy: 'CliProxy',
  iprocket: 'IPRocket',
});

export const REGISTER_STATUS_LABELS = Object.freeze({
  queued: '排队',
  running: '运行中',
  success: '成功',
  failed: '失败',
  partial: '部分完成',
  skipped: '已跳过',
  cancelled: '已取消',
  completed: '已完成',
  interrupted: '已中断',
});

export function preferRegisterGroup(groups = []) {
  const list = Array.isArray(groups) ? groups : [];
  const name = item => String(item?.group_name || item || '').trim();
  const hit = list.find((item) => {
    const group = name(item);
    const count = Number(item?.count);
    return REGISTER_GROUP_RE.test(group)
      && !PAY_GROUP_RE.test(group)
      && (!Number.isFinite(count) || count > 0);
  });
  return name(hit) || DEFAULT_REGISTER_PROXY_GROUP;
}

export function resolveRegisterProxyGroup(proxyGroup, groups = []) {
  const requested = String(proxyGroup || '').trim();
  if (requested && requested !== '直连') return requested;
  return DEFAULT_REGISTER_PROXY_GROUP;
}

export function smsRegistrationProxyFor(country) {
  const code = String(country || '').trim().toUpperCase();
  if (REGISTER_AUTO_COUNTRIES.some((item) => item.code === code)) return `__auto__:${code}`;
  return DEFAULT_REGISTER_PROXY_GROUP;
}

export function registerProxyChoices(groups = [], dynamicProxy = {}) {
  const pool = String(dynamicProxy.active_pool || '1024proxy');
  const poolLabel = DYNAMIC_PROXY_LABELS[pool] || pool;
  const autos = REGISTER_AUTO_COUNTRIES.map((country) => ({
    value: `__auto__:${country.code}`,
    label: `自动化代理：${country.code} ${country.label}（${poolLabel}）`,
  }));
  const named = (Array.isArray(groups) ? groups : [])
    .filter((item) => {
      const group = String(item?.group_name || '');
      return group && !PAY_GROUP_RE.test(group);
    })
    .map((item) => ({
      value: item.group_name,
      label: `代理组：${item.group_name}（${item.count}）`,
    }));
  return [...autos, ...named];
}

export function preferPayGroup(groups = []) {
  const list = Array.isArray(groups) ? groups : [];
  const name = item => String(item?.group_name || item || '');
  const hit = list.find(item => /支付/.test(name(item)))
    || list.find(item => /paypal|pay[\s_-]?gb|\bgb\b|\buk\b/i.test(name(item)));
  return name(hit);
}

export function splitMailMix(count, mailcomShare = 5, cfShare = 5) {
  const totalCount = Math.max(0, Math.floor(Number(count) || 0));
  const mailParts = Math.max(0, Number(mailcomShare) || 0);
  const cfParts = Math.max(0, Number(cfShare) || 0);
  const parts = mailParts + cfParts;
  if (!totalCount) return { mailcom: 0, cfworker: 0 };
  if (!parts) return { mailcom: totalCount, cfworker: 0 };
  if (!cfParts) return { mailcom: totalCount, cfworker: 0 };
  if (!mailParts) return { mailcom: 0, cfworker: totalCount };
  const cfworker = Math.round(totalCount * cfParts / parts);
  return { mailcom: totalCount - cfworker, cfworker };
}

export function defaultRegisterConcurrency(cloakMax = 3) {
  return Math.max(1, Number.parseInt(cloakMax, 10) || 3);
}

export function registrationPayload(form = {}) {
  const quantity = Math.max(1, Math.min(REGISTER_COUNT_MAX, Number.parseInt(form.count, 10) || 1));
  const concurrency = Math.max(1, Number.parseInt(form.concurrency, 10) || 1);
  return {
    quantity,
    concurrency,
    mail_provider: form.mail_provider || 'mailcom',
    proxy_group: resolveRegisterProxyGroup(form.proxy_group, form.groups),
    set_password: form.set_password !== false,
    enable_totp_2fa: form.enable_totp_2fa !== false,
    get_refresh_token: false,
    register_mode: form.register_mode === 'protocol' ? 'protocol' : 'headless_click',
    performance_profile: form.performance_profile === 'throughput' ? 'throughput' : 'safe',
    headless: form.visible !== true,
    humanize: form.humanize !== false,
    attempts: Math.max(1, Math.min(3, Number.parseInt(form.attempts, 10) || 3)),
    email_timeout_ms: Math.max(10000, Math.min(1800000, (Number(form.email_timeout_seconds) || 300) * 1000)),
    ...(form.channel ? { channel: form.channel } : {}),
    ...(form.proxy_country ? { proxy_country: form.proxy_country } : {}),
  };
}

export const DEFAULT_RT_PROXY_COUNTRY = 'GB';
export const DEFAULT_RT_PHONE_COUNTRY = 'CL';

export function accountRtPayload(form = {}, ids = [], maxConcurrency = 1) {
  const proxyCountry = String(form.proxy_country || DEFAULT_RT_PROXY_COUNTRY).trim().toUpperCase() || DEFAULT_RT_PROXY_COUNTRY;
  const proxyGroup = String(form.proxy_group || `__auto__:${proxyCountry}`);
  return {
    ids: [...ids],
    concurrency: Math.max(1, Math.min(
      Number.parseInt(form.concurrency, 10) || 5,
      Math.max(1, Number.parseInt(maxConcurrency, 10) || 1),
    )),
    proxy_group: proxyGroup,
    proxy_country: proxyCountry,
    dynamic_proxy: proxyGroup.startsWith('__auto__:'),
    phone_country: String(form.phone_country || DEFAULT_RT_PHONE_COUNTRY).trim().toUpperCase() || DEFAULT_RT_PHONE_COUNTRY,
    phone_max_price: form.phone_max_price ? Number(form.phone_max_price) : undefined,
    headless: form.visible !== true,
    performance_profile: form.performance_profile === 'throughput' ? 'throughput' : 'safe',
    ...(form.force === true ? { force: true } : {}),
  };
}
