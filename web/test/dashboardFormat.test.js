import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatYuan,
  percent,
} from '../src/utils/dashboardFormat.js';

test('dashboard percentages avoid divide-by-zero and stay bounded', () => {
  assert.equal(percent(5, 0), 0);
  assert.equal(percent(1, 4), 25);
  assert.equal(percent(5, 4), 100);
  assert.equal(formatPercent(1, 3), '33.3%');
});

test('dashboard byte, duration and money formatters are compact', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatDuration(65), '1分');
  assert.equal(formatDuration(90061), '1天 1小时');
  assert.equal(formatYuan('21.5'), '¥21.50');
});
