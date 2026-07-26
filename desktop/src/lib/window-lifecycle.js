function restoreWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createSingleInstanceWindowLifecycle({ app, getWindow, createWindow }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return {
      primary: false,
      bind() {},
      ensureWindow: async () => undefined,
    };
  }

  let creatingWindow;
  async function ensureWindow() {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      restoreWindow(window);
      return window;
    }
    if (!creatingWindow) {
      creatingWindow = Promise.resolve(createWindow()).finally(() => {
        creatingWindow = undefined;
      });
    }
    return creatingWindow;
  }

  return {
    primary: true,
    bind() {
      app.on('second-instance', () => {
        void ensureWindow();
      });
    },
    ensureWindow,
  };
}

module.exports = { createSingleInstanceWindowLifecycle };
