//  NumericConfig.ts ─ v1.0（2026-09-12）
//  坦克大战数值控制柄 · 单一事实源
//
//  设计原则：
//  ① 所有影响玩法平衡的数值集中在此，一处改全局生效；
//  ② 按功能域分章节（坦克·敌人·武器·伤害·掉落·商店·升级·刷怪·强化道具·全局常量）；
//  ③ 代码中逐步引用本配置（历史硬编码值保留在对应文件注释，标注迁移目标）；
//  ④ 每个控制柄在文档 game-numeric-config.md 里有对应表格行。

// ─────────────────────────────────────────────────────
//  §1 坦克基础配置（玩家/敌人通用结构，但分 grade 有差异）
// ─────────────────────────────────────────────────────

export const TANK_BASE = {
  /** 默认暴击率（Tank.ts critChance 初始值；v2.26 起初始为 0%，由升级/暴击模块提升） */
  DEFAULT_CRIT_CHANCE: 0.0,
  /** 暴击伤害倍率（初始 200%，由 fp_crit_dmg 升级/暴击模块提升） */
  CRIT_MULTIPLIER: 2.0,
  /** 装甲减伤公式系数：damage * 200 / (armor + 200) */
  ARMOR_FORMULA_DIVISOR: 200,
  /** 最小伤害（永不低于 1） */
  MIN_DAMAGE: 1,
  /** 复活时间（秒，df_respawn 升级减 1s） */
  RESPAWN_TIME: 3,
  /** 出生保护（秒） */
  SPAWN_INVINCIBLE: 10,
  /** 切炮延迟（秒，防频繁切炮重置攻速） */
  SWITCH_DELAY: 0.6,
  /** 单发主炮再发间隔下限（秒） */
  MAIN_GUN_REFIRE: 0.2,
  /** 炮筒预设射速（发/秒）：[主炮(单发), 机枪, 散弹, 默认] */
  WAND_FIRE_RATE: { MAIN: null, MG: 3.5, SPREAD: 1.5, DEFAULT: null } as Record<string, number | null>,
  /** 友伤眩晕：累计命中次数阈值 → 触发眩晕 + 免疫 */
  FRIENDLY_FIRE: { STUN_DURATION: 1.5, IMMUNE_DURATION: 5.0, IMMUNE_THRESHOLD: 5 },
  /** 无敌护盾触发概率（df_invincible 升级） */
  INVINCIBLE_SHIELD_CHANCE: 0.15,
  /** 护盾持续时间（秒） */
  INVINCIBLE_SHIELD_DURATION: 3,
  /** 墙冷却（秒，gold 墙更短） */
  WALL_COOLDOWN: { NORMAL: 1.2, GOLD: 0.8 },
  /** 炮筒槽数（每根炮筒可装模块数） */
  CANNON_SLOTS: 5,
} as const;

// ─────────────────────────────────────────────────────
//  §2 敌人数值表（按 grade 分档）
// ─────────────────────────────────────────────────────

export type EnemyGrade = "F" | "C" | "B" | "A" | "S" | "S2" | "S3" | "S4" | "S5" | "BOSS";

/** v2.27 10 档 HP Tier（Enemy.ts HP_TIERS） — F=5 一击必杀, C=12 两下；质量随隐藏难度分升级 */
export const HP_TIERS = [5, 12, 50, 150, 400, 1000, 3000, 5000, 10000, 15000];

/** 各 grade 基础装甲（Enemy.ts GRADE_ARMOR） */
export const GRADE_ARMOR: Record<EnemyGrade, number> = { F: 0, C: 3, B: 10, A: 20, S: 50, S2: 70, S3: 100, S4: 140, S5: 190, BOSS: 40 };

/** 各 grade HP Tier 索引（与 HP_TIERS 对应） */
export const GRADE_HP_TIER: Record<EnemyGrade, number> = { F: 0, C: 1, B: 2, A: 3, S: 4, S2: 5, S3: 6, S4: 7, S5: 8, BOSS: 9 };

/** 各 grade 敌人速度（px/s） */
export const GRADE_SPEED: Record<EnemyGrade, number> = { F: 40, C: 34, B: 48, A: 40, S: 28, S2: 24, S3: 20, S4: 16, S5: 12, BOSS: 24 };

/** 各 grade castDelay（秒，敌人射击冷却） */
export const GRADE_CAST_DELAY: Record<EnemyGrade, number> = { F: 2.5, C: 2.0, B: 1.5, A: 1.2, S: 0.9, S2: 0.8, S3: 0.7, S4: 0.6, S5: 0.5, BOSS: 0.6 };

