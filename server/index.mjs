//  server/index.mjs ─
//  坦克大战 联机服务器（单端口）：静态页面托管 + 大厅 + 主机权威中继
//  职责：
//    1. 同一端口托管构建后的前端页面（dist/）与 WebSocket → 一个链接即可分享
//    2. 大厅：建桌/进桌/离开/准备/开始（每桌最多 4 座，每模式预置 20 桌）
//    3. 游戏期：把非主机成员的按键(peer_input)中继给桌主；把桌主的
//       权威快照(snapshot)/结束(gameover)广播给其他成员。（主机权威：主机跑模拟）
//  运行：
//    npm run build     先构建前端到 dist/
//    node server/index.mjs   （默认端口 3001，可用环境变量 PORT 覆盖）
//    然后把 http://<本机IP>:3001 直接发给好友即可联机。
//
//  协议：消息统一 JSON，字段 `t` 表示类型。见 src/net/NetTypes.ts 同步维护。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");

const PORT = parseInt(process.env.PORT || "3001", 10);
// 监听地址：默认 0.0.0.0（容器/端口预览代理回源需要），可用 HOST=127.0.0.1 收紧到本机
const HOST = process.env.HOST || "0.0.0.0";
const MAX_SEATS = 4;

// ── 静态文件服务（dist/）─────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendHtml(res, code, body) {
  res.writeHead(code, { "Content-Type": MIME[".html"], "Cache-Control": "no-store, must-revalidate" });
  res.end(body);
}

const NOT_BUILT_PAGE = `<!DOCTYPE html><html lang="zh"><meta charset="utf-8">
<title>坦克大战联机</title><body style="background:#0a0a0a;color:#ddd;font-family:monospace;padding:32px;line-height:1.8">
<h2 style="color:#ffd700">坦克大战 · 联机服务器已启动</h2>
<p>WebSocket 大厅服务正常（端口 ${PORT}）。</p>
<p>但还没有构建前端页面（缺少 dist/ 目录），好友打开此地址暂时看不到游戏。</p>
<p>在项目目录执行：</p>
<pre style="color:#4af">npm install
npm run build</pre>
<p>然后重启本服务器，再把这个地址发给好友即可：<b>http://&lt;你的IP&gt;:${PORT}</b></p>
</body></html>`;

const httpServer = http.createServer((req, res) => {
  learnPublicHost(req.headers && req.headers.host);
  if (!req.url || req.method !== "GET") { res.writeHead(405); res.end(); return; }
  // 解析路径并防目录穿越
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { sendHtml(res, 400, "bad request"); return; }
  // 健康检查（供 Docker HEALTHCHECK / 云负载均衡 / 你自己 curl 用）
  // 与 "/" 的区别：这里只证明**服务进程活着**，不关心 dist 是否构建，返回极小的 JSON。
  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, service: "tank-online", port: PORT, tables: tables.size, publicHost: publicHost || null }));
    return;
  }
  // 版本标识：好友/你一眼确认「这是游戏服务」而不是某个 IDE 或跳转页
  if (urlPath === "/__whoami") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ game: "坦克大战深度版", kind: "game-server", distBuilt: fs.existsSync(path.join(DIST_DIR, "index.html")), host: req.headers.host || null }));
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(DIST_DIR, urlPath));
  if (!filePath.startsWith(DIST_DIR)) { sendHtml(res, 403, "forbidden"); return; }

  const serve = (fp) => {
    fs.readFile(fp, (err, data) => {
      if (err) return sendHtml(res, 500, "read error");
      const ext = path.extname(fp).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        // v2.15 禁用所有静态文件缓存，确保联机玩家加载相同版本
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
      });
      res.end(data);
    });
  };

  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) return serve(filePath);
    // 无扩展名的路径 → SPA 回退到 index.html；dist 未构建 → 引导页
    if (!path.extname(urlPath)) {
      fs.stat(path.join(DIST_DIR, "index.html"), (e2, st2) => {
        if (!e2 && st2.isFile()) return serve(path.join(DIST_DIR, "index.html"));
        sendHtml(res, 200, NOT_BUILT_PAGE.replace(/\${PORT}/g, String(PORT)));
      });
      return;
    }
    sendHtml(res, 404, "not found");
  });
});

