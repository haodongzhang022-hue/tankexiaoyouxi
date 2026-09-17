//  ModuleRegistry.ts ─
// All built-in module definitions.

import type { ModuleConfig } from "./WandTypes";

export const ALL_MODULES: ModuleConfig[] = [
  //  PROJECTILES 
  {
    id: "proj_bullet", name: "普通子弹", category: "projectile", quality: "white",
    maxUses: 500, manaCost: 3, damage: 3, speed: 280, radius: 4, range: 500,
    count: 1, pierceCount: 0, bounceCount: 0, aoeRadius: 0, color: "#ff0",
    desc: "基础子弹，高频武器（500次）",
  },
  {
    id: "proj_cannon", name: "炮弹", category: "projectile", quality: "white",
    maxUses: 400, manaCost: 2, damage: 5, speed: 330, radius: 4, range: 780,
    count: 1, pierceCount: 0, bounceCount: 0, aoeRadius: 0, color: "#ffe060",
    desc: "初始主炮（经典单发）：400次可用，高频",
  },
  {
    id: "proj_sniper", name: "狙击弹", category: "projectile", quality: "gold",
    maxUses: 200, manaCost: 2, damage: 40, speed: 480, radius: 3, range: 1000,
    count: 1, pierceCount: 1, bounceCount: 0, aoeRadius: 0, color: "#fff07a",
    desc: "掉落获得的真·狙击：弹速极快、伤害高、超远程（200次）",
  },
  {
    id: "proj_pew", name: "机枪弹", category: "projectile", quality: "white",
    maxUses: 500, manaCost: 1, damage: 1, speed: 230, radius: 3, range: 336,
    count: 1, maxInFlight: 5, pierceCount: 0, bounceCount: 0, aoeRadius: 0, color: "#8f8",
    desc: "高频机枪：3.5发/s、每发1伤害（500次可用；单发炮筒下每槽位最多5发在飞）",
  },
  {
    id: "proj_pink", name: "粉弹枪", category: "projectile", quality: "white",
    maxUses: 200, manaCost: 3, damage: 1, speed: 300, radius: 3, range: 340,
    count: 9, pierceCount: 0, bounceCount: 0, aoeRadius: 0, spreadAngle: 40, color: "#f8f",
    desc: "中频武器：9发宽扇形散射（200次）",
  },
  {
    id: "proj_dynamite", name: "引线炸药包", category: "projectile", quality: "blue",
    maxUses: 30, manaCost: 14, damage: 60, speed: 80, radius: 7, range: 220,
    count: 1, pierceCount: 0, bounceCount: 0, aoeRadius: 70, color: "#a35",
    fuseTime: 1.1, duration: 0,
    desc: "珍稀大招：扔出后1.1秒引线燃尽大爆炸（30次）",
  },
  {
    id: "proj_mine", name: "触发式地雷", category: "projectile", quality: "blue",
    maxUses: 30, manaCost: 12, damage: 70, speed: 0, radius: 8, range: 9999,
    count: 1, pierceCount: 0, bounceCount: 0, aoeRadius: 65, color: "#556",
    fuseTime: 0, armingTime: 0.6,
    desc: "珍稀大招：部署在原地，0.6秒后待发；敌人接触才引爆，不被触碰则永久存在（30次）",
  },
  {
    id: "proj_missile", name: "追踪导弹", category: "projectile", quality: "blue",
    maxUses: 80, manaCost: 12, damage: 40, speed: 220, radius: 5, range: 600,
    count: 1, pierceCount: 0, bounceCount: 0, aoeRadius: 60, homingStrength: 0.08,
    color: "#ff7",
    desc: "低频强武器：自动追踪目标，命中爆炸（80次）",
  },
  {
    id: "proj_rocket", name: "火箭弹", category: "projectile", quality: "white",
    maxUses: 150, manaCost: 15, damage: 80, speed: 280, radius: 6, range: 600,
    count: 1, aoeRadius: 48, color: "#f80",
    desc: "中频武器：命中爆炸，范围伤害（150次）",
  },
  {
    id: "proj_gatling", name: "加特林", category: "projectile", quality: "white",
    maxUses: 500, manaCost: 1, damage: 1, speed: 500, radius: 3, range: 380,
    count: 8, spreadAngle: 6, color: "#ff8",
    desc: "高频武器：8连发，高频低伤害（500次）",
  },
  {
    id: "proj_spread", name: "散弹", category: "projectile", quality: "white",
    maxUses: 200, manaCost: 8, damage: 1, speed: 240, radius: 4, range: 280,
    count: 7, spreadAngle: 30, color: "#f44",
    desc: "中频武器：7颗扇形散射，近战强（200次）",
  },
  {
    id: "proj_bounce", name: "弹跳弹", category: "projectile", quality: "white",
    maxUses: 150, manaCost: 6, damage: 20, speed: 360, radius: 4, range: 700,
    count: 1, bounceCount: 3, color: "#0ff",
    desc: "中频武器：最多弹墙3次（150次）",
  },
  {
    id: "proj_seeking", name: "追踪弹", category: "projectile", quality: "blue",
    maxUses: 100, manaCost: 12, damage: 30, speed: 220, radius: 5, range: 550,
    count: 1, homingStrength: 0.06, color: "#f0f",
    desc: "低频武器：自动追踪最近敌人（100次）",
  },
  {
    id: "proj_flame", name: "火焰弹", category: "projectile", quality: "white",
    maxUses: 200, manaCost: 5, damage: 8, speed: 160, radius: 8, range: 200,
    count: 1, aoeRadius: 24, duration: 1.5, element: "fire", color: "#f60",
    desc: "中频武器：持续燃烧AOE伤害（200次）",
  },
  {
    id: "proj_pierce", name: "穿透弹", category: "projectile", quality: "blue",
    maxUses: 120, manaCost: 10, damage: 25, speed: 350, radius: 4, range: 600,
    count: 1, pierceCount: 3, color: "#8ff",
    desc: "低频强武器：穿透最多3个目标（120次）",
  },
  {
    id: "proj_bomb", name: "定时炸弹", category: "projectile", quality: "blue",
    maxUses: 40, manaCost: 25, damage: 120, speed: 150, radius: 8, range: 300,
    count: 1, aoeRadius: 80, fuseTime: 2.0, duration: 0, color: "#888",
    desc: "珍稀大招：2秒后大爆炸（40次）",
  },
  {
    id: "proj_laser", name: "激光束", category: "projectile", quality: "blue",
    maxUses: 60, manaCost: 20, damage: 15, speed: 999, radius: 3, range: 800,
    count: 1, pierceCount: 10, duration: 0.5, color: "#f0f",
    desc: "低频强武器：持续0.5秒的穿透光束（60次）",
  },
  {
    id: "proj_crescent", name: "半月环绕", category: "projectile", quality: "blue",
    maxUses: 100, manaCost: 8, damage: 22, speed: 0, radius: 8, range: 9999,
    count: 1, duration: 6.0, color: "#0f8",
    orbitRadius: 60, orbitSpeed: 200,
    desc: "低频武器：围绕自身旋转6秒的半月斩，接触敌人持续斩击（100次）",
  },

  //  TRIGGERS (v2.19: 每个触发模块150次，按触发次数消耗，不再在开火时消耗)
  {
    id: "trig_on_hit", name: "命中触发", category: "trigger", quality: "white",
    maxUses: 150, manaCost: 0, triggerOn: "hit",
    desc: "子弹命中时触发后续模块（150次）",
  },
  {
    id: "trig_on_destroy", name: "销毁触发", category: "trigger", quality: "white",
    maxUses: 150, manaCost: 0, triggerOn: "destroy",
    desc: "子弹消亡时触发后续模块（150次）",
  },
  {
    id: "trig_timer", name: "定时触发", category: "trigger", quality: "blue",
    maxUses: 150, manaCost: 0, triggerOn: "timer", triggerDelay: 0.5,
    desc: "0.5秒后触发后续模块（150次）",
  },
  {
    id: "trig_delay", name: "延迟触发", category: "trigger", quality: "blue",
    maxUses: 150, manaCost: 0, triggerOn: "timer", triggerDelay: 0.9,
    desc: "0.9秒后触发后续模块（150次）",
  },
  {
    id: "trig_bounce_trigger", name: "弹跳触发", category: "trigger", quality: "blue",
    maxUses: 150, manaCost: 0, triggerOn: "bounce",
    desc: "每次弹跳触发一次后续模块（150次）",
  },
  {
    id: "trig_on_kill", name: "击杀触发", category: "trigger", quality: "blue",
    maxUses: 150, manaCost: 0, triggerOn: "kill",
    desc: "子弹击杀敌人时触发后续模块（150次）",
  },
  {
    id: "trig_on_fire", name: "开火触发", category: "trigger", quality: "blue",
    maxUses: 150, manaCost: 0, triggerOn: "fire",
    desc: "开火瞬间额外发射后续模块载荷（150次）",
  },

  //  MODIFIERS 
  {
    id: "mod_damage_up", name: "伤害+50%", category: "modifier", quality: "white",
    maxUses: 500, manaCost: 2, damageMultiplier: 1.5,
    desc: "高频修饰：对后续投射体伤害1.5（500次）",
  },
  {
    id: "mod_damage_up2", name: "伤害+100%", category: "modifier", quality: "blue",
    maxUses: 500, manaCost: 5, damageMultiplier: 2.0,
    desc: "高频修饰：对后续投射体伤害2（500次）",
  },
  {
    id: "mod_speed_up", name: "飞速+30%", category: "modifier", quality: "white",
    maxUses: 500, manaCost: 2, speedMultiplier: 1.3,
    desc: "高频修饰：后续投射体速度1.3（500次；合成升级可提升幅度）",
  },
  {
    id: "mod_speed_up2", name: "飞速+50%", category: "modifier", quality: "blue",
    maxUses: 500, manaCost: 4, speedMultiplier: 1.5,
    desc: "进阶修饰：后续投射体速度1.5（500次）",
  },
  {
    id: "mod_speed_up_gold", name: "飞速·金+70%", category: "modifier", quality: "gold",
    maxUses: -1, manaCost: 4, speedMultiplier: 1.7,
    desc: "金色特权：后续投射体速度1.7（无限次）",
  },
  {
    id: "mod_size_up", name: "体积2", category: "modifier", quality: "white",
    maxUses: 500, manaCost: 2, sizeMultiplier: 2.0,
    desc: "高频修饰：后续投射体碰撞半径2（500次）",
  },
  {
    id: "mod_bounce_add", name: "+2次弹跳", category: "modifier", quality: "white",
    maxUses: -1, manaCost: 2, extraBounce: 2,
    desc: "永久修饰：后续投射体多弹2次",
  },
  {
    id: "mod_pierce_add", name: "+2穿透", category: "modifier", quality: "white",
    maxUses: -1, manaCost: 3, extraPierce: 2,
    desc: "永久修饰：后续投射体额外穿透2目标",
  },
  // ── 多重施法（旧件，保留以兼容旧存档；不再进入掉落/商店，由下面的"散射·一分N"取代）──
  {
    id: "mod_multicast_x2", name: "2同发", category: "modifier", quality: "blue",
    maxUses: 200, manaCost: 8, multicastCount: 2,
    desc: "【旧件】已被『散射·一分二』取代",
  },
  {
    id: "mod_multicast_x3", name: "3同发", category: "modifier", quality: "blue",
    maxUses: 200, manaCost: 15, multicastCount: 3,
    desc: "【旧件】已被『散射·一分三』取代",
  },
  // ── 散射模块升级线（辅助模块·一分N）─────────────────────────────
  //  基础等级（白/蓝）按次数消耗；合成到高等级（蓝顶/金）后变为无限次数（不消耗）。
  //  机制等价多重施法：把1发炮弹分裂成N发，以准心为中心呈扇形射出（v2.25 相邻弹夹角 15°：
  //  1分三 = −15°/0°/+15°）；贴脸全中 = N倍伤害（每发独立结算），远处自然散开成覆盖面。
  //  "方向修正"收紧扇形；金色版本完全平行（全距离 N 发同线命中）。
  {
    id: "mod_split_2", name: "散射·一分二", category: "modifier", quality: "white",
    maxUses: 200, manaCost: 8, multicastCount: 2, color: "#9fe",
    desc: "辅助模块：1发分裂成2发（±7.5°扇形，贴脸双倍伤害；基础件，200次）",
  },
  {
    id: "mod_split_3", name: "散射·一分三", category: "modifier", quality: "blue",
    maxUses: 150, manaCost: 15, multicastCount: 3, color: "#6cf",
    desc: "辅助模块：1发分裂成3发（±15°扇形，近距三发全中三倍伤害；进阶件，150次）",
  },
  {
    id: "mod_split_4", name: "散射·一分四", category: "modifier", quality: "blue",
    maxUses: -1, manaCost: 20, multicastCount: 4, color: "#4af",
    desc: "辅助模块：1发分裂成4发（相邻15°扇形，高等级，无限次不消耗）",
  },
  {
    id: "mod_split_5", name: "散射·一分五", category: "modifier", quality: "gold",
    maxUses: -1, manaCost: 25, multicastCount: 5, color: "#fd6",
    desc: "辅助模块：1发分裂成5发（相邻15°大扇形，金色顶级，无限次不消耗）",
  },
  // ── 散射方向修正（辅助模块）：收紧一分N扇形；金色版完全平行向前 ──
  {
    id: "mod_aim_focus", name: "方向修正", category: "modifier", quality: "white",
    maxUses: 200, manaCost: 4, focusFactor: 0.4, color: "#bfa",
    desc: "辅助模块：散射扇形收紧到40%，弹着更集中（基础件，200次）",
  },
  {
    id: "mod_aim_focus_gold", name: "精准方向修正", category: "modifier", quality: "gold",
    maxUses: -1, manaCost: 8, focusFactor: 0, color: "#fe8",
    desc: "辅助模块：散射弹完全平行朝准心射出（金色，无限次不消耗）",
  },
  {
    id: "mod_cooldown_reduce", name: "冷却-30%", category: "modifier", quality: "white",
    maxUses: 500, manaCost: 2, cooldownMultiplier: 0.7,
    desc: "高频修饰：炮筒冷却时间0.7（500次）",
  },
  {
    id: "mod_explosion_radius", name: "爆炸范围+50%", category: "modifier", quality: "blue",
    maxUses: -1, manaCost: 5, sizeMultiplier: 1.5,
    desc: "永久修饰：后续爆炸半径1.5",
  },
  {
    id: "mod_homing", name: "轻度追踪", category: "modifier", quality: "white",
    maxUses: 300, manaCost: 4, homingStrength: 0.35,
    desc: "高频修饰：后续投射体自动追踪敌人（300次）",
  },
  {
    id: "mod_homing_med", name: "中度追踪", category: "modifier", quality: "blue",
    maxUses: 400, manaCost: 6, homingStrength: 0.6, color: "#8f8",
    desc: "进阶修饰：后续投射体追踪更灵敏（400次）",
  },
  {
    id: "mod_homing_strong", name: "强力追踪", category: "modifier", quality: "gold",
    maxUses: -1, manaCost: 10, homingStrength: 1.0, color: "#fa6",
    desc: "金色特权：投射体强力锁定最近敌人（无限次）",
  },

  // ── 元素修饰器（v2.3）：给后续投射体附元素，命中地形/敌人触发元素交互 ──
  {
    id: "mod_fire", name: "附火", category: "modifier", quality: "white",
    maxUses: -1, manaCost: 3, element: "fire",
    desc: "后续投射体附火：命中点燃可燃地形、灼烧敌人",
  },
  {
    id: "mod_ice", name: "附冰", category: "modifier", quality: "white",
    maxUses: -1, manaCost: 3, element: "ice",
    desc: "后续投射体附冰：命中减速/冻结、冰弹冻结水面可通行",
  },
  {
    id: "mod_lightning", name: "附电", category: "modifier", quality: "blue",
    maxUses: -1, manaCost: 5, element: "electric",
    desc: "后续投射体附电：命中感电传导、湿地面导电连锁",
  },
  {
    id: "mod_poison", name: "附毒", category: "modifier", quality: "white",
    maxUses: -1, manaCost: 3, element: "poison",
    desc: "后续投射体附毒：命中中毒持续掉血、沼泽扩散毒雾",
  },
  {
    id: "mod_oil", name: "附油", category: "modifier", quality: "blue",
    maxUses: -1, manaCost: 4, element: "oil",
    desc: "后续投射体附油：命中泼洒油渍，油渍遇火变大火",
  },

  // ── 元素投射体（v2.3）：可直接装配的元素弹，掉落/敌人可用 ──
  {
    id: "proj_fireball", name: "火球弹", category: "projectile", quality: "blue",
    maxUses: 200, manaCost: 8, damage: 14, speed: 210, radius: 6, range: 320,
    count: 1, aoeRadius: 34, element: "fire", color: "#f70",
    desc: "中频元素弹：附火爆炸弹（200次）",
  },
  {
    id: "proj_iceshard", name: "冰晶弹", category: "projectile", quality: "blue",
    maxUses: 200, manaCost: 8, damage: 12, speed: 330, radius: 5, range: 420,
    count: 1, pierceCount: 1, element: "ice", color: "#8df",
    desc: "中频元素弹：附冰贯穿弹（200次）",
  },
  {
    id: "proj_arc", name: "电弧弹", category: "projectile", quality: "blue",
    maxUses: 200, manaCost: 10, damage: 18, speed: 500, radius: 4, range: 360,
    count: 1, element: "electric", color: "#fe6",
    desc: "中频元素弹：附电弹（200次）",
  },
  {
    id: "proj_toxic", name: "毒液弹", category: "projectile", quality: "blue",
    maxUses: 200, manaCost: 8, damage: 10, speed: 270, radius: 6, range: 300,
    count: 1, aoeRadius: 30, element: "poison", color: "#8e5",
    desc: "中频元素弹：附毒弹（200次）",
  },
  {
    id: "proj_oilsplat", name: "油渍弹", category: "projectile", quality: "blue",
    maxUses: 200, manaCost: 6, damage: 4, speed: 250, radius: 5, range: 280,
    count: 1, element: "oil", color: "#642",
    desc: "中频元素弹：附油弹（200次）",
  },

  // ── v2.26 暴击模块（统一走"敌人掉落 → 背包 → 炮筒"链路；升级面板绝不发放）──
  //    v2.27 用户反馈：暴击率出现太少 → 数值上调(8%/15%) + 新增金色 25%
  {
    id: "mod_crit_up", name: "暴击率+8%", category: "modifier", quality: "white",
    maxUses: 300, manaCost: 0, critChanceAdd: 0.08, color: "#fd8",
    desc: "命中暴击率+8%（基础0%）",
  },
  {
    id: "mod_crit_up2", name: "暴击率+15%", category: "modifier", quality: "blue",
    maxUses: 400, manaCost: 0, critChanceAdd: 0.15, color: "#fd8",
    desc: "命中暴击率+15%（基础0%）",
  },
  {
    id: "mod_crit_up_gold", name: "暴击率+25%", category: "modifier", quality: "gold",
    maxUses: -1, manaCost: 8, critChanceAdd: 0.25, color: "#ffd700",
    desc: "金色特权：命中暴击率+25%（无限次）",
  },
  {
    id: "mod_critdmg", name: "暴击伤害+50%", category: "modifier", quality: "blue",
    maxUses: 400, manaCost: 0, critDamageAdd: 0.5, color: "#f80",
    desc: "暴击伤害+50%（基础200%）",
  },

  // SPECIAL ─
  {
    id: "spec_black_hole", name: "黑洞弹", category: "special", quality: "blue",
    maxUses: 20, manaCost: 50, damage: 200, speed: 150, radius: 20, range: 400,
    aoeRadius: 120, color: "#308",
    desc: "珍稀大招：吸附周围敌人（约1/8屏）；被吸到中心才受持续伤害，结束后爆炸（20次）",
  },
  {
    id: "spec_wall", name: "放墙", category: "special", quality: "white",
    maxUses: 3, manaCost: 12, damage: 0, speed: 0, radius: 0, range: 0,
    color: "#c80",
    desc: "消耗品：朝前方放置墙体（3次）",
  },
  {
    id: "spec_wall_gold", name: "放墙金", category: "special", quality: "gold",
    maxUses: -1, manaCost: 8, damage: 0, speed: 0, radius: 0, range: 0,
    color: "#fc0",
    desc: "金色特权：玩家墙体放置能力，冷却更短，初始等级更高，无限使用",
  },
  {
    id: "spec_temp_steel_wall", name: "临时钢墙", category: "special", quality: "blue",
    maxUses: 3, manaCost: 20, damage: 0, speed: 0, radius: 0, range: 0,
    color: "#4af",
    desc: "放置一块30秒后消失的钢墙，每人最多同时存在1块",
  },
  {
    id: "spec_chain_lightning", name: "链式闪电", category: "special", quality: "blue",
    maxUses: 70, manaCost: 30, damage: 60, speed: 800, radius: 6, range: 300,
    count: 1, pierceCount: 3, element: "electric", color: "#ff0",
    desc: "从本体发射闪电（0.5秒内自身免伤），在3个目标间跳跃（初始70次）",
  },
  {
    id: "spec_recall", name: "回旋镖", category: "special", quality: "blue",
    maxUses: 100, manaCost: 15, damage: 35, speed: 260, radius: 5, range: 400,
    count: 1, bounceCount: 0, color: "#0f8",
    desc: "低频武器：飞出后折返（100次）",
  },
  {
    id: "spec_detonate_all", name: "引爆全场", category: "special", quality: "blue",
    maxUses: 20, manaCost: 40, damage: 0, speed: 0, radius: 0, range: 0,
    color: "#f00",
    desc: "珍稀大招：引爆场上所有子弹（20次）",
  },
  // ── 无人机部署（蜂群单位，脆弱但可消耗敌方子弹/牵制）──
  {
    id: "spec_drone_swarm", name: "蜂群无人机", category: "special", quality: "white",
    maxUses: -1, manaCost: 15, damage: 0, speed: 0, radius: 0, range: 0,
    droneVariant: "swarm", droneCount: 1, color: "#4c4",
    desc: "永久技能：部署1架蜂群无人机",
  },
  {
    id: "spec_drone_swarm_x3", name: "蜂群x3", category: "special", quality: "blue",
    maxUses: 20, manaCost: 30, damage: 0, speed: 0, radius: 0, range: 0,
    droneVariant: "swarm", droneCount: 3, color: "#4c4",
    desc: "珍稀大招：一次部署3架蜂群无人机（20次）",
  },
  {
    id: "spec_drone_kamikaze", name: "自爆无人机", category: "special", quality: "blue",
    maxUses: 20, manaCost: 20, damage: 0, speed: 0, radius: 0, range: 0,
    droneVariant: "kamikaze", droneCount: 1, color: "#f44",
    desc: "珍稀大招：自爆无人机（20次）",
  },
  {
    id: "spec_drone_patrol", name: "巡逻无人机", category: "special", quality: "white",
    maxUses: -1, manaCost: 12, damage: 0, speed: 0, radius: 0, range: 0,
    droneVariant: "patrol", droneCount: 1, color: "#7cf",
    desc: "永久技能：巡逻无人机",
  },
  {
    id: "spec_drone_interceptor", name: "追踪拦截机", category: "special", quality: "blue",
    maxUses: 15, manaCost: 25, damage: 0, speed: 0, radius: 0, range: 0,
    droneVariant: "interceptor", droneCount: 1, color: "#f7f",
    desc: "珍稀大招：追踪拦截机（15次）",
  },
  // Gold versions
  {
    id: "spec_black_hole_gold", name: "黑洞弹金", category: "special", quality: "gold",
    maxUses: -1, manaCost: 50, damage: 250, speed: 150, radius: 20, range: 400,
    aoeRadius: 140, color: "#fa0",
    desc: "金色特权：无限使用的大范围黑洞弹（吸附+中心伤害+爆炸）",
  },
  {
    id: "proj_bullet_gold", name: "普通子弹金", category: "projectile", quality: "gold",
    maxUses: 300, manaCost: 3, damage: 15, speed: 300, radius: 4, range: 550,
    count: 1, color: "#ffd700",
    desc: "金色强化普通子弹（300次）",
  },
  {
    id: "mod_damage_up_gold", name: "伤害+200%金", category: "modifier", quality: "gold",
    maxUses: 300, manaCost: 5, damageMultiplier: 3.0,
    desc: "金色强化：伤害3（300次）",
  },
];

const moduleMap = new Map<string, ModuleConfig>(ALL_MODULES.map(m => [m.id, m]));

export function getModule(id: string): ModuleConfig | null {
  return moduleMap.get(id) ?? null;
}

export function getModulesByQuality(quality: ModuleConfig["quality"]): ModuleConfig[] {
  return ALL_MODULES.filter(m => m.quality === quality);
}
