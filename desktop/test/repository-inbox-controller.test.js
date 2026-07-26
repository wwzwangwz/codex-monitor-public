const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepositoryInboxController } = require('../src/lib/repository-inbox-controller');
const { RepositoryInboxError } = require('../src/lib/repository-inbox');

const METADATA = {
  commit: 'a'.repeat(40),
  committedAt: '2026-07-25T00:00:00.000Z',
  documents: [
    { path: 'PLATFORM_STATUS.md', blobSha: 'b'.repeat(40), changed: true },
    { path: 'docs/PROTOCOL.md', blobSha: 'c'.repeat(40), changed: false },
  ],
};

function configHarness(initial = {}) {
  let config = structuredClone(initial);
  return {
    readConfig: () => structuredClone(config),
    writeConfig: (next) => { config = structuredClone(next); },
    current: () => structuredClone(config),
  };
}

function credentialHarness(initial = null, persistent = true) {
  let token = initial;
  let stored = Boolean(initial && persistent);
  return {
    get: () => token,
    has: () => Boolean(token),
    isPersistent: () => stored,
    set: (value) => {
      token = value;
      stored = persistent;
      return { stored };
    },
    clear: () => {
      token = null;
      stored = false;
    },
  };
}

test('reports authentication required without calling the repository reader', async () => {
  let reads = 0;
  const controller = createRepositoryInboxController({
    reader: { read: async () => { reads += 1; } },
    credentialStore: credentialHarness(),
    ...configHarness(),
  });

  assert.deepEqual(controller.status(), {
    hasCredential: false,
    persistentCredential: false,
    refreshing: false,
    metadata: null,
    error: null,
  });
  const result = await controller.refresh();
  assert.equal(reads, 0);
  assert.equal(result.error.code, 'authentication_required');
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
});

test('serializes concurrent refreshes and caches only repository metadata', async () => {
  let resolveRead;
  let reads = 0;
  let readerInput;
  const config = configHarness({ machineName: 'DESKTOP' });
  const controller = createRepositoryInboxController({
    reader: {
      read: (input) => {
        reads += 1;
        readerInput = input;
        return new Promise((resolve) => { resolveRead = resolve; });
      },
    },
    credentialStore: credentialHarness('github_pat_private'),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  const first = controller.refresh();
  const second = controller.refresh();
  assert.equal(first, second);
  assert.equal(reads, 1);
  assert.equal(controller.status().refreshing, true);
  assert.deepEqual(readerInput.previousDocuments, {});
  assert.equal(readerInput.token, 'github_pat_private');

  resolveRead(structuredClone(METADATA));
  const result = await first;
  assert.equal(result.refreshing, false);
  assert.deepEqual(result.metadata, METADATA);
  assert.deepEqual(config.current(), {
    machineName: 'DESKTOP',
    repositoryInbox: {
      commit: METADATA.commit,
      committedAt: METADATA.committedAt,
      documents: METADATA.documents.map(({ path, blobSha }) => ({ path, blobSha })),
    },
  });
  assert.equal(JSON.stringify(config.current()).includes('github_pat_private'), false);
});

test('passes preceding blob identifiers into the next refresh', async () => {
  const config = configHarness({
    repositoryInbox: {
      commit: 'd'.repeat(40),
      committedAt: '2026-07-24T00:00:00.000Z',
      documents: [
        { path: 'PLATFORM_STATUS.md', blobSha: 'e'.repeat(40) },
        { path: 'docs/PROTOCOL.md', blobSha: 'f'.repeat(40) },
      ],
    },
  });
  let previousDocuments;
  const controller = createRepositoryInboxController({
    reader: {
      read: async (input) => {
        previousDocuments = input.previousDocuments;
        return structuredClone(METADATA);
      },
    },
    credentialStore: credentialHarness('secret'),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  const initial = controller.status();
  assert.equal(initial.metadata.documents.every((item) => item.changed === false), true);
  await controller.refresh();
  assert.deepEqual(previousDocuments, {
    'PLATFORM_STATUS.md': 'e'.repeat(40),
    'docs/PROTOCOL.md': 'f'.repeat(40),
  });
});

test('preserves the last successful metadata after a sanitized refresh failure', async () => {
  const config = configHarness({
    repositoryInbox: {
      commit: METADATA.commit,
      committedAt: METADATA.committedAt,
      documents: METADATA.documents.map(({ path, blobSha }) => ({ path, blobSha })),
    },
  });
  const controller = createRepositoryInboxController({
    reader: {
      read: async () => {
        throw new RepositoryInboxError('authentication_failed');
      },
    },
    credentialStore: credentialHarness('github_pat_private'),
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  const result = await controller.refresh();
  assert.equal(result.metadata.commit, METADATA.commit);
  assert.deepEqual(result.error, {
    code: 'authentication_failed',
    message: 'GitHub authentication failed',
  });
  assert.equal(JSON.stringify(result).includes('github_pat_private'), false);
  assert.deepEqual(config.current().repositoryInbox.documents, METADATA.documents.map(
    ({ path, blobSha }) => ({ path, blobSha }),
  ));
});

test('setting a credential refreshes immediately and clearing it preserves cached metadata', async () => {
  const config = configHarness();
  const credentialStore = credentialHarness(null, false);
  let receivedToken;
  const controller = createRepositoryInboxController({
    reader: {
      read: async ({ token }) => {
        receivedToken = token;
        return structuredClone(METADATA);
      },
    },
    credentialStore,
    readConfig: config.readConfig,
    writeConfig: config.writeConfig,
  });

  const connected = await controller.setToken('github_pat_memory');
  assert.equal(receivedToken, 'github_pat_memory');
  assert.equal(connected.hasCredential, true);
  assert.equal(connected.persistentCredential, false);
  assert.equal(JSON.stringify(connected).includes('github_pat_memory'), false);

  const cleared = controller.clearToken();
  assert.equal(cleared.hasCredential, false);
  assert.equal(cleared.persistentCredential, false);
  assert.equal(cleared.metadata.commit, METADATA.commit);
});

test('closing aborts an active refresh and rejects later refresh work', async () => {
  let observedSignal;
  const controller = createRepositoryInboxController({
    reader: {
      read: ({ signal }) => new Promise((_resolve, reject) => {
        observedSignal = signal;
        signal.addEventListener('abort', () => reject(new RepositoryInboxError('app_closing')));
      }),
    },
    credentialStore: credentialHarness('secret'),
    ...configHarness(),
  });

  const active = controller.refresh();
  controller.close();
  assert.equal(observedSignal.aborted, true);
  assert.equal((await active).error.code, 'app_closing');
  assert.equal((await controller.refresh()).error.code, 'app_closing');
});
