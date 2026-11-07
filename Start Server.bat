@echo off
rem TeTrowers - start the local test server and open the game in your default browser.
rem Needs Node.js (https://nodejs.org). Phones on the same Wi-Fi can open the network
rem address it prints. Close this window or press Ctrl+C to stop the server.
rem Optional: pass a port number, e.g.  "Start Server.bat" 3000
setlocal
title TeTrowers server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node "%~dp0tools\serve.js" --open %*
if errorlevel 1 pause
exit /b

:nonode
echo.
echo   Node.js was not found, so the TeTrowers server cannot start.
echo.
echo   * Install Node.js (the LTS version) from https://nodejs.org and run this file again.
echo   * Or double-click "Play TeTrowers.bat" to play right away without a server.
echo.
pause
exit /b 1
