import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Accounts pipeline has rebind after register for GB and GC', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  assert.match(source, /key: 'rebind', label: '换绑'/);
  assert.match(source, /pipeline_gc\.rebind/);
  assert.match(source, /__auto__:GB/);
  assert.match(source, /__auto__:PH/);
  assert.match(source, /rebindLabel\(row\)/);
  assert.match(source, /已换绑/);
});

test('Accounts delete keeps trial and extract-fail-20 accounts', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  assert.match(source, /有试用，已保留/);
  assert.match(source, /提链失败已满 20 次，已保留/);
  assert.match(source, /不同步/);
  assert.match(source, /accountCanDelete\(row\)/);
  assert.match(source, /有试用或提链失败满 20 次的账号会保留/);
  assert.match(source, /:disabled="!accountCanDelete\(row\)"/);
});

test('Accounts batch menu has selected-only rebind and first/last page buttons', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  assert.match(source, /openAccountOperation\('rebind'\)/);
  assert.match(source, /批量换绑\{\{ selected\.size \? `\(\$\{selected\.size\}\)` : '' \}\}/);
  assert.match(source, /:disabled="!selected.size" @click="openAccountOperation\('rebind'\)"/);
  assert.match(source, /REBIND_CONCURRENCY_DEFAULT = 10/);
  assert.match(source, /REBIND_CONCURRENCY_MAX = 20/);
  assert.match(source, /\/accounts\/operations\/\$\{operationKind\.value\}/);
  assert.match(source, /operationKind\.value === 'rebind'/);
  assert.match(source, /请先勾选要换绑的账号/);
  assert.match(source, /未检测、无试用也会执行/);
  assert.match(source, /只跳过缺少密码或 TOTP/);
  assert.match(source, /勾选号会强制执行/);
  assert.doesNotMatch(source, /缺少密码\/TOTP\/AT/);
  assert.doesNotMatch(source, /无试用会跳过/);
  assert.match(source, /source: 'batch'/);
  assert.match(source, /loadAccounts/);
  assert.match(source, /账号检测 \/ 换绑/);
  assert.match(source, /@click="goPage\(1\)">首页/);
  assert.match(source, /@click="goPage\(totalPages\)">尾页/);
  assert.match(source, /@click="goPage\(page - 1\)">上一页/);
  assert.match(source, /@click="goPage\(page \+ 1\)">下一页/);
});

test('GCash paywall prefers QR image and explains link-only extract', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  assert.match(source, /isGcashQrImage\(paywall\.qr\)/);
  assert.match(source, /gcashPaywallHint\(paywall\)/);
  assert.match(source, /已有跳转链但未抽到二维码/);
});

test('GC 支付中 opens paywall and keeps 支付墙 clickable', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  assert.match(source, /rowRemark\(row\) === '支付中'/);
  assert.match(source, /isGc \? openGcashPaywall\(row\) : goActivateLogs\(row\)/);
  assert.match(source, /打开 GCash 支付墙查看二维码/);
  assert.match(source, /kind === 'activate'\) return isGc\.value \? false : liveMatch\(liveJobs\.activate, row\)/);
  assert.match(source, /progress === '支付中'/);
  assert.match(source, /row\.has_gcash_link \|\| row\.gcash_qr \|\| row\.gcash_link/);
});

test('GCash wall uses one batch poll and disables unsafe refreshes', () => {
  const source = readFileSync(new URL('../src/views/Accounts.vue', import.meta.url), 'utf8');
  assert.match(source, />二维码墙</);
  assert.match(source, /\/accounts\/gcash\/paywall-wall/);
  assert.match(source, /setInterval\(pollGcashWall, 4000\)/);
  assert.match(source, /只看可扫/);
  assert.match(source, /隐藏已完成\/失败/);
  assert.match(source, /刷新全部到期二维码/);
  assert.match(source, /!item\.refreshable \|\| item\.processing/);
  assert.match(source, /target\.scannable = false/);
  assert.match(source, /paywall\.scannable && isGcashQrImage\(paywall\.qr\)/);
});
