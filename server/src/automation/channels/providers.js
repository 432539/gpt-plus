'use strict';

const { createHandlerPhoneChannel } = require('./sms');
const { SmsbowerMailChannel, HeroSmsMailChannel } = require('./paid-mail');
const { ImportedMailChannel, CfWorkerMailChannel, parseImportedMailboxList } = require('./mail');
const { MailcomClient } = require('../../utils/mailcom');
const { createMemorySessionStore } = require('../../utils/mailcomSession');
const { extractVerification } = require('../flows/mailbox');
const { globalHeroSmsGuard } = require('../lib/herosms-guard');

const text = value => String(value ?? '').trim();
const providerName = value => {
  const name = text(value).toLowerCase().replace(/[_\s]+/g, '-');
  if (['hero', 'hero-sms', 'herosms'].includes(name)) return 'herosms';
  if (['sms-bower', 'smsbower'].includes(name)) return 'smsbower';
  if (['cf-worker', 'cfworker', 'cf-mail'].includes(name)) return 'cfworker';
  if (['mix', 'mail-mix', 'mailcom-cf', 'mail-cf'].includes(name)) return 'mix';
  if (['url', 'imap', 'import', 'imported'].includes(name)) return 'imported';
  if (['mail-pit', 'mailpit'].includes(name)) return 'mailpit';
  return name || 'mailcom';
};
const SAFE_HERO_DOMAINS = Object.freeze(['outlook.com', 'hotmail.com', 'yandex.com', 'icloud.com']);
const IDP_FORCED_MAIL_REASON = 'Google 邮箱通常会被强制走第三方登录，不能用于密码注册';
const blockedDomain = value => /^(?:gmail|googlemail)\.com$/i.test(String(value || '').trim());
const PHONE_COUNTRY_FALLBACK = Object.freeze([
  { value: 'JP', iso: 'JP', label: '日本', chn: '日本', eng: 'Japan', dial_code: '+81' },
  { value: 'US', iso: 'US', label: '美国', chn: '美国', eng: 'United States', dial_code: '+1' },
  { value: 'BR', iso: 'BR', label: '巴西', chn: '巴西', eng: 'Brazil', dial_code: '+55' },
  { value: 'GB', iso: 'GB', label: '英国', chn: '英国', eng: 'United Kingdom', dial_code: '+44' },
  { value: 'CL', iso: 'CL', label: '智利', chn: '智利', eng: 'Chile', dial_code: '+56' },
]);

async function controlledFetch(fetchImpl, url, options = {}, timeoutMs = 10000) {
  const limit = Math.max(100, Math.min(30000, Number(timeoutMs) || 10000));
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(`供应商请求超时 ${limit}ms`), { code: 'VENDOR_REQUEST_TIMEOUT' }));
    }, limit);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: options.signal || controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getSmsPhoneCountries(settings = {}, dependencies = {}) {
  const sms = settings.sms || {};
  const bower = settings.smsbower || {};
  let provider = providerName(dependencies.provider || sms.phone_provider || sms.provider || 'auto');
  if (provider === 'auto') provider = bower.api_key ? 'smsbower' : 'herosms';
  const config = provider === 'smsbower' ? bower : { ...sms, ...(settings.herosms || {}) };
  const base = {
    ok: true, provider, source: 'fallback',
    countries: [...PHONE_COUNTRY_FALLBACK], items: [...PHONE_COUNTRY_FALLBACK],
    default_country: 'JP', count: PHONE_COUNTRY_FALLBACK.length, warning: '',
  };
  const apiKey = text(config.api_key || sms.api_key);
  if (!apiKey) return { ...base, warning: `请先配置 ${provider === 'smsbower' ? 'SMSBower' : 'HeroSMS'} API Key；当前显示离线回退国家` };
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  try {
    const apiUrl = text(config.api_url || (provider === 'smsbower'
      ? 'https://smsbower.app/stubs/handler_api.php'
      : 'https://hero-sms.com/stubs/handler_api.php'));
    const url = new URL(apiUrl);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('action', 'getCountries');
    const response = await controlledFetch(fetchImpl, url, { headers: { accept: 'application/json' } }, dependencies.timeoutMs);
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
    const data = await response.json();
    const raw = Array.isArray(data) ? data : data.countries || data.data || [];
    const countries = raw.map((item, index) => {
      const iso = text(item.iso || item.iso2 || item.code || item.shortName).toUpperCase();
      const value = iso || text(item.id ?? index);
      return {
        id: item.id ?? value, value, iso,
        label: text(item.chn || item.rus || item.name || item.eng || value),
        chn: text(item.chn || item.name),
        eng: text(item.eng || item.name),
        dial_code: text(item.dial_code || item.dialCode || item.prefix),
      };
    }).filter(item => item.value);
    if (!countries.length) throw new Error('供应商未返回国家');
    const preferred = countries.find(item => item.iso === 'JP' || item.value === 'JP')?.value || countries[0].value;
    return {
      ...base, source: provider, countries, items: countries,
      default_country: preferred, count: countries.length,
    };
  } catch (error) {
    return { ...base, warning: `供应商国家列表读取失败：${String(error?.message || error).slice(0, 160)}；已显示离线回退国家` };
  }
}

