'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

test('thumbnail IPC follows player state and clicks the real player controls', () => {
  const ipcListeners = new Map();
  const windowListeners = new Map();
  const sent = [];
  const clicked = [];
  const observers = [];
  const audioEvents = new Map();
  const audio = {
    paused: true, ended: false, source: '/api/ytmusic/stream/track',
    getAttribute(name) { return name === 'src' ? this.source : null; },
    addEventListener(name, listener) { audioEvents.set(name, listener); },
  };
  const nodes = {
    audioEl: audio,
    npName: { textContent: 'First song' },
    npSub: { textContent: 'Artist' },
    prevBtn: { click: () => clicked.push('previous') },
    playBtn: { click: () => { clicked.push('toggle'); audio.paused = !audio.paused;
      audioEvents.get(audio.paused ? 'pause' : 'play')?.(); } },
    nextBtn: { click: () => clicked.push('next') },
  };
  const document = {
    visibilityState: 'visible',
    head: { appendChild() {} },
    documentElement: { classList: { add() {}, toggle() {} } },
    createElement: () => ({}),
    getElementById: id => nodes[id] || null,
    querySelector: () => null,
    addEventListener() {},
  };
  const ipcRenderer = {
    on: (channel, listener) => ipcListeners.set(channel, listener),
    send: (channel, payload) => sent.push([channel, payload]),
  };
  vm.runInNewContext(preload, {
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld() {} } };
    },
    document,
    window: { addEventListener: (name, listener) => windowListeners.set(name, listener),
      dispatchEvent() {} },
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
    },
    CustomEvent: class {},
    setInterval() {},
    console,
  });
  windowListeners.get('DOMContentLoaded')();
  const states = () => sent.filter(([channel]) => channel === 'playback:state')
    .map(([, value]) => value);
  assert.equal(states().at(-1).hasTrack, true);
  assert.equal(states().at(-1).playing, false);

  ipcListeners.get('playback:control')(null, 'toggle');
  assert.deepEqual(clicked, ['toggle']);
  assert.equal(states().at(-1).playing, true);
  assert.ok(sent.some(([channel, result]) => channel === 'playback:control-result'
    && result.action === 'toggle' && result.clicked));

  nodes.npName.textContent = 'Second song';
  observers.forEach(callback => callback());
  assert.equal(states().at(-1).title, 'Second song');
  ipcListeners.get('playback:control')(null, 'next');
  assert.deepEqual(clicked, ['toggle', 'next']);

  audio.source = '';
  audioEvents.get('emptied')();
  assert.equal(states().at(-1).hasTrack, false);
  ipcListeners.get('playback:control')(null, 'not-a-player-action');
  assert.deepEqual(clicked, ['toggle', 'next']);
});
