const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { generateEteid } = require('./paypalProfile');

const { EXTRACT_USER_AGENT } = require('./extractHttp');

const USER_AGENT = EXTRACT_USER_AGENT;

const SCREEN_POOL = Object.freeze([
  { colorDepth: 24, pixelDepth: 24, height: 1080, width: 1920, availHeight: 1040, availWidth: 1920 },
  { colorDepth: 24, pixelDepth: 24, height: 900, width: 1440, availHeight: 860, availWidth: 1440 },
  { colorDepth: 24, pixelDepth: 24, height: 768, width: 1366, availHeight: 728, availWidth: 1366 },
  { colorDepth: 24, pixelDepth: 24, height: 1440, width: 2560, availHeight: 1400, availWidth: 2560 },
]);
const WEBGL_POOL = Object.freeze([
  'Google Inc. (NVIDIA)|ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Google Inc. (NVIDIA)|ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Google Inc. (NVIDIA)|ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Google Inc. (AMD)|ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Google Inc. (AMD)|ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Google Inc. (Intel)|ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Google Inc. (Intel)|ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
]);
const SCREEN = SCREEN_POOL[1];
const VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const TEALEAF_APP_KEY = '76938917d7504ff7a962174c021690bd';

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function createDeviceSignals({ userAgent = USER_AGENT, timezone = 'Europe/London' } = {}) {
  const screen = { ...randomItem(SCREEN_POOL) };
  const webgl = randomItem(WEBGL_POOL);
  return {
    userAgent,
    timezone,
    timezoneOffset: 0,
    screen,
    viewport: {
      width: Math.min(VIEWPORT.width, screen.width),
      height: Math.min(VIEWPORT.height, screen.height),
    },
    webgl,
    webglVendorAndRenderer: webgl.replace('|', '~'),
    audio: String((124.04347527516074 + (Math.random() - 0.5) * 1e-10).toFixed(14)),
    hardwareConcurrency: randomItem([4, 8, 12, 16]),
    deviceMemory: randomItem([8, 16, 32]),
  };
}

function compactJson(value) {
  return JSON.stringify(value);
}

function buildFnSyncData(correlationId, { source = 'IWC_NEXT_CHECKOUT', includeD = false, userAgent = USER_AGENT, signals } = {}) {
  const nowMs = Date.now();
  const screen = signals?.screen || SCREEN;
  const ua = signals?.userAgent || userAgent;
  const data = {
    SC_VERSION: '2.0.4',
    syncStatus: 'data',
    f: correlationId,
    s: source,
    chk: { ts: nowMs, eteid: generateEteid(), tts: 20 + Math.floor(Math.random() * 61) },
    dc: compactJson({ screen, ua }),
    wv: false,
    web_integration_type: 'WEB_REDIRECT',
    cookie_enabled: true,
  };
  if (includeD) {
    const ts2 = [
      ['Di0', 12000 + Math.floor(Math.random() * 12001)],
      ['Di1', 5 + Math.floor(Math.random() * 14)],
      ['Di2', 80 + Math.floor(Math.random() * 101)],
      ['Ui0', 24],
      ['Ui1', 40 + Math.floor(Math.random() * 41)],
      ['Ui2', 45 + Math.floor(Math.random() * 51)],
      ['Di3', 2000 + Math.floor(Math.random() * 3001)],
      ['Di4', 24],
      ['Di5', 60 + Math.floor(Math.random() * 81)],
      ['Uh', 2500 + Math.floor(Math.random() * 3001)],
    ];
    const chunks = [];
    let baseA = 18000 + Math.floor(Math.random() * 38001);
    for (let i = 0; i < 20; i += 1) {
      const a = Math.max(1000, baseA + Math.floor(Math.random() * 56001) - 28000);
      const b = a + Math.floor(Math.random() * 501) - 250;
      const c = Math.max(1000, a - (250 + Math.floor(Math.random() * 451)));
      chunks.push(`${a},${b},${c}`);
    }
    data.d = {
      ts2: ts2.map(([k, v]) => `${k}:${v}`).join(''),
      rDT: `${chunks.join(':')}:${8000 + Math.floor(Math.random() * 20001)},${20 + Math.floor(Math.random() * 61)}`,
    };
  }
  return encodeURIComponent(compactJson(data));
}

function buildSignupFnSyncData(ecToken, userAgent, signals) {
  return buildFnSyncData(ecToken, { source: 'IWC_LOGIN_APP', includeD: true, userAgent, signals });
}

function mousePath() {
  const startX = 100 + Math.floor(Math.random() * 401);
  const startY = 100 + Math.floor(Math.random() * 301);
  const endX = 300 + Math.floor(Math.random() * 501);
  const endY = 200 + Math.floor(Math.random() * 401);
  const dx = [];
  const dy = [];
  const ts = [];
  for (let i = 0; i < 10; i += 1) {
    const progress = i / 9;
    dx.push(Math.round(startX + (endX - startX) * progress + Math.floor(Math.random() * 7) - 3));
    dy.push(Math.round(startY + (endY - startY) * progress + Math.floor(Math.random() * 7) - 3));
    ts.push(i * 200 + Math.floor(Math.random() * 51));
  }
  return { dx, dy, ts };
}

