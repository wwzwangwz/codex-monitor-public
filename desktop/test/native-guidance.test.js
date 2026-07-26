const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createNativeGuidanceSender,
  readComposerEnterBehavior,
  readFollowUpQueueMode,
  submissionModifiers,
  validateGuidance,
  assertLoopbackUrl,
  rolloutReceipt,
} = require('../src/lib/native-guidance');

const SESSION_ID = '00000000-0000-4000-8000-000000000101';

test('validates native guidance without falling back to Resume', () => {
  assert.deepEqual(validateGuidance({ sessionId: SESSION_ID, text: ' continue ', mode: 'steer' }), {
    sessionId: SESSION_ID,
    text: 'continue',
    mode: 'steer',
    attachments: [],
  });
  const image = { name: 'screen.png', mimeType: 'image/png', data: Buffer.from('png') };
  assert.deepEqual(validateGuidance({
    sessionId: SESSION_ID, text: '', mode: 'queue', attachments: [image],
  }), { sessionId: SESSION_ID, text: '', mode: 'queue', attachments: [image] });
  assert.throws(() => validateGuidance({ sessionId: SESSION_ID, text: '', mode: 'steer' }), /message or.*image/i);
  assert.throws(() => validateGuidance({ sessionId: 'bad', text: 'continue', mode: 'steer' }), /session ID/);
  assert.throws(() => validateGuidance({ sessionId: SESSION_ID, text: 'continue', mode: 'resume' }), /Steer or Queue/);
});

test('reads the configured follow-up mode and computes the opposite shortcut', () => {
  assert.equal(readFollowUpQueueMode({ readFileSync: () => '[desktop]\nfollowUpQueueMode = "queue"' }), 'queue');
  assert.equal(readComposerEnterBehavior({ readFileSync: () => 'composerEnterBehavior = "cmdAlways"' }), 'cmdAlways');
  assert.equal(readComposerEnterBehavior({ readFileSync: () => 'followUpQueueMode = "steer"' }), 'enter');
  assert.equal(submissionModifiers('queue', 'steer', 'darwin', 'cmdAlways'), 12);
  assert.equal(submissionModifiers('steer', 'steer', 'darwin', 'enter'), 0);
  assert.equal(submissionModifiers('steer', 'queue', 'win32', 'cmdIfMultiline'), 10);
  assert.equal(submissionModifiers('queue', 'steer', 'win32', 'enter'), 2);
});

test('uses the default config reader when no config file is present', () => {
  assert.equal(readFollowUpQueueMode({ file: 'C:\\path\\that\\does\\not\\exist' }), 'steer');
});

test('submits image-only guidance atomically and retains staged files after acceptance', async () => {
  const calls = [];
  let cleaned = false;
  let retainedSessionId;
  let stagedStorageDirectory;
  const attachmentDirectory = 'C:\\MonitorData\\guidance-attachments';
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('draftAttachments')) return { ok: true };
    if (expression.includes('new DataTransfer')) return { ok: true, count: 1 };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('draftButtons')) return true;
    if (expression.includes('document.activeElement === editor')) return true;
    return SESSION_ID;
  }, {
    calls,
    attachmentDirectory,
    stageAttachments: (_attachments, options) => {
      stagedStorageDirectory = options?.storageDirectory;
      return ({
      files: [{ name: 'screen.png', path: 'C:\\Temp\\screen.png' }],
      cleanup: () => { cleaned = true; },
      });
    },
    retainAttachments: (_staged, { sessionId }) => { retainedSessionId = sessionId; },
  });

  const result = await send({
    sessionId: SESSION_ID,
    text: '',
    mode: 'steer',
    attachments: [{ name: 'screen.png', mimeType: 'image/png', data: Buffer.from('png') }],
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /1 image/i);
  assert.equal(retainedSessionId, SESSION_ID);
  assert.equal(stagedStorageDirectory, attachmentDirectory);
  assert.equal(cleaned, false);
  assert.ok(calls.some((call) => call.method === 'DOM.setFileInputFiles'
    && call.params.files[0] === 'C:\\Temp\\screen.png'));
  assert.equal(calls.some((call) => call.method === 'Input.insertText'), false);
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchKeyEvent'
    && call.params.windowsVirtualKeyCode === 13).length, 2);
});

