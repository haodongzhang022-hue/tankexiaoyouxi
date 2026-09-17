// ============================================================================
//  net-sync-core / core.ts ─ 通用同步核心（语言无关机制，TS 实现）
//  ----------------------------------------------------------------------------
//  覆盖：快照增量编解码 / 自适应插值缓冲 / RTT·抖动测量 / 断线重连 /
//        主机迁移 / 传输接口 / 同步引擎编排。
//  约定：零引擎依赖（不 import 任何游戏/渲染代码），浏览器与 Node 均可运行；
//        同一机制的不同实现（如自适应 vs 固定插值延迟）在此文件内以参数控制。
//  版本：2026-09-12 v1.0.0
//    - 固化自坦克大战已验证行为：v2.8 快照增量编码、v2.6.7 自适应插值延迟、
//      v2.11 断线重连、v2.12 主机迁移（对齐见 tests 交叉等价断言）。
// ============================================================================

import type { EntityKind, SyncMode, SyncSchema } from "./schema";

// ── 通用状态 / 帧（语言无关数据结构，各端序列化器按此对齐）───────────────────

/** 一条实体记录（diff 种类必须含稳定 id；alwaysFull 种类可省略） */
export interface EntityRecord {
  id?: number;
  [field: string]: unknown;
}

/** 解码后的完整同步状态（成员端渲染 / 主机端构建的中间态） */
export interface SyncState {
  frame: number;                          // 单调递增帧号（服务端域）
  t: number;                              // 服务端时间戳（ms，单调）
  kinds: Record<string, EntityRecord[]>;  // 每种实体的当前全量
  scope: Record<string, unknown>;         // 全局小状态
  payload?: Record<string, unknown>;      // 首帧大数据（如地图）
}

/** 网络帧（增量 / 全量 / 轻量） */
export interface Frame {
  full?: boolean;                          // 缺省 true（兼容旧端）
  frame: number;
  t: number;
  kinds?: Record<string, EntityRecord[]>;  // 增量=变化子集；全量=全部；轻量=缺省
  removed?: Record<string, number[]>;      // 消失 ID（按种类；空则缺省）
  scope?: Record<string, unknown>;         // 变化的小状态（未变缺省）
  payload?: Record<string, unknown>;       // 仅全量帧携带
}

// ── 1. 快照增量编解码（schema 驱动）───────────────────────────────────────────

/**
 * 通用快照编解码器：按对接表（schema）驱动。
 *  - 首帧 / 每 keyFrameEvery 帧 / 单类变化超 forceFullRatio → 全量帧；
 *  - 有稳定 ID 的种类按 id diff（只比较 sync=eq 字段，命中即整条记录发送）；
 *  - alwaysFull 种类（loot/powerup）每帧全量发送/替换；
 *  - scope 变化才携带（整对象），payload（地图）仅全量帧携带；
 *  - 完全无变化 → 轻量帧（只带时间戳）。
 *  主机端用 encode，成员端用 decode（同实例两角色不混用；帧号单调去重）。
 */
export class SyncCodec {
  /** 发送侧状态（encode 用） */
  private frameCount = 0;
  private lastScopeKey = "";
  private lastPayloadKey = "";
  /** 接收侧状态（decode 用） */
  private diffCache = new Map<string, Map<number, EntityRecord>>();
  private fullCache = new Map<string, EntityRecord[]>();
  private lastScope: Record<string, unknown> = {};
  private lastPayload: Record<string, unknown> | undefined;

  constructor(private schema: SyncSchema) {}

  private kindMap(): Map<string, EntityKind> {
    return new Map(this.schema.entities.map((e) => [e.kind, e]));
  }