/** 各 grade 模块掉率（cfg.moduleDropChance） */
export const GRADE_MODULE_DROP_CHANCE: Record<EnemyGrade, number> = { F: 0.12, C: 0.35, B: 0.60, A: 0.80, S: 1.00, S2: 1.00, S3: 1.00, S4: 1.00, S5: 1.00, BOSS: 1.00 };

/** 各 grade 敌人金币（被玩家击杀后换算为浓缩经验） */
export const GRADE_GOLD_REWARD: Record<EnemyGrade, number> = { F: 8, C: 15, B: 40, A: 80, S: 240, S2: 350, S3: 550, S4: 850, S5: 1200, BOSS: 1500 };

/** 各 grade 敌人经验（可直接升级的经验，addExp 累加） */
export const GRADE_EXP_REWARD: Record<EnemyGrade, number> = { F: 10, C: 25, B: 55, A: 110, S: 250, S2: 400, S3: 700, S4: 1100, S5: 1600, BOSS: 1500 };

/** 各 grade 敌人实体宽度（渲染+碰撞+出生空位校验半宽） */
export const GRADE_WIDTH: Record<EnemyGrade, number> = { F: 24, C: 26, B: 28, A: 30, S: 40, S2: 44, S3: 48, S4: 52, S5: 56, BOSS: 56 };

/** 敌人子弹速度缩放（玩家子弹 * projSpeedScale） */
export const ENEMY_PROJ_SPEED_SCALE = 0.65;

/** 敌人召唤小兵等级/时间 */
export const ENEMY_SUMMON = { INTERVAL_MIN: 6, INTERVAL_MAX: 12, /** S/A 召唤 1 个，BOSS 召唤 2 个 */ } as const;

// ─────────────────────────────────────────────────────
//  §3 掉落系统数值（LootSystem.ts / PowerUpSystem.ts）
// ─────────────────────────────────────────────────────

export const LOOT = {
  /** 掉落物存活时长（秒）v2.18 延长到60s */
  DROP_LIFETIME: 60,
  /** v2.15 浓缩经验换算倍率：goldReward * this → 经验掉落值（原 2.5 → 1.0，砍 60%，匹配用户"掉落太多"诉求） */
  EXP_CONVERT_RATE: 1.0,
  /** BOSS 经验掉落额外 ×3 */
  BOSS_EXP_MULTIPLIER: 3,
  /** v2.18 模块掉率全局倍增倍率：0.8 → 0.2（再减75%，模块变为稀有掉落） */
  MODULE_DROP_MULTIPLIER: 0.2,
  /**
   * v2.20 掉落分包：先按总概率 roll「弹药组（消耗型武器）」，再在组内细分具体武器类型；
   * 「辅助模块组（散射一分N/方向修正/追踪等不消耗或高等级无限的功能件）」总包概率
   * = 弹药组总概率 × 本倍率。辅助件不消耗/可永久使用，故整体更稀有（1/3）。
   */
  AUX_DROP_RATIO: 1 / 3,
  /** v2.15 传统手动道具各 grade 掉率区间（原 ×0.3，砍到约 30%）：道具为稀有品，让商店/升级成为主获取渠道 */
  TRAD_ITEM_DROP_BY_GRADE: {
    F:   [0.003, 0.009],   // 原 0.01-0.03 → 砍 70%
    C:   [0.018, 0.036],   // 原 0.06-0.12 → 砍 70%
    B:   [0.030, 0.054],   // 原 0.10-0.18 → 砍 70%
    A:   [0.045, 0.072],   // 原 0.15-0.24 → 砍 70%
    S:   [0.060, 0.090],   // 原 0.20-0.30 → 砍 70%
    S2:  [0.075, 0.105],   // v2.27 S 系列高阶档：掉率随档位递增
    S3:  [0.090, 0.120],
    S4:  [0.105, 0.135],
    S5:  [0.120, 0.150],
    BOSS:[0.210, 0.270],   // 原 0.70-0.90 → 砍 70%（BOSS 仍必掉一个，不走这概率）
  } as Record<EnemyGrade, [number, number]>,
  /** v2.15 S/A 级敌人额外掉落精华概率（原 0.25 → 0.10，砍 60%） */
  ESSENCE_DROP_CHANCE_ELITE: 0.10,
  /** BOSS 掉落强化材料数量 1~2（保持不变，BOSS 是唯一精华来源） */
  ESSENCE_COUNT_BOSS_MIN: 1,
  ESSENCE_COUNT_BOSS_MAX: 2,
  /** BOSS 必掉金色模块候选列表 */
  BOSS_GOLD_MODULE_POOL: ["spec_black_hole_gold", "proj_bullet_gold", "mod_damage_up_gold"] as string[],
  /** 拾取半径（px） */
  PICKUP_RADIUS: 20,
} as const;

