// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake UptimeRobot,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { UptimeRobotApp } from '../src/app.js';
import { ACTIONS, API_ORIGIN, INTERVALS, STORE_FILE } from '../src/constants.js';
import { buildMonitorDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { parseMonitor } from '../src/uptimerobot/parse.js';
import { CODES } from '../src/uptimerobot/errors.js';
import { API_KEY, MAIN_KEY, createFakeUptimeRobot, monitor } from './helpers/fakeUptimeRobot.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');
const SELECTOR = 'uptimerobot';
const ids = createFakeGladys({ selector: SELECTOR });
const SITE = buildMonitorDevice(ids, parseMonitor(monitor(101)));
const ROUTER = buildMonitorDevice(
  ids,
  parseMonitor(monitor(102, { type: 3, url: '192.168.1.1', friendly_name: 'Router' })),
);
const withButtons = (device) =>
  buildMonitorDevice(
    ids,
    { id: device.external_id.split(':').at(-1), name: device.name },
    {
      withButtons: true,
    },
  );
const featureId = (device, key) => `${device.external_id}:${key}`;
const feature = (device, key) =>
  device.features.find((f) => f.external_id === featureId(device, key));
const INTERVAL = 300_000;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({ config = {}, devices = [SITE, ROUTER], api, dataDir, clock } = {}) {
  clock ??= { now: T0 };
  api ??= createFakeUptimeRobot();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { api_key: API_KEY, ...config },
    devices,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'uptimerobot-app-'));
  const app = new UptimeRobotApp({
    gladys,
    logger,
    request: api.request,
    dataDir,
    now: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, api, timers, clock, logs, app, dataDir };
}

const state = (gladys, device, key) => gladys.fake.lastState(featureId(device, key));
const reads = (api) => api.requests.filter((r) => r.method === 'getMonitors');
/** Advance the clock by the interval and run the loop once. */
async function nextRound({ clock, timers }, ms = INTERVAL) {
  clock.now += ms;
  await timers.run();
}

test('start: Discovery gets every monitor; states; badges; one request', async () => {
  const { gladys, api, timers } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'UptimeRobot answers: 2 monitors (2 up, 0 down, 0 paused).',
      fr: 'UptimeRobot répond : 2 moniteurs (2 en ligne, 0 hors ligne, 0 en pause).',
    },
  });
  const discovered = gladys.fake.discoveredDevices;
  assert.deepEqual(
    discovered.map((d) => [d.external_id, d.name, d.model]),
    [
      [`ext:${SELECTOR}:monitor:101`, 'Site 101', 'UptimeRobot HTTP(s) monitor'],
      [`ext:${SELECTOR}:monitor:102`, 'Router', 'UptimeRobot Ping monitor'],
    ],
  );
  assert.deepEqual(discovered[0].params, [
    { name: 'MONITOR_ID', value: '101' },
    { name: 'MONITOR_TYPE', value: 'HTTP(s)' },
    { name: 'MONITOR_TARGET', value: 'https://site101.example.com' },
  ]);
  const text = JSON.stringify(discovered);
  assert.ok(!/pass|token|SECRET|health/.test(text), 'never credentials, path nor query');
  assert.ok(
    discovered.every((d) => !d.features.some((f) => f.category === 'switch')),
    'never a switch',
  );
  assert.ok(!discovered[0].features.some((f) => f.category === 'button'), 'no button by default');
  assert.equal(state(gladys, SITE, 'online'), 1);
  assert.equal(state(gladys, SITE, 'status'), 'up');
  assert.equal(state(gladys, SITE, 'response_time'), 245);
  assert.equal(state(gladys, SITE, 'uptime_24h'), 100);
  assert.equal(state(gladys, SITE, 'uptime_7d'), 99.95);
  assert.equal(state(gladys, SITE, 'uptime_30d'), 99.801);
  assert.equal(state(gladys, ROUTER, 'uptime_30d'), 97.25);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'cloud'));
  assert.deepEqual(timers.delays(), [INTERVAL]);
  assert.equal(api.requests.length, 1);
  const [request] = api.requests;
  assert.equal(request.origin, API_ORIGIN);
  assert.equal(request.path, '/v2/getMonitors');
  assert.equal(request.search, '', 'the key is never in a URL');
  assert.equal(request.params.api_key, API_KEY);
  assert.equal(request.params.custom_uptime_ratios, '1-7-30');
  assert.equal(request.params.response_times_limit, '1');
  assert.equal(gladys.fake.sceneEvents.length, 0, 'the first reading fires nothing');
});

