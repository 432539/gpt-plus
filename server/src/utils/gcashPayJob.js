'use strict';

const opLog = require('./opLog');
const { createLiveJob } = require('./accountLiveJob');
const {
  markPaying, markPaid, clearGcashExtract, updateGcashQrImage, extractLinkState, accountChannelOf, parseStamp, PROGRESS,
} = require('./accountProgress');
const { loadPhProxies } = require('./phProxy');
const { detectViaToken } = require('./accountJob');
const { isPaidPlan } = require('./accountCheck');
const {
  GCASH_POLL_INTERVAL_MS,
  GCASH_QR_TTL_MS,
  GCASH_URL_TTL_MS,
  pollGcashScan,
  followScanRedirect,
  consultGcashQr,
  redirectFlag,
  remainingTtlMs,
  qrNeedsRefresh,
  buildGcashContinueRequest,
  isGcashAuthPage,
  protocolSuccessFlag,
} = require('./gcashProtocol');
const {
  getGcashSession,
  syncParkedH5Protocol,
  markGcashQrRefreshed,
  markGcashContinueSubmitted,
  markGcashContinueFailed,
  releaseGcashSession,
} = require('./gcashSessionStore');
const {
  readGcashH5Callback,
  waitForGcashH5Callback,
  isParkedH5Alive,
  followScanRedirectInPage,
  submitGcashContinueInPage,
  ingestH5ScanProgress,
  h5UrlKind,
  h5LeftGcashAuth,
  gcashH5PageUrl,
} = require('./gcashH5Screenshot');
const { gcashConcurrencyCap, gcashJobConcurrency } = require('./gcashConcurrency');

function gcashPayMonitorLimit() {
  return gcashConcurrencyCap();
}

const monitorReservations = new Map();
const qrRefreshLocks = new Map();
const GCASH_BATCH_REFRESH_CONCURRENCY = 20;
const GCASH_BATCH_REFRESH_WINDOW_MS = 30 * 1000;

function refreshLockKey(userId, accountId) {
  return `${String(userId)}:${String(accountId)}`;
}

function scanWorkInFlight(lease) {
  const callback = readGcashH5Callback(lease?.h5);
  return Boolean(
    lease?.continueInFlight
    || lease?.continueAttempted
    || lease?.continueSubmitted
    || lease?.h5?.scanComplete
    || lease?.h5?.scanRedirectUrl
    || callback?.kind === 'verify'
    || callback?.kind === 'success'
    || callback?.kind === 'adyen'
    || h5LeftGcashAuth(lease?.h5),
  );
}

function refreshCapability(lease) {
  if (!lease) return { ok: false, code: 'SESSION_MISSING', message: '会话已失效，需要新号重新出码' };
  if (scanWorkInFlight(lease)) {
    return { ok: false, code: 'SCAN_IN_FLIGHT', message: '已扫码，正在处理，不能刷新二维码' };
  }
  if (!lease.session || !lease.auth?.ready) {
    return { ok: false, code: 'SESSION_MISSING', message: '会话已失效，需要新号重新出码' };
  }
  if (lease.h5 && !isParkedH5Alive(lease.h5)) {
    return { ok: false, code: 'SESSION_MISSING', message: 'Playwright H5 已关闭，会话已失效，需要新号重新出码' };
  }
  if (lease.h5) {
    let currentUrl = '';
    try {
      currentUrl = String(lease.h5.currentUrl?.() || lease.h5.page?.url?.() || '');
    } catch {
      currentUrl = '';
    }
    if (!isGcashAuthPage(currentUrl)) {
      return { ok: false, code: 'SCAN_IN_FLIGHT', message: 'H5 已离开 GCash，支付已进入处理阶段，不能刷新二维码' };
    }
  }
  return { ok: true, code: '', message: '' };
}

function reservationSet(userId) {
  let set = monitorReservations.get(userId);
  if (!set) {
    set = new Set();
    monitorReservations.set(userId, set);
  }
  return set;
}

function reserveGcashPayMonitor(userId, accountId) {
  const id = Number(accountId);
  if (!userId || !Number.isInteger(id) || id <= 0) return { ok: false, reason: 'bad_id' };
  const running = job.status(userId);
  if ((running.ids || []).some((item) => Number(item) === id)) {
    return { ok: true, already_owned: true };
  }
  const reserved = reservationSet(userId);
  if (reserved.has(id)) return { ok: true, already_reserved: true };
  const occupied = new Set((running.ids || []).map(Number).filter(Number.isInteger)).size + reserved.size;
  if (occupied >= gcashPayMonitorLimit()) {
    return { ok: false, reason: 'slot_unavailable', occupied, limit: gcashPayMonitorLimit() };
  }
  reserved.add(id);
  return { ok: true, reserved: true, occupied: occupied + 1, limit: gcashPayMonitorLimit() };
}

