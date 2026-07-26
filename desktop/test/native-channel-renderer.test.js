const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeChannelView } = require('../src/renderer/native-channel');

function element() {
  const listeners = new Map();
  return {
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
    state: element(),
    message: element(),
    repair: element(),
  };
}

test('initial inspection renders a healthy native channel without restarting', async () => {
  const nodes = elements();
  let repairs = 0;
  const view = createNativeChannelView({
    api: {
      getNativeChannel: async () => ({
        state: 'ready',
        ready: true,
        busy: false,
        message: 'Codex 原生信道正常',
      }),
      repairNativeChannel: async () => {
        repairs += 1;
      },
    },
    elements: nodes,
  });

  await view.bind();

  assert.equal(nodes.root.dataset.state, 'ready');
  assert.equal(nodes.state.textContent, '正常');
  assert.equal(nodes.message.textContent, 'Codex 原生信道正常');
  assert.equal(nodes.repair.disabled, false);
  assert.equal(repairs, 0);
});

test('one repair click disables the button and renders the confirmed result', async () => {
  const nodes = elements();
  let releaseRepair;
  const repairGate = new Promise((resolve) => {
    releaseRepair = resolve;
  });
  let repairs = 0;
  const view = createNativeChannelView({
    api: {
      getNativeChannel: async () => ({
        state: 'offline',
        ready: false,
        busy: false,
        message: '9229 未开启，点击按钮修复',
      }),
      repairNativeChannel: async () => {
        repairs += 1;
        await repairGate;
        return {
          state: 'ready',
          ready: true,
          busy: false,
          message: 'Codex 原生信道已修复',
        };
      },
    },
    elements: nodes,
  });
  await view.bind();

  const first = nodes.repair.dispatch('click');
  const second = nodes.repair.dispatch('click');
  assert.equal(nodes.root.dataset.state, 'repairing');
  assert.equal(nodes.state.textContent, '修复中');
  assert.equal(nodes.repair.disabled, true);
  releaseRepair();
  await Promise.all([first, second]);

  assert.equal(repairs, 1);
  assert.equal(nodes.root.dataset.state, 'ready');
  assert.equal(nodes.state.textContent, '正常');
  assert.equal(nodes.message.textContent, 'Codex 原生信道已修复');
  assert.equal(nodes.repair.disabled, false);
});

test('renderer hides IPC process details behind a fixed local error', async () => {
  const nodes = elements();
  const view = createNativeChannelView({
    api: {
      getNativeChannel: async () => {
        throw new Error('C:\\private\\ChatGPT.exe --remote-debugging-port=9229');
      },
      repairNativeChannel: async () => {
        throw new Error('PID 46404 private failure');
      },
    },
    elements: nodes,
  });

  await view.bind();
  assert.equal(nodes.root.dataset.state, 'error');
  assert.equal(nodes.state.textContent, '修复失败');
  assert.equal(nodes.message.textContent, '原生信道暂时不可用，请重试');
  assert.equal(JSON.stringify(nodes).includes('private'), false);

  await nodes.repair.dispatch('click');
  assert.equal(nodes.message.textContent, '原生信道暂时不可用，请重试');
  assert.equal(nodes.repair.disabled, false);
});