  /** 编码：相对上一帧（prev）产生 cur 的增量/全量/轻量帧。 */
  encode(prev: SyncState, cur: SyncState): Frame {
    this.frameCount++;
    const km = this.kindMap();
    let full = this.frameCount === 1 || this.frameCount % this.schema.keyFrameEvery === 0;

    const changes = new Map<string, EntityRecord[]>();
    const removed = new Map<string, number[]>();
    if (!full) {
      for (const kind of this.schema.entities) {
        const prevArr = prev.kinds[kind.kind] ?? [];
        const curArr = cur.kinds[kind.kind] ?? [];
        if (kind.alwaysFull) {
          // 无稳定 ID：整组发送（体积小，等价"每帧全量"）
          if (curArr.length > 0) changes.set(kind.kind, curArr);
          continue;
        }
        const [ch, rm] = this.diffKind(kind, prevArr, curArr);
        if (ch.length) changes.set(kind.kind, ch);
        if (rm.length) removed.set(kind.kind, rm);
        // 强制全量保护：单类变化超阈值 → 全量更划算
        if (curArr.length > 0 && ch.length > curArr.length * this.schema.forceFullRatio) {
          full = true;
          break;
        }
      }
    }

    if (!full) {
      const scopeChanged = this.keyOf(cur.scope) !== this.lastScopeKey;
      if (changes.size > 0 || removed.size > 0 || scopeChanged) {
        this.lastScopeKey = this.keyOf(cur.scope);
        return {
          full: false, frame: cur.frame, t: cur.t,
          kinds: Object.fromEntries(changes),
          removed: Object.fromEntries(removed),
          scope: scopeChanged ? cur.scope : undefined,
        };
      }
      // 完全没变化 → 轻量帧（最省）
      return { full: false, frame: cur.frame, t: cur.t };
    }

    // 全量帧
    this.lastScopeKey = this.keyOf(cur.scope);
    this.lastPayloadKey = this.keyOf(cur.payload);
    return {
      full: true, frame: cur.frame, t: cur.t,
      kinds: cur.kinds, scope: cur.scope,
      payload: cur.payload ?? this.lastPayload,
    };
  }

  /** 解码：增量合并到缓存 / 全量重建缓存，产出完整 SyncState。 */
  decode(msg: Frame): SyncState {
    this.frameCount = msg.frame;
    if (msg.full !== false) {
      // 全量帧：出现的种类重建缓存，未出现的沿用旧缓存
      for (const [k, recs] of Object.entries(msg.kinds ?? {})) {
        const kind = this.kindMap().get(k);
        if (!kind) continue;
        if (kind.alwaysFull) {
          this.fullCache.set(k, recs);
        } else {
          const m = new Map<number, EntityRecord>();
          for (const r of recs) if (r.id != null) m.set(r.id, r);
          this.diffCache.set(k, m);
        }
      }
      if (msg.scope !== undefined) { this.lastScope = msg.scope; }
      if (msg.payload !== undefined) { this.lastPayload = msg.payload; }
      return this.readout(msg.frame, msg.t);
    }

    // 增量/轻量帧：合并
    if (msg.scope !== undefined) this.lastScope = msg.scope;
    if (msg.payload !== undefined) this.lastPayload = msg.payload;
    for (const [k, ids] of Object.entries(msg.removed ?? {})) {
      const m = this.diffCache.get(k);
      if (m) for (const id of ids) m.delete(id);
    }
    for (const [k, recs] of Object.entries(msg.kinds ?? {})) {
      const kind = this.kindMap().get(k);
      if (!kind) continue;
      if (kind.alwaysFull) {
        this.fullCache.set(k, recs);
      } else {
        let m = this.diffCache.get(k);
        if (!m) { m = new Map(); this.diffCache.set(k, m); }
        for (const r of recs) if (r.id != null) m.set(r.id, r);
      }
    }
    return this.readout(msg.frame, msg.t);
  }

  /** 最近一次解码结果（成员端喂插值用） */
  latest(): SyncState | null {
    return this._latest;
  }

  /** 解码器缓存实体数（调试/可视化断言） */
  cacheSize(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, m] of this.diffCache) out[k] = m.size;
    for (const [k, a] of this.fullCache) out[k] = a.length;
    return out;
  }

  // ── 内部 ──
  private _latest: SyncState | null = null;

  private readout(frame: number, t: number): SyncState {
    const kinds: Record<string, EntityRecord[]> = {};
    for (const [k, m] of this.diffCache) kinds[k] = [...m.values()];
    for (const [k, a] of this.fullCache) kinds[k] = [...a];
    this._latest = { frame, t, kinds, scope: this.lastScope, payload: this.lastPayload };
    return this._latest;
  }

  private diffKind(kind: EntityKind, prev: EntityRecord[], cur: EntityRecord[]): [EntityRecord[], number[]] {
    const prevMap = new Map(prev.map((r) => [r.id, r]));
    const curIds = new Set<number>();
    const changed: EntityRecord[] = [];
    for (const r of cur) {
      if (r.id == null) continue;
      curIds.add(r.id);
      const p = prevMap.get(r.id);
      if (!p || !this.same(kind, p, r)) changed.push(r);
    }
    const removed: number[] = [];
    for (const r of prev) if (r.id != null && !curIds.has(r.id)) removed.push(r.id);
    return [changed, removed];
  }

  private same(kind: EntityKind, a: EntityRecord, b: EntityRecord): boolean {
    for (const f of kind.fields) {
      if (f.sync !== "eq") continue;
      if (!eqField(a[f.name], b[f.name])) return false;
    }
    return true;
  }

  private keyOf(o: unknown): string {
    if (o === undefined) return "";
    return JSON.stringify(o ?? null);
  }
}

