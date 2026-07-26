const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RelayPublisher, relayUrls } = require('../src/lib/relay-publisher');

async function createRelayHarness() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    baseUrl: `ws://127.0.0.1:${address.port}`,
  };
}

async function closeRelayHarness(server) {
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 800) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function commandExchange(socket, resultType, send, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out waiting for ${resultType}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'snapshot') return;
      messages.push(value);
      if (value.type !== resultType) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(messages);
    };
    socket.on('message', onMessage);
    send();
  });
}

function nextMessageOfType(socket, type, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
  });
}

test('builds TLS production and loopback test endpoints', () => {
  assert.deepEqual(relayUrls('wss://relay.example.com/codex-monitor/', 'machine-1'), {
    device: 'wss://relay.example.com/codex-monitor/relay/device/machine-1',
    phone: 'wss://relay.example.com/codex-monitor/relay/phone/machine-1',
  });
  assert.doesNotThrow(() => relayUrls('ws://127.0.0.1:1234', 'machine-1'));
  assert.doesNotThrow(() => relayUrls('ws://localhost:1234', 'machine-1'));
  assert.doesNotThrow(() => relayUrls('ws://[::1]:1234', 'machine-1'));
  assert.throws(() => relayUrls('ws://relay.example', 'machine-1'), /TLS/i);
  assert.throws(() => relayUrls('https://relay.example', 'machine-1'), /WebSocket/i);
  assert.throws(() => relayUrls('wss://user@relay.example', 'machine-1'), /credentials/i);
  assert.throws(() => relayUrls('wss://relay.example?token=unsafe', 'machine-1'), /query/i);
});

test('connects outbound with the token and immediately publishes the current snapshot', async () => {
  const harness = await createRelayHarness();
  let publisher;
  try {
    const received = new Promise((resolve, reject) => {
      harness.server.once('connection', (socket, request) => {
        socket.once('message', (raw) => {
          resolve({ requestUrl: request.url, value: JSON.parse(raw.toString()) });
        });
        socket.once('error', reject);
      });
    });
    publisher = new RelayPublisher({
      baseUrl: harness.baseUrl,
      machineId: 'machine-1',
      machineName: 'Windows Studio',
      token: 'pairing-secret',
      snapshot: () => [{
        id: 'session-1',
        title: 'Build',
        state: 'running',
        message: 'Compiling',
      }],
      snapshotIntervalMs: 60_000,
      reconnectMs: 25,
    });

    publisher.start();
    const result = await received;
    const requestUrl = new URL(result.requestUrl, harness.baseUrl);
    assert.equal(requestUrl.pathname, '/relay/device/machine-1');
    assert.equal(requestUrl.searchParams.get('token'), 'pairing-secret');
    assert.equal(result.value.type, 'snapshot');
    assert.deepEqual(result.value.machine, { id: 'machine-1', name: 'Windows Studio' });
    assert.deepEqual(result.value.sessions, [{
      id: 'session-1',
      title: 'Build',
      state: 'running',
      message: 'Compiling',
    }]);
  } finally {
    publisher?.close();
    await closeRelayHarness(harness.server);
  }
});

test('validates Relay guidance before ACK and never invokes a rejected handler', async () => {
  const harness = await createRelayHarness();
  let publisher;
  let handlerCalls = 0;
  try {
    const connection = once(harness.server, 'connection');
    publisher = new RelayPublisher({
      baseUrl: harness.baseUrl,
      machineId: 'machine-1',
      machineName: 'Windows Studio',
      token: 'pairing-secret',
      snapshot: () => [],
      validateGuidanceRequest: () => {
        throw new Error('session is not selected');
      },
      sendGuidance: async () => {
        handlerCalls += 1;
        return { ok: true, message: 'must not run' };
      },
      snapshotIntervalMs: 60_000,
      reconnectMs: 25,
    });
    publisher.start();
    const [socket] = await connection;
    const messages = await commandExchange(socket, 'guidance_result', () => {
      socket.send(JSON.stringify({
        type: 'guidance',
        requestId: 'request-rejected',
        sessionId: 'session-outside-allowlist',
        text: 'continue',
        mode: 'steer',
      }));
    });

    assert.deepEqual(messages.map((value) => value.type), ['guidance_result']);
    assert.equal(messages[0].requestId, 'request-rejected');
    assert.equal(messages[0].sessionId, 'session-outside-allowlist');
    assert.equal(messages[0].ok, false);
    assert.match(messages[0].message, /not selected/);
    assert.equal(handlerCalls, 0);
  } finally {
    publisher?.close();
    await closeRelayHarness(harness.server);
  }
});

