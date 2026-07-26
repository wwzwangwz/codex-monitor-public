const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  retainGuidanceAttachments,
  stageGuidanceAttachments,
} = require('./attachments');
const { waitForRolloutReceipt } = require('./native-guidance');

const APP_SERVER_RECEIPT_TIMEOUT_MS = 30_000;

function defaultCodexPath({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
  isAccessible = (candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  if (env.CODEX_CLI_PATH) return env.CODEX_CLI_PATH;
  if (platform === 'win32') {
    const codexHome = env.CODEX_HOME || path.win32.join(homedir, '.codex');
    const pluginCli = path.win32.join(codexHome, 'plugins', '.plugin-appserver', 'codex.exe');
    if (isAccessible(pluginCli)) return pluginCli;
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local');
    const userLocal = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (isAccessible(userLocal)) return userLocal;
    return 'codex';
  }
  return path.join(homedir, '.local', 'bin', 'codex');
}

class AppServerClient {
  constructor({ spawnProcess = spawn, command = defaultCodexPath(), timeoutMs = 10_000 } = {}) {
    this.spawnProcess = spawnProcess;
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child = null;
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const child = this.spawnProcess(
        this.command,
        ['--enable', 'goals', 'app-server', '--listen', 'stdio://'],
        {
          stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
        },
      );
      this.child = child;
      this.buffer = '';
      this.stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (this.child === child) this.onData(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (this.child === child) this.stderr = (this.stderr + chunk).slice(-2000);
      });
      child.once('error', (error) => this.failAll(error, child));
      child.once('exit', (code) => this.failAll(
        new Error(`Codex app-server exited (${code ?? 'unknown'})`), child,
      ));
      await this.rawRequest('initialize', {
        clientInfo: { name: 'codex-monitor', title: 'Codex Monitor', version: '0.8.1' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
    })();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.id == null) continue;
      const pending = this.pending.get(String(value.id));
      if (!pending) continue;
      this.pending.delete(String(value.id));
      clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(value.error.message || 'Codex app-server request failed'));
      else pending.resolve(value.result);
    }
  }

  failAll(error, child = this.child, kill = false) {
    if (child && this.child !== child) return;
    const detail = this.stderr.trim();
    const failure = detail ? new Error(`${error.message}: ${detail.slice(-500)}`) : error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
    const activeChild = this.child;
    this.child = null;
    this.startPromise = null;
    this.buffer = '';
    if (kill) {
      try { activeChild?.kill(); } catch { /* Process may already be gone. */ }
    }
  }

  write(value) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server is not connected');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  rawRequest(method, params) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error(`Codex app-server ${method} timed out`), this.child, true);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id: Number(id), method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  async request(method, params) {
    await this.start();
    return this.rawRequest(method, params);
  }

  close() {
    this.failAll(new Error('Codex app-server closed'), this.child, true);
  }
}

function normalizeGoalRecord(goal) {
  const status = {
    usageLimited: 'usage_limited',
    budgetLimited: 'budget_limited',
  }[goal?.status] || goal?.status;
  const rawUpdatedAt = Number(goal?.updatedAt ?? goal?.updated_at_ms);
  const updatedAtMs = Number.isFinite(rawUpdatedAt) && rawUpdatedAt > 0
    ? (rawUpdatedAt < 1_000_000_000_000 ? rawUpdatedAt * 1000 : rawUpdatedAt)
    : undefined;
  return {
    status,
    objective: String(goal?.objective || ''),
    ...(updatedAtMs == null ? {} : { updated_at_ms: updatedAtMs }),
  };
}

function createAppServerGoalStore(options = {}) {
  const client = options.client || new AppServerClient(options);
  let statuses = new Map();
  let refreshing = null;

  const refresh = (sessionIds) => {
    if (refreshing) return refreshing;
    const ids = [...new Set(sessionIds || [])];
    const previous = statuses;
    refreshing = Promise.all(ids.map(async (threadId) => {
      try {
        const result = await client.request('thread/goal/get', { threadId });
        return result?.goal ? [threadId, normalizeGoalRecord(result.goal)] : null;
      } catch {
        return previous.has(threadId) ? [threadId, previous.get(threadId)] : null;
      }
    })).then((entries) => {
      statuses = new Map(entries.filter(Boolean));
      return statuses;
    }).finally(() => { refreshing = null; });
    return refreshing;
  };

  return {
    current: () => statuses,
    refresh,
  };
}

function createAppServerThreadStore(options = {}) {
  const client = options.client || new AppServerClient(options);
  let names = new Map();
  let refreshing = null;

  const refresh = (sessionIds) => {
    if (refreshing) return refreshing;
    const ids = [...new Set(sessionIds || [])];
    const previous = names;
    refreshing = Promise.all(ids.map(async (threadId) => {
      try {
        const result = await client.request('thread/read', { threadId, includeTurns: false });
        const name = String(result?.thread?.name || '').trim();
        return name ? [threadId, name] : null;
      } catch {
        return previous.has(threadId) ? [threadId, previous.get(threadId)] : null;
      }
    })).then((entries) => {
      names = new Map(entries.filter(Boolean));
      return names;
    }).finally(() => { refreshing = null; });
    return refreshing;
  };

  return {
    current: () => names,
    refresh,
  };
}

