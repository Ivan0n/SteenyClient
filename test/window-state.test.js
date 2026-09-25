'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDebouncedWriter } = require('../src/window-state');

test('window state is saved once after a burst of move and resize events', () => {
  const pending = new Map();
  let nextId = 0;
  let writes = 0;
  const saver = createDebouncedWriter(() => { writes += 1; }, {
    setTimer: callback => {
      const id = ++nextId;
      pending.set(id, callback);
      return id;
    },
    clearTimer: id => pending.delete(id),
  });

  saver.schedule();
  saver.schedule();
  saver.schedule();
  assert.equal(pending.size, 1);
  assert.equal(writes, 0);
  const [id, callback] = pending.entries().next().value;
  pending.delete(id);
  callback();
  assert.equal(writes, 1);

  saver.schedule();
  saver.flush();
  assert.equal(pending.size, 0);
  assert.equal(writes, 2);

  saver.schedule();
  saver.cancel();
  assert.equal(pending.size, 0);
  assert.equal(writes, 2);
});
