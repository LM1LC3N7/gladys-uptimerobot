// -----------------------------------------------------------------------------
// Non-regression tests of the review of milestone 1 (B1, I1-I3, M1-M9), in
// virtual time, from the reviewer's scenarios (S1-S9).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { UptimeRobotApp } from '../src/app.js';
import { STORE_FILE } from '../src/constants.js';
import { buildMonitorDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { T } from '../src/i18n.js';
import { parseMonitor } from '../src/uptimerobot/parse.js';
import { API_KEY, MAIN_KEY, createFakeUptimeRobot, monitor } from './helpers/fakeUptimeRobot.js';
import { flush, virtualTimers } from './helpers/virtualTimers.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');
const SELECTOR = 'uptimerobot';
const ids = createFakeGladys({ selector: SELECTOR });
const INTERVAL = 300_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const device = (id, withButtons = true) =>
  buildMonitorDevice(ids, parseMonitor(monitor(id)), { withButtons });

let apps = [];
afterEach(async () => {
  for (const app of apps) await app.stop();
  apps = [];
});

async function setup({ config = {}, devices, request, fake, dataDir, clock } = {}) {
  clock ??= { now: T0 };
  fake ??= createFakeUptimeRobot();
  dataDir ??= mkdtempSync(join(tmpdir(), 'ur-review-'));
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { api_key: API_KEY, ...config },
    devices: devices ?? [device(101), device(102)],
  });
  const timers = virtualTimers(clock);
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(`${l} ${a.join(' ')}`)]),
  );
  const app = new UptimeRobotApp({
    gladys,
    logger,
    request: request ? request(fake, clock) : fake.request,
    dataDir,
    now: () => clock.now,
    timers,
  });
  apps.push(app);
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await flush();
  return { gladys, fake, clock, timers, app, logs, dataDir };
}

const reads = (fake) => fake.requests.filter((r) => r.method === 'getMonitors');
const pauseButton = (gladys, i = 0) =>
  gladys.devices[i].features.find((f) => f.external_id.endsWith(':pause'));
const resumeButton = (gladys, i = 0) =>
  gladys.devices[i].features.find((f) => f.external_id.endsWith(':resume'));
const ALLOW = { api_key: MAIN_KEY, allow_pause_resume: true };

test('B1 (S1): a reading and a command failing together leave one reading chain', async () => {
  let gate = null;
  const request = (fake) => async (url, options) => {
    const method = new URL(url).pathname.replace('/v2/', '');
    if (fake.mode429) {
      options.onSent?.();
      if (method === 'getMonitors' && gate) await gate;
      fake.requests.push({ method });
      return { status: 429, headers: {}, body: Buffer.from('{}') };
    }
    return fake.request(url, options);
  };
  const env = await setup({ config: ALLOW, request });
  const { gladys, fake, timers, app } = env;
  // A slow Gladys: an await inside failed() takes a while.
  const post = gladys.httpClient.post;
  gladys.httpClient.post = async (path, body) => {
    if (path === '/device/transport') await sleep(20);
    return post(path, body);
  };
  fake.mode429 = true;
  let release;
  gate = new Promise((resolve) => (release = resolve));
  await timers.advance(INTERVAL); // the loop reading hangs on the gate
  const cmd = gladys.fake.setValue(gladys.devices[0], pauseButton(gladys), 1);
  await sleep(5);
  release(); // the reading answers 429 too, while the command's failed() awaits Gladys
  await sleep(100);
  await cmd;
  gate = null;
  fake.mode429 = false;
  // Gladys answers at once again (its real-time sleeps would outlast virtual time).
  gladys.httpClient.post = post;
  assert.notEqual(app.loopHandle, null);
  assert.equal(timers.pending.size, 1, 'one timer after the two failures');
  const before = reads(fake).length;
  await timers.advance(2 * 3600_000, 5000);
  const count = reads(fake).length - before;
  assert.ok(count >= 20 && count <= 25, `one chain at 5 min: ~24 readings in 2 h, got ${count}`);
});

test('B1: two failed() at once plan one timer only', async () => {
  const { app } = await setup();
  const err = Object.assign(new Error('HTTP 503'), { code: 'http', status: 503 });
  const a = app.failed(err, app.generation);
  const b = app.failed(err, app.generation);
  await Promise.all([a, b]);
  const loops = [...app.handles].filter((h) => h === app.loopHandle);
  assert.equal(loops.length, 1);
  assert.equal(app.handles.size, 1, 'nothing else planned');
});

