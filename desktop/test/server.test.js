const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createMonitorServer, pairingPayload } = require('../src/lib/server');

test('pairing payload contains versioned connection data', () => {
  const value = pairingPayload({ machineId: 'm1', machineName: 'Studio', port: 4455, token: 'secret' });
  const encoded = new URL(value).searchParams.get('data');
  const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert.equal(data.v, 1);
  assert.equal(data.id, 'm1');
  assert.equal(data.name, 'Studio');
  assert.equal(data.token, 'secret');
  assert.match(data.wsUrl, /^ws:\/\/[^:]+:4455\/monitor$/);
});

test('pairing payload adds a relay endpoint without replacing the LAN endpoint', () => {
  const value = pairingPayload({
    machineId: 'm1', machineName: 'Studio', port: 4455, token: 'secret',
    relayWsUrl: 'wss://relay.example/relay/phone/m1',
  });
  const data = JSON.parse(Buffer.from(new URL(value).searchParams.get('data'), 'base64url').toString('utf8'));
  assert.equal(data.v, 2);
  assert.equal(data.wsUrl, data.lanWsUrl);
  assert.match(data.lanWsUrl, /^ws:\/\/[^:]+:4455\/monitor$/);
  assert.equal(data.relayWsUrl, 'wss://relay.example/relay/phone/m1');
});

test('LAN-only pairing stays on v1 for stable mobile compatibility', () => {
  const value = pairingPayload({
    machineId: 'm1', machineName: 'Studio', port: 4455, token: 'secret', hostName: 'studio.local',
  });
  const data = JSON.parse(Buffer.from(new URL(value).searchParams.get('data'), 'base64url').toString('utf8'));
  assert.equal(data.v, 1);
  assert.match(data.wsUrl, /^ws:\/\/[^:]+:4455\/monitor$/);
  assert.equal(data.lanWsUrl, undefined);
  assert.equal(data.lanHostWsUrl, undefined);
});

test('running server can add and remove the optional relay endpoint', async () => {
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: 'secret', preferredPort: 0, snapshot: () => [],
  });
  try {
    server.setRelayWsUrl('wss://relay.example/relay/phone/m1');
    let data = JSON.parse(Buffer.from(new URL(server.pairing).searchParams.get('data'), 'base64url').toString('utf8'));
    assert.equal(data.v, 2);
    assert.equal(data.relayWsUrl, 'wss://relay.example/relay/phone/m1');
    server.setRelayWsUrl('');
    data = JSON.parse(Buffer.from(new URL(server.pairing).searchParams.get('data'), 'base64url').toString('utf8'));
    assert.equal(data.v, 1);
    assert.equal(data.relayWsUrl, undefined);
  } finally {
    server.close();
  }
});

test('authenticated phones receive selected session snapshots', async () => {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [{ id: 's1', title: 'Build', state: 'running', message: 'Compiling' }],
  });
  const data = JSON.parse(Buffer.from(new URL(server.pairing).searchParams.get('data'), 'base64url').toString('utf8'));
  const socket = new WebSocket(`${data.wsUrl}?token=${data.token}`);
  try {
    const message = await new Promise((resolve, reject) => {
      socket.once('message', (value) => resolve(JSON.parse(value.toString())));
      socket.once('error', reject);
    });
    assert.equal(message.machine.name, 'Studio');
    assert.equal(message.sessions[0].state, 'running');
  } finally {
    socket.close();
    server.close();
  }
});

test('records whether a phone WebSocket reached the desktop and passed authentication', async () => {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
  });
  const rejected = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=wrong-token`);
  try {
    await new Promise((resolve, reject) => {
      rejected.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve();
      });
      rejected.once('error', (error) => {
        if (error.message.includes('401')) resolve();
        else reject(error);
      });
    });
    assert.equal(server.connectionDiagnostics().upgradeAttempts, 1);
    assert.equal(server.connectionDiagnostics().rejected, 1);
    assert.equal(server.connectionDiagnostics().lastResult, 'invalid_token');

    const accepted = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
    await new Promise((resolve, reject) => {
      accepted.once('open', resolve);
      accepted.once('error', reject);
    });
    assert.equal(server.connectionDiagnostics().upgradeAttempts, 2);
    assert.equal(server.connectionDiagnostics().accepted, 1);
    assert.equal(server.connectionDiagnostics().lastResult, 'accepted');
    accepted.close();
  } finally {
    rejected.close();
    server.close();
  }
});

test('serves authenticated Android update metadata and APK', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-'));
  const apkPath = path.join(directory, 'app.apk');
  fs.writeFileSync(apkPath, 'test-apk');
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
    androidRelease: {
      versionCode: 2,
      versionName: '0.2.0',
      size: 8,
      sha256: 'example-sha',
      apkPath,
    },
  });
  try {
    const metadataResponse = await fetch(`http://127.0.0.1:${server.port}/android/latest.json?token=${server.token}`);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.versionCode, 2);
    assert.equal(metadata.downloadPath, '/android/apk');
    assert.equal(metadata.migration.v, 2);
    assert.match(metadata.migration.wsUrl, new RegExp(`:${server.port}/monitor$`));
    const apkResponse = await fetch(`http://127.0.0.1:${server.port}${metadata.downloadPath}?token=${server.token}`);
    assert.equal(await apkResponse.text(), 'test-apk');
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/android/latest.json`)).status, 401);
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test('serves only authenticated evidence images from the active whitelist', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-server-'));
  const imagePath = path.join(directory, 'result.png');
  fs.writeFileSync(imagePath, 'evidence-image');
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: '123456789012345678901234', preferredPort: 0,
    snapshot: () => [],
    evidenceFile: (id) => id === 'a'.repeat(32)
      ? { path: imagePath, mimeType: 'image/png', size: 14, name: 'result.png' }
      : null,
  });
  try {
    const url = `http://127.0.0.1:${server.port}/evidence/${'a'.repeat(32)}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(`${url}?token=${server.token}`)).headers.get('cache-control'), 'private, no-store');
    assert.equal(await (await fetch(`${url}?token=${server.token}`)).text(), 'evidence-image');
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/evidence/${'b'.repeat(32)}?token=${server.token}`)).status, 404);
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test('returns a timeout instead of leaving evidence downloads spinning forever', async () => {
  const neverOpeningStream = () => {
    const stream = new EventEmitter();
    stream.destroy = () => {};
    return stream;
  };
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: '123456789012345678901234', preferredPort: 0,
    snapshot: () => [],
    evidenceFile: () => ({ path: '/protected/result.png', mimeType: 'image/png', size: 14, name: 'result.png' }),
    createEvidenceReadStream: neverOpeningStream,
    evidenceOpenTimeoutMs: 100,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/evidence/${'a'.repeat(32)}?token=${server.token}`);
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: 'evidence_read_timeout' });
  } finally {
    server.close();
  }
});

