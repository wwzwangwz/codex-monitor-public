const test = require('node:test');
const assert = require('node:assert/strict');
const { sendIfAlive } = require('../src/lib/window-events');

test('sends renderer events while the window is alive', () => {
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args) => sent.push(args),
    },
  };

  assert.equal(sendIfAlive(window, 'controller:update', ['node']), true);
  assert.deepEqual(sent, [['controller:update', ['node']]]);
});

test('does not send after the browser window is destroyed', () => {
  const window = {
    isDestroyed: () => true,
    webContents: { send: () => assert.fail('must not send') },
  };

  assert.equal(sendIfAlive(window, 'controller:update', []), false);
});

test('does not send after web contents are destroyed', () => {
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => true,
      send: () => assert.fail('must not send'),
    },
  };

  assert.equal(sendIfAlive(window, 'controller:update', []), false);
});
