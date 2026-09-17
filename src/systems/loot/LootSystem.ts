//  LootSystem.ts ─ v2.15 引用 NumericConfig
import type { Enemy, EnemyGrade } from "../../game/Enemy";
import { getModule } from "../wand/ModuleRegistry";
import { tradItemIcon } from "../wand/InventorySystem";
import type { ModuleConfig } from "../wand/WandTypes";
import { LOOT as CFG_LOOT } from "../../framework/NumericConfig";
// v2.15 共享渲染模块：主机端和成员端都调用 EntityVisual，确保联机版本一致
import { renderLoot as renderLootVisual } from "../../ui/EntityVisual";

export interface LootDrop {
  x: number;
  y: number;
  type: "module" | "item" | "exp";   // v2.7：金币并入经验（经验拾取=货币，升级经验仍由击杀 addExp）
  moduleId?: string;
  itemId?: string;
  value?: number;        // exp amount（货币经验）
  id: number;
  lifetime: number;      // seconds before despawn
  quality: "white" | "blue" | "gold" | "none";
  ownerId?: number;      // 专属掉落（如升级改装件）：仅该玩家可捡，undefined=公开
}

let lootIdCounter = 0;

const TRAD_ITEMS = [
  "item_shield", "item_timestop", "item_bomb", "item_extra_life",
  "item_repair_kit", "item_speed_boost", "item_damage_boost",
  "item_handyman",
];

/** Per-grade traditional item drop chance range [min, max]
 *  v2.15 改为引用 NumericConfig.LOOT.TRAD_ITEM_DROP_BY_GRADE（单一事实源）
 *  原硬编码 GRADE_ITEM_DROP 已移除 */
function rollItemDrop(grade: EnemyGrade): boolean {
  const [min, max] = CFG_LOOT.TRAD_ITEM_DROP_BY_GRADE[grade];
  return Math.random() < min + Math.random() * (max - min);
}

/**
 * v2.20 各 grade 额外加入「辅助模块组」的散射升级线 / 方向修正 / 追踪模块。
 * v2.24 辅助组补充触发模块（命中/销毁/定时/延迟/弹跳/击杀触发）：此前触发器只存在于
 *       ModuleRegistry，未进入任何掉落表，导致玩家从未见过触发模块。
 * v2.26 辅助组补充暴击模块（暴击率+8%/+15%、暴击伤害+50%）：统一走"敌人掉落 → 背包
 *       → 炮筒"链路；升级面板绝不发放模块/道具（只能给属性点）。
 * v2.27 补充中/强追踪区分（mod_homing_med 进 B/A）与金色暴击率（S2+ 专属）。
 * 低级（白/蓝）有限次数，高等级（蓝顶/金）无限次数；金色件只在 A/S 及以上出现，
 * 也可通过基地仓库"3白→1蓝、3蓝+精华→1金"合成得到。
 */
const GRADE_AUX_EXTRA: Record<EnemyGrade, string[]> = {
  F:    ["mod_split_2", "mod_aim_focus", "trig_on_hit", "mod_crit_up"],
  C:    ["mod_split_2", "mod_split_3", "mod_aim_focus", "mod_homing", "trig_on_hit", "trig_on_destroy", "trig_on_fire", "mod_crit_up", "mod_critdmg"],
  B:    ["mod_split_3", "mod_split_4", "mod_aim_focus", "mod_homing", "mod_homing_med", "trig_on_hit", "trig_on_destroy", "trig_timer", "trig_delay", "trig_on_fire", "mod_crit_up", "mod_crit_up2", "mod_critdmg"],
  A:    ["mod_split_4", "mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_on_fire", "mod_crit_up2", "mod_critdmg"],
  S:    ["mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_timer", "trig_on_fire", "mod_crit_up2", "mod_crit_up_gold", "mod_critdmg"],
  S2:   ["mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_timer", "trig_on_fire", "mod_crit_up2", "mod_crit_up_gold", "mod_critdmg"],
  S3:   ["mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_timer", "trig_on_fire", "mod_crit_up2", "mod_crit_up_gold", "mod_critdmg"],
  S4:   ["mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_timer", "trig_on_fire", "mod_crit_up2", "mod_crit_up_gold", "mod_critdmg"],
  S5:   ["mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_timer", "trig_on_fire", "mod_crit_up2", "mod_crit_up_gold", "mod_critdmg"],
  BOSS: ["mod_split_5", "mod_aim_focus_gold", "mod_homing_med", "mod_homing_strong", "trig_delay", "trig_bounce_trigger", "trig_on_kill", "trig_timer", "trig_on_fire", "mod_crit_up2", "mod_crit_up_gold", "mod_critdmg"],
};