function releaseGcashPayMonitorReservation(userId, accountId) {
  const set = monitorReservations.get(userId);
  if (!set) return false;
  const removed = set.delete(Number(accountId));
  if (!set.size) monitorReservations.delete(userId);
  return removed;
}

async function confirmGcashPaid(userId, id, proxy) {
  const result = await detectViaToken(userId, id, { proxy, trialOnly: false });
  if (isPaidPlan(result?.plan_type) || result?.plan_type === 'Plus' || result?.plan_type === 'Pro') {
    return { paid: true, plan_type: result.plan_type, expires_at: result.expires_at || '' };
  }
  return { paid: false, plan_type: result?.plan_type || '', expires_at: '' };
}

function payLog(userId, email, runId, message, level = 'info') {
  opLog.activate(userId, level, `${email || ''}：${message}`, {
    source: 'gcash-pay',
    run_id: runId,
  });
}

async function refreshParkedQr(userId, id, lease, emit) {
  const key = refreshLockKey(userId, id);
  if (qrRefreshLocks.has(key)) return qrRefreshLocks.get(key);
  const work = (async () => {
    const capability = refreshCapability(lease);
    if (!capability.ok) {
      emit?.('qr', capability.message);
      return { ok: false, refreshed: false, refreshable: false, ...capability };
    }
    lease.refreshing = true;
    lease.refreshError = '';
    const previousUuid = String(lease.auth.consultUuid || '').trim();
    const nextAuth = { ...lease.auth };
    emit?.('qr', '正在用同一会话重新 consult 并同步新 UUID。');
    try {
      const consulted = await consultGcashQr(lease.session, nextAuth, emit);
      const qr = String(consulted?.qr || '').trim();
      const nextUuid = String(consulted?.uuid || nextAuth.consultUuid || '').trim();
      if (!qr || !nextUuid || nextUuid === previousUuid) {
        lease.refreshError = '刷新未得到新的二维码与 UUID';
        emit?.('qr', '刷新未同时得到新二维码与新 UUID，旧码不再作为可扫二维码展示。');
        return { ok: false, refreshed: false, refreshable: true, code: 'REFRESH_FAILED', message: lease.refreshError };
      }
      updateGcashQrImage(userId, id, qr);
      lease.auth.consultUuid = nextUuid;
      if (nextAuth.tokenId) lease.auth.tokenId = nextAuth.tokenId;
      if (lease.h5) {
        lease.h5.consultUuid = nextUuid;
        if (nextAuth.tokenId) lease.h5.tokenId = nextAuth.tokenId;
      }
      markGcashQrRefreshed(userId, id);
      lease.refreshError = '';
      emit?.('qr', '协议二维码与 query.result UUID 已原子刷新，倒计时重置为 5:00。');
      return { ok: true, refreshed: true, refreshable: true, qr };
    } catch (error) {
      lease.refreshError = '二维码刷新失败';
      return { ok: false, refreshed: false, refreshable: true, code: 'REFRESH_FAILED', message: lease.refreshError };
    } finally {
      lease.refreshing = false;
    }
  })();
  qrRefreshLocks.set(key, work);
  try {
    return await work;
  } finally {
    if (qrRefreshLocks.get(key) === work) qrRefreshLocks.delete(key);
  }
}

async function maybeRefreshParkedQr(userId, id, lease, emit, now = Date.now()) {
  if (scanWorkInFlight(lease)) {
    emit?.('qr', '扫码进行中，保持当前 query.result UUID，不刷新二维码');
    return { ok: true, refreshed: false, skipped: true, code: 'SCAN_IN_FLIGHT' };
  }
  if (!qrNeedsRefresh(lease?.qrIssuedAt || lease?.parkedAt, now, GCASH_QR_TTL_MS)) {
    return { ok: true, refreshed: false };
  }
  return refreshParkedQr(userId, id, lease, emit);
}

function h5ContinueHttp(lease) {
  return Number(lease?.h5?.browserContinueHttp || 0);
}

function h5ContinueOk(lease) {
  const http = h5ContinueHttp(lease);
  return Boolean(lease?.h5?.browserContinueSeen && http > 0 && http < 400);
}

function h5ContinueFailed(lease) {
  return Boolean(lease?.h5?.browserContinueSeen && h5ContinueHttp(lease) >= 400);
}

function shouldPollEntitlement(lease) {
  if (!lease?.session) return true;
  return Boolean(
    lease.continueSubmitted
    || h5ContinueOk(lease)
    || scanWorkInFlight(lease)
  );
}

