//  WandSystem.ts ─
// Executes the wand module sequence, spawning projectiles.

import type {
  WandState, ModuleInstance, ModuleConfig, Projectile, WandConfig, TriggerPayload,
} from "./WandTypes";
import { getModule } from "./ModuleRegistry";
import { getSoundManager } from "../../engine/SoundManager";
import { MODIFIER_HANDLES } from "../../framework/NumericConfig";

let nextProjectileId = 1;

// 单发武器（狙击）：子弹命中/消失后，最短等待时间才能再发（v2.3：0.2s）
const SINGLE_SHOT_RELOAD = 0.2;

// 散射·一分N：相邻两发之间的夹角步长（度）。v2.25：10 → 15（1分三 = −15°/0°/+15°，总张角30°）
// N发总张角 = SPLIT_FAN_STEP_DEG × (N-1)，再乘方向修正 focusFactor（0=完全平行）。
// 近距优势：贴脸时N发几乎同点、全中即N倍伤害；远距自然散开，只有中心弹稳定命中。
const SPLIT_FAN_STEP_DEG = MODIFIER_HANDLES.SPLIT_FAN_STEP_DEG;

function makeProjectile(
  ownerId: number, ownerTeam: number,
  x: number, y: number, angle: number,
  base: ModuleConfig,
  damageMultiplier: number,
  speedMultiplier: number,
  sizeMultiplier: number,
  extraBounce: number,
  extraPierce: number,
  castAngleOffset = 0,
  element?: import("./WandTypes").ElementType,
): Projectile {
  const a = angle + castAngleOffset * Math.PI / 180;
  const spd = (base.speed ?? 350) * speedMultiplier;
  // v2.3.4：保留小数伤害（1伤武器吃"伤害+30%"升级可累加），命中时再四舍五入显示
  const maxDmg = base.maxDamage !== undefined ? base.maxDamage : (base.damage ?? 10);
  return {
    id: nextProjectileId++,
    ownerId, ownerTeam,
    x, y,
    vx: Math.cos(a) * spd,
    vy: Math.sin(a) * spd,
    damage: maxDmg * damageMultiplier,
    minDamage: base.minDamage !== undefined ? base.minDamage * damageMultiplier : undefined,
    maxDamage: base.maxDamage !== undefined ? base.maxDamage * damageMultiplier : undefined,
    radius: (base.radius ?? 4) * sizeMultiplier,
    range: base.range ?? 500,
    distanceTraveled: 0,
    pierceLeft: (base.pierceCount ?? 0) + extraPierce,
    bounceLeft: (base.bounceCount ?? 0) + extraBounce,
    aoeRadius: (base.aoeRadius ?? 0) * sizeMultiplier,
    homingStrength: base.homingStrength ?? 0,
    duration: base.duration ?? 0,
    isAlive: true,
    damageMultiplier,
    speedMultiplier,
    sizeMultiplier,
    baseSpeed: spd,           // 记录发射速度，供追踪归一化使用
    color: base.color ?? "#ff0",
    type: base.id,
    element: element ?? base.element,
    orbitRadius: base.orbitRadius ?? 0,
    orbitSpeed: base.orbitSpeed ?? 0,
    orbitAngle: Math.random() * Math.PI * 2,
    recalling: false,
    fuseTime: base.fuseTime,
    armingTime: base.armingTime,
    droneVariant: base.droneVariant,
    droneCount: base.droneCount,
  };
}

export class WandSystem {
  private projectiles: Projectile[] = [];
  private readonly MAX_PROJECTILES = 80;
  mapW = 800;
  mapH = 640;

  createWandState(config: WandConfig): WandState {
    return {
      config,
      modules: Array(config.slots).fill(null),
      cursor: 0,
      castTimer: 0,
      rechargeTimer: 0,
      isRecharging: false,
    };
  }

  equipModule(wand: WandState, slot: number, moduleId: string): boolean {
    if (slot < 0 || slot >= wand.modules.length) return false;
    const cfg = getModule(moduleId);
    if (!cfg) return false;
    wand.modules[slot] = { config: cfg, usesLeft: cfg.maxUses };
    return true;
  }

