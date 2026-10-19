// -----------------------------------------------------------------------------
// The official UptimeRobot API v2 (https://uptimerobot.com/api/legacy/):
//   POST /v2/getMonitors   the monitors, 50 per page, with the uptime ratios
//                          of the last 1, 7 and 30 days and the latest
//                          response time (one request per page)
//   POST /v2/editMonitor   status 0 pauses a monitor, 1 resumes it (main key)
// The key goes in the form body only (never in a URL, never in a log), and
// only to api.uptimerobot.com (fixed here, never configurable). Every request
// is counted in a budget shared by every path: the free plan admits 10
// requests per minute, this integration sends 8 at most.
//
// Why v2 and not v3: see TODO.md, "Decisions".
// -----------------------------------------------------------------------------

import { API_ORIGIN, LIMITS, MAX_BYTES, TIMEOUTS } from '../constants.js';
import { CODES, UptimeRobotError } from './errors.js';
import { httpRequest } from './http.js';
import { parseMonitorsPage } from './parse.js';

/** Room a command needs before its deadline, or it is not sent at all. */
const MIN_SEND_MS = 300;

const header = (headers, name) => {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * The wait an HTTP 429 asks for, in ms, or null: Retry-After (seconds), else
 * X-RateLimit-Reset (epoch seconds, documented for the rate limits).
 */
export function retryAfterMs(headers, now) {
  const retry = header(headers, 'retry-after');
  if (typeof retry === 'string' && /^\d{1,9}$/.test(retry.trim())) {
    return Number(retry.trim()) * 1000;
  }
  const reset = header(headers, 'x-ratelimit-reset');
  if (typeof reset === 'string' && /^\d{9,11}$/.test(reset.trim())) {
    const delay = Number(reset.trim()) * 1000 - now;
    return delay > 0 ? delay : null;
  }
  return null;
}

const notSent = (err) => {
  if (err && typeof err === 'object') err.notSent = true;
  return err;
};

/** The `error` of a `stat: fail` answer, reduced to what is safe to keep. */
function apiErrorOf(json) {
  const error = json !== null && typeof json === 'object' ? json.error : null;
  const pick = (key) => {
    const value =
      error !== null && typeof error === 'object' && Object.hasOwn(error, key) ? error[key] : null;
    return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : undefined;
  };
  // Never `passed_value` nor `message`: they may quote the API key.
  return { apiType: pick('type') ?? 'unknown', apiParameter: pick('parameter_name') };
}

export class UptimeRobotClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {import('../budget.js').Budget} options.limiter requests per minute, shared
   * @param {Function} [options.request] the HTTP transport (tests inject a fake UptimeRobot)
   * @param {() => number} [options.now]
   */
  constructor({ apiKey, limiter, request = httpRequest, now = Date.now }) {
    this.apiKey = apiKey;
    this.limiter = limiter;
    this.request = request;
    this.now = now;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  /**
   * One POST. Resolves the parsed JSON of a `stat: ok` answer; rejects an
   * UptimeRobotError (HTTP with its status, API for `stat: fail`).
   */
  async call(method, params, { timeout = TIMEOUTS.API, onSent } = {}) {
    if (this.closed) throw notSent(new UptimeRobotError(CODES.CLOSED, 'Client closed'));
    if (this.limiter.remaining() < 1) {
      throw notSent(
        new UptimeRobotError(CODES.LIMITED, 'Request budget of the minute spent: not sent'),
      );
    }
    this.limiter.record(1);
    const body = new URLSearchParams({ api_key: this.apiKey, format: 'json', ...params });
    const response = await this.request(`${API_ORIGIN}/v2/${method}`, {
      body: body.toString(),
      timeout,
      maxBytes: MAX_BYTES,
      onSent,
    });
    let json;
    try {
      json = JSON.parse(response.body?.toString('utf8') ?? '');
    } catch {
      json = null;
    }
    if (response.status < 200 || response.status > 299) {
      throw new UptimeRobotError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers, this.now()),
        method,
      });
    }
    if (json === null || typeof json !== 'object') {
      throw new UptimeRobotError(CODES.BAD_ANSWER, 'Not JSON', { method });
    }
    if (json.stat !== 'ok') {
      const { apiType, apiParameter } = apiErrorOf(json);
      throw new UptimeRobotError(CODES.API, `API error ${apiType}`, {
        status: response.status,
        method,
        apiType,
        apiParameter,
      });
    }
    return json;
  }

  /** Requests a full reading needs at most. */
  static pagesFor(ids) {
    return ids ? 1 : Math.ceil(LIMITS.MONITORS / LIMITS.PAGE);
  }

  /**
   * Every monitor (or those of `ids`), LIMITS.MONITORS at most, page by page.
   * Resolves { monitors, total }.
   */
  async monitors({ ids } = {}) {
    const monitors = [];
    let total = 0;
    for (let offset = 0; offset < LIMITS.MONITORS; offset += LIMITS.PAGE) {
      const params = {
        custom_uptime_ratios: '1-7-30',
        response_times: '1',
        response_times_limit: '1',
        logs: '0',
        offset: String(offset),
        limit: String(LIMITS.PAGE),
      };
      if (ids) params.monitors = ids.join('-');
      const page = parseMonitorsPage(await this.call('getMonitors', params));
      if (!page) throw new UptimeRobotError(CODES.BAD_ANSWER, 'Not a list of monitors');
      total = page.total;
      monitors.push(...page.monitors);
      if (page.count < LIMITS.PAGE || offset + LIMITS.PAGE >= total) break;
    }
    const unique = new Map();
    for (const monitor of monitors) if (!unique.has(monitor.id)) unique.set(monitor.id, monitor);
    return { monitors: [...unique.values()].slice(0, LIMITS.MONITORS), total };
  }

  /**
   * Pause (`paused` true) or resume a monitor. The deadline bounds the whole
   * exchange; no room left: not sent.
   */
  async setPaused(id, paused, { deadline, onSent } = {}) {
    const remaining = deadline === undefined ? TIMEOUTS.API : deadline - this.now();
    if (remaining < MIN_SEND_MS) {
      throw notSent(new UptimeRobotError(CODES.NO_TIME, 'No time left: request not sent'));
    }
    await this.call(
      'editMonitor',
      { id, status: paused ? '0' : '1' },
      { timeout: Math.min(TIMEOUTS.API, remaining), onSent },
    );
  }
}
