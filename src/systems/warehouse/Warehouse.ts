//  Warehouse.ts ─
// 基地大仓库：无限存储 + 低级合成高级（小人造武器）。
// 3×白 → 1×蓝；3×蓝 + 1×强化材料(essence) → 1×金。
import type { ModuleInstance, ModuleQuality } from "../wand/WandTypes";
import { getModule, getModulesByQuality } from "../wand/ModuleRegistry";
import type { InventorySystem } from "../wand/InventorySystem";

export const QUALITY_ORDER: ModuleQuality[] = ["white", "blue", "gold"];

const QUALITY_LABEL: Record<ModuleQuality, string> = {
  white: "白色", blue: "蓝色", gold: "金色",
};

export class Warehouse {
  private slots: (ModuleInstance | null)[] = [];
  /** 强化材料（BOSS/精英掉落 item_essence） */
  essence: number = 0;

  constructor(initialEssence = 0) {
    this.essence = initialEssence;
  }

  get all(): (ModuleInstance | null)[] { return this.slots; }
  get usedSlots(): number { return this.slots.filter(s => !!s).length; }

  /** 存入一个模块（无上限）。返回 true 表示成功。 */
  store(module: ModuleInstance): boolean {
    this.slots.push(module);
    return true;
  }

  /** 取出指定槽位模块，存入背包。背包满则失败。 */
  withdrawToInventory(index: number, inv: InventorySystem): boolean {
    const m = this.slots[index];
    if (!m) return false;
    if (inv.freeSlots <= 0) return false;
    this.slots.splice(index, 1);
    inv.addModule(m.config.id);
    return true;
  }

  /** 直接按 id 存入（模块掉落时使用）。 */
  storeModuleId(moduleId: string): boolean {
    const cfg = getModule(moduleId);
    if (!cfg) return false;
    this.slots.push({ config: cfg, usesLeft: cfg.maxUses });
    return true;
  }

  countByQuality(q: ModuleQuality): number {
    return this.slots.filter(s => s && s.config.quality === q).length;
  }

  /** 移除指定品质的前 n 个模块。 */
  private removeQuality(q: ModuleQuality, n: number): number {
    let removed = 0;
    for (let i = 0; i < this.slots.length && removed < n; ) {
      const s = this.slots[i];
      if (s && s.config.quality === q) {
        this.slots.splice(i, 1);
        removed++;
      } else {
        i++;
      }
    }
    return removed;
  }

  /** 合成：target 为产出品质。返回产出模块，失败返回 null。 */
  synthesize(target: "blue" | "gold"): ModuleInstance | null {
    const inputIdx = QUALITY_ORDER.indexOf(target) - 1;
    if (inputIdx < 0) return null;
    const inputQ = QUALITY_ORDER[inputIdx];
    const need = 3;
    if (this.countByQuality(inputQ) < need) return null;
    // 金色合成额外需要 1 个强化材料
    if (target === "gold" && this.essence < 1) return null;

    this.removeQuality(inputQ, need);
    if (target === "gold") this.essence--;

    const candidates = getModulesByQuality(target);
    if (candidates.length === 0) return null;
    const cfg = candidates[Math.floor(Math.random() * candidates.length)];
    return { config: cfg, usesLeft: cfg.maxUses };
  }

  /** 一次把所有可合成对尽量合完（小人自动造武器，后台逻辑）。返回合成数量。 */
  autoSynthesizeAll(): number {
    let made = 0;
    // 白→蓝（不限材料）
    while (this.countByQuality("white") >= 3) {
      const m = this.synthesize("blue");
      if (!m) break;
      this.slots.push(m);
      made++;
    }
    // 蓝→金（需 essence）
    while (this.essence > 0 && this.countByQuality("blue") >= 3) {
      const m = this.synthesize("gold");
      if (!m) break;
      this.slots.push(m);
      made++;
    }
    return made;
  }

  static qualityLabel(q: ModuleQuality): string { return QUALITY_LABEL[q]; }
}
