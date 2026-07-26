const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  cleanupStaleGuidanceAttachments,
  decodeGuidanceAttachments,
  retainGuidanceAttachments,
  stageGuidanceAttachments,
} = require('../src/lib/attachments');

test('decodes and verifies guidance image attachments', () => {
  const data = Buffer.from('small-png');
  const attachments = decodeGuidanceAttachments([{
    name: 'problem.png', mimeType: 'image/png', sizeBytes: data.length, dataBase64: data.toString('base64'),
  }]);
  assert.equal(attachments[0].name, 'problem.png');
  assert.deepEqual(attachments[0].data, data);
});

test('keeps a submitted image across early agent progress until retention expires', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-retain-test-'));
  const staged = stageGuidanceAttachments([
    { name: 'problem.png', mimeType: 'image/png', data: Buffer.from('image') },
  ], { temporaryDirectory: directory });
  let expire;
  try {
    retainGuidanceAttachments(staged, {
      maxAgeMs: 2_000,
      setTimeoutImpl: (callback) => { expire = callback; return { unref() {} }; },
      clearTimeoutImpl: () => {},
    });
    // The first assistant commentary is not proof that a later image-reading tool has run.
    assert.equal(fs.existsSync(staged.files[0].path), true);
    expire();
    assert.equal(fs.existsSync(staged.files[0].path), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removes only stale guidance directories during startup cleanup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-stale-test-'));
  const stale = path.join(directory, 'codex-monitor-guidance-old');
  const fresh = path.join(directory, 'codex-monitor-guidance-new');
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(stale, old, old);
  try {
    assert.equal(cleanupStaleGuidanceAttachments({ temporaryDirectory: directory, maxAgeMs: 5_000 }), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects malformed, unsafe, oversized, and duplicate guidance images', () => {
  const valid = { name: 'a.png', mimeType: 'image/png', sizeBytes: 1, dataBase64: 'eA==' };
  assert.throws(() => decodeGuidanceAttachments([{ ...valid, name: '../a.png' }]), /文件名/);
  assert.throws(() => decodeGuidanceAttachments([{ ...valid, mimeType: 'image/svg+xml' }]), /JPEG/);
  assert.throws(() => decodeGuidanceAttachments([{ ...valid, sizeBytes: 2 }]), /大小校验/);
  assert.throws(() => decodeGuidanceAttachments([valid, valid]), /不能重复/);
  const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...valid, name: `${index}.png` }));
  assert.throws(() => decodeGuidanceAttachments(tooMany), /最多/);
  assert.equal(decodeGuidanceAttachments(tooMany.slice(0, 10)).length, 10);
});

test('stages images in a private temporary directory and removes them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-attachment-test-'));
  try {
    const staged = stageGuidanceAttachments([{
      name: 'screen.jpeg', mimeType: 'image/jpeg', data: Buffer.from('jpeg'),
    }], { temporaryDirectory: root });
    assert.equal(path.basename(staged.files[0].path), 'screen.jpeg');
    assert.equal(fs.readFileSync(staged.files[0].path, 'utf8'), 'jpeg');
    const directory = path.dirname(staged.files[0].path);
    staged.cleanup();
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stages phone images in a monitor-owned durable directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-owned-storage-test-'));
  const storageDirectory = path.join(root, 'user-data', 'guidance-attachments');
  try {
    const staged = stageGuidanceAttachments([{
      name: 'phone.png', mimeType: 'image/png', data: Buffer.from('durable'),
    }], { storageDirectory });
    assert.equal(staged.files[0].path.startsWith(`${storageDirectory}${path.sep}`), true);
    assert.equal(fs.readFileSync(staged.files[0].path, 'utf8'), 'durable');

    const restartedProcessCleanup = cleanupStaleGuidanceAttachments({
      storageDirectory,
      now: Date.now() + 1_000,
      maxAgeMs: 5_000,
    });
    assert.equal(restartedProcessCleanup, 0);
    assert.equal(fs.existsSync(staged.files[0].path), true);

    staged.cleanup();
    assert.equal(fs.existsSync(staged.files[0].path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