async function getSmsMailOptions(settings = {}, body = {}, dependencies = {}) {
  const provider = providerName(body.provider || body.mail_provider || settings.registration?.mail_provider || 'herosms');
  const hero = settings.herosms || {};
  const bower = settings.smsbower || {};
  const cf = settings.cfworker_mail || {};
  const legacy = settings.sms || {};
  const providers = [
    { id: 'herosms', label: 'HeroSMS', recommended: true, configured: Boolean(hero.api_key || legacy.api_key), note: '支持非 Google 域名邮箱' },
    { id: 'smsbower', label: 'SMSBower', recommended: false, configured: Boolean(bower.api_key), note: '库存可能仅含 Google 邮箱' },
    { id: 'cfworker', label: 'CF Worker 域名邮箱', recommended: false, configured: Boolean(cf.api_key), note: '使用自建域名邮箱' },
  ];
  const current = providers.find(item => item.id === provider);
  const site = provider === 'herosms' ? hero.site || 'openai.com'
    : provider === 'smsbower' ? bower.service || 'openai' : '';
  const base = {
    ok: true, provider, providers, blocked_reason: IDP_FORCED_MAIL_REASON,
    site, domains: [], blocked: [], default_domain: '', warning: '',
  };
  if (!current) return { ...base, ok: false, warning: `不支持的邮箱供应商：${provider}` };
  if (!current.configured) return {
    ...base,
    warning: `请先在系统设置里填写 ${current.label} API Key`,
  };
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const saved = text(provider === 'herosms' ? hero.domain : provider === 'smsbower' ? bower.domain : cf.domain).toLowerCase();
  const normalize = raw => {
    const items = (Array.isArray(raw) ? raw : []).map(item => typeof item === 'string' ? { name: item } : item)
      .map(item => ({
        name: text(item.name || item.domain).toLowerCase(),
        cost: Number(item.cost ?? item.price) || 0,
        count: Number(item.count ?? item.stock ?? item.quantity) || 0,
      })).filter(item => item.name);
    return {
      domains: items.filter(item => !blockedDomain(item.name)),
      blocked: items.filter(item => blockedDomain(item.name)),
    };
  };
  try {
    let response;
    if (provider === 'herosms') {
      const url = new URL('/api/v1/emails/domains', hero.api_url || 'https://hero-sms.com');
      url.searchParams.set('site', site);
      response = await controlledFetch(fetchImpl, url, {
        headers: { accept: 'application/json', authorization: `ApiKey ${hero.api_key || legacy.api_key}` },
      }, dependencies.timeoutMs);
    } else if (provider === 'smsbower') {
      const url = new URL('/api/mail/getDomains', bower.api_url || 'https://smsbower.app');
      url.searchParams.set('api_key', bower.api_key);
      url.searchParams.set('service', site);
      response = await controlledFetch(fetchImpl, url, { headers: { accept: 'application/json' } }, dependencies.timeoutMs);
    } else {
      response = await controlledFetch(fetchImpl, `${String(cf.api_url || '').replace(/\/$/, '')}/api/config`, {
        headers: { accept: 'application/json', authorization: `Bearer ${cf.api_key}` },
      }, dependencies.timeoutMs);
    }
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
    const data = await response.json();
    const raw = provider === 'cfworker'
      ? data.emailDomains || data.domains || []
      : data.data || data.domains || data.items || [];
    const partitioned = normalize(raw);
    const domains = provider === 'cfworker'
      ? partitioned.domains.map(item => ({ ...item, owned: true }))
      : partitioned.domains;
    const defaultDomain = domains.find(item => item.name === saved)?.name || domains[0]?.name || '';
    return {
      ...base, domains, blocked: partitioned.blocked, default_domain: defaultDomain,
      warning: domains.length ? '' : `${current.label} 当前没有可用于密码注册的域名`,
    };
  } catch (error) {
    const names = provider === 'herosms' ? SAFE_HERO_DOMAINS
      : provider === 'cfworker' && cf.domain ? [cf.domain] : [];
    const domains = names.map(name => ({ name, cost: 0, count: 0, fallback: true }));
    return {
      ...base, domains, default_domain: domains.find(item => item.name === saved)?.name || domains[0]?.name || '',
      warning: `${current.label} 域名库存读取失败：${String(error?.message || error).slice(0, 160)}${domains.length ? '；已使用安全回退列表' : ''}`,
    };
  }
}

