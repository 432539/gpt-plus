'use strict';

const express = require('express');
const { domainStatsForUser } = require('../utils/domainStats');

const router = express.Router();

router.get('/', (req, res) => {
  const items = domainStatsForUser(req.user.id);
  res.json({
    items,
    count: items.length,
  });
});

module.exports = router;
