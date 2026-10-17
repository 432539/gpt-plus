import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('已同步 menu and page cover 普通 / PLUS stats', () => {
  const layout = readFileSync(new URL('../src/layouts/MainLayout.vue', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/views/Syncs.vue', import.meta.url), 'utf8');
  assert.match(layout, /to: '\/syncs', label: '账号同步'/);
  assert.doesNotMatch(layout, /to: '\/syncs', label: '已同步'/);
  assert.match(router, /path: 'syncs'/);
  assert.match(router, /title: '账号同步'/);
  assert.match(page, /已同步普通/);
  assert.match(page, /已同步 PLUS/);
  assert.match(page, /PLUS 成交额合计/);
  assert.match(page, /api\.get\('\/syncs'/);
  assert.match(page, /kind: kind\.value/);
  assert.doesNotMatch(page, /access_token/);
  assert.doesNotMatch(page, /refresh_token/);
});
