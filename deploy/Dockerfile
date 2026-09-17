#  坦克大战 · 常驻联机服务器镜像
#  目标：替代 cpolar 内网穿透 + CNB 云原生开发临时环境，得到一个**固定、常驻、可玩**的公网入口。
#
#  与「云原生开发端口预览」的区别（这是上一版踩的坑）：
#    - 端口预览地址形如 https://<环境ID>-3001.cnb.run，环境ID 每次启动都变，
#      且环境离线约 10 分钟被回收 → 地址失效，好友打不开，也**不能长期当游戏服务器**；
#    - 本镜像部署到任意云主机/容器平台后，入口就是「服务器IP:3001」或你自己的域名，
#      **重启不变、7x24 常驻、延迟只取决于机房到你家的物理链路**。
#
#  构建（必须在仓库根目录执行，Dockerfile 在 deploy/ 下，所以要带 -f）：
#      docker build -f deploy/Dockerfile -t tank-online .
#  运行：
#      docker run -d --name tank -p 3001:3001 --restart=always tank-online
#      # 换端口：docker run -d --name tank -p 8080:8080 -e PORT=8080 tank-online
#  玩法：把 http://<服务器公网IP>:3001 发给好友 → 打开即进大厅（页面与 WS 同端口）
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
# 注意：src/ 依赖仓库根的 net-sync-core/（main.ts / OnlineHostMode.ts / RemoteView.ts 都 import 它），
#       tsconfig 的 include 也含它 → build 阶段必须一起 COPY，否则 tsc 报 TS2307、dist 生不出来。
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY net-sync-core ./net-sync-core
# 可选：构建期注入 ICE 服务器（P2P 直连用），例：
#   docker build -f deploy/Dockerfile --build-arg VITE_ICE_SERVERS="stun:stun.qq.com" -t tank-online .
# 不传 = 纯直连（仅同机/局域网），与 deploy/README.md「P2P 直连」一节一致。
ARG VITE_ICE_SERVERS=""
ENV VITE_ICE_SERVERS=$VITE_ICE_SERVERS
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV PORT=3001 HOST=0.0.0.0 NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
# 服务器启动时要 import ../shared/preview-url.mjs（与 scripts 共用的单一事实源）
COPY shared ./shared
EXPOSE 3001
# 健康检查：打 /healthz（只证明进程活着，不依赖 dist 是否构建），
# 端口用 ${PORT} 而不是硬编码 —— 否则 -e PORT=8080 时容器永远 unhealthy。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "server/index.mjs"]
