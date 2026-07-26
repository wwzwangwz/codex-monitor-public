#!/usr/bin/env node

const { resolveSigningPlan } = require('../src/lib/mac-signing-policy');

const plan = resolveSigningPlan({
  channel: process.env.CODEX_MONITOR_RELEASE_CHANNEL,
  identity: process.env.CODEX_MONITOR_SIGNING_IDENTITY,
});

if (plan.adHoc) {
  process.stdout.write('Mac 开发包：使用临时签名，不得发布为稳定版或覆盖正式安装。\n');
} else {
  process.stdout.write(`Mac 稳定版签名门禁通过：${plan.identity}\n`);
}
