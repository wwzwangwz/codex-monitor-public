const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RELAY_BASE_URL,
  RelaySettingsController,
} = require('../src/lib/relay-settings');

function controllerHarness({ publisherFactory } = {}) {
  const relayUrls = [];
  const saved = [];
  const created = [];
  const monitorServer = {
    machineName: 'Windows Studio',
    setRelayWsUrl(value) {
      relayUrls.push(value);
    },
    close() {
      throw new Error('LAN server must not be closed by Relay settings');
    },
  };
  const factory = publisherFactory || ((options) => {
    const publisher = {
      options,
      started: false,
      closed: false,
      renamed: [],
      start() {
        this.started = true;
      },
      close() {
        this.closed = true;
      },
      rename(value) {
        this.renamed.push(value);
      },
    };
    created.push(publisher);
    return publisher;
  });
  const controller = new RelaySettingsController({
    monitorServer,
    machineId: 'machine-1',
    machineName: 'Windows Studio',
    token: 'pairing-secret',
    snapshot: () => [],
    sendGuidance: async () => ({ ok: true }),
    validateGuidanceRequest: (value) => value,
    sendGoalCommand: async () => ({ ok: true }),
    validateGoalCommandRequest: (value) => value,
    evidenceFile: () => null,
    saveConfig(value) {
      saved.push(value);
    },
    publisherFactory: factory,
  });
  return {
    controller,
    relayUrls,
    saved,
    created,
  };
}

test('restores missing Relay settings as off without creating a publisher', () => {
  const harness = controllerHarness();

  const restored = harness.controller.restore({});

  assert.deepEqual(restored, {
    enabled: false,
    baseUrl: DEFAULT_RELAY_BASE_URL,
    connected: false,
    message: '远程中继已关闭',
  });
  assert.equal(harness.created.length, 0);
  assert.deepEqual(harness.relayUrls, ['']);
  assert.deepEqual(harness.saved, []);
});

test('enables one publisher, applies v2 pairing, and persists no secret', () => {
  const harness = controllerHarness();

  const enabled = harness.controller.set({ enabled: true });

  assert.equal(enabled.enabled, true);
  assert.equal(enabled.baseUrl, DEFAULT_RELAY_BASE_URL);
  assert.equal(enabled.connected, false);
  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].started, true);
  assert.equal(
    harness.relayUrls.at(-1),
    'wss://relay.example.com/codex-monitor/relay/phone/machine-1',
  );
  assert.deepEqual(harness.saved, [{
    relayEnabled: true,
    relayBaseUrl: DEFAULT_RELAY_BASE_URL,
  }]);
  assert.equal(JSON.stringify(harness.saved).includes('pairing-secret'), false);

  harness.created[0].options.onStatus({
    connected: true,
    message: '远程中继已连接',
  });
  assert.deepEqual(harness.controller.get(), {
    enabled: true,
    baseUrl: DEFAULT_RELAY_BASE_URL,
    connected: true,
    message: '远程中继已连接',
  });
});

test('publisher startup failure returns to v1 without closing LAN or exposing the token', () => {
  const harness = controllerHarness({
    publisherFactory: () => {
      throw new Error('cannot connect with pairing-secret');
    },
  });

  const result = harness.controller.set({
    enabled: true,
    baseUrl: 'wss://relay.example',
  });

  assert.equal(result.enabled, false);
  assert.equal(result.connected, false);
  assert.match(result.message, /cannot connect/);
  assert.doesNotMatch(result.message, /pairing-secret/);
  assert.match(result.message, /\[redacted\]/);
  assert.equal(harness.relayUrls.at(-1), '');
  assert.deepEqual(harness.saved, [{
    relayEnabled: false,
    relayBaseUrl: 'wss://relay.example',
  }]);
});

test('renames the live publisher and close removes only Relay pairing state', () => {
  const harness = controllerHarness();
  harness.controller.set({ enabled: true });
  const publisher = harness.created[0];

  harness.controller.rename('Renamed Windows');
  harness.controller.close();

  assert.deepEqual(publisher.renamed, ['Renamed Windows']);
  assert.equal(publisher.closed, true);
  assert.equal(harness.relayUrls.at(-1), '');
  assert.deepEqual(harness.saved, [{
    relayEnabled: true,
    relayBaseUrl: DEFAULT_RELAY_BASE_URL,
  }]);
  assert.deepEqual(harness.controller.get(), {
    enabled: false,
    baseUrl: DEFAULT_RELAY_BASE_URL,
    connected: false,
    message: '远程中继已关闭',
  });
});

test('reconfiguration closes the old publisher and ignores its late status', () => {
  const harness = controllerHarness();
  harness.controller.set({ enabled: true, baseUrl: 'wss://relay-one.example' });
  const oldPublisher = harness.created[0];

  harness.controller.set({ enabled: true, baseUrl: 'wss://relay-two.example' });
  const currentPublisher = harness.created[1];
  assert.equal(oldPublisher.closed, true);

  oldPublisher.options.onStatus({ connected: true, message: 'stale connected' });
  assert.equal(harness.controller.get().connected, false);
  assert.equal(harness.controller.get().message, '远程中继正在连接');

  currentPublisher.options.onStatus({ connected: true, message: 'current connected' });
  assert.equal(harness.controller.get().connected, true);
  assert.equal(harness.controller.get().message, 'current connected');
});
