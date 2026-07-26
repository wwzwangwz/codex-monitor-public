const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { verifyMacUpdateCandidate } = require('./mac-update-verifier');

const execFileAsync = promisify(execFile);
const INSTALLED_APP_PATH = '/Applications/Codex Monitor.app';
const TRANSACTION_PATH = /^\/Applications\/\.Codex Monitor\.(?:update|rollback)-[a-zA-Z0-9_-]{8,64}\.app$/;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertMutableUpdatePath(value) {
  const target = String(value || '');
  if (target !== INSTALLED_APP_PATH && !TRANSACTION_PATH.test(target)) {
    throw new Error(`不安全的 Mac 更新删除路径：${target || '(空)'}`);
  }
  return true;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessExit(pid, {
  attempts = 80,
  intervalMs = 250,
  processAliveImpl = processAlive,
  sleepImpl = sleep,
} = {}) {
  const normalizedPid = Number(pid);
  if (!Number.isSafeInteger(normalizedPid) || normalizedPid <= 0) {
    throw new Error('旧 Mac App PID 不合法');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processAliveImpl(normalizedPid)) return true;
    if (attempt + 1 < attempts) await sleepImpl(intervalMs);
  }
  throw new Error(`旧 Mac App 进程 ${normalizedPid} 仍未退出，拒绝替换`);
}

function createMacUpdateOperations({
  expectedMachineId,
  healthUrl = 'http://127.0.0.1:43117/health',
  healthAttempts = 40,
  healthIntervalMs = 500,
  execFileImpl = execFileAsync,
  fsImpl = fs.promises,
  verifyCandidateImpl = verifyMacUpdateCandidate,
  fetchImpl = global.fetch,
  sleepImpl = sleep,
} = {}) {
  const machineId = String(expectedMachineId || '').trim();
  if (!machineId) throw new Error('Mac 更新缺少待确认的设备 ID');

  return {
    exists: async (target) => {
      try {
        await fsImpl.access(target);
        return true;
      } catch {
        return false;
      }
    },
    verifyCandidate: (installedAppPath, candidateAppPath) => verifyCandidateImpl({
      installedAppPath,
      candidateAppPath,
    }),
    copyBundle: (source, target) => execFileImpl(
      '/usr/bin/ditto',
      ['--rsrc', '--extattr', '--acl', source, target],
    ),
    rename: (source, target) => fsImpl.rename(source, target),
    removeBundle: async (target) => {
      assertMutableUpdatePath(target);
      await fsImpl.rm(target, { recursive: true, force: true });
    },
    launchApp: (target) => execFileImpl('/usr/bin/open', ['-n', target]),
    waitForHealth: async () => {
      for (let attempt = 0; attempt < healthAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(healthUrl, { cache: 'no-store' });
          const value = response.ok ? await response.json() : null;
          if (value?.ok === true && value.id === machineId) return true;
        } catch {
          // The app is allowed a short startup window before rollback.
        }
        if (attempt + 1 < healthAttempts) await sleepImpl(healthIntervalMs);
      }
      throw new Error(`Mac 更新健康检查未确认目标设备 ${machineId}`);
    },
  };
}

module.exports = {
  assertMutableUpdatePath,
  createMacUpdateOperations,
  processAlive,
  waitForProcessExit,
};
