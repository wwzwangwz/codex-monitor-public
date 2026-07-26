const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function defaultCodexPath() {
  return process.env.CODEX_CLI_PATH || path.join(os.homedir(), '.local', 'bin', 'codex');
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
      const child = this.spawnProcess(this.command, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      this.child = child;
      this.buffer = '';
      this.stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onData(chunk));
      child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
      child.once('error', (error) => this.failAll(error, child));
      child.once('exit', (code) => this.failAll(new Error(`Codex app-server 已退出（${code ?? 'unknown'}）`), child));
      await this.rawRequest('initialize', {
        clientInfo: { name: 'codex-monitor', title: 'Codex Monitor', version: '0.10.3' },
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
      if (value.error) pending.reject(new Error(value.error.message || 'Codex app-server 请求失败'));
      else pending.resolve(value.result);
    }
  }

  failAll(error, child = this.child, kill = false) {
    if (child && this.child !== child) return;
    const detail = this.stderr.trim();
    const failure = detail ? new Error(`${error.message}：${detail.slice(-500)}`) : error;
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
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server 未连接');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  rawRequest(method, params) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failAll(new Error(`Codex app-server ${method} 超时`), this.child, true);
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
    this.failAll(new Error('Codex app-server 已关闭'), this.child, true);
  }
}

function createGoalController(options = {}) {
  const client = options.client || new AppServerClient(options);
  const resumeThread = options.resumeThread;
  return {
    async execute({ threadId, command, sessionState, sessionTitle = '', confirmed = false }) {
      if (!/^[0-9a-f-]{36}$/i.test(String(threadId || ''))) throw new Error('会话 ID 格式无效');
      if (!['resume', 'delete'].includes(command)) throw new Error('不支持的 Goal 操作');
      const response = await client.request('thread/goal/get', { threadId });
      const goal = response?.goal;
      if (!goal) throw new Error('该会话当前没有 Goal');
      if (command === 'resume') {
        const paused = goal.status === 'paused';
        if (sessionState === 'running' && !paused) throw new Error('会话仍在运行，不需要重启 Goal');
        if (!['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'].includes(goal.status)) {
          throw new Error(`当前 Goal 状态为 ${goal.status}，不能重启`);
        }
        const previousStatus = goal.status;
        const changedStatus = previousStatus !== 'active';
        if (changedStatus) {
          const result = await client.request('thread/goal/set', { threadId, status: 'active' });
          if (result?.goal?.status !== 'active') throw new Error('Codex 未确认 Goal 已恢复');
        }
        if (sessionState === 'running') {
          return { ok: true, message: 'Goal 已从暂停恢复，当前会话继续执行中' };
        }
        try {
          if (typeof resumeThread !== 'function') throw new Error('原生会话恢复通道未配置');
          const delivery = await resumeThread({
            sessionId: threadId,
            sessionTitle,
            text: '继续当前 Goal。先定位并处理真实阻塞；不要停止任何仍在进行的工作，只在当前会话内继续，不要创建或转发到其他会话，也不要使用 codex exec resume。若外部阻塞仍存在，继续可安全推进的本地工作，并返回精确错误和验证证据。',
            mode: 'steer',
            attachments: [],
          });
          if (!delivery?.ok) throw new Error(delivery?.message || 'Codex 未确认继续指令');
        } catch (error) {
          if (changedStatus) {
            await client.request('thread/goal/set', { threadId, status: previousStatus }).catch(() => {});
          }
          throw new Error(`Goal 未真正恢复：${error.message || error}`);
        }
        const verified = await client.request('thread/goal/get', { threadId });
        if (verified?.goal?.status !== 'active') {
          throw new Error(`继续指令已送达，但 Goal 当前状态为 ${verified?.goal?.status || 'unknown'}`);
        }
        return { ok: true, message: '继续指令已送达原会话，Goal 已恢复；等待会话实际执行确认' };
      }
      if (!confirmed) throw new Error('删除 Goal 需要在手机端二次确认');
      const result = await client.request('thread/goal/clear', { threadId });
      if (result?.cleared !== true) throw new Error('Codex 未确认 Goal 已删除');
      return { ok: true, message: 'Goal 已删除，会话和聊天记录仍保留' };
    },
    close: () => client.close(),
  };
}

module.exports = { AppServerClient, createGoalController, defaultCodexPath };
