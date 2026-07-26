function sendIfAlive(window, channel, ...args) {
  if (!window || window.isDestroyed?.()) return false;
  const contents = window.webContents;
  if (!contents || contents.isDestroyed?.()) return false;
  contents.send(channel, ...args);
  return true;
}

module.exports = { sendIfAlive };