/** 字段相等（标量直比；对象/数组走 JSON 序无关比较） */
function eqField(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  }
  return false;
}

/** 对象键排序后序列化（消除键序差异，wallets/bp/base 等小对象可靠比较） */
function normalize(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(normalize);
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) out[k] = normalize((o as Record<string, unknown>)[k]);
    return out;
  }
  return o;
}

// ── 2. 自适应插值缓冲（成员端渲染）───────────────────────────────────────────

interface Rec { s: SyncState; t: number }

/**
 * 成员端插值缓冲：以快照「服务端时间戳 t」为时间基准，渲染点单调推进（永不回退）。
 *  - 自适应延迟（adaptive=true，对齐 v2.6.7）：稳定贴最新帧（低延迟），抖动加深缓冲（防卡顿回跳）；
 *  - 宽松追赶：落后严重大步追，正常小步推，抖动需后撤则较快建立缓冲。
 */
export class Interpolator {
  private buffer: (Rec | null)[];
  private head = -1;
  private lastFrame = -1;
  private first = false;
  private renderT = 0;
  private delayMs: number;
  private snapDtEma = 0;
  private snapJitterEma = 0;
  private lastSnapT = 0;

  constructor(private pref: { delayMinMs: number; delayMaxMs: number; adaptive: boolean; stepMs: number; catchUpMult: number; backoffMult: number; bufferSize?: number }) {
    this.delayMs = pref.delayMinMs;
    this.buffer = new Array(pref.bufferSize ?? 30).fill(null);
  }

  /** 喂入解码后的快照（乱序/重复帧按 frame 丢弃） */
  push(s: SyncState): void {
    const frame = s.frame;
    if (frame <= this.lastFrame) return;
    this.lastFrame = frame;
    const t = s.t;
    this.head = (this.head + 1) % this.buffer.length;
    this.buffer[this.head] = { s, t };
    if (!this.first) { this.first = true; this.renderT = t - this.delayMs; }

    // 到达间隔 EMA + 抖动 EMA（衡量网络不稳程度）
    if (this.lastSnapT > 0) {
      const dt = t - this.lastSnapT;
      if (dt > 1 && dt < 1000) {
        if (this.snapDtEma <= 0) this.snapDtEma = dt;
        else this.snapDtEma += 0.1 * (dt - this.snapDtEma);
        const jd = Math.abs(dt - this.snapDtEma);
        if (this.snapJitterEma <= 0) this.snapJitterEma = jd;
        else this.snapJitterEma += 0.2 * (jd - this.snapJitterEma);
      }
    }
    this.lastSnapT = t;

    if (this.pref.adaptive) {
      const interval = this.snapDtEma > 0 ? this.snapDtEma : 50;
      const buffer = Math.min(150, Math.max(8, this.snapJitterEma * 2)); // 抖动每 1ms ≈ 2ms 缓冲
      this.delayMs = Math.max(this.pref.delayMinMs,
        Math.min(this.pref.delayMaxMs, interval * 0.7 + buffer));
    }
  }

  /** 渲染时间单调推进（每渲染帧调用一次） */
  advance(): void {
    const latestT = this.latestT();
    if (!this.first || latestT <= 0) return;
    const target = latestT - this.delayMs;
    const lag = target - this.renderT;
    // v2.35 极端积压（>1.2s，暂停恢复/长时间卡顿）：直接跳帧对齐，避免"回放旧画面"
    if (lag > 1200) { this.renderT = target; return; }
    let adv: number;
    if (lag > 60) adv = this.pref.stepMs * this.pref.catchUpMult;   // 追赶（网络刚恢复/积压）
    else if (lag > 0) adv = this.pref.stepMs;                        // 正常推进
    else adv = this.pref.stepMs * this.pref.backoffMult;             // 后撤铺缓冲
    if (this.renderT < target) this.renderT = Math.min(target, this.renderT + adv);
    else this.renderT = Math.max(target, this.renderT - adv);
    if (this.renderT > latestT) this.renderT = latestT;
  }

