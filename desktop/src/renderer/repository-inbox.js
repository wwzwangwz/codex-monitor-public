(function exposeRepositoryInbox(globalObject) {
  function shortSha(value) {
    return /^[a-f0-9]{40}$/.test(value || '') ? value.slice(0, 7) : '-------';
  }

  function commitLabel(metadata) {
    if (!metadata) return null;
    const time = new Date(metadata.committedAt);
    if (Number.isNaN(time.getTime())) return shortSha(metadata.commit);
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(time);
    return `${shortSha(metadata.commit)} · ${formatted}`;
  }

  function createRepositoryInboxView({ api, elements }) {
    let currentStatus = null;
    let refreshPromise = null;

    function render(status) {
      currentStatus = status;
      const hasCredential = Boolean(status?.hasCredential);
      const refreshing = Boolean(status?.refreshing);
      elements.root.dataset.state = refreshing ? 'loading' : (status?.error ? 'error' : 'ready');
      elements.tokenForm.hidden = hasCredential;
      elements.clearToken.hidden = !hasCredential;
      elements.refresh.disabled = refreshing || !hasCredential;
      elements.persistence.textContent = hasCredential
        ? (status.persistentCredential
          ? '凭据已由 Windows 加密保存'
          : '凭据仅在本次运行中有效')
        : '';
      elements.summary.textContent = commitLabel(status?.metadata)
        || (hasCredential ? '尚未同步 main' : '需要 GitHub 只读凭据');
      const documents = new Map((status?.metadata?.documents || []).map((item) => [item.path, item]));
      for (const [path, nodes] of Object.entries(elements.documents)) {
        const document = documents.get(path);
        nodes.sha.textContent = document ? shortSha(document.blobSha) : '-------';
        nodes.changed.hidden = !document?.changed;
      }
      elements.error.textContent = status?.error?.message || '';
      elements.error.hidden = !status?.error;
    }

    function renderLocalError() {
      render({
        ...(currentStatus || {
          hasCredential: false,
          persistentCredential: false,
          metadata: null,
        }),
        refreshing: false,
        error: { code: 'ipc_failed', message: '仓库收件箱暂时不可用' },
      });
    }

    function load() {
      return Promise.resolve(api.repositoryInboxStatus())
        .then(render)
        .catch(renderLocalError);
    }

    function refresh() {
      if (refreshPromise) return refreshPromise;
      if (currentStatus) render({ ...currentStatus, refreshing: true });
      else elements.refresh.disabled = true;
      let request;
      try {
        request = api.refreshRepositoryInbox();
      } catch (error) {
        request = Promise.reject(error);
      }
      refreshPromise = Promise.resolve(request)
        .then(render)
        .catch(renderLocalError)
        .finally(() => { refreshPromise = null; });
      return refreshPromise;
    }

    function submitToken() {
      const token = elements.tokenInput.value;
      elements.tokenInput.value = '';
      return Promise.resolve()
        .then(() => api.setRepositoryToken(token))
        .then(render)
        .catch(renderLocalError);
    }

    function clearToken() {
      return Promise.resolve(api.clearRepositoryToken())
        .then(render)
        .catch(renderLocalError);
    }

    function bind() {
      elements.refresh.addEventListener('click', refresh);
      elements.tokenForm.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitToken();
      });
      elements.clearToken.addEventListener('click', clearToken);
      return load();
    }

    return { render, load, refresh, submitToken, clearToken, bind };
  }

  const exported = { createRepositoryInboxView };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (globalObject) globalObject.repositoryInboxView = exported;
}(typeof window === 'undefined' ? null : window));