function rememberH5ScanComplete(lease, redirectUrl) {
  if (!lease?.h5) return;
  lease.h5.scanComplete = true;
  const redirect = String(redirectUrl || '').trim();
  if (redirect) lease.h5.scanRedirectUrl = redirect;
}

function beginContinueWork(lease) {
  if (!lease || lease.continueInFlight) return false;
  lease.continueInFlight = true;
  return true;
}

function endContinueWork(lease) {
  if (lease) lease.continueInFlight = false;
}

function rememberVerifyHit(lease, hit) {
  if (!lease || !hit) return hit;
  if (hit.verifyUrl) lease.verifyUrl = hit.verifyUrl;
  if (hit.redirectResult) lease.redirectResult = hit.redirectResult;
  if (hit.checkoutSessionId) lease.checkoutSessionId = hit.checkoutSessionId;
  return hit;
}

function continueFailureDetail(result) {
  const status = Number(result?.status || result?.continueStatus || 0);
  const keys = Array.isArray(result?.body_keys) ? result.body_keys.join(',') : '';
  const code = String(result?.error_code || '').trim();
  return `HTTP ${status}${keys ? ` keys=[${keys}]` : ''}${code ? ` code=${code}` : ''}`;
}

async function finishH5Success(userId, id, lease, emit, message) {
  emit?.('pay', message);
  markGcashContinueSubmitted(userId, id);
  return { complete: true, continue_ok: true, source: 'h5-success' };
}

async function finishH5ContinueFailure(userId, id, lease, emit, source, result) {
  try { await lease?.h5?.browserContinueDetailPromise; } catch { /* safe status-only fallback */ }
  const detail = continueFailureDetail(
    result
    || lease?.h5?.browserContinueError
    || { status: h5ContinueHttp(lease) || lease?.continueStatus || 0 },
  );
  markGcashContinueFailed(userId, id, detail);
  emit?.('pay', `扫码已完成但真实 continue 回调失败：${detail}，未计次；Playwright 保持打开`);
  return { complete: true, continue_ok: false, continue_failed: true, source };
}

async function submitParkedContinue(userId, id, detail, lease, emit, options = {}) {
  if (lease?.continueSubmitted) return { ok: true, skipped: true };
  if (lease?.continueAttempted) {
    return { ok: false, skipped: true, status: Number(lease.continueStatus || 0) };
  }
  const checkout = lease?.checkout || { cs_id: detail?.gcash_cs_id };
  const built = buildGcashContinueRequest({
    checkoutSessionId: options.checkoutSessionId || checkout?.cs_id,
    customPaymentMethodTypeId: lease?.cpmId,
    redirectResult: options.redirectResult || lease?.redirectResult,
    verifyUrl: options.verifyUrl || lease?.verifyUrl,
  });
  if (isParkedH5Alive(lease?.h5)) {
    const result = await submitGcashContinueInPage(lease.h5, built, emit);
    if (result?.skipped) return result;
    lease.continueAttempted = true;
    lease.continueStatus = Number(result?.status || 0);
    if (result.ok) markGcashContinueSubmitted(userId, id);
    else markGcashContinueFailed(userId, id, continueFailureDetail(result));
    return result;
  }
  emit?.('pay', '当前没有同一浏览器 verify 会话，不用 HTTP/curl 伪造动态头抢发 continue');
  return { ok: false, skipped: true, status: 0 };
}

async function followAndContinue(userId, id, detail, lease, emit, redirectUrl, source) {
  const followed = await followScanRedirect(lease.session, redirectUrl, emit);
  rememberVerifyHit(lease, followed);
  const continued = await submitParkedContinue(userId, id, detail, lease, emit, followed || {});
  if (continued.skipped) {
    return { complete: false, continue_ok: false, source };
  }
  if (!continued.ok) {
    emit?.('pay', `扫码已完成但真实 continue 回调失败：${continueFailureDetail(continued)}，未计次`);
    return { complete: true, continue_ok: false, continue_failed: true, source };
  }
  emit?.('pay', 'GCash 扫码已完成，真实 continue 回调成功');
  return { complete: true, continue_ok: true, source };
}