  /** v2.35 立即对齐到最新快照（暂停恢复等场景，跳过积压旧帧回放） */
  flush(): void {
    if (!this.first) return;
    this.renderT = this.latestT() - this.delayMs;
  }

  /** 找插值对：a=renderT 左侧最近，b=右侧最近（b 缺失则 alpha=1 用 a） */
  pair(): { a: SyncState | null; b: SyncState | null; alpha: number } {
    if (!this.first) return { a: null, b: null, alpha: 0 };
    const latestT = this.latestT();
    if (latestT <= 0) return { a: null, b: null, alpha: 0 };
    let older: Rec | null = null;
    let newer: Rec | null = null;
    for (const rec of this.buffer) {
      if (!rec) continue;
      if (rec.t <= this.renderT) {
        if (!older || rec.t > older.t) older = rec;
      } else {
        if (!newer || rec.t < newer.t) newer = rec;
      }
    }
    if (!older) return { a: null, b: null, alpha: 0 };
    if (!newer) return { a: older.s, b: null, alpha: 1 };
    const dt = newer.t - older.t;
    const alpha = dt > 0 ? Math.min(1, Math.max(0, (this.renderT - older.t) / dt)) : 1;
    return { a: older.s, b: newer.s, alpha };
  }

  latest(): SyncState | null {
    const rec = this.buffer[this.head];
    return rec?.s ?? null;
  }
  latestT(): number {
    const rec = this.buffer[this.head];
    return rec?.t ?? 0;
  }
  /** 调试：自适应插值状态（供单测/可视化断言读） */
  debug(): { delay: number; interval: number; jitter: number; renderT: number; latestT: number; lag: number } {
    const latestT = this.latestT();
    return {
      delay: Math.round(this.delayMs),
      interval: Math.round(this.snapDtEma),
      jitter: Math.round(this.snapJitterEma),
      renderT: Math.round(this.renderT),
      latestT,
      lag: Math.round(latestT - this.renderT),
    };
  }
}

/**
 * 通用实体插值：数值字段按 alpha 线性插值（含角度环绕），非数值取 b。
 * b 中缺该 id → 返回 null（调用方登记消失/淡出）。
 * 项目侧可按需覆写（如转向>90°一步到位），此为基础实现。
 */
export function lerpEntity(
  a: EntityRecord, b: EntityRecord | undefined, alpha: number, numericFields: string[],
): EntityRecord | null {
  if (!b) return null;
  const lerp = (x: number, y: number) => x + (y - x) * alpha;
  const out: EntityRecord = { id: b.id };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === "id") continue;
    const va = a[k]; const vb = b[k];
    if (numericFields.includes(k) && typeof va === "number" && typeof vb === "number") {
      out[k] = lerp(va, vb);
    } else {
      out[k] = vb !== undefined ? vb : va;
    }
  }
  return out;
}

// ── 3. RTT / 抖动测量 ────────────────────────────────────────────────────────

/** 延迟跟踪参数：同一文件内收敛两种实现路线
 *  - route="ema"：逐样本指数平滑（轻量、收敛快，适合资产默认）
 *  - route="window"：滑动窗口均值 + 平均绝对偏差（读数更稳，对齐坦克旧实现手感）
 *  按偏好收敛在模块内，避免各项目各自重复实现。 */
export interface LatencyOpts {
  route: "ema" | "window";
  windowSize?: number;   // window 路线：滑动窗口大小（默认 12）
  maxAgeMs?: number;     // 样本最大年龄（默认 1500；超过即丢弃，防陈旧回包）
}

/** 延迟跟踪：服务器回声 ping/pong（ts 原样回），RTT = 收包时刻 - 发起时刻。 */
export class LatencyTracker {
  rtt = 0;
  jitter = 0;
  private n = 0;
  private ema = 0;
  private jema = 0;
  private samples: number[] = [];

