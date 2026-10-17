'use strict';

const { SENTINEL_SDK_URL } = require('./constants');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMEZONE_META = Object.freeze({
  'Asia/Tokyo': { offsetMin: 540, label: 'Japan Standard Time' },
  'Asia/Manila': { offsetMin: 480, label: 'Philippine Standard Time' },
});
const DOCUMENT_KEYS = Object.freeze([
  'location', 'referrer', 'cookie', 'title', 'URL', 'domain', 'body', 'head',
  'documentElement', 'scripts', 'images', 'forms', 'links', 'anchors', 'embeds',
  'plugins', 'applets', 'all', 'readyState', 'designMode', 'dir', 'lastModified',
  'height', 'width', 'visibilityState', 'hidden', 'fullscreen', 'fullscreenEnabled',
  'pointerLockElement', 'pictureInPictureElement', 'pictureInPictureEnabled',
  'rootElement', 'activeElement', 'styleSheets', 'fonts', 'fullscreenElement',
  'characterSet', 'charset', 'inputEncoding', 'compatMode', 'contentType',
  'doctype', 'implementation', 'defaultView', 'firstChild', 'lastChild',
  'childElementCount', 'children', 'firstElementChild', 'lastElementChild',
]);
const WINDOW_KEYS = Object.freeze([
  'location', 'navigator', 'history', 'screen', 'document', 'window', 'self',
  'top', 'parent', 'frames', 'opener', 'closed', 'length', 'name', 'status',
  'origin', 'href', 'pathname', 'search', 'hash', 'host', 'hostname', 'port',
  'protocol', 'performance', 'crypto', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'localStorage', 'sessionStorage', 'indexedDB', 'console', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio',
]);
const NAVIGATOR_KEYS = Object.freeze([
  'userAgent', 'language', 'languages', 'platform', 'vendor', 'vendorSub',
  'product', 'productSub', 'appName', 'appVersion', 'hardwareConcurrency',
  'deviceMemory', 'maxTouchPoints', 'cookieEnabled', 'onLine', 'doNotTrack',
  'pdfViewerEnabled',
]);
const FAIL_PREFIX = 'gAAAAAB';
const REQUIREMENTS_PREFIX = 'gAAAAAC';
const ENFORCEMENT_PREFIX = 'gAAAAAB';

function timezoneMeta(timezone) {
  return TIMEZONE_META[String(timezone || '').trim()] || TIMEZONE_META['Asia/Tokyo'];
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)] || '';
}

function localeDateString(timestamp = Date.now(), timezone = 'Asia/Tokyo') {
  const { offsetMin, label } = timezoneMeta(timezone);
  const local = new Date(Number(timestamp) + offsetMin * 60 * 1000);
  const weekday = WEEKDAYS[local.getUTCDay()];
  const month = MONTHS[local.getUTCMonth()];
  const day = String(local.getUTCDate());
  const year = String(local.getUTCFullYear());
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  const ss = String(local.getUTCSeconds()).padStart(2, '0');
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offsetHh = String(Math.floor(abs / 60)).padStart(2, '0');
  const offsetMm = String(abs % 60).padStart(2, '0');
  return `${weekday} ${month} ${day} ${year} ${hh}:${mm}:${ss} GMT${sign}${offsetHh}${offsetMm} (${label})`;
}

function compact64(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function fnv1aHex(text) {
  let value = 2166136261;
  const input = String(text);
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 2246822507) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 3266489909) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0).toString(16).padStart(8, '0');
}

function screenSum(screen) {
  const text = String(screen || '1920x1080');
  const match = text.match(/(\d+)\s*[xX*]\s*(\d+)/);
  if (match) return Number(match[1]) + Number(match[2]);
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1920 + 1080;
}

function searchParamKeys(pageUrl) {
  try {
    return [...new URL(String(pageUrl || ''), 'https://chatgpt.com').searchParams.keys()].join(',');
  } catch {
    return '';
  }
}

function navigatorSample(state, prop) {
  const values = {
    userAgent: state.userAgent,
    language: state.language,
    languages: state.languages,
    platform: state.platform || 'Win32',
    vendor: 'Google Inc.',
    vendorSub: '',
    product: 'Gecko',
    productSub: '20030107',
    appName: 'Netscape',
    appVersion: state.userAgent.replace(/^Mozilla\//, '') || '5.0',
    hardwareConcurrency: String(state.cores || 8),
    deviceMemory: '8',
    maxTouchPoints: '0',
    cookieEnabled: 'true',
    onLine: 'true',
    doNotTrack: 'null',
    pdfViewerEnabled: 'true',
  };
  const value = Object.prototype.hasOwnProperty.call(values, prop) ? values[prop] : 'undefined';
  return `${prop}\u2212${value}`;
}

function createSentinelState({
  deviceId,
  userAgent,
  screen = '1920x1080',
  platform = 'Win32',
  language,
  languages,
  timezone,
  pageUrl,
} = {}) {
  return {
    deviceId: String(deviceId || ''),
    userAgent: String(userAgent || ''),
    screen: String(screen || '1920x1080'),
    platform: String(platform || 'Win32'),
    language: String(language || 'en-US'),
    languages: String(languages || 'en-US,en'),
    timezone: String(timezone || 'Asia/Tokyo'),
    pageUrl: String(pageUrl || ''),
    sid: require('node:crypto').randomUUID(),
    cores: 8,
  };
}

function configuration(state) {
  const now = Date.now();
  const perf = Math.round((1000 + Math.random() * 49000) * 10) / 10;
  const navProp = pick(NAVIGATOR_KEYS);
  return [
    screenSum(state.screen),
    localeDateString(now, state?.timezone),
    4294705152,
    0,
    state.userAgent,
    SENTINEL_SDK_URL,
    null,
    state.language,
    state.languages,
    0,
    navigatorSample(state, navProp),
    pick(DOCUMENT_KEYS),
    pick(WINDOW_KEYS),
    perf,
    state.sid,
    searchParamKeys(state.pageUrl),
    state.cores || 8,
    now - perf,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
}

function failAnswer(value = 'e') {
  return compact64(String(value ?? 'e'));
}

function solveEncoded(state, seed, difficulty, limit = 500000) {
  const started = performance.now();
  const values = configuration(state);
  const target = String(difficulty ?? '0');
  try {
    for (let nonce = 0; nonce < limit; nonce += 1) {
      values[3] = nonce;
      values[9] = Math.round(performance.now() - started);
      const payload = compact64(values);
      const digest = fnv1aHex(`${seed}${payload}`);
      if (digest.slice(0, target.length) <= target) return `${payload}~S`;
    }
  } catch (error) {
    return failAnswer(error?.message || error);
  }
  return failAnswer('e');
}

function requirementsToken(state) {
  const seed = String(Math.random());
  return `${REQUIREMENTS_PREFIX}${solveEncoded(state, seed, '0')}`;
}

function solveProof(state, seed, difficulty, limit = 500000) {
  if (!seed || difficulty == null || difficulty === '') {
    return `${ENFORCEMENT_PREFIX}${failAnswer('e')}`;
  }
  return `${ENFORCEMENT_PREFIX}${solveEncoded(state, String(seed), String(difficulty), limit)}`;
}

function decodePowPayload(token) {
  const raw = String(token || '');
  const body = raw.replace(/^gAAAAA[BC]/, '').replace(/~S$/, '');
  try {
    return JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  localeDateString,
  compact64,
  fnv1aHex,
  fnv1a: fnv1aHex,
  createSentinelState,
  configuration,
  requirementsToken,
  solveProof,
  decodePowPayload,
};
