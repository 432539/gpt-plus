'use strict';

const db = require('../db');
const opLog = require('./opLog');
const { createLiveJob } = require('./accountLiveJob');
const { accountChannelOf } = require('./accountProgress');
const { checkGcashTrialForUser, gcashDetectLog } = require('./checkGcashTrial');
const { trialKnown } = require('./accountCheck');
const { requireChannelDynamicProxy } = require('./channelProxy');
const { gcashConcurrencyCap, gcashJobConcurrency } = require('./gcashConcurrency');

const job = createLiveJob({
  kind: 'detect',
  source: 'gcash-detect',
  log: opLog.account,
  requireIds: false,
  allowEnqueue: true,
  configure({ user, body }) {
    requireChannelDynamicProxy(user.id, 'PH', `gcash-detect-preflight:${user.id}`);
    return {
      body: { ...body, proxy_group: '__auto__:PH' },
      maxConcurrency: gcashConcurrencyCap(),
      defaultConcurrency: gcashJobConcurrency(body),
      requireProxy: false,
      skipCloak: true,
      proxies: [],
    };
  },
  async runOne({ user, id, row, detail, state }) {
    if (accountChannelOf(row) !== 'gc') {
      throw Object.assign(new Error('该账号不是 GC 通道，已跳过'), { code: 'ACCOUNT_CHANNEL_MISMATCH', skip: true });
    }
    if (!detail?.access_token) {
      throw Object.assign(new Error('账号缺少 access token'), { code: 'ACCOUNT_ACCESS_TOKEN_MISSING', skip: true });
    }
    const result = await checkGcashTrialForUser(user.id, detail, {
      identity: detail.email,
      cancelled: () => state.stop,
      log: gcashDetectLog(user.id, detail.email || id),
    });
    if (!trialKnown(row.has_trial) || result.has_trial === 0 || result.has_trial === 1) {
      db.prepare(
        `UPDATE gpt_accounts SET has_trial = ?, trial_label = ?, last_detected_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
         WHERE id = ? AND user_id = ?`
      ).run(result.has_trial === 1 ? 1 : 0, result.has_trial === 1 ? 'gcash-cpmt' : '', id, user.id);
    }
    opLog.account(
      user.id,
      'success',
      `${detail.email || id}：GCash 资格 ${result.has_trial === 1 ? '是' : '否'}`,
      { source: 'gcash-detect' },
    );
    if (result.has_trial === 1) {
      try { require('./accountRebindJob').kickRegistered(user.id, id, 'gc'); } catch { /* optional */ }
    }
    return result;
  },
});

module.exports = {
  start: job.start,
  stop: job.stop,
  status: job.status,
  isLive: job.isLive,
};
