'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const controls = main.slice(
  main.indexOf('async function evalDesktop('),
  main.indexOf('async function boundedDesktopStep('),
);

function fixture() {
  const calls = [];
  const sent = [];
  const clicked = [];
  const audio = {
    paused: true, ended: false,
    getAttribute(name) { return name === 'src' ? '/api/stream/track' : null; },
  };
  const nodes = {
    audioEl: audio,
    npName: { textContent: 'Track' },
    npSub: { textContent: 'Artist' },
    prevBtn: { click: () => clicked.push('previous') },
    playBtn: { click: () => { clicked.push('toggle'); audio.paused = !audio.paused; } },
    nextBtn: { click: () => clicked.push('next') },
  };
  const page = { document: { getElementById: id => nodes[id] || null } };
  const window = {
    isDestroyed: () => false,
    visible: true,
    minimized: false,
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    webContents: {
      getURL: () => 'https://music.steeny.xyz/home',
      send(channel, action) { sent.push([channel, action]); },
      executeJavaScript(script) {
        calls.push(script);
        return Promise.resolve(vm.runInNewContext(script, page));
      },
    },
    setThumbarButtons(buttons) { this.buttons = buttons; return true; },
    setThumbnailToolTip(value) { this.tooltip = value; },
  };
  const backgroundPlayer = {
    status() { return { hasTrack: true, playing: true, canPrevious: true,
      canNext: true, title: 'Track', artist: 'Artist' }; },
    toggle() { clicked.push('background-toggle'); return this.status(); },
  };
  const backgroundWindow = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript(script) {
        calls.push(script);
        return Promise.resolve(vm.runInNewContext(script,
          { window: { steenyBackgroundPlayer: backgroundPlayer } }));
      },
    },
  };
  const scope = {
    process: { platform: 'win32' },
    MEMORY_PROBE: false, SMOKE_TEST: false, TASKBAR_DEBUG: false, quitting: false,
    mainWindow: window, backgroundPlayerWindow: null,
    desktopSleepPhase: 'awake', desktopSnapshot: null,
    latestPlaybackStatus: null,
    APP_ORIGIN: 'https://music.steeny.xyz',
    thumbarIcons: null, thumbarRefreshTimer: null,
    thumbarRejected: false,
    nativeImage: {},
    createThumbarIcons: () => ({
      previous: 'previous-icon', play: 'play-icon',
      pause: 'pause-icon', next: 'next-icon',
    }),
    showWindow: () => { throw new Error('unexpected wake'); },
    wakeDesktopWindow: () => { throw new Error('unexpected wake'); },
    setTimeout: () => 1, clearTimeout() {},
    console,
  };
  vm.runInNewContext(controls, scope);
  return { scope, window, backgroundWindow, calls, clicked, sent };
}

test('Windows thumbnail buttons use the main player while it is open', async () => {
  const { scope, window, sent } = fixture();
  await scope.refreshThumbar();
  assert.equal(window.buttons.length, 3);
  assert.equal(window.buttons[1].icon, 'play-icon');
  assert.equal(window.buttons[1].flags.length, 0);
  await window.buttons[0].click();
  await window.buttons[1].click();
  await window.buttons[2].click();
  assert.deepEqual(sent, [
    ['playback:control', 'previous'],
    ['playback:control', 'toggle'],
    ['playback:control', 'next'],
  ]);
  scope.latestPlaybackStatus = {
    hasTrack: true, playing: true, canPrevious: true, canNext: true,
    title: 'Track', artist: 'Artist',
  };
  await scope.refreshThumbar();
  assert.equal(window.buttons[1].icon, 'pause-icon');
});

test('Windows thumbnail buttons are not registered before the taskbar window is visible', async () => {
  const { scope, window } = fixture();
  window.visible = false;
  await scope.refreshThumbar();
  assert.equal(window.buttons, undefined);
  window.visible = true;
  await scope.refreshThumbar();
  assert.equal(window.buttons.length, 3);
});

test('Windows thumbnail buttons control the audio-only player without waking UI', async () => {
  const { scope, window, backgroundWindow, clicked } = fixture();
  scope.desktopSleepPhase = 'dormant';
  scope.backgroundPlayerWindow = backgroundWindow;
  await scope.refreshThumbar();
  assert.equal(window.buttons[1].icon, 'pause-icon');
  assert.match(window.tooltip, /Track — Artist/);
  await window.buttons[1].click();
  assert.deepEqual(clicked, ['background-toggle']);
});

test('desktop renderer bridge invokes arrow functions and preserves method receiver', async () => {
  const { scope, window, backgroundWindow } = fixture();
  assert.equal(await scope.evalDesktop(window, 'value => value * 2', 21), 42);
  scope.backgroundPlayerWindow = backgroundWindow;
  const status = await scope.evalDesktop(backgroundWindow,
    'window.steenyBackgroundPlayer?.status');
  assert.equal(status.title, 'Track');
});
