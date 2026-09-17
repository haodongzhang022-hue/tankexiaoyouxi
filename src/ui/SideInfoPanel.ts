//  SideInfoPanel.ts ─
// 持久信息栏：放在场地之外（横屏=右侧竖栏，竖屏=底部横条），
// 显示两位玩家的背包、当前炮筒模块剩余次数、以及基地墙等级/耐久。
// 不遮挡场地，任何时候都可见，等价于"当前信息"。

import type { Renderer } from "../engine/Renderer";
import type { Tank } from "../game/Tank";
import type { Base } from "../game/Base";
import type { BaseRepairSystem } from "../systems/base/BaseRepairSystem";
import type { InventorySystem } from "../systems/wand/InventorySystem";
import { tradItemIcon, getTradItemName } from "../systems/wand/InventorySystem";
import type { LevelUpSystem } from "../systems/levelup/LevelUpSystem";
import {
  THEME, drawThemedSlot, drawThemedProgressBar, drawThemedButton,
  verticalGradient,
} from "./VisualTheme";

const SLOT_V  = 32;   // 竖栏槽位尺寸
const SLOT_H  = 24;   // 横条槽位尺寸
const GAP     = 5;
const PAD     = 6;
const INV_COLS = 4;

export interface InfoClick {
  pi: number;
  kind: "equip" | "remove" | "use" | "fortify" | "warehouse" | "backpack" | "cannonTab";
  index: number;   // 背包槽位 or 炮筒槽位 or 炮筒编号
}

/** 基地加固升级费用（等级 → 金币）；等级 3 封顶不再可升 */
export function fortifyCost(level: number): number {
  return level === 1 ? 150 : level === 2 ? 400 : 0;
}

interface Zone {
  x: number; y: number; w: number; h: number;
  pi: number; kind: "inv" | "cannon" | "fortify" | "warehouse" | "backpack" | "cannonTab"; index: number;
}

const QUALITY_COLORS: Record<string, string> = { white: "#ddd", blue: "#4af", gold: "#ffd700" };

// ── 远端（成员端）信息栏数据源：快照驱动的统一布局（与本地模式共用同一份 UI 区域）──
export interface RemoteInfoSource {
  players: Array<{ playerId: number; name?: string; hp: number; maxHp: number; alive: boolean; lives?: number; activeCannon?: number }>;
  base: { wallLevel: number; walls: Array<{ hp: number; maxHp: number }>; eagleHp: number; eagleMaxHp: number };
  wallets?: number[];
  bp?: Array<Record<string, number>>;
}

export class SideInfoPanel {
  private infoX: number;
  private infoY: number;
  private infoW: number;
  private infoH: number;
  private vertical: boolean;
  private players: Tank[];
  private inventories: InventorySystem[];
  private levelSystems: LevelUpSystem[];
  private base: Base;
  private baseRepair: BaseRepairSystem;
  private zones: Zone[] = [];
  /** 顶部避让空间（小地图/其他悬浮元素在信息栏顶部占据的像素，信息栏内容从此 y 起画） */
  private topSkipY: number;
  /** 本地玩家索引：只显示该玩家的背包/属性 */
  private localPi: number;
  /** 本地双人模式：显示所有玩家 */
  private showAllPlayers: boolean;
  /** 强制竖栏模式（用于左侧面板，infoX=0 时也需要竖栏布局） */
  private forceVertical: boolean;

  constructor(infoX: number, infoY: number, infoW: number, infoH: number,
              players: Tank[], inventories: InventorySystem[],
              base: Base, baseRepair: BaseRepairSystem,
              levelSystems: LevelUpSystem[],
              topSkipY: number = 0, localPi: number = 0, showAllPlayers = false,
              forceVertical = false) {
    this.infoX = infoX;
    this.infoY = infoY;
    this.infoW = infoW;
    this.infoH = infoH;
    // 竖栏=画布右侧（infoX>0），横条=画布底部（infoY>0）；forceVertical 覆盖
    this.vertical = forceVertical || infoX > 0;
    this.forceVertical = forceVertical;
    this.players = players;
    this.inventories = inventories;
    this.levelSystems = levelSystems;
    this.base = base;
    this.baseRepair = baseRepair;
    this.topSkipY = topSkipY;
    this.localPi = localPi;
    this.showAllPlayers = showAllPlayers;
  }

