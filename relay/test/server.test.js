const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createRelayServer } = require('../src/server');

const token = '0123456789abcdef0123456789abcdef';
const deviceId = '00000000-0000-4000-8000-000000000001';
const otherDeviceId = '00000000-0000-4000-8000-000000000002';

function connect(port, role, targetDeviceId = deviceId, credential = token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/relay/${role}/${targetDeviceId}?token=${credential}`);
    socket.jsonQueue = [];
    socket.jsonWaiters = [];
    socket.on('message', (data) => {
      let value;
      try { value = JSON.parse(data.toString()); } catch (error) {
        const waiter = socket.jsonWaiters.shift();
        if (waiter) waiter.reject(error);
        return;
      }
      const waiter = socket.jsonWaiters.shift();
      if (waiter) waiter.resolve(value);
      else socket.jsonQueue.push(value);
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextJson(socket) {
  if (socket.jsonQueue.length) return Promise.resolve(socket.jsonQueue.shift());
  return new Promise((resolve, reject) => {
    socket.jsonWaiters.push({ resolve, reject });
  });
}

async function nextType(socket, type) {
  while (true) {
    const value = await nextJson(socket);
    if (value.type === type) return value;
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

test('health is public but websocket channels require the configured device token', async () => {
  const relay = await createRelayServer({ deviceTokens: { [deviceId]: token } });
  try {
    const health = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${relay.port}/health`, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    await assert.rejects(connect(relay.port, 'phone', deviceId, 'wrong-token'), /401/);
    await assert.rejects(connect(relay.port, 'phone', 'not-a-device-id', token), /401/);
  } finally {
    await relay.close();
  }
});

test('forwards the current snapshot and replays only its short-lived latest value', async () => {
  let now = 1_000;
  const relay = await createRelayServer({
    deviceTokens: { [deviceId]: token }, snapshotTtlMs: 100, now: () => now,
  });
  const device = await connect(relay.port, 'device');
  try {
    const firstPhone = await connect(relay.port, 'phone');
    const live = nextJson(firstPhone);
    device.send(JSON.stringify({
      type: 'snapshot', machine: { id: deviceId, name: 'Studio' }, sentAt: 'now', sessions: [],
    }));
    assert.equal((await live).machine.name, 'Studio');
    firstPhone.close();

    now += 50;
    const secondPhone = await connect(relay.port, 'phone');
    assert.equal((await nextJson(secondPhone)).type, 'snapshot');
    secondPhone.close();

    now += 101;
    const stalePhone = await connect(relay.port, 'phone');
    const outcome = await Promise.race([
      nextJson(stalePhone).then(() => 'message'),
      new Promise((resolve) => setTimeout(() => resolve('quiet'), 30)),
    ]);
    assert.equal(outcome, 'quiet');
    stalePhone.close();
  } finally {
    device.close();
    await relay.close();
  }
});

