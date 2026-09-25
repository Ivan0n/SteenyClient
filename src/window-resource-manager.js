'use strict';

const DEFAULT_PURGE_DELAY_MS = 2500;
// What the renderer is allowed to hold before the watchdog reclaims. The
// budget deliberately covers the renderer alone: a JS purge cannot shrink the
// GPU, network or browser processes, and their footprint is a fixed startup
// cost rather than something that grows. The renderer is the one that
// ratchets upwards over a long listening session, so it is the one worth
// watching. Summing every process would also be meaningless on Linux, where
// getAppMetrics() reports RSS and the shared pages get counted once per
// process.
const DEFAULT_MEMORY_BUDGET_KB = 200 * 1024;
const DEFAULT_WATCHDOG_INTERVAL_MS = 30000;
// Purging is a full GC; back-to-back runs would cost more than they reclaim.
const DEFAULT_PURGE_COOLDOWN_MS = 60000;

// Only collectGarbage. Memory.forciblyPurgeJavaScriptMemory reclaims more on
// paper -- it is what Chromium runs for its own backgrounded tabs -- but under
// Electron it leaves the renderer permanently unresponsive: the command
// reports success and the debugger detaches cleanly, yet the process never
// executes script again, so the window comes back from the tray frozen with
// its animations dead. Measured directly against this app; do not re-add it
// without re-testing a hide/show cycle.
const PURGE_COMMANDS = ['HeapProfiler.collectGarbage'];

