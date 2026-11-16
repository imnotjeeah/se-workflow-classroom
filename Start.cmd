@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 (
  echo Extract the whole ZIP before starting SE Workflow.
  pause
  exit /b 1
)
if not exist "server.mjs" (
  echo Extract the whole ZIP, then run Start.cmd from the extracted folder.
  pause
  exit /b 1
)
node -e "process.exit(parseInt(process.versions.node, 10) < 22 ? 1 : 0)" >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required to start SE Workflow.
  pause
  exit /b 1
)
node server.mjs --open
pause
