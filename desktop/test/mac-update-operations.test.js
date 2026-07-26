const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertMutableUpdatePath,
  createMacUpdateOperations,
  waitForProcessExit,
} = require('../src/lib/mac-update-operations');

test('Mac updater deletes only the exact install path or its hidden transaction siblings', () => {
  assert.doesNotThrow(() => assertMutableUpdatePath('/Applications/Codex Monitor.app'));
  assert.doesNotThrow(
    () => assertMutableUpdatePath('/Applications/.Codex Monitor.update-1234abcd.app'),
  );
  assert.doesNotThrow(
    () => assertMutableUpdatePath('/Applications/.Codex Monitor.rollback-1234abcd.app'),
  );
  assert.throws(() => assertMutableUpdatePath('/Applications'), /不安全/);
  assert.throws(() => assertMutableUpdatePath('/Applications/Other.app'), /不安全/);
  assert.throws(() => assertMutableUpdatePath('/'), /不安全/);
});

test('default Mac update operations copy with ditto, verify, launch and remove guarded paths', async () => {
  const commands = [];
  const removed = [];
  const verified = [];
  const operations = createMacUpdateOperations({
    expectedMachineId: 'mac-1',
    execFileImpl: async (command, args) => commands.push([command, args]),
    fsImpl: {
      access: async () => {},
      rename: async () => {},
      rm: async (target, options) => removed.push([target, options]),
    },
    verifyCandidateImpl: async (value) => verified.push(value),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, id: 'mac-1' }),
    }),
    sleepImpl: async () => {},
  });

  assert.equal(await operations.exists('/Applications/Codex Monitor.app'), true);
  await operations.verifyCandidate('/Applications/Codex Monitor.app', '/Volumes/CodexMonitorBuild/candidate.app');
  await operations.copyBundle('/Volumes/CodexMonitorBuild/candidate.app', '/Applications/.Codex Monitor.update-1234abcd.app');
  await operations.launchApp('/Applications/Codex Monitor.app');
  await operations.waitForHealth();
  await operations.removeBundle('/Applications/.Codex Monitor.rollback-1234abcd.app');

  assert.deepEqual(verified, [{
    installedAppPath: '/Applications/Codex Monitor.app',
    candidateAppPath: '/Volumes/CodexMonitorBuild/candidate.app',
  }]);
  assert.deepEqual(commands, [
    [
      '/usr/bin/ditto',
      [
        '--rsrc',
        '--extattr',
        '--acl',
        '/Volumes/CodexMonitorBuild/candidate.app',
        '/Applications/.Codex Monitor.update-1234abcd.app',
      ],
    ],
    ['/usr/bin/open', ['-n', '/Applications/Codex Monitor.app']],
  ]);
  assert.deepEqual(removed, [[
    '/Applications/.Codex Monitor.rollback-1234abcd.app',
    { recursive: true, force: true },
  ]]);
});

test('health confirmation rejects another machine even when HTTP is 200', async () => {
  const operations = createMacUpdateOperations({
    expectedMachineId: 'expected-mac',
    execFileImpl: async () => {},
    fsImpl: { access: async () => {}, rename: async () => {}, rm: async () => {} },
    verifyCandidateImpl: async () => {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ ok: true, id: 'wrong-mac' }),
    }),
    sleepImpl: async () => {},
    healthAttempts: 2,
  });

  await assert.rejects(operations.waitForHealth(), /健康检查未确认目标设备/);
});

test('helper waits for the exact old PID and times out without killing it', async () => {
  let checks = 0;
  await assert.doesNotReject(waitForProcessExit(1234, {
    attempts: 3,
    processAliveImpl: () => {
      checks += 1;
      return checks < 3;
    },
    sleepImpl: async () => {},
  }));
  await assert.rejects(
    waitForProcessExit(1234, {
      attempts: 2,
      processAliveImpl: () => true,
      sleepImpl: async () => {},
    }),
    /仍未退出/,
  );
});