const wss = new WebSocketServer({ server: httpServer });

// 收集本机真实局域网 IPv4（排除回环），按可分享概率排序：
// 192.168.x.x（家用路由最常见的物理网卡）> 10.x > 172.16-31.x > 其他
const LAN_IPS = (() => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
    }
  }
  const rank = (ip) =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return ips.sort((a, b) => rank(a) - rank(b));
})();
const SERVER_INFO = { lanIps: LAN_IPS, port: PORT };

// ── 公网入口动态学习 ─────────────────────────────
// 隧道(cpolar/cloudflared 等)转发请求时会带原始 Host 头（如 600ecc6f.r3.cpolar.cn）。
// 服务器从任何进站 HTTP/WS 请求自动学习"当前公网域名"，随 welcome/tables 广播给所有
// 客户端 → 游戏内邀请链接实时自动适配，隧道域名怎么变都不用手动改。
let publicHost = "";
function learnPublicHost(hostHeader) {
  if (!hostHeader) return; // Host 必须是公网域名才更新（局域网/localhost 已被下面过滤）
  let h = String(hostHeader).replace(/^www\./, "").toLowerCase();
  h = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.split(":")[0];
  if (!h || h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return;                // 纯 IP 不学（要域名）
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return; // 私网不学
  publicHost = h;
  console.log("[动态适配] 学习到公网入口域名: " + h);
}

// ── 大厅数据 ──
let nextClient = 1;

/** table = { id, name, mode:'endless'|'stage', hostId, state:'lobby'|'playing',
 *            seats:[ {clientId,name,ready} | null ... ], playingSeats:[ws|null...] } */
const tables = new Map(); // tableId -> table

// v2.3.6 房间大厅：每模式预置 20 桌（无尽 + 闯关），先选模式再进该模式的大厅。
// 一桌 1~4 人，房主随时可开局（其余座位全部准备后生效）。
const MAX_TABLES_PER_MODE = 20;
const MODE_TABLE_NAMES = { endless: "无尽房", stage: "闯关房" };
function makeTable(id, mode, num) {
  return {
    id,
    name: `${MODE_TABLE_NAMES[mode]} ${String(num).padStart(2, "0")}`,
    mode,
    hostId: -1,           // -1 = 空桌（无人）
    state: "lobby",
    seats: Array.from({ length: MAX_SEATS }, () => null),
    orient: "landscape",  // v2.35 房间方向（房主建房时指定；成员端据此对齐布局）
  };
}
{
  let tid = 1;
  for (const mode of ["endless", "stage"]) {
    for (let n = 1; n <= MAX_TABLES_PER_MODE; n++) tables.set(tid, makeTable(tid, mode, n)), tid++;
  }
}

// v2.25 动态建房：预置的 20 桌只是"基础房"，房满/无空桌时服务器现场新建 ——
// 大厅永远有可加入的房间，绝不出现"暂无可用房间"。
let nextTableId = MAX_TABLES_PER_MODE * 2 + 1;
const dynSeq = { endless: MAX_TABLES_PER_MODE, stage: MAX_TABLES_PER_MODE };
function createTable(mode) {
  const num = ++dynSeq[mode];
  const t = makeTable(nextTableId++, mode, num);
  tables.set(t.id, t);
  console.log(`[大厅] 动态新建房间 #${t.id} ${t.name}（${mode}）`);
  return t;
}
/** v2.25 保证每个模式的大厅至少有一桌可加入（列表/建房前调用；没有就现场新建）
 *  可加入 = lobby 状态且还有空位（满桌/对局中不算）。 */
function ensureLobbyTables() {
  if (tables.size > 400) return;   // 防御性上限（正常玩法永远到不了）
  for (const mode of ["endless", "stage"]) {
    let hasJoinable = false;
    for (const t of tables.values()) {
      if (t.mode === mode && t.state === "lobby" && t.seats.some((s) => s === null)) { hasJoinable = true; break; }
    }
    if (!hasJoinable) createTable(mode);
  }
}

// ── 工具 ──
function seatCount(table) {
  return table.seats.filter((s) => s !== null).length;
}
function fullTableView(table) {
  return {
    id: table.id,
    name: table.name,
    mode: table.mode,
    hostName: table.seats.find((s) => s && s.clientId === table.hostId)?.name ?? "",
    hostClientId: table.hostId,
    seats: table.seats.map((s) => (s ? { clientId: s.clientId, name: s.name, ready: s.ready } : null)),
    state: table.state,
    orient: table.orient || "landscape",   // v2.35
  };
}
function broadcastTables(filterTableId = null) {
  const list = [];
  for (const t of tables.values()) {
    if (filterTableId !== null && t.id === filterTableId) continue;
    list.push(fullTableView(t));
  }
  // 携带动态学习的公网域名，客户端实时刷新邀请链接
  const msg = JSON.stringify({ t: "tables", tables: list, publicHost: publicHost || undefined });
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && c.conn) c.send(msg);
  }
}
function broadcastTable(table) {
  const msg = JSON.stringify({ t: "table", table: fullTableView(table) });
  for (const s of table.seats) {
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(msg);
  }
}
function sendRaw(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function makeHost(table) {
  return table.seats.find((s) => s && s.clientId === table.hostId)?.ws ?? null;
}

// ── 连接管理 ──
wss.on("connection", (ws, req) => {
  learnPublicHost(req && req.headers && req.headers.host);
  const conn = { id: nextClient++, name: "玩家", tableId: null, idx: -1 };
  ws.conn = conn;
  // serverInfo：告知客户端本机的真实局域网地址 + 动态学习的公网入口
  sendRaw(ws, { t: "welcome", clientId: conn.id, serverInfo: SERVER_INFO, publicHost: publicHost || undefined });
  broadcastTables(null);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    handle(ws, conn, msg);
  });

  ws.on("close", () => {
    if (conn.tableId !== null) {
      const table = tables.get(conn.tableId);
      // v2.12 房主断线：存活成员接替续局（主机迁移；无人在场才终止本局）
      if (table && table.state === "playing" && conn.id === table.hostId) {
        migrateHost(table, conn);
        return;
      }
      // v2.11 对局进行中非房主断线：软离场（保留座位 ws=null），凭 rejoinToken 可重连回来
      if (table && table.state === "playing" && conn.id !== table.hostId) {
        const idx = table.seats.findIndex((s) => s && s.clientId === conn.id);
        if (idx >= 0) table.seats[idx].ws = null;
        conn.tableId = null;
        broadcastTables(null);
        return;
      }
      // 房主断线 / 大厅内断线：正常离桌（对局中房主断线 = 本局终止——不做主机迁移）
      if (table) leaveTable(conn, table);
    }
    broadcastTables(null);
  });

  // 单个连接的协议错误（如非法关闭码 WS_ERR_INVALID_CLOSE_CODE、对端异常断开）
  // 不能让它冒泡成未捕获异常，否则一条坏连接会拖垮整个联机服。
  ws.on("error", (err) => {
    try { console.warn(`[ws] 连接 ${conn.id} 错误（已忽略，不影响服务）: ${err && err.code ? err.code : err.message}`); } catch {}
    try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate(); } catch {}
  });
});

