#!/usr/bin/env node
/** Generates icons/icon{16,48,128}.png — a calendar page with a check, no image deps. */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [79, 70, 229]; // indigo
const FG = [255, 255, 255];
const ACCENT = [199, 210, 254];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const distToSegment = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = (v) => (v * size) / 128;
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };

  const radius = s(26);
  const inRound = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return Math.hypot(x - cx, y - cy) <= r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRound(x, y, 0, 0, size - 1, size - 1, radius)) continue;
      set(x, y, BG);

      // calendar body
      const bx0 = s(24), by0 = s(30), bx1 = size - 1 - s(24), by1 = size - 1 - s(22);
      if (inRound(x, y, bx0, by0, bx1, by1, s(8))) {
        set(x, y, y < by0 + s(16) ? ACCENT : FG); // header band
      }
      // binding posts above the body
      if (y >= s(18) && y <= s(34) && ((x >= s(42) && x <= s(52)) || (x >= s(76) && x <= s(86)))) {
        set(x, y, FG);
      }
      // check mark
      const t = s(7);
      const d = Math.min(
        distToSegment(x, y, s(44), s(74), s(58), s(88)),
        distToSegment(x, y, s(58), s(88), s(86), s(56)),
      );
      if (d <= t / 2) set(x, y, BG);
    }
  }
  return buf;
}

mkdirSync('icons', { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`icons/icon${size}.png`, png(size, render(size)));
  console.log(`icons/icon${size}.png`);
}
