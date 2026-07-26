const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSingleInstanceWindowLifecycle } = require('../src/lib/window-lifecycle');

function createApp({ acquiresLock }) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => acquiresLock;
  app.quitCount = 0;
  app.quit = () => { app.quitCount += 1; };
  return app;
}

test('secondary instance exits before it can initialize Monitor resources', () => {
  const app = createApp({ acquiresLock: false });
  let createCalls = 0;
  const lifecycle = createSingleInstanceWindowLifecycle({
    app,
    getWindow: () => null,
    createWindow: () => { createCalls += 1; },
  });

  assert.equal(lifecycle.primary, false);
  assert.equal(app.quitCount, 1);
  assert.equal(app.listenerCount('second-instance'), 0);
  assert.equal(createCalls, 0);
});

test('second launch restores and focuses the existing minimized Monitor window', async () => {
  const app = createApp({ acquiresLock: true });
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
  const lifecycle = createSingleInstanceWindowLifecycle({
    app,
    getWindow: () => window,
    createWindow: () => calls.push('create'),
  });

  lifecycle.bind();
  app.emit('second-instance');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('second launch creates a window only when the prior window is gone', async () => {
  const app = createApp({ acquiresLock: true });
  let createCalls = 0;
  const lifecycle = createSingleInstanceWindowLifecycle({
    app,
    getWindow: () => ({ isDestroyed: () => true }),
    createWindow: () => { createCalls += 1; },
  });

  lifecycle.bind();
  app.emit('second-instance');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCalls, 1);
});

test('overlapping second launches share one pending window creation', async () => {
  const app = createApp({ acquiresLock: true });
  let resolveCreation;
  let createCalls = 0;
  const lifecycle = createSingleInstanceWindowLifecycle({
    app,
    getWindow: () => null,
    createWindow: () => {
      createCalls += 1;
      return new Promise((resolve) => { resolveCreation = resolve; });
    },
  });

  lifecycle.bind();
  app.emit('second-instance');
  app.emit('second-instance');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCalls, 1);
  resolveCreation();
});