// WebSocket 服务级错误兜底
wss.on("error", (err) => {
  console.error(`[wss] WebSocket 服务错误（已捕获，服务继续运行）: ${err && err.stack ? err.stack : err}`);
});

/** v2.12 主机迁移：房主断线 → 最靠前的在场成员接替为主机，本局继续（无需重开） */
function migrateHost(table, departed) {
  // 找最靠前（座位序）的在场成员作为新主机
  const live = table.seats.map((s, i) => (s && s.ws && s.ws.readyState === WebSocket.OPEN ? i : -1)).filter((i) => i >= 0);
  // 清空离场房主的座位（其 rejoinToken 随之失效，断线者无法再挤回）
  const depIdx = table.seats.findIndex((s) => s && s.clientId === departed.id);
  if (depIdx >= 0) table.seats[depIdx] = null;
  if (live.length === 0) {
    // 无人在场 → 终止本局（回大厅，桌子保留供重开）
    table.hostId = -1;
    table.state = "lobby";
    for (let i = 0; i < table.seats.length; i++) table.seats[i] = null;
    broadcastTables(null);
    return;
  }
  const newSeat = live[0];
  table.hostId = table.seats[newSeat].clientId;
  const players = table.seats.filter(Boolean).map((s) => ({ clientId: s.clientId, name: s.name }));
  for (const s of table.seats) {
    if (s && s.ws && s.ws.readyState === WebSocket.OPEN) {
      sendRaw(s.ws, { t: "migrated", newHostClientId: table.hostId, players });
    }
  }
  console.log(`[migrate] table ${table.id}: host ${departed.id} 断线 → 新主机 seat${newSeat}(client ${table.hostId}) 接替续局`);
  broadcastTables(null);
}

