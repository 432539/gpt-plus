'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const accountJob = require('./accountJob');
const registerJob = require('./registerJob');
const { readSettings } = require('./settings');
const opLog = require('./opLog');
const { encrypt } = require('./crypto');
const { requireChannelDynamicProxy, channelCountry, channelAutoGroup } = require('./channelProxy');
const { withExtractSession } = require('./extractHttp');
const { jobSlotKey, normalizeChannel, isGcChannel, channelSql } = require('./accountChannel');
const { cfMailReady, enabledCfDomains, cfMailConfig } = require('./cfMail');
const { pickQuotaSuffix } = require('./suffixQuota');
const { CfWorkerMailChannel } = require('../automation/channels/mail');
const {
  maskEmail,
  emailDomain,
  interpretEligibility,
  interpretMutation,
  canBeginChangeEmail,
  changeEmailContext,
  checkChangeEmailEligibility,
  beginChangeEmail,
  verifyChangeEmail,
} = require('./changeEmailProtocol');
const { loginWebSession, RebindLoginError } = require('./changeEmailLogin');

const REBIND_COOLDOWN_MS = 3 * 60 * 1000;
const REBIND_ATTEMPT_CAP = 8;
const DEFAULT_REBIND_CONCURRENCY = 10;
const MAX_REBIND_WORKERS = 20;
const OTP_TIMEOUT_MS = 180000;
const runtimes = new Map();
const hooks = {
  loginForAccessToken: null,
  acquireRebindMailbox: null,
};
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function parseStamp(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = /T/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function rebindStatusOf(row = {}) {
  return String(row.rebind_status || '').trim().toLowerCase();
}

function emailAlreadyRebound(row = {}, detail = {}) {
  const original = String(row.original_email || '').trim().toLowerCase();
  const current = String(detail.email || row.email || '').trim().toLowerCase();
  const target = String(row.rebind_email || '').trim().toLowerCase();
  return Boolean(original && current && target && current === target && current !== original);
}

function inRebindCooldown(row = {}, nowMs = Date.now()) {
  const status = rebindStatusOf(row);
  if (status !== 'failed' && status !== 'cooling') return false;
  const stamp = parseStamp(row.rebind_attempted_at);
  if (!stamp) return false;
  return nowMs - stamp < REBIND_COOLDOWN_MS;
}

function rebindBlocksExtract(row = {}, rebindRequired = false) {
  if (!rebindRequired) return false;
  const status = rebindStatusOf(row);
  return status !== 'ok' && status !== 'skipped';
}

function resolveRebindSource(input = {}, fallback = 'batch') {
  if (input === 'pipeline' || input === 'batch') return input;
  const named = String(input.source || '').trim().toLowerCase();
  if (named === 'pipeline' || input.pipeline === true) return 'pipeline';
  if (named === 'batch' || input.pipeline === false) return 'batch';
  return fallback === 'pipeline' ? 'pipeline' : 'batch';
}

function hasFilled(value) {
  return Boolean(String(value || '').trim());
}

function trialFlag(value) {
  if (value === 1 || value === true) return 1;
  if (value === 0 || value === false) return 0;
  return null;
}

function rebindLoginGap(row = {}, detail = {}) {
  const missing = [];
  if (!hasFilled(detail.password) && !hasFilled(row.password_enc)) missing.push('密码');
  if (!hasFilled(detail.totp_secret) && !hasFilled(row.totp_secret_enc)) missing.push('TOTP');
  if (!missing.length) return '';
  return `缺少${missing.join('、')}，无法登录`;
}

function summarizeLoginSkipMessage(skipReasons = []) {
  const loginReasons = (skipReasons || []).filter((item) => /缺少/.test(item.reason));
  if (!loginReasons.length) return '';
  const unique = [...new Set(loginReasons.map((item) => item.reason))];
  if (unique.length === 1) return `已跳过 ${loginReasons.length} 个：${unique[0]}`;
  return `已跳过 ${loginReasons.length} 个：缺少密码或 TOTP，无法登录`;
}

function isAccessTokenInvalid(result = {}) {
  const status = Number(result.status) || 0;
  const blob = `${result.errorCode || result.code || ''} ${result.reason || result.message || ''}`;
  return status === 401 || /token[_ -]?invalidated|invalid[_ -]?token|unauthorized/i.test(blob);
}

function selectRebindIds(rows = [], nowMs = Date.now(), caps = {}) {
  const cap = Math.max(1, Number(caps.rebind_attempts) || REBIND_ATTEMPT_CAP);
  return rows.filter((row) => {
    if (Number(row.has_trial) !== 1) return false;
    if (!String(row.password_enc || '').trim()) return false;
    if (!String(row.totp_secret_enc || '').trim()) return false;
    const status = rebindStatusOf(row);
    if (status === 'ok' || status === 'skipped') return false;
    if ((Number(row.rebind_attempts) || 0) >= cap) return false;
    if (inRebindCooldown(row, nowMs)) return false;
    return true;
  }).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
}

function clampRebindConcurrency(raw, eligibleCount = Infinity) {
  const requested = Number(raw);
  const wanted = Number.isFinite(requested) && requested > 0
    ? requested
    : DEFAULT_REBIND_CONCURRENCY;
  const capped = Math.max(1, Math.min(MAX_REBIND_WORKERS, Math.floor(wanted)));
  const pool = Number(eligibleCount);
  if (!Number.isFinite(pool) || pool <= 0) return capped;
  return Math.min(capped, pool);
}

function classifyRebindSelection(foundRows = [], nowMs = Date.now(), options = {}) {
  const source = resolveRebindSource(options, 'pipeline');
  const skipped_no_trial = [];
  const skipped_other = [];
  const skip_reasons = [];
  const eligible = [];
  for (const found of foundRows) {
    const row = found?.row || found;
    const detail = found?.detail || {};
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (source === 'pipeline' && trialFlag(row.has_trial) !== 1) {
      skipped_no_trial.push(id);
      skip_reasons.push({ id, reason: trialFlag(row.has_trial) === 0 ? '无试用' : '未检测' });
      continue;
    }
    const loginGap = rebindLoginGap(row, detail);
    if (source === 'batch') {
      if (loginGap) {
        skipped_other.push(id);
        skip_reasons.push({ id, reason: loginGap });
        continue;
      }
      eligible.push(found);
      continue;
    }
    if (selectRebindIds([row], nowMs).includes(id)) eligible.push(found);
    else {
      skipped_other.push(id);
      skip_reasons.push({ id, reason: loginGap || '暂不符合流水线换绑条件' });
    }
  }
  return { eligible, skipped_no_trial, skipped_other, skip_reasons, source };
}

function pipelineRebindOn(userId, channel) {
  const settings = readSettings(userId);
  const { normalizePipeline } = require('./accountPipeline');
  const raw = isGcChannel(channel) ? settings.pipeline_gc : settings.pipeline;
  return normalizePipeline(raw).rebind === true;
}

function markAddressUsed(userId, address) {
  const email = String(address || '').trim();
  if (!email) return 0;
  return db.prepare(
    `UPDATE emails SET status = '已使用', used_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
     WHERE user_id = ? AND lower(address) = lower(?) AND status != '已使用'`
  ).run(userId, email).changes;
}

function persistEmailAfterVerify(userId, id, { originalEmail, newEmail } = {}) {
  const next = String(newEmail || '').trim();
  const previous = String(originalEmail || '').trim();
  if (!next) throw Object.assign(new Error('换绑成功但缺少新邮箱'), { code: 'REBIND_EMAIL_MISSING' });
  const clash = db.prepare(
    'SELECT id FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?) AND id != ?'
  ).get(userId, next, id);
  if (clash) {
    throw Object.assign(new Error('新邮箱已被本用户其他账号占用'), { code: 'REBIND_EMAIL_TAKEN' });
  }
  db.prepare(
    `UPDATE gpt_accounts SET
       original_email = CASE WHEN COALESCE(original_email, '') = '' THEN ? ELSE original_email END,
       email = ?,
       rebind_email = ?,
       rebind_status = 'pending',
       rebind_error = '',
       rebind_attempted_at = ?,
       updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(previous, next, next, now(), now(), id, userId);
  markAddressUsed(userId, previous);
  return { email: next, original_email: previous };
}

function persistRebindAccessToken(userId, id, accessToken, options = {}) {
  const token = String(accessToken || '').trim();
  if (!token) throw Object.assign(new Error('登录没有拿到 AT'), { code: 'REBIND_AT_MISSING' });
  const meta = accountJob.jwtMetadata(token);
  const complete = options.complete !== false;
  if (!complete) {
    db.prepare(
      `UPDATE gpt_accounts SET
         access_token = ?,
         chatgpt_account_id = CASE WHEN ? != '' THEN ? ELSE chatgpt_account_id END,
         expires_at = CASE WHEN ? != '' THEN ? ELSE expires_at END,
         token_invalidated = 0,
         last_refresh_at = ?,
         last_security_state = 'rebind_login',
         updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      encrypt(token),
      meta?.accountId || '',
      meta?.accountId || '',
      meta?.expiresAt || '',
      meta?.expiresAt || '',
      now(),
      now(),
      id,
      userId,
    );
    return;
  }
  db.prepare(
    `UPDATE gpt_accounts SET
       access_token = ?,
       chatgpt_account_id = CASE WHEN ? != '' THEN ? ELSE chatgpt_account_id END,
       expires_at = CASE WHEN ? != '' THEN ? ELSE expires_at END,
       token_invalidated = 0,
       last_refresh_at = ?,
       last_security_state = 'rebind_refreshed',
       rebind_status = 'ok',
       rebind_error = '',
       rebind_done_at = ?,
       updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(
    encrypt(token),
    meta?.accountId || '',
    meta?.accountId || '',
    meta?.expiresAt || '',
    meta?.expiresAt || '',
    now(),
    now(),
    now(),
    id,
    userId,
  );
}

function markRebindPending(userId, id, rebindEmail = '') {
  db.prepare(
    `UPDATE gpt_accounts SET
       rebind_status = 'pending',
       rebind_email = CASE WHEN ? != '' THEN ? ELSE rebind_email END,
       rebind_error = '',
       rebind_attempted_at = ?,
       updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(rebindEmail, rebindEmail, now(), now(), id, userId);
}

function markRebindFailure(userId, id, error, { cooling = true } = {}) {
  const row = db.prepare('SELECT rebind_attempts FROM gpt_accounts WHERE id = ? AND user_id = ?').get(id, userId);
  const attempts = (Number(row?.rebind_attempts) || 0) + 1;
  const over = attempts >= REBIND_ATTEMPT_CAP;
  const status = over ? 'failed' : (cooling ? 'cooling' : 'failed');
  const message = String(error?.message || error || '').slice(0, 240);
  db.prepare(
    `UPDATE gpt_accounts SET
       rebind_status = ?,
       rebind_error = ?,
       rebind_attempts = ?,
       rebind_attempted_at = ?,
       updated_at = ?
     WHERE id = ? AND user_id = ?`
  ).run(status, message, attempts, now(), now(), id, userId);
  return { attempts, status };
}

function pickRebindDomain(userId, settings, currentEmail) {
  const current = emailDomain(currentEmail);
  const enabled = enabledCfDomains(settings).filter((domain) => domain && domain !== current);
  const dashed = enabled.filter((domain) => domain.includes('-mail'));
  const pool = dashed.length ? dashed : enabled;
  if (!pool.length) {
    throw Object.assign(new Error('没有可换绑的 CF 邮箱后缀'), { code: 'REBIND_NO_CF_DOMAIN' });
  }
  const picked = pickQuotaSuffix(userId, pool, { settings, mode: 'generate' });
  if (!picked) {
    throw Object.assign(new Error('CF 邮箱后缀配额已用完'), { code: 'REBIND_CF_QUOTA' });
  }
  return picked;
}

async function acquireRebindMailbox(userId, settings, currentEmail) {
  if (typeof hooks.acquireRebindMailbox === 'function') {
    return hooks.acquireRebindMailbox(userId, settings, currentEmail);
  }
  if (!cfMailReady(settings)) {
    throw Object.assign(new Error('CF Worker 邮箱未配置'), { code: 'CFWORKER_MAIL_NOT_CONFIGURED' });
  }
  const cfg = cfMailConfig(settings);
  const current = String(currentEmail || '').trim().toLowerCase();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const domain = pickRebindDomain(userId, settings, currentEmail);
    const channel = new CfWorkerMailChannel({
      apiUrl: cfg.api_url,
      apiKey: cfg.api_key,
      domain,
    });
    const acquired = await channel.acquire();
    const email = String(acquired.email || channel.email || '').trim();
    if (!email) {
      lastError = Object.assign(new Error('CF Worker 没有返回新邮箱'), { code: 'CFWORKER_MAIL_CREATE_FAILED' });
      continue;
    }
    if (email.toLowerCase() === current) {
      lastError = Object.assign(new Error('新邮箱与当前邮箱相同'), { code: 'REBIND_SAME_EMAIL' });
      continue;
    }
    const clash = db.prepare(
      'SELECT id FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)'
    ).get(userId, email);
    if (clash) {
      lastError = Object.assign(new Error('新邮箱已存在于账号表'), { code: 'REBIND_EMAIL_EXISTS' });
      continue;
    }
    channel.email = email;
    return { channel, email, domain: emailDomain(email) };
  }
  throw lastError || Object.assign(new Error('申请换绑邮箱失败'), { code: 'REBIND_MAIL_ACQUIRE_FAILED' });
}

