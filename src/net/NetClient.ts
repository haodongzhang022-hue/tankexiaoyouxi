//  src/net/NetClient.ts ─
//  WebSocket 客户端封装：大厅状态机 + 主机权威游戏期消息收发。
//  与 server/index.mjs 通信。事件回调由 main.ts 订阅驱动 UI/游戏逻辑。
//
//  v2.5：支持多候选地址依次探测（同源 → :3001 回退），兼容三种部署：
//    1. 单端口（页面和 WS 都由 server/index.mjs 提供）→ 同源直连
//    2. 开发模式（Vite:3000 + WS:3001）→ 自动回退到 ws://host:3001
//    3. 隧道/反代（ngrok 等，页面 https）→ 自动用 wss 同源

import type { NetTable, NetSnapshot, StartMsg, PeerInputMsg, ServerInfo, NetLvlChoice, PickLevelUpMsg, ShopBuyMsg, ShopStockView, RejoinOkMsg, CheckpointMsg, MigratedMsg, EquipReqMsg, EquipResMsg, FortifyReqMsg, FortifyResMsg } from "./NetTypes";
import type { PlayerInput } from "../engine/InputManager";

export interface NetEvents {
  welcome: (clientId: number) => void;
  tables: (tables: NetTable[]) => void;
  table: (table: NetTable) => void;          // 当前所在桌更新（成员/准备/房主）
  start: (start: StartMsg) => void;
  snapshot: (data: NetSnapshot) => void;     // 非主机成员收到
  gameover: (info: { reason: string; score: number }) => void;
  peerInput: (msg: PeerInputMsg) => void;    // 主机收到远端按键
  peerLeft: (idx: number) => void;           // 主机收到成员断线
  pong: (ts: number) => void;                // RTT 探测回包（延续原时间戳）
  levelup: (data: { playerIdx: number; choices: NetLvlChoice[] }) => void;  // 成员收到升级选项
  pickLevelup: (m: PickLevelUpMsg) => void;  // 主机收到成员回传的升级选择
  shopstate: (d: { stock: ShopStockView[] }) => void;  // v2.9 成员收到基地商店库存
  shop_buy: (m: ShopBuyMsg) => void;          // v2.9 主机收到成员购买选择
  rtc_signal: (m: { from: number; payload: unknown }) => void;  // v2.10 WebRTC 信令中继
  rejoin_ok: (m: RejoinOkMsg) => void;         // v2.11 局内重进成功（复用 start 流程恢复对局）
  checkpoint: (m: CheckpointMsg) => void;      // v2.12 成员保存主机检查点（接替续局用）
  migrated: (m: MigratedMsg) => void;          // v2.12 房主断线，成员接替通知
  equip_req: (m: EquipReqMsg) => void;         // v2.23 主机收到成员装配/卸载请求（拖动协议）
  equip_res: (m: EquipResMsg) => void;         // v2.23 成员收到装配/卸载结果
  fortify_req: (m: FortifyReqMsg) => void;     // v2.23 主机收到成员加固请求
  fortify_res: (m: FortifyResMsg) => void;     // v2.23 成员收到加固结果
  error: (msg: string) => void;
  closed: () => void;
  left: () => void;
  /** 服务器汇报「当前入口 + 内部 id」（welcome/pong 都会带）→ 客户端自动匹配刷新稳定链接 */
  entry: (e: { sid: string; url: string | null }) => void;
}

type Handler = (...args: any[]) => void;

/** 候选地址：字符串，或延迟求值函数（返回 null 则跳过该候选） */
export type ServerCandidate = string | (() => string | null);

const PROBE_TIMEOUT_MS = 3500; // 每个候选地址的最长探测时间

