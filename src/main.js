'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  session,
  shell,
  Tray,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const {
  createLinkClient,
  createTokenStore,
  runLinkFlow,
} = require('./auth');
const { DiscordPresence, applyStatusTemplate } = require('./rpc');
const { setStatus, checkToken } = require('./cli');
const { createUpdateManager } = require('./updater');
const {
  collectRendererGarbage,
  createWindowResourceManager,
} = require('./window-resource-manager');
const { createRendererRecovery } = require('./renderer-recovery');
const { createDebouncedWriter } = require('./window-state');
const { createThumbarIcons } = require('./thumbar-icons');

// The root route renders login for a new session and redirects an authenticated
// user to `/home`. Starting there avoids an anonymous `/home` → `/` redirect.
const DEFAULT_APP_URL = 'https://music.steeny.xyz/';
function resolveAppUrl(rawUrl) {
  try {
    const value = new URL(String(rawUrl || DEFAULT_APP_URL).trim());
    if (!['http:', 'https:'].includes(value.protocol)) {
      throw new Error('unsupported protocol');
    }
    return value.href;
  } catch {
    console.warn(`Invalid STEENY_URL; using ${DEFAULT_APP_URL}`);
    return DEFAULT_APP_URL;
  }
}

const APP_URL = resolveAppUrl(process.env.STEENY_URL);
const APP_ORIGIN = new URL(APP_URL).origin;
const DEVTOOLS = process.env.STEENY_DEVTOOLS === '1'
  || process.argv.includes('--devtools');
const SMOKE_TEST = process.argv.includes('--smoke-test');
const MEMORY_PROBE = process.argv.includes('--memory-probe');
const TASKBAR_DEBUG = process.argv.includes('--taskbar-debug');
// Short visits to the tray should be instant. Only a sustained background
// stay pays for a document reload and receives the larger memory saving.
const DESKTOP_SLEEP_DELAY_MS = 15000;
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const offlinePath = path.join(__dirname, '..', 'assets', 'offline.html');
const offlineUrl = pathToFileURL(offlinePath).href;
const linkPath = path.join(__dirname, '..', 'assets', 'link.html');
const linkUrl = pathToFileURL(linkPath).href;
const suspendedPath = path.join(__dirname, '..', 'assets', 'suspended.html');
const suspendedUrl = pathToFileURL(suspendedPath).href;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Chromium starts a separate, ~120 MiB utility process merely to enumerate
// audio outputs on the current web UI. Video capture itself is denied by our
// session permissions; keeping that service in the browser process avoids the
// large idle helper without changing audio capture or playback. Measured on
// Windows with the live page (visible and hidden) before enabling by default.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'RunVideoCaptureServiceInBrowserProcess');
}
// These two are disk caches. Shrinking them to 16 MiB was measured against
// this app and moved the resident total by nothing at all, while costing
// audio and artwork re-fetches -- so they stay generous.
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024));
app.commandLine.appendSwitch('media-cache-size', String(50 * 1024 * 1024));
// One origin, one renderer. The old limit of 2 allowed a second renderer to
// exist without ever being needed.
app.commandLine.appendSwitch('renderer-process-limit', '1');
// The app is a single origin, so every frame can share one renderer instead of
// Chromium spinning up a process per site instance. Fewer processes is the
// single biggest saving available that costs nothing visually.
app.commandLine.appendSwitch('process-per-site');
// --optimize-for-size trades a little JIT speed for a smaller heap. The
// old-space cap keeps a long listening session from ratcheting upwards, and a
// small semi-space keeps the short-lived allocation churn of the player from
// reserving young-generation memory it only needs at peak. Rendering,
// textures and image decoding are untouched by all three.
app.commandLine.appendSwitch(
  'js-flags',
  '--optimize-for-size --max-old-space-size=256 --max-semi-space-size=2',
);
app.commandLine.appendSwitch(
  'disable-features',
  'SpareRendererForSitePerProcess,BackForwardCache,AudioServiceOutOfProcess',
);

let mainWindow = null;
let tray = null;
let quitting = false;
let offlineLoaded = false;
let updates = null;
let appSession = null;
let tokenStore = null;
let linkClient = null;
let authState = { status: 'idle' };
let linkAbort = null;
// One self-heal attempt per navigation, so a server that keeps bouncing us to
// the login page cannot turn into a reload loop.
let recovering = false;
let lastRecoveryAt = 0;
// Checked far more often than the timeout it enforces, so a hang is caught
// within a few seconds of crossing the line rather than a full period later.
const HEARTBEAT_CHECK_MS = 5000;
let heartbeatWatchdog = null;
let memoryProbeScheduled = false;
let desktopSleepTimer = null;
let desktopSleepPromise = null;
let desktopWakePromise = null;
let desktopSleepPhase = 'awake';
let desktopHiddenToTray = false;
let destroyingMainForSleep = false;
let desktopWantsWake = false;
let desktopSnapshot = null;
let backgroundPlayerWindow = null;
let thumbarIcons = null;
let thumbarRefreshTimer = null;
let latestPlaybackStatus = null;
let thumbarRejected = false;
const rpc = new DiscordPresence({ onLatency: sendRpcLatency });
const resources = createWindowResourceManager({
  getMetrics: () => app.getAppMetrics(),
});
// Brings the interface back when the renderer dies or wedges. Reloading the
// current URL keeps the user where they were; the offline notice is the last
// resort once repeated crashes prove the page itself cannot load.
const recovery = createRendererRecovery({
  reload: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // A crashed renderer has no page left to reload, and reload() on the
    // offline file would just re-show the notice instead of retrying the app.
    if (offlineLoaded) loadApp().catch(() => undefined);
    else mainWindow.webContents.reload();
  },
  forceCrash: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.forcefullyCrashRenderer();
  },
  showFallback: () => {
    showOffline().catch(() => undefined);
  },
  onEvent: ({ cause, action }) => {
    console.warn(`STEENY renderer ${cause} -> ${action}`);
  },
});

// How long the last status/presence update took to reach Discord. The web
// app uses it to send the next lyric line that far ahead of the audio, so it
// lands on Discord right as the line starts instead of trailing behind.
function sendRpcLatency(ms) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('rpc:latency', ms);
}

function validBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = ['x', 'y', 'width', 'height'];
  if (!keys.every(key => Number.isFinite(value[key]))) return null;
  if (value.width < 620 || value.height < 460) return null;
  return value;
}

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

