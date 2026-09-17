//  RemoteView.ts ─
//  联机·远端成员渲染（稳定版 v3）：
//  纯插值主线 —— 以快照「服务端时间戳 t + 帧号 frame」为时间基准，
//  渲染点单调推进（永不回退），杜绝"瞬移/跳变"。
//  预测/校准机制默认关闭（只保留帧号流），不干预插值。

import type { Renderer } from "../engine/Renderer";
import type { NetSnapshot, NetTank, NetProjectile, NetLootDrop, NetPowerUp, NetBase, NetLvlChoice, CheckpointPlayer, NetWarehouse } from "../net/NetTypes";
import { Tilemap, TILE_SIZE, TileType } from "../game/Tilemap";
import { DIR_ANGLES } from "../game/Tank";
import { POWERUP_INFO } from "../systems/powerup/PowerUpSystem";
import { Minimap } from "./Minimap";
import { SideInfoPanel, type RemoteInfoSource } from "./SideInfoPanel";
import { drawShopPanel, drawShopHint } from "../systems/base/BaseShop";
import { getModule } from "../systems/wand/ModuleRegistry";
import type { ShopStockView } from "../net/NetTypes";
// v2.15 美化模块：RemoteView 使用与主机相同的渲染逻辑，确保联机版本一致
import { renderTile, renderTileState } from "./MapVisual";
import { drawTankBody, drawTankShadow } from "./TankVisual";
import { renderBase as renderBaseVisual } from "./BaseVisual";
import { renderLoot, renderPowerUps, renderProjectiles } from "./EntityVisual";
import type { Tank } from "../game/Tank";
import type { BiomeId } from "../systems/terrain/MapGenerator";
// ── net-sync-core 通用资产：插值缓冲由模块 Interpolator 驱动（自适应延迟算法 = v2.6.7 固化）──
import { Interpolator } from "../../net-sync-core/core";
import { netSnapshotToState, stateToNetSnapshot } from "../../net-sync-core/adapters/tank-adapter";

// 敌人等级 → 颜色/尺寸（与 Enemy ENEMY_CONFIGS 视觉一致）
const ENEMY_VIS: Record<string, { color: string; w: number }> = {
  F: { color: "#964", w: 24 },
  C: { color: "#696", w: 26 },
  B: { color: "#66a", w: 28 },
  A: { color: "#a44", w: 30 },
  S: { color: "#f22", w: 40 },
  BOSS: { color: "#f0f", w: 56 },
};
// v2.15 旧的 TILE_COLORS 已删除，改用 MapVisual.renderTile 美化渲染

export class RemoteView {
  /** 本玩家的玩家索引（从 start 获得） */
  myIndex: number = 1;
  /** v2.31 成员端：点击侧栏炮筒标签后待 main 强制上送的炮筒选择（-1=无；读后置 -1） */
  pendingCannonSelect: number = -1;
  /** v2.31 成员端：本机当前炮筒（快照 activeCannon 同步；main 用于 MobileControls 炮筒高亮） */
  myActiveCannon: number = 0;
  playersMeta: Array<{ clientId: number; name: string }> = [];
  /** v2.15 地图生物群系（与主机保持一致，确保美化渲染相同） */
  biome: BiomeId = "classic";
  /** 网络质量（由 main 每帧写入：RTT/抖动，服务器回声 ping 测量） */
  netHud: { rtt: number; jitter: number; p2p?: boolean } = { rtt: 0, jitter: 0 };
  /** 点选升级的回调（由 main 注入 → net.pickLevelUp） */
  onPickLevelUp?: (playerIdx: number, choice: number) => void;
  /** v2.9 基地商店：主机广播的库存（远端成员也能买，钱包在快照 scope.wallets 对齐） */
  shopStock: ShopStockView[] = [];
  shopNear = false;
  /** v2.14.1 商店改为手动打开：按 E 或点击基地切换（不再靠近自动弹出） */
  shopOpen = false;
  private shopBtnRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  /** 成员点选商店货物 → main 转 net.shopBuy（主机结算） */
  onShopBuy?: (playerIdx: number, choice: number) => void;

  setShopState(stock: ShopStockView[]): void { this.shopStock = stock || []; }

  // ── v2.16 仓库/背包查看（成员端 UI 对齐主机端） ──
  /** 最新检查点数据（由 main 在收到 checkpoint 消息时写入） */
  checkpointPlayers: CheckpointPlayer[] = [];
  checkpointWarehouse: NetWarehouse | null = null;
  /** 仓库面板开关 */
  warehouseOpen = false;
  /** 背包面板：null=关闭，0=P1，1=P2 */
  backpackOwner: number | null = null;
  /** v2.23 成员拖动装配/卸载请求（由 main 注入 → net.equipReq → 主机权威结算） */
  onEquipReq?: (playerIdx: number, action: "equip" | "unequip", invIdx: number, wand: number, slot: number) => void;
  /** v2.23 成员加固基地请求（信息栏"加固"按钮，由 main 注入 → net.fortifyReq → 主机权威结算） */
  onFortifyReq?: (playerIdx: number) => void;
  /** v2.23 操作反馈（equip_res/fortify_res 由 main 转发到这里显示） */
  actionResult: { msg: string; ok: boolean; t0: number } | null = null;
  showActionResult(msg: string, ok: boolean): void { this.actionResult = { msg, ok, t0: performance.now() }; }

  // ── v2.23 成员端拖动装配状态 ──
  /** 本次渲染的背包面板几何（供拖动命中/反馈绘制，与渲染共用同一份数据） */
  private panelRects: {
    px: number; py: number; pw: number; ph: number;
    invRects: Array<{ x: number; y: number; w: number; h: number; index: number; label: string }>;
    cannonRects: Array<{ x: number; y: number; w: number; h: number; wand: number; index: number; label: string }>;
  } | null = null;
  /** 拖动中的来源（null=未拖动） */
  private drag: { from: { kind: "inv"; index: number } | { kind: "wand"; wand: number; index: number }; x: number; y: number; label: string } | null = null;

  /** v2.23 背包面板是否打开（main 据此切换 MobileControls 覆盖层，让出触摸给拖动） */
  isBackpackPanelOpen(): boolean { return this.backpackOwner !== null; }

