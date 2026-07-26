const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TERMINAL_ERROR_EVENTS = new Set([
  'error',
  'turn_aborted',
  'task_failed',
]);
const statusCache = new Map();
let goalCache = { path: null, signature: null, values: new Map() };
const evidenceFiles = new Map();
let activeEvidenceIds = new Set();
const EVIDENCE_TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
]);

function localImagePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('file://')) {
      const pathname = decodeURIComponent(new URL(raw).pathname);
      return process.platform === 'win32' && /^\/[A-Za-z]:\//.test(pathname)
        ? pathname.slice(1)
        : pathname;
    }
  } catch {
    return null;
  }
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw) ? decodeURIComponent(raw) : null;
}

function extractEvidenceImages(message, threadId) {
  const evidence = [];
  const ids = new Set();
  let removedLocalImage = false;
  const imagePattern = /!\[[^\]]*\]\(\s*<?(file:\/\/\/[^)>\n]+|\/[^)>\n]+|[A-Za-z]:[\\/][^)>\n]+)>?\s*\)/g;
  const cleanMessage = String(message || '').replace(imagePattern, (_markdown, reference) => {
    removedLocalImage = true;
    if (evidence.length >= 10) return '';
    const candidate = localImagePath(reference);
    if (!candidate) return '';
    let realPath;
    let stat;
    try {
      realPath = fs.realpathSync(candidate);
      stat = fs.statSync(realPath);
    } catch {
      return '';
    }
    const mimeType = EVIDENCE_TYPES.get(path.extname(realPath).toLowerCase());
    if (!mimeType || !stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) return '';
    const id = crypto.createHash('sha256')
      .update(`${threadId}\0${realPath}\0${stat.mtimeMs}\0${stat.size}`)
      .digest('hex').slice(0, 32);
    if (!ids.has(id)) {
      ids.add(id);
      evidenceFiles.set(id, { path: realPath, mimeType, size: stat.size, name: path.basename(realPath) });
      evidence.push({ id, name: path.basename(realPath), mimeType, downloadPath: `/evidence/${id}` });
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return {
    message: cleanMessage || (evidence.length
      ? `已附带 ${evidence.length} 张证据图片`
      : removedLocalImage ? '最近工作图片已不可用' : String(message || '')),
    evidence,
    hasLocalImageReference: removedLocalImage,
  };
}

function latestEvidenceImages(text, threadId) {
  const lines = String(text || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    let record;
    try { record = JSON.parse(lines[index]); } catch { continue; }
    const payload = record?.type === 'event_msg' && record.payload?.type === 'agent_message'
      ? record.payload : null;
    if (!payload) continue;
    const visible = extractEvidenceImages(usefulMessage(payload), threadId);
    if (visible.hasLocalImageReference) return visible.evidence;
  }
  return null;
}

function activateEvidence(values) {
  activeEvidenceIds = new Set(values.flatMap((value) => value.evidence || []).map((item) => item.id));
  for (const id of evidenceFiles.keys()) {
    if (!activeEvidenceIds.has(id)) evidenceFiles.delete(id);
  }
}

function evidenceFile(id) {
  if (!activeEvidenceIds.has(id)) return null;
  const value = evidenceFiles.get(id);
  if (!value) return null;
  try {
    const stat = fs.statSync(value.path);
    if (!stat.isFile() || stat.size !== value.size) return null;
  } catch {
    return null;
  }
  return value;
}

function databaseSignature(databasePath) {
  return [databasePath, `${databasePath}-wal`]
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return 'missing';
      }
    })
    .join('|');
}

function goalStatuses(home = codexHome()) {
  const candidates = [path.join(home, 'goals_1.sqlite'), path.join(home, 'sqlite', 'goals_1.sqlite')];
  const databasePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!databasePath) return new Map();
  try {
    const signature = databaseSignature(databasePath);
    if (goalCache.path === databasePath && goalCache.signature === signature) return goalCache.values;
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare('SELECT thread_id, status, objective, updated_at_ms FROM thread_goals').all();
    database.close();
    goalCache = {
      path: databasePath,
      signature,
      values: new Map(rows.map((row) => [row.thread_id, row])),
    };
    return goalCache.values;
  } catch {
    return new Map();
  }
}

