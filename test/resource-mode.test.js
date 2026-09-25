'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  collectRendererGarbage,
  createWindowResourceManager,
  rendererWorkingSetKb,
  totalWorkingSetKb,
} = require('../src/window-resource-manager');

test('client enables Chromium throttling and renderer media cleanup', () => {
  const mainSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'main.js'),
    'utf8',
  );
  const preloadSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload.js'),
    'utf8',
  );
  assert.match(mainSource, /backgroundThrottling:\s*true/);
  // The audio-only renderer must keep its clock running while invisible;
  // the heavyweight UI still uses Chromium's normal background throttling.
  assert.match(mainSource, /backgroundPlayerWindow = new BrowserWindow\([\s\S]*?backgroundThrottling:\s*false/);
  assert.match(mainSource, /renderer-process-limit/);
  assert.match(mainSource, /process-per-site/);
  assert.match(mainSource, /max-old-space-size/);
  assert.match(mainSource, /RunVideoCaptureServiceInBrowserProcess/);
  assert.match(mainSource, /if \(process\.platform === 'win32'\)/);
  assert.match(mainSource, /getAppMetrics/);
  assert.match(mainSource, /resources\.sync\(\)/);
  assert.match(mainSource, /DESKTOP_SLEEP_DELAY_MS = 15000/);
  assert.match(mainSource, /home\?desktop_restore=1/);
  assert.match(mainSource, /contents\.once\('dom-ready', onReady\)/);
  assert.match(mainSource, /await loadDesktopHomeForRestore\(\)/);
  assert.match(mainSource, /destroyingMainForSleep = true;\s*mainWindow\.destroy\(\)/);
  assert.match(mainSource, /createWindow\(\{ restoreFromSleep: true \}\)/);
  assert.match(mainSource, /mainWindow\.getNormalBounds\(\)/);
  assert.match(mainSource, /mainWindow\?\.isVisible\(\) && !mainWindow\.isMinimized\(\)/);
  // Normal minimize keeps the original renderer/audio and its taskbar entry.
  // Only an explicit hide-to-tray may destroy the window for deep sleep.
  assert.match(mainSource, /if \(SMOKE_TEST \|\| quitting \|\| !desktopHiddenToTray\) return;/);
  assert.match(mainSource, /desktopSleepPhase !== 'awake' \|\| !desktopHiddenToTray \|\| !desktopWindowIsHidden\(\)/);
  assert.doesNotMatch(mainSource, /mainWindow\.on\('minimize', scheduleDesktopSleep\)/);
  assert.match(mainSource, /Desktop audio alignment/);
  assert.match(mainSource, /'window\.steenyDesktopSession\?\.finishAudioHandoff', finalState/);
  assert.match(mainSource, /target\.setThumbarButtons\(buttons\)/);
  assert.match(mainSource, /controlFromThumbar\('previous'\)/);
  assert.match(mainSource, /controlFromThumbar\('toggle'\)/);
  assert.match(mainSource, /controlFromThumbar\('next'\)/);
  assert.match(mainSource, /label: 'Воспроизвести \/ пауза', click: \(\) => controlFromThumbar\('toggle'\)/);
  assert.match(mainSource, /backgroundPlayerWindow\.webContents\.on\('media-paused', queueThumbarRefresh\)/);
  assert.match(mainSource, /if \(!sleeping\) closeBackgroundPlayer\(\)/);
  // Graphics must never be downgraded to save memory.
  assert.doesNotMatch(mainSource, /enable-low-end-device-mode/);
  assert.doesNotMatch(mainSource, /disable-gpu/);
  assert.match(preloadSource, /appearanceWallpaperVideo/);
  assert.match(preloadSource, /fpVideo/);
  assert.match(preloadSource, /radioVideo/);
  assert.match(preloadSource, /videoId !== audioId/);
  assert.match(preloadSource, /if \(degraded\) suspendHeavyVideos\(\)/);
  assert.match(preloadSource, /steeny-low-memory-mode/);
  assert.match(
    preloadSource,
    /html\.steeny-low-memory-mode \.app-window \{\s*display: none !important;/,
  );
  assert.match(preloadSource, /removeAttribute\('src'\)/);
  // A visible page must never be degraded on the main process's word alone,
  // and visibilitychange has to be able to undo a stale signal.
  assert.match(preloadSource, /document\.visibilityState === 'hidden'/);
  assert.match(preloadSource, /visibilitychange/);
  // resources.bind() has to precede show(), or the 'show' event is missed and
  // low-memory mode can latch on for good.
  assert.match(
    mainSource,
    /resources\.bind\(mainWindow\);[\s\S]{0,400}else mainWindow\.show\(\);/,
  );
});

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.minimized = false;
    this.visible = true;
    this.messages = [];
    this.throttling = [];
    this.webContents = {
      isDestroyed: () => false,
      setBackgroundThrottling: value => this.throttling.push(value),
      send: (channel, payload) => this.messages.push({ channel, payload }),
    };
  }

  isDestroyed() {
    return false;
  }

  isMinimized() {
    return this.minimized;
  }

  isVisible() {
    return this.visible;
  }
}

