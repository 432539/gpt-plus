const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const { decrypt, encrypt } = require('../utils/crypto');
const { checkWritable } = require('../utils/plan');
const { getPlanContext } = require('../utils/plan');
const {
  ENCRYPTED_FIELDS,
  INSERT_COLUMNS,
  toListItem,
  toDetail,
  toColumns,
  valuesForInsert,
  encodeExtractLink,
  normalizePlan,
  normalizeEmailType,
  normalizeStatus,
} = require('../utils/accountFields');
const { parseAccountsDetailed } = require('../utils/accountParser');
const { buildExport } = require('../utils/accountExport');
const { collectLiveJobs, displayProgress, extractCopyValue, extractLinkState, normalizeProgress } = require('../utils/accountProgress');
const { normalizeTrialFlag } = require('../utils/accountCheck');
const { normalizeChannel, channelSql, isGcChannel } = require('../utils/accountChannel');
const { KEEP_ACCOUNT_SQL, deleteBlockReason } = require('../utils/accountRetention');

const router = express.Router();

function gcashPaySurface() {
  if (require('../mkGcash/enabled').mkGcashEnabled()) return require('../mkGcash/adapter');
  return require('../utils/gcashPayJob');
}

const insertStmt = () =>
  db.prepare(
    `INSERT INTO gpt_accounts (${INSERT_COLUMNS.join(', ')})
     VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`
  );

function insertRow(userId, cols) {
  return insertStmt().run(...valuesForInsert(userId, cols));
}

function parseHasTrialFilter(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'all' || value === '全部' || value === '全部资格') return null;
  if (['1', 'yes', 'true', 'y', '是', '有', '有试用', '有试用资格'].includes(value)) return 1;
  if (['0', 'no', 'false', 'n', '否', '无', '没试用', '无试用资格'].includes(value)) return 0;
  if (['unset', 'unknown', 'null', 'none', '未检测', '未知'].includes(value)) return 'unset';
  return null;
}

function buildListWhere(query = {}, userId) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.max(1, Math.min(500, Number(query.page_size) || 10));
  const keyword = String(query.keyword || '').trim();
  const status = String(query.status || '').trim();
  const planType = String(query.plan_type || '').trim();
  const emailType = String(query.email_type || '').trim();
  const trial = parseHasTrialFilter(query.has_trial);
  const channel = normalizeChannel(query.channel);

  const where = ['user_id = ?', channelSql()];
  const params = [userId, channel];
  if (keyword) {
    where.push('(email LIKE ? OR remark LIKE ? OR progress LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (planType) {
    where.push('plan_type = ?');
    params.push(planType);
  }
  if (emailType) {
    where.push('email_type = ?');
    params.push(emailType);
  }
  if (trial === 1) where.push('has_trial = 1');
  else if (trial === 0) where.push('has_trial = 0');
  else if (trial === 'unset') where.push(require('../utils/accountCheck').trialUnsetSql());

  return { whereSql: where.join(' AND '), params, page, pageSize, trial, channel };
}

function startJobResponse(res, job, user, body, fallbackMessage) {
  return job.start(user, body).then((data) => res.json(data)).catch((error) => {
    res.status(error.status || 500).json({ message: error.message || fallbackMessage });
  });
}

function requestChannel(req) {
  return normalizeChannel(req.body?.channel || req.query?.channel);
}

function extractJobFor(channel) {
  return isGcChannel(channel) ? require('../utils/gcashExtractJob') : require('../utils/oauthJob');
}

function payJobFor(channel) {
  return isGcChannel(channel) ? require('../utils/gcashPayJob') : require('../utils/activateJob');
}

function detectJobFor(channel) {
  return isGcChannel(channel) ? require('../utils/gcashDetectJob') : require('../utils/accountJob');
}

