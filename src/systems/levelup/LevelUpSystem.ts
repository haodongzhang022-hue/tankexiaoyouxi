//  LevelUpSystem.ts ─
import type { Tank } from "../../game/Tank";
import type { Base } from "../../game/Base";
import type { BaseRepairSystem } from "../base/BaseRepairSystem";
import type { InventorySystem } from "../wand/InventorySystem";
import { LEVEL_UP as CFG_LEVEL_UP } from "../../framework/NumericConfig";

// 升级选项的按键绑定（两位玩家各自独立，控制自己的升级）
// P1 用 T/Y/U（左手附近好按，避开 WASD 与 H/J/K/L 射击键）
// P2 用小键盘 7/8/9（右手数字区，避开小键盘 1-4 射击键）
export const LEVELUP_KEYS_P1 = ["KeyT", "KeyY", "KeyU"];
export const LEVELUP_KEYS_P2 = ["Numpad7", "Numpad8", "Numpad9"];
// 对应的显示标签（画在升级按钮上，明确告诉玩家按哪个键）
export const LEVELUP_LABELS_P1 = ["T", "Y", "U"];
export const LEVELUP_LABELS_P2 = ["7", "8", "9"];
export function levelUpKeysFor(playerIdx: number): string[] {
  return playerIdx === 0 ? LEVELUP_KEYS_P1 : LEVELUP_KEYS_P2;
}
export function levelUpLabelsFor(playerIdx: number): string[] {
  return playerIdx === 0 ? LEVELUP_LABELS_P1 : LEVELUP_LABELS_P2;
}

// ── 升级面板几何/命中检测 ──
// 两位玩家共用同一套侧边面板布局：P1 靠左缘、P2 靠右缘（不遮挡场地中央）。
// 新建一个共享模块级函数，供两模式渲染与点击判定使用同一份几何，避免"点不到/按错"。
export interface LevelUpPanelGeo {
  panelX: number; panelY: number; panelW: number; panelH: number; btnH: number;
}
export function levelUpPanelGeo(playerIdx: number, viewW: number, viewH: number): LevelUpPanelGeo {
  const panelW = 160; const panelH = 180; const btnH = 40;
  const panelX = playerIdx === 0 ? 4 : viewW - panelW - 4;
  const panelY = Math.floor(viewH / 2) - panelH / 2;
  return { panelX, panelY, panelW, panelH, btnH };
}
/** 返回命中的选项下标，未点中返回 -1；供鼠标/触屏直接点选升级 */
export function levelUpPanelChoiceAt(geo: LevelUpPanelGeo, choiceCount: number, x: number, y: number): number {
  for (let i = 0; i < choiceCount; i++) {
    const bx = geo.panelX + 4;
    const by = geo.panelY + 32 + i * (geo.btnH + 4);
    const bw = geo.panelW - 8;
    if (x >= bx && x < bx + bw && y >= by && y < by + geo.btnH) return i;
  }
  return -1;
}

export interface Ability {
  id: string;
  name: string;
  desc: string;
  category: "firepower" | "defense" | "special";
  apply: (tank: Tank) => void;
}

/**
 * v2.6.3 单武器伤害增强：每根炮筒一项，每次 +10%（克制递增，可多次累加）。
 * 替换旧的全武器伤害 +30%/+60%（一次升级前后突变、且覆盖所有武器）。
 */
