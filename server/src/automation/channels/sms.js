'use strict';

const { SmsBowerClient, resolveSmsCountry, resolveSmsService } = require('../../utils/smsbower');

const text = value => String(value ?? '').trim();

function createHandlerPhoneChannel(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let client = null;
  let activation = null;
  let settlement = 'open';

  const guardedFetch = options.guard
    ? (url, requestOptions = {}) => options.guard.request(
        url, requestOptions, () => fetchImpl(url, requestOptions), { cancelled: options.cancelled }
      )
    : fetchImpl;
  const makeClient = cancelled => new SmsBowerClient({
    apiKey: text(options.apiKey || options.api_key),
    apiUrl: text(options.apiUrl || options.api_url),
    country: resolveSmsCountry(options.country || options.phone_country, 'GB'),
    service: resolveSmsService(options.service || options.product, 'dr'),
    maxPrice: options.maxPrice ?? options.max_price,
    timeoutSeconds: Math.max(30, Number(options.timeoutSeconds || options.timeout_seconds) || 300),
    pollInterval: Math.max(1, Number(options.pollInterval || options.poll_interval) || 3),
    fetchImpl: guardedFetch,
    cancelled,
  });

  const lifecycle = async (status, signal) => {
    if (!client || !activation) return false;
    let payload;
    try {
      payload = await client.request('setStatus', { id: activation.activationId, status }, { signal });
    } catch (cause) {
      const code = status === 6 ? 'SMS_ORDER_FINISH_FAILED' : 'SMS_ORDER_CANCEL_FAILED';
      throw Object.assign(new Error(status === 6 ? '手机号订单结算失败' : '手机号订单取消失败'), { code, cause });
    }
    const value = text(payload?.status || payload?.message || payload);
    if (!/^(?:ACCESS_|OK|SUCCESS)/i.test(value)) {
      const code = status === 6 ? 'SMS_ORDER_FINISH_FAILED' : 'SMS_ORDER_CANCEL_FAILED';
      throw Object.assign(new Error(`${status === 6 ? '手机号订单结算' : '手机号订单取消'}失败：${value || 'UNKNOWN'}`), { code });
    }
    return true;
  };

  return {
    get activation() { return activation; },
    restoreActivation(value) {
      activation = value;
      client = makeClient(() => options.cancelled?.());
      settlement = 'open';
    },
    async acquire(_session, meta = {}) {
      if (activation) return activation.phone;
      client = makeClient(() => options.cancelled?.() || meta.cancelled?.());
      activation = await client.reserveMatchingNumber();
      await options.onActivation?.(activation);
      const digits = text(activation.phone).replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        const bad = activation;
        activation = null;
        await client.request('setStatus', { id: bad.activationId, status: 8 }).catch(() => {});
        throw Object.assign(new Error('接码平台返回的手机号格式无效'), { code: 'SMS_PHONE_INVALID' });
      }
      log(`已获取 ${text(options.provider || 'SMS')} 手机号 ${digits.slice(0, 2)}******${digits.slice(-2)}`, 'info');
      return `+${digits}`;
    },
    async code() {
      if (!client || !activation) throw new Error('尚未获取手机号');
      return client.waitForCode();
    },
    async finish(_session, meta = {}) {
      if (settlement === 'finished') return true;
      if (settlement === 'cancelled') return false;
      const result = await lifecycle(6, meta.signal);
      settlement = 'finished';
      activation = null;
      client = null;
      return result;
    },
    async cancel(_session, meta = {}) {
      if (!activation || settlement === 'finished' || settlement === 'cancelled') return false;
      const current = activation;
      try {
        const result = await lifecycle(8, meta.signal);
        settlement = 'cancelled';
        activation = null;
        client = null;
        return result;
      } catch (error) {
        if (/EARLY_CANCEL_DENIED|first 2 minutes/i.test(`${error.message} ${error.cause?.message || ''}`)) {
          log(`手机号订单 ${String(current.activationId).slice(-6)} 处于不可取消窗口，交由供应商过期`, 'warning');
          settlement = 'cancel_pending';
          const timer = setTimeout(() => {
            settlement = 'open';
            lifecycle(8).then(() => {
              settlement = 'cancelled';
              activation = null;
              client = null;
            }).catch(() => {});
          }, 121000);
          timer.unref?.();
          return false;
        }
        throw error;
      }
    },
  };
}

module.exports = { createHandlerPhoneChannel };
