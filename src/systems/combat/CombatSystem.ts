//  CombatSystem.ts ─
import type { Projectile, TriggerPayload } from "../wand/WandTypes";
import type { Tank } from "../../game/Tank";
import type { Base } from "../../game/Base";
import { Tilemap, isBulletPassable, TileType, TILE_SIZE } from "../../game/Tilemap";
import { EventManager } from "../../framework/EventManager";
import { ObjectPool } from "../../framework/ObjectPool";
import { getSoundManager } from "../../engine/SoundManager";
import type { ElementSystem } from "../element/ElementSystem";
// v2.15 共享渲染模块：主机端和成员端都调用 EntityVisual，确保联机版本一致
import { renderProjectiles as renderProjectilesVisual } from "../../ui/EntityVisual";

const events = EventManager.getInstance();

/** v2.3.4：投射体命中伤害结算（含狙击距离衰减：越近伤害越高）
 *  p.damage=贴脸伤害(maxDamage)；minDamage/maxDamage 存在时随 distanceTraveled 线性递减 */
export function projectileHitDamage(p: Projectile, crit: boolean, critMult = 2): number {
  let base = p.damage;
  if (p.maxDamage !== undefined && p.minDamage !== undefined && p.range > 0) {
    const t = Math.min(1, p.distanceTraveled / p.range);
    base = p.maxDamage - (p.maxDamage - p.minDamage) * t;
  }
  if (crit) base *= critMult;
  return Math.max(1, Math.round(base));
}

export interface HitEvent {
  projectile: Projectile;
  targetId: number;
  damage: number;
  isCritical: boolean;
  x: number;
  y: number;
}

/** Floating damage number that appears on hit */
export interface DamageNumber {
  x: number;
  y: number;
  text: string;
  color: string;
  lifetime: number;
  maxLifetime: number;
  vy: number;    // float-up speed (px/s)
  isCrit: boolean;
}

/** Visual particle: sparks / smoke / debris */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: "spark" | "smoke" | "debris";
  gravity: number;   // downward acceleration px/s²
  drag: number;      // velocity damping per second (0-1)
  rot: number;       // current rotation (debris)
  rotV: number;      // rotation speed
  alpha: number;     // base alpha
}

export class CombatSystem {
  private explosionfx: Array<{ x:number; y:number; r:number; maxR:number; t:number; maxT:number }> = [];
  baseDestroyedFx = false;

  /** v2.17 获取活跃爆炸特效（供联机快照同步给远端渲染） */
  getActiveExplosions(): Array<{ x:number; y:number; r:number; maxR:number; t:number; maxT:number }> {
    return this.explosionfx;
  }

  /** Floating damage numbers */
  private damageNumbers: DamageNumber[] = [];

  /** Visual particles (sparks/smoke/debris) */
  private particles: Particle[] = [];

  /** Optional callback so modes can trigger camera shake (intensity, duration) */
  onShake?: (intensity: number, duration: number) => void;

  /** 触发系统：投射体命中/销毁/弹跳/击杀时，把载荷转发给炮筒系统生成（由模式接线） */
  onTriggerFire?: (x: number, y: number, angle: number, payload: TriggerPayload, ownerId: number, ownerTeam: number, sourceWandId?: string) => void;

  /** 无人机部署：投放弹命中时召唤无人机（由模式接线到 DroneSystem） */
  onDroneDeploy?: (x: number, y: number, variant: string, count: number, ownerId: number, ownerTeam: number) => void;

  /** 投射体击中无人机：命中敌方无人机返回 true（由模式接线到 DroneSystem） */
  onDroneHit?: (x: number, y: number, radius: number, byTeam: number) => boolean;

  /** timer 触发的倒计时（projectileId → 剩余秒） */
  private triggerTimers: Map<number, number> = new Map();

  /** 爆炸物引线/地雷计时（projectileId → 剩余秒） */
  private explosiveTimers: Map<number, number> = new Map();

  /** Track which tanks have been hit recently by flame projectiles (DOT cooldown) */
  private flameHitCooldown: Map<number, Map<number, number>> = new Map();

  /** Track chain lightning targets already hit */
  private chainHitTargets: Map<number, Set<number>> = new Map(); // projectileId -> Set<targetId>
  /** v2.26 黑洞中心伤害跳表：projectileId -> 距下一跳剩余秒数 */
  private bhTickTimers: Map<number, number> = new Map();

  /** v2.3 元素系统（由模式注入）：命中实体/地形时触发元素交互 */
  elementSystem?: ElementSystem;

  /** v2.3 电弧特效（感电传导/电流地形触发） */
  private arcs: Array<{ x1: number; y1: number; x2: number; y2: number; t: number; maxT: number; color: string }> = [];

  /** v2.3 粒子对象池：命中/爆炸高频分配复用，减 GC 压力 */
  private particlePool = new ObjectPool<Particle>(
    () => ({ x:0, y:0, vx:0, vy:0, life:0, maxLife:1, size:1, color:"#fff", kind:"spark", gravity:0, drag:0, rot:0, rotV:0, alpha:1 }),
    (p) => { p.life = 0; },
    32,
  );