export const ABILITY_POOL: Ability[] = [
  // ── 火力（全部直接加到坦克属性，不占武器槽、不进背包；v2.28 单次数值随机）──
  { id:"fp_all_dmg",   name:"全伤害+5~10%",  category:"firepower", desc:"所有炮筒投射体伤害+5~10%（随机，可叠加）",
    apply(t){ const r = 0.05 + Math.random() * 0.05; t.wandDamageMults = t.wandDamageMults.map(m => m * (1 + r)); } },
  { id:"fp_crit",      name:"暴击+5~8%",     category:"firepower", desc:"命中暴击率+5~8%（随机，基础0%，可叠加）",
    apply(t){ t.critChance = Math.min(1, t.critChance + 0.05 + Math.random() * 0.03); } },
  { id:"fp_crit_rate2",name:"暴击+6~8%·进阶", category:"firepower", desc:"命中暴击率+6~8%（随机偏上，基础0%，可叠加）",
    apply(t){ t.critChance = Math.min(1, t.critChance + 0.06 + Math.random() * 0.02); } },
  { id:"fp_crit_dmg",  name:"爆伤+5~12%",    category:"firepower", desc:"暴击伤害+5~12%（随机，基础200%，可叠加）",
    apply(t){ t.critMultiplier += 0.05 + Math.random() * 0.07; } },
  { id:"fp_crit_dmg2", name:"爆伤+10~20%",   category:"firepower", desc:"暴击伤害+10~20%（随机，基础200%，可叠加）",
    apply(t){ t.critMultiplier += 0.10 + Math.random() * 0.10; } },
  { id:"fp_speed",     name:"弹速+20%",     category:"firepower", desc:"所有炮筒投射体速度永久提升20%",
    apply(t){ t.projSpeedMult *= 1.2; } },
  { id:"fp_reload",    name:"装填-15%",     category:"firepower", desc:"所有炮筒射击间隔×0.85",
    apply(t){ t.cannons.forEach(c => { c.config.castDelay *= 0.85; }); } },
  { id:"fp_recharge",  name:"充能-20%",     category:"firepower", desc:"所有炮筒重装时间×0.8",
    apply(t){ t.cannons.forEach(c => { c.config.rechargeTime *= 0.8; }); } },
  { id:"fp_penetration", name:"穿甲+10%",   category:"firepower", desc:"炮弹穿透护甲比例+10%",
    apply(t){ t.extraArmorPen = Math.min(0.8, (t.extraArmorPen ?? 0) + 0.10); } },
  { id:"fp_pickup",    name:"拾取范围+25%", category:"firepower", desc:"道具拾取范围扩大25%",
    apply(t){ t.pickupRangeMult = (t.pickupRangeMult ?? 1) * 1.25; } },

  // ── 防御（渐进式成长，杜绝一升级血量翻几倍）──
  { id:"df_hp",        name:"最大HP+2",     category:"defense", desc:"最大HP增加2（渐进成长）",
    apply(t){ t.extraMaxHp += 2; t.hp = Math.min(t.hp + 2, t.effectiveMaxHp); } },
  { id:"df_hp2",       name:"最大HP+4",     category:"defense", desc:"最大HP增加4（渐进成长）",
    apply(t){ t.extraMaxHp += 4; t.hp = Math.min(t.hp + 4, t.effectiveMaxHp); } },
  { id:"df_armor",     name:"装甲+2~5",     category:"defense", desc:"减伤增加2~5（随机，约1~2.4%）",
    apply(t){ t.extraArmor += 2 + Math.floor(Math.random() * 4); } },
  { id:"df_armor2",    name:"装甲+3~5·进阶", category:"defense", desc:"减伤增加3~5（随机偏上，约1.4~2.4%）",
    apply(t){ t.extraArmor += 3 + Math.floor(Math.random() * 3); } },
  { id:"df_respawn",   name:"复活-1s",      category:"defense", desc:"复活时间减少1秒",
    apply(_t){ /* handled externally */ } },
  { id:"df_invincible",name:"命中盾15%",    category:"defense", desc:"被命中15%概率触发3s护盾",
    apply(t){ t.hasInvincibleShield = true; } },
  { id:"df_lives",     name:"复活次数+1",   category:"defense", desc:"可复活次数+1（属性点，非道具）",
    apply(t){ t.lives += 1; } },

  // ── 特殊（全部直接加到坦克属性）──
  { id:"sp_loot",      name:"模块掉落+50%", category:"special", desc:"击杀敌人时模块掉落率提高50%（可叠加）",
    apply(t){ t.moduleDropMult = (t.moduleDropMult ?? 1) * 1.5; } },
  { id:"sp_freecast",  name:"3%免消耗",     category:"special", desc:"每次射击3%概率不消耗模块次数",
    apply(t){ t.hasFreeCast = true; } },
  { id:"sp_speed",     name:"移速+5%",      category:"special", desc:"坦克移速+5%",
    apply(t){ t.extraSpeed += t.config.speed * 0.05; } },
  { id:"sp_repair",    name:"基地修复增速",  category:"special", desc:"基地小人修复速度提升50%",
    apply(_t){ /* handled externally */ } },
  { id:"sp_fortify",   name:"基地加固",     category:"special", desc:"基地四面墙变厚，耐久提升",
    apply(_t){ /* handled externally */ } },

  // ── 玩家墙体放置技能升级（非道具，是玩家自身能力，按Q键放置） ──
  { id:"wp_wall_2",   name:"墙体放置Lv2·厚墙", category:"special", desc:"墙体放置能力升级：砖墙耐久8，按Q放置",
    apply(t){ t.wallLevel = Math.max(t.wallLevel, 2); } },
  { id:"wp_wall_3",   name:"墙体放置Lv3·岩石", category:"special", desc:"墙体放置能力升级：敌人普通弹不可破，按Q放置",
    apply(t){ t.wallLevel = Math.max(t.wallLevel, 3); } },
  { id:"wp_wall_4",   name:"墙体放置Lv4·坚不可摧", category:"special", desc:"墙体放置能力升级：砖墙无法被破坏，按Q放置",
    apply(t){ t.wallLevel = Math.max(t.wallLevel, 4); } },
  { id:"wp_wall_speed", name:"墙体放置冷却-50%", category:"special", desc:"玩家墙体放置冷却时间减半",
    apply(t){ t.wallCooldownScale = 0.5; } },
];