test('retains queued images when rollout receipt is delayed beyond desktop acceptance', async () => {
  let cleaned = false;
  let retained = false;
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('draftAttachments')) return { ok: true };
    if (expression.includes('new DataTransfer')) return { ok: true, count: 1 };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('draftButtons')) return true;
    if (expression.includes('document.activeElement === editor')) return true;
    return SESSION_ID;
  }, {
    stageAttachments: () => ({
      files: [{ name: 'queued.png', path: 'C:\\MonitorData\\queued.png' }],
      cleanup: () => { cleaned = true; },
    }),
    retainAttachments: () => { retained = true; },
  });

  const result = await send({
    sessionId: SESSION_ID,
    text: 'inspect after the current turn',
    mode: 'queue',
    attachments: [{ name: 'queued.png', mimeType: 'image/png', data: Buffer.from('png') }],
    rolloutPath: __filename,
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /Queue/);
  assert.equal(retained, true);
  assert.equal(cleaned, false);
});

test('accepts a verified native steer when rollout persistence is delayed', async () => {
  let cleaned = false;
  let retained = false;
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('draftAttachments')) return { ok: true };
    if (expression.includes('new DataTransfer')) return { ok: true, count: 1 };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('draftButtons')) return true;
    if (expression.includes('document.activeElement === editor')) return true;
    return SESSION_ID;
  }, {
    stageAttachments: () => ({
      files: [{ name: 'steered.png', path: 'C:\\MonitorData\\steered.png' }],
      cleanup: () => { cleaned = true; },
    }),
    retainAttachments: () => { retained = true; },
  });

  const result = await send({
    sessionId: SESSION_ID,
    text: 'inspect during the current turn',
    mode: 'steer',
    attachments: [{ name: 'steered.png', mimeType: 'image/png', data: Buffer.from('png') }],
    rolloutPath: __filename,
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /Steer/);
  assert.equal(retained, true);
  assert.equal(cleaned, false);
});

test('submits through the Codex renderer CDP with the requested mode', async () => {
  const calls = [];
  class FakeWebSocket extends EventEmitter {
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
      let value;
      if (request.method === 'Runtime.evaluate') {
        const expression = request.params.expression;
        if (expression.includes('row.click()')) value = { found: true, current: SESSION_ID };
        else if (expression.includes('document.activeElement')) value = true;
        else if (expression.includes("return !(editor?.innerText")) value = true;
        else if (expression.includes('return { ok: true }')) value = { ok: true };
        else value = SESSION_ID;
      }
      process.nextTick(() => this.emit('message', JSON.stringify({
        id: request.id,
        result: request.method === 'Runtime.evaluate'
          ? { result: { value } }
          : {},
      })));
    }

    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }

  const send = createNativeGuidanceSender({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{
        type: 'page',
        url: 'app://-/index.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1/fake',
      }],
    }),
    WebSocketImpl: FakeWebSocket,
    readFileSync: () => '[desktop]\nfollowUpQueueMode = "steer"',
    platform: 'darwin',
  });

  const result = await send({ sessionId: SESSION_ID, text: 'continue', mode: 'queue' });
  assert.equal(result.ok, true);
  assert.match(result.message, /Queue/);
  assert.ok(calls.some((item) => item.method === 'Input.insertText' && item.params.text === 'continue'));
  const keyDown = calls.find((item) => item.method === 'Input.dispatchKeyEvent' && item.params.type === 'rawKeyDown');
  assert.equal(keyDown.params.modifiers, 4);
});

function cdpSocket(respond, calls = []) {
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
      let result = {};
      if (request.method === 'Runtime.evaluate') result = { result: { value } };
      else if (request.method === 'DOM.getDocument') result = { root: { nodeId: 1 } };
      else if (request.method === 'DOM.querySelector') result = { nodeId: 2 };
      process.nextTick(() => this.emit('message', JSON.stringify({
        id: request.id,
        result,
      })));
    }

    close() {
      this.readyState = 3;
      this.emit('close');
    }
  };
}

function nativeSenderWith(respond, options = {}) {
  return createNativeGuidanceSender({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/fake' }],
    }),
    WebSocketImpl: cdpSocket(respond, options.calls),
    readFileSync: () => '[desktop]\nfollowUpQueueMode = "steer"',
    acceptanceTimeoutMs: 20,
    ...options,
  });
}

