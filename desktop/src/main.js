const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { activateEvidence, evidenceFile, listSessions, sessionStatus } = require('./lib/codex');
const { createNativeGuidanceSender } = require('./lib/native-guidance');
const { createNativeChannelController } = require('./lib/native-channel');
const { cleanupStaleGuidanceAttachments } = require('./lib/attachments');
const { RemoteController } = require('./lib/remote-controller');
const { createMonitorServer } = require('./lib/server');
const { createGoalController } = require('./lib/app-server');
const { sendIfAlive } = require('./lib/window-events');
const { enforceNormalWindowAfterShow } = require('./lib/window-bounds');
const { RelayPublisher, relayUrls } = require('./lib/relay-publisher');
const { installTerminationHandlers } = require('./lib/termination');

let mainWindow;
let monitorServer;
let remoteController;
let relayPublisher;
let relayStatus = { connected: false, message: '远程中继已关闭' };
let sessions = [];
let selected = new Set();
let sendNativeGuidance;
const goalController = createGoalController({
  resumeThread: (input) => {
    if (!sendNativeGuidance) throw new Error('Codex 桌面原生输入通道尚未就绪');
    return sendNativeGuidance(input);
  },
});
const nativeChannelController = createNativeChannelController();

function androidRelease() {
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
  const apkPath = path.join(resources, 'Codex-Monitor-Android.apk');
  const metadataPath = path.join(resources, 'android-latest.json');
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const contents = fs.readFileSync(apkPath);
    const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
    if (metadata.sha256 !== sha256) return null;
    return { ...metadata, apkPath, size: contents.length, sha256 };
  } catch {
    return null;
  }
}

function configPath() {
  return path.join(app.getPath('userData'), 'monitor-config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function loadConfig() {
  const data = readConfig();
  selected = new Set(Array.isArray(data.selected) ? data.selected : []);
  return data;
}

function saveConfig(extra = {}) {
  const current = readConfig();
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...current, ...extra, selected: [...selected] }, null, 2));
}

function refreshSessions() {
  sessions = listSessions();
  return sessions;
}

function snapshot() {
  const values = sessions.filter((item) => selected.has(item.id)).map((item) => sessionStatus(item));
  activateEvidence(values);
  return values;
}

function publicSessions() {
  return sessions.filter((item, index) => index < 50 || selected.has(item.id)).map((item) => ({
    id: item.id,
    title: item.title,
    updatedAt: item.updatedAt,
    selected: selected.has(item.id),
    status: sessionStatus(item),
  }));
}

async function sendGuidance({ sessionId, text, mode, attachments = [] }) {
  const value = String(text || '').trim();
  if (!selected.has(sessionId)) return { ok: false, message: '该会话未在电脑端选择监控' };
  if ((!value && !attachments.length) || value.length > 2000) {
    return { ok: false, message: '请输入消息或选择图片，文字不能超过 2000 字' };
  }
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: '电脑端找不到该会话' };
  try {
    return await sendNativeGuidance({ sessionId, sessionTitle: session.title, text: value, mode, attachments });
  } catch (error) {
    return { ok: false, message: String(error.message || error).slice(0, 300) };
  }
}

async function sendGoalCommand({ sessionId, command, confirmed }) {
  if (!selected.has(sessionId)) return { ok: false, message: '该会话未在电脑端选择监控' };
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: '电脑端找不到该会话' };
  try {
    const status = sessionStatus(session);
    const result = await goalController.execute({
      threadId: sessionId,
      command,
      sessionState: status.state,
      sessionTitle: session.title,
      confirmed,
    });
    refreshSessions();
    return result;
  } catch (error) {
    return { ok: false, message: String(error.message || error).slice(0, 300) };
  }
}

function applyRelaySettings({ enabled, baseUrl }, { persist = true } = {}) {
  relayPublisher?.close();
  relayPublisher = null;
  monitorServer?.setRelayWsUrl('');
  const normalizedBaseUrl = String(baseUrl || '').trim();
  if (!enabled) {
    relayStatus = { connected: false, message: '远程中继已关闭' };
    if (persist) saveConfig({ relayEnabled: false, relayBaseUrl: normalizedBaseUrl });
    return { enabled: false, baseUrl: normalizedBaseUrl, ...relayStatus };
  }
  try {
    const config = readConfig();
    const machineId = config.machineId;
    const token = config.pairingToken;
    const urls = relayUrls(normalizedBaseUrl, machineId);
    monitorServer.setRelayWsUrl(urls.phone);
    relayStatus = { connected: false, message: '远程中继正在连接' };
    relayPublisher = new RelayPublisher({
      baseUrl: normalizedBaseUrl,
      machineId,
      machineName: monitorServer.machineName,
      token,
      snapshot,
      sendGuidance,
      sendGoalCommand,
      evidenceFile,
      onStatus: (status) => {
        relayStatus = status;
        sendIfAlive(mainWindow, 'relay:update', { enabled: true, baseUrl: normalizedBaseUrl, ...status });
      },
    });
    relayPublisher.start();
    if (persist) saveConfig({ relayEnabled: true, relayBaseUrl: normalizedBaseUrl });
    return { enabled: true, baseUrl: normalizedBaseUrl, ...relayStatus };
  } catch (error) {
    relayStatus = { connected: false, message: String(error.message || error).slice(0, 200) };
    if (persist) saveConfig({ relayEnabled: false, relayBaseUrl: normalizedBaseUrl });
    return { enabled: false, baseUrl: normalizedBaseUrl, ...relayStatus };
  }
}

