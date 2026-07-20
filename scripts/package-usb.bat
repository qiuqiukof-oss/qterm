@echo off
REM ============================================================
REM Hesi USB Agent Packager (Windows)
REM Build a portable, offline-capable USB edition ONCE on a machine
REM with internet access. The resulting 'hesi' folder can then be copied
REM to a USB stick and run on air-gapped / GFW-affected machines.
REM
REM Strategy: download portable Node.js + pre-install agents into
REM offline-cache/ so the end user's one-click install needs NO network.
REM ============================================================
setlocal EnableDelayedExpansion
set "NODE_VER=22.14.0"
set "NODE_ZIP=node-v%NODE_VER%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VER%/%NODE_ZIP%"
set "ROOT=%~dp0.."
set "OUT=%ROOT%\hesi"
set "NODE_DIR=%OUT%\node"
set "CACHE=%OUT%\offline-cache"

echo [1/7] Preparing output directory: %OUT%
if exist "%OUT%" (
  echo   - existing hesi detected, removing stale build...
  rmdir /S /Q "%OUT%" 2>nul
)
if not exist "%OUT%" mkdir "%OUT%"
if not exist "%NODE_DIR%" mkdir "%NODE_DIR%"
if not exist "%CACHE%" mkdir "%CACHE%"

echo [2/7] Copying app source into %OUT% ...
REM 仅复制运行所需源码，排除 node_modules / .git / hesi 自身 / 已生成的缓存
for %%D in (routes public lib scripts agents-src packaging) do (
  if exist "%ROOT%\%%D" xcopy /E /I /Y "%ROOT%\%%D" "%OUT%\%%D" >nul
)
for %%F in (server.js package.json package-lock.json .env.example README.md) do (
  if exist "%ROOT%\%%F" copy /Y "%ROOT%\%%F" "%OUT%\%%F" >nul
)

echo [3/7] Portable Node.js (%NODE_VER%) ...
if exist "%NODE_DIR%\node.exe" (
  echo   - already present, skip download
) else (
  echo   - downloading %NODE_URL%
  powershell -Command "Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%TEMP%\%NODE_ZIP%'"
  echo   - extracting to %NODE_DIR%
  powershell -Command "Expand-Archive -Force '%TEMP%\%NODE_ZIP%' '%TEMP%\node-extract'"
  xcopy /E /I /Y "%TEMP%\node-extract\node-v%NODE_VER%-win-x64\*" "%NODE_DIR%\" >nul
  del /Q "%TEMP%\%NODE_ZIP%" 2>nul
  rmdir /S /Q "%TEMP%\node-extract" 2>nul
)

echo [4/7] Installing Hesi dependencies (portable npm) ...
if exist "%OUT%\package-lock.json" (
  call "%NODE_DIR%\npm.cmd" ci --prefix "%OUT%" || call "%NODE_DIR%\npm.cmd" install --prefix "%OUT%"
) else (
  call "%NODE_DIR%\npm.cmd" install --prefix "%OUT%"
)

echo [5/7] Building frontend bundle (public/bundle.js) ...
call "%NODE_DIR%\npm.cmd" --prefix "%OUT%" run build || echo   - build 失败，请检查 esbuild 是否安装

echo [6/7] Pre-installing agents into offline-cache (offline one-click later) ...
call "%NODE_DIR%\node.exe" "%OUT%\scripts\build-offline-cache.js" --out "%CACHE%" --npm "%NODE_DIR%\npm.cmd"

echo [7/7] Generating launcher scripts ...
(
  echo @echo off
  echo REM Start Hesi using the bundled portable Node.js
  echo set "DIR=%%~dp0"
  echo set "QCLI_PORTABLE=%%DIR%%"
  echo set "PATH=%%DIR%%node;%%PATH%%"
  echo "%%DIR%%node\node.exe" "%%DIR%%server.js"
) > "%OUT%\start.bat"

(
  echo @echo off
  echo set "DIR=%%~dp0"
  echo set "QCLI_PORTABLE=%%DIR%%"
  echo set "PATH=%%DIR%%node;%%PATH%%"
  echo "%%DIR%%offline-cache\opencode\bin\opencode.cmd" %%*
) > "%OUT%\opencode.bat"

(
  echo @echo off
  echo set "DIR=%%~dp0"
  echo set "QCLI_PORTABLE=%%DIR%%"
  echo set "PATH=%%DIR%%node;%%PATH%%"
  echo "%%DIR%%offline-cache\ohmyopenagent\bin\oma.cmd" %%*
) > "%OUT%\oma.bat"

(
  echo @echo off
  echo set "DIR=%%~dp0"
  echo set "QCLI_PORTABLE=%%DIR%%"
  echo set "PATH=%%DIR%%node;%%PATH%%"
  echo "%%DIR%%offline-cache\codex\bin\codex.cmd" %%*
) > "%OUT%\codex.bat"

echo [8/8] Copying config template ...
if not exist "%OUT%\.env" (
  if exist "%ROOT%\.env.example" copy "%ROOT%\.env.example" "%OUT%\.env" >nul
)
echo.
echo Done. Copy the entire '%OUT%' folder to a USB stick.
echo On the target machine, double-click start.bat (no admin required).
echo Open http://127.0.0.1:4264 — the welcome page shows one-click install
echo that uses the offline-cache (no internet needed).
endlocal
