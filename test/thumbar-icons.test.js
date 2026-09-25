'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { iconPng, createThumbarIcons } = require('../src/thumbar-icons');

function pixels(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  const idatAt = 8 + 25;
  assert.equal(png.subarray(idatAt + 4, idatAt + 8).toString(), 'IDAT');
  return zlib.inflateSync(png.subarray(
    idatAt + 8, idatAt + 8 + png.readUInt32BE(idatAt),
  ));
}

test('Windows thumbnail controls have distinct transparent PNG icons', () => {
  const rendered = ['previous', 'play', 'pause', 'next'].map(iconPng);
  assert.equal(new Set(rendered.map(icon => icon.toString('base64'))).size, 4);
  for (const png of rendered) {
    const data = pixels(png);
    assert.equal(data.length, (32 * 4 + 1) * 32);
    const alpha = [];
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) alpha.push(data[y * 129 + 1 + x * 4 + 3]);
    }
    assert.ok(alpha.some(value => value === 0));
    assert.ok(alpha.some(value => value === 255));
    assert.ok(alpha.some(value => value > 0 && value < 255),
      'icon edges should be antialiased instead of pixelated');
  }
});

test('thumbnail icons are decoded once for the Electron window', () => {
  const received = [];
  const icons = createThumbarIcons({
    createFromBuffer(buffer) {
      received.push(buffer);
      return { buffer };
    },
  });
  assert.deepEqual(Object.keys(icons), ['previous', 'play', 'pause', 'next']);
  assert.equal(received.length, 4);
  assert.ok(Object.isFrozen(icons));
});