// app.getAppPath() is the project root next to package.json in a dev run
// (`electron .`); inside a packaged, asar-archived build it is read-only, so
// this only ever lands the file where the user actually expects it in dev.
function settingsPath() {
  return path.join(app.getAppPath(), 'settings.json');
}

// Cached after the first read. Status updates land at lyric frequency, and
// re-reading plus re-parsing the file for each one meant synchronous disk I/O
// on the main process -- the one thread that must never stall -- and a fresh
// throwaway object every line. The cache is only ever invalidated here, since
// this process is the sole writer.
let settingsCache = null;

function readSettings() {
  if (settingsCache) return settingsCache;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    settingsCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    settingsCache = {};
  }
  return settingsCache;
}

function writeDiscordToken(value) {
  const settings = { ...readSettings(), discord_token: value };
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  settingsCache = settings;
}

// Delivers the "text in status" line onto the account's own custom status via
// setStatus() from cli.js -- a self-bot call (PATCH /users/@me/settings with
// the user's own token). The text never reaches Rich Presence (see rpc.js);
// this is the only place it is shown.
//
// Discord rate-limits this endpoint, so lines arriving faster than it can
// keep up get a 429 with a mandatory retry_after. Earlier this was treated
// as a hard failure and the line was just dropped -- the visible "skipping".
// Now a rate-limited request waits out that exact cooldown and retries,
// unless a newer line has shown up in the meantime, in which case this one
// is abandoned in favor of the fresher text (there is no point displaying a
// stale line after waiting on a 429). Only one request is ever in flight:
// a request that arrives while another is running simply replaces whatever
// was queued next, so the queue itself never backs up and falls behind.
const MAX_STATUS_RATE_LIMIT_RETRIES = 4;
let lastCustomStatusFingerprint = '';
let customStatusNext = null;
let customStatusRunning = false;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Discord reports the cooldown two ways: a JSON body ({ retry_after }, in
// seconds) and a Retry-After header. Either is authoritative; this is not a
// delay of our own choosing.
async function rateLimitWaitMs(res) {
  try {
    const body = await res.clone().json();
    if (Number.isFinite(body?.retry_after)) {
      return Math.max(0, Math.ceil(body.retry_after * 1000));
    }
  } catch {
    // No JSON body to read; fall back to the header below.
  }
  const seconds = Number(res.headers?.get?.('retry-after'));
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : 1000;
}

async function applyCustomStatus(text, emoji) {
  const token = readSettings().discord_token;
  if (!token) return { ok: false, error: 'Токен Discord не сохранён.' };
  const trimmed = String(text || '').trim().slice(0, 128);
  const trimmedEmoji = String(emoji || '').trim().slice(0, 64);
  if (!trimmed && !trimmedEmoji && !lastCustomStatusFingerprint) return { ok: true };
  const fingerprint = `${trimmed} ${trimmedEmoji}`;
  if (fingerprint === lastCustomStatusFingerprint) return { ok: true };

  for (let attempt = 0; ; attempt += 1) {
    const sentAt = Date.now();
    let res;
    try {
      res = await setStatus(token, trimmed, trimmedEmoji);
    } catch (error) {
      return { ok: false, error: error?.message || 'Не удалось отправить статус.' };
    }
    if (res.ok) {
      // This is the channel the lyric/status text actually travels over now
      // (Rich Presence no longer carries it) -- report its round trip so the
      // web app can keep scheduling the next line early enough to land on time.
      sendRpcLatency(Date.now() - sentAt);
      lastCustomStatusFingerprint = fingerprint;
      return { ok: true };
    }
    if (res.status !== 429 || attempt >= MAX_STATUS_RATE_LIMIT_RETRIES) {
      return { ok: false, error: `Discord ответил кодом ${res.status} при обновлении статуса.` };
    }
    await delay(await rateLimitWaitMs(res));
    if (customStatusNext) return { ok: true, superseded: true };
  }
}

function scheduleCustomStatus(text, emoji) {
  return new Promise(resolve => {
    customStatusNext?.resolve({ ok: true, superseded: true });
    customStatusNext = { text, emoji, resolve };
    if (!customStatusRunning) runCustomStatusQueue();
  });
}

async function runCustomStatusQueue() {
  customStatusRunning = true;
  while (customStatusNext) {
    const job = customStatusNext;
    customStatusNext = null;
    job.resolve(await applyCustomStatus(job.text, job.emoji));
  }
  customStatusRunning = false;
}

function pushCustomStatus(text, emoji = '') {
  return scheduleCustomStatus(text, emoji);
}

function clearCustomStatus() {
  return scheduleCustomStatus('', '');
}

function loadWindowState() {
  try {
    return validBounds(JSON.parse(fs.readFileSync(statePath(), 'utf8')));
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized()) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(
      statePath(),
      JSON.stringify(mainWindow.isMinimized()
        ? mainWindow.getNormalBounds() : mainWindow.getBounds()),
      { mode: 0o600 },
    );
  } catch {
    // Window state is optional.
  }
}

// Moving or resizing a frameless window emits many events per second. Writing
// JSON synchronously for every event stalls Electron's main thread, including
// playback controls. Persist only after the drag settles and flush on quit.
const windowStateSaver = createDebouncedWriter(saveWindowState);

function appIcon() {
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function isAllowedMainFrame(rawUrl) {
  try {
    const value = new URL(rawUrl);
    if (value.origin === APP_ORIGIN) return true;
    return value.href === offlineUrl || value.href === linkUrl
      || value.href === suspendedUrl;
  } catch {
    return false;
  }
}

function safeExternalUrl(rawUrl) {
  try {
    const text = String(rawUrl).trim();
    if (!text || text.length > 4096) return null;
    const value = new URL(text);
    return ['http:', 'https:'].includes(value.protocol) && value.hostname
      ? value.href
      : null;
  } catch {
    return null;
  }
}

function isTrustedOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function openExternal(rawUrl) {
  const url = safeExternalUrl(rawUrl);
  if (url) shell.openExternal(url).catch(() => undefined);
}

async function loadApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // loadURL already reports main-frame failures through did-fail-load. A
  // separate availability GET delayed every launch and could falsely send a
  // healthy app offline when only the probe failed.
  offlineLoaded = false;
  try {
    await mainWindow.loadURL(APP_URL);
    return !offlineLoaded;
  } catch {
    // did-fail-load may already be rendering the offline page.
    if (!offlineLoaded && mainWindow && !mainWindow.isDestroyed()) {
      await showOffline();
    }
    return false;
  }
}

// ── Sign-in state ───────────────────────────────────────────────────────────

function setAuthState(state) {
  authState = { ...state };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:state', authState);
  }
}

