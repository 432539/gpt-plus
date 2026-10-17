'use strict';

const { AUTH_BASE, CHATGPT_BASE, EXTRACT_PROFILE } = require('./constants');
const { REDIRECT_STATUSES } = require('./constants');
const { absUrl, continueUrl, extractCode, isCodexCallbackUrl, urlForLog } = require('./parse');
const { headerValue } = require('./httpHeaders');

function browserHeaders(profile, deviceId) {
  return {
    'accept-language': profile.locale,
    'oai-device-id': deviceId,
    'oai-language': profile.oai_language,
    'sec-ch-ua': profile.sec_ch_ua,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': profile.sec_ch_ua_platform,
    'user-agent': profile.user_agent,
  };
}

function jsonHeaders(profile, deviceId, referer, origin = AUTH_BASE) {
  return {
    ...browserHeaders(profile, deviceId),
    accept: 'application/json',
    'content-type': 'application/json',
    origin,
    referer,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

function navHeaders(profile, deviceId, referer = '') {
  const headers = {
    ...browserHeaders(profile, deviceId),
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': referer ? 'same-origin' : 'none',
    'upgrade-insecure-requests': '1',
  };
  if (referer) headers.referer = referer;
  return headers;
}

async function protocolRequest(session, method, url, options = {}) {
  return session.request(url, {
    method,
    headers: options.headers,
    json: options.json,
    form: options.form,
    body: options.body,
    redirect: options.redirect || 'manual',
    timeout: options.timeout || 45000,
  });
}

async function seedDeviceCookies(session, deviceId) {
  if (typeof session.seedCookies !== 'function') return;
  await session.seedCookies([
    { name: 'oai-did', value: deviceId, domain: '.chatgpt.com', path: '/' },
    { name: 'oai-did', value: deviceId, domain: '.openai.com', path: '/' },
    { name: 'oai-did', value: deviceId, domain: 'chatgpt.com', path: '/' },
    { name: 'oai-did', value: deviceId, domain: 'auth.openai.com', path: '/' },
  ]);
}

async function dumpCookies(session) {
  if (typeof session.cookies !== 'function') return [];
  try {
    const rows = await session.cookies();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function decodeSignedCookiePayload(raw) {
  const val = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!val) return null;
  const part = val.includes('.') ? val.split('.')[0] : val;
  const pad = '='.repeat((4 - (part.length % 4)) % 4);
  for (const encoding of ['base64url', 'base64']) {
    try {
      const data = JSON.parse(Buffer.from(part + pad, encoding).toString('utf8'));
      if (data && typeof data === 'object') return data;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function extractWorkspaceId(session) {
  for (const cookie of await dumpCookies(session)) {
    if (!String(cookie.name || '').includes('oai-client-auth-session')) continue;
    const data = decodeSignedCookiePayload(cookie.value);
    if (!data) continue;
    const workspaces = data.workspaces
      || (data.client_auth_session && typeof data.client_auth_session === 'object'
        ? data.client_auth_session.workspaces
        : []);
    if (Array.isArray(workspaces) && workspaces[0]?.id) return String(workspaces[0].id);
  }
  return '';
}

async function extractLoginVerifier(session) {
  for (const cookie of await dumpCookies(session)) {
    if (cookie.name !== 'login_session') continue;
    const data = decodeSignedCookiePayload(cookie.value);
    if (!data) continue;
    return String(data.login_challenge || data.login_verifier || '');
  }
  return '';
}

async function follow(session, profile, deviceId, url, {
  referer, log, checkpoint, maxHops = 15,
} = {}) {
  let current = url;
  let last = null;
  let currentReferer = referer || `${AUTH_BASE}/`;
  for (let i = 0; i < maxHops; i += 1) {
    await checkpoint?.();
    if (isCodexCallbackUrl(current)) return { last, code: extractCode(current), location: current };
    last = await protocolRequest(session, 'GET', current, {
      headers: navHeaders(profile, deviceId, currentReferer),
    });
    const loc = absUrl(headerValue(last.headers, 'location'));
    log?.(`    follow[${i}] ${last.status}`);
    if (loc && isCodexCallbackUrl(loc)) return { last, code: extractCode(loc), location: loc };
    if (REDIRECT_STATUSES.has(last.status) && loc) {
      currentReferer = current;
      current = loc;
      continue;
    }
    if (last.status === 200) {
      const nxt = absUrl(continueUrl(last.data));
      if (nxt) {
        if (isCodexCallbackUrl(nxt)) return { last, code: extractCode(nxt), location: nxt };
        if (nxt !== current) {
          currentReferer = current;
          current = nxt;
          continue;
        }
      }
    }
    break;
  }
  return { last, code: extractCode(current), location: current };
}

async function postAccount(session, profile, deviceId, path, payload, { referer, extraHeaders } = {}) {
  const crypto = require('node:crypto');
  return protocolRequest(session, 'POST', `${AUTH_BASE}${path}`, {
    headers: {
      ...jsonHeaders(profile, deviceId, referer),
      'x-access-flow-invocation-id': crypto.randomUUID(),
      ...(extraHeaders || {}),
    },
    json: payload,
  });
}

async function warmLoginDoor(session, profile, deviceId, log) {
  try {
    await protocolRequest(session, 'GET', `${AUTH_BASE}/`, {
      headers: navHeaders(profile, deviceId, ''),
    });
    await protocolRequest(session, 'GET', `${CHATGPT_BASE}/`, {
      headers: navHeaders(profile, deviceId, `${CHATGPT_BASE}/`),
    });
  } catch {
    log?.('· 登录小门预热没成功，还是继续开 Codex 门…');
  }
}

module.exports = {
  AUTH_BASE,
  CHATGPT_BASE,
  EXTRACT_PROFILE,
  browserHeaders,
  jsonHeaders,
  navHeaders,
  protocolRequest,
  seedDeviceCookies,
  dumpCookies,
  decodeSignedCookiePayload,
  extractWorkspaceId,
  extractLoginVerifier,
  follow,
  postAccount,
  warmLoginDoor,
  headerValue,
  urlForLog,
};
