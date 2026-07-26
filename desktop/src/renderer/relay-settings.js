(function exposeRelaySettings(globalObject) {
  const DEFAULT_RELAY_BASE_URL = 'wss://relay.example.com/codex-monitor';

  function createRelaySettingsView({ api, elements }) {
    let currentStatus = null;
    let settingPromise = null;

    function render(status) {
      currentStatus = {
        enabled: status?.enabled === true,
        baseUrl: String(status?.baseUrl || DEFAULT_RELAY_BASE_URL),
        connected: status?.connected === true,
        message: String(status?.message || ''),
      };
      elements.enabled.checked = currentStatus.enabled;
      elements.endpoint.textContent = currentStatus.baseUrl;
      elements.status.textContent = currentStatus.message;
      elements.root.dataset.state = currentStatus.connected
        ? 'connected'
        : (currentStatus.enabled ? 'connecting' : 'off');
    }

    function renderLocalError() {
      render(currentStatus || {
        enabled: false,
        baseUrl: DEFAULT_RELAY_BASE_URL,
        connected: false,
        message: '远程中继已关闭',
      });
      elements.root.dataset.state = 'error';
      elements.status.textContent = '远程中继暂时不可用';
    }

    function refresh() {
      return Promise.resolve()
        .then(() => api.getRelay())
        .then(render)
        .catch(renderLocalError);
    }

    function setEnabled() {
      if (settingPromise) return settingPromise;
      elements.enabled.disabled = true;
      const request = {
        enabled: elements.enabled.checked,
        baseUrl: currentStatus?.baseUrl || DEFAULT_RELAY_BASE_URL,
      };
      settingPromise = Promise.resolve()
        .then(() => api.setRelay(request))
        .then(render)
        .catch(renderLocalError)
        .finally(() => {
          settingPromise = null;
          elements.enabled.disabled = false;
        });
      return settingPromise;
    }

    function bind() {
      elements.enabled.addEventListener('change', setEnabled);
      return refresh();
    }

    return {
      render,
      refresh,
      setEnabled,
      bind,
    };
  }

  const exported = { createRelaySettingsView };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (globalObject) globalObject.relaySettingsView = exported;
}(typeof window === 'undefined' ? null : window));