test('I1 (S2): the ack of a Pause never waits for POST /state', async () => {
  const { gladys, fake } = await setup({ config: ALLOW });
  const post = gladys.httpClient.post;
  let releaseState;
  const stateGate = new Promise((resolve) => (releaseState = resolve));
  gladys.httpClient.post = async (path, body) => {
    if (path === '/state') await stateGate;
    return post(path, body);
  };
  let settled = false;
  const ack = gladys.fake.setValue(gladys.devices[0], pauseButton(gladys), 1).then((a) => {
    settled = a;
  });
  await sleep(100);
  assert.equal(fake.edits.length, 1);
  assert.equal(settled?.success, true, 'acked while /state hangs');
  releaseState();
  await ack;
});

test('I2 (S3): HTTP 503 on editMonitor pauses like a reading, persisted, "not confirmed"', async () => {
  const { gladys, fake, app, clock, dataDir } = await setup({ config: ALLOW });
  fake.failures.push({ method: 'editMonitor', status: 503, headers: { 'retry-after': '600' } });
  const ack = await gladys.fake.setValue(gladys.devices[0], pauseButton(gladys), 1);
  assert.match(ack.error, /was sent but UptimeRobot did not confirm it/);
  assert.equal(app.pausedUntil, clock.now + 600_000);
  await flush();
  await app.store.settled();
  const stored = JSON.parse(readFileSync(join(dataDir, STORE_FILE), 'utf8'));
  assert.equal(Number(stored.meta.pausedUntil), clock.now + 600_000);
  assert.equal(stored.meta.pauseReason, 'server:503');
});

test('I3 (S4): a reconnection every 4 min never pushes the reading back', async () => {
  const { gladys, fake, timers } = await setup();
  const before = reads(fake).length;
  for (let i = 0; i < 10; i += 1) {
    await timers.advance(240_000, 5000);
    await gladys.connect();
    await flush();
  }
  assert.equal(reads(fake).length - before, 8, 'one reading every 5 min over 40 min');
});

test('M1 (S5): the budget spent between two pages: wait a minute, still online', async () => {
  const fake = createFakeUptimeRobot();
  fake.monitors = Array.from({ length: 200 }, (_, i) => monitor(1000 + i));
  let gate = null;
  const request = (f) => async (url, options) => {
    if (gate && options.body.includes('offset=0&')) {
      const g = gate;
      gate = null;
      await g;
    }
    return f.request(url, options);
  };
  const { gladys, timers, app, clock } = await setup({
    fake,
    devices: [device(1000)],
    config: ALLOW,
    request,
  });
  await timers.advance(290_000);
  for (let i = 0; i < 4; i += 1) {
    const button = i % 2 ? resumeButton(gladys) : pauseButton(gladys);
    await gladys.fake.setValue(gladys.devices[0], button, 1);
  }
  let release;
  gate = new Promise((resolve) => (release = resolve));
  await timers.advance(10_000); // the loop at 5 min: 4 requests left, page 1 hangs
  await gladys.fake.setValue(gladys.devices[0], pauseButton(gladys), 1);
  release();
  await flush();
  assert.equal(app.online, true, 'not shown offline');
  assert.equal(app.retryDelay, 0, 'no back-off');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /does not answer/);
  assert.equal(app.nextRunAt - clock.now, 60_000);
});

test('M2 (S7): no room in the budget: a status of its own, a message of its own for the button', async () => {
  const { gladys, app } = await setup();
  const answers = [];
  for (let i = 0; i < 5; i += 1) answers.push(await gladys.fake.action('test_connection', {}));
  assert.ok(answers.slice(0, 4).every((a) => a.success));
  assert.equal(answers[4].success, false);
  assert.equal(answers[4].error, T.errors.testBudget);
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: false,
    message: T.status.waitingBudget,
  });
  assert.equal(app.online, false);
});

test('M4 (S6): a key pasted in "Monitors" never reaches the status nor the logs', async () => {
  const { gladys, fake, logs } = await setup({ config: { monitors: MAIN_KEY } });
  const shown = JSON.stringify([gladys.fake.connectionStatuses, logs]);
  for (const piece of MAIN_KEY.split('-')) assert.ok(!shown.includes(piece), piece);
  assert.match(gladys.fake.connectionStatus.message.en, /2 entries that are not/);
  assert.equal(fake.requests.length, 0);
});

