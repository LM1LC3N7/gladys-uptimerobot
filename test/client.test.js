// -----------------------------------------------------------------------------
// The client and the parsing (src/uptimerobot/): answers checked field by
// field, the key never kept from an error, the request budget, Retry-After.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../src/budget.js';
import { normalizeConfig, parseMonitorFilter } from '../src/config.js';
import { UptimeRobotClient, retryAfterMs } from '../src/uptimerobot/client.js';
import { CODES, isKeyRefused } from '../src/uptimerobot/errors.js';
import {
  cleanName,
  parseMonitor,
  parseMonitorsPage,
  parseRatios,
  safeTarget,
} from '../src/uptimerobot/parse.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');

const answer =
  (status, value, headers = {}) =>
  async () => ({
    status,
    headers,
    body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
  });

const client = (request, perMinute = 8) =>
  new UptimeRobotClient({
    apiKey: 'ur1-key',
    limiter: new Budget({ perMinute, now: () => T0 }),
    request,
    now: () => T0,
  });

test('safeTarget: host only, never credentials, path, query nor a heartbeat URL', () => {
  assert.equal(
    safeTarget(1, 'https://u:p@example.com:8443/a?token=x#y'),
    'https://example.com:8443',
  );
  assert.equal(safeTarget(2, 'http://example.com/login'), 'http://example.com');
  assert.equal(safeTarget(1, 'ftp://example.com'), null);
  assert.equal(safeTarget(1, 'not a url'), null);
  assert.equal(safeTarget(3, '192.168.1.1'), '192.168.1.1');
  assert.equal(safeTarget(3, 'user@host'), null);
  assert.equal(safeTarget(4, 'mail.example.com', 25), 'mail.example.com:25');
  assert.equal(safeTarget(4, 'mail.example.com', '99999'), 'mail.example.com');
  assert.equal(safeTarget(5, 'https://heartbeat.uptimerobot.com/m1-secret'), null);
  assert.equal(safeTarget(1, { toString: () => 'x' }), null);
});

test('parseRatios and names', () => {
  assert.deepEqual(parseRatios('100.000-99.950-99.801'), [100, 99.95, 99.801]);
  assert.deepEqual(parseRatios('101-abc-'), [null, null, null]);
  assert.deepEqual(parseRatios(42), [null, null, null]);
  assert.equal(cleanName(` a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)} c `), 'a b c');
  assert.equal(cleanName('x'.repeat(500)).length, 100);
});

test('parseMonitor: ids, statuses and types checked; no prototype pollution', () => {
  assert.equal(parseMonitor({ id: '../1' }), null);
  assert.equal(parseMonitor(null), null);
  const raw = JSON.parse(
    '{"id":5,"status":7,"type":99,"friendly_name":"","__proto__":{"polluted":1},"response_times":[{"datetime":"x","value":5},{"datetime":1760774400,"value":-1}]}',
  );
  const parsed = parseMonitor(raw);
  assert.equal(parsed.id, '5');
  assert.equal(parsed.status, null);
  assert.equal(parsed.typeLabel, null);
  assert.equal(parsed.name, 'Monitor 5');
  assert.equal(parsed.responseTime, null);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  const page = parseMonitorsPage(
    JSON.parse(
      '{"__proto__":{"x":1},"monitors":[{"id":1},{"id":"bad"}],"pagination":{"total":"2"}}',
    ),
  );
  assert.deepEqual(
    page.monitors.map((m) => m.id),
    ['1'],
  );
  assert.equal(page.total, 2);
  assert.equal(parseMonitorsPage({ monitors: 'no' }), null);
});

test('an API error keeps only its type: never passed_value nor message', async () => {
  const err = await client(
    answer(200, {
      stat: 'fail',
      error: {
        type: 'invalid_parameter',
        parameter_name: 'api_key',
        passed_value: 'ur1-key',
        message: 'api_key ur1-key is wrong',
      },
    }),
  )
    .monitors()
    .catch((e) => e);
  assert.equal(err.code, CODES.API);
  assert.equal(err.apiType, 'invalid_parameter');
  assert.ok(isKeyRefused(err));
  assert.ok(!JSON.stringify({ ...err, message: err.message }).includes('ur1-key'));
  const odd = await client(answer(200, { stat: 'fail', error: { type: 'ur1-key oops' } }))
    .monitors()
    .catch((e) => e);
  assert.equal(odd.apiType, 'unknown');
});

test('the key is refused only on getMonitors; a 403 is passing', async () => {
  const edit = await client(answer(200, { stat: 'fail', error: { type: 'not_authorized' } }))
    .setPaused('1', true)
    .catch((e) => e);
  assert.equal(isKeyRefused(edit), false);
  const forbidden = await client(answer(403, '<html>'))
    .monitors()
    .catch((e) => e);
  assert.equal(isKeyRefused(forbidden), false);
  const unauthorized = await client(answer(401, '{}'))
    .monitors()
    .catch((e) => e);
  assert.equal(isKeyRefused(unauthorized), true);
});

test('retryAfterMs: Retry-After, else X-RateLimit-Reset, else null', () => {
  assert.equal(retryAfterMs({ 'retry-after': '30' }, T0), 30_000);
  assert.equal(retryAfterMs({ 'x-ratelimit-reset': String(T0 / 1000 + 45) }, T0), 45_000);
  assert.equal(retryAfterMs({ 'retry-after': 'Wed, 21 Oct' }, T0), null);
  assert.equal(retryAfterMs({}, T0), null);
});

test('the request budget: beyond it, nothing is sent', async () => {
  let calls = 0;
  const c = client(async () => {
    calls += 1;
    return { status: 200, headers: {}, body: Buffer.from('{"stat":"ok","monitors":[]}') };
  }, 2);
  await c.monitors();
  await c.monitors();
  const err = await c.monitors().catch((e) => e);
  assert.equal(err.code, CODES.LIMITED);
  assert.equal(err.notSent, true);
  assert.equal(calls, 2);
});

test('a command with no time left is not sent', async () => {
  let calls = 0;
  const err = await client(async () => {
    calls += 1;
  })
    .setPaused('1', true, { deadline: T0 + 100 })
    .catch((e) => e);
  assert.equal(err.code, CODES.NO_TIME);
  assert.equal(err.notSent, true);
  assert.equal(calls, 0);
});

test('the configuration', () => {
  assert.deepEqual(normalizeConfig({}), {
    apiKey: '',
    apiKeyInvalid: false,
    filter: null,
    intervalMs: 300_000,
    allowPauseResume: false,
  });
  assert.equal(normalizeConfig({ refresh_interval: '7' }).intervalMs, 300_000);
  assert.equal(normalizeConfig({ allow_pause_resume: 'yes' }).allowPauseResume, false);
  assert.deepEqual(parseMonitorFilter('1, 2;3 4-5 1'), {
    ids: ['1', '2', '3', '4', '5'],
    invalid: [],
    tooMany: false,
  });
  assert.equal(
    parseMonitorFilter(Array.from({ length: 51 }, (_, i) => i + 1).join(',')).tooMany,
    true,
  );
});
