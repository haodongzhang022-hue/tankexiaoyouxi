// main.ts
import { GameLoop } from "./engine/GameLoop";
import { Renderer } from "./engine/Renderer";
import { InputManager, type PlayerInput } from "./engine/InputManager";
import { getSoundManager } from "./engine/SoundManager";
import { GamepadAdapter } from "./input/GamepadAdapter";
import { MobileControls } from "./engine/MobileControls";
import { EndlessMode } from "./modes/EndlessMode";
import { StageMode } from "./modes/StageMode";
import { DpsTestMode } from "./modes/DpsTestMode";
import { OnlineHostMode } from "./modes/OnlineHostMode";
import { NetClient } from "./net/NetClient";
import { RtcPeer, ICE_SERVERS } from "./net/RtcPeer";
import type { ServerCandidate } from "./net/NetClient";
// ── net-sync-core 通用资产：成员端解码/延迟/重连全部由模块驱动 ──
import { SyncCodec, LatencyTracker, ReconnectManager, StableEntryManager, entryPathOf, parseStableEntry } from "../net-sync-core/core";
import { TANK_SYNC_SCHEMA, stateToNetSnapshot } from "../net-sync-core/adapters/tank-adapter";
import type { NetTable, MigratedMsg, CheckpointPlayer } from "./net/NetTypes";
import { RemoteView } from "./ui/RemoteView";
import { assetPack } from "./assets/AssetPack";
import { TILE_SIZE } from "./game/Tilemap";
import {
  loadSettings, saveSettings, SETTINGS_ROWS, renderSettings,
  MODE_LABELS, ORIENT_LABELS, type GameSettings,
} from "./ui/SettingsMenu";
import type { GameLayout } from "./types/GameLayout";
import { levelUpKeysFor } from "./systems/levelup/LevelUpSystem";
import {
  drawMenuBackground, drawGameTitle, drawMenuOption,
  drawPauseOverlay as drawPauseOverlayThemed, drawHintBar, drawThemedTitle,
} from "./ui/MenuVisual";

// --- Layout definitions ---
// 画布 = 场地(左上角) + 信息栏(右侧/底部)，信息栏不遮挡场地
export const LAYOUTS: Record<string, GameLayout> = {
  landscape: { canvasW: 968, canvasH: 640, mapCols: 25, mapRows: 20, infoW: 168, infoH: 0 },
  portrait:  { canvasW: 480, canvasH: 920, mapCols: 15, mapRows: 25, infoW: 0, infoH: 120 },
};

// Detect mobile
function isMobile(): boolean {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
         (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
}

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;

// Current layout (default landscape)
let currentLayout: GameLayout = LAYOUTS.landscape;

// 画面缩放系数（v2.6.3 允许随时调整画面大小：放大可能裁切边缘、缩小留黑边）
let zoomScale = 1;

function fitCanvas(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { canvasW, canvasH } = currentLayout;
  const scale = Math.min(vw / canvasW, vh / canvasH) * zoomScale;
  canvas.style.width  = `${Math.floor(canvasW * scale)}px`;
  canvas.style.height = `${Math.floor(canvasH * scale)}px`;
}

/** 调整画面缩放：+ 放大 / − 缩小（0.5x ~ 2.5x，比例步进） */
function adjustZoom(dir: 1 | -1): void {
  zoomScale = Math.max(0.5, Math.min(2.5, zoomScale * (dir > 0 ? 1.1 : 1 / 1.1)));
  fitCanvas();
}

function applyLayout(layout: GameLayout): void {
  currentLayout = layout;
  renderer.resize(layout.canvasW, layout.canvasH);
  fitCanvas();
}

const renderer = new Renderer(canvas);
// Initial apply（按设备方向，layoutByAspect 见下方声明处）
applyLayout(layoutByAspect());
window.addEventListener("resize", () => { fitCanvas(); });
window.addEventListener("orientationchange", () => setTimeout(fitCanvas, 250));
document.addEventListener("fullscreenchange", () => setTimeout(fitCanvas, 120));

const input = InputManager.getInstance();
input.init();

// ── 设置（localStorage 持久化）──
const settings: GameSettings = loadSettings();
input.setMode(settings.mode);
getSoundManager().setVolume(settings.volume / 100);
const gamepadAdapter = new GamepadAdapter(input);
// 手机/触屏虚拟控制：联机观战端(online_client)专用实例
const mobileControls = new MobileControls(canvas);

type GameState = "menu" | "playing_endless" | "playing_stage" | "playing_test" | "gameover" | "settings"
  | "online" | "online_host" | "online_client";
let state: GameState = "menu";
let paused = false;
let endless: EndlessMode | null = null;
let stage: StageMode | null = null;
let test: DpsTestMode | null = null;
let host: OnlineHostMode | null = null;
let remoteView: RemoteView | null = null;
let menuSel = 0;          // 0=endless, 1=stage, 2=打靶, 3=联机, 4=settings（v2.15 移除人机队友选项，改到房间内增减）
let menuOrient = 0;       // 0=landscape, 1=portrait
const mobile = isMobile();

// ── 设备自适应：手机默认触屏操控；按宽高比定横竖屏（用户手动改过则尊重）──
if (!localStorage.getItem("tank_mode_manual")) {
  settings.mode = mobile ? "mobile" : "keyboard";
}
input.setMode(settings.mode);
menuOrient = layoutByAspect() === LAYOUTS.portrait ? 1 : 0;
settings.orient = menuOrient;

let orientTouched = false;   // 用户是否手动切换过方向
function pickLayout(): GameLayout {
  return orientTouched ? (menuOrient === 1 ? LAYOUTS.portrait : LAYOUTS.landscape) : layoutByAspect();
}

/** 按当前窗口宽高比选择布局 */
function layoutByAspect(): GameLayout {
  return window.innerHeight > window.innerWidth ? LAYOUTS.portrait : LAYOUTS.landscape;
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); }
    else {
      await document.documentElement.requestFullscreen();
      const o = window.innerHeight > window.innerWidth ? "portrait" : "landscape";
      try { await (screen.orientation as any)?.lock?.(o); } catch {}
    }
  } catch {}
}
// v2.6.3 游戏内画面控制桥（顶栏 −/⛶/+ 按钮调用；逻辑集中在 main.ts，单一事实来源）
(window as any).__tankView = {
  fullscreen: () => { void toggleFullscreen(); },
  zoomIn: () => adjustZoom(1),
  zoomOut: () => adjustZoom(-1),
};
let settingsSel = 0;          // 设置菜单选中的行
let settingsFromPause = false; // 是否从暂停进入设置（返回时回到游戏）

// ── 联机大厅状态 ──
const net = new NetClient();
// ── v2.11 重连卡（断线/刷新后凭 tableId+token 回到原座位继续对局）── 由 net-sync-core ReconnectManager 驱动
const rejoinMgr = new ReconnectManager({
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
}, "tank_rejoin_v1");
// ── v3.0 稳定入口（本 Issue 的核心机制）────────────────────────────
// 问题：临时地址会变（云原生环境重建换域名、隧道重开换域名、服务器换 IP），但玩家手里的链接是固定的。
// 做法：服务器有内部 id（sid），链接形状 = <当前域名>/<sid>/join/<roomId>；
//       服务器每次 welcome/pong 都会汇报「sid + 当前入口地址」，客户端据此：
//         ① 自动匹配到最新地址（每次连接/重连都把稳定链接作为第一候选，服务器 302 到当前地址）；
//         ② 刷新本地稳定链接（域名换了不用手动改，玩家复制出来的就是新域名 + 同一个 sid）。
// 于是「变化的部分自动挂载到稳定之上」：只要服务器没重启，链接一直能用；
//       中途断线/刷新也是走同一条链接（也许已经被 302 到新域名）自动回到同一批人同一房间。
const entryMgr = new StableEntryManager({
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* 忽略 */ } },
}, "tank_stable_entry_v1");
/** 当前稳定链接的站内路径（/<sid>/join/<roomId>）；没有 sid 时返回 null（退回普通寻址） */
function stableEntryPath(roomId: number | null): string | null {
  const sid = entryMgr.peek()?.sid ?? net.sid;
  if (!sid) return null;
  return entryPathOf(sid, roomId);
}
/**
 * 稳定链接候选：优先同源（当前域名已被 302 到正确环境），其次服务器汇报的当前入口地址。
 * ⚠ 之前这里用 `shared === entryUrl` 比「ws://…」与「https://…」，恒不成立（死分支）；
 *   现在只比 host（协议归一后再比），语义清楚：手里的域名与服务器入口不同才多跳一次。
 */
function stableEntryCandidates(): string | null {
  const room = onlineCurrent?.id ?? autoJoinRoom ?? null;
  const path = stableEntryPath(room ?? null);
  if (!path) return null;
  const wsUrl = (origin: string) => `${origin.replace(/^http/i, "ws").replace(/\/+$/, "")}${path}`;
  const sameOrigin = `${wsProto()}://${location.host}${path}`;
  const entryUrl = net.entryUrl;
  const here = `${wsProto()}://${location.host}`;
  if (entryUrl && entryUrl.replace(/^http/i, "ws").replace(/\/+$/, "") !== here) return wsUrl(entryUrl);
  return sameOrigin;
}
/** 服务器汇报新 sid/入口 → 自动滚动更新本地稳定链接（同一进程内 sid 不变，无需重新分享） */
function onEntryReport(sid: string, url: string | null): void {
  if (!sid) return;
  const prev = entryMgr.peek();
  const same = prev && prev.sid === sid;
  if (!same) {
    entryMgr.adopt(sid, url ?? undefined, onlineCurrent?.id ?? autoJoinRoom ?? null);
    console.log(`[稳定入口] 已自动匹配服务器内部 id ${sid}${prev ? `（原 ${prev.sid}，环境已重建 → 请重新分享链接）` : ""}`);
    if (prev) notifyOnline("服务器已重建，链接已自动更新，请重新分享给好友");
  } else if (url) {
    entryMgr.adopt(sid, url, onlineCurrent?.id ?? autoJoinRoom ?? null);
  }
  if (serverPublicOrigin && prev?.sid === sid) keepStableEntryForOrigin(serverPublicOrigin);
}
/**
 * 服务器入口变化 → 稳定链接自动挂到新入口上。
 * v3.0.2：接受**完整 origin**（http://203.0.113.9:3001 / https://game.example.com），
 * 不再硬拼 `https://` —— IP 形态部署（无域名）也要能分享出可用链接（Issue #11 评审 🔴2）。
 */
function keepStableEntryForOrigin(origin: string | null): void {
  const card = entryMgr.peek();
  if (!card || !origin) return;
  const clean = origin.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) return;
  entryMgr.save({ ...card, url: `${clean}${entryPathOf(card.sid, card.roomId ?? null)}` });
}
function saveRejoinCard(tableId: number, token: string): void { rejoinMgr.save({ tableId, token }); }
function peekRejoinCard(): { tableId: number; token: string } | null { return rejoinMgr.peek(); }
function clearRejoinCard(): void { rejoinMgr.clear(); }
/** v2.12 主机检查点：成员保存最新一份（房主断线时凭它+本地快照接替续局） */
let lastCheckpoint: CheckpointPlayer[] | null = null;
/** v2.10 WebRTC P2P：双人同桌时尝试建立快照直连（失败自动回落 WS 兜底） */
function tryStartP2P(start: { myIndex: number; players: Array<{ clientId: number; name: string }> }): RtcPeer | null {
  try {
    if (start.players.length < 2) return null;
    // 自检句柄：确认当前构建到底带没带 STUN（VITE_ICE_SERVERS 是构建期变量，配了才有）
    (window as any).__iceServers = ICE_SERVERS;
    if (ICE_SERVERS.length) console.log("[p2p] ICE 服务器: " + ICE_SERVERS.map((s) => s.urls).join(", "));
    const other = start.players.find((p) => p.clientId !== net.myClientId);
    if (!other) return null;
    const p = new RtcPeer((to, payload) => net.rtcSignal(to, payload), other.clientId, start.myIndex === 0 ? "host" : "member");
    (window as any).__rtc = p;
    net.on("rtc_signal", (m) => { void p.onSignal(Number(m.from), m.payload as { kind: string; sdp?: unknown; candidate?: unknown }); });
    p.onStateChange = (s) => { if (remoteView) remoteView.netHud.p2p = s === "connected"; };
    if (start.myIndex !== 0) {
      // 成员端：P2P 帧先到先渲染（WS 兜底副本按 frame 去重被丢弃）
      p.onRemoteData = (d) => {
        const x = d as { snap?: unknown };
        if (x?.snap && remoteView) remoteView.setSnapshot(stateToNetSnapshot(snapCodec.decode(x.snap as never)));
      };
    }
    void p.start();
    return p;
  } catch { return null; }
}
let serverLanIps: string[] = [];   // 服务器在 welcome 里报告的本机局域网 IP（生成邀请链接用）
// 服务器**可信来源**确立的当前入口（v3.0.1：不再从进站 Host 学习，Host 可伪造）
// v3.0.2：host 与**完整 origin** 都留一份 —— 域名形态用 https，IP 形态必须带协议+端口
let serverPublicHost: string | null = null;
let serverPublicOrigin: string | null = null;
let onlineName = localStorage.getItem("tank_online_name") || "玩家";
let onlineTables: NetTable[] = [];
// v2.25 是否已收到过服务器桌子列表：未同步前不自动建房（避免连接时序空窗误建重复房）
let tablesSynced = false;
// v2.25 断线自动重连定时器
let onlineReconnectTimer: number | null = null;
let onlineCurrent: NetTable | null = null;
let onlineSel = 0;
let onlineMsg = "";
let onlineMsgTimer = 0;
let onlineInTable = false;
// v2.15 房间内人机队友数量：在房间内增减，不再在主菜单显示（房主控制，0~2）
let roomBotCount = 0;
// v2.15 座位状态：每个座位可以是 "open"(开放) | "ai"(AI队友) | "closed"(关闭)
// 房主点击空座位轮换状态：开放 → AI → 关闭 → 开放
type SeatState = "open" | "ai" | "closed";
let seatStates: SeatState[] = ["open", "open", "open", "open"];
// v2.3.6：先选模式（null=模式选择中），再进该模式的房间大厅（每模式 20 桌）
let onlineMode: "endless" | "stage" | null = null;
let onlineModeSel = 0; // 0=无尽 1=闯关
/** 远端输入发送节流器：30Hz 兜底 + "变化即发"（按键变化时绕过节流立即发送） */
let inputSendTimer = 0;
const INPUT_SEND_INTERVAL = 1 / 30; // 30Hz ≈ 33ms（按键变化时无视此间隔立即发送）
/** 上次发送的输入指纹：按键状态任何一位变化即重发（低延迟），稳定时按 30Hz 保活 */
let remoteLastSig = "";
/** v2.14.1 成员端 E 键边沿（用 E 打开/关闭基地商店；触屏则点基地，勿误转发两次） */
let prevRemoteInteract = false;
/** v2.22 成员端触屏"背包"/"仓库"按钮边沿：本地打开自己的背包/仓库查看面板（不转发主机） */
let prevMemberInvHeld = false;
let prevMemberWhHeld = false;
/** v2.35 成员端底部炮筒按钮（c0-c3）：选择变化时强制上送一次（输入指纹不含 selectCannon） */
let remoteLastSelectCannon = -1;

