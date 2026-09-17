//  WandTypes.ts ─
// All module type definitions for the Noita-style wand system.

export type ModuleCategory = "projectile" | "trigger" | "modifier" | "special";
export type ModuleQuality  = "white" | "blue" | "gold";

// 元素类型（v2.3）：投射体可附元素，命中地形/实体时交给 ElementSystem 处理
export type ElementType = "fire" | "ice" | "electric" | "poison" | "oil";

export interface ModuleConfig {
  id: string;
  name: string;
  category: ModuleCategory;
  quality: ModuleQuality;
  maxUses: number;           // -1 = infinite (gold)
  manaCost: number;
  // Projectile specific
  damage?: number;
  // 距离衰减（v2.3.4）：maxDamage=贴脸伤害、minDamage=满射程伤害，随飞行距离线性递减
  // 用于"狙击弹：越近伤害越高"的单发特色
  minDamage?: number;
  maxDamage?: number;
  speed?: number;            // pixels/s
  radius?: number;           // collision radius
  range?: number;            // max travel distance (px)
  count?: number;            // burst count
  spreadAngle?: number;      // degrees, for shotgun spread
  /**
   * v2.21 每模块槽位在飞上限（单发炮筒 singleShot 生效时）：
   * 默认 1 发/槽位（"只能1发"的武器特性，散弹这类一发=多颗弹丸整体算1发）；
   * 高频武器（机枪 proj_pew）可放宽到 5，不打断连射节奏。
   */
  maxInFlight?: number;
  pierceCount?: number;      // targets to pierce through
  bounceCount?: number;      // wall bounces
  aoeRadius?: number;        // explosion radius
  duration?: number;         // seconds (laser, fire, orbiter)
  homingStrength?: number;   // 0-1, how aggressively it tracks
  orbitRadius?: number;      // orbiter: orbit distance from owner (px)
  orbitSpeed?: number;       // orbiter: rotation speed (deg/s)
  // Explosives (dynamite / mine)
  fuseTime?: number;         // dynamite: seconds until fuse detonates (0 = off)
  armingTime?: number;       // mine: seconds before it arms (won't trigger while arming)
  // Drone deployer
  droneVariant?: string;     // "swarm" | "kamikaze" | "patrol" | "interceptor"
  droneCount?: number;       // how many drones this module deploys
  // Modifier specific
  damageMultiplier?: number;
  speedMultiplier?: number;
  sizeMultiplier?: number;
  cooldownMultiplier?: number;
  extraBounce?: number;
  extraPierce?: number;
  multicastCount?: number;   // 散射·一分N：一次开火把1发分裂成N发
  /**
   * 散射方向修正（0~1）：收紧"一分N / 多重施法"产生的扇形夹角。
   * 1=不修正（默认扇形）；0.4=基础·方向修正（收紧到40%）；0=金色·精准修正（完全平行向前）。
   * 只收紧散射分裂产生的扇形，不改变单发武器本体弹道与触发载荷的随机散射。
   */
  focusFactor?: number;
  /**
   * v2.26 暴击模块：给发射的投射体附加暴击率/暴击伤害（命中时与射手属性相加结算）。
   * 与升级属性共用同一结算路径（CombatSystem），但来源分离：升级=属性点、模块=掉落。
   */
  critChanceAdd?: number;   // 暴击率加成（0.05 = +5%）
  critDamageAdd?: number;   // 暴击伤害加成（0.5 = 暴击倍率 +50%）
  // Element (v2.3): modifier 附元素，或 projectile 直接携带
  element?: ElementType;
  // Trigger type
  triggerOn?: "hit" | "destroy" | "timer" | "bounce" | "kill" | "fire";
  triggerDelay?: number;     // seconds (for timer trigger)
  // Visual
  color?: string;
  // Description
  desc: string;
}

export interface WandConfig {
  id: string;
  name: string;
  slots: number;
  castDelay: number;         // seconds between casts
  rechargeTime: number;      // seconds to recharge after full sequence
  shuffle: boolean;          // shuffle module order?
  singleShot?: boolean;      // classic tank: only ONE bullet on screen from this wand (fire blocked until it disappears)
}

