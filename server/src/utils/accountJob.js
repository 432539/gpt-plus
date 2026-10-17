const db = require('../db');
const { decrypt, encrypt } = require('./crypto');
const { readSettings, cloakLicenseKeys } = require('./settings');
const { toDetail } = require('./accountFields');
const { waitMailOtp } = require('./mailOtp');
const opLog = require('./opLog');
const { resolveTrial, resolveTrialOnce, paidPlanFromCheck, trialKnown, activatedPlanFromCheck, accountCheckPayloadUsable, subscriptionExpiresFromCheck, isPaidPlan } = require('./accountCheck');
const { persistDerivedProgress, markPaid } = require('./accountProgress');
const { requestAccountCheck } = require('./accountDetectHttp');
const { jobSlotKey, normalizeChannel, channelSql } = require('./accountChannel');
const { requireChannelDynamicProxy, nextChannelProxy, channelCountry } = require('./channelProxy');

const DETECT_HTTP_CONCURRENCY = 5;

const jobs = new Map();
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function emptyState(kind = '') {
  return {
    kind, running: false, stop: false, finished: false, target: 0, completed: 0,
    success: 0, failed: 0, skipped: 0, current_email: '', current_id: 0, ids: [], emails: [], message: '',
  };
}

function status(userId, channel) {
  const value = jobs.get(jobSlotKey(userId, channel)) || emptyState();
  const { runtime, ...safe } = value;
  return safe;
}

function loadProxies(userId, groupName) {
  if (!groupName) return [];
  return db.prepare('SELECT * FROM proxies WHERE user_id = ? AND group_name = ? ORDER BY id').all(userId, groupName).map(row => ({
    proxy_type: row.proxy_type || 'http', host: row.host, port: row.port,
    username: row.username || '', password: decrypt(row.password_enc || ''),
  }));
}

function responseStatus(response) {
  const status = Number(response?.status) || 0;
  if (status) return status;
  if (response?.ok === true) return 200;
  return 0;
}

function responseBodyText(response) {
  return String(response?.data?.detail || response?.data?.error?.message || response?.text || '');
}

function looksLikeTransportFailure(response) {
  const status = responseStatus(response);
  const text = responseBodyText(response).toLowerCase();
  if (status === 0 || status === 408 || status === 429 || status >= 500) return true;
  if (/cloudflare|just a moment|attention required|cf-ray|error code 5\d\d|<!doctype|<html/.test(text)) return true;
  if (status === 403) {
    const data = response?.data;
    const hasAccountSignal = data && typeof data === 'object' && (data.detail || data.error || data.accounts);
    if (!hasAccountSignal) return true;
  }
  return false;
}

function classifyRemoteResponse(response) {
  const status = responseStatus(response);
  const text = responseBodyText(response).toLowerCase();
  if (status === 401 || /token[_ -]?invalidated|invalid token/.test(text)) {
    return { accountStatus: '令牌失效', securityState: 'token_invalidated', tokenInvalidated: true, terminal: true };
  }
  if (status === 403 && /deactivat|deleted|disabled/.test(text)) {
    return { accountStatus: '已停用', securityState: 'deactivated', tokenInvalidated: false, terminal: true };
  }
  if (status === 403 && /banned|suspended/.test(text) && !/cloudflare|<!doctype|<html/.test(text)) {
    return { accountStatus: '已封禁', securityState: 'banned', tokenInvalidated: false, terminal: true };
  }
  if (looksLikeTransportFailure(response)) {
    return { transportFailure: true, terminal: false };
  }
  if (status >= 200 && status < 300) {
    return { accountStatus: '正常', securityState: 'active', tokenInvalidated: false, terminal: false };
  }
  return { accountStatus: '检测失败', securityState: `http_${status || 'unknown'}`, tokenInvalidated: false, terminal: false };
}

function jwtMetadata(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const auth = payload?.['https://api.openai.com/auth'] || {};
    const plan = String(auth.chatgpt_plan_type || 'Free');
    return {
      expired: Number(payload.exp) > 0 && Number(payload.exp) * 1000 <= Date.now(),
      expiresAt: payload.exp ? new Date(Number(payload.exp) * 1000).toISOString().replace('T', ' ').slice(0, 19) : '',
      planType: ['free', 'plus', 'pro', 'team'].includes(plan.toLowerCase()) ? `${plan[0].toUpperCase()}${plan.slice(1).toLowerCase()}` : 'Free',
      accountId: String(auth.chatgpt_account_id || ''),
      plusOnFreeTrial: auth.chatgpt_plus_on_free_trial === true,
      hasUsedTrial: auth.has_used_trial === true || auth.chatgpt_has_used_free_trial === true,
    };
  } catch { return null; }
}

