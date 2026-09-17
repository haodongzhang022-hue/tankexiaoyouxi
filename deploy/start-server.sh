#!/usr/bin/env bash
#  一键部署常驻联机服务器（在本机或云主机上跑）
#  用法： bash deploy/start-server.sh [端口]
set -euo pipefail
PORT="${1:-3001}"
cd "$(dirname "$0")/.."

# 前端在镜像的 build 阶段里构建（见 deploy/Dockerfile），这里不再重复 npm run build。
echo "==> 1/3 构建镜像 tank-online（镜像内会构建前端 dist）"
docker build -f deploy/Dockerfile -t tank-online .

echo "==> 2/3 启动容器（端口 ${PORT}，随机器自启，崩溃自动重启）"
docker rm -f tank >/dev/null 2>&1 || true
docker run -d --name tank -p "${PORT}:${PORT}" --restart=always \
  -e PORT="${PORT}" -e HOST=0.0.0.0 tank-online

echo "==> 3/3 健康检查"
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "    服务器就绪 ✓"
    break
  fi
  sleep 1
  [ "$i" = "15" ] && { echo "    启动超时，看日志： docker logs tank"; exit 1; }
done

IP=$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo "<你的公网IP>")
echo
echo "====================================================="
echo " 入口（发给好友，打开即进大厅）："
echo "   本机:   http://127.0.0.1:${PORT}"
echo "   公网:   http://${IP}:${PORT}"
echo
echo " 自检:   curl -s http://127.0.0.1:${PORT}/__whoami"
echo " 测延迟: npm run net:latency -- http://${IP}:${PORT}"
echo "====================================================="