export class LevelUpSystem {
  // v2.18 经验统一：不再维护独立 exp，直接使用 tank.stats.exp 作为唯一经验值
  // （既是升级进度也是商店货币），升级时自动扣除阈值经验并弹出选择面板
  level: number = 1;
  onLevelUp?: (choices: Ability[]) => void;

  // v2.6.2：升级经验增益 ×0.7（升级速度整体减慢约 30%，用户反馈前期升级偏快）
  private readonly EXP_GAIN_SCALE = 0.7;

  // 外部上下文（由模式注入）：基地 / 修复小人 / 该玩家背包 / 该玩家坦克
  private base?: Base;
  private baseRepair?: BaseRepairSystem;
  private inventory?: InventorySystem;
  private tank?: Tank;

  setBaseContext(base: Base, baseRepair: BaseRepairSystem): void {
    this.base = base;
    this.baseRepair = baseRepair;
  }

  setInventory(inv: InventorySystem): void {
    this.inventory = inv;
  }

  /** 注入该玩家坦克：升级生成时按其"当前炮筒"优先给武器增强（权重×2） */
  setTank(tank: Tank): void {
    this.tank = tank;
  }

  /** 当前经验值（统一从 tank.stats.exp 读取） */
  get exp(): number { return this.tank?.stats.exp ?? 0; }

  getExpToNextLevel(): number {
    // v2.15 线性阈值：原指数 28*1.15^(lvl-1) 过陡 → 25 + lvl*10 平滑
    return CFG_LEVEL_UP.AUTO_LEVEL_THRESHOLD_BASE + this.level * CFG_LEVEL_UP.AUTO_LEVEL_THRESHOLD_SLOPE;
  }

  /**
   * v2.18 统一经验：获得经验直接加到 tank.stats.exp，达到阈值自动升级。
   * 升级时扣除阈值经验（消耗了就是消耗了，不再作为货币重复使用），
   * 并触发 onLevelUp 回调弹出三选一属性面板。
   * @returns 是否触发了升级
   */
  addExp(amount: number): boolean {
    if (!this.tank) return false;
    // v2.18 经验值取整：EXP_GAIN_SCALE=0.7 会产生小数，显示时一大串0不美观
    const gained = Math.round(amount * this.EXP_GAIN_SCALE);
    this.tank.stats.exp += gained;
    this.tank.stats.goldCollected += gained;
    // 自动升级：经验满了就升，可能连续升多级
    let leveled = false;
    while (this.tank.stats.exp >= this.getExpToNextLevel()) {
      this.tank.stats.exp -= this.getExpToNextLevel();
      this.level++;
      leveled = true;
    }
    if (leveled) {
      const choices = this.generateChoices();
      this.onLevelUp?.(choices);
    }
    return leveled;
  }

