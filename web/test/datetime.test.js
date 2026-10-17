import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClock,
  formatExpiresAt,
  formatShanghaiDate,
  formatShanghaiDateTime,
  fromExpiresInput,
  toExpiresInput,
} from '../src/utils/datetime.js';

test('formatExpiresAt keeps date-only values without faking midnight', () => {
  assert.equal(formatExpiresAt('2026-08-29'), '2026-08-29');
  assert.equal(formatExpiresAt(''), '—');
  assert.equal(formatExpiresAt(null), '—');
});

test('UTC 2026-08-23T05:33:00.000Z displays as Asia/Shanghai 2026-08-23 13:33', () => {
  assert.equal(formatExpiresAt('2026-08-23T05:33:00.000Z'), '2026-08-23 13:33');
  assert.equal(formatShanghaiDateTime('2026-08-23T05:33:00.000Z'), '2026-08-23 13:33');
  assert.equal(formatShanghaiDateTime('2026-08-23 05:33:00'), '2026-08-23 13:33');
  assert.equal(formatShanghaiDateTime('2026-08-23T05:33:00.000Z', { seconds: true }), '2026-08-23 13:33:00');
});

test('formatExpiresAt converts stored UTC datetimes to Asia/Shanghai', () => {
  assert.equal(formatExpiresAt('2026-08-29 14:30:00'), '2026-08-29 22:30');
  assert.equal(formatExpiresAt('2026-08-29T14:30:08.000Z'), '2026-08-29 22:30');
  assert.equal(formatExpiresAt('2026-08-29T00:00:00'), '2026-08-29 08:00');
  assert.equal(formatShanghaiDate('2026-08-23T16:30:00.000Z'), '2026-08-24');
});

test('formatClock uses Asia/Shanghai and does not follow the host timezone', () => {
  assert.equal(formatClock(new Date('2026-08-23T05:33:00.000Z')), '13:33:00');
});

test('edit form shows Shanghai and saves UTC without inventing 00:00 on date-only', () => {
  assert.equal(toExpiresInput('2026-08-29'), '2026-08-29T00:00');
  assert.equal(fromExpiresInput('2026-08-29T00:00', '2026-08-29'), '2026-08-29');
  assert.equal(toExpiresInput('2026-08-23 05:33:00'), '2026-08-23T13:33');
  assert.equal(fromExpiresInput('2026-08-23T13:33', '2026-08-23 05:33:00'), '2026-08-23 05:33:00');
});