async function automation() {
  const [{ CloakRuntime }, oauth, existingLogin] = await Promise.all([
    import('../automation/cloak.js'),
    import('../automation/lib/chatgpt-oauth.js'),
    import('../automation/flows/existing-account-login.js'),
  ]);
  return {
    CloakRuntime,
    refreshDurableCredentials: oauth.refreshDurableCredentials,
    loginAndRefreshExistingAccount: existingLogin.loginAndRefreshExistingAccount,
  };
}

function accountRow(userId, id) {
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE user_id = ? AND id = ?').get(userId, id);
  return row ? { row, detail: toDetail(row) } : null;
}

async function detectOne(userId, id, runtime, proxy, state) {
  const found = accountRow(userId, id);
  if (!found) throw Object.assign(new Error('账号不存在'), { code: 'ACCOUNT_NOT_FOUND' });
  const { row, detail } = found;
  if (!detail.access_token) throw Object.assign(new Error('账号缺少 access token'), { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
  const local = jwtMetadata(detail.access_token);
  return runtime.withSession({ kind: 'account-detect', proxy, headless: true, cancelled: () => state.stop }, async session => {
    const response = await session.request('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', {
      headers: { Authorization: `Bearer ${detail.access_token}`, Accept: 'application/json', 'OAI-Language': 'en-US' },
      contextUrl: 'https://chatgpt.com/', timeout: 30000,
    }).catch(error => ({ status: 0, text: String(error?.message || error) }));
    const verdict = classifyRemoteResponse(response);
    if (verdict.transportFailure) throw Object.assign(new Error('检测传输失败，账号状态保持不变'), { code: 'ACCOUNT_DETECT_TRANSPORT', retryable: true });
    let mfaEnabled = row.mfa_enabled;
    let factorId = row.mfa_factor_id || '';
    if (response.ok) {
      const mfa = await session.request('https://chatgpt.com/backend-api/accounts/mfa_info', {
        headers: { Authorization: `Bearer ${detail.access_token}`, Accept: 'application/json' },
        contextUrl: 'https://chatgpt.com/', timeout: 15000,
      }).catch(() => null);
      if (mfa?.ok) {
        const root = mfa.data?.data || mfa.data || {};
        mfaEnabled = root.mfa_enabled_v2 === true || root.mfa_enabled === true ? 1 : 0;
        factorId = String(root.native_default_factor_id || factorId);
      }
    }
    return finalizeDetect(userId, id, persistDetectResult(userId, id, row, detail, {
      response, verdict, local, mfaEnabled, factorId, updatePlan: true,
    }));
  });
}

function remoteCheckOk(response) {
  if (!response) return false;
  if (response.ok === true) return true;
  const status = Number(response.status) || 0;
  return status >= 200 && status < 300;
}

function persistDetectResult(userId, id, row, detail, options = {}) {
  const response = options.response || {};
  const verdict = options.verdict || classifyRemoteResponse(response);
  if (verdict.transportFailure) {
    return {
      id: Number(id),
      skipped: true,
      transport: true,
      status: row.status,
      has_trial: trialKnown(row.has_trial) ? Number(row.has_trial) : null,
    };
  }
  const local = options.local || jwtMetadata(detail?.access_token);
  const mfaEnabled = options.mfaEnabled === undefined ? row.mfa_enabled : options.mfaEnabled;
  const factorId = options.factorId || row.mfa_factor_id || '';
  const accountStatus = verdict.accountStatus === '正常' && local?.expired ? '已过期' : verdict.accountStatus;
  const trial = resolveTrialOnce(row, {
    check: remoteCheckOk(response) ? response.data : undefined,
    accessToken: detail?.access_token,
  });
  let trialWritten = null;
  let planType = row.plan_type;
  // Detection may refresh a paid plan only after this application recorded an
  // actual activation. Stored progress/JWT/trial metadata is not payment proof.
  if (options.updatePlan === true && String(row.activated_at || '').trim()) {
    const paid = paidPlanFromCheck(remoteCheckOk(response) ? response.data : null);
    if (paid) planType = paid;
  }
  const set = [
    'status = ?', 'plan_type = ?', 'expires_at = ?', 'chatgpt_account_id = ?',
    'mfa_enabled = ?', 'mfa_factor_id = ?', 'last_security_state = ?', 'token_invalidated = ?',
    'last_detected_at = ?', 'updated_at = ?',
  ];
  const params = [
    accountStatus, planType, local?.expiresAt || row.expires_at,
    local?.accountId || row.chatgpt_account_id, mfaEnabled, factorId, verdict.securityState,
    verdict.tokenInvalidated ? 1 : 0, now(), now(),
  ];
  if (!trialKnown(row.has_trial) && (trial.has_trial === 0 || trial.has_trial === 1)) {
    set.push('has_trial = ?', 'trial_label = ?');
    params.push(trial.has_trial, trial.trial_label || '');
    trialWritten = trial.has_trial;
  }
  params.push(id, userId);
  db.prepare(`UPDATE gpt_accounts SET ${set.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  persistDerivedProgress(userId, id, {
    ...row,
    plan_type: planType,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
  });
  return {
    id: Number(id),
    status: accountStatus,
    security_state: verdict.securityState,
    mfa_enabled: Boolean(mfaEnabled),
    has_trial: trial.has_trial,
    trial_written: trialWritten,
    skipped: false,
    transport: false,
  };
}

async function finalizeDetect(userId, id, result, options = {}) {
  if (!result || result.skipped || result.transport) return result;
  try {
    const { afterAccountChange } = require('./accountHousekeeping');
    const extra = await afterAccountChange(userId, id, {
      fetchImpl: options.fetchImpl,
    });
    if (extra?.cleaned) result.cleaned = true;
  } catch (error) {
    opLog.account(userId, 'warning', `账号收尾处理失败：${String(error.message || error).slice(0, 160)}`, {
      source: 'housekeeping',
    });
  }
  return result;
}

function isTokenInvalidatedError(error) {
  const code = String(error?.code || '');
  if (code === 'ACCOUNT_TOKEN_INVALIDATED') return true;
  if (/ACCOUNT_TOKEN_INVALIDATED/i.test(code)) return true;
  const message = String(error?.message || '');
  return /账号 Token 已被作废|ACCOUNT_TOKEN_INVALIDATED/i.test(message);
}

async function recheckAfterTokenInvalidated(userId, id, options = {}) {
  const found = accountRow(userId, id);
  let proxy = options.proxy;
  if (proxy === undefined) {
    try {
      proxy = requireChannelDynamicProxy(
        userId,
        channelCountry(found?.row?.channel),
        `token-recheck:${id}`,
      );
    } catch (error) {
      opLog.account(
        userId,
        'warning',
        `${options.email ? `${options.email}：` : ''}Token 即时复核失败：${String(error.message || error).slice(0, 160)}，不会回退手工检测组`,
        { source: options.source || 'token-recheck' },
      );
      return { skipped: true, reason: 'dynamic_proxy_not_configured' };
    }
  }
  const result = await detectViaToken(userId, id, {
    proxy,
    fetchImpl: options.fetchImpl,
    trialOnly: false,
  });
  const email = options.email ? `${options.email}：` : '';
  const source = options.source || 'token-recheck';
  if (result?.transport || result?.skipped) {
    opLog.account(userId, 'warning', `${email}Token 即时复核未完成，状态保持不变`, { source });
    return result;
  }
  if (result?.status === '令牌失效') {
    opLog.account(userId, 'warning', `${email}Token 即时复核：已确认失效`, { source });
  } else {
    opLog.account(userId, 'info', `${email}Token 即时复核：${result?.status || '正常'}，可按上限继续重试`, { source });
  }
  return result;
}

async function detectViaToken(userId, id, { proxy, fetchImpl, trialOnly = false } = {}) {
  const found = accountRow(userId, id);
  if (!found) return { skipped: true, reason: 'missing' };
  const { row, detail } = found;
  if (!detail.access_token) return { skipped: true, reason: 'no_token' };
  if (trialOnly && trialKnown(row.has_trial)) {
    return { id: Number(id), skipped: true, reason: 'trial_known', has_trial: Number(row.has_trial), status: row.status };
  }
  if (trialOnly && !trialKnown(row.has_trial)) {
    const jwtTrial = resolveTrial({ accessToken: detail.access_token });
    if (jwtTrial.has_trial === 1) {
      db.prepare('UPDATE gpt_accounts SET has_trial = ?, trial_label = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(1, jwtTrial.trial_label || '', now(), id, userId);
      return { id: Number(id), status: row.status, has_trial: 1, source: 'jwt', skipped: false };
    }
  }
  const response = await requestAccountCheck(detail.access_token, { proxy, fetchImpl });
  const result = persistDetectResult(userId, id, row, detail, {
    response,
    local: jwtMetadata(detail.access_token),
    updatePlan: false,
  });
  await finalizeDetect(userId, id, result, { fetchImpl });
  return result;
}

function refreshTransportRetryable(error) {
  if (error?.retryable === true) return true;
  if (['PROTOCOL_REQUEST_TIMEOUT', 'PROTOCOL_REQUEST_NETWORK', 'ACCOUNT_RT_SESSION_PROBE_TRANSPORT',
    'ACCOUNT_RT_LOGIN_ENTRY_FAILED', 'ACCOUNT_RT_LOGIN_CONTROL_STALLED', 'ACCOUNT_RT_NO_CALLBACK',
    'CLOAK_BROWSER_DISCONNECTED', 'CLOAK_BROWSER_CRASHED'].includes(String(error?.code || ''))) return true;
  return /net::|timeout|timed out|failed to fetch|socket hang up|econnreset|browser has been closed|target closed/i
    .test(String(error?.message || error));
}

function isPermanentRefreshFailure(error) {
  if (error?.permanent === true) return true;
  if (String(error?.code || '') === 'ACCOUNT_RT_REFRESH_VERIFY_FAILED') return false;
  return /refresh_token_(?:expired|reused|invalidated)|invalid_grant/i
    .test(`${error?.code || ''} ${error?.message || ''}`);
}

function persistRefreshResult(userId, id, row, result) {
  const accessToken = String(result?.access_token || '');
  const metadata = jwtMetadata(accessToken);
  if (!accessToken || !metadata) {
    throw Object.assign(new Error('刷新结果缺少有效 access token，未写入'), { code: 'ACCOUNT_REFRESH_INVALID_TOKEN' });
  }
  const refreshToken = String(result.refresh_token || '');
  const updatedAt = now();
  const transaction = db.transaction(() => {
    const current = db.prepare('SELECT id, refresh_token FROM gpt_accounts WHERE id = ? AND user_id = ?').get(id, userId);
    if (!current) throw Object.assign(new Error('账号在刷新期间已被删除'), { code: 'ACCOUNT_NOT_FOUND' });
    const storedRefresh = refreshToken ? encrypt(refreshToken) : current.refresh_token;
    const hasRt = Boolean(refreshToken || current.refresh_token);
    db.prepare(`UPDATE gpt_accounts SET access_token = ?, refresh_token = ?, client_id = ?,
      chatgpt_account_id = ?, expires_at = ?, status = '正常',
      token_invalidated = 0, last_security_state = ?, last_refresh_at = ?, updated_at = ?,
      remark = CASE WHEN ? = 1 THEN '已拿RT' ELSE remark END
      WHERE id = ? AND user_id = ?`).run(
      encrypt(accessToken),
      storedRefresh,
      result.client_id || row.client_id,
      metadata.accountId || result.chatgpt_account_id || row.chatgpt_account_id,
      metadata.expiresAt,
      result.partial ? (result.phone_required ? 'refreshed_at_phone_required' : 'refreshed_session_only') : 'refreshed_durable',
      updatedAt,
      updatedAt,
      hasRt ? 1 : 0,
      id,
      userId,
    );
    if (!trialKnown(row.has_trial)) {
      const trial = resolveTrial({ accessToken });
      if (trial.has_trial === 0 || trial.has_trial === 1) {
        db.prepare('UPDATE gpt_accounts SET has_trial = ?, trial_label = ? WHERE id = ? AND user_id = ?')
          .run(trial.has_trial, trial.trial_label || '', id, userId);
      }
    }
    if (hasRt) {
      db.prepare(
        `UPDATE gpt_accounts SET extract_link = '', extracted_at = '' WHERE id = ? AND user_id = ?`
      ).run(id, userId);
    }
    persistDerivedProgress(userId, id, {
      ...row,
      plan_type: row.plan_type,
      access_token: accessToken,
      refresh_token: refreshToken || row.refresh_token,
      extract_link: hasRt ? '' : row.extract_link,
      extracted_at: hasRt ? '' : row.extracted_at,
    });
  });
  transaction();
  return {
    id: Number(id),
    status: '正常',
    partial: result.partial === true,
    phone_required: result.phone_required === true,
    has_refresh_token: Boolean(refreshToken || row.refresh_token),
    rotated: result.rotated === true,
    expires_at: metadata.expiresAt,
  };
}

function pickPlanCheckProxy(userId, channel) {
  return requireChannelDynamicProxy(userId, channelCountry(channel), `plan-check:${userId}:${Date.now()}`);
}

async function persistPlanAfterRt(userId, id, { proxy, fetchImpl } = {}) {
  const found = accountRow(userId, id);
  if (!found) return { skipped: true, reason: 'missing' };
  const { row, detail } = found;
  if (!detail.access_token) return { skipped: true, reason: 'no_token' };
  let chosenProxy = proxy;
  if (chosenProxy === undefined) {
    try {
      chosenProxy = pickPlanCheckProxy(userId, row.channel);
    } catch (error) {
      opLog.account(
        userId,
        'warning',
        `套餐回填失败：${String(error.message || error).slice(0, 160)}，不会回退支付组`,
        { source: 'refresh' },
      );
      return { skipped: true, reason: 'dynamic_proxy_not_configured' };
    }
  }
  const response = await requestAccountCheck(detail.access_token, { proxy: chosenProxy, fetchImpl });
  const verdict = classifyRemoteResponse(response);
  if (verdict.transportFailure) {
    return { skipped: true, transport: true, reason: 'transport' };
  }
  if (!remoteCheckOk(response) || !accountCheckPayloadUsable(response.data)) {
    return { skipped: true, reason: 'check_unusable', status: Number(response?.status) || 0 };
  }
  const planType = activatedPlanFromCheck(response.data) || 'Free';
  const expiresAt = planType !== 'Free'
    ? subscriptionExpiresFromCheck(response.data, 30)
    : (row.expires_at || jwtMetadata(detail.access_token)?.expiresAt || '');
  const stamp = now();
  const remark = detail.refresh_token ? '已拿RT' : (row.remark || '');
  db.prepare(
    `UPDATE gpt_accounts SET plan_type = ?, expires_at = ?, remark = ?, status = ?,
     last_detected_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(planType, expiresAt, remark, verdict.accountStatus || '正常', stamp, stamp, id, userId);
  if (detail.refresh_token && isPaidPlan(planType)) {
    markPaid(userId, id, { plan_type: planType, expires_at: expiresAt });
  } else {
    persistDerivedProgress(userId, id, {
      ...row,
      plan_type: planType,
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      extract_link: detail.refresh_token ? '' : row.extract_link,
      extracted_at: detail.refresh_token ? '' : row.extracted_at,
    });
  }
  try {
    require('./pipelineState').markActivationRetryAfterFreeRt(userId, id, planType);
  } catch { /* pipeline optional */ }
  return {
    skipped: false,
    id: Number(id),
    plan_type: planType,
    expires_at: expiresAt,
    remark,
  };
}

async function backfillRtRemarkAndPlan(userId, { emails = [], proxy, fetchImpl } = {}) {
  const wanted = (emails || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const rows = wanted.length
    ? db.prepare(
      `SELECT id, email FROM gpt_accounts WHERE user_id = ? AND lower(email) IN (${wanted.map(() => '?').join(',')})`
    ).all(userId, ...wanted)
    : db.prepare(
      `SELECT id, email FROM gpt_accounts WHERE user_id = ? AND COALESCE(refresh_token, '') != ''`
    ).all(userId);
  const out = [];
  for (const row of rows) {
    const result = await persistPlanAfterRt(userId, row.id, { proxy, fetchImpl });
    out.push({ email: row.email, ...result });
  }
  return out;
}

function refreshEligibility(detail) {
  if (!detail) return { eligible: false, code: 'ACCOUNT_NOT_FOUND', reason: '账号不存在' };
  if (detail.refresh_token) return { eligible: true, mode: 'refresh_token', code: '', reason: '' };
  if (detail.password) return { eligible: true, mode: 'login', code: '', reason: '' };
  return {
    eligible: false,
    mode: '',
    code: 'ACCOUNT_REFRESH_PASSWORDLESS',
    reason: '账号没有 ChatGPT 密码或 refresh token',
  };
}

async function loginExistingAccount(userId, id, runtime, proxy, state, module, detail, options = {}) {
  const emailRow = db.prepare(
    'SELECT id FROM emails WHERE user_id = ? AND lower(address) = lower(?) ORDER BY id LIMIT 1'
  ).get(userId, detail.email);
  const loginStarted = Date.now();
  return module.loginAndRefreshExistingAccount(runtime, detail, {
    timeoutMs: 60000,
    headless: options.headless !== false,
    phone_channel: options.phone_channel || 'sms',
    profile_key: options.profile_key || `account-rt:${id}`,
    cleanup_profile: options.cleanup_profile !== false,
    session_wall_timeout_ms: options.session_wall_timeout_ms,
  }, {
    proxy,
    cancelled: () => state.stop,
    progress: (pct, message) => {
      state.message = `${detail.email}：${message}（${pct}%）`;
    },
    log: (message, level = 'info') => {
      if (level !== 'debug') opLog.account(userId, level === 'ok' ? 'success' : level, `${detail.email}：${String(message).slice(0, 220)}`, { source: 'refresh' });
    },
    getEmailOtp: emailRow
      ? () => waitMailOtp(userId, emailRow.id, {
        timeoutMs: 300000,
        intervalMs: 3000,
        after: loginStarted,
        cancelled: () => state.stop,
      })
      : null,
    phoneChannel: options.phoneChannel || null,
    getPhoneChannel: options.getPhoneChannel,
    onSessionReady: options.onSessionReady,
  });
}

async function refreshOne(userId, id, runtime, nextProxy, state, module, options = {}) {
  const found = accountRow(userId, id);
  if (!found) throw Object.assign(new Error('账号不存在'), { code: 'ACCOUNT_NOT_FOUND' });
  const { row, detail } = found;
  const eligibility = refreshEligibility(detail);
  if (!eligibility.eligible) {
    throw Object.assign(new Error(`${eligibility.reason}，无法登录刷新且未修改任何凭据`), {
      code: eligibility.code, skip: true, actionable: true,
    });
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const proxy = nextProxy();
    try {
      let result;
      if (detail.refresh_token) {
        try {
          result = await runtime.withSession({
            kind: 'account-refresh', proxy, headless: true, cancelled: () => state.stop,
          }, session => module.refreshDurableCredentials(session, {
            previous: detail, refreshToken: detail.refresh_token, clientId: detail.client_id, timeoutMs: 45000,
          }));
        } catch (error) {
          // A refresh response can be lost after the server rotated the token.
          // Replaying the same RT can trigger reuse detection and invalidate the
          // whole credential family, so uncertain exchanges are deliberately terminal.
          if (refreshTransportRetryable(error) && !isPermanentRefreshFailure(error)) {
            throw Object.assign(
              new Error('RT 续期响应状态不确定，未重放旧 RT 且原记录保持不变'),
              { code: 'ACCOUNT_RT_REFRESH_VERIFY_FAILED', terminal: true, cause: error },
            );
          }
          if (options.allowLoginFallback === true && isPermanentRefreshFailure(error)
            && detail.password && detail.totp_secret) {
            opLog.account(userId, 'warning', `${detail.email}：RT 已失效，改走密码+TOTP 登录`, { source: 'refresh' });
            result = await loginExistingAccount(userId, id, runtime, proxy, state, module, detail, options);
          } else {
            throw error;
          }
        }
      } else {
        result = await loginExistingAccount(userId, id, runtime, proxy, state, module, detail, options);
      }
      return persistRefreshResult(userId, id, row, result);
    } catch (error) {
      lastError = error;
      if (state.stop || error?.code === 'JOB_CANCELLED') throw error;
      if (!refreshTransportRetryable(error) || error?.terminal === true || error?.actionable === true || attempt >= 2) throw error;
      opLog.account(userId, 'warning', `${detail.email}：传输失败，切换代理后重试（${error.code || 'NETWORK'}）`, { source: 'refresh' });
    }
  }
  throw lastError;
}

async function start(user, body = {}, kind) {
  const userId = user.id;
  const channel = normalizeChannel(body.channel);
  const slot = jobSlotKey(userId, channel);
  if (jobs.get(slot)?.running) throw Object.assign(new Error('已有账号任务在运行'), { status: 409 });
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger))];
  const targets = ids.length
    ? ids.filter((id) => db.prepare(`SELECT id FROM gpt_accounts WHERE user_id = ? AND id = ? AND ${channelSql()}`).get(userId, id, channel))
    : db.prepare(`SELECT id FROM gpt_accounts WHERE user_id = ? AND ${channelSql()} ORDER BY id`).all(userId, channel).map((row) => row.id);
  if (!targets.length) throw Object.assign(new Error('没有可处理的账号'), { status: 400 });
  const settings = readSettings(userId);
  const licenseKeys = cloakLicenseKeys(settings.cloak);
  if (!licenseKeys.length) throw Object.assign(new Error('请先配置 CloakBrowser 授权'), { status: 400 });
  const country = channelCountry(channel);
  requireChannelDynamicProxy(userId, country, `account-${kind}-preflight:${userId}`, settings);
  const module = await automation();
  const runtime = new module.CloakRuntime({
    licenseKey: licenseKeys[0],
    licenseKeys,
    headless: settings.cloak.headless !== false,
    maxConcurrency: Math.max(1, Number(settings.cloak.max_concurrency) || 3),
  });
  const emails = targets.map((id) => String(accountRow(userId, id)?.detail.email || '').toLowerCase()).filter(Boolean);
  const state = {
    ...emptyState(kind), running: true, target: targets.length, ids: [...targets], emails,
    message: `已启动 ${targets.length} 个账号`,
  };
  state.runtime = runtime;
  jobs.set(slot, state);
  const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 1, settings.cloak.max_concurrency || 3, targets.length));
  const nextProxy = nextChannelProxy(userId, country, `account-${kind}:${userId}`, settings);
  const worker = async () => {
    while (targets.length && !state.stop) {
      const id = targets.shift();
      const found = accountRow(userId, id);
      state.current_id = Number(id) || 0;
      state.current_email = found?.detail.email || '';
      try {
        const result = kind === 'detect'
          ? await detectOne(userId, id, runtime, nextProxy(), state)
          : await refreshOne(userId, id, runtime, nextProxy, state, module);
        state.success += 1;
        opLog.account(userId, 'success', `${found?.detail.email || id}：${kind === 'detect'
          ? `检测为 ${result.status}`
          : result.partial
            ? `会话刷新成功（${result.phone_required ? '上游要求手机验证，已保留有效 AT' : '未取得 RT，已保留有效 AT'}）`
            : '凭据刷新成功'}`, { source: kind });
      } catch (error) {
        if (state.stop || error.code === 'JOB_CANCELLED') break;
        if (error.skip) state.skipped += 1;
        else state.failed += 1;
        let safeError = String(error.message || error);
        for (const secret of [
          found?.detail.password, found?.detail.totp_secret, found?.detail.access_token,
          found?.detail.refresh_token, found?.detail.client_secret,
        ].filter(Boolean)) safeError = safeError.replaceAll(String(secret), '<redacted>');
        safeError = safeError.replace(/\b[A-Z2-7]{16,128}\b/gi, '<redacted>').replace(/\b\d{6}\b/g, '<redacted>');
        opLog.account(userId, error.skip ? 'warning' : 'error', `${found?.detail.email || id}：${safeError.slice(0, 200)}（${error.code || 'ERROR'}）`, { source: kind });
      } finally {
        state.completed += 1;
        state.message = `完成 ${state.completed}/${state.target}，成功 ${state.success}，失败 ${state.failed}，跳过 ${state.skipped}`;
      }
    }
  };
  Promise.all(Array.from({ length: concurrency }, worker)).finally(() => {
    state.running = false;
    state.finished = true;
    state.current_email = '';
    state.current_id = 0;
    runtime.closeAll().catch(() => {});
  });
  return { ok: true, kind, target: state.target, concurrency };
}

function stop(userId, channel) {
  const state = jobs.get(jobSlotKey(userId, channel));
  if (!state?.running) return { ok: true, message: '当前没有运行中的账号任务' };
  state.stop = true;
  state.message = '正在停止…';
  state.runtime?.closeAll?.().catch(() => {});
  return { ok: true, message: '已发送停止指令' };
}

module.exports = {
  start, stop, status, classifyRemoteResponse, jwtMetadata,
  refreshTransportRetryable, persistRefreshResult, persistPlanAfterRt,
  backfillRtRemarkAndPlan, refreshEligibility,
  persistDetectResult, detectViaToken, loadProxies, DETECT_HTTP_CONCURRENCY,
  refreshOne, accountRow, automation, isPermanentRefreshFailure, finalizeDetect,
  isTokenInvalidatedError, recheckAfterTokenInvalidated, pickPlanCheckProxy,
};