async function showLinkScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  offlineLoaded = false;
  await mainWindow.loadFile(linkPath);
  return false;
}

async function showOffline() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  offlineLoaded = true;
  await mainWindow.loadFile(offlinePath);
  return false;
}

/**
 * Decide what the window should show: the app, the sign-in screen, or the
 * offline notice. A stored token is thrown away only when the server actually
 * rejects it -- a dead network must never cost the user their session.
 */
async function enterApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const token = tokenStore?.read();
  if (!token) {
    setAuthState({ status: 'idle' });
    return showLinkScreen();
  }
  let handoff;
  try {
    handoff = await linkClient.establishSession(token);
  } catch {
    return showOffline();
  }
  if (handoff.ok) return loadApp();
  if (handoff.unauthorized) {
    tokenStore.clear();
    setAuthState({ status: 'idle' });
    return showLinkScreen();
  }
  return showOffline();
}

async function beginLink() {
  if (linkAbort) return authState;
  linkAbort = new AbortController();
  try {
    const result = await runLinkFlow({
      client: linkClient,
      openBrowser: openExternal,
      onState: setAuthState,
      signal: linkAbort.signal,
    });
    if (result.status === 'authorized') {
      tokenStore.write(result.token);
      linkAbort = null;
      await enterApp();
      return authState;
    }
    if (result.status === 'cancelled') setAuthState({ status: 'idle' });
    else setAuthState({ status: 'error', reason: result.status });
  } catch (error) {
    setAuthState({
      status: 'error',
      reason: error?.offline ? 'offline' : 'failed',
      message: error?.message,
    });
  } finally {
    linkAbort = null;
  }
  return authState;
}

async function signOut() {
  linkAbort?.abort();
  linkAbort = null;
  tokenStore?.clear();
  try {
    // Drop the cookie too, otherwise the next launch would silently walk back
    // into the account the user just left.
    await appSession?.clearStorageData({ storages: ['cookies'] });
  } catch {
    // A locked profile still signs out: the token file is already gone.
  }
  setAuthState({ status: 'idle' });
  return showLinkScreen();
}

/**
 * The web app renders its login form only at the root path, so landing there
 * means the cookie session is gone -- either the user logged out or the token
 * was revoked from another device. Re-establish it when the token is still
 * good, and fall back to the sign-in screen when it is not.
 */
async function handlePossibleSignOut(rawUrl) {
  if (recovering || !tokenStore) return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.origin !== APP_ORIGIN || parsed.pathname !== '/') return;
  const token = tokenStore.read();
  if (!token) {
    await showLinkScreen();
    return;
  }
  if (Date.now() - lastRecoveryAt < 15000) {
    // We just handed the cookie over and still ended up here. Stop bouncing.
    tokenStore.clear();
    setAuthState({ status: 'idle' });
    await showLinkScreen();
    return;
  }
  recovering = true;
  lastRecoveryAt = Date.now();
  try {
    const check = await linkClient.checkToken(token);
    if (check.valid) {
      const handoff = await linkClient.establishSession(token);
      if (handoff.ok) {
        await loadApp();
        return;
      }
    }
    tokenStore.clear();
    setAuthState({ status: 'idle' });
    await showLinkScreen();
  } catch {
    // Offline: the page on screen is as good an answer as we have.
  } finally {
    recovering = false;
  }
}

function desktopWindowIsHidden() {
  return mainWindow && !mainWindow.isDestroyed()
    && (!mainWindow.isVisible() || mainWindow.isMinimized());
}

function closeBackgroundPlayer() {
  if (backgroundPlayerWindow && !backgroundPlayerWindow.isDestroyed()) {
    backgroundPlayerWindow.destroy();
  }
  backgroundPlayerWindow = null;
  queueThumbarRefresh();
}

async function evalDesktop(window, expression, value) {
  if (!window || window.isDestroyed()) throw new Error('Desktop window was closed');
  const argument = value === undefined ? '' : JSON.stringify(value);
  // An arrow function cannot be invoked as `action => {...}(value)`; the
  // callee must be parenthesized. This also keeps method calls bound to their
  // object, including optional-chain expressions used by the audio bridge.
  return window.webContents.executeJavaScript(`(${expression})(${argument})`);
}

function queueThumbarRefresh() {
  if (process.platform !== 'win32' || MEMORY_PROBE || SMOKE_TEST || quitting) return;
  clearTimeout(thumbarRefreshTimer);
  thumbarRefreshTimer = setTimeout(() => {
    thumbarRefreshTimer = null;
    refreshThumbar().catch(error => console.warn('STEENY taskbar:', error?.message || error));
  }, 80);
  thumbarRefreshTimer.unref?.();
}

async function thumbarStatus() {
  if (backgroundPlayerWindow && !backgroundPlayerWindow.isDestroyed()
      && desktopSleepPhase !== 'awake' && desktopSleepPhase !== 'starting') {
    return evalDesktop(backgroundPlayerWindow, 'window.steenyBackgroundPlayer?.status');
  }
  if (mainWindow && !mainWindow.isDestroyed()
      && mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) {
    if (latestPlaybackStatus) return latestPlaybackStatus;
    return evalDesktop(mainWindow, `(() => {
      const audio = document.getElementById('audioEl');
      const hasTrack = Boolean(audio?.getAttribute('src'));
      return {
        hasTrack, playing: hasTrack && !audio.paused && !audio.ended,
        canPrevious: hasTrack, canNext: hasTrack,
        title: document.getElementById('npName')?.textContent?.trim() || '',
        artist: document.getElementById('npSub')?.textContent?.trim() || '',
      };
    })`);
  }
  const song = desktopSnapshot?.playback?.record?.song;
  return {
    hasTrack: Boolean(song), playing: false,
    canPrevious: Boolean(song), canNext: Boolean(song),
    title: song?.title || '', artist: song?.artist || '',
  };
}

async function controlFromThumbar(action) {
  if (!['previous', 'toggle', 'next'].includes(action)) return;
  try {
    if (backgroundPlayerWindow && !backgroundPlayerWindow.isDestroyed()
        && desktopSleepPhase !== 'awake' && desktopSleepPhase !== 'starting') {
      const result = await evalDesktop(backgroundPlayerWindow,
        `window.steenyBackgroundPlayer?.${action}`);
      if (result !== undefined) return;
    }
    if (desktopSleepPhase === 'dormant') {
      showWindow();
      await wakeDesktopWindow();
    }
    if (mainWindow && !mainWindow.isDestroyed()
        && mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) {
      mainWindow.webContents.send('playback:control', action);
    }
  } catch (error) {
    console.warn('STEENY taskbar control:', error?.message || error);
  } finally {
    queueThumbarRefresh();
  }
}