test('routes guidance and correlated results without exposing another device channel', async () => {
  const relay = await createRelayServer({
    deviceTokens: { [deviceId]: token, [otherDeviceId]: 'abcdef0123456789abcdef0123456789' },
  });
  const device = await connect(relay.port, 'device');
  const phone = await connect(relay.port, 'phone');
  const otherPhone = await connect(relay.port, 'phone', otherDeviceId, 'abcdef0123456789abcdef0123456789');
  try {
    const receivedByDevice = nextJson(device);
    phone.send(JSON.stringify({
      type: 'guidance', requestId: 'r1', sessionId: 's1', text: '继续', mode: 'steer', attachments: [],
    }));
    assert.equal((await receivedByDevice).requestId, 'r1');

    const resultOnPhone = nextJson(phone);
    device.send(JSON.stringify({
      type: 'guidance_result', requestId: 'r1', sessionId: 's1', ok: true, message: 'done',
    }));
    assert.equal((await resultOnPhone).ok, true);
    const leaked = await Promise.race([
      nextJson(otherPhone).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    assert.equal(leaked, false);
  } finally {
    device.close();
    phone.close();
    otherPhone.close();
    await relay.close();
  }
});

test('returns an explicit final failure when a phone controls an offline computer', async () => {
  const relay = await createRelayServer({ deviceTokens: { [deviceId]: token } });
  const phone = await connect(relay.port, 'phone');
  try {
    const result = nextJson(phone);
    phone.send(JSON.stringify({
      type: 'goal_command', requestId: 'g1', sessionId: 's1', command: 'resume', confirmed: false,
    }));
    assert.deepEqual(await result, {
      type: 'goal_command_result', requestId: 'g1', sessionId: 's1', command: 'resume',
      ok: false, message: '远程电脑当前不在线',
    });
  } finally {
    phone.close();
    await relay.close();
  }
});

test('streams authenticated evidence from the matching online device without caching it', async () => {
  const relay = await createRelayServer({ deviceTokens: { [deviceId]: token } });
  const evidenceId = 'a'.repeat(32);
  const device = await connect(relay.port, 'device');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${relay.port}/evidence/${evidenceId}`)).status, 401);
    const responsePromise = fetch(`http://127.0.0.1:${relay.port}/evidence/${evidenceId}?token=${token}`);
    const request = await nextJson(device);
    assert.equal(request.type, 'evidence_request');
    assert.equal(request.evidenceId, evidenceId);
    device.send(JSON.stringify({
      type: 'evidence_response', requestId: request.requestId, ok: true,
      mimeType: 'image/png', dataBase64: Buffer.from('current-image').toString('base64'),
    }));
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'current-image');
    await new Promise((resolve) => {
      device.once('close', resolve);
      device.close();
    });
    assert.equal(
      (await fetch(`http://127.0.0.1:${relay.port}/evidence/${evidenceId}?token=${token}`)).status,
      503,
    );
  } finally {
    device.close();
    await relay.close();
  }
});

test('returns a clear failure when evidence is requested while the device is offline', async () => {
  const relay = await createRelayServer({ deviceTokens: { [deviceId]: token } });
  try {
    const response = await fetch(`http://127.0.0.1:${relay.port}/evidence/${'b'.repeat(32)}?token=${token}`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'device_offline' });
  } finally {
    await relay.close();
  }
});

test('fails an in-flight evidence request immediately when the device disconnects', async () => {
  const relay = await createRelayServer({
    deviceTokens: { [deviceId]: token }, evidenceTimeoutMs: 1000,
  });
  const device = await connect(relay.port, 'device');
  try {
    const responsePromise = fetch(
      `http://127.0.0.1:${relay.port}/evidence/${'e'.repeat(32)}?token=${token}`,
    );
    assert.equal((await nextJson(device)).type, 'evidence_request');
    device.terminate();
    const response = await responsePromise;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'device_offline' });
  } finally {
    device.terminate();
    await relay.close();
  }
});