function accountChannelOfId(userId, id) {
  const row = db.prepare('SELECT channel FROM gpt_accounts WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? normalizeChannel(row.channel) : 'gb';
}

// ---------- 列表(分页 + 状态/套餐/试用资格筛选) ----------
router.get('/', (req, res) => {
  const { whereSql, params, page, pageSize, channel } = buildListWhere(req.query, req.user.id);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM gpt_accounts WHERE ${whereSql}`).get(...params).c;
  const rows = db
    .prepare(
      `SELECT * FROM gpt_accounts WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, (page - 1) * pageSize);

  const live = collectLiveJobs(req.user.id, channel);
  res.json({
    total,
    items: rows.map((row) => {
      const item = toListItem(row);
      item.progress = displayProgress(item, live);
      return item;
    }),
    page,
    page_size: pageSize,
    live_jobs: live,
  });
});

// ---------- 统计 ----------
router.get('/stats', (req, res) => {
  const uid = req.user.id;
  const rows = db.prepare(
    `SELECT plan_type, status, email_type, expires_at FROM gpt_accounts
     WHERE user_id = ? AND COALESCE(channel, 'gb') = 'gb'`
  ).all(uid);
  const planDist = {};
  const statusDist = {};
  const emailTypeDist = {};
  const today = new Date();
  const soon = new Date(Date.now() + 7 * 86400000);
  let expiring = 0;
  for (const r of rows) {
    planDist[r.plan_type] = (planDist[r.plan_type] || 0) + 1;
    statusDist[r.status] = (statusDist[r.status] || 0) + 1;
    emailTypeDist[r.email_type] = (emailTypeDist[r.email_type] || 0) + 1;
    if (r.expires_at) {
      const d = new Date(r.expires_at);
      if (!Number.isNaN(d.getTime()) && d >= today && d <= soon) expiring += 1;
    }
  }
  res.json({
    total: rows.length,
    normal: rows.filter((x) => x.status === '正常').length,
    premium: rows.filter((x) => ['Plus', 'Pro', 'Team'].includes(x.plan_type)).length,
    expiring,
    plan_dist: planDist,
    status_dist: statusDist,
    email_type_dist: emailTypeDist,
  });
});

// ---------- 账号在线检测 / 凭据刷新任务 ----------
router.get('/operations/status', (req, res) => {
  const channel = requestChannel(req);
  const job = detectJobFor(channel);
  res.json(job.status(req.user.id, isGcChannel(channel) ? undefined : channel));
});

router.post('/operations/detect', async (req, res) => {
  const channel = requestChannel(req);
  const body = { ...(req.body || {}), channel };
  try {
    if (isGcChannel(channel)) {
      return res.json(await require('../utils/gcashDetectJob').start(req.user, body));
    }
    res.json(await require('../utils/accountJob').start(req.user, body, 'detect'));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '启动检测失败' });
  }
});

router.post('/operations/refresh', async (req, res) => {
  try {
    res.json(await require('../utils/accountJob').start(req.user, { ...(req.body || {}), channel: requestChannel(req) }, 'refresh'));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '启动刷新失败' });
  }
});

router.post('/operations/stop', (req, res) => {
  const channel = requestChannel(req);
  const job = detectJobFor(channel);
  res.json(job.stop(req.user.id, isGcChannel(channel) ? undefined : channel));
});

router.post('/operations/extract', (req, res) => {
  const channel = requestChannel(req);
  startJobResponse(res, extractJobFor(channel), req.user, { ...(req.body || {}), channel }, '启动提链失败');
});

router.get('/operations/extract/status', (req, res) => {
  res.json(extractJobFor(requestChannel(req)).status(req.user.id));
});

router.post('/operations/extract/stop', (req, res) => {
  res.json(extractJobFor(requestChannel(req)).stop(req.user.id));
});

router.post('/operations/activate', (req, res) => {
  const channel = requestChannel(req);
  startJobResponse(res, payJobFor(channel), req.user, { ...(req.body || {}), channel }, '启动开通失败');
});

router.get('/operations/activate/status', (req, res) => {
  res.json(payJobFor(requestChannel(req)).status(req.user.id));
});

router.post('/operations/activate/stop', (req, res) => {
  res.json(payJobFor(requestChannel(req)).stop(req.user.id));
});

router.post('/operations/rebind', (req, res) => {
  const channel = requestChannel(req);
  startJobResponse(
    res,
    require('../utils/accountRebindJob'),
    req.user,
    { ...(req.body || {}), channel },
    '启动换绑失败',
  );
});

