const test = require('node:test');
const assert = require('node:assert/strict');
const { registerNativeChannelIpc } = require('../src/lib/native-channel-ipc');

test('registers only bounded native-channel inspection and repair IPC', async () => {
  const handlers = new Map();
  let repairs = 0;
  const controller = {
    async get() {
      return {
        state: 'offline',
        ready: false,
        busy: false,
        message: '9229 未开启，点击按钮修复',
        executablePath: 'C:\\must-not-cross-ipc\\ChatGPT.exe',
      };
    },
    async repair() {
      repairs += 1;
      return {
        state: 'ready',
        ready: true,
        busy: false,
        message: 'Codex 原生信道已修复',
        pid: 1234,
      };
    },
  };
  registerNativeChannelIpc({
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
    getController: () => controller,
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    'native-channel:get',
    'native-channel:repair',
  ]);
  assert.deepEqual(await handlers.get('native-channel:get')(), {
    state: 'offline',
    ready: false,
    busy: false,
    message: '9229 未开启，点击按钮修复',
  });
  assert.deepEqual(await handlers.get('native-channel:repair')(), {
    state: 'ready',
    ready: true,
    busy: false,
    message: 'Codex 原生信道已修复',
  });
  assert.equal(repairs, 1);
});

test('rejects native-channel IPC before controller initialization', async () => {
  const handlers = new Map();
  registerNativeChannelIpc({
    ipcMain: {
      handle(name, handler) {
        handlers.set(name, handler);
      },
    },
    getController: () => null,
  });

  await assert.rejects(handlers.get('native-channel:get')(), /not initialized/i);
  await assert.rejects(handlers.get('native-channel:repair')(), /not initialized/i);
});

