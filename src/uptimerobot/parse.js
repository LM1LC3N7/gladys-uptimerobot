// -----------------------------------------------------------------------------
// Parsing of the getMonitors answers (pure). The answers are untrusted: each
// field is read on its own, checked and copied into a fresh object (never a
// spread nor an Object.assign of what the API sent: no prototype pollution),
// and everything is capped.
// -----------------------------------------------------------------------------

import { API_STATUS, LIMITS, MONITOR_ID_PATTERN, MONITOR_TYPES } from '../constants.js';

const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;

const KNOWN_STATUSES = new Set(Object.values(API_STATUS));

/** A host name or an IP address, nothing else (no credentials, no path). */
const HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9-]{1,63})*\.?|\[?[0-9A-Fa-f:.]{2,45}\]?)$/;

/** Control characters and the like, stripped from the names shown. */
// Built from code points: the source stays plain ASCII.
const CONTROL_RANGES = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];
const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
const CONTROL = new RegExp(
  `[${CONTROL_RANGES.map(([a, b]) => `${hex(a)}-${hex(b)}`).join('')}]`,
  'gu',
);

export function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.NAME);
}

const integer = (value) => {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * What may be shown of the target of a monitor: the scheme and host of an
 * HTTP(s) / keyword URL, the host of a ping, host:port of a port monitor.
 * Never the path, the query nor credentials (a token may hide there), never
 * the URL of a heartbeat (it is the secret push URL). null when unsure.
 */
export function safeTarget(type, url, port) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  if (type === 1 || type === 2) {
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!HOST_PATTERN.test(parsed.hostname)) return null;
    return `${parsed.protocol}//${parsed.host}`;
  }
  if (type === 3 || type === 4) {
    const host = url.trim();
    if (!HOST_PATTERN.test(host) || host.length > 253) return null;
    if (type === 3) return host;
    const p = integer(port);
    return p !== null && p >= 1 && p <= 65535 ? `${host}:${p}` : host;
  }
  return null;
}

/** "99.998-100.000-99.950" (the 1-7-30 days asked) -> [99.998, 100, 99.95] or nulls. */
export function parseRatios(value) {
  const parts = typeof value === 'string' && value.length <= 100 ? value.split('-') : [];
  const ratio = (text) => {
    if (typeof text !== 'string' || !/^\d{1,3}(?:\.\d{1,6})?$/.test(text)) return null;
    const n = Number(text);
    return n >= 0 && n <= 100 ? Math.round(n * 1000) / 1000 : null;
  };
  return [ratio(parts[0]), ratio(parts[1]), ratio(parts[2])];
}

/** The latest response time: { ms, at } (at in ms since epoch) or null. */
export function parseResponseTime(list) {
  if (!Array.isArray(list)) return null;
  let latest = null;
  for (const item of list.slice(0, 10)) {
    const ms = own(item, 'value');
    const at = integer(own(item, 'datetime'));
    if (!Number.isFinite(ms) || ms < 0 || ms > 600_000 || at === null) continue;
    if (!latest || at * 1000 > latest.at) latest = { ms: Math.round(ms), at: at * 1000 };
  }
  return latest;
}

/** One monitor of the answer, or null when it cannot be trusted. */
export function parseMonitor(raw) {
  const rawId = own(raw, 'id');
  const id = typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : '';
  if (!MONITOR_ID_PATTERN.test(id)) return null;
  const type = integer(own(raw, 'type'));
  const status = integer(own(raw, 'status'));
  const [uptime24h, uptime7d, uptime30d] = parseRatios(own(raw, 'custom_uptime_ratio'));
  const typeLabel = Object.hasOwn(MONITOR_TYPES, type) ? MONITOR_TYPES[type] : null;
  return {
    id,
    name: cleanName(own(raw, 'friendly_name')) || `Monitor ${id}`,
    type,
    typeLabel,
    target: safeTarget(type, own(raw, 'url'), own(raw, 'port')),
    status: KNOWN_STATUSES.has(status) ? status : null,
    interval: integer(own(raw, 'interval')),
    uptime24h,
    uptime7d,
    uptime30d,
    responseTime: parseResponseTime(own(raw, 'response_times')),
  };
}

/**
 * A page of getMonitors: { total, monitors } or null when it is not one.
 * The `stat` is checked by the client before.
 */
export function parseMonitorsPage(json) {
  const list = own(json, 'monitors');
  if (!Array.isArray(list)) return null;
  const monitors = [];
  for (const raw of list.slice(0, LIMITS.PAGE)) {
    const monitor = parseMonitor(raw);
    if (monitor) monitors.push(monitor);
  }
  const total = integer(own(own(json, 'pagination'), 'total'));
  return { total: total ?? list.length, count: Math.min(list.length, LIMITS.PAGE), monitors };
}
