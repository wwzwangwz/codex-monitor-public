const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createNativeGuidanceSender,
  readFollowUpQueueMode,
  submissionModifiers,
  validateGuidance,
} = require('../src/lib/native-guidance');

const SESSION_ID = '00000000-0000-4000-8000-000000000002';

test('validates native guidance without falling back to Resume', () => {
  assert.deepEqual(validateGuidance({ sessionId: SESSION_ID, text: ' 继续 ', mode: 'steer' }), {
    sessionId: SESSION_ID,
    sessionTitle: '',
    text: '继续',
    mode: 'steer',
    attachments: [],
  });
  assert.throws(() => validateGuidance({ sessionId: 'bad', text: '继续', mode: 'steer' }), /会话 ID/);
  assert.throws(() => validateGuidance({ sessionId: SESSION_ID, text: '继续', mode: 'resume' }), /Steer 或 Queue/);
});

test('submits an image-only request through the native Codex attachment path', async () => {
  const calls = [];
  let cleaned = false;
  let retained = false;
  let stagedStorageDirectory;
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
      let result = {};
      if (request.method === 'Runtime.evaluate') {
        const expression = request.params.expression;
        let value = true;
        if (expression.includes('row.click()')) value = { found: true, current: SESSION_ID };
        else if (expression.includes('draftAttachments')) value = { ok: true };
        else if (expression.includes('new DataTransfer')) value = { ok: true, count: 1 };
        else if (expression.includes('getAttribute') && expression.includes('|| null')) value = SESSION_ID;
        result = { result: { value } };
      } else if (request.method === 'DOM.getDocument') result = { root: { nodeId: 1 } };
      else if (request.method === 'DOM.querySelector') result = { nodeId: 2 };
      process.nextTick(() => this.emit('message', JSON.stringify({ id: request.id, result })));
    }

    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }

  const send = createNativeGuidanceSender({
    fetchImpl: async () => ({
      ok: true,
      json: async () => [{ type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://fake' }],
    }),
    WebSocketImpl: FakeWebSocket,
    readFileSync: () => '[desktop]\nfollowUpQueueMode = "steer"',
    attachmentDirectory: '/monitor-owned/guidance-attachments',
    stageAttachments: (_attachments, options) => {
      stagedStorageDirectory = options.storageDirectory;
      return ({
      files: [{ name: 'screen.png', path: '/tmp/screen.png' }],
      cleanup: () => { cleaned = true; },
      });
    },
    retainAttachments: (_staged, value) => {
      retained = value.sessionId === SESSION_ID;
    },
  });

  const result = await send({
    sessionId: SESSION_ID,
    text: '',
    mode: 'steer',
    attachments: [{ name: 'screen.png', mimeType: 'image/png', data: Buffer.from('png') }],
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /1 张图片/);
  assert.equal(cleaned, false);
  assert.equal(retained, true);
  assert.equal(stagedStorageDirectory, '/monitor-owned/guidance-attachments');
  assert.ok(calls.some((item) => item.method === 'DOM.setFileInputFiles'
    && item.params.files[0] === '/tmp/screen.png'));
  assert.equal(calls.some((item) => item.method === 'Input.insertText'), false);
  assert.ok(calls.some((item) => item.method === 'Input.dispatchKeyEvent'
    && item.params.windowsVirtualKeyCode === 13));
});

test('reads the configured follow-up mode and computes the opposite shortcut', () => {
  assert.equal(readFollowUpQueueMode({ readFileSync: () => '[desktop]\nfollowUpQueueMode = "queue"' }), 'queue');
  assert.equal(submissionModifiers('queue', 'steer', 'darwin'), 12);
  assert.equal(submissionModifiers('steer', 'steer', 'darwin'), 0);
  assert.equal(submissionModifiers('steer', 'queue', 'win32'), 10);
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
        else if (expression.includes("return { ok: true }")) value = { ok: true };
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
        webSocketDebuggerUrl: 'ws://fake',
      }],
    }),
    WebSocketImpl: FakeWebSocket,
    readFileSync: () => '[desktop]\nfollowUpQueueMode = "steer"',
    platform: 'darwin',
  });

  const result = await send({ sessionId: SESSION_ID, text: '继续', mode: 'queue' });
  assert.equal(result.ok, true);
  assert.match(result.message, /Queue/);
  assert.ok(calls.some((item) => item.method === 'Input.insertText' && item.params.text === '继续'));
  const keyDown = calls.find((item) => item.method === 'Input.dispatchKeyEvent' && item.params.type === 'rawKeyDown');
  assert.equal(keyDown.params.modifiers, 12);
});