test('removes native image previews and staged files when atomic submission fails', async () => {
  let cleaned = false;
  let removedPreview = false;
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('draftAttachments')) return { ok: true };
    if (expression.includes('new DataTransfer')) return { ok: true, count: 1 };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('for (const button of draftButtons)')) {
      removedPreview = true;
      return true;
    }
    if (expression.includes('const textReady')) return false;
    if (expression.includes('draftButtons')) return true;
    if (expression.includes('document.activeElement === editor')) return false;
    return SESSION_ID;
  }, {
    stageAttachments: () => ({
      files: [{ name: 'screen.png', path: 'C:\\Temp\\screen.png' }],
      cleanup: () => { cleaned = true; },
    }),
  });

  await assert.rejects(() => send({
    sessionId: SESSION_ID,
    text: 'inspect this',
    mode: 'queue',
    attachments: [{ name: 'screen.png', mimeType: 'image/png', data: Buffer.from('png') }],
  }), /confirm/i);
  assert.equal(removedPreview, true);
  assert.equal(cleaned, true);
});

test('uses native show-thread for a selected conversation outside the sidebar', async () => {
  const calls = [];
  const otherSessionId = '00000000-0000-4000-8000-000000000102';
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: false, current: otherSessionId };
    if (expression.includes('appActions.runInPrimaryWindow')) return { invoked: true };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) return true;
    if (expression.includes('return current === id')) return true;
    return SESSION_ID;
  }, {
    calls,
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{
        type: 'page',
        url: `app://-/local/${otherSessionId}`,
        webSocketDebuggerUrl: 'ws://127.0.0.1/fake',
      }],
    }),
  });

  const result = await send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' });

  assert.equal(result.ok, true);
  const nativeNavigation = calls.find((call) => (
    call.method === 'Runtime.evaluate'
    && call.params.expression.includes('appActions.runInPrimaryWindow')
  ));
  assert.ok(nativeNavigation);
  assert.match(nativeNavigation.params.expression, /windows\.show_thread/);
  assert.match(nativeNavigation.params.expression, new RegExp(SESSION_ID));
  assert.ok(calls.some((call) => call.method === 'Input.insertText'));
});

test('does not insert text when native show-thread does not reach the selected conversation', async () => {
  const calls = [];
  const otherSessionId = '00000000-0000-4000-8000-000000000102';
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: false, current: otherSessionId };
    if (expression.includes('appActions.runInPrimaryWindow')) return { invoked: true };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return otherSessionId;
    return otherSessionId;
  }, { calls, timeoutMs: 20 });

  await assert.rejects(
    () => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /did not switch to the target conversation/,
  );
  assert.equal(calls.some((call) => call.method === 'Input.insertText'), false);
});

test('rejects non-loopback debugger endpoints and targets', async () => {
  assert.match(assertLoopbackUrl('http://[::1]:9229/json/list', ['http:']), /^http:\/\/\[::1\]:9229/);
  const remoteEndpoint = nativeSenderWith(() => null, { debugEndpoint: 'http://192.0.2.10:9229/json/list' });
  await assert.rejects(
    () => remoteEndpoint({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /loopback/,
  );

  const remoteTarget = createNativeGuidanceSender({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://192.0.2.10/fake' }],
    }),
    WebSocketImpl: cdpSocket(() => null),
  });
  await assert.rejects(
    () => remoteTarget({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /loopback/,
  );
});

test('requires an exact confirmed composer value before submission', async () => {
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) {
      return expression.includes('.includes') ? true : false;
    }
    if (expression.includes('return !(editor')) return true;
    return SESSION_ID;
  });
  await assert.rejects(
    () => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /confirm the inserted message/,
  );
});

test('fails when acceptance polling observes a different conversation', async () => {
  const otherSessionId = '00000000-0000-4000-8000-000000000102';
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) return true;
    if (expression.includes('return current === id')) return false;
    if (expression.includes('return !(editor')) return true;
    if (expression.includes('data-above-composer-conversation-id')) return otherSessionId;
    return SESSION_ID;
  });
  await assert.rejects(
    () => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /did not accept Enter and no usable send button was found/,
  );
});

test('fails when acceptance polling finds a replacement nonempty draft', async () => {
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) return true;
    if (expression.includes('return current === id')) {
      return expression.includes("(editor.innerText || '').trim() === ''") ? false : true;
    }
    return SESSION_ID;
  });
  await assert.rejects(
    () => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /did not accept Enter and no usable send button was found/,
  );
});

