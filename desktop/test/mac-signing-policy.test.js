const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertUpdateBundleIdentity,
  assertUpdateIdentity,
  readDesignatedRequirement,
  resolveSigningPlan,
} = require('../src/lib/mac-signing-policy');

test('stable Mac releases reject missing or ad-hoc signing identities', () => {
  assert.throws(
    () => resolveSigningPlan({ channel: 'stable', identity: '' }),
    /固定签名身份/,
  );
  assert.throws(
    () => resolveSigningPlan({ channel: 'stable', identity: '-' }),
    /临时签名/,
  );
});

test('stable Mac releases use the explicit long-lived signing identity', () => {
  assert.deepEqual(
    resolveSigningPlan({ channel: 'stable', identity: 'Developer ID Application: Example (TEAMID)' }),
    {
      channel: 'stable',
      identity: 'Developer ID Application: Example (TEAMID)',
      adHoc: false,
    },
  );
});

test('development builds remain available without being publishable as stable', () => {
  assert.deepEqual(resolveSigningPlan({ channel: 'development', identity: '' }), {
    channel: 'development',
    identity: '-',
    adHoc: true,
  });
});

test('misspelled release channels cannot silently fall back to development', () => {
  assert.throws(
    () => resolveSigningPlan({ channel: 'stabel', identity: '' }),
    /未知发布通道/,
  );
});

test('in-place Mac updates require the exact same designated requirement', () => {
  const requirement = 'designated => identifier "com.codexmonitor.desktop" and certificate leaf = H"abc"';
  assert.doesNotThrow(() => assertUpdateIdentity({
    installedRequirement: requirement,
    candidateRequirement: requirement,
  }));
  assert.throws(
    () => assertUpdateIdentity({
      installedRequirement: requirement,
      candidateRequirement: 'designated => identifier "com.codexmonitor.desktop" and certificate leaf = H"def"',
    }),
    /签名身份不一致/,
  );
});

test('ad-hoc CDHash identities are never accepted for permission-preserving updates', () => {
  assert.throws(
    () => assertUpdateIdentity({
      installedRequirement: '# designated => cdhash H"1111111111111111111111111111111111111111"',
      candidateRequirement: '# designated => cdhash H"1111111111111111111111111111111111111111"',
    }),
    /临时签名/,
  );
});

test('reads the designated requirement from codesign stderr', () => {
  const requirement = 'designated => identifier "com.codexmonitor.desktop" and certificate leaf = H"abc"';
  const fakeSpawn = (command, args) => {
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args, ['-d', '-r-', '/Applications/Codex Monitor.app']);
    return {
      status: 0,
      stdout: '',
      stderr: `Executable=/Applications/Codex Monitor.app/Contents/MacOS/Codex Monitor\n${requirement}\n`,
    };
  };

  assert.equal(
    readDesignatedRequirement('/Applications/Codex Monitor.app', fakeSpawn),
    requirement,
  );
});

test('candidate bundle is rejected before replacement when its identity differs', () => {
  const requirements = new Map([
    ['/Applications/Codex Monitor.app', 'designated => identifier "com.codexmonitor.desktop" and certificate leaf = H"abc"'],
    ['/tmp/Codex Monitor.app', 'designated => identifier "com.codexmonitor.desktop" and certificate leaf = H"def"'],
  ]);
  const fakeSpawn = (_command, args) => ({
    status: 0,
    stdout: '',
    stderr: requirements.get(args[2]),
  });

  assert.throws(
    () => assertUpdateBundleIdentity({
      installedAppPath: '/Applications/Codex Monitor.app',
      candidateAppPath: '/tmp/Codex Monitor.app',
      spawnSyncImpl: fakeSpawn,
    }),
    /签名身份不一致/,
  );
});