/** 输入指纹：任一键位变化 → 触发"变化即发"（v2.22 补上 fire，触屏开火键按下即发不等 30Hz 保活） */
function inputSig(i: PlayerInput): string {
  return `${i.up}|${i.down}|${i.left}|${i.right}|${i.w0}|${i.w1}|${i.w2}|${i.w3}|${i.fire}|${i.interact}|${i.switchCannon}|${i.inventory}|${i.warehouse}|${i.revive}`;
}
/** 客户端固定步进帧号（60Hz 世界时间基准，与 rAF/刷新率解耦，供主机按序消费） */
function clientInputFrame(): number {
  return Math.floor(performance.now() / (1000 / 60));
}

// ── 网络 RTT/抖动（net-sync-core LatencyTracker，window 路线=坦克旧手感，读数稳定）──
const NET_SAMPLE_MAX = 12;             // 滑动窗口大小：取最近 12 个样本的平均 ≈ 稳定 ~1s 的读数
const netLatency = new LatencyTracker({ route: "window", windowSize: NET_SAMPLE_MAX });
let netRtt = 0;                        // 窗口均值 RTT（ms，HUD 读）
let netJitter = 0;                     // 窗口平均绝对偏差（ms，HUD 读）
let netPingTimer = 0;                  // 定时 ping 节流（主机无 input 流量时也保测量）

/** 收到 pong：交给 LatencyTracker（ts 为发起时的原时间戳，异常/过期样本模块内丢弃）→ 读 rtt/jitter 供 HUD */
function onNetPong(ts: number): void {
  netLatency.onPong(ts);
  netRtt = netLatency.rtt;
  netJitter = netLatency.jitter;
}
/** 联机中按 500ms 定时 ping（成员有 input 回声可忽略；主机仅靠此保测量） */
function netPingTick(dt: number): void {
  netPingTimer -= dt;
  if (netPingTimer <= 0) { netPingTimer = 0.5; net.ping(); }
}

const wsProto = (): "ws" | "wss" => (location.protocol === "https:" ? "wss" : "ws");

/**
 * 联机服务器候选地址（按序探测，收到 welcome 才算成功）：
 *  1. ?server= 显式指定（最高优先）
 *  2. 同源 —— 单端口部署时页面与 WS 同由 server/index.mjs 提供，直接连
 *  3. ws(s)://<host>:3001 —— 开发模式（Vite:3000）等场景的回退；
 *     若当前是 localhost 会尝试用局域网 IP（WebRTC 探测缓存）
 */
function getServerCandidates(): ServerCandidate[] {
  const qs = new URLSearchParams(location.search);
  const s = qs.get("server");
  if (s) {
    const u = s.startsWith("ws://") || s.startsWith("wss://") ? s : `${wsProto()}://${s}`;
    return [u];
  }
  const cands: ServerCandidate[] = [`${wsProto()}://${location.host}`];
  // 手里有「稳定入口」（/<sid>/join/… 形态）时，把它也作为兜底候选：
  // 链接被 302/反代送到一个连不上的地址时，直接改连服务器本身，由它把我带回当前入口。
  // 玩家视角：不用懂这些，打开链接就是能玩（Issue #11）。
  const stablePath = stableEntryPath(autoJoinRoom ?? null);
  if (stablePath) cands.push(`${wsProto()}://${location.host}${stablePath}`);
  if (location.port !== "3001") {
    cands.push(() => {
      const h = sharedHost || location.hostname;
      return h ? `${wsProto()}://${h}:3001` : null;
    });
  }
  return [...new Set(cands)];
}

/** 大厅顶部展示用：当前联机服地址的可读描述 */
function describeServer(): string {
  const qs = new URLSearchParams(location.search);
  const s = qs.get("server");
  if (s) return s;
  if (location.port === "3001") return `${wsProto()}://${location.host}（同源）`;
  return `${wsProto()}://${sharedHost || location.hostname}:3001`;
}

// ── 邀请链接：URL 形如 ?server=ws://...&room=<桌ID>，对方打开后自动进房 ──
let autoJoinRoom: number | null = (() => {
  const r = Number(new URLSearchParams(location.search).get("room"));
  return Number.isFinite(r) && r > 0 ? r : null;
})();

// ── v3.0 稳定入口自动学习：链接形如 /<sid>/join/<roomId>（302 后到达页面，路径仍可解析）──
// 页面地址 / 当前域名 里只要带得出 sid，就记下来 —— 之后无论是断线重连、刷新、
// 还是把链接再分享给别人，都能自动匹配到「当前实际地址」。
(function learnStableEntryFromUrl() {
  const fromPath = parseStableEntry(location.href);
  if (fromPath) {
    const prev = entryMgr.peek();
    entryMgr.save({ sid: fromPath.sid, roomId: fromPath.roomId ?? autoJoinRoom ?? prev?.roomId ?? null, url: location.origin });
    // 302 落回来时路径可能已被换成 "/?room=x"，此时 roomId 从 query 里补
    if (autoJoinRoom != null) entryMgr.save({ sid: fromPath.sid, roomId: autoJoinRoom, url: location.origin });
    console.log(`[稳定入口] 从链接学习到 sid=${fromPath.sid} room=${fromPath.roomId ?? autoJoinRoom ?? "-"}`);
  }
  // 另一个可能：管理员直接改地址栏（?entry=<sid>）或先用老链接（?room=x），都允许后续由 welcome 补 sid
  const qs = new URLSearchParams(location.search);
  const entrySid = (qs.get("entry") || "").trim().toLowerCase();
  if (/^[0-9a-f]{8}$/.test(entrySid)) entryMgr.save({ sid: entrySid, roomId: autoJoinRoom, url: location.origin });
})();

/** v2.10 快照增量解码器（成员端把增量帧重建为完整快照再喂 RemoteView）——net-sync-core SyncCodec */
const snapCodec = new SyncCodec(TANK_SYNC_SCHEMA);
(window as any).__snapCodec = snapCodec;   // 调试句柄（可视化 e2e 断言缓存状态）
/** v2.10 WebRTC P2P 直连（双人时尝试；失败自动回落 WS 兜底） */
let peer: RtcPeer | null = null;

/** 通过 WebRTC 尝试探测本机局域网 IP（用于把 localhost 替换成可分享的地址） */
function detectLanHost(): string | null {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel("d");
    let got: string | null = null;
    pc.onicecandidate = (e) => {
      if (e.candidate && !got) {
        const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
        if (m) got = m[1];
      }
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => { try { pc.close(); } catch {} }, 400);
    return got;
  } catch { return null; }
}