// Runtime wand state
export interface WandState {
  config: WandConfig;
  modules: (ModuleInstance | null)[];  // null = empty slot
  cursor: number;
  castTimer: number;
  rechargeTimer: number;
  isRecharging: boolean;
  /** 上次开火时累积的冷却倍率（mod_cooldown_reduce 等）：单发再发间隙同样受它缩短 */
  lastCooldownMult?: number;
}

// Module instance in a wand slot (tracks remaining uses)
export interface ModuleInstance {
  config: ModuleConfig;
  usesLeft: number;   // -1 = infinite
}

// A projectile in flight
export interface Projectile {
  id: number;
  ownerId: number;          // tank id
  ownerTeam: number;        // 0=p1, 1=p2, 2=enemy
  x: number;
  y: number;
  /** 本帧移动起点（扫掠式碰撞用，防高速穿墙） */
  prevX?: number;
  prevY?: number;
  vx: number;
  vy: number;
  damage: number;
  // 距离衰减（v2.3.4）：maxDamage=贴脸、minDamage=满射程，命中时按 distanceTraveled 结算
  minDamage?: number;
  maxDamage?: number;
  radius: number;
  range: number;
  distanceTraveled: number;
  pierceLeft: number;
  bounceLeft: number;
  aoeRadius: number;
  homingStrength: number;
  duration: number;         // for beam/fire/orbiter types
  isAlive: boolean;
  // Stacked modifiers
  damageMultiplier: number;
  speedMultiplier: number;
  sizeMultiplier: number;
  /** 发射时的原始速度（用于追踪修正归一化） */
  baseSpeed?: number;
  // Trigger payload: the module fired when the trigger condition fires
  triggerPayload?: TriggerPayload;
  triggerTimer?: number;    // remaining seconds until timer trigger fires
  // Orbiter (rotating crescent) state
  orbitRadius?: number;
  orbitSpeed?: number;      // deg/s
  orbitAngle?: number;      // current angle around owner (rad)
  // Visual
  color: string;
  type: string;             // module id that created this
  // Element (v2.3): 投射体携带的元素，命中时由 ElementSystem 施加状态
  element?: ElementType;
  // Recall (boomerang) state
  recalling: boolean;       // true when returning to owner

  // Which wand (cannon) fired this projectile — used by single-shot guns
  sourceWandId?: string;
  // Which module slot fired this projectile — used by per-module single-shot tracking (v2.19)
  sourceSlotIdx?: number;

  // Player-placed wall (spec_wall): level 1-4 carried by the "wall projectile"
  wallLevel?: number;
  wallDirX?: number;   // cast direction (unit vector) for placing the wall ahead
  wallDirY?: number;

  // Explosive fuse/mine arming (carried from module config)
  fuseTime?: number;
  armingTime?: number;

  // Drone-deploy projectile: which drone variant to summon
  droneVariant?: string;
  droneCount?: number;

  // v2.26 暴击加成（模块赋予：射出时写入，命中时与射手属性相加）
  critChanceBonus?: number;
  critDamageBonus?: number;

  // v2.26 黑洞状态：减速到阈值后锚定；锚定期间由 CombatSystem 计时结算中心伤害与爆炸
  anchored?: boolean;
  bhTimer?: number;
}

// The module(s) fired when a projectile's trigger condition is met
export interface TriggerPayload {
  triggerOn: "hit" | "destroy" | "timer" | "bounce" | "kill" | "fire";
  triggerDelay: number;      // for timer triggers (seconds)
  projectileId: string;      // payload projectile module id
  // v2.19: which wand slot the trigger module occupies (for per-trigger consumption)
  triggerSourceSlot?: number;
  damageMultiplier: number;
  // v2.3.4：载荷投射体的距离衰减参数（狙击弹触发载荷继承）
  minDamage?: number;
  maxDamage?: number;
  speedMultiplier: number;
  sizeMultiplier: number;
  extraBounce: number;
  extraPierce: number;
  multicast: number;
  homing?: number;          // 载荷修饰器赋予的追踪强度
  element?: ElementType;     // v2.3: payload 也可携带元素
}
