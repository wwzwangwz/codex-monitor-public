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
let goalCache = { path: null, signature: '', values: new Map() };
const evidenceFiles = new Map();
let activeEvidenceIds = new Set();
const EVIDENCE_TYPES = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
]);
const LOCAL_IMAGE_MARKDOWN = /!\[[^\]]*\]\(\s*<?(?:file:\/\/\/|\/)/;

function localImagePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('file://')) return decodeURIComponent(new URL(raw).pathname);
  } catch {
    return null;
  }
  return path.isAbsolute(raw) ? decodeURIComponent(raw) : null;
}

function extractEvidenceImages(message, threadId) {
  const evidence = [];
  const ids = new Set();
  let removedLocalImage = false;
  const imagePattern = /!\[[^\]]*\]\(\s*<?(file:\/\/\/[^)>\n]+|\/[^)>\n]+)>?\s*\)/g;
  const cleanMessage = String(message || '').replace(imagePattern, (markdown, reference) => {
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
  };
}

function evidenceFromStatusText(text, threadId) {
  let found = false;
  let value = { message: '', evidence: [] };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record.payload || {};
    if (record.type !== 'event_msg' || payload.type !== 'agent_message') continue;
    const message = usefulMessage(payload);
    if (!LOCAL_IMAGE_MARKDOWN.test(message)) continue;
    found = true;
    value = extractEvidenceImages(message, threadId);
  }
  return { found, evidence: value.evidence };
}

function readLatestEvidence(filePath, threadId, maxScanBytes = 32 * 1024 * 1024, chunkBytes = 512 * 1024, maxLineBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  let position = stat.size;
  let scanned = 0;
  let partial = '';
  let skippingOversizedLine = false;
  try {
    while (position > 0 && scanned < maxScanBytes) {
      const length = Math.min(chunkBytes, position, maxScanBytes - scanned);
      const start = position - length;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let segment = buffer.toString('utf8');
      scanned += length;
      position = start;
      if (skippingOversizedLine) {
        const boundary = segment.lastIndexOf('\n');
        if (boundary < 0) continue;
        segment = segment.slice(0, boundary + 1);
        skippingOversizedLine = false;
      }
      const lines = (segment + partial).split(/\r?\n/);
      partial = position > 0 ? lines.shift() || '' : '';
      if (Buffer.byteLength(partial) > maxLineBytes) {
        partial = '';
        skippingOversizedLine = true;
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.trim() || Buffer.byteLength(line) > maxLineBytes) continue;
        const latest = evidenceFromStatusText(line, threadId);
        if (latest.found) return latest.evidence;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return [];
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

function goalDatabaseSignature(databasePath, statSync = fs.statSync, existsSync = fs.existsSync) {
  return [databasePath, `${databasePath}-wal`].map((candidate) => {
    if (!existsSync(candidate)) return `${candidate}:missing`;
    const stat = statSync(candidate);
    return `${candidate}:${stat.mtimeMs}:${stat.size}`;
  }).join('|');
}

function goalStatuses(home = codexHome()) {
  const candidates = [path.join(home, 'goals_1.sqlite'), path.join(home, 'sqlite', 'goals_1.sqlite')];
  const databasePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!databasePath) return new Map();
  try {
    const signature = goalDatabaseSignature(databasePath);
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
    goal: { status: normalizedStatus, objective: String(goal.objective || '') },
  };
  // Goal rows can retain an older blocked state after work resumes. A live
  // turn is authoritative and must stay green until execution actually stops.
  if (value.state === 'running') return withGoal;
  const blockedLabels = {
    blocked: '目标已阻塞',
    usage_limited: '目标因用量限制而阻塞',
    budget_limited: '目标因预算限制而阻塞',
  };
  if (blockedLabels[goal.status]) {
    return { ...withGoal, state: 'blocked', message: blockedLabels[goal.status] };
  }
  return withGoal;
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

function listSessions(home = codexHome()) {
  const indexPath = path.join(home, 'session_index.jsonl');
  const index = fs.existsSync(indexPath)
    ? parseSessionIndex(fs.readFileSync(indexPath, 'utf8'))
    : new Map();
  const rollouts = walkRollouts(path.join(home, 'sessions'));

  return [...index.values()]
    .map((item) => ({
      id: item.id,
      title: item.thread_name || '未命名会话',
      updatedAt: item.updated_at || null,
      rolloutPath: rollouts.get(item.id) || null,
    }))
    .filter((item) => item.rolloutPath)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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

function statusRecord(record) {
  const type = record?.payload?.type;
  return record?.type === 'event_msg' && (
    type === 'task_started' || type === 'task_complete' ||
    TERMINAL_ERROR_EVENTS.has(type) || type === 'agent_message'
  );
}

function readRecentStatusText(filePath, maxScanBytes = 128 * 1024 * 1024, chunkBytes = 512 * 1024, maxLineBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  let position = stat.size;
  let scanned = 0;
  let partial = '';
  let skippingOversizedLine = false;
  const records = [];
  let foundDecisive = false;
  try {
    while (position > 0 && scanned < maxScanBytes && !foundDecisive) {
      const length = Math.min(chunkBytes, position, maxScanBytes - scanned);
      const start = position - length;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      let segment = buffer.toString('utf8');
      scanned += length;
      position = start;
      if (skippingOversizedLine) {
        const boundary = segment.lastIndexOf('\n');
        if (boundary < 0) continue;
        segment = segment.slice(0, boundary + 1);
        skippingOversizedLine = false;
      }
      const lines = (segment + partial).split(/\r?\n/);
      partial = position > 0 ? lines.shift() || '' : '';
      if (Buffer.byteLength(partial) > maxLineBytes) {
        partial = '';
        skippingOversizedLine = true;
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.trim() || Buffer.byteLength(line) > maxLineBytes) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!statusRecord(record)) continue;
        records.push(record);
        const type = record.payload?.type;
        if (type === 'task_started' || type === 'task_complete' || TERMINAL_ERROR_EVENTS.has(type)) {
          foundDecisive = true;
          break;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { text: records.reverse().map((record) => JSON.stringify(record)).join('\n'), truncated: position > 0 };
}

function cachedStatusPrefix(value) {
  if (value.state === 'running') return [
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: value.message } }),
  ].join('\n');
  if (value.state === 'blocked') return JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: value.message } });
  return JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: value.message } });
}

