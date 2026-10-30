@echo off
setlocal
chcp 65001 >nul 2>&1

set "SCRIPT2SHOT_SERVER=%~dp0..\server\dist\server.mjs"

if not exist "%SCRIPT2SHOT_SERVER%" (
  echo script2shot MCP Server 尚未构建：找不到 "%SCRIPT2SHOT_SERVER%" 1>&2
  echo 请先运行：npm --prefix server run build 1>&2
  echo 也可由 scripts/setup_bootstrap build-server 自动完成（安装依赖 + 构建 + 握手自检） 1>&2
  exit /b 1
)

if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" (
  "%CODEX_MCP_NODE_PATH%" "%SCRIPT2SHOT_SERVER%" %*
  exit
)

if defined CODEX_ELECTRON_RESOURCES_PATH if exist "%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe" (
  "%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe" "%SCRIPT2SHOT_SERVER%" %*
  exit
)

if defined CODEX_CLI_PATH for %%I in ("%CODEX_CLI_PATH%") do if exist "%%~dpIcua_node\bin\node.exe" (
  "%%~dpIcua_node\bin\node.exe" "%SCRIPT2SHOT_SERVER%" %*
  exit
)

if defined XDG_CACHE_HOME if exist "%XDG_CACHE_HOME%\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  "%XDG_CACHE_HOME%\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%SCRIPT2SHOT_SERVER%" %*
  exit
)

if defined USERPROFILE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%SCRIPT2SHOT_SERVER%" %*
  exit
)

rem Claude Code 等宿主不自带 Node：复用 setup 安装的私有运行时。ensure-runtime 只装
rem >= 24 的版本，任意一个都满足；多个版本时目录枚举取到最后一个（字典序最大）。
set "SCRIPT2SHOT_RUNTIME=%USERPROFILE%\.codex-script2shot\runtime"
if defined SCRIPT2SHOT_HOME set "SCRIPT2SHOT_RUNTIME=%SCRIPT2SHOT_HOME%\runtime"
set "SCRIPT2SHOT_PRIVATE_NODE="
if exist "%SCRIPT2SHOT_RUNTIME%" for /d %%V in ("%SCRIPT2SHOT_RUNTIME%\node-*") do (
  for /d %%D in ("%%~V\node-*") do (
    if exist "%%~D\node.exe" set "SCRIPT2SHOT_PRIVATE_NODE=%%~D\node.exe"
  )
)
if defined SCRIPT2SHOT_PRIVATE_NODE (
  "%SCRIPT2SHOT_PRIVATE_NODE%" "%SCRIPT2SHOT_SERVER%" %*
  exit
)

where node >nul 2>&1
if not errorlevel 1 (
  node "%SCRIPT2SHOT_SERVER%" %*
  exit
)

echo 未找到可用的 Node 运行时；请安装 Node.js ^>= 24 后重试 1>&2
exit /b 127
