const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitorServer, pairingPayload } = require('../src/lib/server');
const { RemoteController, connectionEndpoints, parsePairingCode } = require('../src/lib/remote-controller');

test('parses a desktop pairing code without changing its credentials', () => {
  const code = pairingPayload({ machineId: 'windows-1', machineName: 'Windows Studio', port: 4455, token: 'secret-token' });
  const pairing = parsePairingCode(code);
  assert.equal(pairing.id, 'windows-1');
  assert.equal(pairing.name, 'Windows Studio');
  assert.equal(pairing.token, 'secret-token');
  assert.match(pairing.wsUrl, /^ws:\/\/[^:]+:4455\/monitor$/);
});

test('parses v2 desktop pairing with LAN first and a secure relay fallback', () => {
  const code = pairingPayload({
    machineId: 'windows-v2', machineName: 'Windows V2', port: 4455, token: 'secret-v2',
    relayWsUrl: 'wss://relay.example.com/codex-monitor/relay/phone/windows-v2',
    hostName: 'windows-v2.local',
  });
  const pairing = parsePairingCode(code);
  assert.equal(pairing.v, 2);
  assert.equal(pairing.wsUrl, pairing.lanWsUrl);
  assert.equal(pairing.lanHostWsUrl, 'ws://windows-v2.local:4455/monitor');
  assert.equal(pairing.relayWsUrl, 'wss://relay.example.com/codex-monitor/relay/phone/windows-v2');
  assert.deepEqual(connectionEndpoints(pairing), [pairing.lanWsUrl, pairing.lanHostWsUrl, pairing.relayWsUrl]);
});

test('keeps a LAN-only desktop pairing compatible with v1 controllers', () => {
  const code = pairingPayload({
    machineId: 'windows-host', machineName: 'Windows Host', port: 4455, token: 'secret-host', hostName: 'windows-host.local',
  });
  const pairing = parsePairingCode(code);
  assert.equal(pairing.v, 1);
  assert.equal(pairing.lanWsUrl, undefined);
  assert.equal(pairing.lanHostWsUrl, undefined);
  assert.deepEqual(connectionEndpoints(pairing), [pairing.wsUrl]);
});

test('v2 pairing rejects an insecure public relay without weakening v1', () => {
  const payload = Buffer.from(JSON.stringify({
    v: 2, id: 'windows-v2', name: 'Windows V2', token: 'secret-v2',
    wsUrl: 'ws://192.168.10.17:43117/monitor', lanWsUrl: 'ws://192.168.10.17:43117/monitor',
    relayWsUrl: 'ws://relay.example.com/codex-monitor/relay/phone/windows-v2',
  })).toString('base64url');
  assert.throws(() => parsePairingCode(`codex-monitor://pair?data=${payload}`), /远程中继地址必须使用 wss/);
});

test('v2 controller falls back from LAN to relay and retries LAN first next cycle', async () => {
  class FakeSocket {
    static OPEN = 1;
    static attempts = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.OPEN;
      this.handlers = new Map();
      FakeSocket.attempts.push(url);
      queueMicrotask(() => this.emit('open'));
    }

    on(name, handler) { this.handlers.set(name, handler); }
    emit(name, value) { this.handlers.get(name)?.(value); }
    send() {}
    close() { queueMicrotask(() => this.emit('close')); }
  }

  const pairing = {
    v: 2, id: 'windows-v2', name: 'Windows V2', token: 'secret-v2',
    wsUrl: 'ws://192.168.10.17:43117/monitor', lanWsUrl: 'ws://192.168.10.17:43117/monitor',
    relayWsUrl: 'wss://relay.example.com/codex-monitor/relay/phone/windows-v2',
  };
  const controller = new RemoteController({ pairings: [pairing], WebSocketImpl: FakeSocket, reconnectMs: 1, snapshotTimeoutMs: 5 });
  try {
    controller.start();
    await waitFor(() => FakeSocket.attempts.length >= 3);
    assert.match(FakeSocket.attempts[0], /^ws:\/\/192\.168\.10\.17:43117\/monitor\?token=/);
    assert.match(FakeSocket.attempts[1], /^wss:\/\/relay\.example\.com\/codex-monitor\/relay\/phone\/windows-v2\?token=/);
    assert.match(FakeSocket.attempts[2], /^ws:\/\/192\.168\.10\.17:43117\/monitor\?token=/);
  } finally {
    controller.close();
  }
});

