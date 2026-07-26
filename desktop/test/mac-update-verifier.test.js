const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertNewerVersion,
  verifyMacUpdateArchive,
  verifyMacUpdateCandidate,
} = require('../src/lib/mac-update-verifier');

test('Mac update archive must match both declared size and SHA-256', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-mac-archive-'));
  const archive = path.join(directory, 'Codex-Monitor.zip');
  try {
    const contents = Buffer.from('signed archive fixture');
    fs.writeFileSync(archive, contents);
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    await assert.doesNotReject(verifyMacUpdateArchive(archive, { size: contents.length, sha256 }));
    await assert.rejects(
      verifyMacUpdateArchive(archive, { size: contents.length + 1, sha256 }),
      /大小校验失败/,
    );
    await assert.rejects(
      verifyMacUpdateArchive(archive, { size: contents.length, sha256: '0'.repeat(64) }),
      /SHA-256 校验失败/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Mac update version must be strictly newer and numeric', () => {
  assert.doesNotThrow(() => assertNewerVersion('0.11.15', '0.11.16'));
  assert.doesNotThrow(() => assertNewerVersion('0.11.15', '0.12.0'));
  assert.throws(() => assertNewerVersion('0.11.15', '0.11.15'), /必须高于/);
  assert.throws(() => assertNewerVersion('0.11.15', '0.11.14'), /必须高于/);
  assert.throws(() => assertNewerVersion('0.11.15', 'latest'), /版本号不合法/);
});

test('Mac candidate verifies signature, identity, bundle ID and version before replacement', async () => {
  const events = [];
  const metadata = new Map([
    ['/Applications/Codex Monitor.app', {
      bundleId: 'com.codexmonitor.desktop',
      version: '0.11.15',
    }],
    ['/Volumes/CodexMonitorBuild/candidate/Codex Monitor.app', {
      bundleId: 'com.codexmonitor.desktop',
      version: '0.11.16',
    }],
  ]);

  const result = await verifyMacUpdateCandidate({
    installedAppPath: '/Applications/Codex Monitor.app',
    candidateAppPath: '/Volumes/CodexMonitorBuild/candidate/Codex Monitor.app',
    expectedBundleId: 'com.codexmonitor.desktop',
    readBundleMetadataImpl: async (value) => metadata.get(value),
    verifyCodeSignatureImpl: async (value) => events.push(['signature', value]),
    assertUpdateBundleIdentityImpl: (value) => events.push([
      'identity',
      value.installedAppPath,
      value.candidateAppPath,
    ]),
  });

  assert.deepEqual(result, {
    installed: metadata.get('/Applications/Codex Monitor.app'),
    candidate: metadata.get('/Volumes/CodexMonitorBuild/candidate/Codex Monitor.app'),
  });
  assert.deepEqual(events, [
    ['signature', '/Applications/Codex Monitor.app'],
    ['signature', '/Volumes/CodexMonitorBuild/candidate/Codex Monitor.app'],
    ['identity', '/Applications/Codex Monitor.app', '/Volumes/CodexMonitorBuild/candidate/Codex Monitor.app'],
  ]);
});

test('Mac candidate rejects another bundle ID or a non-newer version', async () => {
  const base = {
    installedAppPath: '/Applications/Codex Monitor.app',
    candidateAppPath: '/Volumes/CodexMonitorBuild/candidate/Codex Monitor.app',
    expectedBundleId: 'com.codexmonitor.desktop',
    verifyCodeSignatureImpl: async () => {},
    assertUpdateBundleIdentityImpl: () => {},
  };

  await assert.rejects(
    verifyMacUpdateCandidate({
      ...base,
      readBundleMetadataImpl: async (value) => ({
        bundleId: value.startsWith('/Applications') ? 'com.codexmonitor.desktop' : 'example.impostor',
        version: value.startsWith('/Applications') ? '0.11.15' : '0.11.16',
      }),
    }),
    /bundle ID/,
  );
  await assert.rejects(
    verifyMacUpdateCandidate({
      ...base,
      readBundleMetadataImpl: async () => ({
        bundleId: 'com.codexmonitor.desktop',
        version: '0.11.15',
      }),
    }),
    /必须高于/,
  );
});
