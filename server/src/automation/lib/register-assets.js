'use strict';

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const TELEMETRY_MARKER = 'REGISTER_ASSET_OPT_V1';

const STATIC_ROUTE_PATTERN = /^https:\/\/(?:chatgpt\.com|auth\.openai\.com|(?:[a-z0-9-]+\.)?oaistatic\.com)\/[^?#]+\.(?:m?js|css)(?:\?[^#]*)?$/i;
const MEDIA_ROUTE_PATTERN = '**/*';
const PROTECTED_CHALLENGE = /(?:captcha|turnstile|challenge|challenges\.cloudflare\.com|hcaptcha|arkoselabs|sentinel\.openai\.com)/i;
const FORBIDDEN_STATIC_PATH = /(?:\/api\/|\/oauth(?:\/|$)|\/authorize(?:\/|$)|\/accounts?(?:\/|$)|\/(?:login|logout|signup|register|session|token)(?:\/|$)|captcha|turnstile|challenge|service[-_]?worker|(?:^|\/)sw\.js|checkout)/i;
const SECRET_QUERY_KEY = /(?:^|_)(?:access|auth|authorization|code|credential|jwt|key|license|password|refresh|secret|session|sig|signature|state|token)(?:_|$)/i;
const JAVASCRIPT_CONTENT_TYPE = /^(?:application|text)\/(?:javascript|x-javascript)(?:\s*;|$)/i;
const CSS_CONTENT_TYPE = /^text\/css(?:\s*;|$)/i;
const PRIVATE_CACHE_CONTROL = /(?:^|,)\s*(?:private|no-store|no-cache|must-revalidate)(?:\s*(?:,|$)|\s*=)/i;

function headerValue(headers, name) {
  const wanted = String(name || '').toLowerCase();
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === wanted);
  const value = key ? headers[key] : '';
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

function approvedStaticHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'chatgpt.com'
    || host === 'auth.openai.com'
    || host === 'cdn.oaistatic.com'
    || host.endsWith('.oaistatic.com');
}

function strongContentHash(pathname) {
  const filename = String(pathname || '').split('/').pop() || '';
  const stem = filename.replace(/\.(?:m?js|css)$/i, '');
  return stem.split(/[-_.]/).some(segment => (
    (/^[a-f0-9]{8,}$/i.test(segment) && /[a-f]/i.test(segment) && /\d/.test(segment))
    || (/^[A-Za-z0-9_]{16,}$/.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment) && /\d/.test(segment))
  ));
}

function safePublicStaticUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return null; }
  if (url.protocol !== 'https:' || !approvedStaticHost(url.hostname)) return null;
  if (url.username || url.password || url.hash || FORBIDDEN_STATIC_PATH.test(url.pathname)) return null;
  if (!/\.(?:m?js|css)$/i.test(url.pathname)) return null;
  for (const key of url.searchParams.keys()) if (SECRET_QUERY_KEY.test(key)) return null;
  // Query-bearing assets are deliberately excluded. This avoids sharing signed,
  // personalized, experiment, or authorization-dependent variants.
  if (url.search) return null;
  const immutablePath = /\/_next\/static\//i.test(url.pathname)
    || (url.hostname.endsWith('.oaistatic.com') && /\/(?:assets|static)\//i.test(url.pathname));
  return immutablePath || strongContentHash(url.pathname) ? url : null;
}

function isImmutableStaticRequest({
  url, method = 'GET', resourceType = '', headers = {},
} = {}) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  if (!['script', 'stylesheet'].includes(String(resourceType || '').toLowerCase())) return false;
  if (headerValue(headers, 'authorization')) return false;
  return Boolean(safePublicStaticUrl(url));
}