test('primary controller receives a remote snapshot and sends native guidance', async () => {
  let received;
  const server = await createMonitorServer({
    machineId: 'windows-1', machineName: 'Windows Studio', pairingToken: 'secret-token', preferredPort: 0,
    snapshot: () => [{ id: 'session-1', title: 'Windows task', state: 'running', message: 'Working' }],
    sendGuidance: async (value) => {
      received = value;
      return { ok: true, message: 'Windows 已提交' };
    },
  });
  const code = pairingPayload({ machineId: 'windows-1', machineName: 'Windows Studio', port: server.port, token: server.token });
  const controller = new RemoteController({ reconnectMs: 20, requestTimeoutMs: 1000 });
  try {
    controller.add(code, 'mac-primary');
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('snapshot timeout')), 1000);
      const poll = () => {
        if (controller.snapshot()[0]?.connected) {
          clearTimeout(deadline);
          resolve();
        } else setTimeout(poll, 10);
      };
      poll();
    });
    assert.equal(controller.snapshot()[0].sessions[0].state, 'running');
    const result = await controller.sendGuidance({
      deviceId: 'windows-1', sessionId: 'session-1', text: '读取主控任务文档', mode: 'queue',
    });
    assert.deepEqual(received, {
      sessionId: 'session-1', text: '读取主控任务文档', mode: 'queue', attachments: [],
    });
    assert.equal(result.ok, true);
  } finally {
    controller.close();
    server.close();
  }
});

test('guidance ACK extends the wait for a slow final result', async () => {
  const server = await createMonitorServer({
    machineId: 'windows-slow', machineName: 'Windows Slow', pairingToken: 'slow-token', preferredPort: 0,
    snapshot: () => [{ id: 'session-slow', title: 'Slow task', state: 'running', message: 'Working' }],
    sendGuidance: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { ok: true, message: 'Windows 最终已提交' };
    },
  });
  const code = pairingPayload({ machineId: 'windows-slow', machineName: 'Windows Slow', port: server.port, token: server.token });
  const controller = new RemoteController({ reconnectMs: 20, requestTimeoutMs: 30, resultTimeoutMs: 200 });
  try {
    controller.add(code, 'mac-primary');
    await waitForConnected(controller);
    const result = await controller.sendGuidance({
      deviceId: 'windows-slow', sessionId: 'session-slow', text: '继续现有任务', mode: 'queue',
    });
    assert.equal(result.ok, true);
    assert.equal(result.message, 'Windows 最终已提交');
    assert.equal(result.ack?.type, 'guidance_ack');
  } finally {
    controller.close();
    server.close();
  }
});

