const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  activateEvidence,
  aggregateSessionStatuses,
  applyGoalStatus,
  applyThreadNames,
  evidenceFile,
  extractEvidenceImages,
  goalStatusRecord,
  goalStatuses,
  inferStatus,
  normalizeSelectedSessionIds,
  officialTurnCandidateIds,
  parseSessionIndex,
  resolveSessionHierarchy,
  sessionStatus,
} = require('../src/lib/codex');

const line = (type, payload) => JSON.stringify({ type, payload });

test('keeps the newest session index entry for each thread', () => {
  const result = parseSessionIndex([
    JSON.stringify({ id: 'a', thread_name: 'Old' }),
    JSON.stringify({ id: 'a', thread_name: 'New' }),
    '{incomplete',
  ].join('\n'));
  assert.equal(result.get('a').thread_name, 'New');
});

test('aggregates a selected blocked child under its running root snapshot', () => {
  const sessions = [
    { id: 'root', rootId: 'root', title: 'Painting experiment' },
    { id: 'child', rootId: 'root', title: 'Painting experiment / blocked fork' },
  ];
  const statuses = new Map([
    ['root', { state: 'running', message: 'Rendering image' }],
    ['child', { state: 'blocked', message: 'Old task failed' }],
  ]);

  assert.deepEqual(aggregateSessionStatuses(sessions, new Set(['child']), (session) => statuses.get(session.id)), [
    { id: 'root', title: 'Painting experiment', state: 'running', message: 'Rendering image' },
  ]);
});

test('uses a running child activity for a selected idle root before a blocked child', () => {
  const sessions = [
    { id: 'root', rootId: 'root', title: 'Painting experiment' },
    { id: 'running-child', rootId: 'root', title: 'Painting experiment / active fork' },
    { id: 'blocked-child', rootId: 'root', title: 'Painting experiment / old fork' },
  ];
  const statuses = new Map([
    ['root', { state: 'completed', message: 'Idle' }],
    ['running-child', { state: 'running', message: 'Rendering image' }],
    ['blocked-child', { state: 'blocked', message: 'Old task failed' }],
  ]);

  assert.deepEqual(aggregateSessionStatuses(sessions, new Set(['root']), (session) => statuses.get(session.id)), [
    { id: 'root', title: 'Painting experiment', state: 'running', message: 'Rendering image' },
  ]);
});

test('uses a newer explicit blocked state before an orphaned older running child', () => {
  const sessions = [
    { id: 'root', rootId: 'root', title: 'Painting experiment' },
    { id: 'child', rootId: 'root', title: 'Painting experiment / stale review' },
  ];
  const statuses = new Map([
    ['root', { state: 'blocked', message: 'Goal blocked', updatedAt: '2026-07-24T13:20:00.000Z' }],
    ['child', { state: 'running', message: 'Old review output', updatedAt: '2026-07-24T07:41:00.000Z' }],
  ]);

  assert.deepEqual(aggregateSessionStatuses(sessions, new Set(['root']), (session) => statuses.get(session.id)), [
    {
      id: 'root',
      title: 'Painting experiment',
      state: 'blocked',
      message: 'Goal blocked',
      updatedAt: '2026-07-24T13:20:00.000Z',
    },
  ]);
});

test('keeps a newer running child before an older blocked state', () => {
  const sessions = [
    { id: 'root', rootId: 'root', title: 'Painting experiment' },
    { id: 'child', rootId: 'root', title: 'Painting experiment / active run' },
  ];
  const statuses = new Map([
    ['root', { state: 'blocked', message: 'Old goal state', updatedAt: '2026-07-24T07:41:00.000Z' }],
    ['child', { state: 'running', message: 'Rendering', updatedAt: '2026-07-24T13:20:00.000Z' }],
  ]);

  assert.equal(
    aggregateSessionStatuses(sessions, new Set(['root']), (session) => statuses.get(session.id))[0].state,
    'running',
  );
});

test('normalizes a selected child ID to its root ID', () => {
  const sessions = [
    { id: 'root', rootId: 'root', title: 'Painting experiment' },
    { id: 'child', rootId: 'root', title: 'Painting experiment / fork' },
  ];

  assert.deepEqual(normalizeSelectedSessionIds(sessions, new Set(['child'])), new Set(['root']));
});