function isCacheableStaticResponse({ url, status = 0, headers = {}, bodyLength = 0, maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES } = {}) {
  const parsed = safePublicStaticUrl(url);
  if (!parsed || Number(status) !== 200) return false;
  const contentType = headerValue(headers, 'content-type');
  const cacheControl = headerValue(headers, 'cache-control');
  const vary = headerValue(headers, 'vary');
  const contentTypeMatches = /\.css$/i.test(parsed.pathname)
    ? CSS_CONTENT_TYPE.test(contentType)
    : JAVASCRIPT_CONTENT_TYPE.test(contentType);
  if (!contentTypeMatches) return false;
  if (headerValue(headers, 'set-cookie') || PRIVATE_CACHE_CONTROL.test(cacheControl)) return false;
  if (/(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/i.test(vary)) return false;
  if (!/\bimmutable\b/i.test(cacheControl) && !strongContentHash(parsed.pathname)) return false;
  const size = Number(bodyLength) || 0;
  return size > 0 && size <= Math.max(1, Number(maxEntryBytes) || DEFAULT_MAX_ENTRY_BYTES);
}

function shouldBlockRegistrationResource({ url, resourceType = '' } = {}) {
  const type = String(resourceType || '').toLowerCase();
  if (!['image', 'media'].includes(type)) return false;
  const value = String(url || '');
  if (PROTECTED_CHALLENGE.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

class BoundedByteLruCache {
  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
  } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES));
    this.maxBytes = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
    this.ttlMs = Math.max(1, Math.floor(Number(ttlMs) || DEFAULT_TTL_MS));
    this.now = typeof now === 'function' ? now : Date.now;
    this.items = new Map();
    this.bytes = 0;
  }

  get(key) {
    const item = this.items.get(key);
    if (!item) return null;
    if (item.expiresAt <= this.now()) {
      this.delete(key);
      return null;
    }
    this.items.delete(key);
    this.items.set(key, item);
    return item.value;
  }

  set(key, value) {
    const body = Buffer.isBuffer(value?.body) ? value.body : Buffer.from(value?.body || '');
    if (!body.length || body.length > this.maxBytes) return false;
    this.delete(key);
    const item = {
      size: body.length,
      expiresAt: this.now() + this.ttlMs,
      value: {
        body,
        contentType: String(value?.contentType || ''),
        cacheControl: String(value?.cacheControl || ''),
      },
    };
    this.items.set(key, item);
    this.bytes += item.size;
    while (this.items.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.items.keys().next().value);
    }
    return this.items.has(key);
  }

  delete(key) {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key);
    this.bytes = Math.max(0, this.bytes - item.size);
    return true;
  }

  clear() {
    this.items.clear();
    this.bytes = 0;
  }

  stats() {
    return { entries: this.items.size, bytes: this.bytes };
  }
}

const registrationStaticCache = new BoundedByteLruCache();

const requestView = request => ({
  url: typeof request?.url === 'function' ? request.url() : request?.url,
  method: typeof request?.method === 'function' ? request.method() : request?.method,
  resourceType: typeof request?.resourceType === 'function' ? request.resourceType() : request?.resourceType,
  headers: typeof request?.headers === 'function' ? request.headers() : request?.headers,
});

async function responseHeaders(response) {
  if (typeof response?.allHeaders === 'function') return response.allHeaders();
  if (typeof response?.headers === 'function') return response.headers();
  return response?.headers || {};
}

function isRouteAlreadyHandledError(error) {
  return /already handled/i.test(String(error?.message || ''));
}

async function settleRoute(action) {
  try {
    return await action();
  } catch (error) {
    if (isRouteAlreadyHandledError(error)) return undefined;
    throw error;
  }
}

async function continueRoute(route) {
  return settleRoute(async () => {
    if (typeof route?.fallback === 'function') return route.fallback();
    return route?.continue?.();
  });
}

async function fulfillRoute(route, options) {
  if (typeof route?.fulfill !== 'function') return continueRoute(route);
  return settleRoute(() => route.fulfill(options));
}

function safeFinalCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^(?:SUCCESS|[A-Z][A-Z0-9_]{2,79})$/.test(code) ? code : 'UNKNOWN';
}

