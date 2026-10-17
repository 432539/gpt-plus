'use strict';

/**
 * Corresponds to sentinel.py:mint_sentinel_sync.
 * Spawns the open-source sentinel_bridge.js (copied 1:1) under Node/V8.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_VERSION = '20260219f9f6';
const BRIDGE_JS = path.join(__dirname, 'sentinel_bridge.js');

function resolveNodeExecutable() {
  const candidate = String(process.env.SENTINEL_NODE || '').trim();
  return candidate || process.execPath;
}

function mintSentinelSync({
  flow,
  deviceId,
  userAgent,
  proxy = '',
  cores = 16,
  pageUrl = 'https://chatgpt.com/',
  language = 'en-US',
  timezone = 'America/New_York',
  cookieHeader = '',
  timeoutS = 120,
} = {}) {
  const payload = JSON.stringify({
    ua: userAgent,
    cores,
    deviceId,
    flow,
    proxy,
    version: BRIDGE_VERSION,
    pageUrl,
    language,
    timezone,
    cookieHeader,
    sentinelOrigin: 'https://chatgpt.com',
  });

  return new Promise((resolve, reject) => {
    const child = spawn(resolveNodeExecutable(), [BRIDGE_JS], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Sentinel 生成超时（>${timeoutS}s）`));
    }, Math.max(1, Number(timeoutS) || 120) * 1000);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (error && error.code === 'ENOENT') reject(new Error('Sentinel 需要 Node.js'));
      else reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      if (!output) {
        const error = Buffer.concat(stderr).toString('utf8').slice(0, 300);
        reject(new Error(`Sentinel bridge 无输出: ${error}`));
        return;
      }
      let result;
      try { result = JSON.parse(output); } catch {
        reject(new Error(`Sentinel bridge 输出无效: ${output.slice(0, 200)}`));
        return;
      }
      if (result.error) {
        reject(new Error(`Sentinel bridge 失败: ${String(result.error).slice(0, 300)}`));
        return;
      }
      const main = String(result.main || '');
      if (!main) {
        reject(new Error('Sentinel bridge 未返回 main token'));
        return;
      }
      let tokenPayload;
      try { tokenPayload = JSON.parse(main); } catch {
        reject(new Error('Sentinel bridge main token 不是有效 JSON'));
        return;
      }
      if (tokenPayload.id !== deviceId || tokenPayload.flow !== flow || !tokenPayload.c) {
        reject(new Error('Sentinel bridge token 与当前 device/flow 不匹配'));
        return;
      }
      resolve({ main, so: String(result.so || '') });
    });
    child.stdin.write(payload, () => child.stdin.end());
  });
}

module.exports = { mintSentinelSync, BRIDGE_VERSION };
