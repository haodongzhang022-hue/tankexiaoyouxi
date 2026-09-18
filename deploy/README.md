# 常驻联机服务器部署（固定公网入口 · 取代 cpolar）

## 云原生开发能测延迟吗？能；但只能当"临时"入口

端口预览 `https://<环境ID>-3001.cnb.run` **可以先用来测延迟**（页面与 WebSocket 同源，
一个地址即可联机），流程见 `.cnb.yml` 顶部注释：

```bash
npm run net:tunnel -- --test   # 探测"是不是游戏服务" + 实测延迟
```

但它不能当长期入口，硬伤：

1. **环境ID每次都变**：环境销毁重建后域名前缀变了，旧链接立刻失效；
2. **环境回收后链接打不开**（关页 10 分钟无操作 / 最大 18h / 凌晨 4-6 点强制）；
3. **`cnb.run` 是通配域名**，环境不存在时统一 302 跳回 cnb.cool
   —— 这就是"进去是写代码的网站、没法玩"的直接原因（那个环境已经被回收了）。

结论：**先用云原生开发把延迟测出来，数字满意了再上常驻服务器做固定入口。**

## 方案 A · 本地/局域网机器 + Docker（最快得到固定入口）

```bash
# 推荐用一键脚本：构建 → 启动 → 健康检查 → **带令牌登记对外入口** 一条龙
bash deploy/start-server.sh 3001
```

> **玩家视角（Issue #11）：入口不再需要任何手动前置。**
> 服务器启动时自己找一次对外入口（平台模板 → `TANK_PUBLIC_ENTRY` → 本机公网 IP → 局域网 IP）
> 并落盘，容器一起来就能玩；下面那条 `curl` 登记只是**可选**的（用来指定公网 IP 或自有域名，
> 让异地好友优先走你指定的地址）。要固定指定就传 `-e TANK_PUBLIC_ENTRY=http://<域名或IP>:3001`，
> 同样零手动步骤。完全不想要自动登记（只认显式令牌登记）就 `-e TANK_AUTO_ENTRY=0`。

等价的手工步骤（登记是**可选**的，跑不跑都能玩）：

```bash
docker build -f deploy/Dockerfile -t tank-online .   # 前端在镜像里构建，宿主无需 npm run build
mkdir -p "$PWD/.tank-deploy"
docker run -d --name tank -p 3001:3001 --restart=always \
  -e TANK_ENTRY_TOKEN_FILE=/data/entry.token -v "$PWD/.tank-deploy:/data" tank-online
# （可选）显式登记「对外入口」——指定优先用哪个地址（IP 形态也认）：
#   不跑这条也没关系：服务器启动时会自动登记本机公网/局域网 IP。
curl -H "X-Tank-Entry-Token: $(cat .tank-deploy/entry.token)" \
  "http://127.0.0.1:3001/entry/register?url=http://203.0.113.9:3001"
```

- 局域网内：`http://<本机IP>:3001` 直接可玩，**零隧道、零延迟开销**；
  **无域名也能分享**（v3.0.2）：登记 `http://192.168.1.50:3001` 即可，同 WiFi 好友点稳定链接会 302 到这台机器；
- 要公网：路由器端口转发 3001（有公网IP时最佳，延迟最低），或在这台机器上跑
  一个 FRP/Cloudflare Tunnel 客户端（只需一条 TCP 转发，比 cpolar 自带的 HTTP 隧道稳）。

## 方案 B · 腾讯云轻量/CVM（推荐，低延迟固定入口）

这是本 Issue 的目标形态：

```bash
# 腾讯云轻量应用服务器（2核2G，最低配够用），选离你最近的地域（如南京/上海）
# 安全组放行 TCP 3001
scp -r . root@<服务器IP>:/opt/tank     # 或 git clone
ssh root@<服务器IP>
cd /opt/tank
bash deploy/start-server.sh 3001       # 构建 + 启动 + 健康检查 + 登记对外入口
```

拿到固定入口 **`http://<服务器IP>:3001`**（绑域名后 `https://game.你的域名`，见下）。
`start-server.sh` 会自动把公网 IP 登记成「当前入口」；换了 IP 或绑了域名，
重跑一次脚本、或跑 `npm run net:tunnel -- --entry=http://<新IP或域名>:3001` 即可，
分享出去的稳定链接不用改。

