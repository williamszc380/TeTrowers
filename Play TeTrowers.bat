@echo off
rem TeTrowers - open the game in an app-style window (Microsoft Edge, else Google Chrome),
rem or in the default browser if neither is installed. No server or internet needed.
setlocal
set "PAGE=%~dp0index.html"
if not exist "%PAGE%" goto missing

rem index.html as a file:/// URL, with spaces and other special characters escaped
set "URL="
for /f "usebackq delims=" %%U in (`powershell -NoProfile -NonInteractive -Command "(New-Object System.Uri $env:PAGE).AbsoluteUri" 2^>nul`) do set "URL=%%U"
if not defined URL set "URL=file:///%PAGE:\=/%"

set "BROWSER="
for %%B in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if not defined BROWSER if exist "%%~B" set "BROWSER=%%~B"

if defined BROWSER (
  start "" "%BROWSER%" --app="%URL%"
) else (
  start "" "%PAGE%"
)
exit /b

:missing
echo Could not find "%PAGE%".
echo Keep this file in the TeTrowers folder, next to index.html.
pause
exit /b 1
