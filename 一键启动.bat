@echo off
chcp 65001 >nul
title 坦克大战 · 一键启动（服务器+双隧道）
echo ============================================================
echo   坦克大战 · 一键启动（服务器 + 国内隧道 + 国外隧道）
echo ============================================================
echo.

rem ==== 1. 游戏服务器 ====
netstat -ano | findstr ":3001 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [OK]  游戏服务器已在运行 (端口 3001)
) else (
  echo [1/3] 启动游戏服务器...
  start "tank-server" /min cmd /c "cd /d E:\web-tank-battle && node server\index.mjs >> E:\web-tank-battle\server.log 2>&1"
  timeout /t 3 /nobreak >nul
  netstat -ano | findstr ":3001 .*LISTENING" >nul 2>&1
  if %errorlevel%==0 ( echo [OK]  游戏服务器已启动 ) else ( echo [错误] 服务器启动失败，请看 server.log )
)

echo.

rem ==== 2. 国内隧道 (cpolar) ====
tasklist /FI "IMAGENAME eq cpolar.exe" 2>nul | findstr /i cpolar >nul 2>&1
if %errorlevel%==0 (
  echo [OK]  国内隧道进程已在运行
) else (
  echo [2/3] 启动国内隧道 (cpolar)...
  start "cpolar-tunnel" /min cmd /c ""E:\web-tank-battle\tools\cpolar\extract\cpolar\cpolar.exe" start tank-game --config "E:\web-tank-battle\tools\cpolar\cpolar-tank.yml" >> E:\web-tank-battle\cpolar2.log 2>&1"
  timeout /t 12 /nobreak >nul
  echo [检查] 国内隧道启动中，10 秒后应可用
)

echo.

rem ==== 3. 国外隧道 (cloudflared) ====
tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | findstr /i cloudflared >nul 2>&1
if %errorlevel%==0 (
  echo [OK]  国外隧道进程已在运行
) else (
  echo [3/3] 启动国外隧道 (cloudflared)...
  start "cf-tunnel" /min cmd /c ""E:\web-tank-battle\tools\cloudflared.exe" tunnel --url http://localhost:3001 --no-autoupdate >> E:\web-tank-battle\cf.log 2>&1"
  timeout /t 8 /nobreak >nul
  echo [注意] cloudflared 新链接在 cf.log 中查找 trycloudflare
)

echo.
echo ============================================================
echo   本机游玩:  http://localhost:3001
echo   国内分享:  https://27201307.r29.cpolar.top  (重启后域名可能变化，看隧道窗口/日志)
echo   国外分享:  见 cloudflared 隧道日志中的 trycloudflare 地址
echo   游戏内邀请链接: 桌内按 U 设置公网域名后自动生成公网链接
echo   停止服务器: 关闭 tank-server 窗口即可
echo ============================================================
echo.
pause
