const WebSocket = require('ws');
const {
  CdpClient,
  assertLoopbackUrl,
  isCodexMainPage,
} = require('./native-guidance');

const DEBUG_ENDPOINT = 'http://127.0.0.1:9229/json/list';
const TURN_STATUSES = new Set(['inProgress', 'completed', 'failed', 'interrupted']);

async function readTurnBatch(dispatcher, actionName, candidateIds, timeoutMs) {
  const results = await Promise.all(candidateIds.map(async (threadId) => {
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout', threadId }), timeoutMs);
    });
    const requested = Promise.resolve().then(() => dispatcher(actionName, {
      hostId: 'local',
      method: 'thread/turns/list',
      params: {
        threadId,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      },
    })).then((response) => {
      const turn = Array.isArray(response?.data) ? response.data[0] || null : null;
      if (!turn) return { kind: 'empty', threadId };
      const errorMessage = turn.error == null
        ? null
        : String(turn.error?.message || turn.error).slice(0, 300);
      return {
        kind: 'turn',
        threadId,
        turn: {
          threadId,
          id: turn.id,
          status: turn.status,
          startedAt: turn.startedAt ?? null,
          completedAt: turn.completedAt ?? null,
          error: errorMessage ? { message: errorMessage } : null,
        },
      };
    }, () => ({ kind: 'failed', threadId }));
    const result = await Promise.race([requested, timedOut]);
    clearTimeout(timer);
    return result;
  }));
  return {
    turns: results.filter((result) => result.kind === 'turn').map((result) => result.turn),
    timedOutThreadIds: results
      .filter((result) => result.kind === 'timeout')
      .map((result) => result.threadId),
  };
}

