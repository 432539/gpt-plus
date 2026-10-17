const opLog = require('./opLog');
const { createLiveJob } = require('./accountLiveJob');
const {
  markExtracting, markExtracted, markExtractFailed, normalizeProgress, PROGRESS, setAccountProgress,
  bumpStageAttempt, resetStageAttempt, stampExtractAttempt,
} = require('./accountProgress');
const { encodeExtractLink } = require('./accountFields');
const { EXTRACT_CONCURRENCY_CAP, GB_PAYPAL } = require('./paymentLink');
const paypalExtract = require('./paypalExtract');
const { readSettings } = require('./settings');
const { nextChannelProxy, requireChannelDynamicProxy } = require('./channelProxy');
const { shouldSkipExtract } = require('./pipelineState');
const { pipelineCaps, extractIntervalMs, stageCap } = require('./pipelineCaps');
const { isExtractRetryDue } = require('./accountProgress');
const { isTokenInvalidatedError, recheckAfterTokenInvalidated } = require('./accountJob');
const { applySkipPlatformSync, shouldSkipPlatformSync } = require('./accountRetention');

const PIPELINE_UNLIMITED_CAP = 1000;

function extractConcurrencyCap(_settings = {}, body = {}) {
  if (body?.pipeline === true) return PIPELINE_UNLIMITED_CAP;
  return EXTRACT_CONCURRENCY_CAP;
}

function prepareExtractJob(userId, body = {}, settings = readSettings(userId)) {
  const cap = extractConcurrencyCap(settings, body);
  const requested = Number(body.concurrency);
  const fallback = body.pipeline === true ? cap : 1;
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(requested) && requested > 0 ? requested : fallback, cap),
  );
  return { proxy_group: '__auto__:GB', concurrency, maxConcurrency: cap };
}

const job = createLiveJob({
  kind: 'extract',
  source: 'extract',
  log: opLog.oauth,
  requireIds: true,
  allowEnqueue: true,
  onFinish({ userId }) {
    try { require('./accountPipeline').kick(userId); } catch { /* poller optional */ }
  },
  configure({ user, body, settings }) {
    const prepared = prepareExtractJob(user.id, body, settings);
    requireChannelDynamicProxy(user.id, 'GB', `extract-preflight:${user.id}`, settings);
    return {
      body: { ...body, ...prepared },
      maxConcurrency: prepared.maxConcurrency,
      defaultConcurrency: body.pipeline === true ? prepared.concurrency : 1,
      locale: 'en-GB',
      timezone: GB_PAYPAL.timezone,
      requireProxy: true,
      skipCloak: true,
      nextProxy: nextChannelProxy(user.id, 'GB', `extract:${user.id}`, settings),
    };
  },
  async runOne({ user, id, row, detail, runtime, nextProxy, state }) {
    const previous = normalizeProgress(row?.progress) || PROGRESS.REGISTERED;
    const caps = pipelineCaps(readSettings(user.id));
    if (shouldSkipExtract(row || {}, caps)) {
      throw Object.assign(new Error('账号已有 RT 或已开通，跳过提链'), {
        code: 'ACCOUNT_PIPELINE_DONE',
        skip: true,
      });
    }
    if (!isExtractRetryDue(row || {}, Date.now(), extractIntervalMs(caps))) {
      throw Object.assign(new Error(`提链间隔未到（${caps.extract_interval_minutes} 分钟）`), {
        code: 'EXTRACT_INTERVAL',
        skip: true,
      });
    }
    if (previous === PROGRESS.PAYMENT_REVIEW) {
      throw Object.assign(
        new Error('该账号支付结果待核验，请先点击“核验”；为避免重复扣款，暂不允许重新提链'),
        { code: 'PAYMENT_OUTCOME_UNKNOWN', skip: true },
      );
    }
    markExtracting(user.id, id);
    try {
      if (!detail?.access_token) {
        throw Object.assign(new Error('账号缺少 access token'), { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
      }
      const proxy = nextProxy();
      if (!proxy) {
        throw Object.assign(new Error('动态代理 CliProxy 未配置或国家无效'), {
          status: 400,
          code: 'DYNAMIC_PROXY_NOT_CONFIGURED',
        });
      }
      opLog.oauth(user.id, 'info', `${detail.email || id}：开始 GB PayPal 提链`, { source: 'extract', run_id: state.run_id });
      const result = await paypalExtract.extractPaymentLink({
        detail,
        proxy,
        nextProxy,
        cancelled: () => state.stop,
        log: (message, level = 'info') => {
          if (level === 'debug') return;
          opLog.oauth(
            user.id,
            level === 'error' ? 'error' : 'info',
            `${detail.email || id}：${String(message).slice(0, 240)}`,
            { source: 'extract', run_id: state.run_id },
          );
        },
      });
      markExtracted(user.id, id, { extract_link: encodeExtractLink(result.link) });
      resetStageAttempt(user.id, id, 'extract');
      opLog.oauth(user.id, 'success', `${detail.email || id}：已提取 PayPal 支付链`, { source: 'extract', run_id: state.run_id });
      return result;
    } catch (error) {
      if (error?.code !== 'JOB_CANCELLED' && error?.code !== 'ACCOUNT_PIPELINE_DONE' && error?.code !== 'EXTRACT_INTERVAL') {
        if (isTokenInvalidatedError(error)) {
          try {
            await recheckAfterTokenInvalidated(user.id, id, {
              email: detail?.email,
              source: 'extract',
            });
          } catch { /* one-shot recheck */ }
        }
        const restore = previous === PROGRESS.EXTRACTING ? PROGRESS.REGISTERED : previous;
        if (restore && restore !== PROGRESS.EXTRACTING) setAccountProgress(user.id, id, restore);
        if (!error?.skip) markExtractFailed(user.id, id);
        else stampExtractAttempt(user.id, id);
        if (error?.code !== 'PAYMENT_OUTCOME_UNKNOWN') {
          const attempts = bumpStageAttempt(user.id, id, 'extract');
          applySkipPlatformSync(user.id, id, attempts);
          const cap = stageCap('extract', caps);
          if (!shouldSkipPlatformSync({ extract_attempts: attempts }) && attempts >= cap) {
            opLog.oauth(
              user.id,
              'warning',
              `${detail?.email || id}：提链已失败 ${cap} 次，流水线不再自动重试`,
              { source: 'extract', run_id: state.run_id },
            );
          }
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
  prepareExtractJob,
  extractConcurrencyCap,
  PIPELINE_UNLIMITED_CAP,
};
