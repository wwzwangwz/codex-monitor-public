const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const {
  retainGuidanceAttachments,
  stageGuidanceAttachments,
  validatePreparedAttachments,
} = require('./attachments');

const DEBUG_ENDPOINT = 'http://127.0.0.1:9229/json/list';
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rolloutReceipt(rolloutPath, start, text, attachmentPaths) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return false;
  let contents;
  try {
    const size = fs.statSync(rolloutPath).size;
    if (size <= start) return false;
    const fd = fs.openSync(rolloutPath, 'r');
    const buffer = Buffer.alloc(size - start);
    try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
    contents = buffer.toString('utf8');
  } catch {
    return false;
  }
  for (const line of contents.split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record?.type === 'event_msg' && record.payload?.type === 'user_message'
      ? record.payload : null;
    if (!payload) continue;
    const textMatches = !text || String(payload.message || '').includes(text);
    const images = Array.isArray(payload.local_images) ? payload.local_images : [];
    const imagesMatch = attachmentPaths.every((file) => images.includes(file));
    if (textMatches && imagesMatch) return true;
  }
  return false;
}

async function waitForRolloutReceipt(rolloutPath, start, text, attachmentPaths, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (rolloutReceipt(rolloutPath, start, text, attachmentPaths)) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return false;
}

function validateGuidance({ sessionId, text, mode, attachments, rolloutPath }) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedText = String(text || '').trim();
  const normalizedMode = mode === 'queue' ? 'queue' : mode === 'steer' ? 'steer' : null;
  const normalizedAttachments = validatePreparedAttachments(attachments);
  if (!SESSION_ID_PATTERN.test(normalizedSessionId)) throw new Error('session ID format is invalid');
  if ((!normalizedText && !normalizedAttachments.length) || normalizedText.length > 2000) {
    throw new Error('provide a message or image; message length must not exceed 2000 characters');
  }
  if (!normalizedMode) throw new Error('send mode must be Steer or Queue');
  return {
    sessionId: normalizedSessionId,
    text: normalizedText,
    mode: normalizedMode,
    attachments: normalizedAttachments,
    ...(typeof rolloutPath === 'string' && rolloutPath ? { rolloutPath } : {}),
  };
}

function assertLoopbackUrl(value, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codex debug URL must be a loopback URL');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('Codex debug URL must be a loopback URL');
  }
  return url.toString();
}

function isCodexMainPage(item) {
  if (item?.type !== 'page' || !item.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === 'app:'
      && url.hostname === '-'
      && url.searchParams.get('initialRoute') !== '/avatar-overlay';
  } catch {
    return false;
  }
}

