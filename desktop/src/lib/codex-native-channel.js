const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { assertLoopbackUrl, isCodexMainPage } = require('./native-guidance');

const execFileAsync = promisify(execFile);
const CODEX_DEBUG_ENDPOINT = 'http://127.0.0.1:9229/json/list';
const CODEX_DEBUG_ARGUMENTS = Object.freeze([
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9229',
]);

const readyStatus = (message = 'Codex 原生信道正常') => ({
  state: 'ready',
  ready: true,
  busy: false,
  message,
});
const offlineStatus = () => ({
  state: 'offline',
  ready: false,
  busy: false,
  message: '9229 未开启，点击按钮修复',
});
const repairingStatus = () => ({
  state: 'repairing',
  ready: false,
  busy: true,
  message: '正在重启 Codex 并恢复原生信道',
});
const errorStatus = () => ({
  state: 'error',
  ready: false,
  busy: false,
  message: '原生信道修复失败，请重试',
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectCodexNativeChannel({
  fetchImpl = globalThis.fetch,
  endpoint = CODEX_DEBUG_ENDPOINT,
  timeoutMs = 1500,
} = {}) {
  let safeEndpoint;
  try {
    safeEndpoint = assertLoopbackUrl(endpoint, ['http:', 'https:']);
  } catch {
    return false;
  }
  try {
    const options = typeof AbortSignal?.timeout === 'function'
      ? { signal: AbortSignal.timeout(timeoutMs) }
      : {};
    const response = await fetchImpl(safeEndpoint, options);
    if (!response?.ok) return false;
    const pages = await response.json();
    if (!Array.isArray(pages)) return false;
    return pages.some((page) => {
      if (!isCodexMainPage(page)) return false;
      try {
        assertLoopbackUrl(page.webSocketDebuggerUrl, ['ws:', 'wss:']);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

class CodexNativeChannelController {
  constructor({
    inspect = () => inspectCodexNativeChannel(),
    processManager = createWindowsCodexProcessManager(),
    delay: delayImpl = delay,
    timeoutMs = 60000,
    pollIntervalMs = 250,
  } = {}) {
    this.inspect = inspect;
    this.processManager = processManager;
    this.delay = delayImpl;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.repairPromise = null;
  }

  async get() {
    if (this.repairPromise) return repairingStatus();
    return (await this.inspect().catch(() => false)) ? readyStatus() : offlineStatus();
  }

  repair() {
    if (this.repairPromise) return this.repairPromise;
    const operation = this.performRepair()
      .catch(() => errorStatus())
      .finally(() => {
        if (this.repairPromise === operation) this.repairPromise = null;
      });
    this.repairPromise = operation;
    return operation;
  }

  async performRepair() {
    if (await this.inspect().catch(() => false)) return readyStatus();
    await this.processManager.restart(CODEX_DEBUG_ARGUMENTS);
    const attempts = Math.max(1, Math.ceil(this.timeoutMs / this.pollIntervalMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await this.inspect().catch(() => false)) {
        return readyStatus('Codex 原生信道已修复');
      }
      if (attempt + 1 < attempts) await this.delay(this.pollIntervalMs);
    }
    return errorStatus();
  }
}

function validateCodexExecutablePath(value, { existsSync = fs.existsSync } = {}) {
  const executable = path.win32.normalize(String(value || '').trim());
  const packagedCodex = /^[a-z]:\\program files\\windowsapps\\openai\.codex_[^\\]+__2p2nqsd0c76g0\\app\\chatgpt\.exe$/i;
  if (!path.win32.isAbsolute(executable) || !packagedCodex.test(executable) || !existsSync(executable)) {
    throw new Error('cannot locate the installed Codex Desktop executable');
  }
  return executable;
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

async function runPowerShell(script, {
  execFileImpl = execFileAsync,
  timeoutMs = 30000,
} = {}) {
  const result = await execFileImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
    {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );
  return String(result?.stdout || '').trim();
}

async function locateWindowsCodexDesktop({
  runPowerShellImpl = runPowerShell,
} = {}) {
  const output = await runPowerShellImpl(`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$main = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'ChatGPT.exe' -and
    $_.CommandLine -notmatch '--type=' -and
    $_.ExecutablePath -match '\\\\WindowsApps\\\\OpenAI\\.Codex_[^\\\\]+\\\\app\\\\ChatGPT\\.exe$'
  } |
  Sort-Object CreationDate -Descending |
  Select-Object -First 1
if ($main) {
  [pscustomobject]@{
    pid = [int]$main.ProcessId
    executablePath = [string]$main.ExecutablePath
  } | ConvertTo-Json -Compress
  exit 0
}
$package = Get-AppxPackage -Name 'OpenAI.Codex' |
  Sort-Object Version -Descending |
  Select-Object -First 1
if (-not $package) { throw 'Codex Desktop package is not installed' }
[pscustomobject]@{
  pid = $null
  executablePath = [string](Join-Path $package.InstallLocation 'app\\ChatGPT.exe')
} | ConvertTo-Json -Compress
`);
  const record = JSON.parse(output);
  return {
    pid: Number.isInteger(record?.pid) && record.pid > 0 ? record.pid : null,
    executablePath: String(record?.executablePath || ''),
  };
}

async function stopWindowsCodexDesktop({ pid, executablePath }, {
  runPowerShellImpl = runPowerShell,
  gracefulTimeoutMs = 8000,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const encodedPath = Buffer.from(executablePath, 'utf16le').toString('base64');
  await runPowerShellImpl(`
$ErrorActionPreference = 'Stop'
$targetPid = ${pid}
$expectedPath = [Text.Encoding]::Unicode.GetString(
  [Convert]::FromBase64String('${encodedPath}')
)
$root = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid"
if (-not $root) { exit 0 }
if (-not [string]::Equals(
  [string]$root.ExecutablePath,
  $expectedPath,
  [StringComparison]::OrdinalIgnoreCase
)) { throw 'Codex Desktop process identity changed' }
try {
  $desktop = Get-Process -Id $targetPid -ErrorAction Stop
  [void]$desktop.CloseMainWindow()
} catch {}
$deadline = [DateTime]::UtcNow.AddMilliseconds(${gracefulTimeoutMs})
while ((Get-Process -Id $targetPid -ErrorAction SilentlyContinue) -and
       [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
  $processes = @(Get-CimInstance Win32_Process)
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($targetPid)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $processes) {
      if ($ids.Contains([int]$process.ParentProcessId) -and
          -not $ids.Contains([int]$process.ProcessId)) {
        [void]$ids.Add([int]$process.ProcessId)
        $changed = $true
      }
    }
  }
  foreach ($process in $processes) {
    if ($process.ProcessId -ne $targetPid -and $ids.Contains([int]$process.ProcessId)) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
}
$exitDeadline = [DateTime]::UtcNow.AddSeconds(5)
while ((Get-Process -Id $targetPid -ErrorAction SilentlyContinue) -and
       [DateTime]::UtcNow -lt $exitDeadline) {
  Start-Sleep -Milliseconds 100
}
if (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {
  throw 'Codex Desktop did not exit'
}
`, { timeoutMs: gracefulTimeoutMs + 10000 });
}

async function launchWindowsCodexDesktop(executablePath, args, {
  spawnImpl = spawn,
} = {}) {
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executablePath, args, {
        cwd: path.win32.dirname(executablePath),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function createWindowsCodexProcessManager({
  platform = process.platform,
  existsSync = fs.existsSync,
  locate = locateWindowsCodexDesktop,
  stop = stopWindowsCodexDesktop,
  launch = launchWindowsCodexDesktop,
} = {}) {
  return {
    async restart(args) {
      if (platform !== 'win32') throw new Error('Codex native channel repair is Windows-only');
      if (!Array.isArray(args)
        || args.length !== CODEX_DEBUG_ARGUMENTS.length
        || args.some((value, index) => value !== CODEX_DEBUG_ARGUMENTS[index])) {
        throw new Error('invalid Codex Desktop launch arguments');
      }
      const target = await locate();
      const executablePath = validateCodexExecutablePath(target?.executablePath, { existsSync });
      if (target?.pid) await stop({ pid: target.pid, executablePath });
      await launch(executablePath, CODEX_DEBUG_ARGUMENTS);
    },
  };
}

module.exports = {
  CODEX_DEBUG_ARGUMENTS,
  CODEX_DEBUG_ENDPOINT,
  CodexNativeChannelController,
  createWindowsCodexProcessManager,
  inspectCodexNativeChannel,
  launchWindowsCodexDesktop,
  locateWindowsCodexDesktop,
  runPowerShell,
  stopWindowsCodexDesktop,
  validateCodexExecutablePath,
};