test('guidance reports a distinct final-result timeout after ACK', async () => {
  const server = await createMonitorServer({
    machineId: 'windows-hung', machineName: 'Windows Hung', pairingToken: 'hung-token', preferredPort: 0,
    snapshot: () => [{ id: 'session-hung', title: 'Hung task', state: 'running', message: 'Working' }],
    sendGuidance: () => new Promise(() => {}),
  });
  const code = pairingPayload({ machineId: 'windows-hung', machineName: 'Windows Hung', port: server.port, token: server.token });
  const controller = new RemoteController({ reconnectMs: 20, requestTimeoutMs: 30, resultTimeoutMs: 50 });
  try {
    controller.add(code, 'mac-primary');
    await waitForConnected(controller);
    const result = await controller.sendGuidance({
      deviceId: 'windows-hung', sessionId: 'session-hung', text: '继续现有任务', mode: 'queue',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /已接收.*30 秒未返回最终执行结果/);
    assert.equal(result.ack?.type, 'guidance_ack');
  } finally {
    controller.close();
    server.close();
  }
});

test('guidance fails at the shorter receive timeout when no ACK arrives', async () => {
  class SilentSocket {
    static OPEN = 1;
  }
  const controller = new RemoteController({ WebSocketImpl: SilentSocket, requestTimeoutMs: 25, resultTimeoutMs: 100 });
  controller.put({ id: 'windows-silent', name: 'Windows Silent', wsUrl: 'ws://127.0.0.1:1/monitor', token: 'silent-token' });
  const node = controller.nodes.get('windows-silent');
  node.connected = true;
  node.sessions = [{ id: 'session-silent' }];
  node.socket = { readyState: SilentSocket.OPEN, send() {}, close() {} };
  try {
    const result = await controller.sendGuidance({
      deviceId: 'windows-silent', sessionId: 'session-silent', text: '继续现有任务', mode: 'queue',
    });
    assert.equal(result.ok, false);
    assert.equal(result.message, '受控电脑 10 秒未确认接收消息');
    assert.equal(result.ack, undefined);
  } finally {
    controller.close();
  }
});

test('primary controller sends a Goal command and waits for its final result', async () => {
  let received;
  const server = await createMonitorServer({
    machineId: 'windows-goal', machineName: 'Windows Goal', pairingToken: 'goal-token', preferredPort: 0,
    snapshot: () => [{
      id: 'session-goal', title: 'Blocked goal', state: 'blocked', message: '受阻',
      goal: { status: 'blocked', objective: '继续实验' },
    }],
    sendGoalCommand: async (value) => {
      received = value;
      return { ok: true, message: 'Goal 已重启' };
    },
  });
  const code = pairingPayload({ machineId: 'windows-goal', machineName: 'Windows Goal', port: server.port, token: server.token });
  const controller = new RemoteController({ reconnectMs: 20, requestTimeoutMs: 1000, resultTimeoutMs: 1000 });
  try {
    controller.add(code, 'mac-primary');
    await waitForConnected(controller);
    const result = await controller.sendGoalCommand({
      deviceId: 'windows-goal', sessionId: 'session-goal', command: 'resume',
    });
    assert.equal(result.ok, true);
    assert.equal(result.message, 'Goal 已重启');
    assert.equal(result.ack?.type, 'goal_command_ack');
    assert.deepEqual(received, { sessionId: 'session-goal', command: 'resume', confirmed: false });
  } finally {
    controller.close();
    server.close();
  }
});

test('primary controller rejects a Goal result for another session immediately', async () => {
  const controller = new RemoteController({ WebSocketImpl: { OPEN: 1 }, requestTimeoutMs: 200, resultTimeoutMs: 200 });
  controller.put({ id: 'windows-mismatch-session', name: 'Windows', wsUrl: 'ws://127.0.0.1:1/monitor', token: 'token' });
  const node = controller.nodes.get('windows-mismatch-session');
  node.connected = true;
  node.sessions = [{ id: 'session-goal' }];
  node.socket = {
    readyState: 1,
    send: (raw) => {
      const request = JSON.parse(raw);
      queueMicrotask(() => controller.handleMessage(node, node.socket, JSON.stringify({
        type: 'goal_command_ack', requestId: request.requestId, sessionId: 'session-goal',
      })));
      queueMicrotask(() => controller.handleMessage(node, node.socket, JSON.stringify({
        type: 'goal_command_result', requestId: request.requestId, sessionId: 'another-session',
        command: 'resume', ok: true,
      })));
    },
    close() {},
  };
  try {
    const result = await controller.sendGoalCommand({
      deviceId: 'windows-mismatch-session', sessionId: 'session-goal', command: 'resume',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /不匹配的会话结果/);
    assert.equal(result.ack?.type, 'goal_command_ack');
  } finally {
    controller.close();
  }
});

test('primary controller rejects a Goal result for another command immediately', async () => {
  const controller = new RemoteController({ WebSocketImpl: { OPEN: 1 }, requestTimeoutMs: 200, resultTimeoutMs: 200 });
  controller.put({ id: 'windows-mismatch-command', name: 'Windows', wsUrl: 'ws://127.0.0.1:1/monitor', token: 'token' });
  const node = controller.nodes.get('windows-mismatch-command');
  node.connected = true;
  node.sessions = [{ id: 'session-goal' }];
  node.socket = {
    readyState: 1,
    send: (raw) => {
      const request = JSON.parse(raw);
      queueMicrotask(() => controller.handleMessage(node, node.socket, JSON.stringify({
        type: 'goal_command_ack', requestId: request.requestId, sessionId: 'session-goal',
      })));
      queueMicrotask(() => controller.handleMessage(node, node.socket, JSON.stringify({
        type: 'goal_command_result', requestId: request.requestId, sessionId: 'session-goal',
        command: 'delete', ok: true,
      })));
    },
    close() {},
  };
  try {
    const result = await controller.sendGoalCommand({
      deviceId: 'windows-mismatch-command', sessionId: 'session-goal', command: 'resume',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /不匹配的 Goal 操作结果/);
    assert.equal(result.ack?.type, 'goal_command_ack');
  } finally {
    controller.close();
  }
});

test('primary controller refuses an unconfirmed Goal deletion before sending', async () => {
  const controller = new RemoteController({ WebSocketImpl: { OPEN: 1 } });
  controller.put({ id: 'windows-delete', name: 'Windows', wsUrl: 'ws://127.0.0.1:1/monitor', token: 'token' });
  const node = controller.nodes.get('windows-delete');
  node.connected = true;
  node.sessions = [{ id: 'session-goal' }];
  node.socket = { readyState: 1, send() { throw new Error('should not send'); }, close() {} };
  try {
    const result = await controller.sendGoalCommand({
      deviceId: 'windows-delete', sessionId: 'session-goal', command: 'delete', confirmed: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.message, '删除 Goal 需要二次确认');
  } finally {
    controller.close();
  }
});

test('primary controller refuses to pair with itself', () => {
  const code = pairingPayload({ machineId: 'mac-primary', machineName: 'Mac', port: 4455, token: 'secret-token' });
  const controller = new RemoteController();
  assert.throws(() => controller.add(code, 'mac-primary'), /不能把主控 Mac 自己添加/);
  controller.close();
});

async function waitForConnected(controller) {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('snapshot timeout')), 1000);
    const poll = () => {
      if (controller.snapshot()[0]?.connected) {
        clearTimeout(deadline);
        resolve();
      } else setTimeout(poll, 10);
    };
    poll();
  });
}

async function waitFor(predicate) {
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('condition timeout')), 1000);
    const poll = () => {
      if (predicate()) {
        clearTimeout(deadline);
        resolve();
      } else setTimeout(poll, 5);
    };
    poll();
  });
}