router.get('/operations/rebind/status', (req, res) => {
  res.json(require('../utils/accountRebindJob').status(req.user.id, requestChannel(req)));
});

router.post('/operations/rebind/stop', (req, res) => {
  res.json(require('../utils/accountRebindJob').stop(req.user.id, requestChannel(req)));
});

router.get('/live-jobs', (req, res) => {
  res.json(collectLiveJobs(req.user.id, requestChannel(req)));
});

// ---------- 参考兼容注册 / 邮箱池 / 已有账号获取 RT ----------
router.get('/active-batches', (req, res) => {
  res.json({ batches: require('../utils/registerJob').activeBatches(req.user.id) });
});
router.get('/batches/:batch_id', (req, res) => {
  const batch = require('../utils/registerJob').getBatch(req.user.id, req.params.batch_id);
  if (!batch) return res.status(404).json({ message: '批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});
router.get('/jobs/:job_id', (req, res) => {
  const job = require('../utils/registerJob').getJob(req.user.id, req.params.job_id);
  if (!job) return res.status(404).json({ message: '任务不存在', code: 'REGISTRATION_JOB_NOT_FOUND' });
  return res.json(job);
});
router.post('/batches/:batch_id/cancel', (req, res) => {
  const batch = require('../utils/registerJob').cancelBatch(req.user.id, req.params.batch_id);
  if (!batch) return res.status(404).json({ message: '活动批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json({ ok: true, ...batch });
});
router.post('/register-sms', async (req, res) => {
  try { return res.json(await require('../utils/registerJob').start(req.user, req.body || {})); }
  catch (error) { return res.status(error.status || 500).json({ message: error.message, code: error.code || 'REGISTER_START_FAILED' }); }
});
router.get('/sms-mail-options', async (req, res) => {
  const { getSmsMailOptions } = require('../automation/channels/providers');
  const { readSettings } = require('../utils/settings');
  res.json(await getSmsMailOptions(readSettings(req.user.id), req.query || {}));
});
router.get('/sms-phone-countries', async (req, res) => {
  const { getSmsPhoneCountries } = require('../automation/channels/providers');
  const { readSettings } = require('../utils/settings');
  res.json(await getSmsPhoneCountries(readSettings(req.user.id), { provider: req.query.provider }));
});
router.get('/register-sms/job/:job_id', (req, res) => {
  const job = require('../utils/registerJob').getJob(req.user.id, req.params.job_id);
  if (!job) return res.status(404).json({ message: 'SMS 注册任务不存在', code: 'REGISTRATION_JOB_NOT_FOUND' });
  return res.json(job);
});
router.get('/register-sms/:batch_id', (req, res) => {
  const batch = require('../utils/registerJob').getBatch(req.user.id, req.params.batch_id);
  if (!batch) return res.status(404).json({ message: 'SMS 注册批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});
router.post('/register-sms/:batch_id/cancel', (req, res) => {
  const batch = require('../utils/registerJob').cancelBatch(req.user.id, req.params.batch_id);
  return res.json({ ok: Boolean(batch), ...(batch || {}) });
});
router.post('/email-list/preview', (req, res) => {
  const { parseImportedMailboxList } = require('../automation/channels/providers');
  const parsed = parseImportedMailboxList(req.body?.text || req.body?.imported_mailboxes || '');
  res.json({ count: parsed.entries.length, invalid: parsed.errors.length, items: parsed.entries, errors: parsed.errors });
});
router.get('/mailboxes', (req, res) => {
  const { readSettings } = require('../utils/settings');
  const { parseImportedMailboxList } = require('../automation/channels/providers');
  const parsed = parseImportedMailboxList(readSettings(req.user.id).imported_mail?.mailboxes || '');
  res.json({ total: parsed.entries.length, items: parsed.entries.map((item, index) => ({ id: index + 1, ...item })) });
});
router.get('/mailboxes/domains', (_req, res) => {
  res.json({ items: ['outlook.com', 'hotmail.com', 'yandex.com', 'icloud.com'] });
});
router.post('/mailboxes/import', (req, res) => {
  const { readSettings, writeSettings, publicView } = require('../utils/settings');
  const { parseImportedMailboxList } = require('../automation/channels/providers');
  const text = String(req.body?.text || req.body?.mailboxes || '');
  const parsed = parseImportedMailboxList(text);
  if (parsed.errors.length) return res.status(400).json({ message: `第 ${parsed.errors[0].line} 行：${parsed.errors[0].reason}`, code: 'IMPORTED_MAIL_INVALID' });
  return res.json({ ok: true, imported: parsed.entries.length, settings: publicView(writeSettings(req.user.id, { imported_mail: { mailboxes: text } })) });
});
router.delete('/mailboxes/:mailbox_id', (req, res) => {
  const { readSettings, writeSettings } = require('../utils/settings');
  const { parseImportedMailboxList } = require('../automation/channels/providers');
  const settings = readSettings(req.user.id);
  const lines = String(settings.imported_mail?.mailboxes || '').split(/\r?\n/);
  const index = Number(req.params.mailbox_id) - 1;
  const parsed = parseImportedMailboxList(lines.join('\n'));
  if (!Number.isInteger(index) || index < 0 || index >= parsed.entries.length) {
    return res.status(404).json({ message: '邮箱池条目不存在', code: 'MAILBOX_NOT_FOUND' });
  }
  const targetEmail = parsed.entries[index].email;
  let seen = -1;
  const next = lines.filter(line => {
    const item = parseImportedMailboxList(line).entries[0];
    if (!item) return true;
    seen += 1;
    return !(seen === index && item.email === targetEmail);
  }).join('\n');
  writeSettings(req.user.id, { imported_mail: { mailboxes: next } });
  return res.json({ ok: true, removed: targetEmail });
});
router.post('/register-email-list', async (req, res) => {
  try {
    return res.json(await require('../utils/registerJob').start(req.user, {
      ...(req.body || {}), mail_provider: 'imported',
    }));
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message, code: error.code || 'REGISTER_START_FAILED' });
  }
});
router.get('/register-email-list/:batch_id', (req, res) => {
  const batch = require('../utils/registerJob').getBatch(req.user.id, req.params.batch_id);
  if (!batch) return res.status(404).json({ message: '邮箱列表注册批次不存在' });
  return res.json(batch);
});
router.post('/acquire-rt', async (req, res) => {
  try { return res.json(await require('../utils/accountRtJob').start(req.user, { ...(req.body || {}), channel: requestChannel(req) })); }
  catch (error) {
    return res.status(error.status || 500).json({
      message: error.message, code: error.code || 'ACCOUNT_RT_START_FAILED',
      ...(error.preflight_skipped ? { preflight_skipped: error.preflight_skipped } : {}),
    });
  }
});
router.get('/acquire-rt/job/:job_id', (req, res) => {
  const job = require('../utils/accountRtJob').job(req.user.id, req.params.job_id);
  if (!job) return res.status(404).json({ message: '账号获取 RT 任务不存在', code: 'ACCOUNT_RT_JOB_NOT_FOUND' });
  return res.json(job);
});
router.get('/acquire-rt/:batch_id', (req, res) => {
  const batch = require('../utils/accountRtJob').view(req.user.id, req.params.batch_id);
  if (!batch) return res.status(404).json({ message: '账号获取 RT 批次不存在', code: 'ACCOUNT_RT_BATCH_NOT_FOUND' });
  return res.json(batch);
});
router.post('/acquire-rt/:batch_id/cancel', (req, res) => {
  const batch = require('../utils/accountRtJob').cancel(req.user.id, req.params.batch_id);
  return res.json({ ok: Boolean(batch), ...(batch || {}) });
});

function dumpResultPayload(result = {}) {
  return {
    ok: true,
    skipped: Boolean(result.skipped),
    reason: result.reason || '',
    pushed: result.pushed || 0,
    deleted: result.deleted || 0,
    failed: result.failed || 0,
    emails: result.emails || [],
  };
}

router.post('/dump-no-trial', async (req, res) => {
  try {
    const result = await require('../utils/accountHousekeeping').dumpNoTrialAccounts(req.user.id);
    return res.json(dumpResultPayload(result));
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message, code: error.code || 'IMPORT_DUMP_FAILED' });
  }
});

router.post('/dump-all-accounts', async (req, res) => {
  try {
    const result = await require('../utils/accountHousekeeping').dumpAllAccounts(req.user.id);
    return res.json(dumpResultPayload(result));
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message, code: error.code || 'IMPORT_DUMP_FAILED' });
  }
});

// ---------- 单条明文密码 ----------
router.get('/:id/password', (req, res) => {
  const row = db
    .prepare('SELECT password_enc FROM gpt_accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  res.json({ password: decrypt(row.password_enc) });
});

router.get('/:id/extract-link', (req, res) => {
  const row = db
    .prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  const detail = toDetail(row);
  if (extractLinkState(detail) === 'expired') {
    return res.status(400).json({ message: '提链已过期，请重新提取', expired: true });
  }
  const link = extractCopyValue(detail);
  if (!link) return res.status(400).json({ message: '该账号还没有可复制的提链' });
  res.json({ link });
});

router.get('/gcash/paywall-wall', async (req, res) => {
  try {
    res.json(await gcashPaySurface().paywallWall(req.user.id));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '查询二维码墙失败' });
  }
});

router.post('/gcash/paywall-wall/refresh', async (req, res) => {
  try {
    res.json(await gcashPaySurface().refreshPaywallWall(req.user.id));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '批量刷新二维码失败', code: error.code || '' });
  }
});

router.post('/:id/gcash-qr/refresh', async (req, res) => {
  try {
    res.json(await gcashPaySurface().refreshPaywallQr(req.user.id, Number(req.params.id), {
      includeLink: true,
    }));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '刷新二维码失败', code: error.code || '' });
  }
});

