const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { version } = require('../package.json');

const dist = path.join(__dirname, '..', 'dist');
const archive = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
const resourcesDirectory = path.dirname(archive);
const updatePublicKeyFile = path.join(resourcesDirectory, 'windows-update-ed25519-public.pem');
const artifacts = [
  path.join(dist, `Codex Monitor ${version}.exe`),
  path.join(dist, `Codex Monitor Setup ${version}.exe`),
];
const sourceFiles = asar.listPackage(archive)
  .filter((file) => file.startsWith('\\src\\') && file.endsWith('.js'));
const sourceEntries = sourceFiles.map((file) => ({
  file: file.replaceAll('\\', '/'),
  source: asar.extractFile(archive, file.slice(1)).toString('utf8'),
}));
const source = sourceEntries.map((entry) => entry.source).join('\n');
const forbidden = [
  /codex\s+exec\s+resume/i,
  /thread\/delete/,
  /archive-conversation/,
  /(?<![.\w$])(?:exec|execFile|execSync|execFileSync|fork|spawnSync)\s*\(/,
  /shell\s*:\s*true/,
];

for (const pattern of forbidden) {
  if (pattern.test(source)) throw new Error(`packaged source contains forbidden pattern: ${pattern}`);
}
for (const entry of sourceEntries) {
  if (/child_process/.test(entry.source)
    && !['/src/lib/app-server.js', '/src/lib/codex-native-channel.js'].includes(entry.file)) {
    throw new Error(`packaged source uses child_process outside app-server: ${entry.file}`);
  }
}
const installerLaunchPatterns = [
  /(?<![.\w$])(?:spawn|spawnSync|exec|execFile|execSync|execFileSync|fork)\s*\(/,
  /\bshell\.openPath\s*\(/,
];
for (const entry of sourceEntries) {
  if (entry.file === '/src/lib/app-server.js') continue;
  for (const pattern of installerLaunchPatterns) {
    if (pattern.test(entry.source)) {
      throw new Error(`packaged source can launch an installer outside app-server: ${entry.file}`);
    }
  }
}
for (const required of [
  'set-thread-goal-status',
  'clear-thread-goal',
  'windows.show_thread',
  'DOM.setFileInputFiles',
  'codex-monitor-guidance-',
  "const { spawn } = require('node:child_process')",
  "['--enable', 'goals', 'app-server', '--listen', 'stdio://']",
  '/repos/wwzwangwz/codex-monitor-public',
  '/commits/main',
  'githubTokenEncrypted',
  'safeStorage.encryptString',
  'repository-inbox:status',
  'repository-inbox:refresh',
  'repository-inbox:set-token',
  'repository-inbox:clear-token',
  'createRepositoryInboxView',
  'wss://relay.example.com/codex-monitor',
  '/relay/device/',
  '/relay/phone/',
  'relay:get',
  'relay:set',
  'setRelayWsUrl',
  'createRelaySettingsView',
  'native-channel:get',
  'native-channel:repair',
  'createNativeChannelView',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9229',
]) {
  if (!source.includes(required)) throw new Error(`packaged source is missing ${required}`);
}

const repositoryInbox = {
  exactShaReader: source.includes('/commits/main')
    && source.includes('?ref=${commit}')
    && sourceFiles.includes('\\src\\lib\\repository-inbox.js'),
  encryptedCredential: source.includes('safeStorage.encryptString')
    && sourceFiles.includes('\\src\\lib\\github-credential.js'),
  ipcBoundary: [
    'repository-inbox:status',
    'repository-inbox:refresh',
    'repository-inbox:set-token',
    'repository-inbox:clear-token',
  ].every((name) => source.includes(name)),
  renderer: sourceFiles.includes('\\src\\renderer\\repository-inbox.js')
    && source.includes('createRepositoryInboxView'),
};
if (Object.values(repositoryInbox).includes(false)) {
  throw new Error(`packaged repository inbox boundary is incomplete: ${JSON.stringify(repositoryInbox)}`);
}

const relaySourceFiles = [
  '\\src\\lib\\relay-publisher.js',
  '\\src\\lib\\relay-settings.js',
  '\\src\\lib\\relay-ipc.js',
  '\\src\\renderer\\relay-settings.js',
];
const relaySources = sourceEntries
  .filter((entry) => relaySourceFiles.includes(entry.file.replaceAll('/', '\\')))
  .map((entry) => entry.source)
  .join('\n');
const relay = {
  publisher: sourceFiles.includes('\\src\\lib\\relay-publisher.js'),
  settings: sourceFiles.includes('\\src\\lib\\relay-settings.js'),
  ipc: sourceFiles.includes('\\src\\lib\\relay-ipc.js')
    && source.includes('relay:get')
    && source.includes('relay:set'),
  renderer: sourceFiles.includes('\\src\\renderer\\relay-settings.js')
    && source.includes('createRelaySettingsView'),
  defaultOff: source.includes('config.relayEnabled === true'),
  v2Pairing: source.includes('lanWsUrl')
    && source.includes('relayWsUrl')
    && source.includes('setRelayWsUrl'),
  tokenLoggingAbsent: !/console\.(?:log|info|warn|error|debug)\s*\(/.test(relaySources),
};
if (Object.values(relay).includes(false)) {
  throw new Error(`packaged Relay boundary is incomplete: ${JSON.stringify(relay)}`);
}

const nativeChannelSourceFiles = [
  '\\src\\lib\\codex-native-channel.js',
  '\\src\\lib\\native-channel-ipc.js',
  '\\src\\renderer\\native-channel.js',
];
const nativeChannelSources = sourceEntries
  .filter((entry) => nativeChannelSourceFiles.includes(entry.file.replaceAll('/', '\\')))
  .map((entry) => entry.source)
  .join('\n');
const nativeChannel = {
  controller: sourceFiles.includes('\\src\\lib\\codex-native-channel.js')
    && source.includes('new CodexNativeChannelController'),
  ipc: sourceFiles.includes('\\src\\lib\\native-channel-ipc.js')
    && source.includes('registerNativeChannelIpc')
    && source.includes('native-channel:get')
    && source.includes('native-channel:repair'),
  renderer: sourceFiles.includes('\\src\\renderer\\native-channel.js')
    && source.includes('createNativeChannelView')
    && source.includes('getNativeChannel')
    && source.includes('repairNativeChannel'),
  loopbackOnly: nativeChannelSources.includes('http://127.0.0.1:9229/json/list')
    && nativeChannelSources.includes('--remote-debugging-address=127.0.0.1')
    && !nativeChannelSources.includes('--remote-debugging-address=0.0.0.0'),
  fixedLaunchArguments: nativeChannelSources.includes('--remote-debugging-port=9229')
    && nativeChannelSources.includes('invalid Codex Desktop launch arguments'),
  processBoundary: nativeChannelSources.includes("Get-AppxPackage -Name 'OpenAI.Codex'")
    && nativeChannelSources.includes('2p2nqsd0c76g0')
    && nativeChannelSources.includes('ProcessId = $targetPid'),
};
if (Object.values(nativeChannel).includes(false)) {
  throw new Error(`packaged native channel boundary is incomplete: ${JSON.stringify(nativeChannel)}`);
}

function listResourcePaths(directory, prefix = '') {
  const paths = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    paths.push(relative);
    if (entry.isDirectory()) paths.push(...listResourcePaths(path.join(directory, entry.name), relative));
  }
  return paths;
}

const privateMaterialPatterns = [
  /private[-_ ]?key/i,
  /-----BEGIN (?:ED25519 )?PRIVATE KEY-----/,
];
const resourcePaths = listResourcePaths(resourcesDirectory);
const privateScanText = [
  ...sourceEntries.map((entry) => `${entry.file}\n${entry.source}`),
  ...resourcePaths,
].join('\n');
for (const pattern of privateMaterialPatterns) {
  if (pattern.test(privateScanText)) throw new Error(`packaged files reference private key material: ${pattern}`);
}

let publicKey = null;
try {
  publicKey = crypto.createPublicKey(fs.readFileSync(updatePublicKeyFile));
} catch {
  throw new Error('packaged Windows update public key is missing or invalid');
}
const publicKeyValid = publicKey.type === 'public' && publicKey.asymmetricKeyType === 'ed25519';
if (!publicKeyValid) throw new Error('packaged Windows update public key is not Ed25519');

const windowsUpdate = {
  publicKey: publicKeyValid,
  manifestVerifier: sourceFiles.includes('\\src\\lib\\windows-update-manifest.js'),
  atomicDownload: sourceFiles.includes('\\src\\lib\\windows-update-download.js'),
  rollbackSnapshot: sourceFiles.includes('\\src\\lib\\windows-update-rollback.js'),
  privateKeyAbsent: true,
  installerLaunchAbsent: true,
};
if (Object.values(windowsUpdate).includes(false)) {
  throw new Error(`packaged Windows update boundary is incomplete: ${JSON.stringify(windowsUpdate)}`);
}

const report = artifacts.map((file) => {
  const contents = fs.readFileSync(file);
  return {
    file,
    size: contents.length,
    sha256: crypto.createHash('sha256').update(contents).digest('hex').toUpperCase(),
  };
});
console.log(JSON.stringify({
  archive,
  sourceFileCount: sourceFiles.length,
  repositoryInbox,
  relay,
  nativeChannel,
  windowsUpdate,
  artifacts: report,
}, null, 2));
