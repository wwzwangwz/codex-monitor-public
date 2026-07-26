const STATES = new Set(['checking', 'ready', 'offline', 'repairing', 'error']);

function publicNativeChannelStatus(value) {
  const state = STATES.has(value?.state) ? value.state : 'error';
  return {
    state,
    ready: value?.ready === true,
    busy: value?.busy === true,
    message: String(value?.message || '').slice(0, 120),
  };
}

function registerNativeChannelIpc({ ipcMain, getController }) {
  const controller = () => {
    const value = getController();
    if (!value) throw new Error('native channel controller is not initialized');
    return value;
  };
  ipcMain.handle('native-channel:get', async () => (
    publicNativeChannelStatus(await controller().get())
  ));
  ipcMain.handle('native-channel:repair', async () => (
    publicNativeChannelStatus(await controller().repair())
  ));
}

module.exports = {
  publicNativeChannelStatus,
  registerNativeChannelIpc,
};