async function refreshThumbar() {
  const target = mainWindow;
  if (!target || target.isDestroyed() || process.platform !== 'win32') return;
  // Windows can report ThumbBarAddButtons success for a hidden HWND before
  // Explorer has created its taskbar button, then never paint that toolbar.
  // Make the very first registration only after the window has been shown.
  if (!target.isVisible() && !target.isMinimized()) return;
  let status;
  try { status = await thumbarStatus(); } catch { status = null; }
  if (target !== mainWindow || target.isDestroyed()) return;
  if (!thumbarIcons) thumbarIcons = createThumbarIcons(nativeImage);
  // Do not disable the native buttons just because a media event raced the
  // initial status report. The page's own controls decide what to do when no
  // song is selected; disabled THUMBBUTTONs cannot deliver clicks at all.
  const interactive = target.webContents.getURL().startsWith(`${APP_ORIGIN}/home`);
  const buttons = [
    { icon: thumbarIcons.previous, tooltip: 'Предыдущий трек',
      flags: interactive ? [] : ['disabled'],
      click: () => controlFromThumbar('previous') },
    { icon: status?.playing ? thumbarIcons.pause : thumbarIcons.play,
      tooltip: status?.playing ? 'Пауза' : 'Воспроизвести',
      flags: interactive ? [] : ['disabled'],
      click: () => controlFromThumbar('toggle') },
    { icon: thumbarIcons.next, tooltip: 'Следующий трек',
      flags: interactive ? [] : ['disabled'],
      click: () => controlFromThumbar('next') },
  ];
  const installed = target.setThumbarButtons(buttons);
  if (TASKBAR_DEBUG) {
    console.log('STEENY_THUMBAR', JSON.stringify({
      installed,
      url: target.webContents.getURL(),
      visible: target.isVisible(),
      minimized: target.isMinimized(),
      hasTrack: Boolean(status?.hasTrack),
      playing: Boolean(status?.playing),
    }));
  }
  if (installed) {
    thumbarRejected = false;
  } else if (!thumbarRejected) {
    thumbarRejected = true;
    console.warn('STEENY taskbar: Windows rejected thumbnail buttons');
  }
  const title = [status?.title, status?.artist].filter(Boolean).join(' — ');
  target.setThumbnailToolTip(title ? `STEENY — ${title.slice(0, 120)}` : 'STEENY');
}

async function boundedDesktopStep(promise, label, milliseconds = 12000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sleepDesktopWindow() {
  if (desktopSleepPhase !== 'awake' || !desktopHiddenToTray || !desktopWindowIsHidden()
      || !mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) return;
  desktopSleepPhase = 'starting';
  desktopWantsWake = false;
  desktopSleepPromise = (async () => {
    let primed = false;
    let mainClosedForSleep = false;
    try {
      let snapshot = await evalDesktop(mainWindow, 'window.steenyDesktopSession?.capture');
      // An older server, a listening room, or a radio station has no safe
      // handoff. In those cases keep the existing renderer and its audio.
      if (!snapshot || !desktopWindowIsHidden() || desktopWantsWake) return;
      if (snapshot.playback?.playing) {
        if (!snapshot.playback.record?.song || !snapshot.playback.source) return;
        backgroundPlayerWindow = new BrowserWindow({
          width: 1,
          height: 1,
          show: false,
          skipTaskbar: true,
          title: 'STEENY background audio',
          webPreferences: {
            session: appSession,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false,
            spellcheck: false,
          },
        });
        backgroundPlayerWindow.webContents.setUserAgent(mainWindow.webContents.getUserAgent());
        backgroundPlayerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        backgroundPlayerWindow.webContents.on('media-started-playing', queueThumbarRefresh);
        backgroundPlayerWindow.webContents.on('media-paused', queueThumbarRefresh);
        await boundedDesktopStep(backgroundPlayerWindow.loadURL(`${APP_ORIGIN}/desktop-player`),
          'Background page load');
        if (backgroundPlayerWindow.webContents.getURL() !== `${APP_ORIGIN}/desktop-player`) return;
        const payload = {
          ...snapshot.playback,
          source: new URL(snapshot.playback.source, APP_ORIGIN).href,
        };
        primed = await boundedDesktopStep(evalDesktop(backgroundPlayerWindow,
          'window.steenyBackgroundPlayer?.start', payload), 'Background stream start', 15000);
        if (!primed || !desktopWindowIsHidden() || desktopWantsWake) return;
        const latestSnapshot = await evalDesktop(mainWindow,
          'window.steenyDesktopSession?.capture');
        const primedState = await evalDesktop(backgroundPlayerWindow,
          'window.steenyBackgroundPlayer?.state');
        if (!latestSnapshot?.playback?.playing
            || String(latestSnapshot.playback.record?.song?.file_url || '') !==
              String(primedState?.record?.song?.file_url || '')) return;
        snapshot = latestSnapshot;
        const suspended = await evalDesktop(mainWindow,
          'window.steenyDesktopSession?.suspend');
        const finalPosition = Number(suspended?.position)
          || await evalDesktop(mainWindow,
            '(() => document.getElementById("audioEl")?.currentTime || 0)');
        const activated = await evalDesktop(backgroundPlayerWindow,
          'payload => window.steenyBackgroundPlayer?.activate(payload.volume, payload.position)',
          { volume: snapshot.playback.volume, position: finalPosition });
        if (activated === false) throw new Error('Background audio could not align with playback');
      }
      if (!desktopWindowIsHidden() || desktopWantsWake) {
        if (primed) await evalDesktop(mainWindow,
          '(() => document.getElementById("audioEl")?.play())').catch(() => undefined);
        return;
      }
      desktopSnapshot = snapshot;
      if (tray) {
        // Navigating to a tiny file leaves Chromium free to retain the large
        // page's renderer. Destroying the window releases it instead. The tray
        // (and, when playing, the separate audio window) keep the app alive.
        saveWindowState();
        destroyingMainForSleep = true;
        mainWindow.destroy();
        mainClosedForSleep = true;
      } else {
        await mainWindow.loadFile(suspendedPath);
      }
      desktopSleepPhase = 'dormant';
      queueThumbarRefresh();
    } catch (error) {
      console.warn('STEENY desktop sleep skipped:', error?.message || error);
      if (mainClosedForSleep) {
        // The old window is already gone. Keep the background audio owner and
        // let the tray retry restoration instead of stopping playback.
        desktopSleepPhase = 'dormant';
        return;
      }
      if (primed && mainWindow && !mainWindow.isDestroyed()
          && mainWindow.webContents.getURL().startsWith(APP_ORIGIN)) {
        await evalDesktop(mainWindow,
          '(() => document.getElementById("audioEl")?.play())').catch(() => undefined);
      }
    } finally {
      if (desktopSleepPhase !== 'dormant') {
        closeBackgroundPlayer();
        desktopSnapshot = null;
        desktopSleepPhase = 'awake';
      }
    }
  })();
  await desktopSleepPromise;
  desktopSleepPromise = null;
  if (desktopWantsWake && desktopSleepPhase === 'dormant') {
    wakeDesktopWindow().catch(error => console.warn('STEENY wake:', error));
  }
}

function scheduleDesktopSleep() {
  if (SMOKE_TEST || quitting || !desktopHiddenToTray) return;
  clearTimeout(desktopSleepTimer);
  desktopSleepTimer = setTimeout(() => {
    desktopSleepTimer = null;
    sleepDesktopWindow().catch(error => console.warn('STEENY sleep:', error));
  }, DESKTOP_SLEEP_DELAY_MS);
  desktopSleepTimer.unref?.();
}

async function loadDesktopHomeForRestore() {
  const contents = mainWindow.webContents;
  let fail;
  let onReady;
  const ready = new Promise((resolve, reject) => {
    fail = reject;
    onReady = resolve;
    contents.once('dom-ready', onReady);
  });
  const failed = (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) fail(new Error(`Desktop navigation failed (${code}): ${description}`));
  };
  contents.on('did-fail-load', failed);
  try {
    // loadURL waits for the full load event (including nonessential images and
    // fonts). The app bridge is ready at DOM-ready, so restore the visible
    // screen without waiting for every decorative resource.
    mainWindow.loadURL(`${APP_ORIGIN}/home?desktop_restore=1`).catch(fail);
    await boundedDesktopStep(ready, 'Desktop DOM ready', 25000);
  } finally {
    contents.removeListener('dom-ready', onReady);
    contents.removeListener('did-fail-load', failed);
  }
}

