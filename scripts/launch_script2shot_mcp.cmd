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

where node >nul 2>&1
if not errorlevel 1 (
  node "%SCRIPT2SHOT_SERVER%" %*
  exit
)

echo 请更新 Codex 或安装 Node.js ^>= 24 1>&2
exit /b 127
