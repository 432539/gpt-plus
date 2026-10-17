const express = require('express');
const opLog = require('../utils/opLog');

const router = express.Router();

router.get('/', (req, res) => {
  const category = String(req.query.category || 'pull');
  const cap = Math.min(5000, Math.max(1, Number(process.env.OP_LOG_LATEST_LIMIT) || 100));
  const limit = Math.min(cap, Math.max(1, parseInt(req.query.limit, 10) || cap));
  const runId = String(req.query.run_id || '').trim().slice(0, 80);
  if (!opLog.CATEGORIES.includes(category)) {
    return res.status(400).json({ message: '未知日志分类' });
  }
  const { total, items } = opLog.latest(req.user.id, {
    category,
    limit,
    runId,
  });
  res.json({
    items,
    total,
    category,
    limit,
    window: 'latest',
    order: 'oldest_to_newest',
    run_id: runId,
  });
});

router.post('/clear', (req, res) => {
  const category = String(req.body?.category || '').trim();
  if (category && !opLog.CATEGORIES.includes(category)) {
    return res.status(400).json({ message: '未知日志分类' });
  }
  const deleted = opLog.clear(req.user.id, category);
  res.json({ ok: true, deleted });
});

module.exports = router;