async function waitForH5ContinueOrFallback(userId, id, detail, lease, emit, verifyHit, source) {
  rememberVerifyHit(lease, verifyHit);
  if (lease?.continueSubmitted || h5ContinueOk(lease)) {
    return finishH5Success(
      userId,
      id,
      lease,
      emit,
      lease?.h5?.browserContinueSeen
        ? `浏览器已 POST continue（HTTP ${h5ContinueHttp(lease)}），未另打 curl continue`
        : 'Playwright 已落到支付成功页（H5 自己完成回跳）',
    );
  }
  if (h5ContinueFailed(lease) || lease?.continueAttempted) {
    return finishH5ContinueFailure(userId, id, lease, emit, source, {
      status: h5ContinueHttp(lease) || lease.continueStatus || 0,
    });
  }
  const waitMs = Number.isFinite(Number(lease?.h5SuccessWaitMs))
    ? Number(lease.h5SuccessWaitMs)
    : 12000;
  emit?.('pay', 'Playwright 已落到 /checkout/verify，等待页面用登录态自己 continue');
  const waited = await waitForGcashH5Callback(lease.h5, { timeoutMs: waitMs });
  rememberVerifyHit(lease, waited);
  if (h5ContinueOk(lease)) {
    return finishH5Success(
      userId,
      id,
      lease,
      emit,
      lease?.h5?.browserContinueSeen
        ? `浏览器已 POST continue（HTTP ${h5ContinueHttp(lease)}），未另打 curl continue`
        : 'Playwright 已从 verify 跳到支付成功页',
    );
  }
  if (h5ContinueFailed(lease)) {
    emit?.('pay', `浏览器已 POST continue（HTTP ${h5ContinueHttp(lease)}），未另打 curl continue`);
    return finishH5ContinueFailure(userId, id, lease, emit, source, {
      status: h5ContinueHttp(lease),
    });
  }
  emit?.('pay', 'verify 页未自行跳到成功页，改用同一登录态 POST continue');
  const continued = await submitParkedContinue(userId, id, detail, lease, emit, waited || verifyHit || {});
  if (continued.skipped) {
    let diagnostic = null;
    try { diagnostic = await lease?.h5?.verifyDiagnostics?.(); } catch { diagnostic = null; }
    if (diagnostic) {
      emit?.(
        'pay',
        `verify诊断 kind=${diagnostic.url_kind} ready=${diagnostic.ready_state || 'unknown'} scripts=${diagnostic.script_count} app_root=${diagnostic.has_app_root} console_errors=${diagnostic.console_errors} page_errors=${diagnostic.page_errors}`,
      );
    }
    emit?.('pay', 'verify 页尚未发出可重试的真实 continue；继续保留页面等待，不用裸 fetch/curl 抢发');
    return { complete: false, continue_ok: false, source };
  }
  if (!continued.ok) {
    return finishH5ContinueFailure(userId, id, lease, emit, source, continued);
  }
  emit?.('pay', 'GCash 扫码已完成，真实 continue 回调成功；Playwright 保持打开直到支付成功');
  return { complete: true, continue_ok: true, source };
}

async function waitForNaturalH5Return(userId, id, detail, lease, emit, source) {
  const existing = readGcashH5Callback(lease.h5);
  if (existing?.kind === 'success' || existing?.kind === 'verify' || lease.h5?.browserContinueSeen) {
    return waitForH5ContinueOrFallback(userId, id, detail, lease, emit, existing, source);
  }
  const waitMs = Number.isFinite(Number(lease?.h5SuccessWaitMs))
    ? Number(lease.h5SuccessWaitMs)
    : 8000;
  const landed = await followScanRedirectInPage(lease.h5, '', emit, { timeoutMs: waitMs });
  rememberVerifyHit(lease, landed);
  if (landed?.kind === 'success' || landed?.kind === 'verify' || lease.h5?.browserContinueSeen) {
    return waitForH5ContinueOrFallback(userId, id, detail, lease, emit, landed, source);
  }
  emit?.('pay', '同一 Playwright 页尚未落到 /checkout/verify，本轮不抢发 continue');
  return { complete: false, continue_ok: false, source };
}

