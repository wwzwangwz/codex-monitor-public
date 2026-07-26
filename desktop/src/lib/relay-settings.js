const { RelayPublisher, relayUrls } = require('./relay-publisher');

const DEFAULT_RELAY_BASE_URL = 'wss://relay.example.com/codex-monitor';

class RelaySettingsController {
  constructor({
    monitorServer,
    machineId,
    machineName,
    token,
    snapshot,
    sendGuidance,
    validateGuidanceRequest,
    sendGoalCommand,
    validateGoalCommandRequest,
    evidenceFile,
    saveConfig = () => {},
    publisherFactory = (options) => new RelayPublisher(options),
  }) {
    this.monitorServer = monitorServer;
    this.machineId = machineId;
    this.machineName = machineName;
    this.token = token;
    this.snapshot = snapshot;
    this.sendGuidance = sendGuidance;
    this.validateGuidanceRequest = validateGuidanceRequest;
    this.sendGoalCommand = sendGoalCommand;
    this.validateGoalCommandRequest = validateGoalCommandRequest;
    this.evidenceFile = evidenceFile;
    this.saveConfig = saveConfig;
    this.publisherFactory = publisherFactory;
    this.publisher = null;
    this.state = {
      enabled: false,
      baseUrl: DEFAULT_RELAY_BASE_URL,
      connected: false,
      message: '远程中继已关闭',
    };
  }

  restore(config = {}) {
    return this.set({
      enabled: config.relayEnabled === true,
      baseUrl: config.relayBaseUrl || DEFAULT_RELAY_BASE_URL,
    }, { persist: false });
  }

  get() {
    return { ...this.state };
  }

  set({ enabled, baseUrl } = {}, { persist = true } = {}) {
    this.publisher?.close();
    this.publisher = null;
    this.monitorServer.setRelayWsUrl('');
    const normalizedBaseUrl = String(baseUrl || DEFAULT_RELAY_BASE_URL).trim();
    if (enabled !== true) {
      this.state = {
        enabled: false,
        baseUrl: normalizedBaseUrl,
        connected: false,
        message: '远程中继已关闭',
      };
      if (persist) {
        this.saveConfig({
          relayEnabled: false,
          relayBaseUrl: normalizedBaseUrl,
        });
      }
      return this.get();
    }

    let candidate;
    try {
      const urls = relayUrls(normalizedBaseUrl, this.machineId);
      candidate = this.publisherFactory({
        baseUrl: normalizedBaseUrl,
        machineId: this.machineId,
        machineName: this.machineName,
        token: this.token,
        snapshot: this.snapshot,
        sendGuidance: this.sendGuidance,
        validateGuidanceRequest: this.validateGuidanceRequest,
        sendGoalCommand: this.sendGoalCommand,
        validateGoalCommandRequest: this.validateGoalCommandRequest,
        evidenceFile: this.evidenceFile,
        onStatus: (status) => {
          if (this.publisher !== candidate) return;
          this.state = {
            ...this.state,
            connected: status?.connected === true,
            message: String(status?.message || '').slice(0, 200),
          };
        },
      });
      this.publisher = candidate;
      this.monitorServer.setRelayWsUrl(urls.phone);
      this.state = {
        enabled: true,
        baseUrl: normalizedBaseUrl,
        connected: false,
        message: '远程中继正在连接',
      };
      candidate.start();
    } catch (error) {
      candidate?.close();
      if (this.publisher === candidate) this.publisher = null;
      this.monitorServer.setRelayWsUrl('');
      const token = String(this.token || '');
      const rawMessage = String(error.message || error);
      const message = (token ? rawMessage.split(token).join('[redacted]') : rawMessage)
        .slice(0, 200);
      this.state = {
        enabled: false,
        baseUrl: normalizedBaseUrl,
        connected: false,
        message,
      };
      if (persist) {
        this.saveConfig({
          relayEnabled: false,
          relayBaseUrl: normalizedBaseUrl,
        });
      }
      return this.get();
    }
    if (persist) {
      this.saveConfig({
        relayEnabled: true,
        relayBaseUrl: normalizedBaseUrl,
      });
    }
    return this.get();
  }

  rename(name) {
    this.machineName = name;
    this.publisher?.rename(name);
  }

  close() {
    this.publisher?.close();
    this.publisher = null;
    this.monitorServer.setRelayWsUrl('');
    this.state = {
      ...this.state,
      enabled: false,
      connected: false,
      message: '远程中继已关闭',
    };
  }
}

module.exports = {
  DEFAULT_RELAY_BASE_URL,
  RelaySettingsController,
};
