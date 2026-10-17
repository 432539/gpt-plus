import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGcashQrImage, isPlaceholderQrImage, gcashPaywallHint, gcashPaywallFallback,
  gcashPaywallStatus, formatGcashCountdown, gcashWallStatusLabel, filterAndSortGcashWall,
  gcashWallItemBusy, GCASH_CONCURRENCY_CAP,
} from '../src/utils/gcashPaywall.js';

const PNG = 'data:image/png;base64,aaa';
const REDIRECT = 'https://checkoutshopper-live.adyen.com/checkoutshopper/checkoutPaymentRedirect?redirectData=fixture';
const LOADER = 'https://m.gcash.com/gcashapp/gcash-merchants-auth/src/assets/gcat_loader.png';

test('payment wall prefers a QR image and never treats the Adyen redirect as the code', () => {
  assert.equal(isGcashQrImage(PNG), true);
  assert.equal(isGcashQrImage('https://checkoutshopper-live.adyen.com/checkoutshopper/images/qr.png'), true);
  assert.equal(isGcashQrImage(REDIRECT), false);
  assert.match(gcashPaywallHint({ qr: PNG, link: REDIRECT }), /用 GCash 扫描二维码/);
  assert.match(gcashPaywallHint({ qr: '', link: REDIRECT }), /已有跳转链但未抽到二维码/);
  assert.match(gcashPaywallFallback({ qr: '', link: REDIRECT }), /请重新出码/);
  assert.equal(gcashPaywallFallback({ qr: PNG, link: REDIRECT }), '');
});

test('payment wall rejects the GCash loader URL and does not render it as a QR', () => {
  assert.equal(isPlaceholderQrImage(LOADER), true);
  assert.equal(isGcashQrImage(LOADER), false);
  assert.equal(isGcashQrImage('https://m.gcash.com/assets/spinner.gif'), false);
  assert.equal(isGcashQrImage('https://m.gcash.com/assets/placeholder.png'), false);
  assert.match(gcashPaywallHint({ qr: LOADER, link: REDIRECT }), /已有跳转链但未抽到二维码/);
  assert.match(gcashPaywallFallback({ qr: LOADER, link: REDIRECT }), /请重新出码/);
});

test('payment wall shows a 5-minute countdown and does not finish before continue', () => {
  assert.equal(formatGcashCountdown(5 * 60 * 1000), '5:00');
  assert.equal(formatGcashCountdown(61 * 1000), '1:01');
  assert.equal(formatGcashCountdown(0), '0:00');
  assert.match(gcashPaywallHint({ qr: PNG, link: REDIRECT }), /5 分钟/);
  assert.match(gcashPaywallStatus({ qr: PNG, qr_remaining_ms: 4 * 60 * 1000 }), /4:00/);
  assert.equal(gcashPaywallStatus({ continue_submitted: true }), '已回调，正在确认 Plus');
  assert.equal(gcashPaywallStatus({ continue_error: 'HTTP 500' }), '扫码后回调失败，未计次');
  assert.equal(gcashPaywallStatus({ paid: true }), '已开通 Plus');
  assert.match(gcashPaywallStatus({ expired: true }), /过期/);
});

test('wall defaults to scannable cards sorted by remaining time', () => {
  const items = [
    { id: 1, scannable: true, status: 'waiting_scan', qr_remaining_ms: 200000 },
    { id: 2, scannable: false, status: 'refresh_failed', qr_remaining_ms: 0 },
    { id: 3, scannable: true, status: 'waiting_scan', qr_remaining_ms: 100000 },
  ];
  assert.deepEqual(filterAndSortGcashWall(items).map((item) => item.id), [3, 1]);
  assert.deepEqual(
    filterAndSortGcashWall(items, { onlyScannable: false, hideFinished: false }).map((item) => item.id),
    [2, 3, 1],
  );
});

test('wall keeps scanned cards visible even when only-scannable is on', () => {
  const items = [
    { id: 1, scannable: true, status: 'waiting_scan', qr_remaining_ms: 200000 },
    { id: 2, scannable: false, status: 'processing', processing: true, qr_remaining_ms: 0 },
    { id: 3, scannable: false, status: 'continue_success', continue_submitted: true, qr_remaining_ms: 0 },
    { id: 4, scannable: false, status: 'refresh_failed', qr_remaining_ms: 0 },
    { id: 5, scannable: false, status: 'refresh_failed', refresh_code: 'SCAN_IN_FLIGHT', qr_remaining_ms: 0 },
  ];
  assert.equal(gcashWallItemBusy(items[1]), true);
  assert.equal(gcashWallItemBusy(items[4]), true);
  assert.deepEqual(filterAndSortGcashWall(items).map((item) => item.id), [2, 3, 5, 1]);
  assert.equal(gcashWallStatusLabel({ processing: true }), '已扫码处理中');
});

test('GC extract/pay/H5 concurrency cap is 20', () => {
  assert.equal(GCASH_CONCURRENCY_CAP, 20);
});

test('wall status and button guards distinguish scan and session failure', () => {
  assert.equal(gcashWallStatusLabel({ processing: true }), '已扫码处理中');
  assert.equal(gcashWallStatusLabel({ continue_submitted: true }), 'continue 成功');
  assert.equal(gcashWallStatusLabel({ refreshable: false }), '刷新失败');
  assert.match(gcashPaywallStatus({ refreshable: false, refresh_message: '会话已失效，需要新号重新出码' }), /新号重新出码/);
  assert.equal(gcashPaywallStatus({ refreshing: true }), '正在刷新二维码…');
});
