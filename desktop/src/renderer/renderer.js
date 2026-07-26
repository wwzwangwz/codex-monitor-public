const labels = { running: '运行中', blocked: '受阻', completed: '已完成', unknown: '未知' };
const goalLabels = { active: '进行中', blocked: '受阻', usageLimited: '额度受限', budgetLimited: '预算受限' };
const controllerDrafts = new Map();
const controllerResults = new Map();
let controllerSignature = '';

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

async function loadSessions() {
  const sessions = await window.codexMonitor.listSessions();
  const list = document.getElementById('session-list');
  document.getElementById('selection-count').textContent = `${sessions.filter((item) => item.selected).length} 个已选择`;
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">没有找到 Codex 会话</div>';
    return;
  }
  list.innerHTML = sessions.map((session) => `
    <label class="session-row">
      <input type="checkbox" data-id="${session.id}" ${session.selected ? 'checked' : ''} />
      <span class="status-dot ${session.status.state}"></span>
      <span class="session-copy">
        <span class="session-name">${escapeHtml(session.title)}</span>
        <span class="session-message">${escapeHtml(session.status.message)}</span>
      </span>
      <span class="status-label">${labels[session.status.state]}</span>
    </label>
  `).join('');
  list.querySelectorAll('input').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      await window.codexMonitor.toggleSession(checkbox.dataset.id, checkbox.checked);
      await loadSessions();
    });
  });
}

async function loadPairing() {
  const pairing = await window.codexMonitor.getPairing();
  document.getElementById('qr').src = pairing.qr;
  document.getElementById('pair-value').textContent = pairing.value;
  document.getElementById('client-count').textContent = pairing.clients
    ? `${pairing.clients} 台手机已连接`
    : '等待手机扫码';
  const release = document.getElementById('client-release');
  const latestClient = pairing.clientInfo?.sort((a, b) => b.versionCode - a.versionCode)[0];
  release.hidden = !latestClient;
  if (latestClient) {
    const platform = latestClient.platform === 'ios' ? 'iPhone' : 'Android';
    document.getElementById('client-version').textContent = `${platform} ${latestClient.appVersion} · 状态协议 ${latestClient.statusProtocolVersion}`;
    document.getElementById('client-release-notes').innerHTML = latestClient.releaseNotes
      .map((note) => `<p>${escapeHtml(note)}</p>`).join('');
  }
  const input = document.getElementById('machine-name');
  if (document.activeElement !== input) input.value = pairing.machineName;
  document.getElementById('auto-start').checked = pairing.openAtLogin;
}

function renderRelay(value) {
  document.getElementById('relay-enabled').checked = Boolean(value.enabled);
  const input = document.getElementById('relay-url');
  if (document.activeElement !== input) input.value = value.baseUrl || '';
  const status = document.getElementById('relay-status');
  status.textContent = value.message || (value.connected ? '远程中继已连接' : '远程中继未连接');
  status.classList.toggle('connected', Boolean(value.connected));
}

async function loadRelay() {
  renderRelay(await window.codexMonitor.getRelay());
}

function renderNativeChannel(value) {
  const state = document.getElementById('native-channel-state');
  const message = document.getElementById('native-channel-message');
  const button = document.getElementById('repair-native-channel');
  state.textContent = value.repairing ? '修复中' : (value.ready ? '已连接' : '未连接');
  state.classList.toggle('ready', Boolean(value.ready));
  state.classList.toggle('repairing', Boolean(value.repairing));
  message.textContent = value.message || '无法读取输入通道状态';
  button.hidden = value.ready || value.available === false;
  button.disabled = Boolean(value.repairing);
}

async function loadNativeChannel() {
  try {
    renderNativeChannel(await window.codexMonitor.getNativeChannel());
  } catch (error) {
    renderNativeChannel({
      available: true,
      ready: false,
      message: String(error.message || error).replace(/^Error invoking remote method '[^']+':\s*/, ''),
    });
  }
}

