'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  SENTINEL_FRAME_REFERER, SENTINEL_URL,
} = require('./constants');
const {
  createSentinelState, requirementsToken, solveProof,
} = require('./sentinelPoW');
const { EXTRACT_PROFILE } = require('./constants');

const VM_DIR = path.join(__dirname, 'sentinel_vm');
const VM_SCRIPT = path.join(VM_DIR, 'gen_token.cjs');
const VM_SDK = path.join(VM_DIR, 'sentinel_sdk_full.js');

function vmAvailable() {
  return fs.existsSync(VM_SCRIPT) && fs.existsSync(VM_SDK);
}

function defaultSentinelPageUrl(flow) {
  if (flow === 'checkout_create' || flow === 'chatgpt_checkout') return 'https://chatgpt.com/';
  if (flow === 'checkout_session_approval') return 'https://chatgpt.com/checkout';
  return 'https://auth.openai.com/about-you';
}

function screenParts(screen) {
  const match = String(screen || '1920x1080').match(/(\d+)\s*[xX*]\s*(\d+)/);
  return {
    width: match ? Number(match[1]) : 1920,
    height: match ? Number(match[2]) : 1080,
  };
}

function runVm(data, reqProof, flow, state) {
  if (!vmAvailable()) return Promise.resolve({});
  const payload = {
    chatReq: data,
    cachedProof: reqProof,
    flow,
    deviceId: state.deviceId,
    userAgent: state.userAgent,
    pageUrl: state.pageUrl || defaultSentinelPageUrl(flow),
    fingerprint: {
      userAgent: state.userAgent,
      language: state.language,
      languages: state.languages,
      timezone: state.timezone,
      platform: state.platform,
      hardwareConcurrency: state.cores || 8,
      screen: screenParts(state.screen),
    },
  };
  const tmp = path.join(os.tmpdir(), `sentinel_vm_${process.pid}_${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VM_SCRIPT, tmp], {
      cwd: VM_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({});
    }, 35000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({});
    });
    child.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      try {
        const parsed = JSON.parse(String(out || '').trim() || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function fetchChallenge(session, state, flow) {
  const reqProof = requirementsToken(state);
  const headers = {
    'content-type': 'text/plain;charset=UTF-8',
    origin: 'https://sentinel.openai.com',
    referer: SENTINEL_FRAME_REFERER,
    'user-agent': state.userAgent || EXTRACT_PROFILE.user_agent,
  };
  if (state.deviceId) headers.cookie = `oai-did=${state.deviceId}`;
  const response = await session.request(SENTINEL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p: reqProof, id: state.deviceId, flow }),
    redirect: 'manual',
    timeout: 30000,
  });
  if (response.status !== 200) {
    throw new Error(`sentinel/req ${flow} HTTP ${response.status}`);
  }
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  if (!data.token) throw new Error(`sentinel/req ${flow} omitted challenge token`);
  return { data, reqProof };
}

function solveFromChallenge(state, data) {
  const proof = data?.proofofwork || {};
  if (!proof.required) return null;
  if (typeof proof.seed !== 'string' || typeof proof.difficulty !== 'string') {
    return solveProof(state, '', '');
  }
  return solveProof(state, proof.seed, proof.difficulty);
}

function encodeSentinelToken({ p, t, c, id, flow }) {
  const token = t
    ? { p, t, c, id, flow }
    : { p, c, id, flow };
  return JSON.stringify(token);
}

async function tokenBundle(session, state, flow) {
  const { data, reqProof } = await fetchChallenge(session, state, flow);
  const solved = solveFromChallenge(state, data);
  const challengeToken = String(data.token || '');
  const vm = await runVm(data, reqProof, flow, state);
  const tValue = typeof vm.t === 'string' && vm.t.length >= 40 ? vm.t : '';
  const soValue = typeof vm.so === 'string' ? vm.so : '';
  const sentinelToken = encodeSentinelToken({
    p: solved,
    t: tValue,
    c: challengeToken,
    id: state.deviceId,
    flow,
  });
  const soToken = soValue.length >= 40
    ? JSON.stringify({ so: soValue, c: challengeToken, id: state.deviceId, flow })
    : '';
  return { sentinelToken, soToken };
}

async function sentinelHeaders(session, state, flow) {
  const { sentinelToken, soToken } = await tokenBundle(session, state, flow);
  const headers = { 'openai-sentinel-token': sentinelToken };
  if (soToken) headers['openai-sentinel-so-token'] = soToken;
  return headers;
}

module.exports = {
  vmAvailable,
  createSentinelState,
  tokenBundle,
  sentinelHeaders,
};
