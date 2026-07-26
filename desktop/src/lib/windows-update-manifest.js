const crypto = require('node:crypto');

const TOP_KEYS = [
  'schema',
  'product',
  'platform',
  'version',
  'publishedAt',
  'asset',
  'rollback',
  'releaseNotesZh',
];
const SIGNED_KEYS = [...TOP_KEYS, 'signature'];
const ASSET_KEYS = ['kind', 'url', 'sha256', 'sizeBytes'];
const ROLLBACK_KEYS = ['version', 'kind', 'url', 'sha256', 'sizeBytes'];
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PUBLISHED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const RELEASE_PATH_PATTERN = /^\/wwzwangwz\/codex-monitor-public\/releases\/download\/[^/]+\/[^/]+$/;

class WindowsUpdateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WindowsUpdateError';
    this.code = code;
  }
}

function fail(code = 'invalid_manifest') {
  throw new WindowsUpdateError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key, index) => key === keys[index]);
}

function parseVersion(value) {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) fail();
  return match.slice(1).map((part) => BigInt(part));
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function validatePublishedAt(value) {
  const match = PUBLISHED_AT_PATTERN.exec(value);
  if (!match) fail();
  const expected = match.slice(1, 7).map(Number);
  const milliseconds = Number(match[7] || 0);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail();
  const actual = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  if (actual.some((part, index) => part !== expected[index])
      || date.getUTCMilliseconds() !== milliseconds) fail();
}

function validateReleaseUrl(value) {
  if (typeof value !== 'string' || /%(?:2f|5c)/i.test(value)) fail();
  let target;
  try {
    target = new URL(value);
  } catch {
    return fail();
  }
  if (
    target.protocol !== 'https:'
    || target.origin !== 'https://github.com'
    || target.username
    || target.password
    || target.search
    || target.hash
    || target.href !== value
    || !RELEASE_PATH_PATTERN.test(target.pathname)
  ) fail();
}

function validateAsset(value, expectedKinds) {
  if (!hasExactKeys(value, ASSET_KEYS) || !expectedKinds.has(value.kind)) fail();
  validateReleaseUrl(value.url);
  if (!SHA256_PATTERN.test(value.sha256)
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes <= 0) fail();
  return {
    kind: value.kind,
    url: value.url,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  };
}

function validateRollback(value, targetVersion) {
  if (!hasExactKeys(value, ROLLBACK_KEYS) || value.kind !== 'rollback') fail();
  parseVersion(value.version);
  if (compareVersions(value.version, targetVersion) >= 0) fail();
  validateReleaseUrl(value.url);
  if (!SHA256_PATTERN.test(value.sha256)
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes <= 0) fail();
  return {
    version: value.version,
    kind: value.kind,
    url: value.url,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
  };
}

function canonicalUnsigned(value, asset, rollback) {
  return JSON.stringify({
    schema: value.schema,
    product: value.product,
    platform: value.platform,
    version: value.version,
    publishedAt: value.publishedAt,
    asset,
    rollback,
    releaseNotesZh: value.releaseNotesZh,
  });
}

function decodeSignature(value) {
  if (typeof value !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const signature = Buffer.from(value, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== value) fail();
  return signature;
}

function deepFreezeManifest(value) {
  Object.freeze(value.asset);
  Object.freeze(value.rollback);
  return Object.freeze(value);
}

function verifyWindowsUpdateManifest(raw, {
  publicKeyPem,
  currentVersion,
  maxBytes = 64 * 1024,
} = {}) {
  if (!Buffer.isBuffer(raw)
      || !Number.isSafeInteger(maxBytes)
      || maxBytes <= 0
      || raw.length === 0
      || raw.length > maxBytes
      || (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)) fail();
  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  if (!hasExactKeys(parsed, SIGNED_KEYS)
      || parsed.schema !== 2
      || parsed.product !== 'Codex Monitor'
      || parsed.platform !== 'windows') fail();
  parseVersion(currentVersion);
  if (compareVersions(parsed.version, currentVersion) <= 0) fail('update_not_newer');
  validatePublishedAt(parsed.publishedAt);
  if (typeof parsed.releaseNotesZh !== 'string'
      || parsed.releaseNotesZh.length === 0
      || parsed.releaseNotesZh.length > 4000
      || parsed.releaseNotesZh.trim() !== parsed.releaseNotesZh
      || !/\p{Script=Han}/u.test(parsed.releaseNotesZh)) fail();
  const asset = validateAsset(parsed.asset, new Set(['nsis', 'portable']));
  const rollback = validateRollback(parsed.rollback, parsed.version);
  const signature = decodeSignature(parsed.signature);
  const body = canonicalUnsigned(parsed, asset, rollback);
  const canonicalSigned = `${body.slice(0, -1)},"signature":${JSON.stringify(parsed.signature)}}`;
  if (text !== canonicalSigned) fail();
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(body),
      crypto.createPublicKey(publicKeyPem),
      signature,
    );
  } catch {
    return fail('invalid_signature');
  }
  if (!verified) fail('invalid_signature');
  return deepFreezeManifest({
    schema: parsed.schema,
    product: parsed.product,
    platform: parsed.platform,
    version: parsed.version,
    publishedAt: parsed.publishedAt,
    asset,
    rollback,
    releaseNotesZh: parsed.releaseNotesZh,
    signature: parsed.signature,
  });
}

module.exports = {
  WindowsUpdateError,
  verifyWindowsUpdateManifest,
};
