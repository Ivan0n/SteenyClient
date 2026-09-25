'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let lastChargingState = null;
// What the main process last asked for, and what is actually in effect. They
// differ whenever the main process says "hidden" about a page Chromium still
// reports as visible.
let lowMemoryMode = false;
let degraded = false;
let domReady = false;
const suspendedVideos = new Map();
const RESOURCE_STYLE_ID = 'steeny-electron-resource-style';
// The main process watches for these. Their whole value is that they stop
// arriving the instant the renderer stops running script, which is precisely
// the state Chromium's own 'unresponsive' event reports late or not at all.
const HEARTBEAT_MS = 5000;

function installResourceStyle() {
  if (!document.head || document.getElementById(RESOURCE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = RESOURCE_STYLE_ID;
  style.textContent = `
    html.steeny-low-memory-mode *,
    html.steeny-low-memory-mode *::before,
    html.steeny-low-memory-mode *::after {
      animation-play-state: paused !important;
      transition-duration: 0s !important;
    }
    html.steeny-low-memory-mode .app-bg::before {
      content: none !important;
      background-image: none !important;
    }
    html.steeny-low-memory-mode :is(
      .interface-wallpaper-video,
      .fp-video-bg-layer,
      .fp-bg,
      .fp-bg2,
      .radio-video
    ) {
      display: none !important;
      background-image: none !important;
      filter: none !important;
      backdrop-filter: none !important;
    }
  `;
  document.head.appendChild(style);
}

function suspendHeavyVideos() {
  for (const id of ['appearanceWallpaperVideo', 'fpVideo', 'radioVideo']) {
    const video = document.getElementById(id);
    if (!video) continue;
    const previous = suspendedVideos.get(video);
    // The web app may replace a visual stream while hidden (radio reconnects
    // periodically). A missing src means it is already suspended; a new src
    // needs to be detached too, and becomes the one restored later.
    const explicitSrc = video.getAttribute('src') || '';
    if (previous && !explicitSrc) continue;
    const src = explicitSrc || video.currentSrc || '';
    if (!src) continue;
    suspendedVideos.set(video, {
      src,
      currentTime: Number(video.currentTime) || 0,
      wasPlaying: !video.paused && !video.ended,
    });
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      // A renderer navigation can invalidate a media element mid-cleanup.
    }
  }
}

function restoreHeavyVideos() {
  const audio = document.getElementById('audioEl');
  for (const [video, state] of suspendedVideos) {
    if (!video.isConnected || !state.src) continue;
    // The page may have replaced the source while hidden. Its new choice wins.
    if (video.getAttribute('src')) continue;
    if (video.id === 'radioVideo') {
      // A changed or stopped station must not resurrect the old video stream.
      const audioSrc = audio?.currentSrc || audio?.getAttribute('src') || '';
      try {
        const videoPath = new URL(state.src, document.baseURI).pathname;
        const audioPath = new URL(audioSrc, document.baseURI).pathname;
        const videoId = videoPath.match(/^\/api\/radio\/video\/(.+)$/)?.[1];
        const audioId = audioPath.match(/^\/api\/radio\/stream\/(.+)$/)?.[1];
        if (!videoId || videoId !== audioId) continue;
      } catch {
        continue;
      }
    }
    const resume = () => {
      const targetTime = video.id === 'fpVideo' && audio
        ? Number(audio.currentTime) || state.currentTime
        : state.currentTime;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        try {
          video.currentTime = Math.max(0, targetTime % video.duration);
        } catch {
          // Some streams do not allow seeking until more data is buffered.
        }
      }
      const shouldPlay = state.wasPlaying
        || (video.id === 'fpVideo' && audio && !audio.paused && !audio.ended);
      if (shouldPlay) video.play().catch(() => undefined);
    };
    try {
      video.setAttribute('src', state.src);
      video.addEventListener('loadedmetadata', resume, { once: true });
      video.load();
      if (video.readyState >= 1) resume();
    } catch {
      // The web app can recreate the video while the window is minimized.
    }
  }
  suspendedVideos.clear();
}


function dispatchResourceMode() {
  try {
    window.dispatchEvent(new CustomEvent('steeny-resource-mode', {
      detail: { lowMemory: degraded },
    }));
  } catch {
    // The remote page does not need this event for the built-in cleanup.
  }
}

// document.visibilityState is Chromium's own answer, and it cannot disagree
// with what the user is actually looking at. The main process only infers
// visibility from window state, which a compositor can report late or wrongly
// -- and a single wrong "hidden" there used to strip animations and video
// sources from a window sitting in plain sight, with no event left to undo it.
// Degrading is therefore gated on both signals agreeing; restoring needs only
// one, because being wrong in that direction merely costs a little memory.
function pageHidden() {
  return document.visibilityState === 'hidden';
}

function applyResourceMode(payload) {
  if (payload && 'lowMemory' in payload) lowMemoryMode = Boolean(payload.lowMemory);
  if (!domReady || !document.documentElement) return;
  degraded = lowMemoryMode && pageHidden();
  installResourceStyle();
  document.documentElement.classList.toggle('steeny-low-memory-mode', degraded);
  if (degraded) suspendHeavyVideos();
  else restoreHeavyVideos();
  dispatchResourceMode();
}

