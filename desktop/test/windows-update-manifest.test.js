const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  verifyWindowsUpdateManifest,
} = require('../src/lib/windows-update-manifest');

const keys = crypto.generateKeyPairSync('ed25519');
const otherKeys = crypto.generateKeyPairSync('ed25519');
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });

function manifest(overrides = {}) {
  return {
    schema: 2,
    product: 'Codex Monitor',
    platform: 'windows',
    version: '0.8.4',
    publishedAt: '2026-07-25T02:30:00Z',
    asset: {
      kind: 'nsis',
      url: 'https://github.com/wwzwangwz/codex-monitor-public/releases/download/windows-0.8.4/Codex-Monitor-Setup.exe',
      sha256: 'a'.repeat(64),
      sizeBytes: 1234,
    },
    rollback: {
      version: '0.8.3',
      kind: 'rollback',
      url: 'https://github.com/wwzwangwz/codex-monitor-public/releases/download/windows-0.8.4/Codex-Monitor-rollback.zip',
      sha256: 'b'.repeat(64),
      sizeBytes: 5678,
    },
    releaseNotesZh: 'Windows 安全更新',
    ...overrides,
  };
}

function signManifest(value, privateKey = keys.privateKey) {
  const body = JSON.stringify(value);
  const signature = crypto.sign(null, Buffer.from(body), privateKey).toString('base64');
  return `${body.slice(0, -1)},"signature":"${signature}"}`;
}

function verify(raw, options = {}) {
  return verifyWindowsUpdateManifest(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), {
    publicKeyPem,
    currentVersion: '0.8.3',
    ...options,
  });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('verifies and freezes a canonical Ed25519 Windows update manifest', () => {
  const result = verify(signManifest(manifest()));

  assert.equal(result.version, '0.8.4');
  assert.equal(result.asset.kind, 'nsis');
  assert.equal(result.rollback.kind, 'rollback');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.asset), true);
  assert.equal(Object.isFrozen(result.rollback), true);
});

test('rejects a wrong public key and a modified signature', () => {
  expectCode(() => verify(signManifest(manifest()), {
    publicKeyPem: otherKeys.publicKey.export({ type: 'spki', format: 'pem' }),
  }), 'invalid_signature');

  const signed = JSON.parse(signManifest(manifest()));
  signed.signature = `${signed.signature[0] === 'A' ? 'B' : 'A'}${signed.signature.slice(1)}`;
  expectCode(() => verify(JSON.stringify(signed)), 'invalid_signature');
});

test('rejects noncanonical JSON including duplicate, unknown, reordered, and whitespace fields', () => {
  const valid = signManifest(manifest());
  expectCode(() => verify(valid.replace('{"schema":2,', '{"schema":2,"schema":2,')), 'invalid_manifest');
  expectCode(() => verify(valid.replace('{"schema":2,', '{"unknown":true,"schema":2,')), 'invalid_manifest');
  expectCode(() => verify(` ${valid}`), 'invalid_manifest');

  const reordered = manifest();
  delete reordered.schema;
  const reorderedBody = { product: reordered.product, schema: 1, ...reordered };
  expectCode(() => verify(signManifest(reorderedBody)), 'invalid_manifest');
});

test('rejects BOM, invalid UTF-8, trailing bytes, malformed JSON, and oversized input', () => {
  const valid = Buffer.from(signManifest(manifest()));
  expectCode(() => verify(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid])), 'invalid_manifest');
  expectCode(() => verify(Buffer.from([0xff, 0xfe, 0xfd])), 'invalid_manifest');
  expectCode(() => verify(Buffer.concat([valid, Buffer.from('\n')])), 'invalid_manifest');
  expectCode(() => verify('{'), 'invalid_manifest');
  expectCode(() => verify(Buffer.alloc(65), { maxBytes: 64 }), 'invalid_manifest');
});

test('rejects schema, product, platform, and structural field mismatches', () => {
  const fixtures = [
    manifest({ schema: 1 }),
    manifest({ product: 'Other' }),
    manifest({ platform: 'mac' }),
    manifest({ asset: { ...manifest().asset, kind: 'rollback' } }),
    manifest({ rollback: { ...manifest().rollback, kind: 'nsis' } }),
    manifest({ asset: { ...manifest().asset, extra: true } }),
    manifest({ rollback: { ...manifest().rollback, extra: true } }),
  ];
  for (const value of fixtures) expectCode(() => verify(signManifest(value)), 'invalid_manifest');
});

test('authenticates schema 2 rollback version and rejects a rollback that is not older', () => {
  const valid = signManifest(manifest());
  const tampered = JSON.parse(valid);
  tampered.rollback.version = '0.8.2';
  expectCode(() => verify(JSON.stringify(tampered)), 'invalid_signature');

  for (const version of ['0.8.4', '0.8.5', '01.2.3', '0.8']) {
    expectCode(() => verify(signManifest(manifest({
      rollback: { ...manifest().rollback, version },
    }))), 'invalid_manifest');
  }
});

test('enforces the update semantic version gate', () => {
  for (const version of ['0.8.3', '0.8.2', '01.2.3', '1.2', '1.2.3-beta']) {
    const expected = ['0.8.3', '0.8.2'].includes(version) ? 'update_not_newer' : 'invalid_manifest';
    expectCode(() => verify(signManifest(manifest({ version }))), expected);
  }
});

test('accepts the contracted UTC timestamp forms and rejects invalid dates', () => {
  assert.equal(verify(signManifest(manifest({ publishedAt: '2026-07-25T02:30:00.123Z' }))).version, '0.8.4');
  for (const publishedAt of ['2026-07-25 02:30:00Z', '2026-02-30T00:00:00Z', '2026-07-25T02:30:00+08:00']) {
    expectCode(() => verify(signManifest(manifest({ publishedAt }))), 'invalid_manifest');
  }
});

test('rejects unsafe or mutable release asset URLs', () => {
  const urls = [
    'http://github.com/wwzwangwz/codex-monitor-public/releases/download/v/file.exe',
    'https://example.com/wwzwangwz/codex-monitor-public/releases/download/v/file.exe',
    'https://github.com/other/codex-monitor/releases/download/v/file.exe',
    'https://user@github.com/wwzwangwz/codex-monitor-public/releases/download/v/file.exe',
    'https://github.com/wwzwangwz/codex-monitor-public/releases/download/v/file.exe?x=1',
    'https://github.com/wwzwangwz/codex-monitor-public/releases/download/v/file.exe#x',
    '/relative/file.exe',
  ];
  for (const url of urls) {
    expectCode(() => verify(signManifest(manifest({
      asset: { ...manifest().asset, url },
    }))), 'invalid_manifest');
  }
});

test('rejects invalid hashes, sizes, release notes, and signatures', () => {
  const fixtures = [
    manifest({ asset: { ...manifest().asset, sha256: 'A'.repeat(64) } }),
    manifest({ asset: { ...manifest().asset, sizeBytes: 0 } }),
    manifest({ rollback: { ...manifest().rollback, sizeBytes: Number.MAX_SAFE_INTEGER + 1 } }),
    manifest({ releaseNotesZh: '' }),
    manifest({ releaseNotesZh: 'English only' }),
    manifest({ releaseNotesZh: '中'.repeat(4001) }),
  ];
  for (const value of fixtures) expectCode(() => verify(signManifest(value)), 'invalid_manifest');

  const signed = JSON.parse(signManifest(manifest()));
  signed.signature = '***';
  expectCode(() => verify(JSON.stringify(signed)), 'invalid_manifest');
});
