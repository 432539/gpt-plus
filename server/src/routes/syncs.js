'use strict';

const express = require('express');
const { listAccountSyncs } = require('../utils/accountSyncs');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(listAccountSyncs(req.user.id, {
    kind: req.query.kind,
    page: req.query.page,
    page_size: req.query.page_size,
  }));
});

module.exports = router;
