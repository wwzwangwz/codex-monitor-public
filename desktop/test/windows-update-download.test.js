const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  downloadVerifiedAsset,
} = require('../src/lib/windows-update-download');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-update-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function assetFor(bytes, overrides = {}) {
  return {
    url: 'https://github.com/wwzwangwz/codex-monitor-public/releases/download/windows-0.8.4/Codex-Monitor-Setup.exe',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    ...overrides,
  };
}

async function expectDownloadCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('streams a verified asset into an atomic final file', async (t) => {
  const destinationDirectory = await temporaryDirectory(t);
  const bytes = Buffer.from('verified Windows update bytes');
  const asset = assetFor(bytes);

  const result = await downloadVerifiedAsset(asset, {
    destinationDirectory,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    }),
  });

  const expectedPath = path.join(destinationDirectory, 'Codex-Monitor-Setup.exe');
  assert.deepEqual(result, { path: expectedPath, sizeBytes: bytes.length, sha256: asset.sha256 });
  assert.deepEqual(await fs.readFile(expectedPath), bytes);
  assert.deepEqual(await fs.readdir(destinationDirectory), ['Codex-Monitor-Setup.exe']);
});

test('rejects redirects, HTTP failures, and responses without a body', async (t) => {
  const fixtures = [
    new Response(null, { status: 302, headers: { location: 'https://example.com/update.exe' } }),
    new Response('private response body', { status: 500 }),
    { ok: true, status: 200, headers: new Headers(), body: null },
  ];
  for (const response of fixtures) {
    const destinationDirectory = await temporaryDirectory(t);
    await expectDownloadCode(downloadVerifiedAsset(assetFor(Buffer.from('x')), {
      destinationDirectory,
      fetchImpl: async () => response,
    }), 'download_failed');
    assert.deepEqual(await fs.readdir(destinationDirectory), []);
  }
});

test('rejects a declared content length that differs from the signed size', async (t) => {
  const destinationDirectory = await temporaryDirectory(t);
  const bytes = Buffer.from('exact bytes');
  await expectDownloadCode(downloadVerifiedAsset(assetFor(bytes), {
    destinationDirectory,
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length + 1) },
    }),
  }), 'size_mismatch');
  assert.deepEqual(await fs.readdir(destinationDirectory), []);
});

test('rejects truncated, excessive, and hash-mismatched streams without publishing a file', async (t) => {
  const bytes = Buffer.from('signed bytes');
  const fixtures = [
    { responseBytes: bytes.subarray(0, 3), asset: assetFor(bytes) },
    { responseBytes: Buffer.concat([bytes, Buffer.from('!')]), asset: assetFor(bytes) },
    { responseBytes: bytes, asset: assetFor(bytes, { sha256: 'a'.repeat(64) }) },
  ];
  for (const { responseBytes, asset } of fixtures) {
    const destinationDirectory = await temporaryDirectory(t);
    await assert.rejects(downloadVerifiedAsset(asset, {
      destinationDirectory,
      fetchImpl: async () => new Response(responseBytes),
    }), (error) => ['size_mismatch', 'hash_mismatch'].includes(error.code));
    assert.deepEqual(await fs.readdir(destinationDirectory), []);
  }
});

test('rejects Windows-unsafe URL basenames before requesting the asset', async (t) => {
  const unsafeNames = ['CON.exe', '%2e%2e', 'update.', 'update%20', 'bad%00name.exe'];
  for (const filename of unsafeNames) {
    const destinationDirectory = await temporaryDirectory(t);
    let requested = false;
    const asset = assetFor(Buffer.from('x'), {
      url: `https://github.com/wwzwangwz/codex-monitor-public/releases/download/v/${filename}`,
    });
    await expectDownloadCode(downloadVerifiedAsset(asset, {
      destinationDirectory,
      fetchImpl: async () => {
        requested = true;
        return new Response('x');
      },
    }), 'unsafe_filename');
    assert.equal(requested, false);
    assert.deepEqual(await fs.readdir(destinationDirectory), []);
  }
});

test('preserves an existing destination and does not issue a request', async (t) => {
  const destinationDirectory = await temporaryDirectory(t);
  const finalPath = path.join(destinationDirectory, 'Codex-Monitor-Setup.exe');
  await fs.writeFile(finalPath, 'installed candidate');
  let requested = false;

  await expectDownloadCode(downloadVerifiedAsset(assetFor(Buffer.from('replacement')), {
    destinationDirectory,
    fetchImpl: async () => {
      requested = true;
      return new Response('replacement');
    },
  }), 'destination_exists');

  assert.equal(requested, false);
  assert.equal(await fs.readFile(finalPath, 'utf8'), 'installed candidate');
  assert.deepEqual(await fs.readdir(destinationDirectory), ['Codex-Monitor-Setup.exe']);
});

test('times out and removes its owned part file', async (t) => {
  const destinationDirectory = await temporaryDirectory(t);
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
  });

  await expectDownloadCode(downloadVerifiedAsset(assetFor(Buffer.from('x')), {
    destinationDirectory,
    fetchImpl,
    timeoutMs: 10,
  }), 'download_timeout');
  assert.deepEqual(await fs.readdir(destinationDirectory), []);
});

test('cleans a failed stream and never discloses request secrets in its error', async (t) => {
  const destinationDirectory = await temporaryDirectory(t);
  const token = 'secret-bearer-value';
  const responseBody = 'private-response-content';
  const asset = assetFor(Buffer.from('expected'), {
    url: 'https://github.com/wwzwangwz/codex-monitor-public/releases/download/private-tag/Secret-Update.exe',
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('partial'));
      controller.error(new Error(`${token} ${responseBody} ${asset.url} ${asset.sha256}`));
    },
  });

  let caught;
  try {
    await downloadVerifiedAsset(asset, {
      destinationDirectory,
      token,
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body }),
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught.code, 'download_failed');
  for (const secret of [token, responseBody, asset.url, asset.sha256]) {
    assert.equal(String(caught).includes(secret), false);
  }
  assert.deepEqual(await fs.readdir(destinationDirectory), []);
});
