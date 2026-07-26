const API_ORIGIN = 'https://api.github.com';
const API_ROOT = `${API_ORIGIN}/repos/wwzwangwz/codex-monitor-public`;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 512 * 1024;
const DOCUMENTS = [
  { path: 'PLATFORM_STATUS.md', heading: '# 平台发布状态' },
  { path: 'docs/PROTOCOL.md', heading: '# Codex Monitor Shared Protocol' },
];

class RepositoryInboxError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryInboxError';
    this.code = code;
  }
}

function fail(code) {
  throw new RepositoryInboxError(code);
}

function errorMessage(code) {
  return {
    authentication_required: 'GitHub authentication is required',
    authentication_failed: 'GitHub authentication failed',
    repository_unavailable: 'The repository inbox is unavailable',
    invalid_response: 'GitHub returned an invalid repository response',
    request_timeout: 'The repository inbox request timed out',
    app_closing: 'The application is closing',
  }[code] || 'The repository inbox request failed';
}

function sanitizeRepositoryError(error) {
  const code = error instanceof RepositoryInboxError
    ? error.code
    : 'repository_unavailable';
  return { code, message: errorMessage(code) };
}

async function readBoundedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) fail('invalid_response');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        fail('invalid_response');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return fail('invalid_response');
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string') fail('invalid_response');
  const compact = value.replace(/\s/g, '');
  if (!compact || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    fail('invalid_response');
  }
  return Buffer.from(compact, 'base64');
}

function normalizePreviousDocuments(value) {
  if (!value || typeof value !== 'object') return {};
  return value;
}

function createRepositoryInboxReader({
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
} = {}) {
  async function request(url, token, externalSignal) {
    const target = new URL(url);
    if (target.origin !== API_ORIGIN) fail('invalid_response');
    const controller = new AbortController();
    const abort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'codex-monitor-windows-repository-inbox',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (externalSignal?.aborted) fail('app_closing');
          fail('request_timeout');
        }
        throw error;
      }
      if (response.status >= 300 && response.status < 400) fail('invalid_response');
      if (response.status === 401 || response.status === 403) fail('authentication_failed');
      if (!response.ok) fail('repository_unavailable');
      return parseJson(await readBoundedText(response, maxResponseBytes));
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  async function read({ token, previousDocuments, signal } = {}) {
    const credential = typeof token === 'string' ? token.trim() : '';
    if (!credential) fail('authentication_required');
    const commitResponse = await request(`${API_ROOT}/commits/main`, credential, signal);
    const commit = commitResponse?.sha;
    const committedAt = new Date(commitResponse?.commit?.committer?.date || '');
    if (!COMMIT_PATTERN.test(commit || '') || Number.isNaN(committedAt.getTime())) {
      fail('invalid_response');
    }
    const previous = normalizePreviousDocuments(previousDocuments);
    const documents = [];
    for (const expected of DOCUMENTS) {
      const response = await request(
        `${API_ROOT}/contents/${expected.path}?ref=${commit}`,
        credential,
        signal,
      );
      if (
        response?.type !== 'file'
        || response.path !== expected.path
        || response.encoding !== 'base64'
        || !COMMIT_PATTERN.test(response.sha || '')
      ) {
        fail('invalid_response');
      }
      const content = decodeBase64(response.content);
      if (content.length > maxDocumentBytes || response.size !== content.length) {
        fail('invalid_response');
      }
      if (!content.toString('utf8').startsWith(expected.heading)) fail('invalid_response');
      documents.push({
        path: expected.path,
        blobSha: response.sha,
        changed: previous[expected.path] !== response.sha,
      });
    }
    return {
      commit,
      committedAt: committedAt.toISOString(),
      documents,
    };
  }

  return { read };
}

module.exports = {
  RepositoryInboxError,
  createRepositoryInboxReader,
  sanitizeRepositoryError,
};
