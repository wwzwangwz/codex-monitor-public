const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyGoalStatus, extractEvidenceImages, goalDatabaseSignature, inferStatus, parseSessionIndex, sessionStatus } = require('../src/lib/codex');

const line = (type, payload) => JSON.stringify({ type, payload });

test('invalidates Goal cache when SQLite WAL changes', () => {
  const stats = new Map([
    ['/goals.sqlite', { mtimeMs: 10, size: 100 }],
    ['/goals.sqlite-wal', { mtimeMs: 20, size: 200 }],
  ]);
  const signature = () => goalDatabaseSignature('/goals.sqlite', (file) => stats.get(file), (file) => stats.has(file));
  const before = signature();
  stats.set('/goals.sqlite-wal', { mtimeMs: 21, size: 240 });
  assert.notEqual(signature(), before);
});

test('keeps the newest session index entry for each thread', () => {
  const result = parseSessionIndex([
    JSON.stringify({ id: 'a', thread_name: 'Old' }),
    JSON.stringify({ id: 'a', thread_name: 'New' }),
    '{incomplete',
  ].join('\n'));
  assert.equal(result.get('a').thread_name, 'New');
});

test('reports a task after task_started as running', () => {
  const result = inferStatus(line('event_msg', { type: 'task_started' }), Date.now());
  assert.equal(result.state, 'running');
});

test('shows the most recent visible work message while running', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message: '正在构建 Android 客户端' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'running', message: '正在构建 Android 客户端' });
});

test('keeps the complete recent work message for scrollable mobile details', () => {
  const message = `第一行\n${'完整工作内容'.repeat(90)}\n最后一行`;
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message }),
  ].join('\n'), Date.now());

  assert.equal(result.state, 'running');
  assert.equal(result.message, message);
  assert.ok(result.message.length > 240);
});

test('separates explicitly referenced local evidence images from visible work text', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-'));
  const image = path.join(directory, 'result image.png');
  try {
    fs.writeFileSync(image, 'png-data');
    const result = extractEvidenceImages(`页面已完成\n\n![最终页面](<${image}>)`, 'thread-1');
    assert.equal(result.message, '页面已完成');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].name, 'result image.png');
    assert.equal(result.evidence[0].mimeType, 'image/png');
    assert.match(result.evidence[0].downloadPath, /^\/evidence\/[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(result).includes(directory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not expose missing unsupported or ordinary linked files as evidence', () => {
  const result = extractEvidenceImages([
    '![missing](/tmp/not-present.png)',
    '[document](/tmp/private.pdf)',
  ].join('\n'), 'thread-1');
  assert.equal(result.evidence.length, 0);
  assert.equal(result.message.includes('not-present.png'), false);
  assert.match(result.message, /document/);
});

test('reports a final answer followed by task_complete as completed', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'agent_message', phase: 'final_answer', message: 'All done' }),
    line('event_msg', { type: 'task_complete' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'completed', message: 'All done' });
});

test('uses task_complete last_agent_message when the final response record is outside the tail window', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'task_complete', last_agent_message: '构建已完成' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'completed', message: '构建已完成' });
});

test('reports task_complete with a provider error as blocked', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', {
      type: 'task_complete',
      error: {
        message: 'unexpected status 413 Payload Too Large: openai_error',
        codex_error_info: 'other',
      },
    }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, {
    state: 'blocked',
    message: 'unexpected status 413 Payload Too Large: openai_error',
  });
});

test('an automatic retry is running as soon as a new task starts', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'task_complete', error: { message: 'retry 5/5 failed' } }),
    line('event_msg', { type: 'task_started' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'running', message: 'Codex 正在处理' });
});

test('an automatic retry becomes running after real agent progress', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'task_complete', error: { message: 'retry 5/5 failed' } }),
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'agent_reasoning', text: '继续处理任务' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'running', message: 'Codex 正在处理' });
});

test('keeps a quiet running task green while it is not stopped', () => {
  const now = Date.now();
  const result = inferStatus(line('event_msg', { type: 'task_started' }), now - 190000, now, 180000);
  assert.deepEqual(result, { state: 'running', message: 'Codex 正在处理' });
});