  constructor() {
    events.on("element:arc", (x1, y1, x2, y2, team) => {
      this.arcs.push({
        x1: x1 as number, y1: y1 as number,
        x2: x2 as number, y2: y2 as number,
        t: 0, maxT: 0.22, color: team === 0 ? "#4af" : "#ffe14a",
      });
    });
    events.on("element:burnfx", (x, y) => {
      this.spawnSparks(x as number, y as number, 3, "#f80", 80, 2, 0.4);
    });
  }

  /** Spawn a floating damage number at a world position */
  spawnDamageNumber(x: number, y: number, damage: number, isCrit: boolean): void {
    this.damageNumbers.push({
      x, y: y - 8,
      text: `${Math.round(damage)}`,
      color: isCrit ? "#ffd700" : "#fff",
      lifetime: 1.0,
      maxLifetime: 1.0,
      vy: isCrit ? 60 : 40,
      isCrit,
    });
  }

  /** Spawn a generic floating text (gold pickup, buff messages, etc.) */
  spawnFloatText(x: number, y: number, text: string, color = "#fff"): void {
    this.damageNumbers.push({
      x, y: y - 8,
      text,
      color,
      lifetime: 1.2,
      maxLifetime: 1.2,
      vy: 45,
      isCrit: false,
    });
  }

  /** Update floating damage numbers (float up + fade) */
  updateDamageNumbers(dt: number): void {
    for (const dn of this.damageNumbers) {
      dn.lifetime -= dt;
      dn.y -= dn.vy * dt;
    }
    this.damageNumbers = this.damageNumbers.filter(dn => dn.lifetime > 0);
  }

  /** v2.17 返回活跃伤害数字（供联机同步给远端渲染） */
  getActiveDamageNumbers(): Array<{ x: number; y: number; value: number; crit: boolean; color: string }> {
    return this.damageNumbers.map((dn) => ({
      x: Math.round(dn.x), y: Math.round(dn.y),
      value: parseInt(dn.text) || 0, crit: dn.isCrit, color: dn.color,
    }));
  }

  /** Render floating damage numbers (world-space, call after camera transform) */
  renderDamageNumbers(ctx: CanvasRenderingContext2D): void {
    for (const dn of this.damageNumbers) {
      const fadeStart = dn.maxLifetime * 0.3;
      const alpha = dn.lifetime > fadeStart ? 1 : Math.max(0, dn.lifetime / fadeStart);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = dn.color;
      ctx.font = dn.isCrit ? "bold 15px monospace" : "12px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Crit: add a subtle shadow/outline
      if (dn.isCrit) {
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.strokeText(dn.text, dn.x, dn.y);
      }
      ctx.fillText(dn.text, dn.x, dn.y);
      ctx.restore();
    }
  }

  // ── Particle helpers ─────────────────────────────────────────────