async function readNativeTurns(
  candidateIds,
  cachedResolution,
  perThreadTimeoutMs,
  batchReader,
) {
  const actionName = 'send-cli-request-for-host';
  const modulePath = [...document.querySelectorAll('link[rel="modulepreload"]')]
    .map((link) => link.getAttribute('href'))
    .find((href) => /assets\/app-initial-[^/]+\.js$/.test(href || ''));
  if (!modulePath) return { ok: false, reason: 'module_not_found' };
  const moduleHref = location.origin + '/' + modulePath.replace(/^\.\//, '');

  let exportKey = cachedResolution?.moduleHref === moduleHref
    ? cachedResolution.exportKey
    : null;
  let appModule = await import(moduleHref);
  let dispatcher = exportKey ? appModule[exportKey] : null;
  if (typeof dispatcher !== 'function') {
    const source = await (await fetch(moduleHref)).text();
    const marker = String.fromCharCode(96) + actionName + String.fromCharCode(96);
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return { ok: false, reason: 'native_action_not_found' };
    const prefix = source.slice(Math.max(0, markerIndex - 100), markerIndex);
    const localMatch = prefix.match(/([A-Za-z_$][\w$]*)\($/);
    if (!localMatch) return { ok: false, reason: 'dispatcher_local_not_found' };
    const exportStart = source.lastIndexOf('export{');
    if (exportStart < 0) return { ok: false, reason: 'dispatcher_export_not_found' };
    const exportPair = source.slice(exportStart + 7).split(',')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${localMatch[1]} as `));
    exportKey = exportPair?.slice(`${localMatch[1]} as `.length)
      .match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (!exportKey) return { ok: false, reason: 'dispatcher_export_not_found' };
    appModule = await import(moduleHref);
    dispatcher = appModule[exportKey];
    if (typeof dispatcher !== 'function') {
      return { ok: false, reason: 'dispatcher_export_not_found' };
    }
  }

  const batch = await batchReader(
    dispatcher,
    actionName,
    candidateIds,
    perThreadTimeoutMs,
  );
  return {
    ok: true,
    resolution: { moduleHref, exportKey },
    turns: batch.turns,
    timedOutThreadIds: batch.timedOutThreadIds,
  };
}

function normalizeTurnRecord(turn) {
  const threadId = String(turn?.threadId || '').trim();
  const id = String(turn?.id || '').trim();
  const status = String(turn?.status || '').trim();
  if (!threadId || !id || !TURN_STATUSES.has(status)) return null;
  const startedAt = Number(turn.startedAt);
  const completedAt = turn.completedAt == null ? null : Number(turn.completedAt);
  return {
    threadId,
    value: {
      id,
      status,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      completedAt: Number.isFinite(completedAt) ? completedAt : null,
      error: turn.error ?? null,
    },
  };
}

function createNativeTurnStore(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const debugEndpoint = options.debugEndpoint
    || process.env.CODEX_DESKTOP_DEBUG_URL
    || DEBUG_ENDPOINT;
  const perThreadTimeoutMs = Math.max(1, Number(options.perThreadTimeoutMs) || 8_000);
  const timeoutMs = Math.max(
    perThreadTimeoutMs + 1_000,
    Number(options.timeoutMs) || 12_000,
  );
  const now = options.now || Date.now;
  const refreshIntervalMs = options.refreshIntervalMs == null
    ? 3_000
    : Math.max(0, Number(options.refreshIntervalMs) || 0);
  const timeoutBackoffMs = options.timeoutBackoffMs == null
    ? 60_000
    : Math.max(0, Number(options.timeoutBackoffMs) || 0);
  let statuses = new Map();
  let refreshing = null;
  let lastCandidateKey = null;
  let lastRefreshAt = -Infinity;
  const timeoutUntil = new Map();
  let pageKey = null;
  let resolution = null;

  const read = async (ids) => {
    const endpoint = assertLoopbackUrl(debugEndpoint, ['http:', 'https:']);
    let pages;
    try {
      const response = await fetchImpl(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      pages = await response.json();
    } catch {
      throw new Error('cannot connect to the Codex desktop native turn channel');
    }
    const page = pages.find(isCodexMainPage);
    if (!page) throw new Error('cannot find the Codex desktop main window');
    const nextPageKey = String(page.webSocketDebuggerUrl || '');
    if (pageKey !== nextPageKey) {
      pageKey = nextPageKey;
      resolution = null;
    }

    const cdp = new CdpClient(assertLoopbackUrl(nextPageKey, ['ws:', 'wss:']), {
      WebSocketImpl,
      timeoutMs,
    });
    try {
      await cdp.open();
      const expression = `(async () => {
        const batchReader = ${readTurnBatch.toString()};
        return (${readNativeTurns.toString()})(
          ${JSON.stringify(ids)},
          ${JSON.stringify(resolution)},
          ${perThreadTimeoutMs},
          batchReader
        );
      })()`;
      const result = await cdp.evaluate(expression);
      if (!result?.ok) {
        resolution = null;
        throw new Error(`Codex desktop native turn action is unavailable: ${result?.reason || 'unknown'}`);
      }
      resolution = result.resolution || null;
      return {
        turns: Array.isArray(result.turns) ? result.turns : [],
        timedOutThreadIds: Array.isArray(result.timedOutThreadIds)
          ? result.timedOutThreadIds
          : [],
      };
    } finally {
      cdp.close();
    }
  };

  const refresh = (sessionIds) => {
    if (refreshing) return refreshing;
    const ids = [...new Set((sessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
      .sort();
    const candidateKey = ids.join('\0');
    const currentTime = Number(now());
    if (
      candidateKey === lastCandidateKey
      && Number.isFinite(currentTime)
      && currentTime - lastRefreshAt < refreshIntervalMs
    ) {
      return Promise.resolve(statuses);
    }
    const previous = statuses;
    lastCandidateKey = candidateKey;
    lastRefreshAt = Number.isFinite(currentTime) ? currentTime : Date.now();
    const idSet = new Set(ids);
    for (const threadId of timeoutUntil.keys()) {
      if (!idSet.has(threadId)) timeoutUntil.delete(threadId);
    }
    const eligibleIds = ids.filter((threadId) => (
      (timeoutUntil.get(threadId) ?? -Infinity) <= lastRefreshAt
    ));
    if (!eligibleIds.length) {
      statuses = new Map(
        ids.filter((threadId) => previous.has(threadId))
          .map((threadId) => [threadId, previous.get(threadId)]),
      );
      return Promise.resolve(statuses);
    }
    refreshing = read(eligibleIds).then(({ turns, timedOutThreadIds }) => {
      const timedOut = new Set(timedOutThreadIds);
      const completedAt = Number(now());
      const backoffStartedAt = Number.isFinite(completedAt) ? completedAt : Date.now();
      for (const threadId of eligibleIds) {
        if (timedOut.has(threadId)) {
          timeoutUntil.set(threadId, backoffStartedAt + timeoutBackoffMs);
        } else {
          timeoutUntil.delete(threadId);
        }
      }
      const returned = new Map(
        turns
          .map(normalizeTurnRecord)
          .filter(Boolean)
          .map((turn) => [turn.threadId, turn.value]),
      );
      statuses = new Map(ids.map((threadId) => (
        returned.has(threadId)
          ? [threadId, returned.get(threadId)]
          : previous.has(threadId) ? [threadId, previous.get(threadId)] : null
      )).filter(Boolean));
      return statuses;
    }).catch(() => {
      statuses = new Map(
        ids.filter((threadId) => previous.has(threadId))
          .map((threadId) => [threadId, previous.get(threadId)]),
      );
      return statuses;
    }).finally(() => { refreshing = null; });
    return refreshing;
  };

  return {
    current: () => statuses,
    refresh,
  };
}

module.exports = {
  createNativeTurnStore,
  readTurnBatch,
};
