const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'windows-build.yml'),
  'utf8',
);

test('Windows CI builds the package before running packaged-boundary tests', () => {
  const build = workflow.indexOf('npx electron-builder --win nsis portable --publish never');
  const packagedTests = workflow.indexOf('name: Test source and packaged Windows boundaries');

  assert.notEqual(build, -1);
  assert.notEqual(packagedTests, -1);
  assert.ok(build < packagedTests);
});

test('Windows CI verifies and uploads the same default dist package', () => {
  assert.doesNotMatch(workflow, /config\.directories\.output=dist-windows/);
  assert.match(workflow, /desktop\/dist\/\*\.exe/);
  assert.match(workflow, /desktop\/dist\/latest\.yml/);
});
