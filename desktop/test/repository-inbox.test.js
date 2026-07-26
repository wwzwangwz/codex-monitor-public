const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRepositoryInboxReader,
  sanitizeRepositoryError,
} = require('../src/lib/repository-inbox');

const COMMIT = 'a'.repeat(40);
const BACKLOG_SHA = 'b'.repeat(40);
const WINDOWS_TASK_SHA = 'c'.repeat(40);

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fileResponse(path, sha, contents) {
  return jsonResponse({
    type: 'file',
    encoding: 'base64',
    path,
    sha,
    size: Buffer.byteLength(contents),
    content: Buffer.from(contents).toString('base64'),
  });
}

function successfulResponses() {
  return [
    jsonResponse({
      sha: COMMIT,
      commit: { committer: { date: '2026-07-25T00:00:00Z' } },
    }),
    fileResponse(
      'PLATFORM_STATUS.md',
      BACKLOG_SHA,
      '# 平台发布状态\n\nCurrent priorities.',
    ),
    fileResponse(
      'docs/PROTOCOL.md',
      WINDOWS_TASK_SHA,
      '# Codex Monitor Shared Protocol\n\nCurrent Windows task.',
    ),
  ];
}

function sequenceFetch(responses, calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const response = responses.shift();
    if (!response) throw new Error('unexpected extra request');
    return response;
  };
}

test('pins both inbox documents to one resolved main commit', async () => {
  const calls = [];
  const reader = createRepositoryInboxReader({
    fetchImpl: sequenceFetch(successfulResponses(), calls),
  });

  const result = await reader.read({
    token: 'github_pat_read_only',
    previousDocuments: {
      'PLATFORM_STATUS.md': BACKLOG_SHA,
      'docs/PROTOCOL.md': 'd'.repeat(40),
    },
  });

  assert.deepEqual(result, {
    commit: COMMIT,
    committedAt: '2026-07-25T00:00:00.000Z',
    documents: [
      {
        path: 'PLATFORM_STATUS.md',
        blobSha: BACKLOG_SHA,
        changed: false,
      },
      {
        path: 'docs/PROTOCOL.md',
        blobSha: WINDOWS_TASK_SHA,
        changed: true,
      },
    ],
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/repos\/wwzwangwz\/codex-monitor-public\/commits\/main$/);
  assert.ok(calls.slice(1).every(({ url }) => url.endsWith(`?ref=${COMMIT}`)));
  assert.ok(calls.every(({ options }) => options.redirect === 'manual'));
  assert.ok(calls.every(({ options }) => (
    options.headers.Authorization === 'Bearer github_pat_read_only'
  )));
});

test('requires a configured repository credential before any request', async () => {
  let called = false;
  const reader = createRepositoryInboxReader({
    fetchImpl: async () => { called = true; },
  });

  await assert.rejects(reader.read({ token: '  ' }), (error) => {
    assert.equal(error.code, 'authentication_required');
    return true;
  });
  assert.equal(called, false);
});

test('classifies authentication failures without exposing the response body', async () => {
  const secretBody = 'token fingerprint and private server diagnostics';
  const reader = createRepositoryInboxReader({
    fetchImpl: sequenceFetch([new Response(secretBody, { status: 401 })]),
  });

  await assert.rejects(reader.read({ token: 'github_pat_private' }), (error) => {
    const sanitized = sanitizeRepositoryError(error);
    assert.deepEqual(sanitized, {
      code: 'authentication_failed',
      message: 'GitHub authentication failed',
    });
    assert.equal(JSON.stringify(sanitized).includes(secretBody), false);
    assert.equal(JSON.stringify(sanitized).includes('github_pat_private'), false);
    return true;
  });
});

test('rejects redirects before sending document requests to another origin', async () => {
  const calls = [];
  const reader = createRepositoryInboxReader({
    fetchImpl: sequenceFetch([
      new Response('', { status: 302, headers: { location: 'https://example.com/private' } }),
    ], calls),
  });

  await assert.rejects(reader.read({ token: 'secret' }), (error) => {
    assert.equal(error.code, 'invalid_response');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('aborts a repository request at the configured timeout', async () => {
  const reader = createRepositoryInboxReader({
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  await assert.rejects(reader.read({ token: 'secret' }), (error) => {
    assert.equal(error.code, 'request_timeout');
    return true;
  });
});

test('rejects a response body larger than the configured byte limit', async () => {
  const reader = createRepositoryInboxReader({
    maxResponseBytes: 64,
    fetchImpl: sequenceFetch([
      new Response('x'.repeat(65), { status: 200 }),
    ]),
  });

  await assert.rejects(reader.read({ token: 'secret' }), (error) => {
    assert.equal(error.code, 'invalid_response');
    return true;
  });
});

test('rejects malformed commit and file responses', async (t) => {
  const cases = [
    {
      name: 'invalid commit SHA',
      responses: [jsonResponse({ sha: 'main', commit: { committer: { date: '2026-07-25T00:00:00Z' } } })],
    },
    {
      name: 'wrong file path',
      responses: [
        ...successfulResponses().slice(0, 1),
        fileResponse('docs/OTHER.md', BACKLOG_SHA, '# Codex Monitor\n'),
      ],
    },
    {
      name: 'directory in place of file',
      responses: [
        ...successfulResponses().slice(0, 1),
        jsonResponse({ type: 'dir', path: 'PLATFORM_STATUS.md', sha: BACKLOG_SHA }),
      ],
    },
    {
      name: 'malformed Base64',
      responses: [
        ...successfulResponses().slice(0, 1),
        jsonResponse({
          type: 'file',
          encoding: 'base64',
          path: 'PLATFORM_STATUS.md',
          sha: BACKLOG_SHA,
          size: 3,
          content: '***',
        }),
      ],
    },
    {
      name: 'missing Markdown heading',
      responses: [
        ...successfulResponses().slice(0, 1),
        fileResponse('PLATFORM_STATUS.md', BACKLOG_SHA, 'not markdown'),
      ],
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const reader = createRepositoryInboxReader({
        fetchImpl: sequenceFetch([...fixture.responses]),
      });
      await assert.rejects(reader.read({ token: 'secret' }), (error) => {
        assert.equal(error.code, 'invalid_response');
        return true;
      });
    });
  }
});

test('rejects decoded document content above the configured limit', async () => {
  const reader = createRepositoryInboxReader({
    maxDocumentBytes: 32,
    fetchImpl: sequenceFetch([
      ...successfulResponses().slice(0, 1),
      fileResponse(
        'PLATFORM_STATUS.md',
        BACKLOG_SHA,
        `# Codex Monitor\n${'x'.repeat(40)}`,
      ),
    ]),
  });

  await assert.rejects(reader.read({ token: 'secret' }), (error) => {
    assert.equal(error.code, 'invalid_response');
    return true;
  });
});
