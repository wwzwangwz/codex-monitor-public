const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMonitorServer, pairingPayload, validateGoalCommandRequest } = require('../src/lib/server');

function decodePairing(value) {
  const encoded = new URL(value).searchParams.get('data');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('pairing payload contains versioned connection data', () => {
  const value = pairingPayload({ machineId: 'm1', machineName: 'Studio', port: 4455, token: 'secret' });
  const data = decodePairing(value);
  assert.equal(data.v, 1);
  assert.equal(data.id, 'm1');
  assert.equal(data.name, 'Studio');
  assert.equal(data.token, 'secret');
  assert.match(data.wsUrl, /^ws:\/\/[^:]+:4455\/monitor$/);
  assert.deepEqual(Object.keys(data).sort(), ['id', 'name', 'token', 'v', 'wsUrl']);
});

test('adds LAN and Relay endpoints only while Relay is enabled', async () => {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
  });
  try {
    server.setRelayWsUrl('wss://relay.example/relay/phone/m1');
    const relayPairing = decodePairing(server.pairing);
    assert.equal(relayPairing.v, 2);
    assert.equal(relayPairing.wsUrl, relayPairing.lanWsUrl);
    assert.equal(relayPairing.relayWsUrl, 'wss://relay.example/relay/phone/m1');

    server.setRelayWsUrl('');
    const lanPairing = decodePairing(server.pairing);
    assert.equal(lanPairing.v, 1);
    assert.deepEqual(Object.keys(lanPairing).sort(), ['id', 'name', 'token', 'v', 'wsUrl']);
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
  const data = decodePairing(server.pairing);
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

test('counts only sockets that registered Android or iOS client info as phones', async () => {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
  });
  const control = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  const android = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await Promise.all([control, android].map((socket) => new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    })));
    assert.equal(server.connectedClients(), 0);

    android.send(JSON.stringify({
      type: 'client_info',
      platform: 'android',
      appVersion: '0.11.1',
      versionCode: 29,
      statusProtocolVersion: 7,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.connectedClients(), 1);

    control.close();
    await new Promise((resolve) => control.once('close', resolve));
    assert.equal(server.connectedClients(), 1);

    android.close();
    await new Promise((resolve) => android.once('close', resolve));
    await waitFor(() => server.connectedClients() === 0);
    assert.equal(server.connectedClients(), 0);
  } finally {
    control.close();
    android.close();
    server.close();
  }
});

