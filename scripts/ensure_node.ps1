# ensure_node.ps1 —— 无 Node 环境下的引导脚本（setup 技能专用，Windows）。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure_node.ps1
#
# 行为：复用系统 node / 私有运行时 → 都没有时下载 Node >= 24 的最新 LTS 归档，
#       以 SHASUMS256.txt 校验 sha256 后解压到 <home>/runtime/node-<version>/，
#       输出 JSON（ok / source / version / node_path / npm_path）。
#       目录布局与校验口径与 scripts/setup_bootstrap.mjs 的 ensure-runtime 一致。
# 退出码：0 成功、1 失败。可用 SCRIPT2SHOT_NODE_VERSION 固定要下载的版本（测试用）。
# 本脚本只在 setup 流程中被 AI 调用；MCP 启动器不得自动下载。

$ProgressPreference = "SilentlyContinue"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
} catch {}

$MinMajor = 24
$NodeDistBase = "https://nodejs.org/dist"
$NodeIndexUrl = "$NodeDistBase/index.json"
$ShaFile = "SHASUMS256.txt"

$homeDir = if ($env:SCRIPT2SHOT_HOME) { $env:SCRIPT2SHOT_HOME } else { Join-Path $env:USERPROFILE ".codex-script2shot" }
$runtimeRoot = Join-Path $homeDir "runtime"

function Out-Json($payload) {
  $payload | ConvertTo-Json -Depth 6 -Compress
}

function Fail($code, $message, $details) {
  Out-Json @{ ok = $false; error = @{ code = $code; message = $message; details = $details } }
  exit 1
}

function Get-NodeMajor($nodePath) {
  try {
    $raw = (& $nodePath --version 2>$null | Select-Object -First 1)
  } catch {
    return $null
  }
  if ($raw -match '^v(\d+)\.') { return [int]$Matches[1] }
  return $null
}

function Get-SiblingNpm($nodePath) {
  $npm = Join-Path (Split-Path $nodePath -Parent) "npm.cmd"
  if (Test-Path $npm) { return $npm }
  return "npm"
}

# ① 系统 node。
$systemNode = $null
try { $systemNode = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}
if ($systemNode) {
  $major = Get-NodeMajor $systemNode
  if ($major -ne $null -and $major -ge $MinMajor) {
    Out-Json @{ ok = $true; source = "system"; version = (& $systemNode --version).TrimStart("v"); node_path = $systemNode; npm_path = (Get-SiblingNpm $systemNode) }
    exit 0
  }
}

# ② 私有运行时（ensure-runtime 布局；多版本时取目录名最大者，视为最新）。
$privateNode = $null
if (Test-Path $runtimeRoot) {
  $candidates = Get-ChildItem -Path $runtimeRoot -Directory -Filter "node-*" |
    Sort-Object Name -Descending
  foreach ($versionDir in $candidates) {
    $inner = Get-ChildItem -Path $versionDir.FullName -Directory -Filter "node-*" |
      Sort-Object Name -Descending | Select-Object -First 1
    if ($inner) {
      $nodeExe = Join-Path $inner.FullName "node.exe"
      if (Test-Path $nodeExe) { $privateNode = $nodeExe; break }
    }
  }
}
if ($privateNode) {
  $major = Get-NodeMajor $privateNode
  if ($major -ne $null -and $major -ge $MinMajor) {
    Out-Json @{ ok = $true; source = "private"; version = (& $privateNode --version).TrimStart("v"); node_path = $privateNode; npm_path = (Get-SiblingNpm $privateNode) }
    exit 0
  }
}

