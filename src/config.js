// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { LIMITS, MONITOR_ID_PATTERN, REFRESH_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  refresh_interval: '300',
  allow_pause_resume: false,
});

/** What the API key may hold: printable ASCII, no space. */
const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The monitors to follow: ids separated by commas, semicolons, dashes or
 * spaces. Empty: all of them. -> { ids: [...], invalid: count, tooMany } or null.
 * The invalid entries are only counted, never kept: a key pasted in this
 * field must never reach a status or a log.
 */
export function parseMonitorFilter(value) {
  const tokens = text(value)
    .split(/[,;\s-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const ids = [...new Set(tokens.filter((t) => MONITOR_ID_PATTERN.test(t)))];
  return {
    ids: ids.slice(0, LIMITS.FILTER_IDS),
    invalid: tokens.filter((t) => !MONITOR_ID_PATTERN.test(t)).length,
    tooMany: ids.length > LIMITS.FILTER_IDS,
  };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const apiKey = typeof raw.api_key === 'string' ? raw.api_key.trim() : '';
  const interval = REFRESH_INTERVALS.includes(String(raw.refresh_interval))
    ? String(raw.refresh_interval)
    : DEFAULTS.refresh_interval;
  return {
    apiKey,
    // An invisible character pasted with the key (U+200B...): said to the
    // user, never sent.
    apiKeyInvalid: apiKey !== '' && !KEY_PATTERN.test(apiKey),
    filter: parseMonitorFilter(raw.monitors),
    intervalMs: Number(interval) * 1000,
    allowPauseResume: bool(raw.allow_pause_resume, DEFAULTS.allow_pause_resume),
  };
}