  removeModule(wand: WandState, slot: number): ModuleInstance | null {
    const m = wand.modules[slot];
    wand.modules[slot] = null;
    return m;
  }

  // Call each frame; fires when ready. Returns newly spawned projectiles.
  update(wand: WandState, dt: number,
         ownerId: number, ownerTeam: number,
         x: number, y: number, angle: number,
         isFiring: boolean, projSpeedScale = 1.0, extraDamageMult = 1,
         hasFreeCast = false, wallLevel = 1): Projectile[] {
    const spawned: Projectile[] = [];

    if (wand.isRecharging) {
      wand.rechargeTimer -= dt;
      if (wand.rechargeTimer <= 0) {
        wand.isRecharging = false;
        wand.cursor = 0;
      }
      return spawned;
    }

    if (!isFiring) {
      wand.castTimer = Math.max(0, wand.castTimer - dt);
      return spawned;
    }

    // ── v2.19 单发限制改为按模块槽位独立结算 ──
    // 不再在顶层检查整根炮筒的在飞弹数，而是在 sweep 中遇到每个投射体模块时，
    // 按 sourceSlotIdx 检查该槽位的在飞弹数（每个模块槽位最多1发在飞）。
    // 这样同一炮筒装2个炮弹模块时，各自独立结算，可交替发射；初始单发炮弹上限严格为1发。
    wand.castTimer -= dt;
    if (wand.castTimer > 0) return spawned;

    // Execute from cursor, collect modifiers until we fire something
    let damageMultiplier = extraDamageMult;
    let speedMultiplier  = 1;
    let sizeMultiplier   = 1;
    let cooldownMult     = 1;
    let extraBounce      = 0;
    let extraPierce      = 0;
    let multicast        = 1;
    let focus            = 1;   // 散射方向修正累积（取最紧，1=不修正/0=平行）
    let homing           = 0;   // 修饰器赋予的追踪强度（取最强）
    let critChanceAdd    = 0;   // v2.26 暴击率加成累积（暴击模块，加法叠加）
    let critDamageAdd    = 0;   // v2.26 暴击伤害加成累积（暴击模块）
    let element: import("./WandTypes").ElementType | undefined;
    let fired = false;

    const modules = wand.config.shuffle
      ? [...wand.modules].sort(() => Math.random() - 0.5)
      : wand.modules;

    // ── Trigger chain state ──
    // lastSpawned: most recent projectile fired this sweep (candidate to carry a trigger)
    // collectingTrigger: a trigger attached to lastSpawned; payload modifiers+projectile accumulate here
    // pendingTrigger: a trigger seen BEFORE any projectile; dropped if no payload follows
    let lastSpawned: Projectile | null = null;
    let collectingTrigger: ModuleConfig | null = null;
    let collectingTriggerSlot = -1;  // v2.19: slot of the trigger module (for per-trigger consumption)
    let pendingTrigger: ModuleConfig | null = null;
    let payloadRef: TriggerPayload | null = null;  // v2.34: 已挂载载荷引用（后续修饰器继续汇入）
    let payloadAttached = false;                    // v2.34: 本回合已挂载载荷（收尾走 castTimer，保持射速）
    let payloadMods = { damageMultiplier:1, speedMultiplier:1, sizeMultiplier:1, extraBounce:0, extraPierce:0, multicast:1, homing:0, element: undefined as import("./WandTypes").ElementType | undefined };

    let firedSomething = false;  // tracks if any projectile was fired this sweep
    let collectedMods = false;   // v2.27: any modifier collected this sweep (enables wrap-continue)
    let wrappedThisSweep = false; // v2.27: only wrap once per sweep (prevents re-collect loops)
    let singleShotBlocked = false;  // v2.19: tracks if any slot was skipped due to singleShot
    let firedFromSlot = -1;  // v2.19: which slot fired the projectile (for sourceSlotIdx)
    let triggerChainPending = false; // v2.27: carrier fired, keep sweeping to bind a following trigger's payload
    let safetyLimit = modules.length + 1;
    while (!fired && safetyLimit-- > 0) {
      if (wand.cursor >= modules.length) {
        if (firedSomething) {
          if (payloadAttached) {
            // v2.34: 本回合挂载了触发载荷 → 按普通发射收尾（castTimer，保持主炮射速，不走进替换弹 1s）
            fired = true;
            break;
          }
          // Completed a full sweep with shots → recharge
          wand.isRecharging = true;
          wand.rechargeTimer = wand.config.rechargeTime;
          break;
        }
        if (collectedMods && !wrappedThisSweep) {
          // v2.27 修复：只收集到修饰器（炮弹在前、修饰器在后）→ 不再丢弃累积，
          // 回卷到槽位0继续本次施法，让修饰器真正作用到炮弹模块上
          // （此前直接 break，导致"追踪/伤害模块放在炮弹后面完全不生效"）
          wrappedThisSweep = true;
          wand.cursor = 0;
          wand.castTimer = 0;
          continue;
        }
        // Only empty/null slots → wrap cursor WITHOUT consuming a full castDelay
        // （否则单模块炮筒 = 发射后空槽回卷还要再等一个 castDelay，射速减半）
        wand.cursor = 0;
        wand.castTimer = 0;
        break;
      }

      const slotIdx = wand.cursor;
      const slot = modules[slotIdx];
      wand.cursor++;

      if (!slot) continue;
      // Depleted finite module: remove it from the wand so it stops blocking
      if (slot.usesLeft === 0) {
        modules[slotIdx] = null;
        continue;
      }

      const cfg = slot.config;

      // ── v2.19/v2.21 按模块槽位独立在飞上限：单发武器每槽位默认最多1发在飞 ──
      // 同一炮筒装2个炮弹模块时，各自独立结算，可交替发射（每个槽位各自1发）。
      // 注意：这里是"拦截条件"——在飞数 >= 上限 才阻止发射（<=上限恒允许），
      // 即每槽位在飞数最多保持"上限"发，不是写反了。
      // 上限默认 1（"只能1发"是武器特性：散弹 count=5 的5颗弹丸同槽位整体算1发）；
      // 高频武器可配置 module.maxInFlight 放宽（机枪 proj_pew = 5，不打断连射）。
      if (wand.config.singleShot && cfg.category === "projectile") {
        const inFlightCap = cfg.maxInFlight ?? 1;
        const flyingForSlot = this.projectiles.filter(p =>
          p.isAlive && p.ownerId === ownerId &&
          p.sourceWandId === wand.config.id &&
          p.sourceSlotIdx === slotIdx).length;
        if (flyingForSlot >= inFlightCap) {
          singleShotBlocked = true;
          continue;  // 跳过此模块，不消耗次数
        }
      }

      // ── Black hole: limit concurrent instances per owner (prevent ground spam) ──
      if (cfg.id === "spec_black_hole" || cfg.id === "spec_black_hole_gold") {
        const activeBH = this.projectiles.filter(pp =>
          pp.isAlive &&
          (pp.type === "spec_black_hole" || pp.type === "spec_black_hole_gold") &&
          pp.ownerId === ownerId).length;
        if (activeBH >= 1) {
          // Blocked: don't consume the module, apply a cooldown before retry
          fired = true;
          wand.castTimer = Math.max(wand.castTimer, 1.0);
          break;
        }
      }

      // Consume a use (sp_freecast: 3% chance to not consume)
      // v2.19: trigger modules do NOT consume on fire — they consume per-trigger event
      if (cfg.category !== "trigger" && slot.usesLeft > 0 && !(hasFreeCast && Math.random() < 0.03)) {
        slot.usesLeft--;
        // Depleted → the module disappears immediately
        if (slot.usesLeft === 0) modules[slotIdx] = null;
      }

      switch (cfg.category) {
        case "modifier":
          if (payloadRef) {
            // v2.34: 载荷已挂载 → 后续修饰器直接汇入载荷（Noita 式链尾增强：[弹,触发,载荷,伤害+] 伤害作用到载荷）
            if (cfg.damageMultiplier)  payloadRef.damageMultiplier *= cfg.damageMultiplier;
            if (cfg.speedMultiplier)   payloadRef.speedMultiplier  *= cfg.speedMultiplier;
            if (cfg.sizeMultiplier)    payloadRef.sizeMultiplier   *= cfg.sizeMultiplier;
            if (cfg.extraBounce)       payloadRef.extraBounce      += cfg.extraBounce;
            if (cfg.extraPierce)       payloadRef.extraPierce      += cfg.extraPierce;
            if (cfg.multicastCount)    payloadRef.multicast         = Math.max(payloadRef.multicast, cfg.multicastCount);
            if (cfg.homingStrength !== undefined) payloadRef.homing = Math.max(payloadRef.homing ?? 0, cfg.homingStrength);
            if (cfg.element)           payloadRef.element           = cfg.element;
          } else if (collectingTrigger) {
            // Modifiers AFTER a trigger become part of the trigger payload
            if (cfg.damageMultiplier)  payloadMods.damageMultiplier *= cfg.damageMultiplier;
            if (cfg.speedMultiplier)   payloadMods.speedMultiplier  *= cfg.speedMultiplier;
            if (cfg.sizeMultiplier)    payloadMods.sizeMultiplier   *= cfg.sizeMultiplier;
            if (cfg.extraBounce)       payloadMods.extraBounce      += cfg.extraBounce;
            if (cfg.extraPierce)       payloadMods.extraPierce      += cfg.extraPierce;
            if (cfg.multicastCount)    payloadMods.multicast         = cfg.multicastCount;
            if (cfg.homingStrength !== undefined) payloadMods.homing = Math.max(payloadMods.homing, cfg.homingStrength);
            if (cfg.element)           payloadMods.element           = cfg.element;
          } else {
            collectedMods = true;  // v2.27: mark for wrap-continue (mods after projectile)
            if (cfg.damageMultiplier)  damageMultiplier *= cfg.damageMultiplier;
            if (cfg.speedMultiplier)   speedMultiplier  *= cfg.speedMultiplier;
            if (cfg.sizeMultiplier)    sizeMultiplier   *= cfg.sizeMultiplier;
            if (cfg.cooldownMultiplier) cooldownMult     *= cfg.cooldownMultiplier;
            if (cfg.extraBounce)       extraBounce      += cfg.extraBounce;
            if (cfg.extraPierce)       extraPierce      += cfg.extraPierce;
            if (cfg.multicastCount)    multicast         = cfg.multicastCount;
            if (cfg.focusFactor !== undefined) focus    = Math.min(focus, cfg.focusFactor);
            if (cfg.homingStrength !== undefined) homing = Math.max(homing, cfg.homingStrength);
            if (cfg.critChanceAdd)     critChanceAdd    += cfg.critChanceAdd;
            if (cfg.critDamageAdd)     critDamageAdd    += cfg.critDamageAdd;
            if (cfg.element)           element           = cfg.element;
          }
          break;

        case "trigger":
          if (lastSpawned) {
            // Attach this trigger to the last projectile fired this sweep and collect its payload
            collectingTrigger = cfg;
            collectingTriggerSlot = slotIdx;  // v2.19: record trigger module's slot
            payloadMods = { damageMultiplier:1, speedMultiplier:1, sizeMultiplier:1, extraBounce:0, extraPierce:0, multicast:1, homing:0, element: undefined as import("./WandTypes").ElementType | undefined };
            payloadRef = null;                // v2.34: 新触发器开始收集 → 后续载荷独立
            pendingTrigger = null;
          } else {
            // Trigger before any projectile this sweep → no carrier, dropped
            pendingTrigger = cfg;
          }
          break;

        case "projectile":
        case "special": {
          // v2.27 触发链中断保护：本回合为绑定触发而继续扫掠，但触发槽被跳过/耗尽时安全收尾
          if (triggerChainPending && !collectingTrigger) {
            fired = true;
            break;
          }
          // ── Payload projectile for an active trigger ──
          if (collectingTrigger && lastSpawned) {
            lastSpawned.triggerPayload = {
              triggerOn: collectingTrigger.triggerOn ?? "hit",
              triggerDelay: collectingTrigger.triggerDelay ?? 0.5,
              projectileId: cfg.id,
              triggerSourceSlot: collectingTriggerSlot,  // v2.19: for per-trigger consumption
              damageMultiplier: payloadMods.damageMultiplier,
              minDamage: cfg.minDamage,
              maxDamage: cfg.maxDamage,
              speedMultiplier: payloadMods.speedMultiplier,
              sizeMultiplier: payloadMods.sizeMultiplier,
              extraBounce: payloadMods.extraBounce,
              extraPierce: payloadMods.extraPierce,
              multicast: Math.max(1, payloadMods.multicast),
              homing: payloadMods.homing,
              element: payloadMods.element,
            };
            payloadRef = lastSpawned.triggerPayload;   // v2.34: 记录引用 → 后续修饰器继续汇入
            payloadAttached = true;
            firedSomething = true;
            collectingTrigger = null;
            collectingTriggerSlot = -1;
            // v2.34: 不再立即结束扫掠 —— 载荷之后的修饰器仍可汇入（更接近 Noita 触发链）
            break;
          }

          // ── Normal projectile cast ──
          // baseCount=武器本体弹数；multicast=散射·一分N 分裂倍数；focus=方向修正收紧比例
          const baseCount = cfg.count ?? 1;
          const count = baseCount * multicast;
          const nativeSpread = cfg.spreadAngle ?? 0;

          // ── Player wall placement (spec_wall): spawn a stationary "wall" marker ──
          if (cfg.id === "spec_wall" || cfg.id === "spec_wall_gold") {
            const proj = makeProjectile(
              ownerId, ownerTeam, x, y, angle,
              cfg, damageMultiplier, speedMultiplier * projSpeedScale, sizeMultiplier,
              extraBounce, extraPierce, 0, element,
            );
            proj.speedMultiplier = 0;   // stays in place at the cast tile
            proj.wallLevel = cfg.id === "spec_wall_gold" ? Math.max(2, wallLevel + 1) : wallLevel;
            proj.wallDirX = Math.cos(angle);
            proj.wallDirY = Math.sin(angle);
            spawned.push(proj);
            lastSpawned = proj;
            fired = true;
            firedSomething = true;
            getSoundManager().play("shoot");
            break;
          }

          // ── v2.15 临时钢墙 (spec_temp_steel_wall): 放置一块30秒后消失的钢墙 ──
          if (cfg.id === "spec_temp_steel_wall") {
            const proj = makeProjectile(
              ownerId, ownerTeam, x, y, angle,
              cfg, damageMultiplier, speedMultiplier * projSpeedScale, sizeMultiplier,
              extraBounce, extraPierce, 0, element,
            );
            proj.speedMultiplier = 0;   // stays in place at the cast tile
            proj.wallLevel = 3;          // 钢墙等级
            proj.wallDirX = Math.cos(angle);
            proj.wallDirY = Math.sin(angle);
            (proj as any).tempWall = true;   // 标记为临时墙
            (proj as any).tempWallOwnerId = ownerId;  // 记录所有者（每人最多1块）
            spawned.push(proj);
            lastSpawned = proj;
            fired = true;
            firedSomething = true;
            getSoundManager().play("shoot");
            break;
          }

          // Clamp total projectiles
          const canSpawn = Math.min(count, this.MAX_PROJECTILES - this.projectiles.length);

          for (let i = 0; i < canSpawn; i++) {
            // 散射扇形夹角（相对准心，左右对称）：
            //  - 单发武器被"一分N"分裂：相邻弹夹角 = SPLIT_FAN_STEP_DEG（v2.25 = 15°），受方向修正 focus 收紧（0=平行向前）
            //    例：1分三 → −15° / 0° / +15°；散弹同时命中时每发独立结算伤害（近距优势）
            //  - 多发武器（霰弹等）：用武器本体散布，方向修正等比收紧
            let angleOffset = 0;
            if (count > 1) {
              const centered = (i / (count - 1) - 0.5);       // -0.5..0.5 对称
              if (nativeSpread > 0) {
                angleOffset = centered * nativeSpread * focus;
              } else {
                const totalFan = SPLIT_FAN_STEP_DEG * (count - 1) * focus;
                angleOffset = centered * totalFan;
              }
            }

            const proj = makeProjectile(
              ownerId, ownerTeam, x, y, angle,
              cfg, damageMultiplier, speedMultiplier * projSpeedScale, sizeMultiplier,
              extraBounce, extraPierce, angleOffset, element,
            );
            // 修饰器赋予的追踪强度（取武器自带与修饰器中的较强者）
            if (homing > (proj.homingStrength ?? 0)) proj.homingStrength = homing;
            // v2.26 模块暴击加成写入投射体（命中时与射手属性相加结算）
            if (critChanceAdd) proj.critChanceBonus = critChanceAdd;
            if (critDamageAdd) proj.critDamageBonus = critDamageAdd;

            spawned.push(proj);
          }
          if (canSpawn > 0) lastSpawned = spawned[spawned.length - 1];
          firedSomething = true;
          firedFromSlot = slotIdx;  // v2.19: record which slot fired (for sourceSlotIdx)
          // v2.27 触发链前瞻（修复：命中触发模块不生效、链式闪电从本体发射电到自己）：
          // 投射体之后的下一个非空槽若是可用触发模块 → 本回合不结束，继续扫掠让 trigger case
          // 把载荷绑定到刚发射的载体上。此前 fired=true 立即 break，触发槽永远访问不到，
          // collectingTrigger 恒为 null，载荷模块只能当普通弹从本体发射。
          if (canSpawn > 0 && this.hasTriggerAfter(modules, slotIdx)) {
            triggerChainPending = true;   // 由后续 trigger/payload 处理或中断保护负责收尾
            fired = false;
          } else {
            fired = true;
          }
          // Play shoot sound based on projectile type
          if (cfg.id === "spec_black_hole" || cfg.id === "spec_black_hole_gold") {
            getSoundManager().play("black_hole");
          } else if (cfg.id === "proj_laser") {
            getSoundManager().play("laser");
          } else {
            getSoundManager().play("shoot");
          }
          break;
        }
      }
    }

    if (fired) {
      wand.castTimer = wand.config.castDelay * cooldownMult;
      // 记录本次冷却倍率：单发炮筒"命中销毁后再发"的间隙同样按此缩短（否则冷却模块对单发几乎无效）
      wand.lastCooldownMult = cooldownMult;
      // Tag each projectile with source wand + slot (needed by per-module single-shot tracking)
      for (const p of spawned) {
        p.sourceWandId = wand.config.id;
        p.sourceSlotIdx = firedFromSlot;
      }
      this.projectiles.push(...spawned);
    } else if (singleShotBlocked) {
      // v2.19: all fireable slots were singleShot-blocked → short reload before retry
      // v2.24: 该间隙同样受冷却倍率影响（冷却模块对单发主炮不再是摆设）
      wand.castTimer = Math.max(wand.castTimer, SINGLE_SHOT_RELOAD * (wand.lastCooldownMult ?? 1));
    }

    return spawned;
  }