async function createWindow() {
  const attachmentDirectory = path.join(app.getPath('userData'), 'guidance-attachments');
  cleanupStaleGuidanceAttachments({ storageDirectory: attachmentDirectory });
  sendNativeGuidance = createNativeGuidanceSender({ attachmentDirectory });
  const config = loadConfig();
  refreshSessions();
  const machineId = config.machineId || crypto.randomUUID();
  const machineName = config.machineName || os.hostname();
  const openAtLogin = config.openAtLogin !== false;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin });
  saveConfig({ machineId, machineName });
  const primaryController = config.primaryController === true || config.role === 'primary_controller';
  if (primaryController) saveConfig({ primaryController: true, role: 'primary_controller' });
  const pairingToken = config.pairingToken || crypto.randomBytes(24).toString('base64url');
  const preferredPort = config.port || 43117;
  monitorServer = await createMonitorServer({
    machineId,
    machineName,
    snapshot,
    pairingToken,
    preferredPort,
    hostName: os.hostname(),
    androidRelease: androidRelease(),
    sendGuidance,
    sendGoalCommand,
    evidenceFile,
  });
  saveConfig({ machineId, machineName, pairingToken, port: monitorServer.port });
  applyRelaySettings({ enabled: config.relayEnabled === true, baseUrl: config.relayBaseUrl || '' }, { persist: false });

  if (primaryController) {
    remoteController = new RemoteController({
      pairings: Array.isArray(config.remotePairings) ? config.remotePairings : [],
      onUpdate: (nodes) => sendIfAlive(mainWindow, 'controller:update', nodes),
      onPairingsChange: (remotePairings) => saveConfig({ remotePairings }),
    });
    remoteController.start();
  }

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#f3f5f4',
    title: 'Codex Monitor',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.once('ready-to-show', () => {
    enforceNormalWindowAfterShow(mainWindow);
    mainWindow.show();
  });
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.CODEX_MONITOR_CAPTURE) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(process.env.CODEX_MONITOR_CAPTURE, image.toPNG());
    app.quit();
  }
}

ipcMain.handle('sessions:list', () => {
  refreshSessions();
  return publicSessions();
});
ipcMain.handle('sessions:toggle', (_event, id, value) => {
  if (value) selected.add(id);
  else selected.delete(id);
  saveConfig();
  return publicSessions();
});
ipcMain.handle('pairing:get', async () => ({
  value: monitorServer.pairing,
  qr: await QRCode.toDataURL(monitorServer.pairing, { width: 360, margin: 1, errorCorrectionLevel: 'M' }),
  clients: monitorServer.connectedClients(),
  clientInfo: monitorServer.connectedClientInfo(),
  machineName: monitorServer.machineName,
  openAtLogin: readConfig().openAtLogin !== false,
}));
ipcMain.handle('machine:rename', (_event, value) => {
  const machineName = String(value || '').trim().slice(0, 40);
  if (!machineName) throw new Error('设备名不能为空');
  monitorServer.rename(machineName);
  relayPublisher?.rename(machineName);
  saveConfig({ machineName });
  return machineName;
});
ipcMain.handle('machine:auto-start', (_event, value) => {
  const openAtLogin = Boolean(value);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin });
  saveConfig({ openAtLogin });
  return openAtLogin;
});
ipcMain.handle('native-channel:get', () => nativeChannelController.getStatus());
ipcMain.handle('native-channel:repair', () => nativeChannelController.repair());
ipcMain.handle('relay:get', () => {
  const config = readConfig();
  return {
    enabled: config.relayEnabled === true && Boolean(relayPublisher),
    baseUrl: String(config.relayBaseUrl || ''),
    ...relayStatus,
  };
});
ipcMain.handle('relay:set', (_event, value) => applyRelaySettings({
  enabled: value?.enabled === true,
  baseUrl: value?.baseUrl,
}));
ipcMain.handle('controller:get', () => ({
  enabled: Boolean(remoteController),
  role: remoteController ? 'primary_controller' : 'node',
  nodes: remoteController?.snapshot() || [],
}));
ipcMain.handle('controller:add', (_event, code) => {
  if (!remoteController) throw new Error('本机不是主控设备');
  const machineId = readConfig().machineId;
  remoteController.add(code, machineId);
  return remoteController.snapshot();
});
ipcMain.handle('controller:remove', (_event, id) => {
  remoteController?.remove(String(id || ''));
  return remoteController?.snapshot() || [];
});
ipcMain.handle('controller:send', (_event, value) => {
  if (!remoteController) return { ok: false, message: '本机不是主控设备' };
  return remoteController.sendGuidance(value || {});
});
ipcMain.handle('controller:goal', (_event, value) => {
  if (!remoteController) return { ok: false, message: '本机不是主控设备' };
  return remoteController.sendGoalCommand(value || {});
});

app.whenReady().then(createWindow);
installTerminationHandlers({ quit: () => app.quit() });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('before-quit', () => {
  goalController.close();
  remoteController?.close();
  relayPublisher?.close();
  monitorServer?.close();
});