/** 本机对外的可分享 host（非 localhost）。探测是异步的，缓存到首次成功。 */
let sharedHost: string | null = null;
let sharedHostAt = 0;
function getSharedHost(): string {
  const h = location.hostname;
  if (h !== "localhost" && h !== "127.0.0.1" && h !== "0.0.0.0" && h !== "") return h;
  if (sharedHost && Date.now() - sharedHostAt < 15000) return sharedHost;
  const lan = detectLanHost();
  if (lan) { sharedHost = lan; sharedHostAt = Date.now(); return lan; }
  return h;
}
/** 手动配置/记忆的公网入口（localStorage；U 键可改）。原样保存，协议与端口都不丢。 */
function getPublicOrigin(): string | null {
  try {
    const v = (localStorage.getItem("tank_public_host") || "").trim();
    if (!v) return null;
    const clean = v.replace(/[\/]+$/, "");
    if (/^https?:\/\//i.test(clean)) return clean;              // 用户/自动学习时带了协议 → 原样用
    // 只有 host[:port]：域名默认 https，IP（含端口）默认 http —— 后者是 IP 形态部署的常见姿势
    return `${/^\d+\.\d+\.\d+\.\d+/.test(clean) ? "http" : "https"}://${clean}`;
  } catch { return null; }
}
/** 手动配置/记忆的公网 host（展示用；保留端口） */
function getPublicHost(): string | null {
  const o = getPublicOrigin();
  return o ? o.replace(/^https?:\/\//i, "") : null;
}
function setPublicHost(h: string | null) {
  try {
    if (h) localStorage.setItem("tank_public_host", h.trim().replace(/[\/]+$/, ""));
    else localStorage.removeItem("tank_public_host");
  } catch {}
}
/**
 * 页面通过**公网地址**打开时自动记住它（桌面端分享时也用它）。
 * v3.0.2：公网 IP 形态也记（含端口），且把协议一起记住（http://203.0.113.9:3001 不能拼成 https）。
 * 局域网 IP / 回环仍不记（好友设备上无意义）。
 */
function autoLearnPublicHost() {
  try {
    const h = location.hostname;
    if (!h || h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") return;
    const isLan = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    if (isLan) return;                                    // 局域网地址不记（只对同一 WiFi 有意义）
    setPublicHost(`${location.protocol}//${location.host}`);
  } catch {}
}


/**
 * 可分享的「当前入口 origin」：服务器可信来源确立的入口 > 页面自身域名（排除 localhost）；没有则 ""。
 * v3.0.2：优先用服务器给的**完整 origin**（协议+端口都在里面），这样
 *   域名（https://game.example.com）、公网 IP（http://203.0.113.9:3001）、
 *   局域网 IP（http://192.168.1.50:3001）三种形态都能原样分享出去。
 */
function getSharedOrigin(): string {
  const pub = serverPublicOrigin || (serverPublicHost ? `https://${serverPublicHost}` : "");
  if (pub && /^https?:\/\//i.test(pub) && !/^https?:\/\/(localhost|127\.)/i.test(pub)) return pub.replace(/\/+$/, "");
  const h = location.hostname;
  if (!h || h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") return "";
  return location.origin;
}

/**
 * 生成当前房间的邀请链接。
 * 关键规则：链接里绝不能出现 localhost / 127.0.0.1 —— 那在好友设备上指向他自己。
 *  - 页面本身通过非 localhost 地址打开（局域网 IP / 隧道域名）→ 同源即最佳；
 *  - 本机用 localhost 打开 → 用服务器在 welcome 中报告的真实局域网 IP 替换。
 */
function buildInviteUrl(roomId: number): string {
  // ⓿ v3.0 稳定入口：链接形状 = <当前域名>/<sid>/join/<roomId>。
  //    域名用「当前实际域名」（**服务器可信来源确立的入口域名** > 页面自身域名），sid 恒定；
  //    好友打开这条链接时由服务器 302 自动匹配到最新可用地址 → 域名变了链接也不用改。
  //    ⚠ v3.0.1：服务器不再**学习**进站 Host（Host 可伪造，会被劫持成钓鱼链接），
  //      所以这里的域名只可能是「服务器可信入口」或「页面自己所在的域名」——两者都不是 caller 自报。
  const entryPath = stableEntryPath(roomId);
  if (entryPath) {
    const origin = getSharedOrigin();
    if (origin) return `${origin}${entryPath}`;
    // 本机打开（localhost）：退回服务器的局域网 IP，同样带稳定入口路径（仅同 WiFi 可用）
    const lan = serverLanIps[0] || sharedHost;
    if (lan) return `http://${lan}:${location.port || 3001}${entryPath}`;
  }
  // ① 服务器可信来源确立的当前入口（域名/IP 都算，客户端由 welcome/pong 自动刷新）
  if (serverPublicOrigin) return `${serverPublicOrigin}/?room=${roomId}`;
  if (serverPublicHost) return `https://${serverPublicHost}/?room=${roomId}`;
  // ② 手动配置/记忆的公网入口（兜底）：协议按用户/自动学习时给的原样，IP 形态不会被打成 https
  const pub = getPublicOrigin();
  if (pub) return `${pub}/?room=${roomId}`;

  const h = location.hostname;
  const isLocal = !h || h === "localhost" || h === "127.0.0.1";
  if (!isLocal) return `${location.origin}${location.pathname}?room=${roomId}`;

  // 开发模式（Vite 等非 3001 页面）：额外携带 ?server= 指向联机服
  if (location.port && location.port !== "3001") {
    const host = serverLanIps[0] || sharedHost;
    if (!host) return "";
    const server = encodeURIComponent(`${wsProto()}://${host}:3001`);
    return `http://${host}:3001${location.pathname}?room=${roomId}&server=${server}`;
  }
  // 单端口部署 + localhost 打开：替换为服务器的局域网地址（仅同 WiFi 可用）
  const host = serverLanIps[0];
  if (host) return `http://${host}:${location.port || 3001}${location.pathname}?room=${roomId}`;
  return ""; // 拿不到任何可分享地址（无局域网网卡），由调用方提示
}

/** 复制文本到剪贴板（兼容非 https 环境：降级为临时 textarea / prompt） */
function copyText(t: string): void {
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      notifyOnline("邀请链接已复制，发给好友即可进房");
    } catch {
      prompt("复制这条邀请链接发给好友：", t);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(
      () => notifyOnline("邀请链接已复制，发给好友即可进房"),
      () => fallback(),
    );
  } else fallback();
}

// ── 大厅鼠标/触屏按钮：canvas 命中检测（每帧渲染时注册，点击时倒序命中）──
interface LobbyButton { x: number; y: number; w: number; h: number; onTap: () => void; }
let lobbyButtons: LobbyButton[] = [];

function drawLobbyButton(x: number, y: number, w: number, h: number, label: string,
  bg: string, border: string, fg: string, onTap: () => void): void {
  renderer.fillRect(x, y, w, h, bg);
  renderer.strokeRect(x, y, w, h, border, 2);
  renderer.drawText(label, x + w / 2, y + (h - 14) / 2 + 2,
    { font: "13px monospace", color: fg, align: "center" });
  lobbyButtons.push({ x, y, w, h, onTap });
}

/** 判断当前是否处于可暂停的游戏对局中 */
function isGameplayState(): boolean {
  return state === "playing_endless" || state === "playing_stage" ||
         state === "playing_test" || state === "online_host" || state === "online_client";
}

/** 从任意游戏模式退出到主菜单（各模式各自的清理逻辑） */
function quitCurrentGame(): void {
  getSoundManager().play("pickup");
  if (state === "online_host" && host) {
    if (net.connected && host.score >= 0) net.hostGameOver({ reason: "房主退出", score: host.score });
    exitOnlineToMenu();
  } else if (state === "online_client") {
    net.close(); state = "menu";
    remoteView = null;
    mobileControls.setEnabled(false);
    input.setSuppressLocalP2(false);
  } else {
    endless = null; stage = null; test = null; paused = false; state = "menu";
  }
}

/**
 * 注册暂停菜单四个选项的点击命中区域（与 MenuVisual.drawPauseOverlay 的布局严格对应）。
 * 只注册命中区，不重复绘制——视觉由 drawPauseOverlayThemed 负责。
 */
function registerPauseMenuButtons(W: number, H: number): void {
  const pw = 320, ph = 210;
  const px = (W - pw) / 2, py = (H - ph) / 2;
  const actions: Array<() => void> = [
    () => { paused = false; if (remoteView) remoteView.flushInterp(); getSoundManager().play("pickup"); },  // 继续游戏（v2.35 对齐最新帧）
    () => { settingsFromPause = true; paused = false; state = "settings"; getSoundManager().play("pickup"); }, // 打开设置
    () => { quitCurrentGame(); },                                                                          // 返回菜单
    () => { void toggleFullscreen(); },                                                                    // 全屏/缩放
  ];
  actions.forEach((action, i) => {
    const oy = py + 74 + i * 28;
    lobbyButtons.push({ x: px + 16, y: oy, w: pw - 32, h: 22, onTap: action });
  });
}

canvas.addEventListener("pointerdown", (e) => {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const x = (e.clientX - r.left) * (currentLayout.canvasW / r.width);
  const y = (e.clientY - r.top) * (currentLayout.canvasH / r.height);
  // 联机成员：点击转发给远端视图（升级面板点选等），暂停时不转发；对局结束后改走结束菜单按钮
  const overOnline = (state === "online_host" && !!host?.isOver) || (state === "online_client" && !!remoteView?.isOver());
  if (state === "online_client" && remoteView && !paused && !overOnline) {
    // v2.36 先响应全局按钮（暂停键等）——此前点击被 RemoteView.tap 吞掉，导致暂停键"不能点开"
    for (let i = lobbyButtons.length - 1; i >= 0; i--) {
      const b = lobbyButtons[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        getSoundManager().play("pickup");
        b.onTap();
        return;
      }
    }
    // v2.35 优先尝试拖拽（背包→炮筒槽拖放）；命中拖拽目标则不触发普通点击
    if (remoteView.dragPointerDown(x, y)) return;
    remoteView.tap(x, y);
    return;
  }
  // 暂停状态 / 菜单 / 联机大厅 / 设置页 / 游戏结束 / 联机结束画面：处理 lobbyButtons 点击
  // v2.18 修复：gameover 状态也需要处理点击（手机端无Enter键，只能点按钮）
  if ((state !== "online" && state !== "menu" && state !== "settings" && state !== "gameover" && !overOnline && !paused) || lobbyButtons.length === 0) return;
  for (let i = lobbyButtons.length - 1; i >= 0; i--) {
    const b = lobbyButtons[i];
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      getSoundManager().play("pickup");
      b.onTap();
      break;
    }
  }
});

// v2.35 联机成员：拖拽移动/释放（背包↔炮筒槽拖放；指针移出画布也能正常结算）
function onlineDragXY(e: PointerEvent): { x: number; y: number } | null {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return {
    x: (e.clientX - r.left) * (currentLayout.canvasW / r.width),
    y: (e.clientY - r.top) * (currentLayout.canvasH / r.height),
  };
}
window.addEventListener("pointermove", (e) => {
  if (state !== "online_client" || !remoteView || paused) return;
  const p = onlineDragXY(e);
  if (p) remoteView.dragPointerMove(p.x, p.y);
});
window.addEventListener("pointerup", (e) => {
  if (state !== "online_client" || !remoteView || paused) return;
  const p = onlineDragXY(e);
  if (p) remoteView.dragPointerUp(p.x, p.y);
});

// ── 大厅共享动作（键盘快捷键与鼠标/触屏按钮共用）──
function onlineRename(): void {
  const nn = prompt("你的昵称", onlineName);
  if (nn && nn.trim()) { onlineName = nn.trim().slice(0, 12); localStorage.setItem("tank_online_name", onlineName); net.setname(onlineName); }
}
// v2.25 新建房间：不依赖弹窗输入（不阻塞），直接用默认名开一桌并进入
// v2.35 房间方向：把当前选择的横屏/竖屏写入房间，成员进入后按此对齐（PC 也可选竖屏）
/** v2.35 切换房间方向（横屏/竖屏）：建房时写入房间，成员端自动对齐 */
function onlineToggleOrient(): void {
  orientTouched = true;
  menuOrient = (menuOrient + 1) % 2;
  settings.orient = menuOrient;
  saveSettings(settings);
  // v2.36 已在房间内且是房主：实时更改房间方向（广播给所有成员，开局按最新方向创建地图）
  if (onlineInTable && onlineIsHost()) {
    const orient = menuOrient === 1 ? "portrait" : "landscape";
    net.setOrient(orient);
    notifyOnline(`房间方向已改为「${menuOrient === 1 ? "竖屏" : "横屏"}」，双方将按此方向进入对局`);
    return;
  }
  notifyOnline(`房间方向已设为「${menuOrient === 1 ? "竖屏" : "横屏"}」，新建房间生效`);
}
function onlineCreateTable(): void {
  if (!net.connected) { notifyOnline("正在连接联机服务器…"); net.list(); return; }
  const def = (onlineMode === "stage" ? "闯关房" : "无尽房") + (onlineName ? `·${onlineName}` : "");
  const L = pickLayout();
  const orient: "landscape" | "portrait" = L === LAYOUTS.portrait ? "portrait" : "landscape";
  net.create(def.slice(0, 16), onlineMode ?? undefined, orient);
  notifyOnline(`正在创建新房间（${orient === "portrait" ? "竖屏" : "横屏"}）…`);
}
// v2.15 快速加入空桌：桌子是预留的，加入就自动占据座位
// v2.25 没有任何可加入的房间时 → 现场新建一桌（大厅永远有房，不存在"暂无可用房间"阻塞）
function onlineQuickJoin(): void {
  if (!tablesSynced) { notifyOnline("正在同步房间列表…"); net.list(); return; }
  const filtered = onlineTables.filter((t) => t.mode === onlineMode && t.state === "lobby");
  // 优先加入有空座位的桌子
  const withEmpty = filtered.find((t) => t.seats.some((s) => s === null));
  const target = withEmpty || filtered[0];
  if (target) {
    net.join(target.id);
    notifyOnline(`正在加入 ${target.name}…`);
  } else {
    onlineCreateTable();
  }
}
/** v2.25 断线自动重连：留在联机大厅，2.5 秒后按候选地址重连（成功后 welcome 自动拉取房间列表） */
function scheduleOnlineReconnect(): void {
  if (onlineReconnectTimer !== null) return;
  onlineReconnectTimer = window.setTimeout(() => {
    onlineReconnectTimer = null;
    if (state !== "online" || net.connected) return;
    notifyOnline("正在重连联机服务器…");
    net.connect(getServerCandidates());
  }, 2500);
}
function cancelOnlineReconnect(): void {
  if (onlineReconnectTimer !== null) { clearTimeout(onlineReconnectTimer); onlineReconnectTimer = null; }
}
function onlineJoin(t: NetTable): void {
  if (t.state === "playing") notifyOnline("该房间对局中，等待本局结束");
  else net.join(t.id);
}
function onlineToggleReady(): void {
  const mySeat = onlineCurrent?.seats.find((s) => s && s.clientId === net.myClientId);
  net.ready(!(mySeat?.ready ?? false));
}
function onlineStartGame(): void { net.start(); }
function onlineLeaveTable(): void { net.leave(); }
function onlineCopyInvite(): void {
  if (!onlineCurrent) return;
  const url = buildInviteUrl(onlineCurrent.id);
  if (!url || url.includes("//localhost") || url.includes("//127.0.0.1")) {
    notifyOnline("无法生成分享链接：未获取到本机局域网地址，请改用 http://<你的IP>:3001 打开页面");
    return;
  }
  copyText(url);
  notifyOnline(`已复制: ${url.length > 52 ? url.slice(0, 52) + "…" : url}`);
}

// 应用设置：操作模式/音量/方向
function applySettings(): void {
  input.setMode(settings.mode);
  getSoundManager().setVolume(settings.volume / 100);
  menuOrient = settings.orient;
  // v2.15 触屏控制：mobile/tablet/touch 模式启用虚拟摇杆
  mobileControls.setEnabled(settings.mode === "mobile" || settings.mode === "tablet" || settings.mode === "touch");
  saveSettings(settings);
}

/** 联机大厅 M 键：循环切换操作方式（键盘 → 手机 → 平板 → 手柄），P2 手机用户在进房前/房内都能改 */
function onlineCycleControlMode(): void {
  const modes: GameSettings["mode"][] = ["keyboard", "mobile", "tablet", "gamepad"];
  const i = (modes.indexOf(settings.mode) + 1) % modes.length;
  settings.mode = modes[i];
  localStorage.setItem("tank_mode_manual", "1"); // 用户显式选择后不再按设备自动切换
  input.setMode(settings.mode);
  mobileControls.setEnabled(settings.mode === "mobile" || settings.mode === "tablet" || settings.mode === "touch");
  notifyOnline(`操作方式：${MODE_LABELS[settings.mode]}`);
  getSoundManager().play("pickup");
}

function changeSettings(dir: 1 | -1): void {
  switch (settingsSel) {
    case 0: {  // 操作模式
      const modes: GameSettings["mode"][] = ["keyboard", "mobile", "tablet", "gamepad"];
      const i = (modes.indexOf(settings.mode) + dir + 4) % 4;
      settings.mode = modes[i];
      localStorage.setItem("tank_mode_manual", "1"); // 用户显式选择后不再按设备自动切换
      break;
    }
    case 1: settings.volume = Math.max(0, Math.min(100, settings.volume + dir * 10)); break;
    case 2: settings.orient = settings.orient === 0 ? 1 : 0; break;
    case 3: /* 按键绑定：左右键不响应，按 Enter 进入绑定模式（后续实现） */ break;
    case 4: settings.p2Bot = !settings.p2Bot; break;   // P2 自动 AI 开关
    case 5: settings.showVirtualControls = !settings.showVirtualControls; break;  // v2.19 虚拟按键显示开关
    case 6: return; // 返回行不响应左右
  }
  applySettings();
  getSoundManager().play("pickup");
}

function startGame(mode: number): void {
  const layout = pickLayout();
  applyLayout(layout);
  paused = false;
  if (mode === 0) { endless = new EndlessMode(canvas, layout); state = "playing_endless"; }
  else if (mode === 1) { stage = new StageMode(canvas, layout); state = "playing_stage"; }
  else { test = new DpsTestMode(canvas, layout, input); state = "playing_test"; }
}

// ── 联机流程 ──
function notifyOnline(msg: string): void { onlineMsg = msg; onlineMsgTimer = 2.5; }

function enterOnline(): void {
  cancelOnlineReconnect();    // v2.25 手动进入：清掉待执行的重连
  tablesSynced = false;
  net.setname(onlineName);
  net.connect(getServerCandidates());
  state = "online";
  onlineMsg = "";
  onlineMode = null;          // 先选模式
  onlineModeSel = 0;
  onlineInTable = false;
  onlineCurrent = null;
  onlineSel = 0;
  const stable = entryMgr.peek();
  notifyOnline(stable ? "正在连接联机服务器（稳定入口自动匹配中…）" : "正在连接联机服务器…");
}

function exitOnlineToMenu(): void {
  cancelOnlineReconnect();    // v2.25 主动退出：不再自动重连
  if (net.connected) net.close();
  host = null; remoteView = null; paused = false;
  onlineCurrent = null; onlineInTable = false;
  input.setSuppressLocalP2(false);
  mobileControls.setEnabled(false);
  state = "menu";
}

/** v2.21 联机对局结束（基地被摧毁/全员阵亡）后返回联机大厅：离开已结束的桌子，保持连接继续选桌 */
function returnToOnlineLobby(): void {
  getSoundManager().play("pickup");
  host = null; remoteView = null; paused = false;
  input.setSuppressLocalP2(false);
  mobileControls.setEnabled(false);
  if (onlineInTable) net.leave();   // 服务器已把桌子置回 lobby，主动离桌回大厅列表
  onlineInTable = false; onlineCurrent = null;
  onlineMode = onlineMode ?? "endless";
  onlineSel = 0;
  state = "online";
  notifyOnline("已返回大厅，重新选桌或新建房间");
}

/**
 * v3.0.3 入口自愈：当前页面地址 != 服务器汇报的当前入口时，把浏览器带到正确入口
 * （带上 sid + 房间号 → 到达后仍是同一个房间，稳定链接语义不变）。
 * 只在「服务器有明确入口」且「当前页面不是这个入口」且「当前不是由 ?server= 指定服务器」时才跳，
 * 避免多服务器/开发模式被误跳。
 */
async function reconcileEntryOrigin(): Promise<void> {
  const target = serverPublicOrigin ? serverPublicOrigin.replace(/\/+$/, "") : "";
  if (!target || !/^https?:\/\//i.test(target)) return;
  // 只在**页面被送到了别的地址**时自愈（反代/隧道/后端网络把用户送到了非本服务的地址）。
  // 同机打开（localhost / 本机网卡 IP 访问同一台服务器）属于房主自己开着玩，绝不跳 ——
  // 跳了反而会把房主从他自己的页面踢走（体验倒退）。
  const sameHost = location.hostname === new URL(target).hostname;
  const isLocalView = /^(localhost|127\.|0\.0\.0\.0)$/i.test(location.hostname);
  if (sameHost || isLocalView) return;
  const qs = new URLSearchParams(location.search);
  if (qs.get("server")) return;                                  // 显式指定别的服务器 → 不跳
  if (location.origin === target) return;                        // 已经在正确入口上
  const sid = net.sid;
  if (!sid) return;
  // 服务器可达性先确认一下：新入口打不开（如仅内网可达）就不跳，免得把玩家推到更差的地址
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(`${target}/__whoami`, { signal: ac.signal, cache: "no-store" });
    clearTimeout(to);
    if (!r.ok) return;
    const j = await r.json().catch(() => null);
    if (!j || j.sid !== sid) return;                             // 别跳到另一台服务器上
  } catch { return; }
  const room = onlineCurrent?.id ?? autoJoinRoom ?? entryMgr.peek()?.roomId ?? null;
  const url = `${target}/${sid}/join/${room != null ? room : ""}`;
  console.log(`[稳定入口] 当前页面入口( ${location.origin} )与服务器入口( ${target} )不一致，自动带你过去`);
  notifyOnline("正在带你到正确的服务器入口…");
  location.replace(url);
}

/**
 * v3.0.3「玩家视角」：服务器登记的入口**从我这台机器连不上**时的自救。
 *
 * 场上真实故障（Issue #11 用户描述）：服务器对外登记的入口（公网 IP/域名）在后端网络里访问不到 ——
 * 页面能打开（说明这个地址是通的），但任何指向「那个入口」的链接、跳转、分享都等于把玩家送进死路。
 * 玩家要的是「点开就能玩」，不是「先去验证入口可达性」。
 *
 * 所以：一旦发现入口连不上，就把「我实际打开的这个地址」当作可用入口用起来 ——
 *   ① 本地稳定入口落成当前地址（断线重连/刷新继续走它，不再绕远路去不可达的入口）；
 *   ② 告诉服务器「这台机器从哪个地址能连到你」（仅在其**已经登记过入口**时用于修正，
 *      未登记时不动：避免把「请求方自报的 Host」重新引回来当入口，那是之前的钓鱼漏洞）。
 */
async function ensureLocalPlayableEntry(): Promise<void> {
  const target = serverPublicOrigin ? serverPublicOrigin.replace(/\/+$/, "") : "";
  const sid = net.sid;
  if (!sid) return;
  const origin = location.origin;
  if (/^https?:\/\//i.test(target) && target !== origin) {
    let reachable = false;
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 2500);
      const r = await fetch(`${target}/__whoami`, { signal: ac.signal, cache: "no-store" });
      clearTimeout(to);
      reachable = r.ok;
    } catch { reachable = false; }
    if (reachable) return;                                       // 入口可达：保持现状，不必自救
    console.log(`[稳定入口] 登记的入口 ${target} 从本机连不上 → 就地使用当前地址 ${origin}`);
    notifyOnline("当前网络连不上服务器登记的入口，已就地用你打开的这个地址开玩");
  }
  // ① 本地稳定入口 = 当前实际可用的地址（玩家刷新/断线重连走它）
  entryMgr.save({ sid, roomId: onlineCurrent?.id ?? autoJoinRoom ?? entryMgr.peek()?.roomId ?? null, url: origin });
  // ② 服务器已登记过入口 → 允许它按「这台机器实际能连到的地址」修正一次（仅此情形，避免请求方自报 Host 复活）
  try {
    await fetch("/entry/localtip?origin=" + encodeURIComponent(origin), { cache: "no-store" });
  } catch { /* 失败不影响开玩 */ }
}

function wireNetHandlers(): void {
  net.setEntryLink(() => stableEntryCandidates());   // 稳定链接永远是第一寻址候选（自动匹配）
  net.on("entry", (e) => onEntryReport(e.sid, e.url));
  net.on("tables", (tables) => {
    onlineTables = tables;
    tablesSynced = true;   // v2.25 已同步：允许"快速加入/开房"直接决策
    // 服务器每次广播都带最新公网域名（来自可信来源）→ 邀请链接实时自动适配（稳定链接同步换域名）
    if (net.publicHost) serverPublicHost = net.publicHost;
    if (net.publicOrigin) { serverPublicOrigin = net.publicOrigin; keepStableEntryForOrigin(net.publicOrigin); }
  });
  net.on("welcome", () => {
    // 记录服务器报告的真实局域网地址（生成邀请链接用）
    const si = net.serverInfo;
    if (si && si.lanIps.length) serverLanIps = si.lanIps;
    // 服务器可信来源确立的当前入口（隧道/换 IP 后由登记刷新，客户端自动跟上）
    if (net.publicHost) serverPublicHost = net.publicHost;
    if (net.publicOrigin) { serverPublicOrigin = net.publicOrigin; keepStableEntryForOrigin(net.publicOrigin); }
    // 页面经公网隧道打开 → 自动记住该域名（兜底：本地手动模式）
    autoLearnPublicHost();
    // v3.0.3「玩家视角」自愈：这条页面如果不是从服务器自己的入口打开的（反代/隧道把用户送到了
    // 别的地址，页面与 WebSocket 不同源），服务器已经告诉了我们正确入口 —— 自动带过去，
    // 玩家不需要理解「入口 / 反代 / 域名」是什么，打开链接就是能玩（Issue #11）。
    // 放在 welcome 之后一小段延迟：welcome 里刚拿到的入口要先落到 serverPublicOrigin，
    // 而 welcome 只保证「有地址」，不保证「页面已经被送到那个地址」（反代/多跳场景）。
    setTimeout(() => { void reconcileEntryOrigin(); }, 600);
    // 反向场景：登记的入口从本机根本连不上（后端网络不通）→ 就地用当前地址开玩，别让玩家卡住
    setTimeout(() => { void ensureLocalPlayableEntry(); }, 1400);
    // v2.19 连接后主动拉取桌子列表（不依赖服务器广播时序，避免大厅空表）
    net.list();
    // 带邀请链接打开：连上后自动加入目标房间（重连卡优先于邀请链接，避免已开始的对局被 join 拒绝）
    const rej = !onlineInTable ? peekRejoinCard() : null;
    if (rej) {
      notifyOnline("检测到中断的对局，正在重连…");
      setTimeout(() => net.rejoin(rej.tableId, rej.token), 300);
    } else if (autoJoinRoom !== null && !onlineInTable) {
      const r = autoJoinRoom;
      autoJoinRoom = null;
      notifyOnline(`正在加入邀请房间…`);
      net.join(r);
    }
  });
  net.on("table", (table) => {
    onlineCurrent = table;
    onlineInTable = table.seats.some((s) => s && s.clientId === net.myClientId);
    // 邀请链接自动进房时，从桌信息反推模式（跳过模式选择）
    if (onlineInTable && onlineMode === null) onlineMode = table.mode;
    // 进入房间时重置人机队友数量和座位状态
    if (onlineInTable) { roomBotCount = 0; seatStates = ["open", "open", "open", "open"]; }
  });
  net.on("error", (m) => notifyOnline(m));
  net.on("closed", () => {
    if (state === "online" || state === "online_host" || state === "online_client") {
      // v2.25 断线不再踢回主菜单（避免玩家误点"开始"被导流到离线单机）：
      // 留在联机界面自动重连，重连成功由 welcome 重新拉取房间列表
      host = null; remoteView = null; onlineCurrent = null; onlineInTable = false;
      input.setSuppressLocalP2(false);
      mobileControls.setEnabled(false);
      paused = false;
      tablesSynced = false;
      state = "online";
      notifyOnline("与服务器断开连接，正在自动重连…");
      scheduleOnlineReconnect();
    }
  });
  net.on("left", () => { onlineInTable = false; onlineCurrent = null; onlineSel = 0; roomBotCount = 0; seatStates = ["open", "open", "open", "open"]; clearRejoinCard(); notifyOnline("已离开房间"); });
  net.on("start", (start) => beginOnlineGame(start));
  net.on("rejoin_ok", (d) => {      // v2.11 局内重进成功：直接恢复对局（复用 beginOnlineGame）
    (window as any).__rejoinApplied = true;   // e2e 判定"已重连回对局"
    beginOnlineGame({ myIndex: d.myIndex, mode: d.mode, players: d.players, orient: d.orient });
    notifyOnline("对局重连成功，继续游戏");
  });
  net.on("error", (msg) => {        // v2.11 重连令牌失效（对局已结束/座位被顶替/房主迁移）→ 清卡回大厅
    if (peekRejoinCard()) { clearRejoinCard(); notifyOnline(`重连失败：${msg}，已回大厅`); }
    // v2.25 大厅内连接失败（服务器未启动/重启中）→ 自动重试，不把玩家丢回主菜单
    if (state === "online" && !net.connected) scheduleOnlineReconnect();
  });
  net.on("peerInput", (msg) => { if (host && msg.idx === 1) { host.enqueueRemoteInput(msg.flags, msg.clientFrame ?? 0, msg.clientSendTime ?? Date.now()); host.lastPeerInputTime = msg.clientSendTime ?? Date.now(); } });
  net.on("peerLeft", () => { });
  net.on("snapshot", (data) => {
    if (!remoteView) return;
    try {
      const decoded = snapCodec.decode(data as never);
      const snap = stateToNetSnapshot(decoded);
      remoteView.setSnapshot(snap);
    } catch (e) {
      console.error("[snapshot] decode failed:", e);
    }
  });
  net.on("gameover", () => { clearRejoinCard(); });   // v2.11 对局正常结束 → 清重连卡
  net.on("pong", onNetPong);
  net.on("levelup", (d) => { if (remoteView) remoteView.setLevelUp(d.playerIdx, d.choices); });
  net.on("pickLevelup", (m) => { if (host) host.onPeerLevelUpPick(Number(m.playerIdx), Number(m.choice)); });
  net.on("shopstate", (d) => { if (remoteView) remoteView.setShopState(d.stock); });   // v2.9 商店库存 → 成员面板
  net.on("shop_buy", (m) => { if (host) host.memberShopBuy(Number(m.playerIdx), Number(m.choice)); });
  net.on("checkpoint", (m) => {
    lastCheckpoint = m.players;
    if (remoteView) remoteView.setCheckpoint(m.players, m.warehouse);
    // v2.17 资源包：首次收到完整包时应用，确保联机两端视觉一致
    if (m.assetPack) {
      assetPack.apply(m.assetPack);
      remoteView?.onAssetPackApplied(m.assetPackVersion ?? m.assetPack.version);
    }
  });
  net.on("migrated", (m) => {   // v2.12 房主断线 → 接替通知
    if (m.newHostClientId === net.myClientId) {
      takeOverAsHost(m);
    } else {
      notifyOnline("房主断线，对局由其他成员接替继续");
    }
  });
}

/** v2.12 主机迁移：本成员被指定为新主机 → 凭「本地最新快照 + 地图 + 检查点」恢复为本地主机继续模拟 */
function takeOverAsHost(m: MigratedMsg): void {
  if (state !== "online_client" || !remoteView) return;
  const snap = remoteView.latestSnapshot();
  const mapArr = remoteView.mapArray();
  if (!snap) {
    notifyOnline("接替失败：暂无可用快照，已退出对局");
    exitOnlineToMenu();
    return;
  }
  (window as any).__migrated = true;   // e2e 判定"已接替为主机"
  const layout = currentLayout;
  host = OnlineHostMode.createTakeover(canvas, layout, snap, mapArr, lastCheckpoint);
  host.onSendSnapshot = (s) => { net.hostSnapshot(s); if (peer?.ready()) peer.send({ snap: s }); };
  host.onSendGameOver = (info) => net.hostGameOver(info);
  host.onSendLevelUp = (d) => net.hostLevelUp(d.playerIdx, d.choices);
  host.onShopState = (stock) => net.sendShopState(stock);              // v2.9 商店库存 → 成员
  host.onSendCheckpoint = (p) => net.hostCheckpoint(p.players, p.warehouse, p.assetPack, p.assetPackVersion);                // v2.12 检查点 → 成员 + v2.17 资源包
  remoteView = null;
  lastCheckpoint = null;
  input.setSuppressLocalP2(true);   // 接替后 P1 本地操控（唯一战斗位）
  mobileControls.setEnabled(false);
  netRtt = 0; netJitter = 0; netLatency.reset(); netPingTimer = 0;
  state = "online_host";
  notifyOnline("房主断线，你已接替主机继续对局");
}

function beginOnlineGame(start: { myIndex: number; mode: "endless" | "stage"; players: Array<{ clientId: number; name: string }>; tableId?: number; rejoinToken?: string; orient?: "landscape" | "portrait" }): void {
  // v2.11 存重连卡（断线/刷新后凭 tableId+token 回到原座位）
  if (start.tableId && start.rejoinToken) saveRejoinCard(start.tableId, start.rejoinToken);
  // v2.36 布局对齐（房主/成员统一）：以「房间方向」为准（建房时写入 / 房主在房内 T 切换都会更新）；
  // 无 orient 的旧房间退回本地设备方向选择。修复"两边地图不一样/竖屏显示不全"
  const layout = start.orient === "portrait" ? LAYOUTS.portrait
    : start.orient === "landscape" ? LAYOUTS.landscape
    : pickLayout();
  applyLayout(layout);
  onlineMsg = "";
  paused = false;
  // 新对局重置网络质量统计（从 0 重新采样）
  netRtt = 0; netJitter = 0; netLatency.reset(); netPingTimer = 0;
  input.setSuppressLocalP2(start.myIndex === 0); // 远端玩家接管 P2，屏蔽本地方向键
  mobileControls.setEnabled((settings.mode === "touch" || settings.mode === "mobile" || settings.mode === "tablet") && start.myIndex !== 0);
  if (start.myIndex === 0) {
    // v2.18 引擎支持 1~4 名战斗玩家：真人玩家 + AI座位
    // AI座位索引 = seatStates 中为 "ai" 的座位索引（座位0永远是房主）
    const aiSeats: number[] = [];
    seatStates.forEach((st, i) => { if (st === "ai" && i > 0) aiSeats.push(i); });
    const combatPlayers = Math.min(4, Math.max(1, start.players.length + aiSeats.length));
    host = new OnlineHostMode(canvas, layout, combatPlayers, aiSeats);
    // v2.15 AI队友：房间内开启人机队友后，P2 由 AI 接管（无远端玩家时）
    if (roomBotCount > 0) {
      // 如果座位1是AI，设置P2 AI
      if (seatStates[1] === "ai") host.setAICompanion(true);
      notifyOnline(`已启用 ${roomBotCount} 个人机队友（座位:${aiSeats.map(i=>i+1).join(",")}）`);
    }
    host.onSendSnapshot = (s) => { net.hostSnapshot(s); if (peer?.ready()) peer.send({ snap: s }); };   // v2.10 双发：WS 兜底 + P2P 低延迟
    host.onSendGameOver = (info) => net.hostGameOver(info);
    host.onSendLevelUp = (d) => net.hostLevelUp(d.playerIdx, d.choices);
    host.onShopState = (stock) => net.sendShopState(stock);   // v2.9 商店库存 → 成员
    host.onSendCheckpoint = (p) => net.hostCheckpoint(p.players, p.warehouse, p.assetPack, p.assetPackVersion);     // v2.12 检查点 → 成员（接替续局用）+ v2.17 资源包
    state = "online_host";
  } else {
    remoteView = new RemoteView();
    // 调试句柄（同 __gameLoop 先例）：联机可视化测试（tests/net-snapshot-e2e.mjs）据此读插值状态断言
    (window as any).__remoteView = remoteView;
    remoteView.myIndex = start.myIndex;
    remoteView.playersMeta = start.players;
    remoteView.onPickLevelUp = (playerIdx, choice) => net.pickLevelUp(playerIdx, choice);
    remoteView.onShopBuy = (playerIdx, choice) => net.shopBuy(playerIdx, choice);   // v2.9 成员购买 → 主机结算
    inputSendTimer = 0;  // 进入对局立即发送首帧输入
    remoteLastSig = "";  // 清指纹，保证第一帧即发送
    prevRemoteInteract = false;  // 清 E 键边沿状态
    state = "online_client";
  }
  // v2.10 WebRTC P2P 直连：双人同桌即尝试（同机/局域网优先，失败自动回落 WS）
  peer = tryStartP2P(start);
}

/** 大厅中判断自己是否为房主（net.isHost 只在开局后才为 true，大厅需按座位比较） */
function onlineIsHost(): boolean {
  return onlineCurrent !== null && onlineCurrent.hostClientId === net.myClientId;
}

function handleOnline(dt: number): void {
  if (onlineMsgTimer > 0) onlineMsgTimer -= dt;

  if (input.wasJustPressed("Escape")) {
    if (onlineInTable) { net.leave(); }
    else if (onlineMode !== null) { onlineMode = null; onlineSel = 0; }
    else { net.disconnect(); state = "menu"; }
    return;
  }
  if (input.wasJustPressed("KeyN")) { onlineRename(); return; }
  // 大厅内切换操作方式（键盘/触屏/手柄）：P2（远端手机用户）在进房前/房内都能改
  if (input.wasJustPressed("KeyM")) { onlineCycleControlMode(); return; }

  // 阶段1：选择模式
  if (onlineMode === null) {
    if (input.wasJustPressed("ArrowUp")   || input.wasJustPressed("KeyW") ||
        input.wasJustPressed("ArrowDown") || input.wasJustPressed("KeyS")) {
      onlineModeSel = (onlineModeSel + 1) % 2;
    }
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space") || input.wasJustPressed("KeyQ")) {
      onlineMode = onlineModeSel === 0 ? "endless" : "stage";
      onlineSel = 0;
      getSoundManager().play("pickup");
    }
    return;
  }

  // 阶段2：模式房间大厅（未入桌）
  if (!onlineInTable) {
    const list = onlineTables.filter((t) => t.mode === onlineMode);
    if (input.wasJustPressed("ArrowUp") || input.wasJustPressed("KeyW")) {
      if (list.length) onlineSel = (onlineSel + list.length - 1) % list.length;
    }
    if (input.wasJustPressed("ArrowDown") || input.wasJustPressed("KeyS")) {
      if (list.length) onlineSel = (onlineSel + 1) % list.length;
    }
    if (input.wasJustPressed("KeyC")) { onlineQuickJoin(); return; }
    if (input.wasJustPressed("KeyB")) { onlineCreateTable(); return; }   // v2.25 一键新建房间
    if (input.wasJustPressed("KeyT")) { onlineToggleOrient(); return; }  // v2.35 切换房间方向（横屏/竖屏）
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space")) {
      const t = list[onlineSel];
      if (t) onlineJoin(t);
      else onlineQuickJoin();   // v2.25 列表为空 → 快速加入会自动开房（不再出现"暂无可用房间"）
      return;
    }
  } else {
    // 阶段3：桌内（准备 / 房主开始 / 邀请）
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space")) { onlineToggleReady(); return; }
    if (input.wasJustPressed("KeyS") && onlineIsHost()) { onlineStartGame(); return; }
    if (input.wasJustPressed("KeyY") && onlineCurrent) { onlineCopyInvite(); return; }
    // v2.36 房主在房间内也可切换房间方向（横屏/竖屏），实时广播给成员
    if (input.wasJustPressed("KeyT") && onlineIsHost()) { onlineToggleOrient(); return; }
    if (input.wasJustPressed("KeyU") && onlineCurrent) {
      const cur = getPublicHost() ?? "";
      // v3.0.2：公网 **IP（带端口）** 也能填 —— 无域名的部署形态靠它分享（如 203.0.113.9:3001）
      const nn = prompt("设置公网入口（域名如 27201307.r29.cpolar.top，或 IP:端口如 203.0.113.9:3001），留空清除：", cur);
      if (nn !== null) { setPublicHost(nn.trim() || null); notifyOnline(nn.trim() ? "公网入口已设置，邀请链接将用它" : "已清除公网入口"); }
      return;
    }
  }
}

