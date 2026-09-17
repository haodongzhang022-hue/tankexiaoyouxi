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
npm run build
docker build -f deploy/Dockerfile -t tank-online .
docker run -d --name tank -p 3001:3001 --restart=always tank-online
```

- 局域网内：`http://<本机IP>:3001` 直接可玩，**零隧道、零延迟开销**；
- 要公网：路由器端口转发 3001（有公网IP时最佳，延迟最低），或在这台机器上跑
  一个 FRP/Cloudflare Tunnel 客户端（只需一条 TCP 转发，比 cpolar 自带的 HTTP 隧道稳）。

## 方案 B · 腾讯云轻量/CVM（推荐，低延迟固定入口）

这是本 Issue 的目标形态：

```bash
# 腾讯云轻量应用服务器（2核2G，最低配够用），选离你最近的地域（如南京/上海）
# 安全组放行 TCP 3001
scp -r . root@<服务器IP>:/opt/tank     # 或 git clone
ssh root@<服务器IP>
cd /opt/tank && npm run build
docker build -f deploy/Dockerfile -t tank-online .
docker run -d --name tank -p 3001:3001 --restart=always tank-online
```

拿到固定入口 **`http://<服务器IP>:3001`**（绑域名后 `https://game.你的域名`，见下）。

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

游戏内「复制邀请链接」会自动学习当前域名（服务器动态识别 Host 头），
换域名/换IP 都不用改代码。

## P2P 直连（进一步压低延迟）

默认两端都走服务器中继。给**两端**都配 STUN 可提升 P2P 直连概率，
让快照少走一跳中转：

```bash
VITE_ICE_SERVERS="stun:stun.qq.com" npm run build
```

自建 coturn 最稳（也能在对称 NAT 下打洞成功）：

```bash
VITE_ICE_SERVERS="stun:你的coturn:3478" npm run build
```