async function loginForAccessToken(proxy, creds, { cancelled, log } = {}) {
  if (typeof hooks.loginForAccessToken === 'function') {
    return hooks.loginForAccessToken(proxy, creds, { cancelled, log });
  }
  return withExtractSession({ proxy, timeoutMs: 45000 }, async (session) => (
    loginWebSession(session, creds, { cancelled, log })
  ));
}

async function refreshAccessToken(detail, {
  proxy, cancelled, log, userId, rowId, reason,
} = {}) {
  log?.(reason || '用密码+TOTP 登录拿 AT');
  const tokens = await loginForAccessToken(proxy, {
    email: detail.email,
    password: detail.password,
    totp: detail.totp_secret,
  }, { cancelled, log });
  persistRebindAccessToken(userId, rowId, tokens.access_token, { complete: false });
  detail.access_token = tokens.access_token;
  if (tokens.chatgpt_account_id) detail.chatgpt_account_id = tokens.chatgpt_account_id;
  return tokens;
}

async function runChangeEmailBegin(detail, mailbox, { proxy, log } = {}) {
  const ctx = changeEmailContext(detail);
  return withExtractSession({ proxy, timeoutMs: 45000 }, async (session) => {
    const eligibility = interpretEligibility(await checkChangeEmailEligibility(session, ctx));
    const eligible = canBeginChangeEmail(eligibility);
    log?.(`eligibility：${eligible ? '可换绑' : (eligibility.reason || eligibility.errorCode || '当前不能换绑')}`);
    if (!eligible) {
      throw Object.assign(new Error(eligibility.reason || eligibility.errorCode || '当前不能换绑'), {
        code: eligibility.errorCode || 'REBIND_NOT_ELIGIBLE',
        status: eligibility.status,
        tokenInvalid: isAccessTokenInvalid(eligibility),
      });
    }
    const begin = interpretMutation(await beginChangeEmail(session, ctx, mailbox.email));
    log?.(`begin：${begin.ok ? '已提交新邮箱' : (begin.reason || begin.errorCode || 'begin 失败')}`);
    if (!begin.ok) {
      throw Object.assign(new Error(begin.reason || begin.errorCode || 'begin 失败'), {
        code: begin.errorCode || 'REBIND_BEGIN_FAILED',
        status: begin.status,
        tokenInvalid: isAccessTokenInvalid(begin),
      });
    }
  });
}