function renderOnline(W: number, H: number): void {
  const now = performance.now();
  // 美化背景
  drawMenuBackground(renderer, W, H, now);
  lobbyButtons = []; // 每帧重新注册可点击区域

  // 标题
  drawThemedTitle(renderer.ctx, "联 机 大 厅", W / 2, 36, {
    color: "#ffd700", fontSize: W > 700 ? 24 : 20, width: 240, align: "center",
  });
  renderer.ctx.save();
  renderer.ctx.font = "11px monospace";
  renderer.ctx.fillStyle = "#8a9bb8";
  renderer.ctx.textAlign = "center";
  renderer.ctx.fillText(
    `联机服 ${describeServer()} · 昵称:${onlineName}(按N改名) · 操作:${MODE_LABELS[settings.mode]}(按M切换)`,
    W / 2, 72,
  );
  renderer.ctx.restore();
  drawLobbyButton(W - 46, 10, 36, 28, "⛶", "#111", "#555", "#9cf", () => { void toggleFullscreen(); });

  // ── 阶段1：选择模式 ──
  if (onlineMode === null) {
    const modes = [
      { label: "无尽模式", subLabel: "连续刷怪·坚守基地", icon: "∞" },
      { label: "闯关模式", subLabel: "章节BOSS·阶段奖励", icon: "🏰" },
    ];
    modes.forEach((m, i) => {
      const bw = Math.min(440, W - 40);
      const bx = W / 2 - bw / 2;
      const by = 130 + i * 56;
      drawMenuOption(renderer.ctx, bx, by, bw, 48, m, i === onlineModeSel, i);
      lobbyButtons.push({ x: bx, y: by, w: bw, h: 48, onTap: () => {
        onlineMode = i === 0 ? "endless" : "stage";
        onlineSel = 0;
        getSoundManager().play("pickup");
      }});
    });
    drawHintBar(renderer.ctx, W, H, [
      "↑/↓ 选择模式   Enter 进入该模式房间",
      "Esc 返回主菜单",
    ]);
    // v2.15 触屏返回主菜单按钮（手机端无ESC键）
    drawLobbyButton(W / 2 - 80, H - 90, 160, 36, "← 返回主菜单",
      "#2a1a1a", "#f66", "#faa", () => {
        exitOnlineToMenu();
        getSoundManager().play("pickup");
      });
    if (onlineMsgTimer > 0) {
      renderer.ctx.save();
      renderer.ctx.font = "14px monospace";
      renderer.ctx.fillStyle = "#ffd700";
      renderer.ctx.textAlign = "center";
      renderer.ctx.shadowColor = "#ffd700";
      renderer.ctx.shadowBlur = 6;
      renderer.ctx.fillText(onlineMsg, W / 2, H - 60);
      renderer.ctx.restore();
    }
    return;
  }

  const modeLabel = onlineMode === "stage" ? "闯关" : "无尽";
  renderer.ctx.save();
  renderer.ctx.font = "bold 14px monospace";
  renderer.ctx.fillStyle = "#00d4ff";
  renderer.ctx.textAlign = "center";
  renderer.ctx.shadowColor = "#00d4ff";
  renderer.ctx.shadowBlur = 4;
  renderer.ctx.fillText(`${modeLabel}模式 · 房间大厅（每桌 1~4 人）· 点击房间直接加入`, W / 2, 98);
  renderer.ctx.restore();

  // 该模式房间列表（左侧）
  const filtered = onlineTables.filter((t) => t.mode === onlineMode);
  let ly = 118;
  renderer.ctx.save();
  renderer.ctx.font = "bold 13px monospace";
  renderer.ctx.fillStyle = "#4a9eff";
  renderer.ctx.textAlign = "left";
  renderer.ctx.fillText(`房间列表（${filtered.length} 桌）:`, 20, ly);
  renderer.ctx.restore();
  ly += 18;
  const listW = Math.max(300, Math.floor(W * 0.5));
  if (filtered.length === 0) {
    renderer.ctx.save();
    renderer.ctx.font = "13px monospace";
    renderer.ctx.fillStyle = "#7fa0c8";
    renderer.ctx.fillText("正在准备房间列表…（点底部「＋ 新建房间」可直接开房，不会无房可加）", 20, ly);
    renderer.ctx.restore();
  }
  filtered.forEach((t, i) => {
    const sel = i === onlineSel && !onlineInTable;
    const seats = t.seats.filter((s) => s).length;
    const readyTxt = t.seats.filter((s) => s && s.ready).length;
    const empty = seats === 0;
    // 美化房间项
    if (sel) {
      renderer.ctx.fillStyle = "rgba(26,37,72,0.9)";
    } else {
      renderer.ctx.fillStyle = "rgba(14,18,32,0.7)";
    }
    renderer.ctx.fillRect(16, ly, listW, 36);
    if (sel) {
      renderer.ctx.strokeStyle = "#ffd700";
      renderer.ctx.lineWidth = 1.5;
      renderer.ctx.shadowColor = "#ffd700";
      renderer.ctx.shadowBlur = 6;
      renderer.ctx.strokeRect(16.5, ly + 0.5, listW - 1, 35);
      renderer.ctx.shadowBlur = 0;
      // 左侧指示条
      renderer.ctx.fillStyle = "#ffd700";
      renderer.ctx.fillRect(16, ly + 4, 3, 28);
    } else {
      renderer.ctx.strokeStyle = "#1e2840";
      renderer.ctx.lineWidth = 1;
      renderer.ctx.strokeRect(16.5, ly + 0.5, listW - 1, 35);
    }
    // 房间名
    renderer.ctx.save();
    renderer.ctx.font = "bold 13px monospace";
    renderer.ctx.fillStyle = sel ? "#e8eef7" : "#c0c8d8";
    renderer.ctx.textAlign = "left";
    renderer.ctx.fillText(`${t.name}${empty ? "  [空桌]" : ""}${t.hostName ? `  (${t.hostName})` : ""}`, 26, ly + 12);
    renderer.ctx.restore();
    // 状态
    const stateColor = t.state === "playing" ? "#ff8888" : empty ? "#556680" : "#7cff7c";
    renderer.ctx.save();
    renderer.ctx.font = "11px monospace";
    renderer.ctx.fillStyle = stateColor;
    renderer.ctx.fillText(`座位 ${seats}/4  准备 ${readyTxt}/4  ${t.state === "playing" ? "对局中" : empty ? "空桌" : "等待中"}`, 26, ly + 27);
    renderer.ctx.restore();
    if (!onlineInTable) lobbyButtons.push({ x: 16, y: ly, w: listW, h: 36, onTap: () => onlineJoin(t) });
    ly += 40;
  });

  // 当前座位（右侧：麻将桌风格）
  if (onlineInTable && onlineCurrent) {
    const px = Math.min(W - 20, 16 + listW + 24);
    const py = 118;
    const panelW = W - px - 16;
    const panelH = Math.max(280, H - 200);

    // 房间信息面板背景
    renderer.ctx.fillStyle = "rgba(10,14,28,0.85)";
    renderer.ctx.fillRect(px - 8, py - 8, panelW, panelH);
    renderer.ctx.strokeStyle = "#2e3d5c";
    renderer.ctx.lineWidth = 1;
    renderer.ctx.strokeRect(px - 7.5, py - 7.5, panelW - 1, panelH - 1);

    // 房间标题
    renderer.ctx.save();
    renderer.ctx.font = "bold 13px monospace";
    renderer.ctx.fillStyle = "#ffd700";
    renderer.ctx.textAlign = "center";
    renderer.ctx.shadowColor = "#ffd700";
    renderer.ctx.shadowBlur = 4;
    renderer.ctx.fillText(`${onlineCurrent.name}`, px + panelW / 2, py + 8);
    renderer.ctx.restore();
    renderer.ctx.save();
    renderer.ctx.font = "10px monospace";
    renderer.ctx.fillStyle = "#8a9bb8";
    renderer.ctx.textAlign = "center";
    renderer.ctx.fillText(`${onlineCurrent.mode === "stage" ? "闯关" : "无尽"} · ${onlineCurrent.hostName} 的房`, px + panelW / 2, py + 22);
    renderer.ctx.restore();

    // ── v2.15 房间操作区：邀请按钮 + AI队友增减（明显位置，所有玩家可见）──
    const actionY = py + 32;
    const actionCx = px + panelW / 2;
    const isHost = onlineIsHost();

    // 邀请按钮（所有玩家可见可点击）
    const inviteBtnW = Math.min(140, panelW - 20);
    const inviteBtnX = actionCx - inviteBtnW / 2;
    drawLobbyButton(inviteBtnX, actionY, inviteBtnW, 26, "📋 复制邀请链接",
      "#0f1f2a", "#4af", "#9df", () => {
        onlineCopyInvite();
      });

    // AI队友状态显示（通过点击座位轮换：开放→AI→关闭）
    const botY = actionY + 32;
    const botCx = actionCx;
    const aiCount = seatStates.filter(st => st === "ai").length;
    const closedCount = seatStates.filter(st => st === "closed").length;
    renderer.ctx.save();
    renderer.ctx.font = "10px monospace";
    renderer.ctx.fillStyle = "#8af";
    renderer.ctx.textAlign = "center";
    renderer.ctx.fillText(`🤖 AI:${aiCount}  🚫关闭:${closedCount}  (房主点座位轮换)`, botCx, botY + 10);
    renderer.ctx.restore();

    // ── 麻将桌：椭圆形桌子 + 4个方位座位 ──
    const tableCx = px + panelW / 2;
    const tableCy = py + panelH / 2 + 30;  // v2.15 往下移，避免与顶部操作区重叠
    const tableRx = Math.min(panelW * 0.38, 110);
    const tableRy = Math.min(panelH * 0.25, 60);

    // 桌子阴影
    renderer.ctx.fillStyle = "rgba(0,0,0,0.4)";
    if (typeof renderer.ctx.ellipse === "function") {
      renderer.ctx.beginPath();
      renderer.ctx.ellipse(tableCx + 3, tableCy + 3, tableRx, tableRy, 0, 0, Math.PI * 2);
      renderer.ctx.fill();
    }

    // 桌子主体（渐变）
    if (typeof renderer.ctx.createRadialGradient === "function") {
      const tg = renderer.ctx.createRadialGradient(tableCx, tableCy, 0, tableCx, tableCy, tableRx);
      tg.addColorStop(0, "#2a4a3a");
      tg.addColorStop(0.7, "#1a3a2a");
      tg.addColorStop(1, "#0a2a1a");
      renderer.ctx.fillStyle = tg;
    } else {
      renderer.ctx.fillStyle = "#1a3a2a";
    }
    if (typeof renderer.ctx.ellipse === "function") {
      renderer.ctx.beginPath();
      renderer.ctx.ellipse(tableCx, tableCy, tableRx, tableRy, 0, 0, Math.PI * 2);
      renderer.ctx.fill();
      // 桌子边框（金色）
      renderer.ctx.strokeStyle = "#c8a040";
      renderer.ctx.lineWidth = 3;
      renderer.ctx.stroke();
      // 内边框
      renderer.ctx.strokeStyle = "rgba(255,220,100,0.3)";
      renderer.ctx.lineWidth = 1;
      renderer.ctx.beginPath();
      renderer.ctx.ellipse(tableCx, tableCy, tableRx - 6, tableRy - 6, 0, 0, Math.PI * 2);
      renderer.ctx.stroke();
    }

    // 桌子中心文字
    renderer.ctx.save();
    renderer.ctx.font = "bold 11px monospace";
    renderer.ctx.fillStyle = "rgba(255,220,100,0.5)";
    renderer.ctx.textAlign = "center";
    renderer.ctx.textBaseline = "middle";
    renderer.ctx.fillText("准备中", tableCx, tableCy);
    renderer.ctx.restore();

    // 4个座位位置：上、右、下、左
    const seatPositions = [
      { x: tableCx, y: tableCy - tableRy - 28, align: "center" },  // 上
      { x: tableCx + tableRx + 28, y: tableCy, align: "left" },     // 右
      { x: tableCx, y: tableCy + tableRy + 28, align: "center" },    // 下
      { x: tableCx - tableRx - 28, y: tableCy, align: "right" },     // 左
    ];

    onlineCurrent.seats.forEach((s, i) => {
      const pos = seatPositions[i];
      if (!pos) return;

      const isHostSeat = s && s.clientId === onlineCurrent!.hostClientId;
      const isMe = s && s.clientId === net.myClientId;
      const ready = s?.ready ?? false;

      // 座位背景
      const seatW = 72;
      const seatH = 44;
      let seatX = pos.x - seatW / 2;
      if (pos.align === "left") seatX = pos.x - 4;
      if (pos.align === "right") seatX = pos.x - seatW + 4;
      const seatY = pos.y - seatH / 2;

      if (!s) {
        const seatState = seatStates[i];
        if (seatState === "closed") {
          // 被关闭的座位：红色叉号
          renderer.ctx.save();
          renderer.ctx.fillStyle = "rgba(60,20,20,0.6)";
          renderer.ctx.fillRect(seatX, seatY, seatW, seatH);
          renderer.ctx.strokeStyle = "rgba(200,60,60,0.6)";
          renderer.ctx.lineWidth = 1;
          renderer.ctx.strokeRect(seatX + 0.5, seatY + 0.5, seatW - 1, seatH - 1);
          // 叉号
          renderer.ctx.strokeStyle = "#f66";
          renderer.ctx.lineWidth = 3;
          renderer.ctx.beginPath();
          renderer.ctx.moveTo(seatX + seatW / 2 - 8, seatY + seatH / 2 - 8);
          renderer.ctx.lineTo(seatX + seatW / 2 + 8, seatY + seatH / 2 + 8);
          renderer.ctx.moveTo(seatX + seatW / 2 + 8, seatY + seatH / 2 - 8);
          renderer.ctx.lineTo(seatX + seatW / 2 - 8, seatY + seatH / 2 + 8);
          renderer.ctx.stroke();
          renderer.ctx.font = "9px monospace";
          renderer.ctx.fillStyle = "#f66";
          renderer.ctx.textAlign = "center";
          renderer.ctx.fillText("已关闭", pos.x, seatY + seatH + 10);
          renderer.ctx.restore();
        } else if (seatState === "ai") {
          // AI队友座位：蓝色边框 + 🤖图标
          renderer.ctx.save();
          renderer.ctx.fillStyle = "rgba(20,30,60,0.8)";
          renderer.ctx.fillRect(seatX, seatY, seatW, seatH);
          renderer.ctx.strokeStyle = "#4af";
          renderer.ctx.lineWidth = 2;
          renderer.ctx.shadowColor = "#4af";
          renderer.ctx.shadowBlur = 6;
          renderer.ctx.strokeRect(seatX + 0.5, seatY + 0.5, seatW - 1, seatH - 1);
          renderer.ctx.shadowBlur = 0;
          // AI图标
          renderer.ctx.font = "bold 16px monospace";
          renderer.ctx.fillStyle = "#4af";
          renderer.ctx.textAlign = "center";
          renderer.ctx.textBaseline = "middle";
          renderer.ctx.fillText("🤖", pos.x, pos.y - 4);
          renderer.ctx.font = "9px monospace";
          renderer.ctx.fillStyle = "#8af";
          renderer.ctx.fillText("AI队友", pos.x, seatY + seatH + 10);
          renderer.ctx.restore();
        } else {
          // 开放座位：虚线框，等待玩家加入
          renderer.ctx.save();
          renderer.ctx.strokeStyle = "rgba(100,200,100,0.5)";
          renderer.ctx.lineWidth = 1;
          renderer.ctx.setLineDash([3, 3]);
          renderer.ctx.strokeRect(seatX, seatY, seatW, seatH);
          renderer.ctx.setLineDash([]);
          renderer.ctx.font = "10px monospace";
          renderer.ctx.fillStyle = "rgba(100,200,100,0.6)";
          renderer.ctx.textAlign = "center";
          renderer.ctx.textBaseline = "middle";
          renderer.ctx.fillText(`+邀请`, pos.x, pos.y);
          renderer.ctx.font = "8px monospace";
          renderer.ctx.fillStyle = "rgba(100,200,100,0.4)";
          renderer.ctx.fillText(`空位${i + 1}`, pos.x, seatY + seatH + 8);
          renderer.ctx.restore();
        }
        // 房主点击空座位轮换状态：开放 → AI → 关闭 → 开放
        if (isHost) {
          lobbyButtons.push({ x: seatX, y: seatY, w: seatW, h: seatH, onTap: () => {
            const cur = seatStates[i];
            if (cur === "open") seatStates[i] = "ai";
            else if (cur === "ai") seatStates[i] = "closed";
            else seatStates[i] = "open";
            // 同步更新 roomBotCount（AI座位数量）
            roomBotCount = seatStates.filter(st => st === "ai").length;
            getSoundManager().play("pickup");
          }});
        }
      } else {
        // 有玩家的座位
        const borderColor = ready ? "#39d94a" : (isMe ? "#4af" : "#5a6a8a");
        const bgColor = ready ? "rgba(20,60,30,0.8)" : "rgba(20,30,50,0.8)";

        renderer.ctx.fillStyle = bgColor;
        renderer.ctx.fillRect(seatX, seatY, seatW, seatH);
        renderer.ctx.strokeStyle = borderColor;
        renderer.ctx.lineWidth = ready ? 2 : 1;
        if (ready) {
          renderer.ctx.shadowColor = "#39d94a";
          renderer.ctx.shadowBlur = 4;
        }
        renderer.ctx.strokeRect(seatX + 0.5, seatY + 0.5, seatW - 1, seatH - 1);
        renderer.ctx.shadowBlur = 0;

        // 玩家头像（圆形）
        const avatarColor = isMe ? "#4af" : (isHostSeat ? "#fd0" : "#8af");
        renderer.ctx.fillStyle = avatarColor;
        if (typeof renderer.ctx.arc === "function") {
          renderer.ctx.beginPath();
          renderer.ctx.arc(seatX + 14, seatY + 16, 9, 0, Math.PI * 2);
          renderer.ctx.fill();
        } else {
          renderer.ctx.fillRect(seatX + 5, seatY + 7, 18, 18);
        }
        // 头像内文字
        renderer.ctx.save();
        renderer.ctx.font = "bold 10px monospace";
        renderer.ctx.fillStyle = "#fff";
        renderer.ctx.textAlign = "center";
        renderer.ctx.textBaseline = "middle";
        renderer.ctx.fillText(`P${i + 1}`, seatX + 14, seatY + 16);
        renderer.ctx.restore();

        // 玩家名字
        renderer.ctx.save();
        renderer.ctx.font = "10px monospace";
        renderer.ctx.fillStyle = ready ? "#8f8" : "#c0c8d8";
        renderer.ctx.textAlign = "left";
        renderer.ctx.textBaseline = "top";
        const nameStr = s.name.length > 6 ? s.name.slice(0, 6) + "…" : s.name;
        renderer.ctx.fillText(nameStr, seatX + 26, seatY + 6);
        // 标识
        let tag = "";
        if (isHostSeat) tag += "👑";
        if (isMe) tag += "←你";
        if (tag) {
          renderer.ctx.font = "9px monospace";
          renderer.ctx.fillStyle = "#fd0";
          renderer.ctx.fillText(tag, seatX + 26, seatY + 18);
        }
        // 准备状态
        renderer.ctx.font = "9px monospace";
        renderer.ctx.fillStyle = ready ? "#39d94a" : "#888";
        renderer.ctx.fillText(ready ? "✓ 已准备" : "未准备", seatX + 26, seatY + 30);
        renderer.ctx.restore();
      }
    });

    // 操作提示（底部）
    const hintY = py + panelH - 30;
    renderer.ctx.save();
    renderer.ctx.font = "10px monospace";
    renderer.ctx.fillStyle = "#ffaa00";
    renderer.ctx.textAlign = "center";
    renderer.ctx.fillText(onlineIsHost() ? "点「开始」开局（其他人需已准备）" : "点「准备」后等待房主开始", px + panelW / 2, hintY);
    renderer.ctx.fillStyle = "#4a9eff";
    renderer.ctx.fillText("Y 复制邀请链接 / U 设置公网入口（域名或 IP:端口） / T 房间方向（房主）", px + panelW / 2, hintY + 14);
    renderer.ctx.restore();
  }

  // ── 底部：桌内 = 邀请分享 + 准备/开始/离开按钮；大厅 = 开桌/改名按钮 + 键位说明 ──
  if (onlineInTable && onlineCurrent) {
    // 邀请链接预览
    const url = buildInviteUrl(onlineCurrent.id);
    const maxChars = Math.max(24, Math.floor(W / 7.2));
    const shown = url
      ? (url.length > maxChars ? url.slice(0, maxChars) + "…" : url)
      : "（未配置公网入口且无局域网地址，按 U 设置公网入口）";
    const isPub = !!serverPublicOrigin || !!serverPublicHost || !!getPublicOrigin();
    renderer.ctx.save();
    renderer.ctx.font = "11px monospace";
    renderer.ctx.fillStyle = isPub ? "#8fff8f" : "#ffaa00";
    renderer.ctx.textAlign = "center";
    renderer.ctx.fillText(isPub
      ? "邀请链接 · 稳定入口（换域名/换 IP 自动匹配，远程好友可访问）："
      : "邀请链接 · 稳定入口·局域网（仅同 WiFi；服务器有公网入口后自动切换）：",
      W / 2, H - 134);
    renderer.ctx.fillStyle = "#66ccff";
    renderer.ctx.fillText(shown, W / 2, H - 118);
    renderer.ctx.restore();

    // v2.36 房间方向（房主可实时更改并广播；成员只读显示，进入对局时双方按此对齐）
    {
      const curOrient = (onlineCurrent.orient ?? "landscape") === "portrait" ? "竖屏 📱" : "横屏 🖥";
      if (onlineIsHost()) {
        drawLobbyButton(W / 2 - 140, H - 170, 280, 26, `房间方向：${curOrient}（T 键更改）`,
          "#1a1020", "#a6f", "#c9f", onlineToggleOrient);
      } else {
        drawLobbyButton(W / 2 - 140, H - 170, 280, 26, `房间方向：${curOrient}（由房主设定）`,
          "#14141c", "#555", "#999", () => {});
      }
    }

    drawLobbyButton(W / 2 - 140, H - 100, 280, 30, "📋 复制邀请链接 · 发给好友",
      "#102033", "#4af", "#9df", onlineCopyInvite);

    // 准备 / 开始 / 离开
    const mySeatNow = onlineCurrent.seats.find((s) => s && s.clientId === net.myClientId);
    const myReadyNow = !!mySeatNow?.ready;
    const isHost = onlineIsHost();
    const btnW = Math.min(150, Math.floor((W - 40) / 3) - 8);
    const gap = 8;
    const bx = W / 2 - (btnW * 3 + gap * 2) / 2;
    drawLobbyButton(bx, H - 58, btnW, 28, myReadyNow ? "取消准备" : "✅ 准备",
      "#12210f", "#4f4", "#cfc", onlineToggleReady);
    if (isHost) {
      drawLobbyButton(bx + btnW + gap, H - 58, btnW, 28, "▶ 开始游戏 (S)",
        "#221a05", "#fd0", "#ffd75e", onlineStartGame);
    } else {
      drawLobbyButton(bx + btnW + gap, H - 58, btnW, 28, "等待房主开始…",
        "#181818", "#333", "#777", () => {});
    }
    drawLobbyButton(bx + (btnW + gap) * 2, H - 58, btnW, 28, "← 离开房间",
      "#21100f", "#f66", "#faa", onlineLeaveTable);
  } else {
    // v2.25 四按钮响应式排布（竖屏 480 宽也不出屏）：返回 / 快速加入（自动开房）/ 新建房间 / 改名
    const obW = Math.min(150, Math.floor((W - 32) / 4) - 8);
    const obGap = 8;
    const obX = W / 2 - (obW * 4 + obGap * 3) / 2;
    // v2.35 房间方向切换（横屏/竖屏）：建房时写入房间，成员端自动对齐
    drawLobbyButton(W / 2 - 140, H - 140, 280, 26, `房间方向：${menuOrient === 1 ? "竖屏 📱" : "横屏 🖥"}（T 键切换）`, "#1a1020", "#a6f", "#c9f", onlineToggleOrient);
    drawLobbyButton(obX, H - 104, obW, 30, "← 主菜单", "#2a1a1a", "#f66", "#faa", exitOnlineToMenu);
    drawLobbyButton(obX + (obW + obGap), H - 104, obW, 30, "⚡ 快速加入/开房 (C)", "#0f1f14", "#4af", "#9df", onlineQuickJoin);
    drawLobbyButton(obX + (obW + obGap) * 2, H - 104, obW, 30, "＋ 新建房间 (B)", "#102a1a", "#4f8", "#afd", onlineCreateTable);
    drawLobbyButton(obX + (obW + obGap) * 3, H - 104, obW, 30, "✏️ 改昵称 (N)", "#1c1c2b", "#a86", "#dba", onlineRename);

    drawHintBar(renderer.ctx, W, H, [
      "↑/↓ 选桌   Enter/点击 加入   C 快速加入（没房会自动开一桌）   B 新建房间   T 房间方向   N 改名   Esc 返回模式选择",
      "座位 1~2 = 战斗玩家（P1 主机 / P2 成员）· 座位 3~4 = 观战成员；人机队友需房主在房间内手动添加",
    ]);
  }
  if (onlineMsgTimer > 0) {
    renderer.ctx.save();
    renderer.ctx.font = "14px monospace";
    renderer.ctx.fillStyle = "#ffd700";
    renderer.ctx.textAlign = "center";
    renderer.ctx.shadowColor = "#ffd700";
    renderer.ctx.shadowBlur = 6;
    renderer.ctx.fillText(onlineMsg, W / 2, H - 18);
    renderer.ctx.restore();
  }
}