  /** 命中检测：返回点击对应的动作描述，交由模式系统执行 */
  handleClick(x: number, y: number): InfoClick | null {
    for (const z of this.zones) {
      if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) {
        if (z.kind === "fortify") return { pi: 0, kind: "fortify", index: 0 };
        if (z.kind === "warehouse") return { pi: 0, kind: "warehouse", index: 0 };
        if (z.kind === "backpack") return { pi: z.pi, kind: "backpack", index: 0 };
        if (z.kind === "cannonTab") return { pi: z.pi, kind: "cannonTab", index: z.index };
        if (z.kind === "inv") return { pi: z.pi, kind: "equip", index: z.index };
        return { pi: z.pi, kind: "remove", index: z.index };
      }
    }
    return null;
  }

  render(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    this.zones = [];
    // 美化后的信息栏背景（渐变 + 边框）
    ctx.fillStyle = verticalGradient(ctx, this.infoX, this.infoY, this.infoW, this.infoH, "#141b30", "#0a0e1c");
    ctx.fillRect(this.infoX, this.infoY, this.infoW, this.infoH);
    // 左侧装饰条
    ctx.fillStyle = "rgba(0,212,255,0.3)";
    ctx.fillRect(this.infoX, this.infoY, 2, this.infoH);
    ctx.strokeStyle = THEME.borderNormal;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.infoX + 0.5, this.infoY + 0.5, this.infoW - 1, this.infoH - 1);

    if (this.vertical) this.renderVertical(ctx, now);
    else               this.renderHorizontal(ctx, now);
  }

  // ── 远端（成员端）模式：同一个信息栏区域，数据来自快照（布局与本地模式一致）──
  renderRemote(renderer: Renderer, now: number, src: RemoteInfoSource): void {
    const { ctx } = renderer;
    this.zones = [];
    // 与本地 render 相同的美化背景
    ctx.fillStyle = verticalGradient(ctx, this.infoX, this.infoY, this.infoW, this.infoH, "#141b30", "#0a0e1c");
    ctx.fillRect(this.infoX, this.infoY, this.infoW, this.infoH);
    ctx.fillStyle = "rgba(0,212,255,0.3)";
    ctx.fillRect(this.infoX, this.infoY, 2, this.infoH);
    ctx.strokeStyle = THEME.borderNormal;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.infoX + 0.5, this.infoY + 0.5, this.infoW - 1, this.infoH - 1);
    if (this.vertical) this.renderRemoteVertical(ctx, now, src);
    else               this.renderRemoteHorizontal(ctx, now, src);
  }

  private renderRemoteVertical(ctx: CanvasRenderingContext2D, now: number, src: RemoteInfoSource): void {
    const X = this.infoX + PAD;
    let y = this.infoY + PAD + this.topSkipY;

    // 标题（与本地一致）
    ctx.fillStyle = "#ffd700"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
    ctx.fillText("≡ 当前信息", X, y + 8);
    y += 16;

    // v2.16 快捷操作图标行（与主机一致：仓/P1/P2，成员端也能查看仓库和双方背包）
    y = this.drawQuickActions(ctx, X, y);
    y += 4;

    // 基地块（远端：墙等级/耐久/核心）
    y = this.drawBaseRemote(ctx, X, y, src);
    y += 6;

    // 玩家块（只显示本地玩家）
    y = this.drawPlayerRemote(ctx, this.localPi, X, y, src);
    y += 4;
    // v2.31 炮筒切换标签（成员端点击切炮；快照无 activeCannon 时不显示）
    y += this.drawCannonTabsRemote(ctx, X, y, this.localPi, src) + 2;
    y += 8;
  }

  private renderRemoteHorizontal(ctx: CanvasRenderingContext2D, now: number, src: RemoteInfoSource): void {
    // v2.23 与本地横条一致：为竖屏左下角暂停键右移 44px 让位
    const X = this.infoX + PAD + (!this.vertical ? 44 : 0);
    let y = this.infoY + PAD + this.topSkipY;

    // 基地行
    ctx.fillStyle = "#ffd700"; ctx.font = "bold 10px monospace"; ctx.textAlign = "left";
    ctx.fillText("基地", X, y + 10);
    const baseX = X + 38;
    const sum = src.base.walls.reduce((s, w) => s + w.hp, 0);
    const max = src.base.walls.reduce((s, w) => s + w.maxHp, 0);
    ctx.fillStyle = "#fff"; ctx.font = "9px monospace";
    ctx.fillText(`墙Lv${src.base.wallLevel} ${sum}/${max} 核心${src.base.eagleHp}`, baseX, y + 10);
    y += 18;

    // 玩家行 — 只显示本地玩家
    const slot = SLOT_H;
    const pi = this.localPi;
    if (pi < src.players.length) {
      const p = src.players[pi];
      const PLAYER_COLORS = ["#38f", "#4c4", "#fa0", "#f4a"];
      ctx.fillStyle = PLAYER_COLORS[pi] ?? "#ccc";
      ctx.font = "bold 10px monospace";
      const wv = (src.wallets || [])[pi];
      const aliveTxt = p.alive ? "" : "  [阵亡]";
      ctx.fillText(`P${pi + 1}${p.name ? " " + p.name : ""} 经验${wv ?? "-"}${aliveTxt}`, X, y + slot / 2 + 3);
      const bp = (src.bp || [])[pi] || {};
      const bpTxt = Object.entries(bp).filter(([, n]) => n > 0)
        .map(([k, n]) => (k === "模块" ? `模块x${n}` : `${getTradItemName(k)}x${n}`)).join(" ");
      if (bpTxt) {
        ctx.fillStyle = "#6af"; ctx.font = "9px monospace";
        ctx.fillText(bpTxt, baseX + 90, y + slot / 2 + 3);
      }
      y += slot + 6;
    }
    // v2.31 炮筒切换标签（成员端点击切炮；竖屏手机同样可切）
    y += this.drawCannonTabsRemote(ctx, X, y, pi, src);

    // v2.16 快捷操作图标行（仓/P1/P2，成员端也能查看仓库和背包）
    this.drawQuickActions(ctx, X, y + 2);
  }

  /** 基地块（远端）：墙 Lv 格子 + 耐久条 + 核心（与本地 drawBase 同一视觉） */
  private drawBaseRemote(ctx: CanvasRenderingContext2D, x: number, y: number, src: RemoteInfoSource): number {
    const level = src.base.wallLevel;
    const maxLevel = 3;
    ctx.fillStyle = "#aaa"; ctx.font = "9px monospace"; ctx.textAlign = "left";
    ctx.fillText(`基地墙 Lv${level}/${maxLevel}`, x, y + 8);
    for (let i = 0; i < maxLevel; i++) {
      ctx.fillStyle = i < level ? "#ffd700" : "#333";
      ctx.fillRect(x + 84 + i * 8, y, 6, 8);
    }
    const sum = src.base.walls.reduce((s, w) => s + w.hp, 0);
    const max = src.base.walls.reduce((s, w) => s + w.maxHp, 0);
    drawThemedProgressBar(ctx, {
      x, y: y + 12, w: 120, h: 6,
      value: max > 0 ? sum / max : 0,
      bgColor: "#1a0a0a", borderColor: "#333",
    });
    ctx.fillStyle = "#889"; ctx.font = "8px monospace";
    ctx.fillText(`${sum}/${max}`, x, y + 30);
    ctx.fillStyle = "#ffd700"; ctx.fillRect(x + 60, y + 20, 6, 6);
    ctx.fillStyle = "#ddd"; ctx.font = "8px monospace";
    ctx.fillText(`核心 ${src.base.eagleHp}`, x + 70, y + 26);
    return y + 40;
  }

  /** 玩家块（远端）：P1/P2 存活 + 经验 + 背包摘要（两个玩家都可见，不再只显示自己） */
  private drawPlayerRemote(ctx: CanvasRenderingContext2D, pi: number, x: number, y: number, src: RemoteInfoSource): number {
    const p = src.players[pi];
    const col = pi === 0 ? "#4af" : "#4c4";
    // 头部：P1/P2（存活状态）+ 剩余命数（红心醒目显示）
    ctx.fillStyle = col; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
    ctx.fillText(`P${pi + 1} ${p.alive ? "" : "[阵亡]"}`, x, y + 10);
    // v2.17 剩余命数：红心 + 数字，醒目呈现
    const lives = p.lives ?? 0;
    ctx.fillStyle = lives > 0 ? "#f44" : "#666";
    ctx.font = "bold 10px monospace";
    ctx.fillText(`♥${lives}`, x + 56, y + 10);
    ctx.fillStyle = "#aaa"; ctx.font = "9px monospace";
    ctx.fillText(p.name ? p.name.slice(0, 6) : "", x + 92, y + 10);
    y += 16;

    // 经验（快照 wallets 对齐）
    const wv = (src.wallets || [])[pi];
    ctx.fillStyle = "#ffd700"; ctx.font = "9px monospace";
    ctx.fillText(`经验 ${wv ?? "-"}`, x, y + 8);
    // 背包摘要（快照 bp 对齐）
    const bp = (src.bp || [])[pi] || {};
    const bpTxt = Object.entries(bp).filter(([, n]) => n > 0)
      .map(([k, n]) => (k === "模块" ? `模块x${n}` : `${getTradItemName(k)}x${n}`)).join(" ");
    if (bpTxt) {
      ctx.fillStyle = "#6af"; ctx.font = "9px monospace";
      ctx.fillText(`背:${bpTxt}`, x, y + 20);
    } else {
      ctx.fillStyle = "#334"; ctx.font = "9px monospace";
      ctx.fillText("背包 空", x, y + 20);
    }
    // 血条（美化版）
    const barW = 120, barH = 5;
    const hpFrac = Math.max(0, Math.min(1, p.hp / Math.max(1, p.maxHp)));
    drawThemedProgressBar(ctx, {
      x, y: y + 26, w: barW, h: barH,
      value: hpFrac, bgColor: "#1a0a0a", borderColor: "#333",
    });
    ctx.fillStyle = "#889"; ctx.font = "8px monospace";
    ctx.fillText(`HP ${p.hp}/${p.maxHp}`, x, y + 42);
    return y + 46;
  }

  /** v2.31 成员端：炮筒标签行（点击=切换炮筒，主机直选生效；activeCannon 快照高亮） */
  private drawCannonTabsRemote(ctx: CanvasRenderingContext2D, x: number, y: number, pi: number, src: RemoteInfoSource): number {
    const p = src.players[pi];
    if (!p || p.activeCannon === undefined) return 0;
    const tw = 26, th = 15, gap = 4;
    for (let c = 0; c < 4; c++) {
      const tx = x + c * (tw + gap);
      const active = c === (p.activeCannon ?? 0);
      ctx.fillStyle = active ? "#2563b8" : "#1a2438";
      ctx.fillRect(tx, y, tw, th);
      ctx.strokeStyle = active ? "#6af" : "#3a4a66";
      ctx.lineWidth = 1;
      ctx.strokeRect(tx + 0.5, y + 0.5, tw - 1, th - 1);
      ctx.fillStyle = active ? "#fff" : "#889";
      ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
      ctx.fillText(`${c + 1}`, tx + tw / 2, y + 11);
      this.zones.push({ x: tx, y, w: tw, h: th, pi, kind: "cannonTab", index: c });
    }
    ctx.textAlign = "left";
    return th + 4;
  }

  // ── 快捷操作图标行（共用仓库 / 各自背包），对两位玩家和触屏都可点 ──
  private drawQuickActions(ctx: CanvasRenderingContext2D, x: number, y: number): number {
    const btnW = 26, btnH = 20, gap = 4;
    let cx = x;
    const PLAYER_COLORS = ["#38f", "#4c4", "#fa0", "#f4a"];
    const addBtn = (label: string, color: string, kind: "warehouse" | "backpack", pi: number): void => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect(cx, y, btnW, btnH, 5); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 10px monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, cx + btnW / 2, y + btnH / 2 + 1);
      ctx.textBaseline = "alphabetic";
      this.zones.push({ x: cx, y, w: btnW, h: btnH, pi, kind, index: 0 });
      cx += btnW + gap;
    };
    addBtn("仓", "#7a3", "warehouse", 0);
    if (this.showAllPlayers) {
      for (let pi = 0; pi < this.players.length; pi++) {
        addBtn(`P${pi + 1}`, PLAYER_COLORS[pi] ?? "#ccc", "backpack", pi);
      }
      ctx.fillStyle = "#667"; ctx.font = "8px monospace"; ctx.textAlign = "left";
      const hint = this.players.map((_, i) => `P${i + 1}`).join("/");
      ctx.fillText(`仓=仓库 ${hint}=背包`, cx + 2, y + btnH / 2 + 3);
    } else {
      addBtn(`P${this.localPi + 1}`, PLAYER_COLORS[this.localPi] ?? "#ccc", "backpack", this.localPi);
      ctx.fillStyle = "#667"; ctx.font = "8px monospace"; ctx.textAlign = "left";
      ctx.fillText(`仓=仓库 P${this.localPi + 1}=背包`, cx + 2, y + btnH / 2 + 3);
    }
    return y + btnH + 4;
  }

  // ── 竖栏（横屏：右侧）────────────────────────────
  private renderVertical(ctx: CanvasRenderingContext2D, now: number): void {
    const X = this.infoX + PAD;
    // topSkipY = 小地图等悬浮元素占的高度，信息栏内容从它下面开始
    let y = this.infoY + PAD + this.topSkipY;

    // 标题
    ctx.fillStyle = "#ffd700"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
    ctx.fillText("≡ 当前信息", X, y + 8);
    y += 16;

    // 快捷操作图标行（点此开仓库/背包，触屏同样可用）
    y = this.drawQuickActions(ctx, X, y);
    y += 4;

    // 基地（含加固按钮，返回新 y）
    y = this.drawBase(ctx, X, y);
    y += 6;

    // 玩家 — 本地双人显示全部，否则只显示本地玩家
    if (this.showAllPlayers) {
      for (let pi = 0; pi < this.players.length; pi++) {
        y = this.drawPlayer(ctx, pi, X, y, now);
        y += 8;
      }
    } else {
      y = this.drawPlayer(ctx, this.localPi, X, y, now);
      y += 8;
    }
  }

  // ── 横条（竖屏：底部）────────────────────────────
  private renderHorizontal(ctx: CanvasRenderingContext2D, now: number): void {
    // v2.23 竖屏（横条=信息栏在底部）：左下角有暂停键(8, H-44, 36×36)，内容整体右移 44px 让位，不被遮挡
    const X = this.infoX + PAD + (!this.vertical ? 44 : 0);
    // 竖屏模式下小地图在 infoY+10 处，infoH=120 足够容纳，一般不冲突；
    // 但如果 topSkipY > 0 也一起跳过（保持一致）
    let y = this.infoY + PAD + this.topSkipY;

    // 基地行
    ctx.fillStyle = "#ffd700"; ctx.font = "bold 10px monospace"; ctx.textAlign = "left";
    ctx.fillText("基地", X, y + 10);
    const baseX = X + 38;
    ctx.fillStyle = "#fff"; ctx.font = "9px monospace";
    ctx.fillText(`墙Lv${this.base.wallLevel} ${this.wallHpText()} 核心${this.base.eagleHp} 小人修${this.baseRepair.handymanRepairCount}面 护墙挡${this.base.wallDamageAbsorbed}伤`,
      baseX, y + 10);
    // 加固按钮（右侧，横条模式）
    const cost = fortifyCost(this.base.wallLevel);
    if (cost > 0) {
      const bw = 96, bh = 14;
      const bx2 = this.infoX + this.infoW - PAD - bw;
      ctx.fillStyle = "rgba(255,180,40,0.14)";
      ctx.fillRect(bx2, y - 1, bw, bh);
      ctx.strokeStyle = "#c90"; ctx.lineWidth = 1;
      ctx.strokeRect(bx2 + 0.5, y - 0.5, bw - 1, bh - 1);
      ctx.fillStyle = "#ffd700"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
      ctx.fillText(`加固→Lv${this.base.wallLevel + 1} ${cost}金`, bx2 + bw / 2, y + 9);
      this.zones.push({ x: bx2, y: y - 1, w: bw, h: bh, pi: 0, kind: "fortify", index: 0 });
    } else {
      ctx.fillStyle = "#666"; ctx.font = "8px monospace"; ctx.textAlign = "right";
      ctx.fillText("墙已满级", this.infoX + this.infoW - PAD, y + 9);
    }
    y += 18;

    // 玩家行 — 本地双人显示全部，否则只显示本地玩家
    const PLAYER_COLORS = ["#38f", "#4c4", "#fa0", "#f4a"];
    const slot = SLOT_H;
    const startPi = this.showAllPlayers ? 0 : this.localPi;
    const endPi = this.showAllPlayers ? this.players.length : this.localPi + 1;
    for (let pi = startPi; pi < endPi; pi++) {
      const pp = this.players[pi];
      if (!pp) continue;
      ctx.fillStyle = PLAYER_COLORS[pi] ?? "#ccc";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(`P${pi + 1} EXP ${pp.stats.exp}`, X, y + slot / 2 + 3);
      const gx = X + 70;
      const inv = this.inventories[pi];
      const slots = inv.getAll();
      // v2.34 背包可扩容到 16 格：横条只画一行，放得下的才画，其余 +N 提示（完整背包见背包面板）
      const rowMax = Math.max(4, Math.floor((this.infoW - gx - 8) / (slot + GAP)));
      const shown = Math.min(slots.length, rowMax);
      for (let i = 0; i < shown; i++) {
        const sx = gx + i * (slot + GAP);
        this.zones.push({ x: sx, y, w: slot, h: slot, pi, kind: "inv", index: i });
        this.drawSlot(ctx, sx, y, slot, slots[i].item, pi, now);
      }
      if (slots.length > shown) {
        ctx.fillStyle = "#9aa"; ctx.font = "9px monospace"; ctx.textAlign = "left";
        ctx.fillText(`+${slots.length - shown}`, gx + shown * (slot + GAP) + 2, y + 14);
      }
      y += slot + 6;
    }

    // 底部快捷操作图标行（共用仓库 / 各自背包，触屏也可点）
    this.drawQuickActions(ctx, X, y + 2);
  }

  // ── 基地信息块（竖栏），返回下一行 y ──────────────
  private drawBase(ctx: CanvasRenderingContext2D, x: number, y: number): number {
    const fh = 16; // 加固按钮高度
    const level = this.base.wallLevel;
    const maxLevel = 3;
    ctx.fillStyle = "#aaa"; ctx.font = "9px monospace"; ctx.textAlign = "left";
    ctx.fillText(`基地墙 Lv${level}/${maxLevel}`, x, y + 8);
    // 等级小格子
    for (let i = 0; i < maxLevel; i++) {
      ctx.fillStyle = i < level ? "#ffd700" : "#333";
      ctx.fillRect(x + 84 + i * 8, y, 6, 8);
    }
    // 墙耐久条（美化版）
    const sum = this.base.walls.reduce((s, w) => s + w.hp, 0);
    const max = this.base.walls.reduce((s, w) => s + w.maxHp, 0);
    drawThemedProgressBar(ctx, {
      x, y: y + 12, w: 120, h: 6,
      value: max > 0 ? sum / max : 0,
      bgColor: "#1a0a0a", borderColor: "#333",
    });
    ctx.fillStyle = "#889"; ctx.font = "8px monospace";
    ctx.fillText(`${sum}/${max}`, x, y + 30);
    // 核心
    ctx.fillStyle = "#ffd700"; ctx.fillRect(x + 60, y + 20, 6, 6);
    ctx.fillStyle = "#ddd"; ctx.font = "8px monospace";
    ctx.fillText(`核心 ${this.base.eagleHp}`, x + 70, y + 26);
    // 修复小人
    const hm = this.baseRepair.isHandymanAlive ? "健在" : this.baseRepair.isHandymanGrave ? "阵亡" : "无";
    const badge = this.baseRepair.storedCount;
    ctx.fillStyle = "#6f6"; ctx.font = "8px monospace";
    ctx.fillText(`小人:${hm} 徽章x${badge}`, x, y + 40);
    // 小人贡献：修了多少面墙 + 护墙替基地挡了多少伤害（强化"队友保护基地"感）
    ctx.fillStyle = "#fa9"; ctx.font = "8px monospace";
    ctx.fillText(`小人修墙${this.baseRepair.handymanRepairCount}面 护墙挡${this.base.wallDamageAbsorbed}伤`, x, y + 52);

    // 加固按钮（Lv<3 可点，费用见 fortifyCost）
    const cost = fortifyCost(level);
    y += 58;
    if (cost > 0) {
      const bw = 126;
      ctx.fillStyle = "rgba(255,180,40,0.14)";
      ctx.fillRect(x, y, bw, fh);
      ctx.strokeStyle = "#c90"; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, fh - 1);
      ctx.fillStyle = "#ffd700"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
      ctx.fillText(`加固墙→Lv${level + 1}  (${cost}金)`, x + bw / 2, y + 11);
      this.zones.push({ x, y, w: bw, h: fh, pi: 0, kind: "fortify", index: 0 });
    } else {
      ctx.fillStyle = "#666"; ctx.font = "8px monospace"; ctx.textAlign = "left";
      ctx.fillText("墙已至最高等级", x, y + 10);
    }
    return y + fh;
  }

  private wallHpText(): string {
    const sum = this.base.walls.reduce((s, w) => s + w.hp, 0);
    const max = this.base.walls.reduce((s, w) => s + w.maxHp, 0);
    return `${sum}/${max}`;
  }

  // ── 玩家信息块（竖栏）────────────────────────────
  private drawPlayer(ctx: CanvasRenderingContext2D, pi: number, x: number, y: number, now: number): number {
    const p = this.players[pi];
    const inv = this.inventories[pi];
    const ls = this.levelSystems[pi];
    const slot = SLOT_V;

    // 头部：P1/P2 + 剩余命数（红心醒目）
    const col = pi === 0 ? "#4af" : "#4c4";
    ctx.fillStyle = col; ctx.font = "bold 13px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`P${pi + 1}`, x, y + 12);
    // v2.17 剩余命数：红心 + 数字
    ctx.fillStyle = p.lives > 0 ? "#f44" : "#666";
    ctx.font = "bold 12px sans-serif";
    ctx.fillText(`♥${p.lives}`, x + 34, y + 12);
    y += 16;

    // v2.24 炮筒页签：4 个可点击切换（手机/触屏直接点，无需键盘 Tab）
    const tabW = 33, tabH = 17, tabGap = 4;
    for (let c = 0; c < 4; c++) {
      const tx = x + c * (tabW + tabGap);
      const active = c === p.activeCannon;
      ctx.fillStyle = active ? (pi === 0 ? "#2563b8" : "#2c7a2c") : "rgba(255,255,255,0.08)";
      ctx.beginPath(); ctx.roundRect(tx, y, tabW, tabH, 4); ctx.fill();
      ctx.strokeStyle = active ? (pi === 0 ? "#8cf" : "#8f8") : "#445";
      ctx.lineWidth = 1;
      ctx.strokeRect(tx + 0.5, y + 0.5, tabW - 1, tabH - 1);
      ctx.fillStyle = active ? "#fff" : "#99a";
      ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`${c + 1}`, tx + tabW / 2, y + tabH / 2 + 0.5);
      ctx.textBaseline = "alphabetic";
      this.zones.push({ x: tx, y, w: tabW, h: tabH, pi, kind: "cannonTab", index: c });
    }
    y += tabH + 2;
    ctx.fillStyle = "#99a"; ctx.font = "9px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(`当前炮筒${p.activeCannon + 1} · Tab键/点击切换`, x, y + 8);
    y += 12;

    // v2.24 当前数值明示：伤害 / 移速 / 血量
    const dmg = this.cannonDisplayDamage(pi);
    ctx.fillStyle = "#e8e8f0"; ctx.font = "bold 10px sans-serif";
    ctx.fillText(`伤害 ${dmg}`, x, y + 9);
    ctx.fillText(`移速 ${Math.round(p.effectiveSpeed)}`, x + 54, y + 9);
    ctx.fillText(`血 ${p.hp}/${p.effectiveMaxHp}`, x + 106, y + 9);
    y += 14;

    // 经验（醒目大号，清晰数字）+ 击杀
    ctx.fillStyle = "#ffd700"; ctx.font = "bold 13px sans-serif";
    ctx.fillText(`EXP ${p.stats.exp}`, x, y + 11);
    ctx.fillStyle = "#f8f"; ctx.font = "bold 10px sans-serif";
    ctx.fillText(`杀 ${p.stats.kills}`, x + 96, y + 11);
    y += 15;

    // 等级 / 经验（美化进度条）
    const need = Math.max(1, ls.getExpToNextLevel());
    const expFrac = Math.min(1, ls.exp / need);
    ctx.fillStyle = "#88f"; ctx.font = "bold 10px sans-serif";
    ctx.fillText(`Lv.${ls.level}`, x, y + 9);
    drawThemedProgressBar(ctx, {
      x: x + 42, y: y + 2, w: 60, h: 5,
      value: expFrac, color: "#6688ff", bgColor: "#1a1a30", borderColor: "#334",
    });
    ctx.fillStyle = "#9aa"; ctx.font = "9px sans-serif";
    ctx.fillText(`${ls.exp}/${need}`, x + 106, y + 9);
    y += 13;

    // 背包格子（4列）
    const slots = inv.getAll();
    const invRows = Math.ceil(slots.length / INV_COLS);
    for (let i = 0; i < slots.length; i++) {
      const c = i % INV_COLS;
      const r = Math.floor(i / INV_COLS);
      const sx = x + c * (slot + GAP);
      const sy = y + r * (slot + GAP);
      this.zones.push({ x: sx, y: sy, w: slot, h: slot, pi, kind: "inv", index: i });
      this.drawSlot(ctx, sx, sy, slot, slots[i].item, pi, now);
    }
    y += invRows * (slot + GAP);

    // 当前炮筒模块（含剩余次数；4个/行折行）
    const cannon = p.cannons[p.activeCannon];
    ctx.fillStyle = "#9aa"; ctx.font = "bold 10px sans-serif";
    ctx.fillText(`炮筒${p.activeCannon + 1} 模块 (×次数)`, x, y + 8);
    y += 13;
    const maxSlots = Math.min(16, cannon.modules.length);   // v2.34 炮筒扩容上限 16 孔
    for (let s = 0; s < maxSlots; s++) {
      const c = s % INV_COLS;
      const r = Math.floor(s / INV_COLS);
      const sx = x + c * (slot + GAP);
      const sy = y + r * (slot + GAP);
      this.zones.push({ x: sx, y: sy, w: slot, h: slot, pi, kind: "cannon", index: s });
      this.drawSlot(ctx, sx, sy, slot, cannon.modules[s], pi, now);
    }
    const modRows = Math.max(1, Math.ceil(maxSlots / INV_COLS));
    y += modRows * (slot + GAP);
    return y;
  }

  /** v2.24 当前炮筒的展示伤害：基础弹伤 × 所有伤害倍率（用于面板数值显示） */
  private cannonDisplayDamage(pi: number): number {
    const p = this.players[pi];
    const cannon = p.cannons[p.activeCannon];
    let base = 0;
    let mult = 1;
    for (const m of cannon.modules) {
      const cfg = m?.config as any;
      if (!cfg) continue;
      if (cfg.damageMultiplier) mult *= cfg.damageMultiplier;
      if (!base && typeof cfg.damage === "number") base = cfg.damage;
    }
    if (!base) return 0;
    return Math.round(base * mult);
  }

  // ── 通用槽位绘制（美化版）────────────────────────────────
  private drawSlot(ctx: CanvasRenderingContext2D, x: number, y: number, size: number,
                   item: any, pi: number, now: number): void {
    // 美化槽位背景
    const quality = item?.config?.quality ?? "white";
    drawThemedSlot(ctx, { x, y, size, quality });

    if (!item) return;

    if ("config" in item) {
      // 模块：品质色块 + 名称 + 剩余次数
      const qc = QUALITY_COLORS[item.config.quality] ?? "#ddd";
      // 品质渐变块
      const blockH = Math.floor(size * 0.58);
      const grad = ctx.createLinearGradient(x + 2, y + 2, x + 2, y + 2 + blockH);
      grad.addColorStop(0, qc);
      grad.addColorStop(1, this.darkenHex(qc, 0.3));
      ctx.fillStyle = grad;
      ctx.fillRect(x + 2, y + 2, size - 4, blockH);
      // 顶部高光
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(x + 2, y + 2, size - 4, 1.5);
      // 名称
      ctx.fillStyle = "#000";
      ctx.font = `${Math.max(7, Math.floor(size * 0.26))}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(item.config.name.slice(0, 4), x + size / 2, y + 2 + blockH / 2);

      // 剩余次数：无限 ∞ / 有限显示次数
      const uses = item.usesLeft;
      const infinite = item.config.maxUses === -1;
      if (infinite || uses >= 0) {
        ctx.fillStyle = infinite ? "#ffd700" : uses <= 3 ? "#f44" : "#889";
        ctx.font = `bold ${Math.max(7, Math.floor(size * 0.28))}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        if (infinite) {
          ctx.shadowColor = "#ffd700";
          ctx.shadowBlur = 3;
        }
        ctx.fillText(infinite ? "∞" : `${uses}`, x + size / 2, y + size - Math.floor(size * 0.15));
        ctx.shadowBlur = 0;
      }
    } else if (item.kind === "traditional") {
      // 传统道具：独立图标颜色 + 图案 + 名称
      const icon = tradItemIcon(item.id);
      // 圆形渐变
      const r = size / 2 - 4;
      const grad = ctx.createRadialGradient(x + size / 2 - 2, y + size / 2 - 2, 1, x + size / 2, y + size / 2, r);
      grad.addColorStop(0, this.lightenHex(icon.color, 0.3));
      grad.addColorStop(1, icon.color);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1; ctx.stroke();
      // 图标
      ctx.fillStyle = "#000";
      ctx.font = `bold ${Math.max(9, Math.floor(size * 0.32))}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(icon.glyph, x + size / 2, y + size / 2 + 1);
      // 名称（底部小字）
      ctx.fillStyle = "#c0c8d8";
      ctx.font = `bold ${Math.max(5, Math.floor(size * 0.16))}px monospace`;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(item.name.slice(0, 2), x + size / 2, y + size - Math.floor(size * 0.06));
    }
  }

  /** 颜色变亮（工具） */
  private lightenHex(hex: string, amount: number): string {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = Math.min(255, Math.round(parseInt(m[1], 16) + (255 - parseInt(m[1], 16)) * amount));
    const g = Math.min(255, Math.round(parseInt(m[2], 16) + (255 - parseInt(m[2], 16)) * amount));
    const b = Math.min(255, Math.round(parseInt(m[3], 16) + (255 - parseInt(m[3], 16)) * amount));
    return `rgb(${r},${g},${b})`;
  }
  /** 颜色变暗（工具） */
  private darkenHex(hex: string, amount: number): string {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const r = Math.max(0, Math.round(parseInt(m[1], 16) * (1 - amount)));
    const g = Math.max(0, Math.round(parseInt(m[2], 16) * (1 - amount)));
    const b = Math.max(0, Math.round(parseInt(m[3], 16) * (1 - amount)));
    return `rgb(${r},${g},${b})`;
  }
}
