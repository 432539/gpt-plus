const DEFAULT_API_URL = 'https://smsbower.app/stubs/handler_api.php';

const COUNTRY_IDS = Object.freeze({
  PH: 4,
  ID: 6,
  GB: 16,
  UK: 16,
  CA: 36,
  DE: 43,
  NL: 48,
  TH: 52,
  MX: 54,
  TW: 55,
  BR: 73,
  IT: 86,
  AE: 95,
  PT: 117,
  AU: 175,
  JP: 182,
  US: 187,
  CL: 151,
});

const API_ERRORS = Object.freeze({
  NO_NUMBERS: '当前国家/服务/价格没有可用号码',
  NO_BALANCE: '账户余额不足',
  BAD_KEY: 'API Key 无效',
  BAD_SERVICE: '服务代码不正确',
  BAD_ACTION: '接口动作不正确',
  WRONG_MAX_PRICE: '指定价格参数不正确',
  MAX_PRICE_EXCEEDED: '当前号码价格超过指定上限',
});

class SmsBowerError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SmsBowerError';
    Object.assign(this, extra);
  }
}

class SmsBowerPriceMismatch extends SmsBowerError {
  constructor(message) {
    super(message);
    this.name = 'SmsBowerPriceMismatch';
  }
}

class SmsBowerNoNumbers extends SmsBowerError {
  constructor(message) {
    super(message);
    this.name = 'SmsBowerNoNumbers';
  }
}

function sleep(ms, cancelled) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(watch);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const watch = setInterval(() => {
      if (typeof cancelled !== 'function' || !cancelled()) return;
      clearTimeout(timer);
      clearInterval(watch);
      reject(new SmsBowerError('接码任务已停止', { code: 'JOB_CANCELLED' }));
    }, 200);
    timer.unref?.();
    watch.unref?.();
  });
}

function apiError(value) {
  const code = String(value || '').split(':', 1)[0].trim().toUpperCase();
  return new SmsBowerError(`SMSBower：${API_ERRORS[code] || code || '请求失败'}`, { smsCode: code });
}

function formatPrice(value) {
  return String(Number(value).toFixed(4)).replace(/\.?0+$/, '');
}

class SmsBowerClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.country = String(options.country || '').trim().toUpperCase();
    this.service = String(options.service || 'ts').trim();
    this.maxPrice = options.maxPrice == null ? null : Number(options.maxPrice);
    this.exactPrice = options.exactPrice == null ? null : Number(options.exactPrice);
    this.exactPriceAttempts = Math.max(1, Math.min(Number(options.exactPriceAttempts) || 150, 600));
    this.exactRetryInterval = Math.max(0.01, Number(options.exactRetryInterval) || 2);
    this.apiUrl = String(options.apiUrl || DEFAULT_API_URL).trim();
    this.pollInterval = Math.max(1, Number(options.pollInterval) || 5);
    this.timeoutSeconds = Math.max(30, Number(options.timeoutSeconds) || 300);
    this.cancelled = typeof options.cancelled === 'function' ? options.cancelled : () => false;
    this.statusCallback = typeof options.statusCallback === 'function' ? options.statusCallback : null;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.activation = null;
    this.finalized = false;

    if (!this.apiKey) throw new SmsBowerError('SMSBower API Key 不能为空', { status: 400, code: 'SMS_KEY_MISSING' });
    if (!COUNTRY_IDS[this.country]) throw new SmsBowerError(`SMSBower 暂未配置 ${this.country} 的国家编号`, { status: 400 });
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(this.service)) throw new SmsBowerError('SMSBower 服务代码格式不正确', { status: 400 });
    if (!this.apiUrl.startsWith('https://')) throw new SmsBowerError('SMSBower API 地址必须使用 HTTPS', { status: 400 });
    if (typeof this.fetchImpl !== 'function') throw new SmsBowerError('SMSBower 缺少 HTTP 实现');
  }

  notify(message) {
    this.statusCallback?.(message);
  }

  checkCancelled() {
    if (this.cancelled()) throw new SmsBowerError('接码任务已停止', { code: 'JOB_CANCELLED' });
  }

  async request(action, params = {}, options = {}) {
    this.checkCancelled();
    const url = new URL(this.apiUrl);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET', redirect: 'follow', signal: options.signal,
      });
    } catch (error) {
      throw new SmsBowerError(`SMSBower 连接失败：${error?.name || 'Error'}`, { code: 'SMS_TRANSPORT' });
    }
    const body = String(await response.text()).trim();
    if (response.status === 401 || response.status === 403) {
      throw new SmsBowerError('SMSBower API Key 无效或没有接口权限', { status: response.status });
    }
    if (response.status >= 400) {
      throw new SmsBowerError(`SMSBower 接口返回 HTTP ${response.status}`, { status: response.status });
    }
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('json') || body.startsWith('{')) {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        throw new SmsBowerError('SMSBower 返回了无效 JSON');
      }
      if (payload && typeof payload === 'object' && (payload.status === 0 || payload.status === false)) {
        throw new SmsBowerError(`SMSBower：${payload.message || '请求失败'}`);
      }
      return payload;
    }
    return body;
  }

  parseActivation(payload) {
    let activationId = '';
    let phone = '';
    let price = null;
    if (payload && typeof payload === 'object') {
      const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
      activationId = String(data.activationId || data.activation_id || data.id || '');
      phone = String(data.phoneNumber || data.phone || data.number || '');
      const rawPrice = data.activationCost ?? data.price;
      const parsed = Number(rawPrice);
      price = Number.isFinite(parsed) ? parsed : null;
    } else if (typeof payload === 'string' && payload.startsWith('ACCESS_NUMBER:')) {
      const parts = payload.split(':');
      if (parts.length >= 3) {
        activationId = parts[1];
        phone = parts.slice(2).join(':');
        if (this.exactPrice != null) price = this.exactPrice;
      }
    } else if (typeof payload === 'string') {
      if (payload.split(':', 1)[0].trim().toUpperCase() === 'NO_NUMBERS') {
        throw new SmsBowerNoNumbers('SMSBower has no number at the requested fixed price yet');
      }
      throw apiError(payload);
    }
    const digits = String(phone).replace(/\D/g, '');
    if (!activationId || !digits) throw new SmsBowerError('SMSBower 取号响应缺少激活编号或手机号');
    return { activationId, phone: `+${digits}`, price };
  }

  async reserveNumber() {
    const params = {
      service: this.service,
      country: COUNTRY_IDS[this.country],
    };
    let action = 'getNumberV2';
    if (this.exactPrice != null) {
      action = 'getNumber';
      params.fixPrice = formatPrice(this.exactPrice);
    } else if (this.maxPrice != null) {
      params.maxPrice = formatPrice(this.maxPrice);
    }
    const activation = this.parseActivation(await this.request(action, params));
    this.activation = activation;
    this.finalized = false;
    if (this.exactPrice != null) {
      if (activation.price == null || Math.abs(activation.price - this.exactPrice) > 1e-9) {
        const returned = activation.price == null ? 'missing' : String(activation.price);
        await this.cancelActivation();
        throw new SmsBowerPriceMismatch(
          `SMSBower returned price ${returned}; exact price ${this.exactPrice} was requested`,
        );
      }
    }
    if (this.maxPrice != null) {
      if (activation.price == null) {
        await this.cancelActivation();
        throw new SmsBowerError('SMSBower did not return an activation price; the configured price ceiling cannot be verified');
      }
      if (activation.price > this.maxPrice + 1e-9) {
        await this.cancelActivation();
        throw new SmsBowerError(
          `SMSBower activation price ${activation.price} exceeds the configured ceiling ${this.maxPrice}`,
        );
      }
    }
    this.notify('SMSBower 已分配号码，等待发送短信');
    return activation;
  }

  async reserveMatchingNumber() {
    const attempts = this.exactPrice != null ? this.exactPriceAttempts : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.reserveNumber();
      } catch (error) {
        if (!(error instanceof SmsBowerPriceMismatch || error instanceof SmsBowerNoNumbers)) throw error;
        lastError = error;
        this.activation = null;
        this.notify(`SMSBower price did not match; retrying exact-price inventory (${attempt}/${attempts})`);
        if (attempt < attempts) await sleep(this.exactRetryInterval * 1000, this.cancelled);
      }
    }
    throw new SmsBowerError(
      `SMSBower has no number at the requested exact price ${this.exactPrice} after ${attempts} attempts`,
      { cause: lastError },
    );
  }

  async rotateNumber() {
    await this.cancelActivation();
    this.activation = null;
    return this.reserveMatchingNumber();
  }

  async waitForCode(timeoutSeconds) {
    if (!this.activation) throw new SmsBowerError('SMSBower 激活记录不存在');
    const waitSeconds = timeoutSeconds == null ? this.timeoutSeconds : Math.max(1, Number(timeoutSeconds));
    const deadline = Date.now() + waitSeconds * 1000;
    this.notify('短信已发送，SMSBower 正在等待验证码');
    while (Date.now() < deadline) {
      this.checkCancelled();
      const payload = await this.request('getStatus', { id: this.activation.activationId });
      let value = '';
      if (payload && typeof payload === 'object') {
        const data = payload.data;
        if (data && typeof data === 'object') {
          const code = String(data.code || data.sms || data.otp || '').trim();
          const state = String(data.status || data.state || '').trim();
          value = code ? `STATUS_OK:${code}` : state;
        } else {
          value = String(data || payload.message || payload.status || '').trim();
        }
      } else {
        value = String(payload || '').trim();
      }
      if (value.startsWith('STATUS_OK:')) {
        const code = value.split(':', 2)[1].replace(/\D/g, '');
        if (code) {
          this.notify('SMSBower 已收到验证码，正在提交');
          return code;
        }
      }
      if (value === 'STATUS_CANCEL' || value === 'STATUS_FINISH') {
        throw new SmsBowerError('SMSBower 激活已结束，未收到验证码');
      }
      if (/^(BAD_|ERROR|NO_)/.test(value)) throw apiError(value);
      await sleep(this.pollInterval * 1000, this.cancelled);
    }
    const error = new Error('等待 SMSBower 验证码超时');
    error.name = 'TimeoutError';
    error.code = 'SMS_TIMEOUT';
    throw error;
  }

  async finishActivation() {
    if (!this.activation || this.finalized) return;
    try {
      await this.request('setStatus', { id: this.activation.activationId, status: 6 });
    } finally {
      this.finalized = true;
    }
  }

  async requestAnotherSms() {
    if (!this.activation || this.finalized) return;
    await this.request('setStatus', { id: this.activation.activationId, status: 3 });
    this.notify('验证码未通过，SMSBower 正在等待下一条短信');
  }

  async cancelActivation() {
    if (!this.activation || this.finalized) return;
    try {
      const url = new URL(this.apiUrl);
      url.searchParams.set('api_key', this.apiKey);
      url.searchParams.set('action', 'setStatus');
      url.searchParams.set('id', this.activation.activationId);
      url.searchParams.set('status', '8');
      await this.fetchImpl(url, { method: 'GET', redirect: 'follow' });
    } catch {
      /* release best-effort */
    } finally {
      this.finalized = true;
    }
  }
}