  getProjectiles(): Projectile[] { return this.projectiles; }

  /** 触发载荷：命中/销毁/计时/弹跳/击杀事件时，在事件位置生成载荷模块的投射体 */
  spawnTriggerPayload(
    x: number, y: number, angle: number,
    payload: TriggerPayload,
    ownerId: number, ownerTeam: number,
  ): void {
    const cfg = getModule(payload.projectileId);
    if (!cfg) return;
    const count = Math.max(1, payload.multicast);
    const spawned: Projectile[] = [];
    for (let i = 0; i < count; i++) {
      // 触发弹向四周随机散射（Noita 风格）
      const a = angle + (Math.random() - 0.5) * Math.PI * 2;
      const proj = makeProjectile(
        ownerId, ownerTeam, x, y, a,
        cfg, payload.damageMultiplier, payload.speedMultiplier, payload.sizeMultiplier,
        payload.extraBounce, payload.extraPierce, 0, payload.element,
      );
      if (payload.homing && payload.homing > (proj.homingStrength ?? 0)) proj.homingStrength = payload.homing;
      spawned.push(proj);
    }
    this.projectiles.push(...spawned);
    getSoundManager().play("shoot");
  }

  /** v2.34 触发链前瞻：from 之后、下一个投射体/特殊槽之前是否存在可用触发器（跨越修饰器） */
  private hasTriggerAfter(modules: (ModuleInstance | null)[], from: number): boolean {
    for (let j = from + 1; j < modules.length; j++) {
      const m = modules[j];
      if (!m || m.usesLeft === 0) continue;
      const cat = m.config.category;
      if (cat === "modifier") continue;   // v2.34: [弹,伤害+,触发,载荷] 也能绑定（修饰器不打断触发链）
      return cat === "trigger";
    }
    return false;
  }

