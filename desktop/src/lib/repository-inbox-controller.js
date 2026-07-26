const { sanitizeRepositoryError } = require('./repository-inbox');

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DOCUMENT_PATHS = new Set([
  'PLATFORM_STATUS.md',
  'docs/PROTOCOL.md',
]);

function cachedMetadata(config) {
  const value = config?.repositoryInbox;
  if (
    !SHA_PATTERN.test(value?.commit || '')
    || Number.isNaN(Date.parse(value?.committedAt || ''))
    || !Array.isArray(value?.documents)
  ) return null;
  const documents = value.documents.filter((item) => (
    DOCUMENT_PATHS.has(item?.path) && SHA_PATTERN.test(item?.blobSha || '')
  ));
  if (documents.length !== DOCUMENT_PATHS.size) return null;
  return {
    commit: value.commit,
    committedAt: new Date(value.committedAt).toISOString(),
    documents: documents.map((item) => ({ ...item, changed: false })),
  };
}

function persistedMetadata(metadata) {
  return {
    commit: metadata.commit,
    committedAt: metadata.committedAt,
    documents: metadata.documents.map(({ path, blobSha }) => ({ path, blobSha })),
  };
}

function previousDocuments(metadata) {
  return Object.fromEntries((metadata?.documents || []).map((item) => [item.path, item.blobSha]));
}

function createRepositoryInboxController({
  reader,
  credentialStore,
  readConfig,
  writeConfig,
}) {
  let metadata = cachedMetadata(readConfig());
  let error = null;
  let refreshing = false;
  let refreshPromise = null;
  let activeController = null;
  let generation = 0;
  let closed = false;

  function status() {
    return structuredClone({
      hasCredential: credentialStore.has(),
      persistentCredential: credentialStore.isPersistent(),
      refreshing,
      metadata,
      error,
    });
  }

  function refresh() {
    if (closed) {
      error = { code: 'app_closing', message: 'The application is closing' };
      return Promise.resolve(status());
    }
    if (refreshPromise) return refreshPromise;
    const token = credentialStore.get();
    if (!token) {
      error = {
        code: 'authentication_required',
        message: 'GitHub authentication is required',
      };
      return Promise.resolve(status());
    }
    const currentGeneration = generation;
    const controller = new AbortController();
    activeController = controller;
    refreshing = true;
    error = null;
    let request;
    try {
      request = reader.read({
        token,
        previousDocuments: previousDocuments(metadata),
        signal: controller.signal,
      });
    } catch (failure) {
      request = Promise.reject(failure);
    }
    const work = Promise.resolve(request).then((next) => {
      if (currentGeneration !== generation) return;
      metadata = structuredClone(next);
      const current = readConfig() || {};
      writeConfig({ ...current, repositoryInbox: persistedMetadata(metadata) });
      error = null;
    }).catch((failure) => {
      if (currentGeneration === generation) error = sanitizeRepositoryError(failure);
    });
    const result = work.then(() => {
      if (currentGeneration === generation) {
        refreshing = false;
        activeController = null;
        refreshPromise = null;
      }
      return status();
    });
    refreshPromise = result;
    return result;
  }

  function resetActiveRefresh() {
    generation += 1;
    activeController?.abort();
    activeController = null;
    refreshPromise = null;
    refreshing = false;
  }

  function setToken(token) {
    resetActiveRefresh();
    credentialStore.set(token);
    error = null;
    return refresh();
  }

  function clearToken() {
    resetActiveRefresh();
    credentialStore.clear();
    error = null;
    return status();
  }

  function close() {
    closed = true;
    resetActiveRefresh();
    error = { code: 'app_closing', message: 'The application is closing' };
  }

  return { status, refresh, setToken, clearToken, close };
}

module.exports = { createRepositoryInboxController };
