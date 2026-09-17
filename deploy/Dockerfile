#  坦克大战 · 常驻联机服务器镜像
#  目标：替代 cpolar 内网穿透 + CNB 云原生开发临时环境，得到一个**固定、常驻、可玩**的公网入口。
#
#  与「云原生开发端口预览」的区别（这是上一版踩的坑）：
#    - 端口预览地址形如 https://<环境ID>-3001.cnb.run，环境ID 每次启动都变，
#      且环境离线约 10 分钟被回收 → 地址失效，好友打不开，也**不能长期当游戏服务器**；
#    - 本镜像部署到任意云主机/容器平台后，入口就是「服务器IP:3001」或你自己的域名，
#      **重启不变、7x24 常驻、延迟只取决于机房到你家的物理链路**。
#
#  构建：  docker build -t tank-online .
#  运行：  docker run -d --name tank -p 3001:3001 --restart=always tank-online
#  玩法：  把 http://<服务器公网IP>:3001 发给好友 → 打开即进大厅（页面与 WS 同端口）
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV PORT=3001 HOST=0.0.0.0 NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/ || exit 1
CMD ["node", "server/index.mjs"]
