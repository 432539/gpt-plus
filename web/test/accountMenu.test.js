import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('menu names are 账号管理(GB/GC) and 账号同步, routes stay put', () => {
  const layout = readFileSync(new URL('../src/layouts/MainLayout.vue', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../src/router/index.js', import.meta.url), 'utf8');
  assert.match(layout, /to: '\/accounts', label: '账号管理\(GB\)'/);
  assert.match(layout, /to: '\/accounts-gc', label: '账号管理\(GC\)'/);
  assert.match(layout, /to: '\/syncs', label: '账号同步'/);
  assert.doesNotMatch(layout, /账号同步\(GB\)/);
  assert.doesNotMatch(layout, /账号同步\(GC\)/);
  assert.match(router, /path: 'accounts'[\s\S]*title: '账号管理\(GB\)'/);
  assert.match(router, /path: 'accounts-gc'[\s\S]*title: '账号管理\(GC\)'/);
  assert.match(router, /path: 'syncs'[\s\S]*title: '账号同步'/);
  assert.match(layout, /https:\/\/github.com\/432539\/gpt-plus/);
  assert.match(layout, /QQ 群 1109037692/);
  const login = readFileSync(new URL('../src/views/Login.vue', import.meta.url), 'utf8');
  assert.match(login, /https:\/\/github.com\/432539\/gpt-plus/);
  assert.match(login, /QQ 群 1109037692/);
});

test('GC detect posts detect APIs and never extract', () => {
  const page = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  const detectFn = page.match(/async function startRowDetect[\s\S]*?\nasync function startRowExtract/);
  assert.ok(detectFn);
  assert.match(detectFn[0], /\/accounts\/\$\{row\.id\}\/detect/);
  assert.doesNotMatch(detectFn[0], /\/extract/);
  assert.match(page, /const path = `\/accounts\/operations\/\$\{operationKind\.value\}`/);
  assert.match(page, /detect: '批量检测 GCash 资格'/);
  assert.match(page, /rebind: '批量换绑'/);
  assert.match(page, /批量换绑\{\{ selected\.size \? `\(\$\{selected\.size\}\)` : '' \}\}/);
  assert.match(page, /账号管理\(GC\)/);
  assert.match(page, /账号管理\(GB\)/);
});
