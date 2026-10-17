/** UI wall clock: Asia/Shanghai (UTC+8, no DST). Stored UTC ISO/naive stays UTC. */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

function pad(value) {
  return String(value).padStart(2, '0');
}

function shanghaiParts(ms) {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    second: pad(shifted.getUTCSeconds()),
  };
}

function formatShanghaiParts(ms, { seconds = false } = {}) {
  const p = shanghaiParts(ms);
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  return `${date} ${time}`;
}

/** Parse ISO / naive `YYYY-MM-DD HH:mm[:ss]` as UTC. Date-only returns null (keep calendar date). */
export function parseUtcDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value ?? '').trim();
  if (!text || DATE_ONLY_RE.test(text)) return null;
  const match = text.match(DATE_TIME_RE);
  if (match) {
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const date = new Date(text);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    return new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0),
    ));
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatShanghaiDateTime(value, { seconds = false } = {}) {
  if (value == null) return '—';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '—' : formatShanghaiParts(value.getTime(), { seconds });
  }
  const text = String(value).trim();
  if (!text) return '—';
  if (DATE_ONLY_RE.test(text)) return text;
  const date = parseUtcDate(text);
  if (!date) return text;
  return formatShanghaiParts(date.getTime(), { seconds });
}

/** List/detail timestamps: `YYYY-MM-DD HH:mm` in Asia/Shanghai. Date-only stays date-only. */
export function formatExpiresAt(value) {
  return formatShanghaiDateTime(value);
}

export function formatShanghaiDate(value) {
  const text = formatShanghaiDateTime(value);
  if (text === '—' || !/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  return text.slice(0, 10);
}

export function formatClock(value) {
  if (value == null) return '—';
  const date = value instanceof Date ? value : parseUtcDate(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  const p = shanghaiParts(date.getTime());
  return `${p.hour}:${p.minute}:${p.second}`;
}

function shanghaiWallToUtcStamp(year, month, day, hour, minute, second) {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - SHANGHAI_OFFSET_MS;
  const utc = new Date(utcMs);
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`;
}

export function toExpiresInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (DATE_ONLY_RE.test(text)) return `${text}T00:00`;
  const formatted = formatShanghaiDateTime(text);
  const match = formatted.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  if (!match) return '';
  return `${match[1]}T${match[2]}:${match[3]}`;
}

export function fromExpiresInput(input, original = '') {
  const text = String(input || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return text.replace('T', ' ');
  const originalHadTime = /\d{2}:\d{2}/.test(String(original || ''));
  if (`${match[2]}:${match[3]}` === '00:00' && !originalHadTime) return match[1];
  return shanghaiWallToUtcStamp(
    Number(match[1].slice(0, 4)),
    Number(match[1].slice(5, 7)),
    Number(match[1].slice(8, 10)),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] || 0),
  );
}