test('the loop reads at the interval, the refresh interval of the configuration', async () => {
  const ctx = await setup();
  ctx.api.monitors[0].response_times = [{ datetime: (T0 + INTERVAL) / 1000, value: 300 }];
  await nextRound(ctx);
  assert.equal(state(ctx.gladys, SITE, 'response_time'), 300);
  assert.equal(reads(ctx.api).length, 2);
  assert.deepEqual(ctx.timers.delays(), [INTERVAL]);
  const other = await setup({ config: { refresh_interval: '1800' } });
  assert.deepEqual(other.timers.delays(), [1_800_000]);
});

test('scene triggers: down, then back up, between two close readings only', async () => {
  const ctx = await setup();
  const { gladys, api } = ctx;
  api.monitors[0].status = 8; // seems down: not confirmed yet
  await nextRound(ctx);
  assert.equal(gladys.fake.sceneEvents.length, 0);
  assert.equal(state(gladys, SITE, 'status'), 'seems_down');
  assert.equal(state(gladys, SITE, 'online'), 1, 'online stays until confirmed');
  api.monitors[0].status = 9;
  await nextRound(ctx);
  assert.deepEqual(gladys.fake.sceneEvents, [
    {
      key: 'monitor_down',
      data: { monitor: SITE.external_id, monitor_name: 'Site 101', monitor_type: 'HTTP(s)' },
    },
  ]);
  assert.equal(state(gladys, SITE, 'online'), 0);
  await nextRound(ctx);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'one event per transition');
  api.monitors[0].status = 2;
  await nextRound(ctx);
  assert.equal(gladys.fake.sceneEvents.length, 2);
  assert.equal(gladys.fake.sceneEvents[1].key, 'monitor_up');
});

test('a "seems down" back to up fires nothing', async () => {
  const ctx = await setup();
  ctx.api.monitors[0].status = 8;
  await nextRound(ctx);
  ctx.api.monitors[0].status = 2;
  await nextRound(ctx);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
});

test('after a long gap, a change only becomes the new reference', async () => {
  const ctx = await setup();
  const { gladys, api } = ctx;
  api.failures.push({ error: CODES.UNREACHABLE });
  await nextRound(ctx);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  api.monitors[0].status = 9;
  // The retry comes 2 intervals later: the previous reading is 3 intervals old.
  await nextRound(ctx, 2 * INTERVAL);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'not fired after a gap');
  assert.equal(state(gladys, SITE, 'online'), 0, 'the state itself is published');
  api.monitors[0].status = 2;
  await nextRound(ctx);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'the next close reading fires again');
});

test('a paused monitor resumed fires nothing; a new monitor fires nothing', async () => {
  const ctx = await setup();
  ctx.api.monitors[0].status = 0;
  await nextRound(ctx);
  assert.equal(state(ctx.gladys, SITE, 'status'), 'paused');
  ctx.api.monitors[0].status = 2;
  ctx.api.monitors.push(monitor(103, { status: 9 }));
  await nextRound(ctx);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
});

test('a restart fires nothing on its first reading', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'uptimerobot-app-'));
  const api = createFakeUptimeRobot();
  await setup({ api, dataDir });
  await running.stop();
  api.monitors[0].status = 9;
  const ctx = await setup({ api, dataDir });
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0);
});

test('a reconnection to Gladys republishes status and Discovery, keeps the references', async () => {
  const ctx = await setup();
  const { gladys, api } = ctx;
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.requests.filter((r) => r.path === '/discovered_device').length;
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1, 'status sent again');
  assert.equal(
    gladys.fake.requests.filter((r) => r.path === '/discovered_device').length,
    discoveries + 1,
    'Discovery sent again',
  );
  assert.equal(reads(api).length, 1, 'no extra request to UptimeRobot');
  api.monitors[0].status = 9;
  await nextRound(ctx);
  assert.equal(gladys.fake.sceneEvents.length, 1, 'the reference survived the reconnection');
});

