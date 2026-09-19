#!/bin/sh
# scripts/e2e/run-verify.sh — 邀请链接真机实测：一条命令复跑（**本机跑，云端不跑**）
#
# 定位（Issue #16 D2 + 用户口径「云端开发 / 本地测试」）：
#   本脚本是**本地**回归工具，不是 CI 门禁的门票 —— 它要下载 Chromium（~400MB）+ 起三个服务，
#   在云原生环境里既慢又占 CPU。云端请只跑 npm test（tsc/vitest/net:entry-test）。
#
# 做什么：
#   1) 装 Chromium 依赖 + puppeteer（依赖与浏览器缓存落在 gitignored 的 tests/e2e/，不进仓库）
#   2) 起三个服务：3001 = 当前工作区构建（返工后）
#                  3002 = main 对照构建（.probe/mainbuild/dist，git worktree）
#                  3003 = 返工前 PR 构建（.probe/prefixbuild/dist，git worktree @ ef80055）
#                  对照构建拿不到时**跳过对应分组**（脚本里已做可选断言），不再假失败
#   3) 跑 scripts/e2e/verify-invite-fixes.mjs（横屏 968×640 + 竖屏 480×920）
#      ★ 断言总数以脚本实际打印为准（`汇总：N/N 通过`）—— 别在这里写死数字，写过一次「39」就腐了。
#
# D2 三处修复（Issue #16，架构·测试 复现）：
#   D2a 守卫判错对象：旧版判 `[ -x "$PUPPETEER_CACHE_DIR/chrome" ]`（**目录**，恒可执行）
#       → 空目录/半截安装也跳过下载 → 实测 "Could not find Chrome"。现判**真实二进制**。
#   D2b 模块路径写死：旧版写死 `lib/esm/puppeteer/puppeteer.js`（puppeteer 22 有、25 已删）
#       → ERR_MODULE_NOT_FOUND。现在不再传路径，由脚本用 createRequire 自解析。
#   D2c networkidle2 永不达成：并发多页 + 页面持 WebSocket 时网络永不「空闲」
#       （实测 12 次并发打开失败 9 次）→ 等待策略统一改 domcontentloaded + 显式就绪条件。
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

# ── D2a：浏览器安装状态必须判**真实二进制**，不能判目录 ──
#   puppeteer 25 的实际落点：$PUPPETEER_CACHE_DIR/chrome/linux-<ver>/chrome-linux64/chrome
#   旧版判 `[ -x "$PUPPETEER_CACHE_DIR/chrome" ]`（目录）恒真 → 半截安装被跳过 → "Could not find Chrome"。
chrome_bin() {
  find "$PUPPETEER_CACHE_DIR" -type f -name chrome -path "*chrome-linux64*" 2>/dev/null | head -n 1
}
if [ -z "$(chrome_bin)" ]; then
  rm -rf "$PUPPETEER_CACHE_DIR"          # 清掉半截安装，避免又踩 D2a
  (cd "$E2E" && npx puppeteer browsers install chrome >/dev/null 2>&1) || true
fi
CHROME_BIN=$(chrome_bin)
if [ -n "$CHROME_BIN" ]; then
  export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"
  echo "[e2e] Chromium: $CHROME_BIN"
else
  echo "[e2e] ⚠ 未装成 Chromium（离线？）；先跑 npm test 那套门禁，真机 e2e 稍后再试" >&2
fi

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
# D2b：不再指定模块路径（写死的 lib/esm/... 在 puppeteer 25 已不存在）。
# 让 Node 自己去解析 —— 脚本内用 createRequire + NODE_PATH 兜底解析到 tests/e2e 下装的 puppeteer。
cd "$E2E"
NODE_PATH="$E2E/node_modules${NODE_PATH:+:$NODE_PATH}" \
  node "$ROOT/scripts/e2e/verify-invite-fixes.mjs"