  constructor(private opts: LatencyOpts = { route: "ema" }) {}

  /** 收到 pong（ts=发起时时间戳；recvTs 默认当前墙钟） */
  onPong(sentTs: number, recvTs = Date.now()): void {
    const r = recvTs - sentTs;
    const max = this.opts.maxAgeMs ?? 1500;
    if (r < 0 || r > max) return; // 异常/过期样本丢弃
    if (this.opts.route === "window") {
      // 滑动窗口：先进先出，窗口内求均值与平均偏差（读数稳定）
      const size = this.opts.windowSize ?? 12;
      this.samples.push(r);
      if (this.samples.length > size) this.samples.shift();
      const avg = this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
      const dev = this.samples.reduce((s, v) => s + Math.abs(v - avg), 0) / this.samples.length;
      this.rtt = Math.round(avg);
      this.jitter = Math.round(dev);
    } else {
      // 指数平滑（EMA）
      this.n++;
      if (this.n === 1) this.ema = r; else this.ema += 0.2 * (r - this.ema);
      const j = Math.abs(r - this.ema);
      if (this.n === 1) this.jema = j; else this.jema += 0.2 * (j - this.jema);
      this.rtt = Math.round(this.ema);
      this.jitter = Math.round(this.jema);
    }
  }

  reset(): void { this.rtt = 0; this.jitter = 0; this.ema = 0; this.jema = 0; this.n = 0; this.samples = []; }
}

// ── 4. 断线重连（凭令牌回到原座位）───────────────────────────────────────────

/** 可注入存储（浏览器 localStorage / 端上存档 / 内存 Map 均可） */
export interface KVStorage { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; }

/** 重连卡：断线/刷新后凭 {tableId, token} 回到原座位（对齐 v2.11 局内重进） */
export interface RejoinCard { tableId: number; token: string }

/** 重连管理：卡片存取 + 状态机（idle → reconnecting → joined / failed） */
export class ReconnectManager {
  state: "idle" | "reconnecting" | "joined" | "failed" = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 状态变化回调（供 UI/日志） */
  onStateChange: ((s: ReconnectManager["state"]) => void) | null = null;

  constructor(private storage: KVStorage, private key: string) {}

  save(card: RejoinCard): void { this.storage.setItem(this.key, JSON.stringify(card)); }
  peek(): RejoinCard | null {
    try {
      const v = this.storage.getItem(this.key);
      return v ? (JSON.parse(v) as RejoinCard) : null;
    } catch { return null; }
  }
  clear(): void { this.storage.removeItem(this.key); }

  /** 发起重连（凭卡；超时未确认回 failed） */
  begin(timeoutMs: number, attempt: () => void): void {
    this.setState("reconnecting");
    attempt();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.state === "reconnecting") this.setState("failed"); }, timeoutMs);
  }
  confirm(): void { if (this.timer) clearTimeout(this.timer); this.setState("joined"); }
  fail(): void { if (this.timer) clearTimeout(this.timer); this.setState("failed"); }
  /** 重连成功但回大厅（对局已结束/令牌失效） → 清卡 */
  abandon(): void { if (this.timer) clearTimeout(this.timer); this.setState("idle"); this.clear(); }

  private setState(s: ReconnectManager["state"]): void {
    if (this.state === s) return;
    this.state = s;
    this.onStateChange?.(s);
  }
}

// ── 5. 主机迁移（房主断线 → 在场成员接替）───────────────────────────────────

export interface SeatInfo { clientId: number; online: boolean; isHost: boolean }

/**
 * 选择接替主机：最靠前的在场非房主成员（对齐 v2.12 服务器策略）。
 * 返回新主机 clientId；无人可接替返回 null（→ 终止本局）。
 */
export function pickSuccessorHost(seats: SeatInfo[], currentHostId: number): number | null {
  for (const s of seats) if (s.online && s.clientId !== currentHostId) return s.clientId;
  return null;
}

// ── 6. 传输接口（可插拔：WS / WebRTC / UDP / TCP，跨端替换实现）───────────────

export interface Transport {
  readonly kind: "ws" | "rtc" | "udp" | "tcp";
  ready(): boolean;
  /** 发送任意消息（引擎负责序列化；P2P 双发也走此接口） */
  send(msg: unknown): void;
  /** 注册收包回调（原始消息，由引擎统一分发） */
  onMessage(cb: (raw: unknown) => void): void;
  close(): void;
}