router.get('/:id/gcash-qr', (req, res) => {
  const row = db.prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  if (!isGcChannel(row.channel)) return res.status(400).json({ message: '该账号不是 GC 通道' });
  const detail = toDetail(row);
  const state = extractLinkState(detail);
  if (state === 'expired') {
    return res.json({
      qr: '',
      link: '',
      cs_id: detail.gcash_cs_id || '',
      expired: true,
      scannable: false,
      refreshable: false,
      refresh_code: 'LINK_EXPIRED',
      refresh_message: '支付链接已过期，需要新号重新出码',
      message: '支付链接已过期，需要新号重新出码',
    });
  }
  const pay = gcashPaySurface();
  if (!require('../mkGcash/enabled').mkGcashEnabled()) {
    const { getGcashSession } = require('../utils/gcashSessionStore');
    const lease = getGcashSession(req.user.id, req.params.id);
    if (lease) {
      try { require('../utils/gcashPayJob').ensureGcashPayMonitor(req.user, req.params.id); } catch { /* keep returning QR */ }
    }
  }
  const view = pay.paywallView(row, req.user.id, { detail, includeLink: true });
  const qrMissing = !view.qr && Boolean(view.link || detail.gcash_link);
  res.json({
    ...view,
    cs_id: detail.gcash_cs_id || '',
    qr_missing: qrMissing,
    message: qrMissing ? '已有跳转链但未抽到二维码。支付墙需要二维码图片，请重新出码。' : undefined,
  });
});

