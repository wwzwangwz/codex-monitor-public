const { spawnSync } = require('node:child_process');

function normalize(value) {
  return String(value || '').trim();
}

function resolveSigningPlan({ channel = 'development', identity = '' } = {}) {
  const normalizedChannel = normalize(channel).toLowerCase() || 'development';
  const normalizedIdentity = normalize(identity);

  if (!['development', 'stable'].includes(normalizedChannel)) {
    throw new Error(`未知发布通道：${normalizedChannel}`);
  }

  if (normalizedChannel === 'stable') {
    if (!normalizedIdentity) {
      throw new Error('稳定版必须配置固定签名身份');
    }
    if (normalizedIdentity === '-') {
      throw new Error('稳定版不能使用临时签名');
    }
    return {
      channel: 'stable',
      identity: normalizedIdentity,
      adHoc: false,
    };
  }

  const developmentIdentity = normalizedIdentity || '-';
  return {
    channel: 'development',
    identity: developmentIdentity,
    adHoc: developmentIdentity === '-',
  };
}

function assertUpdateIdentity({
  installedRequirement = '',
  candidateRequirement = '',
} = {}) {
  const installed = normalize(installedRequirement);
  const candidate = normalize(candidateRequirement);

  if (/\bcdhash\b/i.test(installed) || /\bcdhash\b/i.test(candidate)) {
    throw new Error('临时签名无法保证权限继承，拒绝原位更新');
  }

  if (!installed || !candidate || installed !== candidate) {
    throw new Error('签名身份不一致，拒绝原位更新');
  }

  return true;
}

function readDesignatedRequirement(appPath, spawnSyncImpl = spawnSync) {
  const normalizedPath = normalize(appPath);
  if (!normalizedPath) {
    throw new Error('缺少待校验的 Mac App 路径');
  }

  const result = spawnSyncImpl(
    '/usr/bin/codesign',
    ['-d', '-r-', normalizedPath],
    { encoding: 'utf8' },
  );
  if (result?.error) {
    throw new Error(`无法读取 Mac 签名身份：${result.error.message}`);
  }
  if (result?.status !== 0) {
    const detail = normalize(result?.stderr || result?.stdout);
    throw new Error(`无法读取 Mac 签名身份${detail ? `：${detail}` : ''}`);
  }

  const requirement = `${result?.stdout || ''}\n${result?.stderr || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(?:#\s*)?designated\s*=>/i.test(line));
  if (!requirement) {
    throw new Error('Mac App 没有可验证的 designated requirement');
  }
  return requirement;
}

function assertUpdateBundleIdentity({
  installedAppPath,
  candidateAppPath,
  spawnSyncImpl = spawnSync,
} = {}) {
  return assertUpdateIdentity({
    installedRequirement: readDesignatedRequirement(installedAppPath, spawnSyncImpl),
    candidateRequirement: readDesignatedRequirement(candidateAppPath, spawnSyncImpl),
  });
}

module.exports = {
  assertUpdateBundleIdentity,
  assertUpdateIdentity,
  readDesignatedRequirement,
  resolveSigningPlan,
};
