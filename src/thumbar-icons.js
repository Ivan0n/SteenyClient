'use strict';

const zlib = require('node:zlib');

// Windows THUMBBUTTON uses a 32-bit SM_CXICON-sized image. A 24 px source
// was being scaled by Explorer and looked rough at common display scales.
const SIZE = 32;
const SAMPLES = 6;
const COLOR = [231, 220, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function iconPng(kind) {
  if (!['previous', 'play', 'pause', 'next'].includes(kind)) {
    throw new TypeError(`Unknown thumbnail icon: ${kind}`);
  }
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const triangle = (x, y, a, b, c) => {
    const edge = (p, q) => (x - p[0]) * (q[1] - p[1])
      - (y - p[1]) * (q[0] - p[0]);
    const first = edge(a, b);
    const second = edge(b, c);
    const third = edge(c, a);
    return (first >= 0 && second >= 0 && third >= 0)
      || (first <= 0 && second <= 0 && third <= 0);
  };
  const roundedRect = (x, y, left, top, right, bottom, radius) => {
    if (x < left || x > right || y < top || y > bottom) return false;
    const cornerX = Math.max(left + radius, Math.min(x, right - radius));
    const cornerY = Math.max(top + radius, Math.min(y, bottom - radius));
    return (x - cornerX) ** 2 + (y - cornerY) ** 2 <= radius ** 2;
  };
  const inside = (x, y) => {
    switch (kind) {
      case 'play':
        return triangle(x, y, [7.2, 5.4], [18.4, 12], [7.2, 18.6]);
      case 'pause':
        return roundedRect(x, y, 6, 5.5, 9.6, 18.5, .8)
          || roundedRect(x, y, 14.4, 5.5, 18, 18.5, .8);
      case 'previous':
        return roundedRect(x, y, 4.8, 5.8, 7.4, 18.2, .55)
          || triangle(x, y, [17.9, 5.8], [8.3, 12], [17.9, 18.2]);
      case 'next':
        return roundedRect(x, y, 16.6, 5.8, 19.2, 18.2, .55)
          || triangle(x, y, [6.1, 5.8], [15.7, 12], [6.1, 18.2]);
      default:
        return false;
    }
  };
  // Render vector-like silhouettes at subpixel resolution. The old icons
  // were hard-edged pixel blocks that looked especially jagged at 125–200%
  // Windows display scaling.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const sampleX = (x + (sx + .5) / SAMPLES) * 24 / SIZE;
          const sampleY = (y + (sy + .5) / SAMPLES) * 24 / SIZE;
          if (inside(sampleX, sampleY)) covered++;
        }
      }
      const offset = (y * SIZE + x) * 4;
      pixels[offset] = COLOR[0];
      pixels[offset + 1] = COLOR[1];
      pixels[offset + 2] = COLOR[2];
      pixels[offset + 3] = Math.round(covered * 255 / (SAMPLES * SAMPLES));
    }
  }

  const rows = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 4 + 1);
    rows[row] = 0;
    pixels.copy(rows, row + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createThumbarIcons(nativeImage) {
  return Object.freeze(Object.fromEntries(
    ['previous', 'play', 'pause', 'next'].map(kind => [
      kind, nativeImage.createFromBuffer(iconPng(kind)),
    ]),
  ));
}

module.exports = { iconPng, createThumbarIcons };
