const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CODEX_DEBUG_ARGUMENTS,
  CodexNativeChannelController,
  createWindowsCodexProcessManager,
  inspectCodexNativeChannel,
  validateCodexExecutablePath,
} = require('../src/lib/codex-native-channel');

const readyPage = {
  type: 'page',
  url: 'app://-/index.html?initialRoute=%2F',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/page/codex-main',
};

test('reports a real Codex main page as ready without restarting Codex', async () => {
  let restarts = 0;
  const controller = new CodexNativeChannelController({
    inspect: async () => true,
    processManager: {
      async restart() {
        restarts += 1;
      },
    },
  });

  assert.deepEqual(await controller.get(), {
    state: 'ready',
    ready: true,
    busy: false,
    message: 'Codex 原生信道正常',
  });
  assert.equal(restarts, 0);
});

test('an offline repair restarts once and waits for the native page', async () => {
  const inspections = [false, false, true];
  const restartArguments = [];
  const controller = new CodexNativeChannelController({
    inspect: async () => inspections.shift() ?? true,
    processManager: {
      async restart(args) {
        restartArguments.push(args);
      },
    },
    delay: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 10,
  });

  assert.deepEqual(await controller.repair(), {
    state: 'ready',
    ready: true,
    busy: false,
    message: 'Codex 原生信道已修复',
  });
  assert.deepEqual(restartArguments, [CODEX_DEBUG_ARGUMENTS]);
});

test('concurrent repair clicks share one Codex restart', async () => {
  let releaseRestart;
  const restartGate = new Promise((resolve) => {
    releaseRestart = resolve;
  });
  let inspections = 0;
  let restarts = 0;
  const controller = new CodexNativeChannelController({
    inspect: async () => {
      inspections += 1;
      return inspections > 2;
    },
    processManager: {
      async restart() {
        restarts += 1;
        await restartGate;
      },
    },
    delay: async () => {},
    timeoutMs: 100,
    pollIntervalMs: 10,
  });

  const first = controller.repair();
  const second = controller.repair();
  releaseRestart();

  assert.deepEqual(await first, await second);
  assert.equal(restarts, 1);
});

test('repair failure is bounded and never exposes process details', async () => {
  const controller = new CodexNativeChannelController({
    inspect: async () => false,
    processManager: {
      async restart() {
        throw new Error('C:\\private\\OpenAI.Codex\\ChatGPT.exe --secret');
      },
    },
  });

  const result = await controller.repair();
  assert.deepEqual(result, {
    state: 'error',
    ready: false,
    busy: false,
    message: '原生信道修复失败，请重试',
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('repair timeout never reports a successful restart', async () => {
  const controller = new CodexNativeChannelController({
    inspect: async () => false,
    processManager: { restart: async () => {} },
    delay: async () => {},
    timeoutMs: 30,
    pollIntervalMs: 10,
  });

  assert.deepEqual(await controller.repair(), {
    state: 'error',
    ready: false,
    busy: false,
    message: '原生信道修复失败，请重试',
  });
});

test('native inspection requires a loopback Codex main-page debugger target', async () => {
  const responseWith = (pages) => ({
    ok: true,
    async json() {
      return pages;
    },
  });

  assert.equal(await inspectCodexNativeChannel({
    fetchImpl: async () => responseWith([readyPage]),
  }), true);
  assert.equal(await inspectCodexNativeChannel({
    fetchImpl: async () => responseWith([{
      ...readyPage,
      webSocketDebuggerUrl: 'ws://192.0.2.10:9229/devtools/page/codex-main',
    }]),
  }), false);
  assert.equal(await inspectCodexNativeChannel({
    fetchImpl: async () => responseWith([{
      ...readyPage,
      url: 'https://example.com/',
    }]),
  }), false);
});

test('accepts only the packaged OpenAI Codex ChatGPT executable', () => {
  const executable = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  assert.equal(validateCodexExecutablePath(executable, {
    existsSync: (value) => value === executable,
  }), executable);
  assert.throws(() => validateCodexExecutablePath('C:\\Temp\\ChatGPT.exe', {
    existsSync: () => true,
  }), /installed Codex Desktop/i);
  assert.throws(() => validateCodexExecutablePath(executable, {
    existsSync: () => false,
  }), /installed Codex Desktop/i);
});

test('Windows process manager restarts only the discovered packaged executable', async () => {
  const executable = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.721.4979.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  const events = [];
  const manager = createWindowsCodexProcessManager({
    platform: 'win32',
    existsSync: () => true,
    locate: async () => ({ pid: 46404, executablePath: executable }),
    stop: async (value) => events.push(['stop', value]),
    launch: async (value, args) => events.push(['launch', value, args]),
  });

  await manager.restart(CODEX_DEBUG_ARGUMENTS);

  assert.deepEqual(events, [
    ['stop', { pid: 46404, executablePath: executable }],
    ['launch', executable, CODEX_DEBUG_ARGUMENTS],
  ]);
});

