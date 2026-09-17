@echo off
chcp 65001 >nul
rem 切换到本脚本所在目录（%~dp0 末尾自带反斜杠），避免路径里的 \t 等被转义破坏
cd /d "%~dp0"
echo ============================================
echo   cpolar 国内隧道 - 坦克大战联机
echo ============================================
echo.
set "CPOLAR=%~dp0tools\cpolar\extract\cpolar\cpolar.exe"
set "CFG=%~dp0tools\cpolar\cpolar-tank.yml"
if not exist "%CPOLAR%" ( echo 未找到 cpolar.exe: %CPOLAR% & pause & exit /b 1 )
if not exist "%CFG%" ( echo 未找到配置文件: %CFG% & pause & exit /b 1 )

echo 正在启动国内隧道 (127.0.0.1:3001 -^> cpolar.top)...
echo 请稍候 10~15 秒，隧道地址会打印在下方（形如 https://xxxxx.r29.cpolar.top）
echo 游戏服务器需已在 3001 端口运行（start-online.bat）。
"%CPOLAR%" start tank-game --config "%CFG%"
pause
