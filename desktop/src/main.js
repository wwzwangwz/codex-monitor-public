const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const {
  activateEvidence,
  aggregateSessionStatuses,
  applyThreadNames,
  canonicalSessions,
  evidenceFile,
  listSessions,
  normalizeSelectedSessionIds,
  officialTurnCandidateIds,
  sessionStatus,
} = require('./lib/codex');
const { createGoalCommandController } = require('./lib/goal-control');
const { createNativeGoalCommander } = require('./lib/native-goal');
const {
  AppServerClient,
  createAppServerGoalCommander,
  createAppServerGoalStore,
  createAppServerGuidanceSender,
  createAppServerThreadStore,
} = require('./lib/app-server');
const { createMonitorServer } = require('./lib/server');
const { createNativeGuidanceSender, validateGuidance } = require('./lib/native-guidance');
const { cleanupStaleGuidanceAttachments } = require('./lib/attachments');
const { createGitHubCredentialStore } = require('./lib/github-credential');
const { createRepositoryInboxReader } = require('./lib/repository-inbox');
const { createRepositoryInboxController } = require('./lib/repository-inbox-controller');
const { createSingleInstanceWindowLifecycle } = require('./lib/window-lifecycle');
const { RelaySettingsController } = require('./lib/relay-settings');
const { registerRelayIpc } = require('./lib/relay-ipc');
const { CodexNativeChannelController } = require('./lib/codex-native-channel');
const { createNativeTurnStore } = require('./lib/native-turns');
const { registerNativeChannelIpc } = require('./lib/native-channel-ipc');

let mainWindow;
let monitorServer;
let repositoryInbox;
let relaySettings;
let sessions = [];
let selected = new Set();
const appServerClient = new AppServerClient();
let sendNativeGuidance;
let sendAppServerGuidance;
const executeDesktopGoalCommand = createNativeGoalCommander();
const executeAppServerGoalCommand = createAppServerGoalCommander({
  client: appServerClient,
  resumeThread: (input) => sendGuidance(input),
});
const officialGoals = createAppServerGoalStore({ client: appServerClient });
const officialThreads = createAppServerThreadStore({ client: appServerClient });
const officialTurns = createNativeTurnStore();
const nativeChannel = new CodexNativeChannelController();

function nativeChannelUnavailable(error) {
  return /cannot connect to the Codex desktop native|cannot find the Codex desktop main window|native conversation navigation is unavailable|did not switch to the target conversation/i
    .test(String(error?.message || error));
}

async function executeNativeGoalCommand(input) {
  if (input.command === 'resume') {
    return executeAppServerGoalCommand(input);
  }
  try {
    return await executeDesktopGoalCommand(input);
  } catch (error) {
    if (!nativeChannelUnavailable(error)) throw error;
    return executeAppServerGoalCommand(input);
  }
}
const goalCommands = createGoalCommandController({
  getSessions: () => sessions,
  getSelectedIds: () => selected,
  getGoalStatuses: () => officialGoals.current(),
  executeNativeGoalCommand,
});
registerRelayIpc({
  ipcMain,
  getController: () => relaySettings,
});
registerNativeChannelIpc({
  ipcMain,
  getController: () => nativeChannel,
});

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
  writeConfig({ ...current, ...extra });
}

function writeConfig(data) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ ...data, selected: [...selected] }, null, 2));
}

function refreshSessions() {
  sessions = listSessions();
  selected = normalizeSelectedSessionIds(sessions, selected);
  return sessions;
}

function refreshOfficialMetadata() {
  const ids = [...selected];
  const turnIds = [...officialTurnCandidateIds(
    sessions,
    selected,
    (session) => sessionStatus(session, { goalStatuses: new Map() }),
  )];
  return Promise.all([
    officialGoals.refresh(ids),
    officialThreads.refresh(ids),
    officialTurns.refresh(turnIds),
  ]);
}

function namedSessions() {
  return applyThreadNames(sessions, officialThreads.current());
}

function snapshot() {
  void refreshOfficialMetadata();
  const goalMap = officialGoals.current();
  const turnMap = officialTurns.current();
  const values = aggregateSessionStatuses(
    namedSessions(),
    selected,
    (session) => sessionStatus(session, { goalStatuses: goalMap, turnStatuses: turnMap }),
  );
  activateEvidence(values);
  return values;
}

function publicSessions() {
  void refreshOfficialMetadata();
  const statusOptions = {
    goalStatuses: officialGoals.current(),
    turnStatuses: officialTurns.current(),
  };
  return canonicalSessions(namedSessions())
    .filter((item, index) => index < 50 || selected.has(item.id))
    .map((item) => ({
    id: item.id,
    title: item.title,
    updatedAt: item.updatedAt,
    selected: selected.has(item.id),
    status: sessionStatus(item, statusOptions),
    }));
}