export const POWERUP = {
  /** 敌人掉落强化道具概率（BOSS ~50%，普通 ~7%） */
  ENEMY_DROP_CHANCE: { BOSS: 0.5, NORMAL: 0.07 },
  /** 道具存活时长（秒） */
  LIFETIME: 20,
  /** 各强化道具权重概率（star最常见，bomb最稀有） */
  TYPE_WEIGHTS: { star: 0.25, helmet: 0.15, shield: 0.15, clock: 0.15, shovel: 0.15, bomb: 0.15 } as Record<string, number>,
  /** ★ 火力强化：伤害+30% 持续 12s */
  STAR_DAMAGE_BOOST: 1.3,
  STAR_DURATION: 12,
  /** ▣ 基地护盾：基地大修 + 坦克 flatArmor+30 */
  SHIELD_FLAT_ARMOR: 30,
  /** ◉ 无敌护甲：6s 无敌 */
  HELMET_DURATION: 6,
  /** ◷ 冻结敌人：6s 静止 */
  CLOCK_DURATION: 6,
  /** ⌂ 基地铁壁：基地大修 + flatArmor+15 */
  SHOVEL_FLAT_ARMOR: 15,
  /** ◎ 全屏爆破：对所有敌人造成固定伤害 */
  BOMB_DAMAGE: 60,
} as const;

export const TRADITIONAL_ITEMS = {
  /** item_shield：flatArmor 吸收伤害值（每点吸收1dmg） */
  SHIELD_FLAT_ARMOR: 50,
  /** item_timestop：冻结敌人秒数 */
  TIMESTOP_FREEZE: 3,
  /** item_bomb：爆炸半径（px） */
  BOMB_RADIUS: 420,
  BOMB_DAMAGE: 40,
  /** item_speed_boost：加速倍率（config.speed * 0.5）持续 15s */
  SPEED_BOOST_RATIO: 0.5,
  SPEED_BOOST_DURATION: 15,
  /** item_damage_boost：伤害倍率（1.3）持续 10s */
  DAMAGE_BOOST_MULTIPLIER: 1.3,
  DAMAGE_BOOST_DURATION: 10,
} as const;

// ─────────────────────────────────────────────────────
//  §4 刷怪系统数值（SpawnSystem.ts）
// ─────────────────────────────────────────────────────

export const SPAWN = {
  /** 各档概率权重（v2.25 起仅作文档参考，连续模式改为骰子制） */
  TIER_WEIGHTS: { F: 18, C: 6, B: 2, A: 1, S: 0, S2: 0, S3: 0, S4: 0, S5: 0, BOSS: 0 } as Record<EnemyGrade, number>,
  /** 各档积分成本（v2.30：F=1 C=5 B=15 A=45 S=135 S2=300 S3=700 S4=1600 S5=3500，质量随隐藏分消耗自然转化） */
  TIER_COST: { F: 1, C: 5, B: 15, A: 45, S: 400, S2: 800, S3: 1600, S4: 3200, S5: 6000, BOSS: 10000 } as Record<EnemyGrade, number>,
  /** 初始预算：开局每 30 秒产出积分 */
  BUDGET_BASE_PER_30S: 10,
  /** 难度时钟 +1.25/秒 → 5min→385, 10min→760, 20min→1510（v2.30 节奏加快，对齐 5min-S / 20min-S3 目标） */
  BUDGET_TIME_GROW_PER_SEC: 1.25,
  /** 每击杀 +0.22（v2.30 上调加速） */
  BUDGET_KILL_GROW: 0.22,
  /** 场上敌人越多，预算增速越慢（pressure 系数） */
  PRESSURE_COEFF: 0.06,
  /** 出怪最小间隔（连续模式） */
  MIN_SPAWN_INTERVAL: 0.35,
  /** 预算不足时重试间隔 */
  LOW_BUDGET_RETRY: 0.2,
  /** 出生预警延迟（秒）：BOSS 3.0s，普通 1.5s */
  WARNING_DELAY: { BOSS: 3.0, NORMAL: 1.5 },
  /** BOSS 唯一 + 45s 冷却（场上不重复，击杀后冷却） */
  BOSS_COOLDOWN: 45,
  /** S 精英解锁阈值（预算 B > 45 有概率出 S） */
  S_ELITE_BUDGET_THRESHOLD: 45,
  /** BOSS 解锁阈值（预算 B > 90 有概率出 BOSS） */
  BOSS_BUDGET_THRESHOLD: 90,
  /** 关卡模式：每波敌人数 = 6 + wave * 2.2 */
  STAGE_WAVE_COUNT_BASE: 6,
  STAGE_WAVE_COUNT_GROWTH: 2.2,
  /** 关卡模式刷怪间隔 = (1.0 - wave * 0.02) * 2 / playerScale，最低 0.4s */
  STAGE_SPAWN_INTERVAL_BASE: 2,
  STAGE_SPAWN_INTERVAL_GROWTH: 0.02,
  STAGE_SPAWN_INTERVAL_MIN: 0.4,
  /** 玩家数缩放（连续模式预算 + 关卡刷怪间隔） */
  PLAYER_COUNT_SCALE: { 1: 1.0, 2: 1.5, 3: 2.0, 4: 2.5 } as Record<number, number>,
  /** 关卡模式：每 5 波固定 BOSS */
  BOSS_EVERY_WAVES: 5,
  /** 关卡模式：S 精英基础随波次解锁概率 */
  STAGE_S_ELITE_GROWTH_PER_WAVE: 0.008,
  STAGE_S_ELITE_MAX: 0.05,
} as const;

