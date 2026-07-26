const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { resolveSigningPlan } = require('../src/lib/mac-signing-policy');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const signingPlan = resolveSigningPlan({
    channel: process.env.CODEX_MONITOR_RELEASE_CHANNEL,
    identity: process.env.CODEX_MONITOR_SIGNING_IDENTITY,
  });
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    signingPlan.identity,
    '--identifier',
    'com.codexmonitor.desktop',
    appPath,
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ], { stdio: 'inherit' });
};
