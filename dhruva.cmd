@echo off
REM Dhruva — one-command setup + start. Checks mandatory prerequisites,
REM installs what it safely can, and tells you exactly what remains.
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM subcommands (update, version) go to the CLI launcher - the bare
REM command falls through to setup+start below
if not "%~1"=="" (
  node "%~dp0bin\dhruva.js" %*
  exit /b %errorlevel%
)

echo [dhruva] checking prerequisites...

where node >nul 2>nul || (
  echo [dhruva] MISSING: Node.js 20+ is required. Install the LTS from https://nodejs.org and re-run.
  exit /b 1
)
rem existence is not enough: an old Node fails the build with confusing errors
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node" 2^>nul') do set NODE_MAJOR=%%v
if defined NODE_MAJOR if %NODE_MAJOR% LSS 20 (
  echo [dhruva] Node.js %NODE_MAJOR% found, but 20+ is required. Update from https://nodejs.org and re-run.
  exit /b 1
)
where git >nul 2>nul || (
  echo [dhruva] MISSING: git is required. Install from https://git-scm.com and re-run.
  exit /b 1
)

where sf >nul 2>nul
if errorlevel 1 (
  echo [dhruva] Salesforce CLI not found - installing via npm...
  call npm install -g @salesforce/cli || (
    echo [dhruva] could not install Salesforce CLI - install manually: https://developer.salesforce.com/tools/salesforcecli
    exit /b 1
  )
)

sf plugins 2>nul | findstr /i "lightning-dev" >nul
if errorlevel 1 (
  echo [dhruva] installing Local Dev plugin ^(visual testing^)...
  call sf plugins install @salesforce/plugin-lightning-dev
)

set AGENTS=
where copilot >nul 2>nul && set AGENTS=!AGENTS! copilot
where claude  >nul 2>nul && set AGENTS=!AGENTS! claude
where codex   >nul 2>nul && set AGENTS=!AGENTS! codex
if "!AGENTS!"=="" (
  echo [dhruva] WARNING: no agent CLI found. Install at least one and log in once:
  echo    npm install -g @github/copilot        then: copilot  ^(use /login^)
  echo    npm install -g @anthropic-ai/claude-code   then: claude
  echo    npm install -g @openai/codex          then: codex login
  echo [dhruva] continuing - chat/workflow agent steps will not work until then.
) else (
  echo [dhruva] agent CLIs found:!AGENTS!
)

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
