//  InventorySystem.ts ─
import type { ModuleInstance } from "../wand/WandTypes";
import type { ModuleConfig } from "../wand/WandTypes";
import { getModule } from "../wand/ModuleRegistry";

export interface InventorySlot {
  item: ModuleInstance | TraditionalItem | null;
}

export interface TraditionalItem {
  kind: "traditional";
  id: string;
  name: string;
  desc: string;
}

const TRAD_ITEM_DEFS: Record<string, Omit<TraditionalItem,"kind">> = {
  item_shield:       { id:"item_shield",       name:"护盾",       desc:"吸收下一次伤害" },
  item_timestop:     { id:"item_timestop",     name:"时停",       desc:"3秒内所有敌人静止" },
  item_bomb:         { id:"item_bomb",         name:"全场炸弹",   desc:"对全屏敌人造成伤害" },
  item_extra_life:   { id:"item_extra_life",   name:"额外命",     desc:"+1条命" },
  item_repair_kit:   { id:"item_repair_kit",   name:"修复套件",   desc:"立即修复基地一面墙" },
  item_speed_boost:  { id:"item_speed_boost",  name:"加速",       desc:"移速+50%，持续15s" },
  item_damage_boost: { id:"item_damage_boost", name:"攻击强化",   desc:"所有伤害+30%，持续10s" },
  item_bricks:       { id:"item_bricks",       name:"放砖",       desc:"在前方放置一块可破坏砖块（30次）" },
};

/** 传统道具图标：每个道具独立图案+颜色，便于玩家识别（不再是清一色"I"） */
export const TRAD_ITEM_ICONS: Record<string, { glyph: string; color: string }> = {
  item_shield:       { glyph: "盾", color: "#4af" },
  item_timestop:     { glyph: "停", color: "#8ff" },
  item_bomb:         { glyph: "爆", color: "#f44" },
  item_extra_life:   { glyph: "命", color: "#4f4" },
  item_repair_kit:   { glyph: "修", color: "#fa0" },
  item_speed_boost:  { glyph: "速", color: "#ff0" },
  item_damage_boost: { glyph: "攻", color: "#f80" },
  item_bricks:       { glyph: "砖", color: "#c84" },
};

export function tradItemIcon(itemId: string): { glyph: string; color: string } {
  return TRAD_ITEM_ICONS[itemId] ?? { glyph: "具", color: "#f84" };
}

export function getTradItemName(itemId: string): string {
  return TRAD_ITEM_DEFS[itemId]?.name ?? itemId;
}

export class InventorySystem {
  /** v2.34 不再 readonly：基地商店「背包·扩容」可提升（上限由购买侧控制=16） */
  maxSlots: number;
  private slots: InventorySlot[];

  constructor(maxSlots = 30) {
    this.maxSlots = maxSlots;
    this.slots = Array.from({ length: maxSlots }, () => ({ item: null }));
  }

  /** v2.34 扩容：+amount 格（同步 maxSlots，autoStack/restoreFromNet 按下限重建不丢格） */
  expand(amount: number): void {
    for (let i = 0; i < amount; i++) this.slots.push({ item: null });
    this.maxSlots = this.slots.length;
  }

  /** 自动堆叠：同名模块合并剩余次数，传统道具堆叠（但传统道具不合并，因为每次使用是整体） */
  private autoStack(): void {
    // 对模块进行堆叠：同config.id的合并usesLeft
    const stacked = new Set<number>();
    for (let i = 0; i < this.slots.length; i++) {
      const si = this.slots[i].item;
      if (!si || !('config' in si) || stacked.has(i)) continue;
      for (let j = i + 1; j < this.slots.length; j++) {
        const sj = this.slots[j].item;
        if (!sj || !('config' in sj) || stacked.has(j)) continue;
        if (si.config.id === sj.config.id && si.config.maxUses > 0) {
          // 合并：把j的次数加到i上，j清空
          si.usesLeft += sj.usesLeft;
          this.slots[j].item = null;
          stacked.add(j);
        }
      }
    }
    // 压缩：把空洞移到末尾
    const items = this.slots.filter(s => s.item !== null);
    this.slots = items.concat(Array.from({ length: this.maxSlots - items.length }, () => ({ item: null })));
  }

