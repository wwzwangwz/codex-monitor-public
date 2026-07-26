const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNativeGoalCommander } = require('../src/lib/native-goal');

const SESSION_ID = '00000000-0000-4000-8000-000000000101';
const OTHER_ID = '00000000-0000-4000-8000-000000000102';

function cdpSocket(respond, calls) {
  return class FakeWebSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.readyState = 0;
      process.nextTick(() => {
        this.readyState = this.OPEN;
        this.emit('open');
      });
    }

    send(raw) {
      const request = JSON.parse(raw);
      calls.push(request);
      const value = request.method === 'Runtime.evaluate'
        ? respond(request.params.expression)
        : undefined;
      process.nextTick(() => this.emit('message', JSON.stringify({
        id: request.id,
        result: request.method === 'Runtime.evaluate' ? { result: { value } } : {},
      })));
    }

    close() {
      this.readyState = 3;
      this.emit('close');
    }
  };
}

function commanderWith(respond, options = {}) {
  const calls = options.calls || [];
  return {
    calls,
    execute: createNativeGoalCommander({
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{
          type: 'page',
          url: `app://-/local/${OTHER_ID}`,
          webSocketDebuggerUrl: 'ws://127.0.0.1/fake',
        }],
      }),
      WebSocketImpl: cdpSocket(respond, calls),
      timeoutMs: 20,
      ...options,
    }),
  };
}

function successfulResponse(command) {
  return (expression) => {
    if (expression.includes('windows.show_thread')) return { invoked: true };
    if (expression.includes('data-above-composer-conversation-id')) return SESSION_ID;
    if (expression.includes('dispatcher_export_not_found')) {
      return {
        invoked: true,
        action: command === 'resume' ? 'set-thread-goal-status' : 'clear-thread-goal',
      };
    }
    return null;
  };
}

test('resumes through the exact native Goal status action', async () => {
  const { execute, calls } = commanderWith(successfulResponse('resume'));

  const result = await execute({ sessionId: SESSION_ID, command: 'resume' });

  assert.equal(result.ok, true);
  assert.match(result.message, /resumed/i);
  const navigation = calls.find((call) => call.params?.expression.includes('windows.show_thread'));
  const action = calls.find((call) => call.params?.expression.includes('set-thread-goal-status'));
  assert.match(navigation.params.expression, new RegExp(SESSION_ID));
  assert.match(action.params.expression, /status:\s*'active'/);
  assert.doesNotMatch(action.params.expression, /thread\/delete|thread\/goal\/clear/);
});

test('deletes only the Goal association through the native clear action', async () => {
  const { execute, calls } = commanderWith(successfulResponse('delete'));

  const result = await execute({ sessionId: SESSION_ID, command: 'delete', confirmed: true });

  assert.equal(result.ok, true);
  assert.match(result.message, /Goal association cleared/i);
  const action = calls.find((call) => call.params?.expression.includes('clear-thread-goal'));
  assert.ok(action);
  assert.doesNotMatch(action.params.expression, /thread\/delete|archive-conversation|fs\.|sqlite/i);
});

test('does not invoke a Goal action when navigation reaches another thread', async () => {
  const { execute, calls } = commanderWith((expression) => {
    if (expression.includes('windows.show_thread')) return { invoked: true };
    if (expression.includes('data-above-composer-conversation-id')) return OTHER_ID;
    return null;
  });

  await assert.rejects(
    () => execute({ sessionId: SESSION_ID, command: 'resume' }),
    /did not switch to the target conversation/,
  );
  assert.equal(calls.some((call) => call.params?.expression.includes('set-thread-goal-status')), false);
});

test('returns a specific error when the native dispatcher export cannot be resolved', async () => {
  const { execute } = commanderWith((expression) => {
    if (expression.includes('windows.show_thread')) return { invoked: true };
    if (expression.includes('data-above-composer-conversation-id')) return SESSION_ID;
    if (expression.includes('dispatcher_export_not_found')) {
      return { invoked: false, reason: 'dispatcher_export_not_found' };
    }
    return null;
  });

  await assert.rejects(
    () => execute({ sessionId: SESSION_ID, command: 'delete', confirmed: true }),
    /native Goal dispatcher is unavailable/,
  );
});

test('serializes native Goal commands', async () => {
  let resolveFirstFetch;
  const firstFetch = new Promise((resolve) => { resolveFirstFetch = resolve; });
  let fetches = 0;
  const { execute } = commanderWith(successfulResponse('resume'), {
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) await firstFetch;
      return {
        ok: true,
        json: async () => [{
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1/fake',
        }],
      };
    },
  });

  const first = execute({ sessionId: SESSION_ID, command: 'resume' });
  const second = execute({ sessionId: SESSION_ID, command: 'resume' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  resolveFirstFetch();
  await Promise.all([first, second]);
  assert.equal(fetches, 2);
});