function renderController(nodes, force = false) {
  const signature = JSON.stringify(nodes.map((node) => ({
    id: node.id, name: node.name, connected: node.connected, error: node.error, sessions: node.sessions,
  })));
  if (!force && signature === controllerSignature) return;
  controllerSignature = signature;
  document.getElementById('controller-count').textContent = `${nodes.filter((node) => node.connected).length}/${nodes.length} 台在线`;
  const list = document.getElementById('controller-list');
  if (!nodes.length) {
    list.innerHTML = '<div class="controller-empty">尚未连接受控电脑</div>';
    return;
  }
  list.innerHTML = nodes.map((node) => `
    <article class="controlled-device">
      <div class="controlled-device-heading">
        <span class="status-dot ${node.connected ? 'running' : 'unknown'}"></span>
        <div>
          <h3>${escapeHtml(node.name)}</h3>
          <p>${node.connected ? `${node.sessions.length} 个可控会话` : escapeHtml(node.error || '正在重连')}</p>
        </div>
        <button class="remove-device" data-device="${escapeHtml(node.id)}">移除</button>
      </div>
      <div class="controlled-sessions">
        ${node.sessions.length ? node.sessions.map((session) => {
          const key = `${node.id}:${session.id}`;
          const result = controllerResults.get(key) || '';
          const goalStatus = session.goal?.status || '';
          const canResumeGoal = node.connected && session.state !== 'running' &&
            ['blocked', 'usageLimited', 'budgetLimited'].includes(goalStatus);
          const canDeleteGoal = node.connected && Boolean(session.goal);
          return `
            <div class="controlled-session">
              <span class="status-dot ${node.connected ? session.state : 'unknown'}"></span>
              <div class="controlled-session-copy">
                <strong>${escapeHtml(session.title)}</strong>
                <span>${escapeHtml(session.message)}</span>
                ${goalStatus ? `<span class="remote-goal-status">Goal：${escapeHtml(goalLabels[goalStatus] || goalStatus)}</span>` : ''}
              </div>
              <span class="status-label">${node.connected ? labels[session.state] || '未知' : '未知'}</span>
              <div class="remote-guidance">
                <input data-draft-key="${escapeHtml(key)}" value="${escapeHtml(controllerDrafts.get(key) || '')}" placeholder="输入给这个 Windows 会话的指令" />
                <button data-send-key="${escapeHtml(key)}" data-device="${escapeHtml(node.id)}" data-session="${escapeHtml(session.id)}" data-mode="steer" ${node.connected ? '' : 'disabled'}>Steer</button>
                <button data-send-key="${escapeHtml(key)}" data-device="${escapeHtml(node.id)}" data-session="${escapeHtml(session.id)}" data-mode="queue" ${node.connected ? '' : 'disabled'}>Queue</button>
                <span class="remote-result">${escapeHtml(result)}</span>
              </div>
              ${session.goal ? `<div class="remote-goal-actions">
                <button data-goal-command="resume" data-goal-key="${escapeHtml(key)}" data-device="${escapeHtml(node.id)}" data-session="${escapeHtml(session.id)}" ${canResumeGoal ? '' : 'disabled'}>重启 Goal</button>
                <button data-goal-command="delete" data-goal-key="${escapeHtml(key)}" data-device="${escapeHtml(node.id)}" data-session="${escapeHtml(session.id)}" ${canDeleteGoal ? '' : 'disabled'}>删除 Goal</button>
              </div>` : ''}
            </div>`;
        }).join('') : '<p class="controlled-empty">电脑端尚未选择会话</p>'}
      </div>
    </article>
  `).join('');
  list.querySelectorAll('[data-draft-key]').forEach((input) => {
    input.addEventListener('input', () => controllerDrafts.set(input.dataset.draftKey, input.value));
  });
  list.querySelectorAll('[data-send-key]').forEach((button) => {
    button.addEventListener('click', async () => {
      const key = button.dataset.sendKey;
      const text = controllerDrafts.get(key)?.trim() || '';
      if (!text) {
        controllerResults.set(key, '请先输入指令');
        renderController(nodes, true);
        return;
      }
      controllerResults.set(key, '正在发送…');
      renderController(nodes, true);
      const result = await window.codexMonitor.sendRemoteGuidance({
        deviceId: button.dataset.device,
        sessionId: button.dataset.session,
        text,
        mode: button.dataset.mode,
      });
      controllerResults.set(key, result.message || (result.ok ? '已发送' : '发送失败'));
      if (result.ok) controllerDrafts.delete(key);
      renderController(nodes, true);
    });
  });
  list.querySelectorAll('[data-goal-command]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      const key = button.dataset.goalKey;
      const command = button.dataset.goalCommand;
      if (command === 'delete' && !window.confirm('只删除这个 Goal，不删除会话和聊天记录，继续吗？')) return;
      controllerResults.set(key, command === 'delete' ? '正在删除 Goal…' : '正在重启 Goal…');
      renderController(nodes, true);
      const result = await window.codexMonitor.sendRemoteGoalCommand({
        deviceId: button.dataset.device,
        sessionId: button.dataset.session,
        command,
        confirmed: command === 'delete',
      });
      controllerResults.set(key, result.message || (result.ok ? 'Goal 操作已完成' : 'Goal 操作失败'));
      renderController(nodes, true);
    });
  });
  list.querySelectorAll('.remove-device').forEach((button) => {
    button.addEventListener('click', async () => {
      const updated = await window.codexMonitor.removeControlledDevice(button.dataset.device);
      controllerSignature = '';
      renderController(updated);
    });
  });
}