async function wakeDesktopWindow() {
  clearTimeout(desktopSleepTimer);
  desktopSleepTimer = null;
  desktopWantsWake = true;
  if (desktopWakePromise) return desktopWakePromise;
  if (desktopSleepPhase === 'starting') {
    await desktopSleepPromise;
  }
  if (desktopSleepPhase !== 'dormant') return;
  if (desktopWakePromise) return desktopWakePromise;
  desktopSleepPhase = 'waking';
  desktopWakePromise = (async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) {
        const window = createWindow({ restoreFromSleep: true });
        await boundedDesktopStep(window.loadFile(suspendedPath),
          'Desktop shell load', 10000);
      }
      await loadDesktopHomeForRestore();
      if (!mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) {
        throw new Error('The saved session is no longer signed in');
      }
      const restored = await boundedDesktopStep(evalDesktop(mainWindow,
        'window.steenyDesktopSession?.restore', desktopSnapshot),
        'Desktop view restore', 25000);
      if (!restored) throw new Error('The server has no desktop restore bridge');
      if (desktopWindowIsHidden() && desktopHiddenToTray) {
        // The user minimized us again during a slow reload. Keep the audio
        // owner and avoid painting a full page nobody can currently see.
        if (tray) {
          saveWindowState();
          destroyingMainForSleep = true;
          mainWindow.destroy();
        } else {
          await mainWindow.loadFile(suspendedPath);
        }
        desktopSleepPhase = 'dormant';
        return;
      }
      if (backgroundPlayerWindow && !backgroundPlayerWindow.isDestroyed()) {
        const backgroundState = await evalDesktop(backgroundPlayerWindow,
          'window.steenyBackgroundPlayer?.state');
        const resumed = await boundedDesktopStep(evalDesktop(mainWindow,
          'window.steenyDesktopSession?.resumeAudio', backgroundState),
          'Desktop audio handoff', 15000);
        if (!resumed) throw new Error('Audio handoff did not finish');
        // The background stream kept advancing while the full player loaded.
        // Sample it again after the muted main stream is ready, then make the
        // final seek against the position returned by pause itself.
        const latestState = await evalDesktop(backgroundPlayerWindow,
          'window.steenyBackgroundPlayer?.state');
        const aligned = await boundedDesktopStep(evalDesktop(mainWindow,
          'window.steenyDesktopSession?.resumeAudio', latestState),
          'Desktop audio alignment', 15000);
        if (!aligned) throw new Error('Audio alignment did not finish');
        const finalState = await evalDesktop(backgroundPlayerWindow,
          'window.steenyBackgroundPlayer?.pause');
        const finished = await boundedDesktopStep(evalDesktop(mainWindow,
          'window.steenyDesktopSession?.finishAudioHandoff', finalState),
          'Desktop audio finish', 5000);
        if (finished === false) throw new Error('Audio playback could not align with background');
        closeBackgroundPlayer();
      }
      desktopSnapshot = null;
      desktopSleepPhase = 'awake';
      queueThumbarRefresh();
      if (desktopWindowIsHidden()) scheduleDesktopSleep();
    } catch (error) {
      console.warn('STEENY desktop restore:', error?.message || error);
      // Never kill the only playing audio if loading or seeking the full UI
      // fails. Another show/restore attempt can retry the handoff.
      if (backgroundPlayerWindow && !backgroundPlayerWindow.isDestroyed()) {
        if (mainWindow && !mainWindow.isDestroyed()
            && mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) {
          await evalDesktop(mainWindow, '(() => { const audio = document.getElementById("audioEl"); if (audio) { audio.pause(); audio.muted = false; } })')
            .catch(() => undefined);
        }
        await evalDesktop(backgroundPlayerWindow,
          'window.steenyBackgroundPlayer?.resume').catch(() => undefined);
      }
      // Equally, never strand the user behind the restore curtain if the
      // server rejects the snapshot or its bridge disappears during deploy.
      if (mainWindow && !mainWindow.isDestroyed()
          && mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) {
        await evalDesktop(mainWindow,
          '(() => document.documentElement.classList.remove("desktop-restoring"))')
          .catch(() => undefined);
      }
      desktopSleepPhase = 'dormant';
    } finally {
      desktopWakePromise = null;
    }
  })();
  return desktopWakePromise;
}

function showWindow() {
  desktopHiddenToTray = false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    wakeDesktopWindow().catch(error => console.warn('STEENY wake:', error));
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  wakeDesktopWindow().catch(error => console.warn('STEENY wake:', error));
}