  /** 无人机/辅助单位发射的简易投射体（参与常规碰撞与伤害结算） */
  spawnAuxProjectile(
    ownerId: number, ownerTeam: number,
    x: number, y: number, angle: number,
    damage: number, speed = 400, radius = 3, range = 320,
    color = "#8f8", aoeRadius = 0, homingStrength = 0,
  ): Projectile | null {
    if (this.projectiles.length >= this.MAX_PROJECTILES) return null;
    const base: ModuleConfig = {
      id: "proj_aux", name: "辅助弹", category: "projectile", quality: "white",
      maxUses: -1, manaCost: 0,
      damage, speed, radius, range, count: 1,
      pierceCount: 0, bounceCount: 0, aoeRadius, color,
      homingStrength,
      desc: "",
    };
    const proj = makeProjectile(
      ownerId, ownerTeam, x, y, angle,
      base, 1, 1, 1, 0, 0, 0,
    );
    this.projectiles.push(proj);
    return proj;
  }

  removeProjectile(id: number): void {
    const idx = this.projectiles.findIndex(p => p.id === id);
    if (idx !== -1) this.projectiles.splice(idx, 1);
  }

  // Update projectile physics and return expired ones
  updateProjectiles(dt: number, nearestEnemy: (p: Projectile) => { x: number; y: number } | null,
                    ownerPositions?: Map<number, {x:number; y:number}>): Projectile[] {
    const dead: Projectile[] = [];
    for (const p of this.projectiles) {
      if (!p.isAlive) { dead.push(p); continue; }

      // 记录本帧移动起点：CombatSystem 用 (prev→cur) 做扫掠式碰撞，防高速穿墙
      p.prevX = p.x;
      p.prevY = p.y;

      // ── Black hole: 减速→锚定→倒计时（v2.26 修复：此前减速后永不消失，
      //    导致"每名玩家仅1个活跃黑洞"的限制永久卡死，后续再也发射不出来）──
      if (p.type === "spec_black_hole" || p.type === "spec_black_hole_gold") {
        if (!p.anchored) {
          // Flight phase: decelerate; anchor once slow enough
          const spd = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
          if (spd > 30) {
            p.vx *= 0.97;
            p.vy *= 0.97;
          } else {
            // Anchor: stop moving, start lifetime countdown (damage/explosion in CombatSystem)
            p.vx = 0; p.vy = 0;
            p.anchored = true;
            p.bhTimer = p.type === "spec_black_hole_gold" ? 8 : 6;
          }
        } else {
          // Anchored: no movement, no range accumulation — fully owned by CombatSystem
          continue;
        }
      }

      // ── Recall (boomerang) ──
      if (p.type === "spec_recall" && !p.recalling) {
        if (p.distanceTraveled >= p.range * 0.6) {
          p.recalling = true;
        }
      }
      if (p.recalling) {
        // Return to owner
        if (ownerPositions) {
          const ownerPos = ownerPositions.get(p.ownerId);
          if (ownerPos) {
            const tx = ownerPos.x - p.x;
            const ty = ownerPos.y - p.y;
            const len = Math.sqrt(tx*tx + ty*ty) || 1;
            const speed = 400 * p.speedMultiplier;
            p.vx = (tx/len) * speed;
            p.vy = (ty/len) * speed;
            // If close enough to owner, die
            if (len < 30) {
              p.isAlive = false;
              dead.push(p);
              continue;
            }
          }
        }
      }

      // Homing — 修正：使用弹道自身的实际速度而非硬编码350
      if (p.homingStrength > 0) {
        const target = nearestEnemy(p);
        if (target) {
          const tx = target.x - p.x;
          const ty = target.y - p.y;
          const len = Math.sqrt(tx*tx + ty*ty) || 1;
          // 渐进转向：homingStrength 控制每秒转向力度（越大越快锁定）
          const steer = p.homingStrength * 800 * dt;
          p.vx += (tx/len) * steer;
          p.vy += (ty/len) * steer;
          // Re-normalize to projectile's OWN speed (not hardcoded 350)
          const spd = Math.sqrt(p.vx*p.vx + p.vy*p.vy);
          // p.baseSpeed stores the original launch speed; fallback to 350
          const targetSpd = (p.baseSpeed ?? 350) * p.speedMultiplier;
          if (spd > 0 && spd !== targetSpd) {
            const scale = targetSpd / spd;
            p.vx *= scale;
            p.vy *= scale;
          }
        }
      }

      // ── 半月环绕（proj_crescent）：绕主人旋转（v2.27 实现轨道；此前无轨道逻辑，
      //    显示为"放在地上一动不动几秒后消失"，与"环绕"名不符）──
      if ((p.orbitRadius ?? 0) > 0) {
        const ownerPos = ownerPositions?.get(p.ownerId);
        if (ownerPos) {
          p.orbitAngle = (p.orbitAngle ?? 0) + ((p.orbitSpeed ?? 180) * Math.PI / 180) * dt;
          p.x = ownerPos.x + Math.cos(p.orbitAngle) * (p.orbitRadius ?? 60);
          p.y = ownerPos.y + Math.sin(p.orbitAngle) * (p.orbitRadius ?? 60);
        }
      }

      // Duration-based projectiles (flame, laser)
      if (p.duration && p.duration > 0) {
        p.duration -= dt;
        if (p.duration <= 0) {
          p.isAlive = false;
          dead.push(p);
          continue;
        }
        // Flame: stay in place after initial spawn
        if (p.type === "proj_flame") {
          // Don't move, just tick down duration
        } else {
          // Laser: still moves
          const dx = p.vx * dt;
          const dy = p.vy * dt;
          p.x += dx;
          p.y += dy;
          p.distanceTraveled += Math.sqrt(dx*dx + dy*dy);
        }
      } else {
        // Normal movement
        const dx = p.vx * dt;
        const dy = p.vy * dt;
        p.x += dx;
        p.y += dy;
        p.distanceTraveled += Math.sqrt(dx*dx + dy*dy);

        if (p.distanceTraveled >= p.range) {
          p.isAlive = false;
          dead.push(p);
        }
      }

      // Kill out-of-map projectiles
      if (p.x < 0 || p.x > this.mapW || p.y < 0 || p.y > this.mapH) {
        p.isAlive = false;
        if (!dead.includes(p)) dead.push(p);
      }
    }
    this.projectiles = this.projectiles.filter(p => p.isAlive);
    return dead;
  }
}
