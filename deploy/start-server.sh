#!/usr/bin/env bash
#  一键部署常驻联机服务器（在本机或云主机上跑）
#  用法： bash deploy/start-server.sh [端口]
set -euo pipefail
PORT="${1:-3001}"
cd "$(dirname "$0")/.."

# 前端在镜像的 build 阶段里构建（见 deploy/Dockerfile），这里不再重复 npm run build。
echo "==> 1/4 构建镜像 tank-online（镜像内会构建前端 dist）"
docker build -f deploy/Dockerfile -t tank-online .

echo "==> 2/4 启动容器（端口 ${PORT}，随机器自启，崩溃自动重启）"
docker rm -f tank >/dev/null 2>&1 || true
# 令牌/登记文件放在宿主机目录里（挂进容器）：① 部署脚本能读到令牌去登记；② 登记结果重启后仍在
TOKEN_DIR="${PWD}/.tank-deploy"
mkdir -p "$TOKEN_DIR"
docker run -d --name tank -p "${PORT}:${PORT}" --restart=always \
  -e PORT="${PORT}" -e HOST=0.0.0.0 \
  -e TANK_ENTRY_TOKEN_FILE=/data/entry.token \
  -v "${TOKEN_DIR}:/data" tank-online

echo "==> 3/4 健康检查"
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "    服务器就绪 ✓"
    break
  fi
  sleep 1
  [ "$i" = "15" ] && { echo "    启动超时，看日志： docker logs tank"; exit 1; }
done

IP=$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo "")
# hostname -i 在部分系统（macOS）不存在 → 失败不影响脚本（set -e + pipefail 下必须兜住）
LAN_IP=$(hostname -i 2>/dev/null | awk '{print $1}' || true)
# 公网 IP 拿不到（内网机器 / 没网）→ 退回局域网 IP：同 WiFi 也能玩，链接照样是可用地址
PUBLIC_ENTRY=""
if [ -n "$IP" ] && [ "$IP" != "127.0.0.1" ]; then PUBLIC_ENTRY="http://${IP}:${PORT}"; fi
if [ -z "$PUBLIC_ENTRY" ] && [ -n "${LAN_IP:-}" ]; then PUBLIC_ENTRY="http://${LAN_IP}:${PORT}"; fi

echo "==> 4/4 登记对外入口（稳定链接 302 的目标；IP 形态无需域名）"
# 这一步以前缺失 → 没有域名的部署形态拿不到「当前入口」，好友点开会被送到他自己的 127.0.0.1。
# 现在：把上面算出的入口用**带令牌的可信登记**写进服务器（并落盘，重启后仍生效）。
TOKEN_FILE="${TOKEN_DIR}/entry.token"
TOKEN=""
for i in $(seq 1 10); do
  # 优先在容器内读（令牌 0600 属 root：宿主机非 root 用户直接 cat 可能读不到）
  TOKEN=$(docker exec tank cat /data/entry.token 2>/dev/null | tr -d '\r\n' || true)
  if [ -z "$TOKEN" ]; then TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\r\n' || true); fi
  [ -n "$TOKEN" ] && break
  sleep 1
done
if [ -n "$TOKEN" ] && [ -n "$PUBLIC_ENTRY" ]; then
  # 注意：这里**不能**带 -f —— 登记被拒时服务器会返回 4xx + 说明原因的 JSON，我们要把它打出来
  REG=$(curl -sS -H "X-Tank-Entry-Token: ${TOKEN}" \
    "http://127.0.0.1:${PORT}/entry/register?url=$(printf %s "$PUBLIC_ENTRY" | sed 's/:/%3A/g; s#/#%2F#g')" 2>/dev/null || true)
  echo "    登记结果: ${REG:-（无响应）}"
  case "$REG" in
    *'"applied":true'*) echo "    ✓ 当前入口 = ${PUBLIC_ENTRY}" ;;
    *) echo "    ⚠ 登记未生效，稳定链接会退化为可操作提示页；请检查上面返回的原因" ;;
  esac
else
  echo "    ⚠ 跳过登记（令牌未就绪或没算出可用 IP）—— 稳定链接将提示「服务器还没有对外入口」"
fi

echo
echo "====================================================="
echo " 入口（发给好友，打开即进大厅）："
echo "   本机:   http://127.0.0.1:${PORT}"
if [ -n "$IP" ]; then echo "   公网:   http://${IP}:${PORT}"; fi
if [ -n "${LAN_IP:-}" ]; then echo "   局域网: http://${LAN_IP}:${PORT}"; fi
SID=$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null | sed -n 's/.*"sid":"\([0-9a-f]\{8\}\)".*/\1/p')
echo "   稳定:   ${PUBLIC_ENTRY:-<未登记>}/${SID:-<sid>}/join/  （换 IP/域名不用改链接；重建环境才换 sid）"
echo
echo " 自检:   curl -s http://127.0.0.1:${PORT}/__whoami"
echo " 入口:   curl -s http://127.0.0.1:${PORT}/healthz   # 看 current / currentSource"
echo " 换IP/绑域名: 重跑本脚本，或 npm run net:tunnel -- --entry=http://<新地址>:${PORT}"
if [ -n "$PUBLIC_ENTRY" ]; then echo " 测延迟: npm run net:latency -- ${PUBLIC_ENTRY}"; fi
echo "====================================================="
