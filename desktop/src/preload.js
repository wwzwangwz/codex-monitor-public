const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexMonitor', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  toggleSession: (id, selected) => ipcRenderer.invoke('sessions:toggle', id, selected),
  getPairing: () => ipcRenderer.invoke('pairing:get'),
  renameMachine: (name) => ipcRenderer.invoke('machine:rename', name),
  setAutoStart: (enabled) => ipcRenderer.invoke('machine:auto-start', enabled),
  getRelay: () => ipcRenderer.invoke('relay:get'),
  setRelay: (value) => ipcRenderer.invoke('relay:set', value),
  getNativeChannel: () => ipcRenderer.invoke('native-channel:get'),
  repairNativeChannel: () => ipcRenderer.invoke('native-channel:repair'),
  repositoryInboxStatus: () => ipcRenderer.invoke('repository-inbox:status'),
  refreshRepositoryInbox: () => ipcRenderer.invoke('repository-inbox:refresh'),
  setRepositoryToken: (token) => ipcRenderer.invoke('repository-inbox:set-token', token),
  clearRepositoryToken: () => ipcRenderer.invoke('repository-inbox:clear-token'),
});