router.get('/:id/gcash-pay-status', async (req, res) => {
  try {
    res.json(await gcashPaySurface().payStatus(req.user.id, Number(req.params.id)));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '查询支付状态失败' });
  }
});

router.post('/:id/detect', async (req, res) => {
  const id = Number(req.params.id);
  const accountJob = require('../utils/accountJob');
  const found = accountJob.accountRow(req.user.id, id);
  if (!found) return res.status(404).json({ message: '记录不存在' });
  if (!found.detail.access_token) return res.status(400).json({ message: '账号缺少 access token' });
  try {
    if (isGcChannel(found.row.channel)) {
      const opLog = require('../utils/opLog');
      const { checkGcashTrialForUser } = require('../utils/checkGcashTrial');
      const result = await checkGcashTrialForUser(req.user.id, found.detail, {
        identity: found.detail.email,
      });
      db.prepare(
        `UPDATE gpt_accounts SET has_trial = ?, trial_label = ?, last_detected_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
         WHERE id = ? AND user_id = ?`
      ).run(result.has_trial === 1 ? 1 : 0, result.has_trial === 1 ? 'gcash-cpmt' : '', id, req.user.id);
      opLog.account(
        req.user.id,
        'success',
        `${found.detail.email || id}：GCash 资格 ${result.has_trial === 1 ? '是' : '否'}`,
        { source: 'gcash-detect' },
      );
      return res.json({ ...result, status: found.detail.status, has_trial: result.has_trial });
    }
    const { requireChannelDynamicProxy } = require('../utils/channelProxy');
    const proxy = requireChannelDynamicProxy(
      req.user.id,
      'GB',
      found.detail.email || `detect:${id}`,
    );
    const result = await accountJob.detectViaToken(req.user.id, id, { proxy });
    if (result?.skipped && result.reason === 'no_token') {
      return res.status(400).json({ message: '账号缺少 access token' });
    }
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || '检测失败' });
  }
});