function update(dt: number): void {
  // 每帧读取手柄状态（仅当有手柄时生效）
  if (state === "playing_endless" || state === "playing_stage" || state === "menu") {
    gamepadAdapter.poll();
  }

  // v2.6.3 画面控制快捷键（任意状态可用）：O 全屏切换 / = 放大 / − 缩小
  if (input.wasJustPressed("KeyO")) { void toggleFullscreen(); }
  if (input.wasJustPressed("Equal")) adjustZoom(1);
  if (input.wasJustPressed("Minus")) adjustZoom(-1);
  // v2.18 F3 切换联机成员端调试面板（默认关闭，避免显示高精度调试数据）
  if (input.wasJustPressed("F3") && remoteView) { remoteView.toggleDebug(); }

  // ESC toggles pause in all gameplay modes
  if (input.wasJustPressed("Escape")) {
    if (isGameplayState()) {
      const wasPaused = paused;
      paused = !paused;
      // v2.35 成员端：从暂停恢复时把插值器对齐到最新帧，消除"回放 5~10 秒前画面"
      if (wasPaused && !paused && remoteView) remoteView.flushInterp();
    }
  }

  // During pause: Enter/Space returns to menu, S opens settings, ESC continues
  if (paused) {
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space")) {
      quitCurrentGame();
    } else if (input.wasJustPressed("KeyS")) {
      settingsFromPause = true;
      paused = false;
      state = "settings";
    }
    input.flush();
    return;
  }

  if (state === "settings") {
    if (input.wasJustPressed("ArrowUp")   || input.wasJustPressed("KeyW")) settingsSel = (settingsSel + SETTINGS_ROWS - 1) % SETTINGS_ROWS;
    if (input.wasJustPressed("ArrowDown") || input.wasJustPressed("KeyS")) settingsSel = (settingsSel + 1) % SETTINGS_ROWS;
    if (input.wasJustPressed("ArrowLeft") || input.wasJustPressed("KeyA")) changeSettings(-1);
    if (input.wasJustPressed("ArrowRight") || input.wasJustPressed("KeyD")) changeSettings(1);
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space") ||
        input.wasJustPressed("Escape") || input.wasJustPressed("Backspace")) {
      applySettings();
      if (settingsFromPause) {
        settingsFromPause = false;
        if (endless) { paused = true; state = "playing_endless"; }
        else if (stage) { paused = true; state = "playing_stage"; }
        else if (test) { paused = true; state = "playing_test"; }
        else if (host) { paused = true; state = "online_host"; }
        else if (remoteView) { paused = true; state = "online_client"; }
        else state = "menu";
      } else {
        state = "menu";
      }
    }
    input.flush();
    return;
  }

  if (state === "menu") {
    if (input.wasJustPressed("ArrowUp")   || input.wasJustPressed("KeyW")) menuSel = (menuSel + 4) % 5;
    if (input.wasJustPressed("ArrowDown") || input.wasJustPressed("KeyS")) menuSel = (menuSel + 1) % 5;
    if (input.wasJustPressed("ArrowLeft") || input.wasJustPressed("ArrowRight")) {
      // v2.15 移除人机队友选项，左右键统一切换屏幕方向
      menuOrient = (menuOrient + 1) % 2;
      settings.orient = menuOrient;
      orientTouched = true;
    }
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space") || input.wasJustPressed("KeyQ")) {
      if (menuSel === 4) { settingsFromPause = false; state = "settings"; }
      else if (menuSel === 3) { enterOnline(); }
      else startGame(menuSel);
    }
  } else if (state === "online") {
    handleOnline(dt);
  } else if (state === "online_host" && host) {
    if (!paused) {
      // 联机主机：升级选项也走按键（P1=T/Y/U，P2=小键盘7/8/9），与单机一致
      if (host.pendingLevelUp) {
        const keys = levelUpKeysFor(host.pendingLevelUp.playerIdx);
        keys.forEach((k, i) => { if (input.wasJustPressed(k)) host!.chooseLevelUpAbility(i); });
      }
      netPingTick(dt);
      host.netHud = { rtt: netRtt, jitter: netJitter };   // 网络质量写入 HUD
      host.update(dt);
    }
  } else if (state === "online_client" && remoteView) {
    if (!paused && net.connected) {
      netPingTick(dt);
      remoteView.netHud = { rtt: netRtt, jitter: netJitter };  // 网络质量写入 HUD
      // 远端发送策略：
      //  1) 帧号用"客户端固定步进帧号"（performance.now/16.7ms，非 rAF 帧计数），
      //     与主机 60Hz 世界时间解耦，主机按序消费、丢帧有兜底。
      //  2) 按键状态变化 → 绕过节流立即发送（低延迟手感）；
      //     状态稳定 → 每 30Hz 保活一次（防丢包+维持主机输入新鲜度）。
      const inp = { ...input.peekP1() };          // 含触屏/手柄合并结果
      // v2.14.1 成员端 E 键边沿：开/关基地商店（本地 UI，无需上送主机的"打开"意图）
      // v2.16 E 键也可关闭仓库/背包查看面板
      if (inp.interact && !prevRemoteInteract && remoteView) {
        if (remoteView.warehouseOpen || remoteView.backpackOwner !== null) {
          remoteView.warehouseOpen = false;
          remoteView.backpackOwner = null;
        } else {
          remoteView.toggleShop();
        }
      }
      prevRemoteInteract = inp.interact;
      // v2.22 成员端触屏"背包"/"仓库"按钮边沿：本地打开/关闭自己的背包/仓库查看面板
      // （与信息栏按钮同一套 UI；这两个标志不进发送包，主机端 P2 的 inventory 只会上演"主机屏误弹 P2 背包"）
      if (inp.inventory && !prevMemberInvHeld && remoteView) {
        remoteView.backpackOwner = remoteView.backpackOwner === remoteView.myIndex ? null : remoteView.myIndex;
        remoteView.warehouseOpen = false;
      }
      prevMemberInvHeld = inp.inventory;
      if (inp.warehouse && !prevMemberWhHeld && remoteView) {
        remoteView.warehouseOpen = !remoteView.warehouseOpen;
        remoteView.backpackOwner = null;
      }
      prevMemberWhHeld = inp.warehouse;
      // P2 本地预测：把本地方向输入写入 RemoteView（run-ahead 预测 + 权威校正）
      remoteView.myInputPref = { up: inp.up, down: inp.down, left: inp.left, right: inp.right };
      // v2.31 成员端：点击侧栏炮筒标签 → 一次性强制上送 selectCannon（绕过节流，主机直选切炮）
      let forceSend = false;
      if (remoteView.pendingCannonSelect >= 0) {
        inp.selectCannon = remoteView.pendingCannonSelect;
        remoteView.pendingCannonSelect = -1;
        forceSend = true;
      }
      // v2.35 成员端：底部炮筒按钮（虚拟按键 c0-c3）选择变化 → 强制上送（指纹不含 selectCannon）
      if (inp.selectCannon >= 0 && inp.selectCannon !== remoteLastSelectCannon) {
        remoteLastSelectCannon = inp.selectCannon;
        forceSend = true;
      } else if (inp.selectCannon < 0) {
        remoteLastSelectCannon = -1;
      }
      const frame = clientInputFrame();
      const sig = inputSig(inp);
      const changed = sig !== remoteLastSig;
      inputSendTimer -= dt;
      if (changed || forceSend || inputSendTimer <= 0) {
        inputSendTimer = INPUT_SEND_INTERVAL;
        remoteLastSig = sig;
        // v2.22 背包/仓库标志已在本地处理，上送时清零（主机只认 P1 的这两个标志）
        net.sendInput({ ...inp, inventory: false, warehouse: false }, frame);
      }
    }
  } else if ((state === "online_host" && host?.isOver) || (state === "online_client" && remoteView?.isOver())) {
    // v2.21 联机对局结束（基地被摧毁/全员阵亡）：Enter/Space 返回大厅（不关闭连接）
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space")) {
      returnToOnlineLobby();
    }
  } else if (state === "playing_endless" && endless) {
    // Level-up choices processed even when paused
    if (endless.pendingLevelUp) {
      const keys = levelUpKeysFor(endless.pendingLevelUp.playerIdx);
      keys.forEach((k, i) => { if (input.wasJustPressed(k)) endless!.chooseLevelUpAbility(i); });
    }
    if (!paused) {
      endless.update(dt);
      if (endless.isOver) { paused = false; state = "gameover"; }
    }
  } else if (state === "playing_test" && test) {
    if (!paused) test.update(dt);
  } else if (state === "playing_stage" && stage) {
    // Level-up choices processed even when paused
    if (stage.pendingLevelUp) {
      const keys = levelUpKeysFor(stage.pendingLevelUp.playerIdx);
      keys.forEach((k, i) => { if (input.wasJustPressed(k)) stage!.chooseLevelUpAbility(i); });
    }
    if (!paused) {
      stage.update(dt);
      if (stage.isOver || stage.isWin) { paused = false; state = "gameover"; }
    }
  } else if (state === "gameover") {
    if (input.wasJustPressed("Enter") || input.wasJustPressed("Space")) {
      // Enter/Space = 重新开始（同按钮 "restart"）
      if (endless) { endless = new EndlessMode(canvas, currentLayout); state = "playing_endless"; }
      else if (stage) { stage = new StageMode(canvas, currentLayout); state = "playing_stage"; }
      paused = false;
    }
    if (input.wasJustPressed("Escape")) {
      endless = null; stage = null; paused = false; state = "menu";
    }
  }
  input.flush();
}

