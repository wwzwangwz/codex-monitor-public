const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const MAX_GUIDANCE_MESSAGE_BYTES = 32 * 1024 * 1024;
const STALE_ATTACHMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

function validateName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120 || path.basename(name) !== name || /[\x00-\x1f/\\]/.test(name)) {
    throw new Error('图片文件名无效');
  }
  return name;
}

function decodeBase64(value) {
  const encoded = String(value || '');
  if (!encoded || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('图片数据格式无效');
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) throw new Error('图片数据格式无效');
  return data;
}

function decodeGuidanceAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`每次最多发送 ${MAX_ATTACHMENT_COUNT} 张图片`);
  }
  let total = 0;
  const names = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('图片附件格式无效');
    const name = validateName(item.name);
    if (names.has(name)) throw new Error('同一次发送的图片文件名不能重复');
    names.add(name);
    const mimeType = String(item.mimeType || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(mimeType)) throw new Error('仅支持 JPEG、PNG 或 WebP 图片');
    const data = decodeBase64(item.dataBase64);
    const declaredSize = Number(item.sizeBytes);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== data.length) {
      throw new Error('图片大小校验失败');
    }
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('单张图片不能超过 4 MiB');
    total += data.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('图片总大小不能超过 24 MiB');
    return { name, mimeType, data };
  });
}

function validatePreparedAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`每次最多发送 ${MAX_ATTACHMENT_COUNT} 张图片`);
  }
  let total = 0;
  const names = new Set();
  return value.map((item) => {
    const name = validateName(item?.name);
    if (names.has(name)) throw new Error('同一次发送的图片文件名不能重复');
    names.add(name);
    const mimeType = String(item?.mimeType || '').toLowerCase();
    if (!IMAGE_EXTENSIONS.has(mimeType)) throw new Error('仅支持 JPEG、PNG 或 WebP 图片');
    if (!Buffer.isBuffer(item?.data)) throw new Error('图片附件格式无效');
    if (item.data.length > MAX_ATTACHMENT_BYTES) throw new Error('单张图片不能超过 4 MiB');
    total += item.data.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('图片总大小不能超过 24 MiB');
    return { name, mimeType, data: item.data };
  });
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
  const root = storageDirectory || temporaryDirectory;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(path.join(root, 'codex-monitor-guidance-'));
  const files = attachments.map((item) => {
    const expectedExtension = IMAGE_EXTENSIONS.get(item.mimeType);
    const parsed = path.parse(item.name);
    const fileName = parsed.ext.toLowerCase() === expectedExtension
      || (item.mimeType === 'image/jpeg' && parsed.ext.toLowerCase() === '.jpeg')
      ? item.name
      : `${parsed.name}${expectedExtension}`;
    const filePath = path.join(directory, fileName);
    writeFileSync(filePath, item.data, { mode: 0o600 });
    return { name: fileName, path: filePath };
  });
  return { files, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
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
    // Temporary directory cleanup must never stop the monitor from starting.
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
