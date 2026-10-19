// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-green gradient, a
// heartbeat line, and a row of uptime bars (one red: a short outage).
// Plain Node (zlib), no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [10, 18, 30];
const DEEP = [14, 60, 52];
const WHITE = [236, 246, 242];
const GREEN = [60, 214, 130];
const RED = [235, 80, 70];

// The heartbeat line: flat, a spike, flat (x, y points).
const PULSE = [
  [60, 210],
  [260, 210],
  [300, 150],
  [340, 290],
  [380, 90],
  [420, 250],
  [450, 210],
  [740, 210],
];

function segmentDistance(x, y, [x0, y0], [x1, y1]) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

// Uptime bars: 30 days, one red.
const BARS = { x0: 100, y0: 360, width: 16, gap: 4, height: 90, count: 30, red: 21 };

function pixel(x, y) {
  let color = mix(DARK, DEEP, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The glow under the pulse, then the pulse itself.
  let d = Infinity;
  for (let i = 0; i < PULSE.length - 1; i += 1) {
    d = Math.min(d, segmentDistance(x, y, PULSE[i], PULSE[i + 1]));
  }
  color = mix(color, GREEN, Math.max(0, 1 - d / 40) * 0.25);
  color = mix(color, GREEN, smooth(6, d));
  color = mix(color, WHITE, smooth(2, d) * 0.6);
  // The dot at the end of the line: the monitor is up.
  color = mix(color, GREEN, smooth(16, Math.hypot(x - 740, y - 210)));
  color = mix(color, WHITE, smooth(6, Math.hypot(x - 740, y - 210)) * 0.8);
  // The uptime bars.
  const rel = x - BARS.x0;
  const index = Math.floor(rel / (BARS.width + BARS.gap));
  if (
    rel >= 0 &&
    index < BARS.count &&
    rel % (BARS.width + BARS.gap) < BARS.width &&
    y >= BARS.y0 &&
    y <= BARS.y0 + BARS.height
  ) {
    color = mix(color, index === BARS.red ? RED : GREEN, 0.9);
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
