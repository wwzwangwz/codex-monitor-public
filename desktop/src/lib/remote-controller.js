const crypto = require('node:crypto');
const WebSocket = require('ws');

function parsePairingCode(value) {
  let url;
  let data;
  try {
    url = new URL(String(value || '').trim());
    if (url.protocol !== 'codex-monitor:' || url.hostname !== 'pair') throw new Error();
    data = JSON.parse(Buffer.from(url.searchParams.get('data') || '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('配对码格式无效');
  }
  if (![1, 2].includes(data.v) || !data.id || !data.name || !data.token) throw new Error('配对码缺少必要字段');
  const wsUrl = normalizeEndpoint(data.wsUrl, '配对地址');
  const lanWsUrl = data.v === 2 ? normalizeEndpoint(data.lanWsUrl || data.wsUrl, '局域网地址') : wsUrl;
  const lanHostWsUrl = data.v === 2 && data.lanHostWsUrl
    ? normalizeEndpoint(data.lanHostWsUrl, '局域网主机名地址')
    : '';
  const relayWsUrl = data.v === 2 && data.relayWsUrl
    ? normalizeEndpoint(data.relayWsUrl, '远程中继地址', { secure: true })
    : '';
  return {
    v: data.v,
    id: String(data.id).slice(0, 80),
    name: String(data.name).trim().slice(0, 40),
    wsUrl,
    ...(data.v === 2 ? { lanWsUrl, relayWsUrl } : {}),
    ...(lanHostWsUrl ? { lanHostWsUrl } : {}),
    token: String(data.token).slice(0, 256),
  };
}

function normalizeEndpoint(value, label, { secure = false } = {}) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${label}无效`);
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || (secure && endpoint.protocol !== 'wss:')) {
    throw new Error(secure ? `${label}必须使用 wss` : `${label}必须使用 ws 或 wss`);
  }
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error(`${label}不能包含账号或锚点`);
  return endpoint.toString();
}

function connectionEndpoints(pairing) {
  return [...new Set([
    pairing?.lanWsUrl || pairing?.wsUrl,
    pairing?.lanHostWsUrl,
    pairing?.relayWsUrl,
  ].filter(Boolean))];
}

class RemoteController {
  constructor({ pairings = [], WebSocketImpl = WebSocket, reconnectMs = 3000, snapshotTimeoutMs = 8000, requestTimeoutMs = 10_000, resultTimeoutMs = 30_000, onUpdate = () => {}, onPairingsChange = () => {} } = {}) {
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectMs = reconnectMs;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.resultTimeoutMs = resultTimeoutMs;
    this.onUpdate = onUpdate;
    this.onPairingsChange = onPairingsChange;
    this.closed = false;
    this.nodes = new Map();
    this.pending = new Map();
    for (const pairing of pairings) this.put(pairing);
  }

  put(pairing) {
    if (!pairing?.id || connectionEndpoints(pairing).length === 0 || !pairing?.token) return;
    const previous = this.nodes.get(pairing.id);
    if (previous?.timer) clearTimeout(previous.timer);
    previous?.socket?.close();
    this.nodes.set(pairing.id, {
      pairing: { ...pairing },
      connected: false,
      sessions: previous?.sessions || [],
      lastSeen: previous?.lastSeen || null,
      error: null,
      socket: null,
      timer: null,
      snapshotTimer: null,
      endpointIndex: 0,
      activeWsUrl: null,
    });
  }

  start() {
    this.closed = false;
    for (const id of this.nodes.keys()) this.connect(id);
  }

  add(code, ownMachineId) {
    const pairing = parsePairingCode(code);
    if (pairing.id === ownMachineId) throw new Error('不能把主控 Mac 自己添加为受控设备');
    this.put(pairing);
    this.persist();
    this.connect(pairing.id);
    this.emit();
    return pairing.id;
  }

  remove(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.timer) clearTimeout(node.timer);
    node.socket?.close();
    this.nodes.delete(id);
    this.persist();
    this.emit();
  }

  pairings() {
    return [...this.nodes.values()].map((node) => ({ ...node.pairing }));
  }

  snapshot() {
    return [...this.nodes.values()].map((node) => ({
      id: node.pairing.id,
      name: node.pairing.name,
      wsUrl: node.pairing.wsUrl,
      lanWsUrl: node.pairing.lanWsUrl || node.pairing.wsUrl,
      lanHostWsUrl: node.pairing.lanHostWsUrl || '',
      relayWsUrl: node.pairing.relayWsUrl || '',
      activeWsUrl: node.activeWsUrl,
      connected: node.connected,
      sessions: node.sessions,
      lastSeen: node.lastSeen,
      error: node.error,
    }));
  }

  connect(id) {
    const node = this.nodes.get(id);
    if (!node || this.closed || node.socket) return;
    let endpoint;
    try {
      const endpoints = connectionEndpoints(node.pairing);
      node.endpointIndex %= endpoints.length;
      endpoint = new URL(endpoints[node.endpointIndex]);
      endpoint.searchParams.set('token', node.pairing.token);
    } catch {
      node.error = '连接地址无效';
      this.emit();
      return;
    }
    const socket = new this.WebSocketImpl(endpoint.toString());
    node.socket = socket;
    node.activeWsUrl = endpoint.origin + endpoint.pathname;
    socket.on('open', () => {
      if (node.socket !== socket) return;
      node.error = null;
      clearTimeout(node.snapshotTimer);
      node.snapshotTimer = setTimeout(() => {
        if (node.socket === socket && !node.connected) socket.close();
      }, this.snapshotTimeoutMs);
    });
    socket.on('message', (raw) => this.handleMessage(node, socket, raw));
    socket.on('error', (error) => {
      if (node.socket === socket) node.error = String(error.message || '连接失败').slice(0, 160);
    });
    socket.on('close', () => this.handleClose(node, socket));
  }

  handleMessage(node, socket, raw) {
    if (node.socket !== socket) return;
    let value;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (value.type === 'snapshot' && value.machine?.id === node.pairing.id) {
      clearTimeout(node.snapshotTimer);
      node.snapshotTimer = null;
      node.connected = true;
      node.lastSeen = value.sentAt || new Date().toISOString();
      node.error = null;
      node.sessions = Array.isArray(value.sessions) ? value.sessions : [];
      if (value.machine.name && value.machine.name !== node.pairing.name) {
        node.pairing.name = String(value.machine.name).slice(0, 40);
        this.persist();
      }
      this.emit();
      return;
    }
    if (value.type === 'guidance_ack' || value.type === 'guidance_result' ||
        value.type === 'goal_command_ack' || value.type === 'goal_command_result') {
      const requestId = String(value.requestId || '');
      const request = this.pending.get(requestId);
      if (!request) return;
      const expectedAck = request.kind === 'guidance' ? 'guidance_ack' : 'goal_command_ack';
      const expectedResult = request.kind === 'guidance' ? 'guidance_result' : 'goal_command_result';
      if (value.type !== expectedAck && value.type !== expectedResult) return;
      if (String(value.sessionId || '') !== request.sessionId) {
        clearTimeout(request.timer);
        this.pending.delete(requestId);
        request.resolve({ ok: false, message: '受控电脑返回了不匹配的会话结果，消息未确认', ack: request.ack });
        return;
      }
      if (value.type === 'guidance_ack' && !request.ack) {
        request.ack = value;
        clearTimeout(request.timer);
        request.timer = setTimeout(() => {
          this.pending.delete(requestId);
          request.resolve({ ok: false, message: '受控电脑已接收，但 30 秒未返回最终执行结果', ack: request.ack });
        }, this.resultTimeoutMs);
      }
      if (value.type === 'goal_command_ack' && !request.ack) {
        request.ack = value;
        clearTimeout(request.timer);
        request.timer = setTimeout(() => {
          this.pending.delete(requestId);
          request.resolve({ ok: false, message: '受控电脑已接收 Goal 操作，但 30 秒未返回最终结果', ack: request.ack });
        }, this.resultTimeoutMs);
      }
      if (value.type === expectedResult) {
        if (request.kind === 'goal' && String(value.command || '') !== request.command) {
          clearTimeout(request.timer);
          this.pending.delete(requestId);
          request.resolve({
            ok: false,
            message: '受控电脑返回了不匹配的 Goal 操作结果，消息未确认',
            ack: request.ack,
          });
          return;
        }
        clearTimeout(request.timer);
        this.pending.delete(requestId);
        request.resolve({ ok: Boolean(value.ok), message: String(value.message || ''), ack: request.ack });
      }
    }
  }

  handleClose(node, socket) {
    if (node.socket !== socket) return;
    clearTimeout(node.snapshotTimer);
    node.snapshotTimer = null;
    node.socket = null;
    node.connected = false;
    const endpoints = connectionEndpoints(node.pairing);
    node.endpointIndex = endpoints.length > 1 ? (node.endpointIndex + 1) % endpoints.length : 0;
    this.emit();
    if (!this.closed && this.nodes.has(node.pairing.id)) {
      node.timer = setTimeout(() => {
        node.timer = null;
        this.connect(node.pairing.id);
      }, this.reconnectMs);
    }
  }

  sendGuidance({ deviceId, sessionId, text, mode }) {
    const node = this.nodes.get(deviceId);
    const value = String(text || '').trim();
    if (!node?.connected || !node.socket || node.socket.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.resolve({ ok: false, message: '受控电脑当前未连接' });
    }
    if (!node.sessions.some((session) => session.id === sessionId)) {
      return Promise.resolve({ ok: false, message: '受控电脑当前没有该会话' });
    }
    if (!value || value.length > 2000) return Promise.resolve({ ok: false, message: '消息长度必须为 1 到 2000 字' });
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, message: '受控电脑 10 秒未确认接收消息' });
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { kind: 'guidance', sessionId, resolve, timer, ack: null });
      node.socket.send(JSON.stringify({
        type: 'guidance', requestId, sessionId, text: value, mode: mode === 'queue' ? 'queue' : 'steer',
      }));
    });
  }

  sendGoalCommand({ deviceId, sessionId, command, confirmed = false }) {
    const node = this.nodes.get(deviceId);
    const normalizedCommand = command === 'resume' || command === 'delete' ? command : '';
    if (!node?.connected || !node.socket || node.socket.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.resolve({ ok: false, message: '受控电脑当前未连接' });
    }
    if (!node.sessions.some((session) => session.id === sessionId)) {
      return Promise.resolve({ ok: false, message: '受控电脑当前没有该会话' });
    }
    if (!normalizedCommand) return Promise.resolve({ ok: false, message: '不支持的 Goal 操作' });
    if (normalizedCommand === 'delete' && confirmed !== true) {
      return Promise.resolve({ ok: false, message: '删除 Goal 需要二次确认' });
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, message: '受控电脑 10 秒未确认 Goal 操作' });
      }, this.requestTimeoutMs);
      this.pending.set(requestId, {
        kind: 'goal', sessionId, command: normalizedCommand, resolve, timer, ack: null,
      });
      node.socket.send(JSON.stringify({
        type: 'goal_command', requestId, sessionId, command: normalizedCommand, confirmed: confirmed === true,
      }));
    });
  }

  persist() {
    this.onPairingsChange(this.pairings());
  }

  emit() {
    this.onUpdate(this.snapshot());
  }

  close() {
    this.closed = true;
    for (const node of this.nodes.values()) {
      if (node.timer) clearTimeout(node.timer);
      if (node.snapshotTimer) clearTimeout(node.snapshotTimer);
      node.socket?.close();
    }
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, message: '主控服务已关闭' });
    }
    this.pending.clear();
  }
}

module.exports = { RemoteController, connectionEndpoints, parsePairingCode };
