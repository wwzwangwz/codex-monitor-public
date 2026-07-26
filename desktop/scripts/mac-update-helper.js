#!/usr/bin/env node

const {
  createMacUpdateOperations,
  waitForProcessExit,
} = require('../src/lib/mac-update-operations');
const {
  runMacUpdateTransaction,
} = require('../src/lib/mac-update-transaction');

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error('Mac 更新助手参数不完整');
    result[key.slice(2)] = value;
  }
  return result;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  for (const name of ['installed-app', 'candidate-app', 'transaction-id', 'machine-id', 'wait-pid']) {
    if (!args[name]) throw new Error(`Mac 更新助手缺少 --${name}`);
  }

  await waitForProcessExit(Number(args['wait-pid']));
  const operations = createMacUpdateOperations({
    expectedMachineId: args['machine-id'],
  });
  const result = await runMacUpdateTransaction({
    installedAppPath: args['installed-app'],
    candidateAppPath: args['candidate-app'],
    transactionId: args['transaction-id'],
    operations,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
