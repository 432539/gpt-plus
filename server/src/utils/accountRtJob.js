'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const accountJob = require('./accountJob');
const registerJob = require('./registerJob');
const { readSettings } = require('./settings');
const opLog = require('./opLog');
const { requireChannelDynamicProxy, channelCountry, channelAutoGroup } = require('./channelProxy');
const { withExtractSession } = require('./extractHttp');
const { credentialsFromTokens } = require('../automation/lib/chatgpt-oauth');
const {
  acquireRefreshTokenByLogin,
  createRtSmsClient,
  isRtGateBlock,
  OPENAI_RT_COUNTRY,
} = require('./protocolRt');
const { bumpStageAttempt, resetStageAttempt, hasActivated } = require('./accountProgress');
const { pipelineCaps, stageCap } = require('./pipelineCaps');
const { isTokenInvalidatedError, recheckAfterTokenInvalidated } = require('./accountJob');
const { jobSlotKey, normalizeChannel, isGcChannel, channelSql } = require('./accountChannel');

function isTransientRtFailure(error) {
  const hay = `${error?.code || ''} ${error?.message || error || ''}`;
  if (/JOB_CANCELLED/i.test(hay)) return false;
  return /TimeoutError|ETIMEDOUT|timed out|timeout/i.test(hay);
}

const runtimes = new Map();
const AUTHORIZE_SID_RETRIES = 5;
const MAX_RT_WORKERS = 8;
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function accountRtEligibility(found, accountId, options = {}) {
  if (!found) return { eligible: false, account_id: accountId, code: 'ACCOUNT_NOT_FOUND', reason: '账号不存在' };
  if (found.detail.refresh_token && options.allowExistingRt === true) {
    return { eligible: true, found };
  }
  if (found.detail.refresh_token) {
    return { eligible: false, account_id: accountId, email: found.detail.email, code: 'ACCOUNT_RT_ALREADY_AVAILABLE', reason: '账号已有 RT' };
  }
  if (!found.detail.password) {
    return { eligible: false, account_id: accountId, email: found.detail.email, code: 'ACCOUNT_RT_MISSING_PASSWORD', reason: '账号缺少 ChatGPT 密码' };
  }
  if (!found.detail.totp_secret) {
    return { eligible: false, account_id: accountId, email: found.detail.email, code: 'ACCOUNT_RT_MISSING_TOTP', reason: '账号缺少 TOTP Secret' };
  }
  if (!hasActivated(found.row || {})) {
    return {
      eligible: false,
      account_id: accountId,
      email: found.detail.email,
      code: 'ACCOUNT_RT_NOT_PAID',
      reason: '需提链并支付成功后才拿 RT',
    };
  }
  return { eligible: true, found };
}

function enqueue(user, ids, options = {}) {
  const slot = jobSlotKey(user.id, options.channel);
  const state = runtimes.get(slot);
  if (!state?.running || state.stop) {
    return { ok: true, enqueued: 0, accepted: 0 };
  }
  const added = [];
  const insert = db.prepare(
    `INSERT INTO registration_jobs
     (job_id,batch_id,user_id,kind,account_id,email,status,progress)
     VALUES (?,?,?,'account-rt',?,?,'queued',0)`
  );
  for (const id of ids) {
    const eligibility = accountRtEligibility(accountJob.accountRow(user.id, id), id, options);
    if (!eligibility.eligible) continue;
    const found = eligibility.found;
    if (state.pending.some((job) => Number(job.account_id) === Number(found.row.id))) continue;
    const jobId = crypto.randomUUID();
    try {
      insert.run(jobId, state.batchId, user.id, found.row.id, found.detail.email);
    } catch {
      continue;
    }
    const job = db.prepare('SELECT * FROM registration_jobs WHERE job_id=?').get(jobId);
    if (!job) continue;
    state.pending.push(job);
    added.push(id);
  }
  if (added.length) {
    try { registerJob._test.syncBatch(state.batchId); } catch { /* ignore */ }
  }
  return {
    ok: true,
    enqueued: added.length,
    accepted: added.length,
    batch_id: state.batchId,
  };
}