test('official turn candidates stay bounded to the selected canonical and running family members', () => {
  const sessions = [
    {
      id: 'old-root',
      rootId: 'old-root',
      title: 'Experiment',
      threadSource: 'user',
      updatedAt: '2026-07-24T01:00:00.000Z',
    },
    {
      id: 'selected-continuation',
      rootId: 'old-root',
      title: 'Experiment continued',
      threadSource: 'user',
      updatedAt: '2026-07-26T01:00:00.000Z',
    },
    {
      id: 'running-child',
      rootId: 'old-root',
      title: 'Active child',
      threadSource: 'subagent',
      updatedAt: '2026-07-26T01:01:00.000Z',
    },
    ...Array.from({ length: 300 }, (_value, index) => ({
      id: `completed-child-${index}`,
      rootId: 'old-root',
      title: `Completed child ${index}`,
      threadSource: 'subagent',
      updatedAt: '2026-07-24T01:00:00.000Z',
    })),
    {
      id: 'unrelated-running',
      rootId: 'unrelated-running',
      title: 'Unrelated',
      threadSource: 'user',
      updatedAt: '2026-07-26T01:02:00.000Z',
    },
  ];
  const getStatus = (session) => ({
    state: ['running-child', 'unrelated-running'].includes(session.id) ? 'running' : 'completed',
    message: 'fixture',
  });

  assert.deepEqual(
    officialTurnCandidateIds(sessions, new Set(['old-root']), getStatus),
    new Set(['selected-continuation', 'running-child']),
  );
});

test('uses the newest user continuation as the monitored conversation and title', () => {
  const sessions = resolveSessionHierarchy([
    {
      id: 'old-root',
      title: '旧版长任务',
      parentId: null,
      threadSource: 'user',
      updatedAt: '2026-06-09T08:10:14.000Z',
    },
    {
      id: 'main-v2',
      title: '长任务主会话',
      parentId: 'old-root',
      threadSource: 'user',
      updatedAt: '2026-07-24T15:29:47.000Z',
    },
    {
      id: 'review-child',
      title: '审查子任务',
      parentId: 'main-v2',
      threadSource: 'subagent',
      updatedAt: '2026-07-24T15:31:00.000Z',
    },
  ]);
  const statuses = new Map([
    ['old-root', { state: 'blocked', message: '旧 Goal 已阻塞' }],
    ['main-v2', { state: 'running', message: '正在执行长任务' }],
    ['review-child', { state: 'completed', message: '审查已完成' }],
  ]);

  assert.deepEqual(normalizeSelectedSessionIds(sessions, new Set(['old-root'])), new Set(['main-v2']));
  assert.deepEqual(aggregateSessionStatuses(sessions, new Set(['old-root']), (session) => statuses.get(session.id)), [
    { id: 'main-v2', title: '长任务主会话', state: 'running', message: '正在执行长任务' },
  ]);
});

test('official user-facing names override stale index titles only when nonempty', () => {
  const sessions = [
    { id: 'thread-1', title: 'Old title' },
    { id: 'thread-2', title: 'Keep me' },
  ];

  assert.deepEqual(applyThreadNames(sessions, new Map([
    ['thread-1', 'Renamed task'],
    ['thread-2', '   '],
  ])), [
    { id: 'thread-1', title: 'Renamed task' },
    { id: 'thread-2', title: 'Keep me' },
  ]);
});

test('resolves a newest-first multi-generation session chain to the oldest root', () => {
  const sessions = [
    { id: 'grandchild', title: 'Active painting stage', parentId: 'child' },
    { id: 'child', title: 'Painting stage', parentId: 'root' },
    { id: 'root', title: 'Painting experiment', parentId: null },
  ];

  resolveSessionHierarchy(sessions);

  assert.deepEqual(sessions.map(({ id, title, rootId }) => ({ id, title, rootId })), [
    { id: 'grandchild', title: 'Painting experiment / Active painting stage', rootId: 'root' },
    { id: 'child', title: 'Painting experiment / Painting stage', rootId: 'root' },
    { id: 'root', title: 'Painting experiment', rootId: 'root' },
  ]);
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

test('keeps a substantial recent message in the snapshot', () => {
  const message = 'recent-work '.repeat(100).trim();
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message }),
  ].join('\n'), Date.now());

  assert.equal(result.message, message);
});

test('keeps the complete multiline recent message in the snapshot', () => {
  const message = `${'x'.repeat(4500)}\nsecond line`;
  const result = inferStatus([
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'agent_message', phase: 'commentary', message }),
  ].join('\n'), Date.now());

  assert.equal(result.message, message);
});

test('separates local evidence images from visible work text', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-'));
  const image = path.join(directory, 'result image.png');
  try {
    fs.writeFileSync(image, 'png-data');
    const result = extractEvidenceImages(`页面已完成\n\n![最终页面](<${image}>)`, 'thread-1');
    activateEvidence([result]);
    assert.equal(result.message, '页面已完成');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].name, 'result image.png');
    assert.equal(result.evidence[0].mimeType, 'image/png');
    assert.match(result.evidence[0].downloadPath, /^\/evidence\/[a-f0-9]{32}$/);
    assert.equal(JSON.stringify(result).includes(directory), false);
    assert.equal(evidenceFile(result.evidence[0].id).path, fs.realpathSync(image));
  } finally {
    activateEvidence([]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removes a Windows local image reference from visible work text', () => {
  const result = extractEvidenceImages(
    '页面已完成\n\n![最终页面](<C:\\Users\\runner\\AppData\\Local\\Temp\\result image.png>)',
    'thread-1',
  );
  assert.equal(result.message, '页面已完成');
  assert.equal(result.evidence.length, 0);
});

