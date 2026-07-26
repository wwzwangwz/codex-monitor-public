const WebSocket = require('ws');
const fs = require('node:fs');
const { decodeGuidanceAttachments, MAX_GUIDANCE_MESSAGE_BYTES } = require('./attachments');

function relayUrls(baseUrl, machineId) {
  const url = new URL(String(baseUrl || '').trim());
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('远程中继地址必须以 ws:// 或 wss:// 开头');
  if (url.username || url.password || url.search || url.hash) throw new Error('远程中继地址不能包含账号、查询参数或锚点');
  const root = url.toString().replace(/\/$/, '');
  const id = encodeURIComponent(machineId);
  return {
    device: `${root}/relay/device/${id}`,
    phone: `${root}/relay/phone/${id}`,
  };
}

class RelayPublisher {
  constructor({
    baseUrl,
    machineId,
    machineName,
    token,
    snapshot,
    sendGuidance,
    sendGoalCommand,
    evidenceFile,
    WebSocketImpl = WebSocket,
    snapshotIntervalMs = 1500,
    reconnectMs = 3000,
    onStatus = () => {},
  }) {
    this.urls = relayUrls(baseUrl, machineId);
    this.machineId = machineId;
    this.machineName = machineName;
    this.token = token;
    this.snapshot = snapshot;
    this.sendGuidance = sendGuidance;
    this.sendGoalCommand = sendGoalCommand;
    this.evidenceFile = evidenceFile;
    this.WebSocketImpl = WebSocketImpl;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.reconnectMs = reconnectMs;
    this.onStatus = onStatus;
    this.socket = null;
    this.closed = true;
    this.timer = null;
    this.reconnectTimer = null;
  }

  start() {
    if (!this.closed) return;
    this.closed = false;
    this.timer = setInterval(() => this.sendSnapshot(), this.snapshotIntervalMs);
    this.connect();
  }

  endpointWithToken() {
    const endpoint = new URL(this.urls.device);
    endpoint.searchParams.set('token', this.token);
    return endpoint.toString();
  }

  connect() {
    if (this.closed) return;
    const socket = new this.WebSocketImpl(this.endpointWithToken());
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.onStatus({ connected: true, message: '远程中继已连接' });
      this.sendSnapshot();
    });
    socket.on('message', (raw, binary) => {
      if (this.socket !== socket || binary || raw.length > MAX_GUIDANCE_MESSAGE_BYTES) return;
      this.handleMessage(raw);
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.onStatus({ connected: false, message: String(error.message || error).slice(0, 200) });
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onStatus({ connected: false, message: '远程中继正在重连' });
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
    });
  }

  send(value) {
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) this.socket.send(JSON.stringify(value));
  }

  sendSnapshot() {
    this.send({
      type: 'snapshot',
      machine: { id: this.machineId, name: this.machineName },
      sentAt: new Date().toISOString(),
      sessions: this.snapshot(),
    });
  }

  handleMessage(raw) {
    let value;
    try { value = JSON.parse(raw.toString()); } catch { return; }
    if (value?.type === 'evidence_request' && this.evidenceFile) {
      const requestId = String(value.requestId || '').slice(0, 80);
      const evidenceId = String(value.evidenceId || '');
      const evidence = /^[a-f0-9]{32}$/.test(evidenceId) ? this.evidenceFile(evidenceId) : null;
      if (!evidence || !['image/jpeg', 'image/png', 'image/webp'].includes(evidence.mimeType)) {
        this.send({ type: 'evidence_response', requestId, ok: false });
        return;
      }
      fs.promises.readFile(evidence.path).then((data) => {
        if (data.length > 20 * 1024 * 1024) throw new Error('evidence_too_large');
        this.send({
          type: 'evidence_response', requestId, ok: true, mimeType: evidence.mimeType,
          name: String(evidence.name || 'evidence').slice(0, 160), dataBase64: data.toString('base64'),
        });
      }).catch(() => this.send({ type: 'evidence_response', requestId, ok: false }));
      return;
    }
    if (value?.type === 'guidance' && this.sendGuidance) {
      const requestId = String(value.requestId || '').slice(0, 80);
      const sessionId = String(value.sessionId || '').slice(0, 80);
      this.send({ type: 'guidance_ack', requestId, sessionId, message: '电脑端已收到，正在交给 Codex' });
      let attachments;
      try { attachments = decodeGuidanceAttachments(value.attachments); } catch (error) {
        this.send({ type: 'guidance_result', requestId, sessionId, ok: false, message: String(error.message).slice(0, 300) });
        return;
      }
      Promise.resolve(this.sendGuidance({
        sessionId,
        text: String(value.text || '').trim(),
        mode: value.mode === 'queue' ? 'queue' : 'steer',
        attachments,
      })).then((result) => this.send({
        type: 'guidance_result', requestId, sessionId, ok: Boolean(result?.ok),
        message: String(result?.message || '电脑端未返回结果').slice(0, 300),
      })).catch((error) => this.send({
        type: 'guidance_result', requestId, sessionId, ok: false, message: String(error.message || error).slice(0, 300),
      }));
      return;
    }
    if (value?.type === 'goal_command' && this.sendGoalCommand) {
      const requestId = String(value.requestId || '').slice(0, 80);
      const sessionId = String(value.sessionId || '').slice(0, 80);
      const command = value.command === 'delete' ? 'delete' : value.command === 'resume' ? 'resume' : '';
      this.send({ type: 'goal_command_ack', requestId, sessionId, message: '电脑端已收到 Goal 操作' });
      Promise.resolve(this.sendGoalCommand({
        sessionId, command, confirmed: value.confirmed === true,
      })).then((result) => this.send({
        type: 'goal_command_result', requestId, sessionId, command, ok: Boolean(result?.ok),
        message: String(result?.message || '电脑端未返回结果').slice(0, 300),
      })).catch((error) => this.send({
        type: 'goal_command_result', requestId, sessionId, command, ok: false,
        message: String(error.message || error).slice(0, 300),
      }));
    }
  }

  rename(name) {
    this.machineName = name;
    this.sendSnapshot();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnectTimer);
    this.socket?.terminate();
    this.socket = null;
  }
}

module.exports = { RelayPublisher, relayUrls };
