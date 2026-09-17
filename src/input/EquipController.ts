//  EquipController.ts ─
// 精准装配操作模块（问题2/10/14）：把"背包模块 → 指定炮筒槽位"的两段式装配，
// 统一为三套操作方式（电脑鼠标/手机触屏=点击两段式；手柄=焦点框+确认键）。
// 作为可被调用的模块，由游戏模式持有：模式把库存/坦克/反馈注入，动作在此直接执行。
import type { Tank } from "../game/Tank";
import type { InventorySystem } from "../systems/wand/InventorySystem";
import type { SoundName } from "../engine/SoundManager";

/** 可装配的目标：背包格 或 炮筒槽 */
export type EquipZone =
  | { kind: "inv"; index: number }
  | { kind: "wand"; wand: number; index: number };

export interface EquipCtx {
  inv: InventorySystem;
  player: Tank;
  /** 使用传统道具（从指定背包格取出并生效） */
  onUseItem: (invIdx: number) => void;
  onFeedback: (msg: string, color: string) => void;
  onPlay: (sfx: SoundName) => void;
  /** 卸载模块消耗经验（从炮筒卸下需付费，覆盖则免费但销毁旧模块） */
  gold: () => number;
  spendGold: (amount: number) => boolean;
}

// 面板网格几何（与 BackpackPanel 渲染保持一致）
export const EQUIP_PANEL = {
  w: 460, h: 330,
  invCols: 4, invSlot: 44, invGap: 4, invX0: 8, invY0: 26,
  wandCols: 6, wandSlot: 36, wandGap: 4, wandX0: 8, wandY0: 148, wandRowH: 42,
};

/** 从炮筒卸下模块到背包的消耗经验（保留模块；覆盖则免费但销毁旧模块） */
export const UNEQUIP_COST = 15;

export class EquipController {
  /** 两段式第一步：选中的背包模块索引（null=未选中） */
  selectedInv: number | null = null;
  /** 手柄焦点框位置 */
  focus: EquipZone = { kind: "inv", index: 0 };

  private moveDebounce = 0;
  private confirmHeld = false;

  reset(): void {
    this.selectedInv = null;
    this.focus = { kind: "inv", index: 0 };
    this.moveDebounce = 0;
    this.confirmHeld = false;
  }

  update(dt: number): void {
    this.moveDebounce = Math.max(0, this.moveDebounce - dt);
  }

  /** 指针/触屏：命中测试 → 执行动作。panelX/panelY 为面板左上角。命中槽位返回 true */
  pointerTap(x: number, y: number, panelX: number, panelY: number, ctx: EquipCtx): boolean {
    const zone = this.hitTest(x - panelX, y - panelY, ctx);
    if (!zone) return false;
    this.act(zone, ctx);
    return true;
  }

  /** 手柄：方向键移动焦点框（带防抖） */
  moveFocus(dx: number, dy: number, ctx: EquipCtx): void {
    if (this.moveDebounce > 0) return;
    this.moveDebounce = 0.18;
    const invRows = Math.max(1, Math.ceil(ctx.inv.totalSlots / EQUIP_PANEL.invCols));
    const z = this.focus;
    if (z.kind === "inv") {
      const col = z.index % EQUIP_PANEL.invCols;
      const row = Math.floor(z.index / EQUIP_PANEL.invCols);
      const nc = Math.max(0, Math.min(EQUIP_PANEL.invCols - 1, col + dx));
      const nr = Math.max(0, Math.min(invRows - 1, row + dy));
      this.focus = { kind: "inv", index: nr * EQUIP_PANEL.invCols + nc };
    } else {
      const slots = ctx.player.cannons[z.wand]?.modules.length ?? 0;
      if (dy !== 0) {
        const nw = Math.max(0, Math.min(3, z.wand + dy));
        const nslots = ctx.player.cannons[nw]?.modules.length ?? 0;
        this.focus = { kind: "wand", wand: nw, index: Math.min(z.index, Math.max(0, nslots - 1)) };
      } else {
        this.focus = { kind: "wand", wand: z.wand, index: Math.max(0, Math.min(slots - 1, z.index + dx)) };
      }
    }
  }

  /** 手柄：确认键（A）——按下沿触发一次焦点动作 */
  confirmHeldInput(pressed: boolean, ctx: EquipCtx): void {
    if (pressed && !this.confirmHeld) this.act(this.focus, ctx);
    this.confirmHeld = pressed;
  }

  /** 渲染手柄焦点框 + 两段式选中高亮 */
  renderFocus(c: CanvasRenderingContext2D, panelX: number, panelY: number, ctx: EquipCtx): void {
    const G = EQUIP_PANEL;
    const z = this.focus;
    let r: { x: number; y: number; s: number };
    if (z.kind === "inv") {
      const col = z.index % G.invCols;
      const row = Math.floor(z.index / G.invCols);
      r = { x: panelX + G.invX0 + col * (G.invSlot + G.invGap), y: panelY + G.invY0 + row * (G.invSlot + G.invGap), s: G.invSlot };
    } else {
      r = { x: panelX + G.wandX0 + z.index * (G.wandSlot + G.wandGap), y: panelY + G.wandY0 + z.wand * G.wandRowH, s: G.wandSlot };
    }
    // 两段式选中高亮
    if (this.selectedInv !== null) {
      const col = this.selectedInv % G.invCols;
      const row = Math.floor(this.selectedInv / G.invCols);
      c.fillStyle = "rgba(255,255,0,0.22)";
      c.fillRect(panelX + G.invX0 + col * (G.invSlot + G.invGap), panelY + G.invY0 + row * (G.invSlot + G.invGap), G.invSlot, G.invSlot);
    }
    // 焦点框（黄色粗框，高亮在上）
    c.strokeStyle = "#ff0";
    c.lineWidth = 2;
    c.strokeRect(r.x + 0.5, r.y + 0.5, r.s - 1, r.s - 1);
  }

