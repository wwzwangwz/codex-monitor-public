const path = require('node:path');

const INSTALLED_APP_PATH = '/Applications/Codex Monitor.app';
const MAC512_ROOT = '/Volumes/CodexMonitorBuild';

function normalizeAbsolute(value) {
  return path.resolve(String(value || ''));
}

function macUpdatePaths({
  installedAppPath,
  candidateAppPath,
  transactionId,
} = {}) {
  const installed = normalizeAbsolute(installedAppPath);
  const candidate = normalizeAbsolute(candidateAppPath);
  const id = String(transactionId || '').trim();

  if (installed !== INSTALLED_APP_PATH) {
    throw new Error(`Mac 更新只允许唯一安装路径：${INSTALLED_APP_PATH}`);
  }
  if (
    candidate === MAC512_ROOT
    || !candidate.startsWith(`${MAC512_ROOT}${path.sep}`)
    || !candidate.endsWith('.app')
  ) {
    throw new Error('Mac 更新候选包必须位于 Mac512 且必须是 .app');
  }
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    throw new Error('Mac 更新事务 ID 不合法');
  }

  const directory = path.dirname(installed);
  return {
    installedAppPath: installed,
    candidateAppPath: candidate,
    stagedAppPath: path.join(directory, `.Codex Monitor.update-${id}.app`),
    rollbackAppPath: path.join(directory, `.Codex Monitor.rollback-${id}.app`),
  };
}

function assertOperations(operations) {
  for (const name of [
    'exists',
    'verifyCandidate',
    'copyBundle',
    'rename',
    'removeBundle',
    'launchApp',
    'waitForHealth',
  ]) {
    if (typeof operations?.[name] !== 'function') {
      throw new Error(`Mac 更新缺少事务操作：${name}`);
    }
  }
}

async function runMacUpdateTransaction({
  installedAppPath,
  candidateAppPath,
  transactionId,
  operations,
} = {}) {
  const paths = macUpdatePaths({ installedAppPath, candidateAppPath, transactionId });
  assertOperations(operations);
  const {
    installedAppPath: installed,
    candidateAppPath: candidate,
    stagedAppPath: staged,
    rollbackAppPath: rollback,
  } = paths;

  if (!await operations.exists(installed)) throw new Error('Mac 已安装应用不存在');
  if (!await operations.exists(candidate)) throw new Error('Mac 更新候选包不存在');
  if (await operations.exists(staged) || await operations.exists(rollback)) {
    throw new Error('存在未清理的 Mac 更新事务，拒绝覆盖');
  }

  let oldAppRenamed = false;
  let candidateInstalled = false;
  try {
    // Verify before copying, then verify the exact bytes that will be installed.
    await operations.verifyCandidate(installed, candidate);
    await operations.copyBundle(candidate, staged);
    await operations.verifyCandidate(installed, staged);

    // Renaming the old app is the rollback snapshot; it does not duplicate it.
    await operations.rename(installed, rollback);
    oldAppRenamed = true;
    await operations.rename(staged, installed);
    candidateInstalled = true;
    await operations.launchApp(installed);
    await operations.waitForHealth();
  } catch (error) {
    let rollbackError = null;
    try {
      if (candidateInstalled && await operations.exists(installed)) {
        await operations.removeBundle(installed);
      }
      if (oldAppRenamed && await operations.exists(rollback)) {
        await operations.rename(rollback, installed);
        await operations.launchApp(installed);
      }
      await operations.removeBundle(staged);
    } catch (failure) {
      rollbackError = failure;
    }
    const detail = String(error?.message || error);
    if (rollbackError) {
      throw new Error(`Mac 更新失败且回滚未完成：${detail}；${rollbackError.message || rollbackError}`);
    }
    throw new Error(`Mac 更新失败，已恢复旧版本：${detail}`);
  }

  try {
    await operations.removeBundle(rollback);
    return { ok: true, cleanupPending: false };
  } catch {
    // The new app is already healthy. Keep the hidden renamed old bundle for
    // later cleanup instead of rolling a healthy installation back.
    return { ok: true, cleanupPending: true };
  }
}

module.exports = {
  INSTALLED_APP_PATH,
  MAC512_ROOT,
  macUpdatePaths,
  runMacUpdateTransaction,
};
