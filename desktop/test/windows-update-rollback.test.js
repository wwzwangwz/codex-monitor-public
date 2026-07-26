const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createRollbackSnapshot,
  restoreRollbackSnapshot,
  verifyRollbackSnapshot,
} = require('../src/lib/windows-update-rollback');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-update-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'installed');
  const backupRoot = path.join(root, 'backups');
  await fs.mkdir(path.join(sourceDirectory, 'resources'), { recursive: true });
  await fs.writeFile(path.join(sourceDirectory, 'Codex Monitor.exe'), 'exe-v1');
  await fs.writeFile(path.join(sourceDirectory, 'resources', 'app.asar'), 'asar-v1');
  return { root, sourceDirectory, backupRoot };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test('creates a verifiable rollback snapshot that survives source mutation', async (t) => {
  const { sourceDirectory, backupRoot } = await fixture(t);

  const snapshot = await createRollbackSnapshot({
    sourceDirectory,
    backupRoot,
    version: '0.8.3',
  });
  await fs.writeFile(path.join(sourceDirectory, 'Codex Monitor.exe'), 'exe-v2');
  await fs.rm(path.join(sourceDirectory, 'resources', 'app.asar'));
  const verified = await verifyRollbackSnapshot({
    snapshotDirectory: snapshot.path,
    expectedVersion: '0.8.3',
  });

  assert.equal(snapshot.path, path.join(backupRoot, 'Codex-Monitor-0.8.3'));
  assert.deepEqual(verified, {
    schema: 1,
    product: 'Codex Monitor',
    version: '0.8.3',
    files: [
      {
        path: 'Codex Monitor.exe',
        sizeBytes: 6,
        sha256: 'b9ef0d8f5d2bc193dd5d1de0ba58eb27404211e95b45d640148963309289260b',
      },
      {
        path: 'resources/app.asar',
        sizeBytes: 7,
        sha256: '95c8e571401c99300d90d65d979c669028d948599e6a7702a8e635acd36d2e02',
      },
    ],
  });
  assert.equal(await fs.readFile(path.join(snapshot.path, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
  assert.equal(await fs.readFile(path.join(snapshot.path, 'resources', 'app.asar'), 'utf8'), 'asar-v1');
});

test('restores a verified snapshot into a new destination without its inventory', async (t) => {
  const { root, sourceDirectory, backupRoot } = await fixture(t);
  const snapshot = await createRollbackSnapshot({ sourceDirectory, backupRoot, version: '0.8.3' });
  const destinationDirectory = path.join(root, 'restored');

  const restored = await restoreRollbackSnapshot({
    snapshotDirectory: snapshot.path,
    destinationDirectory,
    expectedVersion: '0.8.3',
  });

  assert.equal(restored.path, destinationDirectory);
  assert.deepEqual(await fs.readdir(destinationDirectory), ['Codex Monitor.exe', 'resources']);
  assert.equal(await fs.readFile(path.join(destinationDirectory, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
  assert.equal(await fs.readFile(path.join(destinationDirectory, 'resources', 'app.asar'), 'utf8'), 'asar-v1');
});

test('rejects modified, missing, and extra snapshot files', async (t) => {
  const mutations = [
    async (snapshotPath) => fs.writeFile(path.join(snapshotPath, 'Codex Monitor.exe'), 'tampered'),
    async (snapshotPath) => fs.rm(path.join(snapshotPath, 'resources', 'app.asar')),
    async (snapshotPath) => fs.writeFile(path.join(snapshotPath, 'unexpected.dll'), 'extra'),
  ];
  for (const mutate of mutations) {
    const { sourceDirectory, backupRoot } = await fixture(t);
    const snapshot = await createRollbackSnapshot({ sourceDirectory, backupRoot, version: '0.8.3' });
    await mutate(snapshot.path);
    await expectCode(verifyRollbackSnapshot({
      snapshotDirectory: snapshot.path,
      expectedVersion: '0.8.3',
    }), 'snapshot_mismatch');
  }
});

test('rejects malformed, noncanonical, and wrong-version inventories', async (t) => {
  const mutations = [
    async (inventoryPath) => fs.writeFile(inventoryPath, '{'),
    async (inventoryPath) => fs.appendFile(inventoryPath, '\n'),
  ];
  for (const mutate of mutations) {
    const { sourceDirectory, backupRoot } = await fixture(t);
    const snapshot = await createRollbackSnapshot({ sourceDirectory, backupRoot, version: '0.8.3' });
    await mutate(path.join(snapshot.path, 'rollback-inventory.json'));
    await expectCode(verifyRollbackSnapshot({
      snapshotDirectory: snapshot.path,
      expectedVersion: '0.8.3',
    }), 'invalid_inventory');
  }

  const { sourceDirectory, backupRoot } = await fixture(t);
  const snapshot = await createRollbackSnapshot({ sourceDirectory, backupRoot, version: '0.8.3' });
  await expectCode(verifyRollbackSnapshot({
    snapshotDirectory: snapshot.path,
    expectedVersion: '0.8.2',
  }), 'invalid_inventory');
});

test('preserves an existing backup and the installation source', async (t) => {
  const { sourceDirectory, backupRoot } = await fixture(t);
  const existing = path.join(backupRoot, 'Codex-Monitor-0.8.3');
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, 'marker.txt'), 'keep backup');

  await expectCode(createRollbackSnapshot({
    sourceDirectory,
    backupRoot,
    version: '0.8.3',
  }), 'backup_exists');

  assert.equal(await fs.readFile(path.join(existing, 'marker.txt'), 'utf8'), 'keep backup');
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
  assert.deepEqual((await fs.readdir(backupRoot)).sort(), ['Codex-Monitor-0.8.3']);
});

test('rejects a backup root inside the installation without creating it', async (t) => {
  const { sourceDirectory } = await fixture(t);
  const backupRoot = path.join(sourceDirectory, 'nested-backups');

  await expectCode(createRollbackSnapshot({
    sourceDirectory,
    backupRoot,
    version: '0.8.3',
  }), 'unsafe_backup_root');

  await assert.rejects(fs.access(backupRoot), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
});

test('preserves an existing restore destination', async (t) => {
  const { root, sourceDirectory, backupRoot } = await fixture(t);
  const snapshot = await createRollbackSnapshot({ sourceDirectory, backupRoot, version: '0.8.3' });
  const destinationDirectory = path.join(root, 'restored');
  await fs.mkdir(destinationDirectory);
  await fs.writeFile(path.join(destinationDirectory, 'marker.txt'), 'keep destination');

  await expectCode(restoreRollbackSnapshot({
    snapshotDirectory: snapshot.path,
    destinationDirectory,
    expectedVersion: '0.8.3',
  }), 'destination_exists');

  assert.equal(await fs.readFile(path.join(destinationDirectory, 'marker.txt'), 'utf8'), 'keep destination');
  assert.deepEqual(await fs.readdir(destinationDirectory), ['marker.txt']);
});

test('rejects source symlinks and cleans its partial snapshot when Windows permits symlinks', async (t) => {
  const { sourceDirectory, backupRoot } = await fixture(t);
  try {
    await fs.symlink(
      path.join(sourceDirectory, 'Codex Monitor.exe'),
      path.join(sourceDirectory, 'linked.exe'),
      'file',
    );
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Windows Developer Mode or symlink privilege is unavailable');
      return;
    }
    throw error;
  }

  await expectCode(createRollbackSnapshot({
    sourceDirectory,
    backupRoot,
    version: '0.8.3',
  }), 'unsafe_entry');
  assert.deepEqual(await fs.readdir(backupRoot), []);
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
});

test('cleans a partial snapshot after a source copy failure', async (t) => {
  const { sourceDirectory, backupRoot } = await fixture(t);
  t.mock.method(fs, 'copyFile', async () => {
    throw new Error('injected copy failure');
  });

  await expectCode(createRollbackSnapshot({
    sourceDirectory,
    backupRoot,
    version: '0.8.3',
  }), 'rollback_failed');

  assert.deepEqual(await fs.readdir(backupRoot), []);
  assert.equal(await fs.readFile(path.join(sourceDirectory, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
});

test('cleans a partial restore after a destination copy failure', async (t) => {
  const { root, sourceDirectory, backupRoot } = await fixture(t);
  const snapshot = await createRollbackSnapshot({ sourceDirectory, backupRoot, version: '0.8.3' });
  const destinationDirectory = path.join(root, 'restored');
  t.mock.method(fs, 'copyFile', async () => {
    throw new Error('injected copy failure');
  });

  await expectCode(restoreRollbackSnapshot({
    snapshotDirectory: snapshot.path,
    destinationDirectory,
    expectedVersion: '0.8.3',
  }), 'rollback_failed');

  await assert.rejects(fs.access(destinationDirectory), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(root)).sort(), ['backups', 'installed']);
  assert.equal(await fs.readFile(path.join(snapshot.path, 'Codex Monitor.exe'), 'utf8'), 'exe-v1');
});