  /** v2.23 拖动起点：命中背包格/炮筒槽则进入拖动，返回 true（main 在成员端 pointerdown 调用） */
  dragPointerDown(x: number, y: number): boolean {
    if (this.backpackOwner === null || !this.panelRects) return false;
    for (const r of this.panelRects.invRects) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        this.drag = { from: { kind: "inv", index: r.index }, x, y, label: r.label };
        return true;
      }
    }
    for (const r of this.panelRects.cannonRects) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        this.drag = { from: { kind: "wand", wand: r.wand, index: r.index }, x, y, label: r.label };
        return true;
      }
    }
    return false;
  }
  dragPointerMove(x: number, y: number): void { if (this.drag) { this.drag.x = x; this.drag.y = y; } }
  dragPointerUp(x: number, y: number): void {
    if (!this.drag || this.backpackOwner === null) return;
    const from = this.drag.from;
    const label = this.drag.label;
    this.drag = null;
    const pr = this.panelRects;
    if (!pr) return;
    // 背包格 → 拖到炮筒槽 = 装入
    if (from.kind === "inv") {
      const t = pr.cannonRects.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      if (t) {
        this.onEquipReq?.(this.backpackOwner, "equip", from.index, t.wand, t.index);
      } else {
        this.actionResult = { msg: "拖到炮筒槽位再松手", ok: false, t0: performance.now() };
      }
      return;
    }
    // 炮筒槽 → 拖回背包区/面板 = 卸下
    const onInv = pr.invRects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    if (onInv || (x >= pr.px && x < pr.px + pr.pw && y >= pr.py && y < pr.py + pr.ph)) {
      this.onEquipReq?.(this.backpackOwner, "unequip", 0, from.wand, from.index);
    } else {
      this.actionResult = { msg: `${label} 未卸下（拖到背包区松手）`, ok: false, t0: performance.now() };
    }
  }

  setCheckpoint(players: CheckpointPlayer[], warehouse: NetWarehouse): void {
    this.checkpointPlayers = players || [];
    this.checkpointWarehouse = warehouse || null;
  }

  /** v2.17 资源包应用回调（main 在收到 checkpoint 中的 assetPack 时调用） */
  onAssetPackApplied(version: string): void {
    this.assetPackReady = true;
    this.assetPackVersion = version;
    this.assetPackAppliedAt = performance.now();
  }

  /** v2.18 调试面板开关：默认关闭，按 F3 切换（避免正常游戏中显示高精度调试数据） */
  showDebug = false;
  toggleDebug(): void { this.showDebug = !this.showDebug; }

  /** v2.14.1 成员端切换商店开关（main 在 E 键边沿调用；需已在基地半径内） */
  toggleShop(): void {
    if (this.shopStock.length === 0) return;
    if (!this.nearBaseNow()) return;
    this.shopOpen = !this.shopOpen;
  }

  /** 据最新快照判断自己是否在基地半径内（商店打开/购买按钮的前提） */
  private nearBaseNow(): boolean {
    const snap = this.getLatestSnap();
    if (!snap) return false;
    const self = snap.players.find((p) => p.team === 0 && p.playerId === this.myIndex);
    if (!self) return false;
    return Math.hypot(self.x - snap.base.x, self.y - snap.base.y) < 95;
  }

  // ── 远端升级面板（主机广播的升级选项）──
  lvlPlayerIdx = -1;
  lvlChoices: NetLvlChoice[] = [];
  private lvlDeadline = 0;          // 本地绝对时间(performance.now)，超时自动隐藏（主机 15s 自动选兜底）
  private lvlBtnRects: Array<{ x: number; y: number; w: number; h: number }> = [];

  setLevelUp(playerIdx: number, choices: NetLvlChoice[]): void {
    this.lvlPlayerIdx = playerIdx;
    this.lvlChoices = choices;
    this.lvlDeadline = performance.now() + 14000;
  }
  private clearLevelUp(): void {
    this.lvlPlayerIdx = -1;
    this.lvlChoices = [];
    this.lvlBtnRects = [];
  }
  /** 触屏/鼠标点选：升级面板优先，其次基地商店面板，命中即回传选择 */
  tap(x: number, y: number): void {
    if (performance.now() >= this.lvlDeadline) { this.clearLevelUp(); }
    if (this.lvlPlayerIdx >= 0 && this.lvlChoices.length > 0) {
      for (let i = 0; i < this.lvlBtnRects.length; i++) {
        const b = this.lvlBtnRects[i];
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          this.onPickLevelUp?.(this.lvlPlayerIdx, i);
          this.clearLevelUp();
          return;
        }
      }
    }
    // v2.16 快捷操作按钮（仓/P1/P2）：成员端也能查看仓库和双方背包
    const infoClick = this.sidePanel?.handleClick(x, y);
    if (infoClick) {
      if (infoClick.kind === "warehouse") {
        this.warehouseOpen = !this.warehouseOpen;
        this.backpackOwner = null;
        return;
      }
      if (infoClick.kind === "backpack") {
        this.backpackOwner = this.backpackOwner === infoClick.pi ? null : infoClick.pi;
        this.warehouseOpen = false;
        return;
      }
      // v2.31 成员端点击侧栏炮筒标签 → 记录待发送（main 下一帧强制上送 selectCannon，主机直选切炮）
      if (infoClick.kind === "cannonTab") {
        this.pendingCannonSelect = infoClick.index;
        return;
      }
    }
    // v2.14.1 基地商店（成员面板）：手动打开/关闭 —— 点商品购买、点面板外关闭、点基地切换
    const snap = this.getLatestSnap();
    const near = this.nearBaseNow();
    this.shopNear = near;
    if (near && snap && this.shopStock.length > 0) {
      if (this.shopOpen) {
        for (let i = 0; i < this.shopBtnRects.length; i++) {
          const b = this.shopBtnRects[i];
          if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
            this.onShopBuy?.(this.myIndex, i);
            return;
          }
        }
        const bx = snap.base.x, by = snap.base.y;
        const onBase = (x - bx) * (x - bx) + (y - by) * (y - by) <= 52 * 52;
        if (!onBase) this.shopOpen = false;   // 点面板外（非基地）→ 关闭
        return;
      }
      // 未打开：点基地本体 或 点商店按钮 → 打开
      const bx = snap.base.x, by = snap.base.y;
      const onBase = (x - bx) * (x - bx) + (y - by) * (y - by) <= 52 * 52;
      const onShopBtn = this.shopBtnHintRect
        && x >= this.shopBtnHintRect.x && x <= this.shopBtnHintRect.x + this.shopBtnHintRect.w
        && y >= this.shopBtnHintRect.y && y <= this.shopBtnHintRect.y + this.shopBtnHintRect.h;
      if (onBase || onShopBtn) {
        this.shopOpen = true;
      }
    }
  }

  private tilemap: Tilemap | null = null;
  private lastMap: number[][] | null = null;
  /** v2.17 瓦片受击闪光（与主机 Tilemap.render 同一机制：HP减少时触发白色闪光） */
  private hitFlash: Map<number, number> = new Map();
  private prevHp: Int16Array | null = null;
  private mini: Minimap | null = null;   // 成员端小地图（与主机同锚点：横屏=右侧信息栏右上 / 竖屏=底部信息栏右上）
  /** 远端信息栏（快照驱动，与主机 SideInfoPanel 同一布局区域：右侧竖栏 / 底部横条） */
  private sidePanel: SideInfoPanel | null = null;

  // ── 快照缓冲 + 渲染时间（net-sync-core Interpolator 驱动，自适应延迟算法 = v2.6.7 固化）──
  // v2.36 高延迟链路（公网中继+蜂窝 RTT 600~1000ms / 抖动~100ms）进一步加大缓冲窗口：
  // 宁可多 ~150ms 显示延迟，也避免缓冲欠载导致的"位置回弹/画面重放"
  private readonly interp = new Interpolator({
    delayMinMs: 150, delayMaxMs: 800, adaptive: true,
    stepMs: 34, catchUpMult: 2.2, backoffMult: 0.6, bufferSize: 60,
  });
  private lastFrame = -1;
  private firstFrameRecv = false;

  // v2.15 调试信息：快照接收/解码/插值状态（帮助定位2号机数据不全的问题）
  private debugSnapCount = 0;
  private debugLastFrame = -1;
  private debugLastT = 0;
  private debugPlayersCount = 0;
  private debugEnemiesCount = 0;
  private debugProjectilesCount = 0;
  private debugLastPlayers: NetTank[] = [];
  private debugLastEnemies: NetTank[] = [];
  private debugDecodeErrors = 0;

  // ── v2.17 资源包同步状态 ──
  /** 是否已收到并应用主机资源包 */
  private assetPackReady = false;
  /** 已应用的资源包版本 */
  private assetPackVersion = "本地默认";
  /** 资源包应用时间戳（用于显示"已同步"提示） */
  private assetPackAppliedAt = 0;
  /** v2.35 等待资源包起始时间（超时保护：8s 未收到 → 用本地资源,不再无限"下载中"） */
  private assetPackWaitStart = 0;
  /** v2.35 资源包同步是否失败（超时回退本地） */
  private assetPackFailed = false;

  // ── P2 本地预测（run-ahead + 权威校正）：消除高延迟下"自己不动"的延迟感 ──
  /** 本成员当前按压的方向（由 main 每帧按本地 P1 输入写入，含触屏/手柄合并结果） */
  myInputPref: { up: boolean; down: boolean; left: boolean; right: boolean } =
    { up: false, down: false, left: false, right: false };
  /** 预测用的坦克速度估计（px/s，相邻权威快照位移 EMA；未测到时用默认） */
  private pSpeed = 0;
  private lastSelfSnap: NetTank | null = null;
  private lastSelfT = 0;
  /** 方向按下基准：{dir,t(按住时长起点 wallclock), base(按下瞬间权威坐标)} */
  private pressEntry: { dir: string; t: number; base: { x: number; y: number } } | null = null;
  private readonly DEFAULT_TANK_SPEED = 75;   // 轻/狙 80、重/工 60，取中值；测速后即被覆盖
  private readonly PRED_HALF = 14;            // 预测碰撞盒半宽（约 28px 坦克）

  // ── 实体消失淡出（v2.6.6：按稳定 ID 检出死亡/移除 → 立即剔除 + 200ms 消亡特效，杜绝"死亡冻结/消失延迟"）──
  private readonly FADE_MS = 200;
  private fading = new Map<string, { kind: "tank" | "proj"; x: number; y: number; t0: number; w: number; color: string; angle: number }>();

  /** 登记一个刚消失的实体（按下一次按键唯一；重复出现只更新最后位置） */
  private beginFade(kind: "tank" | "proj", ent: NetTank | NetProjectile): void {
    const key = `${kind}:${ent.id}`;
    let f = this.fading.get(key);
    if (!f) {
      f = { kind, x: ent.x, y: ent.y, t0: performance.now(), w: 2, color: "#fff", angle: 0 };
      this.fading.set(key, f);
    }
    f.x = ent.x; f.y = ent.y;
    if (kind === "tank") {
      const t = ent as NetTank;
      const v = this.visualFor(t);
      f.w = v.w; f.color = v.color; f.angle = DIR_ANGLES[t.facing];
    } else {
      const pr = ent as NetProjectile;
      f.w = Math.max(2, pr.radius); f.color = pr.color;
    }
  }

  /** 坦克外观（颜色/尺寸）单一来源：正常渲染与死亡淡出共用，避免两处配色漂移 */
  private visualFor(t: NetTank): { color: string; w: number } {
    if (t.team === 0) {
      return { color: t.playerId === 1 ? "#39d94a" : "#3a8cff", w: t.playerId === 1 ? 28 : 26 };
    }
    const vis = ENEMY_VIS[t.gradeLabel ?? "F"] ?? ENEMY_VIS.F;
    return { color: t.isBoss ? "#f0f" : vis.color, w: vis.w };
  }

  setSnapshot(s: NetSnapshot): void {
    const frame = s.frame ?? 0;
    if (frame <= this.lastFrame) return; // 乱序/重复帧丢弃
    this.lastFrame = frame;
    const t = s.t ?? frame * 50;              // 老版本无 t 时用帧号近似

    // v2.15 更新调试信息
    this.debugSnapCount++;
    this.debugLastFrame = frame;
    this.debugLastT = t;
    this.debugPlayersCount = s.players?.length ?? 0;
    this.debugEnemiesCount = s.enemies?.length ?? 0;
    this.debugProjectilesCount = s.projectiles?.length ?? 0;
    this.debugLastPlayers = s.players ?? [];
    this.debugLastEnemies = s.enemies ?? [];

    // 缓冲写入 + 自适应插值延迟（v2.6.7 算法）+ 渲染时间基准 全部由模块 Interpolator 负责
    this.interp.push(netSnapshotToState(s));
    if (!this.firstFrameRecv) this.firstFrameRecv = true;

    // v2.15 同步生物群系（每次快照都同步，不依赖 map 字段，确保地图配色与主机一致）
    if (s.biome) this.biome = s.biome as BiomeId;

    // 地图只在首帧加载（后续快照不带 map 时沿用缓存）
    if (s.map && s.map !== this.lastMap) {
      this.lastMap = s.map;
      const tm = new Tilemap(s.map[0]?.length ?? 1, s.map.length);
      tm.loadFromArray(s.map);
      this.tilemap = tm;
      // 成员端小地图初始化（世界尺寸 = 地图格数 × 格大小）
      if (!this.mini) {
        const w = tm.cols * TILE_SIZE, h = tm.rows * TILE_SIZE;
        this.mini = new Minimap(w, h, w, h);
      }
    }

    // v2.15 地图增量变化：应用自上一快照起变化的瓦片（砖块打掉/临时墙放置等），
    // 确保2号机的地图状态与主机一致，不会出现"碰撞消失但显示还在"的bug
    if (s.mapChanges && s.mapChanges.length > 0 && this.tilemap) {
      for (const ch of s.mapChanges) {
        // v2.17 砖块象限伤害同步：有 quadHp 时按象限血量设置，否则按类型设置
        if (ch.type === TileType.Brick && ch.quadHp) {
          this.tilemap.setQuadHp(ch.col, ch.row, ch.quadHp);
        } else {
          this.tilemap.set(ch.col, ch.row, ch.type as TileType);
        }
      }
      // 同步更新 lastMap 缓存（如果有）
      if (this.lastMap) {
        for (const ch of s.mapChanges) {
          if (this.lastMap[ch.row] && this.lastMap[ch.row][ch.col] !== undefined) {
            this.lastMap[ch.row][ch.col] = ch.type;
          }
        }
      }
    }

    // P2 本地预测：用相邻快照自己坦克位移估测速度（EMA；移动中快速收敛）
    const self = s.players.find(p => p.playerId === this.myIndex);
    if (self) this.myActiveCannon = self.activeCannon;   // v2.31：同步本机炮筒（供全局虚拟按键高亮）
    if (self && this.lastSelfSnap && this.lastSelfT > 0) {
      const dt = s.t - this.lastSelfT;
      if (dt > 1 && dt < 1000) {
        const dx = self.x - this.lastSelfSnap.x, dy = self.y - this.lastSelfSnap.y;
        const dist = Math.hypot(dx, dy);
        const spd = dt > 0 ? (dist / dt) * 1000 : 0;
        if (spd > 0) {
          this.pSpeed = this.pSpeed <= 0 ? spd : this.pSpeed + 0.3 * (spd - this.pSpeed);
        }
      }
    }
    if (self) { this.lastSelfSnap = self; this.lastSelfT = s.t; }
  }

  hasSnapshot(): boolean { return this.firstFrameRecv; }
  isOver(): boolean { return this.getLatestSnap()?.scope.over ?? false; }

  /** v2.12 主机迁移：接替者取最新完整快照（解码产物，含 players/enemies/base/scope） */
  latestSnapshot(): NetSnapshot | null { return this.getLatestSnap(); }
  /** v2.12 主机迁移：接替者取首帧地图（重建本地主机世界用） */
  mapArray(): number[][] | null { return this.lastMap; }

  /** 调试：渲染时间推进统计（验证单调平滑）——由模块 Interpolator 提供 */
  debugStats(): { renderT: number; latestT: number; frames: number } {
    return { renderT: this.interp.debug().renderT, latestT: this.getLatestT(), frames: this.lastFrame };
  }

  /** 调试（v2.6.7）：自适应插值延迟状态（供单测/可视化断言读）——由模块 Interpolator 提供 */
  debugInterp(): { delay: number; interval: number; jitter: number; renderT: number; latestT: number; lag: number } {
    return this.interp.debug();
  }

  /** v2.35 成员端：暂停恢复/长卡顿后把插值器对齐到最新帧（消除旧帧回放） */
  flushInterp(): void { this.interp.flush(); }

  private getLatestSnap(): NetSnapshot | null {
    const latest = this.interp.latest();
    return latest ? stateToNetSnapshot(latest) : null;
  }
  private getLatestT(): number {
    return this.interp.latestT();
  }

  /** 渲染时间推进（单调不减）+ 找插值对 —— 由模块 Interpolator 驱动（算法 = v2.6.7 固化） */
  private findInterpolationPair(): { a: NetSnapshot | null; b: NetSnapshot | null; alpha: number } {
    if (!this.firstFrameRecv) return { a: null, b: null, alpha: 0 };
    this.interp.advance();
    const { a, b, alpha } = this.interp.pair();
    return {
      a: a ? stateToNetSnapshot(a) : null,
      b: b ? stateToNetSnapshot(b) : null,
      alpha,
    };
  }

  render(renderer: Renderer, now: number, viewW: number, viewH: number): void {
    renderer.clear("#111");
    const { a, b, alpha } = this.findInterpolationPair();
    const s = this.interpolateSnapshot(a, b, alpha);
    if (!s) {
      renderer.drawText("等待主机广播对局画面…", viewW / 2, viewH / 2,
        { font: "16px monospace", color: "#888", align: "center" });
      return;
    }
    const { ctx } = renderer;

    this.renderMap(ctx);
    this.renderTileStates(ctx, s);   // v2.17 地形状态（火/毒/电等）同步渲染
    this.renderBase(ctx, s, viewW, now);
    this.renderLoot(ctx, s);
    this.renderPowerUps(ctx, renderer, s, now);
    this.renderHandyman(ctx, s, now);   // v2.17 修复小人同步渲染
    this.renderProjectiles(ctx, s);
    this.renderExplosions(ctx, s);   // v2.17 爆炸特效同步渲染
    this.renderDamageNumbers(ctx, s);  // v2.17 伤害数字同步渲染
    this.applyLocalPrediction(s, now);
    for (const t of s.players) this.renderTank(ctx, t, now);
    for (const t of s.enemies) this.renderTank(ctx, t, now);
    this.renderFading(ctx, now);            // 已消失实体的 200ms 消亡特效（在存活实体之上绘制）
    this.renderCorpseMarkers(ctx, s, now);  // v2.7.1 成员端死亡玩家"救援标记"（常显，不再缺失）

    this.renderHUD(renderer, s, viewW);
    this.renderDeathHint(renderer, s, viewW);   // v2.22 成员阵亡提示：明确告诉 P2 怎么复活
    this.renderAssetPackStatus(renderer, viewW, now);   // v2.17 资源包下载/同步状态
    // 与主机同区域的信息栏（快照驱动，两个玩家的背包/经验/基地都能看见）
    // 顺序与主机一致：先信息栏背景，再小地图（信息栏不遮挡小地图）
    this.ensureSidePanel(renderer, s, viewW, viewH);
    this.renderMemberMinimap(renderer, s, viewW, viewH);
    this.renderLevelUpPanel(renderer, viewW, viewH);
    this.renderShopPanel(renderer, s, viewW, viewH);   // v2.9 成员基地商店（近基地时）
    // v2.16 成员端仓库/背包面板（与主机端 UI 对齐）
    if (this.warehouseOpen) this.renderWarehousePanel(renderer, viewW, viewH);
    if (this.backpackOwner !== null) this.renderBackpackPanel(renderer, viewW, viewH);

    if (s.scope.over) this.renderGameOver(renderer, viewW, viewH);

    // v2.18 调试面板默认关闭，按 F3 切换（避免正常游戏中显示高精度调试数据）
    if (this.showDebug) this.renderDebugPanel(ctx, viewW, viewH, s, a, b, alpha);
  }

  /** v2.15 调试面板：显示快照管道状态 */
  private renderDebugPanel(ctx: CanvasRenderingContext2D, viewW: number, viewH: number,
    s: NetSnapshot, a: NetSnapshot | null, b: NetSnapshot | null, alpha: number): void {
    const px = 8, py = viewH - 180, pw = 280, ph = 170;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = "#f66";
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    ctx.font = "bold 11px monospace";
    ctx.fillStyle = "#f66";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("🔧 调试面板 (2号机)", px + 8, py + 6);

    ctx.font = "10px monospace";
    ctx.fillStyle = "#fff";
    let ly = py + 24;
    const line = (label: string, val: string, color = "#fff") => {
      ctx.fillStyle = "#888";
      ctx.fillText(label, px + 8, ly);
      ctx.fillStyle = color;
      ctx.fillText(val, px + 120, ly);
      ly += 14;
    };

    line("快照接收数:", `${this.debugSnapCount}`, this.debugSnapCount > 0 ? "#4f4" : "#f66");
    line("最新帧号:", `${this.debugLastFrame}`, this.debugLastFrame >= 0 ? "#4f4" : "#f66");
    line("最新时间:", `${Math.round(this.debugLastT)}ms`);
    line("玩家数:", `${this.debugPlayersCount}`, this.debugPlayersCount > 0 ? "#4f4" : "#f66");
    line("敌人数:", `${this.debugEnemiesCount}`, this.debugEnemiesCount > 0 ? "#4f4" : "#fa0");
    line("子弹数:", `${this.debugProjectilesCount}`);
    line("插值A帧:", a ? `${a.frame}` : "null", a ? "#4f4" : "#f66");
    line("插值B帧:", b ? `${b.frame}` : "null", b ? "#4f4" : "#fa0");
    line("插值alpha:", `${alpha.toFixed(3)}`);
    line("渲染玩家:", `${s.players?.length ?? 0}`);
    line("渲染敌人:", `${s.enemies?.length ?? 0}`, s.enemies?.length > 0 ? "#4f4" : "#fa0");

    // 显示玩家和敌人ID
    if (this.debugLastPlayers.length > 0) {
      const ids = this.debugLastPlayers.map(p => `P${p.playerId}(${p.id})`).join(",");
      ctx.fillStyle = "#888";
      ctx.fillText("玩家IDs:", px + 8, ly);
      ctx.fillStyle = "#4af";
      ctx.fillText(ids.slice(0, 30), px + 120, ly);
      ly += 14;
    }
    if (this.debugLastEnemies.length > 0) {
      const ids = this.debugLastEnemies.slice(0, 4).map(e => `${e.gradeLabel ?? "?"}(${e.id})`).join(",");
      ctx.fillStyle = "#888";
      ctx.fillText("敌人IDs:", px + 8, ly);
      ctx.fillStyle = "#f84";
      ctx.fillText(ids.slice(0, 30), px + 120, ly);
    }

    ctx.restore();
  }

  /** 懒创建信息栏（布局规则与 GameModeCore 完全一致：横屏=右侧竖栏 / 竖屏=底部横条） */
  private ensureSidePanel(renderer: Renderer, s: NetSnapshot, viewW: number, viewH: number): void {
    if (this.sidePanel) {
      this.sidePanel.renderRemote(renderer, performance.now(), this.remoteInfoSource(s));
      return;
    }
    const cw = renderer.canvas?.width ?? viewW;
    const ch = renderer.canvas?.height ?? viewH;
    const infoW = cw - viewW;                       // >0 横屏：信息栏在右侧（宽=overscan）
    const infoH = ch - viewH;                       // >0 竖屏：信息栏在底部（高=overscan）
    const infoX = infoW > 0 ? viewW : 0;
    const infoY = infoH > 0 ? viewH : 0;
    // v2.21 竖屏已去掉小地图 → 信息栏内容不再需要给小地图让位（topSkipY=0）；
    // 横屏小地图在右侧信息栏顶 y=42，保留 topSkipY 避让。
    const topSkipY = infoW > 0 ? Math.max(0, 42 + (this.mini?.size ?? { w: 154, h: 123 }).h + 4 - 6) : 0;
    this.sidePanel = new SideInfoPanel(
      infoX, infoY, infoW > 0 ? infoW : viewW, infoH > 0 ? infoH : viewH,
      [], [], null as never, null as never, [],
      topSkipY, this.myIndex,
    );
    this.sidePanel.renderRemote(renderer, performance.now(), this.remoteInfoSource(s));
  }

  /** 把快照转成信息栏统一数据源（与本地模式同一区域展示两位玩家的背包/经验/基地） */
  private remoteInfoSource(s: NetSnapshot): RemoteInfoSource {
    return {
      players: s.players.map((p) => ({
        playerId: p.playerId,
        name: this.playersMeta[p.playerId]?.name,
        hp: p.hp, maxHp: p.maxHp, alive: p.alive, lives: p.lives,
        activeCannon: p.activeCannon,   // v2.31：成员端炮筒标签行高亮/切换
      })),
      base: { wallLevel: s.base.wallLevel, walls: s.base.walls, eagleHp: s.base.eagleHp, eagleMaxHp: s.base.eagleMaxHp },
      wallets: s.scope.wallets,
      bp: s.scope.bp,
    };
  }

  /**
   * P2 本地预测（self run-ahead）：仅对本成员自己的坦克生效。
   * 核心思路（客户端预测 + 权威校正）：
   *   当本地正按住一个方向时，以"按下瞬间的权威坐标"为基准 + 方向 × 速度 × 按住时长，
   *   得出理想预测位置 `pred`；显示位置 = 权威插值位置 `me` + clamp(pred - me)。
   *   权威快照会随时间追上来 → 差值收敛到 0，画面平滑回到纯权威，无跳变。
   *   撞墙（tilemap 判定）或松键/转向时直接回落到权威，避免外推穿墙。
   */
  private applyLocalPrediction(s: NetSnapshot, now: number): void {
    const idx = s.players.findIndex(p => p.team === 0 && p.playerId === this.myIndex);
    if (idx < 0) return;
    const me = s.players[idx];
    const pi = this.myInputPref;
    const dir = pi.up ? "up" : pi.down ? "down" : pi.left ? "left" : pi.right ? "right" : "";

    // 未移动 / 转向 / 松开 → 重置按压基准，用纯权威（内置平滑，无跳变）
    if (!dir) { this.pressEntry = null; return; }
    if (this.pressEntry && this.pressEntry.dir !== dir) { this.pressEntry = null; }
    if (!this.pressEntry) {
      this.pressEntry = { dir, t: now, base: { x: me.x, y: me.y } };
    }

    const spd = this.pSpeed > 0 ? this.pSpeed : this.DEFAULT_TANK_SPEED;
    const held = Math.min(now - this.pressEntry.t, 400);   // 预测时长上限 400ms，避免极端外推
    const pred = { x: this.pressEntry.base.x, y: this.pressEntry.base.y };
    if (dir === "up") pred.y -= spd * (held / 1000);
    else if (dir === "down") pred.y += spd * (held / 1000);
    else if (dir === "left") pred.x -= spd * (held / 1000);
    else pred.x += spd * (held / 1000);

    // 差值 = 预测 - 权威；只用"权威落后"的那一轴推进（沿按压方向），反向/到位则 0
    const dx = pred.x - me.x, dy = pred.y - me.y;
    const errX = dir === "left" ? Math.min(0, dx) : dir === "right" ? Math.max(0, dx) : 0;
    const errY = dir === "up" ? Math.min(0, dy) : dir === "down" ? Math.max(0, dy) : 0;
    // 距基准越远（超 3s 按压）越不可信，线性回退到权威，防长期按压后外推失真
    const trust = Math.max(0, 1 - held / 3000);
    const dispX = me.x + errX * trust, dispY = me.y + errY * trust;

    // 穿墙保护：目标格不可通行则回落权威（交给主机裁决）
    if (this.tilemap) {
      const h = this.PRED_HALF;
      if (this.tilemap.checkTankCollision(dispX - h, dispY - h, h * 2, h * 2, 0)) return;
    }

    me.x = Math.round(dispX); me.y = Math.round(dispY);
  }

  /** member小地图：与主机同一锚点（横屏=右侧信息栏右上 y42；v2.21 竖屏版去掉小地图） */
  private renderMemberMinimap(renderer: Renderer, s: NetSnapshot, viewW: number, viewH: number): void {
    if (!this.mini) return;   // 等待地图快照到达后再初始化（需要世界尺寸）
    const cw = renderer.canvas?.width ?? viewW;
    const ch = renderer.canvas?.height ?? viewH;
    const infoW = cw - viewW;                       // >0 横屏：信息栏在右侧
    if (infoW <= 0) return;   // v2.21 竖屏版去掉小地图
    const pts: Array<{ x: number; y: number; color: string; size?: number }> = [];
    for (const p of s.players) {
      if (!p.alive) continue;
      pts.push({ x: p.x, y: p.y, color: p.playerId === 0 ? "#3a8cff" : "#39d94a", size: 4 });
    }
    for (const e of s.enemies) {
      if (!e.alive) continue;
      pts.push({ x: e.x, y: e.y, color: e.isBoss ? "#f0f" : "#f44", size: e.isBoss ? 5 : 3 });
    }
    pts.push({ x: s.base.x, y: s.base.y, color: "#ffd700", size: 5 });
    const mm = this.mini.size;
    // 横屏小地图在右侧信息栏内左上对齐（避开顶栏）；竖屏已去掉
    const anchor = { x: viewW + 8, y: 42 };
    this.mini.render(renderer, pts, anchor);
  }

  /** 在 a(旧) 与 b(新) 之间按 alpha 插值；b 缺失时用 a */
  private interpolateSnapshot(a: NetSnapshot | null, b: NetSnapshot | null, alpha: number): NetSnapshot | null {
    if (!a) return null;
    if (!b || alpha >= 1 || alpha <= 0) return alpha >= 1 && b ? b : a;
    const lerp = (x: number, y: number) => x + (y - x) * alpha;
    const notNullT = (t: NetTank | null): t is NetTank => t !== null;
    const notNullP = (p: NetProjectile | null): p is NetProjectile => p !== null;

    // 坦克：按稳定 ID 匹配（全局唯一，跨 players/enemies 数组都不撞号）。
    //  b 中不存在 = 该实体已死亡/移除 → 立即登记淡出并剔除，杜绝"死亡冻结/消失延迟"。
    const lerpTank = (t: NetTank, tb: NetTank): NetTank & { facingAngle?: number } => {
      const fa = DIR_ANGLES[t.facing];
      const fb = DIR_ANGLES[tb.facing];
      let d = fb - fa;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return {
        ...t,
        // v2.7.1 位置取整到像素：避免亚像素抖动；转向≤90° 平滑、>90° 一步到位（防大跳变）
        x: Math.round(lerp(t.x, tb.x)), y: Math.round(lerp(t.y, tb.y)),
        hp: lerp(t.hp, tb.hp),
        facing: Math.abs(d) < 0.01 ? tb.facing : t.facing,
        facingAngle: Math.abs(d) <= Math.PI / 2 ? fa + d * alpha : DIR_ANGLES[tb.facing],
        activeCannon: tb.activeCannon,
        alive: tb.alive,
      };
    };
    const interpTank = (t: NetTank): NetTank | null => {
      if (t.id == null) {
        // 旧版快照（无 id）：回退 playerId 跨表匹配（旧行为，仅兼容老主机）
        const tb = [...b!.players, ...b!.enemies].find(q => q.id == null && q.playerId === t.playerId);
        return tb ? lerpTank(t, tb) : t;
      }
      const tb = b!.players.find(q => q.id === t.id) ?? b!.enemies.find(q => q.id === t.id);
      if (!tb) { this.beginFade("tank", t); return null; }
      return lerpTank(t, tb);
    };

    // 子弹：按稳定 ID 匹配（同一颗子弹跨帧不串位）；无 id 的老快照回退"类型+颜色+最近距离"启发式；已消失 → 淡出剔除
    const interpProj = (p: NetProjectile): NetProjectile | null => {
      let q: NetProjectile | null = null;
      if (p.id != null) {
        q = b!.projectiles.find(x => x.id === p.id) ?? null;
      } else {
        let best: NetProjectile | null = null;
        let bestD = 64; // 匹配阈值：超过 64px 视为新子弹，不插值
        for (const x of b!.projectiles) {
          if (x.type !== p.type || x.color !== p.color) continue;
          const d2 = Math.abs(x.x - p.x) + Math.abs(x.y - p.y);
          if (d2 < bestD) { bestD = d2; best = x; }
        }
        q = best;
      }
      if (!q) { this.beginFade("proj", p); return null; }
      return { ...p, x: Math.round(lerp(p.x, q.x)), y: Math.round(lerp(p.y, q.y)) };
    };

    const interpLoot = (d: NetLootDrop): NetLootDrop => {
      let best: NetLootDrop | null = null; let bestD = 30;
      for (const x of b!.loot) {
        if (x.type !== d.type) continue;
        const d2 = Math.abs(x.x - d.x) + Math.abs(x.y - d.y);
        if (d2 < bestD) { bestD = d2; best = x; }
      }
      return best ? { ...d, x: Math.round(lerp(d.x, best.x)), y: Math.round(lerp(d.y, best.y)) } : d;
    };

    return {
      ...a,
      players: a.players.map(interpTank).filter(notNullT),
      enemies: a.enemies.map(interpTank).filter(notNullT),
      projectiles: a.projectiles.map(interpProj).filter(notNullP),
      loot: a.loot.map(interpLoot),
      powerups: a.powerups,
      base: (() => {
        const bb = b!.base;
        const walls = a.base.walls.map((w, i) => ({
          ...w,
          hp: lerp(w.hp, bb.walls[i]?.hp ?? w.hp),
        }));
        // v2.16 独立小砖插值：按 side+index 匹配，血量线性插值
        let bricks = a.base.bricks;
        if (bricks && bb.bricks) {
          bricks = bricks.map((br) => {
            const match = bb.bricks!.find((x) => x.side === br.side && x.index === br.index);
            return match ? { ...br, hp: Math.round(lerp(br.hp, match.hp)) } : br;
          });
        }
        return { ...a.base, x: lerp(a.base.x, bb.x), y: lerp(a.base.y, bb.y), eagleHp: lerp(a.base.eagleHp, bb.eagleHp), walls, bricks };
      })(),
    };
  }

  private renderMap(ctx: CanvasRenderingContext2D): void {
    const t = this.tilemap;
    if (!t) return;
    const { cols, rows } = t;
    const now = performance.now();
    const dt = 1 / 60;

    // 懒初始化上一帧HP快照
    if (!this.prevHp || this.prevHp.length !== cols * rows) {
      this.prevHp = new Int16Array(cols * rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = t.get(c, r);
          this.prevHp[r * cols + c] = cell ? cell.hp : 0;
        }
      }
    }

    // v2.15 使用 MapVisual.renderTile 美化渲染，确保与主机版本一致
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const cell = t.get(c, r);
        if (!cell) continue;
        const x = c * TILE_SIZE, y = r * TILE_SIZE;

        // v2.17 受击闪光检测：HP减少时触发白色闪光
        if (cell.maxHp > 0 && cell.hp < this.prevHp[idx]) {
          this.hitFlash.set(idx, 0.18);
        }
        this.prevHp[idx] = cell.hp;

        renderTile(ctx, cell, x, y, c, r, now, this.biome);

        // v2.17 受击闪光渲染：白色覆盖层（从亮到暗衰减）
        const flash = this.hitFlash.get(idx);
        if (flash && flash > 0) {
          const alpha = Math.min(1, flash / 0.18) * 0.7;
          ctx.fillStyle = `rgba(255,255,255,${alpha})`;
          ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
          const newFlash = flash - dt;
          if (newFlash > 0) this.hitFlash.set(idx, newFlash);
          else this.hitFlash.delete(idx);
        }
      }
    }
  }

  /** v2.17 渲染地形状态（火/毒/电/冰面等），数据来自快照 tileStates */
  private renderTileStates(ctx: CanvasRenderingContext2D, s: NetSnapshot): void {
    if (!s.tileStates || s.tileStates.length === 0) return;
    const now = performance.now();
    for (const st of s.tileStates) {
      const x = st.col * TILE_SIZE, y = st.row * TILE_SIZE;
      // 构造一个临时 TileState 传给共享渲染函数
      const state = { element: st.element as any, timer: st.timer, intensity: st.intensity };
      renderTileState(ctx, state, x, y, now, st.col, st.row);
    }
  }

  /** v2.17 渲染爆炸特效，数据来自快照 explosions */
  private renderExplosions(ctx: CanvasRenderingContext2D, s: NetSnapshot): void {
    if (!s.explosions || s.explosions.length === 0) return;
    for (const fx of s.explosions) {
      const progress = Math.min(1, fx.t / fx.maxT);
      const alpha = 1 - progress;
      const r = fx.r * (0.3 + progress * 0.7);
      ctx.save();
      ctx.globalAlpha = alpha;
      if (typeof ctx.createRadialGradient === "function") {
        const grad = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, r);
        grad.addColorStop(0, "#fff");
        grad.addColorStop(0.3, "#f80");
        grad.addColorStop(1, "rgba(200,0,0,0)");
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = "#f80";
      }
      if (typeof ctx.beginPath === "function" && typeof ctx.arc === "function") {
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(fx.x - r, fx.y - r, r * 2, r * 2);
      }
      ctx.restore();
    }
  }

  /** v2.17 修复小人（基地维修工）渲染 —— 与主机 BaseRepairSystem.render 视觉对齐 */
  private renderHandyman(ctx: CanvasRenderingContext2D, s: NetSnapshot, now: number): void {
    const hm = s.handyman;
    if (!hm) return;

    // 墓碑状态（小人阵亡）
    if (hm.grave || !hm.isAlive) {
      const bob = Math.sin(now / 300) * 1.5;
      ctx.fillStyle = "#8a8a8a";
      ctx.beginPath();
      ctx.arc(hm.x, hm.y - 8 + bob, 7, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(hm.x - 7, hm.y - 8 + bob, 14, 12);
      ctx.fillStyle = "#555";
      ctx.fillRect(hm.x - 4, hm.y - 4 + bob, 8, 7);
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hm.x, hm.y - 3 + bob); ctx.lineTo(hm.x, hm.y + 2 + bob);
      ctx.moveTo(hm.x - 2.5, hm.y - 0.5 + bob); ctx.lineTo(hm.x + 2.5, hm.y - 0.5 + bob);
      ctx.stroke();
      return;
    }

    // 活的修复小人
    const animTime = now / 1000;
    const bob = Math.sin(animTime * 8) * (hm.walking ? 1.2 : 0.6);
    const step = Math.sin(animTime * 10);
    const dir = hm.dir;

    ctx.save();
    ctx.translate(hm.x, hm.y);

    // 影子
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(0, 12, 9, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // 腿（走路摆动）
    ctx.strokeStyle = "#3a4a8a";
    ctx.lineWidth = 3;
    const legSwing = hm.walking ? step * 3 : 0;
    ctx.beginPath();
    ctx.moveTo(-3, 6); ctx.lineTo(-3 + legSwing, 11);
    ctx.moveTo(3, 6);  ctx.lineTo(3 - legSwing, 11);
    ctx.stroke();

    // 身体（蓝色工装）
    ctx.fillStyle = "#3f7fd4";
    ctx.fillRect(-6, -4 + bob, 12, 12);
    // 腰带
    ctx.fillStyle = "#2a3a6a";
    ctx.fillRect(-6, 4 + bob, 12, 2);

    // 手臂 + 锤子
    ctx.strokeStyle = "#ffcc99";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(6, 0 + bob);
    const swing = hm.repairing ? Math.sin(animTime * 14) * 5 : 2;
    ctx.lineTo(6 + 4, 2 + bob + swing);
    ctx.stroke();
    // 锤头
    ctx.fillStyle = "#b0622a";
    ctx.save();
    ctx.translate(10 + dir, 2 + bob + swing + 1);
    ctx.rotate(dir * (hm.repairing ? swing * 0.2 : 0));
    ctx.fillRect(-4, -2, 9, 4);
    ctx.fillStyle = "#6a3a10";
    ctx.fillRect(-4, -1, 9, 1);
    ctx.restore();

    // 头
    ctx.fillStyle = "#ffcc99";
    ctx.beginPath();
    ctx.arc(0, -11 + bob, 6, 0, Math.PI * 2);
    ctx.fill();
    // 眼睛
    ctx.fillStyle = "#222";
    ctx.beginPath(); ctx.arc(dir * 2.5, -12 + bob, 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(dir * 5.5, -12 + bob, 1.3, 0, Math.PI * 2); ctx.fill();
    // 腮红
    ctx.fillStyle = "rgba(255,120,120,0.5)";
    ctx.beginPath(); ctx.arc(dir * 7, -9.5 + bob, 1.5, 0, Math.PI * 2); ctx.fill();
    // 微笑
    ctx.strokeStyle = "#c33";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(dir * 4, -8 + bob, 2, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();

    // 安全帽
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.arc(0, -14 + bob, 6.5, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(-6.5, -15 + bob, 13, 2);
    ctx.fillStyle = "#e0a000";
    ctx.fillRect(-2, -19 + bob, 4, 3);

    ctx.restore();

    // 修复中提示
    if (hm.repairing) {
      ctx.fillStyle = "#ffd700";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(hm.repairingEagle ? "修基地" : "修墙", hm.x, hm.y - 24);
    }
  }

  /** v2.17 伤害数字（飘字）渲染 —— 与主机 CombatSystem.renderDamageNumbers 对齐 */
  private renderDamageNumbers(ctx: CanvasRenderingContext2D, s: NetSnapshot): void {
    if (!s.damageNumbers || s.damageNumbers.length === 0) return;
    for (const dn of s.damageNumbers) {
      ctx.save();
      ctx.fillStyle = dn.color || (dn.crit ? "#ff4" : "#fff");
      ctx.font = dn.crit ? "bold 15px monospace" : "12px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (dn.crit) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.strokeText(String(dn.value), dn.x, dn.y);
      }
      ctx.fillText(String(dn.value), dn.x, dn.y);
      ctx.restore();
    }
  }

  private renderBase(ctx: CanvasRenderingContext2D, s: NetSnapshot, _viewW: number, now: number): void {
    const b = s.base;
    // v2.15 调用共享渲染模块 BaseVisual，确保主机端和成员端渲染完全一致
    // v2.16 传递独立小砖数据，逐块渲染
    renderBaseVisual(ctx, {
      x: b.x,
      y: b.y,
      eagleHp: b.eagleHp,
      eagleMaxHp: b.eagleMaxHp,
      isDestroyed: b.isDestroyed,
      walls: b.walls,
      bricks: b.bricks,
      // 成员端快照可能不包含修复闪光/进度信息，传 undefined 即可
    }, now);
  }

  /** v2.15 调用共享渲染模块 EntityVisual，确保主机端和成员端渲染完全一致 */
  private renderLoot(ctx: CanvasRenderingContext2D, s: NetSnapshot): void {
    renderLoot(ctx, {
      drops: s.loot,
      viewer: this.myIndex,
    }, performance.now());
  }

  private renderPowerUps(ctx: CanvasRenderingContext2D, _r: Renderer, s: NetSnapshot, now: number): void {
    renderPowerUps(ctx, {
      powerups: s.powerups,
    }, now);
  }

  private renderProjectiles(ctx: CanvasRenderingContext2D, s: NetSnapshot): void {
    renderProjectiles(ctx, {
      projectiles: s.projectiles,
    }, performance.now());
  }

  /** 已消失实体的消亡特效：随时间收缩+淡出，200ms 后清除（无残影、无冻结） */
  private renderFading(ctx: CanvasRenderingContext2D, now: number): void {
    for (const [key, f] of this.fading) {
      const p = (now - f.t0) / this.FADE_MS;
      if (p >= 1) { this.fading.delete(key); continue; }
      ctx.save();
      ctx.globalAlpha = 1 - p;
      if (f.kind === "proj") {
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(f.x, f.y, Math.max(1, f.w), 0, Math.PI * 2);
        ctx.fill();
      } else {
        const s = Math.max(2, f.w * (1 - p * 0.5));
        ctx.translate(f.x, f.y);
        ctx.rotate(f.angle);
        ctx.fillStyle = f.color;
        ctx.fillRect(-s / 2, -s / 2, s, s);
      }
      ctx.restore();
    }
  }

  /** v2.7.1 成员端死亡玩家的"救援标记"：红色标圈 + ✕ 常显（有剩余生命才可救） */
  private renderCorpseMarkers(ctx: CanvasRenderingContext2D, s: NetSnapshot, now: number): void {
    for (const t of s.players) {
      // v2.21 仅绘制"还在等救援"的队友尸体；我方/无剩余生命者不画（无人救援 → 不提示）
      if (t.alive || t.team !== 0 || !t.lives || t.lives <= 0) continue;
      if (t.playerId === this.myIndex) continue;   // 自己死后不需要"✕"提示（自动复活）
      const pulse = 0.55 + 0.15 * Math.sin(now / 380);
      ctx.fillStyle = `rgba(255,60,60,${pulse.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#f44"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "#f44"; ctx.font = "10px monospace"; ctx.textAlign = "center";
      ctx.fillText("✕", t.x, t.y + 4);
    }
  }

  private renderTank(ctx: CanvasRenderingContext2D, t: NetTank, now: number): void {
    if (!t.alive) return;
    const { w } = this.visualFor(t);
    const h = w;
    // v2.7：优先用连续插值角（转向平滑，消除抖/糊），无则用枚举朝向
    const ang = (t as NetTank & { facingAngle?: number }).facingAngle ?? DIR_ANGLES[t.facing];

    // v2.17 眩晕闪白（与主机一致）
    if (t.stunned && Math.floor(now / 100) % 2 === 0) {
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(ang);
      ctx.fillStyle = "#fff8";
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(t.x, t.y);

    // v2.15 影子必须在旋转之前绘制，确保影子方向固定（右下方），不随坦克朝向旋转
    drawTankShadow(ctx, w, h);

    ctx.rotate(ang);
    ctx.globalAlpha = t.hidden ? 0.35 : 1;   // v2.17 与主机一致：森林隐藏 0.35

    // v2.15 美化：使用与主机相同的 TankVisual.drawTankBody 渲染，确保联机版本一致
    const tankAdapter = {
      config: { width: w, height: h },
      team: t.team,
      playerId: t.playerId,
      grade: t.gradeLabel,
      isBoss: t.isBoss,
      hitFlashTimer: 0,
    } as unknown as Tank;
    drawTankBody(ctx, tankAdapter, now);

    // v2.18 移除武器挂载位标记（与 Tank.ts 对齐），炮筒只在主方向显示

    // v2.17 Boss 皇冠 + 紫色发光边框
    if (t.isBoss) {
      ctx.save();
      ctx.rotate(-ang); // 皇冠保持正向
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("♛", 0, -h / 2 - 6);
      ctx.strokeStyle = `rgba(255, 0, 255, ${0.2 + 0.3 * Math.sin(now / 300)})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);
      ctx.restore();
    }

    // v2.17 无敌闪光（白色边框闪烁）
    if (t.buffs?.includes("🛡") && Math.floor(now / 150) % 2 === 0) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }

    ctx.globalAlpha = 1;
    ctx.restore();

    // ── 敌军等级角标（世界坐标）──
    ctx.save();
    ctx.translate(t.x, t.y);
    if (t.team !== 0 && t.gradeLabel) {
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(-7, -h / 2 - 14, 14, 12);
      ctx.strokeStyle = t.isBoss ? "#ffd700" : "#f44";
      ctx.lineWidth = 1;
      ctx.strokeRect(-7, -h / 2 - 14, 14, 12);
      ctx.fillStyle = t.isBoss ? "#ffd700" : "#f44";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(t.gradeLabel, 0, -h / 2 - 4);
    }

    // v2.17 Buff/状态图标（🔥🛡✦⚡❄等）
    if (t.buffs && t.buffs.length > 0) {
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      t.buffs.forEach((ic, i) => {
        ctx.fillText(ic, w / 2 + 5, -h / 2 + 6 + i * 13);
      });
    }
    ctx.restore();

    // HP bar
    const barW = w + 4, barH = 4;
    const bx = t.x - barW / 2, by = t.y - h / 2 - 8;
    ctx.fillStyle = "#400"; ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = "#0f0"; ctx.fillRect(bx, by, barW * (t.hp / Math.max(1, t.maxHp)), barH);

    // v2.17 复活进度条（队友救援中）
    if (t.reviveProgress && t.reviveProgress > 0) {
      ctx.fillStyle = "#ff0";
      ctx.fillRect(bx, by - 6, barW * (t.reviveProgress / 4), 3);
    }
  }

  private renderHUD(r: Renderer, s: NetSnapshot, W: number): void {
    const { ctx } = r;
    // 顶栏 40px 两行，与主机 OnlineHostMode.render 同一结构（第一行状态 / 第二行网络质量）
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, W, 40);
    const meCol = this.myIndex === 0 ? "#6af" : "#4c4";
    r.drawText(`${this.playersMeta[this.myIndex]?.name ?? "你"} [P${this.myIndex + 1}]`, 8, 4,
      { font: "13px monospace", color: meCol });
    r.drawText(`波次 ${s.scope.wave}`, 170, 4, { font: "13px monospace", color: "#ff0" });
    // v2.30 难度/隐藏分（与主机 EndlessMode / OnlineHostMode 顶栏同结构）
    if (s.scope.diff !== undefined) {
      r.drawText(`难度 ${s.scope.diff}`, 250, 4, { font: "12px monospace", color: "#fa0" });
    }
    if (s.scope.hidden !== undefined) {
      r.drawText(`隐藏分 ${s.scope.hidden}`, 322, 4, { font: "12px monospace", color: "#b9f" });
    }
    const wv = (s.scope.wallets || [])[this.myIndex];
    if (wv !== undefined) r.drawText(`EXP ${wv}`, W - 8, 3,
      { font: "bold 14px sans-serif", color: "#ffd700", align: "right" });

    // 第二行（y=21）：网络质量 —— 成员标识 + RTT（与主机布局对齐：标签在左，RTT 让位给难度信息后右移）
    r.drawText(this.netHud.p2p ? "联机·成员·P2P" : "联机·成员·中继", 8, 21,
      { font: "12px monospace", color: this.netHud.p2p ? "#2d9" : "#666" });
    const nc = this.netHud.rtt <= 0 ? "#666" : this.netHud.rtt < 100 ? "#4f4" : this.netHud.rtt < 220 ? "#fa0" : "#f55";
    r.drawText(`RTT ${Math.round(this.netHud.rtt)}ms·抖${Math.round(this.netHud.jitter)}`, 150, 21,
      { font: "11px monospace", color: nc });
    // 成员特有（右对齐，与主机"P2入"占同侧）：插值缓冲自适应深度
    const delayMs = this.interp.debug().delay;
    const dc = delayMs <= 60 ? "#4f4" : delayMs <= 140 ? "#fa0" : "#f55";
    r.drawText(`插${delayMs}ms`, W - 8, 21, { font: "11px monospace", color: dc, align: "right" });
  }

  /**
   * v2.22 成员阵亡提示：明确告诉 P2 怎么复活。
   * 联机 P2（非单机）死后 3 秒倒计时结束 → 按开火键自复活（主机权威裁决）；有剩余生命才提示。
   */
  private renderDeathHint(r: Renderer, s: NetSnapshot, W: number): void {
    if (s.scope.over) return;
    const self = s.players.find((p) => p.team === 0 && p.playerId === this.myIndex);
    if (!self || self.alive || !self.lives || self.lives <= 0) return;
    const { ctx } = r;
    const timer = self.respawnTimer ?? 0;
    const text = timer > 0
      ? `你已阵亡 · ${Math.ceil(timer)} 秒后可复活`
      : "你已阵亡 · 按住开火键复活";
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.beginPath();
    ctx.roundRect(W / 2 - 118, 46, 236, 28, 10);
    ctx.fill();
    ctx.strokeStyle = "#f44";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(W / 2 - 118, 46, 236, 28, 10);
    ctx.stroke();
    r.drawText(text, W / 2, 60,
      { font: "12px monospace", color: "#ff8", align: "center" });
    ctx.restore();
  }

  /**
   * v2.17 资源包下载/同步状态 UI
   * - 未收到资源包时：顶部显示"正在下载资源包…"
   * - 刚应用时：显示"资源包已同步 vX.XX"（3秒后淡出）
   * - 已同步：HUD 右上角显示资源包版本号
   */
  private renderAssetPackStatus(r: Renderer, W: number, now: number): void {
    const { ctx } = r;
    const sinceApplied = now - this.assetPackAppliedAt;

    if (!this.assetPackReady) {
      // v2.35 超时保护：8 秒未收到主机资源包 → 回退本地资源（避免"永远下载中"）
      if (this.assetPackWaitStart === 0) this.assetPackWaitStart = now;
      if (now - this.assetPackWaitStart > 8000) {
        this.assetPackReady = true;
        this.assetPackVersion = "本地";
        this.assetPackFailed = true;
        this.assetPackAppliedAt = now;
      }
      // 等待下载中：居中顶部提示
      const pulse = 0.6 + 0.4 * Math.sin(now / 300);
      ctx.fillStyle = `rgba(0,0,0,${0.75 * pulse})`;
      ctx.fillRect(W / 2 - 140, 48, 280, 28);
      ctx.strokeStyle = `rgba(100,180,255,${pulse})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(W / 2 - 140, 48, 280, 28);
      r.drawText("⬇ 正在下载主机资源包…", W / 2, 58,
        { font: "13px monospace", color: "#8cf", align: "center" });
      r.drawText("确保联机视觉一致", W / 2, 72,
        { font: "10px monospace", color: "#689", align: "center" });
    } else if (this.assetPackFailed && sinceApplied < 3500) {
      // v2.35 同步失败提示（3.5 秒淡出）
      const alpha = sinceApplied < 2500 ? 1 : Math.max(0, 1 - (sinceApplied - 2500) / 1000);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(50,40,0,0.85)";
      ctx.fillRect(W / 2 - 150, 48, 300, 26);
      ctx.strokeStyle = "#fa0";
      ctx.lineWidth = 1;
      ctx.strokeRect(W / 2 - 150, 48, 300, 26);
      r.drawText("⚠ 资源包同步失败，已使用本地资源", W / 2, 59,
        { font: "12px monospace", color: "#fc6", align: "center" });
      ctx.restore();
    } else if (sinceApplied < 3000) {
      // 刚同步完成：显示成功提示（3秒淡出）
      const alpha = sinceApplied < 2000 ? 1 : Math.max(0, 1 - (sinceApplied - 2000) / 1000);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(0,40,0,0.85)";
      ctx.fillRect(W / 2 - 130, 48, 260, 26);
      ctx.strokeStyle = "#4f4";
      ctx.lineWidth = 1;
      ctx.strokeRect(W / 2 - 130, 48, 260, 26);
      r.drawText(`✓ 资源包已同步 v${this.assetPackVersion}`, W / 2, 59,
        { font: "12px monospace", color: "#6f6", align: "center" });
      ctx.restore();
    }
  }

  /** 成员端商店按钮点击区域（供 tap 命中检测） */
  private shopBtnHintRect: { x: number; y: number; w: number; h: number } | null = null;

  /** v2.9 成员基地商店面板：主机广播库存 + 本地判定；v2.14.1 改为手动打开（点基地/按E）并复用共享渲染 */
  private renderShopPanel(r: Renderer, s: NetSnapshot, W: number, H: number): void {
    const self = s.players.find((p) => p.team === 0 && p.playerId === this.myIndex);
    if (!self) return;
    const near = Math.hypot(self.x - s.base.x, self.y - s.base.y) < 95;
    this.shopNear = near;
    if (!near) { this.shopOpen = false; this.shopBtnHintRect = null; return; }   // 离开基地自动关闭
    if (!this.shopStock.length) return;

    const { ctx } = r;
    // 靠近未打开 → 显示可点击的商店按钮（手机端友好，不需要按E）
    if (!this.shopOpen) {
      const bw = 100, bh = 36;
      const bx = s.base.x - bw / 2, by = s.base.y - 60;
      // 按钮背景
      ctx.fillStyle = "rgba(0,180,80,0.85)";
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.fill();
      ctx.strokeStyle = "#4f4"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.stroke();
      r.drawText("🛒 打开商店", bx + bw / 2, by + bh / 2 + 4,
        { font: "bold 13px monospace", color: "#fff", align: "center" });
      this.shopBtnHintRect = { x: bx, y: by, w: bw, h: bh };
      return;
    }
    this.shopBtnHintRect = null;

    const wallet = (s.scope.wallets || [])[this.myIndex] ?? 0;
    this.shopBtnRects = [];
    drawShopPanel({
      ctx, W, H, stock: this.shopStock, wallet,
      bottom: "60s 自动刷新 · 点面板外或按E关闭",
      onRect: (i, rect) => { this.shopBtnRects[i] = rect; },
    });
  }

  // ── v2.16 成员端仓库面板（查看用，数据来自检查点） ──
  private renderWarehousePanel(r: Renderer, W: number, H: number): void {
    const { ctx } = r;
    const pw = 260, ph = Math.min(380, H - 40);
    const px = Math.floor((W - pw) / 2), py = Math.floor((H - ph) / 2);
    ctx.fillStyle = "rgba(8,12,24,0.95)";
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = "#0af"; ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    // 标题
    ctx.fillStyle = "#0af"; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
    ctx.fillText("◆ 基地仓库（查看）", px + pw / 2, py + 20);
    ctx.fillStyle = "#888"; ctx.font = "10px monospace";
    ctx.fillText("数据每 2 秒同步", px + pw / 2, py + 34);
    // 强化材料
    const essence = this.checkpointWarehouse?.essence ?? 0;
    ctx.fillStyle = "#f0f"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
    ctx.fillText(`强化材料: ${essence}`, px + 10, py + 52);
    // 模块列表
    const items = this.checkpointWarehouse?.items ?? [];
    const byQuality: Record<string, typeof items> = { gold: [], blue: [], white: [] };
    for (const it of items) (byQuality[it.quality] || (byQuality[it.quality] = [])).push(it);
    let y = py + 68;
    const qualityColors: Record<string, string> = { gold: "#fd4", blue: "#4af", white: "#ccc" };
    const qualityLabels: Record<string, string> = { gold: "金色", blue: "蓝色", white: "白色" };
    for (const q of ["gold", "blue", "white"]) {
      const arr = byQuality[q] || [];
      if (arr.length === 0) continue;
      ctx.fillStyle = qualityColors[q]; ctx.font = "bold 10px monospace";
      ctx.fillText(`${qualityLabels[q]} x${arr.length}`, px + 10, y);
      y += 14;
      for (const it of arr.slice(0, 12)) {
        ctx.fillStyle = qualityColors[q]; ctx.font = "9px monospace";
        const uses = it.usesLeft > 0 ? `(${it.usesLeft})` : "";
        ctx.fillText(`  ${it.name} ${uses}`, px + 14, y);
        y += 12;
        if (y > py + ph - 20) break;
      }
      if (arr.length > 12) {
        ctx.fillStyle = "#666"; ctx.font = "9px monospace";
        ctx.fillText(`  ...还有 ${arr.length - 12} 个`, px + 14, y);
        y += 12;
      }
      y += 4;
      if (y > py + ph - 20) break;
    }
    if (items.length === 0) {
      ctx.fillStyle = "#666"; ctx.font = "11px monospace"; ctx.textAlign = "center";
      ctx.fillText("仓库为空", px + pw / 2, py + ph / 2);
    }
    // 底部提示
    ctx.fillStyle = "#555"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText("点「仓」按钮关闭", px + pw / 2, py + ph - 8);
  }

  // ── v2.16/v2.23 成员端背包面板（查看 + 拖动装配/卸载；数据来自检查点，2s 同步） ──
  private renderBackpackPanel(r: Renderer, W: number, H: number): void {
    const { ctx } = r;
    const pi = this.backpackOwner ?? 0;
    const cp = this.checkpointPlayers[pi];
    const pw = 300, ph = Math.min(430, H - 40);
    const px = Math.floor((W - pw) / 2), py = Math.floor((H - ph) / 2);
    const col = pi === 0 ? "#4af" : "#4c4";
    ctx.fillStyle = "rgba(8,12,24,0.96)";
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    // 标题
    ctx.fillStyle = col; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
    ctx.fillText(`◆ P${pi + 1} 背包 · 拖动装配`, px + pw / 2, py + 20);
    ctx.fillStyle = "#888"; ctx.font = "10px monospace";
    ctx.fillText(`Lv.${cp?.level ?? 0}  经验 ${cp?.exp ?? 0}  生命 ${cp?.lives ?? 0}`, px + pw / 2, py + 34);

    const invRects: typeof this.panelRects extends { invRects: infer T } | null ? T : never = [];
    const cannonRects: typeof this.panelRects extends { cannonRects: infer T } | null ? T : never = [];

    if (!cp) {
      ctx.fillStyle = "#666"; ctx.font = "11px monospace"; ctx.textAlign = "center";
      ctx.fillText("等待检查点数据…", px + pw / 2, py + ph / 2);
      this.panelRects = { px, py, pw, ph, invRects, cannonRects };
      return;
    }

    const slotS = 34, slotGap = 6, rowH = 42;
    const qColor = (id: string): string => {
      const q = getModule(id)?.quality;
      return q === "gold" ? "#fd4" : q === "blue" ? "#4af" : "#ccc";
    };
    const drawSlot = (sx: number, sy: number, label: string, empty: boolean, active: boolean): void => {
      ctx.fillStyle = empty ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.14)";
      ctx.fillRect(sx, sy, slotS, slotS);
      ctx.strokeStyle = active ? "#fd4" : empty ? "#445" : qColor(label);
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(sx + 0.5, sy + 0.5, slotS - 1, slotS - 1);
      if (!empty) {
        ctx.fillStyle = qColor(label);
        ctx.font = "9px monospace"; ctx.textAlign = "center";
        ctx.fillText(label.length > 6 ? label.slice(0, 6) : label, sx + slotS / 2, sy + slotS / 2 + 3);
      }
    };

    // ── 炮筒槽区（4 门炮 × 槽位）──
    ctx.fillStyle = "#aaa"; ctx.font = "bold 10px monospace"; ctx.textAlign = "left";
    ctx.fillText("炮筒槽位（拖背包模块到此处=装入 / 拖槽到背包=卸下）:", px + 10, py + 52);
    let y = py + 62;
    for (let ci = 0; ci < 4; ci++) {
      const cannon = cp.cannons[ci];
      const active = !!cannon?.active;
      ctx.fillStyle = active ? "#fd4" : "#888";
      ctx.font = "9px monospace";
      ctx.fillText(`${active ? "●" : "○"}${cannon?.config.name ?? `炮${ci + 1}`}`, px + 12, y + slotS / 2 + 3);
      const sx0 = px + 92;
      const nSlots = cannon?.modules.length ?? 4;
      for (let s = 0; s < nSlots; s++) {
        const sx = sx0 + s * (slotS + slotGap);
        const m = cannon?.modules[s];
        const label = m ? (getModule(m.id)?.name ?? m.id) : "";
        drawSlot(sx, y, label, !m, active);
        cannonRects.push({ x: sx, y, w: slotS, h: slotS, wand: ci, index: s, label: label || "空槽" });
      }
      y += rowH;
      if (y > py + ph - 150) break;
    }

    // ── 背包格区（8 格网格）──
    y += 4;
    ctx.fillStyle = "#aaa"; ctx.font = "bold 10px monospace";
    ctx.fillText("背包（拖动到上方炮筒槽=装入）:", px + 10, y);
    y += 6;
    const invSlot = 44, invGap = 6;
    for (let i = 0; i < 8; i++) {
      const cx0 = px + 10 + (i % 4) * (invSlot + invGap);
      const cy0 = y + Math.floor(i / 4) * (invSlot + invGap);
      const it = cp.inv[i];
      const label = it ? (it.kind === "module" ? (getModule(it.id)?.name ?? it.id) : `[物]${getModule(it.id)?.name ?? it.id}`) : "";
      ctx.fillStyle = it ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
      ctx.fillRect(cx0, cy0, invSlot, invSlot);
      ctx.strokeStyle = it ? qColor(it.id) : "#445";
      ctx.lineWidth = 1;
      ctx.strokeRect(cx0 + 0.5, cy0 + 0.5, invSlot - 1, invSlot - 1);
      if (it) {
        ctx.fillStyle = qColor(it.id);
        ctx.font = "9px monospace"; ctx.textAlign = "center";
        ctx.fillText(label.length > 5 ? label.slice(0, 5) : label, cx0 + invSlot / 2, cy0 + invSlot / 2 + 3);
        if (it.kind === "module" && it.uses > 0) {
          ctx.fillStyle = "#ffd700"; ctx.font = "8px monospace";
          ctx.fillText(`${it.uses}`, cx0 + invSlot - 4, cy0 + invSlot - 4);
        }
      }
      invRects.push({ x: cx0, y: cy0, w: invSlot, h: invSlot, index: i, label: label || "空" });
    }
    y += 2 * (invSlot + invGap);

    // 底部提示
    ctx.fillStyle = "#555"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`点「P${pi + 1}」按钮或面板外关闭`, px + pw / 2, py + ph - 8);

    this.panelRects = { px, py, pw, ph, invRects, cannonRects };
  }

  /** v2.23 成员端拖动浮动图标 + 装配/加固反馈（画在背包面板之上） */
  private renderDragOverlay(r: Renderer): void {
    const { ctx } = r;
    if (this.drag) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = "rgba(60,80,160,0.9)";
      ctx.strokeStyle = "#9cf"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(this.drag.x - 22, this.drag.y - 22, 44, 44, 8);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
      ctx.fillText(this.drag.label.length > 6 ? this.drag.label.slice(0, 6) : this.drag.label, this.drag.x, this.drag.y + 3);
      ctx.restore();
    }
    if (this.actionResult) {
      const age = performance.now() - this.actionResult.t0;
      if (age > 2600) { this.actionResult = null; return; }
      const a = age < 150 ? age / 150 : 1 - Math.max(0, (age - 2200) / 400);
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = this.actionResult.ok ? "rgba(20,60,20,0.85)" : "rgba(90,20,20,0.85)";
      ctx.strokeStyle = this.actionResult.ok ? "#4f4" : "#f66";
      ctx.lineWidth = 1.5;
      const bw = Math.max(150, this.actionResult.msg.length * 8 + 24);
      const bx = Math.floor((this.drag ? 0 : 0)) + 0; // 居中于屏幕
      ctx.beginPath();
      ctx.roundRect((this.ctxW() - bw) / 2, 90, bw, 30, 8);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = this.actionResult.ok ? "#9f9" : "#f99";
      ctx.font = "11px monospace"; ctx.textAlign = "center";
      ctx.fillText(this.actionResult.msg, this.ctxW() / 2, 109);
      ctx.restore();
    }
  }

  /** 画布宽度（反馈横幅居中用） */
  private ctxW(): number {
    return this.tilemap ? this.tilemap.cols * TILE_SIZE : 0;
  }

  /** 远端升级面板：显示主机广播的升级选项，点击即回传选择（触屏/鼠标） */
  private renderLevelUpPanel(r: Renderer, W: number, H: number): void {
    const now = performance.now();
    if (now >= this.lvlDeadline) { this.clearLevelUp(); return; }
    if (this.lvlPlayerIdx < 0 || this.lvlChoices.length === 0) return;

    const { ctx } = r;
    const col = this.lvlPlayerIdx === 0 ? "#4af" : "#4c4";
    const panelW = 180, panelH = 200, btnH = 46;
    const px = this.lvlPlayerIdx === 0 ? 4 : W - panelW - 4;
    // v2.35 面板下移：不再居中挡视野（贴底部按钮区上沿，且避开右下开火键）
    const py = Math.max(8, H - panelH - 180);

    // 记录按钮区域（供 tap 命中检测）
    this.lvlBtnRects = this.lvlChoices.map((_, i) => ({
      x: px + 4, y: py + 34 + i * (btnH + 4), w: panelW - 8, h: btnH,
    }));

    r.fillRect(px, py, panelW, panelH, "rgba(0,0,20,0.94)");
    r.strokeRect(px, py, panelW, panelH, col, 2);
    const remain = Math.max(0, Math.ceil((this.lvlDeadline - now) / 1000));
    r.drawText(`P${this.lvlPlayerIdx + 1} 升级!`, px + panelW / 2, py + 10,
      { font: "13px monospace", color: col, align: "center" });
    r.drawText(`剩余${remain}s 点击选择`, px + panelW / 2, py + 23,
      { font: "10px monospace", color: "#888", align: "center" });

    this.lvlChoices.forEach((c, i) => {
      const bx = px + 4, by = py + 34 + i * (btnH + 4), bw = panelW - 8;
      const catCol = c.category === "firepower" ? "#f80" : c.category === "defense" ? "#4af" : "#a4f";
      ctx.fillStyle = "#111";
      ctx.fillRect(bx, by, bw, btnH);
      ctx.strokeStyle = catCol; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, btnH);
      ctx.fillStyle = catCol;
      ctx.font = "bold 12px monospace"; ctx.textAlign = "center";
      ctx.fillText(`${i + 1}. ${c.name}`, bx + bw / 2, by + 14);
      ctx.fillStyle = "#999"; ctx.font = "9px monospace";
      ctx.fillText(c.desc.slice(0, 17), bx + bw / 2, by + 27);
      if (c.desc.length > 17) ctx.fillText(c.desc.slice(17, 34), bx + bw / 2, by + 37);
    });
  }

  private renderGameOver(r: Renderer, W: number, H: number): void {
    const { ctx } = r;
    r.fillRect(0, 0, W, H, "rgba(0,0,0,0.85)");
    const s = this.getLatestSnap();
    const snap = s;

    // ── 标题 ──
    r.drawText("— 对局结束 —", W / 2, 30, { font: "26px monospace", color: "#f44", align: "center" });
    if (snap) {
      r.drawText(`第 ${snap.scope.wave} 波`, W / 2, 56, { font: "bold 16px sans-serif", color: "#ffd700", align: "center" });
    }

    // ── 所有玩家统计（来自检查点，有完整 stats 数据）──
    const cp = this.checkpointPlayers;
    const meta = this.playersMeta;
    const n = cp.length || meta.length;
    if (n > 0) {
      const PLAYER_COLORS = ["#4af", "#4c4", "#fa0", "#f4a"];
      const colW = W / (n > 2 ? n : 2);
      const statY = 82;
      const statLabels = ["经验", "等级", "击杀", "伤害输出", "伤害承受"];
      for (let pi = 0; pi < n; pi++) {
        const col = PLAYER_COLORS[pi] ?? "#ccc";
        const sx = colW * pi + colW / 2;
        const isMe = pi === this.myIndex;
        const name = meta[pi]?.name ?? "";
        const label = `${isMe ? "★ " : ""}P${pi + 1}${name ? " " + name : ""}`;
        // 列头
        r.drawText(label, sx, statY, { font: isMe ? "bold 13px monospace" : "12px monospace", color: isMe ? "#fff" : col, align: "center" });
        if (isMe) {
          r.drawText("（你）", sx, statY + 14, { font: "10px monospace", color: "#ffd700", align: "center" });
        }
        const cpData = cp[pi];
        if (cpData) {
          const s2 = cpData.stats;
          const vals = [
            `${s2.exp}`,
            `Lv.${cpData.level}`, `${s2.kills}`,
            `${s2.damageDealt}`, `${s2.damageTaken}`,
          ];
          statLabels.forEach((label, i) => {
            r.drawText(`${label}: ${vals[i]}`, sx, statY + (isMe ? 28 : 18) + i * 15,
              { font: "10px monospace", color: i === 0 ? "#ff0" : col, align: "center" });
          });
          // 背包摘要
          const inv = cpData.inv;
          if (inv) {
            const bpItems = inv.filter((it): it is NonNullable<typeof it> => it !== null)
              .map(it => it.id).reduce((acc, id) => { acc[id] = (acc[id] || 0) + 1; return acc; }, {} as Record<string, number>);
            const bpTxt = Object.entries(bpItems).map(([k, c]) => `${k}×${c}`).join(" ");
            r.drawText(bpTxt ? `背: ${bpTxt}` : "背包: 空",
              sx, statY + (isMe ? 28 : 18) + statLabels.length * 15 + 4,
              { font: "9px monospace", color: "#8cf", align: "center" });
          }
        } else {
          // 无检查点数据时从快照 scope 补充
          const wallets = snap?.scope.wallets ?? [];
          const bps = snap?.scope.bp ?? [];
          const wallet = wallets[pi] ?? 0;
          const bp = bps[pi] ?? {};
          r.drawText(`经验: ${wallet}`, sx, statY + 18, { font: "10px monospace", color: col, align: "center" });
          const bpTxt = Object.entries(bp).filter(([, c]) => c > 0).map(([k, c]) => `${k}×${c}`).join(" ");
          r.drawText(bpTxt ? `背: ${bpTxt}` : "背包: 空",
            sx, statY + 34, { font: "9px monospace", color: "#8cf", align: "center" });
        }
      }
    }

    // 操作按钮由 main.ts drawLobbyButton 统一绘制并注册点击区域，这里不重复画
    // 键盘提示
    r.drawText("按 Enter 返回菜单", W / 2, H - 30, { font: "12px monospace", color: "#555", align: "center" });
  }
}