router.post('/:id/extract', (req, res) => {
  const id = Number(req.params.id);
  const channel = accountChannelOfId(req.user.id, id);
  startJobResponse(res, extractJobFor(channel), req.user, { ...(req.body || {}), ids: [id], channel }, '启动提链失败');
});

router.post('/:id/activate', (req, res) => {
  const id = Number(req.params.id);
  const channel = accountChannelOfId(req.user.id, id);
  startJobResponse(res, payJobFor(channel), req.user, { ...(req.body || {}), ids: [id], channel }, '启动开通失败');
});

// ---------- 单条完整详情(编辑用,含解密令牌) ----------
router.get('/:id', (req, res) => {
  const row = db
    .prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  res.json(toDetail(row));
});

// ---------- 新增 ----------
router.post('/', (req, res) => {
  const err = checkWritable(req.user, 'gpt_accounts', true);
  if (err) return res.status(403).json({ message: err });

  const body = req.body || {};
  if (!body.email) return res.status(400).json({ message: '账号邮箱不能为空' });

  const dup = db
    .prepare('SELECT id FROM gpt_accounts WHERE user_id = ? AND lower(email) = lower(?)')
    .get(req.user.id, String(body.email).trim());
  if (dup) return res.status(400).json({ message: '邮箱已存在' });

  const info = insertRow(req.user.id, toColumns(body));
  res.json({ id: info.lastInsertRowid });
});