# ③ 下载并落地最新 LTS。
$version = $env:SCRIPT2SHOT_NODE_VERSION
if (-not $version) {
  try {
    $index = Invoke-RestMethod -Uri $NodeIndexUrl -TimeoutSec 30
  } catch {
    Fail "NETWORK_BLOCKED" "无法读取 Node 版本索引：$($_.Exception.Message)" @{ url = $NodeIndexUrl }
  }
  $version = ($index | Where-Object { $_.lts -ne $false -and ($_.version -match '^v(\d+)\.' ) -and ([int]$Matches[1] -ge $MinMajor) } |
    Sort-Object { [version]($_.version.TrimStart("v")) } -Descending | Select-Object -First 1).version
  if (-not $version) {
    Fail "NODE_UNAVAILABLE" "Node 版本索引里没有满足 >= $MinMajor 的 LTS 版本。" @{ url = $NodeIndexUrl }
  }
}
if ($version -notmatch '^v') { $version = "v$version" }
if ($version -notmatch '^v\d+\.\d+\.\d+$') {
  Fail "NODE_UNAVAILABLE" "Node 版本号格式不合法：$version" @{ version = $version }
}

$archiveName = "node-$version-win-x64.zip"
$archiveUrl = "$NodeDistBase/$version/$archiveName"
$checksumUrl = "$NodeDistBase/$version/$ShaFile"
$runtimeDir = Join-Path $runtimeRoot "node-$version"
$archivePath = Join-Path $runtimeDir $archiveName

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
try {
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -TimeoutSec 600
} catch {
  Fail "NODE_DOWNLOAD_FAILED" "下载 Node 归档失败：$($_.Exception.Message)" @{ archive_url = $archiveUrl }
}
try {
  $checksums = (Invoke-WebRequest -Uri $checksumUrl -TimeoutSec 30).Content
} catch {
  Fail "NODE_DOWNLOAD_FAILED" "下载 Node 校验文件失败：$($_.Exception.Message)" @{ checksum_source = $checksumUrl }
}
$expected = $null
foreach ($line in ($checksums -split "`n")) {
  if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -eq $archiveName) {
    $expected = $Matches[1].ToLower()
    break
  }
}
if (-not $expected) {
  Fail "NODE_CHECKSUM_MISMATCH" "校验文件里没有 $archiveName 的 sha256 记录。" @{ checksum_source = $checksumUrl }
}
$actual = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
  Fail "NODE_CHECKSUM_MISMATCH" "Node 归档 sha256 校验失败：$archiveName" @{ expected_sha256 = $expected; actual_sha256 = $actual }
}

try {
  Expand-Archive -Path $archivePath -DestinationPath $runtimeDir -Force
} catch {
  Remove-Item -Recurse -Force $runtimeDir -ErrorAction SilentlyContinue
  Fail "NODE_DOWNLOAD_FAILED" "解压 Node 归档失败：$($_.Exception.Message)" @{ archive_url = $archiveUrl }
}
Remove-Item -Force $archivePath -ErrorAction SilentlyContinue

$topDir = Get-ChildItem -Path $runtimeDir -Directory | Where-Object { $_.Name -like "node-$version-*" } |
  Select-Object -First 1
if (-not $topDir) {
  $all = @(Get-ChildItem -Path $runtimeDir -Directory)
  if ($all.Count -eq 1) { $topDir = $all[0] }
}
if (-not $topDir) {
  Fail "NODE_DOWNLOAD_FAILED" "解压后未找到 Node 顶层目录。" @{ runtime_dir = $runtimeDir }
}
$nodePath = Join-Path $topDir.FullName "node.exe"
$npmPath = Join-Path $topDir.FullName "npm.cmd"
if (-not (Test-Path $nodePath) -or -not (Test-Path $npmPath)) {
  Fail "NODE_DOWNLOAD_FAILED" "解压后的 Node 运行时缺少 node / npm。" @{ runtime_dir = $runtimeDir; node_path = $nodePath; npm_path = $npmPath }
}

Out-Json @{ ok = $true; source = "private"; version = $version.TrimStart("v"); node_path = $nodePath; npm_path = $npmPath; archive_url = $archiveUrl; checksum_source = $checksumUrl }
exit 0
