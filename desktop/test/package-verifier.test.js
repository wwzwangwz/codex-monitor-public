const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageConfig = require('../package.json');
const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil');
const hasWindowsPackage = fs.existsSync(path.join(
  __dirname,
  '..',
  'dist',
  'win-unpacked',
  'resources',
  'app.asar',
));

test('portable Windows builds reuse one extraction path across updates', () => {
  assert.equal(packageConfig.build.portable.unpackDirName, 'codex-monitor-desktop-portable');
});

test('Windows installer resolves the one fixed product-name directory', () => {
  const oneClick = packageConfig.build.nsis?.oneClick !== false;
  const installDirectory = getWindowsInstallationDirName({
    productFilename: 'Codex Monitor',
    sanitizedName: 'codex-monitor-desktop',
  }, !oneClick);

  assert.equal(installDirectory, 'Codex Monitor');
  assert.equal(packageConfig.build.nsis.allowToChangeInstallationDirectory, false);
});

test('packaged Windows verifier accepts only the controlled app-server process boundary', {
  skip: !hasWindowsPackage,
}, () => {
  const project = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(project, 'scripts', 'verify-windows-package.js')], {
    cwd: project,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(
    report.artifacts.map((artifact) => path.basename(artifact.file)),
    [
      `Codex Monitor ${packageConfig.version}.exe`,
      `Codex Monitor Setup ${packageConfig.version}.exe`,
    ],
  );
});

test('packaged Windows verifier confirms the repository inbox boundary', {
  skip: !hasWindowsPackage,
}, () => {
  const project = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(project, 'scripts', 'verify-windows-package.js')], {
    cwd: project,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.repositoryInbox, {
    exactShaReader: true,
    encryptedCredential: true,
    ipcBoundary: true,
    renderer: true,
  });
});

test('packaged Windows verifier confirms the signed update safety boundary', {
  skip: !hasWindowsPackage,
}, () => {
  const project = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(project, 'scripts', 'verify-windows-package.js')], {
    cwd: project,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.windowsUpdate, {
    publicKey: true,
    manifestVerifier: true,
    atomicDownload: true,
    rollbackSnapshot: true,
    privateKeyAbsent: true,
    installerLaunchAbsent: true,
  });
});

test('packaged Windows verifier confirms the bounded native-channel repair boundary', {
  skip: !hasWindowsPackage,
}, () => {
  const project = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(project, 'scripts', 'verify-windows-package.js')], {
    cwd: project,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.nativeChannel, {
    controller: true,
    ipc: true,
    renderer: true,
    loopbackOnly: true,
    fixedLaunchArguments: true,
    processBoundary: true,
  });
});