async function runProtocolRt(found, {
  proxy, settings, cancelled, log, fetchImpl,
} = {}) {
  return withExtractSession({ proxy, timeoutMs: 45000, fetchImpl }, async (session) => {
    const tokens = await acquireRefreshTokenByLogin({
      session,
      email: found.detail.email,
      password: found.detail.password,
      mfaSecret: found.detail.totp_secret,
      smsFactory: () => createRtSmsClient(settings, { cancelled, log }),
      logger: log,
      cancelled,
    });
    const creds = credentialsFromTokens(tokens, { previous: found.detail });
    if (!creds?.access_token || !creds.refresh_token) {
      throw Object.assign(new Error('换令牌成功但没有可保存的 AT/RT'), { code: 'ACCOUNT_RT_NO_REFRESH' });
    }
    return { ...creds, phone_verified: tokens.phone_verified === true };
  });
}

async function start(user, body = {}) {
  const rawIds = Array.isArray(body.ids) ? body.ids : [];
  const channel = normalizeChannel(body.channel);
  const country = channelCountry(channel);
  body = {
    ...body,
    proxy_group: channelAutoGroup(channel),
    proxy_country: country,
    channel,
  };
  const ids = [...new Set(rawIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw Object.assign(new Error('请先选择至少一个账号'), { status: 400, code: 'ACCOUNT_RT_IDS_REQUIRED' });
  if (ids.length > 2000) throw Object.assign(new Error('单批最多选择 2000 个账号'), { status: 400, code: 'ACCOUNT_RT_BATCH_TOO_LARGE' });
  const allowExistingRt = body.force === true || body.allow_existing_rt === true;
  const slot = jobSlotKey(user.id, channel);
  if (runtimes.get(slot)?.running) {
    return enqueue(user, ids, { allowExistingRt, channel });
  }

  const settings = readSettings(user.id);
  const owned = ids.filter((id) => db.prepare(
    `SELECT id FROM gpt_accounts WHERE user_id = ? AND id = ? AND ${channelSql()}`
  ).get(user.id, id, channel));
  const eligibility = owned.map(id => accountRtEligibility(accountJob.accountRow(user.id, id), id, { allowExistingRt }));
  const rows = eligibility.filter(item => item.eligible).map(item => item.found);
  const preflightSkipped = eligibility.filter(item => !item.eligible).map(({ found, eligible, ...item }) => item);
  if (!rows.length) {
    throw Object.assign(new Error('所选账号均不符合获取 RT 条件'), {
      status: 422, code: 'ACCOUNT_RT_NO_ELIGIBLE_ACCOUNTS', preflight_skipped: preflightSkipped,
    });
  }
  const requested = Math.max(1, Math.min(MAX_RT_WORKERS, Number(body.concurrency) || 3));
  const concurrency = Math.min(requested, rows.length);
  requireChannelDynamicProxy(user.id, country, `rt-preflight:${user.id}`, settings);

  const batchId = crypto.randomUUID();
  const state = { running: true, stop: false, batchId, pending: [], cursor: 0, concurrency, channel };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO registration_runs (run_id,user_id,target,concurrency,running,finished,started_at,message)
       VALUES (?,?,?,?,1,0,?,?)`
    ).run(batchId, user.id, rows.length, concurrency, now(), '协议拿 RT 批次已启动');
    db.prepare(
      `INSERT INTO registration_batches
       (batch_id,user_id,run_id,kind,status,total,concurrency,queued,message,created_at)
       VALUES (?,?,?,'account-rt','running',?,?,?,'协议拿 RT 批次已启动',?)`
    ).run(batchId, user.id, batchId, rows.length, concurrency, rows.length, now());
    const insert = db.prepare(
      `INSERT INTO registration_jobs
       (job_id,batch_id,user_id,kind,account_id,email,status,progress)
       VALUES (?,?,?,'account-rt',?,?,'queued',0)`
    );
    rows.forEach(found => insert.run(crypto.randomUUID(), batchId, user.id, found.row.id, found.detail.email));
  })();

  runtimes.set(slot, state);
  const nextProxy = (jobId, attempt) => requireChannelDynamicProxy(
    user.id,
    country,
    `${batchId}:${jobId}:${attempt || 1}`,
    settings,
  );

  state.pending = db.prepare('SELECT * FROM registration_jobs WHERE batch_id=? ORDER BY rowid').all(batchId);
  state.cursor = 0;

  const worker = async () => {
    while (!state.stop) {
      const job = state.pending[state.cursor++];
      if (!job) return;
      registerJob._test.patchRegistrationJob(job.job_id, { status: 'running', progress: 5, attempt: 1 });
      let last = null;
      const found = accountJob.accountRow(user.id, job.account_id);
      try {
        for (let attempt = 1; attempt <= AUTHORIZE_SID_RETRIES && !state.stop; attempt += 1) {
          registerJob._test.patchRegistrationJob(job.job_id, { attempt, progress: 20 });
          const proxy = nextProxy(job.job_id, attempt);
          const log = (message, level = 'info') => {
            if (level === 'debug') return;
            opLog.account(user.id, level === 'ok' ? 'success' : level, `${job.email}：${String(message).slice(0, 220)}`, { source: 'refresh' });
            registerJob._test.patchRegistrationJob(job.job_id, {
              progress: Math.min(90, 20 + attempt * 8),
              error: String(message).slice(0, 240),
            });
          };
          try {
            const result = await runProtocolRt(found, {
              proxy,
              settings,
              cancelled: () => state.stop,
              log,
            });
            accountJob.persistRefreshResult(user.id, job.account_id, found.row, result);
            resetStageAttempt(user.id, job.account_id, 'acquire_rt');
            let planType = '';
            try {
              const plan = await accountJob.persistPlanAfterRt(user.id, job.account_id, { proxy });
              planType = plan?.plan_type || '';
              if (planType) log(`套餐已更新为 ${planType}`, 'ok');
              else if (plan?.skipped) log(`RT 已保存，套餐查询暂未写入（${plan.reason || 'skipped'}）`, 'warning');
            } catch (error) {
              log(`RT 已保存，套餐查询失败：${String(error.message || error).slice(0, 160)}`, 'warning');
            }
            const fresh = accountJob.accountRow(user.id, job.account_id);
            const hasRt = Boolean(fresh?.detail.refresh_token || result.refresh_token);
            registerJob._test.patchRegistrationJob(job.job_id, {
              status: hasRt ? 'success' : 'partial',
              progress: 100,
              partial: !hasRt,
              error_code: hasRt ? '' : 'ACCOUNT_RT_NOT_ACQUIRED',
              error: hasRt ? '' : '协议登录完成，但未取得可续期 RT',
              result: {
                success: hasRt,
                partial: !hasRt,
                account_id: job.account_id,
                has_refresh_token: hasRt,
                plan_type: planType || fresh?.row?.plan_type || '',
              },
            });
            last = null;
            break;
          } catch (error) {
            last = error;
            if (state.stop) break;
            if (isRtGateBlock(error) && attempt < AUTHORIZE_SID_RETRIES) {
              log(`🚪 登录小门被门禁拦住了，换一条出口再试（${attempt}/${AUTHORIZE_SID_RETRIES}）`, 'warning');
              continue;
            }
            break;
          }
        }
      } catch (error) {
        last = error;
      }
      if (last) {
        const current = registerJob.getJob(user.id, job.job_id);
        if (!['success', 'partial'].includes(current?.status)) {
          if (!state.stop) {
            if (isTokenInvalidatedError(last)) {
              try {
                await recheckAfterTokenInvalidated(user.id, job.account_id, {
                  email: job.email,
                  source: 'refresh',
                });
              } catch { /* one-shot recheck */ }
            }
            const caps = pipelineCaps(settings);
            let attempts = Number(found?.row?.rt_attempts) || 0;
            if (!isTransientRtFailure(last)) {
              attempts = bumpStageAttempt(user.id, job.account_id, 'acquire_rt');
            }
            const cap = stageCap('acquire_rt', caps);
            if (attempts >= cap) {
              opLog.account(
                user.id,
                'warning',
                `${job.email}：拿 RT 已失败 ${cap} 次，流水线不再自动重试`,
                { source: 'refresh' },
              );
            }
          }
          registerJob._test.patchRegistrationJob(job.job_id, {
            status: state.stop ? 'cancelled' : 'failed',
            progress: 100,
            error_code: state.stop ? 'JOB_CANCELLED' : String(last.code || 'ACCOUNT_RT_FAILED'),
            error: state.stop ? '任务已取消' : String(last.message || last).slice(0, 240),
          });
        }
      }
    }
  };

  const pump = async () => {
    while (!state.stop && state.cursor < state.pending.length) {
      const startedAt = state.cursor;
      await Promise.allSettled(Array.from({ length: Math.max(1, concurrency) }, worker));
      if (state.cursor <= startedAt) break;
    }
  };

  pump().finally(() => {
    if (state.stop) {
      db.prepare(
        `UPDATE registration_jobs SET status='cancelled',progress=100,error_code='JOB_CANCELLED',
         error='任务已取消',finished_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
         WHERE batch_id=? AND status IN ('queued','running')`
      ).run(batchId);
    } else {
      db.prepare(
        `UPDATE registration_jobs SET status='failed',progress=100,error_code='ACCOUNT_RT_BATCH_ABORTED',
         error='批次执行器提前结束',finished_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
         WHERE batch_id=? AND status IN ('queued','running')`
      ).run(batchId);
    }
    registerJob._test.syncBatch(batchId, state.stop ? '协议拿 RT 批次已取消' : '协议拿 RT 批次已完成', state.stop ? 'cancelled' : '');
    state.running = false;
    runtimes.delete(slot);
    try {
      if (isGcChannel(channel)) require('./accountGcPipeline').kick(user.id);
      else require('./accountPipeline').kick(user.id);
    } catch { /* poller optional */ }
  });

  return {
    ok: true, batch_id: batchId, job_ids: state.pending.map(row => row.job_id),
    requested: ids.length, accepted: rows.length, skipped: preflightSkipped.length,
    preflight_skipped: preflightSkipped, effective_concurrency: concurrency,
    proxy_country: country, dynamic_proxy: dynamic, phone_country: OPENAI_RT_COUNTRY,
    protocol: true,
  };
}

function view(userId, batchId) {
  const batch = registerJob.getBatch(userId, batchId);
  return batch?.kind === 'account-rt' ? batch : null;
}

function job(userId, jobId) {
  const value = registerJob.getJob(userId, jobId);
  return value?.kind === 'account-rt' ? value : null;
}

function status(userId, channel) {
  const state = runtimes.get(jobSlotKey(userId, channel));
  return {
    running: Boolean(state?.running),
    batch_id: state?.batchId || '',
  };
}

function isLive(userId, channel) {
  return Boolean(runtimes.get(jobSlotKey(userId, channel))?.running);
}

function reconcileStale(userId) {
  if (isLive(userId) || isLive(userId, 'gc')) return 0;
  try {
    return require('./registerJob').reconcileDeadKind(userId, 'account-rt');
  } catch {
    return 0;
  }
}

function stop(userId, channel) {
  const state = runtimes.get(jobSlotKey(userId, channel));
  if (!state?.running) return { ok: true, message: '当前没有运行中的 RT 任务' };
  const batchId = state.batchId;
  state.stop = true;
  if (batchId) registerJob.cancelBatch(userId, batchId);
  return { ok: true, message: '已发送停止指令' };
}

function cancel(userId, batchId) {
  const batch = view(userId, batchId);
  if (!batch) return null;
  for (const channel of ['gb', 'gc']) {
    const state = runtimes.get(jobSlotKey(userId, channel));
    if (state?.batchId === batchId) state.stop = true;
  }
  return registerJob.cancelBatch(userId, batchId);
}

module.exports = {
  start, view, job, cancel, stop, status, isLive, reconcileStale, enqueue,
  isTransientRtFailure,
  _test: { accountRtEligibility, runProtocolRt, runtimes, AUTHORIZE_SID_RETRIES, isTransientRtFailure },
};