test('a refused key: final, persisted, never in a log, a status or an error', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'uptimerobot-app-'));
  const BAD = 'ur999-badbadbadbadbad';
  const ctx = await setup({ config: { api_key: BAD }, dataDir });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the API key/);
  assert.deepEqual(ctx.timers.delays(), [], 'no retry by itself');
  const everything = JSON.stringify([ctx.logs, ctx.gladys.fake.connectionStatuses]);
  assert.ok(!everything.includes(BAD), 'the key never shows');
  assert.ok(!readFileSync(join(dataDir, STORE_FILE), 'utf8').includes(BAD), 'nor in /data');
  // A restart with the same key does not try again.
  await running.stop();
  const again = await setup({ config: { api_key: BAD }, dataDir });
  assert.equal(again.api.requests.length, 0);
  // The button tries (the user asked), and says why.
  const ack = await again.gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /refused the API key/);
  assert.ok(!ack.error.includes(BAD));
  assert.equal(again.api.requests.length, 1);
});

test('HTTP 429: a bounded pause of every path, kept across a restart and a reconnection', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'uptimerobot-app-'));
  const ctx = await setup({ dataDir });
  ctx.api.failures.push({ status: 429, headers: { 'retry-after': '5' } });
  await nextRound(ctx);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /HTTP 429/);
  // Retry-After 5 s: never faster than the interval.
  assert.deepEqual(ctx.timers.delays(), [INTERVAL]);
  const stored = JSON.parse(readFileSync(join(dataDir, STORE_FILE), 'utf8'));
  assert.equal(Number(stored.meta.pausedUntil), ctx.clock.now + INTERVAL);
  // A reconnection keeps the pause: no request.
  await ctx.gladys.disconnect();
  await ctx.gladys.connect();
  assert.equal(reads(ctx.api).length, 2);
  // A restart keeps it too.
  await running.stop();
  const again = await setup({ dataDir, clock: { now: ctx.clock.now + 60_000 } });
  assert.equal(again.api.requests.length, 0);
  assert.deepEqual(again.timers.delays(), [INTERVAL - 60_000]);
});

test('a long Retry-After is capped at 6 h; a pause file gone wrong is capped too', async () => {
  const ctx = await setup();
  ctx.api.failures.push({ status: 429, headers: { 'retry-after': '999999' } });
  await nextRound(ctx);
  assert.deepEqual(ctx.timers.delays(), [INTERVALS.BUSY_MAX_MS]);
  const dataDir = mkdtempSync(join(tmpdir(), 'uptimerobot-app-'));
  writeFileSync(
    join(dataDir, STORE_FILE),
    JSON.stringify({ meta: { pausedUntil: String(T0 + 365 * 86400_000) } }),
  );
  await running.stop();
  const again = await setup({ dataDir });
  assert.deepEqual(again.timers.delays(), [INTERVALS.BUSY_MAX_MS]);
});

test('a failure is never read again faster than the interval, then doubles', async () => {
  const ctx = await setup();
  ctx.api.failures.push({ status: 502 }, { status: 502 });
  await nextRound(ctx);
  assert.deepEqual(ctx.timers.delays(), [INTERVAL]);
  await nextRound(ctx);
  assert.deepEqual(ctx.timers.delays(), [2 * INTERVAL]);
  await nextRound(ctx, 2 * INTERVAL);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('an unexpected answer is a passing failure, never a crash', async () => {
  const ctx = await setup();
  ctx.api.failures.push({ status: 200, body: '<html>maintenance</html>' });
  await nextRound(ctx);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /unexpected answer/);
  ctx.api.failures.push({ status: 403, body: '<html>denied</html>' });
  await nextRound(ctx);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /HTTP error 403/);
  assert.equal(ctx.timers.delays().length, 1, 'a 403 page is not a refused key');
});

test('the monitor filter, an id absent from the account, an invalid id', async () => {
  const ctx = await setup({ config: { monitors: '102, 999' } });
  assert.deepEqual(
    ctx.gladys.fake.discoveredDevices.map((d) => d.name),
    ['Router'],
  );
  assert.equal(ctx.api.requests[0].params.monitors, '102-999');
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Not found in the account: 999/);
  const bad = await setup({ config: { monitors: '101, abc' } });
  assert.match(bad.gladys.fake.connectionStatus.message.en, /1 entry that is not an UptimeRobot/);
  assert.ok(!JSON.stringify(bad.gladys.fake.connectionStatus).includes('abc'), 'never quoted');
  assert.equal(bad.api.requests.length, 0);
});