async function runRebindOne(found, {
  proxy, settings, cancelled, log, userId, source,
} = {}) {
  const { row } = found;
  const detail = { ...found.detail };
  const kick = resolveRebindSource({ source, pipeline: source === 'pipeline' });
  log?.('开始换绑');
  if (kick === 'pipeline' && trialFlag(row.has_trial) !== 1) {
    throw Object.assign(new Error('无试用不换绑'), { code: 'REBIND_NO_TRIAL', skip: true });
  }
  const loginGap = rebindLoginGap(row, detail);
  if (loginGap) {
    throw Object.assign(new Error(loginGap), { code: 'REBIND_MISSING_SECRETS', skip: true });
  }

  if (emailAlreadyRebound(row, detail)) {
    log?.('邮箱已改，只刷新 AT');
    const tokens = await loginForAccessToken(proxy, {
      email: detail.email,
      password: detail.password,
      totp: detail.totp_secret,
    }, { cancelled, log });
    persistRebindAccessToken(userId, row.id, tokens.access_token);
    return { ok: true, refreshed: true, email: detail.email };
  }

  if (!hasFilled(detail.access_token)) {
    await refreshAccessToken(detail, {
      proxy, cancelled, log, userId, rowId: row.id,
      reason: '没有 AT，先用密码+TOTP 登录',
    });
  }

  const mailbox = await acquireRebindMailbox(userId, settings, detail.email);
  markRebindPending(userId, row.id, mailbox.email);
  log?.(`已申请新邮箱 ${maskEmail(mailbox.email)}`);

  try {
    await runChangeEmailBegin(detail, mailbox, { proxy, log });
  } catch (error) {
    if (!error?.tokenInvalid && !isAccessTokenInvalid(error)) throw error;
    await refreshAccessToken(detail, {
      proxy, cancelled, log, userId, rowId: row.id,
      reason: 'AT 失效，重新登录刷新',
    });
    await runChangeEmailBegin(detail, mailbox, { proxy, log });
  }

  mailbox.channel.email = mailbox.email;
  let otp = '';
  try {
    const hit = await mailbox.channel.wait(null, {}, {}, {
      timeoutMs: OTP_TIMEOUT_MS,
      intervalMs: 3000,
      cancelled,
    });
    otp = String(hit?.code || '').replace(/\D/g, '');
  } catch (error) {
    throw Object.assign(new Error('等待新邮箱验证码超时'), {
      code: error?.code || 'REBIND_OTP_TIMEOUT',
      cause: error,
    });
  }
  if (!/^\d{6}$/.test(otp)) {
    throw Object.assign(new Error('新邮箱验证码无效'), { code: 'REBIND_OTP_INVALID' });
  }

  const verifyOnce = () => withExtractSession({ proxy, timeoutMs: 45000 }, async (session) => {
    const ctx = changeEmailContext(detail);
    const verify = interpretMutation(await verifyChangeEmail(session, ctx, {
      email: mailbox.email,
      code: otp,
    }));
    log?.(`verify：${verify.ok ? '成功' : (verify.reason || verify.errorCode || '失败')}`);
    if (!verify.ok) {
      throw Object.assign(new Error(verify.reason || verify.errorCode || 'verify 失败'), {
        code: verify.errorCode || 'REBIND_VERIFY_FAILED',
        status: verify.status,
        tokenInvalid: isAccessTokenInvalid(verify),
      });
    }
  });
  try {
    await verifyOnce();
  } catch (error) {
    if (!error?.tokenInvalid && !isAccessTokenInvalid(error)) throw error;
    await refreshAccessToken(detail, {
      proxy, cancelled, log, userId, rowId: row.id,
      reason: 'AT 失效，重新登录刷新',
    });
    await verifyOnce();
  }

  persistEmailAfterVerify(userId, row.id, {
    originalEmail: detail.email,
    newEmail: mailbox.email,
  });
  log?.(`verify 成功，已改邮箱 ${maskEmail(detail.email)} → ${maskEmail(mailbox.email)}`);

  const tokens = await loginForAccessToken(proxy, {
    email: mailbox.email,
    password: detail.password,
    totp: detail.totp_secret,
  }, { cancelled, log });
  persistRebindAccessToken(userId, row.id, tokens.access_token);
  return { ok: true, email: mailbox.email, refreshed: true };
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
     VALUES (?,?,?,'account-rebind',?,?,'queued',0)`
  );
  for (const id of ids) {
    const found = accountJob.accountRow(user.id, id);
    if (!found) continue;
    if (state.pending.some((job) => Number(job.account_id) === Number(found.row.id))) continue;
    const jobId = crypto.randomUUID();
    try {
      insert.run(jobId, state.batchId, user.id, found.row.id, found.detail.email);
    } catch {
      continue;
    }
    const job = db.prepare('SELECT * FROM registration_jobs WHERE job_id=?').get(jobId);
    if (!job) continue;
    job.rebind_source = options.source || state.source || 'batch';
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
  const ids = [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) {
    throw Object.assign(new Error('请先选择至少一个账号'), { status: 400, code: 'REBIND_IDS_REQUIRED' });
  }
  const source = resolveRebindSource(body, 'batch');
  const slot = jobSlotKey(user.id, channel);
  const settings = readSettings(user.id);
  const owned = ids.filter((id) => db.prepare(
    `SELECT id FROM gpt_accounts WHERE user_id = ? AND id = ? AND ${channelSql()}`
  ).get(user.id, id, channel));
  const rows = owned.map((id) => accountJob.accountRow(user.id, id)).filter(Boolean);
  const classified = classifyRebindSelection(rows, Date.now(), { source, pipeline: body.pipeline === true });
  const eligible = classified.eligible;
  const skippedNoTrial = classified.skipped_no_trial.length;
  const skippedOther = classified.skipped_other.length;
  const rowById = new Map(rows.map((found) => [Number(found.row.id), found]));
  for (const item of classified.skip_reasons || []) {
    const found = rowById.get(Number(item.id));
    const email = maskEmail(found?.detail?.email || found?.row?.email || item.id);
    opLog.account(
      user.id,
      'info',
      `${email}：跳过换绑（${item.reason}）`,
      { source: 'rebind' },
    );
  }
  if (runtimes.get(slot)?.running) {
    const queued = enqueue(user, eligible.map((found) => found.row.id), { channel, source });
    return {
      ...queued,
      requested: ids.length,
      accepted: queued.accepted,
      skipped_no_trial: skippedNoTrial,
      skipped: skippedNoTrial + skippedOther,
      source,
    };
  }
  if (!eligible.length) {
    if (source === 'pipeline' && skippedNoTrial) {
      opLog.account(
        user.id,
        'info',
        `流水线换绑：跳过无试用 ${skippedNoTrial} 个`,
        { source: 'rebind' },
      );
      return {
        ok: true,
        requested: ids.length,
        accepted: 0,
        skipped_no_trial: skippedNoTrial,
        skipped: skippedNoTrial + skippedOther,
        source,
        message: `已跳过 ${skippedNoTrial} 个无试用账号`,
      };
    }
    const loginSkipMessage = summarizeLoginSkipMessage(classified.skip_reasons);
    if (loginSkipMessage) {
      return {
        ok: true,
        requested: ids.length,
        accepted: 0,
        skipped_no_trial: skippedNoTrial,
        skipped: skippedNoTrial + skippedOther,
        source,
        message: loginSkipMessage,
      };
    }
    throw Object.assign(new Error('所选账号均不符合换绑条件'), {
      status: 422, code: 'REBIND_NO_ELIGIBLE_ACCOUNTS',
    });
  }
  const concurrency = clampRebindConcurrency(body.concurrency, eligible.length);
  requireChannelDynamicProxy(user.id, country, `rebind-preflight:${user.id}`, settings);

  const batchId = crypto.randomUUID();
  const state = { running: true, stop: false, batchId, pending: [], cursor: 0, concurrency, channel, source };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO registration_runs (run_id,user_id,target,concurrency,running,finished,started_at,message)
       VALUES (?,?,?,?,1,0,?,?)`
    ).run(batchId, user.id, eligible.length, concurrency, now(), '协议换绑批次已启动');
    db.prepare(
      `INSERT INTO registration_batches
       (batch_id,user_id,run_id,kind,status,total,concurrency,queued,message,created_at)
       VALUES (?,?,?,'account-rebind','running',?,?,?,'协议换绑批次已启动',?)`
    ).run(batchId, user.id, batchId, eligible.length, concurrency, eligible.length, now());
    const insert = db.prepare(
      `INSERT INTO registration_jobs
       (job_id,batch_id,user_id,kind,account_id,email,status,progress)
       VALUES (?,?,?,'account-rebind',?,?,'queued',0)`
    );
    eligible.forEach((found) => insert.run(crypto.randomUUID(), batchId, user.id, found.row.id, found.detail.email));
  })();

  runtimes.set(slot, state);
  opLog.account(
    user.id,
    'info',
    source === 'pipeline'
      ? `流水线换绑：受理 ${eligible.length} 个，跳过无试用 ${skippedNoTrial} 个`
      : `手工批量换绑：强制受理 ${eligible.length} 个，跳过无法登录 ${skippedOther} 个`,
    { source: 'rebind' },
  );
  const nextProxy = (jobId, attempt) => requireChannelDynamicProxy(
    user.id,
    country,
    `${batchId}:${jobId}:${attempt || 1}`,
    settings,
  );

  state.pending = db.prepare('SELECT * FROM registration_jobs WHERE batch_id=? ORDER BY rowid').all(batchId)
    .map((job) => ({ ...job, rebind_source: source }));
  state.cursor = 0;

  const worker = async () => {
    while (!state.stop) {
      const job = state.pending[state.cursor++];
      if (!job) return;
      registerJob._test.patchRegistrationJob(job.job_id, { status: 'running', progress: 10, attempt: 1 });
      const found = accountJob.accountRow(user.id, job.account_id);
      const log = (message, level = 'info') => {
        if (level === 'debug') return;
        opLog.account(
          user.id,
          level === 'ok' ? 'success' : level,
          `${maskEmail(found?.detail.email || job.email)}：${String(message).slice(0, 220)}`,
          { source: 'rebind' },
        );
        registerJob._test.patchRegistrationJob(job.job_id, {
          progress: Math.min(90, 20),
          error: String(message).slice(0, 240),
        });
      };
      try {
        if (!found) throw Object.assign(new Error('账号不存在'), { code: 'ACCOUNT_NOT_FOUND' });
        const proxy = nextProxy(job.job_id, 1);
        const result = await runRebindOne(found, {
          proxy,
          settings,
          cancelled: () => state.stop,
          log,
          userId: user.id,
          source: job.rebind_source || state.source || source,
        });
        registerJob._test.patchRegistrationJob(job.job_id, {
          status: 'success',
          progress: 100,
          error: '',
          result: { success: true, email: maskEmail(result.email || found.detail.email) },
        });
        log('换绑成功并已刷新 AT', 'ok');
      } catch (error) {
        if (state.stop || error?.code === 'JOB_CANCELLED') {
          registerJob._test.patchRegistrationJob(job.job_id, {
            status: 'cancelled',
            progress: 100,
            error_code: 'JOB_CANCELLED',
            error: '任务已取消',
          });
          continue;
        }
        if (error?.skip) {
          log(`跳过换绑：${String(error.message || error).slice(0, 160)}`, 'warning');
          registerJob._test.patchRegistrationJob(job.job_id, {
            status: 'skipped',
            progress: 100,
            error_code: error.code || 'REBIND_SKIPPED',
            error: String(error.message || error).slice(0, 240),
          });
          continue;
        }
        const marked = markRebindFailure(user.id, job.account_id, error);
        log(`换绑失败：${String(error.message || error).slice(0, 160)}`, 'warning');
        registerJob._test.patchRegistrationJob(job.job_id, {
          status: 'failed',
          progress: 100,
          error_code: String(error.code || 'REBIND_FAILED'),
          error: String(error.message || error).slice(0, 240),
          result: { attempts: marked.attempts, status: marked.status },
        });
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
        `UPDATE registration_jobs SET status='failed',progress=100,error_code='REBIND_BATCH_ABORTED',
         error='批次执行器提前结束',finished_at=datetime('now','localtime'),updated_at=datetime('now','localtime')
         WHERE batch_id=? AND status IN ('queued','running')`
      ).run(batchId);
    }
    registerJob._test.syncBatch(batchId, state.stop ? '协议换绑批次已取消' : '协议换绑批次已完成', state.stop ? 'cancelled' : '');
    state.running = false;
    runtimes.delete(slot);
    try {
      if (isGcChannel(channel)) require('./accountGcPipeline').kick(user.id);
      else require('./accountPipeline').kick(user.id);
    } catch { /* poller optional */ }
  });

  return {
    ok: true,
    batch_id: batchId,
    job_ids: state.pending.map((row) => row.job_id),
    requested: ids.length,
    accepted: eligible.length,
    skipped_no_trial: skippedNoTrial,
    skipped: skippedNoTrial + skippedOther,
    source,
    effective_concurrency: concurrency,
    proxy_country: country,
    dynamic_proxy: true,
  };
}

