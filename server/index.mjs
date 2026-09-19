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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dgram from "node:dgram";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
// 预览地址变量表/落盘读写的「单一事实源」（与 scripts/net-tunnel.mjs 共用同一份，避免漂移）
// ⚠ 只从单一事实源取「平台预览地址」与落盘读写；预览模板变量表（PREVIEW_TPL_KEYS）只被
//   detectPreviewUrl 内部使用 —— 服务器不再自己拼模板域名（Issue #11 评审 🔴3：自拼会产出未校验的垃圾域名）。
import { detectPreviewUrl, writePublicUrl, PUBLIC_URL_FILE } from "../shared/preview-url.mjs";
// 「稳定入口 ↔ 当前临时地址」自动匹配表（与共享层同一份实现，见 shared/entry-match.mjs）
import { createEntryMatcher, entryPath, makeSid, SID_RE, ENTRY_TTL_MS, ENTRY_KEEPALIVE_MS, ENTRY_SWEEP_MS, normalizeOrigin, originScope, ipScope, hasTemplatePlaceholder, localTipAllowedFor } from "../shared/entry-match.mjs";
import { ERR_ROOM_NOT_FOUND, ERR_ROOM_FULL, ERR_ROOM_PLAYING, ERR_ALREADY_IN_TABLE, ERR_HOST_ONLY, ERR_START_PRECONDITION, ERR_NO_REJOIN } from "../shared/net-error-codes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "..", "dist");

const PORT = parseInt(process.env.PORT || "3001", 10);
// 监听地址：默认 0.0.0.0（容器/端口预览代理回源需要），可用 HOST=127.0.0.1 收紧到本机
const HOST = process.env.HOST || "0.0.0.0";
const MAX_SEATS = 4;
// 服务可见性（联机自检报告用）：服务器启动时刻 + 进程内持续在服务的证明
const STARTED_AT = Date.now();
let lastClientSeenAt = 0;      // 最近一次收到任意客户端消息的时刻

// ── 稳定入口自动匹配 ────────────────────────────────────────────────
// 服务器内部 id（sid）恒定到进程重启：分享出去的链接 /<sid>/join/<roomId> 因此是"稳定"的；
// 平台环境重建/隧道换域名/换 IP 时，sid 会换新；地址变化由**服务器自己**按可信来源刷新并写进匹配表，
// 老链接打开时由 /:sid/join/:room 自动 302 到最新可用地址 —— 这就是"自动匹配到稳定之上"。
// 可用 TANK_SID 固定（自测/复现方便），否则每次启动新生成 —— 稳定链接的"稳定"来自自动匹配，不来自硬编码
const SID = SID_RE.test(String(process.env.TANK_SID || "").trim().toLowerCase())
  ? String(process.env.TANK_SID).trim().toLowerCase()
  : makeSid();
const entries = createEntryMatcher(SID);

// ── 「当前入口」的可信来源白名单 ────────────────────────────────────
// 硬教训（PR #7 评审 🔴1）：请求里的 Host 头是**调用方自报**的，任何人都能伪造。
// 若采信它来建立/迁移「当前入口」，那么一条 `curl -H "Host: evil.example.com" /healthz`
// 就能把房主分享出去的稳定链接 302 到攻击者域名（钓鱼）。
// 因此「当前入口」只认这三类**非请求方自报**的来源：
//   ① 带一次性部署令牌的探针显式登记（令牌 = 进程启动时随机生成 + 打印到日志/落盘，仅部署者可取）——
//      **优先级最高**：部署者说「我的入口是 http://1.2.3.4:3001」就以此为准，不被平台模板顶回；
//   ② 平台注入的端口预览模板（环境自己的域名，外部无法伪造；经 buildPreviewUrl 同口径校验，
//      含残留占位符（如 {{port}}）或域名形态不合法的模板一律作废，绝不拿半成品当 302 目标）；
//   ③ 上一次已被可信来源确立的当前入口（保持在服务的那个地址，不被匿名请求改写）。
// 请求 Host 只在**已经存在**「当前入口」时用来做同源跳转判断，永远不参与建立与迁移。
const ENTRY_PROBE_TOKEN_FILE = process.env.TANK_ENTRY_TOKEN_FILE || `/tmp/tank-entry-${PORT}.token`;
const ENTRY_PROBE_TOKEN = crypto.randomBytes(16).toString("hex");
/** 令牌落盘：0600 + 不跟随符号链接（预置 0644 / 指向别处的符号链接都要挡住，见 Issue #11 评审 🟡3） */
function writeEntryTokenFile(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(file, flags, 0o600);
    try { fs.writeSync(fd, ENTRY_PROBE_TOKEN + "\n"); } finally { fs.closeSync(fd); }
    fs.chmodSync(file, 0o600);      // open 的 mode 对「已存在的文件」无效 → 显式收权
  } catch (e) {
    console.warn(`[入口令牌] 落盘失败（不影响服务，但部署脚本将无法带令牌登记）: ${e && e.message}`);
  }
}
writeEntryTokenFile(ENTRY_PROBE_TOKEN_FILE);

/**
 * 「部署者免手动登记」——玩家视角的兜底：服务器自己把对外入口找出来并登记。
 *
 * 为什么需要它（Issue #11：有玩家反馈「入口只有 root 能拿到，玩家拿不到可用的连接入口」）：
 *   此前入口只能由**带 0600 令牌的手动登记**确立（`TANK_ENTRY_TOKEN_FILE` 权限 0600，默认属启动进程用户）。
 *   部署脚本用 `docker exec` 读容器内 root 的令牌，或宿主机以 root 跑 —— 换成非 root 启动、或直接用
 *   `node server/index.mjs` 跑的玩家，就**根本读不到令牌**，于是拿不到任何入口，点开邀请链接只会看到
 *   「还没有对外入口」提示页 → 「有别的前置就算没开发成功」。
 *
 * 判定「可信部署者」用的不是 uid（root/非 root 都要能用），而是**服务器自己的令牌文件路径可写**：
 *   能写 `$TANK_ENTRY_TOKEN_FILE` 的进程，本来就能直接改写登记结果（`<token>.url`），文件权限不构成任何
 *   安全边界（进程内的 CURRENT_ORIGIN 同样可被它改写）。因此把「同机可写」当作可信，不降低安全性，
 *   但把「玩家必须手动跑一条 curl」这个前置彻底去掉 —— 打开页面就能玩。
 *
 * 找入口的顺序（都是「非请求方自报」，所以不会引入 Host 伪造劫持）：
 *   ① 平台预览模板（detectPreviewUrl，已做残留占位符校验）；
 *   ② 显式传的 TANK_PUBLIC_ENTRY / TANK_PUBLIC_URL（部署脚本可用它指定域名，如反代域名）；
 *   ③ 本机公网出口 IP（UDP dial 腾讯 DNS，任何联网机器都做得到）+ 本机网卡里的公网 IP；
 *   ④ 局域网 IP（同 WiFi 直接可玩）。
 * 拿不到任何地址就老实不登记（宁缺勿错：给可操作提示页，绝不把好友送到他自己的 127.0.0.1）。
 * 可用 TANK_AUTO_ENTRY=0 关闭。
 */