async function pollParkedScan(userId, id, detail, lease, emit, options = {}) {
  if (lease?.continueSubmitted) {
    return { complete: false, continue_ok: true };
  }
  syncParkedH5Protocol(lease);
  await ingestH5ScanProgress(lease?.h5, emit, { id });
  const h5Hit = readGcashH5Callback(lease?.h5);
  if (h5ContinueOk(lease)) {
    return finishH5Success(
      userId,
      id,
      lease,
      emit,
      lease?.h5?.browserContinueSeen
        ? `Playwright 登录态已自己 POST continue（HTTP ${h5ContinueHttp(lease)}）`
        : 'Playwright 已落到支付成功页（H5 自己完成回跳）',
    );
  }
  if (h5ContinueFailed(lease)) {
    return finishH5ContinueFailure(userId, id, lease, emit, 'h5-continue', {
      status: h5ContinueHttp(lease),
    });
  }
  if (h5Hit?.kind === 'verify' || h5Hit?.kind === 'adyen') {
    if (!beginContinueWork(lease)) return { complete: false, continue_ok: false };
    try {
      if (h5Hit.kind === 'adyen') {
        emit?.('pay', 'Playwright 已落到 Adyen 回跳页，等待页面自行回跳 /checkout/verify');
        return await waitForNaturalH5Return(userId, id, detail, lease, emit, 'h5-adyen');
      }
      return await waitForH5ContinueOrFallback(userId, id, detail, lease, emit, h5Hit, 'h5-verify');
    } finally {
      endContinueWork(lease);
    }
  }
  if (isParkedH5Alive(lease?.h5) && lease.h5.scanComplete && lease.h5.scanRedirectUrl) {
    if (!beginContinueWork(lease)) return { complete: false, continue_ok: false };
    emit?.('pay', 'Playwright 已截到 GCash query.result 扫码完成，等待页面自行回跳');
    try {
      return await waitForNaturalH5Return(userId, id, detail, lease, emit, 'h5-rpc');
    } finally {
      endContinueWork(lease);
    }
  }
  if (!lease?.session || !lease.auth?.ready) {
    return { complete: false, continue_ok: false };
  }
  const polled = await pollGcashScan(lease.session, lease.auth, emit);
  emit?.('pay', `协议轮询 keys=[${(polled.keys || []).join(',')}]，rpc_ok=${protocolSuccessFlag(polled.payload) ? 'true' : 'false'}，redirect=${polled.complete ? '有' : redirectFlag(polled.payload)}，h5=${h5UrlKind(gcashH5PageUrl(lease?.h5))}`);
  if (polled.complete) {
    rememberH5ScanComplete(lease, polled.redirectUrl);
    if (!beginContinueWork(lease)) return { ...polled, complete: false, continue_ok: false };
    try {
      if (isParkedH5Alive(lease.h5)) {
        emit?.('pay', '协议轮询检测到扫码完成，等待同一 Playwright 页自行回跳');
        return await waitForNaturalH5Return(userId, id, detail, lease, emit, 'protocol');
      }
      const continued = await followAndContinue(userId, id, detail, lease, emit, polled.redirectUrl, 'protocol');
      return { ...polled, ...continued };
    } finally {
      endContinueWork(lease);
    }
  }
  if (!options.skipRefresh) await maybeRefreshParkedQr(userId, id, lease, emit);
  return { ...polled, continue_ok: false };
}

const job = createLiveJob({
  kind: 'gcash-pay',
  source: 'gcash-pay',
  log: opLog.activate,
  requireIds: true,
  allowEnqueue: true,
  onFinish({ userId }) {
    try { require('./accountGcPipeline').kick(userId); } catch { /* optional */ }
  },
  configure({ user, body }) {
    const cap = gcashConcurrencyCap();
    return {
      body: { ...body, proxy_group: '__auto__:PH' },
      maxConcurrency: cap,
      defaultConcurrency: gcashJobConcurrency(body),
      requireProxy: true,
      skipCloak: true,
      proxies: loadPhProxies(user.id, Math.max(1, Number(body.concurrency) || cap)),
    };
  },
  async runOne({ user, id, row, detail, nextProxy, state }) {
    if (accountChannelOf(row) !== 'gc') {
      throw Object.assign(new Error('该账号不是 GC 通道，已跳过'), { code: 'ACCOUNT_CHANNEL_MISMATCH', skip: true });
    }
    const linkState = extractLinkState(row);
    if (linkState === 'expired') {
      clearGcashExtract(user.id, id);
      await releaseGcashSession(user.id, id);
      throw Object.assign(new Error('GCash 二维码已过期，已清 gcash_*，请重新提链'), {
        code: 'GCASH_QR_EXPIRED', skip: true,
      });
    }
    if (linkState !== 'valid') {
      throw Object.assign(new Error('该账号还没有有效的 GCash 二维码'), { code: 'GCASH_QR_MISSING', skip: true });
    }
    markPaying(user.id, id);
    const proxy = nextProxy();
    let lease = getGcashSession(user.id, id);
    const urlStart = Number(lease?.parkedAt || Date.now());
    const deadline = urlStart + GCASH_URL_TTL_MS;
    const emit = (step, message) => {
      payLog(user.id, detail?.email || id, state.run_id, String(message).slice(0, 240));
    };
    emit('pay', lease?.h5
      ? '支付墙等待 GCash 扫码；Playwright H5 保持打开直到支付成功以捕获回跳；码 5 分钟刷新，链接 24 小时有效'
      : (lease?.session
        ? '支付墙等待 GCash 扫码，协议轮询保持同一登录态；码 5 分钟刷新，链接 24 小时有效'
        : '支付墙等待 GCash 扫码（出码会话已不在，仍用 AT 检测 Plus）'));
    while (!state.stop && Date.now() < deadline) {
      lease = getGcashSession(user.id, id);
      if (lease?.session) {
        try {
          const scanned = await pollParkedScan(user.id, id, detail, lease, emit);
          if (scanned.continue_failed) {
            throw Object.assign(new Error('扫码后真实 continue 回调失败，未计次'), {
              code: 'GCASH_CONTINUE_FAILED',
            });
          }
        } catch (error) {
          if (error?.code === 'GCASH_CONTINUE_FAILED' || error?.code === 'JOB_CANCELLED') throw error;
        }
      }
      const confirm = shouldPollEntitlement(lease)
        ? await confirmGcashPaid(user.id, id, proxy)
        : { paid: false, plan_type: '', expires_at: '' };
      if (confirm.paid) {
        markPaid(user.id, id, {
          plan_type: confirm.plan_type || 'Plus',
          expires_at: confirm.expires_at || '',
          extract_link: row.extract_link || '',
          extracted_at: row.extracted_at || '',
        });
        try { require('./accountGcPipeline').notePaidForRt(user.id, id); } catch { /* optional */ }
        await releaseGcashSession(user.id, id);
        emit('pay', lease?.continueSubmitted
          ? 'GCash 扫码开通成功'
          : '已检测到 Plus 权益到账');
        return confirm;
      }
      await new Promise((resolve) => setTimeout(resolve, lease && !lease.continueSubmitted
        ? GCASH_POLL_INTERVAL_MS
        : 4000));
    }
    if (state.stop) throw Object.assign(new Error('任务已取消'), { code: 'JOB_CANCELLED' });
    throw Object.assign(new Error('支付链接已满 24 小时，会话仍保留到支付墙关闭'), {
      code: 'GCASH_PAY_TIMEOUT', skip: true,
    });
  },
});

