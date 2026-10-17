const crypto = require('crypto');
const { fetch: undiciFetch } = require('undici');
const { createProxyDispatcher } = require('./mailcomProxy');

const CHECK_URL = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function requestAccountCheck(accessToken, { proxy, fetchImpl, timeoutMs = 30000 } = {}) {
  const token = String(accessToken || '').trim();
  if (!token) return { ok: false, status: 0, text: 'missing access token', data: null };
  const dispatcher = proxy ? createProxyDispatcher(proxy) : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 30000));
  const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : undiciFetch;
  try {
    const res = await fetchFn(CHECK_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OAI-Language': 'en-US',
        'OAI-Device-Id': crypto.randomUUID(),
        Origin: 'https://chatgpt.com',
        Referer: 'https://chatgpt.com/',
        'User-Agent': USER_AGENT,
      },
      dispatcher,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    const status = Number(res.status) || 0;
    return { ok: status >= 200 && status < 300, status, text, data };
  } catch (error) {
    return { ok: false, status: 0, text: String(error?.message || error), data: null };
  } finally {
    clearTimeout(timer);
    if (dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close().catch(() => {});
    }
  }
}

module.exports = { requestAccountCheck, CHECK_URL };
