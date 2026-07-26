function registerRelayIpc({ ipcMain, getController }) {
  const currentController = () => {
    const controller = getController();
    if (!controller) throw new Error('Relay settings are not initialized');
    return controller;
  };

  ipcMain.handle('relay:get', () => currentController().get());
  ipcMain.handle('relay:set', (_event, value) => currentController().set({
    enabled: value?.enabled === true,
    baseUrl: value?.baseUrl,
  }));
}

module.exports = { registerRelayIpc };