test('routes validated Relay guidance and Goal commands with correlated ACK then result', async () => {
  const harness = await createRelayHarness();
  let publisher;
  const received = [];
  try {
    const connection = once(harness.server, 'connection');
    publisher = new RelayPublisher({
      baseUrl: harness.baseUrl,
      machineId: 'machine-1',
      machineName: 'Windows Studio',
      token: 'pairing-secret',
      snapshot: () => [],
      validateGuidanceRequest: () => ({
        sessionId: 'canonical-session',
        text: 'continue',
        mode: 'queue',
        attachments: [],
      }),
      sendGuidance: async (value) => {
        received.push(value);
        return { ok: true, message: 'guidance submitted' };
      },
      validateGoalCommandRequest: (value) => {
        if (value.command === 'delete') throw new Error('confirmation is required');
        return { sessionId: 'canonical-session', command: 'resume', confirmed: false };
      },
      sendGoalCommand: async (value) => {
        received.push(value);
        return { ok: true, message: 'Goal resumed' };
      },
      snapshotIntervalMs: 60_000,
      reconnectMs: 25,
    });
    publisher.start();
    const [socket] = await connection;

    const guidance = await commandExchange(socket, 'guidance_result', () => {
      socket.send(JSON.stringify({
        type: 'guidance',
        requestId: 'request-1',
        sessionId: 'requested-session',
        text: 'continue',
        mode: 'queue',
      }));
    });
    assert.deepEqual(guidance.map((value) => value.type), ['guidance_ack', 'guidance_result']);
    assert.equal(guidance[1].requestId, 'request-1');
    assert.equal(guidance[1].sessionId, 'requested-session');
    assert.equal(guidance[1].ok, true);

    const goal = await commandExchange(socket, 'goal_command_result', () => {
      socket.send(JSON.stringify({
        type: 'goal_command',
        requestId: 'goal-1',
        sessionId: 'requested-session',
        command: 'resume',
        confirmed: false,
      }));
    });
    assert.deepEqual(goal.map((value) => value.type), ['goal_command_ack', 'goal_command_result']);
    assert.equal(goal[1].requestId, 'goal-1');
    assert.equal(goal[1].sessionId, 'requested-session');
    assert.equal(goal[1].command, 'resume');
    assert.equal(goal[1].ok, true);

    const rejectedDelete = await commandExchange(socket, 'goal_command_result', () => {
      socket.send(JSON.stringify({
        type: 'goal_command',
        requestId: 'goal-delete',
        sessionId: 'requested-session',
        command: 'delete',
        confirmed: false,
      }));
    });
    assert.deepEqual(rejectedDelete.map((value) => value.type), ['goal_command_result']);
    assert.equal(rejectedDelete[0].ok, false);
    assert.match(rejectedDelete[0].message, /confirmation/);

    assert.deepEqual(received, [
      {
        sessionId: 'canonical-session',
        text: 'continue',
        mode: 'queue',
        attachments: [],
      },
      {
        sessionId: 'canonical-session',
        command: 'resume',
        confirmed: false,
      },
    ]);
  } finally {
    publisher?.close();
    await closeRelayHarness(harness.server);
  }
});