function handle(ws, conn, msg) {
  const t = msg.t;
  // 大厅操作
  if (t === "setname") { conn.name = String(msg.name || "玩家").slice(0, 12); return; }

  if (t === "list") {
    ensureLobbyTables();   // v2.25 列表永远包含可加入的房间（缺房现场新建）
    sendRaw(ws, { t: "tables", tables: [...tables.values()].map(fullTableView) });
    return;
  }

  if (t === "create") {
    if (conn.tableId !== null) return sendRaw(ws, { t: "error", msg: "你已在桌内" });
    const mode = msg.mode === "stage" ? "stage" : "endless";
    // 找该模式第一个空桌（0 座）作为新房间；v2.25 无空桌则现场新建（绝不阻塞）
    let target = null;
    for (const table of tables.values()) {
      if (table.mode === mode && seatCount(table) === 0 && table.state === "lobby") { target = table; break; }
    }
    if (!target) target = createTable(mode);
    conn.name = (conn.name && conn.name !== "玩家") ? conn.name : `房主${conn.id % 1000}`;
    target.hostId = conn.id;
    target.state = "lobby";
    target.seats[0] = { clientId: conn.id, name: conn.name, ready: false, ws };
    if (msg.name && String(msg.name).trim()) target.name = String(msg.name).slice(0, 16);
    if (msg.orient === "portrait" || msg.orient === "landscape") target.orient = msg.orient;   // v2.35 房间方向
    conn.tableId = target.id; conn.idx = 0;
    broadcastTable(target);
    broadcastTables(null);
    return;
  }

  if (t === "join") {
    if (conn.tableId !== null) return sendRaw(ws, { t: "error", msg: "你已在桌内" });
    const table = tables.get(Number(msg.tableId));
    if (!table) return sendRaw(ws, { t: "error", msg: "房间不存在" });
    if (table.state === "playing") return sendRaw(ws, { t: "error", msg: "该房间对局中" });
    const idx = table.seats.findIndex((s) => s === null);
    if (idx < 0) return sendRaw(ws, { t: "error", msg: "房间已满" });
    // 空桌首位进入者自动成为房主（否则无人能开始对局）
    if (table.hostId === -1) {
      table.hostId = conn.id;
      conn.name = (conn.name && conn.name !== "玩家") ? conn.name : `房主${conn.id % 1000}`;
    }
    conn.name = (conn.name && conn.name !== "玩家") ? conn.name : `玩家${(conn.id % 1000)}`;
    table.seats[idx] = { clientId: conn.id, name: conn.name, ready: false, ws };
    conn.tableId = table.id; conn.idx = idx;
    broadcastTable(table);
    broadcastTables(null);
    return;
  }

  if (t === "leave") {
    if (conn.tableId === null) return;
    leaveTable(conn, tables.get(conn.tableId));
    return;
  }

  if (t === "ready") {
    const table = tableOf(conn);
    if (!table || table.state !== "lobby") return;
    const seat = seatOf(conn, table);
    if (seat) seat.ready = !!msg.value;
    broadcastTable(table);
    return;
  }

  // v2.36 房主更改房间方向（对局开始前）：实时广播给所有成员，各自按此方向准备布局
  if (t === "orient") {
    const table = tableOf(conn);
    if (!table || table.state !== "lobby") return;
    if (conn.id !== table.hostId) return sendRaw(ws, { t: "error", msg: "仅房主可更改房间方向" });
    table.orient = msg.orient === "portrait" ? "portrait" : "landscape";
    broadcastTable(table);
    broadcastTables(null);
    return;
  }

  if (t === "start") {
    const table = tableOf(conn);
    if (!table || conn.id !== table.hostId) return sendRaw(ws, { t: "error", msg: "仅房主可开始" });
    if (table.state !== "lobby") return;
    // v2.5：房主无需准备；其余入座玩家全部准备后才能开始
    const seated = table.seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    if (seated.length < 1) return sendRaw(ws, { t: "error", msg: "需要至少 1 人才能开始" });
    const guestsReady = seated.every((i) => table.seats[i].clientId === table.hostId || table.seats[i].ready);
    if (!guestsReady) return sendRaw(ws, { t: "error", msg: "还有玩家未准备（等待所有人点击准备）" });
    table.state = "playing";
    table.playingSeats = table.seats.map((s) => (s ? s.ws : null));
    if (table.seed == null) table.seed = Math.floor(Math.random() * 1e9);
    const players = seated.map((i) => ({ clientId: table.seats[i].clientId, name: table.seats[i].name }));
    seated.forEach((seatIdx, idx) => {
      const s = table.seats[seatIdx];
      s.idx = idx; // 玩家索引：房主=0，成员按座次 1..3（座位 3~4 为观战）
      s.rejoinToken = Math.random().toString(36).slice(2, 12); // v2.11 对局身份令牌（断线重连用）
      sendRaw(s.ws, { t: "start", tableId: table.id, mode: table.mode, myIndex: idx, players, seed: table.seed, rejoinToken: s.rejoinToken, orient: table.orient || "landscape" });
    });
    return;
  }

  if (t === "rejoin") {
    // v2.11 局内重进：对局进行中断线/刷新后凭令牌回到原座位（服务端原样继续广播，无需主机配合）
    const table = tables.get(Number(msg.tableId));
    console.log("[rejoin] req tableId=", msg.tableId, "token=", String(msg.token || "").slice(0, 6), "state=", table?.state, "found=", table ? table.seats.some((s) => s && s.rejoinToken === String(msg.token || "")) : "-");
    if (!table || table.state !== "playing") return sendRaw(ws, { t: "error", msg: "房间已结束或无进行中对局" });
    const token = String(msg.token || "");
    const seatIdx = table.seats.findIndex((s) => s && s.rejoinToken === token);
    if (seatIdx < 0) return sendRaw(ws, { t: "error", msg: "重连令牌无效或已失效" });
    const s = table.seats[seatIdx];
    s.ws = ws; s.clientId = conn.id;       // 新连接挂回原座位
    conn.tableId = table.id; conn.idx = s.idx;   // 玩家索引（座位下标可能≠玩家索引）
    const players = table.seats.map((x, i) => (x ? { clientId: x.clientId, name: x.name } : null)).filter(Boolean);
    const playersNamed = table.seats.filter(Boolean).map((x) => ({ clientId: x.clientId, name: x.name })); // 索引=玩家索引
    sendRaw(ws, { t: "rejoin_ok", mode: table.mode, myIndex: s.idx, players: playersNamed, seed: table.seed ?? 0, rejoinToken: token, orient: table.orient || "landscape" });
    return;
  }

  // 游戏期
  if (t === "ping") {
    // RTT 探测：原样回包（ts 为客户端发起的原时间戳）
    sendRaw(ws, { t: "pong", ts: Number(msg.ts) || Date.now() });
    return;
  }
  if (t === "input") {
    const table = tableOf(conn);
    if (!table || table.state !== "playing") return;
    // 顺便为发送者回一个 pong（同一趟 input 兼当 RTT 探测，利用率最高）
    sendRaw(ws, { t: "pong", ts: Number(msg.clientSendTime) || Date.now() });
    const host = makeHost(table);
    if (host && host !== ws) {
      // 透传 clientSendTime 和 clientFrame 供主机队列消费
      sendRaw(host, { t: "peer_input", idx: conn.idx, flags: msg.flags, clientSendTime: msg.clientSendTime, clientFrame: msg.clientFrame });
    }
    return;
  }
  if (t === "snapshot") {
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return; // 只有房主可发快照
    for (const s of table.seats) {
      if (s && s.ws !== host) sendRaw(s.ws, { t: "snapshot", data: msg.data });
    }
    return;
  }
  if (t === "gameover") {
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return;
    for (const s of table.seats) if (s && s.ws !== host) sendRaw(s.ws, { t: "gameover", info: msg.info });
    table.state = "lobby";
    table.seats.forEach((s) => { if (s) s.ready = false; });
    broadcastTables(null); // 对局结束后同步大厅列表状态
    return;
  }
  if (t === "levelup") {
    // 主机广播升级选项 → 其他成员
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return;
    for (const s of table.seats) if (s && s.ws !== host) sendRaw(s.ws, { t: "levelup", playerIdx: msg.playerIdx, choices: msg.choices });
    return;
  }
  if (t === "pick_levelup") {
    // 成员回传升级选择 → 主机
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host && host !== ws) sendRaw(host, { t: "pick_levelup", playerIdx: msg.playerIdx, choice: msg.choice });
    return;
  }
  if (t === "shopstate") {
    // v2.9 主机广播基地商店库存 → 其他成员
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return;
    for (const s of table.seats) if (s && s.ws !== host) sendRaw(s.ws, { t: "shopstate", stock: Array.isArray(msg.stock) ? msg.stock : [] });
    return;
  }
  if (t === "shop_buy") {
    // v2.9 成员回传购买选择 → 主机（主机扣该玩家经验钱包并结算）
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host && host !== ws) sendRaw(host, { t: "shop_buy", playerIdx: msg.playerIdx, choice: Number(msg.choice) });
    return;
  }
  if (t === "equip_req") {
    // v2.23 成员装配/卸载请求（拖动协议）→ 主机（主机权威结算后回 equip_res）
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host && host !== ws) sendRaw(host, { t: "equip_req", playerIdx: Number(msg.playerIdx), action: msg.action === "unequip" ? "unequip" : "equip", invIdx: Number(msg.invIdx) || 0, wand: Number(msg.wand) || 0, slot: Number(msg.slot) || 0 });
    return;
  }
  if (t === "equip_res") {
    // v2.23 主机装配结果 → 全体成员（主要是发起者）
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return;
    for (const s of table.seats) if (s && s.ws !== host) sendRaw(s.ws, { t: "equip_res", playerIdx: Number(msg.playerIdx), ok: !!msg.ok, msg: String(msg.msg || "") });
    return;
  }
  if (t === "fortify_req") {
    // v2.23 成员加固基地请求 → 主机
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host && host !== ws) sendRaw(host, { t: "fortify_req", playerIdx: Number(msg.playerIdx) || 1 });
    return;
  }
  if (t === "fortify_res") {
    // v2.23 主机加固结果 → 全体成员
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return;
    for (const s of table.seats) if (s && s.ws !== host) sendRaw(s.ws, { t: "fortify_res", ok: !!msg.ok, msg: String(msg.msg || "") });
    return;
  }
  if (t === "checkpoint") {
    // v2.35 主机检查点 → 在场成员（每人保存最新一份，接替续局时恢复武器/等级/背包）
    // v2.35 修复：此前只转发 players，导致成员端「资源包永远下载中」+ 仓库为空 —— 补全 warehouse/assetPack/assetPackVersion
    const table = tableOf(conn);
    if (!table) return;
    const host = makeHost(table);
    if (host !== ws) return;
    for (const s of table.seats) {
      if (s && s.ws && s.ws !== host && s.ws.readyState === WebSocket.OPEN) {
        sendRaw(s.ws, { t: "checkpoint", players: msg.players, warehouse: msg.warehouse, assetPack: msg.assetPack, assetPackVersion: msg.assetPackVersion });
      }
    }
    return;
  }
  if (t === "rtc_signal") {
    // v2.10 WebRTC 信令：仅同桌内转发给目标 clientId（服务器不感知 SDP/ICE 内容）
    const table = tableOf(conn);
    if (!table) return;
    const toSeat = table.seats.find((s) => s && s.clientId === msg.to && s.ws !== ws);
    if (toSeat) sendRaw(toSeat.ws, { t: "rtc_signal", from: conn.id, payload: msg.payload });
    return;
  }
}