function normalizeSmsUrl(value) {
  let url = String(value || '').trim();
  if (!url) return DEFAULT_API_URL;
  url = url.replace(/\/+$/, '');
  if (/smsbower/i.test(url) && !/handler_api\.php/i.test(url)) {
    url = `${url}/stubs/handler_api.php`;
  }
  return url;
}

function resolveSmsCountry(value, fallback = 'GB') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '16' || raw === 'uk' || raw === 'gb' || raw === 'united kingdom' || raw === 'britain') return 'GB';
  if (raw === '151' || raw === 'cl' || raw === 'chile' || raw === '智利') return 'CL';
  const upper = raw.replace(/[^a-z]/g, '').toUpperCase();
  if (COUNTRY_IDS[upper]) return upper === 'UK' ? 'GB' : upper;
  return fallback;
}

function resolveSmsService(value, fallback = 'ts') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['paypal', 'ts', 'openai', 'chatgpt', 'gpt', 'plus'].includes(raw)) return 'ts';
  if (/^[a-z0-9_-]{1,8}$/.test(raw)) return raw;
  return fallback;
}

function resolveSmsbowerConfig(sms = {}, { countryFallback = 'GB', serviceFallback = 'ts' } = {}) {
  const apiKey = String(sms.api_key || sms.apiKey || '').trim();
  if (!apiKey) {
    throw Object.assign(new Error('请先在设置中配置 SMSBower API Key'), { status: 400, code: 'SMS_KEY_MISSING' });
  }
  const apiUrl = normalizeSmsUrl(sms.api_url || sms.apiUrl);
  if (!apiUrl.startsWith('https://')) {
    throw Object.assign(new Error('SMSBower API 地址必须使用 HTTPS'), { status: 400, code: 'SMS_URL_INVALID' });
  }
  return {
    apiKey,
    apiUrl,
    country: resolveSmsCountry(sms.country, countryFallback),
    service: resolveSmsService(sms.product || sms.service, serviceFallback),
    provider: String(sms.provider || 'smsbower').trim().toLowerCase() || 'smsbower',
  };
}

module.exports = {
  DEFAULT_API_URL,
  COUNTRY_IDS,
  SmsBowerError,
  SmsBowerPriceMismatch,
  SmsBowerNoNumbers,
  SmsBowerClient,
  normalizeSmsUrl,
  resolveSmsCountry,
  resolveSmsService,
  resolveSmsbowerConfig,
};
