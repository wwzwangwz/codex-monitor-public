const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installTerminationHandlers } = require('../src/lib/termination');

test('SIGTERM and SIGINT request one graceful Electron quit', () => {
  const processRef = new EventEmitter();
  let quits = 0;
  const remove = installTerminationHandlers({ processRef, quit: () => { quits += 1; } });

  processRef.emit('SIGTERM');
  processRef.emit('SIGINT');
  assert.equal(quits, 1);

  remove();
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(processRef.listenerCount('SIGINT'), 0);
});

test('termination handler requires an explicit quit boundary', () => {
  assert.throws(() => installTerminationHandlers({ processRef: new EventEmitter() }), /quit callback/);
});
