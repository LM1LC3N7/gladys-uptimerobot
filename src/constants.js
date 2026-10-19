// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys and the external id shapes are
// stored in user devices and scenes: never rename them (test/manifest.test.js
// ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

export const SCENE_TRIGGERS = Object.freeze({
  DOWN: 'monitor_down',
  UP: 'monitor_up',
});

/** The only host the API key is ever sent to (API v2, see src/uptimerobot/client.js). */
export const API_ORIGIN = 'https://api.uptimerobot.com';

/** Device external ids: `ext:<selector>:monitor:<UptimeRobot monitor id>`. */
export const MONITOR_TYPE = 'monitor';

/** An UptimeRobot monitor id: digits only. */
export const MONITOR_ID_PATTERN = /^[0-9]{1,15}$/;

/** The features of a monitor device. */
export const FEATURES = Object.freeze({
  ONLINE: 'online',
  STATUS: 'status',
  RESPONSE_TIME: 'response_time',
  UPTIME_24H: 'uptime_24h',
  UPTIME_7D: 'uptime_7d',
  UPTIME_30D: 'uptime_30d',
  PAUSE: 'pause',
  RESUME: 'resume',
});

/** The `status` of a monitor in API v2. */
export const API_STATUS = Object.freeze({
  PAUSED: 0,
  NOT_CHECKED: 1,
  UP: 2,
  SEEMS_DOWN: 8,
  DOWN: 9,
});

/** The text of the "Status" feature for each API status. */
export const STATUS_TEXT = Object.freeze({
  0: 'paused',
  1: 'not_checked',
  2: 'up',
  8: 'seems_down',
  9: 'down',
});

/** The `type` of a monitor in API v2. */
export const MONITOR_TYPES = Object.freeze({
  1: 'HTTP(s)',
  2: 'Keyword',
  3: 'Ping',
  4: 'Port',
  5: 'Heartbeat',
});

/** Seconds between two readings; 300 (5 min) is the default. */
export const REFRESH_INTERVALS = Object.freeze(['60', '120', '300', '600', '900', '1800', '3600']);

/** Caps: what is published, read and remembered. */
export const LIMITS = Object.freeze({
  /** One page of getMonitors (the API maximum). */
  PAGE: 50,
  /** Monitors followed at most (4 pages, 4 requests a round). */
  MONITORS: 200,
  /** Monitor ids of the configuration (one `monitors` filter). */
  FILTER_IDS: 50,
  /**
   * The free plan admits 10 requests per minute (API documentation): this
   * integration sends 8 at most in any minute, every path counted.
   */
  REQUESTS_PER_MINUTE: 8,
  /**
   * POST /state admits 300 states per minute per integration: this
   * integration keeps under 250 (the rest waits a minute).
   */
  STATES_PER_MINUTE: 250,
  /** Scene events sent per round at most. */
  EVENTS_PER_ROUND: 50,
  /** Longest monitor name kept. */
  NAME: 100,
});

export const TIMEOUTS = Object.freeze({
  API: 10_000,
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent any more.
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Once sent, Gladys gets its answer at the latest this long after the command arrived. */
export const COMMAND_ACK_MS = 4_300;

export const INTERVALS = Object.freeze({
  /** Failures retry at the reading interval at least, doubling up to this. */
  RETRY_MAX_MS: 3600_000,
  /** HTTP 429: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /** States held back by the state budget are sent again after this. */
  STATES_RETRY_MS: 61_000,
});

/**
 * A scene trigger fires only when the previous reading is at most this many
 * intervals old (plus a minute): after a long gap (outage, pause, restart)
 * a change is not "just happened", it only becomes the new reference.
 */
export const MAX_GAP_INTERVALS = 2;

/** A response time older than this is not published (a paused or silent monitor). */
export const RESPONSE_TIME_MAX_AGE_MS = 2 * 3600_000;

/** Size cap of an answer of the API (one page of 50 monitors). */
export const MAX_BYTES = 512 * 1024;

/** The persistent store (refusal, pause: see src/store.js). */
export const STORE_FILE = 'uptimerobot.json';
