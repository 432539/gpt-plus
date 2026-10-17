'use strict';

const { requireChannelDynamicProxy, loadChannelProxies } = require('./channelProxy');

function phDynamicProxy(userId, identity = '') {
  return requireChannelDynamicProxy(userId, 'PH', identity || `gc-${userId}-${Date.now()}`);
}

function loadPhProxies(userId, count = 3) {
  return loadChannelProxies(userId, 'PH', count, `gc-pool-${Date.now()}`);
}

module.exports = { phDynamicProxy, loadPhProxies };