function tableOf(conn) { return conn.tableId !== null ? tables.get(conn.tableId) : null; }
function seatOf(conn, table) {
  return table.seats.find((s) => s && s.clientId === conn.id) || null;
}

function leaveTable(conn, table) {
  if (!table) return;
  const idx = table.seats.findIndex((s) => s && s.clientId === conn.id);
  const myWs = idx >= 0 ? table.seats[idx].ws : null;
  const wasHost = conn.id === table.hostId;
  if (idx >= 0) table.seats[idx] = null;
  conn.tableId = null; conn.idx = -1;
  // 通知离开者本人（用座位里的真实 ws；断线触发时 ws 已关，sendRaw 自动跳过）
  sendRaw(myWs, { t: "left" });
  // 房主离开 → 整桌清空重置（桌子保留，供后续玩家再开）
  if (wasHost) {
    for (let i = 0; i < table.seats.length; i++) table.seats[i] = null;
    table.hostId = -1;
    table.state = "lobby";
    broadcastTables(null);
    return;
  }
  if (table.state === "playing") {
    const host = makeHost(table);
    if (host && host.readyState === WebSocket.OPEN) sendRaw(host, { t: "peer_left", idx });
  }
  broadcastTable(table);
  broadcastTables(null);
}

httpServer.on("error", (err) => {
  console.error(`[http] 服务器错误（已捕获）: ${err && err.stack ? err.stack : err}`);
});

