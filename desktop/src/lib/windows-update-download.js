const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { WindowsUpdateError } = require('./windows-update-manifest');

function fail(code = 'download_failed') {
  throw new WindowsUpdateError(code);
}

function safeFilenameFromUrl(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return fail('unsafe_filename');
  }
  const encoded = target.pathname.slice(target.pathname.lastIndexOf('/') + 1);
  let filename;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    return fail('unsafe_filename');
  }
  if (
    !filename
    || filename === '.'
    || filename === '..'
    || /[<>:"/\\|?*\u0000-\u001f]/.test(filename)
    || /[ .]$/.test(filename)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
  ) fail('unsafe_filename');
  return filename;
}

function declaredLength(response) {
  const value = response.headers?.get?.('content-length');
  if (value === null || value === undefined) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) fail('size_mismatch');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('size_mismatch');
  return parsed;
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (bytesWritten <= 0) fail();
    offset += bytesWritten;
  }
}

async function downloadVerifiedAsset(asset, {
  destinationDirectory,
  token,
  fetchImpl = fetch,
  timeoutMs = 30_000,
} = {}) {
  const filename = safeFilenameFromUrl(asset?.url);
  const finalPath = path.join(destinationDirectory, filename);
  const partPath = path.join(destinationDirectory, `.${filename}.part-${crypto.randomUUID()}`);
  let file;
  let ownsPart = false;
  let timedOut = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    await fs.access(finalPath).then(() => fail('destination_exists'), () => {});
    file = await fs.open(partPath, 'wx');
    ownsPart = true;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetchImpl(asset.url, {
      redirect: 'manual',
      headers,
      signal: controller.signal,
    });
    if (!response.ok || !response.body) fail();
    const contentLength = declaredLength(response);
    if (contentLength !== null && contentLength !== asset.sizeBytes) fail('size_mismatch');

    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > asset.sizeBytes) fail('size_mismatch');
      hash.update(bytes);
      await writeAll(file, bytes);
    }
    if (sizeBytes !== asset.sizeBytes) fail('size_mismatch');
    const sha256 = hash.digest('hex');
    if (sha256 !== asset.sha256) fail('hash_mismatch');

    await file.sync();
    await file.close();
    file = undefined;
    await fs.rename(partPath, finalPath);
    return { path: finalPath, sizeBytes, sha256 };
  } catch (error) {
    if (file) await file.close().catch(() => {});
    if (ownsPart) await fs.rm(partPath, { force: true }).catch(() => {});
    if (timedOut) fail('download_timeout');
    if (error instanceof WindowsUpdateError) throw error;
    fail();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  downloadVerifiedAsset,
};