test('returns only current whitelisted evidence with bounded MIME and size', async () => {
  const harness = await createRelayHarness();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-relay-publisher-'));
  const imagePath = path.join(directory, 'result.png');
  const invalidMimePath = path.join(directory, 'result.txt');
  const largePath = path.join(directory, 'large.png');
  fs.writeFileSync(imagePath, 'relay-evidence');
  fs.writeFileSync(invalidMimePath, 'not-an-image');
  fs.writeFileSync(largePath, Buffer.alloc((20 * 1024 * 1024) + 1));
  let publisher;
  try {
    const connection = once(harness.server, 'connection');
    publisher = new RelayPublisher({
      baseUrl: harness.baseUrl,
      machineId: 'machine-1',
      machineName: 'Windows Studio',
      token: 'pairing-secret',
      snapshot: () => [],
      evidenceFile: (id) => ({
        ['a'.repeat(32)]: {
          path: imagePath, name: 'result.png', mimeType: 'image/png', size: 14,
        },
        ['b'.repeat(32)]: {
          path: invalidMimePath, name: 'result.txt', mimeType: 'text/plain', size: 12,
        },
        ['c'.repeat(32)]: {
          path: largePath, name: 'large.png', mimeType: 'image/png',
          size: (20 * 1024 * 1024) + 1,
        },
      })[id] || null,
      snapshotIntervalMs: 60_000,
      reconnectMs: 25,
    });
    publisher.start();
    const [socket] = await connection;

    const valid = await commandExchange(socket, 'evidence_response', () => {
      socket.send(JSON.stringify({
        type: 'evidence_request',
        requestId: 'evidence-valid',
        evidenceId: 'a'.repeat(32),
      }));
    });
    assert.equal(valid[0].ok, true);
    assert.equal(valid[0].mimeType, 'image/png');
    assert.equal(valid[0].name, 'result.png');
    assert.equal(Buffer.from(valid[0].dataBase64, 'base64').toString(), 'relay-evidence');

    for (const [requestId, evidenceId] of [
      ['evidence-bad-id', '../outside'],
      ['evidence-bad-mime', 'b'.repeat(32)],
      ['evidence-too-large', 'c'.repeat(32)],
      ['evidence-missing', 'd'.repeat(32)],
    ]) {
      const response = await commandExchange(socket, 'evidence_response', () => {
        socket.send(JSON.stringify({ type: 'evidence_request', requestId, evidenceId }));
      });
      assert.equal(response[0].requestId, requestId);
      assert.equal(response[0].ok, false);
      assert.equal(Object.hasOwn(response[0], 'dataBase64'), false);
    }
  } finally {
    publisher?.close();
    await closeRelayHarness(harness.server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('publishes the renamed machine identity without reconnecting', async () => {
  const harness = await createRelayHarness();
  let publisher;
  try {
    const connection = once(harness.server, 'connection');
    publisher = new RelayPublisher({
      baseUrl: harness.baseUrl,
      machineId: 'machine-1',
      machineName: 'Windows Studio',
      token: 'pairing-secret',
      snapshot: () => [],
      snapshotIntervalMs: 60_000,
      reconnectMs: 25,
    });
    publisher.start();
    const [socket] = await connection;
    assert.equal(typeof publisher.rename, 'function', 'RelayPublisher.rename must publish identity changes');
    const renamedSnapshot = nextMessageOfType(socket, 'snapshot');
    publisher.rename('Renamed Windows');
    assert.equal((await renamedSnapshot).machine.name, 'Renamed Windows');
    assert.equal(harness.server.clients.size, 1);
  } finally {
    publisher?.close();
    await closeRelayHarness(harness.server);
  }
});

test('reconnects once after transport loss and close prevents another attempt', async () => {
  const harness = await createRelayHarness();
  const connections = [];
  harness.server.on('connection', (socket) => connections.push(socket));
  const publisher = new RelayPublisher({
    baseUrl: harness.baseUrl,
    machineId: 'machine-1',
    machineName: 'Windows Studio',
    token: 'pairing-secret',
    snapshot: () => [],
    snapshotIntervalMs: 60_000,
    reconnectMs: 20,
  });
  try {
    publisher.start();
    await waitFor(() => connections.length === 1);
    connections[0].close();
    await waitFor(() => connections.length === 2);

    publisher.close();
    connections[1].close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(connections.length, 2);
  } finally {
    publisher.close();
    await closeRelayHarness(harness.server);
  }
});