function applyGoalStatus(value, threadId, home, statuses = goalStatuses(home)) {
  const goal = statuses.get(threadId);
  if (!goal) return value;
  const normalizedStatus = {
    usage_limited: 'usageLimited',
    budget_limited: 'budgetLimited',
  }[goal.status] || goal.status;
  const withGoal = {
    ...value,
    goal: {
      status: normalizedStatus,
      objective: String(goal.objective || ''),
    },
  };
  const blockedLabels = {
    blocked: '目标已阻塞',
    usage_limited: '目标因用量限制而阻塞',
    budget_limited: '目标因预算限制而阻塞',
  };
  if (value.state !== 'running' && blockedLabels[goal.status]) {
    const updatedAtMs = Number(goal.updated_at_ms);
    return {
      ...withGoal,
      state: 'blocked',
      message: blockedLabels[goal.status],
      updatedAt: Number.isFinite(updatedAtMs) && updatedAtMs > 0
        ? new Date(updatedAtMs).toISOString()
        : value.updatedAt,
    };
  }
  // Usage/budget markers can be stale or provider-specific; rollout events are authoritative.
  return withGoal;
}

function goalStatusRecord(threadId, home = codexHome()) {
  return goalStatuses(home).get(threadId) || null;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function parseSessionIndex(text) {
  const sessions = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.id) sessions.set(item.id, item);
    } catch {
      // A concurrently appended final line may be incomplete. It will be read next refresh.
    }
  }
  return sessions;
}

function walkRollouts(root, result = new Map()) {
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) walkRollouts(fullPath, result);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
      if (match) result.set(match[1], fullPath);
    }
  }
  return result;
}

function sessionMeta(filePath) {
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const record = buffer.subarray(0, length).toString('utf8').split(/\r?\n/).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((value) => value?.type === 'session_meta');
    const payload = record?.payload || {};
    return {
      parentId: payload.parent_thread_id || payload.forked_from_id || null,
      threadSource: payload.thread_source || (payload.source?.subagent ? 'subagent' : 'user'),
    };
  } catch {
    return { parentId: null, threadSource: null };
  }
}

function resolveSessionHierarchy(entries) {
  const byId = new Map(entries.map((item) => [item.id, item]));
  for (const item of entries) {
    const seen = new Set([item.id]);
    let root = item;
    while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
      seen.add(root.parentId);
      root = byId.get(root.parentId);
    }
    item.rootId = root.id;
    item.rootTitle = root.title;
    if (root.id !== item.id && item.threadSource !== 'user') item.title = `${root.title} / ${item.title}`;
  }
  return entries;
}

function listSessions(home = codexHome()) {
  const indexPath = path.join(home, 'session_index.jsonl');
  const index = fs.existsSync(indexPath)
    ? parseSessionIndex(fs.readFileSync(indexPath, 'utf8'))
    : new Map();
  const rollouts = walkRollouts(path.join(home, 'sessions'));

  const entries = [...index.values()]
    .map((item) => ({
      id: item.id,
      title: item.thread_name || '未命名会话',
      updatedAt: item.updated_at || null,
      rolloutPath: rollouts.get(item.id) || null,
    }))
    .filter((item) => item.rolloutPath)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const item of entries) {
    const meta = sessionMeta(item.rolloutPath);
    item.parentId = meta.parentId;
    item.threadSource = meta.threadSource;
  }
  return resolveSessionHierarchy(entries);
}

function rootSessionId(session) {
  return session?.rootId || session?.id || null;
}

function canonicalSessionForRoot(sessions, rootId) {
  const root = sessions.find((session) => session.id === rootId);
  return sessions
    .filter((session) => rootSessionId(session) === rootId && session.threadSource === 'user')
    .reduce((latest, session) => {
      if (!latest) return session;
      const latestTime = Date.parse(latest.updatedAt);
      const sessionTime = Date.parse(session.updatedAt);
      return Number.isFinite(sessionTime) && (!Number.isFinite(latestTime) || sessionTime > latestTime)
        ? session
        : latest;
    }, null) || root || null;
}

function canonicalSessions(sessions) {
  const rootIds = [...new Set(sessions.map(rootSessionId).filter(Boolean))];
  return rootIds.map((rootId) => canonicalSessionForRoot(sessions, rootId)).filter(Boolean);
}

function applyThreadNames(sessions, names = new Map()) {
  return sessions.map((session) => {
    const name = String(names.get(session.id) || '').trim();
    return name ? { ...session, title: name } : session;
  });
}

function isDescendantOf(session, ancestorId, byId) {
  const seen = new Set([session.id]);
  let current = session;
  while (current.parentId && !seen.has(current.parentId)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.parentId);
    current = byId.get(current.parentId);
    if (!current) return false;
  }
  return false;
}