function readAppendedStatusText(filePath, start, maxLineBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const records = [];
  let position = start;
  let partial = '';
  let skippingOversizedLine = false;
  try {
    while (position < stat.size) {
      const length = Math.min(512 * 1024, stat.size - position);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, position);
      position += length;
      const lines = (partial + buffer.toString('utf8')).split(/\r?\n/);
      partial = lines.pop() || '';
      if (skippingOversizedLine) {
        if (lines.length === 0) {
          partial = '';
          continue;
        }
        lines.shift();
        skippingOversizedLine = false;
      }
      for (const line of lines) {
        if (!line.trim() || Buffer.byteLength(line) > maxLineBytes) continue;
        try {
          const record = JSON.parse(line);
          if (statusRecord(record)) records.push(record);
        } catch {
          // Ignore concurrently appended or irrelevant records.
        }
      }
      if (Buffer.byteLength(partial) > maxLineBytes) {
        partial = '';
        skippingOversizedLine = true;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return records.map((record) => JSON.stringify(record)).join('\n');
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
  if (value && typeof value.message === 'string') return value.message.trim();
  return '';
}

function inferStatus(text, mtimeMs, now = Date.now(), _timeoutMs = 3 * 60 * 1000, truncated = false) {
  let lastStarted = -1;
  let lastCompleted = -1;
  let lastError = -1;
  let lastProgress = -1;
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
    return { state: 'blocked', message: errorMessage };
  }
  if (lastStarted > lastCompleted) {
    return { state: 'running', message: latestWorkMessage || 'Codex 正在处理' };
  }
  if (truncated && lastStarted < 0 && lastCompleted < 0 && lastProgress >= 0) {
    return { state: 'running', message: latestWorkMessage || 'Codex 正在处理' };
  }
  if (lastCompleted >= 0) {
    return { state: 'completed', message: completionMessage || 'Codex 已完成任务' };
  }
  return { state: 'completed', message: '会话当前空闲' };
}

function sessionStatus(session, options = {}) {
  try {
    const stat = fs.statSync(session.rolloutPath);
    const cached = statusCache.get(session.rolloutPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return applyGoalStatus(cached.value, session.id, options.home);
    }
    let text;
    let truncated;
    let evidence;
    if (cached && stat.size > cached.size) {
      const appended = readAppendedStatusText(session.rolloutPath, cached.size);
      if (!appended) {
        statusCache.set(session.rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, value: cached.value });
        return applyGoalStatus(cached.value, session.id, options.home);
      }
      const appendedEvidence = evidenceFromStatusText(appended, session.id);
      evidence = appendedEvidence.found ? appendedEvidence.evidence : cached.value.evidence;
      text = [cachedStatusPrefix(cached.value), appended]
        .filter(Boolean).join('\n');
      truncated = true;
    } else {
      const recent = readRecentStatusText(session.rolloutPath);
      text = recent.text;
      truncated = recent.truncated;
      evidence = readLatestEvidence(session.rolloutPath, session.id);
    }
    const inferred = inferStatus(text, stat.mtimeMs, options.now, options.timeoutMs, truncated);
    const visible = extractEvidenceImages(inferred.message, session.id);
    if (visible.evidence.length) evidence = visible.evidence;
    const value = {
      id: session.id,
      title: session.title,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      ...inferred,
      message: visible.message,
      ...(evidence?.length ? { evidence } : {}),
    };
    statusCache.set(session.rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return applyGoalStatus(value, session.id, options.home);
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
  codexHome,
  inferStatus,
  extractEvidenceImages,
  evidenceFromStatusText,
  activateEvidence,
  evidenceFile,
  applyGoalStatus,
  goalStatuses,
  goalDatabaseSignature,
  listSessions,
  parseSessionIndex,
  readAppendedStatusText,
  readRecentStatusText,
  readTail,
  sessionCwd,
  sessionStatus,
};
