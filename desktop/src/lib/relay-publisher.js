const WebSocket = require('ws');
const fs = require('node:fs');
const { MAX_GUIDANCE_MESSAGE_BYTES } = require('./attachments');

const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const EVIDENCE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function relayUrls(baseUrl, machineId) {
  const url = new URL(String(baseUrl || '').trim());
  const loopback = url.protocol === 'ws:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !loopback) {
    throw new Error('Relay requires TLS WebSocket; ws:// is loopback-only');
  }
  if (url.username || url.password) throw new Error('Relay URL cannot contain credentials');
  if (url.search || url.hash) throw new Error('Relay URL cannot contain query or fragment');
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
    sendGuidance = null,
    validateGuidanceRequest = null,
    sendGoalCommand = null,
    validateGoalCommandRequest = null,
    evidenceFile = null,
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
    this.validateGuidanceRequest = validateGuidanceRequest;
    this.sendGoalCommand = sendGoalCommand;
    this.validateGoalCommandRequest = validateGoalCommandRequest;
    this.evidenceFile = evidenceFile;
    this.WebSocketImpl = WebSocketImpl;
    this.snapshotIntervalMs = snapshotIntervalMs;
    this.reconnectMs = reconnectMs;
    this.onStatus = onStatus;
    this.socket = null;
    this.closed = true;
    this.snapshotTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    if (!this.closed) return;
    this.closed = false;
    this.snapshotTimer = setInterval(() => this.sendSnapshot(), this.snapshotIntervalMs);
    this.connect();
  }

  endpointWithToken() {
    const endpoint = new URL(this.urls.device);
    endpoint.searchParams.set('token', this.token);
    return endpoint.toString();
  }

  connect() {
    if (this.closed) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.endpointWithToken());
    } catch (error) {
      this.onStatus({ connected: false, message: String(error.message || error).slice(0, 200) });
      this.scheduleReconnect();
      return;
    }
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
      if (this.socket !== socket) return;
      this.onStatus({
        connected: false,
        message: String(error.message || error).slice(0, 200),
      });
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onStatus({ connected: false, message: '远程中继正在重连' });
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectMs);
  }

  send(value) {
    if (this.socket?.readyState !== this.WebSocketImpl.OPEN) return;
    this.socket.send(JSON.stringify(value));
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
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (value?.type === 'evidence_request' && this.evidenceFile) {
      this.handleEvidenceRequest(value);
      return;
    }
    if (value?.type === 'guidance' && this.sendGuidance && this.validateGuidanceRequest) {
      this.handleGuidance(value);
      return;
    }
    if (value?.type === 'goal_command'
      && this.sendGoalCommand
      && this.validateGoalCommandRequest) {
      this.handleGoalCommand(value);
    }
  }

  handleEvidenceRequest(value) {
    const requestId = String(value.requestId || '').slice(0, 80);
    const evidenceId = String(value.evidenceId || '');
    const evidence = /^[a-f0-9]{32}$/.test(evidenceId)
      ? this.evidenceFile(evidenceId)
      : null;
    if (!evidence
      || !EVIDENCE_MIME_TYPES.has(evidence.mimeType)
      || Number(evidence.size) > MAX_EVIDENCE_BYTES) {
      this.send({ type: 'evidence_response', requestId, ok: false });
      return;
    }
    fs.promises.readFile(evidence.path).then((data) => {
      if (data.length > MAX_EVIDENCE_BYTES) throw new Error('evidence_too_large');
      this.send({
        type: 'evidence_response',
        requestId,
        ok: true,
        mimeType: evidence.mimeType,
        name: String(evidence.name || 'evidence').slice(0, 160),
        dataBase64: data.toString('base64'),
      });
    }).catch(() => {
      this.send({ type: 'evidence_response', requestId, ok: false });
    });
  }

  handleGuidance(value) {
    const requestId = String(value.requestId || '').slice(0, 80);
    const sessionId = String(value.sessionId || '').slice(0, 80);
    let guidance;
    try {
      guidance = this.validateGuidanceRequest(value);
    } catch (error) {
      this.send({
        type: 'guidance_result',
        requestId,
        sessionId,
        ok: false,
        message: String(error.message || error).slice(0, 300),
      });
      return;
    }
    this.send({
      type: 'guidance_ack',
      requestId,
      sessionId,
      message: 'Desktop received the Relay guidance request',
    });
    Promise.resolve(this.sendGuidance(guidance)).then((result) => {
      this.send({
        type: 'guidance_result',
        requestId,
        sessionId,
        ok: Boolean(result?.ok),
        message: String(result?.message || 'Desktop did not return a guidance result').slice(0, 300),
      });
    }).catch((error) => {
      this.send({
        type: 'guidance_result',
        requestId,
        sessionId,
        ok: false,
        message: String(error.message || error).slice(0, 300),
      });
    });
  }

  handleGoalCommand(value) {
    const requestId = String(value.requestId || '').slice(0, 80);
    const sessionId = String(value.sessionId || '').slice(0, 80);
    let goalCommand;
    try {
      goalCommand = this.validateGoalCommandRequest(value);
    } catch (error) {
      this.send({
        type: 'goal_command_result',
        requestId,
        sessionId,
        command: String(value.command || ''),
        ok: false,
        message: String(error.message || error).slice(0, 300),
      });
      return;
    }
    this.send({
      type: 'goal_command_ack',
      requestId,
      sessionId,
      message: 'Desktop received the Relay Goal command',
    });
    Promise.resolve(this.sendGoalCommand(goalCommand)).then((result) => {
      this.send({
        type: 'goal_command_result',
        requestId,
        sessionId,
        command: goalCommand.command,
        ok: Boolean(result?.ok),
        message: String(result?.message || 'Desktop did not return a Goal result').slice(0, 300),
      });
    }).catch((error) => {
      this.send({
        type: 'goal_command_result',
        requestId,
        sessionId,
        command: goalCommand.command,
        ok: false,
        message: String(error.message || error).slice(0, 300),
      });
    });
  }

  rename(name) {
    this.machineName = name;
    this.sendSnapshot();
  }

  close() {
    this.closed = true;
    clearInterval(this.snapshotTimer);
    clearTimeout(this.reconnectTimer);
    this.snapshotTimer = null;
    this.reconnectTimer = null;
    this.socket?.terminate();
    this.socket = null;
  }
}

module.exports = { RelayPublisher, relayUrls };