/**
 * v2.20 把敌人的 moduleDropIds 拆成两个掉落包：
 *  - ammo（弹药组）：消耗型武器模块（category=projectile），会被打光、需要补给；
 *  - aux（辅助模块组）：修饰器/特殊/触发器等功能件（散射一分N、方向修正、追踪、
 *    附元素、放墙、无人机、连锁闪电等），不消耗或高等级无限，整体更稀有。
 * 组内具体类型再等概率细分（结构上保留为独立数组，便于以后按类型配权）。
 */
export function buildDropPools(grade: EnemyGrade, ids: string[]): { ammo: string[]; aux: string[] } {
  const ammo: string[] = [];
  const aux: string[] = [];
  const pushUnique = (arr: string[], id: string) => { if (!arr.includes(id)) arr.push(id); };
  for (const id of ids) {
    const m = getModule(id);
    if (!m) continue;
    if (m.category === "projectile") pushUnique(ammo, id);
    else pushUnique(aux, id);
  }
  for (const id of GRADE_AUX_EXTRA[grade] ?? []) {
    if (getModule(id)) pushUnique(aux, id);
  }
  return { ammo, aux };
}

/** 组内等概率细分一个具体类型（后续可改为按 id 配权的加权抽取） */
function pickFromPool(pool: string[]): string | null {
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export class LootSystem {
  drops: LootDrop[] = [];
  mapW: number = 800;
  mapH: number = 640;
  /** 掉落物存活时长（v2.18 延长到60s：给玩家充足时间拾取，尤其是改装件） */
  readonly DROP_LIFETIME = 60;

  /** v2.14.2 归属权：killerId 传入后，模块/道具归属该玩家（只有他能捡）；经验保持公开掉落（团队资源）。
   *  无 killerId 时全部公开（如被基地墙烧死/陷阱死等场景）。
   *  v2.25 dropMult：击杀者的模块掉落率倍率（sp_loot「模块掉落+50%」能力，可叠加）。 */
  onEnemyKilled(enemy: Enemy, killerId?: number, dropMult: number = 1): void {
    const cfg = enemy.enemyCfg;
    const isBoss = enemy.isBoss;
    const pad = 32;
    const ex = Math.max(pad, Math.min(this.mapW - pad, enemy.x + (Math.random() - 0.5) * 20));
    const ey = Math.max(pad, Math.min(this.mapH - pad, enemy.y + (Math.random() - 0.5) * 20));
    const owner = killerId;  // undefined → 公开

    // v2.7：金币并入经验 → 每个敌人掉 1 份"浓缩经验"（团队资源，双方都能捡）
    // v2.15：EXP_CONVERT_RATE 从 2.5 砍到 1.0，匹配用户"掉落太多"诉求
    const expValue = Math.ceil(cfg.goldReward * CFG_LOOT.EXP_CONVERT_RATE) * (isBoss ? CFG_LOOT.BOSS_EXP_MULTIPLIER : 1);
    this.drops.push({ id: lootIdCounter++, x: ex, y: ey + 4, type: "exp", value: expValue, lifetime: this.DROP_LIFETIME, quality: "none" });

    // Boss: guaranteed gold module drop
    if (isBoss) {
      const goldModules = ["spec_black_hole_gold", "proj_bullet_gold", "mod_damage_up_gold"];
      const goldId = goldModules[Math.floor(Math.random() * goldModules.length)];
      this.drops.push({
        id: lootIdCounter++, x: ex, y: ey - 16, type: "module",
        moduleId: goldId, lifetime: this.DROP_LIFETIME, quality: "gold", ownerId: owner,
      });
      // Boss also drops a random traditional item
      const itemId = TRAD_ITEMS[Math.floor(Math.random() * TRAD_ITEMS.length)];
      this.drops.push({
        id: lootIdCounter++, x: ex, y: ey - 32, type: "item",
        itemId, lifetime: this.DROP_LIFETIME, quality: "white", ownerId: owner,
      });
      // Boss drops 1-2 essence (强化材料, 用于金色合成)
      const essenceCount = 1 + Math.floor(Math.random() * 2);
      for (let k = 0; k < essenceCount; k++) {
        this.drops.push({
          id: lootIdCounter++, x: ex + (Math.random() - 0.5) * 24, y: ey - 44 - k * 14,
          type: "item", itemId: "item_essence", lifetime: this.DROP_LIFETIME, quality: "gold", ownerId: owner,
        });
      }
      return; // Boss guaranteed drops, skip normal roll
    }

    // v2.15 Elite (S / A) small chance to drop essence（原 0.25 → NumericConfig.ESSENCE_DROP_CHANCE_ELITE=0.10）
    if ((enemy.grade === "S" || enemy.grade === "A") && Math.random() < CFG_LOOT.ESSENCE_DROP_CHANCE_ELITE) {
      this.drops.push({
        id: lootIdCounter++, x: ex, y: ey - 44, type: "item",
        itemId: "item_essence", lifetime: this.DROP_LIFETIME, quality: "gold", ownerId: owner,
      });
    }

    // ── v2.20 模块掉落分包 ──
    // 总包概率（弹药组）= grade.moduleDropChance × 全局倍率 × 击杀者掉落倍率（v2.25）
    const moduleChance = Math.min(1, cfg.moduleDropChance * CFG_LOOT.MODULE_DROP_MULTIPLIER * dropMult);
    const pools = buildDropPools(enemy.grade, cfg.moduleDropIds);

    // 弹药组（消耗型武器）：总包概率 moduleChance
    if (moduleChance > 0 && pools.ammo.length > 0 && Math.random() < moduleChance) {
      const moduleId = pickFromPool(pools.ammo);
      const mod = moduleId ? getModule(moduleId) : null;
      if (moduleId && mod) {
        this.drops.push({
          id: lootIdCounter++, x: ex, y: ey - 16, type: "module",
          moduleId, lifetime: this.DROP_LIFETIME, quality: mod.quality, ownerId: owner,
        });
      }
    }

    // 辅助模块组（散射一分N/方向修正/追踪等功能件，不消耗或高等级无限）：
    // 总包概率 = 弹药组 × 1/3，组内再细分具体辅助件；与弹药组独立 roll（可同时掉）。
    const auxChance = moduleChance * CFG_LOOT.AUX_DROP_RATIO;
    if (auxChance > 0 && pools.aux.length > 0 && Math.random() < auxChance) {
      const moduleId = pickFromPool(pools.aux);
      const mod = moduleId ? getModule(moduleId) : null;
      if (moduleId && mod) {
        this.drops.push({
          id: lootIdCounter++, x: ex, y: ey - 30, type: "module",
          moduleId, lifetime: this.DROP_LIFETIME, quality: mod.quality, ownerId: owner,
        });
      }
    }

    // ── v2.28 Boss级（血量≥400，即 S/S2/S3/S4/S5）额外武器掉落：35% 掉一件"它实际使用的武器" ──
    // （额外增加，不影响上方常规掉落概率；BOSS 已走专属掉落通道）
    const bossTier = enemy.grade === "S" || enemy.grade === "S2" || enemy.grade === "S3"
      || enemy.grade === "S4" || enemy.grade === "S5";
    if (bossTier && Math.random() < 0.35) {
      const used = enemy.cannons[0]?.modules.flatMap(m => (m ? [m.config.id] : [])) ?? [];
      const candidates = used.length > 0 ? used : cfg.moduleDropIds;
      const modId = candidates[Math.floor(Math.random() * candidates.length)];
      const mod = getModule(modId);
      if (mod) {
        this.drops.push({
          id: lootIdCounter++, x: ex + (Math.random() - 0.5) * 20, y: ey - 46, type: "module",
          moduleId: modId, lifetime: this.DROP_LIFETIME, quality: mod.quality, ownerId: owner,
        });
      }
    }

    // Traditional item — per-grade drop rate (F: 3–10%)
    if (rollItemDrop(enemy.grade)) {
      const itemId = TRAD_ITEMS[Math.floor(Math.random() * TRAD_ITEMS.length)];
      this.drops.push({
        id: lootIdCounter++, x: ex, y: ey - 32, type: "item",
        itemId, lifetime: this.DROP_LIFETIME, quality: "white", ownerId: owner,
      });
    }
  }

  /** v2.7：不再吸引/追踪玩家 —— 掉落物原地静止，玩家自己去捡（避免与子弹视觉混淆） */
  update(dt: number, _playerPositions?: Array<{ x: number; y: number }>): void {
    this.drops = this.drops.filter(d => { d.lifetime -= dt; return d.lifetime > 0; });
  }

  pickup(px: number, py: number, radius = 20, playerIdx?: number): LootDrop[] {
    const picked: LootDrop[] = [];
    this.drops = this.drops.filter(d => {
      // 专属掉落（升级改装件等）：非本人不可捡
      if (d.ownerId !== undefined && (playerIdx === undefined || d.ownerId !== playerIdx)) return true;
      const dx = d.x - px; const dy = d.y - py;
      if (dx * dx + dy * dy < radius * radius) { picked.push(d); return false; }
      return true;
    });
    return picked;
  }

  /** v2.14.2 归属视觉：viewer 是当前玩家 idx，别人的专属掉落半透明灰显示（但仍能看到、提醒"这不是你的"）。
   *  公开掉落（无 ownerId）照常亮显示。viewer 为 undefined 时不区分（观战/单机）。 */
  render(ctx: CanvasRenderingContext2D, now: number, viewer?: number): void {
    // v2.15 调用共享渲染模块 EntityVisual，确保主机端和成员端渲染完全一致
    renderLootVisual(ctx, {
      drops: this.drops,
      viewer,
    }, now);
  }
}
