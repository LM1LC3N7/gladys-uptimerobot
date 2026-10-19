// -----------------------------------------------------------------------------
// UptimeRobotApp: the integration. One UptimeRobot account (API key), its
// monitors.
//
//   start(config)  (re)connects: monitors read, Discovery published, loop started
//   reading loop   every `refresh_interval` (5 min by default): getMonitors,
//                  one request per 50 monitors, 200 monitors at most
//   scene events   "monitor down" / "monitor up" on a confirmed transition
//                  between two close readings (never on the first reading,
//                  nor after a long gap)
//   setValue       the Pause / Resume buttons, off by default
//
// The loop is ONE timer (plan() replaces it, synchronously): two paths
// failing together never leave two chains; halt() bumps an epoch, and a run
// of an older epoch never plans again. The next reading time is kept across
// a reconnection and, bounded, across a restart. An API key UptimeRobot refused is
// final: the loop stops and the status says what to fix; nothing is sent
// again until the configuration is saved or "Test the connection" is pressed.
// A failure is never read again faster than the interval; HTTP 429 and 5xx
// pauses are kept in /data (a restart waits too). Every request, commands
// included, is counted in one budget of 8 per minute (free plan: 10).
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  API_STATUS,
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  FEATURES,
  INTERVALS,
  LIMITS,
  MAX_GAP_INTERVALS,
  RESPONSE_TIME_MAX_AGE_MS,
  SCENE_TRIGGERS,
  STATUS_TEXT,
  STORE_FILE,
} from './constants.js';
import {
  buildMonitorDevice,
  createdMonitors,
  featureKeysOf,
  monitorIds,
  parseExternalId,
} from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { UptimeRobotClient } from './uptimerobot/client.js';
import { CODES, isApiGone, isBusy, isKeyRefused, isServerError } from './uptimerobot/errors.js';
import { httpRequest } from './uptimerobot/http.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;
const MINUTE = 60_000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** The confirmed state of a monitor for the scene triggers: 'up', 'down', or null (none). */
function confirmedOf(status, previous) {
  if (status === API_STATUS.UP) return 'up';
  if (status === API_STATUS.DOWN) return 'down';
  // "Seems down" is not confirmed yet: the reference stays what it was.
  if (status === API_STATUS.SEEMS_DOWN) return previous ?? null;
  // Paused, not checked yet, unknown: no reference (a resume fires nothing).
  return null;
}