  /** v2.14.2：基地手动购买升级 —— 生成三选一，调用方（BaseShop）apply 并扣经验 */
  generateAndConsumeChoices(): Ability[] {
    const choices = this.generateChoices();
    return choices;
  }

  /**
   * 升级选项生成：三个选项从火力/防御/特殊三个池中抽取，确保多样性。
   * 不再有炮筒专属升级（所有伤害升级作用于全部炮筒）。
   */
  generateChoices(tankOverride?: Tank): Ability[] {
    const t = tankOverride ?? this.tank;
    // 放墙升级只在玩家装备了 spec_wall 模块时才出现
    const hasWallMod = t?.cannons.some(c => c.modules.some(m => m?.config.id === "spec_wall" || m?.config.id === "spec_wall_gold")) ?? false;
    const poolFilter = (a: Ability) => {
      if ((a.id === "wp_wall_2" || a.id === "wp_wall_3" || a.id === "wp_wall_4" || a.id === "wp_wall_speed") && !hasWallMod) return false;
      return true;
    };
    const firePool = ABILITY_POOL.filter(a => a.category === "firepower" && poolFilter(a));
    const defPool = ABILITY_POOL.filter(a => a.category === "defense" && poolFilter(a));
    const specPool = ABILITY_POOL.filter(a => a.category === "special" && poolFilter(a));
    const allPool = ABILITY_POOL.filter(poolFilter);

    const chosen: Ability[] = [];
    const pick = (pool: Ability[]): Ability => {
      const available = pool.filter(a => !chosen.includes(a));
      if (available.length === 0) {
        // fallback: pick from any pool
        const fallback = allPool.filter(a => !chosen.includes(a));
        return fallback.length > 0 ? fallback[Math.floor(Math.random() * fallback.length)] : pool[0];
      }
      return available[Math.floor(Math.random() * available.length)];
    };

    // 第1个选项：60% 火力, 20% 防御, 20% 特殊
    const r1 = Math.random();
    if (r1 < 0.6) chosen.push(pick(firePool));
    else if (r1 < 0.8) chosen.push(pick(defPool));
    else chosen.push(pick(specPool));

    // 第2个选项：确保不重复类别 → 从另外两个类别各50%
    const used1 = chosen[0].category;
    const cat2Options = allPool.filter(a => a.category !== used1);
    const avail2 = cat2Options.filter(a => !chosen.includes(a));
    if (avail2.length > 0) {
      chosen.push(avail2[Math.floor(Math.random() * avail2.length)]);
    } else {
      chosen.push(pick(allPool));
    }

    // 第3个选项：从剩余类别中选
    const usedCats = new Set(chosen.map(a => a.category));
    const cat3Pool = allPool.filter(a => !usedCats.has(a.category) && !chosen.includes(a));
    if (cat3Pool.length > 0) {
      chosen.push(cat3Pool[Math.floor(Math.random() * cat3Pool.length)]);
    } else {
      chosen.push(pick(allPool));
    }

    return chosen;
  }

  applyAbility(ability: Ability, tank: Tank): void {
    ability.apply(tank);

    // ── 需要外部上下文的能力 ──
    switch (ability.id) {
      case "df_respawn":
        tank.respawnTimeScale = Math.min(tank.respawnTimeScale, 0.67); // 3s → 2s
        break;
      case "sp_repair":
        this.baseRepair?.setRepairMultiplier(1.5);
        break;
      case "sp_fortify":
        this.base?.upgradeWalls();
        break;
    }
  }
}
