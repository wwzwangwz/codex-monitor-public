const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepositoryInboxView } = require('../src/renderer/repository-inbox');

function element() {
  const listeners = new Map();
  return {
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    dataset: {},
    addEventListener: (name, handler) => listeners.set(name, handler),
    dispatch: (name) => listeners.get(name)?.({ preventDefault() {} }),
  };
}

function elements() {
  return {
    root: element(),
    summary: element(),
    documents: {
      'PLATFORM_STATUS.md': {
        sha: element(),
        changed: element(),
      },
      'docs/PROTOCOL.md': {
        sha: element(),
        changed: element(),
      },
    },
    error: element(),
    refresh: element(),
    tokenForm: element(),
    tokenInput: element(),
    persistence: element(),
    clearToken: element(),
  };
}

const metadataStatus = {
  hasCredential: true,
  persistentCredential: true,
  refreshing: false,
  metadata: {
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    committedAt: '2026-07-25T00:00:00.000Z',
    documents: [
      {
        path: 'PLATFORM_STATUS.md',
        blobSha: '1111111222222222333333334444444455555555',
        changed: true,
      },
      {
        path: 'docs/PROTOCOL.md',
        blobSha: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee',
        changed: false,
      },
    ],
  },
  error: null,
};

test('shows credential entry without exposing repository controls as active', () => {
  const nodes = elements();
  const view = createRepositoryInboxView({ api: {}, elements: nodes });

  view.render({
    hasCredential: false,
    persistentCredential: false,
    refreshing: false,
    metadata: null,
    error: null,
  });

  assert.equal(nodes.tokenForm.hidden, false);
  assert.equal(nodes.clearToken.hidden, true);
  assert.equal(nodes.refresh.disabled, true);
  assert.equal(nodes.summary.textContent, '需要 GitHub 只读凭据');
  assert.equal(nodes.persistence.textContent, '');
});

test('renders commit and document metadata with independent NEW markers', () => {
  const nodes = elements();
  const view = createRepositoryInboxView({ api: {}, elements: nodes });

  view.render(metadataStatus);

  assert.match(nodes.summary.textContent, /^abcdef0 · /);
  assert.equal(nodes.tokenForm.hidden, true);
  assert.equal(nodes.clearToken.hidden, false);
  assert.equal(nodes.refresh.disabled, false);
  assert.equal(nodes.persistence.textContent, '凭据已由 Windows 加密保存');
  assert.equal(nodes.documents['PLATFORM_STATUS.md'].sha.textContent, '1111111');
  assert.equal(nodes.documents['PLATFORM_STATUS.md'].changed.hidden, false);
  assert.equal(nodes.documents['docs/PROTOCOL.md'].sha.textContent, 'aaaaaaa');
  assert.equal(nodes.documents['docs/PROTOCOL.md'].changed.hidden, true);
});

test('serializes refresh clicks and renders the final result', async () => {
  const nodes = elements();
  let calls = 0;
  let resolveRefresh;
  const view = createRepositoryInboxView({
    elements: nodes,
    api: {
      refreshRepositoryInbox: () => {
        calls += 1;
        return new Promise((resolve) => { resolveRefresh = resolve; });
      },
    },
  });

  const first = view.refresh();
  const second = view.refresh();
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(nodes.refresh.disabled, true);
  resolveRefresh(metadataStatus);
  await first;
  assert.equal(nodes.summary.textContent.startsWith('abcdef0'), true);
  assert.equal(nodes.refresh.disabled, false);
});

test('clears the password input immediately after submitting it', async () => {
  const nodes = elements();
  nodes.tokenInput.value = 'github_pat_private';
  let received;
  const view = createRepositoryInboxView({
    elements: nodes,
    api: {
      setRepositoryToken: async (token) => {
        received = token;
        return metadataStatus;
      },
    },
  });

  const pending = view.submitToken();
  assert.equal(nodes.tokenInput.value, '');
  await pending;
  assert.equal(received, 'github_pat_private');
  assert.equal(JSON.stringify(nodes).includes('github_pat_private'), false);
});

test('renders a bounded local error when IPC rejects', async () => {
  const nodes = elements();
  const view = createRepositoryInboxView({
    elements: nodes,
    api: {
      refreshRepositoryInbox: async () => {
        throw new Error('Bearer github_pat_private internal stack');
      },
    },
  });

  await view.refresh();
  assert.equal(nodes.error.hidden, false);
  assert.equal(nodes.error.textContent, '仓库收件箱暂时不可用');
  assert.equal(JSON.stringify(nodes).includes('github_pat_private'), false);
});

test('clears the credential without discarding cached metadata', async () => {
  const nodes = elements();
  const clearedStatus = {
    ...metadataStatus,
    hasCredential: false,
    persistentCredential: false,
  };
  const view = createRepositoryInboxView({
    elements: nodes,
    api: { clearRepositoryToken: async () => clearedStatus },
  });
  view.render(metadataStatus);

  await view.clearToken();

  assert.equal(nodes.tokenForm.hidden, false);
  assert.equal(nodes.summary.textContent.startsWith('abcdef0'), true);
  assert.equal(nodes.documents['PLATFORM_STATUS.md'].sha.textContent, '1111111');
});
