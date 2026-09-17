@echo off
title Tank Battle Online Server
cd /d "%~dp0"

if not exist node_modules (
  echo [First run] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 goto :fail
)

if not exist dist\index.html (
  echo [First run] Building game files, please wait...
  call npm run build
  if errorlevel 1 goto :fail
)

cls
echo ============================================================
echo   Tank Battle online server is starting...
echo.
echo   - DO NOT close this window (closing it stops the server)
echo   - Send the LAN address shown below to your friends
echo   - You play at : http://localhost:3001
echo   - Stop server : press Ctrl+C or close this window
echo ============================================================
echo.
node server/index.mjs
echo.
echo Server stopped.
pause
exit /b

:fail
echo.
echo [ERROR] Startup failed. Please check:
echo   1. Is Node.js installed?
echo   2. Have you ever run npm install in this folder?
echo.
pause