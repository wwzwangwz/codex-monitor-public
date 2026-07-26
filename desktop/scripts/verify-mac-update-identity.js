#!/usr/bin/env node

const {
  assertUpdateBundleIdentity,
  readDesignatedRequirement,
} = require('../src/lib/mac-signing-policy');

const [, , installedAppPath, candidateAppPath] = process.argv;
if (!installedAppPath || !candidateAppPath) {
  process.stderr.write(
    '用法：npm run verify:mac-update -- "/Applications/Codex Monitor.app" "/候选路径/Codex Monitor.app"\n',
  );
  process.exitCode = 2;
} else {
  assertUpdateBundleIdentity({
    installedAppPath,
    candidateAppPath,
  });
  process.stdout.write('原位更新签名门禁通过：候选包与已安装包身份一致。\n');
  process.stdout.write(`已安装：${readDesignatedRequirement(installedAppPath)}\n`);
  process.stdout.write(`候选包：${readDesignatedRequirement(candidateAppPath)}\n`);
}
