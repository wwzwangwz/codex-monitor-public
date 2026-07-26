const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const MAX_GUIDANCE_MESSAGE_BYTES = 33 * 1024 * 1024;
const STALE_ATTACHMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function validateName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120 || path.basename(name) !== name || /[\x00-\x1f/\\]/.test(name)) {
    throw new Error('attachment name is invalid');
  }
  return name;
}

function decodeBase64(value) {
  const encoded = String(value || '');
  const maximumEncodedLength = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4;
  if (!encoded || encoded.length > maximumEncodedLength
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('attachment data format is invalid');
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) throw new Error('attachment data format is invalid');
  return data;
}

function validateAttachmentList(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`at most ${MAX_ATTACHMENT_COUNT} image attachments are allowed`);
  }
  return value;
}

function decodeGuidanceAttachments(value) {
  const attachments = validateAttachmentList(value);
  let total = 0;
  const names = new Set();
  return attachments.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('attachment format is invalid');
    const name = validateName(item.name);
    if (names.has(name)) throw new Error('duplicate attachment names are not allowed');
    names.add(name);
    const mimeType = String(item.mimeType || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(mimeType)) {
      throw new Error('only JPEG, PNG, or WebP attachments are supported');
    }
    const data = decodeBase64(item.dataBase64);
    const declaredSize = Number(item.sizeBytes);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== data.length) {
      throw new Error('attachment size does not match its decoded data');
    }
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('each attachment must be at most 4 MiB');
    total += data.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('attachments must total at most 24 MiB');
    return { name, mimeType, data };
  });
}

function validatePreparedAttachments(value) {
  const attachments = validateAttachmentList(value);
  let total = 0;
  const names = new Set();
  return attachments.map((item) => {
    const name = validateName(item?.name);
    if (names.has(name)) throw new Error('duplicate attachment names are not allowed');
    names.add(name);
    const mimeType = String(item?.mimeType || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(mimeType)) {
      throw new Error('only JPEG, PNG, or WebP attachments are supported');
    }
    if (!Buffer.isBuffer(item?.data)) throw new Error('attachment format is invalid');
    if (item.data.length > MAX_ATTACHMENT_BYTES) throw new Error('each attachment must be at most 4 MiB');
    total += item.data.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('attachments must total at most 24 MiB');
    return { name, mimeType, data: item.data };
  });
}

function stagedFileName(attachment) {
  const expectedExtension = IMAGE_EXTENSIONS.get(attachment.mimeType);
  const parsed = path.parse(attachment.name);
  const actualExtension = parsed.ext.toLowerCase();
  if (actualExtension === expectedExtension
      || (attachment.mimeType === 'image/jpeg' && actualExtension === '.jpeg')) {
    return attachment.name;
  }
  return `${parsed.name}${expectedExtension}`;
}

function stageGuidanceAttachments(value, {
  mkdirSync = fs.mkdirSync,
  mkdtempSync = fs.mkdtempSync,
  writeFileSync = fs.writeFileSync,
  rmSync = fs.rmSync,
  storageDirectory,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  const attachments = validatePreparedAttachments(value);
  if (!attachments.length) return { files: [], cleanup: () => {} };
  const names = attachments.map(stagedFileName);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error('attachment names collide after extension correction');
  }
  const root = storageDirectory || temporaryDirectory;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(root, 'codex-monitor-guidance-'));
  try {
    const files = attachments.map((attachment, index) => {
      const filePath = path.join(directory, names[index]);
      writeFileSync(filePath, attachment.data, { mode: 0o600 });
      return { name: names[index], path: filePath };
    });
    return {
      files,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function retainGuidanceAttachments(staged, {
  maxAgeMs = STALE_ATTACHMENT_AGE_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!staged?.files?.length) return () => {};
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearTimeoutImpl(expiry);
    staged.cleanup();
  };
  const expiry = setTimeoutImpl(cleanup, maxAgeMs);
  expiry.unref?.();
  return cleanup;
}

function cleanupStaleGuidanceAttachments({
  storageDirectory,
  temporaryDirectory = os.tmpdir(),
  now = Date.now(),
  maxAgeMs = STALE_ATTACHMENT_AGE_MS,
} = {}) {
  let removed = 0;
  const root = storageDirectory || temporaryDirectory;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('codex-monitor-guidance-')) continue;
      const directory = path.join(root, entry.name);
      if (now - fs.statSync(directory).mtimeMs < maxAgeMs) continue;
      fs.rmSync(directory, { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    // Temporary-file cleanup must never prevent monitor startup.
  }
  return removed;
}

module.exports = {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_GUIDANCE_MESSAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  STALE_ATTACHMENT_AGE_MS,
  cleanupStaleGuidanceAttachments,
  decodeGuidanceAttachments,
  retainGuidanceAttachments,
  stageGuidanceAttachments,
  validatePreparedAttachments,
};