test('recognizes activity in a truncated large rollout as running', () => {
  const tail = [
    line('event_msg', { type: 'agent_reasoning', text: '继续渲染' }),
    line('response_item', { type: 'custom_tool_call', status: 'completed' }),
  ].join('\n');
  assert.deepEqual(inferStatus(tail, Date.now(), Date.now(), undefined, true), {
    state: 'running',
    message: 'Codex 正在处理',
  });
});

test('does not infer running from an untruncated idle rollout', () => {
  const text = line('event_msg', { type: 'agent_reasoning', text: '旧记录' });
  assert.deepEqual(inferStatus(text, Date.now()), { state: 'completed', message: '会话当前空闲' });
});

test('keeps a reconnectable stream error running', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'stream_error', message: 'Connection lost' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'running', message: 'Codex 正在处理' });
});

test('reports a terminal task failure as blocked', () => {
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'task_failed', message: 'Connection lost' }),
  ].join('\n'), Date.now());
  assert.deepEqual(result, { state: 'blocked', message: 'Connection lost' });
});

test('a live turn overrides a stale blocked goal row', () => {
  const result = applyGoalStatus(
    { state: 'running', message: 'Codex 正在处理' },
    'thread-1',
    undefined,
    new Map([['thread-1', { status: 'blocked' }]]),
  );
  assert.deepEqual(result, {
    state: 'running', message: 'Codex 正在处理', goal: { status: 'blocked', objective: '' },
  });
});

test('a blocked goal is red after the turn has stopped', () => {
  const result = applyGoalStatus(
    { state: 'completed', message: '会话当前空闲' },
    'thread-1',
    undefined,
    new Map([['thread-1', { status: 'blocked' }]]),
  );
  assert.deepEqual(result, {
    state: 'blocked', message: '目标已阻塞', goal: { status: 'blocked', objective: '' },
  });
});

test('exposes normalized Goal metadata without overriding a running turn', () => {
  const result = applyGoalStatus(
    { state: 'running', message: '仍在执行' },
    'thread-1',
    undefined,
    new Map([['thread-1', { status: 'usage_limited', objective: '持续推进实验' }]]),
  );
  assert.deepEqual(result, {
    state: 'running',
    message: '仍在执行',
    goal: { status: 'usageLimited', objective: '持续推进实验' },
  });
});

test('keeps a running turn green when a huge tool output hides it from a fixed-size tail', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-rollout-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started' }),
      line('event_msg', { type: 'agent_message', message: '开始正式渲染' }),
      line('response_item', { type: 'custom_tool_call_output', output: 'x'.repeat(2 * 1024 * 1024) }),
      line('event_msg', { type: 'token_count' }),
    ].join('\n'));
    const session = { id: `large-${Date.now()}`, title: 'Large rollout', rolloutPath };
    assert.deepEqual(sessionStatus(session), {
      id: session.id,
      title: 'Large rollout',
      updatedAt: sessionStatus(session).updatedAt,
      state: 'running',
      message: '开始正式渲染',
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps the latest evidence across later text and replaces it with the next evidence set', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-cache-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const imagePath = path.join(directory, 'proof.png');
  const replacementPath = path.join(directory, 'replacement.jpg');
  const session = { id: `evidence-${Date.now()}`, title: 'Evidence cache', rolloutPath };
  try {
    fs.writeFileSync(imagePath, 'proof');
    fs.writeFileSync(replacementPath, 'replacement');
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started' }),
      line('event_msg', { type: 'agent_message', message: `证据如下\n![proof](${imagePath})` }),
      '',
    ].join('\n'));
    const first = sessionStatus(session);
    assert.equal(first.evidence.length, 1);
    fs.appendFileSync(rolloutPath, `${line('response_item', { type: 'custom_tool_call_output', output: 'ok' })}\n`);
    assert.equal(sessionStatus(session).evidence.length, 1);
    fs.appendFileSync(rolloutPath, `${line('event_msg', { type: 'agent_message', message: '下一条工作内容没有图片' })}\n`);
    assert.equal(sessionStatus(session).evidence.length, 1);
    assert.equal(sessionStatus(session).evidence[0].name, 'proof.png');
    fs.appendFileSync(rolloutPath, `${line('event_msg', {
      type: 'agent_message', message: `新证据\n![replacement](${replacementPath})`,
    })}\n`);
    assert.equal(sessionStatus(session).evidence.length, 1);
    assert.equal(sessionStatus(session).evidence[0].name, 'replacement.jpg');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
