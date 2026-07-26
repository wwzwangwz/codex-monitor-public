const test = require('node:test');
const assert = require('node:assert/strict');

const { createGitHubCredentialStore } = require('../src/lib/github-credential');

function encryptedSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
    decryptString: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('protected:')) throw new Error('invalid ciphertext');
      return text.slice('protected:'.length);
    },
  };
}

function configHarness(initial = {}) {
  let config = structuredClone(initial);
  return {
    readConfig: () => structuredClone(config),
    writeConfig: (next) => { config = structuredClone(next); },
    current: () => structuredClone(config),
  };
}

test('persists only safeStorage ciphertext and reads the credential in the main process', () => {
  const config = configHarness({ machineName: 'DESKTOP' });
  const store = createGitHubCredentialStore({
    safeStorage: encryptedSafeStorage(),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  assert.deepEqual(store.set('github_pat_read_only'), { stored: true });
  assert.equal(store.get(), 'github_pat_read_only');
  assert.equal(store.has(), true);
  assert.equal(store.isPersistent(), true);
  assert.deepEqual(config.current(), {
    machineName: 'DESKTOP',
    githubTokenEncrypted: Buffer.from('protected:github_pat_read_only').toString('base64'),
  });
  assert.equal(JSON.stringify(config.current()).includes('github_pat_read_only'), false);
});

test('reloads a persisted credential without exposing plaintext through status methods', () => {
  const config = configHarness({
    githubTokenEncrypted: Buffer.from('protected:github_pat_existing').toString('base64'),
  });
  const store = createGitHubCredentialStore({
    safeStorage: encryptedSafeStorage(),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  assert.equal(store.get(), 'github_pat_existing');
  assert.equal(store.has(), true);
  assert.equal(store.isPersistent(), true);
  assert.equal(JSON.stringify({ has: store.has(), persistent: store.isPersistent() }).includes('github_pat'), false);
});

test('keeps a credential in memory only when OS encryption is unavailable', () => {
  const config = configHarness({ machineId: 'machine-1' });
  const store = createGitHubCredentialStore({
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('must not encrypt'); },
      decryptString: () => { throw new Error('must not decrypt'); },
    },
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  assert.deepEqual(store.set('github_pat_memory'), { stored: false });
  assert.equal(store.get(), 'github_pat_memory');
  assert.equal(store.has(), true);
  assert.equal(store.isPersistent(), false);
  assert.deepEqual(config.current(), { machineId: 'machine-1' });
});

test('falls back to memory without writing plaintext when encryption fails', () => {
  const config = configHarness({ selected: ['thread-1'] });
  const store = createGitHubCredentialStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('Windows credential service failed'); },
      decryptString: () => '',
    },
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  assert.deepEqual(store.set('github_pat_memory'), { stored: false });
  assert.equal(store.get(), 'github_pat_memory');
  assert.deepEqual(config.current(), { selected: ['thread-1'] });
});

test('a corrupt ciphertext is unavailable without changing unrelated config', () => {
  const initial = {
    machineName: 'DESKTOP',
    selected: ['thread-1'],
    githubTokenEncrypted: Buffer.from('corrupt').toString('base64'),
  };
  const config = configHarness(initial);
  const store = createGitHubCredentialStore({
    safeStorage: encryptedSafeStorage(),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  assert.equal(store.get(), null);
  assert.equal(store.has(), false);
  assert.equal(store.isPersistent(), false);
  assert.deepEqual(config.current(), initial);
});

test('replacing and clearing a credential preserves every unrelated config field', () => {
  const config = configHarness({
    machineId: 'machine-1',
    selected: ['thread-1'],
    githubTokenEncrypted: Buffer.from('protected:github_pat_old').toString('base64'),
  });
  const store = createGitHubCredentialStore({
    safeStorage: encryptedSafeStorage(),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  store.set('github_pat_new');
  assert.equal(store.get(), 'github_pat_new');
  store.clear();

  assert.equal(store.get(), null);
  assert.equal(store.has(), false);
  assert.equal(store.isPersistent(), false);
  assert.deepEqual(config.current(), {
    machineId: 'machine-1',
    selected: ['thread-1'],
  });
});

test('rejects empty, oversized, and control-character credentials', () => {
  const config = configHarness();
  const store = createGitHubCredentialStore({
    safeStorage: encryptedSafeStorage(),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  for (const value of ['', '   ', `github_${'x'.repeat(600)}`, 'github\npat']) {
    assert.throws(() => store.set(value), /credential format is invalid/);
  }
  assert.deepEqual(config.current(), {});
});