test('enters low-memory mode while minimized and restores on show', async () => {
  const window = new FakeWindow();
  const scheduled = [];
  const collected = [];
  const manager = createWindowResourceManager({
    purgeDelayMs: 2500,
    setTimer: callback => {
      scheduled.push(callback);
      return { unref() {} };
    },
    clearTimer: () => undefined,
    collectGarbage: async webContents => collected.push(webContents),
  });

  manager.bind(window);
  assert.equal(manager.isLowMemory(), false);
  assert.equal(window.messages.at(-1).payload.lowMemory, false);

  window.minimized = true;
  window.emit('minimize');
  assert.equal(manager.isLowMemory(), true);
  assert.equal(window.messages.at(-1).payload.reason, 'minimized');
  assert.equal(scheduled.length, 1);
  await scheduled[0]();
  assert.deepEqual(collected, [window.webContents]);

  window.minimized = false;
  window.emit('restore');
  assert.equal(manager.isLowMemory(), false);
  assert.equal(window.messages.at(-1).payload.lowMemory, false);
  assert.ok(window.throttling.every(Boolean));

  window.visible = false;
  window.emit('hide');
  assert.equal(manager.isLowMemory(), true);
  assert.equal(window.messages.at(-1).payload.reason, 'hidden');
  manager.unbind();
  assert.equal(window.listenerCount('hide'), 0);
});

test('a scheduled purge is re-checked when it fires, not when it was queued', async () => {
  const window = new FakeWindow();
  const collected = [];
  const scheduled = [];
  const manager = createWindowResourceManager({
    setTimer: callback => {
      scheduled.push(callback);
      return { unref() {} };
    },
    clearTimer: () => undefined,
    collectGarbage: async webContents => collected.push(webContents),
  });

  manager.bind(window);
  window.visible = false;
  window.emit('hide');
  assert.equal(scheduled.length, 1);

  // The user brings the window back before the delayed purge fires. Forcing a
  // full GC on it now would stall the renderer in plain sight.
  window.visible = true;
  window.emit('show');
  await scheduled.at(-1)();
  assert.deepEqual(collected, []);

  manager.unbind();
});

test('renderer garbage collection attaches and detaches a private debugger', async () => {
  const commands = [];
  const debuggerClient = {
    attached: false,
    isAttached() {
      return this.attached;
    },
    attach(version) {
      assert.equal(version, '1.3');
      this.attached = true;
    },
    async sendCommand(command) {
      commands.push(command);
    },
    detach() {
      this.attached = false;
    },
  };
  const collected = await collectRendererGarbage({
    isDestroyed: () => false,
    debugger: debuggerClient,
  });
  assert.equal(collected, true);
  assert.deepEqual(commands, ['HeapProfiler.collectGarbage']);
  assert.equal(debuggerClient.attached, false);
});

test('never sends the purge command that wedges the renderer', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'window-resource-manager.js'),
    'utf8',
  );

  // Measured: this command reports success and detaches cleanly, but the
  // renderer never runs script again -- the window returns from the tray
  // frozen. Keep it out of the purge list.
  assert.doesNotMatch(
    source,
    /^\s*(?!\/\/).*'Memory\.forciblyPurgeJavaScriptMemory'/m,
  );
});

