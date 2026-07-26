const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authorizeGoalCommand,
  createGoalCommandController,
  validateGoalCommand,
} = require('../src/lib/goal-control');

const ROOT_ID = '00000000-0000-4000-8000-000000000101';
const CHILD_ID = '00000000-0000-4000-8000-000000000102';

function fixture({ goalStatus = 'blocked', snapshotState = 'completed' } = {}) {
  const sessions = [
    { id: ROOT_ID, rootId: ROOT_ID, title: 'Goal task', threadSource: 'user' },
    { id: CHILD_ID, rootId: ROOT_ID, parentId: ROOT_ID, title: 'Goal task / child', threadSource: 'subagent' },
  ];
  return {
    sessions,
    selectedIds: new Set([ROOT_ID]),
    goalStatuses: new Map([[ROOT_ID, { status: goalStatus }]]),
    getSessionStatus: () => ({ state: snapshotState, message: snapshotState }),
  };
}

test('validates Goal command UUIDs and supported commands', () => {
  assert.deepEqual(validateGoalCommand({ sessionId: ROOT_ID, command: ' resume ' }), {
    sessionId: ROOT_ID,
    command: 'resume',
    confirmed: false,
  });
  assert.throws(() => validateGoalCommand({ sessionId: 'bad', command: 'resume' }), /session ID/);
  assert.throws(() => validateGoalCommand({ sessionId: ROOT_ID, command: 'pause' }), /resume or delete/);
});

test('authorizes a selected child through its canonical monitored session', () => {
  assert.deepEqual(authorizeGoalCommand({
    input: { sessionId: CHILD_ID, command: 'resume' },
    ...fixture(),
  }), {
    sessionId: ROOT_ID,
    command: 'resume',
    confirmed: false,
    goalStatus: 'blocked',
    sessionState: 'completed',
    sessionTitle: 'Goal task',
  });
});

test('rejects a Goal command for a session outside the monitor selection', () => {
  assert.throws(() => authorizeGoalCommand({
    input: { sessionId: ROOT_ID, command: 'delete', confirmed: true },
    ...fixture(),
    selectedIds: new Set(),
  }), /selected for monitoring/);
});

test('rejects a Goal command when the selected session has no Goal', () => {
  assert.throws(() => authorizeGoalCommand({
    input: { sessionId: ROOT_ID, command: 'delete', confirmed: true },
    ...fixture(),
    goalStatuses: new Map(),
  }), /does not have a Goal/);
});

test('authorizes stopped blocked or limited Goal resumes and rejects complete Goals', () => {
  for (const goalStatus of ['blocked', 'usage_limited', 'budget_limited']) {
    assert.equal(authorizeGoalCommand({
      input: { sessionId: ROOT_ID, command: 'resume' },
      ...fixture({ goalStatus }),
    }).goalStatus, goalStatus);
  }
  for (const goalStatus of ['complete']) {
    assert.throws(() => authorizeGoalCommand({
      input: { sessionId: ROOT_ID, command: 'resume' },
      ...fixture({ goalStatus }),
    }), /cannot be resumed/);
  }
});

test('authorizes continuing an active Goal when its turn is idle', () => {
  assert.deepEqual(authorizeGoalCommand({
    input: { sessionId: ROOT_ID, command: 'resume' },
    ...fixture({ goalStatus: 'active', snapshotState: 'completed' }),
  }), {
    sessionId: ROOT_ID,
    command: 'resume',
    confirmed: false,
    goalStatus: 'active',
    sessionState: 'completed',
    sessionTitle: 'Goal task',
  });
});

test('authorizes restoring a paused Goal while its turn is running', () => {
  assert.deepEqual(authorizeGoalCommand({
    input: { sessionId: ROOT_ID, command: 'resume' },
    ...fixture({ goalStatus: 'paused', snapshotState: 'running' }),
  }), {
    sessionId: ROOT_ID,
    command: 'resume',
    confirmed: false,
    goalStatus: 'paused',
    sessionState: 'running',
    sessionTitle: 'Goal task',
  });
});

test('does not resume a non-paused Goal while its turn is running', () => {
  for (const goalStatus of ['active', 'blocked', 'usage_limited', 'budget_limited']) {
    assert.throws(() => authorizeGoalCommand({
      input: { sessionId: ROOT_ID, command: 'resume' },
      ...fixture({ goalStatus, snapshotState: 'running' }),
    }), /turn is still running/);
  }
});

test('allows confirmed delete for any existing selected Goal', () => {
  assert.deepEqual(authorizeGoalCommand({
    input: { sessionId: ROOT_ID, command: 'delete', confirmed: true },
    ...fixture({ goalStatus: 'active', snapshotState: 'running' }),
  }), {
    sessionId: ROOT_ID,
    command: 'delete',
    confirmed: true,
    goalStatus: 'active',
  });
});

test('rejects delete unless confirmed is exactly true', () => {
  for (const confirmed of [undefined, false, 'true', 1]) {
    assert.throws(() => authorizeGoalCommand({
      input: { sessionId: ROOT_ID, command: 'delete', confirmed },
      ...fixture(),
    }), /confirmed: true/);
  }
});

test('passes only the authorized canonical command to the native commander', async () => {
  let nativeInput;
  const state = fixture();
  const controller = createGoalCommandController({
    getSessions: () => state.sessions,
    getSelectedIds: () => state.selectedIds,
    getGoalStatuses: () => state.goalStatuses,
    getSessionStatus: state.getSessionStatus,
    executeNativeGoalCommand: async (input) => {
      nativeInput = input;
      return { ok: true, message: 'native result' };
    },
  });

  const authorized = controller.validate({ sessionId: CHILD_ID, command: 'resume' });
  const result = await controller.send(authorized);

  assert.deepEqual(nativeInput, {
    sessionId: ROOT_ID,
    command: 'resume',
    confirmed: false,
    goalStatus: 'blocked',
    sessionState: 'completed',
    sessionTitle: 'Goal task',
  });
  assert.deepEqual(result, { ok: true, message: 'native result' });
});
