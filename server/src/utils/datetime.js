'use strict';

/** Display wall clock: Asia/Shanghai (UTC+8, no DST). Storage may stay UTC. */
const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
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

function parseUtcDate(value) {
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

function formatShanghaiDateTime(value, { seconds = false } = {}) {
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

function utcStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function nowShanghaiStamp(ms = Date.now()) {
  return formatShanghaiParts(ms, { seconds: true });
}

module.exports = {
  DISPLAY_TIME_ZONE,
  formatShanghaiDateTime,
  parseUtcDate,
  utcStamp,
  nowShanghaiStamp,
};