// ─────────────────────────────────────────────────────
//  §5 武器/模块控制柄（ModuleRegistry.ts 中各 proj_* 的数值）
//  注：ModuleConfig 完整定义仍在 ModuleRegistry.ts，
//      这里提取"参数化控制柄"方便批量调整平衡
// ─────────────────────────────────────────────────────

/** 武器关键数值索引（可用于遍历批量调整平衡） */
export const PROJECTILE_HANDLES = {
  /** 基础白弹：伤害 3 / 速度 280 / 射程 500 */
  BULLET:       { damage: 3, speed: 280, range: 500, radius: 4, pierce: 0, bounce: 0, aoe: 0 },
  /** 初始主炮：伤害 5 / 速度 330 / 射程 780 */
  CANNON:       { damage: 5, speed: 330, range: 780, radius: 4, pierce: 0, bounce: 0, aoe: 0 },
  /** 狙击弹：伤害 20 / 速度 480 / 射程 1000 / 穿透 1 */
  SNIPER:       { damage: 20, speed: 480, range: 1000, radius: 3, pierce: 1, bounce: 0, aoe: 0 },
  /** 机枪弹：伤害 1 / 速度 230 / 射程 336 */
  PEW:          { damage: 1, speed: 230, range: 336, radius: 3, pierce: 0, bounce: 0, aoe: 0 },
  /** 粉弹：伤害 1 × 9发 / 速度 300 / 射程 340 / 40° 散射 */
  PINK:         { damage: 1, speed: 300, range: 340, radius: 3, count: 9, spreadDeg: 40 },
  /** 散弹：伤害 1 × 7发 / 速度 240 / 射程 280 / 30° 散射 */
  SPREAD:       { damage: 1, speed: 240, range: 280, radius: 4, count: 7, spreadDeg: 30 },
  /** 加特林：伤害 1 × 8发 / 速度 500 / 射程 380 */
  GATLING:      { damage: 1, speed: 500, range: 380, radius: 3, count: 8, spreadDeg: 6 },
  /** 追踪弹：伤害 30 / 速度 220 / 射程 550 / 追踪强度 0.06 */
  SEEKING:      { damage: 30, speed: 220, range: 550, radius: 5, homing: 0.06 },
  /** 火箭弹：伤害 80 / 速度 280 / 射程 600 / AOE 48 */
  ROCKET:       { damage: 80, speed: 280, range: 600, radius: 6, aoe: 48 },
  /** 穿透弹：伤害 25 / 速度 350 / 射程 600 / 穿透 3 */
  PIERCE:       { damage: 25, speed: 350, range: 600, radius: 4, pierce: 3 },
  /** 弹跳弹：伤害 20 / 速度 360 / 射程 700 / 弹跳 3 */
  BOUNCE:       { damage: 20, speed: 360, range: 700, radius: 4, bounce: 3 },
  /** 导弹：伤害 40 / 速度 220 / 射程 600 / AOE 60 / 追踪 0.08 */
  MISSILE:      { damage: 40, speed: 220, range: 600, radius: 5, aoe: 60, homing: 0.08 },
  /** 火焰弹：伤害 8 DOT / 速度 160 / 射程 200 / AOE 24 / 持续 1.5s / 元素=火 */
  FLAME:        { damage: 8, speed: 160, range: 200, radius: 8, aoe: 24, duration: 1.5, element: "fire" },
  /** 炸弹：伤害 120 / 速度 150 / 射程 300 / AOE 80 / 引线 2.0s */
  BOMB:         { damage: 120, speed: 150, range: 300, radius: 8, aoe: 80, fuseTime: 2.0 },
  /** 炸药包：伤害 60 / 速度 80 / 射程 220 / AOE 70 / 引线 1.1s */
  DYNAMITE:     { damage: 60, speed: 80, range: 220, radius: 7, aoe: 70, fuseTime: 1.1 },
  /** 地雷：伤害 70 / AOE 65 / 就位时间 0.6s */
  MINE:         { damage: 70, speed: 0, range: 9999, radius: 8, aoe: 65, armingTime: 0.6 },
  /** 激光：伤害 15 / 持续 0.5s / 穿透 10 */
  LASER:        { damage: 15, speed: 999, range: 800, radius: 3, pierce: 10, duration: 0.5 },
  /** 半月环绕：伤害 22 / 旋转半径 60 / 旋转速度 200°/s / 持续 4s */
  CRESCENT:     { damage: 22, speed: 0, range: 9999, radius: 8, orbitRadius: 60, orbitSpeedDeg: 200, duration: 4 },
  /** 黑洞：伤害 200 / AOE 120 / 吸附半径 120 */
  BLACK_HOLE:   { damage: 200, speed: 150, range: 400, radius: 20, aoe: 120, BH_RADIUS: 120 },
  /** 链式闪电：伤害 60 / 速度 800 / 跳跃 3 目标 / 元素=电 */
  CHAIN_LIGHT:  { damage: 60, speed: 800, range: 300, radius: 6, pierce: 3, element: "electric" },
  /** 回旋镖：伤害 35 / 速度 260 / 射程 400 */
  RECALL:       { damage: 35, speed: 260, range: 400, radius: 5 },
} as const;