function createAppServerGuidanceSender(options = {}) {
  const client = options.client || new AppServerClient(options);
  const waitForReceipt = options.waitForReceipt || waitForRolloutReceipt;
  const stageAttachments = options.stageAttachments || stageGuidanceAttachments;
  const retainAttachments = options.retainAttachments || retainGuidanceAttachments;
  return async ({ sessionId, text, mode, attachments = [], rolloutPath }) => {
    if (mode === 'queue') {
      throw new Error('The app-server fallback cannot safely queue');
    }
    let staged = { files: [], cleanup: () => {} };
    let submitted = false;
    try {
      staged = stageAttachments(attachments, { storageDirectory: options.attachmentDirectory });
      const start = rolloutPath ? require('node:fs').statSync(rolloutPath).size : 0;
      const resumed = await client.request('thread/resume', { threadId: sessionId });
      const turns = Array.isArray(resumed?.thread?.turns) ? resumed.thread.turns : [];
      const activeTurn = turns.findLast((turn) => turn?.status === 'inProgress');
      const input = [
        ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
        ...staged.files.map((file) => ({ type: 'localImage', path: file.path })),
      ];
      if (activeTurn) {
        await client.request('turn/steer', {
          threadId: sessionId,
          expectedTurnId: activeTurn.id,
          input,
        });
      } else {
        await client.request('turn/start', { threadId: sessionId, input });
      }
      const hasReceipt = !rolloutPath || await waitForReceipt(
        rolloutPath, start, text, staged.files.map((file) => file.path), APP_SERVER_RECEIPT_TIMEOUT_MS,
      );
      if (!hasReceipt) throw new Error('The app-server accepted the request but the target rollout has no receipt');
      submitted = true;
      if (staged.files.length) retainAttachments(staged, { sessionId });
      return {
        ok: true,
        message: activeTurn
          ? '已通过 Codex app-server 备用通道引导当前运行（Steer）'
          : '已通过 Codex app-server 备用通道继续该会话',
      };
    } finally {
      if (!submitted || !staged.files.length) staged.cleanup();
    }
  };
}

function createAppServerGoalCommander(options = {}) {
  const client = options.client || new AppServerClient(options);
  const resumeThread = options.resumeThread;
  return async ({
    sessionId,
    command,
    sessionTitle = '',
    sessionState = 'unknown',
    confirmed = false,
  }) => {
    if (command === 'resume') {
      const currentGoal = await client.request('thread/goal/get', { threadId: sessionId });
      const goalStatus = currentGoal?.goal?.status;
      const continuableStatuses = new Set([
        'active',
        'paused',
        'blocked',
        'usageLimited',
        'budgetLimited',
      ]);
      if (!continuableStatuses.has(goalStatus)) {
        throw new Error(`Goal status ${goalStatus || 'missing'} cannot be resumed`);
      }
      if (!['running', 'completed', 'blocked'].includes(sessionState)) {
        throw new Error('The authoritative session turn state is unavailable');
      }
      const running = sessionState === 'running';
      if (running && goalStatus !== 'paused') {
        throw new Error('The selected session turn is still running');
      }
      const changedStatus = goalStatus !== 'active';
      if (changedStatus) {
        const restored = await client.request('thread/goal/set', {
          threadId: sessionId,
          status: 'active',
        });
        if (restored?.goal?.status !== 'active') {
          throw new Error('Codex app-server did not confirm Goal resume');
        }
      }
      if (running) {
        return {
          ok: true,
          message: 'The paused Goal is active again and its current turn is still running',
        };
      }
      try {
        if (typeof resumeThread !== 'function') {
          throw new Error('The native Goal continuation channel is not configured');
        }
        const delivery = await resumeThread({
          sessionId,
          sessionTitle,
          text: 'Continue the current Goal. Locate and address the real blocker; do not stop any work still in progress. Continue only in this thread, do not create or forward to another thread, and do not invoke any CLI resume command.',
          mode: 'steer',
          attachments: [],
        });
        if (!delivery?.ok) {
          throw new Error(delivery?.message || 'Codex did not confirm the Goal continuation');
        }
      } catch (error) {
        if (changedStatus) {
          await client.request('thread/goal/set', {
            threadId: sessionId,
            status: goalStatus,
          }).catch(() => {});
        }
        throw new Error(`Goal did not actually resume: ${error.message || error}`);
      }
      const verified = await client.request('thread/goal/get', { threadId: sessionId });
      if (verified?.goal?.status !== 'active') {
        throw new Error(`Goal continuation was delivered but its status is ${verified?.goal?.status || 'missing'}`);
      }
      return {
        ok: true,
        message: changedStatus
          ? 'The Goal was resumed and continued in the original session'
          : 'Goal continuation was delivered to the original session and remains active',
      };
    }
    if (!confirmed) throw new Error('Goal deletion requires confirmed: true');
    const result = await client.request('thread/goal/clear', { threadId: sessionId });
    if (result?.cleared !== true) throw new Error('Codex app-server did not confirm Goal deletion');
    return { ok: true, message: '已通过 Codex app-server 备用通道删除 Goal，会话仍保留' };
  };
}

module.exports = {
  AppServerClient,
  createAppServerGoalCommander,
  createAppServerGoalStore,
  createAppServerGuidanceSender,
  createAppServerThreadStore,
  defaultCodexPath,
};
