const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelaySettingsView } = require('../src/renderer/relay-settings');

function element() {
  const listeners = new Map();
  return {
    checked: false,
    disabled: false,
    textContent: '',
    dataset: {},
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    dispatch(name) {
      return listeners.get(name)?.({ target: this });
    },
  };
}

function elements() {
  return {
    root: element(),
    enabled: element(),
    endpoint: element(),
    status: element(),
  };
}

const offStatus = {
  enabled: false,
  baseUrl: 'wss://relay.example.com/codex-monitor',
  connected: false,
  message: '远程中继已关闭',
};

test('binds the fixed Relay endpoint and persists an explicit enable action', async () => {
  const nodes = elements();
  const setCalls = [];
  const view = createRelaySettingsView({
    elements: nodes,
    api: {
      getRelay: async () => offStatus,
      setRelay: async (value) => {
        setCalls.push(value);
        return {
          ...offStatus,
          enabled: true,
          connected: true,
          message: '远程中继已连接',
        };
      },
    },
  });

  await view.bind();
  assert.equal(nodes.enabled.checked, false);
  assert.equal(nodes.endpoint.textContent, 'wss://relay.example.com/codex-monitor');
  assert.equal(nodes.status.textContent, '远程中继已关闭');

  nodes.enabled.checked = true;
  await nodes.enabled.dispatch('change');

  assert.deepEqual(setCalls, [{
    enabled: true,
    baseUrl: 'wss://relay.example.com/codex-monitor',
  }]);
  assert.equal(nodes.enabled.checked, true);
  assert.equal(nodes.enabled.disabled, false);
  assert.equal(nodes.root.dataset.state, 'connected');
  assert.equal(nodes.status.textContent, '远程中继已连接');
});

test('restores the last confirmed state and hides IPC details after failure', async () => {
  const nodes = elements();
  const view = createRelaySettingsView({
    elements: nodes,
    api: {
      getRelay: async () => offStatus,
      setRelay: async () => {
        throw new Error('pairing-secret internal IPC details');
      },
    },
  });
  await view.bind();

  nodes.enabled.checked = true;
  await nodes.enabled.dispatch('change');

  assert.equal(nodes.enabled.checked, false);
  assert.equal(nodes.enabled.disabled, false);
  assert.equal(nodes.root.dataset.state, 'error');
  assert.equal(nodes.status.textContent, '远程中继暂时不可用');
  assert.equal(JSON.stringify(nodes).includes('pairing-secret'), false);
});
