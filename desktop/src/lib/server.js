const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const { decodeGuidanceAttachments, MAX_GUIDANCE_MESSAGE_BYTES } = require('./attachments');

function localIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function pairingPayload({ machineId, machineName, port, token, relayWsUrl = '', hostName = '' }) {
  const lanWsUrl = `ws://${localIPv4()}:${port}/monitor`;
  const normalizedHostName = String(hostName || '').trim().replace(/\.$/, '');
  const lanHostWsUrl = normalizedHostName && normalizedHostName !== localIPv4()
    ? `ws://${normalizedHostName}:${port}/monitor`
    : '';
  // Keep LAN-only QR codes compatible with the stable v1 mobile path.
  // New clients can still derive the .local fallback from the device name.
  const version = relayWsUrl ? 2 : 1;
  const data = {
    v: version,
    id: machineId,
    name: machineName,
    wsUrl: lanWsUrl,
    token,
  };
  if (version === 2) {
    data.lanWsUrl = lanWsUrl;
    if (lanHostWsUrl) data.lanHostWsUrl = lanHostWsUrl;
    if (relayWsUrl) data.relayWsUrl = relayWsUrl;
  }
  return `codex-monitor://pair?data=${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
}

async function createMonitorServer({
  machineId,
  machineName,
  snapshot,
  pairingToken,
  preferredPort = 43117,
  androidRelease = null,
  sendGuidance = null,
  sendGoalCommand = null,
  evidenceFile = null,
  createEvidenceReadStream = fs.createReadStream,
  evidenceOpenTimeoutMs = 8000,
  relayWsUrl = '',
  hostName = '',
}) {
  let currentMachineName = machineName;
  let currentRelayWsUrl = relayWsUrl;
  const clientInfo = new Map();
  const connectionDiagnostics = {
    upgradeAttempts: 0,
    accepted: 0,
    rejected: 0,
    lastAttemptAt: null,
    lastRemoteAddress: '',
    lastResult: 'none',
    lastConnectedAt: null,
    lastDisconnectedAt: null,
  };
  const token = pairingToken || crypto.randomBytes(24).toString('base64url');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const authorized = url.searchParams.get('token') === token
      || request.headers.authorization === `Bearer ${token}`;
    if (url.pathname === '/health') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ ok: true, id: machineId, name: currentMachineName }));
    } else if (url.pathname === '/clients' && authorized) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify({
        clients: [...clientInfo.values()],
        diagnostics: { ...connectionDiagnostics },
      }));
    } else if (url.pathname === '/android/latest.json' && authorized && androidRelease) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      const address = server.address();
      const updatePort = address && typeof address === 'object' ? address.port : 43117;
      const migrationLanWsUrl = `ws://${localIPv4()}:${updatePort}/monitor`;
      const migrationHost = String(hostName || '').trim().replace(/\.$/, '');
      const migration = {
        v: 2,
        wsUrl: migrationLanWsUrl,
        lanWsUrl: migrationLanWsUrl,
        ...(migrationHost && migrationHost !== localIPv4()
          ? { lanHostWsUrl: `ws://${migrationHost}:${updatePort}/monitor` }
          : {}),
        ...(currentRelayWsUrl ? { relayWsUrl: currentRelayWsUrl } : {}),
      };
      response.end(JSON.stringify({
        versionCode: androidRelease.versionCode,
        versionName: androidRelease.versionName,
        size: androidRelease.size,
        sha256: androidRelease.sha256,
        downloadPath: '/android/apk',
        migration,
      }));
    } else if (url.pathname === '/android/apk' && authorized && androidRelease) {
      response.setHeader('Content-Type', 'application/vnd.android.package-archive');
      response.setHeader('Content-Length', androidRelease.size);
      response.setHeader('Content-Disposition', `attachment; filename="Codex-Monitor-Android-${androidRelease.versionName}.apk"`);
      fs.createReadStream(androidRelease.apkPath).on('error', () => response.destroy()).pipe(response);
    } else if (url.pathname.startsWith('/evidence/') && authorized && evidenceFile) {
      const id = url.pathname.slice('/evidence/'.length);
      const evidence = /^[a-f0-9]{32}$/.test(id) ? evidenceFile(id) : null;
      if (!evidence) {
        response.statusCode = 404;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const stream = createEvidenceReadStream(evidence.path);
      let opened = false;
      const timeout = setTimeout(() => {
        if (opened || response.writableEnded) return;
        stream.destroy();
        response.statusCode = 504;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'evidence_read_timeout' }));
      }, Math.max(100, evidenceOpenTimeoutMs));
      stream.once('open', () => {
        if (response.writableEnded) return;
        opened = true;
        clearTimeout(timeout);
        response.setHeader('Content-Type', evidence.mimeType);
        response.setHeader('Content-Length', evidence.size);
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        stream.pipe(response);
      });
      stream.once('error', () => {
        clearTimeout(timeout);
        if (response.writableEnded) return;
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: 'evidence_read_failed' }));
        } else {
          response.destroy();
        }
      });
    } else {
      response.statusCode = authorized ? 404 : 401;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: authorized ? 'not_found' : 'unauthorized' }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_GUIDANCE_MESSAGE_BYTES });

  server.on('upgrade', (request, socket, head) => {
    connectionDiagnostics.upgradeAttempts += 1;
    connectionDiagnostics.lastAttemptAt = new Date().toISOString();
    connectionDiagnostics.lastRemoteAddress = String(request.socket.remoteAddress || socket.remoteAddress || '').slice(0, 80);
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      connectionDiagnostics.rejected += 1;
      connectionDiagnostics.lastResult = 'invalid_url';
      socket.destroy();
      return;
    }
    if (url.pathname !== '/monitor') {
      connectionDiagnostics.rejected += 1;
      connectionDiagnostics.lastResult = 'invalid_path';
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.searchParams.get('token') !== token) {
      connectionDiagnostics.rejected += 1;
      connectionDiagnostics.lastResult = 'invalid_token';
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    connectionDiagnostics.accepted += 1;
    connectionDiagnostics.lastResult = 'accepted';
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws));
  });

  const sendSnapshot = () => {
    const message = JSON.stringify({
      type: 'snapshot',
      machine: { id: machineId, name: currentMachineName },
      sentAt: new Date().toISOString(),
      sessions: snapshot(),
    });
    for (const client of sockets.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };
  sockets.on('connection', (ws) => {
    connectionDiagnostics.lastConnectedAt = new Date().toISOString();
    ws.on('message', (raw) => {
      if (raw.length > MAX_GUIDANCE_MESSAGE_BYTES) return;
      try {
        const value = JSON.parse(raw.toString());
        if (value.type === 'guidance' && sendGuidance) {
          const requestId = String(value.requestId || '').slice(0, 80);
          const sessionId = String(value.sessionId || '').slice(0, 80);
          const text = String(value.text || '').trim();
          const mode = value.mode === 'queue' ? 'queue' : 'steer';
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
            type: 'guidance_ack',
            requestId,
            sessionId,
            message: '电脑端已收到，正在交给 Codex',
          }));
          let attachments;
          try {
            attachments = decodeGuidanceAttachments(value.attachments);
          } catch (error) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'guidance_result', requestId, sessionId, ok: false, message: String(error.message).slice(0, 300),
            }));
            return;
          }
          Promise.resolve(sendGuidance({ sessionId, text, mode, attachments })).then((result) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'guidance_result',
              requestId,
              sessionId,
              ok: Boolean(result?.ok),
              message: String(result?.message || '电脑端未返回结果').slice(0, 300),
            }));
          }).catch((error) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'guidance_result', requestId, sessionId, ok: false, message: String(error.message).slice(0, 300),
            }));
          });
          return;
        }
        if (value.type === 'goal_command' && sendGoalCommand) {
          const requestId = String(value.requestId || '').slice(0, 80);
          const sessionId = String(value.sessionId || '').slice(0, 80);
          const command = value.command === 'delete' ? 'delete' : value.command === 'resume' ? 'resume' : '';
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
            type: 'goal_command_ack', requestId, sessionId, message: '电脑端已收到 Goal 操作',
          }));
          Promise.resolve(sendGoalCommand({
            sessionId,
            command,
            confirmed: value.confirmed === true,
          })).then((result) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'goal_command_result',
              requestId,
              sessionId,
              command,
              ok: Boolean(result?.ok),
              message: String(result?.message || '电脑端未返回结果').slice(0, 300),
            }));
          }).catch((error) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'goal_command_result', requestId, sessionId, command, ok: false,
              message: String(error.message || error).slice(0, 300),
            }));
          });
          return;
        }
        if (value.type !== 'client_info' || !['android', 'ios'].includes(value.platform)) return;
        clientInfo.set(ws, {
          platform: value.platform,
          appVersion: String(value.appVersion || 'unknown').slice(0, 32),
          versionCode: Number(value.versionCode) || 0,
          statusProtocolVersion: Number(value.statusProtocolVersion) || 1,
          releaseNotes: Array.isArray(value.releaseNotes)
            ? value.releaseNotes.slice(0, 10).map((item) => String(item).slice(0, 300))
            : [],
          connectedAt: new Date().toISOString(),
        });
      } catch {
        // Ignore messages from older clients and malformed optional metadata.
      }
    });
    ws.on('close', () => {
      clientInfo.delete(ws);
      connectionDiagnostics.lastDisconnectedAt = new Date().toISOString();
    });
    ws.send(JSON.stringify({
      type: 'snapshot',
      machine: { id: machineId, name: currentMachineName },
      sentAt: new Date().toISOString(),
      sessions: snapshot(),
    }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = server.address().port;
  const timer = setInterval(sendSnapshot, 1500);
  return {
    port,
    token,
    get pairing() {
      return pairingPayload({
        machineId,
        machineName: currentMachineName,
        port,
        token,
        relayWsUrl: currentRelayWsUrl,
        hostName,
      });
    },
    get machineName() {
      return currentMachineName;
    },
    rename: (name) => {
      currentMachineName = name;
      sendSnapshot();
    },
    setRelayWsUrl: (value) => {
      currentRelayWsUrl = String(value || '');
    },
    connectedClients: () => sockets.clients.size,
    connectedClientInfo: () => [...clientInfo.values()],
    connectionDiagnostics: () => ({ ...connectionDiagnostics }),
    close: () => {
      clearInterval(timer);
      sockets.close();
      server.close();
    },
  };
}

module.exports = { createMonitorServer, localIPv4, pairingPayload };