function render(_alpha: number): void {
  const now = performance.now();
  const W = currentLayout.canvasW;
  const H = currentLayout.canvasH;
  lobbyButtons = []; // 每帧重置可点击区域（所有状态共用）
  // v2.19 统一管理全局虚拟控件：仅联机客户端（RemoteView 无自带 MobileControls）需要；
  // 菜单/设置/大厅/主机/单机（GameModeCore 自带 mobile）一律禁用，避免拦截 UI 触摸
  {
    const touchMode = settings.mode === "mobile" || settings.mode === "tablet" || settings.mode === "touch";
    const inGame = state === "online_host" || state === "online_client"
      || state === "playing_endless" || state === "playing_stage" || state === "playing_test";
    // UI 覆盖层（菜单/设置/大厅/暂停）：所有 MobileControls 实例放行触摸，保证按钮可点
    // v2.35 成员端：背包/仓库/商店面板打开时同样放行触摸（避免拖拽被虚拟摇杆劫持）
    const memberPanelOpen = state === "online_client" && remoteView !== null
      && (remoteView.backpackOwner !== null || remoteView.warehouseOpen || remoteView.shopOpen);
    MobileControls.uiOverlayActive = !inGame || paused || memberPanelOpen;
    // v2.19 设置中的虚拟按键显示开关
    MobileControls.showVirtual = settings.showVirtualControls;
    const shouldEnable = state === "online_client" && touchMode && !paused;
    if (mobileControls.enabled !== shouldEnable) mobileControls.setEnabled(shouldEnable);
    // v2.31 联机成员：虚拟炮筒按钮高亮跟随本机当前炮筒（快照 activeCannon 同步）
    if (state === "online_client" && remoteView) MobileControls.activeCannon = remoteView.myActiveCannon;
  }
  if (state === "menu") {
    renderMenu(W, H);
  } else if (state === "online") {
    renderOnline(W, H);
  } else if (state === "online_host" && host) {
    host.render(renderer, now);
  } else if (state === "online_client" && remoteView) {
    remoteView.render(renderer, now, currentLayout.mapCols * TILE_SIZE, currentLayout.mapRows * TILE_SIZE);
    mobileControls.render(renderer.ctx); // 触屏虚拟摇杆/按键（仅 touch 模式绘制）
  } else if (state === "settings") {
    renderSettings(renderer, W, H, settings, settingsSel);
    // 设置页每一行注册点击区域（触屏/鼠标均可操作）
    const panelW = Math.min(520, W - 40);
    const startY = 100;
    const rowH = 44, rowGap = 6;
    const rowX = W / 2 - panelW / 2;
    const settingRowActions: Array<() => void> = [
      () => { settingsSel = 0; changeSettings(1); },  // 操作模式
      () => { settingsSel = 1; changeSettings(1); },  // 音量
      () => { settingsSel = 2; changeSettings(1); },  // 屏幕方向
      () => { settingsSel = 3; /* 按键绑定待实现 */ }, // 按键绑定
      () => { settingsSel = 4; changeSettings(1); },  // P2自动AI
    ];
    settingRowActions.forEach((action, i) => {
      const ry = startY + i * (rowH + rowGap);
      lobbyButtons.push({ x: rowX, y: ry, w: panelW, h: rowH, onTap: action });
    });
    // v2.15 触屏后退按钮（手机端无ESC键）
    const backBtnW = 120, backBtnH = 36;
    const backBtnX = W - backBtnW - 12, backBtnY = H - backBtnH - 12;
    drawLobbyButton(backBtnX, backBtnY, backBtnW, backBtnH, "← 返回",
      "#1a2a3a", "#4af", "#9df", () => {
        applySettings();
        if (settingsFromPause) {
          settingsFromPause = false;
          if (endless) { paused = true; state = "playing_endless"; }
          else if (stage) { paused = true; state = "playing_stage"; }
          else if (test) { paused = true; state = "playing_test"; }
          else if (host) { paused = true; state = "online_host"; }
          else if (remoteView) { paused = true; state = "online_client"; }
          else state = "menu";
        } else {
          state = "menu";
        }
        getSoundManager().play("pickup");
      });
  } else if (state === "playing_endless" && endless) {
    endless.render(renderer, now);
  } else if (state === "playing_test" && test) {
    test.render(renderer, now);
    // v2.15 触屏退出打靶按钮（手机端无ESC键）
    drawLobbyButton(W - 110, 8, 100, 32, "← 退出打靶",
      "#2a1a1a", "#f66", "#faa", () => {
        test = null;
        state = "menu";
        getSoundManager().play("pickup");
      });
  } else if (state === "playing_stage" && stage) {
    stage.render(renderer, now);
  } else if (state === "gameover") {
    if (endless) endless.render(renderer, now);
    else if (stage) stage.render(renderer, now);
    // 注册结算按钮为 lobbyButton 使其可点击
    const src = endless ?? stage;
    if (src) {
      for (const btn of src._gameOverBtnRects) {
        lobbyButtons.push({ x: btn.x, y: btn.y, w: btn.w, h: btn.h, onTap: () => {
          if (btn.action === "restart") {
            if (endless) { endless = new EndlessMode(canvas, currentLayout); state = "playing_endless"; }
            else if (stage) { stage = new StageMode(canvas, currentLayout); state = "playing_stage"; }
            paused = false;
          } else if (btn.action === "return_lobby") {
            endless = null; stage = null; state = "menu";
          } else if (btn.action === "return_menu") {
            endless = null; stage = null; state = "menu";
          }
        }});
      }
    }
  }

  // ── v2.21 联机对局结束（基地被摧毁/全员阵亡）：结束画面给出可点的菜单按钮（手机无Enter键）──
  const overOnline = (state === "online_host" && !!host?.isOver) || (state === "online_client" && !!remoteView?.isOver());
  if (overOnline) {
    const bw = 170, bh = 40, gap = 14;
    const bx0 = W / 2 - (bw * 2 + gap) / 2;
    drawLobbyButton(bx0, H - 64, bw, bh, "🚪 返回大厅", "#1a2a1a", "#4af", "#9df", returnToOnlineLobby);
    drawLobbyButton(bx0 + bw + gap, H - 64, bw, bh, "🏠 返回主菜单", "#1a1a2a", "#888", "#ccc", () => {
      getSoundManager().play("pickup");
      exitOnlineToMenu();
    });
  }

  // ── 通用：所有游戏模式共用的暂停按钮 + 暂停遮罩 ──
  if (isGameplayState()) {
    if (!paused) {
      // v2.25 暂停按钮：横屏移到右侧信息栏顶部（不与地图/底部HUD重叠），竖屏留在左下角（虚拟按键区之上）
      const pbW = 36, pbH = 36;
      const landscapeBar = currentLayout.infoW > 0;
      // v2.36 成员端竖屏：暂停键移到右上角（左下角是虚拟摇杆区域，放那里点不到/冲突）
      const isMemberView = state === "online_client";
      const pbX = landscapeBar ? (currentLayout.canvasW - currentLayout.infoW + 6) : (isMemberView ? W - pbW - 8 : 8);
      const pbY = landscapeBar ? 4 : (isMemberView ? 46 : H - pbH - 8);
      drawLobbyButton(pbX, pbY, pbW, pbH, "⏸", "rgba(10,16,28,0.75)", "#555", "#9cf", () => {
        paused = true;
        getSoundManager().play("pickup");
      });
    } else {
      // 暂停遮罩（主题化"游戏暂停"面板 + 全屏缩放效果）
      renderPauseOverlay(W, H);
      // 注册四个选项的点击命中区（视觉由 drawPauseOverlayThemed 绘制）
      registerPauseMenuButtons(W, H);
    }
  }
}

