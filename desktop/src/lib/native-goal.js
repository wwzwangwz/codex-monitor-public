const WebSocket = require('ws');
const {
  CdpClient,
  assertLoopbackUrl,
  delay,
  isCodexMainPage,
} = require('./native-guidance');
const { validateGoalCommand } = require('./goal-control');

const DEBUG_ENDPOINT = 'http://127.0.0.1:9229/json/list';

function createNativeGoalCommander({
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
  debugEndpoint = process.env.CODEX_DESKTOP_DEBUG_URL || DEBUG_ENDPOINT,
  timeoutMs = 5000,
} = {}) {
  let active = Promise.resolve();

  const execute = async (input) => {
    const { sessionId, command } = validateGoalCommand(input);
    const endpoint = assertLoopbackUrl(debugEndpoint, ['http:', 'https:']);
    let pages;
    try {
      const response = await fetchImpl(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      pages = await response.json();
    } catch {
      throw new Error('cannot connect to the Codex desktop native Goal channel');
    }
    const page = pages.find(isCodexMainPage);
    if (!page) throw new Error('cannot find the Codex desktop main window');

    const cdp = new CdpClient(assertLoopbackUrl(page.webSocketDebuggerUrl, ['ws:', 'wss:']), {
      WebSocketImpl,
      timeoutMs,
    });
    const target = JSON.stringify(sessionId);
    try {
      await cdp.open();
      const navigation = await cdp.evaluate(`(async () => {
        const id = ${target};
        const modulePath = [...document.querySelectorAll('link[rel="modulepreload"]')]
          .map((link) => link.getAttribute('href'))
          .find((href) => /assets\\/app-initial-[^/]+\\.js$/.test(href || ''));
        if (!modulePath) return { invoked: false, reason: 'module_not_found' };
        const appModule = await import(location.origin + '/' + modulePath.replace(/^\\.\\//, ''));
        const services = Object.values(appModule).find((value) => (
          value
          && typeof value === 'object'
          && value.appActions
          && typeof value.appActions.runInPrimaryWindow === 'function'
        ));
        if (!services) return { invoked: false, reason: 'app_actions_not_found' };
        await services.appActions.runInPrimaryWindow({
          action: {
            kind: 'codex',
            type: 'windows.show_thread',
            windowId: 'current',
            threadId: id,
          },
        });
        return { invoked: true };
      })()`);
      if (!navigation?.invoked) throw new Error('Codex desktop native conversation navigation is unavailable');

      let current;
      const deadline = Date.now() + timeoutMs;
      do {
        current = await cdp.evaluate(`document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id') || null`);
        if (current === sessionId) break;
        await delay(100);
      } while (Date.now() < deadline);
      if (current !== sessionId) throw new Error('Codex desktop did not switch to the target conversation');

      const actionName = command === 'resume' ? 'set-thread-goal-status' : 'clear-thread-goal';
      const invocation = await cdp.evaluate(`(async () => {
        const id = ${target};
        const actionName = ${JSON.stringify(actionName)};
        const modulePath = [...document.querySelectorAll('link[rel="modulepreload"]')]
          .map((link) => link.getAttribute('href'))
          .find((href) => /assets\\/app-initial-[^/]+\\.js$/.test(href || ''));
        if (!modulePath) return { invoked: false, reason: 'module_not_found' };
        const moduleHref = location.origin + '/' + modulePath.replace(/^\\.\\//, '');
        const source = await (await fetch(moduleHref)).text();
        const marker = String.fromCharCode(96) + actionName + String.fromCharCode(96);
        const markerIndex = source.indexOf(marker);
        if (markerIndex < 0) return { invoked: false, reason: 'native_action_not_found' };
        const prefix = source.slice(Math.max(0, markerIndex - 100), markerIndex);
        const localMatch = prefix.match(/([A-Za-z_$][\\w$]*)\\($/);
        if (!localMatch) return { invoked: false, reason: 'dispatcher_local_not_found' };
        const exportStart = source.lastIndexOf('export{');
        if (exportStart < 0) return { invoked: false, reason: 'dispatcher_export_not_found' };
        const exportPair = source.slice(exportStart + 7).split(',')
          .map((part) => part.trim())
          .find((part) => part.startsWith(localMatch[1] + ' as '));
        const exportKey = exportPair?.slice((localMatch[1] + ' as ').length).match(/^[A-Za-z_$][\\w$]*/)?.[0];
        if (!exportKey) return { invoked: false, reason: 'dispatcher_export_not_found' };
        const appModule = await import(moduleHref);
        const dispatcher = appModule[exportKey];
        if (typeof dispatcher !== 'function') {
          return { invoked: false, reason: 'dispatcher_export_not_found' };
        }
        const result = actionName === 'set-thread-goal-status'
          ? await dispatcher(actionName, {
            conversationId: id,
            hostId: 'local',
            status: 'active',
          })
          : await dispatcher(actionName, {
            conversationId: id,
            hostId: 'local',
          });
        return { invoked: true, action: actionName, nativeStatus: result?.status || null };
      })()`);
      if (!invocation?.invoked) {
        if (invocation?.reason === 'dispatcher_export_not_found') {
          throw new Error('Codex desktop native Goal dispatcher is unavailable');
        }
        throw new Error(`Codex desktop native Goal action is unavailable: ${invocation?.reason || 'unknown'}`);
      }
      return {
        ok: true,
        message: command === 'resume'
          ? 'Goal resumed through the Codex desktop native channel'
          : 'Goal association cleared through the Codex desktop native channel',
      };
    } finally {
      cdp.close();
    }
  };

  return (input) => {
    const result = active.then(() => execute(input));
    active = result.catch(() => {});
    return result;
  };
}

module.exports = { createNativeGoalCommander };