function mailcomWait(entry, dependencies = {}) {
  let client = null;
  return async (session, account, _settings, options = {}) => {
    client ||= new MailcomClient(
      entry.mailboxEmail || entry.email,
      entry.password,
      '',
      { sessionStore: createMemorySessionStore(), ...(dependencies.fetchImpl ? { fetch: dependencies.fetchImpl } : {}) },
    );
    const deadline = Date.now() + Math.max(10000, Number(options.timeoutMs) || 300000);
    while (Date.now() < deadline) {
      if (options.cancelled?.()) throw Object.assign(new Error('mail.com 取码已取消'), { code: 'JOB_CANCELLED' });
      const rows = await client.queryInbox(50);
      for (const row of rows) {
        const recipients = JSON.stringify(row.to || '').toLowerCase();
        if (recipients && !recipients.includes(String(account.email || entry.email).toLowerCase())) continue;
        const body = await client.getBody(row.id);
        const hit = extractVerification([{ subject: row.subject || '', text: body, html: body }]);
        if (hit.code || hit.url) return { ...hit, email: account.email || entry.email };
      }
      await (session?.wait ? session.wait(3000) : new Promise(resolve => setTimeout(resolve, 3000)));
    }
    throw Object.assign(new Error('等待导入 mail.com 验证码超时'), { code: 'IMPORTED_MAIL_CODE_TIMEOUT' });
  };
}

function createMailChannel(providerValue, settings = {}, body = {}, dependencies = {}) {
  const provider = providerName(providerValue);
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (provider === 'mailcom') return null;
  if (provider === 'mailpit') {
    const { allocateMailpitAddresses, mailpitReady, waitMailpitOtp } = require('../../utils/mailpit');
    if (!mailpitReady(settings)) {
      throw Object.assign(new Error('请先配置 Mailpit 收信域名和管理接口账号'), {
        status: 400, code: 'MAILPIT_NOT_CONFIGURED',
      });
    }
    const preset = text(body.entry?.email || body.email);
    return {
      email: preset,
      async acquire() {
        const address = preset || allocateMailpitAddresses(settings, 1, body.mail_domain)[0].address;
        this.email = address;
        return { email: address, id: `mailpit:${address}`, provider: 'mailpit' };
      },
      async wait(_session, account, _settings, options = {}) {
        return waitMailpitOtp(settings, account?.email || this.email, options);
      },
      async finish() { return true; },
      async cancel() { return true; },
    };
  }
  if (provider === 'imported') {
    const entry = body.entry;
    if (!entry) throw Object.assign(new Error('导入邮箱条目缺失'), { status: 400, code: 'IMPORTED_MAIL_REQUIRED' });
    return new ImportedMailChannel(entry, {
      fetchImpl,
      imapFactory: dependencies.imapFactory,
      allowUnsafeUrl: settings.imported_mail?.allow_unsafe_url === true,
      localWait: entry.kind === 'mailcom' ? mailcomWait(entry, dependencies) : null,
    });
  }
  if (provider === 'cfworker') {
    const cfg = settings.cfworker_mail || settings.cfworker || {};
    const { pickCfMailDomain } = require('../../utils/cfMail');
    return new CfWorkerMailChannel({
      apiUrl: body.mail_api_url || cfg.api_url,
      apiKey: cfg.api_key || cfg.admin_token,
      domain: body.mail_domain || pickCfMailDomain(settings, cfg.domain),
      fetchImpl,
    });
  }
  if (provider === 'smsbower') {
    const cfg = settings.smsbower_mail || settings.smsbower || {};
    const legacy = settings.sms || {};
    return new SmsbowerMailChannel({
      apiUrl: cfg.api_url || legacy.api_url, apiKey: cfg.api_key || legacy.api_key,
      service: body.mail_service || cfg.service || 'openai',
      domain: body.mail_domain || cfg.domain,
      maxPrice: body.mail_max_price ?? cfg.max_price,
      fetchImpl,
    });
  }
  if (provider === 'herosms') {
    const cfg = settings.herosms_mail || settings.herosms || {};
    const legacy = settings.sms || {};
    return new HeroSmsMailChannel({
      apiUrl: cfg.api_url || 'https://hero-sms.com', apiKey: cfg.api_key || legacy.api_key,
      site: body.mail_site || cfg.site || 'openai.com',
      domain: body.mail_domain || cfg.domain || 'outlook.com',
      maxReorders: cfg.max_reorders,
      acquireAttempts: cfg.acquire_attempts,
      guard: dependencies.heroSmsGuard || globalHeroSmsGuard,
      cancelled: dependencies.cancelled,
      fetchImpl,
    });
  }
  throw Object.assign(new Error(`不支持的邮箱供应商：${provider}`), { status: 400, code: 'MAIL_PROVIDER_NOT_SUPPORTED' });
}