function paywallView(row, userId, options = {}) {
  const { toDetail } = require('./accountFields');
  const detail = options.detail || toDetail(row);
  const now = Number(options.now || Date.now());
  const lease = getGcashSession(userId, row.id);
  const linkState = extractLinkState(detail, now);
  const paid = options.paid != null
    ? Boolean(options.paid)
    : Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID;
  const extractedAt = parseStamp(detail.gcash_extracted_at) || 0;
  const qrIssuedAt = Number(lease?.qrIssuedAt || lease?.parkedAt || extractedAt || 0);
  const urlStart = Number(lease?.parkedAt || extractedAt || 0);
  const qrRemaining = remainingTtlMs(qrIssuedAt, GCASH_QR_TTL_MS, now);
  const urlRemaining = remainingTtlMs(urlStart, GCASH_URL_TTL_MS, now);
  const capability = refreshCapability(lease);
  const processing = !paid && (scanWorkInFlight(lease) || capability.code === 'SCAN_IN_FLIGHT');
  const expired = linkState === 'expired' || urlRemaining <= 0;
  const qrValue = String(detail.gcash_qr || '');
  const scannable = Boolean(qrValue && !paid && !expired && !processing && qrRemaining > 0 && capability.ok);
  let status = 'waiting_scan';
  if (paid) status = 'plus';
  else if (expired) status = 'expired';
  else if (lease?.continueSubmitted) status = 'continue_success';
  else if (processing) status = 'processing';
  else if (lease?.refreshError) status = 'refresh_failed';
  else if (!capability.ok || qrRemaining <= 0) status = 'refresh_failed';
  return {
    id: Number(row.id),
    email: String(detail.email || ''),
    paid,
    expired,
    qr: scannable ? qrValue : '',
    link: options.includeLink ? String(detail.gcash_link || '') : undefined,
    link_available: Boolean(detail.gcash_link),
    progress: paid ? PROGRESS.PAID : row.progress,
    phase: paid ? 'paid' : (lease?.phase || 'monitor_active'),
    status,
    scannable,
    processing,
    refreshable: Boolean(!paid && !expired && capability.ok),
    refresh_code: capability.ok ? '' : capability.code,
    refresh_message: capability.ok ? String(lease?.refreshError || '') : capability.message,
    refreshing: Boolean(lease?.refreshing || qrRefreshLocks.has(refreshLockKey(userId, row.id))),
    continue_submitted: Boolean(lease?.continueSubmitted),
    continue_error: String(lease?.continueError || ''),
    h5_alive: isParkedH5Alive(lease?.h5),
    h5_url_kind: h5UrlKind(gcashH5PageUrl(lease?.h5)),
    has_consult_uuid: Boolean(lease?.auth?.consultUuid || lease?.h5?.consultUuid),
    qr_ttl_ms: GCASH_QR_TTL_MS,
    qr_remaining_ms: qrRemaining,
    url_ttl_ms: GCASH_URL_TTL_MS,
    url_remaining_ms: urlRemaining,
    monitoring: Boolean(lease?.session || lease?.h5) && !paid,
  };
}