test('serves only authenticated evidence images from the active whitelist', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-server-'));
  const imagePath = path.join(directory, 'result.png');
  fs.writeFileSync(imagePath, 'evidence-image');
  const server = await createMonitorServer({
    machineId: 'm1', machineName: 'Studio', pairingToken: '123456789012345678901234',
    preferredPort: 0, snapshot: () => [],
    evidenceFile: (id) => id === 'a'.repeat(32)
      ? { path: imagePath, mimeType: 'image/png', size: 14, name: 'result.png' }
      : null,
  });
  try {
    const url = `http://127.0.0.1:${server.port}/evidence/${'a'.repeat(32)}`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(`${url}?token=${server.token}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'evidence-image');
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/evidence/${'b'.repeat(32)}?token=${server.token}`)).status, 404);
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
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
    const apkResponse = await fetch(`http://127.0.0.1:${server.port}${metadata.downloadPath}?token=${server.token}`);
    assert.equal(await apkResponse.text(), 'test-apk');
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/android/latest.json`)).status, 401);
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true });
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

test('accepts iOS protocol-v6 client metadata', async () => {
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
      platform: 'ios',
      appVersion: '0.8.5',
      versionCode: 85,
      statusProtocolVersion: 6,
      releaseNotes: ['Protocol v6'],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.connectedClientInfo()[0].platform, 'ios');
    assert.equal(server.connectedClientInfo()[0].statusProtocolVersion, 6);
  } finally {
    socket.close();
    server.close();
  }
});

test('requires a bounded request ID for Goal command correlation', () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  assert.throws(() => validateGoalCommandRequest({ sessionId, command: 'resume' }), /request ID/);
  assert.throws(() => validateGoalCommandRequest({
    requestId: 'x'.repeat(81), sessionId, command: 'resume',
  }), /request ID/);
  assert.deepEqual(validateGoalCommandRequest({
    requestId: 'goal-1', sessionId, command: 'delete', confirmed: true,
  }), {
    sessionId,
    command: 'delete',
    confirmed: true,
  });
});

async function exchangeGuidance(serverOptions, payload) {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
    ...serverOptions,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  const messages = [];
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('guidance result timed out')), 500);
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.requestId !== payload.requestId) return;
        messages.push(value);
        if (value.type === 'guidance_result') {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
    socket.send(JSON.stringify(payload));
    return { messages, result: await resultPromise };
  } finally {
    socket.close();
    server.close();
  }
}

test('decodes image-only and mixed guidance before ACK and selected-session validation', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  const data = Buffer.from('png');
  for (const [index, text] of ['', 'inspect this'].entries()) {
    let validated;
    let received;
    const { messages, result } = await exchangeGuidance({
      validateGuidanceRequest: (value) => { validated = value; return value; },
      sendGuidance: async (value) => { received = value; return { ok: true, message: 'submitted' }; },
    }, {
      type: 'guidance',
      requestId: `image-${index}`,
      sessionId,
      text,
      mode: 'steer',
      attachments: [{
        name: 'screen.png',
        mimeType: 'image/png',
        sizeBytes: data.length,
        dataBase64: data.toString('base64'),
      }],
    });

    assert.equal(messages[0].type, 'guidance_ack');
    assert.equal(result.ok, true);
    assert.ok(Buffer.isBuffer(validated.attachments[0].data));
    assert.deepEqual(received.attachments[0].data, data);
    assert.equal(received.text, text);
  }
});

test('rejects malformed image guidance before ACK or handler invocation', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  let invocations = 0;
  const { messages, result } = await exchangeGuidance({
    sendGuidance: async () => { invocations += 1; return { ok: true }; },
  }, {
    type: 'guidance',
    requestId: 'bad-image',
    sessionId,
    text: '',
    mode: 'queue',
    attachments: [{
      name: 'screen.png', mimeType: 'image/png', sizeBytes: 1, dataBase64: 'not-base64',
    }],
  });

  assert.equal(invocations, 0);
  assert.equal(messages.some((value) => value.type === 'guidance_ack'), false);
  assert.equal(result.ok, false);
  assert.match(result.message, /format/i);
});

test('acknowledges validated phone guidance before returning the selected Codex session result', async () => {
  let received;
  const sessionId = '00000000-0000-4000-8000-000000000101';
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
    const messages = [];
    const resultPromise = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        messages.push(value);
        if (value.type === 'guidance_result') resolve(value);
      });
    });
    socket.send(JSON.stringify({
      type: 'guidance', requestId: 'r1', sessionId, text: 'continue', mode: 'queue',
    }));
    const result = await resultPromise;
    assert.deepEqual(received, { sessionId, text: 'continue', mode: 'queue', attachments: [] });
    assert.equal(messages[0].type, 'guidance_ack');
    assert.equal(messages[0].requestId, 'r1');
    assert.equal(result.ok, true);
    assert.equal(result.requestId, 'r1');
  } finally {
    socket.close();
    server.close();
  }
});

test('rejects invalid guidance without acknowledging or invoking the handler', async () => {
  let invocations = 0;
  const sessionId = '00000000-0000-4000-8000-000000000101';
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
    sendGuidance: async () => { invocations += 1; return { ok: true }; },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const responses = [];
    socket.on('message', (raw) => responses.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ type: 'guidance', requestId: 'missing-mode', sessionId, text: 'continue' }));
    socket.send(JSON.stringify({ type: 'guidance', requestId: 'invalid-mode', sessionId, text: 'continue', mode: 'resume' }));
    socket.send(JSON.stringify({ type: 'guidance', requestId: 'too-long', sessionId, text: 'x'.repeat(2001), mode: 'steer' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(invocations, 0);
    assert.equal(responses.filter((value) => value.type === 'guidance_ack').length, 0);
    assert.equal(responses.filter((value) => value.type === 'guidance_result' && !value.ok).length, 3);
  } finally {
    socket.close();
    server.close();
  }
});

test('does not acknowledge guidance rejected by the selected-session allowlist', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  let invocations = 0;
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
    validateGuidanceRequest: () => { throw new Error('conversation is not selected'); },
    sendGuidance: async () => { invocations += 1; return { ok: true }; },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const responses = [];
    socket.on('message', (raw) => responses.push(JSON.parse(raw.toString())));
    socket.send(JSON.stringify({ type: 'guidance', requestId: 'unselected', sessionId, text: 'continue', mode: 'steer' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(invocations, 0);
    assert.equal(responses.filter((value) => value.type === 'guidance_ack').length, 0);
    assert.equal(responses.filter((value) => value.type === 'guidance_result' && !value.ok).length, 1);
  } finally {
    socket.close();
    server.close();
  }
});

async function exchangeGoalCommand(serverOptions, payload) {
  const server = await createMonitorServer({
    machineId: 'm1',
    machineName: 'Studio',
    pairingToken: '123456789012345678901234',
    preferredPort: 0,
    snapshot: () => [],
    ...serverOptions,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/monitor?token=${server.token}`);
  const messages = [];
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Goal command result timed out')), 500);
      socket.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        if (value.requestId !== payload.requestId) return;
        messages.push(value);
        if (value.type === 'goal_command_result') {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
    socket.send(JSON.stringify(payload));
    const result = await resultPromise;
    return { messages, result };
  } finally {
    socket.close();
    server.close();
  }
}

