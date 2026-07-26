const { execFile } = require('node:child_process');
const http = require('node:http');

const CODEX_APP_PATH = '/Applications/ChatGPT.app';
const CODEX_EXECUTABLE = `${CODEX_APP_PATH}/Contents/MacOS/ChatGPT`;
const DEBUG_STATUS_URL = 'http://127.0.0.1:9229/json/version';

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultCheckEndpoint({
  endpoint = DEBUG_STATUS_URL,
  timeoutMs = 1_500,
} = {}) {
  return new Promise((resolve) => {
    const request = http.get(endpoint, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function defaultIsCodexRunning() {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    return stdout.split(/\r?\n/).some((line) => {
      const command = line.trim().replace(/^\d+\s+/, '');
      return command === CODEX_EXECUTABLE || command.startsWith(`${CODEX_EXECUTABLE} `);
    });
  } catch {
    return false;
  }
}

async function defaultQuitCodex() {
  await execFileAsync('/usr/bin/osascript', [
    '-e',
    'tell application id "com.openai.codex" to quit',
  ], { timeout: 10_000 });
}

async function defaultLaunchCodex() {
  await execFileAsync('/usr/bin/open', [
    '-a',
    CODEX_APP_PATH,
    '--args',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9229',
  ], { timeout: 10_000 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, expected, {
  delayImpl = delay,
  intervalMs,
  timeoutMs,
}) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let index = 0; index < attempts; index += 1) {
    if (Boolean(await check()) === expected) return true;
    await delayImpl(intervalMs);
  }
  return false;
}

function createNativeChannelController({
  platform = process.platform,
  checkEndpoint = defaultCheckEndpoint,
  isCodexRunning = defaultIsCodexRunning,
  quitCodex = defaultQuitCodex,
  launchCodex = defaultLaunchCodex,
  delayImpl = delay,
  exitTimeoutMs = 30_000,
  startTimeoutMs = 30_000,
  pollIntervalMs = 500,
} = {}) {
  let repairPromise = null;

  async function getStatus() {
    if (platform !== 'darwin') {
      return {
        available: false,
        ready: false,
        repairing: Boolean(repairPromise),
        message: '输入通道修复目前仅支持 Mac',
      };
    }
    const ready = await checkEndpoint();
    if (ready) {
      return {
        available: true,
        ready: true,
        running: true,
        repairing: Boolean(repairPromise),
        message: '原生输入通道已连接',
      };
    }
    const running = await isCodexRunning();
    return {
      available: true,
      ready: false,
      running,
      repairing: Boolean(repairPromise),
      message: running ? 'Codex 已运行，但输入通道未启用' : 'Codex 未运行',
    };
  }

  async function performRepair() {
    if (platform !== 'darwin') throw new Error('输入通道修复目前仅支持 Mac');
    if (await checkEndpoint()) {
      return { ok: true, message: '原生输入通道已经可用，无需重启' };
    }

    if (await isCodexRunning()) {
      await quitCodex();
      const exited = await waitFor(isCodexRunning, false, {
        delayImpl,
        intervalMs: pollIntervalMs,
        timeoutMs: exitTimeoutMs,
      });
      if (!exited) {
        throw new Error('Codex 未能正常退出，已停止修复；没有强制结束任何会话');
      }
    }

    await launchCodex();
    const ready = await waitFor(checkEndpoint, true, {
      delayImpl,
      intervalMs: pollIntervalMs,
      timeoutMs: startTimeoutMs,
    });
    if (!ready) {
      throw new Error('Codex 已启动，但原生输入通道没有开放；已停止操作，不会循环重启');
    }
    return { ok: true, message: '原生输入通道已恢复，可以从手机发送文字和图片' };
  }

  return {
    getStatus,
    repair() {
      if (repairPromise) return repairPromise;
      repairPromise = performRepair().finally(() => {
        repairPromise = null;
      });
      return repairPromise;
    },
  };
}

module.exports = {
  CODEX_APP_PATH,
  CODEX_EXECUTABLE,
  DEBUG_STATUS_URL,
  createNativeChannelController,
  defaultCheckEndpoint,
  defaultIsCodexRunning,
  waitFor,
};