test('receives Android version and release notes for desktop synchronization', async () => {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'client_info',
      platform: 'android',
      appVersion: '0.5.0',
      versionCode: 5,
      statusProtocolVersion: 2,
      releaseNotes: ['后台持续监控', '前台只显示 NEW'],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(server.connectedClientInfo()[0], {
      platform: 'android',
      appVersion: '0.5.0',
      versionCode: 5,
      statusProtocolVersion: 2,
      releaseNotes: ['后台持续监控', '前台只显示 NEW'],
      connectedAt: server.connectedClientInfo()[0].connectedAt,
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/clients?token=${server.token}`);
    assert.equal((await response.json()).clients[0].appVersion, '0.5.0');
  } finally {
    socket.close();
    server.close();
  }
});

test('receives iPhone version and release notes through the same client_info protocol', async () => {
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: '123456789012345678901234', preferredPort: 0, snapshot: () => [],
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({
      type: 'client_info', platform: 'ios', appVersion: '0.1.0', versionCode: 1,
      statusProtocolVersion: 4, releaseNotes: ['iPhone 首版'],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.connectedClientInfo()[0].platform, 'ios');
    assert.equal(server.connectedClientInfo()[0].statusProtocolVersion, 4);
  } finally {
    socket.close();
    server.close();
  }
});

test('routes authenticated phone guidance to the selected Codex session handler', async () => {
  let received;
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
    sendGuidance: async (value) => {
      received = value;
      return { ok: true, message: '已提交' };
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const resultPromise = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.type === 'guidance_result') resolve(value);
      });
    });
    socket.send(JSON.stringify({
      type: 'guidance', requestId: 'r1', sessionId: 's1', text: '继续执行', mode: 'queue',
    }));
    const result = await resultPromise;
    assert.deepEqual(received, { sessionId: 's1', text: '继续执行', mode: 'queue', attachments: [] });
    assert.equal(result.ok, true);
    assert.equal(result.requestId, 'r1');
  } finally {
    socket.close();
    server.close();
  }
});

test('validates and routes phone screenshot attachments without persisting them', async () => {
  let received;
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: '123456789012345678901234', preferredPort: 0,
    snapshot: () => [],
    sendGuidance: async (value) => {
      received = value;
      return { ok: true, message: '图片已提交' };
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const image = Buffer.from('phone-screenshot');
    const resultPromise = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.type === 'guidance_result') resolve(value);
      });
    });
    socket.send(JSON.stringify({
      type: 'guidance', requestId: 'image-1', sessionId: 's1', text: '', mode: 'steer',
      attachments: [{
        name: 'problem.png', mimeType: 'image/png', sizeBytes: image.length, dataBase64: image.toString('base64'),
      }],
    }));
    const result = await resultPromise;
    assert.equal(result.ok, true);
    assert.equal(received.text, '');
    assert.equal(received.attachments[0].name, 'problem.png');
    assert.deepEqual(received.attachments[0].data, image);
  } finally {
    socket.close();
    server.close();
  }
});

test('routes confirmed mobile Goal commands with ACK and final result', async () => {
  let received;
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: '123456789012345678901234', preferredPort: 0,
    snapshot: () => [],
    sendGoalCommand: async (value) => {
      received = value;
      return { ok: true, message: 'Goal 已删除' };
    },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const messages = [];
    const result = await new Promise((resolve) => {
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.type.startsWith('goal_command_')) messages.push(value.type);
        if (value.type === 'goal_command_result') resolve(value);
      });
      socket.send(JSON.stringify({
        type: 'goal_command', requestId: 'goal-1', sessionId: 's1', command: 'delete', confirmed: true,
      }));
    });
    assert.deepEqual(received, { sessionId: 's1', command: 'delete', confirmed: true });
    assert.deepEqual(messages, ['goal_command_ack', 'goal_command_result']);
    assert.equal(result.ok, true);
  } finally {
    socket.close();
    server.close();
  }
});
