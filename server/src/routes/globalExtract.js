'use strict';

const express = require('express');
const { buildOverview, savePlan } = require('../utils/globalExtractMonitor');

const router = express.Router();

function overviewHandler(req, res) {
  res.json(buildOverview(req.user.id));
}

function savePlanHandler(req, res) {
  const plan = savePlan(req.user.id, req.body || {});
  try {
    require('../utils/globalExtractEngine').kick(req.user.id);
  } catch {
    /* poller optional */
  }
  res.json({
    message: plan.enabled
      ? '计划已开启。将按间隔串行探测全部启用通道，不会写入 extract_link。'
      : '计划已关闭。',
    plan,
    ...buildOverview(req.user.id),
  });
}

router.get('/', overviewHandler);
router.put('/plan', savePlanHandler);

module.exports = router;
module.exports._test = {
  overviewHandler,
  savePlanHandler,
};
