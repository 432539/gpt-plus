'use strict';

const express = require('express');
const { mkGcashEnabled } = require('./enabled');
const {
  QueueFullError,
  createJob,
  publicJob,
  cancelJob,
  refreshAccount,
  abandonAccount,
  abandonJob,
  accountQr,
  health,
  JOB_RE,
  CLIENT_RE,
} = require('./appApi');

const router = express.Router();

router.use((req, res, next) => {
  if (!mkGcashEnabled()) return res.status(404).json({ message: '接口不存在' });
  return next();
});

function sendError(res, error) {
  if (error instanceof QueueFullError) return res.status(429).json({ error: error.message });
  const status = Number(error.httpStatus || error.status || 500);
  if (status === 404) return res.status(404).json({ error: error.message || '任务不存在' });
  if (status === 409) return res.status(409).json({ error: error.message });
  if (status === 400 || error instanceof SyntaxError) return res.status(400).json({ error: error.message });
  return res.status(500).json({ error: '请求失败' });
}

router.get('/health', (req, res) => {
  res.json(health());
});

router.post('/jobs', (req, res) => {
  try {
    return res.status(202).json(createJob(req.body || {}));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/jobs/:jobId', (req, res) => {
  try {
    if (!JOB_RE.test(req.params.jobId)) return res.status(404).json({ error: '任务不存在' });
    return res.json(publicJob(req.params.jobId));
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/jobs/:jobId/accounts/:accountId/qr.png', (req, res) => {
  try {
    if (!JOB_RE.test(req.params.jobId) || !CLIENT_RE.test(req.params.accountId)) {
      return res.status(404).json({ error: '任务不存在' });
    }
    const png = accountQr(req.params.jobId, req.params.accountId);
    if (!png || !png.length) return res.status(404).json({ error: '二维码尚未就绪' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(png);
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/jobs/:jobId/cancel', async (req, res) => {
  try {
    return res.json(await cancelJob(req.params.jobId));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/jobs/:jobId/abandon', async (req, res) => {
  try {
    return res.json(await abandonJob(req.params.jobId));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/jobs/:jobId/accounts/:accountId/refresh', async (req, res) => {
  try {
    return res.json(await refreshAccount(req.params.jobId, req.params.accountId));
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/jobs/:jobId/accounts/:accountId/abandon', async (req, res) => {
  try {
    return res.json(await abandonAccount(req.params.jobId, req.params.accountId));
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