function normalizeSelectedSessionIds(sessions, selectedIds) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const selectedSessions = new Set();
  for (const id of selectedIds || []) {
    const rootId = rootSessionId(byId.get(id));
    const canonical = rootId ? canonicalSessionForRoot(sessions, rootId) : null;
    if (canonical) selectedSessions.add(canonical.id);
  }
  return selectedSessions;
}

function officialTurnCandidateIds(sessions, selectedIds, getStatus = sessionStatus) {
  const selectedSessions = normalizeSelectedSessionIds(sessions, selectedIds);
  const selectedRoots = new Set(
    sessions
      .filter((session) => selectedSessions.has(session.id))
      .map((session) => rootSessionId(session)),
  );
  const candidates = new Set(selectedSessions);
  for (const session of sessions) {
    if (!selectedRoots.has(rootSessionId(session))) continue;
    if (getStatus(session).state === 'running') candidates.add(session.id);
  }
  return candidates;
}

function aggregateSessionStatuses(sessions, selectedIds, getStatus = sessionStatus) {
  const selectedSessions = normalizeSelectedSessionIds(sessions, selectedIds);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return canonicalSessions(sessions)
    .filter((session) => selectedSessions.has(session.id))
    .map((session) => {
      const members = sessions.filter((candidate) => (
        candidate.id === session.id
        || isDescendantOf(candidate, session.id, byId)
        || (session.id === rootSessionId(session) && rootSessionId(candidate) === session.id)
      ));
      const status = members
        .map((member) => getStatus(member))
        .reduce(preferSessionStatus);
      return { ...status, id: session.id, title: session.title };
    });
}

function preferSessionStatus(current, candidate) {
  const runningBlockedPair = new Set([current.state, candidate.state]);
  if (runningBlockedPair.has('running') && runningBlockedPair.has('blocked')) {
    const currentTime = Date.parse(current.updatedAt);
    const candidateTime = Date.parse(candidate.updatedAt);
    if (Number.isFinite(currentTime) && Number.isFinite(candidateTime) && currentTime !== candidateTime) {
      return candidateTime > currentTime ? candidate : current;
    }
  }
  return statusPriority(candidate.state) > statusPriority(current.state) ? candidate : current;
}

function statusPriority(state) {
  return {
    running: 3,
    blocked: 2,
    unknown: 1,
    completed: 0,
  }[state] ?? 0;
}

function readTail(filePath, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  let text = buffer.toString('utf8');
  if (stat.size > length) text = text.slice(text.indexOf('\n') + 1);
  return { text, mtimeMs: stat.mtimeMs, truncated: stat.size > length };
}

function sessionCwd(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const match = buffer.subarray(0, length).toString('utf8').match(/"cwd":("(?:\\.|[^"\\])*")/);
    return match ? JSON.parse(match[1]) : null;
  } finally {
    fs.closeSync(fd);
  }
}

function usefulMessage(payload) {
  const value = payload.message || payload.text || payload.reason || payload.error;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.message === 'string') {
    return value.message.trim();
  }
  return '';
}

