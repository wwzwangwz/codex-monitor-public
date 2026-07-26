(function exposeNativeChannel(globalObject) {
  const labels = {
    checking: '检查中',
    ready: '正常',
    offline: '未开启',
    repairing: '修复中',
    error: '修复失败',
  };
  const states = new Set(Object.keys(labels));

  function createNativeChannelView({ api, elements }) {
    let repairPromise = null;

    function render(status) {
      const state = states.has(status?.state) ? status.state : 'error';
      elements.root.dataset.state = state;
      elements.state.textContent = labels[state];
      elements.message.textContent = String(status?.message || (
        state === 'error' ? '原生信道暂时不可用，请重试' : ''
      ));
      elements.repair.disabled = status?.busy === true || Boolean(repairPromise);
    }

    function renderLocalError() {
      render({
        state: 'error',
        ready: false,
        busy: false,
        message: '原生信道暂时不可用，请重试',
      });
    }

    function refresh() {
      return Promise.resolve()
        .then(() => api.getNativeChannel())
        .then(render)
        .catch(renderLocalError);
    }

    function repair() {
      if (repairPromise) return repairPromise;
      render({
        state: 'repairing',
        ready: false,
        busy: true,
        message: '正在重启 Codex 并恢复原生信道',
      });
      const operation = Promise.resolve()
        .then(() => api.repairNativeChannel())
        .then(render)
        .catch(renderLocalError)
        .finally(() => {
          if (repairPromise === operation) repairPromise = null;
          elements.repair.disabled = false;
        });
      repairPromise = operation;
      return operation;
    }

    function bind() {
      elements.repair.addEventListener('click', repair);
      return refresh();
    }

    return {
      render,
      refresh,
      repair,
      bind,
    };
  }

  const exported = { createNativeChannelView };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (globalObject) globalObject.nativeChannelView = exported;
}(typeof window === 'undefined' ? null : window));