export class UptimeRobotApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake UptimeRobot)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'uptimerobot' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now });
    /** Requests to UptimeRobot in the last minute, every path and every client. */
    this.limiter = new Budget({ perMinute: LIMITS.REQUESTS_PER_MINUTE, now });
    this.rawConfig = null;
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    /** The timers of the loop (cleared by halt()). */
    this.handles = new Set();
    this.flushHandle = null;
    /** The one timer of the reading chain (see plan()). */
    this.loopHandle = null;
    this.queue = Promise.resolve();
    /** One chain of commands per monitor. */
    this.chains = new Map();
    /** The status the integration wants Gladys to show: [connected, message]. */
    this.wantedStatus = null;
    this.lastStatus = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    /** Why: 'busy' (429) or 'server:<status>' (5xx), kept in /data with the end. */
    this.pauseReason = null;
    this.retryDelay = 0;
    /** When the reading chain runs next (0: nothing planned). */
    this.nextRunAt = 0;
    /** The last run found no room in the request budget. */
    this.waitingBudget = false;
    /** id -> bumped by every command that changed the state shown (see readAll). */
    this.commandVersions = new Map();
    /** id -> monitor (src/uptimerobot/parse.js) of the last reading. */
    this.monitors = new Map();
    /** Ids of the configuration absent from the account. */
    this.missing = [];
    /** Monitors left out by the cap of LIMITS.MONITORS. */
    this.leftOut = 0;
    /** id -> 'up' | 'down': the reference of the scene triggers. */
    this.confirmed = new Map();
    /** When the last reading succeeded (0: none yet). */
    this.lastReadAt = 0;
    this.clearCaches();
  }

  /** What only mirrors Gladys (lost when the core restarts): emptied on every `connected`. */
  clearCaches() {
    this.lastStatus = null;
    this.discoveredKey = null;
    this.transports = new Map();
    /** feature external id -> value last accepted by Gladys (to budget only changes). */
    this.published = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * A new configuration arrives: until its start runs, pause and resume are
   * allowed only if BOTH the old and the new configuration allow them, and
   * the commands already accepted are refused before sending.
   */
  tighten(rawConfig) {
    const next = normalizeConfig(rawConfig);
    const allow = this.config.allowPauseResume && next.allowPauseResume;
    if (allow !== this.config.allowPauseResume) {
      this.config = { ...this.config, allowPauseResume: allow };
      this.generation += 1;
    }
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration): a key refused earlier is tried, a
   * pause is lifted.
   */
  start(rawConfig, { force = false } = {}) {
    this.tighten(rawConfig);
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  /**
   * Gladys is back (the `connected` event): the same configuration keeps the
   * client, the pause, the refusal and the references of the triggers; what
   * mirrors Gladys (status, Discovery, states) is sent again.
   */
  reconnected(rawConfig) {
    this.tighten(rawConfig);
    return this.enqueue(async () => {
      const same =
        this.rawConfig !== null &&
        JSON.stringify(rawConfig ?? {}) === JSON.stringify(this.rawConfig);
      if (!same) {
        await this.run(rawConfig, { force: false });
        return;
      }
      this.config = normalizeConfig(rawConfig);
      this.clearCaches();
      if (this.wantedStatus) await this.setStatus(...this.wantedStatus);
      if (this.monitors.size > 0) await this.publishDiscovered();
      if (this.online) await this.publishAllStates();
      await this.publishTransports();
      await this.resume();
    });
  }

  /**
   * The timers of the loop stopped (a reconnection): start them again AS
   * PLANNED. The next reading keeps its time (a reconnection every 4 min
   * never starves a 5 min loop).
   */
  async resume() {
    this.halt();
    if (this.blocked || !this.client) return;
    if (this.paused()) {
      this.plan(this.pausedUntil - this.now());
    } else if (this.nextRunAt > 0) {
      this.plan(Math.max(0, this.nextRunAt - this.now()));
    } else {
      // Nothing planned yet (a first reading cut short): read at once.
      await this.tick(this.generation);
    }
  }

  /** The value a refusal is about (HMAC with the salt of /data: never the key). */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(config.apiKey)
      .digest('hex');
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer of the loop; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
    this.flushHandle = null;
    this.loopHandle = null;
  }

  /**
   * The ONE timer of the reading chain: any earlier one is replaced, so two
   * paths (a reading and a command failing together) can never leave two
   * chains. Synchronous. The time is kept (resume()) and persisted, bounded,
   * for a restart (run()).
   */
  plan(delay) {
    const generation = this.generation;
    if (this.loopHandle !== null) {
      this.timers.clearTimeout(this.loopHandle);
      this.handles.delete(this.loopHandle);
    }
    const wait = Math.max(0, delay);
    this.nextRunAt = this.now() + wait;
    const handle = this.schedule(wait, () => {
      if (this.loopHandle === handle) this.loopHandle = null;
      return this.tick(generation);
    });
    this.loopHandle = handle;
    this.store.set('meta', 'nextReadAt', String(this.nextRunAt)).catch(() => {});
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  async run(rawConfig, { force = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    await this.store.load();

    if (!config.apiKey) {
      await this.setStatus(false, T.status.missingKey);
      return;
    }
    if (config.apiKeyInvalid) {
      await this.setStatus(false, T.status.keyInvalid);
      return;
    }
    if (config.filter?.invalid > 0) {
      await this.setStatus(false, T.status.monitorsInvalid(config.filter.invalid));
      return;
    }
    if (config.filter?.tooMany) {
      await this.setStatus(false, T.status.tooManyIds);
      return;
    }
    // A key UptimeRobot refused is not tried again alone.
    const refused = this.store.get('refusals', 'key');
    if (refused && refused === (await this.refusalKey(config)) && !force) {
      this.blocked = true;
      this.logger.warn('API key refused earlier: not tried again');
      await this.setStatus(false, T.status.keyRefused);
      return;
    }
    if (refused) await this.store.set('refusals', 'key', null);
    this.client = new UptimeRobotClient({
      apiKey: config.apiKey,
      limiter: this.limiter,
      request: this.request,
      now: this.now,
    });
    // A pause asked by UptimeRobot outlives a restart and a reconnection to
    // Gladys; only the user lifts it (button, saved configuration). The end
    // read back is capped (a clock or a file gone wrong never blocks for long).
    const stored = Number(this.store.get('meta', 'pausedUntil')) || 0;
    const pausedUntil = Math.min(stored, this.now() + INTERVALS.BUSY_MAX_MS);
    if (force && stored) {
      await this.store.set('meta', 'pausedUntil', null);
      await this.store.set('meta', 'pauseReason', null);
    }
    if (!force && this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      this.pauseReason = this.store.get('meta', 'pauseReason');
      const delay = pausedUntil - this.now();
      await this.setStatus(false, this.pauseMessage(delay));
      this.plan(delay);
      return;
    }
    // A restart (or a crash loop) never reads sooner than planned: the next
    // reading time is kept in /data, capped at one interval from now.
    const nextReadAt = Math.min(
      Number(this.store.get('meta', 'nextReadAt')) || 0,
      this.now() + config.intervalMs,
    );
    if (!force && nextReadAt > this.now()) {
      const delay = nextReadAt - this.now();
      await this.setStatus(false, T.status.restartWait(delay));
      this.plan(delay);
      return;
    }
    await this.tick(generation);
  }

  /** The status of a pause, by its reason (kept in /data with it). */
  pauseMessage(delay) {
    const server = /^server:(\d{3})$/.exec(this.pauseReason ?? '');
    return server ? T.status.serverError(Number(server[1]), delay) : T.status.busy(delay);
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /**
   * One run of the reading chain: a reading, then the next one planned.
   * Never throws. A failure seen by a run whose epoch moved (another path
   * already failed and planned) only records its pause.
   */
  async tick(generation) {
    if (!this.client || generation !== this.generation || this.blocked) return;
    if (this.paused()) {
      // A timer may fire a little early, or a longer pause came meanwhile.
      this.plan(Math.max(1_000, this.pausedUntil - this.now()));
      return;
    }
    if (!this.roomForReading()) {
      // The buttons spent the request budget of the minute: wait for it.
      this.waitingBudget = true;
      this.plan(MINUTE);
      if (!this.online) await this.setStatus(false, T.status.waitingBudget);
      return;
    }
    this.waitingBudget = false;
    const epoch = this.epoch;
    const wasOnline = this.online;
    let applied;
    try {
      applied = await this.readAll({ publish: !wasOnline });
    } catch (err) {
      if (epoch !== this.epoch || generation !== this.generation) {
        await this.notePause(err, this.delayFor(err));
        return;
      }
      if (err.code === CODES.LIMITED) {
        // The budget ran out between two pages (a button meanwhile): not a
        // failure of UptimeRobot, the reading waits a minute.
        this.waitingBudget = true;
        this.plan(MINUTE);
        if (!this.online) await this.setStatus(false, T.status.waitingBudget);
        return;
      }
      await this.failed(err, generation);
      return;
    }
    // Not applied: a pause, a new configuration or a halt came meanwhile,
    // and whoever did it planned what follows.
    if (!applied || !this.current(generation, epoch)) return;
    if (!wasOnline) this.logger.info(`UptimeRobot answers: ${this.monitors.size} monitor(s)`);
    this.plan(this.config.intervalMs);
  }

  roomForReading() {
    const ids = this.config.filter?.ids;
    return this.limiter.remaining() >= UptimeRobotClient.pagesFor(ids);
  }

  /** The wait after a failure: never shorter than the interval. */
  delayFor(err) {
    const interval = this.config.intervalMs;
    if (isBusy(err)) {
      // Too many requests: a bounded pause of every path (loop, commands).
      return Math.max(
        interval,
        clamp(
          err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
          INTERVALS.BUSY_MIN_MS,
          INTERVALS.BUSY_MAX_MS,
        ),
      );
    }
    const delay = Math.max(interval, this.retryDelay);
    if (isServerError(err) && err.retryAfterMs) {
      return clamp(err.retryAfterMs, delay, INTERVALS.BUSY_MAX_MS);
    }
    return delay;
  }

  /**
   * HTTP 429 or 5xx: the pause of every path, set SYNCHRONOUSLY (a command
   * or a reading starting right after sees it), then kept in /data with its
   * reason. A pause holds whatever the generation (a new configuration does
   * not make UptimeRobot less busy).
   */
  notePause(err, delay) {
    if (!isBusy(err) && !isServerError(err)) return Promise.resolve();
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
    this.pauseReason = isBusy(err) ? 'busy' : `server:${err.status}`;
    return Promise.all([
      this.store.set('meta', 'pausedUntil', String(this.pausedUntil)),
      this.store.set('meta', 'pauseReason', this.pauseReason),
    ]);
  }

  /**
   * A request failed: final refusal, or retry (never faster than the
   * interval). Everything that decides the next run happens BEFORE the
   * first await: two failures at once leave one chain (plan() replaces).
   */
  async failed(err, generation) {
    const interval = this.config.intervalMs;
    const delay = this.delayFor(err);
    const pausing = this.notePause(err, delay);
    if (generation !== this.generation) {
      await pausing;
      return;
    }
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    const refused = isKeyRefused(err);
    if (refused) {
      this.blocked = true;
    } else {
      if (!isBusy(err)) {
        this.retryDelay = Math.min(delay * 2, Math.max(interval, INTERVALS.RETRY_MAX_MS));
      }
      this.plan(delay);
    }
    await pausing;
    await this.publishTransports();
    if (refused) {
      await this.store.set('refusals', 'key', await this.refusalKey(this.config));
      this.logger.warn(
        `API key refused by UptimeRobot (${err.message}): not retried until changed`,
      );
      await this.setStatus(false, T.status.keyRefused);
      return;
    }
    if (wasOnline || delay === interval) {
      this.logger.warn(`UptimeRobot fails: ${err.message}`);
    }
    await this.setStatus(false, this.errorMessage(err, delay));
  }

  errorMessage(err, delay) {
    if (isBusy(err)) return T.status.busy(delay);
    if (isServerError(err)) return T.status.serverError(err.status, delay);
    if (isApiGone(err)) return T.status.apiGone(err.status, delay);
    return T.status.unreachable(err, delay);
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  /**
   * The status wanted is kept apart from the mark of what Gladys received:
   * a reconnection sends the wanted one again.
   */
  async setStatus(connected, message) {
    this.wantedStatus = [connected, message];
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading ---------------------------------------------------------------

  /**
   * Read the monitors. Throws when a request fails. Resolves false, applying
   * nothing, when a pause, a new configuration or a halt came meanwhile.
   */
  async readAll({ publish }) {
    const client = this.client;
    const generation = this.generation;
    const epoch = this.epoch;
    const stale = () =>
      this.paused() ||
      client !== this.client ||
      generation !== this.generation ||
      epoch !== this.epoch;
    if (!client || stale()) return false;
    const filter = this.config.filter;
    const versions = new Map(this.commandVersions);
    const { monitors, total } = await client.monitors({ ids: filter?.ids });
    if (stale()) return false;
    const now = this.now();

    // A command answered while this reading was in flight: its state (paused,
    // not checked) stays until the next reading, never overwritten by an
    // answer older than the command.
    const crossed = (m) => (this.commandVersions.get(m.id) ?? 0) !== (versions.get(m.id) ?? 0);
    const fresh = monitors.map((m) =>
      crossed(m) && this.monitors.has(m.id) ? { ...m, status: this.monitors.get(m.id).status } : m,
    );
    // The cap keeps the monitors already created first.
    const created = new Set(createdMonitors(this.gladys).map((c) => c.monitorId));
    const followed = [
      ...fresh.filter((m) => created.has(m.id)),
      ...fresh.filter((m) => !created.has(m.id)),
    ].slice(0, LIMITS.MONITORS);
    const events = this.transitions(followed, now);

    this.monitors = new Map(followed.map((m) => [m.id, m]));
    this.missing = filter ? filter.ids.filter((id) => !this.monitors.has(id)).slice(0, 10) : [];
    this.leftOut = filter ? 0 : Math.max(0, total - followed.length);
    this.lastReadAt = now;
    this.online = true;
    this.retryDelay = 0;

    const discoveredKey = JSON.stringify([
      this.config.allowPauseResume,
      followed.map((m) => [m.id, m.name, m.typeLabel, m.target]),
    ]);
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishAllStates();
    await this.publishTransports();
    for (const event of events.slice(0, LIMITS.EVENTS_PER_ROUND)) await this.fire(event);
    if (events.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.warn(`${events.length - LIMITS.EVENTS_PER_ROUND} monitor event(s) not sent`);
    }
    await this.setStatus(true, this.okMessage());
    return true;
  }

  /**
   * The confirmed transitions since the previous reading, and the new
   * references. Nothing fires on the first reading, for a new monitor, nor
   * when the previous reading is too old (outage, pause, restart).
   */
  transitions(monitors, now) {
    const maxGap = MAX_GAP_INTERVALS * this.config.intervalMs + MINUTE;
    const close = this.lastReadAt > 0 && now - this.lastReadAt <= maxGap;
    const events = [];
    const next = new Map();
    for (const monitor of monitors) {
      const previous = this.confirmed.get(monitor.id) ?? null;
      const state = confirmedOf(monitor.status, previous);
      if (close && previous && state && previous !== state) {
        events.push({ monitor, down: state === 'down' });
      }
      if (state) next.set(monitor.id, state);
    }
    this.confirmed = next;
    return events;
  }

  async fire({ monitor, down }) {
    await this.gladys
      .publishSceneEvent(down ? SCENE_TRIGGERS.DOWN : SCENE_TRIGGERS.UP, {
        monitor: monitorIds(this.gladys, monitor.id).device,
        monitor_name: monitor.name,
        monitor_type: monitor.typeLabel ?? '',
      })
      .catch((err) => {
        this.logger.warn(`Scene event not sent: ${err.message}`);
      });
  }

  okMessage() {
    if (this.monitors.size === 0) return T.status.noMonitor;
    let up = 0;
    let down = 0;
    let paused = 0;
    for (const monitor of this.monitors.values()) {
      if (monitor.status === API_STATUS.UP) up += 1;
      else if (monitor.status === API_STATUS.DOWN || monitor.status === API_STATUS.SEEMS_DOWN)
        down += 1;
      else if (monitor.status === API_STATUS.PAUSED) paused += 1;
    }
    return T.status.ok({
      monitors: this.monitors.size,
      up,
      down,
      paused,
      missing: this.missing,
      leftOut: this.leftOut,
    });
  }

  /** Never throws: a refusal of Gladys is not an UptimeRobot failure. */
  async publishDiscovered() {
    const created = new Map(createdMonitors(this.gladys).map((c) => [c.monitorId, c.device]));
    const devices = [...this.monitors.values()].map((monitor) =>
      buildMonitorDevice(this.gladys, monitor, {
        withButtons: this.config.allowPauseResume,
        created: created.get(monitor.id),
      }),
    );
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): what the last reading knows (no extra request). */
  async publishDiscovery() {
    if (this.monitors.size > 0) await this.publishDiscovered();
  }

  /** The states of a created monitor device, from the last reading. */
  statesOf(created) {
    const monitor = this.monitors.get(created.monitorId);
    if (!monitor) return [];
    const ids = monitorIds(this.gladys, monitor.id);
    const has = new Set(featureKeysOf(created.device));
    const states = [];
    const push = (key, value) => {
      if (!has.has(key)) return;
      const id = ids.feature(key);
      states.push(
        typeof value === 'string'
          ? { device_feature_external_id: id, text: value }
          : { device_feature_external_id: id, state: value },
      );
    };
    if (monitor.status !== null) push(FEATURES.STATUS, STATUS_TEXT[monitor.status]);
    if (monitor.status === API_STATUS.UP) push(FEATURES.ONLINE, 1);
    if (monitor.status === API_STATUS.DOWN) push(FEATURES.ONLINE, 0);
    const rt = monitor.responseTime;
    if (
      rt &&
      monitor.status !== API_STATUS.PAUSED &&
      Math.abs(this.now() - rt.at) <= RESPONSE_TIME_MAX_AGE_MS
    ) {
      push(FEATURES.RESPONSE_TIME, rt.ms);
    }
    if (monitor.uptime24h !== null) push(FEATURES.UPTIME_24H, monitor.uptime24h);
    if (monitor.uptime7d !== null) push(FEATURES.UPTIME_7D, monitor.uptime7d);
    if (monitor.uptime30d !== null) push(FEATURES.UPTIME_30D, monitor.uptime30d);
    return states;
  }

  /** Publish the states that changed, within the minute budget; the rest a minute later. */
  async publishAllStates() {
    let held = false;
    for (const created of createdMonitors(this.gladys)) {
      if (!(await this.publishStates(this.statesOf(created)))) held = true;
    }
    if (held && !this.flushHandle) {
      const generation = this.generation;
      this.flushHandle = this.schedule(INTERVALS.STATES_RETRY_MS, async () => {
        this.flushHandle = null;
        if (generation === this.generation && this.online) await this.publishAllStates();
      });
    }
  }

  /** Resolves false when the states were held back by the budget. */
  async publishStates(states) {
    const valueOf = (s) => (s.text === undefined ? s.state : s.text);
    const list = states.filter(
      (s) => this.published.get(s.device_feature_external_id) !== valueOf(s),
    );
    if (list.length === 0) return true;
    if (list.length > this.budget.remaining()) {
      this.logger.debug(`${list.length} state(s) held back a minute (state budget)`);
      return false;
    }
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
      for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
    return true;
  }

  async publishTransports() {
    const entries = createdMonitors(this.gladys).map(({ monitorId, externalId }) => ({
      external_id: externalId,
      transport: this.online && this.monitors.has(monitorId) ? 'cloud' : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    for (const entry of changed) this.transports.set(entry.external_id, entry.transport);
    for (let i = 0; i < changed.length; i += 100) {
      const batch = changed.slice(i, i + 100);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Commands --------------------------------------------------------------
  //
  // Two push buttons per monitor, "Pause monitoring" and "Resume monitoring"
  // (never a switch). Refused unless `allow_pause_resume` is on, checked when
  // the command arrives AND just before it is sent; a new configuration
  // narrows it at once (tighten()). Chained per monitor; each command counts
  // in the request budget of the minute and holds while UptimeRobot asks to
  // slow down. Gladys waits 5 s: past 3.5 s after the command arrived,
  // nothing is sent any more. A command that may have left is never said
  // "not sent". Pausing an already paused monitor is harmless (idempotent).

  async setValue(_device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed?.feature) throw new Error(T.errors.unknownDevice);
    if (parsed.feature !== FEATURES.PAUSE && parsed.feature !== FEATURES.RESUME) {
      const known = Object.values(FEATURES).includes(parsed.feature);
      throw new Error(known ? T.errors.readOnly : T.errors.unknownDevice);
    }
    // A push button sends 1: anything else (null, '', 0, '1') is refused.
    if (value !== 1) throw new Error(T.errors.invalidValue);
    if (!this.config.allowPauseResume) throw new Error(T.errors.commandsDisabled);
    const monitorId = parsed.monitorId;
    if (!this.monitors.has(monitorId)) throw new Error(T.errors.unknownMonitor);
    const client = this.client;
    if (!client || this.blocked) throw new Error(T.errors.notConnected);
    if (this.paused()) throw new Error(T.errors.busy);
    const generation = this.generation;
    const pause = parsed.feature === FEATURES.PAUSE;

    const previous = this.chains.get(monitorId) ?? Promise.resolve();
    const run = previous.then(() =>
      this.command(received, { client, generation, monitorId, pause }),
    );
    const chain = run.catch(() => {});
    this.chains.set(monitorId, chain);
    chain.then(() => {
      if (this.chains.get(monitorId) === chain) this.chains.delete(monitorId);
    });
    return run;
  }

  /** The client, the configuration and the permission are still those of the command. */
  stillValid({ client, generation }) {
    if (client !== this.client || generation !== this.generation || this.blocked) {
      throw new Error(T.errors.configChanged);
    }
    if (!this.config.allowPauseResume) throw new Error(T.errors.commandsDisabled);
    if (this.paused()) throw new Error(T.errors.busy);
  }

  async command(received, { client, generation, monitorId, pause }) {
    this.stillValid({ client, generation });
    if (this.now() - received > COMMAND_BUDGET_MS) throw new Error(T.errors.tooSlow);
    let sent = false;
    try {
      await client.setPaused(monitorId, pause, {
        deadline: received + COMMAND_ACK_MS,
        onSent: () => {
          sent = true;
        },
      });
    } catch (err) {
      if (isBusy(err)) {
        // Refused without being done: every path pauses. failed() sets the
        // pause before its first await; the ack never waits for Gladys.
        this.failed(err, generation).catch((e) => this.logger.warn(`Pause: ${e.message}`));
        const delay = Math.max(0, this.pausedUntil - this.now());
        throw new Error(T.errors.busyRefused(delay), { cause: err });
      }
      if (err.code === CODES.LIMITED) throw new Error(T.errors.limited, { cause: err });
      if (err.notSent || !sent) throw new Error(T.errors.notSent(err), { cause: err });
      if (err.code === CODES.API && err.apiType === 'not_authorized') {
        throw new Error(T.errors.refusedKey, { cause: err });
      }
      if (err.code === CODES.API || (err.code === CODES.HTTP && err.status < 500)) {
        throw new Error(T.errors.refused(err), { cause: err });
      }
      if (isServerError(err)) {
        // The same bounded pause as a reading (Retry-After included), kept
        // in /data; the command itself may have been done.
        this.failed(err, generation).catch((e) => this.logger.warn(`Pause: ${e.message}`));
      }
      throw new Error(T.errors.unconfirmed(err), { cause: err });
    }
    this.logger.info(`Monitor ${monitorId} ${pause ? 'paused' : 'resumed'}`);
    // Published without holding the ack (Gladys waits 5 s for it).
    this.observed(generation, monitorId, pause).catch((err) =>
      this.logger.warn(`State not published: ${err.message}`),
    );
  }

  /**
   * What a command did, until the next reading: paused, or not checked yet
   * (UptimeRobot checks a resumed monitor again). The trigger reference is
   * dropped: a resume never fires "monitor up".
   */
  async observed(generation, monitorId, pause) {
    if (generation !== this.generation) return;
    const monitor = this.monitors.get(monitorId);
    if (!monitor) return;
    this.monitors.set(monitorId, {
      ...monitor,
      status: pause ? API_STATUS.PAUSED : API_STATUS.NOT_CHECKED,
    });
    this.confirmed.delete(monitorId);
    // A reading already in flight keeps this state (readAll).
    this.commandVersions.set(monitorId, (this.commandVersions.get(monitorId) ?? 0) + 1);
    const created = createdMonitors(this.gladys).find((c) => c.monitorId === monitorId);
    if (created) await this.publishStates(this.statesOf(created));
  }

  // --- Devices created / updated / deleted in Gladys -------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed) return;
    // The SDK forgot the values of this device: so does the budget cache.
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(`${device.external_id}:`)) this.published.delete(key);
    }
    this.transports.delete(device.external_id);
    if (this.online) await this.publishAllStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Reconnects (a refused key and a pause included: the user asked), then reports, within 25 s. */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig ?? (await this.gladys.getConfig()), { force: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      if (this.waitingBudget) throw new Error(T.errors.testBudget);
      // Only a status that says what failed: never an older "answers" one.
      const wanted = this.wantedStatus;
      throw new Error(wanted && wanted[0] === false ? wanted[1].en : T.errors.notConnected);
    }
    return T.test.ok({ monitors: this.monitors.size });
  }
}