async function loadController() {
  const controller = await window.codexMonitor.getController();
  if (!controller.enabled) return;
  document.getElementById('controller-badge').hidden = false;
  document.getElementById('controller-panel').hidden = false;
  renderController(controller.nodes);
}

document.getElementById('refresh').addEventListener('click', loadSessions);
document.getElementById('save-name').addEventListener('click', async () => {
  await window.codexMonitor.renameMachine(document.getElementById('machine-name').value);
  await loadPairing();
});
document.getElementById('auto-start').addEventListener('change', async (event) => {
  await window.codexMonitor.setAutoStart(event.target.checked);
});
document.getElementById('repair-native-channel').addEventListener('click', async () => {
  if (!window.confirm('修复会正常退出并重新启动一次 Codex。不会强制结束；仍在运行的会话可能被中断。继续吗？')) return;
  const button = document.getElementById('repair-native-channel');
  button.disabled = true;
  renderNativeChannel({
    available: true,
    ready: false,
    repairing: true,
    message: '正在等待 Codex 正常退出并恢复输入通道…',
  });
  try {
    const result = await window.codexMonitor.repairNativeChannel();
    renderNativeChannel({
      available: true,
      ready: Boolean(result.ok),
      message: result.message,
    });
  } catch (error) {
    renderNativeChannel({
      available: true,
      ready: false,
      message: String(error.message || error).replace(/^Error invoking remote method '[^']+':\s*/, ''),
    });
  } finally {
    button.disabled = false;
  }
});
document.getElementById('save-relay').addEventListener('click', async () => {
  const value = await window.codexMonitor.setRelay({
    enabled: document.getElementById('relay-enabled').checked,
    baseUrl: document.getElementById('relay-url').value,
  });
  renderRelay(value);
  await loadPairing();
});
document.getElementById('controller-add-button').addEventListener('click', async () => {
  const error = document.getElementById('controller-error');
  try {
    const code = document.getElementById('controller-code');
    const nodes = await window.codexMonitor.addControlledDevice(code.value);
    code.value = '';
    error.hidden = true;
    controllerSignature = '';
    renderController(nodes);
  } catch (value) {
    error.textContent = String(value.message || value).replace(/^Error invoking remote method '[^']+':\s*/, '');
    error.hidden = false;
  }
});
window.codexMonitor.onControllerUpdate((nodes) => renderController(nodes));
window.codexMonitor.onRelayUpdate(renderRelay);
loadSessions();
loadPairing();
loadRelay();
loadNativeChannel();
loadController();
setInterval(loadSessions, 3000);
setInterval(loadPairing, 3000);
setInterval(loadNativeChannel, 5000);