test('a missing or invalid key is said, nothing sent', async () => {
  const none = await setup({ config: { api_key: '' } });
  assert.match(none.gladys.fake.connectionStatus.message.en, /read-only key is enough/);
  const invalid = await setup({ config: { api_key: `ur1${String.fromCharCode(0x200b)}23` } });
  assert.match(invalid.gladys.fake.connectionStatus.message.en, /invisible character/);
  assert.equal(none.api.requests.length + invalid.api.requests.length, 0);
});

test('pages of 50 monitors, 200 at most, the created ones first', async () => {
  const api = createFakeUptimeRobot();
  api.monitors = Array.from({ length: 230 }, (_, i) => monitor(1000 + i));
  const created = buildMonitorDevice(ids, parseMonitor(monitor(1229)));
  const ctx = await setup({ api, devices: [created] });
  assert.equal(reads(api).length, 4);
  assert.deepEqual(
    reads(api).map((r) => r.params.offset),
    ['0', '50', '100', '150'],
  );
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 200);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /30 monitors left out/);
});

test('a heartbeat URL is never shown; an old response time is not published', async () => {
  const api = createFakeUptimeRobot();
  api.monitors = [
    monitor(201, {
      type: 5,
      url: 'https://heartbeat.uptimerobot.com/m201-0123456789secret',
      response_times: [{ datetime: T0 / 1000 - 3 * 3600, value: 99 }],
    }),
  ];
  const device = buildMonitorDevice(ids, parseMonitor(api.monitors[0]));
  const ctx = await setup({ api, devices: [device] });
  const [discovered] = ctx.gladys.fake.discoveredDevices;
  assert.ok(!JSON.stringify(discovered).includes('heartbeat.uptimerobot.com'));
  assert.equal(state(ctx.gladys, device, 'response_time'), undefined);
  assert.equal(state(ctx.gladys, device, 'online'), 1);
});

test('pause and resume: refused by default, a reading is read only', async () => {
  const { gladys, api } = await setup({ devices: [withButtons(SITE)] });
  const device = withButtons(SITE);
  const ack = await gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Pause and resume are off/);
  const read = await gladys.fake.setValue(device, feature(device, 'online'), 0);
  assert.match(read.error, /is a reading/);
  assert.equal(api.edits.length, 0);
});

test('pause and resume allowed: buttons, the main key pauses, the read-only key is refused', async () => {
  const ctx = await setup({
    config: { api_key: MAIN_KEY, allow_pause_resume: true },
    devices: [withButtons(SITE)],
  });
  const { gladys, api } = ctx;
  const device = withButtons(SITE);
  const keys = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(keys.includes('pause') && keys.includes('resume'));
  for (const bad of [0, '1', null, '']) {
    const ack = await gladys.fake.setValue(device, feature(device, 'pause'), bad);
    assert.match(ack.error, /Invalid value/, String(bad));
  }
  const ack = await gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    api.edits.map((e) => [e.params.id, e.params.status]),
    [['101', '0']],
  );
  assert.equal(state(gladys, device, 'status'), 'paused');
  await gladys.fake.setValue(device, feature(device, 'resume'), 1);
  assert.equal(api.edits.at(-1).params.status, '1');
  assert.equal(state(gladys, device, 'status'), 'not_checked');
  // The monitor comes back up: no "back up" event after a resume.
  await nextRound(ctx);
  assert.equal(gladys.fake.sceneEvents.length, 0);

  const readOnly = await setup({
    config: { allow_pause_resume: true },
    devices: [withButtons(SITE)],
  });
  const refused = await readOnly.gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.match(refused.error, /read-only or monitor-specific API key cannot pause/);
  assert.ok(!refused.error.includes(API_KEY));
  assert.ok(!readOnly.app.blocked, 'the key still reads');
});

test('the option turned off: buttons kept (no feature lost), commands refused at once', async () => {
  const ctx = await setup({
    config: { api_key: MAIN_KEY, allow_pause_resume: true },
    devices: [withButtons(SITE)],
  });
  const { gladys, api } = ctx;
  // The new configuration narrows at once, even before its start runs.
  const update = gladys.fake.configUpdated({ api_key: MAIN_KEY, allow_pause_resume: false });
  await update;
  const device = withButtons(SITE);
  const ack = await gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.match(ack.error, /Pause and resume are off/);
  assert.equal(api.edits.length, 0);
  const keys = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(keys.includes('pause') && keys.includes('resume'), 'never dropped');
});