function buildTealeafPayload(pageUrl) {
  const now = Date.now();
  const messages = [
    {
      type: 6,
      offset: 0,
      screenviewOffset: 0,
      performance: {
        timing: {
          navigationStart: now - 5000,
          domContentLoadedEventEnd: now - 3000,
          loadEventEnd: now - 2000,
        },
      },
    },
    {
      type: 2,
      offset: 0,
      screenviewOffset: 0,
      screenview: { type: 'LOAD', name: pageUrl, url: pageUrl, host: 'www.paypal.com', referrer: '' },
    },
    {
      type: 11,
      offset: 1000,
      screenviewOffset: 0,
      mouseMove: mousePath(),
    },
  ];
  return { type: 2, offset: 0, screenviewOffset: 0, count: messages.length, fromWeb: true, messages };
}

async function sendTealeafData(session, pageUrl) {
  const payload = Buffer.from(JSON.stringify(buildTealeafPayload(pageUrl)));
  const compressed = zlib.gzipSync(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Encoding': 'gzip',
    'X-Tealeaf-SaaS-AppKey': TEALEAF_APP_KEY,
    Origin: 'https://www.paypal.com',
  };
  if (session.state.tltsid) headers['X-Tealeaf-SaaS-TLTSID'] = session.state.tltsid;
  if (session.state.tltdid) headers['X-Tealeaf-TLTDID'] = session.state.tltdid;
  try {
    await session.postGzip(
      'https://www.paypal.com/platform/tealeaftarget',
      compressed,
      headers,
    );
  } catch {
    try {
      delete headers['Content-Encoding'];
      await session.post('https://www.paypal.com/platform/tealeaftarget', {
        body: payload.toString('utf8'),
        headers,
      });
    } catch { /* optional signal */ }
  }
}

async function sendDeviceFingerprint(session, correlationId, {
  appId = 'IWC_NEXT_CHECKOUT',
  referer = 'https://www.paypal.com/',
  wrapped = false,
  userAgent = USER_AGENT,
  signals,
} = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: 'https://www.paypal.com',
    Referer: referer,
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  const ts = Date.now();
  const screen = signals?.screen || SCREEN;
  const ua = signals?.userAgent || userAgent;
  const webgl = signals?.webgl || randomItem(WEBGL_POOL);
  const p1 = {
    f: correlationId,
    s: appId,
    cb1: 'close498',
    cb2: `fingerprintSetup${ts}`,
    v: '5.8.2',
    t: ts,
    fp2: {
      browser: {
        ua,
        lang: 'en-GB',
        colorDepth: screen.colorDepth,
        deviceMemory: signals?.deviceMemory || 8,
        hardwareConcurrency: signals?.hardwareConcurrency || 8,
        screenResolution: [screen.height, screen.width],
        availableScreenResolution: [screen.availHeight, screen.availWidth],
        timezoneOffset: signals?.timezoneOffset ?? 0,
        timezone: signals?.timezone || 'Europe/London',
        sessionStorage: true,
        localStorage: true,
        indexedDb: true,
        openDatabase: true,
        cpuClass: 'not available',
        platform: 'Win32',
        doNotTrack: 'not available',
        plugins: [],
        webgl,
        webglVendorAndRenderer: signals?.webglVendorAndRenderer || webgl.replace('|', '~'),
        hasLiedLanguages: false,
        hasLiedResolution: false,
        hasLiedOs: false,
        hasLiedBrowser: false,
        touchSupport: [0, false, false],
        fonts: ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana'],
        audio: signals?.audio || String((124.04347527516074 + (Math.random() - 0.5) * 1e-10).toFixed(14)),
      },
    },
  };
  const wrap = (payload) => (wrapped ? { appId, correlationId, payload } : payload);
  for (const [path, body] of [
    ['p1', wrap(p1)],
    ['p2', wrap({ f: correlationId, s: appId, t: ts, v: '5.8.2' })],
    ['w', wrap({ f: correlationId, s: appId, t: ts })],
  ]) {
    try {
      await session.post(`https://c.paypal.com/v1/r/d/b/${path}`, { json: body, headers });
    } catch { /* optional */ }
  }
}