  // ── 内部 ────────────────────────────────────────────
  /** v2.23 拖动/协议装配：把背包格 invIdx 装入炮筒 wand 的 slot（主机权威侧执行；覆盖槽免费但销毁旧模块）。
   *  成功返回 null，失败返回原因文字。 */
  equipDirect(invIdx: number, wand: number, slot: number, ctx: EquipCtx): string | null {
    const { inv, player, onPlay, onFeedback } = ctx;
    const cannon = player.cannons[wand];
    if (!cannon || slot < 0 || slot >= cannon.modules.length) return "炮筒槽不存在";
    const src = inv.getAll()[invIdx]?.item;
    if (!src || !("config" in src)) return "背包格为空或不是模块";
    if (cannon.modules[slot] && cannon.modules[slot] !== src) {
      onFeedback(`覆盖炮筒${wand + 1}原有模块（已销毁）`, "#f88");
    }
    inv.removeAt(invIdx);
    cannon.modules[slot] = src;
    onPlay("pickup");
    onFeedback(`已装入 炮筒${wand + 1}`, "#ffd700");
    return null;
  }

  /** v2.23 拖动/协议卸载：把炮筒 wand 的 slot 卸回背包（扣 UNEQUIP_COST 经验）。成功返回 null，失败返回原因。 */
  unequipDirect(wand: number, slot: number, ctx: EquipCtx): string | null {
    const { inv, player, onFeedback, onPlay, spendGold } = ctx;
    const cannon = player.cannons[wand];
    const mod = cannon?.modules[slot];
    if (!cannon || !mod) return "该槽为空";
    if (inv.freeSlots <= 0) return "背包已满";
    if (!spendGold(UNEQUIP_COST)) return `卸装需${UNEQUIP_COST}经验`;
    inv.addModuleInstance(mod);
    cannon.modules[slot] = null;
    onPlay("pickup");
    onFeedback(`已卸下 -${UNEQUIP_COST}经验`, "#ffd700");
    return null;
  }

  private hitTest(lx: number, ly: number, ctx: EquipCtx): EquipZone | null {
    const G = EQUIP_PANEL;
    for (let i = 0; i < ctx.inv.totalSlots; i++) {
      const col = i % G.invCols;
      const row = Math.floor(i / G.invCols);
      const sx = G.invX0 + col * (G.invSlot + G.invGap);
      const sy = G.invY0 + row * (G.invSlot + G.invGap);
      if (lx >= sx && lx < sx + G.invSlot && ly >= sy && ly < sy + G.invSlot) return { kind: "inv", index: i };
    }
    for (let w = 0; w < 4; w++) {
      const slots = ctx.player.cannons[w]?.modules.length ?? 0;
      for (let s = 0; s < slots; s++) {
        const sx = G.wandX0 + s * (G.wandSlot + G.wandGap);
        const sy = G.wandY0 + w * G.wandRowH;
        if (lx >= sx && lx < sx + G.wandSlot && ly >= sy && ly < sy + G.wandSlot) return { kind: "wand", wand: w, index: s };
      }
    }
    return null;
  }

  private act(z: EquipZone, ctx: EquipCtx): void {
    const { inv, player, onUseItem, onFeedback, onPlay } = ctx;
    if (z.kind === "inv") {
      const item = inv.getAll()[z.index]?.item;
      if (!item) return;
      if ("kind" in item) { onUseItem(z.index); return; }   // 传统道具：直接使用
      this.selectedInv = this.selectedInv === z.index ? null : z.index;   // 模块：两段式选择
      return;
    }

    const cannon = player.cannons[z.wand];
    const mod = cannon?.modules[z.index];
    if (!cannon) return;

    if (this.selectedInv !== null) {
      // 两段式第二步：把选中的背包模块装入此槽
      //  - 槽为空：直接装入（免费）
      //  - 槽已占用：覆盖（免费）但销毁旧模块；想保留旧模块需先付费卸下
      const src = inv.getAll()[this.selectedInv]?.item;
      if (!src || !("config" in src)) { this.selectedInv = null; return; }
      if (mod && mod !== src) {
        onFeedback(`覆盖炮筒${z.wand + 1}原有模块（已销毁）`, "#f88");
      }
      inv.removeAt(this.selectedInv);
      cannon.modules[z.index] = src;
      this.selectedInv = null;
      onPlay("pickup");
      onFeedback(`已装入 炮筒${z.wand + 1}`, "#ffd700");
    } else if (mod) {
      // 卸下：炮筒槽 → 背包（消耗经验，保留剩余次数）
      if (inv.freeSlots <= 0) {
        onFeedback("背包已满", "#f66");
        return;
      }
      if (!ctx.spendGold(UNEQUIP_COST)) {
        onFeedback(`卸装需${UNEQUIP_COST}经验`, "#f66");
        onPlay("deny");
        return;
      }
      inv.addModuleInstance(mod);
      cannon.modules[z.index] = null;
      onPlay("pickup");
      onFeedback(`已卸下 -${UNEQUIP_COST}经验`, "#ffd700");
    }
  }
}
