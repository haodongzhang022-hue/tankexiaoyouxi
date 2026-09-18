#!/bin/sh
# scripts/e2e/run-verify.sh — 邀请链接返工（v2.38）真机实测：一条命令复跑
#
# 做什么：
#   1) 装 Chromium 依赖 + puppeteer（依赖与浏览器缓存落在 gitignored 的 tests/e2e/，不进仓库）
#   2) 起三个服务：3001 = 当前工作区构建（返工后）
#                  3002 = main 对照构建（.probe/mainbuild/dist，git worktree）
#                  3003 = 返工前 PR 构建（.probe/prefixbuild/dist，git worktree @ ef80055）
#   3) 跑 scripts/e2e/verify-invite-fixes.mjs（横屏 968×640 + 竖屏 480×920，39 项断言）
#
# 用法：sh scripts/e2e/run-verify.sh
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
E2E="$ROOT/tests/e2e"
export DEBIAN_FRONTEND=noninteractive
export PUPPETEER_CACHE_DIR="$E2E/.chrome"

# ── 依赖（幂等）──
if ! ldconfig -p 2>/dev/null | grep -q libnspr4; then
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 fonts-liberation >/dev/null 2>&1 || true
fi
[ -d "$E2E/node_modules/puppeteer" ] || (mkdir -p "$E2E" && cd "$E2E" && npm init -y >/dev/null && npm i puppeteer >/dev/null 2>&1)
[ -x "$PUPPETEER_CACHE_DIR/chrome" ] || (cd "$E2E" && npx puppeteer browsers install chrome >/dev/null 2>&1) || true

# ── 对照构建（git worktree；dist 留在 .probe/ 下，不进仓库）──
build_ref() { # $1=ref $2=dir
  [ -d "$2/dist" ] && return
  git -C "$ROOT" worktree add "$2" "$1" >/dev/null 2>&1 || true
  (cd "$2" && ln -sf "$ROOT/node_modules" node_modules && npx vite build --outDir dist --emptyOutDir >/dev/null 2>&1) || true
}
build_ref origin/main "$ROOT/.probe/mainbuild"
build_ref ef80055     "$ROOT/.probe/prefixbuild"

# ── 服务 ──
start_server() { # $1=dir $2=port
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$2/healthz" && return
  # HOST=0.0.0.0（与部署一致）：服务器自登记的入口 IP 必须真的可达，否则前端「入口自救」
  # 会额外弹提示并把邀请错误文案盖掉（旧脚本绑 127.0.0.1 时的假失败，非产品问题）
  (cd "$1" && PORT="$2" HOST=0.0.0.0 nohup node server/index.mjs > "/tmp/srv-$2.log" 2>&1 & echo $! > "/tmp/srv-$2.pid")
  for _ in $(seq 1 60); do curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$2/healthz" && break; sleep 0.25; done
}
(cd "$ROOT" && npm run build >/dev/null 2>&1) || true
start_server "$ROOT" 3001
[ -d "$ROOT/.probe/mainbuild/dist" ] && start_server "$ROOT/.probe/mainbuild" 3002
[ -d "$ROOT/.probe/prefixbuild/dist" ] && start_server "$ROOT/.probe/prefixbuild" 3003

# ── 跑 ──
cd "$E2E"
PUPPETEER_MODULE="$E2E/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js" \
  node "$ROOT/scripts/e2e/verify-invite-fixes.mjs"
