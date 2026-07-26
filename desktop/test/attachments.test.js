const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_ATTACHMENT_BYTES,
  STALE_ATTACHMENT_AGE_MS,
  cleanupStaleGuidanceAttachments,
  decodeGuidanceAttachments,
  retainGuidanceAttachments,
  stageGuidanceAttachments,
  validatePreparedAttachments,
} = require('../src/lib/attachments');

function wireAttachment(name, mimeType, data) {
  return {
    name,
    mimeType,
    sizeBytes: data.length,
    dataBase64: data.toString('base64'),
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('decodes canonical Base64 and verifies declared attachment size', () => {
  const data = Buffer.from('small-png');
  assert.deepEqual(decodeGuidanceAttachments([
    wireAttachment('problem.png', 'image/png', data),
  ]), [{ name: 'problem.png', mimeType: 'image/png', data }]);

  assert.throws(() => decodeGuidanceAttachments([{
    ...wireAttachment('problem.png', 'image/png', data), sizeBytes: data.length + 1,
  }]), /size/i);
  assert.throws(() => decodeGuidanceAttachments([{
    ...wireAttachment('problem.png', 'image/png', data), dataBase64: 'eA',
  }]), /format/i);
});

test('rejects unsafe names, duplicates, unsupported MIME types, and too many files', () => {
  const valid = wireAttachment('a.png', 'image/png', Buffer.from('x'));
  assert.throws(() => decodeGuidanceAttachments([{ ...valid, name: '..\\a.png' }]), /name/i);
  assert.throws(() => decodeGuidanceAttachments([{ ...valid, mimeType: 'image/svg+xml' }]), /JPEG|PNG|WebP/i);
  assert.throws(() => decodeGuidanceAttachments([valid, valid]), /duplicate/i);
  const ten = Array.from({ length: 10 }, (_, index) => ({ ...valid, name: `${index}.png` }));
  assert.equal(decodeGuidanceAttachments(ten).length, 10);
  assert.throws(() => decodeGuidanceAttachments([
    ...ten, { ...valid, name: '10.png' },
  ]), /at most 10/i);
});

test('enforces per-file and decoded-total byte limits', () => {
  assert.throws(() => validatePreparedAttachments([{
    name: 'large.png', mimeType: 'image/png', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
  }]), /4 MiB/i);

  const chunk = Buffer.alloc(4 * 1024 * 1024);
  const maximum = Array.from({ length: 6 }, (_, index) => ({
    name: `${index}.png`, mimeType: 'image/png', data: chunk,
  }));
  assert.equal(validatePreparedAttachments(maximum).length, 6);
  assert.throws(() => validatePreparedAttachments([
    ...maximum, { name: 'overflow.png', mimeType: 'image/png', data: Buffer.alloc(1) },
  ]), /24 MiB/i);
});

test('stages corrected extensions and cleanup removes the private directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-attachment-test-'));
  try {
    const staged = stageGuidanceAttachments([
      { name: 'screen.txt', mimeType: 'image/png', data: Buffer.from('png') },
      { name: 'photo.jpeg', mimeType: 'image/jpeg', data: Buffer.from('jpeg') },
    ], { temporaryDirectory: root });
    assert.equal(path.basename(staged.files[0].path), 'screen.png');
    assert.equal(path.basename(staged.files[1].path), 'photo.jpeg');
    assert.equal(fs.readFileSync(staged.files[0].path, 'utf8'), 'png');
    const directory = path.dirname(staged.files[0].path);
    staged.cleanup();
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('keeps submitted files through ordinary assistant progress until retention expiry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-retain-test-'));
  const sessionsRoot = path.join(root, 'sessions');
  const sessionId = '00000000-0000-0000-0000-000000000001';
  fs.mkdirSync(sessionsRoot);
  const rollout = path.join(sessionsRoot, `rollout-${sessionId}.jsonl`);
  const staged = stageGuidanceAttachments([
    { name: 'problem.png', mimeType: 'image/png', data: Buffer.from('image') },
  ], { temporaryDirectory: root });
  let expire;
  try {
    retainGuidanceAttachments(staged, {
      sessionId,
      sessionsRoot,
      pollMs: 10,
      maxAgeMs: 2_000,
      setTimeoutImpl: (callback) => {
        expire = callback;
        return { unref() {} };
      },
      clearTimeoutImpl: () => {},
    });
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'event_msg', payload: {
        type: 'user_message', local_images: [staged.files[0].path],
      } }),
      JSON.stringify({ type: 'event_msg', payload: {
        type: 'agent_message', phase: 'commentary', message: 'starting analysis',
      } }),
    ].join('\n'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fs.existsSync(staged.files[0].path), true);
    expire();
    assert.equal(fs.existsSync(staged.files[0].path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stages guidance images in monitor-owned storage that survives a process restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-owned-storage-test-'));
  const storageDirectory = path.join(root, 'user-data', 'guidance-attachments');
  let staged;
  try {
    staged = stageGuidanceAttachments([
      { name: 'phone.png', mimeType: 'image/png', data: Buffer.from('durable') },
    ], { storageDirectory });
    assert.equal(staged.files[0].path.startsWith(`${storageDirectory}${path.sep}`), true);
    assert.equal(fs.existsSync(staged.files[0].path), true);
    assert.equal(cleanupStaleGuidanceAttachments({
      storageDirectory,
      now: Date.now() + 1_000,
      maxAgeMs: 5_000,
    }), 0);
    assert.equal(fs.existsSync(staged.files[0].path), true);
  } finally {
    staged?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retention expiry cleans files even without rollout evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-retain-expiry-test-'));
  const staged = stageGuidanceAttachments([
    { name: 'problem.png', mimeType: 'image/png', data: Buffer.from('image') },
  ], { temporaryDirectory: root });
  try {
    retainGuidanceAttachments(staged, {
      sessionId: '00000000-0000-0000-0000-000000000003',
      sessionsRoot: path.join(root, 'missing'),
      pollMs: 10,
      maxAgeMs: 30,
    });
    await waitFor(() => !fs.existsSync(staged.files[0].path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup cleanup removes only stale monitor guidance directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-stale-test-'));
  const stale = path.join(root, 'codex-monitor-guidance-old');
  const fresh = path.join(root, 'codex-monitor-guidance-new');
  const unrelated = path.join(root, 'other-old-directory');
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  fs.mkdirSync(unrelated);
  const now = Date.now();
  const old = new Date(now - STALE_ATTACHMENT_AGE_MS - 1);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(unrelated, old, old);
  try {
    assert.equal(cleanupStaleGuidanceAttachments({ temporaryDirectory: root, now }), 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
