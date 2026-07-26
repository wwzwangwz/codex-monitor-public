function restoreNormalWindow(window, { width = 1080, height = 760 } = {}) {
  if (!window || window.isDestroyed?.()) return false;
  if (window.isFullScreen()) window.setFullScreen(false);
  if (window.isMaximized()) window.unmaximize();
  window.setSize(width, height);
  window.center();
  return true;
}

function enforceNormalWindowAfterShow(window, {
  delayMs = 500,
  setTimeoutImpl = setTimeout,
} = {}) {
  restoreNormalWindow(window);
  const timer = setTimeoutImpl(() => restoreNormalWindow(window), delayMs);
  timer?.unref?.();
  return timer;
}

module.exports = { enforceNormalWindowAfterShow, restoreNormalWindow };