test('accepts the ProseMirror trailing newline as an empty composer after submission', async () => {
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) return true;
    if (expression.includes('return current === id')) {
      return expression.includes(".trim() === ''");
    }
    return SESSION_ID;
  });

  const result = await send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' });
  assert.equal(result.ok, true);
});

test('clicks the real submit button when Windows Enter leaves the draft untouched', async () => {
  let submitClicked = false;
  const calls = [];
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) return true;
    if (expression.includes('submit.click()')) {
      submitClicked = true;
      return { clicked: true };
    }
    if (expression.includes('return current === id')) return submitClicked;
    if (expression.includes('return current ===')) return submitClicked;
    return SESSION_ID;
  }, { calls, acceptanceTimeoutMs: 20 });

  const result = await send({ sessionId: SESSION_ID, text: 'fix native send', mode: 'steer' });
  assert.equal(result.ok, true);
  assert.equal(submitClicked, true);
  assert.ok(calls.some((call) => call.method === 'Runtime.evaluate'
    && call.params.expression.includes('submit.click()')));
});

test('requires the target rollout to contain the exact submitted user message', () => {
  const directory = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'monitor-receipt-'));
  const rolloutPath = require('node:path').join(directory, 'rollout.jsonl');
  try {
    require('node:fs').writeFileSync(rolloutPath, '{"old":true}\n');
    const start = require('node:fs').statSync(rolloutPath).size;
    require('node:fs').appendFileSync(rolloutPath, `${JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: 'fix native send', local_images: [] },
    })}\n`);
    assert.equal(rolloutReceipt(rolloutPath, start, 'fix native send', []), true);
    assert.equal(rolloutReceipt(rolloutPath, start, 'different message', []), false);
  } finally {
    require('node:fs').rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a pre-existing desktop draft without inserting text', async () => {
  const calls = [];
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: false, reason: 'draft_present' };
    return SESSION_ID;
  }, { calls });
  await assert.rejects(
    () => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }),
    /unsent desktop draft/,
  );
  assert.equal(calls.some((call) => call.method === 'Input.insertText'), false);
});

test('does not clear a composer after its content changed during a failed submission', async () => {
  const calls = [];
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes('document.activeElement === editor')) return false;
    if (expression.includes("editor?.innerText || '') ===")) return false;
    return SESSION_ID;
  }, { calls });
  await assert.rejects(() => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }));
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchKeyEvent').length, 0);
});

test('clears only the exact inserted text after a failed submission', async () => {
  const calls = [];
  let exactTextChecks = 0;
  const send = nativeSenderWith((expression) => {
    if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
    if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
    if (expression.includes('value = editor')) return { ok: true };
    if (expression.includes("editor?.innerText || '') ===")) return ++exactTextChecks === 2;
    if (expression.includes('document.activeElement === editor')) return false;
    return SESSION_ID;
  }, { calls });
  await assert.rejects(() => send({ sessionId: SESSION_ID, text: 'continue', mode: 'steer' }));
  assert.equal(exactTextChecks, 2);
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchKeyEvent').length, 4);
});

test('serializes native guidance sends', async () => {
  let resolveFirstFetch;
  const firstFetch = new Promise((resolve) => { resolveFirstFetch = resolve; });
  let activeFetches = 0;
  let maxActiveFetches = 0;
  let fetches = 0;
  const send = createNativeGuidanceSender({
    fetchImpl: async () => {
      fetches += 1;
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      if (fetches === 1) await firstFetch;
      activeFetches -= 1;
      return {
        ok: true,
        json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1/fake' }],
      };
    },
    WebSocketImpl: cdpSocket((expression) => {
      if (expression.includes('row.click()')) return { found: true, current: SESSION_ID };
      if (expression.includes('?.getAttribute') && expression.includes('|| null')) return SESSION_ID;
      if (expression.includes('value = editor')) return { ok: true };
      if (expression.includes('document.activeElement === editor')) return true;
      if (expression.includes('return current === id')) return true;
      if (expression.includes('return !(editor')) return true;
      return SESSION_ID;
    }),
  });
  const first = send({ sessionId: SESSION_ID, text: 'one', mode: 'steer' });
  const second = send({ sessionId: SESSION_ID, text: 'two', mode: 'queue' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  resolveFirstFetch();
  await Promise.all([first, second]);
  assert.equal(maxActiveFetches, 1);
});
