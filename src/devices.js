// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   monitor  `ext:<selector>:monitor:<UptimeRobot monitor id>`
//            one per monitor: online (read only), status text, response time
//            (ms), uptime of the last 24 h, 7 and 30 days (%), and the Pause /
//            Resume buttons when the configuration allows them.
//
// The monitor id is the one UptimeRobot gives (stable; the name may change).
// "Online" is never a switch: the core hands every switch to the voice
// assistants, MCP and the "turn off" scene actions. Pause and resume are push
// buttons, refused unless allowed in the configuration.
//
// A device republished never loses a feature: the core would mark it
// `structure_changed`, and "Update" would drop the history. The features of
// the created device (gladys.devices, kept up to date by the SDK) are kept,
// the buttons included once created.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES, MONITOR_ID_PATTERN, MONITOR_TYPE } from './constants.js';

export const monitorIds = (gladys, monitorId) => gladys.externalIds(MONITOR_TYPE, monitorId);

const readOnly = (extra) => ({ read_only: true, has_feedback: false, ...extra });

// No core category lists a percent for an availability: no unit (TODO.md,
// "Decisions"), `unknown`/`unknown`, the pair the front translates.
const uptime = (name) =>
  readOnly({
    name,
    category: C.UNKNOWN,
    type: T.UNKNOWN.UNKNOWN,
    min: 0,
    max: 100,
    keep_history: true,
  });

const button = (name) => ({
  name,
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

/** Every feature this integration can publish, by key (in device order). */
const BLUEPRINTS = Object.freeze({
  [FEATURES.ONLINE]: () =>
    // 1 up, 0 down (confirmed by UptimeRobot); nothing while paused or not checked yet.
    readOnly({
      name: 'Online',
      category: C.UNKNOWN,
      type: T.SENSOR.BINARY,
      min: 0,
      max: 1,
      keep_history: true,
    }),
  [FEATURES.STATUS]: () =>
    // up, seems_down, down, paused, not_checked.
    readOnly({
      name: 'Status',
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
      keep_history: false,
    }),
  [FEATURES.RESPONSE_TIME]: () =>
    readOnly({
      name: 'Response time',
      category: C.DURATION,
      type: T.DURATION.INTEGER,
      unit: U.MILLISECONDS,
      min: 0,
      max: 600_000,
      keep_history: true,
    }),
  [FEATURES.UPTIME_24H]: () => uptime('Uptime 24 h (%)'),
  [FEATURES.UPTIME_7D]: () => uptime('Uptime 7 days (%)'),
  [FEATURES.UPTIME_30D]: () => uptime('Uptime 30 days (%)'),
  [FEATURES.PAUSE]: () => button('Pause monitoring'),
  [FEATURES.RESUME]: () => button('Resume monitoring'),
});

const BASE = [
  FEATURES.ONLINE,
  FEATURES.STATUS,
  FEATURES.RESPONSE_TIME,
  FEATURES.UPTIME_24H,
  FEATURES.UPTIME_7D,
  FEATURES.UPTIME_30D,
];
const BUTTONS = [FEATURES.PAUSE, FEATURES.RESUME];

/** The feature keys a created device carries (unknown ones included). */
export function featureKeysOf(device) {
  const keys = [];
  for (const feature of device?.features ?? []) {
    const id = String(feature?.external_id ?? '');
    const key = id.split(':').at(-1);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Device params: what is safe to show of the monitor (src/uptimerobot/parse.js). */
function paramsOf(monitor) {
  const params = [{ name: 'MONITOR_ID', value: monitor.id }];
  if (monitor.typeLabel) params.push({ name: 'MONITOR_TYPE', value: monitor.typeLabel });
  if (monitor.target) params.push({ name: 'MONITOR_TARGET', value: monitor.target });
  return params;
}

/**
 * @param {object} gladys
 * @param {{ id: string, name: string, typeLabel: string|null, target: string|null }} monitor
 * @param {{ withButtons?: boolean, created?: object }} [options] `created`: the device
 *   already created in Gladys (its features are all kept)
 */
export function buildMonitorDevice(gladys, monitor, { withButtons = false, created } = {}) {
  const ids = monitorIds(gladys, monitor.id);
  const createdKeys = featureKeysOf(created);
  const keys = [...BASE];
  if (withButtons || BUTTONS.some((k) => createdKeys.includes(k))) keys.push(...BUTTONS);
  const features = keys.map((key) => ({ ...BLUEPRINTS[key](), external_id: ids.feature(key) }));
  // A feature of the created device this version does not know (a later
  // version, then a downgrade): kept as it is, never dropped.
  for (const feature of created?.features ?? []) {
    const key = String(feature?.external_id ?? '')
      .split(':')
      .at(-1);
    if (keys.includes(key) || !String(feature.external_id).startsWith(`${ids.device}:`)) continue;
    keys.push(key);
    features.push({
      name: String(feature.name ?? key).slice(0, 100),
      external_id: feature.external_id,
      category: feature.category,
      type: feature.type,
      ...(feature.unit ? { unit: feature.unit } : {}),
      min: feature.min ?? 0,
      max: feature.max ?? 0,
      read_only: feature.read_only !== false,
      has_feedback: false,
      keep_history: feature.keep_history !== false,
    });
  }
  return {
    name: monitor.name,
    external_id: ids.device,
    model: monitor.typeLabel ? `UptimeRobot ${monitor.typeLabel} monitor` : 'UptimeRobot monitor',
    should_poll: false,
    params: paramsOf(monitor),
    features,
  };
}

/**
 * What a device or feature external id of this integration designates:
 * { monitorId, feature } (feature null for the device) | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const prefix = gladys.externalId(`${MONITOR_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [monitorId, feature, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0 || !MONITOR_ID_PATTERN.test(monitorId ?? '')) return null;
  return { monitorId, feature: feature ?? null };
}

/** The created monitor devices: [{ monitorId, externalId, device }]. */
export function createdMonitors(gladys, devices = gladys.devices) {
  const list = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    list.push({ monitorId: parsed.monitorId, externalId: device.external_id, device });
  }
  return list;
}