async function autoRegisterLocalEntry() {
  if (process.env.TANK_AUTO_ENTRY === "0") return;
  // 已有入口（显式登记 / 平台模板）就不动它：显式登记永远优先，不被本兜底顶回
  if (readRegisteredEntryOrigin()) return;
  if (normalizeOrigin(CURRENT_ORIGIN)) return;
  if (!canWriteEntryFiles()) {
    console.log("[入口] 本机无令牌文件写权限（非部署者身份），跳过自动登记；入口仍由可信探针/模板决定");
    return;
  }
  const explicit = normalizeOrigin(process.env.TANK_PUBLIC_ENTRY || process.env.TANK_PUBLIC_URL || "");
  if (explicit && recordEntry(explicit, "auto", { allowPrivateIp: true })) {
    writeRegisteredEntryOrigin(normalizeOrigin(CURRENT_ORIGIN));
    console.log(`[入口] 已自动登记对外入口: ${CURRENT_ORIGIN}（来源：TANK_PUBLIC_ENTRY）`);
    return;
  }
  const pub = await publicIp();
  if (pub && recordEntry(`http://${pub}:${PORT}`, "auto", { allowPrivateIp: true })) {
    writeRegisteredEntryOrigin(normalizeOrigin(CURRENT_ORIGIN));
    console.log(`[入口] 已自动登记对外入口: ${CURRENT_ORIGIN}（公网 IP，好友打开即可玩）`);
    return;
  }
  const lan = LAN_IPS[0];
  if (lan && recordEntry(`http://${lan}:${PORT}`, "auto", { allowPrivateIp: true })) {
    writeRegisteredEntryOrigin(normalizeOrigin(CURRENT_ORIGIN));
    console.log(`[入口] 已自动登记对外入口: ${CURRENT_ORIGIN}（局域网 IP，同一 WiFi 可直接玩）`);
    return;
  }
  console.log("[入口] 未找到可用对外地址（离线/无网卡）：稳定链接将给可操作提示页，不会指向 127.0.0.1");
}

/** 部署者身份判定（不看 uid，看能不能动服务器自己的入口文件） */
function canWriteEntryFiles() {
  try { fs.accessSync(path.dirname(ENTRY_PROBE_TOKEN_FILE), fs.constants.W_OK); return true; } catch { return false; }
}

