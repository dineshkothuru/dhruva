@echo off
REM Dhruva — one-command start for team machines.
REM Prereqs: Node 20+, git, Salesforce CLI (sf), and at least one agent CLI
REM (copilot / claude / codex) logged in once on this machine.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo [dhruva] Node.js is required: https://nodejs.org & exit /b 1)
where git  >nul 2>nul || (echo [dhruva] git is required: https://git-scm.com & exit /b 1)
where sf   >nul 2>nul || echo [dhruva] warning: Salesforce CLI ^(sf^) not found - org features will not work

if not exist node_modules (
  echo [dhruva] installing dependencies...
  call npm ci || call npm install || exit /b 1
)

if not exist .next\BUILD_ID (
  echo [dhruva] building...
  call npm run build || exit /b 1
)

echo [dhruva] starting on http://localhost:3005
start "" http://localhost:3005
call npm start