/** 元素投射体（蓝色，可直接装配） */
export const ELEMENTAL_PROJECTILES = {
  FIREBALL:     { damage: 14, speed: 210, range: 320, radius: 6, aoe: 34, element: "fire" },
  ICESHARD:     { damage: 12, speed: 330, range: 420, radius: 5, pierce: 1, element: "ice" },
  ARC:          { damage: 18, speed: 500, range: 360, radius: 4, element: "electric" },
  TOXIC:        { damage: 10, speed: 270, range: 300, radius: 6, aoe: 30, element: "poison" },
  OILSPLAT:     { damage: 4, speed: 250, range: 280, radius: 5, element: "oil" },
} as const;

/** 金色武器（掉落/BOSS 专属） */
export const GOLD_PROJECTILES = {
  BULLET_GOLD:    { damage: 15, speed: 300, range: 550, radius: 4 },
  BLACK_HOLE_GOLD:{ damage: 250, speed: 150, range: 400, radius: 20, aoe: 140 },
} as const;

/** 修饰器倍率（可批量调平衡） */
export const MODIFIER_HANDLES = {
  /** mod_damage_up：1.5x */
  DMG_UP_WHITE: 1.5,
  /** mod_damage_up2：2.0x */
  DMG_UP_BLUE: 2.0,
  /** mod_damage_up_gold：3.0x */
  DMG_UP_GOLD: 3.0,
  /** mod_speed_up：1.3x / mod_speed_up2：1.5x / mod_speed_up_gold：1.7x */
  SPEED_UP_WHITE: 1.3,
  /** mod_size_up：2.0x */
  SIZE_UP_WHITE: 2.0,
  /** mod_bounce_add：+2 */
  BOUNCE_ADD: 2,
  /** mod_pierce_add：+2 */
  PIERCE_ADD: 2,
  /** mod_multicast_x2：×2（旧件） */
  MULTICAST_X2: 2,
  /** mod_multicast_x3：×3（旧件） */
  MULTICAST_X3: 3,
  /** 散射·一分N：mod_split_2..5 分裂数（高级无限次） */
  SPLIT_COUNTS: [2, 3, 4, 5] as number[],
  /** v2.25 散射·一分N 相邻两发夹角步长（度）：N发总张角 = 15×(N-1)，1分三 = −15°/0°/+15°。
   *  近距全中爆发（N倍伤害）、远距自然散开——散弹同时命中各自独立结算伤害（无无敌帧）。 */
  SPLIT_FAN_STEP_DEG: 15,
  /** 散射方向修正：基础 focusFactor=0.4，金色精准修正=0（平行） */
  FOCUS_BASIC: 0.4,
  FOCUS_GOLD: 0,
  /** mod_cooldown_reduce：0.7x */
  COOLDOWN_REDUCE: 0.7,
  /** mod_explosion_radius：1.5x */
  EXPLOSION_RADIUS: 1.5,
  /** mod_homing：0.03（轻度追踪） */
  HOMING_MOD: 0.03,
  /** mod_homing_strong：0.085（金色强追踪，无限次） */
  HOMING_STRONG: 0.085,
} as const;

