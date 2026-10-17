'use strict';

const fs = require('node:fs');
const path = require('node:path');
const opLog = require('./opLog');
const { createLiveJob } = require('./accountLiveJob');
const {
  markExtracting, markExtractFailed, markGcashExtracted, normalizeProgress, PROGRESS,
  setAccountProgress, bumpStageAttempt, resetStageAttempt, stampExtractAttempt, accountChannelOf,
  clearGcashExtract,
} = require('./accountProgress');
const localProviderExtract = require('./localProviderExtract');
const { encodeExtractLink } = require('./accountFields');
const { loadPhProxies } = require('./phProxy');
const { isTokenInvalidatedError, recheckAfterTokenInvalidated } = require('./accountJob');
const { shouldSkipExtract, underRetryCap } = require('./pipelineState');
const { pipelineCaps, extractIntervalMs, stageCap } = require('./pipelineCaps');
const { isExtractRetryDue } = require('./accountProgress');
const { readSettings } = require('./settings');
const { applySkipPlatformSync } = require('./accountRetention');
const { gcashConcurrencyCap, gcashJobConcurrency } = require('./gcashConcurrency');

function dumpGcashQrFile(email, qr) {
  const dir = String(process.env.GCASH_QR_DUMP_DIR || '').trim();
  if (!dir) return '';
  const match = String(qr || '').match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const prefix = String(email || 'gcash').split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 12) || 'gcash';
    const file = path.join(dir, `${prefix}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(match[1].replace(/\s+/g, ''), 'base64'));
    return file;
  } catch {
    return '';
  }
}

const job = createLiveJob({
  kind: 'gcash-extract',
  source: 'gcash-extract',
  log: opLog.oauth,
  requireIds: true,
  allowEnqueue: true,
  onFinish({ userId }) {
    try { require('./accountGcPipeline').kick(userId); } catch { /* optional */ }
  },
  configure({ user, body }) {
    const { allowGcashExtract } = require('./accountGcPipeline');
    if (!allowGcashExtract(readSettings(user.id), body)) {
      throw Object.assign(new Error('GC 流水线未开启出码，仅检测资格'), {
        status: 400,
        code: 'GCASH_EXTRACT_DISABLED',
      });
    }
    const mk = require('../mkGcash/enabled').mkGcashEnabled();
    const cap = mk ? require('../mkGcash/limits').MAX_CONCURRENCY : gcashConcurrencyCap();
    const proxies = loadPhProxies(user.id, Math.max(1, Number(body.concurrency) || cap));
    return {
      body: { ...body, proxy_group: '__auto__:PH' },
      maxConcurrency: cap,
      defaultConcurrency: gcashJobConcurrency(body),
      requireProxy: true,
      skipCloak: true,
      proxies,
    };
  },
  async runOne({ user, id, row, detail, nextProxy, state }) {
    if (accountChannelOf(row) !== 'gc') {
      throw Object.assign(new Error('该账号不是 GC 通道，已跳过'), { code: 'ACCOUNT_CHANNEL_MISMATCH', skip: true });
    }
    const previous = normalizeProgress(row?.progress) || PROGRESS.REGISTERED;
    const caps = pipelineCaps(readSettings(user.id));
    if (shouldSkipExtract(row || {}, caps)) {
      throw Object.assign(new Error('账号已有 RT 或已开通，跳过提链'), { code: 'ACCOUNT_PIPELINE_DONE', skip: true });
    }
    if (!isExtractRetryDue(row || {}, Date.now(), extractIntervalMs(caps))) {
      throw Object.assign(new Error(`提链间隔未到（${caps.extract_interval_minutes} 分钟）`), {
        code: 'EXTRACT_INTERVAL', skip: true,
      });
    }
    markExtracting(user.id, id);
    let monitorReserved = false;
    try {
      if (!detail?.access_token) {
        throw Object.assign(new Error('账号缺少 access token'), { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
      }
      const proxy = nextProxy();
      if (!proxy) throw Object.assign(new Error('PH 动态代理不可用'), { status: 400, code: 'EXTRACT_PROXY_EMPTY' });
      if (require('../mkGcash/enabled').mkGcashEnabled()) {
        const { buildProxyUrl } = require('./mailcomProxy');
        const mkProxy = typeof proxy === 'string' ? proxy : buildProxyUrl(proxy);
        opLog.oauth(user.id, 'info', `${detail.email || id}：开始 MK GCash 出码提链`, {
          source: 'gcash-extract', run_id: state.run_id,
        });
        const result = await require('../mkGcash/adapter').extractOne({
          userId: user.id,
          accountId: id,
          token: detail.access_token,
          chatgptAccountId: detail.chatgpt_account_id || '',
          email: detail.email || '',
          name: detail.name || '',
          proxy: mkProxy,
          proxyPool: mkProxy ? [mkProxy] : [],
          cancelCheck: () => state.stop,
          onUpdate: (task) => {
            const step = String(task?.current_step || '');
            if (!step) return;
            const failed = task?.status === 'failed';
            const err = failed ? String(task.error_message || '').slice(0, 240) : '';
            opLog.oauth(
              user.id,
              failed ? 'error' : 'info',
              `${detail.email || id}：${step}${err ? ` ${err}` : ''}`,
              { source: 'gcash-extract', run_id: state.run_id },
            );
          },
        });
        resetStageAttempt(user.id, id, 'extract');
        const dumped = dumpGcashQrFile(detail.email || id, result.qr);
        if (dumped) {
          opLog.oauth(user.id, 'info', `${detail.email || id}：二维码已落到本地文件 ${path.basename(dumped)}`, {
            source: 'gcash-extract', run_id: state.run_id,
          });
        }
        opLog.oauth(user.id, 'success', `${detail.email || id}：MK GCash 链接已发布，监控已接管`, {
          source: 'gcash-extract', run_id: state.run_id,
        });
        return { qr: Boolean(result.qr), cs_id: result.cs_id || '', flow: result.flow || 'adyen', mk: true };
      }
      const payJob = require('./gcashPayJob');
      const reservation = payJob.reserveGcashPayMonitor(user.id, id);
      if (!reservation.ok) {
        throw Object.assign(new Error('GCash 支付监控槽已满，本轮不 start、不发布二维码'), {
          status: 409,
          code: 'GCASH_MONITOR_SLOT_UNAVAILABLE',
          recoverable: true,
        });
      }
      monitorReserved = reservation.reserved === true;
      opLog.oauth(user.id, 'info', `${detail.email || id}：已预占 GCash 支付监控槽，开始同一会话出码`, {
        source: 'gcash-extract', run_id: state.run_id,
      });
      opLog.oauth(user.id, 'info', `${detail.email || id}：开始 GCash 出码提链`, { source: 'gcash-extract', run_id: state.run_id });
      const result = await localProviderExtract.extractLocalProvider({
        channelId: 'gcash',
        detail,
        proxy,
        nextProxy,
        maxCheckoutAttempts: 10,
        keepSession: true,
        cancelled: () => state.stop,
        log: (message, level = 'info') => {
          const verbose = /^(1|true|yes)$/i.test(String(process.env.GCASH_PAY_DEBUG || process.env.OP_LOG_VERBOSE || ''));
          if (level === 'debug' && !verbose) return;
          const maxLen = verbose ? 900 : 240;
          opLog.oauth(
            user.id,
            level === 'error' ? 'error' : (level === 'warning' ? 'warning' : 'info'),
            `${detail.email || id}：${String(message).slice(0, maxLen)}`,
            { source: 'gcash-extract', run_id: state.run_id },
          );
        },
      });
      const providerUrl = String(result?.link || '').trim();
      const qr = String(result?.qr || '').trim();
      if (!providerUrl || !qr) {
        if (result?.h5) {
          const { closeGcashH5 } = require('./gcashH5Screenshot');
          await closeGcashH5(result.h5).catch(() => {});
        }
      }
      if (!providerUrl) {
        throw Object.assign(new Error('未提取到 Adyen/GCash 授权链'), { status: 502, recoverable: true });
      }
      if (!qr) {
        throw Object.assign(new Error('已有跳转链但未抽到二维码。支付墙需要二维码图片，请重新出码。'), {
          status: 502,
          code: 'GCASH_QR_MISSING',
          recoverable: true,
        });
      }
      markGcashExtracted(user.id, id, {
        gcash_link: encodeExtractLink(providerUrl),
        gcash_qr: qr,
        gcash_cs_id: String(result.cs_id || ''),
      });
      const dumped = dumpGcashQrFile(detail.email || id, qr);
      if (dumped) {
        opLog.oauth(user.id, 'info', `${detail.email || id}：二维码已落到本地文件 ${path.basename(dumped)}`, {
          source: 'gcash-extract', run_id: state.run_id,
        });
      }
      if (result.session || result.h5) {
        const { parkGcashSession } = require('./gcashSessionStore');
        parkGcashSession(user.id, id, {
          session: result.session,
          proxy,
          auth: result.protocol,
          checkout: result.checkout || { cs_id: result.cs_id },
          cpmId: result.payment_method_id,
          deviceId: result.device_id,
          sessionId: result.session_id,
          h5: result.h5 || null,
        });
      }
      resetStageAttempt(user.id, id, 'extract');
      const monitor = monitorReserved
        ? await payJob.activateReservedGcashPayMonitor({ id: user.id }, id)
        : await payJob.ensureGcashPayMonitor({ id: user.id }, id);
      monitorReserved = false;
      if (!monitor?.ok || monitor?.error) {
        clearGcashExtract(user.id, id);
        const { releaseGcashSession } = require('./gcashSessionStore');
        await releaseGcashSession(user.id, id);
        throw Object.assign(new Error('GCash 支付监控未取得所有权，二维码已撤回且未发布'), {
          status: 409,
          code: 'GCASH_MONITOR_ACTIVATION_FAILED',
          recoverable: true,
        });
      }
      opLog.oauth(user.id, 'success', `${detail.email || id}：协议二维码已发布，has_uuid=${Boolean(result.protocol?.consultUuid)}，支付监控已接管`, {
        source: 'gcash-extract', run_id: state.run_id,
      });
      return { qr: true, cs_id: result.cs_id || '', flow: result.flow || 'adyen' };
    } catch (error) {
      if (monitorReserved) {
        try { require('./gcashPayJob').releaseGcashPayMonitorReservation(user.id, id); } catch { /* best effort */ }
      }
      if (error?.code !== 'JOB_CANCELLED' && error?.code !== 'ACCOUNT_PIPELINE_DONE' && error?.code !== 'EXTRACT_INTERVAL') {
        if (isTokenInvalidatedError(error)) {
          try {
            await recheckAfterTokenInvalidated(user.id, id, { email: detail?.email, source: 'gcash-extract' });
          } catch { /* one-shot */ }
        }
        const restore = previous === PROGRESS.EXTRACTING ? PROGRESS.REGISTERED : previous;
        if (restore && restore !== PROGRESS.EXTRACTING) setAccountProgress(user.id, id, restore);
        if (!error?.skip) markExtractFailed(user.id, id);
        else stampExtractAttempt(user.id, id);
        const attempts = bumpStageAttempt(user.id, id, 'extract');
        // GC 出码失败同样计入 extract_attempts；满 20 次标记不同步（dump 拦截在 accountHousekeeping）
        applySkipPlatformSync(user.id, id, attempts);
        const cap = stageCap('extract', caps);
        if (attempts >= cap) {
          opLog.oauth(
            user.id,
            'warning',
            `${detail?.email || id}：GCash 提链已失败 ${cap} 次，流水线不再自动重试`,
            { source: 'gcash-extract', run_id: state.run_id },
          );
        }
      }
      throw error;
    }
  },
});

module.exports = {
  start: job.start,
  stop: job.stop,
  status: job.status,
  isLive: job.isLive,
  dumpGcashQrFile,
};