function hideWindow() {
  desktopHiddenToTray = true;
  mainWindow?.hide();
  scheduleDesktopSleep();
}

function setupTray() {
  const icon = appIcon();
  if (!icon) return;
  try {
    tray = new Tray(icon.resize({ width: 24, height: 24 }));
  } catch {
    tray = null;
    return;
  }
  tray.setToolTip('STEENY — музыкальный плеер');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть STEENY', click: showWindow },
    { label: 'Скрыть в трей', click: hideWindow },
    { type: 'separator' },
    { label: 'Предыдущий трек', click: () => controlFromThumbar('previous') },
    { label: 'Воспроизвести / пауза', click: () => controlFromThumbar('toggle') },
    { label: 'Следующий трек', click: () => controlFromThumbar('next') },
    { type: 'separator' },
    {
      label: 'Проверить обновления',
      click: () => updates?.check({ manual: true }),
    },
    { type: 'separator' },
    {
      label: 'Выйти из STEENY',
      click: () => {
        quitting = true;
        rpc.destroy();
        app.quit();
      },
    },
  ]));
  tray.on('click', () => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized()) hideWindow();
    else showWindow();
  });
  tray.on('double-click', showWindow);
}

function configureSession() {
  const appSession = session.fromPartition('persist:steeny');
  // Logging out inside the web app has to drop the desktop token as well,
  // otherwise the next launch would sign straight back in and "выйти" would
  // look broken.
  appSession.webRequest.onCompleted(
    { urls: [`${APP_ORIGIN}/logout`, `${APP_ORIGIN}/logout?*`] },
    details => {
      if (details.method !== 'POST') return;
      signOut().catch(() => undefined);
    },
  );
  appSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      const mediaType = details?.mediaType;
      const origin = details?.securityOrigin || requestingOrigin;
      return permission === 'media'
        && isTrustedOrigin(origin)
        && (mediaType === undefined || mediaType === 'audio');
    },
  );
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = isTrustedOrigin(
      details?.requestingUrl || webContents?.getURL(),
    );
    const requestedMedia = Array.isArray(details?.mediaTypes)
      ? details.mediaTypes
      : [];
    const audioOnly = permission === 'media'
      && requestedMedia.length > 0
      && requestedMedia.every(mediaType => mediaType === 'audio');
    callback(trusted && audioOnly);
  });
  if (typeof appSession.setDisplayMediaRequestHandler === 'function') {
    appSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  }
  return appSession;
}

function sendPowerState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('power-state', !powerMonitor.isOnBatteryPower());
}