test('emits push events only for lamp changes and honors per-phone silent completion', async () => {
  const pushes = [];
  const relay = await createRelayServer({
    deviceTokens: { [deviceId]: token },
    sendPush: async (target, event) => pushes.push({ target, event }),
  });
  const device = await connect(relay.port, 'device');
  const phone = await connect(relay.port, 'phone');
  try {
    const registration = nextJson(phone);
    phone.send(JSON.stringify({
      type: 'push_registration', platform: 'android', pushToken: 'push-token-0123456789',
      enabled: true, silentCompletionSessionIds: ['session-1'],
    }));
    assert.deepEqual(await registration, {
      type: 'push_registration_result', ok: true, message: '系统推送已注册',
    });
    const snapshot = (state, message) => JSON.stringify({
      type: 'snapshot', machine: { id: deviceId, name: 'Windows Studio' },
      sessions: [{ id: 'session-1', title: '贾维斯会话', state, message }],
    });
    device.send(snapshot('running', '第一段工作'));
    device.send(snapshot('running', '文字变化但灯不变'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pushes.length, 0);
    device.send(snapshot('completed', '巡检完成'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].event.type, 'lamp_changed');
    assert.equal(pushes[0].event.fromState, 'running');
    assert.equal(pushes[0].event.toState, 'completed');
    assert.equal(pushes[0].event.silent, true);
    assert.equal(pushes[0].event.reminder, false);
    assert.equal(pushes[0].target.platform, 'android');

    const unregister = nextType(phone, 'push_registration_result');
    phone.send(JSON.stringify({
      type: 'push_registration', platform: 'android', pushToken: 'push-token-0123456789', enabled: false,
    }));
    assert.equal((await unregister).ok, true);
    device.send(snapshot('blocked', '明确受阻'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pushes.length, 1);
  } finally {
    device.close();
    phone.close();
    await relay.close();
  }
});

test('repeats an unread lamp push every interval until that phone acknowledges it', async () => {
  const pushes = [];
  const pushToken = 'lan-phone-token-012345';
  const relay = await createRelayServer({
    deviceTokens: { [deviceId]: token },
    pushReminderMs: 20,
    sendPush: async (target, event) => pushes.push({ target, event }),
  });
  const device = await connect(relay.port, 'device');
  try {
    const registerEndpoint = `http://127.0.0.1:${relay.port}/push/register/${deviceId}?token=${token}`;
    const registration = await fetch(registerEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'android', pushToken, enabled: true }),
    });
    assert.equal(registration.status, 200);
    const snapshot = (state) => JSON.stringify({
      type: 'snapshot', machine: { id: deviceId, name: 'Windows' },
      sessions: [{ id: 'session-1', title: '开发', state }],
    });
    device.send(snapshot('running'));
    device.send(snapshot('blocked'));
    await waitFor(() => pushes.length >= 2);
    assert.equal(pushes[0].event.reminder, false);
    assert.equal(pushes[1].event.reminder, true);

    const readEndpoint = `http://127.0.0.1:${relay.port}/push/read/${deviceId}`;
    assert.equal((await fetch(readEndpoint, { method: 'POST', body: '{}' })).status, 401);
    const staleRead = await fetch(`${readEndpoint}?token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'android', pushToken, sessionId: 'session-1', state: 'completed' }),
    });
    assert.equal(staleRead.status, 200);
    const countAfterStaleRead = pushes.length;
    await waitFor(() => pushes.length > countAfterStaleRead);
    const read = await fetch(`${readEndpoint}?token=${token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'android', pushToken, sessionId: 'session-1', state: 'blocked' }),
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), {
      type: 'push_read_result', ok: true, message: '未读提醒已清除',
    });
    const countAfterRead = pushes.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(pushes.length, countAfterRead);
  } finally {
    device.close();
    await relay.close();
  }
});

test('does not claim push registration success when no provider is configured', async () => {
  const relay = await createRelayServer({ deviceTokens: { [deviceId]: token } });
  const phone = await connect(relay.port, 'phone');
  try {
    const result = nextJson(phone);
    phone.send(JSON.stringify({
      type: 'push_registration', platform: 'android', pushToken: 'push-token-0123456789', enabled: true,
    }));
    assert.deepEqual(await result, {
      type: 'push_registration_result', ok: false, message: '远程中继尚未配置系统推送',
    });
  } finally {
    phone.close();
    await relay.close();
  }
});

test('allows a LAN-connected phone to register push over authenticated HTTP', async () => {
  const pushes = [];
  const relay = await createRelayServer({
    deviceTokens: { [deviceId]: token },
    sendPush: async (target, event) => pushes.push({ target, event }),
  });
  const device = await connect(relay.port, 'device');
  try {
    const endpoint = `http://127.0.0.1:${relay.port}/push/register/${deviceId}`;
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
    const registration = await fetch(`${endpoint}?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'android', pushToken: 'lan-phone-token-012345', enabled: true,
        silentCompletionSessionIds: [],
      }),
    });
    assert.equal(registration.status, 200);
    assert.equal((await registration.json()).ok, true);
    const snapshot = (state) => JSON.stringify({
      type: 'snapshot', machine: { id: deviceId, name: 'Mac' },
      sessions: [{ id: 's1', title: '开发', state }],
    });
    device.send(snapshot('running'));
    device.send(snapshot('blocked'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].target.pushToken, 'lan-phone-token-012345');
  } finally {
    device.close();
    await relay.close();
  }
});
