'use strict';

function createDebouncedWriter(write, {
  delayMs = 300,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    cancel();
    timer = setTimer(() => {
      timer = null;
      write();
    }, delayMs);
    timer?.unref?.();
  }

  function flush() {
    cancel();
    write();
  }

  return Object.freeze({ schedule, flush, cancel });
}

module.exports = { createDebouncedWriter };