function createWindow({ restoreFromSleep = false } = {}) {
  const bounds = loadWindowState();
  latestPlaybackStatus = null;
  thumbarRejected = false;
  mainWindow = new BrowserWindow({
    width: bounds?.width || 1354,
    height: bounds?.height || 868,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 620,
    minHeight: 460,
    frame: false,
    transparent: false,
    resizable: true,
    show: false,
    skipTaskbar: MEMORY_PROBE,
    opacity: MEMORY_PROBE ? 0 : 1,
    title: 'STEENY',
    backgroundColor: '#15110e',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: true,
      spellcheck: false,
      session: appSession,
    },
  });

  // Keep Electron's own UA tokens intact. Cloudflare Turnstile cross-checks the
  // UA string against `navigator.userAgentData`, which always reports Chromium
  // here; hiding the `Electron/<version>` token makes the two disagree and the
  // widget hard-fails with "Сбой проверки" instead of showing its checkbox.
  const defaultUa = mainWindow.webContents.getUserAgent();
  mainWindow.webContents.setUserAgent(
    `${defaultUa} SteenyClient/${app.getVersion()}`,
  );
  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, legacyUrl) => {
    if (event.isMainFrame === false) return;
    const url = event.url || legacyUrl;
    if (isAllowedMainFrame(url)) return;
    event.preventDefault();
    openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    handlePossibleSignOut(url).catch(() => undefined);
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) {
      latestPlaybackStatus = null;
      queueThumbarRefresh();
    }
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('media-started-playing', () => {
    queueThumbarRefresh();
    if (desktopSleepPhase !== 'dormant' || !backgroundPlayerWindow
        || !mainWindow.webContents.getURL().startsWith(`${APP_ORIGIN}/home`)) return;
    // If a restore failed but the listener manually starts a track in the
    // reloaded UI, it takes ownership and the invisible player must stop.
    evalDesktop(backgroundPlayerWindow, 'window.steenyBackgroundPlayer?.pause')
      .catch(() => undefined)
      .finally(() => {
        closeBackgroundPlayer();
        desktopSnapshot = null;
        desktopSleepPhase = 'awake';
      });
  });
  mainWindow.webContents.on('media-paused', queueThumbarRefresh);
  mainWindow.webContents.on('did-finish-load', async () => {
    sendPowerState();
    resources.sync();
    queueThumbarRefresh();
    if (MEMORY_PROBE && !memoryProbeScheduled) {
      memoryProbeScheduled = true;
      setTimeout(async () => {
        if (process.env.STEENY_PROBE_FORCE_GC === '1') {
          await collectRendererGarbage(mainWindow?.webContents);
          await delay(700);
        }
        const metrics = app.getAppMetrics().map(item => ({
          type: item.type,
          workingSetKb: item.memory?.workingSetSize || 0,
        }));
        const totalKb = metrics.reduce((sum, item) => sum + item.workingSetKb, 0);
        let page = null;
        try {
          page = await mainWindow?.webContents.executeJavaScript(`({
            visibility: document.visibilityState,
            lowMemory: document.documentElement.classList.contains('steeny-low-memory-mode'),
            imageCount: document.images.length,
            detachedImages: document.querySelectorAll('[data-steeny-suspended-src]').length,
            detachedBackgrounds: document.querySelectorAll('[data-steeny-suspended-background]').length,
            videos: [...document.querySelectorAll('video')].map(v => ({
              id: v.id, src: Boolean(v.getAttribute('src')), paused: v.paused
            })),
            canvasCount: document.querySelectorAll('canvas').length
          })`);
        } catch { /* A navigation can race the probe. */ }
        console.log('STEENY_MEMORY_PROBE', JSON.stringify({
          url: mainWindow?.webContents.getURL(),
          sleepPhase: desktopSleepPhase,
          backgroundAudio: Boolean(backgroundPlayerWindow && !backgroundPlayerWindow.isDestroyed()),
          totalMiB: +(totalKb / 1024).toFixed(1),
          page,
          metrics,
        }));
        mainWindow?.restore();
        mainWindow?.showInactive();
        const restoreStartedAt = Date.now();
        await wakeDesktopWindow();
        console.log('STEENY_WAKE_PROBE', JSON.stringify({
          restoreMs: Date.now() - restoreStartedAt,
          url: mainWindow?.webContents.getURL(),
          sleepPhase: desktopSleepPhase,
        }));
        setTimeout(async () => {
          let restored = null;
          try {
            restored = await mainWindow?.webContents.executeJavaScript(`({
              visibility: document.visibilityState,
              lowMemory: document.documentElement.classList.contains('steeny-low-memory-mode'),
              animationsSuppressed: document.body.classList.contains('perf-no-anim'),
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              workspaceDisplay: document.querySelector('.app-window')
                ? getComputedStyle(document.querySelector('.app-window')).display : null,
              workspaceHeight: Math.round(document.querySelector('.app-window')?.getBoundingClientRect().height || 0)
            })`);
          } catch { /* A navigation can race the probe. */ }
          console.log('STEENY_RESTORE_PROBE', JSON.stringify(restored));
          quitting = true;
          app.quit();
        }, 1200).unref?.();
      }, 35000).unref?.();
    }
    if (SMOKE_TEST) {
      let smokeState = null;
      try {
        smokeState = await mainWindow.webContents.executeJavaScript(
          '({'
          + ' bridge: window.steenyElectron?.is_electron === true'
          + ' && document.documentElement.classList.contains("desktop-client"),'
          + ' legacyChannel: Boolean(document.querySelector("script[src^=\\"qrc:\\"]"))'
          + ' })',
        );
      } catch {
        smokeState = null;
      }
      if (!smokeState?.bridge || smokeState.legacyChannel) {
        console.error('STEENY_SMOKE_FAILED preload or bridge selection error');
        app.exit(1);
        return;
      }
      console.log(
        `STEENY_SMOKE_OK bridge=true legacy-channel=false`
        + ` url=${mainWindow.webContents.getURL()}`,
      );
      setTimeout(() => {
        quitting = true;
        app.quit();
      }, 500);
    }
  });
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, _description, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || offlineLoaded) return;
      offlineLoaded = true;
      mainWindow.loadFile(offlinePath);
    },
  );
  // Without these the window survives its own renderer: it stays on screen,
  // painted in backgroundColor, with no page inside it and no way back.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (SMOKE_TEST) {
      console.error(`STEENY_SMOKE_FAILED renderer gone: ${details?.reason}`);
      app.exit(1);
      return;
    }
    recovery.rendererGone(details);
  });
  mainWindow.on('unresponsive', () => recovery.unresponsive());
  mainWindow.on('responsive', () => recovery.responsive());
  // A throttled window legitimately stops beating, so the watchdog only judges
  // a window the user can actually see.
  heartbeatWatchdog = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const visible = mainWindow.isVisible() && !mainWindow.isMinimized();
    // A page still loading has not reached DOMContentLoaded, so it has not
    // started beating yet. On a slow connection that is ordinary, not a hang --
    // judging it would kill the very load it is waiting on, and the reload
    // would walk straight into the same timeout.
    const settled = !mainWindow.webContents.isLoading();
    recovery.checkHeartbeat(visible && settled);
  }, HEARTBEAT_CHECK_MS);
  heartbeatWatchdog.unref?.();
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const zoomShortcut = input.control
      && ['+', '-', '=', '0'].includes(input.key);
    if (zoomShortcut || (!DEVTOOLS && input.key === 'F12')) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE_TEST) {
      // Bind before show(), never after: show() emits 'show' synchronously, so
      // binding afterwards misses it. The manager would then sample
      // isVisible() at the one moment a compositor may not have mapped the
      // surface yet, latch into low-memory mode, and never see an event to
      // correct itself -- a permanently animation-less, video-less window.
      resources.bind(mainWindow);
      if (MEMORY_PROBE && !restoreFromSleep) {
        // A never-shown BrowserWindow reports document.visibilityState as
        // "visible" on Chromium. Exercise the actual minimize path instead.
        mainWindow.showInactive();
        mainWindow.minimize();
      } else mainWindow.show();
      queueThumbarRefresh();
    }
    if (DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('close', event => {
    if (quitting) return;
    if (!tray) {
      quitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    hideWindow();
  });
  mainWindow.on('moved', windowStateSaver.schedule);
  mainWindow.on('resized', windowStateSaver.schedule);
  mainWindow.on('hide', scheduleDesktopSleep);
  mainWindow.on('restore', () => {
    queueThumbarRefresh();
    wakeDesktopWindow().catch(error => console.warn('STEENY wake:', error));
  });
  mainWindow.on('show', () => {
    queueThumbarRefresh();
    wakeDesktopWindow().catch(error => console.warn('STEENY wake:', error));
  });
  mainWindow.on('closed', () => {
    const sleeping = destroyingMainForSleep;
    destroyingMainForSleep = false;
    clearTimeout(desktopSleepTimer);
    desktopSleepTimer = null;
    if (!sleeping) closeBackgroundPlayer();
    windowStateSaver.cancel();
    resources.unbind();
    recovery.dispose();
    if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);
    heartbeatWatchdog = null;
    mainWindow = null;
    latestPlaybackStatus = null;
  });

  if (!restoreFromSleep) enterApp();
  return mainWindow;
}

