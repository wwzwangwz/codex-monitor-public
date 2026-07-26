const assert = require('node:assert/strict');
const test = require('node:test');
const {
  macUpdatePaths,
  runMacUpdateTransaction,
} = require('../src/lib/mac-update-transaction');

const installed = '/Applications/Codex Monitor.app';
const candidate = '/Volumes/CodexMonitorBuild/CodexMonitorBuild/Desktop/candidate/Codex Monitor.app';
const transactionId = '1234abcd';

function fakeOperations({ healthError = null, cleanupError = null } = {}) {
  const paths = macUpdatePaths({ installedAppPath: installed, candidateAppPath: candidate, transactionId });
  const existing = new Set([installed, candidate]);
  const events = [];
  return {
    paths,
    existing,
    events,
    operations: {
      exists: async (value) => existing.has(value),
      verifyCandidate: async (oldPath, newPath) => events.push(['verify', oldPath, newPath]),
      copyBundle: async (source, target) => {
        events.push(['copy', source, target]);
        existing.add(target);
      },
      rename: async (source, target) => {
        events.push(['rename', source, target]);
        assert.equal(existing.delete(source), true);
        existing.add(target);
      },
      removeBundle: async (target) => {
        events.push(['remove', target]);
        if (cleanupError && target === paths.rollbackAppPath) throw cleanupError;
        existing.delete(target);
      },
      launchApp: async (target) => events.push(['launch', target]),
      waitForHealth: async () => {
        events.push(['health']);
        if (healthError) throw healthError;
      },
    },
  };
}

test('Mac update transaction accepts only the fixed app and a Mac512 candidate', () => {
  assert.throws(
    () => macUpdatePaths({
      installedAppPath: '/Applications/Other.app',
      candidateAppPath: candidate,
      transactionId,
    }),
    /唯一安装路径/,
  );
  assert.throws(
    () => macUpdatePaths({
      installedAppPath: installed,
      candidateAppPath: '/tmp/Codex Monitor.app',
      transactionId,
    }),
    /Mac512/,
  );
  assert.deepEqual(
    macUpdatePaths({ installedAppPath: installed, candidateAppPath: candidate, transactionId }),
    {
      installedAppPath: installed,
      candidateAppPath: candidate,
      stagedAppPath: '/Applications/.Codex Monitor.update-1234abcd.app',
      rollbackAppPath: '/Applications/.Codex Monitor.rollback-1234abcd.app',
    },
  );
});

test('healthy candidate replaces in place and removes the renamed rollback bundle', async () => {
  const fixture = fakeOperations();

  const result = await runMacUpdateTransaction({
    installedAppPath: installed,
    candidateAppPath: candidate,
    transactionId,
    operations: fixture.operations,
  });

  assert.deepEqual(result, { ok: true, cleanupPending: false });
  assert.equal(fixture.existing.has(installed), true);
  assert.equal(fixture.existing.has(candidate), true);
  assert.equal(fixture.existing.has(fixture.paths.stagedAppPath), false);
  assert.equal(fixture.existing.has(fixture.paths.rollbackAppPath), false);
  assert.deepEqual(fixture.events, [
    ['verify', installed, candidate],
    ['copy', candidate, fixture.paths.stagedAppPath],
    ['verify', installed, fixture.paths.stagedAppPath],
    ['rename', installed, fixture.paths.rollbackAppPath],
    ['rename', fixture.paths.stagedAppPath, installed],
    ['launch', installed],
    ['health'],
    ['remove', fixture.paths.rollbackAppPath],
  ]);
});

test('failed launch health restores the old app instead of leaving the candidate installed', async () => {
  const fixture = fakeOperations({ healthError: new Error('health timeout') });

  await assert.rejects(
    runMacUpdateTransaction({
      installedAppPath: installed,
      candidateAppPath: candidate,
      transactionId,
      operations: fixture.operations,
    }),
    /已恢复旧版本.*health timeout/,
  );

  assert.equal(fixture.existing.has(installed), true);
  assert.equal(fixture.existing.has(candidate), true);
  assert.equal(fixture.existing.has(fixture.paths.stagedAppPath), false);
  assert.equal(fixture.existing.has(fixture.paths.rollbackAppPath), false);
  assert.deepEqual(fixture.events.slice(-4), [
    ['remove', installed],
    ['rename', fixture.paths.rollbackAppPath, installed],
    ['launch', installed],
    ['remove', fixture.paths.stagedAppPath],
  ]);
});

test('rollback cleanup failure keeps the healthy new app and reports deferred cleanup', async () => {
  const fixture = fakeOperations({ cleanupError: new Error('busy') });

  const result = await runMacUpdateTransaction({
    installedAppPath: installed,
    candidateAppPath: candidate,
    transactionId,
    operations: fixture.operations,
  });

  assert.deepEqual(result, { ok: true, cleanupPending: true });
  assert.equal(fixture.existing.has(installed), true);
  assert.equal(fixture.existing.has(fixture.paths.rollbackAppPath), true);
});
