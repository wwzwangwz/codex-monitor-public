const test = require('node:test');
const assert = require('node:assert/strict');
const { enforceNormalWindowAfterShow, restoreNormalWindow } = require('../src/lib/window-bounds');

function fakeWindow({ fullScreen = false, maximized = false } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isFullScreen: () => fullScreen,
    isMaximized: () => maximized,
    setFullScreen: (value) => { calls.push(['setFullScreen', value]); fullScreen = value; },
    unmaximize: () => { calls.push(['unmaximize']); maximized = false; },
    setSize: (width, height) => calls.push(['setSize', width, height]),
    center: () => calls.push(['center']),
  };
}

test('restores a fullscreen or maximized window to the normal bounds', () => {
  const window = fakeWindow({ fullScreen: true, maximized: true });
  assert.equal(restoreNormalWindow(window), true);
  assert.deepEqual(window.calls, [
    ['setFullScreen', false], ['unmaximize'], ['setSize', 1080, 760], ['center'],
  ]);
});

test('reapplies normal bounds after the OS late window restoration', () => {
  const window = fakeWindow();
  let delayed;
  enforceNormalWindowAfterShow(window, {
    setTimeoutImpl: (callback, delay) => { delayed = { callback, delay, unref() {} }; return delayed; },
  });
  assert.equal(delayed.delay, 500);
  delayed.callback();
  assert.equal(window.calls.filter((call) => call[0] === 'setSize').length, 2);
});