function createPhoneChannel(providerValue, settings = {}, body = {}, dependencies = {}) {
  let provider = providerName(providerValue || settings.sms?.phone_provider || settings.sms?.provider);
  if (provider === 'auto') {
    provider = settings.herosms_phone?.api_key || settings.herosms?.api_key || settings.sms?.api_key
      ? 'herosms'
      : settings.smsbower_phone?.api_key || settings.smsbower?.api_key ? 'smsbower' : 'herosms';
  }
  if (!providerValue && body.get_refresh_token !== true && body.durable_credentials !== true) return null;
  if (!['herosms', 'smsbower'].includes(provider)) {
    throw Object.assign(new Error(`不支持的手机号供应商：${provider}`), { status: 400, code: 'PHONE_PROVIDER_NOT_SUPPORTED' });
  }
  const specific = provider === 'smsbower' ? settings.smsbower_phone || settings.smsbower : settings.herosms_phone || settings.herosms;
  const legacy = settings.sms || {};
  const cfg = specific || {};
  if (!text(cfg.api_key || legacy.api_key)) {
    throw Object.assign(new Error(`手机号供应商 ${provider} 未配置 API Key`), {
      status: 400,
      code: 'PHONE_PROVIDER_NOT_CONFIGURED',
    });
  }
  return createHandlerPhoneChannel({
    provider,
    apiUrl: cfg.api_url || legacy.api_url,
    apiKey: cfg.api_key || legacy.api_key,
    country: body.phone_country || cfg.country || legacy.country,
    service: body.phone_service || cfg.service || cfg.product || legacy.service || legacy.product || 'dr',
    maxPrice: body.phone_max_price ?? cfg.max_price ?? legacy.max_price,
    timeoutSeconds: cfg.timeout_seconds || legacy.timeout_seconds,
    pollInterval: cfg.poll_interval || legacy.poll_interval,
    fetchImpl: dependencies.fetchImpl,
    cancelled: dependencies.cancelled,
    log: dependencies.log,
    guard: provider === 'herosms' ? (dependencies.heroSmsGuard || globalHeroSmsGuard) : null,
    onActivation: dependencies.onActivation,
  });
}

async function settleChannel(channel, success, session = null, meta = {}) {
  if (!channel) return false;
  return success ? channel.finish?.(session, meta) : channel.cancel?.(session, meta);
}

module.exports = {
  createMailChannel, createPhoneChannel, mailcomWait, parseImportedMailboxList,
  providerName, settleChannel, getSmsMailOptions, getSmsPhoneCountries, controlledFetch,
  PHONE_COUNTRY_FALLBACK,
};
