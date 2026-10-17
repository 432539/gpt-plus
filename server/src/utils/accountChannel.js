'use strict';

const CHANNEL_GB = 'gb';
const CHANNEL_GC = 'gc';

function normalizeChannel(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === CHANNEL_GC ? CHANNEL_GC : CHANNEL_GB;
}

function isGcChannel(value) {
  return normalizeChannel(value) === CHANNEL_GC;
}

function isGbChannel(value) {
  return !isGcChannel(value);
}

function channelSql(alias = '') {
  const col = alias ? `${alias}.channel` : 'channel';
  return `COALESCE(${col}, '${CHANNEL_GB}') = ?`;
}

function channelFilter(channel, alias = '') {
  return {
    sql: channelSql(alias),
    value: normalizeChannel(channel),
  };
}

function jobSlotKey(userId, channel) {
  const id = Number(userId) || userId;
  return isGcChannel(channel) ? `${id}:${CHANNEL_GC}` : id;
}

function parseChannel(input = {}) {
  if (input == null) return CHANNEL_GB;
  if (typeof input === 'string') return normalizeChannel(input);
  return normalizeChannel(input.channel || input.query?.channel || '');
}

function neverMonitorPool(channel) {
  return isGcChannel(channel) ? 0 : undefined;
}

function occupiedAccountEmailsSql() {
  return `SELECT lower(email) FROM gpt_accounts WHERE user_id = ?
    UNION
    SELECT lower(original_email) FROM gpt_accounts
    WHERE user_id = ? AND COALESCE(original_email, '') != ''`;
}

module.exports = {
  CHANNEL_GB,
  CHANNEL_GC,
  normalizeChannel,
  isGcChannel,
  isGbChannel,
  channelSql,
  channelFilter,
  jobSlotKey,
  parseChannel,
  neverMonitorPool,
  occupiedAccountEmailsSql,
};