/** ws/wss/http/https 混写都归一到 ws(s)://；保留路径（稳定入口 /<sid>/join/<room> 必须原样带上） */
export function normalizeWsUrl(u: string): string {
  const s = String(u || "").trim();
  if (!s) return s;
  if (/^wss?:/i.test(s)) return s;
  if (/^https:/i.test(s)) return "wss:" + s.slice(6);
  if (/^http:/i.test(s)) return "ws:" + s.slice(5);
  return s;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private handlers: Partial<Record<keyof NetEvents, Handler>> = {};
  private _connected = false;
  private _myClientId = 0;
  private _myIndex = -1;          // 玩家索引（开始后：房主0/成员1）
  private _isHost = false;
  private _mode: "endless" | "stage" = "endless";
  private _players: Array<{ clientId: number; name: string }> = [];
  private _seed = 0;
  private _serverInfo: ServerInfo | null = null;   // 服务器的真实局域网地址
  private _publicHost: string | null = null;        // 服务器动态学习的当前公网隧道域名
  private _sid: string | null = null;               // 服务器内部 id（稳定入口用；环境重建会换新）
  private _entryUrl: string | null = null;          // 服务器汇报的「当前实际入口」地址（自动匹配源）
  /** 稳定链接优先的候选（URL 对象，每次重连实时求值）→ 断线后自动跳到最新地址 */
  private entryLink: (() => string | null) | null = null;

  // 多候选探测状态
  private candidates: ServerCandidate[] = [];
  private candIdx = 0;
  private probing = false;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;

  on<K extends keyof NetEvents>(k: K, cb: NetEvents[K]): void { this.handlers[k] = cb as Handler; }
  get connected(): boolean { return this._connected; }
  get myClientId(): number { return this._myClientId; }
  get isHost(): boolean { return this._isHost; }
  get mode(): "endless" | "stage" { return this._mode; }
  get myIndex(): number { return this._myIndex; }
  get players(): Array<{ clientId: number; name: string }> { return this._players; }
  get seed(): number { return this._seed; }
  /** 服务器在 welcome 里报告的局域网地址（可能为 null，如旧版服务器） */
  get serverInfo(): ServerInfo | null { return this._serverInfo; }
  /** 服务器动态学习的公网隧道域名（隧道域名变化自动更新，用于邀请链接） */
  get publicHost(): string | null { return this._publicHost; }
  /** 服务器内部 id（8 位十六进制；同一进程内恒定，环境重建/重启后换新） */
  get sid(): string | null { return this._sid; }
  /** 服务器汇报的「当前实际入口」地址（稳定链接 302 的目标） */
  get entryUrl(): string | null { return this._entryUrl; }
  /**
   * 设置「稳定链接」候选（形如 /<sid>/join/<room> 的站内路径，或完整 URL）。
   * 每次连接/重连都实时求值 → 域名/IP 变了也不用改手；返回 null 则跳过该候选。
   */
  setEntryLink(fn: (() => string | null) | null): void { this.entryLink = fn; }

  /** 连接联机服务器：按候选顺序探测，直到某个地址返回 welcome 才算成功。 */
  connect(input: string | ServerCandidate[]): void {
    this.close();
    const base = (Array.isArray(input) ? input.slice() : [input]).filter(Boolean);
    // 稳定链接优先：只要手里有「稳定入口」，就先由它寻址（服务器 302/后续跳转会把我们带到当前地址）；
    // 失败再按常规候选（同源 → :3001）兜底，绝不因为匹配失败而连不上。
    this.candidates = this.entryLink ? [this.entryLink, ...base] : base;
    this.candIdx = 0;
    this.tryNextCandidate();
  }

  close(): void {
    if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
    this.probing = false;
    if (this.ws) {
      try { this.ws.onclose = null; this.ws.onerror = null; this.ws.onmessage = null; this.ws.onopen = null; this.ws.close(); } catch {}
    }
    this.ws = null;
    this._connected = false;
  }
  /** 主动断开（与 close 等价，语义化命名供外部调用） */
  disconnect(): void { this.close(); }

  private resolveCandidate(c: ServerCandidate): string | null {
    try { return typeof c === "function" ? c() : c; } catch { return null; }
  }

  private cleanupProbeSocket(ws: WebSocket): void {
    try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null; } catch {}
    try { ws.close(); } catch {}
  }

  private tryNextCandidate(): void {
    while (this.candIdx < this.candidates.length) {
      const url = this.resolveCandidate(this.candidates[this.candIdx]);
      this.candIdx++;
      if (!url) continue; // 候选不可用（如局域网 IP 探测失败），试下一个
      this.openWithProbe(url);
      return;
    }
    this.emit("error", "无法连接联机服务器（已尝试所有候选地址，请确认服务器已启动）");
  }

  private openWithProbe(url: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(normalizeWsUrl(url));
    } catch {
      this.tryNextCandidate();
      return;
    }
    this.ws = ws;
    this.probing = true;

    const failOver = () => {
      if (!this.probing) return;
      this.probing = false;
      if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
      this.cleanupProbeSocket(ws);
      this.ws = null;
      this.tryNextCandidate();
    };

    // 超时未收到 welcome → 换下一个候选
    this.probeTimer = setTimeout(failOver, PROBE_TIMEOUT_MS);

    // 注意：onopen 不代表可用（纯 TCP 打开后仍可能不是游戏服务器），以 welcome 为准
    ws.onopen = () => {};
    // 断线感知：探测期走换候选；已连接后通知上层（修复"假连接"：服务器重启后操作全部无效）
    ws.onclose = () => {
      if (this.probing) { failOver(); return; }
      this._connected = false;
      this.emit("closed");
    };
    ws.onerror = () => {}; // 错误随后会触发 onclose
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (this.probing && m && m.t === "welcome") {
        // 探测成功：这就是可用的联机服务器
        this.probing = false;
        if (this.probeTimer) { clearTimeout(this.probeTimer); this.probeTimer = null; }
        this._connected = true;
      }
      this.dispatch(m);
    };
  }

  private emit(k: keyof NetEvents, ...args: any[]): void {
    const h = this.handlers[k];
    if (h) (h as any)(...args);
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private dispatch(m: { t: string; [k: string]: unknown }): void {
    switch (m.t) {
      case "welcome": {
        this._myClientId = Number(m.clientId);
        const si = m.serverInfo as ServerInfo | undefined;
        if (si && Array.isArray(si.lanIps)) {
          this._serverInfo = { lanIps: si.lanIps.map(String), port: Number(si.port) || 3001 };
        }
        if (typeof m.publicHost === "string" && m.publicHost) this._publicHost = m.publicHost;
        this.applyEntry(m.sid, m.url);
        this.emit("welcome", this._myClientId); break;
      }
      case "tables":
        if (typeof m.publicHost === "string" && m.publicHost) this._publicHost = m.publicHost;
        this.emit("tables", m.tables); break;
      case "table": this.emit("table", m.table); break;
      case "start": {
        const s = m as unknown as StartMsg;
        this._myIndex = s.myIndex;
        this._isHost = s.myIndex === 0;
        this._mode = s.mode; this._players = s.players; this._seed = s.seed;
        this.emit("start", s); break;
      }
      case "snapshot": this.emit("snapshot", m.data); break;
      case "gameover": this.emit("gameover", m.info); break;
      case "peer_input": this.emit("peerInput", m as unknown as PeerInputMsg); break;
      case "peer_left": this.emit("peerLeft", Number(m.idx)); break;
      case "pong":
        this.applyEntry(m.sid, m.url);
        this.emit("pong", Number(m.ts)); break;
      case "levelup": this.emit("levelup", { playerIdx: Number(m.playerIdx), choices: (m.choices as NetLvlChoice[]) ?? [] }); break;
      case "pick_levelup": this.emit("pickLevelup", m as unknown as PickLevelUpMsg); break;
      case "shopstate": this.emit("shopstate", { stock: Array.isArray(m.stock) ? m.stock as ShopStockView[] : [] }); break;
      case "shop_buy": this.emit("shop_buy", m as unknown as ShopBuyMsg); break;
      case "rtc_signal": this.emit("rtc_signal", { from: Number(m.from), payload: m.payload }); break;
      case "rejoin_ok": this.emit("rejoin_ok", m as unknown as RejoinOkMsg); break;
      case "checkpoint": this.emit("checkpoint", m as unknown as CheckpointMsg); break;
      case "migrated": this.emit("migrated", m as unknown as MigratedMsg); break;
      case "equip_req": this.emit("equip_req", m as unknown as EquipReqMsg); break;
      case "equip_res": this.emit("equip_res", m as unknown as EquipResMsg); break;
      case "fortify_req": this.emit("fortify_req", m as unknown as FortifyReqMsg); break;
      case "fortify_res": this.emit("fortify_res", m as unknown as FortifyResMsg); break;
      case "error": this.emit("error", String(m.msg)); break;
      case "left": this.emit("left"); break;
    }
  }

  /** 记录服务器汇报的内部 id / 当前入口；变化时通知上层（上层自动刷新稳定链接） */
  private applyEntry(sid: unknown, url: unknown): void {
    const s = typeof sid === "string" && /^[0-9a-f]{8}$/.test(sid) ? sid : null;
    const u = typeof url === "string" && url ? url.replace(/\/+$/, "") : null;
    const changed = (s && s !== this._sid) || (u && u !== this._entryUrl);
    if (s) this._sid = s;
    if (u) this._entryUrl = u;
    if (changed) this.emit("entry", { sid: this._sid ?? "", url: this._entryUrl });
  }

  // ── 大厅操作 ──
  setname(name: string): void { this.send({ t: "setname", name }); }
  list(): void { this.send({ t: "list" }); }
  create(name?: string, mode?: "endless" | "stage", orient?: "landscape" | "portrait"): void { this.send({ t: "create", name, mode, orient }); }
  join(tableId: number): void { this.send({ t: "join", tableId }); }
  leave(): void { this.send({ t: "leave" }); }
  ready(value: boolean): void { this.send({ t: "ready", value }); }
  /** v2.36 房主：更改房间方向（横屏/竖屏）——大厅广播后成员端同步，开局按最新方向创建地图 */
  setOrient(orient: "landscape" | "portrait"): void { this.send({ t: "orient", orient }); }
  start(): void { this.send({ t: "start" }); }

  // ── 游戏期 ──
  /** 非主机成员：上报自己（PIndex=myIndex）的按键快照，附带本地发送时间供 RTT 估算 */
  sendInput(flags: PlayerInput, clientFrame?: number): void { this.send({ t: "input", flags, clientSendTime: Date.now(), clientFrame }); }
  /** RTT 探测：服务器原样回 PongMsg{ts}，测客户端→服务器往返延迟（input 消息也会附带触发一次） */
  ping(): void { this.send({ t: "ping", ts: Date.now() }); }
  /** 主机：广播权威快照 */
  hostSnapshot(data: NetSnapshot): void { this.send({ t: "snapshot", data }); }
  /** 主机：广播结束 */
  hostGameOver(info: { reason: string; score: number }): void { this.send({ t: "gameover", info }); }
  /** 主机：广播某玩家的升级选项给成员（成员点选可选） */
  hostLevelUp(playerIdx: number, choices: NetLvlChoice[]): void { this.send({ t: "levelup", playerIdx, choices }); }
  /** 成员：回传所选的升级项下标（服务器中继给主机） */
  pickLevelUp(playerIdx: number, choice: number): void { this.send({ t: "pick_levelup", playerIdx, choice }); }
  /** v2.9 主机广播基地商店库存 → 成员 */
  sendShopState(stock: Array<{ id: string; price: number; discount: number }>): void { this.send({ t: "shopstate", stock }); }
  /** v2.9 成员回传商店购买选择 → 主机 */
  shopBuy(playerIdx: number, choice: number): void { this.send({ t: "shop_buy", playerIdx, choice }); }

  // v2.23 成员端拖动装配/卸载 + 基地加固（经服务器中继到主机/成员）
  equipReq(playerIdx: number, action: "equip" | "unequip", invIdx: number, wand: number, slot: number): void { this.send({ t: "equip_req", playerIdx, action, invIdx, wand, slot }); }
  equipRes(playerIdx: number, ok: boolean, msg: string): void { this.send({ t: "equip_res", playerIdx, ok, msg }); }
  fortifyReq(playerIdx: number): void { this.send({ t: "fortify_req", playerIdx }); }
  fortifyRes(ok: boolean, msg: string): void { this.send({ t: "fortify_res", ok, msg }); }
  /** v2.12 主机：广播检查点（成员保存最新一份，接替续局时恢复武器/等级/背包等快照未携带状态） */
  hostCheckpoint(players: CheckpointMsg["players"], warehouse: CheckpointMsg["warehouse"], assetPack?: CheckpointMsg["assetPack"], assetPackVersion?: string): void { this.send({ t: "checkpoint", players, warehouse, assetPack, assetPackVersion }); }
  /** v2.10 WebRTC 信令（offer/answer/ice → 中继给 to） */
  rtcSignal(to: number, payload: unknown): void { this.send({ t: "rtc_signal", to, payload }); }
  /** v2.11 局内重进：凭本地保存的令牌回到原座位（断线刷新后调用） */
  rejoin(tableId: number, token: string): void { this.send({ t: "rejoin", tableId, token }); }
}