async function collectRendererGarbage(webContents) {
  if (!webContents || webContents.isDestroyed?.()) return false;
  const debuggerClient = webContents.debugger;
  if (!debuggerClient || debuggerClient.isAttached()) return false;
  let attached = false;
  try {
    debuggerClient.attach('1.3');
    attached = true;
    for (const command of PURGE_COMMANDS) {
      try {
        await debuggerClient.sendCommand(command);
      } catch {
        // Older Chromium builds may not expose every purge command; whatever
        // did run has already reclaimed what it could.
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (attached) {
      try {
        debuggerClient.detach();
      } catch {
        // The renderer may have closed while memory was being collected.
      }
    }
  }
}

// app.getAppMetrics() reports every helper process the app owns. `type` is
// 'Browser' for the main process, 'GPU'/'Utility'/'Zygote' for the helpers,
// and 'Tab' for a renderer.
function workingSetKb(metrics, predicate = () => true) {
  if (!Array.isArray(metrics)) return 0;
  return metrics.reduce((total, entry) => {
    if (!entry || !predicate(entry)) return total;
    const size = Number(entry?.memory?.workingSetSize);
    return total + (Number.isFinite(size) ? size : 0);
  }, 0);
}

function rendererWorkingSetKb(metrics) {
  return workingSetKb(metrics, entry => entry.type === 'Tab');
}

function totalWorkingSetKb(metrics) {
  return workingSetKb(metrics);
}

function createWindowResourceManager({
  purgeDelayMs = DEFAULT_PURGE_DELAY_MS,
  memoryBudgetKb = DEFAULT_MEMORY_BUDGET_KB,
  watchdogIntervalMs = DEFAULT_WATCHDOG_INTERVAL_MS,
  purgeCooldownMs = DEFAULT_PURGE_COOLDOWN_MS,
  getMetrics = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setPoll = setInterval,
  clearPoll = clearInterval,
  now = () => Date.now(),
  collectGarbage = collectRendererGarbage,
} = {}) {
  let window = null;
  let lowMemory = null;
  let purgeTimer = null;
  let watchdogTimer = null;
  // -Infinity, not 0: "never purged" has to stay distinguishable from "purged
  // at time zero", or the very first check would sit out its own cooldown.
  let lastPurgeAt = -Infinity;
  const listeners = [];

  function backgrounded() {
    if (!window || window.isDestroyed?.()) return false;
    return Boolean(window.isMinimized?.() || !window.isVisible?.());
  }

  function cancelPurge() {
    if (purgeTimer !== null) clearTimer(purgeTimer);
    purgeTimer = null;
  }

  function publish(force = false) {
    if (!window || window.isDestroyed?.()) return false;
    const next = backgrounded();
    if (!force && next === lowMemory) return next;
    lowMemory = next;
    const webContents = window.webContents;
    try {
      // Audio playback is not suspended. Chromium only throttles visual
      // rendering, animation frames and background JavaScript timers.
      webContents.setBackgroundThrottling?.(true);
      webContents.send('resource-mode', {
        lowMemory,
        reason: window.isMinimized?.() ? 'minimized' : lowMemory ? 'hidden' : 'visible',
      });
    } catch {
      return next;
    }

    cancelPurge();
    if (lowMemory) {
      purgeTimer = setTimer(() => {
        purgeTimer = null;
        // A hidden page is not necessarily a large page. Check its actual
        // renderer footprint before attaching the debugger for a full GC.
        if (getMetrics) checkMemory();
        else purge();
      }, purgeDelayMs);
      purgeTimer?.unref?.();
    }
    return next;
  }

  // The single choke point for reclaiming, and the only place the "is it safe
  // right now" question is answered. A purge attaches the DevTools debugger
  // and forces a full GC inside the renderer, which stalls that process
  // outright -- indistinguishable from the UI freezing. Checking here rather
  // than at the call sites means a delayed purge is re-validated when it
  // actually fires: by then the window may well be back on screen.
  function purge() {
    if (!window || window.isDestroyed?.()) return false;
    if (!backgrounded()) return false;
    lastPurgeAt = now();
    const result = collectGarbage(window.webContents);
    result?.catch?.(() => undefined);
    return true;
  }

  // Reclaims only when the app is over budget AND out of sight, never more
  // often than the cooldown allows.
  //
  // The backgrounded check is not an optimization, it is the whole safety
  // margin: a purge attaches the DevTools debugger and runs a forced full GC
  // inside the renderer, which stalls that process outright. Chromium reserves
  // this for backgrounded tabs for exactly that reason. Running it against a
  // visible window is indistinguishable from the UI freezing -- so a visible
  // window over budget is simply left alone until it is hidden or minimized.
  function checkMemory() {
    if (!getMetrics || !window || window.isDestroyed?.()) return null;
    // Visible renderers cannot be purged safely, so polling their metrics
    // every 30 seconds is wasted work on the main thread.
    if (!backgrounded()) return null;
    let usedKb;
    try {
      usedKb = rendererWorkingSetKb(getMetrics());
    } catch {
      return null;
    }
    if (usedKb <= memoryBudgetKb) return usedKb;
    if (now() - lastPurgeAt < purgeCooldownMs) return usedKb;
    purge();
    return usedKb;
  }

  function cancelWatchdog() {
    if (watchdogTimer !== null) clearPoll(watchdogTimer);
    watchdogTimer = null;
  }

  function startWatchdog() {
    cancelWatchdog();
    if (!getMetrics || watchdogIntervalMs <= 0) return;
    watchdogTimer = setPoll(checkMemory, watchdogIntervalMs);
    watchdogTimer?.unref?.();
  }

  function bind(nextWindow) {
    unbind();
    window = nextWindow;
    if (!window || window.isDestroyed?.()) return;
    for (const eventName of ['minimize', 'restore', 'hide', 'show']) {
      const listener = () => publish();
      window.on(eventName, listener);
      listeners.push([eventName, listener]);
    }
    publish(true);
    startWatchdog();
  }

  function unbind() {
    cancelPurge();
    cancelWatchdog();
    if (window && !window.isDestroyed?.()) {
      for (const [eventName, listener] of listeners) {
        window.removeListener(eventName, listener);
      }
    }
    listeners.length = 0;
    window = null;
    lowMemory = null;
    lastPurgeAt = -Infinity;
  }

  return Object.freeze({
    bind,
    unbind,
    sync: () => publish(true),
    isLowMemory: () => lowMemory === true,
    checkMemory,
    usageKb: () => (getMetrics ? {
      renderer: rendererWorkingSetKb(getMetrics()),
      total: totalWorkingSetKb(getMetrics()),
    } : { renderer: 0, total: 0 }),
  });
}

module.exports = {
  DEFAULT_PURGE_DELAY_MS,
  DEFAULT_MEMORY_BUDGET_KB,
  DEFAULT_WATCHDOG_INTERVAL_MS,
  DEFAULT_PURGE_COOLDOWN_MS,
  collectRendererGarbage,
  createWindowResourceManager,
  rendererWorkingSetKb,
  totalWorkingSetKb,
};
