'use strict';

// 出码成功后把 PH sticky + curl_cffi 会话留在内存里，支付墙轮询/continue 复用。
// 不写磁盘，不把 AT / cookie / redirectUrl 打进日志。

const leases = new Map();

function leaseKey(userId, accountId) {
  return `${String(userId || '')}:${String(accountId || '')}`;
}

async function closeParkedH5(lease) {
  const h5 = lease?.h5;
  if (!h5) return;
  try {
    const { closeGcashH5 } = require('./gcashH5Screenshot');
    await closeGcashH5(h5);
  } catch {
    /* ignore */
  }
}

function parkGcashSession(userId, accountId, lease) {
  const key = leaseKey(userId, accountId);
  const previous = leases.get(key);
  if (previous?.session && previous.session !== lease?.session) {
    previous.session.close?.().catch(() => {});
  }
  if (previous?.h5 && previous.h5 !== lease?.h5) {
    closeParkedH5(previous).catch(() => {});
  }
  const parked = {
    session: lease?.session || null,
    proxy: lease?.proxy || null,
    auth: lease?.auth || null,
    checkout: lease?.checkout || null,
    cpmId: String(lease?.cpmId || ''),
    deviceId: String(lease?.deviceId || ''),
    sessionId: String(lease?.sessionId || ''),
    h5: lease?.h5 || null,
    parkedAt: Date.now(),
    qrIssuedAt: Date.now(),
    continueSubmitted: false,
    continueAttempted: false,
    continueStatus: 0,
    continueError: '',
    phase: 'monitor_active',
  };
  syncParkedH5Protocol(parked);
  leases.set(key, parked);
  return parked;
}

function syncParkedH5Protocol(lease) {
  const h5 = lease?.h5;
  if (!lease || !h5) return lease;
  if (!lease.auth || typeof lease.auth !== 'object') lease.auth = {};
  if (h5.consultUuid) lease.auth.consultUuid = h5.consultUuid;
  if (h5.tokenId) lease.auth.tokenId = h5.tokenId;
  if (h5.scanRedirectUrl) lease.scanRedirectUrl = h5.scanRedirectUrl;
  return lease;
}

function getGcashSession(userId, accountId) {
  return leases.get(leaseKey(userId, accountId)) || null;
}

function markGcashQrRefreshed(userId, accountId) {
  const lease = getGcashSession(userId, accountId);
  if (lease) {
    lease.qrIssuedAt = Date.now();
    lease.phase = 'monitor_active';
  }
  return lease;
}

function markGcashContinueSubmitted(userId, accountId) {
  const lease = getGcashSession(userId, accountId);
  if (lease) {
    lease.continueSubmitted = true;
    lease.continueAttempted = true;
    lease.continueError = '';
    lease.phase = 'continue_ok';
  }
  return lease;
}

function markGcashContinueFailed(userId, accountId, message = '') {
  const lease = getGcashSession(userId, accountId);
  if (lease) {
    lease.continueSubmitted = false;
    lease.continueAttempted = true;
    lease.continueError = String(message || 'continue_failed');
    lease.phase = 'continue_failed';
  }
  return lease;
}

async function releaseGcashSession(userId, accountId) {
  const key = leaseKey(userId, accountId);
  const lease = leases.get(key);
  leases.delete(key);
  await closeParkedH5(lease);
  if (lease?.session?.close) await lease.session.close().catch(() => {});
  return true;
}

function gcashSessionPhase(userId, accountId) {
  return getGcashSession(userId, accountId)?.phase || '';
}

module.exports = {
  parkGcashSession,
  getGcashSession,
  syncParkedH5Protocol,
  markGcashQrRefreshed,
  markGcashContinueSubmitted,
  markGcashContinueFailed,
  releaseGcashSession,
  gcashSessionPhase,
};