function inferStatusDetails(
  text, mtimeMs, now = Date.now(), _timeoutMs = 3 * 60 * 1000, truncated = false,
) {
  let lastStarted = -1;
  let lastCompleted = -1;
  let lastError = -1;
  let lastProgress = -1;
  let turnId = null;
  let completionMessage = '';
  let latestWorkMessage = '';
  let errorMessage = '';
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const payload = record.payload || {};
    if (
      typeof payload.turn_id === 'string'
      && (
        record.type === 'turn_context'
        || (
          record.type === 'event_msg'
          && ['task_started', 'task_complete', 'task_failed', 'turn_aborted'].includes(payload.type)
        )
      )
    ) {
      turnId = payload.turn_id;
    }
    if (
      (record.type === 'event_msg' && (payload.type === 'agent_reasoning' || payload.type === 'agent_message')) ||
      (record.type === 'response_item' && ['reasoning', 'message', 'custom_tool_call'].includes(payload.type))
    ) {
      lastProgress = index;
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') lastStarted = index;
    if (record.type === 'event_msg' && payload.type === 'task_complete') {
      lastCompleted = index;
      completionMessage = usefulMessage({ message: payload.last_agent_message }) || completionMessage;
      if (payload.error) {
        lastError = index;
        errorMessage = usefulMessage({ error: payload.error }) || 'Codex 执行失败';
      }
    }
    if (record.type === 'event_msg' && TERMINAL_ERROR_EVENTS.has(payload.type)) {
      lastError = index;
      errorMessage = usefulMessage(payload) || 'Codex 会话受阻';
    }
    if (
      (record.type === 'event_msg' && payload.type === 'agent_message' && payload.phase === 'final_answer') ||
      (record.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer')
    ) {
      completionMessage = usefulMessage(payload) || completionMessage;
    }
    if (record.type === 'event_msg' && payload.type === 'agent_message') {
      latestWorkMessage = usefulMessage(payload) || latestWorkMessage;
    }
  }

  if (lastError > lastStarted && lastError >= lastCompleted) {
    return { value: { state: 'blocked', message: errorMessage }, turnId };
  }
  if (lastStarted > lastCompleted) {
    return { value: { state: 'running', message: latestWorkMessage || 'Codex 正在处理' }, turnId };
  }
  if (truncated && lastStarted < 0 && lastCompleted < 0 && lastProgress >= 0) {
    return { value: { state: 'running', message: latestWorkMessage || 'Codex 正在处理' }, turnId };
  }
  if (lastCompleted >= 0) {
    return { value: { state: 'completed', message: completionMessage || 'Codex 已完成任务' }, turnId };
  }
  return { value: { state: 'completed', message: '会话当前空闲' }, turnId };
}

function inferStatus(text, mtimeMs, now = Date.now(), timeoutMs = 3 * 60 * 1000, truncated = false) {
  return inferStatusDetails(text, mtimeMs, now, timeoutMs, truncated).value;
}

function applyOfficialTurnStatus(value, threadId, turnId, statuses) {
  const official = statuses?.get?.(threadId);
  if (!turnId || !official || official.id !== turnId) return value;
  if (official.status === 'inProgress') {
    return {
      ...value,
      state: 'running',
      message: value.state === 'running' ? value.message : 'Codex 正在处理',
    };
  }
  if (official.status === 'interrupted') {
    return {
      ...value,
      state: 'completed',
      message: value.state === 'running' && value.message !== 'Codex 正在处理'
        ? value.message
        : 'Codex 已停止',
    };
  }
  if (official.status === 'completed') {
    return {
      ...value,
      state: 'completed',
      message: value.state === 'running' && value.message !== 'Codex 正在处理'
        ? value.message
        : 'Codex 已完成任务',
    };
  }
  if (official.status === 'failed') {
    return {
      ...value,
      state: 'blocked',
      message: usefulMessage({ error: official.error }) || 'Codex 执行失败',
    };
  }
  return value;
}

function applyStatusMetadata(value, threadId, turnId, options) {
  const reconciled = applyOfficialTurnStatus(value, threadId, turnId, options.turnStatuses);
  return applyGoalStatus(reconciled, threadId, options.home, options.goalStatuses);
}

function sessionStatus(session, options = {}) {
  try {
    const stat = fs.statSync(session.rolloutPath);
    const cached = statusCache.get(session.rolloutPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return applyStatusMetadata(cached.value, session.id, cached.turnId, options);
    }
    const { text, mtimeMs, truncated } = readTail(session.rolloutPath, 4 * 1024 * 1024);
    const inferred = inferStatusDetails(text, mtimeMs, options.now, options.timeoutMs, truncated);
    const visible = extractEvidenceImages(inferred.value.message, session.id);
    const latestEvidence = latestEvidenceImages(text, session.id);
    const evidence = latestEvidence == null ? visible.evidence : latestEvidence;
    const value = {
      id: session.id,
      title: session.title,
      updatedAt: new Date(mtimeMs).toISOString(),
      ...inferred.value,
      message: visible.message,
      ...(evidence.length ? { evidence } : {}),
    };
    statusCache.set(session.rolloutPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value,
      turnId: inferred.turnId,
    });
    return applyStatusMetadata(value, session.id, inferred.turnId, options);
  } catch (error) {
    return {
      id: session.id,
      title: session.title,
      updatedAt: new Date().toISOString(),
      state: 'unknown',
      message: `会话状态未知：${error.message}`,
    };
  }
}

module.exports = {
  activateEvidence,
  aggregateSessionStatuses,
  canonicalSessions,
  codexHome,
  evidenceFile,
  extractEvidenceImages,
  inferStatus,
  applyGoalStatus,
  applyThreadNames,
  goalStatusRecord,
  goalStatuses,
  listSessions,
  normalizeSelectedSessionIds,
  officialTurnCandidateIds,
  parseSessionIndex,
  readTail,
  resolveSessionHierarchy,
  sessionCwd,
  sessionStatus,
};