function validateGuidanceRequest(request) {
  const guidance = validateGuidance(request);
  const rootId = [...normalizeSelectedSessionIds(sessions, [guidance.sessionId])][0];
  if (!rootId || !selected.has(rootId)) throw new Error('该会话未在电脑端选择监控');
  return { ...guidance, sessionId: rootId };
}

async function sendGuidance({ sessionId, text, mode, attachments }) {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) return { ok: false, message: '电脑端找不到该会话' };
  try {
    return await sendNativeGuidance({ sessionId, text, mode, attachments, rolloutPath: session.rolloutPath });
  } catch (error) {
    if (!nativeChannelUnavailable(error)) {
      return { ok: false, message: String(error.message || error).slice(0, 300) };
    }
    try {
      return await sendAppServerGuidance({
        sessionId, text, mode, attachments, rolloutPath: session.rolloutPath,
      });
    } catch (fallbackError) {
      return {
        ok: false,
        message: `桌面通道失败：${String(error.message || error)}；备用通道失败：${String(fallbackError.message || fallbackError)}`
          .slice(0, 300),
      };
    }
  }
}

async function createWindow() {
  const attachmentDirectory = path.join(app.getPath('userData'), 'guidance-attachments');
  cleanupStaleGuidanceAttachments({ storageDirectory: attachmentDirectory });
  sendNativeGuidance = createNativeGuidanceSender({ attachmentDirectory });
  sendAppServerGuidance = createAppServerGuidanceSender({ client: appServerClient, attachmentDirectory });
  const config = loadConfig();
  if (!repositoryInbox) {
    const credentialStore = createGitHubCredentialStore({
      safeStorage,
      readConfig,
      writeConfig,
    });
    repositoryInbox = createRepositoryInboxController({
      reader: createRepositoryInboxReader(),
      credentialStore,
      readConfig,
      writeConfig,
    });
  }
  refreshSessions();
  await refreshOfficialMetadata();
  const machineId = config.machineId || crypto.randomUUID();
  const machineName = config.machineName || os.hostname();
  const openAtLogin = config.openAtLogin !== false;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin });
  saveConfig({ machineId, machineName });
  const pairingToken = config.pairingToken || crypto.randomBytes(24).toString('base64url');
  const preferredPort = config.port || 43117;
  monitorServer = await createMonitorServer({
    machineId,
    machineName,
    snapshot,
    pairingToken,
    preferredPort,
    androidRelease: androidRelease(),
    evidenceFile,
    sendGuidance,
    validateGuidanceRequest,
    sendGoalCommand: goalCommands.send,
    validateGoalCommandRequest: goalCommands.validate,
  });
  saveConfig({ machineId, machineName, pairingToken, port: monitorServer.port });
  relaySettings = new RelaySettingsController({
    monitorServer,
    machineId,
    machineName,
    token: pairingToken,
    snapshot,
    sendGuidance,
    validateGuidanceRequest,
    sendGoalCommand: goalCommands.send,
    validateGoalCommandRequest: goalCommands.validate,
    evidenceFile,
    saveConfig,
  });
  relaySettings.restore(config);

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#f3f5f4',
    title: 'Codex Monitor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => { void repositoryInbox.refresh(); });
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
  const rootId = [...normalizeSelectedSessionIds(sessions, [id])][0];
  if (rootId && value) selected.add(rootId);
  else if (rootId) selected.delete(rootId);
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
  relaySettings?.rename(machineName);
  saveConfig({ machineName });
  return machineName;
});
ipcMain.handle('machine:auto-start', (_event, value) => {
  const openAtLogin = Boolean(value);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin });
  saveConfig({ openAtLogin });
  return openAtLogin;
});
ipcMain.handle('repository-inbox:status', () => repositoryInbox.status());
ipcMain.handle('repository-inbox:refresh', () => repositoryInbox.refresh());
ipcMain.handle('repository-inbox:set-token', (_event, value) => (
  repositoryInbox.setToken(String(value || ''))
));
ipcMain.handle('repository-inbox:clear-token', () => repositoryInbox.clearToken());

const windowLifecycle = createSingleInstanceWindowLifecycle({
  app,
  getWindow: () => mainWindow,
  createWindow,
});

if (windowLifecycle.primary) {
  windowLifecycle.bind();
  app.whenReady().then(() => windowLifecycle.ensureWindow());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    void windowLifecycle.ensureWindow();
  });
  app.on('before-quit', () => {
    repositoryInbox?.close();
    relaySettings?.close();
    monitorServer?.close();
    appServerClient.close();
  });
}
