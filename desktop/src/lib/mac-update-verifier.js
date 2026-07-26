const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { assertUpdateBundleIdentity } = require('./mac-signing-policy');

const execFileAsync = promisify(execFile);

function versionParts(value) {
  const normalized = String(value || '').trim();
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) {
    throw new Error(`Mac 版本号不合法：${normalized || '(空)'}`);
  }
  return normalized.split('.').map(Number);
}

function compareVersions(left, right) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function assertNewerVersion(installedVersion, candidateVersion) {
  if (compareVersions(candidateVersion, installedVersion) <= 0) {
    throw new Error(`候选版本 ${candidateVersion} 必须高于已安装版本 ${installedVersion}`);
  }
  return true;
}

async function verifyMacUpdateArchive(archivePath, { size, sha256 } = {}) {
  const normalizedSha = String(sha256 || '').trim().toLowerCase();
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Mac 更新清单大小不合法');
  if (!/^[a-f0-9]{64}$/.test(normalizedSha)) throw new Error('Mac 更新清单 SHA-256 不合法');
  const stat = await fs.promises.stat(archivePath);
  if (!stat.isFile() || stat.size !== size) throw new Error('Mac 更新包大小校验失败');
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(archivePath)) digest.update(chunk);
  if (digest.digest('hex') !== normalizedSha) throw new Error('Mac 更新包 SHA-256 校验失败');
  return true;
}

async function readBundleMetadata(appPath, execFileImpl = execFileAsync) {
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  let stdout;
  try {
    ({ stdout } = await execFileImpl(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', infoPath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(`无法读取 Mac App 元数据：${error.stderr || error.message || error}`);
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Mac App Info.plist 不是有效数据');
  }
  const bundleId = String(value.CFBundleIdentifier || '').trim();
  const version = String(value.CFBundleShortVersionString || value.CFBundleVersion || '').trim();
  if (!bundleId || !version) throw new Error('Mac App 缺少 bundle ID 或版本号');
  return { bundleId, version };
}

async function verifyCodeSignature(appPath, execFileImpl = execFileAsync) {
  try {
    await execFileImpl(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    throw new Error(`Mac App 签名校验失败：${error.stderr || error.message || error}`);
  }
  return true;
}

async function verifyMacUpdateCandidate({
  installedAppPath,
  candidateAppPath,
  expectedBundleId = 'com.codexmonitor.desktop',
  readBundleMetadataImpl = readBundleMetadata,
  verifyCodeSignatureImpl = verifyCodeSignature,
  assertUpdateBundleIdentityImpl = assertUpdateBundleIdentity,
} = {}) {
  await verifyCodeSignatureImpl(installedAppPath);
  await verifyCodeSignatureImpl(candidateAppPath);
  await assertUpdateBundleIdentityImpl({ installedAppPath, candidateAppPath });

  const installed = await readBundleMetadataImpl(installedAppPath);
  const candidate = await readBundleMetadataImpl(candidateAppPath);
  if (installed.bundleId !== expectedBundleId || candidate.bundleId !== expectedBundleId) {
    throw new Error(`Mac 更新 bundle ID 不一致，必须为 ${expectedBundleId}`);
  }
  assertNewerVersion(installed.version, candidate.version);
  return { installed, candidate };
}

module.exports = {
  assertNewerVersion,
  compareVersions,
  readBundleMetadata,
  verifyCodeSignature,
  verifyMacUpdateArchive,
  verifyMacUpdateCandidate,
};
