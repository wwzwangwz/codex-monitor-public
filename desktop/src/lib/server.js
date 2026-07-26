const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const { WebSocketServer } = require('ws');
const { decodeGuidanceAttachments, MAX_GUIDANCE_MESSAGE_BYTES } = require('./attachments');
const { validateGoalCommand } = require('./goal-control');
const { validateGuidance } = require('./native-guidance');

function localIPv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

function pairingPayload({
  machineId,
  machineName,
  port,
  token,
  relayWsUrl = '',
}) {
  const lanWsUrl = `ws://${localIPv4()}:${port}/monitor`;
  const data = {
    v: relayWsUrl ? 2 : 1,
    id: machineId,
    name: machineName,
    wsUrl: lanWsUrl,
    token,
  };
  if (relayWsUrl) Object.assign(data, { lanWsUrl, relayWsUrl });
  return `codex-monitor://pair?data=${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
}

function validateGuidanceRequest(value) {
  return validateGuidance({
    sessionId: value?.sessionId,
    text: value?.text,
    mode: value?.mode,
    attachments: decodeGuidanceAttachments(value?.attachments),
  });
}

function validateGoalCommandRequest(value) {
  const requestId = String(value?.requestId || '').trim();
  if (!requestId || requestId.length > 80) throw new Error('request ID format is invalid');
  return validateGoalCommand(value);
}

async function createMonitorServer({
  machineId,
  machineName,
  snapshot,
  pairingToken,
  preferredPort = 43117,
  androidRelease = null,
  evidenceFile = null,
  sendGuidance = null,
  validateGuidanceRequest: validateRequest = validateGuidanceRequest,
  sendGoalCommand = null,
  validateGoalCommandRequest: validateGoalRequest = validateGoalCommandRequest,
}) {
  let currentMachineName = machineName;
  let currentRelayWsUrl = '';
  const clientInfo = new Map();
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
      response.end(JSON.stringify({ clients: [...clientInfo.values()] }));
    } else if (url.pathname === '/android/latest.json' && authorized && androidRelease) {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify({
        versionCode: androidRelease.versionCode,
        versionName: androidRelease.versionName,
        size: androidRelease.size,
        sha256: androidRelease.sha256,
        downloadPath: '/android/apk',
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
        response.end();
        return;
      }
      response.setHeader('Content-Type', evidence.mimeType);
      response.setHeader('Content-Length', evidence.size);
      response.setHeader('Cache-Control', 'private, no-store');
      fs.createReadStream(evidence.path).on('error', () => response.destroy()).pipe(response);
    } else {
      response.statusCode = authorized ? 404 : 401;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: authorized ? 'not_found' : 'unauthorized' }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_GUIDANCE_MESSAGE_BYTES });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/monitor' || url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
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
    ws.on('message', (raw) => {
      if (raw.length > MAX_GUIDANCE_MESSAGE_BYTES) return;
      try {
        const value = JSON.parse(raw.toString());
        if (value?.type === 'guidance' && sendGuidance) {
          const requestId = String(value.requestId || '').slice(0, 80);
          const sessionId = String(value.sessionId || '').slice(0, 80);
          let guidance;
          try {
            const basicGuidance = validateGuidanceRequest(value);
            guidance = validateRequest === validateGuidanceRequest
              ? basicGuidance
              : validateRequest({ ...value, ...basicGuidance });
          } catch (error) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'guidance_result',
              requestId,
              sessionId,
              ok: false,
              message: String(error.message || error).slice(0, 300),
            }));
            return;
          }
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
            type: 'guidance_ack',
            requestId,
            sessionId,
            message: 'Desktop received the guidance request',
          }));
          Promise.resolve(sendGuidance(guidance)).then((result) => {
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
        if (value?.type === 'goal_command' && sendGoalCommand) {
          const requestId = String(value.requestId || '').slice(0, 80);
          const sessionId = String(value.sessionId || '').slice(0, 80);
          let goalCommand;
          try {
            const basicCommand = validateGoalCommandRequest(value);
            goalCommand = validateGoalRequest === validateGoalCommandRequest
              ? basicCommand
              : validateGoalRequest({ ...value, ...basicCommand });
          } catch (error) {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'goal_command_result',
              requestId,
              sessionId,
              command: String(value.command || ''),
              ok: false,
              message: String(error.message || error).slice(0, 300),
            }));
            return;
          }
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
            type: 'goal_command_ack',
            requestId,
            sessionId,
            message: 'Desktop received the Goal command',
          }));
          Promise.resolve(sendGoalCommand(goalCommand)).then((result) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'goal_command_result',
              requestId,
              sessionId,
              command: goalCommand.command,
              ok: Boolean(result?.ok),
              message: String(result?.message || 'Desktop did not return a Goal result').slice(0, 300),
            }));
          }).catch((error) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({
              type: 'goal_command_result',
              requestId,
              sessionId,
              command: goalCommand.command,
              ok: false,
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
    ws.on('close', () => clientInfo.delete(ws));
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
    connectedClients: () => clientInfo.size,
    connectedClientInfo: () => [...clientInfo.values()],
    close: () => {
      clearInterval(timer);
      sockets.close();
      server.close();
    },
  };
}

module.exports = {
  createMonitorServer,
  localIPv4,
  pairingPayload,
  validateGoalCommandRequest,
  validateGuidanceRequest,
};