test('acknowledges resume and delete before returning their native results', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  for (const command of ['resume', 'delete']) {
    let received;
    const { messages, result } = await exchangeGoalCommand({
      sendGoalCommand: async (value) => {
        received = value;
        return { ok: true, message: `${command} complete` };
      },
    }, {
      type: 'goal_command',
      requestId: `goal-${command}`,
      sessionId,
      command,
      confirmed: command === 'delete',
    });

    assert.deepEqual(received, { sessionId, command, confirmed: command === 'delete' });
    assert.equal(messages[0].type, 'goal_command_ack');
    assert.equal(messages[0].requestId, `goal-${command}`);
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.command, command);
  }
});

test('rejects unconfirmed Goal deletion without ACK or handler invocation', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  for (const [index, confirmed] of [undefined, false, 'true', 1].entries()) {
    let invocations = 0;
    const payload = {
      type: 'goal_command',
      requestId: `goal-unconfirmed-${index}`,
      sessionId,
      command: 'delete',
    };
    if (confirmed !== undefined) payload.confirmed = confirmed;
    const { messages, result } = await exchangeGoalCommand({
      sendGoalCommand: async () => { invocations += 1; return { ok: true }; },
    }, payload);

    assert.equal(invocations, 0);
    assert.equal(messages.some((value) => value.type === 'goal_command_ack'), false);
    assert.equal(result.ok, false);
    assert.match(result.message, /confirmed: true/);
  }
});

test('rejects invalid Goal commands without ACK or handler invocation', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  let invocations = 0;
  const { messages, result } = await exchangeGoalCommand({
    sendGoalCommand: async () => { invocations += 1; return { ok: true }; },
  }, {
    type: 'goal_command',
    requestId: 'goal-invalid',
    sessionId,
    command: 'pause',
  });

  assert.equal(invocations, 0);
  assert.equal(messages.some((value) => value.type === 'goal_command_ack'), false);
  assert.equal(result.ok, false);
  assert.match(result.message, /resume or delete/);
});

test('does not ACK a Goal command rejected by selected-session authorization', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  let invocations = 0;
  const { messages, result } = await exchangeGoalCommand({
    validateGoalCommandRequest: () => { throw new Error('session is not selected for monitoring'); },
    sendGoalCommand: async () => { invocations += 1; return { ok: true }; },
  }, {
    type: 'goal_command',
    requestId: 'goal-unselected',
    sessionId,
    command: 'delete',
    confirmed: true,
  });

  assert.equal(invocations, 0);
  assert.equal(messages.some((value) => value.type === 'goal_command_ack'), false);
  assert.equal(result.ok, false);
  assert.match(result.message, /not selected/);
});

test('returns a failed final result when the native Goal handler rejects after ACK', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000101';
  const { messages, result } = await exchangeGoalCommand({
    sendGoalCommand: async () => { throw new Error('native Goal dispatcher is unavailable'); },
  }, {
    type: 'goal_command',
    requestId: 'goal-native-failure',
    sessionId,
    command: 'resume',
  });

  assert.equal(messages[0].type, 'goal_command_ack');
  assert.equal(result.ok, false);
  assert.match(result.message, /dispatcher is unavailable/);
});
