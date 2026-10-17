const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISPLAY_TIME_ZONE,
  formatShanghaiDateTime,
  nowShanghaiStamp,
  utcStamp,
} = require('../src/utils/datetime');

test('UTC 2026-08-23T05:33:00.000Z displays as Asia/Shanghai 2026-08-23 13:33', () => {
  assert.equal(DISPLAY_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(formatShanghaiDateTime('2026-08-23T05:33:00.000Z'), '2026-08-23 13:33');
  assert.equal(formatShanghaiDateTime('2026-08-23 05:33:00'), '2026-08-23 13:33');
  assert.equal(formatShanghaiDateTime(new Date('2026-08-23T05:33:00.000Z')), '2026-08-23 13:33');
});

test('utcStamp stays UTC; nowShanghaiStamp is UTC+8 wall clock', () => {
  const ms = Date.UTC(2026, 7, 23, 5, 33, 0);
  assert.equal(utcStamp(ms), '2026-08-23 05:33:00');
  assert.equal(nowShanghaiStamp(ms), '2026-08-23 13:33:00');
});
