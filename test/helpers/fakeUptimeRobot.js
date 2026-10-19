// -----------------------------------------------------------------------------
// A fake UptimeRobot API v2 in memory: getMonitors and editMonitor, with the
// answers the official documentation describes. Never checked against the
// real API (TODO.md).
// -----------------------------------------------------------------------------

import { UptimeRobotError } from '../../src/uptimerobot/errors.js';

export const API_KEY = 'ur1234567-0123456789abcdef01234567';
export const MAIN_KEY = 'u1234567-fedcba9876543210fedcba98';

const T0_SECONDS = Math.floor(Date.parse('2026-10-18T08:00:00Z') / 1000);

export function monitor(id, extra = {}) {
  return {
    id: Number(id),
    friendly_name: `Site ${id}`,
    url: `https://user:pass@site${id}.example.com/health?token=SECRET`,
    type: 1,
    sub_type: '',
    port: '',
    interval: 300,
    status: 2,
    create_datetime: T0_SECONDS - 86400,
    custom_uptime_ratio: '100.000-99.950-99.801',
    response_times: [{ datetime: T0_SECONDS - 60, value: 245 }],
    ...extra,
  };
}

const json = (status, value, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: Buffer.from(JSON.stringify(value)),
});

export function createFakeUptimeRobot() {
  const fake = {
    requests: [],
    monitors: [
      monitor(101),
      monitor(102, {
        friendly_name: 'Router',
        type: 3,
        url: '192.168.1.1',
        custom_uptime_ratio: '99.000-98.500-97.250',
        response_times: [{ datetime: T0_SECONDS - 60, value: 12 }],
      }),
    ],
    /** Keys accepted; MAIN_KEY may edit, API_KEY (read-only) may not. */
    keys: new Set([API_KEY, MAIN_KEY]),
    /** { method?, status, headers?, body?, error?, sent? } answered once each, in order. */
    failures: [],
    /** A promise editMonitor waits for before answering (a slow API). */
    editGate: null,
    edits: [],
  };

  fake.request = async (url, options = {}) => {
    const target = new URL(url);
    const method = target.pathname.replace(/^\/v2\//, '');
    const params = Object.fromEntries(new URLSearchParams(options.body ?? ''));
    const entry = {
      origin: target.origin,
      path: target.pathname,
      search: target.search,
      method,
      params,
    };
    fake.requests.push(entry);
    const index = fake.failures.findIndex((f) => !f.method || f.method === method);
    if (index !== -1) {
      const [failure] = fake.failures.splice(index, 1);
      if (failure.error) {
        if (failure.sent) options.onSent?.();
        const err = new UptimeRobotError(failure.error, 'fake failure');
        if (!failure.sent) err.notSent = true;
        throw err;
      }
      options.onSent?.();
      return {
        status: failure.status,
        headers: failure.headers ?? { 'content-type': 'application/json' },
        body: Buffer.from(failure.body ?? '{}'),
      };
    }
    options.onSent?.();
    if (!fake.keys.has(params.api_key)) {
      // The documented shape; `passed_value` echoes the key (never kept).
      return json(200, {
        stat: 'fail',
        error: {
          type: 'invalid_parameter',
          parameter_name: 'api_key',
          passed_value: params.api_key,
        },
      });
    }
    if (method === 'getMonitors') {
      const offset = Number(params.offset ?? 0);
      const limit = Number(params.limit ?? 50);
      const wanted = params.monitors ? new Set(params.monitors.split('-')) : null;
      const list = fake.monitors.filter((m) => !wanted || wanted.has(String(m.id)));
      return json(200, {
        stat: 'ok',
        pagination: { offset, limit, total: list.length },
        monitors: list.slice(offset, offset + limit),
      });
    }
    if (method === 'editMonitor') {
      fake.edits.push(entry);
      if (fake.editGate) await fake.editGate;
      if (params.api_key !== MAIN_KEY) {
        return json(200, {
          stat: 'fail',
          error: { type: 'not_authorized', message: `api_key ${params.api_key} is read-only` },
        });
      }
      const found = fake.monitors.find((m) => String(m.id) === params.id);
      if (!found) return json(200, { stat: 'fail', error: { type: 'not_found' } });
      found.status = params.status === '0' ? 0 : 1;
      return json(200, { stat: 'ok', monitor: { id: found.id } });
    }
    return json(404, { stat: 'fail', error: { type: 'not_found' } });
  };
  return fake;
}
