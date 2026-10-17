'use strict';

const DEFAULTS = Object.freeze({
  requestsPerSecond: 12,
  maxRequestConcurrency: 16,
  maxActiveActivations: 20,
  maxTransientRetries: 2,
  transientRetryBaseMs: 500,
  banCooldownMs: 30 * 60 * 1000,
  rateCooldownMs: 12 * 1000,
});
const TRANSIENT = new Set(['REQUEST_TIMEOUT', 'REQUEST_FAILED', 'RESPONSE_READ_FAILED', 'PROXY_TUNNEL_TIMEOUT', 'PROXY_UNREACHABLE']);
const waitDefault = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const clamp = (value, min, max, fallback) => Number.isFinite(Number(value))
  ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;

class PermitPool {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire(cancelled) {
    if (cancelled?.()) return Promise.reject(Object.assign(new Error('任务已取消'), { code: 'JOB_CANCELLED' }));
    if (this.active < this.limit) { this.active += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => this.queue.push({ resolve, reject, cancelled }));
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length && this.active < this.limit) {
      const next = this.queue.shift();
      if (next.cancelled?.()) {
        next.reject(Object.assign(new Error('任务已取消'), { code: 'JOB_CANCELLED' }));
        continue;
      }
      this.active += 1;
      next.resolve();
    }
  }
  stats() { return { limit: this.limit, active: this.active, queued: this.queue.length }; }
}

function isHeroSmsRequest(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return host === 'hero-sms.com' || host.endsWith('.hero-sms.com');
  } catch { return false; }
}

function restriction(response, url) {
  const raw = JSON.stringify(response?.data || response?.text || '').toUpperCase();
  const email = /\/api\/v1\/emails/.test(String(url));
  if (email && /BANNED_EMAIL_ACTIVATIONS/.test(raw)) return { type: 'email', code: 'HEROSMS_EMAIL_BANNED' };
  if (/BANNED/.test(raw) && !/BANNED_EMAIL_ACTIVATIONS/.test(raw)) return { type: 'account', code: 'HEROSMS_ACCOUNT_BANNED' };
  if (Number(response?.status) === 429 || /RATE.?LIMIT|TOO_MANY_REQUESTS|RPS_LIMIT/.test(raw)) {
    return { type: 'rate', code: 'HEROSMS_RATE_LIMITED' };
  }
  return null;
}

function paidRequest(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  try {
    const parsed = new URL(String(url));
    if (method === 'POST' && (/\/api\/v1\/emails(?:\/batch)?$/.test(parsed.pathname) || /\/reorder$/.test(parsed.pathname))) return true;
    return /handler_api\.php$/i.test(parsed.pathname) && /^getNumber(?:V2)?$/i.test(parsed.searchParams.get('action') || '');
  } catch { return false; }
}

function retrySafe(url, options = {}) {
  if (paidRequest(url, options)) return false;
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) return false;
  try {
    const parsed = new URL(String(url));
    if (!/handler_api\.php$/i.test(parsed.pathname)) return true;
    return /^(?:getStatus|getBalance|getPrices(?:V[23])?|getCountries|getServices(?:List)?)$/i.test(parsed.searchParams.get('action') || '');
  } catch { return false; }
}