async function sendSignupFieldEvents(session, ecToken, fieldIds, {
  appId = 'CHECKOUTUINODEWEB_ONBOARDING_LITE',
} = {}) {
  const headers = {
    Origin: 'https://www.paypal.com',
    Referer: session.state.signup_url || 'https://www.paypal.com/',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  let elapsed = 700 + Math.floor(Math.random() * 701);
  for (const fieldId of fieldIds) {
    let tsObj;
    if (fieldId === 'password' || fieldId === 'cardCvv') {
      tsObj = `Di0:${elapsed}Di1:${7 + Math.floor(Math.random() * 39)}Di2:${80 + Math.floor(Math.random() * 341)}Ui0:${20 + Math.floor(Math.random() * 26)}Ui1:${45 + Math.floor(Math.random() * 76)}Uh:${1200 + Math.floor(Math.random() * 5301)}`;
    } else if (fieldId === 'cardNumber') {
      tsObj = `Dk91:${elapsed}Di0:${120 + Math.floor(Math.random() * 201)}Uk91:${80 + Math.floor(Math.random() * 101)}Uh:${1200 + Math.floor(Math.random() * 1001)}`;
    } else {
      tsObj = `Dk000:${elapsed}Uk000:${4 + Math.floor(Math.random() * 10)}Uh:${850 + Math.floor(Math.random() * 451)}`;
    }
    try {
      await session.get('https://c.paypal.com/v1/r/d/b/w', {
        params: {
          f: ecToken,
          s: appId,
          d: encodeURIComponent(compactJson({
            tsobj: { elid: fieldId, sid: appId, tst: appId, wsps: false, ts: tsObj, pf: { psu: false, val: false } },
          })),
        },
        headers,
      });
    } catch { /* optional */ }
    elapsed += 120 + Math.floor(Math.random() * 261);
  }
}

async function sendAnalyticsTs(session, pageName, baToken, {
  ecToken = '',
  userId = '',
  event = 'im',
  signals,
} = {}) {
  const ts = Date.now();
  const screen = signals?.screen || SCREEN;
  const viewport = signals?.viewport || VIEWPORT;
  const params = {
    v: '1.15.0',
    t: String(ts),
    g: '0',
    pgrp: 'main:billing:hagrid',
    page: pageName,
    pgtf: 'Nodejs',
    s: 'ci',
    env: 'live',
    comp: 'checkoutuinodeweb',
    tsrce: 'checkoutuinodeweb',
    cu: '1',
    ef_policy: 'ccpa',
    c_prefs: 'T=1,P=1,F=1,type=explicit_banner',
    pxpguid: crypto.randomBytes(16).toString('hex'),
    pgst: String(ts - (2000 + Math.floor(Math.random() * 3001))),
    calc: crypto.randomBytes(7).toString('hex').slice(0, 13),
    rsta: 'en_GB',
    ccpg: 'GB',
    cnac: 'GB',
    flnm: 'Hagrid',
    e: event,
    fpti_sdk_name: 'pa-js',
    cd: String(screen.colorDepth),
    sw: String(screen.width),
    sh: String(screen.height),
    bw: String(viewport.width),
    bh: String(viewport.height),
    ce: '1',
  };
  if (ecToken) params.fltk = ecToken;
  if (userId) {
    params.cust = userId;
    params.party_id = userId;
    params.acnt = 'personal';
    params.aver = 'unverified';
    params.rstr = 'unrestricted';
  }
  try {
    await session.get('https://t.paypal.com/ts', { params });
  } catch { /* optional */ }
}

async function sendObservabilityEmit(session, baToken) {
  try {
    await session.post(`https://www.paypal.com/pay/api/trpc/observability.handleClientEmit?token=${encodeURIComponent(baToken)}`, {
      body: '',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.paypal.com' },
    });
  } catch { /* optional */ }
}

async function sendWeasleyLog(session, ecToken, signupUrl, eventNames, { country = 'GB', lang = 'en' } = {}) {
  if (!ecToken || !eventNames?.length) return;
  const now = Date.now();
  const locale = `${lang}_${country}`;
  const events = eventNames.map((name, i) => ({
    level: 'info',
    event: name,
    payload: {
      clientCountry: country,
      clientLocale: locale,
      clientTimestamp: now + i,
      timestamp: String(now + i),
      token: ecToken,
    },
  }));
  try {
    await session.post('https://www.paypal.com/xoplatform/logger/api/logger/', {
      json: {
        events,
        meta: {
          integrationData: {
            contextId: ecToken,
            contextType: ecToken,
            integrationMethod: 'FULLPAGE',
            integrationType: 'EC',
          },
        },
        tracking: [],
        metrics: [],
      },
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.paypal.com',
        Referer: signupUrl,
        'X-Requested-With': 'fetch',
        'X-App-Name': 'checkoutuinodeweb_weasley',
      },
    });
  } catch { /* optional */ }
}

module.exports = {
  USER_AGENT,
  SCREEN,
  VIEWPORT,
  TEALEAF_APP_KEY,
  WEBGL_POOL,
  createDeviceSignals,
  buildFnSyncData,
  buildSignupFnSyncData,
  sendTealeafData,
  sendDeviceFingerprint,
  sendSignupFieldEvents,
  sendAnalyticsTs,
  sendObservabilityEmit,
  sendWeasleyLog,
};
