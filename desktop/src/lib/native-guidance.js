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

function validateGuidance({ sessionId, sessionTitle, text, mode, attachments }) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedText = String(text || '').trim();
  const normalizedMode = mode === 'queue' ? 'queue' : mode === 'steer' ? 'steer' : null;
  const normalizedAttachments = validatePreparedAttachments(attachments);
  if (!SESSION_ID_PATTERN.test(normalizedSessionId)) throw new Error('会话 ID 格式无效');
  if ((!normalizedText && !normalizedAttachments.length) || normalizedText.length > 2000) {
    throw new Error('请输入消息或选择图片，文字不能超过 2000 字');
  }
  if (!normalizedMode) throw new Error('发送模式必须是 Steer 或 Queue');
  return {
    sessionId: normalizedSessionId,
    sessionTitle: String(sessionTitle || '').trim().slice(0, 200),
    text: normalizedText,
    mode: normalizedMode,
    attachments: normalizedAttachments,
  };
}

function readFollowUpQueueMode({
  readFileSync = fs.readFileSync,
  file = path.join(os.homedir(), '.codex', 'config.toml'),
} = {}) {
  try {
    const contents = readFileSync(file, 'utf8');
    const matches = [...contents.matchAll(/^\s*followUpQueueMode\s*=\s*["'](steer|queue|interrupt)["']/gm)];
    const value = matches.at(-1)?.[1];
    return value === 'queue' ? 'queue' : 'steer';
  } catch {
    return 'steer';
  }
}

function submissionModifiers(requestedMode, configuredMode, platform = process.platform) {
  if (requestedMode === configuredMode) return 0;
  const commandOrControl = platform === 'darwin' ? 4 : 2;
  return commandOrControl | 8;
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
      if (message.error) request.reject(new Error(message.error.message || 'Codex 调试接口调用失败'));
      else request.resolve(message.result);
    });
    this.socket.on('close', () => this.rejectPending(new Error('Codex 桌面连接已关闭')));
    this.socket.on('error', (error) => this.rejectPending(error));
  }

  async open() {
    if (this.socket.readyState === this.socket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Codex 桌面超时')), this.timeoutMs);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 桌面操作超时：${method}`));
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
    if (result.exceptionDetails) throw new Error('Codex 桌面页面执行失败');
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
    if (!inputNode.nodeId) throw new Error('Codex 桌面未创建图片输入通道');
    await cdp.call('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: files.map((item) => item.path),
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
    if (!dropped?.ok || dropped.count !== files.length) throw new Error('Codex 桌面未接受图片附件');
  } finally {
    await cdp.evaluate(`document.getElementById(${JSON.stringify(inputId)})?.remove(); true`).catch(() => {});
  }

  const names = files.map((item) => item.name);
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
  throw new Error('Codex 桌面未确认全部图片附件');
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
  attachmentDirectory,
  platform = process.platform,
  debugEndpoint = process.env.CODEX_DESKTOP_DEBUG_URL || DEBUG_ENDPOINT,
  timeoutMs = 5000,
  stageAttachments = stageGuidanceAttachments,
  retainAttachments = retainGuidanceAttachments,
} = {}) {
  let active = Promise.resolve();

  const send = async (input) => {
    const { sessionId, sessionTitle, text, mode, attachments } = validateGuidance(input);
    let pages;
    try {
      const response = await fetchImpl(debugEndpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      pages = await response.json();
    } catch {
      throw new Error('无法连接 Codex 桌面原生输入通道，请确认 ChatGPT/Codex 桌面应用正在运行');
    }
    const page = pages.find((item) => item.type === 'page' && item.url === 'app://-/index.html' && item.webSocketDebuggerUrl);
    if (!page) throw new Error('找不到 Codex 桌面主窗口，请先打开 Codex 会话列表');

    const cdp = new CdpClient(page.webSocketDebuggerUrl, { WebSocketImpl, timeoutMs });
    let inserted = false;
    let staged = { files: [], cleanup: () => {} };
    let attachedNames = [];
    let submitted = false;
    try {
      await cdp.open();
      const target = JSON.stringify(sessionId);
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
      if (!selected?.found && sessionTitle) {
        await cdp.evaluate(`(() => {
          [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '搜索')?.click();
          return true;
        })()`);
        await delay(200);
        await cdp.evaluate(`(() => {
          const input = document.querySelector('input[placeholder="搜索任务"]');
          if (!input) return false;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(sessionTitle)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`);
        await delay(500);
        const opened = await cdp.evaluate(`(() => {
          const suffix = ':local:' + ${target};
          const option = [...document.querySelectorAll('[role="dialog"] [role="option"][data-value]')]
            .find((item) => (item.getAttribute('data-value') || '').endsWith(suffix));
          if (!option) return false;
          option.click();
          return true;
        })()`);
        if (!opened) throw new Error('Codex 桌面搜索中找不到该会话，消息未发送');
      } else if (!selected?.found) {
        throw new Error('Codex 桌面搜索中找不到该会话，消息未发送');
      }

      let current;
      const deadline = Date.now() + timeoutMs;
      do {
        current = await cdp.evaluate(`document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id') || null`);
        if (current === sessionId) break;
        await delay(100);
      } while (Date.now() < deadline);
      if (current !== sessionId) throw new Error('Codex 桌面未能切换到目标会话，消息未发送');

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
      if (composer?.reason === 'draft_present') throw new Error('目标会话输入框中已有未发送草稿，请先在电脑端处理');
      if (!composer?.ok) throw new Error('目标会话暂时没有可用的输入框');

      staged = stageAttachments(attachments, { storageDirectory: attachmentDirectory });
      await attachNativeFiles(cdp, staged.files, timeoutMs);
      attachedNames = staged.files.map((item) => item.name);
      await cdp.evaluate(`document.querySelector('[data-codex-composer="true"]')?.focus(); true`);
      if (text) {
        await cdp.call('Input.insertText', { text });
        inserted = true;
      }
      const ready = await cdp.evaluate(`(() => {
        const id = ${target};
        const current = document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id');
        const editor = document.querySelector('[data-codex-composer="true"]');
        const textReady = !${JSON.stringify(text)} || (editor?.innerText || '').includes(${JSON.stringify(text)});
        return current === id && document.activeElement === editor && textReady;
      })()`);
      if (!ready) throw new Error('Codex 桌面未确认图文输入内容，消息未提交');

      const configuredMode = readFollowUpQueueMode({ readFileSync, file: configFile });
      const modifiers = submissionModifiers(mode, configuredMode, platform);
      const key = { modifiers, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
      await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      let accepted = false;
      const acceptanceDeadline = Date.now() + Math.max(3000, timeoutMs);
      do {
        accepted = await cdp.evaluate(draftAttachmentExpression(`
          const id = ${target};
          const current = document.querySelector('[data-above-composer-conversation-id]')
            ?.getAttribute('data-above-composer-conversation-id');
          const editor = document.querySelector('[data-codex-composer="true"]');
          const names = ${JSON.stringify(attachedNames)};
          const textAccepted = !${JSON.stringify(text)}
            || !(editor?.innerText || '').includes(${JSON.stringify(text)});
          const imagesAccepted = names.every((name) => !draftButtons.some((button) =>
            (button.getAttribute('aria-label') || '').includes(name)));
          return current === id && textAccepted && imagesAccepted;
        `));
        if (accepted) break;
        await delay(100);
      } while (Date.now() < acceptanceDeadline);
      if (!accepted) throw new Error('Codex 桌面未接受快捷键，消息未发送');
      inserted = false;
      attachedNames = [];
      submitted = true;
      retainAttachments(staged, { sessionId });
      const attachmentLabel = attachments.length ? `，包含 ${attachments.length} 张图片` : '';
      return {
        ok: true,
        message: mode === 'steer'
          ? `已通过 Codex 桌面原生通道引导当前运行（Steer）${attachmentLabel}`
          : `已通过 Codex 桌面原生通道排队到下一轮（Queue）${attachmentLabel}`,
      };
    } catch (error) {
      try {
        await removeNativeFiles(cdp, attachedNames);
      } catch {
        // Preserve the original delivery error; the user can inspect the draft on desktop.
      }
      if (inserted) {
        try {
          const modifiers = platform === 'darwin' ? 4 : 2;
          const selectAll = { modifiers, windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA' };
          await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll });
          const backspace = { windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' };
          await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...backspace });
          await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...backspace });
        } catch {
          // Preserve the original delivery error; the user can inspect the draft on desktop.
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
  createNativeGuidanceSender,
  readFollowUpQueueMode,
  submissionModifiers,
  validateGuidance,
};