test('a failing purge command still detaches the debugger', async () => {
  const debuggerClient = {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    detach() { this.attached = false; },
    async sendCommand() { throw new Error('unknown command'); },
  };

  const collected = await collectRendererGarbage({
    isDestroyed: () => false,
    debugger: debuggerClient,
  });

  assert.equal(collected, true);
  assert.equal(debuggerClient.attached, false);
});

test('memory accounting separates the renderer from the fixed helper cost', () => {
  const metrics = [
    { type: 'Browser', memory: { workingSetSize: 90_000 } },
    { type: 'GPU', memory: { workingSetSize: 70_000 } },
    { type: 'Tab', memory: { workingSetSize: 120_000 } },
    { type: 'Tab', memory: {} },
    { type: 'Utility' },
  ];

  // Only the renderer can be reclaimed by a JS purge, so only it is budgeted.
  assert.equal(rendererWorkingSetKb(metrics), 120_000);
  assert.equal(totalWorkingSetKb(metrics), 280_000);
  assert.equal(rendererWorkingSetKb(null), 0);
  assert.equal(totalWorkingSetKb(null), 0);
});

test('the watchdog reclaims only when over budget, and respects the cooldown', async () => {
  const window = new FakeWindow();
  const collected = [];
  let usageKb = 150 * 1024;
  let clock = 0;
  let poll = null;
  const manager = createWindowResourceManager({
    memoryBudgetKb: 200 * 1024,
    purgeCooldownMs: 60000,
    getMetrics: () => [
      // A large fixed helper cost must never on its own trigger a purge --
      // only the renderer's own growth counts against the budget.
      { type: 'Browser', memory: { workingSetSize: 120 * 1024 } },
      { type: 'GPU', memory: { workingSetSize: 90 * 1024 } },
      { type: 'Tab', memory: { workingSetSize: usageKb } },
    ],
    setTimer: () => ({ unref() {} }),
    clearTimer: () => undefined,
    setPoll: callback => {
      poll = callback;
      return { unref() {} };
    },
    clearPoll: () => undefined,
    now: () => clock,
    collectGarbage: async webContents => collected.push(webContents),
  });

  manager.bind(window);
  assert.equal(typeof poll, 'function');

  // Comfortably inside the budget: nothing to reclaim.
  poll();
  assert.equal(collected.length, 0);

  // Over budget, but the window is on screen. A purge stalls the renderer, so
  // a visible window is never touched no matter how far over budget it is.
  usageKb = 260 * 1024;
  poll();
  assert.equal(collected.length, 0);

  // Hidden and over budget: now it is safe to reclaim.
  window.visible = false;
  window.emit('hide');
  poll();
  assert.equal(collected.length, 1);

  // Still over budget, but the cooldown has not elapsed.
  clock += 10000;
  poll();
  assert.equal(collected.length, 1);

  clock += 60000;
  poll();
  assert.equal(collected.length, 2);

  // Back on screen: reclaiming stops again, cooldown or not.
  clock += 60000;
  window.visible = true;
  window.emit('show');
  poll();
  assert.equal(collected.length, 2);

  manager.unbind();
});

