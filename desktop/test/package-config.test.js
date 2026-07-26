const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const packageConfig = require('../package.json');

test('macOS package declares why Codex Monitor needs local network access', () => {
  assert.equal(
    packageConfig.build.mac.extendInfo?.NSLocalNetworkUsageDescription,
    '允许手机在局域网中连接此 Mac 并监控 Codex 会话。',
  );
});

test('macOS package declares protected-folder access for evidence images', () => {
  const info = packageConfig.build.mac.extendInfo;
  assert.match(info.NSDocumentsFolderUsageDescription, /证据图片/);
  assert.match(info.NSDesktopFolderUsageDescription, /证据图片/);
  assert.match(info.NSDownloadsFolderUsageDescription, /证据图片/);
  assert.match(info.NSRemovableVolumesUsageDescription, /证据图片/);
});

test('desktop package applies the stable app identity before distributables are built', () => {
  assert.equal(packageConfig.build.afterPack, 'scripts/after-pack.js');
});

test('Mac release build defaults to the stable signing gate', () => {
  const buildScript = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'build-mac-on-mac512.sh'),
    'utf8',
  );
  assert.match(
    buildScript,
    /CODEX_MONITOR_RELEASE_CHANNEL:-stable/,
  );
  assert.match(buildScript, /check-mac-signing\.js/);
});

test('desktop exposes a read-only identity check before any in-place update', () => {
  assert.equal(
    packageConfig.scripts['verify:mac-update'],
    'node scripts/verify-mac-update-identity.js',
  );
});

test('Mac package carries the detached transactional update helper', () => {
  assert.ok(packageConfig.build.files.includes('scripts/mac-update-helper.js'));
});