  addModule(moduleId: string): boolean {
    const cfg = getModule(moduleId);
    if (!cfg) return false;
    // 尝试堆叠到已有同名模块
    if (cfg.maxUses > 0) {
      const existing = this.slots.find(s => s.item && 'config' in s.item && s.item.config.id === moduleId);
      if (existing) {
        (existing.item as ModuleInstance).usesLeft += cfg.maxUses;
        return true;
      }
    }
    const emptySlot = this.slots.find(s => !s.item);
    if (!emptySlot) return false;
    emptySlot.item = { config: cfg, usesLeft: cfg.maxUses };
    return true;
  }

  /** 装入一个已存在的模块实例（保留剩余次数），用于卸下/交换 */
  addModuleInstance(instance: ModuleInstance): boolean {
    const emptySlot = this.slots.find(s => !s.item);
    if (!emptySlot) return false;
    emptySlot.item = instance;
    return true;
  }

  addTraditionalItem(itemId: string): boolean {
    const def = TRAD_ITEM_DEFS[itemId];
    if (!def) return false;
    const emptySlot = this.slots.find(s => !s.item);
    if (!emptySlot) return false;
    emptySlot.item = { kind: "traditional", ...def };
    return true;
  }

  removeAt(index: number): InventorySlot["item"] {
    const slot = this.slots[index];
    if (!slot) return null;
    const item = slot.item;
    slot.item = null;
    return item;
  }

  /** Find first traditional item slot index, or -1 */
  findTraditionalItem(): number {
    return this.slots.findIndex(s => s.item && "kind" in s.item && s.item.kind === "traditional");
  }

  /** Remove and return first traditional item id */
  takeFirstTraditionalItem(): string | null {
    const idx = this.findTraditionalItem();
    if (idx < 0) return null;
    const item = this.removeAt(idx);
    if (item && "kind" in item && item.kind === "traditional") return item.id;
    return null;
  }

  /** Remove traditional item at slot and return its id */
  takeTraditionalItemAt(index: number): string | null {
    const slot = this.slots[index];
    if (!slot?.item || !("kind" in slot.item) || slot.item.kind !== "traditional") return null;
    const id = slot.item.id;
    slot.item = null;
    return id;
  }

  getAll(): InventorySlot[] { return this.slots; }

  /** v2.12 检查点恢复：按槽位重建（模块带剩余次数，传统道具无次数概念） */
  restoreFromNet(slots: Array<{ kind: "module" | "item"; id: string; uses: number } | null>): void {
    this.slots = Array.from({ length: this.maxSlots }, () => ({ item: null }));
    for (let i = 0; i < Math.min(slots.length, this.slots.length); i++) {
      const s = slots[i];
      if (!s) continue;
      if (s.kind === "module") {
        const cfg = getModule(s.id);
        if (!cfg) continue;
        this.slots[i].item = { config: cfg, usesLeft: typeof s.uses === "number" ? s.uses : cfg.maxUses };
      } else {
        const def = TRAD_ITEM_DEFS[s.id];
        if (!def) continue;
        this.slots[i].item = { kind: "traditional", ...def };
      }
    }
  }

  /** v2.10 网络对齐视图：{ 传统道具id: 数量, 模块: 总模块数 }——快照 scope.bp 携带给成员端展示/对齐 */
  toNet(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.slots) {
      if (!s.item) continue;
      const key = "kind" in s.item && s.item.kind === "traditional" ? s.item.id : "模块";
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }

  get usedSlots(): number { return this.slots.filter(s => !!s.item).length; }
  get freeSlots(): number { return this.slots.filter(s => !s.item).length; }
  get totalSlots(): number { return this.slots.length; }
}
