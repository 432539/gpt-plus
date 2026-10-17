'use strict';

const { extractVerification } = require('../flows/mailbox');

const text = value => String(value ?? '').trim();
const responseData = async response => {
  if (response?.data && typeof response.data === 'object') return response.data;
  if (typeof response?.json === 'function') return response.json();
  try { return JSON.parse(String(response?.text || '')); } catch { return null; }
};
const fetchSession = fetchImpl => ({
  request: async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    let body;
    if (options.json !== undefined) {
      headers['content-type'] ||= 'application/json';
      body = JSON.stringify(options.json);
    }
    const response = await fetchImpl(url, {
      method: options.method || 'GET', headers, body, signal: options.signal,
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    return { ok: response.ok, status: response.status, text: raw, data };
  },
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
});

class ProviderMailClient {
  constructor(session, options = {}) {
    this.session = session;
    this.options = options;
  }
  async call(url, options, action) {
    const send = () => this.session.request(url, options);
    const response = this.options.guard
      ? await this.options.guard.request(url, options, send, {
          cancelled: this.options.cancelled,
        })
      : await send();
    const data = await responseData(response);
    if (!response?.ok) {
      const detail = text(data?.title || data?.details || data?.error || response?.text).slice(0, 160);
      const error = new Error(`${action} 失败 HTTP ${response?.status || 0}${detail ? `：${detail}` : ''}`);
      error.status = Number(response?.status) || 0;
      error.retryable = error.status >= 500;
      if (/EARLY_CANCEL_DENIED|first 2 minutes/i.test(detail)) error.earlyCancel = true;
      throw error;
    }
    return data || {};
  }
}

class SmsbowerMailChannel {
  constructor(options = {}) {
    this.options = options;
    this.activation = null;
    this.codesRead = 0;
    this.settlement = 'open';
  }
  get email() { return this.activation?.mail || ''; }
  get mailId() { return this.activation?.mailId || ''; }
  restoreActivation(id, email = '') {
    this.activation = { mailId: String(id), mail: String(email) };
    this.settlement = 'open';
  }
  client(session) { return new ProviderMailClient(session || fetchSession(this.options.fetchImpl || globalThis.fetch), this.options); }
  url(path, params = {}) {
    const url = new URL(path, `${text(this.options.apiUrl || this.options.api_url || 'https://smsbower.page').replace(/\/$/, '')}/`);
    url.searchParams.set('api_key', text(this.options.apiKey || this.options.api_key));
    for (const [key, value] of Object.entries(params)) if (text(value)) url.searchParams.set(key, text(value));
    return url.href;
  }
  async get(session, path, params, action) {
    return this.client(session).call(this.url(path, params), { headers: { accept: 'application/json' } }, action);
  }
  async acquire(session) {
    if (this.activation) return this.activation;
    if (!text(this.options.apiKey || this.options.api_key)) throw Object.assign(new Error('SMSBower 邮箱 API Key 未配置'), { code: 'SMSBOWER_NO_KEY' });
    const data = await this.get(session, '/api/mail/getActivation', {
      service: this.options.service || 'openai', domain: this.options.domain, maxPrice: this.options.maxPrice,
    }, 'SMSBower getActivation');
    if (!(data.status === 1 || data.status === true || /^success$/i.test(text(data.status)))) {
      throw Object.assign(new Error(`SMSBower 获取邮箱失败：${text(data.error)}`), { code: 'SMSBOWER_MAIL_FAILED' });
    }
    this.activation = { mail: text(data.mail || data.email), mailId: text(data.mailId || data.mail_id || data.id) };
    if (!this.email || !this.mailId) throw Object.assign(new Error('SMSBower 获取邮箱响应缺少地址或活动号'), { code: 'SMSBOWER_MAIL_FAILED' });
    return { email: this.email, id: this.mailId, provider: 'smsbower' };
  }
  async setStatus(session, status, signal) {
    const data = await this.client(session).call(
      this.url('/api/mail/setStatus', { id: this.mailId, status }),
      { headers: { accept: 'application/json' }, signal },
      'SMSBower setStatus'
    );
    if (!(data.status === 1 || data.status === true || /^success$/i.test(text(data.status)))) {
      throw new Error(`SMSBower 邮箱状态更新失败：${text(data.error)}`);
    }
    return true;
  }
  async wait(session, _account, _settings, options = {}) {
    if (this.codesRead) await this.setStatus(session, 5);
    const deadline = Date.now() + Math.max(10000, Number(options.timeoutMs) || 300000);
    while (Date.now() < deadline) {
      if (options.cancelled?.()) throw Object.assign(new Error('邮箱取码已取消'), { code: 'JOB_CANCELLED' });
      const data = await this.get(session, '/api/mail/getCode', { mailId: this.mailId }, 'SMSBower getCode');
      if (data.status === 1 || data.status === true) {
        const code = text(data.code || data.otp);
        if (code) { this.codesRead += 1; return { code, email: this.email }; }
      } else if (!/code has not been received yet/i.test(text(data.error))) {
        throw Object.assign(new Error(`SMSBower 邮箱取码失败：${text(data.error)}`), { code: 'SMSBOWER_MAIL_FAILED' });
      }
      await (session?.wait ? session.wait(3000) : new Promise(resolve => setTimeout(resolve, 3000)));
    }
    throw Object.assign(new Error('SMSBower 邮箱取码超时'), { code: 'SMSBOWER_CODE_TIMEOUT' });
  }
  async finish(session, meta = {}) {
    if (this.settlement === 'finished') return true;
    if (this.settlement === 'cancelled' || !this.activation) return false;
    const result = await this.setStatus(session, 3, meta.signal);
    this.settlement = 'finished';
    return result;
  }
  async cancel(session, meta = {}) {
    if (this.settlement === 'finished' || this.settlement === 'cancelled' || !this.activation) return false;
    try {
      const result = await this.setStatus(session, 2, meta.signal);
      this.settlement = 'cancelled';
      return result;
    }
    catch (cause) {
      throw Object.assign(new Error('SMSBower 邮箱活动取消失败'), { code: 'SMSBOWER_MAIL_CANCEL_FAILED', cause });
    }
  }
}

class HeroSmsMailChannel {
  constructor(options = {}) {
    this.options = options;
    this.activation = null;
    this.mailId = '';
    this.codesRead = 0;
    this.reorders = 0;
    this.settlement = 'open';
    this.activationLease = null;
    this.activationStartedAt = 0;
  }
  get email() { return this.activation?.email || ''; }
  restoreActivation(id, email = '') {
    this.mailId = String(id);
    this.activation = { id: this.mailId, email: String(email) };
    this.activationStartedAt = 0;
    this.settlement = 'open';
  }
  base(path) {
    return new URL(`/api/v1${path}`, text(this.options.apiUrl || this.options.api_url || 'https://hero-sms.com')).href;
  }
  client(session) { return new ProviderMailClient(session || fetchSession(this.options.fetchImpl || globalThis.fetch), this.options); }
  headers() {
    const key = text(this.options.apiKey || this.options.api_key);
    if (!key) throw Object.assign(new Error('HeroSMS 邮箱 API Key 未配置'), { code: 'HEROSMS_NO_KEY' });
    return { accept: 'application/json', authorization: `ApiKey ${key}` };
  }
  async acquire(session) {
    if (this.activation) return this.activation;
    this.activationLease = await this.options.guard?.acquireActivation({
      cancelled: this.options.cancelled,
    }) || { release() {} };
    try {
      let data;
      const attempts = Math.max(1, Math.min(3, Number(this.options.acquireAttempts) || 3));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          data = await this.client(session).call(this.base('/emails'), {
            method: 'POST', headers: this.headers(),
            json: { site: this.options.site || 'openai.com', domain: this.options.domain || 'outlook.com' },
          }, 'HeroSMS buyEmail');
          break;
        } catch (error) {
          if (!error.retryable || attempt >= attempts) throw error;
          await (session?.wait ? session.wait(attempt === 1 ? 500 : 1500) : new Promise(resolve => setTimeout(resolve, attempt === 1 ? 500 : 1500)));
        }
      }
      const item = Array.isArray(data.data) ? data.data[0] : data.data || data;
      this.activation = { id: text(item?.id || item?.emailId), email: text(item?.email) };
      this.mailId = this.activation.id;
      this.activationStartedAt = Date.now();
      if (!this.email || !this.mailId) throw Object.assign(new Error('HeroSMS 购买响应缺少 id/email'), { code: 'HEROSMS_MAIL_FAILED' });
      return { email: this.email, id: this.mailId, provider: 'herosms' };
    } catch (error) {
      this.activationLease?.release();
      this.activationLease = null;
      throw error;
    }
  }
  async reorder(session) {
    if (this.reorders >= Math.max(0, Number(this.options.maxReorders) || 4)) {
      throw Object.assign(new Error('HeroSMS 邮箱重新购买次数耗尽'), { code: 'HEROSMS_REORDER_EXHAUSTED' });
    }
    const data = await this.client(session).call(this.base(`/emails/${encodeURIComponent(this.mailId)}/reorder`), {
      method: 'POST', headers: this.headers(),
    }, 'HeroSMS reorderEmail');
    this.mailId = text(data?.data?.id || data?.id) || this.mailId;
    this.reorders += 1;
  }
  async wait(session, _account, _settings, options = {}) {
    if (this.codesRead) await this.reorder(session);
    const deadline = Date.now() + Math.max(10000, Number(options.timeoutMs) || 300000);
    while (Date.now() < deadline) {
      if (options.cancelled?.()) throw Object.assign(new Error('邮箱取码已取消'), { code: 'JOB_CANCELLED' });
      const data = await this.client(session).call(this.base(`/emails/${encodeURIComponent(this.mailId)}`), {
        headers: this.headers(),
      }, 'HeroSMS getEmail');
      const item = data.data || data;
      if (text(item.status).toUpperCase() === 'SUCCESS') {
        const hit = extractVerification([{ text: item.value, html: item.message }]);
        if (hit.code || hit.url) { this.codesRead += 1; return { ...hit, email: this.email }; }
        await this.reorder(session);
      } else if (text(item.status).toUpperCase() === 'CANCEL') {
        throw Object.assign(new Error('HeroSMS 邮箱活动已取消'), { code: 'HEROSMS_ACTIVATION_CANCELED' });
      }
      await (session?.wait ? session.wait(3000) : new Promise(resolve => setTimeout(resolve, 3000)));
    }
    throw Object.assign(new Error('HeroSMS 邮箱取码超时'), { code: 'HEROSMS_CODE_TIMEOUT' });
  }
  async finish() {
    if (this.settlement === 'cancelled') return false;
    this.settlement = 'finished';
    this.activationLease?.release();
    this.activationLease = null;
    return true;
  }
  async cancel(session, meta = {}) {
    if (this.settlement === 'finished' || this.settlement === 'cancelled' || !this.mailId) return false;
    try {
      await this.client(session).call(this.base(`/emails/${encodeURIComponent(this.mailId)}`), {
        method: 'DELETE', headers: this.headers(), signal: meta.signal,
      }, 'HeroSMS cancelEmail');
      this.settlement = 'cancelled';
      this.activationLease?.release();
      this.activationLease = null;
      return true;
    } catch (cause) {
      if (cause.earlyCancel) {
        this.settlement = 'cancel_pending';
        const remaining = Math.max(1000, this.activationStartedAt + 121000 - Date.now());
        const timer = setTimeout(() => {
          this.settlement = 'open';
          this.cancel(session).catch(() => {}).finally(() => {
            this.activationLease?.release();
            this.activationLease = null;
          });
        }, remaining);
        timer.unref?.();
        return false;
      }
      throw Object.assign(new Error('HeroSMS 邮箱活动取消失败'), { code: 'HEROSMS_MAIL_CANCEL_FAILED', cause });
    }
  }
}

module.exports = { SmsbowerMailChannel, HeroSmsMailChannel, fetchSession };
