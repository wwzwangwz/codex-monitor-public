const labels = { running: '运行中', blocked: '受阻', completed: '已完成', unknown: '未知' };

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
    document.getElementById('client-version').textContent = `Android ${latestClient.appVersion} · 状态协议 ${latestClient.statusProtocolVersion}`;
    document.getElementById('client-release-notes').innerHTML = latestClient.releaseNotes
      .map((note) => `<p>${escapeHtml(note)}</p>`).join('');
  }
  const input = document.getElementById('machine-name');
  if (document.activeElement !== input) input.value = pairing.machineName;
  document.getElementById('auto-start').checked = pairing.openAtLogin;
}

document.getElementById('refresh').addEventListener('click', loadSessions);
document.getElementById('save-name').addEventListener('click', async () => {
  await window.codexMonitor.renameMachine(document.getElementById('machine-name').value);
  await loadPairing();
});
document.getElementById('auto-start').addEventListener('change', async (event) => {
  await window.codexMonitor.setAutoStart(event.target.checked);
});
const nativeChannel = window.nativeChannelView.createNativeChannelView({
  api: {
    getNativeChannel: () => window.codexMonitor.getNativeChannel(),
    repairNativeChannel: () => window.codexMonitor.repairNativeChannel(),
  },
  elements: {
    root: document.getElementById('native-channel'),
    state: document.getElementById('native-channel-state'),
    message: document.getElementById('native-channel-message'),
    repair: document.getElementById('native-channel-repair'),
  },
});
const repositoryInbox = window.repositoryInboxView.createRepositoryInboxView({
  api: window.codexMonitor,
  elements: {
    root: document.getElementById('repository-inbox'),
    summary: document.getElementById('repository-inbox-summary'),
    documents: {
      'PLATFORM_STATUS.md': {
        sha: document.getElementById('repository-backlog-sha'),
        changed: document.getElementById('repository-backlog-new'),
      },
      'docs/PROTOCOL.md': {
        sha: document.getElementById('repository-windows-task-sha'),
        changed: document.getElementById('repository-windows-task-new'),
      },
    },
    error: document.getElementById('repository-inbox-error'),
    refresh: document.getElementById('repository-inbox-refresh'),
    tokenForm: document.getElementById('repository-token-form'),
    tokenInput: document.getElementById('repository-token'),
    persistence: document.getElementById('repository-inbox-persistence'),
    clearToken: document.getElementById('repository-inbox-clear-token'),
  },
});
const relaySettings = window.relaySettingsView.createRelaySettingsView({
  api: {
    getRelay: () => window.codexMonitor.getRelay(),
    setRelay: async (value) => {
      const result = await window.codexMonitor.setRelay(value);
      await loadPairing();
      return result;
    },
  },
  elements: {
    root: document.getElementById('relay-settings'),
    enabled: document.getElementById('relay-enabled'),
    endpoint: document.getElementById('relay-endpoint'),
    status: document.getElementById('relay-status'),
  },
});
loadSessions();
loadPairing();
void nativeChannel.bind();
void relaySettings.bind();
void repositoryInbox.bind();
setInterval(loadSessions, 3000);
setInterval(loadPairing, 3000);
setInterval(() => { void nativeChannel.refresh(); }, 3000);
setInterval(() => { void relaySettings.refresh(); }, 3000);
