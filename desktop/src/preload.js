const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexMonitor', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  toggleSession: (id, selected) => ipcRenderer.invoke('sessions:toggle', id, selected),
  getPairing: () => ipcRenderer.invoke('pairing:get'),
  renameMachine: (name) => ipcRenderer.invoke('machine:rename', name),
  setAutoStart: (enabled) => ipcRenderer.invoke('machine:auto-start', enabled),
  getNativeChannel: () => ipcRenderer.invoke('native-channel:get'),
  repairNativeChannel: () => ipcRenderer.invoke('native-channel:repair'),
  getRelay: () => ipcRenderer.invoke('relay:get'),
  setRelay: (value) => ipcRenderer.invoke('relay:set', value),
  getController: () => ipcRenderer.invoke('controller:get'),
  addControlledDevice: (code) => ipcRenderer.invoke('controller:add', code),
  removeControlledDevice: (id) => ipcRenderer.invoke('controller:remove', id),
  sendRemoteGuidance: (value) => ipcRenderer.invoke('controller:send', value),
  sendRemoteGoalCommand: (value) => ipcRenderer.invoke('controller:goal', value),
  onControllerUpdate: (callback) => ipcRenderer.on('controller:update', (_event, nodes) => callback(nodes)),
  onRelayUpdate: (callback) => ipcRenderer.on('relay:update', (_event, value) => callback(value)),
});
