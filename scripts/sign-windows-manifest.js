#!/usr/bin/env node

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const PRIVATE_KEY = process.env.CODEX_MONITOR_WINDOWS_UPDATE_PRIVATE_KEY;
const ORDER = ['schema', 'product', 'platform', 'version', 'publishedAt', 'asset', 'rollback', 'releaseNotesZh'];
const ASSET_ORDER = ['kind', 'url', 'sha256', 'sizeBytes'];
const ROLLBACK_ORDER = ['version', 'kind', 'url', 'sha256', 'sizeBytes'];

function fail(message) {
  console.error(`manifest signing failed: ${message}`);
  process.exit(1);
}

function orderedObject(value, keys) {
  const result = {};
  for (const key of keys) {
    if (!(key in value)) fail(`missing field: ${key}`);
    result[key] = value[key];
  }
  return result;
}

function assertExactKeys(value, keys, section) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${section} contains missing or unknown fields`);
  }
}

function semverParts(value, field) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) fail(`${field} must be semver`);
  return value.split('.').map(Number);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validate(manifest) {
  assertExactKeys(manifest, ORDER, 'manifest');
  if (manifest.schema !== 2 || manifest.product !== 'Codex Monitor' || manifest.platform !== 'windows') {
    fail('schema/product/platform mismatch');
  }
  const targetVersion = semverParts(manifest.version, 'version');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.publishedAt)) {
    fail('publishedAt must be UTC ISO-8601');
  }
  for (const section of ['asset', 'rollback']) {
    const item = manifest[section];
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${section} invalid`);
    assertExactKeys(item, section === 'asset' ? ASSET_ORDER : ROLLBACK_ORDER, section);
    if (section === 'asset' && !['nsis', 'portable'].includes(item.kind)) fail('asset.kind invalid');
    if (section === 'rollback' && item.kind !== 'rollback') fail('rollback.kind invalid');
    if (typeof item.url !== 'string' || !/^https:\/\/github\.com\/wwzwangwz\/codex-monitor-public\/releases\/download\//.test(item.url)) {
      fail(`${section}.url must be an immutable GitHub release asset`);
    }
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) {
      fail(`${section} hash/size invalid`);
    }
  }
  const rollbackVersion = semverParts(manifest.rollback.version, 'rollback.version');
  if (compareSemver(rollbackVersion, targetVersion) >= 0) fail('rollback.version must be lower than version');
  if (typeof manifest.releaseNotesZh !== 'string' || !manifest.releaseNotesZh.trim()) fail('releaseNotesZh is required');
}

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) fail('usage: sign-windows-manifest.js INPUT.json OUTPUT.json');
if (!PRIVATE_KEY) fail('CODEX_MONITOR_WINDOWS_UPDATE_PRIVATE_KEY is required');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
} catch (error) {
  fail(`cannot read JSON: ${error.message}`);
}
if (manifest.signature !== undefined) fail('input must not contain signature');
validate(manifest);
const body = JSON.stringify(orderedObject({
  ...manifest,
  asset: orderedObject(manifest.asset, ASSET_ORDER),
  rollback: orderedObject(manifest.rollback, ROLLBACK_ORDER),
}, ORDER));
const signature = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY)));
const signed = `${body.slice(0, -1)},"signature":"${signature.toString('base64')}"}`;
fs.writeFileSync(path.resolve(outputPath), signed, { mode: 0o600 });
