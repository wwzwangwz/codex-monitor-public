const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRelayServer } = require('../../relay/src/server');
const { RelayPublisher, relayUrls } = require('../src/lib/relay-publisher');

const machineId = '00000000-0000-4000-8000-000000000001';
const token = '0123456789abcdef0123456789abcdef';

function nextType(socket, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.type !== type) return;
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

test('builds separate device and phone relay channels', () => {
  assert.deepEqual(relayUrls('wss://relay.example/', machineId), {
    device: `wss://relay.example/relay/device/${machineId}`,
    phone: `wss://relay.example/relay/phone/${machineId}`,
  });
  assert.throws(() => relayUrls('https://relay.example', machineId), /ws:\/\//);
});

test('publishes snapshots and handles guidance and Goal commands through the relay', async () => {
  const relay = await createRelayServer({ deviceTokens: { [machineId]: token } });
  const baseUrl = `ws://127.0.0.1:${relay.port}`;
  const received = [];
  const publisher = new RelayPublisher({
    baseUrl, machineId, machineName: 'Primary Mac', token,
    snapshot: () => [{ id: 's1', title: '开发', state: 'running', message: '工作中' }],
    sendGuidance: async (value) => { received.push(value); return { ok: true, message: '已提交' }; },
    sendGoalCommand: async (value) => { received.push(value); return { ok: true, message: 'Goal 已重启' }; },
    snapshotIntervalMs: 50,
  });
  publisher.start();
  const phoneUrl = new URL(relayUrls(baseUrl, machineId).phone);
  phoneUrl.searchParams.set('token', token);
  const phone = new WebSocket(phoneUrl);
  try {
    const snapshot = await nextType(phone, 'snapshot');
    assert.equal(snapshot.machine.name, 'Primary Mac');
    assert.equal(snapshot.sessions[0].state, 'running');

    const guidanceAck = nextType(phone, 'guidance_ack');
    const guidanceResult = nextType(phone, 'guidance_result');
    phone.send(JSON.stringify({ type: 'guidance', requestId: 'r1', sessionId: 's1', text: '继续', mode: 'queue' }));
    assert.equal((await guidanceAck).requestId, 'r1');
    assert.equal((await guidanceResult).ok, true);
    assert.deepEqual(received[0], { sessionId: 's1', text: '继续', mode: 'queue', attachments: [] });

    const goalAck = nextType(phone, 'goal_command_ack');
    const goalResult = nextType(phone, 'goal_command_result');
    phone.send(JSON.stringify({ type: 'goal_command', requestId: 'g1', sessionId: 's1', command: 'resume', confirmed: false }));
    assert.equal((await goalAck).requestId, 'g1');
    assert.equal((await goalResult).ok, true);
    assert.deepEqual(received[1], { sessionId: 's1', command: 'resume', confirmed: false });
  } finally {
    phone.terminate();
    publisher.close();
    await relay.close();
  }
});

test('streams only evidence returned by the desktop active whitelist', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-relay-evidence-'));
  const imagePath = path.join(directory, 'result.png');
  fs.writeFileSync(imagePath, 'relay-evidence');
  const evidenceId = 'c'.repeat(32);
  const relay = await createRelayServer({ deviceTokens: { [machineId]: token } });
  const baseUrl = `ws://127.0.0.1:${relay.port}`;
  const publisher = new RelayPublisher({
    baseUrl, machineId, machineName: 'Primary Mac', token, snapshot: () => [],
    evidenceFile: (id) => id === evidenceId
      ? { path: imagePath, mimeType: 'image/png', name: 'result.png', size: 14 }
      : null,
  });
  publisher.start();
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('publisher connection timeout')), 1000);
      const check = () => {
        if (publisher.socket?.readyState === WebSocket.OPEN) {
          clearTimeout(deadline);
          resolve();
        } else setTimeout(check, 5);
      };
      check();
    });
    const valid = await fetch(`http://127.0.0.1:${relay.port}/evidence/${evidenceId}?token=${token}`);
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('content-type'), 'image/png');
    assert.equal(await valid.text(), 'relay-evidence');
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/evidence/${'d'.repeat(32)}?token=${token}`)).status, 404);
  } finally {
    publisher.close();
    await relay.close();
    fs.rmSync(directory, { recursive: true });
  }
});