function gcashWallRows(userId) {
  const db = require('../db');
  const rows = db.prepare(
    `SELECT * FROM gpt_accounts
     WHERE user_id = ? AND COALESCE(channel, 'gb') = 'gc'
     ORDER BY id ASC`,
  ).all(userId);
  return rows.filter((row) => {
    if (Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID) return false;
    const detail = require('./accountFields').toDetail(row);
    return extractLinkState(detail) === 'valid' && Boolean(detail.gcash_qr || detail.gcash_link);
  });
}

function wallScanLog(userId, email, id, message) {
  const text = String(message || '');
  if (/continue|verify|扫码已完成|query\.result|redirect=/.test(text)) {
    payLog(userId, email || id, '', text);
  }
}

async function tickParkedWallRow(userId, row) {
  const { toDetail } = require('./accountFields');
  const detail = toDetail(row);
  const lease = getGcashSession(userId, row.id);
  if (!lease) return;
  if (extractLinkState(detail) !== 'valid') return;
  try {
    await pollParkedScan(userId, row.id, detail, lease, (_step, message) => {
      wallScanLog(userId, detail?.email, row.id, message);
    }, { skipRefresh: true });
  } catch {
    /* keep waiting */
  }
  const latest = getGcashSession(userId, row.id);
  if (!shouldPollEntitlement(latest)) return;
  try {
    const confirm = await module.exports.confirmGcashPaid(userId, row.id, latest.proxy);
    if (!confirm.paid) return;
    markPaid(userId, row.id, {
      plan_type: confirm.plan_type || 'Plus',
      expires_at: confirm.expires_at || '',
      extract_link: row.extract_link || '',
      extracted_at: row.extracted_at || '',
    });
    try { require('./accountGcPipeline').notePaidForRt(userId, row.id); } catch { /* optional */ }
    await releaseGcashSession(userId, row.id);
    wallScanLog(userId, detail?.email, row.id, '已检测到 Plus 权益到账');
  } catch {
    /* keep waiting */
  }
}

