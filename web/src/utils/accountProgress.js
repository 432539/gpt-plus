export const EXTRACTING = '提链中';
export const EXTRACTED = '已提链';
export const EXTRACTED_EXPIRED = '已提链(已过期)';
export const PAYING = '支付中';
export const PAYMENT_REVIEW = '支付待核验';
export const PAID = '已支付';
export const GOT_RT = '已拿RT';

function liveMatch(live, row) {
  if (!live?.running) return false;
  const email = String(row?.email || '').toLowerCase();
  const id = Number(row?.id);
  if (email && Array.isArray(live.emails) && live.emails.includes(email)) return true;
  return Number.isInteger(id) && Array.isArray(live.ids) && live.ids.includes(id);
}

export function isPaySettled(row = {}) {
  if (String(row.activated_at || '').trim()) return true;
  if (row.has_refresh_token || row.remark === GOT_RT) return true;
  return (row.progress || '') === PAID;
}

export function overlayProgress(row = {}, liveJobs = {}, pending = {}) {
  const pendingKind = pending[row.id];
  if (liveMatch(liveJobs.extract, row) || pendingKind === 'extract') return EXTRACTING;
  if (isPaySettled(row)) {
    if ((row.progress || '') === PAYING) return PAID;
    return row.progress || PAID;
  }
  if (liveMatch(liveJobs.activate, row) || pendingKind === 'activate') return PAYING;
  return row.progress || '';
}

export function remarkDisplay(row = {}, liveJobs = {}, pending = {}) {
  if (row.has_refresh_token || row.remark === GOT_RT) return GOT_RT;
  const overlay = overlayProgress(row, liveJobs, pending);
  if (overlay === EXTRACTING || overlay === PAYING || overlay === PAYMENT_REVIEW) return overlay;
  return overlay;
}

export function extractLogsQuery(liveExtract = {}) {
  const runId = String(liveExtract.run_id || '').trim();
  return runId ? { tab: 'oauth', run_id: runId } : { tab: 'oauth' };
}

export function activateLogsQuery(liveActivate = {}) {
  const runId = String(liveActivate.run_id || '').trim();
  return runId ? { tab: 'activate', run_id: runId } : { tab: 'activate' };
}

export function logRouteState(query = {}, tabs = []) {
  const tab = String(query.tab || '');
  const category = tabs.some((item) => item.key === tab) ? tab : 'pull';
  const runId = String(query.run_id || '').slice(0, 80);
  return { category, runId };
}
