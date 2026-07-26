const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { AppServerClient, createGoalController } = require('../src/lib/app-server');

function fakeAppServer(handler) {
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
      if (request.id != null) {
        const result = request.method === 'initialize' ? { userAgent: 'test' } : handler(request);
        child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
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
      if (response !== undefined) child.stdout.write(`${JSON.stringify({ id: request.id, result: response })}\n`);
    }
  });
  return child;
}

test('app-server client initializes once and routes JSON line responses', async () => {
  const calls = [];
  const client = new AppServerClient({
    spawnProcess: () => fakeAppServer((request) => {
      calls.push(request);
      return { goal: { status: 'blocked' } };
    }),
    timeoutMs: 200,
  });
  const result = await client.request('thread/goal/get', { threadId: 'thread-1' });
  assert.equal(result.goal.status, 'blocked');
  assert.deepEqual(calls.map((call) => call.method), ['thread/goal/get']);
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

  await assert.rejects(client.request('thread/goal/get', { threadId: 'thread-1' }), /超时/);
  assert.equal(children[0].killed, true);
  assert.equal(client.pending.size, 0);

  const result = await client.request('thread/goal/get', { threadId: 'thread-1' });
  assert.equal(result.goal.status, 'active');
  assert.equal(children.length, 2);
  client.close();
});

test('initialize timeout also permits a clean app-server restart', async () => {
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

  await assert.rejects(client.request('thread/read', { threadId: 'thread-1' }), /initialize 超时/);
  assert.equal(children[0].killed, true);
  const result = await client.request('thread/read', { threadId: 'thread-1' });
  assert.equal(result.thread.id, 'thread-1');
  assert.equal(children.length, 2);
  client.close();
});

test('one timeout rejects every request pending on the same broken app-server', async () => {
  const client = new AppServerClient({
    spawnProcess: () => controllableAppServer((request) => (
      request.method === 'initialize' ? { userAgent: 'test' } : undefined
    )),
    timeoutMs: 25,
  });
  await client.start();

  const results = await Promise.allSettled([
    client.request('thread/read', { threadId: 'thread-1' }),
    client.request('thread/goal/get', { threadId: 'thread-2' }),
  ]);

  assert.deepEqual(results.map((value) => value.status), ['rejected', 'rejected']);
  assert.match(results[0].reason.message, /超时/);
  assert.match(results[1].reason.message, /超时/);
  assert.equal(client.pending.size, 0);
});

test('goal controller resumes only a stopped blocked goal', async () => {
  const calls = [];
  const deliveries = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') {
        const setActive = calls.some((call) => call.method === 'thread/goal/set' && call.params.status === 'active');
        return { goal: { status: setActive ? 'active' : 'blocked' } };
      }
      return { goal: { status: 'active' } };
    },
    close() {},
  };
  const controller = createGoalController({
    client,
    resumeThread: async (input) => {
      deliveries.push(input);
      return { ok: true, message: 'accepted' };
    },
  });
  const result = await controller.execute({
    threadId: '00000000-0000-0000-0000-000000000001',
    command: 'resume',
    sessionState: 'blocked',
    sessionTitle: '测试会话',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[1], {
    method: 'thread/goal/set',
    params: { threadId: '00000000-0000-0000-0000-000000000001', status: 'active' },
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].sessionId, '00000000-0000-0000-0000-000000000001');
  assert.equal(deliveries[0].sessionTitle, '测试会话');
  assert.equal(deliveries[0].mode, 'steer');
  assert.match(deliveries[0].text, /继续当前 Goal/);
  await assert.rejects(
    controller.execute({
      threadId: '00000000-0000-0000-0000-000000000001', command: 'resume', sessionState: 'running',
    }),
    /仍在运行/,
  );
});

test('goal controller continues an active but idle goal without rewriting its status', async () => {
  const calls = [];
  let delivered = false;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      return { goal: { status: 'active' } };
    },
    close() {},
  };
  const controller = createGoalController({
    client,
    resumeThread: async () => {
      delivered = true;
      return { ok: true };
    },
  });
  const result = await controller.execute({
    threadId: '00000000-0000-0000-0000-000000000001',
    command: 'resume',
    sessionState: 'completed',
  });
  assert.equal(result.ok, true);
  assert.equal(delivered, true);
  assert.equal(calls.some((call) => call.method === 'thread/goal/set'), false);
});

test('goal controller restores a paused goal during a running turn without sending another prompt', async () => {
  const calls = [];
  let delivered = false;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'paused' } };
      return { goal: { status: params.status } };
    },
    close() {},
  };
  const controller = createGoalController({
    client,
    resumeThread: async () => {
      delivered = true;
      return { ok: true };
    },
  });
  const result = await controller.execute({
    threadId: '00000000-0000-0000-0000-000000000001',
    command: 'resume',
    sessionState: 'running',
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /当前会话继续执行中/);
  assert.equal(delivered, false);
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active'],
  );
});

test('goal controller restores a paused idle goal and sends one continuation prompt', async () => {
  const calls = [];
  let delivered = 0;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') {
        const setActive = calls.some((call) => call.method === 'thread/goal/set' && call.params.status === 'active');
        return { goal: { status: setActive ? 'active' : 'paused' } };
      }
      return { goal: { status: params.status } };
    },
    close() {},
  };
  const controller = createGoalController({
    client,
    resumeThread: async () => {
      delivered += 1;
      return { ok: true };
    },
  });
  const result = await controller.execute({
    threadId: '00000000-0000-0000-0000-000000000001',
    command: 'resume',
    sessionState: 'completed',
  });
  assert.equal(result.ok, true);
  assert.equal(delivered, 1);
});

test('goal controller rolls a blocked goal back when native resume delivery fails', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'blocked' } };
      return { goal: { status: params.status } };
    },
    close() {},
  };
  const controller = createGoalController({
    client,
    resumeThread: async () => {
      throw new Error('原生输入通道不可用');
    },
  });
  await assert.rejects(
    controller.execute({
      threadId: '00000000-0000-0000-0000-000000000001',
      command: 'resume',
      sessionState: 'blocked',
    }),
    /Goal 未真正恢复.*原生输入通道不可用/,
  );
  assert.deepEqual(
    calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params.status),
    ['active', 'blocked'],
  );
});

test('goal controller requires confirmation and clears only the goal', async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: { status: 'complete' } };
      return { cleared: true };
    },
    close() {},
  };
  const controller = createGoalController({ client });
  await assert.rejects(
    controller.execute({
      threadId: '00000000-0000-0000-0000-000000000001', command: 'delete', sessionState: 'completed',
    }),
    /二次确认/,
  );
  const result = await controller.execute({
    threadId: '00000000-0000-0000-0000-000000000001', command: 'delete', sessionState: 'completed', confirmed: true,
  });
  assert.equal(result.message, 'Goal 已删除，会话和聊天记录仍保留');
  assert.equal(calls.at(-1).method, 'thread/goal/clear');
});