async function ensureWallPayMonitors(userId, accountIds) {
  const ids = [...new Set((accountIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return { skipped: true };
  try {
    return await job.start({ id: userId }, {
      ids,
      concurrency: gcashConcurrencyCap(),
      channel: 'gc',
    });
  } catch {
    return { skipped: true };
  }
}

async function paywallWall(userId) {
  const rows = gcashWallRows(userId);
  const parkedIds = rows.filter((row) => getGcashSession(userId, row.id)).map((row) => row.id);
  await ensureWallPayMonitors(userId, parkedIds);
  await Promise.all(rows.map((row) => tickParkedWallRow(userId, row)));
  const now = Date.now();
  return {
    items: gcashWallRows(userId)
      .map((row) => paywallView(row, userId, { now }))
      .sort((a, b) => a.qr_remaining_ms - b.qr_remaining_ms || a.id - b.id),
    polled_at: now,
  };
}

function ownedGcashRow(userId, id) {
  const db = require('../db');
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw Object.assign(new Error('记录不存在'), { status: 404, code: 'NOT_FOUND' });
  if (accountChannelOf(row) !== 'gc') {
    throw Object.assign(new Error('该账号不是 GC 通道'), { status: 400, code: 'ACCOUNT_CHANNEL_MISMATCH' });
  }
  return row;
}

async function refreshPaywallQr(userId, id, options = {}) {
  const row = ownedGcashRow(userId, id);
  const detail = require('./accountFields').toDetail(row);
  if (extractLinkState(detail) !== 'valid') {
    throw Object.assign(new Error('支付链接已过期，需要新号重新出码'), { status: 409, code: 'LINK_EXPIRED' });
  }
  if (Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID) {
    throw Object.assign(new Error('该账号已完成支付'), { status: 409, code: 'ALREADY_PAID' });
  }
  const lease = getGcashSession(userId, id);
  const capability = refreshCapability(lease);
  if (!capability.ok) {
    throw Object.assign(new Error(capability.message), { status: 409, code: capability.code });
  }
  const result = await refreshParkedQr(userId, Number(id), lease);
  const fresh = ownedGcashRow(userId, id);
  return { ...result, item: paywallView(fresh, userId, { includeLink: Boolean(options.includeLink) }) };
}

async function refreshPaywallWall(userId) {
  const candidates = gcashWallRows(userId).filter((row) => {
    const view = paywallView(row, userId);
    return view.refreshable
      && !view.processing
      && view.qr_remaining_ms <= GCASH_BATCH_REFRESH_WINDOW_MS;
  });
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const row = candidates[cursor++];
      try {
        const result = await refreshPaywallQr(userId, row.id);
        results.push({ id: row.id, ok: Boolean(result.ok), refreshed: Boolean(result.refreshed), code: result.code || '' });
      } catch (error) {
        results.push({ id: row.id, ok: false, refreshed: false, code: error.code || 'REFRESH_FAILED' });
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(GCASH_BATCH_REFRESH_CONCURRENCY, candidates.length) },
    () => worker(),
  ));
  return {
    requested: candidates.length,
    refreshed: results.filter((item) => item.refreshed).length,
    results,
    ...await paywallWall(userId),
  };
}

async function payStatus(userId, id) {
  const db = require('../db');
  const { toDetail } = require('./accountFields');
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw Object.assign(new Error('记录不存在'), { status: 404 });
  if (accountChannelOf(row) !== 'gc') {
    throw Object.assign(new Error('该账号不是 GC 通道'), { status: 400, code: 'ACCOUNT_CHANNEL_MISMATCH' });
  }
  const detail = toDetail(row);
  const state = extractLinkState(detail);
  if (state === 'expired') {
    clearGcashExtract(userId, id);
    await releaseGcashSession(userId, id);
    return { paid: false, expired: true, qr: '', link: '', cs_id: '' };
  }
  let paid = Boolean(String(row.activated_at || '').trim()) || row.progress === PROGRESS.PAID;
  const lease = getGcashSession(userId, id);
  if (!paid && state === 'valid' && lease) {
    try {
      await pollParkedScan(userId, id, detail, lease, (_step, message) => {
        const text = String(message || '');
        if (/continue|verify|扫码已完成|query\.result|redirect=/.test(text)) {
          payLog(userId, detail?.email || id, '', text);
        }
      });
    } catch {
      /* keep waiting */
    }
  }
  const fresh = db.prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?').get(id, userId);
  const latest = toDetail(fresh || row);
  if (!paid && state === 'valid' && latest.gcash_cs_id && shouldPollEntitlement(lease)) {
    try {
      const proxy = loadPhProxies(userId, 1)[0];
      const confirm = await confirmGcashPaid(userId, id, proxy);
      if (confirm.paid) {
        markPaid(userId, id, {
          plan_type: confirm.plan_type || 'Plus',
          expires_at: confirm.expires_at || '',
          extract_link: row.extract_link || '',
          extracted_at: row.extracted_at || '',
        });
        await releaseGcashSession(userId, id);
        paid = true;
      }
    } catch {
      /* keep waiting */
    }
  }
  return {
    ...paywallView(fresh || row, userId, { paid, includeLink: true }),
    cs_id: latest.gcash_cs_id || detail.gcash_cs_id || '',
  };
}

function ensureGcashPayMonitor(user, accountId) {
  const id = Number(accountId);
  if (!user?.id || !Number.isInteger(id) || id <= 0) {
    return Promise.resolve({ skipped: true, reason: 'bad_id' });
  }
  return job.start(user, { ids: [id], channel: 'gc' }).catch((error) => {
    opLog.activate(user.id, 'warning', `${id}：支付墙监控未能启动：${String(error?.message || error).slice(0, 160)}`, {
      source: 'gcash-pay',
    });
    return { skipped: true, error: true };
  });
}

async function activateReservedGcashPayMonitor(user, accountId) {
  const id = Number(accountId);
  const reserved = monitorReservations.get(user?.id)?.has(id);
  if (!reserved) return { ok: false, skipped: true, reason: 'not_reserved' };
  try {
    const result = await module.exports.ensureGcashPayMonitor(user, id);
    if (result?.error || result?.reason === 'bad_id') {
      return { ok: false, skipped: true, reason: 'activation_failed' };
    }
    return { ok: true, ...result };
  } finally {
    releaseGcashPayMonitorReservation(user.id, id);
  }
}

module.exports = {
  start: job.start,
  stop: job.stop,
  status: job.status,
  isLive: job.isLive,
  payStatus,
  ensureGcashPayMonitor,
  reserveGcashPayMonitor,
  activateReservedGcashPayMonitor,
  releaseGcashPayMonitorReservation,
  confirmGcashPaid,
  pollParkedScan,
  submitParkedContinue,
  refreshParkedQr,
  maybeRefreshParkedQr,
  refreshPaywallQr,
  refreshPaywallWall,
  paywallWall,
  paywallView,
  refreshCapability,
  scanWorkInFlight,
  shouldPollEntitlement,
  gcashPayMonitorLimit,
  get GCASH_PAY_MONITOR_LIMIT() { return gcashPayMonitorLimit(); },
  GCASH_BATCH_REFRESH_CONCURRENCY,
  GCASH_BATCH_REFRESH_WINDOW_MS,
};