function renderMenu(W: number, H: number): void {
  const now = performance.now();
  lobbyButtons = []; // 菜单页也注册可点击区域（全屏按钮）

  // 美化后的菜单背景
  drawMenuBackground(renderer, W, H, now);

  // 全屏按钮
  drawLobbyButton(W - 46, 10, 36, 28, "⛶", "#111", "#555", "#9cf", () => { void toggleFullscreen(); });

  // 游戏标题
  drawGameTitle(renderer, W, 60, "Noita炮筒  肉鸽成长  2P协作防守基地");

  // 菜单选项
  const opts: Array<{ label: string; subLabel: string; icon: string }> = [
    { label: "无尽模式", subLabel: "波次越来越难，坚守极限", icon: "⚔" },
    { label: "闯关制", subLabel: "30关章节BOSS阶段奖励", icon: "🏰" },
    { label: "数值打靶", subLabel: "武器DPS实测·校准", icon: "🎯" },
    { label: "联 机", subLabel: "在线房间大厅 · 4座准备开局", icon: "🌐" },
    { label: "设 置", subLabel: `当前操作:${MODE_LABELS[settings.mode]}`, icon: "⚙" },
  ];
  const bw = Math.min(460, W - 40);
  const bx = W / 2 - bw / 2;
  opts.forEach((opt, i) => {
    const by = 140 + i * 48;
    drawMenuOption(renderer.ctx, bx, by, bw, 40, opt, i === menuSel, i);
    // 注册点击区域
    lobbyButtons.push({ x: bx, y: by, w: bw, h: 40, onTap: () => {
      if (i === 4) { settingsFromPause = false; state = "settings"; }
      else if (i === 3) { enterOnline(); }
      else startGame(i);
    }});
  });

  // 方向选择（移动端）
  if (mobile) {
    const orientLabels = ["横屏  (宽地图)", "竖屏  (高地图)"];
    renderer.ctx.save();
    renderer.ctx.font = "13px monospace";
    renderer.ctx.fillStyle = "#889";
    renderer.ctx.textAlign = "right";
    renderer.ctx.fillText("方向:", W / 2 - 140, 410);
    renderer.ctx.restore();
    orientLabels.forEach((label, i) => {
      const sel = i === menuOrient;
      const obx = W / 2 - 130 + i * 140;
      renderer.fillRect(obx, 398, 126, 36, sel ? "#1a2540" : "#111");
      renderer.strokeRect(obx, 398, 126, 36, sel ? "#00d4ff" : "#333", sel ? 2 : 1);
      renderer.drawText(label, obx + 63, 409, { font: "12px monospace", color: sel ? "#00d4ff" : "#555", align: "center" });
      lobbyButtons.push({ x: obx, y: 398, w: 126, h: 36, onTap: () => {
        menuOrient = i; settings.orient = i; orientTouched = true;
      }});
    });
  }

  // v2.15 版本号显示（诊断联机版本不一致问题）
  const buildVersion = "v2.15.1";
  const buildTime = "2026-09-13 21:35";
  renderer.ctx.save();
  renderer.ctx.font = "10px monospace";
  renderer.ctx.fillStyle = "rgba(150,170,200,0.5)";
  renderer.ctx.textAlign = "left";
  renderer.ctx.fillText(`${buildVersion} · ${buildTime}`, 10, H - 8);
  renderer.ctx.textAlign = "right";
  renderer.ctx.fillText("联机请统一使用 localhost:3001", W - 10, H - 8);
  renderer.ctx.restore();

  // 底部提示
  drawHintBar(renderer.ctx, W, H, [
    "↑↓ 选模式    ←→ 切换方向    Enter 开始",
    "P1: WASD移动 H/J/K/L四炮筒开火 E修复 Tab换炮筒 I背包",
    "P2: 方向键 Num1-4开火 / 修复 RShift换炮筒  升级时 7/8/9 选增强(不暂停)",
  ]);
}

