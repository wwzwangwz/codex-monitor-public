const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createNativeTurnStore,
  readTurnBatch,
} = require('../src/lib/native-turns');

const ACTIVE_THREAD = '00000000-0000-4000-8000-000000000103';
const INTERRUPTED_THREAD = '00000000-0000-4000-8000-000000000104';

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

function nativeStoreWith(respond, options = {}) {
  const calls = options.calls || [];
  return {
    calls,
    store: createNativeTurnStore({
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{
          type: 'page',
          url: 'app://-/index.html',
          webSocketDebuggerUrl: 'ws://127.0.0.1/fake',
        }],
      }),
      WebSocketImpl: cdpSocket(respond, calls),
      timeoutMs: 20,
      ...options,
    }),
  };
}

test('native turn batch keeps fast exact results when another thread times out', async () => {
  const calls = [];
  const dispatcher = async (_actionName, request) => {
    calls.push(request.params.threadId);
    if (request.params.threadId === ACTIVE_THREAD) {
      return new Promise(() => {});
    }
    return {
      data: [{
        id: 'turn-interrupted',
        status: 'interrupted',
        startedAt: 21,
        completedAt: null,
        error: null,
      }],
    };
  };

  const result = await readTurnBatch(
    dispatcher,
    'send-cli-request-for-host',
    [ACTIVE_THREAD, INTERRUPTED_THREAD],
    5,
  );

  assert.deepEqual(calls.sort(), [ACTIVE_THREAD, INTERRUPTED_THREAD].sort());
  assert.deepEqual(result.timedOutThreadIds, [ACTIVE_THREAD]);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].threadId, INTERRUPTED_THREAD);
  assert.equal(result.turns[0].status, 'interrupted');
});

test('native turn store batch-reads exact candidates through the live desktop host', async () => {
  const { store, calls } = nativeStoreWith(() => ({
    ok: true,
    resolution: {
      moduleHref: 'app://-/assets/app-initial-fixture.js',
      exportKey: 'dispatch',
    },
    turns: [
      {
        threadId: ACTIVE_THREAD,
        id: 'turn-active',
        status: 'inProgress',
        startedAt: 42,
        completedAt: null,
        error: null,
      },
      {
        threadId: INTERRUPTED_THREAD,
        id: 'turn-interrupted',
        status: 'interrupted',
        startedAt: 21,
        completedAt: null,
        error: null,
      },
    ],
  }));

  const statuses = await store.refresh([ACTIVE_THREAD, INTERRUPTED_THREAD]);

  assert.deepEqual(statuses.get(ACTIVE_THREAD), {
    id: 'turn-active',
    status: 'inProgress',
    startedAt: 42,
    completedAt: null,
    error: null,
  });
  assert.equal(statuses.get(INTERRUPTED_THREAD).status, 'interrupted');
  const evaluations = calls.filter((call) => call.method === 'Runtime.evaluate');
  assert.equal(evaluations.length, 1);
  assert.match(evaluations[0].params.expression, /send-cli-request-for-host/);
  assert.match(evaluations[0].params.expression, /thread\/turns\/list/);
  assert.match(evaluations[0].params.expression, new RegExp(ACTIVE_THREAD));
  assert.match(evaluations[0].params.expression, new RegExp(INTERRUPTED_THREAD));
  assert.doesNotMatch(
    evaluations[0].params.expression,
    /windows\.show_thread|turn\/start|turn\/steer|thread\/goal\/set|thread\/goal\/clear/,
  );
});

test('native turn store backs off only the timed-out thread while refreshing healthy candidates', async () => {
  let currentTime = 1_000;
  let reads = 0;
  const { store, calls } = nativeStoreWith(() => {
    reads += 1;
    return {
      ok: true,
      resolution: {
        moduleHref: 'app://-/assets/app-initial-fixture.js',
        exportKey: 'dispatch',
      },
      turns: [{
        threadId: INTERRUPTED_THREAD,
        id: 'turn-interrupted',
        status: 'interrupted',
        startedAt: 21,
        completedAt: null,
        error: null,
      }],
      timedOutThreadIds: reads === 1 ? [ACTIVE_THREAD] : [],
    };
  }, {
    now: () => currentTime,
    refreshIntervalMs: 3_000,
    timeoutBackoffMs: 60_000,
  });

  await store.refresh([ACTIVE_THREAD, INTERRUPTED_THREAD]);
  currentTime = 5_000;
  await store.refresh([ACTIVE_THREAD, INTERRUPTED_THREAD]);

  const evaluations = calls.filter((call) => call.method === 'Runtime.evaluate');
  assert.equal(evaluations.length, 2);
  assert.match(evaluations[0].params.expression, new RegExp(ACTIVE_THREAD));
  assert.doesNotMatch(evaluations[1].params.expression, new RegExp(ACTIVE_THREAD));
  assert.match(evaluations[1].params.expression, new RegExp(INTERRUPTED_THREAD));
  assert.equal(store.current().get(INTERRUPTED_THREAD).status, 'interrupted');
});

test('native turn store preserves prior exact states when the live desktop read fails', async () => {
  let currentTime = 1_000;
  let reads = 0;
  const { store } = nativeStoreWith(() => {
    reads += 1;
    if (reads > 1) return { ok: false, reason: 'dispatcher_unavailable' };
    return {
      ok: true,
      resolution: {
        moduleHref: 'app://-/assets/app-initial-fixture.js',
        exportKey: 'dispatch',
      },
      turns: [{
        threadId: ACTIVE_THREAD,
        id: 'turn-active',
        status: 'inProgress',
        startedAt: 42,
        completedAt: null,
        error: null,
      }],
    };
  }, {
    now: () => currentTime,
    refreshIntervalMs: 3_000,
  });

  const first = await store.refresh([ACTIVE_THREAD]);
  currentTime = 5_000;
  const second = await store.refresh([ACTIVE_THREAD]);

  assert.deepEqual(second.get(ACTIVE_THREAD), first.get(ACTIVE_THREAD));
});

test('native turn store throttles the same bounded candidate set', async () => {
  let currentTime = 1_000;
  let reads = 0;
  const { store } = nativeStoreWith(() => {
    reads += 1;
    return {
      ok: true,
      resolution: null,
      turns: [{
        threadId: ACTIVE_THREAD,
        id: 'turn-active',
        status: 'inProgress',
        startedAt: 42,
        completedAt: null,
        error: null,
      }],
    };
  }, {
    now: () => currentTime,
    refreshIntervalMs: 3_000,
  });

  await store.refresh([ACTIVE_THREAD]);
  currentTime = 2_000;
  await store.refresh([ACTIVE_THREAD]);

  assert.equal(reads, 1);
});