// ── 7. 同步引擎编排（主机/成员两条路线，参数控制）───────────────────────────

export interface SyncEngineHooks {
  /** 主机：当前世界 → SyncState（项目适配层提供） */
  worldToState: () => SyncState;
  /** 成员：解码后的完整状态（喂插值/渲染） */
  onState: (s: SyncState, raw: unknown) => void;
  /** 任何非快照消息（事件：升级/商店/结束/信令/检查点…） */
  onEvent: (name: string, payload: Record<string, unknown>, from?: number) => void;
  /** 需要原始帧时（如 P2P 双发统计），可选 */
  onFrame?: (frame: Frame, raw: unknown) => void;
}

/**
 * 同步引擎：把「传输 + 编解码 + 插值 + 心跳」组装成一条可直接接入项目的线。
 *  - 主机路线：项目主循环每 tick 调 hostTick() → 编码 + 双发；
 *  - 成员路线：handleMessage() 收任意通道消息 → 按帧号去重 → 解码 → hooks.onState；
 *  - 事件：sendEvent() 可靠中继；心跳：startHeartbeat()。
 *  广播节奏由项目主循环驱动（与各引擎主循环天然契合，不内置 setInterval 抢帧）。
 */
export class SyncEngine {
  readonly codec: SyncCodec;
  readonly interp: Interpolator;
  private lastState: SyncState | null = null;
  private lastFrame = -1;
  private transports: Transport[];
  private latency = new LatencyTracker();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private schema: SyncSchema, transport: Transport | Transport[], private hooks: SyncEngineHooks) {
    this.transports = Array.isArray(transport) ? transport : [transport];
    this.codec = new SyncCodec(schema);
    this.interp = new Interpolator({
      delayMinMs: schema.interp.delayMinMs,
      delayMaxMs: schema.interp.delayMaxMs,
      adaptive: schema.interp.adaptive,
      stepMs: schema.interp.stepMs,
      catchUpMult: schema.interp.catchUpMult,
      backoffMult: schema.interp.backoffMult,
    });
    for (const t of this.transports) t.onMessage((raw) => this.handleMessage(raw));
  }

  /** 主机：每 tick 调用（state 省略时用 hooks.worldToState()）→ 编码 + 发送全部通道 */
  hostTick(state?: SyncState): Frame {
    const cur = state ?? this.hooks.worldToState();
    const prev = this.lastState ?? cur;
    const frame = this.codec.encode(prev, cur);
    this.lastState = cur;
    this.send({ t: "snapshot", data: frame });
    return frame;
  }

  /** 收任意通道消息 → 统一分发（快照按帧号去重；事件走 hooks.onEvent） */
  handleMessage(raw: unknown): void {
    const m = (raw ?? {}) as { t?: string; [k: string]: unknown };
    if (m.t === "snapshot") {
      const frame = m.data as Frame;
      if (!frame || typeof frame.frame !== "number") return;
      if (frame.frame <= this.lastFrame) return; // P2P 双发/乱序去重
      this.lastFrame = frame.frame;
      const s = this.codec.decode(frame);
      this.hooks.onFrame?.(frame, raw);
      this.hooks.onState(s, raw);
    } else if (m.t) {
      this.hooks.onEvent(m.t, m);
    }
  }

  /** 成员/主机：发送事件（升级/商店/结束/检查点/信令等） */
  sendEvent(name: string, payload: Record<string, unknown>, _to?: number): void {
    this.send({ t: name, ...payload });
  }

  /** 心跳 + RTT 探测（间隔取 schema.heartbeatMs；onPong 由项目经 transport 收到后调 latency） */
  startHeartbeat(beat: () => void): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(beat, this.schema.heartbeatMs);
  }
  stopHeartbeat(): void { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  get rtt(): number { return this.latency.rtt; }
  get jitter(): number { return this.latency.jitter; }
  onPong(sentTs: number): void { this.latency.onPong(sentTs); }
  latencyReset(): void { this.latency.reset(); }

  private send(m: unknown): void {
    for (const t of this.transports) {
      if (t.ready()) {
        try { t.send(m); } catch { /* 单通道抖动：其余通道兜底 */ }
      }
    }
  }
}