function kickRegistered(userId, accountId, channel) {
  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: true, reason: 'bad_id' };
  const ch = normalizeChannel(channel);
  Promise.resolve()
    .then(async () => {
      if (!pipelineRebindOn(userId, ch)) return;
      const found = accountJob.accountRow(userId, id);
      if (!found || trialFlag(found.row.has_trial) !== 1) return;
      await start({ id: userId }, {
        ids: [id],
        channel: ch,
        pipeline: true,
        proxy_group: channelAutoGroup(ch),
        proxy_country: channelCountry(ch),
        dynamic_proxy: true,
        concurrency: 1,
      });
    })
    .catch((error) => {
      opLog.account(
        userId,
        'warning',
        `注册后自动换绑未启动：${String(error?.message || error).slice(0, 160)}`,
        { source: 'rebind' },
      );
    });
  return { queued: true, id };
}

function status(userId, channel) {
  const state = runtimes.get(jobSlotKey(userId, channel));
  return {
    running: Boolean(state?.running),
    finished: Boolean(state && !state.running),
    batch_id: state?.batchId || '',
    message: state?.running ? '换绑进行中' : '',
  };
}

function isLive(userId, channel) {
  return Boolean(runtimes.get(jobSlotKey(userId, channel))?.running);
}

function reconcileStale(userId) {
  if (isLive(userId) || isLive(userId, 'gc')) return 0;
  try {
    return require('./registerJob').reconcileDeadKind(userId, 'account-rebind');
  } catch {
    return 0;
  }
}

function stop(userId, channel) {
  const state = runtimes.get(jobSlotKey(userId, channel));
  if (!state?.running) return { ok: true, message: '当前没有运行中的换绑任务' };
  state.stop = true;
  if (state.batchId) registerJob.cancelBatch(userId, state.batchId);
  return { ok: true, message: '已发送停止指令' };
}

module.exports = {
  REBIND_COOLDOWN_MS,
  REBIND_ATTEMPT_CAP,
  DEFAULT_REBIND_CONCURRENCY,
  MAX_REBIND_WORKERS,
  clampRebindConcurrency,
  classifyRebindSelection,
  resolveRebindSource,
  rebindLoginGap,
  summarizeLoginSkipMessage,
  isAccessTokenInvalid,
  start,
  stop,
  status,
  isLive,
  enqueue,
  kickRegistered,
  reconcileStale,
  selectRebindIds,
  rebindBlocksExtract,
  emailAlreadyRebound,
  inRebindCooldown,
  persistEmailAfterVerify,
  persistRebindAccessToken,
  markRebindFailure,
  markRebindPending,
  markAddressUsed,
  _test: {
    runtimes,
    hooks,
    runRebindOne,
    acquireRebindMailbox,
    pickRebindDomain,
    RebindLoginError,
  },
};
