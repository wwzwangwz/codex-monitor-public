const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  AppServerClient,
  createAppServerGoalCommander,
  createAppServerGoalStore,
  createAppServerGuidanceSender,
  createAppServerThreadStore,
  defaultCodexPath,
} = require('../src/lib/app-server');

function fakeAppServer(handler, requests = []) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.id == null) continue;
      const result = request.method === 'initialize' ? { userAgent: 'test' } : handler(request);
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    }
  });
  return child;
}

function controllableAppServer(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0);
  };
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const request = JSON.parse(line);
      const response = handler(request);
      if (request.id != null && response !== undefined) {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: response })}\n`);
      }
    }
  });
  return child;
}

test('app-server client initializes once and routes JSONL responses', async () => {
  const calls = [];
  const requests = [];
  const spawns = [];
  const client = new AppServerClient({
    spawnProcess: (command, args, options) => {
      spawns.push({ command, args, options });
      return fakeAppServer((request) => {
      calls.push(request);
      return { thread: { id: request.params.threadId, turns: [] } };
      }, requests);
    },
    command: 'C:\\Codex\\codex.exe',
    timeoutMs: 200,
  });
  const result = await client.request('thread/resume', { threadId: 'thread-1' });
  assert.equal(result.thread.id, 'thread-1');
  assert.deepEqual(calls.map((call) => call.method), ['thread/resume']);
  assert.deepEqual(spawns[0].args, ['--enable', 'goals', 'app-server', '--listen', 'stdio://']);
  assert.deepEqual(requests[0].params.capabilities, { experimentalApi: true });
  client.close();
});

test('request timeout destroys the hung app-server and the next request starts a fresh one', async () => {
  const children = [];
  const client = new AppServerClient({
    spawnProcess: () => {
      const generation = children.length;
      const child = controllableAppServer((request) => {
        if (request.method === 'initialize') return { userAgent: 'test' };
        if (generation === 0) return undefined;
        return { goal: { status: 'active' } };
      });
      children.push(child);
      return child;
    },
    timeoutMs: 25,
  });

  await assert.rejects(
    client.request('thread/goal/get', { threadId: 'thread-1' }),
    /thread\/goal\/get timed out/,
  );
  assert.equal(children[0].killed, true);
  assert.equal(client.pending.size, 0);

  const result = await client.request('thread/goal/get', { threadId: 'thread-1' });
  assert.equal(result.goal.status, 'active');
  assert.equal(children.length, 2);
  client.close();
});

test('initialize timeout destroys the hung app-server and permits a clean restart', async () => {
  const children = [];
  const client = new AppServerClient({
    spawnProcess: () => {
      const generation = children.length;
      const child = controllableAppServer((request) => {
        if (generation === 0) return undefined;
        if (request.method === 'initialize') return { userAgent: 'test' };
        return { thread: { id: request.params.threadId } };
      });
      children.push(child);
      return child;
    },
    timeoutMs: 25,
  });

  await assert.rejects(
    client.request('thread/read', { threadId: 'thread-1' }),
    /initialize timed out/,
  );
  assert.equal(children[0].killed, true);
  assert.equal(client.pending.size, 0);

  const result = await client.request('thread/read', { threadId: 'thread-1' });
  assert.equal(result.thread.id, 'thread-1');
  assert.equal(children.length, 2);
  client.close();
});

test('late output from a terminated app-server cannot corrupt its replacement', async () => {
  const children = [];
  const client = new AppServerClient({
    spawnProcess: () => {
      const generation = children.length;
      const child = controllableAppServer((request) => {
        if (request.method === 'initialize') return { userAgent: 'test' };
        if (generation === 0) return undefined;
        children[0].stdout.write('{"id":999');
        return { thread: { id: request.params.threadId } };
      });
      children.push(child);
      return child;
    },
    timeoutMs: 25,
  });

  await assert.rejects(
    client.request('thread/goal/get', { threadId: 'thread-1' }),
    /thread\/goal\/get timed out/,
  );

  const result = await client.request('thread/read', { threadId: 'thread-1' });
  assert.equal(result.thread.id, 'thread-1');
  client.close();
});

test('one timeout rejects every request pending on the same broken app-server', async () => {
  const children = [];
  const client = new AppServerClient({
    spawnProcess: () => {
      const child = controllableAppServer((request) => (
        request.method === 'initialize' ? { userAgent: 'test' } : undefined
      ));
      children.push(child);
      return child;
    },
    timeoutMs: 25,
  });
  await client.start();

  const results = await Promise.allSettled([
    client.request('thread/read', { threadId: 'thread-1' }),
    client.request('thread/goal/get', { threadId: 'thread-2' }),
  ]);

  assert.deepEqual(results.map((value) => value.status), ['rejected', 'rejected']);
  assert.match(results[0].reason.message, /thread\/read timed out/);
  assert.match(results[1].reason.message, /thread\/read timed out/);
  assert.equal(children[0].killed, true);
  assert.equal(client.pending.size, 0);
});

test('Windows CLI discovery prefers the plugin app-server Codex binary', () => {
  const localAppData = 'C:\\Users\\tester\\AppData\\Local';
  const expected = path.win32.join(
    'C:\\Users\\tester', '.codex', 'plugins', '.plugin-appserver', 'codex.exe',
  );
  const result = defaultCodexPath({
    platform: 'win32',
    env: { LOCALAPPDATA: localAppData },
    homedir: 'C:\\Users\\tester',
    isAccessible: () => true,
  });
  assert.equal(result, expected);
});

test('Goal store reads every selected Goal through the official API', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (params.threadId === 'thread-1') {
        return { goal: { status: 'usageLimited', objective: 'Continue safely', updatedAt: 42 } };
      }
      return { goal: null };
    },
  };
  const store = createAppServerGoalStore({ client });

  const statuses = await store.refresh(['thread-1', 'thread-2']);

  assert.deepEqual(calls, [
    { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
    { method: 'thread/goal/get', params: { threadId: 'thread-2' } },
  ]);
  assert.deepEqual(statuses.get('thread-1'), {
    status: 'usage_limited', objective: 'Continue safely', updated_at_ms: 42000,
  });
  assert.equal(statuses.has('thread-2'), false);
  assert.equal(store.current(), statuses);
});

test('thread store reads selected user-facing names through the official API', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (params.threadId === 'thread-1') {
        return { thread: { id: 'thread-1', name: ' Renamed task ' } };
      }
      return { thread: { id: 'thread-2', name: null } };
    },
  };
  const store = createAppServerThreadStore({ client });

  const names = await store.refresh(['thread-1', 'thread-2']);

  assert.deepEqual(calls, [
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: false } },
    { method: 'thread/read', params: { threadId: 'thread-2', includeTurns: false } },
  ]);
  assert.equal(names.get('thread-1'), 'Renamed task');
  assert.equal(names.has('thread-2'), false);
  assert.equal(store.current(), names);
});

test('fallback steers the exact active turn without starting another turn', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') {
        return { thread: { turns: [{ id: 'turn-active', status: 'inProgress' }] } };
      }
      return { turnId: 'turn-active' };
    },
  };
  const send = createAppServerGuidanceSender({ client, waitForReceipt: async () => true });
  const result = await send({
    sessionId: 'thread-1', text: '继续', mode: 'steer', attachments: [], rolloutPath: null,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1], {
    method: 'turn/steer',
    params: {
      threadId: 'thread-1', expectedTurnId: 'turn-active',
      input: [{ type: 'text', text: '继续', text_elements: [] }],
    },
  });
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
});

test('fallback stages guidance images in the configured monitor-owned directory', async () => {
  const attachmentDirectory = 'C:\\MonitorData\\guidance-attachments';
  let stagedStorageDirectory;
  let retainedSessionId;
  const client = {
    async request(method) {
      if (method === 'thread/resume') {
        return { thread: { turns: [{ id: 'turn-active', status: 'inProgress' }] } };
      }
      return { turnId: 'turn-active' };
    },
  };
  const send = createAppServerGuidanceSender({
    client,
    attachmentDirectory,
    stageAttachments: (_attachments, options) => {
      stagedStorageDirectory = options?.storageDirectory;
      return { files: [{ name: 'phone.png', path: 'C:\\MonitorData\\phone.png' }], cleanup() {} };
    },
    retainAttachments: (_staged, { sessionId }) => { retainedSessionId = sessionId; },
    waitForReceipt: async () => true,
  });

  const result = await send({
    sessionId: 'thread-1',
    text: '',
    mode: 'steer',
    attachments: [{ name: 'phone.png', mimeType: 'image/png', data: Buffer.from('png') }],
    rolloutPath: null,
  });

  assert.equal(result.ok, true);
  assert.equal(stagedStorageDirectory, attachmentDirectory);
  assert.equal(retainedSessionId, 'thread-1');
});

test('fallback immediately cleans staged images when the rollout receipt is missing', async () => {
  let cleaned = false;
  let retained = false;
  const client = {
    async request(method) {
      if (method === 'thread/resume') {
        return { thread: { turns: [{ id: 'turn-active', status: 'inProgress' }] } };
      }
      return { turnId: 'turn-active' };
    },
  };
  const send = createAppServerGuidanceSender({
    client,
    stageAttachments: () => ({
      files: [{ name: 'phone.png', path: 'C:\\MonitorData\\phone.png' }],
      cleanup: () => { cleaned = true; },
    }),
    retainAttachments: () => { retained = true; },
    waitForReceipt: async () => false,
  });

  await assert.rejects(send({
    sessionId: 'thread-1',
    text: '',
    mode: 'steer',
    attachments: [{ name: 'phone.png', mimeType: 'image/png', data: Buffer.from('png') }],
    rolloutPath: __filename,
  }), /no receipt/i);
  assert.equal(cleaned, true);
  assert.equal(retained, false);
});

test('fallback allows delayed rollout persistence before reporting steer failure', async () => {
  const client = {
    async request(method) {
      if (method === 'thread/resume') {
        return { thread: { turns: [{ id: 'turn-active', status: 'inProgress' }] } };
      }
      return { turnId: 'turn-active' };
    },
  };
  let receiptTimeoutMs = 0;
  const send = createAppServerGuidanceSender({
    client,
    waitForReceipt: async (_rolloutPath, _start, _text, _attachments, timeoutMs) => {
      receiptTimeoutMs = timeoutMs;
      return timeoutMs >= 20_000;
    },
  });

  const result = await send({
    sessionId: 'thread-1',
    text: 'delayed Windows steer receipt',
    mode: 'steer',
    attachments: [],
    rolloutPath: __filename,
  });

  assert.equal(result.ok, true);
  assert.ok(receiptTimeoutMs >= 20_000);
});

test('fallback refuses to emulate queue on a stopped thread', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') return { thread: { turns: [{ id: 'old', status: 'failed' }] } };
      return { turn: { id: 'new-turn' } };
    },
  };
  const send = createAppServerGuidanceSender({ client, waitForReceipt: async () => true });
  await assert.rejects(
    send({ sessionId: 'thread-1', text: '继续', mode: 'queue', attachments: [], rolloutPath: null }),
    /cannot safely queue/,
  );
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
});

test('fallback refuses to emulate queue on an active turn', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      return { thread: { turns: [{ id: 'turn-active', status: 'inProgress' }] } };
    },
  };
  const send = createAppServerGuidanceSender({ client, waitForReceipt: async () => true });
  await assert.rejects(
    send({ sessionId: 'thread-1', text: '稍后执行', mode: 'queue', attachments: [], rolloutPath: null }),
    /cannot safely queue/,
  );
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
});

test('fallback Goal commands use official set, native steer, and confirmed clear methods', async () => {
  const calls = [];
  let goalStatus = 'blocked';
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: goalStatus } };
      if (method === 'thread/goal/set') {
        goalStatus = params.status;
        return { goal: { status: goalStatus } };
      }
      return { cleared: true };
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async () => ({ ok: true }),
  });
  assert.equal((await execute({
    sessionId: 'thread-1',
    command: 'resume',
    sessionState: 'blocked',
  })).ok, true);
  assert.equal((await execute({
    sessionId: 'thread-1',
    command: 'delete',
    confirmed: true,
  })).ok, true);
  assert.deepEqual(calls, [
    { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
    { method: 'thread/goal/set', params: { threadId: 'thread-1', status: 'active' } },
    { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
    { method: 'thread/goal/clear', params: { threadId: 'thread-1' } },
  ]);
});

test('fallback Goal resume trusts the authorized native idle state when plugin turns are stale-running', async () => {
  const calls = [];
  const deliveries = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'active' } };
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'stale-plugin-turn', status: 'inProgress' }] };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async (input) => {
      deliveries.push(input);
      return { ok: true, message: 'accepted' };
    },
  });

  const result = await execute({
    sessionId: 'thread-1',
    command: 'resume',
    sessionState: 'completed',
    sessionTitle: 'Disposable Goal fixture',
  });

  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].sessionId, 'thread-1');
  assert.equal(deliveries[0].sessionTitle, 'Disposable Goal fixture');
  assert.equal(deliveries[0].mode, 'steer');
  assert.match(deliveries[0].text, /continue the current Goal/i);
  assert.equal(calls.some((call) => call.method === 'thread/goal/set'), false);
  assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(calls.some((call) => call.method === 'thread/turns/list'), false);
});

test('fallback Goal resume trusts the authorized native running state when plugin turns are stale-completed', async () => {
  const calls = [];
  const deliveries = [];
  let goalStatus = 'paused';
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: goalStatus } };
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'stale-plugin-turn', status: 'completed' }] };
      }
      if (method === 'thread/goal/set') {
        goalStatus = params.status;
        return { goal: { status: goalStatus } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async (input) => {
      deliveries.push(input);
      return { ok: true };
    },
  });

  const result = await execute({
    sessionId: 'thread-1',
    command: 'resume',
    sessionState: 'running',
  });

  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 0);
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active'],
  );
});

test('fallback Goal resume restores a paused idle Goal and steers the original thread once', async () => {
  const calls = [];
  const deliveries = [];
  let goalStatus = 'paused';
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: goalStatus } };
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'old-turn', status: 'completed' }] };
      }
      if (method === 'thread/goal/set') {
        goalStatus = params.status;
        return { goal: { status: goalStatus } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async (input) => {
      deliveries.push(input);
      return { ok: true };
    },
  });

  const result = await execute({
    sessionId: 'thread-1',
    command: 'resume',
    sessionState: 'completed',
  });

  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].sessionId, 'thread-1');
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active'],
  );
});

test('fallback Goal resume restores paused when its idle continuation steer fails', async () => {
  const calls = [];
  let goalStatus = 'paused';
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: goalStatus } };
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'old-turn', status: 'completed' }] };
      }
      if (method === 'thread/goal/set') {
        goalStatus = params.status;
        return { goal: { status: goalStatus } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async () => {
      throw new Error('native steer unavailable');
    },
  });

  await assert.rejects(
    execute({
      sessionId: 'thread-1',
      command: 'resume',
      sessionState: 'completed',
    }),
    /native steer unavailable/,
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active', 'paused'],
  );
});

test('fallback Goal resume activates a stopped blocked Goal and steers the same thread once', async () => {
  const calls = [];
  const deliveries = [];
  let goalStatus = 'blocked';
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: goalStatus } };
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'old-turn', status: 'completed' }] };
      }
      if (method === 'thread/goal/set') {
        goalStatus = params.status;
        return { goal: { status: goalStatus } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async (input) => {
      deliveries.push(input);
      return { ok: true };
    },
  });

  const result = await execute({
    sessionId: 'thread-1',
    command: 'resume',
    sessionState: 'blocked',
  });

  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].sessionId, 'thread-1');
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active'],
  );
  assert.equal(calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
});

test('fallback Goal resume rolls back the previous blocked status when native steer fails', async () => {
  const calls = [];
  let goalStatus = 'blocked';
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: goalStatus } };
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'old-turn', status: 'completed' }] };
      }
      if (method === 'thread/goal/set') {
        goalStatus = params.status;
        return { goal: { status: goalStatus } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async () => ({ ok: false, message: 'native steer unavailable' }),
  });

  await assert.rejects(
    execute({
      sessionId: 'thread-1',
      command: 'resume',
      sessionState: 'blocked',
    }),
    /native steer unavailable/,
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active', 'blocked'],
  );
});

test('fallback Goal deletion requires confirmation before clearing the Goal association', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      return { cleared: true };
    },
  };
  const execute = createAppServerGoalCommander({ client });

  await assert.rejects(
    execute({
      sessionId: 'thread-1',
      command: 'delete',
      confirmed: false,
    }),
    /confirmed: true/,
  );
  assert.equal(calls.some((call) => call.method === 'thread/goal/clear'), false);
});

test('fallback Goal resume rejects a non-paused Goal whose authorized native turn is running', async () => {
  const calls = [];
  let deliveries = 0;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'blocked' } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async () => {
      deliveries += 1;
      return { ok: true };
    },
  });

  await assert.rejects(
    execute({ sessionId: 'thread-1', command: 'resume', sessionState: 'running' }),
    /turn is still running/,
  );
  assert.deepEqual(calls, [
    { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
  ]);
  assert.equal(deliveries, 0);
});

test('fallback Goal resume rejects an unsupported official Goal state before reading turns', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'complete' } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({ client });

  await assert.rejects(
    execute({ sessionId: 'thread-1', command: 'resume' }),
    /Goal status complete cannot be resumed/,
  );
  assert.deepEqual(calls, [
    { method: 'thread/goal/get', params: { threadId: 'thread-1' } },
  ]);
});

test('fallback Goal resume rejects a missing authoritative native turn state without steering', async () => {
  let deliveries = 0;
  const client = {
    async request(method) {
      if (method === 'thread/goal/get') return { goal: { status: 'active' } };
      throw new Error(`unexpected ${method}`);
    },
  };
  const execute = createAppServerGoalCommander({
    client,
    resumeThread: async () => {
      deliveries += 1;
      return { ok: true };
    },
  });

  await assert.rejects(
    execute({ sessionId: 'thread-1', command: 'resume' }),
    /authoritative session turn state is unavailable/,
  );
  assert.equal(deliveries, 0);
});
