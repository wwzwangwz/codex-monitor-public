const TOKEN_MAX_LENGTH = 512;

function validToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= TOKEN_MAX_LENGTH
    && value === value.trim()
    && !/[\x00-\x20\x7f]/.test(value);
}

function createGitHubCredentialStore({ safeStorage, readConfig, writeConfig }) {
  let loaded = false;
  let token = null;
  let persistent = false;

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    const encrypted = readConfig()?.githubTokenEncrypted;
    if (typeof encrypted !== 'string' || !encrypted || !encryptionAvailable()) return;
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (!validToken(decrypted)) return;
      token = decrypted;
      persistent = true;
    } catch {
      token = null;
      persistent = false;
    }
  }

  function removePersistedCredential() {
    const current = readConfig() || {};
    if (!Object.hasOwn(current, 'githubTokenEncrypted')) return;
    const next = { ...current };
    delete next.githubTokenEncrypted;
    writeConfig(next);
  }

  function get() {
    load();
    return token;
  }

  function set(value) {
    if (!validToken(value)) throw new Error('GitHub credential format is invalid');
    loaded = true;
    token = value;
    persistent = false;
    if (encryptionAvailable()) {
      try {
        const ciphertext = safeStorage.encryptString(value);
        if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
          throw new Error('safeStorage returned no ciphertext');
        }
        const current = readConfig() || {};
        writeConfig({
          ...current,
          githubTokenEncrypted: ciphertext.toString('base64'),
        });
        persistent = true;
        return { stored: true };
      } catch {
        persistent = false;
      }
    }
    removePersistedCredential();
    return { stored: false };
  }

  function clear() {
    loaded = true;
    token = null;
    persistent = false;
    removePersistedCredential();
  }

  return {
    get,
    has: () => Boolean(get()),
    set,
    clear,
    isPersistent: () => {
      load();
      return persistent;
    },
  };
}

module.exports = { createGitHubCredentialStore };
