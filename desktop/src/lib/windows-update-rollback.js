const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { WindowsUpdateError } = require('./windows-update-manifest');

const INVENTORY_NAME = 'rollback-inventory.json';
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(code = 'rollback_failed') {
  throw new WindowsUpdateError(code);
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key, index) => key === keys[index]);
}

function normalizedRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  const file = await fs.open(filename, 'r');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

async function walkRegularFiles(root, { excludeInventory = false } = {}) {
  const files = [];
  async function visit(directory) {
    const names = await fs.readdir(directory);
    names.sort();
    for (const name of names) {
      const target = path.join(directory, name);
      const relative = normalizedRelative(root, target);
      if (excludeInventory && relative === INVENTORY_NAME) continue;
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) fail('unsafe_entry');
      if (stats.isDirectory()) await visit(target);
      else if (stats.isFile()) files.push({ absolute: target, relative, stats });
      else fail('unsafe_entry');
    }
  }
  await visit(root);
  files.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
  return files;
}

async function inventoryForDirectory(root, options) {
  const files = await walkRegularFiles(root, options);
  const inventory = [];
  for (const file of files) {
    inventory.push({
      path: file.relative,
      sizeBytes: file.stats.size,
      sha256: await hashFile(file.absolute),
    });
  }
  return inventory;
}

function validateInventory(value, expectedVersion) {
  if (!hasExactKeys(value, ['schema', 'product', 'version', 'files'])
      || value.schema !== 1
      || value.product !== 'Codex Monitor'
      || value.version !== expectedVersion
      || !SEMVER_PATTERN.test(value.version)
      || !Array.isArray(value.files)) fail('invalid_inventory');
  let previous = null;
  for (const file of value.files) {
    if (!hasExactKeys(file, ['path', 'sizeBytes', 'sha256'])
        || typeof file.path !== 'string'
        || !file.path
        || file.path.includes('\\')
        || file.path.startsWith('/')
        || file.path.split('/').some((part) => !part || part === '.' || part === '..')
        || file.path === INVENTORY_NAME
        || !Number.isSafeInteger(file.sizeBytes)
        || file.sizeBytes < 0
        || !SHA256_PATTERN.test(file.sha256)
        || (previous !== null && previous.localeCompare(file.path, 'en') >= 0)) fail('invalid_inventory');
    previous = file.path;
  }
}

async function createRollbackSnapshot({ sourceDirectory, backupRoot, version }) {
  if (!SEMVER_PATTERN.test(version)) fail('invalid_version');
  const source = path.resolve(sourceDirectory);
  const backups = path.resolve(backupRoot);
  if (source === backups || isInside(source, backups)) fail('unsafe_backup_root');
  const sourceStats = await fs.lstat(source).catch(() => fail());
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) fail('unsafe_entry');
  await fs.mkdir(backups, { recursive: true });
  const finalPath = path.join(backups, `Codex-Monitor-${version}`);
  const partPath = path.join(backups, `.Codex-Monitor-${version}.part-${crypto.randomUUID()}`);
  let ownsPart = false;
  try {
    await fs.access(finalPath).then(() => fail('backup_exists'), () => {});
    await fs.mkdir(partPath);
    ownsPart = true;
    const sourceFiles = await walkRegularFiles(source);
    for (const file of sourceFiles) {
      const destination = path.join(partPath, ...file.relative.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(file.absolute, destination, fs.constants.COPYFILE_EXCL);
    }
    const inventory = {
      schema: 1,
      product: 'Codex Monitor',
      version,
      files: await inventoryForDirectory(partPath),
    };
    const inventoryFile = await fs.open(path.join(partPath, INVENTORY_NAME), 'wx');
    try {
      await inventoryFile.writeFile(JSON.stringify(inventory));
      await inventoryFile.sync();
    } finally {
      await inventoryFile.close();
    }
    await fs.rename(partPath, finalPath);
    ownsPart = false;
    return { path: finalPath, inventory };
  } catch (error) {
    if (ownsPart) await fs.rm(partPath, { recursive: true, force: true }).catch(() => {});
    if (error instanceof WindowsUpdateError) throw error;
    fail();
  }
}

async function verifyRollbackSnapshot({ snapshotDirectory, expectedVersion }) {
  try {
    const root = path.resolve(snapshotDirectory);
    const raw = await fs.readFile(path.join(root, INVENTORY_NAME), 'utf8');
    let inventory;
    try {
      inventory = JSON.parse(raw);
    } catch {
      fail('invalid_inventory');
    }
    validateInventory(inventory, expectedVersion);
    if (raw !== JSON.stringify(inventory)) fail('invalid_inventory');
    const actualFiles = await inventoryForDirectory(root, { excludeInventory: true });
    if (JSON.stringify(actualFiles) !== JSON.stringify(inventory.files)) fail('snapshot_mismatch');
    return inventory;
  } catch (error) {
    if (error instanceof WindowsUpdateError) throw error;
    fail();
  }
}

async function restoreRollbackSnapshot({
  snapshotDirectory,
  destinationDirectory,
  expectedVersion,
}) {
  const snapshot = path.resolve(snapshotDirectory);
  const destination = path.resolve(destinationDirectory);
  const parent = path.dirname(destination);
  const partPath = path.join(parent, `.${path.basename(destination)}.part-${crypto.randomUUID()}`);
  let ownsPart = false;
  try {
    const inventory = await verifyRollbackSnapshot({ snapshotDirectory: snapshot, expectedVersion });
    await fs.access(destination).then(() => fail('destination_exists'), () => {});
    await fs.mkdir(partPath);
    ownsPart = true;
    for (const file of inventory.files) {
      const source = path.join(snapshot, ...file.path.split('/'));
      const target = path.join(partPath, ...file.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      const stats = await fs.lstat(target);
      if (!stats.isFile()
          || stats.isSymbolicLink()
          || stats.size !== file.sizeBytes
          || await hashFile(target) !== file.sha256) fail('snapshot_mismatch');
    }
    await fs.rename(partPath, destination);
    ownsPart = false;
    return { path: destination, inventory };
  } catch (error) {
    if (ownsPart) await fs.rm(partPath, { recursive: true, force: true }).catch(() => {});
    if (error instanceof WindowsUpdateError) throw error;
    fail();
  }
}

module.exports = {
  createRollbackSnapshot,
  restoreRollbackSnapshot,
  verifyRollbackSnapshot,
};