test('M5: a restart keeps the planned reading time (bounded), unless forced', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ur-review-'));
  const fake = createFakeUptimeRobot();
  const first = await setup({ fake, dataDir });
  await first.app.stop();
  await first.app.store.settled();
  const clock = { now: T0 + 60_000 };
  const again = await setup({ fake, dataDir, clock });
  assert.equal(reads(fake).length, 1, 'no reading at the restart');
  assert.equal(again.app.nextRunAt, T0 + INTERVAL);
  assert.match(again.gladys.fake.connectionStatus.message.en, /Reading in 4 min/);
  await again.timers.advance(INTERVAL - 60_000);
  assert.equal(reads(fake).length, 2, 'read at the planned time');
  const ack = await again.gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(reads(fake).length, 3, 'the button reads at once');
});

test('M6: the reason of a pause is kept across a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ur-review-'));
  const fake = createFakeUptimeRobot();
  const first = await setup({ fake, dataDir });
  fake.failures.push({ status: 503, headers: { 'retry-after': '1200' } });
  await first.timers.advance(INTERVAL);
  await first.app.stop();
  await first.app.store.settled();
  const again = await setup({ fake, dataDir, clock: { now: first.clock.now + 60_000 } });
  assert.match(again.gladys.fake.connectionStatus.message.en, /server error \(HTTP 503\)/);
  assert.equal(reads(fake).length, 2);
});

test('M7: the docs quote the texts Gladys really shows', () => {
  // Line breaks of the Markdown do not count.
  const read = (lang) =>
    readFileSync(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const en = read('en');
  const fr = read('fr');
  const unconfirmed = 'The command was sent but UptimeRobot did not confirm it';
  assert.ok(T.errors.unconfirmed({}).startsWith(unconfirmed));
  for (const doc of [en, fr]) {
    assert.ok(doc.includes(unconfirmed), unconfirmed);
    assert.ok(doc.includes('Pause monitoring') && doc.includes('Resume monitoring'));
  }
  assert.ok(en.includes('Test the connection') && fr.includes('Tester la connexion'));
  assert.ok(fr.includes('Moniteur hors ligne') && fr.includes('Moniteur rétabli'));
  assert.ok(en.includes('Monitor down') && en.includes('Monitor back up'));
});

test('M8: a reading begun before a command never overwrites what the command did', async () => {
  let gate = null;
  const request = (f) => async (url, options) => {
    const answer = await f.request(url, options);
    if (gate && url.endsWith('getMonitors')) await gate;
    return answer;
  };
  const { gladys, timers, app } = await setup({ config: ALLOW, request });
  let release;
  gate = new Promise((resolve) => (release = resolve));
  await timers.advance(INTERVAL); // answered "up", held
  const ack = await gladys.fake.setValue(gladys.devices[0], pauseButton(gladys), 1);
  assert.equal(ack.success, true);
  gate = null;
  release();
  await flush();
  const statusId = `${gladys.devices[0].external_id}:status`;
  assert.equal(gladys.fake.lastState(statusId), 'paused');
  assert.equal(app.monitors.get('101').status, 0);
  await timers.advance(INTERVAL);
  assert.equal(gladys.fake.lastState(statusId), 'paused', 'the next reading shows the truth');
});

test('M9: HTTP 404 / 410 on the API v2: a clear status', async () => {
  const { gladys, fake, timers } = await setup();
  fake.failures.push({ status: 410 });
  await timers.advance(INTERVAL);
  assert.match(gladys.fake.connectionStatus.message.en, /API v2: it may have been retired/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Mettez à jour l’intégration/);
});

test('S8: hostile answers never leak the key, never pollute', async () => {
  const request = (f) => async (url, options) => {
    options.onSent?.();
    f.requests.push({ method: 'getMonitors' });
    return {
      status: 200,
      headers: {},
      body: Buffer.from(
        `{"stat":"fail","error":{"type":"invalid_parameter","parameter_name":"api_key","passed_value":"${API_KEY}","message":"bad ${API_KEY}"},"__proto__":{"polluted":1}}`,
      ),
    };
  };
  const { gladys, logs } = await setup({ request });
  const all = JSON.stringify([gladys.fake.requests, gladys.fake.wsMessages, logs]);
  assert.ok(!all.includes(API_KEY));
  assert.equal({}.polluted, undefined);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the API key/);
});

test('S9: down, then paused, then up: only "monitor down"', async () => {
  const { gladys, fake, timers } = await setup({ config: ALLOW });
  const events = () => gladys.fake.sceneEvents.map((e) => e.key);
  fake.monitors[0].status = 9;
  await timers.advance(INTERVAL);
  assert.deepEqual(events(), ['monitor_down']);
  fake.monitors[0].status = 0;
  await timers.advance(INTERVAL);
  fake.monitors[0].status = 2;
  await timers.advance(INTERVAL);
  assert.deepEqual(events(), ['monitor_down']);
});