function createTelemetry(startedAt = Date.now) {
  const started = Number(startedAt()) || Date.now();
  const counters = {
    page_ready_ms: 0,
    immutable_cache_hits: 0,
    immutable_cache_misses: 0,
    immutable_cache_bytes_saved: 0,
    media_requests_blocked: 0,
    dom_in_page_retries: 0,
  };
  return {
    markPageReady() {
      if (!counters.page_ready_ms) counters.page_ready_ms = Math.max(0, (Number(startedAt()) || Date.now()) - started);
    },
    noteDomRetry() { counters.dom_in_page_retries += 1; },
    hit(bytes) {
      counters.immutable_cache_hits += 1;
      counters.immutable_cache_bytes_saved += Math.max(0, Number(bytes) || 0);
    },
    miss() { counters.immutable_cache_misses += 1; },
    blocked() { counters.media_requests_blocked += 1; },
    summary(finalCode) {
      return Object.freeze({
        marker: TELEMETRY_MARKER,
        ...counters,
        final_code: safeFinalCode(finalCode),
      });
    },
  };
}

async function installRegistrationAssetOptimization(page, {
  enabled = true,
  cache = registrationStaticCache,
  now = Date.now,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
} = {}) {
  const telemetry = createTelemetry(now);
  if (!enabled || typeof page?.route !== 'function') {
    return { telemetry, enabled: false, dispose: async () => {} };
  }

  const staticHandler = async (route, requestArg) => {
    const request = requestArg || route?.request?.();
    const view = requestView(request);
    if (!isImmutableStaticRequest(view)) return continueRoute(route);
    const key = safePublicStaticUrl(view.url)?.href;
    if (!key) return continueRoute(route);
    const cached = cache.get(key);
    if (cached) {
      telemetry.hit(cached.body.length);
      return fulfillRoute(route, {
        status: 200,
        contentType: cached.contentType,
        headers: { 'cache-control': cached.cacheControl || 'public, max-age=1800, immutable' },
        body: cached.body,
      });
    }
    telemetry.miss();
    if (typeof route?.fetch !== 'function') return continueRoute(route);
    try {
      const response = await route.fetch();
      const headers = await responseHeaders(response);
      const body = await response.body();
      const status = typeof response.status === 'function' ? response.status() : response.status;
      if (isCacheableStaticResponse({
        url: key, status, headers, bodyLength: body.length, maxEntryBytes,
      })) {
        cache.set(key, {
          body,
          contentType: headerValue(headers, 'content-type'),
          cacheControl: headerValue(headers, 'cache-control'),
        });
      }
      return fulfillRoute(route, { response });
    } catch {
      return continueRoute(route);
    }
  };

  const mediaHandler = async (route, requestArg) => {
    const request = requestArg || route?.request?.();
    if (!shouldBlockRegistrationResource(requestView(request))) return continueRoute(route);
    telemetry.blocked();
    return route.abort('blockedbyclient');
  };

  // Playwright routing disables the profile's native HTTP cache. Registration
  // profiles start empty and remain account-isolated, so we trade that cold
  // per-profile cache for a narrow process cache that can only serve validated
  // immutable JS/CSS bytes. The catch-all route below never fulfills non-media.
  await page.route(STATIC_ROUTE_PATTERN, staticHandler);
  await page.route(MEDIA_ROUTE_PATTERN, mediaHandler);
  return {
    telemetry,
    enabled: true,
    async dispose() {
      if (typeof page?.unroute !== 'function') return;
      await page.unroute(STATIC_ROUTE_PATTERN, staticHandler).catch(() => {});
      await page.unroute(MEDIA_ROUTE_PATTERN, mediaHandler).catch(() => {});
    },
  };
}

exports.DEFAULT_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;
exports.DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES;
exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
exports.TELEMETRY_MARKER = TELEMETRY_MARKER;
exports.STATIC_ROUTE_PATTERN = STATIC_ROUTE_PATTERN;
exports.MEDIA_ROUTE_PATTERN = MEDIA_ROUTE_PATTERN;
exports.BoundedByteLruCache = BoundedByteLruCache;
exports.registrationStaticCache = registrationStaticCache;
exports.safePublicStaticUrl = safePublicStaticUrl;
exports.isImmutableStaticRequest = isImmutableStaticRequest;
exports.isCacheableStaticResponse = isCacheableStaticResponse;
exports.shouldBlockRegistrationResource = shouldBlockRegistrationResource;
exports.createTelemetry = createTelemetry;
exports.installRegistrationAssetOptimization = installRegistrationAssetOptimization;