延迟预期：机房→家的单向物理延迟通常在 10~40ms（同省更低），
对比 cpolar 实测 600ms+，**有量级差异**。

## 延迟怎么量

服务器起来后，在本地跑（与游戏内 HUD 同口径）：

```bash
npm run net:latency -- http://<服务器IP>:3001
```

输出 HTTP 首字节 + WS 握手 + 20 次 ping/pong 的 avg/p50/p95/max/jitter。

## 绑域名 + HTTPS（推荐）

WebSocket 在 HTTPS 下走 wss，浏览器混合内容策略更友好（尤其 iOS）：

```bash
# 服务器上装 nginx，反代 3001（WebSocket 需要 Upgrade 头）
```

```nginx
server {
  listen 443 ssl http2;
  server_name game.example.com;
  ssl_certificate     /etc/letsencrypt/live/game.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;   # WS 必需
    proxy_set_header Connection "upgrade";       # WS 必需
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;                    # 长连接别被掐
  }
}
```

证书：`certbot --nginx -d game.example.com`。

游戏内「复制邀请链接」用的是**服务器可信来源确立的入口**（带令牌的显式登记 / 平台预览模板），
**不再采信请求里的 Host 头**（Host 可伪造，曾能把分享链接指向攻击者域名）。
换域名/换 IP 后：跑一次登记（`npm run net:tunnel -- --entry=...`）或重启脚本即可，链接不用改。

## P2P 直连（进一步压低延迟）

默认两端都走服务器中继。P2P 直连由构建期变量 `VITE_ICE_SERVERS` 控制
（`src/net/RtcPeer.ts` 读取，逗号分隔多个地址）：

- **不配置**（默认）：`iceServers: []` → 只有同机/局域网能直连，公网跨 NAT 必然失败并自动回落 WS 中继，游戏不受影响；
- **配置 STUN**：公网跨 NAT 也有机会直连，快照少走一跳中转；
- 自建 coturn 最稳（对称 NAT 下也能打洞）。

```bash
VITE_ICE_SERVERS="stun:stun.qq.com" npm run build
# 多个：VITE_ICE_SERVERS="stun:stun.qq.com,stun:你的coturn:3478"
```

⚠ 这是**构建期**变量（Vite 打包时静态替换），改完必须重新 `npm run build`，
仅改运行环境变量无效。docker 构建时同理：

```bash
docker build -f deploy/Dockerfile --build-arg VITE_ICE_SERVERS="stun:stun.qq.com" -t tank-online .
```

## 换端口 / 健康检查

镜像里端口全部跟着 `PORT` 走（含 `HEALTHCHECK`），换端口只需：

```bash
docker run -d --name tank -p 8080:8080 -e PORT=8080 --restart=always tank-online
```

健康检查打的是 `/healthz`（只证明进程活着，不依赖 dist 是否构建）：

```bash
docker inspect --format '{{.State.Health.Status}}' tank   # healthy
curl -s http://127.0.0.1:3001/healthz                     # {"ok":true,...}
```

一键脚本 `bash deploy/start-server.sh [端口]` 会把上面几步连起来跑：
构建 → 启动（挂载 `.tank-deploy/` 存令牌与登记结果）→ 健康检查等待 → **带令牌登记对外入口** → 打印稳定链接。

登记结果自检（`current` 应是你的公网 IP/域名，`currentSource` 说明它从哪来）：

```bash
curl -s http://127.0.0.1:3001/healthz   # {"current":"http://203.0.113.9:3001","currentSource":"register",...}
```

**入口从哪来（v3.0.3 起，优先级由高到低）**：
1. 带令牌的**显式登记**（你说了算，不被别的来源顶回）；
2. 平台注入的预览模板（云原生开发环境自带，已做残留占位符校验）；
3. 服务器**自己找**的本机入口（`TANK_PUBLIC_ENTRY` → 本机公网 IP → 局域网 IP），并落盘 —— 零手动步骤。
4. 玩家那侧如发现登记入口连不上（后端网络不通），会就地用「实际能连到的地址」开玩，
   并允许修正一次（仅在**已有登记入口**时，避免请求方自报地址变成入口）。

⚠ 上述全部拿不到时（完全离线/无网卡），稳定链接**不会**把好友送到 127.0.0.1，
而是给一页可操作提示；本机/同一内网打开的访问者会在该页看到「直接开玩」并自动进游戏。