function renderPauseOverlay(W: number, H: number): void {
  drawPauseOverlayThemed(renderer, W, H);
}

wireNetHandlers();
// 开发调试：?debug=1 时暴露当前邀请链接的实时计算结果
if (new URLSearchParams(location.search).has("debug")) {
  (window as any).__tankDebug = {
    inviteUrl: () => (state === "online" && onlineCurrent ? buildInviteUrl(onlineCurrent.id) : null),
    serverLanIps: () => serverLanIps,
    state: () => ({ state, mode: onlineMode, inTable: onlineInTable, netConnected: net.connected }),
    key: (code: string) => {
      document.dispatchEvent(new KeyboardEvent("keydown", { code }));
      document.dispatchEvent(new KeyboardEvent("keyup", { code }));
    },
    click: (cx: number, cy: number) => {
      const c = canvas;
      const r = c.getBoundingClientRect();
      const x = r.left + cx * (r.width / c.width);
      const y = r.top + cy * (r.height / c.height);
      c.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
    },
    rawState: () => ({ menuSel }),
    getEndlessMode: () => endless,
    getStageMode: () => stage,
    getHost: () => host,
    getInputManager: () => input,
    getRemoteView: () => remoteView,
    getNetClient: () => net,
  };
}
// 带邀请链接 ?room=<ID> 打开：自动进入联机并加入该房间
if (autoJoinRoom !== null) {
  state = "online";
  onlineMsg = "";
  enterOnline();
}
const loop = new GameLoop(update, render);
(window as any).__gameLoop = loop;
loop.start();