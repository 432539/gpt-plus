const express = require('express');
const registerJob = require('../utils/registerJob');
const { parseImportedMailboxList } = require('../automation/channels/providers');
const { readSettings, writeSettings, publicView } = require('../utils/settings');

const router = express.Router();

router.get('/options', (req, res) => {
  res.json(registerJob.options(req.user));
});

router.get('/status', (req, res) => {
  res.json(registerJob.status(req.user.id, req.query.channel));
});

router.get('/run', (req, res) => {
  const activity = registerJob.runtimeActivity(req.user.id, req.query.channel);
  res.json({ running: activity.running, cloak_capacity: activity.cloak });
});

router.get('/runtime/activity', (req, res) => {
  res.json(registerJob.runtimeActivity(req.user.id, req.query.channel));
});

router.get('/active-batches', (req, res) => {
  res.json({ batches: registerJob.activeBatches(req.user.id) });
});

router.get('/batches/:id', (req, res) => {
  const batch = registerJob.getBatch(req.user.id, req.params.id);
  if (!batch) return res.status(404).json({ message: '注册批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});

router.get('/jobs/:id', (req, res) => {
  const job = registerJob.getJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ message: '注册任务不存在', code: 'REGISTRATION_JOB_NOT_FOUND' });
  return res.json(job);
});

router.post('/batches/:id/cancel', (req, res) => {
  const batch = registerJob.cancelBatch(req.user.id, req.params.id);
  if (!batch) return res.status(404).json({ message: '注册批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});

router.post('/start', async (req, res) => {
  try {
    const data = await registerJob.start(req.user, req.body || {});
    res.json(data);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || '启动注册失败', code: e.code || 'REGISTER_START_FAILED' });
  }
});

const startCompatible = async (req, res) => {
  try {
    const data = await registerJob.start(req.user, req.body || {});
    res.json({ ...data, total: data.target, effective_concurrency: data.concurrency });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message || '启动注册失败', code: e.code || 'REGISTER_START_FAILED' });
  }
};

router.get('/sms-mail-options', async (req, res) => {
  const { getSmsMailOptions } = require('../automation/channels/providers');
  res.json(await getSmsMailOptions(readSettings(req.user.id), req.query || {}));
});

router.get('/sms-phone-countries', async (req, res) => {
  const { getSmsPhoneCountries } = require('../automation/channels/providers');
  res.json(await getSmsPhoneCountries(readSettings(req.user.id), { provider: req.query.provider }));
});

router.post('/register-sms', startCompatible);
router.get('/register-sms/:id', (req, res) => {
  const batch = registerJob.getBatch(req.user.id, req.params.id);
  if (!batch) return res.status(404).json({ message: 'SMS 注册批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});
router.post('/register-sms/:id/cancel', (req, res) => {
  const batch = registerJob.cancelBatch(req.user.id, req.params.id);
  if (!batch) return res.status(404).json({ message: 'SMS 注册批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});
router.get('/register-sms/job/:id', (req, res) => {
  const job = registerJob.getJob(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ message: 'SMS 注册任务不存在', code: 'REGISTRATION_JOB_NOT_FOUND' });
  return res.json(job);
});

router.post('/email-list/preview', (req, res) => {
  const parsed = parseImportedMailboxList(req.body?.text || req.body?.imported_mailboxes || '', {
    allowUnsafeUrl: readSettings(req.user.id).imported_mail?.allow_unsafe_url === true,
  });
  res.json({
    count: parsed.entries.length,
    invalid: parsed.errors.length,
    items: parsed.entries.map(item => ({ email: item.email, kind: item.kind })),
    errors: parsed.errors,
  });
});

router.post('/register-email-list', (req, res) => {
  const text = req.body?.text || req.body?.imported_mailboxes || (
    req.body?.use_mailbox_pool ? readSettings(req.user.id).imported_mail?.mailboxes : ''
  );
  const parsed = parseImportedMailboxList(text, {
    allowUnsafeUrl: readSettings(req.user.id).imported_mail?.allow_unsafe_url === true,
  });
  if (!parsed.entries.length) return res.status(400).json({ message: '没有解析到可用邮箱', code: 'IMPORTED_MAIL_REQUIRED' });
  req.body = {
    ...(req.body || {}),
    mail_provider: 'imported',
    imported_mailboxes: text,
    quantity: req.body?.quantity ?? req.body?.count ?? parsed.entries.length,
  };
  return startCompatible(req, res);
});
router.get('/register-email-list/:id', (req, res) => {
  const batch = registerJob.getBatch(req.user.id, req.params.id);
  if (!batch) return res.status(404).json({ message: '邮箱列表注册批次不存在', code: 'REGISTRATION_BATCH_NOT_FOUND' });
  return res.json(batch);
});

router.get('/mailboxes', (req, res) => {
  const settings = readSettings(req.user.id);
  const parsed = parseImportedMailboxList(settings.imported_mail?.mailboxes || '', {
    allowUnsafeUrl: settings.imported_mail?.allow_unsafe_url === true,
  });
  res.json({
    total: parsed.entries.length,
    items: parsed.entries.map((item, index) => ({ id: index + 1, email: item.email, kind: item.kind })),
  });
});
router.post('/mailboxes/import', (req, res) => {
  const text = String(req.body?.text || req.body?.mailboxes || '');
  const current = readSettings(req.user.id);
  const parsed = parseImportedMailboxList(text, {
    allowUnsafeUrl: current.imported_mail?.allow_unsafe_url === true,
  });
  if (parsed.errors.length) {
    return res.status(400).json({ message: `第 ${parsed.errors[0].line} 行：${parsed.errors[0].reason}`, code: 'IMPORTED_MAIL_INVALID' });
  }
  const next = writeSettings(req.user.id, { imported_mail: { mailboxes: text } });
  return res.json({ ok: true, imported: parsed.entries.length, settings: publicView(next) });
});

router.post('/stop', (req, res) => {
  res.json(registerJob.stop(req.user.id, req.body?.channel || req.query.channel));
});

module.exports = router;