/** 本机公网出口 IP（UDP dial，不发数据包）；失败/超时返回 ""。可被 TANK_PUBLIC_IP 覆盖。 */
function publicIp() {
  const forced = String(process.env.TANK_PUBLIC_IP || "").trim();
  if (forced) return Promise.resolve(forced);
  // 本机网卡上如果直接就是公网 IP（云主机常见），优先用它 —— 不依赖外网可达
  const nicPublic = LAN_IPS.find((ip) => ipScope(ip) === "public");
  if (nicPublic) return Promise.resolve(nicPublic);
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(v); };
    try {
      sock.connect(80, "119.29.29.29");
      sock.once("connect", () => {
        try {
          const a = sock.address();
          const ip = a && a.address === "0.0.0.0" ? "" : a && a.address;
          finish(ip && ipScope(ip) === "public" ? ip : "");
        } catch { finish(""); }
      });
    } catch { finish(""); }
    setTimeout(() => finish(""), 1500);
  });
}

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
  // ⚠ 不再从进站请求的 Host 学习公网域名：Host 可伪造，会把「当前入口」与邀请链接域名
  //   指向攻击者（PR #7 评审 🔴1）。公网入口只由可信来源确立（模板 / 落盘登记 / 带令牌探针）。
  // 先留一份「本请求到达前」的入口快照：带令牌的请求会在下面 takeEntryTrustSignal 里**立即**应用
  // 新入口，若各处都读 CURRENT_ORIGIN 就会把「已被本请求改过的值」当成 previous 回给调用方（误导）。
  req.entryBeforeRequest = normalizeOrigin(CURRENT_ORIGIN);
  // ⚠ 这里**只刷新入口**（`refreshOnly`），不做显式登记：路由自己还要解析 query（如 /entry/localtip 的
  //    `origin=`），若在此按登记处理就会先把参数吃走（Issue #15 根因）。显式登记只在下面的
  //    `/entry/register` 专用路由里处理（令牌 + `url=` 参数，语义唯一）。
  takeEntryTrustSignal(req, "http", { refreshOnly: true });
  if (!req.url || req.method !== "GET") { res.writeHead(405); res.end(); return; }
  // 解析路径并防目录穿越
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { sendHtml(res, 400, "bad request"); return; }
  const hostHeader = String(req.headers.host || "").toLowerCase();
  // 访问者是不是「就在这台服务器本机 / 同一内网」打开的（Host 只用来做展示与自救跳转，绝不用于确立入口）
  const hostNameOnly = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const viewerIsLocal = hostNameOnly === "" || hostNameOnly === "localhost" || hostNameOnly.endsWith(".localhost")
    || hostNameOnly === "::1" || hostNameOnly.startsWith("127.") || hostNameOnly === "0.0.0.0"
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostNameOnly);
  // ── 部署探针显式登记公网入口（需一次性令牌）────────────────────
  // 部署脚本（deploy/start-server.sh、net:tunnel）用它对公网域名显式登记/刷新「当前入口」，
  // 这样稳定链接既能在环境重建后自动跟上新域名，又不会被匿名请求伪造 Host 劫持。
  if (urlPath === "/entry/register") {
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    if (!hasValidEntryToken(req)) return json(403, { ok: false, applied: false, error: "probe_token 缺失或无效", current: CURRENT_ORIGIN || null });
    const raw = registeredUrlRaw(req);
    if (!raw) return json(400, { ok: false, applied: false, error: "缺少 url 参数（用法：/entry/register?url=http://<你的公网IP或域名>:3001）", current: CURRENT_ORIGIN || null });
    const applied = recordEntry(raw, "register", { allowPrivateIp: true });   // 可信登记：IP 形态同样放行
    if (!applied) {
      return json(400, {
        ok: false, applied: false, requested: raw,
        error: entryRejectReason(raw),
        current: CURRENT_ORIGIN || null,
      });
    }
    // 落盘登记（服务器每次刷新都会读它）——失败也要如实回报，不能让部署者以为"已生效"
    const persisted = writeRegisteredEntryOrigin(applied);
    return json(200, {
      ok: true, applied: true, current: applied, persisted,
      source: "register（带令牌显式登记，优先级最高）",
      sid: SID,
      note: persisted ? "已落盘，服务器重启后仍生效" : "仅进程内生效：落盘失败（检查 " + ENTRY_PROBE_TOKEN_FILE + ".url 的写权限）",
    });
  }
  // ── 入口可达性上报（玩家自救，Issue #11；🔴 准入加固见 Issue #15）──────
  // 场景：服务器登记的入口（公网 IP / 域名）在后端网络里连不上 —— 玩家打开的这个地址却是通的。
  // 这时「登记的入口」对这名玩家等于死路，得让它就地用当前地址开玩。
  //
  // ⚠⚠ Issue #15（🔴 钓鱼面）：本路由此前**不需要任何令牌**就能改写全局入口并落盘 ——
  //    一条 `curl '/entry/localtip?origin=http://phish.example.net'` 就把房主分享出去的稳定链接
  //    302 到攻击者域名，且重启仍生效。旧注释声称的前置条件「只在已有登记入口时才接受修正」
  //    挡不住：服务器启动即自动登记本机 LAN IP（autoRegisterLocalEntry，currentSource=register），
  //    该条件**默认恒为真**。与 PR #7 评审 🔴1（Host 伪造劫持）同源 —— 入口地址决定 302 目标，
  //    **绝不能被请求方自报的值改写**（`?origin=` 只是 Host 的另一个马甲）。
  //
  // 现在的准入（满足其一才接受修正，见 localTipAllowed）：
  //   ① 携带一次性部署令牌（与 /entry/register 同等口径）—— 部署者/探针显式自救；
  //   ② **本机/同内网**自救：上报地址必须是**本机网卡自己的 IP**（LAN_IPS），且 TCP 对端来自
  //      私网/回环 —— 即「你报的这个地址就是我，而且你就跟我同一内网」。
  //    → 「任意公网域名 / 任意公网 IP」一律 403（那正是钓鱼入口的写法）；
  //      Issue #11 的「房主同 WiFi 打开、登记的入口在他那侧不通」照旧可用。
  //    → 公网侧的自救被拒后玩家**照旧能就地开玩**（前端已把当前地址落成本地稳定入口），
  //      只是不再让「某一个玩家的网络状况」改写所有人的全局入口（刻意的可用性取舍）。
  //    这条上报只影响**入口**，不改变任何鉴权/权限。
  // 与 main（v3.0.4）的口径合并：准入 = ① 一次性部署令牌（与 /entry/register 同等口径）**或**
  // ② 本机/同内网自救（本 PR 新增，见 shared/entry-match.mjs 的 localTipAllowedFor）。
  // Issue #15 起两条都是**必要条件**；任一条不满足 → 403 + 入口不变 + 不落盘。
  // main 旧注释里的「匿名放行两版判定都被证伪」留痕（下方 ②③ 即那两版）：本 PR 的 ② 之所以不同于
  // 被证伪的版本，是它**同时**要求「上报地址 = 本机网卡 IP」+「对端来自私网/回环」，
  // 且 main 的 refreshOnly 修掉了 `?origin=` 被当登记参数吃走的问题。
  // ── 入口可达性上报（玩家自救，Issue #11）────────────────────────
  // 场景：服务器登记的入口（公网 IP / 域名）连不上，页面实际是通过另一个地址打开的。
  // ⚠ 该路由会**落盘改写全局入口**（影响所有人的分享链接），因此**必须带一次性部署令牌**：
  //    「已有登记入口」在这套实现里恒为真（服务器启动即自动登记），不构成任何保护 —— 见 Issue #15。
  //    普通玩家的自救不依赖这条路由：前端探到登记入口不可达就地开玩，不改写全局入口。
  //    另外这条上报只影响**入口**，不改变任何鉴权/权限。

  if (urlPath === "/entry/localtip") {
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    let rawTip = "";
    try { rawTip = (new URL(req.url || "/", "http://x").searchParams.get("origin") || "").trim(); } catch { rawTip = ""; }
    const info = originScope(rawTip, { allowPrivateIp: true });
    if (!info.ok) return json(400, { ok: false, applied: false, reason: info.reason || "origin 不是可用的 http(s) 地址" });
    const gate = localTipAllowed(req, rawTip);
    if (!gate.ok) {
      // ⚠ 日志里**不回显被拒的地址原文**（那是攻击者可控的字符串，回显等于给它一个写入日志的通道）；
      //   只记「谁在试 + 为什么拒」，足够审计与定位。
      console.warn(`[入口] 拒绝可达性上报（Issue #15）: 对端=${peerIpOf(req) || "?"} ← ${gate.reason}`);
      return json(403, { ok: false, applied: false, current: normalizeOrigin(CURRENT_ORIGIN) || null, reason: gate.reason });
    }
    const tip = info.origin;
    const existing = req.entryBeforeRequest || normalizeOrigin(CURRENT_ORIGIN);
    if (!existing) return json(409, { ok: false, applied: false, reason: "尚无登记入口，不接受可达性上报（避免把请求方自报的地址当入口）" });
    // ⚠ 鉴权（Issue #15）：这条路由会**落盘改写全局入口**，因此必须过准入（见上方 localTipAllowed）：
    //    ① 一次性部署令牌（`?probe_token=` / `X-Tank-Entry-Token`，与 /entry/register 同等口径）；
    //    ② 本机/同内网自救（上报地址 = 本机网卡 IP 且对端来自私网/回环）。
    //    详见 shared/entry-match.mjs 的 localTipAllowedFor（准入单一事实源），判定在路由入口处已完成。
    //
    //    已经是这个入口：带令牌的调用仍要**补一次落盘**（否则本请求里 takeEntryTrustSignal 已应用的值
    //    重启后就丢了）；匿名/本机自救则直接回「一致」，绝不在无变化时落盘 —— 免得把平台预览这种
    //    临时入口写死成「显式登记」（那会在环境重建后被 readRegisteredEntryOrigin 优先读回旧域名）。
    if (tip === existing && !gate.token) return json(200, { ok: true, applied: false, current: existing, reason: "与当前入口一致" });
    const applied = recordEntry(tip, "localtip", { allowPrivateIp: true });
    if (!applied) return json(400, { ok: false, applied: false, current: existing, reason: entryRejectReason(tip) });
    // 修正也要落盘，否则下一次刷新会被旧的落盘值顶回去（玩家会看到"修了又变回来"）
    const persisted = writeRegisteredEntryOrigin(applied);
    console.log(`[入口] 按可达性上报修正: ${existing} → ${applied}（准入：${gate.via}；persisted=${persisted}）`);
    return json(200, { ok: true, applied: true, persisted, previous: existing, current: applied, source: `localtip（客户端可达性修正；${gate.via}）` });
  }

  // 健康检查（供 Docker HEALTHCHECK / 云负载均衡 / 你自己 curl 用）
  // 与 "/" 的区别：这里只证明**服务进程活着**，不关心 dist 是否构建，返回极小的 JSON。
  if (urlPath === "/healthz") {
    // 入口自动匹配的自证信息：服务是否真的在、内部 id、当前入口、匹配到的临时地址数量。
    // ⚠ 只读探针：**不采信请求 Host**（可伪造）建立/迁移入口 —— 见 PR #7 评审 🔴1。
    // 入口只可能来自「环境自身模板 / 落盘登记 / 携带一次性令牌的部署探针」三种可信来源。
    takeEntryTrustSignal(req, "healthz");
    refreshCurrentOriginFromTrusted("healthz");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      service: "tank-online",
      port: PORT,
      tables: tables.size,
      sid: SID,
      uptimeS: Math.round((Date.now() - STARTED_AT) / 1000),
      lastClientSeenS: lastClientSeenAt ? Math.round((Date.now() - lastClientSeenAt) / 1000) : null,
      clients: wss.clients.size,
      current: CURRENT_ORIGIN || null,
      currentSource: CURRENT_SOURCE || null,   // 当前入口是哪来的（register / preview / keep）
      matched: entries.size(),          // 自动匹配表里的稳定入口条数
    }));
    return;
  }
  // 版本标识：好友/你一眼确认「这是游戏服务」而不是某个 IDE 或跳转页
  if (urlPath === "/__whoami") {
    // 带上 sid + 当前入口：页面加载后据此判断「我打开的这个地址是不是服务器自己的入口」——
    // 反代/隧道把用户送到别的地址时，前端能自动纠正到正确入口（玩家不需要懂这些）。
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      game: "坦克大战深度版", kind: "game-server",
      distBuilt: fs.existsSync(path.join(DIST_DIR, "index.html")),
      host: req.headers.host || null,
      sid: SID,
      current: normalizeOrigin(CURRENT_ORIGIN) || null,
      entryPath: entryPath(SID),
    }));
    return;
  }
  // ── 稳定入口自动匹配：/<sid>/join/<roomId> ──────────────────────
  // 玩家手里是这条固定链接；实际域名/IP 变了也无所谓 —— 这里 302 到**当前**可用地址。
  const mJoin = /^\/([0-9a-f]{8})\/join\/(\d*)$/.exec(urlPath);
  if (mJoin) {
    const sid = mJoin[1];
    const roomId = mJoin[2] ? Number(mJoin[2]) : null;
    takeEntryTrustSignal(req, "join");   // 只有可信探针（带令牌）才会刷新当前入口
    if (sid === SID) {
      // 目标只由服务器自己决定：当前入口（可信来源）优先；请求 Host 仅在「就是当前入口」时同源直跳。
      // ⚠ 绝不用请求 Host 兜底 —— 否则可被伪造 Host 把稳定链接 302 到攻击者域名（PR #7 评审 🔴1）。
      const target = trustedTarget();
      // 没有任何可信入口（既没登记、也没平台模板）→ 给可操作提示页，绝不回退到访问者的 127.0.0.1
      if (!target) { sendEntryGone(res, SID, "no-entry", { viewerIsLocal }); return; }
      redirectTo(res, roomId ? `${target}/?room=${roomId}` : `${target}/`);
      return;
    }
    const e = entries.lookup(sid);
    if (e) {
      redirectTo(res, roomId ? `${e.current}/?room=${roomId}` : `${e.current}/`);
      return;
    }
    sendEntryGone(res, sid);
    return;
  }
  // 裸稳定入口：/entry/<sid>（不带房间）等价于 /<sid>/join/
  const mEntry = /^\/entry\/([0-9a-f]{8})$/.exec(urlPath);
  if (mEntry) {
    takeEntryTrustSignal(req, "entry");
    if (mEntry[1] === SID) {
      const target = trustedTarget();
      if (!target) sendEntryGone(res, SID, "no-entry", { viewerIsLocal });
      else redirectTo(res, `${target}/`);
    }
    else {
      const e = entries.lookup(mEntry[1]);
      if (e) redirectTo(res, `${e.current}/`);
      else sendEntryGone(res, mEntry[1]);
    }
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

// ── 公网入口（不再"从进站 Host 学习"）──────────────────────────
// 历史写法：隧道(cpolar/cloudflared)转发时会带原始 Host，服务器从**任何进站请求**学习"当前公网域名"。
// 这条路径已废除（PR #7 评审 🔴1）：Host 由调用方自报，一条 curl 就能把分享链接指到攻击者域名。
// 现在入口只由可信来源确立（带令牌登记 / 平台预览模板 / 保持现状），随 welcome/tables 广播给客户端。
// ── 端口预览地址探测（云原生开发自测用）──────────────────────────
// 平台把端口预览模板注入到开发环境，形如 https://<环境ID>-{{port}}.<业务域名>。
// 把 {{port}} 换成实际端口即得到该端口的公网预览地址（页面与 WS 同源）。
// 注意：这是**临时**入口（环境ID 随环境重建而变、环境回收即失效），只用于自测延迟，
//       不能当长期游戏入口 —— 长期入口见 deploy/README.md（常驻服务器）。
/** 服务器启动时把预览地址落盘（写 .txt + .json），方便 IDE 终端一条 cat 就拿到。 */
function persistPublicUrl(port) {
  return writePublicUrl(port);
}

// 当前对外入口（origin，如 https://xxx-3001.cnb.run）：只由可信来源确立（见 refreshCurrentOriginFromTrusted）
let CURRENT_ORIGIN = "";
let CURRENT_SOURCE = "";       // 入口来源标签（register / preview / keep），/healthz 可见，便于复评核对
/**
 * 公网域名（仅用于邀请链接展示）；**从已确立的可信入口派生**，不再从进站 Host 学习。
 * 返回 host（不含协议），没有可信入口时返回 ""。
 */
function publicHostOfCurrent() {
  const o = normalizeOrigin(CURRENT_ORIGIN);
  if (!isShareableOrigin(o, { allowPrivateIp: true })) return "";
  try { return new URL(o).host; } catch { return ""; }
}
function currentPublicHost() { return publicHostOfCurrent(); }
// v3.0.2 说明：原本还有一个 originOfRequest(req)（用请求 Host + x-forwarded-proto 拼 origin）供
// trustedTarget 做"同源省一跳"判断 —— x-forwarded-proto 由调用方控制，能伪造出 http:// 降级跳转
// （Issue #11 评审 🟢）。现在 302 目标一律是「已确立的可信入口」原文，不再需要它，故删除（死代码清零）。
/**
 * 刷新「当前入口」并自动登记到匹配表（稳定入口 → 当前地址）。
 * ⚠ 只允许**可信来源**调用（见 recalcTrustedEntryOrigin）：入口地址决定了稳定链接的 302 目标，
 *   它一旦被请求方自报的 Host 影响，就等于把好友的链接指向攻击者域名。
 */
function recordEntry(origin, why, opts = {}) {
  const info = originScope(origin, opts);
  if (!info.ok) return "";                              // 回环/非法/残留占位符/未授权私网 IP：不登记（不瞎猜）
  const o = info.origin;
  const prev = normalizeOrigin(CURRENT_ORIGIN);
  CURRENT_ORIGIN = o;
  CURRENT_SOURCE = why;
  entries.bind(SID, o, null);
  if (prev !== o) console.log(`[匹配] 当前入口已变化: ${prev || "(空)"} → ${o}（来源：${why}；旧链接仍可用，打开会自动跳到新地址）`);
  return o;
}

/** 登记被拒的原因（回给部署脚本，避免"静默无效"） */
function entryRejectReason(origin) {
  return originScope(origin, { allowPrivateIp: true }).reason || "地址不可用作对外入口";
}

/**
 * 请求的 TCP 对端 IP（去掉 IPv4-mapped IPv6 前缀 `::ffff:` —— Node 双栈监听下 IPv4 连接会带它，
 * 不剥掉的话 ipScope 会把私网对端误判成 public）。用于 Issue #15 的「同内网自救」准入判定。
 */
function peerIpOf(req) {
  const raw = String((req && req.socket && req.socket.remoteAddress) || "").trim().toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  return (m ? m[1] : raw).replace(/^\[|\]$/g, "");
}

/**
 * `/entry/localtip` 的准入判定（Issue #15 🔴：匿名请求绝不能改写全局入口）。
 * 判定逻辑放在 shared/entry-match.mjs（`localTipAllowedFor`）—— 与自测同一份实现，避免两处漂移。
 * 这里只补上服务器侧才有的信息：本机网卡 IP 列表（LAN_IPS）与请求 TCP 对端 IP。
 * @returns {{ok:true, via:string, token:boolean} | {ok:false, reason:string}} token=true 表示走的是部署令牌
 */
function localTipAllowed(req, tip) {
  if (hasValidEntryToken(req)) return { ok: true, via: "probe_token（部署者显式自救）", token: true };
  const r = localTipAllowedFor({ tip, peerIp: peerIpOf(req), ownIps: LAN_IPS });
  return r.ok ? { ...r, token: false } : r;
}

/**
 * 重新计算「当前入口」——**只看可信来源**，不看请求 Host（优先级由高到低）：
 *   ① 显式登记（部署脚本 / net:tunnel 写入 `<token>.url`，需令牌或容器内写权限）——
 *      部署者说了算：不会被平台模板的下一轮刷新顶回（Issue #11 评审 🟡1）；
 *   ② 平台注入的端口预览地址（经 detectPreviewUrl → buildPreviewUrl 同口径校验，残留占位符作废）；
 *   ③ 上一次已被可信来源确立的当前入口（保持在服务的那个地址，不被匿名请求改写）。
 * /healthz 这类只读探针也走这里：没有可信来源时，current 保持为空 —— 宁可暂时没有入口，也不给坏地址
 * （此时稳定链接给 sendEntryGone 提示页，而不是把好友 302 到 127.0.0.1）。
 */
function refreshCurrentOriginFromTrusted(why) {
  // 优先级：① 显式登记（部署者说了算，不被下一次刷新顶回）→ ② 平台预览模板 → ③ 保持现有入口
  const explicit = readRegisteredEntryOrigin();
  if (explicit) { recordEntry(explicit, "register", { allowPrivateIp: true }); return; }
  const preview = detectPreviewUrl(PORT);              // 已做「无残留占位符」校验的单一事实源
  if (preview) { recordEntry(preview, `${why}:preview`); return; }
  if (CURRENT_ORIGIN) { recordEntry(CURRENT_ORIGIN, `${why}:keep`); return; }
  // ④ 谁都没有（没有模板、也没人登记）→ 由服务器自己把本机对外入口找出来（玩家不必手动跑 curl）
  autoRegisterTrigger(`${why}:auto`);
}

// 自动登记是异步的（要探测公网 IP），但「当前入口」的读取必须是同步的 —— 两者解耦：
// 先按上面的同步优先级给出结论（可能暂时是"没有入口"），探测完再刷新一次，入口随即出现。
const autoRegisterState = { running: false, done: false, hasRun: false };
function autoRegisterTrigger(why) {
  if (autoRegisterState.running || autoRegisterState.done) return;
  if (process.env.TANK_AUTO_ENTRY === "0") return;
  autoRegisterState.running = true;
  autoRegisterLocalEntry()
    .catch(() => { /* 探测失败就当没有：宁缺勿错 */ })
    .finally(() => {
      autoRegisterState.running = false;
      autoRegisterState.done = true;
      if (!normalizeOrigin(CURRENT_ORIGIN)) { entries.sweep(); return; }
      console.log(`[入口] ${why} → 当前入口就绪: ${CURRENT_ORIGIN}`);
    });
}

/**
 * 落盘登记的对外入口（部署脚本 / net:tunnel 写 `<token file>.url`，服务器读）。
 * 存在 = 部署者**显式指定**了入口 → 优先级最高（不会被平台模板的下一轮刷新顶回，见 Issue #11 评审 🟡1）。
 */
function readRegisteredEntryOrigin() {
  try {
    const raw = fs.readFileSync(ENTRY_PROBE_TOKEN_FILE + ".url", "utf8").trim();
    if (!raw || hasTemplatePlaceholder(raw)) return "";
    const info = originScope(raw, { allowPrivateIp: true });
    return info.ok ? info.origin : "";
  } catch { return ""; }
}

/** 把显式登记的入口落盘（服务器重启/刷新都从这份读）；返回是否写成功 */
function writeRegisteredEntryOrigin(origin) {
  try {
    fs.mkdirSync(path.dirname(ENTRY_PROBE_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(ENTRY_PROBE_TOKEN_FILE + ".url", origin + "\n", { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn(`[入口登记] 落盘失败: ${e && e.message}`);
    return false;
  }
}

/**
 * 处理进站请求的「入口可信信号」。**只有**携带一次性部署令牌的探针才会刷新/迁移当前入口：
 *   GET /healthz?probe_token=<token>      或  请求头 X-Tank-Entry-Token: <token>
 *   GET /entry/register?url=https://...&probe_token=<token>
 * 令牌在服务器启动时随机生成，写入 /tmp（0600）并打印到日志 —— 部署脚本 / net:tunnel 可读，
 * 普通玩家或外部攻击者拿不到（Host 头伪造因此彻底失效）。
 * @returns {boolean} 是否携带了有效令牌
 */
function takeEntryTrustSignal(req, why, opts = {}) {
  if (!hasValidEntryToken(req)) return false;
  // refreshOnly：只按可信来源刷新「当前入口」，**不把请求参数当登记地址**。
  // 为什么需要这个开关：`?origin=` 既是历史登记别名，又是可达性上报（/entry/localtip）的入参名 ——
  // 带令牌的 /entry/localtip?origin=X 会先在这里被当成「显式登记」，于是该请求在自己那条路由里
  // 被静默改道（响应说"已修正"，其实 current 已被这次调用改成了别的值）。见 Issue #15 根因。
  if (opts.refreshOnly) { refreshCurrentOriginFromTrusted(`${why}:probe`); return true; }
  const registered = registeredUrlOf(req);            // 部署探针可显式登记「本环境对外的公网入口」
  if (registered) recordEntry(registered, `${why}:register`, { allowPrivateIp: true });
  else refreshCurrentOriginFromTrusted(`${why}:probe`);
  return true;
}

/** 请求是否携带正确的部署令牌（时间恒定比较，避免时序侧信道） */
function hasValidEntryToken(req) {
  const token = probeTokenOf(req);
  if (!token || token.length !== ENTRY_PROBE_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ENTRY_PROBE_TOKEN));
}

function probeTokenOf(req) {
  const h = (req && req.headers && (req.headers["x-tank-entry-token"] || req.headers["x-tank-probe-token"])) || "";
  if (h) return String(h).trim();
  try {
    const q = new URL(req.url || "/", "http://x").searchParams;
    return (q.get("probe_token") || q.get("token") || "").trim();
  } catch { return ""; }
}

/** 取登记参数里的原始 url（不判合法性：不合法要能回一句为什么，而不是静默 null） */
function registeredUrlRaw(req) {
  try {
    const q = new URL(req.url || "/", "http://x").searchParams;
    // ⚠ 只认 `url` 参数：曾经同时认 `origin`，而 `origin` 正是可达性上报（/entry/localtip）的入参名 ——
    //    带令牌的 /entry/localtip?origin=X 会先被 takeEntryTrustSignal 当作「显式登记」处理，
    //    于是令牌请求在**它自己那条路由**里被静默改道（响应说"与当前入口一致/已修正"，实际 current 是原值）。
    //    Issue #15 顺手修掉这条参数别名（并删掉随之失效的 `?origin=` 登记姿势）。
    return (q.get("url") || "").trim();
  } catch { return ""; }
}
function registeredUrlOf(req) {
  const raw = registeredUrlRaw(req);
  const info = originScope(raw, { allowPrivateIp: true });
  return info.ok ? info.origin : "";
}

/**
 * 记「有活人连着」：真实 WS 连接 / ping 心跳才能证明服务真在被使用（/healthz 的 lastClientSeenS）。
 * 注意：连接带来的 Host **不**参与确立/迁移「当前入口」—— WS 的 Host 同样由客户端自报，可被伪造
 * （伪造 Host 曾能把分享链接 302 到攻击者域名，见 PR #7 评审 🔴1）。
 */
function confirmOriginFromClient() {
  lastClientSeenAt = Date.now();
}
/**
 * 是否为「可分享的对外入口」。
 * v3.0.2（Issue #11 评审 🔴2）：**公网 IP 与（可信来源显式登记的）局域网 IP 都算数** ——
 * 「没有域名」的部署形态（deploy/Dockerfile + start-server.sh 主推形态）必须能拿到入口，
 * 否则稳定链接只能落到 127.0.0.1 兜底，等于把好友送到他自己的机器上。
 * 回环（127./::1/localhost）与未授权私网地址仍然拒收。
 */
function isShareableOrigin(origin, opts = {}) {
  return originScope(origin, opts).ok;
}

/** 可信来源兜底地址（登记表里的最新一条 / 已确立入口的 host / 平台预览地址），都不是回环 */
function fallbackEntryOrigin() {
  const cands = [normalizeOrigin(CURRENT_ORIGIN)];
  const h = publicHostOfCurrent();
  if (h) cands.push(`https://${h}`);
  for (const e of entries.list()) cands.push(normalizeOrigin(e.current));
  cands.push(normalizeOrigin(detectPreviewUrl(PORT)));
  return cands.find((c) => c && isShareableOrigin(c, { allowPrivateIp: true })) || "";
}

/**
 * 稳定链接该跳到哪儿：**只由服务器自己决定**，绝不用访问者自报的 Host 兜底。
 *   ① 已确立的当前入口（可信来源）→ 用它；访问者**就在这个入口上**（Host 与入口一致）时直跳，省一跳；
 *   ② 否则退回登记表/已确立入口（同样来自可信来源）；
 *   ③ 实在没有 → 返回 ""（调用方给 sendEntryGone 提示页）。
 *      ⚠ v3.0.2：不再回退 `http://127.0.0.1:PORT` —— 那会把好友 302 到**他自己**机器的回环地址
 *        （甚至可能是他自己跑的服务），比"暂时没有入口"更糟（Issue #11 评审 🔴2）。
 */
function trustedTarget() {
  // 目标 = 「已确立的可信入口」原文（不掺入访问者的任何自报信息）。
  // 同源访问时访问者用的就是这条地址本身，302 回它等价于"原地不动"，因此不需要另算"省一跳"的地址 ——
  // 旧写法用请求 Host + x-forwarded-proto 拼同源地址，可被伪造出 http:// 降级跳转（Issue #11 评审 🟢）。
  const cur = normalizeOrigin(CURRENT_ORIGIN);
  if (cur && isShareableOrigin(cur, { allowPrivateIp: true })) return cur;
  return fallbackEntryOrigin();
}

function redirectTo(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
  res.end(`正在自动匹配到当前地址…\n${location}\n`);
}

/**
 * 稳定入口打不开时的**可操作提示页**（而不是干巴巴 404，也不是把好友 302 到他自己机器）：
 *   reason = "gone"     → 链接里的 sid 已不再服务（环境被回收 / 服务器已重启）
 *   reason = "no-entry" → 这台服务器还活着，但**没有确立对外入口**（既没平台模板，也没人带令牌登记）
 */
function sendEntryGone(res, sid, reason = "gone", opts = {}) {
  const safeSid = String(sid).replace(/[^0-9a-f]/gi, "");
  // 访问者就在本机（或同一内网）时，「入口还没配好」不该变成拦路虎：
  //   把「直接开玩」的按钮放到最上面并自动跳一次 —— 玩家就是来打游戏的，不是来配入口的。
  const selfServe = opts.viewerIsLocal
    ? `<h2 style="color:#8fff8f">服务器就在你身边 —— 直接开玩</h2>
<p>你打开的这个地址就是本机服务，正在自动进入游戏（大厅 / 房间都可用）：</p>
<p><a style="color:#4af;font-size:18px" href="/">▶ 点这里直接开始游戏</a></p>
<p style="color:#888">（给远程好友的链接会在入口登记完成后自动可玩，无需你手动配置）</p>
<hr style="border-color:#333">`
    : "";
  const body = reason === "no-entry"
    ? `${selfServe}<h2 style="color:#ffd700">这台服务器还没有对外入口</h2>
<p>服务器本身是在跑的，但它没有「公网地址」可跳 —— 所以这条链接暂时打不开（这比给你一个错地址要安全）。</p>
<p>让部署的人补一条**带令牌的登记**即可（IP 或域名二选一，登记后本页就会自动跳过去）：</p>
<pre style="color:#4af">curl -H "X-Tank-Entry-Token: $(cat ${ENTRY_PROBE_TOKEN_FILE})" \
     "http://127.0.0.1:${PORT}/entry/register?url=http://&lt;你的公网IP或域名&gt;:${PORT}"</pre>
<p style="color:#888">部署脚本 deploy/start-server.sh 已内置这一步；手动跑的话上面的命令就是它做的全部事情。</p>`
    : `<h2 style="color:#ffd700">这条链接暂时匹配不到服务器</h2>
<p>链接里的服务器内部 id <b>${safeSid}</b> 已不再服务（环境被回收或服务器已重启）。</p>
<p>请让房主重新分享一条链接 —— 新链接会自动匹配到新的临时地址，无需手动改 IP/域名。</p>
<p style="color:#888">（本机仍在线的话：<a style="color:#4af" href="/">打开当前服务器</a>）</p>`;
  const autoGo = opts.viewerIsLocal ? `<script>setTimeout(function(){location.replace("/");},1200);</script>` : "";
  sendHtml(res, 200, `<!DOCTYPE html><html lang="zh"><meta charset="utf-8">
<title>坦克大战 · 入口暂时不可用</title><body style="background:#0a0a0a;color:#ddd;font-family:monospace;padding:32px;line-height:1.9">
${body}
${autoGo}
</body></html>`);
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
  // 携带可信来源确立的当前入口，客户端实时刷新邀请链接
  const msg = JSON.stringify({ t: "tables", tables: list, publicHost: currentPublicHost() || undefined, publicOrigin: normalizeOrigin(CURRENT_ORIGIN) || undefined });
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
  // 有客户端连进来 = 这个地址确实可用；但 WS 的 Host 同样是客户端自报（可伪造），
  // 所以只记「有活人」不清、不据此改写当前入口（迁移只走可信来源，见 takeEntryTrustSignal）。
  confirmOriginFromClient();
  const conn = { id: nextClient++, name: "玩家", tableId: null, idx: -1 };
  ws.conn = conn;
  lastClientSeenAt = Date.now();
  // serverInfo：告知客户端本机的真实局域网地址 + 可信来源确立的当前入口
  sendRaw(ws, { t: "welcome", clientId: conn.id, serverInfo: SERVER_INFO, publicHost: currentPublicHost() || undefined, publicOrigin: normalizeOrigin(CURRENT_ORIGIN) || undefined, sid: SID, url: normalizeOrigin(CURRENT_ORIGIN) || undefined, entryPath: entryPath(SID) });
  broadcastTables(null);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    lastClientSeenAt = Date.now();   // 客户端活着（联机自检 /healthz 用它证明"服务真在用"）
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
    if (conn.tableId !== null) return sendRaw(ws, { t: "error", code: ERR_ALREADY_IN_TABLE, msg: "你已在桌内" });
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
    if (conn.tableId !== null) return sendRaw(ws, { t: "error", code: ERR_ALREADY_IN_TABLE, msg: "你已在桌内" });
    const table = tables.get(Number(msg.tableId));
    if (!table) return sendRaw(ws, { t: "error", code: ERR_ROOM_NOT_FOUND, msg: "房间不存在" });
    if (table.state === "playing") return sendRaw(ws, { t: "error", code: ERR_ROOM_PLAYING, msg: "该房间对局中" });
    const idx = table.seats.findIndex((s) => s === null);
    if (idx < 0) return sendRaw(ws, { t: "error", code: ERR_ROOM_FULL, msg: "房间已满" });
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
    if (conn.id !== table.hostId) return sendRaw(ws, { t: "error", code: ERR_HOST_ONLY, msg: "仅房主可更改房间方向" });
    table.orient = msg.orient === "portrait" ? "portrait" : "landscape";
    broadcastTable(table);
    broadcastTables(null);
    return;
  }

  if (t === "start") {
    const table = tableOf(conn);
    if (!table || conn.id !== table.hostId) return sendRaw(ws, { t: "error", code: ERR_HOST_ONLY, msg: "仅房主可开始" });
    if (table.state !== "lobby") return;
    // v2.5：房主无需准备；其余入座玩家全部准备后才能开始
    const seated = table.seats.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    if (seated.length < 1) return sendRaw(ws, { t: "error", code: ERR_START_PRECONDITION, msg: "需要至少 1 人才能开始" });
    const guestsReady = seated.every((i) => table.seats[i].clientId === table.hostId || table.seats[i].ready);
    if (!guestsReady) return sendRaw(ws, { t: "error", code: ERR_START_PRECONDITION, msg: "还有玩家未准备（等待所有人点击准备）" });
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
    if (!table || table.state !== "playing") return sendRaw(ws, { t: "error", code: ERR_NO_REJOIN, msg: "房间已结束或无进行中对局" });
    const token = String(msg.token || "");
    const seatIdx = table.seats.findIndex((s) => s && s.rejoinToken === token);
    if (seatIdx < 0) return sendRaw(ws, { t: "error", code: ERR_NO_REJOIN, msg: "重连令牌无效或已失效" });
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
    // RTT 探测：原样回包（ts 为客户端发起的原时间戳）。
    // 顺带回带「当前入口 + 服务器内部 id」：客户端据此**自动匹配**到最新地址并刷新手里的稳定链接，
    // 无需知道环境重建后的新域名（这就是"变化的部分自动挂载到稳定之上"）。
    lastClientSeenAt = Date.now();
    // 心跳只证明「有活人」；不据此迁移当前入口（Host 可伪造，迁移只走可信来源）
    confirmOriginFromClient();
    sendRaw(ws, { t: "pong", ts: Number(msg.ts) || Date.now(), sid: SID, url: normalizeOrigin(CURRENT_ORIGIN) || undefined });
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

// ── 匹配表维护 + 环境保活 ───────────────────────────────────────
// ① 定时刷新「当前入口」：环境一直有服务时，稳定入口→临时地址的绑定不会过期（TTL 5 分钟）；
// ② 定时清理陈旧绑定：隧道/环境换掉后，旧临时地址最多再挂 5 分钟就被摘掉；
//    固定链接打开时若匹配到的地址已不可用，会**在同一次跳转里自动匹配到最新地址**（见下方跳转 302）。
// ③ KEEPALIVE 是可选的外层保活（云原生环境离线 10 分钟会被回收）：
//    设 TANK_KEEPALIVE=1 后，服务器每 60s 对自己公网入口发一次 /healthz，让环境一直有心跳。
setInterval(() => {
  refreshCurrentOriginFromTrusted("server");
  entries.sweep();
}, ENTRY_SWEEP_MS).unref?.();

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

/** Startup entry resolution: no template / no registration -> run auto-register once. */
async function autoRegisterStartup() {
  if (process.env.TANK_AUTO_ENTRY === "0") return;
  if (readRegisteredEntryOrigin() || normalizeOrigin(CURRENT_ORIGIN) || detectPreviewUrl(PORT)) return;
  if (autoRegisterState.running || autoRegisterState.hasRun) return;
  autoRegisterState.hasRun = true;            // 只跑一次：启动 / 定时刷新 / 首个请求谁先到就谁跑
  autoRegisterState.running = true;
  try { await autoRegisterLocalEntry(); } finally {
    autoRegisterState.running = false;
    autoRegisterState.done = true;
  }
}

httpServer.listen(PORT, HOST, async () => {
  const nets = os.networkInterfaces();
  const lanIps = [];
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) lanIps.push(ni.address);
    }
  }
  persistPublicUrl(PORT);
  console.log(`[坦克大战联机] 服务器已启动（页面 + WebSocket 同端口）`);
  console.log(`  本机游玩:   http://localhost:${PORT}`);
  for (const ip of lanIps) console.log(`  局域网分享: http://${ip}:${PORT}`);
  console.log(`  监听地址:   ${HOST}:${PORT}`);
  // 云原生开发（CNB）会注入端口预览模板 https://<环境ID>-{{port}}.cnb.run，
  // 直接把 {{port}} 替换成端口就是公网分享地址（页面与 WS 同源，一个链接即可联机）。
  const pub = detectPreviewUrl(PORT);
  if (pub) {
    console.log(`  公网预览:   ${pub}   ← 云原生开发临时入口（环境回收即失效，仅供自测）`);
    console.log(`  延迟自测:   npm run net:latency -- ${pub}`);
    console.log(`  地址已写入: ${PUBLIC_URL_FILE}   （IDE 终端里 cat 一下即可复制）`);
  } else {
    console.log(`  公网预览:   未检测到（当前不在云原生开发环境 / 未注入 CNB_VSCODE_PROXY_URI）`);
    console.log(`  自测入口:   WebIDE 的 PORTS 面板映射 ${PORT}，面板给出的地址即为预览地址`);
  }
  // 稳定入口：链接形状不变，域名/IP 变了由 302 自动匹配 —— 玩家永远只需要手里这一条链接
  refreshCurrentOriginFromTrusted("server");
  // 启动阶段同步把入口确立下来：没有模板、也没人登记时，服务器自己查本机公网/局域网地址并登记，
  // 于是「打开页面就能玩」在第一个请求之前就成立 —— 不再要求玩家先跑一条 curl（Issue #11）。
  await autoRegisterStartup();
  console.log(`  ── 稳定入口（分享给好友的链接形状，换域名/换 IP 都不用改）──`);
  console.log(`  服务器内部 id: ${SID}（同一进程内恒定；环境重建/重启后自动换新并自动匹配）`);
  console.log(`  稳定链接:      <当前入口>${entryPath(SID)}        ← 例如 ${CURRENT_ORIGIN || "http://<你的地址>"}${entryPath(SID)}`);
  console.log(`  入口登记令牌:  已写入 ${ENTRY_PROBE_TOKEN_FILE}（0600）；部署/隧道脚本可显式登记对外入口：`);
  console.log(`                 curl -H "X-Tank-Entry-Token: $(cat ${ENTRY_PROBE_TOKEN_FILE})" \\`);
  console.log(`                      "http://127.0.0.1:${PORT}/entry/register?url=http://203.0.113.9:${PORT}"`);
  console.log(`                 ↑ 公网 IP 或域名都行（无域名部署形态照样能分享）；登记结果落盘，重启后仍生效`);
  console.log(`  （只有带令牌的探针能改写「当前入口」—— 伪造 Host 无法把分享链接指向别处）`);
  if (!CURRENT_ORIGIN) {
    console.log(`  ⚠ 当前还没有对外入口：稳定链接会给出可操作提示页（不会把好友送到 127.0.0.1）。`);
    console.log(`    无域名部署请跑上面那条 curl 登记；deploy/start-server.sh 已内置这一步。`);
  }
  console.log(`  自动匹配:      打开稳定链接 → 302 到"当前实际可用地址"；匹配表 ${entries.size()} 条，${ENTRY_TTL_MS / 60000} 分钟没被刷新碰过的条目会被清掉`);
  console.log(`  自检:          GET ${CURRENT_ORIGIN || `http://127.0.0.1:${PORT}`}/healthz （ok/clients/sid/current/currentSource/matched）`);
  console.log(`  外网分享:   用路由器端口转发 / ngrok / frp / Cloudflare Tunnel 暴露 ${PORT} 端口后，把公网地址发给好友`);
  console.log(`  提示: 若提示没有游戏页面，请先在项目目录执行 npm run build`);
});

// ── 可选：外层保活（云原生开发环境离线约 10 分钟会被回收）────────────────
// TANK_KEEPALIVE=1 时，每 60s 对自己当前入口发一次 /healthz，保持环境不被判定离线。
if (process.env.TANK_KEEPALIVE === "1") {
  setInterval(() => {
    const base = CURRENT_ORIGIN;
    if (!base) return;
    fetch(base + "/healthz").then((r) => r.text()).then((t) => {
      try { const j = JSON.parse(t); console.log(`[保活] ${ENTRY_KEEPALIVE_MS / 1000}s 心跳 OK（clients=${j.clients}, uptime=${j.uptimeS}s）`); } catch {}
    }).catch((e) => console.warn("[保活] 心跳失败（环境可能已被回收）: " + e.message));
  }, ENTRY_KEEPALIVE_MS).unref?.();
  console.log("[保活] 已开启：每 60s 汇报一次，避免云原生环境被回收");
}