test('does not expose missing or unsupported local images', () => {
  const result = extractEvidenceImages([
    '![missing](/tmp/not-present.png)',
    '[document](/tmp/private.pdf)',
  ].join('\n'), 'thread-1');
  assert.equal(result.evidence.length, 0);
  assert.equal(result.message.includes('not-present.png'), false);
  assert.match(result.message, /document/);
});

test('keeps the latest evidence group after ordinary assistant progress', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-retain-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const image = path.join(directory, 'proof.png');
  try {
    fs.writeFileSync(image, 'proof-image');
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started' }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: `已生成证据\n\n![proof](<${image}>)` }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: '继续核对普通文字' }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-retain', title: 'Evidence', rolloutPath });

    assert.equal(result.message, '继续核对普通文字');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].name, 'proof.png');
  } finally {
    activateEvidence([]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('replaces retained evidence with the newest explicit image group', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-replace-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const first = path.join(directory, 'first.png');
  const second = path.join(directory, 'second.png');
  try {
    fs.writeFileSync(first, 'first-image');
    fs.writeFileSync(second, 'second-image');
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started' }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: `![first](<${first}>)` }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: '普通进展' }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: `![second](<${second}>)` }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: '最终进展' }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-replace', title: 'Evidence', rolloutPath });

    assert.deepEqual(result.evidence.map((item) => item.name), ['second.png']);
  } finally {
    activateEvidence([]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not fall back to old evidence when the newest image reference is unavailable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-evidence-missing-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  const first = path.join(directory, 'first.png');
  const missing = path.join(directory, 'missing.png');
  try {
    fs.writeFileSync(first, 'first-image');
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started' }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: `![first](<${first}>)` }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: `![missing](<${missing}>)` }),
      line('event_msg', { type: 'agent_message', phase: 'commentary', message: '继续处理' }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-missing', title: 'Evidence', rolloutPath });

    assert.equal(result.evidence, undefined);
  } finally {
    activateEvidence([]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test('an explicit blocked goal carries its authoritative update time', () => {
  const updatedAtMs = Date.parse('2026-07-24T13:20:00.000Z');
  const result = applyGoalStatus(
    { state: 'completed', message: 'Idle', updatedAt: '2026-07-24T01:00:00.000Z' },
    'thread-1',
    undefined,
    new Map([['thread-1', { status: 'blocked', updated_at_ms: updatedAtMs }]]),
  );
  assert.equal(result.state, 'blocked');
  assert.equal(result.updatedAt, '2026-07-24T13:20:00.000Z');
});

test('refreshes cached goal statuses when only the SQLite WAL changes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-goals-'));
  const databasePath = path.join(home, 'goals_1.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode=WAL');
    database.exec('CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT, objective TEXT, updated_at_ms INTEGER)');
    database.prepare('INSERT INTO thread_goals VALUES (?, ?, ?, ?)').run('thread-1', 'active', 'Test', 1);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    assert.equal(goalStatuses(home).get('thread-1').status, 'active');
    assert.equal(goalStatusRecord('thread-1', home).status, 'active');
    assert.equal(goalStatusRecord('missing-thread', home), null);

    database.prepare('UPDATE thread_goals SET status = ?, updated_at_ms = ? WHERE thread_id = ?')
      .run('blocked', 2, 'thread-1');

    assert.equal(goalStatuses(home).get('thread-1').status, 'blocked');
  } finally {
    database.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a running rollout is not overridden by a stale blocked goal', () => {
  const result = applyGoalStatus(
    { state: 'running', message: 'Codex 正在处理' },
    'thread-1',
    undefined,
    new Map([['thread-1', { status: 'blocked', objective: 'Continue the experiment' }]]),
  );
  assert.deepEqual(result, {
    state: 'running',
    message: 'Codex 正在处理',
    goal: { status: 'blocked', objective: 'Continue the experiment' },
  });
});

test('stopped limited Goals are blocked while running work remains authoritative', () => {
  for (const [storedStatus, protocolStatus] of [
    ['usage_limited', 'usageLimited'],
    ['budget_limited', 'budgetLimited'],
  ]) {
    const stopped = applyGoalStatus(
      { state: 'completed', message: 'Idle' },
      'thread-1',
      undefined,
      new Map([['thread-1', { status: storedStatus, objective: 'Continue safely' }]]),
    );
    assert.equal(stopped.state, 'blocked');
    assert.deepEqual(stopped.goal, { status: protocolStatus, objective: 'Continue safely' });

    const running = applyGoalStatus(
      { state: 'running', message: 'Working' },
      'thread-1',
      undefined,
      new Map([['thread-1', { status: storedStatus, objective: 'Continue safely' }]]),
    );
    assert.equal(running.state, 'running');
    assert.deepEqual(running.goal, { status: protocolStatus, objective: 'Continue safely' });
  }
});

test('omits Goal metadata when the selected session has no Goal', () => {
  const value = { state: 'completed', message: 'Idle' };
  assert.deepEqual(applyGoalStatus(value, 'thread-1', undefined, new Map()), value);
});

test('session status uses an injected official Goal map', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-official-goal-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, `${line('event_msg', { type: 'task_complete' })}\n`);
    const result = sessionStatus({ id: 'thread-1', title: 'Test', rolloutPath }, {
      goalStatuses: new Map([['thread-1', { status: 'blocked', objective: 'Resume me' }]]),
    });
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.goal, { status: 'blocked', objective: 'Resume me' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact official inProgress turn stays running before a stale blocked Goal', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-turn-running-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started', turn_id: 'turn-active', started_at: 42 }),
      line('turn_context', { turn_id: 'turn-active' }),
      line('event_msg', {
        type: 'task_failed',
        turn_id: 'turn-active',
        message: 'Old terminal transport error',
      }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-1', title: 'Test', rolloutPath }, {
      goalStatuses: new Map([['thread-1', { status: 'blocked', objective: 'Continue safely' }]]),
      turnStatuses: new Map([['thread-1', {
        id: 'turn-active',
        status: 'inProgress',
        startedAt: 42,
        completedAt: null,
        error: null,
      }]]),
    });

    assert.equal(result.state, 'running');
    assert.deepEqual(result.goal, { status: 'blocked', objective: 'Continue safely' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact official interrupted turn cannot remain running without a rollout terminal event', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-turn-interrupted-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started', turn_id: 'turn-interrupted', started_at: 84 }),
      line('turn_context', { turn_id: 'turn-interrupted' }),
      line('event_msg', {
        type: 'agent_message',
        phase: 'commentary',
        message: '最后一条真实工作内容',
      }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-2', title: 'Test', rolloutPath }, {
      goalStatuses: new Map([['thread-2', { status: 'active', objective: 'Continue safely' }]]),
      turnStatuses: new Map([['thread-2', {
        id: 'turn-interrupted',
        status: 'interrupted',
        startedAt: 84,
        completedAt: null,
        error: null,
      }]]),
    });

    assert.equal(result.state, 'completed');
    assert.equal(result.message, '最后一条真实工作内容');
    assert.deepEqual(result.goal, { status: 'active', objective: 'Continue safely' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact official completed turn cannot remain running without a rollout receipt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-turn-completed-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started', turn_id: 'turn-completed', started_at: 126 }),
      line('turn_context', { turn_id: 'turn-completed' }),
      line('event_msg', {
        type: 'agent_message',
        phase: 'commentary',
        message: '已经完成实际工作',
      }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-3', title: 'Test', rolloutPath }, {
      turnStatuses: new Map([['thread-3', {
        id: 'turn-completed',
        status: 'completed',
        startedAt: 126,
        completedAt: 140,
        error: null,
      }]]),
    });

    assert.equal(result.state, 'completed');
    assert.equal(result.message, '已经完成实际工作');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact official failed turn is blocked with its official error', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-turn-failed-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started', turn_id: 'turn-failed', started_at: 168 }),
      line('turn_context', { turn_id: 'turn-failed' }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-4', title: 'Test', rolloutPath }, {
      turnStatuses: new Map([['thread-4', {
        id: 'turn-failed',
        status: 'failed',
        startedAt: 168,
        completedAt: 180,
        error: { message: 'Official execution failure' },
      }]]),
    });

    assert.equal(result.state, 'blocked');
    assert.equal(result.message, 'Official execution failure');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a stale official terminal record cannot override a newer rollout turn ID', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-turn-mismatch-'));
  const rolloutPath = path.join(directory, 'rollout.jsonl');
  try {
    fs.writeFileSync(rolloutPath, [
      line('event_msg', { type: 'task_started', turn_id: 'turn-new', started_at: 210 }),
      line('turn_context', { turn_id: 'turn-new' }),
    ].join('\n'));

    const result = sessionStatus({ id: 'thread-5', title: 'Test', rolloutPath }, {
      turnStatuses: new Map([['thread-5', {
        id: 'turn-old',
        status: 'interrupted',
        startedAt: 200,
        completedAt: null,
        error: null,
      }]]),
    });

    assert.equal(result.state, 'running');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
