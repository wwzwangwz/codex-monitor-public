const test = require('node:test');
const assert = require('node:assert/strict');
const { registerRelayIpc } = require('../src/lib/relay-ipc');

test('registers bounded Relay IPC handlers against the current controller', async () => {
  const handlers = new Map();
  const setCalls = [];
  const controller = {
    get() {
      return {
        enabled: false,
        baseUrl: 'wss://relay.example.com/codex-monitor',
        connected: false,
        message: '远程中继已关闭',
      };
    },
    set(value) {
      setCalls.push(value);
      return { ...this.get(), ...value };
    },
  };
  registerRelayIpc({
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
    getController: () => controller,
  });

  assert.deepEqual([...handlers.keys()].sort(), ['relay:get', 'relay:set']);
  assert.equal((await handlers.get('relay:get')()).enabled, false);

  const result = await handlers.get('relay:set')(null, {
    enabled: true,
    baseUrl: 'wss://relay.example',
    token: 'must-not-cross-ipc',
    publisherFactory: 'must-not-cross-ipc',
  });
  assert.deepEqual(setCalls, [{
    enabled: true,
    baseUrl: 'wss://relay.example',
  }]);
  assert.equal(result.enabled, true);
  assert.equal(JSON.stringify(setCalls).includes('must-not-cross-ipc'), false);
});

test('returns an explicit unavailable result before Relay initialization', () => {
  const handlers = new Map();
  registerRelayIpc({
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
    getController: () => null,
  });

  assert.throws(() => handlers.get('relay:get')(), /not initialized/i);
  assert.throws(() => handlers.get('relay:set')(null, { enabled: true }), /not initialized/i);
});
