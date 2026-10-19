// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, REFRESH_INTERVALS, SCENE_TRIGGERS } from '../src/constants.js';
import { buildMonitorDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-uptimerobot:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-uptimerobot');
  assert.equal(lock.name, 'gladys-uptimerobot');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(
    fields.intro.description.en,
    /Unofficial integration, not affiliated with UptimeRobot/,
  );
  assert.match(fields.intro.description.fr, /non officielle, sans lien avec UptimeRobot/);
  assert.match(read('docs/en.md'), /never been tested with a real UptimeRobot account/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai compte UptimeRobot/i);
});

test('the license (no name) and the notices ship in the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  // Only the placeholder of the appendix: no year, no holder.
  assert.doesNotMatch(license, /Copyright\s+(\(c\)|©|\d{4})/i);
  assert.doesNotMatch(license, /LM1LC3N7|lmilcent|Louis/i);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /pyuptimerobot[\s\S]*MIT License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; pause off by default; the key is a secret', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.equal(fields.refresh_interval.default, '300', '5 minutes by default');
  assert.deepEqual(
    fields.refresh_interval.options.map((o) => o.value),
    REFRESH_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'api_key',
    'monitors',
    'refresh_interval',
    'commands_section',
    'allow_pause_resume',
  ]);
  assert.equal(fields.api_key.type, 'secret');
  assert.match(fields.api_key.description.en, /read-only API key is recommended/);
  assert.match(
    fields.api_key.description.en,
    /never shown again, sent only to api\.uptimerobot\.com/,
  );
  assert.match(
    fields.api_key.description.fr,
    /jamais réaffichée, envoyée seulement à api\.uptimerobot\.com/,
  );
  // A secret field is NOT encrypted by Gladys (kept in its database): never say so.
  // ("chiffres", digits, is fine: only the forms of "chiffrer".)
  const ENCRYPTED = /chiffr(?:é|em|er)|encrypt/i;
  assert.doesNotMatch(JSON.stringify(manifest), ENCRYPTED);
  for (const doc of ['docs/en.md', 'docs/fr.md', 'README.md']) {
    assert.doesNotMatch(read(doc), ENCRYPTED, `${doc} never says encrypted`);
  }
  assert.equal(fields.allow_pause_resume.default, false);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  for (const trigger of manifest.scene_triggers) {
    // The event carries the device (the field) and the declared variables.
    assert.deepEqual(keys(trigger.fields), ['monitor']);
    assert.deepEqual(keys(trigger.variables), ['monitor_name', 'monitor_type']);
    for (const key of ['monitor:', 'monitor_name:', 'monitor_type:']) {
      assert.ok(app.includes(key), key);
    }
  }
  for (const absent of ['scene_actions', 'widgets']) {
    assert.equal(manifest[absent], undefined, absent);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(', "on('connected'"]) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('units and categories: only those the core lists; never a switch', () => {
  const gladys = createFakeGladys({ selector: 'uptimerobot' });
  const device = buildMonitorDevice(
    gladys,
    { id: '1', name: 'Site', typeLabel: 'HTTP(s)', target: null },
    { withButtons: true },
  );
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js: duration
  // lists milliseconds; unknown, text and button list no unit.
  const units = { duration: ['milliseconds'], unknown: [], text: [], button: [] };
  for (const feature of device.features) {
    assert.ok(feature.category in units, `${feature.name}: ${feature.category}`);
    if (feature.unit !== undefined) assert.ok(units[feature.category].includes(feature.unit));
    assert.notEqual(feature.category, 'switch');
  }
  const buttons = device.features.filter((f) => f.category === 'button');
  assert.deepEqual(
    buttons.map((f) => f.type),
    ['push', 'push'],
  );
  assert.equal(new Set(device.features.map((f) => f.external_id)).size, device.features.length);
});
