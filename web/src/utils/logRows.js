function rowId(row) {
  const id = Number(row?.id);
  return Number.isFinite(id) ? id : 0;
}

const envLimit = Number(typeof import.meta !== 'undefined' ? import.meta.env?.VITE_LOG_ROW_LIMIT : process.env.VITE_LOG_ROW_LIMIT);
export const LOG_ROW_LIMIT = Number.isFinite(envLimit) && envLimit > 0
  ? Math.min(5000, Math.max(1, Math.floor(envLimit)))
  : 100;
export const LOG_BOTTOM_THRESHOLD = 48;

export function mergeLogRows(current = [], incoming = [], limit = LOG_ROW_LIMIT) {
  const byId = new Map();
  for (const row of [...current, ...incoming]) {
    const id = rowId(row);
    if (id > 0) byId.set(id, row);
  }
  const ordered = [...byId.values()].sort((a, b) => rowId(a) - rowId(b));
  return ordered.slice(-Math.min(LOG_ROW_LIMIT, Math.max(1, Number(limit) || LOG_ROW_LIMIT)));
}

export function sameLogRows(left = [], right = []) {
  return (
    left.length === right.length &&
    left.every((row, index) => rowId(row) === rowId(right[index]))
  );
}

export function isNearLogBottom(
  { scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {},
  threshold = LOG_BOTTOM_THRESHOLD
) {
  return scrollHeight - clientHeight - scrollTop <= Math.max(0, Number(threshold) || 0);
}

export function nextLogScrollTop(
  { wasNearBottom = false, oldScrollTop = 0, newScrollHeight = 0 } = {}
) {
  return wasNearBottom ? Math.max(0, Number(newScrollHeight) || 0) : Math.max(0, Number(oldScrollTop) || 0);
}

export const CONGRATS_ACTIVATE_COPY = '恭喜你,开通成功';
export const CONGRATS_REGISTER_COPY = '恭喜你,注册成功!';

const LEVEL_TEXT = Object.freeze({
  info: 'INFO',
  success: 'OK',
  warning: 'WARN',
  error: 'ERROR',
});

const REGISTER_LEVEL_TEXT = Object.freeze({
  info: '进度',
  success: '成功',
  warning: '提醒',
  error: '失败',
});

export function isCongratsActivateMessage(message) {
  return String(message || '').includes(CONGRATS_ACTIVATE_COPY);
}

export function isCongratsRegisterMessage(message) {
  return String(message || '').includes(CONGRATS_REGISTER_COPY);
}

export function isCongratsLogMessage(message) {
  return isCongratsActivateMessage(message) || isCongratsRegisterMessage(message);
}

export function logLevelText(level, category) {
  const key = String(level || 'info').toLowerCase();
  const map = category === 'register' ? REGISTER_LEVEL_TEXT : LEVEL_TEXT;
  return map[key] || (category === 'register' ? '进度' : String(level || '').toUpperCase());
}

export function logSourceText(source, category) {
  if (String(source || '') === 'rebind') return '换绑';
  if (category === 'register') return '注册';
  return String(source || '');
}

export function logLineClassNames(row) {
  const level = String(row?.level || 'info');
  const names = [`log-line--${level}`];
  if (isCongratsLogMessage(row?.message)) names.push('log-line--congrats');
  return names;
}
