'use strict';

const MAX_HOPS = 6;
const QR_POLL_ATTEMPTS = 6;
const QR_POLL_WAIT_MS = Object.freeze([1500, 2500, 4000, 6000, 8000]);
const MIN_QR_BYTES = 1500;
const MIN_QR_DIM = 80;
const QR_JSON_KEYS = new Set([
  'qrcodedata',
  'qrcodeimage',
  'qrcodeurl',
  'qr_code',
  'qrcode',
  'qr_code_data',
  'qr_code_image',
  'qrimage',
  'image_url_png',
  'image_url_svg',
  'imageurl',
  'qrurl',
]);
const PLACEHOLDER_QR_RE = /gcat_loader|(?:^|[/?#._-])(?:loader|spinner|placeholder)(?:[/?#._-]|\.|$)/i;
const DECORATIVE_ASSET_RE = /favicon|(?:^|[/?#._-])(?:logo|pixel|tracking|sprite|icon)(?:[/?#._-]|\.|$)/i;

function hostnameOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function resolveUrl(value, base) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^data:/i.test(text) || /^https?:\/\//i.test(text)) return text;
  if (!base) return text;
  try {
    return new URL(text, base).href;
  } catch {
    return text;
  }
}

function isAdyenRedirectUrl(url) {
  const text = String(url || '');
  return /checkoutPaymentRedirect/i.test(text)
    || /custom_payment_method\/start/i.test(text);
}

function isPlaceholderQrValue(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const blob = text.toLowerCase();
  if (PLACEHOLDER_QR_RE.test(blob)) return true;
  if (DECORATIVE_ASSET_RE.test(blob) && !/(?:^|[/?#._-])qr(?:code)?(?:[/?#._-]|$)/.test(blob)) return true;
  return false;
}

function isAllowedQrHost(url) {
  const host = hostnameOf(url);
  if (!host) return false;
  return host === 'adyen.com'
    || host.endsWith('.adyen.com')
    || host === 'gcash.com'
    || host.endsWith('.gcash.com');
}

function isImageUrl(url) {
  const text = String(url || '').trim();
  if (!text || isPlaceholderQrValue(text)) return false;
  if (/^data:image\//i.test(text)) return true;
  if (isAdyenRedirectUrl(text)) return false;
  if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(text)) return true;
  try {
    const parsed = new URL(text);
    const blob = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (!isAllowedQrHost(text)) return false;
    return /qr|barcode|image/.test(blob);
  } catch {
    return false;
  }
}

function isGcashShortCode(value) {
  const text = String(value || '').trim();
  return /^GCSHLNKV[A-Za-z0-9_-]{4,24}$/i.test(text);
}

function isGcashShortUrl(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text) || isAdyenRedirectUrl(text) || isPlaceholderQrValue(text)) return false;
  try {
    const host = new URL(text).hostname.toLowerCase();
    if (host === 'short.dynamic.link' || host.endsWith('.short.dynamic.link')) return true;
    if (host === 'page.link' || host.endsWith('.page.link')) return /gcash|gcshlnkv/i.test(text);
  } catch {
    return false;
  }
  return false;
}

function looksLikeQrPayload(value) {
  const text = String(value || '').trim();
  if (!text || isPlaceholderQrValue(text)) return false;
  if (/^data:image\//i.test(text)) return false;
  if (isAdyenRedirectUrl(text)) return false;
  if (isGcashShortCode(text)) return true;
  if (isGcashShortUrl(text)) return true;
  if (text.length < 16 || text.length > 4096) return false;
  if (/^000201/.test(text)) return true;
  if (/^gcash:/i.test(text)) return true;
  if (/^https?:\/\//i.test(text) && /gcash/i.test(text) && !/adyen\.com/i.test(text)) {
    if (isImageUrl(text) || /merchants-auth|gcash-merchants-auth/i.test(text)) return false;
    return true;
  }
  return false;
}

function isQrImageValue(value) {
  const text = String(value || '').trim();
  if (!text || isPlaceholderQrValue(text)) return false;
  if (/^data:image\//i.test(text)) return true;
  return isImageUrl(text);
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  try {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  } catch {
    return null;
  }
}

function imageLooksLikeQr(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_QR_BYTES) return false;
  const dim = pngDimensions(buffer);
  if (dim && (dim.width < MIN_QR_DIM || dim.height < MIN_QR_DIM)) return false;
  return true;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || headers.get(name.toLowerCase()) || '').trim();
  }
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return String(value || '').trim();
  }
  return '';
}

function contentTypeOf(response) {
  return headerValue(response?.headers, 'content-type').toLowerCase();
}

function bufferFromResponse(response) {
  if (!response) return null;
  if (Buffer.isBuffer(response.buffer)) return response.buffer;
  if (response.buffer) return Buffer.from(response.buffer);
  if (response.body_b64) return Buffer.from(response.body_b64, 'base64');
  return null;
}

function imageDataUrlFromResponse(response) {
  const buf = bufferFromResponse(response);
  if (!buf || !imageLooksLikeQr(buf)) return '';
  const mime = (contentTypeOf(response).split(';')[0] || 'image/png').trim() || 'image/png';
  const safeMime = mime.startsWith('image/') ? mime : 'image/png';
  return `data:${safeMime};base64,${buf.toString('base64')}`;
}

async function qrPayloadToDataUrl(payload) {
  const text = String(payload || '').trim();
  if (!looksLikeQrPayload(text) && !/^000201/.test(text)) return '';
  try {
    const QRCode = require('qrcode');
    return await QRCode.toDataURL(text, {
      type: 'image/png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
  } catch {
    return '';
  }
}

function pushCandidate(out, value, score, kind) {
  const text = decodeEntities(String(value || '').trim());
  if (!text || isAdyenRedirectUrl(text) || isPlaceholderQrValue(text)) return;
  out.push({ value: text, score, kind });
}

function collectFromJson(payload, out) {
  if (typeof payload === 'string') {
    if (isPlaceholderQrValue(payload)) return;
    if (/^data:image\//i.test(payload)) pushCandidate(out, payload, 100, 'data');
    else if (isImageUrl(payload)) pushCandidate(out, payload, 80, 'image');
    else if (looksLikeQrPayload(payload)) pushCandidate(out, payload, 70, 'payload');
    return;
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectFromJson(item, out);
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && QR_JSON_KEYS.has(String(key).toLowerCase())) {
      if (isPlaceholderQrValue(value)) continue;
      if (/^data:image\//i.test(value)) pushCandidate(out, value, 100, 'data');
      else if (isImageUrl(value)) pushCandidate(out, value, 85, 'image');
      else pushCandidate(out, value, 75, 'payload');
    }
    collectFromJson(value, out);
  }
}

function collectFromUrl(url, out) {
  try {
    const parsed = new URL(String(url || ''));
    for (const value of parsed.searchParams.values()) {
      const text = decodeEntities(value);
      if (isPlaceholderQrValue(text)) continue;
      if (/^data:image\//i.test(text)) pushCandidate(out, text, 98, 'data');
      else if (isImageUrl(text)) pushCandidate(out, text, 80, 'image');
      else if (looksLikeQrPayload(text)) pushCandidate(out, text, 72, 'payload');
    }
  } catch {
    /* ignore */
  }
}

function collectQrCandidates(html, pageUrl) {
  const text = String(html || '');
  const out = [];

  collectFromUrl(pageUrl, out);

  for (const match of text.matchAll(/data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+/gi)) {
    if (!isPlaceholderQrValue(match[0])) pushCandidate(out, match[0], 100, 'data');
  }

  for (const match of text.matchAll(/<img\b([^>]*)>/gi)) {
    const tag = match[1] || '';
    const src = decodeEntities((tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || '');
    if (!src || isPlaceholderQrValue(src) || isPlaceholderQrValue(`${src} ${tag}`)) continue;
    const blob = `${src} ${tag}`.toLowerCase();
    const score = /(?:^|[/?._-])qr(?:code)?(?:[/?._-]|$)|adyen-checkout__qr-code/.test(blob)
      ? 92
      : (isImageUrl(src) ? 50 : 0);
    if (score) pushCandidate(out, src, score, 'img');
  }

  for (const key of QR_JSON_KEYS) {
    const re = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, 'gi');
    for (const match of text.matchAll(re)) {
      const value = decodeEntities(match[1] || '');
      if (isPlaceholderQrValue(value)) continue;
      if (/^data:image\//i.test(value)) pushCandidate(out, value, 100, 'data');
      else if (isImageUrl(value)) pushCandidate(out, value, 85, 'image');
      else pushCandidate(out, value, 75, 'payload');
    }
  }

  for (const match of text.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectFromJson(JSON.parse(match[1]), out); } catch { /* ignore */ }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { collectFromJson(JSON.parse(trimmed), out); } catch { /* ignore */ }
  }

  for (const match of text.matchAll(/(?:new\s+QRCode|QRCode\.to(?:Canvas|DataURL|String)|qrcode\.to(?:Canvas|DataURL|String))\s*\((?:[^,)]+,\s*)?["']([^"']+)["']/gi)) {
    if (!isPlaceholderQrValue(match[1])) pushCandidate(out, match[1], 70, 'payload');
  }

  for (const match of text.matchAll(/["']text["']\s*:\s*["']([^"']{16,})["']/g)) {
    if (looksLikeQrPayload(match[1])) pushCandidate(out, match[1], 68, 'payload');
  }

  for (const match of text.matchAll(/\b(000201[0-9A-Za-z.$%*+\-/=#]{20,})\b/g)) {
    pushCandidate(out, match[1], 60, 'payload');
  }

  out.sort((a, b) => b.score - a.score);
  const seen = new Set();
  return out.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

function extractQrFromHtml(html, pageUrl) {
  const first = collectQrCandidates(html, pageUrl)[0];
  return first ? first.value : '';
}

function extractAutoForm(html, baseUrl) {
  const form = String(html || '').match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const attrs = form[1] || '';
  const body = form[2] || '';
  const action = decodeEntities((attrs.match(/\baction=["']([^"']+)["']/i) || [])[1] || '');
  const method = String((attrs.match(/\bmethod=["']([^"']+)["']/i) || [])[1] || 'GET').toUpperCase();
  const actionUrl = resolveUrl(action, baseUrl);
  if (!actionUrl || !isAllowedQrHost(actionUrl)) return null;
  const fields = {};
  for (const match of body.matchAll(/<input\b([^>]*)>/gi)) {
    const tag = match[1] || '';
    const name = decodeEntities((tag.match(/\bname=["']([^"']+)["']/i) || [])[1] || '');
    const value = decodeEntities((tag.match(/\bvalue=["']([^"']*)["']/i) || [])[1] || '');
    if (name) fields[name] = value;
  }
  if (!Object.keys(fields).length && method === 'GET') return null;
  return { url: actionUrl, method: method === 'POST' ? 'POST' : 'GET', form: fields };
}

function extractHttpRedirect(response, baseUrl) {
  const status = Number(response?.status) || 0;
  if (![301, 302, 303, 307, 308].includes(status)) return null;
  const next = resolveUrl(headerValue(response?.headers, 'location'), baseUrl);
  if (next && isAllowedQrHost(next) && next !== baseUrl) return { url: next, method: 'GET' };
  return null;
}

function extractNextHop(html, baseUrl) {
  const text = String(html || '');
  const meta = text.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"';]+)[^"']*["']/i)
    || text.match(/<meta[^>]+content=["'][^"']*url=([^"';]+)[^"']*["'][^>]+http-equiv=["']refresh["']/i);
  if (meta?.[1]) {
    const next = resolveUrl(decodeEntities(meta[1].trim()), baseUrl);
    if (next && isAllowedQrHost(next) && next !== baseUrl) return { url: next, method: 'GET' };
  }
  const loc = text.match(/(?:window\.location(?:\.href)?|location\.replace)\s*=\s*["']([^"']+)["']/i)
    || text.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
  if (loc?.[1]) {
    const next = resolveUrl(decodeEntities(loc[1].trim()), baseUrl);
    if (next && isAllowedQrHost(next) && next !== baseUrl) return { url: next, method: 'GET' };
  }
  return extractAutoForm(text, baseUrl);
}

function shouldWaitForQr(html, url) {
  const page = String(html || '');
  const target = String(url || '').toLowerCase();
  if (/gcat_loader|adyen-checkout__qr-code|merchants-auth/.test(`${page} ${target}`)) return true;
  if (/qrcode|qr-code|qr_code/i.test(page)) return true;
  if (/<canvas\b/i.test(page)) return true;
  return false;
}

function describeQrPage(html, url) {
  const page = String(html || '');
  const marks = [];
  if (/gcat_loader/i.test(page)) marks.push('loader');
  if (/<canvas\b/i.test(page)) marks.push('canvas');
  if (/\b000201/.test(page)) marks.push('emv');
  if (/qrCodeData|qrcodeimage/i.test(page)) marks.push('qrjson');
  if (/adyen-checkout__qr-code/i.test(page)) marks.push('adyen-qr');
  if (/<form\b/i.test(page)) marks.push('form');
  const names = [];
  for (const match of page.matchAll(/<(?:img|script)\b[^>]+src=["']([^"']+)["']/gi)) {
    try {
      const name = new URL(match[1], url).pathname.split('/').pop();
      if (name && !isPlaceholderQrValue(name) && !isPlaceholderQrValue(match[1])) names.push(name);
    } catch {
      /* ignore */
    }
  }
  let keys = '';
  try {
    keys = [...new URL(String(url || '')).searchParams.keys()].join(',');
  } catch {
    keys = '';
  }
  return `${hostnameOf(url) || 'unknown'} ${page.length}b ${marks.join(',') || 'plain'}${names.length ? ` files=${names.slice(0, 6).join(',')}` : ''}${keys ? ` q=${keys}` : ''}`;
}

function pageEvaluator(session) {
  if (typeof session?.evaluate === 'function') return session.evaluate.bind(session);
  if (typeof session?.page?.evaluate === 'function') return session.page.evaluate.bind(session.page);
  return null;
}

async function extractRenderedQr(session) {
  const evaluate = pageEvaluator(session);
  if (!evaluate) return '';
  try {
    const found = await evaluate(() => {
      const bad = /gcat_loader|(?:^|[/?#._-])(?:loader|spinner|placeholder|favicon|logo|pixel)(?:[/?#._-]|\.|$)/i;
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = String(img.currentSrc || img.src || '');
        if (!src || bad.test(src)) continue;
        const width = Number(img.naturalWidth || img.width || 0);
        const height = Number(img.naturalHeight || img.height || 0);
        if (/^data:image\//i.test(src) && (src.length > 2000 || (width >= 80 && height >= 80))) return src;
        if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(src) && width >= 80 && height >= 80) return src;
      }
      for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
        const width = Number(canvas.width || 0);
        const height = Number(canvas.height || 0);
        if (width < 80 || height < 80) continue;
        try {
          const dataUrl = canvas.toDataURL('image/png');
          if (dataUrl && dataUrl.length > 2000) return dataUrl;
        } catch {
          /* tainted canvas */
        }
      }
      return '';
    });
    const text = String(found || '').trim();
    return text && !isPlaceholderQrValue(text) ? text : '';
  } catch {
    return '';
  }
}

async function resolveCandidate(session, candidate, baseUrl, emit) {
  const raw = String(candidate?.value || candidate || '').trim();
  if (!raw || isAdyenRedirectUrl(raw) || isPlaceholderQrValue(raw)) return '';
  if (/^data:image\//i.test(raw)) return raw;
  const absolute = resolveUrl(raw, baseUrl);
  if (isPlaceholderQrValue(absolute)) return '';
  if (isImageUrl(absolute) && session?.request && /^https?:\/\//i.test(absolute)) {
    try {
      const img = await session.request(absolute, { method: 'GET', timeout: 20000 });
      if (isPlaceholderQrValue(img?.url)) return '';
      const dataUrl = imageDataUrlFromResponse(img);
      if (dataUrl) return dataUrl;
      const buf = bufferFromResponse(img);
      if (buf && !imageLooksLikeQr(buf)) {
        emit?.('qr', '忽略过小或占位图，继续等待真码。');
        return '';
      }
      if (isQrImageValue(absolute)) return absolute;
    } catch {
      emit?.('qr', '二维码图片地址打开失败，保留可访问的图片 URL。');
      return isQrImageValue(absolute) ? absolute : '';
    }
  }
  if (looksLikeQrPayload(raw)) {
    const generated = await qrPayloadToDataUrl(raw);
    if (generated) return generated;
  }
  return '';
}

function finishQr(qr, providerUrl, emit, extra = {}) {
  const image = String(qr || '').trim();
  if (
    !image
    || isAdyenRedirectUrl(image)
    || image === providerUrl
    || isPlaceholderQrValue(image)
    || !isQrImageValue(image)
  ) {
    emit?.('qr', '已有跳转链但未抽到二维码');
    return { qr: '', link: providerUrl, missing_qr: true, ...extra };
  }
  return { qr: image, link: providerUrl, missing_qr: false, ...extra };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function extractFromFetched(session, response, finalUrl, emit) {
  if (contentTypeOf(response).startsWith('image/')) {
    if (isPlaceholderQrValue(finalUrl) || isPlaceholderQrValue(response?.url)) return '';
    const dataUrl = imageDataUrlFromResponse(response);
    if (dataUrl) return dataUrl;
  }

  if (response.data && typeof response.data === 'object') {
    const fromJson = [];
    collectFromJson(response.data, fromJson);
    for (const item of fromJson) {
      const resolved = await resolveCandidate(session, item, finalUrl, emit);
      if (resolved) return resolved;
    }
  }

  const rendered = await extractRenderedQr(session);
  if (rendered) {
    const resolved = await resolveCandidate(session, rendered, finalUrl, emit);
    if (resolved) return resolved;
  }

  const html = String(response.text || '');
  for (const item of collectQrCandidates(html, finalUrl)) {
    const resolved = await resolveCandidate(session, item, finalUrl, emit);
    if (resolved) return resolved;
  }
  return '';
}

async function extractGcashQr({ session, url, emit, sleep } = {}) {
  const providerUrl = String(url || '').trim();
  if (!providerUrl) return { qr: '', link: '', missing_qr: true };
  emit?.('qr', '正在通过同一条 PH sticky 打开 Adyen 跳转页抽取二维码。');
  if (!session?.request) {
    return finishQr('', providerUrl, emit);
  }

  const wait = typeof sleep === 'function' ? sleep : defaultSleep;
  let current = { url: providerUrl, method: 'GET' };
  const seen = new Set();
  let finalUrl = providerUrl;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const target = String(current?.url || '').trim();
    const hopKey = `${current.method}:${target}`;
    if (!target || seen.has(hopKey)) break;
    seen.add(hopKey);

    let next = null;
    for (let attempt = 1; attempt <= QR_POLL_ATTEMPTS; attempt += 1) {
      let response;
      try {
        const options = {
          method: current.method || 'GET',
          timeout: 30000,
          redirect: 'manual',
        };
        if (current.method === 'POST' && current.form) options.form = current.form;
        response = await session.request(target, options);
      } catch (error) {
        emit?.('qr', `打开授权链失败：${String(error?.message || error).slice(0, 120)}`);
        return { qr: '', link: providerUrl, missing_qr: true };
      }

      finalUrl = String(response.url || target);
      const html = String(response.text || '');
      const resolved = await extractFromFetched(session, response, finalUrl, emit);
      if (resolved) return finishQr(resolved, providerUrl, emit, { finalUrl });

      next = extractHttpRedirect(response, finalUrl) || extractNextHop(html, finalUrl);
      if (next) {
        emit?.('qr', `授权页仍无真码，跟随下一跳（${describeQrPage(html, finalUrl)}）。`);
        break;
      }
      if (shouldWaitForQr(html, finalUrl) && attempt < QR_POLL_ATTEMPTS) {
        emit?.('qr', `授权页尚未打出真码，继续等待（${attempt}/${QR_POLL_ATTEMPTS}，${describeQrPage(html, finalUrl)}）。`);
        await wait(QR_POLL_WAIT_MS[attempt - 1] || 0);
        continue;
      }
      emit?.('qr', `授权页读完仍无真码（${describeQrPage(html, finalUrl)}）。`);
      break;
    }

    if (!next) break;
    current = next;
  }

  return finishQr('', providerUrl || finalUrl, emit, { finalUrl });
}

module.exports = {
  extractGcashQr,
  extractQrFromHtml,
  collectQrCandidates,
  isImageUrl,
  isQrImageValue,
  isAdyenRedirectUrl,
  isPlaceholderQrValue,
  imageLooksLikeQr,
  looksLikeQrPayload,
  isGcashShortCode,
  isGcashShortUrl,
  qrPayloadToDataUrl,
  shouldWaitForQr,
};