/** 无人机控制柄 */
export const DRONE_HANDLES = {
  /** 蜂群（swarm）：缓慢跟随、单发低伤射击 */
  SWARM:      { fireRate: 1.0, damage: 3, range: 120, speed: 80 },
  /** 自爆（kamikaze）：高速冲向敌人自爆 */
  KAMIKAZE:   { speed: 200, explosionDamage: 80, explosionRadius: 60 },
  /** 巡逻（patrol）：绕基地警戒射击 */
  PATROL:     { orbitRadius: 100, fireRate: 0.7, damage: 5, range: 140 },
  /** 拦截（interceptor）：强追踪+高伤 */
  INTERCEPTOR:{ speed: 160, fireRate: 1.2, damage: 12, range: 180 },
} as const;

// ─────────────────────────────────────────────────────
//  §6 伤害结算（CombatSystem.ts）
// ─────────────────────────────────────────────────────

export const COMBAT = {
  /** 距离衰减：每 10px 采样防高速穿墙，最大 24 采样点 */
  SWEEP_MAX_STEPS: 24,
  SWEEP_SEG_LEN: 10,
  /** 爆炸伤害衰减：falloff * 0.7（中心点取 70% 伤害） */
  EXPLOSION_FALLOFF_BASE: 0.7,
  /** 基地墙爆炸伤害减免系数 */
  BASE_WALL_BOMB_DIVISOR: 6,
  /** 基地鹰爆炸伤害减免系数 */
  BASE_EAGLE_BOMB_DIVISOR: 3,
  /** 激光 DPS = damage * dt * 60（每帧 tick） */
  LASER_DPS_FACTOR: 60,
  /** 火焰 DOT tick 间隔（秒） */
  FLAME_DOT_INTERVAL: 0.3,
  /** 命中玩家坦克时的屏幕震动 */
  HIT_SHAKE: { INTENSITY: 1.5, DURATION: 0.15 },
  HIT_SHAKE_CRIT: { INTENSITY: 3, DURATION: 0.15 },
  /** 爆炸屏幕震动 */
  EXPLOSION_SHAKE: { INTENSITY: 3, DURATION: 0.3 },
  BIG_EXPLOSION_SHAKE: { INTENSITY: 5, DURATION: 0.35 },
  BASE_DESTROY_SHAKE: { INTENSITY: 8, DURATION: 0.5 },
  /** 黑洞吸附半径 & 力度 */
  BLACK_HOLE_RADIUS: 120,
  BLACK_HOLE_FORCE_BASE: 200,
  BLACK_HOLE_OWNER_FORCE_MULT: 0.33,
  /** 链式闪电跳跃速度（px/s） */
  CHAIN_LIGHTNING_JUMP_SPEED: 800,
} as const;

// ─────────────────────────────────────────────────────
//  §7 基地商店（BaseShop.ts）
// ─────────────────────────────────────────────────────

export const SHOP = {
  /** 刷新周期（秒） */
  REFRESH_EVERY: 60,
  /** 每批数量（固定包含 1 个升级服务） */
  STOCK_SIZE: 5,
  /** 折扣档位：1×0.2、1×0.5、3×原价 */
  DISCOUNT_TIERS: [0.2, 0.5, 1, 1],
  /** 最低折扣价（经验，防小数点） */
  MIN_DISCOUNT_PRICE: 5,
  /** 商店面板锚点（距基地中心半径内弹出） */
  TRIGGER_RADIUS: 95,
  /** v2.34 炮筒扩容件（1~4 号炮筒各一件，+1 模块位、限购 1 次）：每件独立出现率（每次刷新） */
  SLOT_ITEM_CHANCE: 0.1,
  /** v2.34 炮筒扩容件：出现后打折概率（折扣随机 1~9 折 = 0.1~0.9） */
  SLOT_ITEM_DISCOUNT_CHANCE: 0.5,
} as const;

/** 商品定价目录（单一事实源） */
export const SHOP_CATALOG_PRICES: Record<string, number> = {
  levelup: 0,                // 动态价
  item_repair_kit: 25,
  item_extra_life: 120,
  item_speed_boost: 45,
  item_damage_boost: 80,
  item_shield: 60,
  item_timestop: 150,
  item_bomb: 200,
  repair_base: 40,
  mod_speed_up: 100,
  mod_damage_up: 90,
  mod_cooldown_reduce: 110,
  mod_split_2: 180,
  mod_split_3: 260,
  mod_split_4: 420,
  mod_split_5: 600,
  mod_aim_focus: 160,
  mod_aim_focus_gold: 480,
  mod_homing: 200,
  mod_homing_strong: 520,
  proj_sniper: 260,
  spec_wall: 180,
  spec_chain_lightning: 420,
  spec_black_hole_gold: 600,
  // v2.34 炮筒/背包扩容（独立 10% 出现率 + 独立 50%/1~9折；买一次当场售罄、下次刷新可再出；上限 16）
  item_cannon_slot_1: 300,
  item_cannon_slot_2: 300,
  item_cannon_slot_3: 300,
  item_cannon_slot_4: 300,
  item_bag_slot: 300,
} as const;