function readFollowUpQueueMode({
  readFileSync = fs.readFileSync,
  file = path.join(os.homedir(), '.codex', 'config.toml'),
} = {}) {
  try {
    const contents = readFileSync(file, 'utf8');
    const matches = [...contents.matchAll(/^\s*followUpQueueMode\s*=\s*["'](steer|queue|interrupt)["']/gm)];
    return matches.at(-1)?.[1] === 'queue' ? 'queue' : 'steer';
  } catch {
    return 'steer';
  }
}

function readComposerEnterBehavior({
  readFileSync = fs.readFileSync,
  file = path.join(os.homedir(), '.codex', 'config.toml'),
} = {}) {
  try {
    const contents = readFileSync(file, 'utf8');
    const matches = [...contents.matchAll(/^\s*composerEnterBehavior\s*=\s*["'](enter|cmdIfMultiline|cmdAlways)["']/gm)];
    return matches.at(-1)?.[1] || 'enter';
  } catch {
    return 'enter';
  }
}

function submissionModifiers(
  requestedMode,
  configuredMode,
  platform = process.platform,
  composerEnterBehavior = 'enter',
) {
  if (requestedMode === configuredMode) return 0;
  const commandOrControl = platform === 'darwin' ? 4 : 2;
  return composerEnterBehavior === 'enter' ? commandOrControl : commandOrControl | 8;
}

class CdpClient {
  constructor(url, { WebSocketImpl = WebSocket, timeoutMs = 5000 } = {}) {
    this.socket = new WebSocketImpl(url);
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || 'Codex debug operation failed'));
      else request.resolve(message.result);
    });
    this.socket.on('close', () => this.rejectPending(new Error('Codex desktop connection closed')));
    this.socket.on('error', (error) => this.rejectPending(error));
  }

  async open() {
    if (this.socket.readyState === this.socket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connection to Codex desktop timed out')), this.timeoutMs);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex desktop operation timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error('Codex desktop page execution failed');
    return result.result?.value;
  }

  rejectPending(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}

function draftAttachmentExpression(body) {
  return `(() => {
    const draftButtons = [...document.querySelectorAll('button[aria-label]')].filter((button) =>
      button.parentElement?.querySelector('img[alt="User attachment"], img[alt="用户附件"]'));
    ${body}
  })()`;
}

async function attachNativeFiles(cdp, files, timeoutMs) {
  if (!files.length) return;
  const inputId = `codex-monitor-${crypto.randomUUID()}`;
  await cdp.evaluate(`(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = ${JSON.stringify(inputId)};
    input.style.display = 'none';
    document.body.appendChild(input);
    return true;
  })()`);
  try {
    const documentNode = await cdp.call('DOM.getDocument');
    const inputNode = await cdp.call('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: `#${inputId}`,
    });
    if (!inputNode.nodeId) throw new Error('Codex desktop did not create the attachment input');
    await cdp.call('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: files.map((file) => file.path),
    });
    const dropped = await cdp.evaluate(`(() => {
      const input = document.getElementById(${JSON.stringify(inputId)});
      const editor = document.querySelector('[data-codex-composer="true"]');
      if (!input?.files?.length || !editor) return { ok: false, count: 0 };
      const transfer = new DataTransfer();
      for (const file of input.files) transfer.items.add(file);
      const accepted = !editor.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
      }));
      input.remove();
      return { ok: accepted, count: transfer.files.length };
    })()`);
    if (!dropped?.ok || dropped.count !== files.length) {
      throw new Error('Codex desktop did not accept the image attachments');
    }
  } finally {
    await cdp.evaluate(`document.getElementById(${JSON.stringify(inputId)})?.remove(); true`).catch(() => {});
  }

  const names = files.map((file) => file.name);
  const deadline = Date.now() + timeoutMs;
  do {
    const ready = await cdp.evaluate(draftAttachmentExpression(`
      const names = ${JSON.stringify(names)};
      return names.every((name) => draftButtons.some((button) =>
        (button.getAttribute('aria-label') || '').includes(name)));
    `));
    if (ready) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Codex desktop did not confirm every image attachment');
}

async function removeNativeFiles(cdp, names) {
  if (!names.length) return;
  await cdp.evaluate(draftAttachmentExpression(`
    const names = ${JSON.stringify(names)};
    for (const button of draftButtons) {
      const label = button.getAttribute('aria-label') || '';
      if (names.some((name) => label.includes(name))) button.click();
    }
    return true;
  `));
}

function createNativeGuidanceSender({
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
  readFileSync = fs.readFileSync,
  configFile,
  platform = process.platform,
  debugEndpoint = process.env.CODEX_DESKTOP_DEBUG_URL || DEBUG_ENDPOINT,
  timeoutMs = 5000,
  acceptanceTimeoutMs = 1500,
  attachmentDirectory,
  stageAttachments = stageGuidanceAttachments,
  retainAttachments = retainGuidanceAttachments,
} = {}) {
  let active = Promise.resolve();

  const send = async (input) => {
    const { sessionId, text, mode, attachments } = validateGuidance(input);
    const endpoint = assertLoopbackUrl(debugEndpoint, ['http:', 'https:']);
    let pages;
    try {
      const response = await fetchImpl(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      pages = await response.json();
    } catch {
      throw new Error('cannot connect to the Codex desktop native input channel');
    }
    const page = pages.find(isCodexMainPage);
    if (!page) throw new Error('cannot find the Codex desktop main window');

    const cdp = new CdpClient(assertLoopbackUrl(page.webSocketDebuggerUrl, ['ws:', 'wss:']), { WebSocketImpl, timeoutMs });
    const target = JSON.stringify(sessionId);
    let inserted = false;
    let staged = { files: [], cleanup: () => {} };
    let attachedNames = [];
    let submitted = false;
    try {
      await cdp.open();
      const selected = await cdp.evaluate(`(() => {
        const id = ${target};
        const current = document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id');
        if (current === id) return { found: true, current };
        const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .find((item) => item.getAttribute('data-app-action-sidebar-thread-id') === 'local:' + id);
        if (!row) return { found: false, current };
        row.click();
        return { found: true, current };
      })()`);
      if (!selected?.found) {
        const navigation = await cdp.evaluate(`(async () => {
          const id = ${target};
          const modulePath = [...document.querySelectorAll('link[rel="modulepreload"]')]
            .map((link) => link.getAttribute('href'))
            .find((href) => /assets\\/app-initial-[^/]+\\.js$/.test(href || ''));
          if (!modulePath) return { invoked: false, reason: 'module_not_found' };
          const moduleHref = location.origin + '/' + modulePath.replace(/^\\.\\//, '');
          const appModule = await import(moduleHref);
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
      }

      let current;
      const deadline = Date.now() + timeoutMs;
      do {
        current = await cdp.evaluate(`document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id') || null`);
        if (current === sessionId) break;
        await delay(100);
      } while (Date.now() < deadline);
      if (current !== sessionId) throw new Error('Codex desktop did not switch to the target conversation');

      const composer = await cdp.evaluate(`(() => {
        const id = ${target};
        const current = document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id');
        const editor = document.querySelector('[data-codex-composer="true"]');
        const value = editor?.innerText?.replace(/\\n/g, '').trim() || '';
        const draftAttachments = [...document.querySelectorAll('button[aria-label]')].filter((button) =>
          button.parentElement?.querySelector('img[alt="User attachment"], img[alt="用户附件"]'));
        if (current !== id) return { ok: false, reason: 'wrong_thread' };
        if (!editor) return { ok: false, reason: 'no_composer' };
        if (value || draftAttachments.length) return { ok: false, reason: 'draft_present' };
        editor.focus();
        return { ok: true };
      })()`);
      if (composer?.reason === 'draft_present') throw new Error('the target conversation has an unsent desktop draft');
      if (!composer?.ok) throw new Error('the target conversation has no available composer');

      staged = stageAttachments(attachments, { storageDirectory: attachmentDirectory });
      await attachNativeFiles(cdp, staged.files, timeoutMs);
      attachedNames = staged.files.map((file) => file.name);
      await cdp.evaluate(`document.querySelector('[data-codex-composer="true"]')?.focus(); true`);
      if (text) {
        await cdp.call('Input.insertText', { text });
        inserted = true;
      }
      const ready = attachments.length
        ? await cdp.evaluate(draftAttachmentExpression(`
          const id = ${target};
          const current = document.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id');
          const editor = document.querySelector('[data-codex-composer="true"]');
          const names = ${JSON.stringify(attachedNames)};
          const textReady = !${JSON.stringify(text)}
            || (editor?.innerText || '') === ${JSON.stringify(text)};
          const imagesReady = names.every((name) => draftButtons.some((button) =>
            (button.getAttribute('aria-label') || '').includes(name)));
          return current === id && document.activeElement === editor && textReady && imagesReady;
        `))
        : await cdp.evaluate(`(() => {
          const id = ${target};
          const current = document.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id');
          const editor = document.querySelector('[data-codex-composer="true"]');
          return current === id && document.activeElement === editor && (editor?.innerText || '') === ${JSON.stringify(text)};
        })()`);
      if (!ready) throw new Error('Codex desktop did not confirm the inserted message');

      const configuredMode = readFollowUpQueueMode({ readFileSync, file: configFile });
      const composerEnterBehavior = readComposerEnterBehavior({ readFileSync, file: configFile });
      const key = {
        modifiers: submissionModifiers(mode, configuredMode, platform, composerEnterBehavior),
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
      };
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      let accepted = false;
      const acceptanceDeadline = Date.now() + acceptanceTimeoutMs;
      do {
        accepted = attachments.length
          ? await cdp.evaluate(draftAttachmentExpression(`
            const id = ${target};
            const current = document.querySelector('[data-above-composer-conversation-id]')
              ?.getAttribute('data-above-composer-conversation-id');
            const editor = document.querySelector('[data-codex-composer="true"]');
            const names = ${JSON.stringify(attachedNames)};
            const textAccepted = !${JSON.stringify(text)}
              || (editor?.innerText || '') !== ${JSON.stringify(text)};
            const imagesAccepted = names.every((name) => !draftButtons.some((button) =>
              (button.getAttribute('aria-label') || '').includes(name)));
            return current === id && Boolean(editor) && textAccepted && imagesAccepted;
          `))
          : await cdp.evaluate(`(() => {
            const id = ${target};
            const current = document.querySelector('[data-above-composer-conversation-id]')
              ?.getAttribute('data-above-composer-conversation-id');
            const editor = document.querySelector('[data-codex-composer="true"]');
            return current === id && Boolean(editor) && (editor.innerText || '').trim() === '';
          })()`);
        if (accepted) break;
        await delay(100);
      } while (Date.now() < acceptanceDeadline);
      if (!accepted) {
        const fallback = await cdp.evaluate(`(() => {
          const id = ${target};
          const current = document.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id');
          const editor = document.querySelector('[data-codex-composer="true"]');
          if (current !== id || !editor || (editor.innerText || '') !== ${JSON.stringify(text)}) {
            return { clicked: false, reason: 'composer_changed' };
          }
          const root = editor.closest('form') || editor.parentElement?.parentElement || document;
          const buttons = [...root.querySelectorAll('button')];
          const submit = buttons.find((button) => button.type === 'submit' && !button.disabled)
            || buttons.find((button) => /send|submit|发送|提交/i.test(button.getAttribute('aria-label') || '') && !button.disabled);
          if (!submit) return { clicked: false, reason: 'submit_not_found' };
          submit.click();
          return { clicked: true };
        })()`);
        if (!fallback?.clicked) throw new Error('Codex desktop did not accept Enter and no usable send button was found');
        const fallbackDeadline = Date.now() + Math.max(2000, acceptanceTimeoutMs);
        do {
          accepted = attachments.length
            ? await cdp.evaluate(draftAttachmentExpression(`
              const id = ${target};
              const current = document.querySelector('[data-above-composer-conversation-id]')
                ?.getAttribute('data-above-composer-conversation-id');
              const editor = document.querySelector('[data-codex-composer="true"]');
              const names = ${JSON.stringify(attachedNames)};
              return current === id && Boolean(editor)
                && (!${JSON.stringify(text)} || (editor.innerText || '').trim() === '')
                && names.every((name) => !draftButtons.some((button) =>
                  (button.getAttribute('aria-label') || '').includes(name)));
            `))
            : await cdp.evaluate(`(() => {
              const current = document.querySelector('[data-above-composer-conversation-id]')
                ?.getAttribute('data-above-composer-conversation-id');
              const editor = document.querySelector('[data-codex-composer="true"]');
              return current === ${target} && Boolean(editor) && (editor.innerText || '').trim() === '';
            })()`);
          if (accepted) break;
          await delay(100);
        } while (Date.now() < fallbackDeadline);
      }
      if (!accepted) throw new Error('Codex desktop send button did not submit the message');
      inserted = false;
      attachedNames = [];
      retainAttachments(staged, { sessionId });
      submitted = true;
      const attachmentLabel = attachments.length === 1
        ? ' with 1 image'
        : attachments.length > 1 ? ` with ${attachments.length} images` : '';
      return {
        ok: true,
        message: mode === 'steer'
          ? `Sent through the Codex desktop native channel (Steer)${attachmentLabel}`
          : `Queued through the Codex desktop native channel (Queue)${attachmentLabel}`,
      };
    } catch (error) {
      try {
        await removeNativeFiles(cdp, attachedNames);
      } catch {
        // Keep the original delivery error; the desktop draft remains visible for recovery.
      }
      if (inserted) {
        try {
          const safeToClear = await cdp.evaluate(`(() => {
            const id = ${target};
            const current = document.querySelector('[data-above-composer-conversation-id]')
              ?.getAttribute('data-above-composer-conversation-id');
            const editor = document.querySelector('[data-codex-composer="true"]');
            return current === id && document.activeElement === editor && (editor?.innerText || '') === ${JSON.stringify(text)};
          })()`);
          if (safeToClear) {
            const modifiers = platform === 'darwin' ? 4 : 2;
            const selectAll = { modifiers, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' };
            await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
            await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll });
            const backspace = { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' };
            await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...backspace });
            await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...backspace });
          }
        } catch {
          // Keep the original delivery error; the desktop draft remains visible for recovery.
        }
      }
      throw error;
    } finally {
      if (!submitted) staged.cleanup();
      cdp.close();
    }
  };

  return (input) => {
    const result = active.then(() => send(input));
    active = result.catch(() => {});
    return result;
  };
}

module.exports = {
  CdpClient,
  createNativeGuidanceSender,
  delay,
  isCodexMainPage,
  readComposerEnterBehavior,
  readFollowUpQueueMode,
  submissionModifiers,
  validateGuidance,
  assertLoopbackUrl,
  rolloutReceipt,
  waitForRolloutReceipt,
};