// 进程级兜底：任何未捕获的连接异常都不应拖垮联机服（好友还在房间里）
process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException] 已捕获，服务继续运行: ${err && err.stack ? err.stack : err}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[unhandledRejection] 已捕获，服务继续运行: ${reason}`);
});

httpServer.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) lanIps.push(ni.address);
    }
  }
  console.log(`[坦克大战联机] 服务器已启动（页面 + WebSocket 同端口）`);
  console.log(`  本机游玩:   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`  局域网分享: http://${ip}:${PORT}`);
  console.log(`  监听地址:   ${HOST}:${PORT}`);
  // 云原生开发（CNB）会注入端口预览模板 https://<环境ID>-{{port}}.cnb.run，
  // 直接把 {{port}} 替换成端口就是公网分享地址（页面与 WS 同源，一个链接即可联机）。
  const proxyTpl = process.env.CNB_VSCODE_PROXY_URI || process.env.CNB_VSCODE_PROXY_URI_HTTPS || process.env.CNB_PROXY_URI || process.env.CNB_PORT_PREVIEW_URI;
  if (proxyTpl) {
    const pub = proxyTpl.replace(/\{\{port\}\}/g, String(PORT)).replace(/\/$/, '');
    console.log(`  公网分享:   ${pub}   ← 直接发给好友，打开即进大厅`);
    console.log(`  延迟自测:   npm run net:latency -- ${pub}`);
  }
  console.log(`  外网分享:   用路由器端口转发 / ngrok / frp / Cloudflare Tunnel 暴露 ${PORT} 端口后，把公网地址发给好友`);
  console.log(`  提示: 若提示没有游戏页面，请先在项目目录执行 npm run build`);
});
