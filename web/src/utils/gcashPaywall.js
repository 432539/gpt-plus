const PLACEHOLDER_QR_RE = /gcat_loader|(?:^|[/?#._-])(?:loader|spinner|placeholder)(?:[/?#._-]|\.|$)/i;
const DECORATIVE_ASSET_RE = /favicon|(?:^|[/?#._-])(?:logo|pixel|tracking|sprite|icon)(?:[/?#._-]|\.|$)/i;

export function isPlaceholderQrImage(qr) {
  const text = String(qr || '').trim();
  if (!text) return false;
  const blob = text.toLowerCase();
  if (PLACEHOLDER_QR_RE.test(blob)) return true;
  return DECORATIVE_ASSET_RE.test(blob) && !/(?:^|[/?#._-])qr(?:code)?(?:[/?#._-]|$)/.test(blob);
}

export function isGcashQrImage(qr) {
  const text = String(qr || '').trim();
  if (!text || isPlaceholderQrImage(text)) return false;
  if (/^data:image\//i.test(text)) return true;
  if (!/^https?:\/\//i.test(text)) return false;
  if (/checkoutPaymentRedirect/i.test(text) || /custom_payment_method\/start/i.test(text)) return false;
  return /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(text) || /(?:^|[/?._-])qr(?:code)?(?:[/?._-]|$)/i.test(text);
}

export const GCASH_QR_TTL_MS = 5 * 60 * 1000;
export const GCASH_URL_TTL_MS = 24 * 60 * 60 * 1000;
export const GCASH_CONCURRENCY_CAP = 20;

export function formatGcashCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function gcashPaywallHint({ expired, qr, link } = {}) {
  if (expired) return '支付链接已过期（24 小时），请重新出码。';
  if (isGcashQrImage(qr)) return '用 GCash 扫描二维码。单个码 5 分钟，到期自动刷新。';
  if (link) return '已有跳转链但未抽到二维码，支付墙需要二维码图片。请重新出码。';
  return '没有二维码，也没有可打开的链接。请先出码。';
}

export function gcashPaywallStatus({
  paid, expired, continue_submitted, continue_error, processing, refreshing,
  refreshable, refresh_message, qr, link, qr_remaining_ms,
} = {}) {
  if (paid) return '已开通 Plus';
  if (expired) return '支付链接已过期，请重新出码';
  if (continue_error) return '扫码后回调失败，未计次';
  if (continue_submitted) return '已回调，正在确认 Plus';
  if (processing) return '已扫码，正在处理';
  if (refreshing) return '正在刷新二维码…';
  if (refreshable === false) return refresh_message || '会话已失效，需要新号重新出码';
  if (qr || link) {
    const clock = formatGcashCountdown(qr_remaining_ms);
    return `等待扫码… 码倒计时 ${clock}`;
  }
  return '等待出码或打开链接';
}

export function gcashPaywallFallback({ error, qr, link } = {}) {
  if (error) return error;
  if (isGcashQrImage(qr)) return '';
  if (link) return '已有跳转链但未抽到二维码。请重新出码；可临时打开或复制链接。';
  return '没有二维码，也没有可打开的链接。请先出码。';
}

export function gcashWallStatusLabel(item = {}) {
  if (item.paid || item.status === 'plus') return 'Plus';
  if (item.expired || item.status === 'expired') return '已过期';
  if (item.continue_submitted || item.status === 'continue_success') return 'continue 成功';
  if (item.processing || item.status === 'processing') return '已扫码处理中';
  if (item.status === 'refresh_failed' || item.refreshable === false) return '刷新失败';
  return '等待扫码';
}

export function gcashWallItemBusy(item = {}) {
  return Boolean(
    item.processing
    || item.continue_submitted
    || item.status === 'processing'
    || item.status === 'continue_success'
    || item.refresh_code === 'SCAN_IN_FLIGHT',
  );
}

export function filterAndSortGcashWall(items = [], options = {}) {
  const onlyScannable = options.onlyScannable !== false;
  const hideFinished = options.hideFinished !== false;
  return [...items]
    .filter((item) => (!onlyScannable || item.scannable || gcashWallItemBusy(item)))
    .filter((item) => (
      !hideFinished
      || gcashWallItemBusy(item)
      || !['plus', 'expired', 'refresh_failed'].includes(item.status)
    ))
    .sort((a, b) => (
      Number(a.qr_remaining_ms || 0) - Number(b.qr_remaining_ms || 0)
      || Number(a.id || 0) - Number(b.id || 0)
    ));
}
