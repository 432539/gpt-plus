const opLog = require('./opLog');
const {
  markPaid, markPaying, normalizeProgress, PROGRESS, setAccountProgress, extractLinkState,
  bumpStageAttempt, resetStageAttempt,
} = require('./accountProgress');
const { isPaidPlan } = require('./accountCheck');
const { createLiveJob } = require('./accountLiveJob');
const { EXTRACT_CONCURRENCY_CAP, GB_PAYPAL } = require('./paymentLink');
const { prepareActivateJob, runActivateAccount } = require('./paypalPay');
const { resolveSmsbowerConfig } = require('./smsbower');
const { readSettings } = require('./settings');
const { nextChannelProxy, requireChannelDynamicProxy } = require('./channelProxy');
const { shouldSkipPay, isActivationRetryPending, consumeActivationRetry } = require('./pipelineState');
const { pipelineCaps, stageCap } = require('./pipelineCaps');
const { isTokenInvalidatedError, recheckAfterTokenInvalidated } = require('./accountJob');

const ACTIVATE_CONGRATS_COPY = '恭喜你,开通成功';

function isHiddenActivateCopy(message) {
  return /卡片被拒/.test(String(message || ''));
}

function activateOpLogLevel(level) {
  const value = String(level || 'info').toLowerCase();
  if (value === 'error') return 'error';
  if (value === 'warning' || value === 'warn') return 'warning';
  if (value === 'success' || value === 'ok') return 'success';
  return 'info';
}

function activateCongratsMessage(email) {
  return `${email}：${ACTIVATE_CONGRATS_COPY}`;
}

const job = createLiveJob({
  kind: 'activate',
  source: 'activate',
  log: opLog.activate,
  requireIds: true,
  allowEnqueue: true,
  onFinish({ userId }) {
    try { require('./accountPipeline').kick(userId); } catch { /* poller optional */ }
  },
  configure({ user, body, settings }) {
    resolveSmsbowerConfig(settings.sms || {});
    const prepared = prepareActivateJob(user.id, body);
    requireChannelDynamicProxy(user.id, 'GB', `activate-preflight:${user.id}`, settings);
    return {
      body: { ...body, ...prepared },
      maxConcurrency: prepared.maxConcurrency || EXTRACT_CONCURRENCY_CAP,
      defaultConcurrency: prepared.concurrency || EXTRACT_CONCURRENCY_CAP,
      locale: 'en-GB',
      timezone: GB_PAYPAL.timezone,
      requireProxy: true,
      nextProxy: nextChannelProxy(user.id, 'GB', `activate:${user.id}`, settings),
    };
  },
  async runOne({ user, id, row, detail, runtime, nextProxy, state }) {
    const previous = normalizeProgress(row?.progress) || PROGRESS.REGISTERED;
    const caps = pipelineCaps(readSettings(user.id));
    if (shouldSkipPay(row || {}, caps)) {
      throw Object.assign(new Error('账号已开通或已有 RT，跳过支付'), {
        code: 'ACCOUNT_ALREADY_PAID',
        skip: true,
      });
    }
    if (isActivationRetryPending(row || {})) consumeActivationRetry(user.id, id);
    markPaying(user.id, id);
    try {
      const proxy = nextProxy();
      if (!proxy) {
        throw Object.assign(new Error('动态代理 CliProxy 未配置或国家无效'), {
          status: 400,
          code: 'DYNAMIC_PROXY_NOT_CONFIGURED',
        });
      }
      opLog.activate(user.id, 'info', `${detail?.email || id}：开始 GB PayPal 支付/开通`, {
        source: 'activate',
        run_id: state.run_id,
      });
      const result = await runActivateAccount({
        user,
        id,
        detail,
        runtime,
        proxy,
        nextProxy,
        cancelled: () => state.stop,
        settings: readSettings(user.id),
        log: (message, level = 'info') => {
          if (level === 'debug' || isHiddenActivateCopy(message)) return;
          opLog.activate(
            user.id,
            activateOpLogLevel(level),
            `${detail?.email || id}：${String(message).slice(0, 240)}`,
            { source: 'activate', run_id: state.run_id },
          );
        },
      });
      const planType = result?.plan_type;
      if (!result?.paid || !isPaidPlan(planType)) {
        throw Object.assign(
          new Error('PayPal 已授权，但 ChatGPT 套餐仍未同步，开通失败'),
          { code: 'CHATGPT_PLUS_NOT_SYNCED', recoverable: true },
        );
      }
      markPaid(user.id, id, {
        plan_type: planType,
        expires_at: result?.expires_at || '',
      });
      try { job.dropSettled(user.id); } catch { /* overlay optional */ }
      resetStageAttempt(user.id, id, 'pay');
      try {
        const pipeline = readSettings(user.id).pipeline || {};
        if (pipeline.acquire_rt === true) {
          require('./accountPipeline').notePaidForRt(user.id, id);
        }
      } catch { /* pipeline optional */ }
      opLog.activate(user.id, 'success', activateCongratsMessage(detail?.email || id), {
        source: 'activate',
        run_id: state.run_id,
      });
      return result;
    } catch (error) {
      if (error?.code !== 'JOB_CANCELLED' && error?.code !== 'ACCOUNT_ALREADY_PAID') {
        if (isTokenInvalidatedError(error)) {
          try {
            await recheckAfterTokenInvalidated(user.id, id, {
              email: detail?.email,
              source: 'activate',
            });
          } catch { /* one-shot recheck */ }
        }
        if (error?.code === 'PAYMENT_OUTCOME_UNKNOWN') {
          setAccountProgress(user.id, id, PROGRESS.PAYMENT_REVIEW);
          opLog.activate(
            user.id,
            'warning',
            `${detail?.email || id}：支付结果待核验，已冻结再次扣款；稍后点击“核验”只查询套餐状态`,
            { source: 'activate', run_id: state.run_id },
          );
        } else {
          const linkState = extractLinkState(detail);
          let restore = previous === PROGRESS.PAYING ? PROGRESS.REGISTERED : previous;
          if (linkState === 'valid') restore = PROGRESS.EXTRACTED;
          else if (linkState === 'expired') restore = PROGRESS.EXTRACTED_EXPIRED;
          if (restore && restore !== PROGRESS.PAYING) setAccountProgress(user.id, id, restore);
          const attempts = bumpStageAttempt(user.id, id, 'pay');
          const cap = stageCap('pay', caps);
          if (attempts >= cap) {
            opLog.activate(
              user.id,
              'warning',
              `${detail?.email || id}：支付已失败 ${cap} 次，流水线不再自动重试`,
              { source: 'activate', run_id: state.run_id },
            );
          }
        }
      }
      // CONTEXT_REBUILD and other pay errors must not flip ChatGPT account status to banned.
      throw error;
    }
  },
});

module.exports = {
  start: job.start,
  stop: job.stop,
  status: job.status,
  isLive: job.isLive,
  dropSettled: job.dropSettled,
  prepareActivateJob,
  ACTIVATE_CONGRATS_COPY,
  isHiddenActivateCopy,
  activateOpLogLevel,
  activateCongratsMessage,
};
