const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_SNAPSHOT_TTL_MS = 60_000;
const DEFAULT_PUSH_REMINDER_MS = 60_000;
const DEVICE_MESSAGE_TYPES = new Set([
  'snapshot', 'guidance_ack', 'guidance_result', 'goal_command_ack', 'goal_command_result', 'evidence_response',
]);
const PHONE_MESSAGE_TYPES = new Set(['guidance', 'goal_command', 'client_info', 'push_registration']);
const SESSION_STATES = new Set(['running', 'blocked', 'completed', 'unknown']);

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseEndpoint(request) {
  const url = new URL(request.url, 'http://relay.local');
  const match = url.pathname.match(/^\/relay\/(device|phone)\/([0-9a-f-]{8,80})$/i);
  if (!match) return null;
  return { role: match[1], deviceId: match[2], token: url.searchParams.get('token') || '' };
}

function createRelayServer({
  deviceTokens,
  preferredPort = 0,
  host = '127.0.0.1',
  snapshotTtlMs = DEFAULT_SNAPSHOT_TTL_MS,
  evidenceTimeoutMs = 10_000,
  pushReminderMs = DEFAULT_PUSH_REMINDER_MS,
  sendPush = null,
  now = Date.now,
} = {}) {
  const tokens = deviceTokens instanceof Map ? deviceTokens : new Map(Object.entries(deviceTokens || {}));
  const channels = new Map();
  const pendingEvidence = new Map();
  function deviceIdForToken(value) {
    let match = null;
    for (const [deviceId, token] of tokens) {
      if (!safeEqual(value, token)) continue;
      if (match) return null;
      match = deviceId;
    }
    return match;
  }
  function failPendingEvidence(deviceId, status, error) {
    for (const [requestId, pending] of pendingEvidence) {
      if (pending.deviceId !== deviceId) continue;
      pendingEvidence.delete(requestId);
      clearTimeout(pending.timer);
      if (!pending.response.writableEnded) {
        pending.response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        pending.response.end(JSON.stringify({ error }));
      }
    }
  }
  function registerPushTarget(channel, value) {
    const platform = value.platform === 'android' ? 'android' : value.platform === 'ios' ? 'ios' : '';
    const pushToken = typeof value.pushToken === 'string' ? value.pushToken.trim() : '';
    if (!platform || pushToken.length < 16 || pushToken.length > 4096) {
      return { type: 'push_registration_result', ok: false, message: '推送注册信息无效' };
    }
    if (value.enabled !== false && typeof sendPush !== 'function') {
      return { type: 'push_registration_result', ok: false, message: '远程中继尚未配置系统推送' };
    }
    const key = `${platform}:${pushToken}`;
    if (value.enabled === false) {
      channel.pushTargets.delete(key);
      clearPendingPushes(channel, key);
    } else {
      channel.pushTargets.set(key, {
        platform,
        pushToken,
        silentCompletionSessionIds: Array.isArray(value.silentCompletionSessionIds)
          ? value.silentCompletionSessionIds.slice(0, 50).map((item) => String(item).slice(0, 80))
          : [],
      });
    }
    return {
      type: 'push_registration_result', ok: true,
      message: value.enabled === false ? '系统推送已注销' : '系统推送已注册',
    };
  }
  function clearPendingPushes(channel, targetKey, sessionId = null) {
    const prefix = `${targetKey}:`;
    for (const [key, pending] of channel.pendingPushes) {
      if (!key.startsWith(prefix) || (sessionId && pending.event.sessionId !== sessionId)) continue;
      clearTimeout(pending.timer);
      channel.pendingPushes.delete(key);
    }
  }
  function rememberUnreadPush(channel, targetKey, event) {
    const key = `${targetKey}:${event.sessionId}`;
    const previous = channel.pendingPushes.get(key);
    if (previous) clearTimeout(previous.timer);
    const pending = { event, timer: null };
    const remind = () => {
      if (channel.pendingPushes.get(key) !== pending) return;
      const target = channel.pushTargets.get(targetKey);
      if (!target || typeof sendPush !== 'function') {
        channel.pendingPushes.delete(key);
        return;
      }
      Promise.resolve(sendPush(target, { ...pending.event, reminder: true })).catch(() => {});
      pending.timer = setTimeout(remind, pushReminderMs);
    };
    pending.timer = setTimeout(remind, pushReminderMs);
    channel.pendingPushes.set(key, pending);
  }
  function acknowledgePushRead(channel, value) {
    const platform = value.platform === 'android' ? 'android' : value.platform === 'ios' ? 'ios' : '';
    const pushToken = typeof value.pushToken === 'string' ? value.pushToken.trim() : '';
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
    const state = typeof value.state === 'string' ? value.state : '';
    if (!platform || pushToken.length < 16 || pushToken.length > 4096 || !sessionId
      || sessionId.length > 80 || !SESSION_STATES.has(state)) {
      return { type: 'push_read_result', ok: false, message: '已读确认信息无效' };
    }
    const targetKey = `${platform}:${pushToken}`;
    if (!channel.pushTargets.has(targetKey)) {
      return { type: 'push_read_result', ok: false, message: '推送设备尚未注册' };
    }
    const pending = channel.pendingPushes.get(`${targetKey}:${sessionId}`);
    if (pending?.event.toState === state) clearPendingPushes(channel, targetKey, sessionId);
    return { type: 'push_read_result', ok: true, message: '未读提醒已清除' };
  }
  const httpServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://relay.local');
    if (url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const pushMatch = url.pathname.match(/^\/push\/register\/([0-9a-f-]{8,80})$/i);
    const pushReadMatch = url.pathname.match(/^\/push\/read\/([0-9a-f-]{8,80})$/i);
    if ((pushMatch || pushReadMatch) && request.method === 'POST') {
      const deviceId = (pushMatch || pushReadMatch)[1];
      const expected = tokens.get(deviceId);
      const credential = url.searchParams.get('token')
        || String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!expected || !safeEqual(credential, expected)) {
        response.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      request.on('end', () => {
        let value;
        try { value = JSON.parse(body); } catch {
          response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }
        const result = pushMatch
          ? registerPushTarget(channelFor(deviceId), value || {})
          : acknowledgePushRead(channelFor(deviceId), value || {});
        response.writeHead(result.ok ? 200 : pushMatch ? 503 : 400, {
          'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        });
        response.end(JSON.stringify(result));
      });
      return;
    }
    const evidenceMatch = url.pathname.match(/^\/evidence\/([a-f0-9]{32})$/);
    if (evidenceMatch) {
      const credential = url.searchParams.get('token')
        || String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const deviceId = deviceIdForToken(credential);
      const channel = deviceId && channels.get(deviceId);
      if (!deviceId) {
        response.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (channel?.device?.readyState !== WebSocket.OPEN) {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: 'device_offline' }));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingEvidence.delete(requestId);
        if (!response.writableEnded) {
          response.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ error: 'evidence_timeout' }));
        }
      }, evidenceTimeoutMs);
      pendingEvidence.set(requestId, { response, timer, deviceId });
      response.once('close', () => {
        const pending = pendingEvidence.get(requestId);
        if (pending?.response !== response) return;
        clearTimeout(pending.timer);
        pendingEvidence.delete(requestId);
      });
      send(channel.device, { type: 'evidence_request', requestId, evidenceId: evidenceMatch[1] });
      return;
    }
    response.writeHead(404).end();
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  function channelFor(deviceId) {
    if (!channels.has(deviceId)) {
      channels.set(deviceId, {
        device: null, phones: new Set(), snapshot: null, snapshotAt: 0,
        sessionStates: null, pushTargets: new Map(), pendingPushes: new Map(),
      });
    }
    return channels.get(deviceId);
  }

  function send(socket, value) {
    if (socket.readyState === WebSocket.OPEN) socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }

  function offlineResult(value) {
    if (value.type === 'guidance') {
      return {
        type: 'guidance_result', requestId: value.requestId, sessionId: value.sessionId,
        ok: false, message: '远程电脑当前不在线',
      };
    }
    if (value.type === 'goal_command') {
      return {
        type: 'goal_command_result', requestId: value.requestId, sessionId: value.sessionId,
        command: value.command, ok: false, message: '远程电脑当前不在线',
      };
    }
    return null;
  }

  function updateSessionStates(channel, snapshotValue, deviceId) {
    const next = new Map();
    for (const session of snapshotValue.sessions) {
      if (!session || typeof session.id !== 'string' || !SESSION_STATES.has(session.state)) continue;
      next.set(session.id, {
        state: session.state,
        title: String(session.title || 'Codex 会话').slice(0, 160),
      });
    }
    if (channel.sessionStates) {
      for (const [sessionId, current] of next) {
        const previous = channel.sessionStates.get(sessionId);
        if (!previous || previous.state === current.state) continue;
        const event = {
          type: 'lamp_changed',
          deviceId,
          deviceName: String(snapshotValue.machine?.name || '电脑').slice(0, 80),
          sessionId,
          sessionTitle: current.title,
          fromState: previous.state,
          toState: current.state,
          changedAt: new Date(now()).toISOString(),
        };
        for (const target of channel.pushTargets.values()) {
          const targetKey = `${target.platform}:${target.pushToken}`;
          const silent = previous.state === 'running' && current.state === 'completed'
            && target.silentCompletionSessionIds.includes(sessionId);
          if (typeof sendPush === 'function') {
            const targetEvent = { ...event, silent, reminder: false };
            Promise.resolve(sendPush(target, targetEvent)).catch(() => {});
            rememberUnreadPush(channel, targetKey, targetEvent);
          }
        }
      }
    }
    if (channel.sessionStates) {
      for (const previousSessionId of channel.sessionStates.keys()) {
        if (next.has(previousSessionId)) continue;
        for (const targetKey of channel.pushTargets.keys()) clearPendingPushes(channel, targetKey, previousSessionId);
      }
    }
    channel.sessionStates = next;
  }

  websocketServer.on('connection', (socket, request, endpoint) => {
    const channel = channelFor(endpoint.deviceId);
    socket.relayRole = endpoint.role;
    socket.deviceId = endpoint.deviceId;
    if (endpoint.role === 'device') {
      if (channel.device && channel.device !== socket) channel.device.close(4001, 'Replaced by a newer device connection');
      channel.device = socket;
    } else {
      channel.phones.add(socket);
      if (channel.snapshot && now() - channel.snapshotAt <= snapshotTtlMs) send(socket, channel.snapshot);
    }

    socket.on('message', (data, binary) => {
      if (binary || data.length > MAX_MESSAGE_BYTES) return socket.close(1003, 'Text JSON only');
      const raw = data.toString('utf8');
      let value;
      try { value = JSON.parse(raw); } catch { return socket.close(1007, 'Invalid JSON'); }
      if (!value || typeof value !== 'object' || typeof value.type !== 'string') return;

      if (endpoint.role === 'device') {
        if (!DEVICE_MESSAGE_TYPES.has(value.type)) return;
        if (value.type === 'evidence_response') {
          const requestId = String(value.requestId || '');
          const pending = pendingEvidence.get(requestId);
          if (!pending || pending.deviceId !== endpoint.deviceId) return;
          pendingEvidence.delete(requestId);
          clearTimeout(pending.timer);
          const { response } = pending;
          if (!value.ok) {
            response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ error: 'not_found' }));
            return;
          }
          const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(value.mimeType) ? value.mimeType : '';
          const encoded = typeof value.dataBase64 === 'string' ? value.dataBase64 : '';
          const data = Buffer.from(encoded, 'base64');
          const validBase64 = encoded.length > 0
            && data.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, '');
          if (!mimeType || !validBase64 || data.length > MAX_EVIDENCE_BYTES) {
            response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ error: 'invalid_evidence' }));
            return;
          }
          response.writeHead(200, {
            'Content-Type': mimeType,
            'Content-Length': data.length,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(data);
          return;
        }
        if (value.type === 'snapshot') {
          if (value.machine?.id !== endpoint.deviceId || !Array.isArray(value.sessions)) return;
          updateSessionStates(channel, value, endpoint.deviceId);
          channel.snapshot = raw;
          channel.snapshotAt = now();
        }
        for (const phone of channel.phones) send(phone, raw);
        return;
      }

      if (!PHONE_MESSAGE_TYPES.has(value.type)) return;
      if (value.type === 'push_registration') {
        send(socket, registerPushTarget(channel, value));
        return;
      }
      if (channel.device?.readyState === WebSocket.OPEN) {
        send(channel.device, raw);
      } else {
        const result = offlineResult(value);
        if (result) send(socket, result);
      }
    });

    socket.on('close', () => {
      if (endpoint.role === 'device' && channel.device === socket) {
        channel.device = null;
        failPendingEvidence(endpoint.deviceId, 503, 'device_offline');
      }
      else channel.phones.delete(socket);
    });
  });

  httpServer.on('upgrade', (request, socket, head) => {
    const endpoint = parseEndpoint(request);
    const expected = endpoint && tokens.get(endpoint.deviceId);
    if (!endpoint || !expected || !safeEqual(endpoint.token, expected)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request, endpoint);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(preferredPort, host, () => {
      const address = httpServer.address();
      resolve({
        host,
        port: address.port,
        channels,
        close: () => new Promise((done) => {
          for (const pending of pendingEvidence.values()) {
            clearTimeout(pending.timer);
            if (!pending.response.writableEnded) pending.response.destroy();
          }
          pendingEvidence.clear();
          for (const channel of channels.values()) {
            for (const pending of channel.pendingPushes.values()) clearTimeout(pending.timer);
            channel.pendingPushes.clear();
            channel.device?.terminate();
            for (const phone of channel.phones) phone.terminate();
          }
          websocketServer.close();
          httpServer.close(done);
        }),
      });
    });
  });
}

module.exports = { createRelayServer, parseEndpoint, safeEqual };