// ---------- 编辑 ----------
router.put('/:id', (req, res) => {
  const err = checkWritable(req.user, 'gpt_accounts', false);
  if (err) return res.status(403).json({ message: err });

  const existing = db
    .prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ message: '记录不存在' });

  const body = req.body || {};
  const set = [];
  const params = [];
  const put = (col, val) => {
    set.push(`${col} = ?`);
    params.push(val);
  };

  if (body.email !== undefined) put('email', String(body.email).trim());
  if (body.email_type !== undefined) put('email_type', normalizeEmailType(body.email_type, body));
  if (body.plan_type !== undefined) put('plan_type', normalizePlan(body.plan_type));
  if (body.status !== undefined) put('status', normalizeStatus(body.status));
  if (body.expires_at !== undefined) put('expires_at', body.expires_at || null);
  if (body.remark !== undefined) put('remark', body.remark || '');
  if (body.progress !== undefined) put('progress', normalizeProgress(body.progress));
  if (body.extract_link !== undefined) {
    put('extract_link', encodeExtractLink(body.extract_link));
    put('extracted_at', body.extract_link
      ? (String(body.extracted_at || '').trim() || new Date().toISOString().replace('T', ' ').slice(0, 19))
      : '');
  } else if (body.extracted_at !== undefined) {
    put('extracted_at', String(body.extracted_at || ''));
  }
  if (body.trial_label !== undefined) put('trial_label', String(body.trial_label || '').slice(0, 200));
  if (body.has_trial !== undefined) {
    const trial = normalizeTrialFlag(body.has_trial);
    put('has_trial', trial === 0 || trial === 1 ? trial : null);
  }
  if (body.client_id !== undefined) put('client_id', body.client_id || '');
  if (body.chatgpt_account_id !== undefined) put('chatgpt_account_id', body.chatgpt_account_id || '');
  if (body.vmail_id !== undefined) put('vmail_id', body.vmail_id || '');
  if (body.gmail_client_id !== undefined) put('gmail_client_id', body.gmail_client_id || '');
  for (const field of [
    'mfa_factor_id', 'mfa_factor_type', 'hardening_status', 'hardening_error_code',
    'hardening_error', 'hardening_updated_at', 'mfa_enrolled_at', 'last_detected_at',
    'last_refresh_at', 'last_security_state',
  ]) {
    if (body[field] !== undefined) put(field, String(body[field] || ''));
  }
  for (const field of ['mfa_enabled', 'password_set', 'security_ready', 'token_invalidated']) {
    if (body[field] !== undefined) put(field, body[field] ? 1 : 0);
  }

  // 密码留空则不改
  if (body.password !== undefined && body.password !== '') put('password_enc', encrypt(body.password));
  // 敏感令牌:传入非空才更新(留空保留原值)
  for (const field of Object.keys(ENCRYPTED_FIELDS)) {
    if (body[field] !== undefined && body[field] !== '') put(ENCRYPTED_FIELDS[field], encrypt(body[field]));
  }

  if (!set.length) return res.json({ ok: true });
  put('updated_at', new Date().toISOString().replace('T', ' ').slice(0, 19));
  params.push(existing.id, req.user.id);
  db.prepare(`UPDATE gpt_accounts SET ${set.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
  res.json({ ok: true });
});

// ---------- 单条删除 ----------
router.delete('/:id', (req, res) => {
  const row = db
    .prepare('SELECT * FROM gpt_accounts WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ message: '记录不存在' });
  const kept = deleteBlockReason(row);
  if (kept) return res.status(409).json({ message: kept, kept: true });
  const info = db
    .prepare(`DELETE FROM gpt_accounts WHERE id = ? AND user_id = ? AND NOT (${KEEP_ACCOUNT_SQL})`)
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(409).json({ message: '有试用，已保留', kept: true });
  res.json({ ok: true });
});

function batchDeleteSpec(mode, rawIds = []) {
  const ids = Array.isArray(rawIds)
    ? [...new Set(rawIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
    : [];
  const { PAID_ACCOUNT_SQL, INVALID_TOKEN_SQL } = require('../utils/accountHousekeeping');
  let predicate = '';
  if (mode === 'selected') {
    if (!ids.length) throw Object.assign(new Error('请选择要删除的账号'), { status: 400 });
    predicate = `id IN (${ids.map(() => '?').join(',')})`;
  } else if (mode === 'invalid') {
    predicate = `(${INVALID_TOKEN_SQL}) AND NOT (${PAID_ACCOUNT_SQL})`;
  } else if (mode === 'banned') {
    predicate = `(status IN ('已封禁', '已停用')
      OR last_security_state IN ('banned', 'deactivated', 'account_deactivated', 'deactivation_confirmed'))`;
  } else if (mode === 'all') {
    predicate = '1 = 1';
  } else {
    throw Object.assign(new Error('不支持的删除范围'), { status: 400 });
  }
  return { predicate: `(${predicate}) AND NOT (${KEEP_ACCOUNT_SQL})`, ids };
}

// ---------- 批量删除 ----------
router.post('/batch-delete', (req, res) => {
  const mode = String(req.body?.mode || 'selected');
  let spec;
  try {
    spec = batchDeleteSpec(mode, req.body?.ids);
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
  const { predicate, ids } = spec;
  const channel = requestChannel(req);
  const params = [req.user.id, channel, ...ids];
  if (req.body?.dry_run === true) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM gpt_accounts WHERE user_id = ? AND ${channelSql()} AND ${predicate}`).get(...params).count;
    return res.json({ count, mode });
  }
  const tx = db.transaction(() =>
    db.prepare(`DELETE FROM gpt_accounts WHERE user_id = ? AND ${channelSql()} AND ${predicate}`).run(...params).changes
  );
  res.json({ deleted: tx(), mode });
});