function exerciseBackgroundRadio({ changeStation = false, reconnectVideo = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const ipcListeners = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const intervals = [];
  const radioVideo = {
    id: 'radioVideo',
    isConnected: true,
    paused: false,
    ended: false,
    currentTime: 0,
    duration: Infinity,
    currentSrc: 'https://music.steeny.xyz/api/radio/video/station-a?t=1',
    src: '/api/radio/video/station-a?t=1',
    playCount: 0,
    pause() { this.paused = true; },
    play() { this.paused = false; this.playCount++; return Promise.resolve(); },
    getAttribute(name) { return name === 'src' ? this.src : null; },
    setAttribute(name, value) { if (name === 'src') this.src = value; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    addEventListener(name, listener) { if (name === 'loadedmetadata') this.onMetadata = listener; },
    load() {
      this.currentSrc = this.src
        ? new URL(this.src, 'https://music.steeny.xyz/home').href : '';
      if (this.src) this.onMetadata?.();
    },
  };
  const audio = {
    id: 'audioEl',
    paused: false,
    currentSrc: 'https://music.steeny.xyz/api/radio/stream/station-a?t=1',
  };
  const nodes = { radioVideo, audioEl: audio };
  const document = {
    visibilityState: 'visible',
    baseURI: 'https://music.steeny.xyz/home',
    head: { appendChild() {} },
    documentElement: { classList: { add() {}, toggle() {} } },
    createElement: () => ({}),
    getElementById: id => nodes[id] || null,
    querySelector: () => null,
    addEventListener: (name, listener) => documentListeners.set(name, listener),
  };
  const window = {
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    dispatchEvent() {},
  };
  const ipcRenderer = {
    on: (name, listener) => ipcListeners.set(name, listener),
    send() {},
  };
  vm.runInNewContext(source, {
    require: name => {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld() {} } };
    },
    window,
    document,
    console,
    URL,
    CustomEvent: class {},
    setInterval: callback => { intervals.push(callback); return 0; },
  });
  windowListeners.get('DOMContentLoaded')();
  document.visibilityState = 'hidden';
  ipcListeners.get('resource-mode')(null, { lowMemory: true });
  assert.equal(radioVideo.src, '');
  assert.equal(audio.paused, false);
  if (reconnectVideo) {
    radioVideo.src = '/api/radio/video/station-a?t=2';
    radioVideo.currentSrc = new URL(radioVideo.src, document.baseURI).href;
    radioVideo.paused = false;
    intervals[0]();
    assert.equal(radioVideo.src, '');
  }
  if (changeStation) {
    audio.currentSrc = 'https://music.steeny.xyz/api/radio/stream/station-b?t=2';
  }
  document.visibilityState = 'visible';
  documentListeners.get('visibilitychange')();
  return { audio, radioVideo };
}

test('background mode releases radio video while audio keeps playing', () => {
  const { audio, radioVideo } = exerciseBackgroundRadio();
  assert.equal(audio.paused, false);
  assert.equal(radioVideo.src, '/api/radio/video/station-a?t=1');
  assert.equal(radioVideo.playCount, 1);
});

test('returning from background does not resurrect a previous radio station', () => {
  const { radioVideo } = exerciseBackgroundRadio({ changeStation: true });
  assert.equal(radioVideo.src, '');
  assert.equal(radioVideo.playCount, 0);
});

test('a radio video reconnected while hidden is released again', () => {
  const { radioVideo } = exerciseBackgroundRadio({ reconnectVideo: true });
  assert.equal(radioVideo.src, '/api/radio/video/station-a?t=2');
  assert.equal(radioVideo.playCount, 1);
});

test('hidden window skips full GC below budget and visible window skips metric polls', () => {
  const window = new FakeWindow();
  const scheduled = [];
  const collected = [];
  let metricReads = 0;
  let usedKb = 100 * 1024;
  const manager = createWindowResourceManager({
    getMetrics: () => {
      metricReads += 1;
      return [{ type: 'Tab', memory: { workingSetSize: usedKb } }];
    },
    setTimer: callback => {
      scheduled.push(callback);
      return { unref() {} };
    },
    clearTimer: () => undefined,
    setPoll: () => ({ unref() {} }),
    clearPoll: () => undefined,
    collectGarbage: () => { collected.push(true); },
  });

  manager.bind(window);
  assert.equal(manager.checkMemory(), null);
  assert.equal(metricReads, 0);

  window.visible = false;
  window.emit('hide');
  scheduled.at(-1)();
  assert.equal(metricReads, 1);
  assert.equal(collected.length, 0);

  usedKb = 250 * 1024;
  manager.checkMemory();
  assert.equal(collected.length, 1);
  manager.unbind();
});

test('does not interfere when DevTools already owns the debugger', async () => {
  const collected = await collectRendererGarbage({
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
    },
  });
  assert.equal(collected, false);
});