function deliverPowerState(charging) {
  lastChargingState = !!charging;
  try {
    window.__steenySetCharging?.(lastChargingState);
  } catch {
    // The page may not have installed its hook yet.
  }
}

function makeTitlebarControlsInteractive() {
  // The web UI owns the frameless titlebar. Keep its home/logo control out of
  // Electron's drag region even while an older cached page stylesheet is used.
  document.querySelector('.titlebar .logo')
    ?.style.setProperty('-webkit-app-region', 'no-drag', 'important');
}

// Each of these channels has exactly one consumer, but the web app is free to
// re-register on re-init or a route change. Plain ipcRenderer.on would stack a
// new listener every time and never drop the old one -- the callbacks and
// everything they close over would be retained for the life of the page, and
// each event would run the same handler N times over. Swapping the previous
// listener keeps re-registration idempotent.
const channelListeners = new Map();
function subscribe(channel, callback, transform = value => value) {
  if (typeof callback !== 'function') return;
  const previous = channelListeners.get(channel);
  if (previous) ipcRenderer.removeListener(channel, previous);
  const listener = (_event, payload) => callback(transform(payload));
  channelListeners.set(channel, listener);
  ipcRenderer.on(channel, listener);
}

const bridge = Object.freeze({
  close_app: () => ipcRenderer.send('window:close'),
  minimize_app: () => ipcRenderer.send('window:minimize'),
  start_window_drag: () => undefined,
  move_window: (x, y) => ipcRenderer.send('window:move', { x, y }),
  get_pos: callback => {
    ipcRenderer.invoke('window:get-position').then(position => {
      callback?.(JSON.stringify(position));
    }).catch(() => callback?.('{"x":0,"y":0}'));
  },
  set_zoom_factor: factor => ipcRenderer.send('window:set-zoom', factor),
  open_external_url: url => ipcRenderer.send('external:open', url),
  update_rpc: dataJson => ipcRenderer.invoke('rpc:update', dataJson),
  clear_rpc: () => ipcRenderer.invoke('rpc:clear'),
  save_discord_token: value => ipcRenderer.invoke('discord-token:save', value),
  has_discord_token: () => ipcRenderer.invoke('discord-token:has'),
  on_rpc_latency: callback => subscribe(
    'rpc:latency', callback, ms => Number(ms) || 0,
  ),
  retry_backend: () => ipcRenderer.invoke('backend:retry'),
  get_update_state: () => ipcRenderer.invoke('update:get-state'),
  check_for_updates: () => ipcRenderer.invoke('update:check'),
  install_update: () => ipcRenderer.send('update:install'),
  open_update_page: () => ipcRenderer.send('update:open-releases'),
  // Browser-based sign-in. Only the local link screen calls these; the web app
  // never sees a token, it keeps using the cookie session as before.
  auth_get_state: () => ipcRenderer.invoke('auth:get-state'),
  auth_begin: () => ipcRenderer.invoke('auth:begin'),
  auth_cancel: () => ipcRenderer.send('auth:cancel'),
  auth_open_link: () => ipcRenderer.send('auth:open-link'),
  auth_sign_out: () => ipcRenderer.invoke('auth:sign-out'),
  on_auth_state: callback => subscribe('auth:state', callback),
  // The effective mode, not what the main process asked for -- the page must
  // see what is actually applied to it.
  is_low_memory_mode: () => degraded,
  on_resource_mode: callback => subscribe(
    'resource-mode', callback, state => ({ ...state, lowMemory: degraded }),
  ),
  on_update_state: callback => subscribe('update:state', callback),
  is_electron: true,
});

contextBridge.exposeInMainWorld('steenyElectron', bridge);

ipcRenderer.on('power-state', (_event, charging) => {
  deliverPowerState(charging);
});

ipcRenderer.on('resource-mode', (_event, state) => {
  applyResourceMode(state);
});

// Chromium flips this itself when the window is minimized, hidden or occluded,
// so it also serves as the recovery path: should the main process ever leave a
// stale "hidden" behind, the first moment the page is genuinely visible undoes
// the degradation instead of leaving the window frozen-looking for good.
document.addEventListener('visibilitychange', () => applyResourceMode());

function beat() {
  try {
    if (degraded) suspendHeavyVideos();
    ipcRenderer.send('ui:heartbeat');
  } catch {
    // The renderer is being torn down; there is nothing left to report to.
  }
}

window.addEventListener('DOMContentLoaded', () => {
  domReady = true;
  document.documentElement.classList.add('desktop-client', 'electron-client');
  makeTitlebarControlsInteractive();
  if (lastChargingState !== null) deliverPowerState(lastChargingState);
  applyResourceMode();
  // Report immediately so the watchdog starts from a fresh page rather than
  // counting the load itself against the timeout.
  beat();
  setInterval(beat, HEARTBEAT_MS);
});