// 导入公共逻辑:去重 + 套餐限额 + 批量写入
function importRows(user, rows, invalid = 0, channel) {
  const clean = rows.filter((r) => r && r.email);
  if (!clean.length) return { success: 0, skipped: invalid, invalid, duplicate: 0, total: rows.length + invalid };

  const ctx = getPlanContext(user);
  const existing = new Set(
    db
      .prepare('SELECT lower(email) AS e FROM gpt_accounts WHERE user_id = ?')
      .all(user.id)
      .map((x) => x.e)
  );
  let current = existing.size;

  let success = 0;
  let duplicate = 0;
  let limitedCount = 0;
  const tx = db.transaction(() => {
    for (const row of clean) {
      const key = String(row.email).toLowerCase();
      if (existing.has(key)) {
        duplicate += 1;
        continue;
      }
      if (!ctx.unlimited && current >= ctx.maxAccounts) {
        limitedCount += 1;
        continue;
      }
      insertRow(user.id, toColumns({ ...row, channel: channel || row.channel }));
      existing.add(key);
      current += 1;
      success += 1;
    }
  });
  tx();
  const limited = !ctx.unlimited && current >= ctx.maxAccounts && success < clean.length;
  return {
    success,
    skipped: duplicate + limitedCount + invalid,
    invalid,
    duplicate,
    limited_count: limitedCount,
    total: rows.length + invalid,
    limited,
    max: ctx.unlimited ? -1 : ctx.maxAccounts,
  };
}

// ---------- 批量导出(JSON / CSV / TXT / Excel) ----------
router.post('/export', (req, res) => {
  const format = String(req.body?.format || 'json').toLowerCase();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  let rows;
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    rows = db
      .prepare(`SELECT * FROM gpt_accounts WHERE user_id = ? AND id IN (${placeholders}) ORDER BY id`)
      .all(req.user.id, ...ids);
  } else {
    rows = db.prepare(`SELECT * FROM gpt_accounts WHERE user_id = ? AND ${channelSql()} ORDER BY id`).all(req.user.id, requestChannel(req));
  }
  if (!rows.length) return res.status(400).json({ message: '没有可导出的账号' });
  res.json(buildExport(rows, format, { fields: req.body?.fields }));
});

// ---------- 批量导入(文本) ----------
router.post('/batch-import', (req, res) => {
  try {
    const parsed = parseAccountsDetailed(req.body?.text || '');
    res.json(importRows(req.user, parsed.rows, parsed.invalid, requestChannel(req)));
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// ---------- 文件导入(JSON / CSV / Excel;前端以 base64 传入) ----------
router.post('/import-file', (req, res) => {
  const files = Array.isArray(req.body?.files) && req.body.files.length
    ? req.body.files
    : [{ filename: req.body?.filename, content_base64: req.body?.content_base64 }];
  if (files.some((file) => !file?.content_base64)) return res.status(400).json({ message: '缺少文件内容' });
  try {
    const combined = { rows: [], invalid: 0 };
    for (const file of files) {
      const name = String(file.filename || '').toLowerCase();
      const buffer = Buffer.from(file.content_base64, 'base64');
      let parsed;
      if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        const wb = XLSX.read(buffer, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        parsed = parseAccountsDetailed(JSON.stringify(XLSX.utils.sheet_to_json(sheet, { defval: '' })));
      } else if (name.endsWith('.json') || name.endsWith('.jsonl') || name.endsWith('.csv') || name.endsWith('.txt')) {
        parsed = parseAccountsDetailed(buffer.toString('utf8').replace(/^\uFEFF/, ''));
      } else {
        return res.status(400).json({ message: '仅支持 JSON / JSONL / CSV / Excel / TXT 文件' });
      }
      combined.rows.push(...parsed.rows);
      combined.invalid += parsed.invalid;
    }
    res.json(importRows(req.user, combined.rows, combined.invalid, requestChannel(req)));
  } catch (e) {
    res.status(400).json({ message: e.message || '导入失败' });
  }
});

module.exports = router;
module.exports.importRows = importRows;
module.exports.batchDeleteSpec = batchDeleteSpec;
module.exports.parseHasTrialFilter = parseHasTrialFilter;
module.exports.buildListWhere = buildListWhere;
