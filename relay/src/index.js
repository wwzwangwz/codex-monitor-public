const { createRelayServer } = require('./server');
const { pushSenderFromEnvironment } = require('./push');

function readTokens() {
  try {
    const value = JSON.parse(process.env.CODEX_MONITOR_RELAY_DEVICE_TOKENS || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('must be an object');
    return value;
  } catch (error) {
    throw new Error(`CODEX_MONITOR_RELAY_DEVICE_TOKENS is invalid JSON: ${error.message}`);
  }
}

createRelayServer({
  deviceTokens: readTokens(),
  preferredPort: Number(process.env.PORT) || 8080,
  host: process.env.RELAY_HOST || '127.0.0.1',
  sendPush: pushSenderFromEnvironment(),
}).then(({ host, port }) => {
  console.log(`Codex Monitor relay listening on ${host}:${port}`);
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
