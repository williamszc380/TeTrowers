@echo off
rem TeTrowers: run [port] [--no-open] [--browser]  (works as ./run in PowerShell and run in cmd)
rem Starts the local server and opens the game.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  node tools\run.js %*
) else (
  echo Node.js not found - opening index.html directly. Install Node from https://nodejs.org for the local server.
  start "" "%~dp0index.html"
)