// ─────────────────────────────────────────────────────
//  §8 升级系统（LevelUpSystem.ts）
// ─────────────────────────────────────────────────────

export const LEVEL_UP = {
  /** 生命升级增量（渐进克制，原 +2/+4 突变 → +1/+2） */
  HP_GAIN_SMALL: 1,
  HP_GAIN_BIG: 2,
  /** 装甲升级增量（平滑，原 +5/+10 → +3/+6） */
  ARMOR_GAIN_SMALL: 3,
  ARMOR_GAIN_BIG: 6,
  /** 弹速永久增幅（每次升级 +20%） */
  PROJ_SPEED_GAIN: 1.2,
  /** 暴击率增幅（每次 +5%） */
  CRIT_GAIN_PER_UP: 0.05,
  /** 炮筒独立伤害增幅（每次 +10%，克制递增） */
  WAND_DMG_GAIN_PER_UP: 1.10,
  /** 装填冷却倍率（×0.85） */
  RELOAD_MULTIPLIER: 0.85,
  /** 充能时间倍率（×0.8） */
  RECHARGE_MULTIPLIER: 0.8,
  /** 复活时间减秒 */
  RESPAWN_REDUCE: 1,
  /** 升级面板三选一：第1项必武器、第2项 60% 概率再给武器、第3项常驻非武器 */
  SECOND_WEAPON_PROB: 0.6,
  /** 当前武器权重 = 其他的 2 倍 */
  ACTIVE_WAND_WEIGHT: 2,
  /** 生成金色改装件归属玩家（ownerId） */
  GOLD_MODULE_OWNERED: true,

  // ── v2.15 商店升级服务定价公式：base + lvl * slope ──
  // 原公式 40 + lvl*20 → 后期过陡（lvl30=640，比商店炸弹还贵3倍）
  // 新公式 40 + lvl*12 → lvl10=160（≈炸弹200）、lvl30=400（≈黑洞600），价格曲线合理平缓
  SHOP_UPGRADE_BASE: 40,
  SHOP_UPGRADE_SLOPE: 12,

  // ── v2.15 等级自动增长经验阈值：线性（原指数 1.15^lvl 过陡）──
  // 原：28 * 1.15^(lvl-1) → lvl20 ≈ 502 才升，玩家体验极差
  // 新：25 + lvl * 10 → lvl20 = 225 即可升，平滑
  AUTO_LEVEL_THRESHOLD_BASE: 25,
  AUTO_LEVEL_THRESHOLD_SLOPE: 10,
} as const;

/** 升级经验阈值（需多少经验才出下一次升级选择） */
export const LEVEL_UP_THRESHOLDS = [40, 120, 240, 400, 600, 850, 1200, 1700, 2300, 3000, 4000, 5200, 6800, 8800, 11500] as number[];

// ─────────────────────────────────────────────────────
//  §9 元素状态（StatusSystem）
// ─────────────────────────────────────────────────────

export const ELEMENT_STATUS = {
  /** 燃烧 DOT：每秒伤害、持续时间 */
  BURN:  { DPS: 4,  DURATION: 3 },
  /** 中毒 DOT：每秒伤害、持续时间 */
  POISON:{ DPS: 2,  DURATION: 5 },
  /** 感电减速：移速倍率、持续时间 */
  ELECTRIC:{ SLOW: 0.7, DURATION: 2 },
  /** 冻结：移速倍率、持续时间（元素冻结，与 item_timestop 区分） */
  FREEZE:{ SLOW: 0, DURATION: 1.5 },
  /** 覆油：移速倍率（打滑） */
  OIL:   { SLOW: 0.5, DURATION: 2 },
  /** 湿润：移速倍率 */
  WET:   { SLOW: 0.85, DURATION: 2 },
} as const;

// ─────────────────────────────────────────────────────
//  §10 地形（Tilemap）
// ─────────────────────────────────────────────────────

