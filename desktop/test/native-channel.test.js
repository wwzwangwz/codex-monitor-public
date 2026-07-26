const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNativeChannelController,
  waitFor,
} = require('../src/lib/native-channel');

test('native channel status distinguishes ready, running and stopped states', async () => {
  const ready = createNativeChannelController({
    checkEndpoint: async () => true,
    isCodexRunning: async () => true,
  });
  assert.equal((await ready.getStatus()).message, '原生输入通道已连接');

  const missing = createNativeChannelController({
    checkEndpoint: async () => false,
    isCodexRunning: async () => true,
  });
  assert.equal((await missing.getStatus()).message, 'Codex 已运行，但输入通道未启用');

  const stopped = createNativeChannelController({
    checkEndpoint: async () => false,
    isCodexRunning: async () => false,
  });
  assert.equal((await stopped.getStatus()).message, 'Codex 未运行');
});

test('repair quits normally, launches once and requires endpoint confirmation', async () => {
  let running = true;
  let endpointChecks = 0;
  let quitCalls = 0;
  let launchCalls = 0;
  const controller = createNativeChannelController({
    checkEndpoint: async () => {
      endpointChecks += 1;
      return launchCalls === 1 && endpointChecks >= 3;
    },
    isCodexRunning: async () => running,
    quitCodex: async () => {
      quitCalls += 1;
      running = false;
    },
    launchCodex: async () => {
      launchCalls += 1;
      running = true;
    },
    delayImpl: async () => {},
    exitTimeoutMs: 10,
    startTimeoutMs: 20,
    pollIntervalMs: 5,
  });

  const result = await controller.repair();
  assert.equal(result.ok, true);
  assert.equal(quitCalls, 1);
  assert.equal(launchCalls, 1);
});

test('repair never force-kills or launches when Codex refuses to exit', async () => {
  let launchCalls = 0;
  const controller = createNativeChannelController({
    checkEndpoint: async () => false,
    isCodexRunning: async () => true,
    quitCodex: async () => {},
    launchCodex: async () => { launchCalls += 1; },
    delayImpl: async () => {},
    exitTimeoutMs: 10,
    startTimeoutMs: 10,
    pollIntervalMs: 5,
  });

  await assert.rejects(controller.repair(), /没有强制结束/);
  assert.equal(launchCalls, 0);
});

test('concurrent repair clicks share one repair operation', async () => {
  let launchCalls = 0;
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  const controller = createNativeChannelController({
    checkEndpoint: async () => launchCalls > 0,
    isCodexRunning: async () => false,
    launchCodex: async () => {
      launchCalls += 1;
      await launchGate;
    },
    delayImpl: async () => {},
    startTimeoutMs: 10,
    pollIntervalMs: 5,
  });

  const first = controller.repair();
  const second = controller.repair();
  releaseLaunch();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(launchCalls, 1);
});

test('waitFor stops after the configured number of checks', async () => {
  let checks = 0;
  const result = await waitFor(async () => {
    checks += 1;
    return false;
  }, true, {
    delayImpl: async () => {},
    intervalMs: 5,
    timeoutMs: 12,
  });
  assert.equal(result, false);
  assert.equal(checks, 3);
});