test('a feature this version does not know is kept on republish', async () => {
  const created = {
    ...SITE,
    features: [
      ...SITE.features,
      {
        name: 'Future',
        external_id: `${SITE.external_id}:future`,
        category: 'unknown',
        type: 'unknown',
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
  const { gladys } = await setup({ devices: [created] });
  const keys = gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').at(-1),
  );
  assert.ok(keys.includes('future'));
});

test('the request budget: 8 a minute, every path counted; a command beyond is not sent', async () => {
  const ctx = await setup({
    config: { api_key: MAIN_KEY, allow_pause_resume: true },
    devices: [withButtons(SITE)],
  });
  const device = withButtons(SITE);
  const answers = [];
  for (let i = 0; i < 9; i += 1) {
    answers.push(await ctx.gladys.fake.setValue(device, feature(device, 'pause'), 1));
  }
  assert.equal(ctx.api.edits.length, 7, '1 reading + 7 commands');
  assert.match(answers.at(-1).error, /Too many requests to UptimeRobot this minute/);
  // The next reading waits for room in the budget instead of failing.
  await nextRound(ctx, 1);
  assert.equal(reads(ctx.api).length, 1);
  assert.deepEqual(ctx.timers.delays(), [60_000]);
});

test('a command that may have left is never said "not sent"', async () => {
  const ctx = await setup({
    config: { api_key: MAIN_KEY, allow_pause_resume: true },
    devices: [withButtons(SITE)],
  });
  const device = withButtons(SITE);
  ctx.api.failures.push({ method: 'editMonitor', error: CODES.TIMEOUT, sent: true });
  const late = await ctx.gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.match(late.error, /was sent but UptimeRobot did not confirm/);
  ctx.api.failures.push({ method: 'editMonitor', error: CODES.UNREACHABLE });
  const never = await ctx.gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.match(never.error, /nothing was sent/);
});

test('a 429 on a command pauses every path', async () => {
  const ctx = await setup({
    config: { api_key: MAIN_KEY, allow_pause_resume: true },
    devices: [withButtons(SITE)],
  });
  const device = withButtons(SITE);
  ctx.api.failures.push({ method: 'editMonitor', status: 429 });
  const ack = await ctx.gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.match(ack.error, /refused the command \(HTTP 429, too many requests\): not done/);
  assert.doesNotMatch(ack.error, /nothing was sent/);
  // The status follows without holding the ack.
  for (let i = 0; i < 5; i += 1) {
    await ctx.app.store.settled();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /HTTP 429/);
  const next = await ctx.gladys.fake.setValue(device, feature(device, 'pause'), 1);
  assert.match(next.error, /slow down/);
  assert.equal(ctx.api.requests.filter((r) => r.method === 'editMonitor').length, 1);
});

test('states beyond the minute budget wait a minute, then go', async () => {
  const api = createFakeUptimeRobot();
  api.monitors = Array.from({ length: 60 }, (_, i) => monitor(3000 + i));
  const devices = api.monitors.map((m) => buildMonitorDevice(ids, parseMonitor(m)));
  const ctx = await setup({ api, devices });
  // 6 states per monitor: 41 monitors fit in 250, the rest waits.
  assert.equal(state(ctx.gladys, devices[59], 'status'), undefined);
  assert.ok(ctx.timers.delays().includes(INTERVALS.STATES_RETRY_MS));
  ctx.clock.now += INTERVALS.STATES_RETRY_MS;
  await ctx.timers.run((ms) => ms === INTERVALS.STATES_RETRY_MS);
  assert.equal(state(ctx.gladys, devices[59], 'status'), 'up');
  assert.equal(reads(api).length, 2, 'two pages, no extra request');
});

test('the scan button republishes what the last reading knows, no request', async () => {
  const { gladys, api } = await setup();
  await gladys.fake.scanRequest();
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  assert.equal(api.requests.length, 1);
});

test('the test button answers with the count', async () => {
  const { gladys } = await setup();
  const ack = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(ack.success, true);
  assert.deepEqual(ack.data, {
    message: { en: 'Connected: 2 monitors.', fr: 'Connecté : 2 moniteurs.' },
  });
});
