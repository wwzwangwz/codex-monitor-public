const WebSocket = require('ws');

const endpoint = process.env.CODEX_DESKTOP_DEBUG_URL || 'http://127.0.0.1:9229/json/list';

async function evaluate(page, expression) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runtime probe timed out')), 5000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description
          || message.result.exceptionDetails.text
          || 'runtime probe evaluation failed'));
      }
      else resolve(message.result?.result?.value);
    });
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
}

async function main() {
  const response = await fetch(endpoint);
  const pages = await response.json();
  const page = pages.find((item) => (
    item.type === 'page'
    && item.url?.startsWith('app://-/')
    && !item.url.includes('avatar-overlay')
  ));
  if (!page) throw new Error('Codex desktop main page is unavailable');
  const result = await evaluate(page, `(async () => {
    const modulePath = [...document.querySelectorAll('link[rel="modulepreload"]')]
      .map((link) => link.getAttribute('href'))
      .find((href) => /assets\\/app-initial-[^/]+\\.js$/.test(href || ''));
    const moduleHref = location.origin + '/' + modulePath.replace(/^\\.\\//, '');
    const [appModule, source] = await Promise.all([
      import(moduleHref),
      fetch(moduleHref).then((response) => response.text()),
    ]);
    const nativeGoalActions = ['set-thread-goal-status', 'clear-thread-goal'].map((actionName) => {
      const marker = String.fromCharCode(96) + actionName + String.fromCharCode(96);
      const markerIndex = source.indexOf(marker);
      const prefix = markerIndex < 0 ? '' : source.slice(Math.max(0, markerIndex - 100), markerIndex);
      const localName = prefix.match(/([A-Za-z_$][\\w$]*)\\($/)?.[1] || null;
      const exportStart = source.lastIndexOf('export{');
      const exportPair = localName && exportStart >= 0
        ? source.slice(exportStart + 7).split(',')
          .map((part) => part.trim())
          .find((part) => part.startsWith(localName + ' as '))
        : null;
      const exportKey = exportPair?.slice((localName + ' as ').length).match(/^[A-Za-z_$][\\w$]*/)?.[0] || null;
      return { actionName, localName, exportKey, callable: typeof appModule[exportKey] === 'function' };
    });
    return {
      modulePath,
      nativeGoalActions,
      currentConversationId: document.querySelector('[data-above-composer-conversation-id]')
        ?.getAttribute('data-above-composer-conversation-id') || null,
      sidebarThreads: [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .map((item) => item.getAttribute('data-app-action-sidebar-thread-id'))
        .filter(Boolean),
      services: Object.entries(appModule).filter(([, value]) => (
        value && typeof value === 'object' && value.appActions
      )).map(([key, value]) => ({
        key,
        appActions: Object.keys(value.appActions || {}),
        appActionsPrototype: Object.getOwnPropertyNames(Object.getPrototypeOf(value.appActions || {})),
        primaryRuntime: Object.keys(value.primaryRuntime || {}),
        primaryRuntimePrototype: Object.getOwnPropertyNames(Object.getPrototypeOf(value.primaryRuntime || {})),
      })),
      matchingFunctions: Object.entries(appModule).flatMap(([key, value]) => {
        if (typeof value !== 'function') return [];
        try {
          const source = Function.prototype.toString.call(value);
          return /set-thread-goal-status|clear-thread-goal/.test(source)
            ? [{ key, source: source.slice(0, 1000) }]
            : [];
        } catch {
          return [];
        }
      }),
    };
  })()`);
  console.log(JSON.stringify({ page: { title: page.title, url: page.url }, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