  /** Burst of small sparks (orange/red) — used on explosions & heavy hits */
  spawnSparks(x: number, y: number, count: number, color = "#f80", speed = 160, size = 2.5, life = 0.5): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = speed * (0.4 + Math.random() * 0.9);
      const p = this.particlePool.acquire();
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd - 40;
      p.life = life * (0.5 + Math.random() * 0.6);
      p.maxLife = life;
      p.size = size * (0.6 + Math.random() * 0.8);
      p.color = color;
      p.kind = "spark";
      p.gravity = 260;
      p.drag = 1.2;
      p.rot = 0; p.rotV = 0;
      p.alpha = 1;
      this.particles.push(p);
    }
  }

  /** Small impact sparks (yellow-white) — used on bullet hits */
  spawnHitSparks(x: number, y: number, count = 5): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 40 + Math.random() * 90;
      const p = this.particlePool.acquire();
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.life = 0.25 + Math.random() * 0.2;
      p.maxLife = 0.4;
      p.size = 1.5 + Math.random() * 1.5;
      p.color = Math.random() < 0.5 ? "#ff0" : "#fff";
      p.kind = "spark";
      p.gravity = 0;
      p.drag = 2.5;
      p.rot = 0; p.rotV = 0;
      p.alpha = 1;
      this.particles.push(p);
    }
  }

  /** Gray smoke puffs that rise and fade — used on explosions */
  spawnSmoke(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 12 + Math.random() * 30;
      const p = this.particlePool.acquire();
      p.x = x + (Math.random() - 0.5) * 8;
      p.y = y + (Math.random() - 0.5) * 8;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd - 30;
      p.life = 0.7 + Math.random() * 0.5;
      p.maxLife = 1.2;
      p.size = 6 + Math.random() * 8;
      p.color = Math.random() < 0.5 ? "#777" : "#555";
      p.kind = "smoke";
      p.gravity = -20;
      p.drag = 0.6;
      p.rot = 0; p.rotV = 0;
      p.alpha = 0.7;
      this.particles.push(p);
    }
  }

  /** Tumbling brick/steel debris — used on big explosions */
  spawnDebris(x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 60 + Math.random() * 140;
      const p = this.particlePool.acquire();
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd - 80;
      p.life = 0.5 + Math.random() * 0.5;
      p.maxLife = 1.0;
      p.size = 3 + Math.random() * 4;
      p.color = Math.random() < 0.5 ? "#a63" : "#888";
      p.kind = "debris";
      p.gravity = 420;
      p.drag = 0.4;
      p.rot = Math.random() * Math.PI * 2;
      p.rotV = (Math.random() - 0.5) * 12;
      p.alpha = 1;
      this.particles.push(p);
    }
  }

  /** One combined explosion burst: flash sparks + smoke + debris */
  spawnExplosionBurst(x: number, y: number, radius: number): void {
    const power = Math.min(1.6, radius / 60);
    this.spawnSparks(x, y, Math.round(10 + 12 * power), "#f80", 180 * power, 3);
    this.spawnSparks(x, y, Math.round(6 + 6 * power), "#ff0", 240 * power, 2);
    this.spawnSmoke(x, y, Math.round(4 + 4 * power));
    this.spawnDebris(x, y, Math.round(3 + 4 * power));
  }

  /** Update particles with gravity + drag, remove dead ones (recycled via pool) */
  private updateParticles(dt: number): void {
    const kept: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) { this.particlePool.release(p); continue; }
      p.vy += p.gravity * dt;
      // Drag: exponential decay toward 0
      const dragFactor = Math.max(0, 1 - p.drag * dt);
      p.vx *= dragFactor;
      p.vy *= dragFactor;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.rotV * dt;
      kept.push(p);
    }
    this.particles = kept;
    // Soft cap to avoid unbounded growth
    if (this.particles.length > 800) {
      const excess = this.particles.splice(0, this.particles.length - 800);
      for (const p of excess) this.particlePool.release(p);
    }
  }

  /** Render particles (world-space, call after camera transform) */
  renderParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      const fade = Math.min(1, p.life / (p.maxLife * 0.35));
      ctx.save();
      ctx.globalAlpha = p.alpha * fade;
      if (p.kind === "smoke") {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.2 - fade * 0.4), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.kind === "debris") {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      } else {
        // spark: short line in velocity direction
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        const len = Math.min(8, Math.hypot(p.vx, p.vy) * 0.03);
        const ang = Math.atan2(p.vy, p.vx);
        ctx.lineTo(p.x + Math.cos(ang) * len, p.y + Math.sin(ang) * len);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Check all projectiles against tanks + tilemap + base
  resolveProjectiles(
    projectiles: Projectile[],
    allTanks: Tank[],
    base: Base,
    tilemap: Tilemap,
    dt: number,
  ): void {
    for (const p of projectiles) {
      if (!p.isAlive) continue;

      // ── v2.3 元素-地形交互：飞行路径上点燃可燃物/冻结水面/导电/毒渍/油渍 ──
      //（水/森林/冰等可穿透地形由这里触发，砖墙等阻挡地形走下方命中逻辑）
      if (this.elementSystem) {
        const gcol = Math.floor(p.x / TILE_SIZE);
        const grow = Math.floor(p.y / TILE_SIZE);
        this.elementSystem.onProjectileToTile(p, gcol, grow, tilemap);
      }

      // ── Timer trigger：计时结束后触发载荷（无需命中）──
      if (p.triggerPayload && p.triggerPayload.triggerOn === "timer") {
        const prev = this.triggerTimers.get(p.id) ?? p.triggerPayload.triggerDelay;
        const next = prev - dt;
        if (next <= 0) {
          this.triggerTimers.delete(p.id);
          this.fireTrigger(p, "timer", p.x, p.y);
        } else {
          this.triggerTimers.set(p.id, next);
        }
      }

      // ── Fire trigger：开火瞬间触发载荷（发射后首帧，无需命中）──
      if (p.triggerPayload && p.triggerPayload.triggerOn === "fire") {
        if (!this.triggerTimers.has(p.id)) {
          this.triggerTimers.set(p.id, 1);
          this.fireTrigger(p, "fire", p.x, p.y);
        }
      }

      // ── 无人机部署：投放弹瞬间在玩家位置召唤无人机 ──
      if (p.type.startsWith("spec_drone")) {
        this.onDroneDeploy?.(p.x, p.y, p.droneVariant ?? "swarm", p.droneCount ?? 1, p.ownerId, p.ownerTeam);
        this.killProjectile(p);
        continue;
      }

      // ── 爆炸物：引线炸药包 / 触发式地雷（引线与待发倒计时）──
      if (p.type === "proj_dynamite" || p.type === "proj_bomb" || p.type === "proj_mine") {
        const isMine = p.type === "proj_mine";
        let t = this.explosiveTimers.get(p.id);
        if (t === undefined) {
          t = isMine ? (p.armingTime ?? 0.6) : (p.fuseTime ?? 2.0);
          this.explosiveTimers.set(p.id, t);
        }
        if (isMine) {
          // 待发阶段：倒计时（此时不会触发）
          if (t > 0) {
            t -= dt;
            this.explosiveTimers.set(p.id, t);
          } else {
            // 已就位：敌人接触才引爆（v2.27：此前 71px 的"路过即爆"半径会让地雷
            // 看起来像自己消失；改为真实接触触发，且同队不触发）
            const contactR = p.radius + 10;
            for (const tank of allTanks) {
              if (!tank.isAlive) continue;
              if (tank.id === p.ownerId) continue;
              if (tank.team === p.ownerTeam) continue;
              const ddx = tank.cx - p.x; const ddy = tank.cy - p.y;
              const rr = contactR + tank.config.width / 2;
              if (ddx*ddx + ddy*ddy < rr*rr) {
                this.spawnExplosion(p.x, p.y, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam, p.ownerId);
                this.killProjectile(p);
                this.explosiveTimers.delete(p.id);
                break;
              }
            }
          }
          continue; // 地雷不参与普通移动/碰撞
        }
        // 引线炸药包：倒计时燃尽引爆；期间仍可被直接命中提前引爆（落入下方常规碰撞）
        t -= dt;
        if (t <= 0) {
          this.spawnExplosion(p.x, p.y, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam, p.ownerId);
          this.killProjectile(p);
          this.explosiveTimers.delete(p.id);
          continue;
        }
        this.explosiveTimers.set(p.id, t);
      }

      // ── 无人机（脆弱蜂群单位）可拦截敌方子弹 ──
      if (p.ownerTeam !== 0 && this.onDroneHit) {
        if (this.onDroneHit(p.x, p.y, p.radius, p.ownerTeam)) {
          getSoundManager().play("hit");
          this.spawnHitSparks(p.x, p.y, 4);
          if (p.pierceLeft <= 0) this.killProjectile(p);
          else p.pierceLeft--;
          continue;
        }
      }

      // ── Player wall placement (spec_wall): place wall one tile ahead of cast ──
      if (p.type === "spec_wall" || p.type === "spec_wall_gold") {
        const wallLevel = p.wallLevel ?? 1;
        const dx = (p.wallDirX ?? 0);
        const dy = (p.wallDirY ?? 0);
        const baseCol = Math.floor(p.x / TILE_SIZE);
        const baseRow = Math.floor(p.y / TILE_SIZE);
        // Choose the tile ahead (dominant axis)
        let col = baseCol, row = baseRow;
        if (Math.abs(dx) > Math.abs(dy)) col = baseCol + (dx > 0 ? 1 : -1);
        else                            row = baseRow + (dy > 0 ? 1 : -1);

        // Don't overwrite base/border tiles; don't place inside another wall
        const cell = tilemap.get(col, row);
        const valid = cell && (cell.type === TileType.Empty || cell.type === TileType.Forest || cell.type === TileType.Ice);
        if (valid && tilemap.getTeamWall(col, row) === null) {
          // Wall level: 1=Brick(4hp), 2=Thick Brick(8hp), 3=Steel(999), 4=Indestructible
          const type = wallLevel >= 3 ? TileType.Steel : TileType.Brick;
          const hp = wallLevel === 2 ? 8 : wallLevel >= 3 ? 999 : 4;
          const indestructible = wallLevel >= 4;
          tilemap.placeTeamWall(col, row, p.ownerTeam, type, hp, indestructible);
          getSoundManager().play("wall_place");
          this.spawnHitSparks(col * TILE_SIZE + 16, row * TILE_SIZE + 16, 6);
        }
        p.isAlive = false;
        continue;
      }

      // ── v2.15 临时钢墙 (spec_temp_steel_wall): 放置一块30秒后消失的钢墙，每人最多1块 ──
      if (p.type === "spec_temp_steel_wall") {
        const dx = (p.wallDirX ?? 0);
        const dy = (p.wallDirY ?? 0);
        const baseCol = Math.floor(p.x / TILE_SIZE);
        const baseRow = Math.floor(p.y / TILE_SIZE);
        // Choose the tile ahead (dominant axis)
        let col = baseCol, row = baseRow;
        if (Math.abs(dx) > Math.abs(dy)) col = baseCol + (dx > 0 ? 1 : -1);
        else                            row = baseRow + (dy > 0 ? 1 : -1);

        // Don't overwrite base/border tiles; don't place inside another wall
        const cell = tilemap.get(col, row);
        const valid = cell && (cell.type === TileType.Empty || cell.type === TileType.Forest || cell.type === TileType.Ice);
        const ownerId = (p as any).tempWallOwnerId ?? -1;
        if (valid && tilemap.getTeamWall(col, row) === null) {
          // placeTempWall 内部会自动移除该所有者的旧临时墙（每人最多1块）
          tilemap.placeTempWall(col, row, p.ownerTeam, ownerId);
          getSoundManager().play("wall_place");
          this.spawnHitSparks(col * TILE_SIZE + 16, row * TILE_SIZE + 16, 8);
          this.spawnFloatText(col * TILE_SIZE + 16, row * TILE_SIZE - 8, "临时钢墙(30s)", "#4af");
        } else if (!valid) {
          this.spawnFloatText(p.x, p.y - 10, "无法放置", "#f66");
        }
        p.isAlive = false;
        continue;
      }

      // ── Black hole: 吸附 + 中心伤害 + 锚定倒计时爆炸（v2.26）──
      if (p.type === "spec_black_hole" || p.type === "spec_black_hole_gold") {
        const BH_RADIUS = 160;      // ≈1/8 屏幕面积的吸附半径（牵引区：被牵引不受伤）
        const BH_CORE_RADIUS = 30;  // 中心区：被吸到中心才承受持续伤害
        for (const tank of allTanks) {
          if (!tank.isAlive) continue;
          // Never attract the owner's own team
          if (tank.team === p.ownerTeam) continue;
          // Enemy black holes pull players at only 1/3 force so they can fight back
          const forceMultiplier = tank.team === 0 ? 0.33 : 1;
          const dx = p.x - tank.x;
          const dy = p.y - tank.y;
          const dist = Math.sqrt(dx*dx + dy*dy);
          if (dist < BH_RADIUS && dist > 1) {
            const force = 200 * (1 - dist / BH_RADIUS) * dt * forceMultiplier;
            // Push enemy TOWARD the black hole (not the owner)
            tank.x += (dx / dist) * force;
            tank.y += (dy / dist) * force;
            // Clamp to map
            const mapW = tilemap.cols * TILE_SIZE;
            const mapH = tilemap.rows * TILE_SIZE;
            const hw = tank.config.width / 2;
            const hh = tank.config.height / 2;
            tank.x = Math.max(hw, Math.min(mapW - hw, tank.x));
            tank.y = Math.max(hh, Math.min(mapH - hh, tank.y));
          }
          // 中心持续伤害：0.5s 一跳（牵引途中不受伤）；玩家伤害为 1/3（可挣扎逃脱）
          if (p.anchored && dist < BH_CORE_RADIUS) {
            const tick = this.bhTickTimers.get(p.id) ?? 0;
            if (tick <= 0) {
              const dmgScale = tank.team === 0 ? 0.33 : 1;
              const coreDmg = Math.max(1, Math.round(p.damage * 0.15 * dmgScale));
              tank.takeDamage(coreDmg, p.ownerTeam, 0, 0, p.ownerId);
              this.trackDamage(p, allTanks, coreDmg);
              this.spawnDamageNumber(tank.x, tank.y, coreDmg, false);
              this.bhTickTimers.set(p.id, 0.5);
            }
          }
        }
        if (p.anchored) {
          // 锚定倒计时（WandSystem 锚定后不再移动；由这里计时并引爆）
          p.bhTimer = (p.bhTimer ?? 6) - dt;
          const tick = this.bhTickTimers.get(p.id);
          if (tick !== undefined && tick > 0) this.bhTickTimers.set(p.id, tick - dt);
          if (p.bhTimer <= 0) {
            this.spawnExplosion(p.x, p.y, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam, p.ownerId);
            this.killProjectile(p);
          }
        }
        // Skip tilemap collision, only resolve on death (explosion handled above)
        continue;
      }

      // ── Chain lightning: bounce between targets ──
      if (p.type === "spec_chain_lightning") {
        // 0.5秒后或发射者死亡 → 消失
        if (!p.isAlive) continue;
        const ownerDead = !allTanks.some(t => t.id === p.ownerId && t.isAlive);
        if (ownerDead) { this.killProjectile(p); continue; }
        let hitSomething = false;
        for (const tank of allTanks) {
          if (!tank.isAlive) continue;
          if (tank.team === p.ownerTeam && tank.team !== 0) continue;
          // 0.5秒自身免伤：发射者在免疫期内不受链式闪电伤害
          if (tank.id === p.ownerId && tank.chainImmuneTimer > 0) continue;
          const dx = tank.cx - p.x;
          const dy = tank.cy - p.y;
          const hitRadius = p.radius + tank.config.width / 2;
          if (dx*dx + dy*dy < hitRadius*hitRadius) {
            // Check if already hit by this chain lightning
            let hitSet = this.chainHitTargets.get(p.id);
            if (!hitSet) { hitSet = new Set(); this.chainHitTargets.set(p.id, hitSet); }
            if (!hitSet.has(tank.id)) {
              hitSet.add(tank.id);
              hitSomething = true;
              tank.takeDamage(p.damage, p.ownerTeam, 0, 0, p.ownerId);
              this.trackDamage(p, allTanks, p.damage);
              this.spawnDamageNumber(tank.x, tank.y, p.damage, false);
              // Chain to nearest other tank
              let nearestDist = 99999;
              let nearestTank: Tank | null = null;
              for (const other of allTanks) {
                if (other === tank || !other.isAlive) continue;
                if (other.team === p.ownerTeam && other.team !== 0) continue;
                if (hitSet.has(other.id)) continue;
                const odx = other.x - p.x;
                const ody = other.y - p.y;
                const od = odx*odx + ody*ody;
                if (od < nearestDist) { nearestDist = od; nearestTank = other; }
              }
              if (nearestTank) {
                // Teleport to nearest target
                const tx = nearestTank.x - p.x;
                const ty = nearestTank.y - p.y;
                const tlen = Math.sqrt(tx*tx + ty*ty) || 1;
                p.vx = (tx/tlen) * 800;
                p.vy = (ty/tlen) * 800;
              } else {
                // 无更多目标 → 消失
                this.killProjectile(p);
              }
            }
          }
        }
        // 超出射程 → 消失（链式闪电总飞行距离不应超过 range）
        if (p.isAlive && hitSomething === false) {
          // 没有命中任何新目标（已击中所有可击中的），消失
          this.killProjectile(p);
        }
        continue;
      }

      // ── Flame projectile: continuous DOT, no tile collision ──
      if (p.type === "proj_flame") {
        for (const tank of allTanks) {
          if (!tank.isAlive) continue;
          if (tank.team === p.ownerTeam && tank.team !== 0) continue;
          const dx = tank.cx - p.x;
          const dy = tank.cy - p.y;
          const hitRadius = p.radius + tank.config.width / 2;
          if (dx*dx + dy*dy < hitRadius*hitRadius) {
            let cdMap = this.flameHitCooldown.get(p.id);
            if (!cdMap) { cdMap = new Map(); this.flameHitCooldown.set(p.id, cdMap); }
            const lastHit = cdMap.get(tank.id) ?? 0;
            if (lastHit <= 0) {
              tank.takeDamage(p.damage, p.ownerTeam, 0, 0, p.ownerId);
              this.trackDamage(p, allTanks, p.damage);
              this.spawnDamageNumber(tank.x, tank.y, p.damage, false);
              cdMap.set(tank.id, 0.3); // 300ms DOT tick
            }
          }
        }
        continue;
      }

      // ── Laser projectile: skip tile collision, continuous damage ──
      if (p.type === "proj_laser") {
        getSoundManager().play("laser");
        for (const tank of allTanks) {
          if (!tank.isAlive) continue;
          if (tank.id === p.ownerId) continue;
          if (tank.team === p.ownerTeam && tank.team !== 0) continue;
          const dx = tank.cx - p.x;
          const dy = tank.cy - p.y;
          const hitRadius = p.radius + tank.config.width / 2;
          if (dx*dx + dy*dy < hitRadius*hitRadius) {
            const dmg = Math.round(p.damage * dt * 60);
            tank.takeDamage(dmg, p.ownerTeam, 0, 0, p.ownerId);
            this.trackDamage(p, allTanks, dmg);
            this.spawnDamageNumber(tank.x, tank.y, dmg, false);
          }
        }
        continue;
      }

      // ── 半月环绕（proj_crescent）：围绕主人旋转，接触敌人反复斩击（不做地形扫掠）──
      if (p.type === "proj_crescent") {
        for (const tank of allTanks) {
          if (!tank.isAlive) continue;
          if (tank.id === p.ownerId) continue;
          if (tank.team === p.ownerTeam) continue;
          const dx = tank.cx - p.x;
          const dy = tank.cy - p.y;
          const hitRadius = p.radius + tank.config.width / 2;
          if (dx*dx + dy*dy < hitRadius*hitRadius) {
            let cdMap = this.flameHitCooldown.get(p.id);
            if (!cdMap) { cdMap = new Map(); this.flameHitCooldown.set(p.id, cdMap); }
            const lastHit = cdMap.get(tank.id) ?? 0;
            if (lastHit <= 0) {
              const owner = allTanks.find(t => t.id === p.ownerId);
              const critChance = Math.min(1, (owner?.critChance ?? 0) + (p.critChanceBonus ?? 0));
              const crit = Math.random() < critChance;
              const critMult = (owner?.critMultiplier ?? 2) + (p.critDamageBonus ?? 0);
              const dmg = projectileHitDamage(p, crit, critMult);
              tank.takeDamage(dmg, p.ownerTeam, 0, 0, p.ownerId);
              this.trackDamage(p, allTanks, dmg);
              this.spawnDamageNumber(tank.x, tank.y, dmg, crit);
              this.spawnHitSparks(tank.x, tank.y, crit ? 8 : 4);
              cdMap.set(tank.id, 0.45); // 斩击间隔
            }
          }
        }
        continue;
      }

      // --- 扫掠式碰撞（prev→cur 每 ≤10px 采样）修复高速子弹/低帧率穿墙 ---
      const fromX = p.prevX ?? p.x;
      const fromY = p.prevY ?? p.y;
      const segLen0 = Math.hypot(p.x - fromX, p.y - fromY);
      const sweepSteps = Math.max(1, Math.min(24, Math.ceil(segLen0 / 10)));
      let deadSwept = false;
      for (let si = 1; si <= sweepSteps && !deadSwept; si++) {
      const sx = fromX + (p.x - fromX) * si / sweepSteps;
      const sy = fromY + (p.y - fromY) * si / sweepSteps;
      const col = Math.floor(sx / TILE_SIZE);
      const row = Math.floor(sy / TILE_SIZE);
      const cell = tilemap.get(col, row);
      if (cell && !isBulletPassable(cell.type, p.pierceLeft > 5)) {
        // v2.17 砖块：命中的象限已碎 → 子弹穿过该洞继续飞行（不停止）
        if (cell.type === TileType.Brick && cell.quadHp) {
          const q = Tilemap.quadrantAt(sx, sy);
          if (cell.quadHp[q] <= 0) continue;
        }
        p.x = sx; p.y = sy; // 回贴到命中面
        getSoundManager().play("wall_hit");
        this.spawnHitSparks(sx, sy, 4);
        this.fireTrigger(p, "hit", sx, sy);
        // v2.17 按命中位置伤害对应象限；子弹伤害即为地形伤害（受阈值限制）
        const tileDmg = Math.max(1, Math.floor(p.damage));
        if (p.bounceLeft > 0) {
          const prevX = p.x - p.vx * dt;
          const prevY = p.y - p.vy * dt;
          const pColPrev = Math.floor(prevX / TILE_SIZE);
          const pRowPrev = Math.floor(prevY / TILE_SIZE);
          if (pColPrev !== col) p.vx = -p.vx;
          else p.vy = -p.vy;
          p.bounceLeft--;
          this.fireTrigger(p, "bounce", sx, sy);
          tilemap.damageAt(sx, sy, tileDmg);
        } else {
          tilemap.damageAt(sx, sy, tileDmg);
          p.pierceLeft--;
          if (p.pierceLeft < 0) {
            this.killProjectile(p);
            if (p.aoeRadius > 0) this.spawnExplosion(p.x, p.y, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam, p.ownerId);
            deadSwept = true;
          }
        }
        if (!p.isAlive) deadSwept = true;
        break; // 本帧止步于墙面
      }

      // --- Tank collision（沿弹道采样点判定）---
      for (const tank of allTanks) {
        if (!tank.isAlive) continue;
        if (tank.id === p.ownerId) continue;
        if (tank.team === p.ownerTeam && tank.team !== 0) continue;

        const dx = tank.cx - sx;
        const dy = tank.cy - sy;
        const hitRadius = p.radius + tank.config.width / 2;
        if (dx*dx + dy*dy < hitRadius*hitRadius) {
          getSoundManager().play("hit");
          // v2.26：暴击率/暴击伤害 = 射手属性 + 模块投射体加成（初始暴击率0%、倍率200%）
          const owner = allTanks.find(t => t.id === p.ownerId);
          const critChance = Math.min(1, (owner?.critChance ?? 0) + (p.critChanceBonus ?? 0));
          const crit = Math.random() < critChance;
          const critMult = (owner?.critMultiplier ?? 2) + (p.critDamageBonus ?? 0);
          const dmg = projectileHitDamage(p, crit, critMult);
          tank.takeDamage(dmg, p.ownerTeam, 0, 0, p.ownerId);
          this.trackDamage(p, allTanks, dmg);
          this.spawnDamageNumber(sx, sy, dmg, crit);
          this.spawnHitSparks(sx, sy, crit ? 10 : 5);
          // Small shake when a player tank is hit
          if (tank.team === 0) this.onShake?.(crit ? 3 : 1.5, 0.15);

          // ── v2.3 元素-实体交互：燃烧/冻结/感电/中毒/覆油 ──
          this.elementSystem?.onProjectileHitEntity(p, tank, allTanks, tilemap);

          const ev: HitEvent = { projectile:p, targetId:tank.id, damage:dmg, isCritical:crit, x:sx, y:sy };
          events.emit("combat:hit", ev);

          this.fireTrigger(p, "hit", sx, sy);
          if (tank.hp <= 0) {
            events.emit("combat:kill", { tank, projectile: p });
            this.fireTrigger(p, "kill", sx, sy);
          }

          p.pierceLeft--;
          if (p.pierceLeft < 0) {
            this.killProjectile(p);
            if (p.aoeRadius > 0) this.spawnExplosion(p.x, p.y, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam, p.ownerId);
            break;
          }
        }
      }

      // ── Base（每个采样点都检查：逐块命中独立小砖，碎砖后子弹可穿透到鹰标）──
      if (!base.isDestroyed) {
        const edx = sx - base.x;
        const edy = sy - base.y;
        if (edx*edx + edy*edy < 18*18) {
          base.eagleHp = Math.max(0, base.eagleHp - Math.ceil(p.damage / 3));
      this.onShake?.(3, 0.25);
      if (base.eagleHp <= 0) {
            base.isDestroyed = true;
            this.triggerBaseExplosion(base.x, base.y);
          }
          events.emit("base:hit", { wall: "eagle", destroyed: base.isDestroyed });
          this.killProjectile(p);
          if (p.aoeRadius > 0) this.spawnExplosion(sx, sy, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam);
          deadSwept = true;
        } else {
          // v2.16 逐块命中独立小砖
          const brick = base.getBrickAtPoint(sx, sy);
          if (brick) {
            const shattered = base.hitBrick(brick, Math.ceil(p.damage / 6));
            this.spawnHitSparks(sx, sy, 3);
            if (shattered) {
              this.spawnDebris(sx, sy, 3);
              events.emit("base:hit", { wall: brick.side, destroyed: false });
            }
            // 无论砖是否碎了，子弹都被挡住（一发只打一块砖）
            this.onShake?.(1, 0.08);
            this.killProjectile(p);
            if (p.aoeRadius > 0) this.spawnExplosion(sx, sy, p.aoeRadius, p.damage, allTanks, base, p.ownerTeam, p.ownerId);
            deadSwept = true;
          }
        }
        if (deadSwept) break;
      }
      } // ← 采样循环闭合
    }
  }

  triggerBaseExplosion(x: number, y: number): void {
    if (this.baseDestroyedFx) return;
    this.baseDestroyedFx = true;
    getSoundManager().play("game_over");
    this.explosionfx.push({ x, y, r: 8, maxR: 64, t: 0, maxT: 0.8 });
    this.explosionfx.push({ x, y, r: 4, maxR: 96, t: 0, maxT: 1.2 });
    this.spawnExplosionBurst(x, y, 96);
    this.onShake?.(8, 0.5);
  }

  spawnExplosionAt(x: number, y: number, r: number): void {
    this.explosionfx.push({ x, y, r: r * 0.3, maxR: r, t: 0, maxT: 0.4 });
    this.spawnExplosionBurst(x, y, r);
    // v2.15 修复屏幕震动bug：此函数用于敌人死亡/无人机/武器特效等视觉爆炸，
    // 都是玩家主动行为（正反馈），不应触发屏幕震动（震动是负反馈，只用于被攻击）
  }

  /** 触发载荷：事件匹配才转发（timer 由上方倒计时触发，其余按命中事件触发） */
  private fireTrigger(p: Projectile, ev: TriggerPayload["triggerOn"], x: number, y: number): void {
    const tp = p.triggerPayload;
    if (!tp || tp.triggerOn !== ev) return;
    const a = Math.atan2(p.vy, p.vx);
    // v2.19: pass sourceWandId so callback can consume the trigger module's uses
    this.onTriggerFire?.(x, y, a, tp, p.ownerId, p.ownerTeam, p.sourceWandId);
  }

  private killProjectile(p: Projectile): void {
    p.isAlive = false;
    this.explosiveTimers.delete(p.id);
    this.triggerTimers.delete(p.id);
    this.bhTickTimers.delete(p.id);
    this.fireTrigger(p, "destroy", p.x, p.y);
  }

  /** Track damage dealt to projectile owner's stats */
  private trackDamage(p: Projectile, allTanks: Tank[], damage: number): void {
    for (const t of allTanks) {
      if (t.id === p.ownerId) {
        t.stats.damageDealt += damage;
        t.stats.hitsLanded++;
        break;
      }
    }
  }

  private spawnExplosion(x: number, y: number, r: number, dmg: number, tanks: Tank[], base: Base, ownerTeam: number, ownerId = -1): void {
    getSoundManager().play("explosion");
    this.explosionfx.push({ x, y, r, maxR: r, t: 0, maxT: 0.3 });
    this.spawnExplosionBurst(x, y, r);
    // v2.15 修复屏幕震动bug：不在爆炸时无条件震动，只有爆炸伤害到玩家方(team=0)或基地时才震动
    // （主动攻击敌人的AOE爆炸不应震动，那是正反馈不是负反馈）
    let playerHit = false;
    for (const tank of tanks) {
      if (!tank.isAlive) continue;
      const dx = tank.cx - x; const dy = tank.cy - y;
      if (dx*dx + dy*dy < r*r) {
        const falloff = 1 - Math.sqrt(dx*dx+dy*dy) / r;
        const dmgDealt = Math.round(dmg * falloff * 0.7);
        tank.takeDamage(dmgDealt, ownerTeam, 0, 0, ownerId);
        this.spawnDamageNumber(tank.x, tank.y, dmgDealt, false);
        // 只有玩家方坦克被爆炸伤害时才震动
        if (tank.team === 0 && dmgDealt > 0) playerHit = true;
      }
    }
    if (playerHit) this.onShake?.(Math.min(8, 3 + r * 0.08), 0.3);
    if (!base.isDestroyed) {
      const dx = base.x - x; const dy = base.y - y;
      const hitR = r + 28;
      if (dx*dx + dy*dy < hitR * hitR) {
        const falloff = 1 - Math.sqrt(dx*dx + dy*dy) / hitR;
        base.eagleHp = Math.max(0, base.eagleHp - Math.ceil(dmg * falloff * 0.4));
      this.onShake?.(2.5, 0.2);
      if (base.eagleHp <= 0) {
          base.isDestroyed = true;
          this.triggerBaseExplosion(base.x, base.y);
        }
      }
      // v2.16 爆炸也伤害范围内的独立小砖
      const brickR = r + 16;
      const nearbyBricks = base.getAliveBricksInRect(x - brickR, y - brickR, brickR * 2, brickR * 2);
      for (const br of nearbyBricks) {
        const bdx = br.x + br.w / 2 - x;
        const bdy = br.y + br.h / 2 - y;
        const bd = Math.sqrt(bdx*bdx + bdy*bdy);
        if (bd < brickR) {
          const bfalloff = 1 - bd / brickR;
          base.hitBrick(br, Math.ceil(dmg * bfalloff * 0.5));
        }
      }
    }
  }

  updateFX(dt: number): void {
    this.explosionfx = this.explosionfx.filter(fx => {
      fx.t += dt;
      return fx.t < fx.maxT;
    });
    // Update damage numbers
    this.updateDamageNumbers(dt);
    // Update particles
    this.updateParticles(dt);
    // Clean up flame cooldown entries
    for (const [pid, cdMap] of this.flameHitCooldown) {
      for (const [tid, timer] of cdMap) {
        const newTimer = timer - dt;
        if (newTimer <= 0) cdMap.delete(tid);
        else cdMap.set(tid, newTimer);
      }
      if (cdMap.size === 0) this.flameHitCooldown.delete(pid);
    }
    // Clean up chain lightning hit targets
    for (const [pid, hitSet] of this.chainHitTargets) {
      // Keep max 2 seconds after projectile is gone
    }
  }

  renderFX(ctx: CanvasRenderingContext2D): void {
    for (const fx of this.explosionfx) {
      const progress = fx.t / fx.maxT;
      const alpha = 1 - progress;
      const r = fx.r * (0.3 + progress * 0.7);
      ctx.save();
      ctx.globalAlpha = alpha;
      const grad = ctx.createRadialGradient(fx.x, fx.y, 0, fx.x, fx.y, r);
      grad.addColorStop(0, "#fff");
      grad.addColorStop(0.3, "#f80");
      grad.addColorStop(1, "rgba(200,0,0,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, r, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
    // Render particles after base explosion flash (world-space)
    this.renderParticles(ctx);
  }

  renderProjectiles(ctx: CanvasRenderingContext2D, projectiles: Projectile[]): void {
    // v2.15 调用共享渲染模块 EntityVisual，确保主机端和成员端渲染完全一致
    renderProjectilesVisual(ctx, {
      projectiles,
      explosiveTimers: this.explosiveTimers,
    }, Date.now());
  }
}