export const TERRAIN = {
  /** 砖块 HP（单发炮弹能炸） */
  BRICK_HP: 4,
  /** 厚砖 HP（v2.3 放墙等级 2） */
  THICK_BRICK_HP: 8,
  /** 钢板 HP（放墙等级 3） */
  STEEL_HP: 999,
  /** 基地鹰 HP */
  EAGLE_HP: 10,
  /** 基地墙 HP */
  BASE_WALL_HP: 6,
  /** 冰面摩擦系数（每帧衰减） */
  ICE_FRICTION: 0.92,
  /** 冰面输入推力系数 */
  ICE_PUSH_FORCE: 0.3,
  /** 地形元素残留时效（秒，岩浆/油渍/毒沼消散） */
  PERSISTENT_STATE_EXPIRY: 45,
  /** 基地护墙设计：坦克可穿越但视觉上半透明 */
  BASE_WALL_TANK_PASSABLE: true,
  BASE_WALL_ALPHA: 0.5,
} as const;

// ─────────────────────────────────────────────────────
//  §11 联机/网络（快照/插值）
// ─────────────────────────────────────────────────────

export const NET = {
  /** 快照帧率（Hz） */
  SNAPSHOT_HZ: 30,
  /** 自适应插值延迟（ms） */
  INTERP_DELAY_STABLE: 43,
  INTERP_DELAY_MAX: 200,
  INTERP_CATCHUP_STEP: 75,
  /** RTT 窗口样本数（均值） */
  RTT_WINDOW_SIZE: 12,
  /** 检查点发送间隔（秒，主机迁移用） */
  CHECKPOINT_INTERVAL: 2,
  /** 成员软离场后座位保留（秒） */
  SOFT_LEAVE_SEAT_TTL: 30,
} as const;

// ─────────────────────────────────────────────────────
//  §12 坦克类型配置（玩家可选）
// ─────────────────────────────────────────────────────

export const TANK_TYPES = {
  tank_light:    { name: "轻型",   hp: 10, armor: 0, speed: 80, castDelay: 0.20, color: "#4af" },
  tank_heavy:    { name: "重装",   hp: 10, armor: 0, speed: 60, castDelay: 0.50, color: "#888" },
  tank_sniper:   { name: "狙击",   hp: 10, armor: 0, speed: 80, castDelay: 0.80, color: "#a4f" },
  tank_engineer: { name: "工程师", hp: 10, armor: 0, speed: 60, castDelay: 0.35, color: "#4c4" },
} as const;

// ─────────────────────────────────────────────────────
//  §13 玩家等级/生命上限
// ─────────────────────────────────────────────────────

export const PLAYER = {
  /** 玩家初始生命条数（lives）v2.20：10 → 3（每条命满血复活，继承升级血量上限） */
  INITIAL_LIVES: 3,
  /** 基地半径（像素，基地中心判定） */
  BASE_TRIGGER_RADIUS: 95,
  /** 复活进度条（秒，队友救援） */
  RESCUE_DURATION: 4,
} as const;

// ─────────────────────────────────────────────────────
//  §13.5 基地修复 / 回血（v2.20）
//  - 基地核心（老鹰）即使无人维修也会缓慢自愈；
//  - 玩家靠近基地时，主动维修更快地补基地/墙，同时回玩家自身血量；
//  - 上述所有速率都吃"修复速度"升级倍率（LevelUpSystem sp_repair → setRepairMultiplier）。
// ─────────────────────────────────────────────────────
export const BASE_REPAIR = {
  /** 基地核心被动自愈速率（HP/秒），比主动修墙慢（约1秒3滴） */
  EAGLE_REGEN_RATE: 3,
  /** 玩家靠近时主动维修基地核心/墙的速率（HP/秒），快于被动自愈 */
  ACTIVE_REPAIR_RATE: 6,
  /** 玩家靠近基地时自身回血速率（HP/秒，"修玩家快"） */
  PLAYER_HEAL_RATE: 6,
} as const;

// ─────────────────────────────────────────────────────
//  §14 模块消耗次数分级参考表（v2.15）
//  ModuleRegistry.ts 中各模块 maxUses 按此分级设定
//  设计原则：高频武器次数多、低频强武器次数少、珍稀大招极少
//  -1 = 无限（触发器/永久修饰/放墙/金色特权）
// ─────────────────────────────────────────────────────

export const MODULE_USES_TIER = {
  /** 高频武器：射速极快、单发低伤、持续输出（机枪/加特林）+ 永久修饰器（伤害/射速/冷却） */
  HIGH_FREQ: 500,
  /** 中频武器：射速中等、伤害中等（散弹/火箭/弹速/元素弹） */
  MID_FREQ: 200,
  /** 低频/强武器：单发高伤、慢射速（狙击/穿透/激光） */
  LOW_FREQ: 100,
  /** 珍稀/大招：极强或特殊效果，次数极少（黑洞/全场炸弹/引爆） */
  RARE_ULT: 20,
} as const;
