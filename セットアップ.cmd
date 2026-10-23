@echo off
rem bkit setup launcher. Keep this file ASCII only: cmd.exe misreads non-ASCII lines.
rem The actual work (with Japanese messages) is done by bin\setup-from-zip.mjs.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0bin\setup-from-zip.mjs" %*
goto end

:nonode
echo.
echo Node.js is not installed.
echo Please install the LTS version from https://nodejs.org and run this file again.
echo.
where winget >nul 2>nul
if errorlevel 1 (
  start "" "https://nodejs.org/ja"
  goto end
)
choice /c YN /m "Install Node.js LTS with winget now"
if errorlevel 2 goto end
winget install -e --id OpenJS.NodeJS.LTS
echo.
echo After the installation finishes, close this window and run this file again.

:end
echo.
if not defined BKIT_NO_PAUSE pause