class HeroSmsGuard {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.wait = options.wait || waitDefault;
    this.random = options.random || Math.random;
    this.log = options.log || (() => {});
    this.rps = clamp(options.requestsPerSecond, 1, 30, DEFAULTS.requestsPerSecond);
    this.retries = clamp(options.maxTransientRetries, 0, 3, DEFAULTS.maxTransientRetries);
    this.retryBase = clamp(options.transientRetryBaseMs, 100, 5000, DEFAULTS.transientRetryBaseMs);
    this.banCooldownMs = clamp(options.banCooldownMs, 60000, 6 * 60 * 60 * 1000, DEFAULTS.banCooldownMs);
    this.rateCooldownMs = clamp(options.rateCooldownMs, 10000, 5 * 60 * 1000, DEFAULTS.rateCooldownMs);
    this.activationLimit = clamp(options.maxActiveActivations, 1, 50, DEFAULTS.maxActiveActivations);
    this.requestPool = new PermitPool(clamp(options.maxRequestConcurrency, 1, 32, DEFAULTS.maxRequestConcurrency));
    this.activationPool = new PermitPool(this.activationLimit);
    this.nextAt = 0;
    this.rateUntil = 0;
    this.emailUntil = 0;
    this.accountUntil = 0;
  }
  async request(url, options, send, control = {}) {
    if (!isHeroSmsRequest(url)) return send();
    const purchase = paidRequest(url, options);
    const emailPurchase = purchase && /\/api\/v1\/emails/.test(String(url));
    const blocked = () => Math.max(this.rateUntil, purchase ? this.accountUntil : 0, emailPurchase ? this.emailUntil : 0);
    let failures = 0;
    while (true) {
      const until = blocked();
      if (until > this.now()) {
        const code = this.accountUntil === until ? 'HEROSMS_ACCOUNT_BANNED'
          : this.emailUntil === until ? 'HEROSMS_EMAIL_BANNED' : '';
        if (code) throw Object.assign(new Error(`HeroSMS 冷却中`), { code, retryAfterMs: until - this.now() });
        await this.wait(until - this.now());
      }
      await this.requestPool.acquire(control.cancelled);
      try {
        const at = Math.max(this.now(), this.nextAt);
        this.nextAt = at + (1000 / this.rps) + Math.floor(this.random() * 25);
        if (at > this.now()) await this.wait(at - this.now());
        try {
          const response = await send();
          const found = restriction(response, url);
          if (found) {
            const delay = found.type === 'rate' ? this.rateCooldownMs : this.banCooldownMs;
            if (found.type === 'rate') this.rateUntil = Math.max(this.rateUntil, this.now() + delay);
            if (found.type === 'email') this.emailUntil = Math.max(this.emailUntil, this.now() + delay);
            if (found.type === 'account') this.accountUntil = Math.max(this.accountUntil, this.now() + delay);
          }
          if (retrySafe(url, options) && response?.status >= 500 && failures < this.retries) {
            throw Object.assign(new Error(`HeroSMS HTTP ${response.status}`), { code: `HTTP_${response.status}`, retryable: true });
          }
          return response;
        } catch (error) {
          if (!retrySafe(url, options) || failures >= this.retries
            || (!TRANSIENT.has(String(error?.code || '')) && error?.retryable !== true)) throw error;
          failures += 1;
          const delay = Math.min(10000, this.retryBase * (2 ** (failures - 1)) + Math.floor(this.random() * this.retryBase));
          this.log(`HeroSMS 请求异常 ${error.code || 'REQUEST_FAILED'}，${delay}ms 后重试 ${failures}/${this.retries}`, 'warning');
          await this.wait(delay);
        }
      } finally { this.requestPool.release(); }
    }
  }
  async acquireActivation(control = {}) {
    await this.activationPool.acquire(control.cancelled);
    let released = false;
    return { release: () => { if (!released) { released = true; this.activationPool.release(); } } };
  }
  info() {
    return {
      request_rps: this.rps,
      requests: this.requestPool.stats(),
      activations: this.activationPool.stats(),
      email_blocked_until: this.emailUntil > this.now() ? new Date(this.emailUntil).toISOString() : '',
      account_blocked_until: this.accountUntil > this.now() ? new Date(this.accountUntil).toISOString() : '',
      rate_blocked_until: this.rateUntil > this.now() ? new Date(this.rateUntil).toISOString() : '',
    };
  }
}

const globalHeroSmsGuard = new HeroSmsGuard();

module.exports = { DEFAULTS, HeroSmsGuard, globalHeroSmsGuard, isHeroSmsRequest, restriction };
