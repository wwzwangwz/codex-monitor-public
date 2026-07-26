const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { waitForSessionState } = require('../scripts/validation-support');

test('waits until the monitored session reaches the required state', async () => {
  const socket = new EventEmitter();
  const waiting = waitForSessionState({
    socket,
    threadId: '00000000-0000-4000-8000-000000000105',
    initialSnapshot: {
      type: 'snapshot',
      sessions: [{ id: '00000000-0000-4000-8000-000000000105', state: 'running' }],
    },
    expectedState: 'blocked',
    timeoutMs: 1000,
  });

  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'snapshot',
    sessions: [{ id: '00000000-0000-4000-8000-000000000105', state: 'blocked' }],
  })));

  assert.equal((await waiting).state, 'blocked');
});
