const {
  aggregateSessionStatuses,
  normalizeSelectedSessionIds,
  sessionStatus,
} = require('./codex');

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUMABLE_GOAL_STATUSES = new Set(['blocked', 'usage_limited', 'budget_limited']);
const CONTINUABLE_GOAL_STATUSES = new Set(['active', 'paused', ...RESUMABLE_GOAL_STATUSES]);

function validateGoalCommand({ sessionId, command, confirmed }) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedCommand = String(command || '').trim();
  const normalizedConfirmed = confirmed === true;
  if (!SESSION_ID_PATTERN.test(normalizedSessionId)) throw new Error('session ID format is invalid');
  if (!['resume', 'delete'].includes(normalizedCommand)) {
    throw new Error('Goal command must be resume or delete');
  }
  if (normalizedCommand === 'delete' && !normalizedConfirmed) {
    throw new Error('Goal deletion requires confirmed: true');
  }
  return {
    sessionId: normalizedSessionId,
    command: normalizedCommand,
    confirmed: normalizedConfirmed,
  };
}

function authorizeGoalCommand({
  input,
  sessions,
  selectedIds,
  goalStatuses,
  getSessionStatus = sessionStatus,
}) {
  const command = validateGoalCommand(input);
  const canonicalId = [...normalizeSelectedSessionIds(sessions, [command.sessionId])][0];
  const selected = normalizeSelectedSessionIds(sessions, selectedIds);
  if (!canonicalId || !selected.has(canonicalId)) {
    throw new Error('the session is not selected for monitoring');
  }
  const goal = goalStatuses.get(canonicalId);
  if (!goal) throw new Error('the selected session does not have a Goal');

  if (command.command === 'resume') {
    const session = aggregateSessionStatuses(sessions, [canonicalId], getSessionStatus)[0];
    const state = session?.state || 'unknown';
    if (state === 'running' && goal.status !== 'paused') {
      throw new Error('the selected session turn is still running');
    }
    if (!CONTINUABLE_GOAL_STATUSES.has(goal.status)) {
      throw new Error(`Goal status ${goal.status || 'missing'} cannot be resumed`);
    }
    return {
      sessionId: canonicalId,
      command: command.command,
      confirmed: command.confirmed,
      goalStatus: goal.status,
      sessionState: state,
      sessionTitle: session?.title || '',
    };
  }

  return {
    sessionId: canonicalId,
    command: command.command,
    confirmed: command.confirmed,
    goalStatus: goal.status,
  };
}

function createGoalCommandController({
  getSessions,
  getSelectedIds,
  getGoalStatuses,
  getSessionStatus = sessionStatus,
  executeNativeGoalCommand,
}) {
  return {
    validate: (input) => authorizeGoalCommand({
      input,
      sessions: getSessions(),
      selectedIds: getSelectedIds(),
      goalStatuses: getGoalStatuses(),
      getSessionStatus,
    }),
    send: (command) => executeNativeGoalCommand(command),
  };
}

module.exports = {
  authorizeGoalCommand,
  createGoalCommandController,
  validateGoalCommand,
};