function installIpcHandlers() {
  const fromMainWindow = event => (
    mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
  );
  ipcMain.on('ui:heartbeat', event => {
    if (fromMainWindow(event)) recovery.heartbeat();
  });
  ipcMain.on('playback:state', (event, rawStatus) => {
    if (!fromMainWindow(event) || !rawStatus || typeof rawStatus !== 'object') return;
    const hasTrack = rawStatus.hasTrack === true;
    latestPlaybackStatus = {
      hasTrack,
      playing: hasTrack && rawStatus.playing === true,
      canPrevious: hasTrack && rawStatus.canPrevious === true,
      canNext: hasTrack && rawStatus.canNext === true,
      title: String(rawStatus.title || '').slice(0, 120),
      artist: String(rawStatus.artist || '').slice(0, 120),
    };
    queueThumbarRefresh();
  });
  ipcMain.on('playback:control-result', (event, result) => {
    if (!fromMainWindow(event)) return;
    if (result?.clicked === false) {
      console.warn(`STEENY taskbar: ${result.action} control was not found in the player`);
    }
  });
  ipcMain.on('window:close', event => {
    if (!fromMainWindow(event)) return;
    mainWindow.close();
  });
  ipcMain.on('window:minimize', event => {
    if (fromMainWindow(event)) mainWindow.minimize();
  });
  ipcMain.on('window:move', (event, position) => {
    if (!fromMainWindow(event)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    try {
      mainWindow.setPosition(Math.round(x), Math.round(y));
    } catch {
      // Wayland owns window positioning; CSS app-region still provides drag.
    }
  });
  ipcMain.handle('window:get-position', event => {
    if (!fromMainWindow(event)) return { x: 0, y: 0 };
    const [x, y] = mainWindow?.getPosition() || [0, 0];
    return { x, y };
  });
  ipcMain.on('window:set-zoom', (event, rawFactor) => {
    if (!fromMainWindow(event)) return;
    const factor = Math.max(0.5, Math.min(2, Number(rawFactor) || 1));
    mainWindow?.webContents.setZoomFactor(factor);
  });
  ipcMain.on('external:open', (event, rawUrl) => {
    if (fromMainWindow(event)) openExternal(rawUrl);
  });
  ipcMain.handle('rpc:update', async (event, dataJson) => {
    if (!fromMainWindow(event)) return { ok: false, error: 'forbidden' };
    // Rich Presence only ever gets title/artist/cover/timestamps -- the lyric
    // or status text is stripped out in rpc.js and delivered exclusively
    // through setStatus() below.
    rpc.update(dataJson);
    let parsed;
    try {
      parsed = JSON.parse(dataJson);
    } catch {
      return { ok: false, error: 'Некорректные данные.' };
    }
    const rawText = String(parsed?.text ?? parsed?.lyric ?? '');
    const emoji = String(parsed?.emoji ?? '');
    const title = String(parsed?.title || '').trim();
    const artist = String(parsed?.artist || '').trim();
    const position = Number(parsed?.position) || 0;
    const text = parsed?.template
      ? applyStatusTemplate(parsed.template, { text: rawText, title, artist, position })
      : rawText.replace(/\s+/g, ' ').trim().slice(0, 128);
    if (!text && !emoji) return clearCustomStatus();
    return pushCustomStatus(text, emoji);
  });
  ipcMain.handle('rpc:clear', event => {
    if (!fromMainWindow(event)) return { ok: false, error: 'forbidden' };
    rpc.clear();
    return clearCustomStatus();
  });
  ipcMain.handle('discord-token:save', async (event, rawValue) => {
    if (!fromMainWindow(event)) throw new Error('forbidden');
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) return { ok: false, error: 'Введите токен.' };
    try {
      const res = await checkToken(value);
      if (!res.ok) {
        return {
          ok: false,
          error: res.status === 401
            ? 'Discord отклонил токен (401): он неверный или истёк.'
            : `Discord ответил кодом ${res.status} при проверке токена.`,
        };
      }
    } catch (error) {
      return { ok: false, error: error?.message || 'Не удалось проверить токен.' };
    }
    writeDiscordToken(value);
    return { ok: true };
  });
  ipcMain.handle('discord-token:has', event => {
    if (!fromMainWindow(event)) return false;
    return Boolean(readSettings().discord_token);
  });
  ipcMain.handle('backend:retry', event => {
    if (!fromMainWindow(event)) return false;
    return enterApp();
  });
  ipcMain.handle('auth:get-state', event => {
    if (!fromMainWindow(event)) return null;
    return authState;
  });
  ipcMain.handle('auth:begin', event => {
    if (!fromMainWindow(event)) return null;
    return beginLink();
  });
  ipcMain.on('auth:cancel', event => {
    if (!fromMainWindow(event)) return;
    linkAbort?.abort();
  });
  ipcMain.on('auth:open-link', event => {
    if (!fromMainWindow(event)) return;
    if (authState.status === 'waiting' && authState.verificationUrl) {
      openExternal(authState.verificationUrl);
    }
  });
  ipcMain.handle('auth:sign-out', event => {
    if (!fromMainWindow(event)) return false;
    return signOut().then(() => true);
  });
  ipcMain.handle('update:get-state', event => {
    if (!fromMainWindow(event)) return null;
    return updates?.getState() || null;
  });
  ipcMain.handle('update:check', async event => {
    if (!fromMainWindow(event) || !updates) return null;
    await updates.check({ manual: true });
    return updates.getState();
  });
  ipcMain.on('update:install', event => {
    if (fromMainWindow(event)) updates?.install();
  });
  ipcMain.on('update:open-releases', event => {
    if (fromMainWindow(event)) updates?.openReleases();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--memory-probe')) showWindow();
  });
  // Chromium restarts a dead GPU process by itself, falling back to software
  // rendering when it has to, so this only records what happened. A run of
  // these lines next to a user's "the window went blank" is the difference
  // between guessing and knowing.
  app.on('child-process-gone', (_event, details) => {
    if (details?.type === 'Utility' && details?.reason === 'clean-exit') return;
    console.warn(
      `STEENY child process gone: type=${details?.type}`
      + ` reason=${details?.reason} exit=${details?.exitCode}`,
    );
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    app.setName('STEENY');
    if (process.platform === 'win32') {
      app.setAppUserModelId('fun.steeny.desktop');
    }
    appSession = configureSession();
    tokenStore = createTokenStore({ app, safeStorage });
    linkClient = createLinkClient({
      origin: APP_ORIGIN,
      // The session's own fetch keeps the handoff cookie in the same partition
      // the window uses; net.fetch would drop it into the default session.
      fetchImpl: (input, init) => appSession.fetch(input, init),
      clientInfo: {
        name: 'STEENY',
        version: app.getVersion(),
        platform: process.platform,
      },
    });
    updates = createUpdateManager({
      app,
      autoUpdater,
      dialog,
      shell,
      getMainWindow: () => mainWindow,
      showMainWindow: showWindow,
      disabled: SMOKE_TEST || MEMORY_PROBE,
      manualOnly: process.platform === 'linux' && !process.env.APPIMAGE,
    });
    installIpcHandlers();
    createWindow();
    setupTray();
    updates.start();
    powerMonitor.on('on-ac', sendPowerState);
    powerMonitor.on('on-battery', sendPowerState);
    powerMonitor.on('resume', () => updates?.check());
  });

  app.on('activate', () => {
    if (mainWindow || desktopSleepPhase !== 'awake') showWindow();
    else createWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(thumbarRefreshTimer);
    resources.unbind();
    updates?.stop();
    windowStateSaver.flush();
    rpc.destroy();
  });
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
    // The tray keeps background playback alive on Windows/Linux.
  });
}
