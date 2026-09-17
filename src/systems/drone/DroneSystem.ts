//  DroneSystem.ts ─
// 蜂群无人机系统：部署无人机作为脆弱支援单位（自动索敌、低伤骚扰、可自爆）。
// 后续可通过"无人机芯片"模块增强（识别敌军/更强攻击/追踪索引/巡逻/自爆等变体）。

import { WandSystem } from "../wand/WandSystem";
import type { Enemy } from "../../game/Enemy";
import type { Tank } from "../../game/Tank";

export type DroneVariant = "swarm" | "kamikaze" | "patrol" | "interceptor";

export interface Drone {
  id: number;
  ownerId: number;
  ownerTeam: number;
  variant: DroneVariant;
  x: number;
  y: number;
  hp: number;
  isAlive: boolean;
  attackTimer: number;   // seconds until next shot
  orbitAngle: number;    // ring position around owner
  xp: number;            // previous position (motion tracer)
  yp: number;
  life: number;          // remaining lifetime (9999 = permanent until killed)
}

interface DroneStats { speed: number; damage: number; interval: number; range: number; }

// 无人机基准：非常脆弱（1血），攻击弱于初始机枪，攻速慢
const DRONE_STATS: Record<DroneVariant, DroneStats> = {
  swarm:       { speed: 150, damage: 1, interval: 1.4, range: 280 },
  interceptor: { speed: 170, damage: 3, interval: 1.0, range: 320 },
  patrol:      { speed: 95,  damage: 1, interval: 1.6, range: 200 },
  kamikaze:    { speed: 240, damage: 30, interval: 0,   range: 0 },
};

const DRONE_COLORS: Record<DroneVariant, string> = {
  swarm: "#5f5", interceptor: "#f5f", patrol: "#6cf", kamikaze: "#f55",
};

export class DroneSystem {
  drones: Drone[] = [];
  mapW = 800;
  mapH = 640;
  private nextId = 1;
  private wandSystem: WandSystem;

  // FX callbacks wired by game modes（接入 CombatSystem 的特效/震屏）
  onHit?: (x: number, y: number, dmg: number) => void;
  onExplosion?: (x: number, y: number, r: number) => void;
  onShake?: (intensity: number, duration: number) => void;

  static readonly MAX_PER_OWNER = 6;

  constructor(wandSystem: WandSystem) {
    this.wandSystem = wandSystem;
  }

  countByOwner(ownerId: number): number {
    return this.drones.filter(d => d.isAlive && d.ownerId === ownerId).length;
  }

  spawnDrone(ownerId: number, ownerTeam: number, x: number, y: number,
             variant: DroneVariant | string, count = 1): void {
    const v: DroneVariant = (["swarm", "kamikaze", "patrol", "interceptor"] as const).includes(variant as DroneVariant)
      ? (variant as DroneVariant)
      : "swarm";
    if (this.countByOwner(ownerId) + count > DroneSystem.MAX_PER_OWNER) {
      count = Math.max(0, DroneSystem.MAX_PER_OWNER - this.countByOwner(ownerId));
    }
    for (let i = 0; i < count; i++) {
      this.drones.push({
        id: this.nextId++,
        ownerId, ownerTeam,
        variant: v,
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 18,
        hp: 1, isAlive: true,
        attackTimer: Math.random() * 0.5,
        orbitAngle: Math.random() * Math.PI * 2,
        xp: x, yp: y,
        life: 9999,
      });
    }
  }

  /** 敌方投射体命中无人机：摧毁范围内敌方无人机，返回是否命中 */
  hitAt(x: number, y: number, radius: number, byTeam: number): boolean {
    let hit = false;
    for (const d of this.drones) {
      if (!d.isAlive) continue;
      if (d.ownerTeam === byTeam) continue;
      const dx = x - d.x; const dy = y - d.y;
      if (dx*dx + dy*dy < (radius + 9) * (radius + 9)) {
        d.isAlive = false;
        hit = true;
      }
    }
    return hit;
  }

  update(dt: number, enemies: Enemy[], players: Tank[]): void {
    for (const d of this.drones) {
      if (!d.isAlive) continue;
      d.life -= dt;
      if (d.life <= 0) { d.isAlive = false; continue; }

      const st = DRONE_STATS[d.variant];
      d.attackTimer -= dt;

      // 最近敌对坦克（无人机攻击欲望不高：只打"足够近"的目标）
      let nearest: Enemy | null = null; let bestD = Infinity;
      for (const e of enemies) {
        if (!e.isAlive || e.team === d.ownerTeam) continue;
        const dx = e.x - d.x; const dy = e.y - d.y;
        const dist2 = dx*dx + dy*dy;
        if (dist2 < bestD) { bestD = dist2; nearest = e; }
      }

      // 主人位置（环绕/巡逻锚点）
      let ox = d.x; let oy = d.y;
      for (const p of players) {
        if (p.id === d.ownerId && p.isAlive) { ox = p.x; oy = p.y; break; }
      }

      d.xp = d.x; d.yp = d.y;

      switch (d.variant) {
        case "kamikaze": {
          // 自爆：高速冲向最近敌人，接触即爆炸（伤敌也伤己方）
          if (nearest) {
            const tx = nearest.x - d.x; const ty = nearest.y - d.y;
            const len = Math.hypot(tx, ty) || 1;
            const spd = st.speed * dt;
            d.x += (tx / len) * Math.min(spd, len);
            d.y += (ty / len) * Math.min(spd, len);
            if (len < 26) {
              d.isAlive = false;
              this.explodeAt(d.x, d.y, 46, st.damage, d.ownerTeam, d.ownerId, enemies);
            }
          }
          break;
        }

        case "swarm":
        case "interceptor":
        case "patrol": {
          // 环绕主人转圈（巡逻圈半径更小）
          d.orbitAngle += (d.variant === "patrol" ? 1.2 : 2.2) * dt;
          const ringR = d.variant === "patrol" ? 55 : 46 + (d.id % 3) * 12;
          const tx = ox + Math.cos(d.orbitAngle) * ringR;
          const ty = oy + Math.sin(d.orbitAngle) * ringR;
          const ddx = tx - d.x; const ddy = ty - d.y;
          const len = Math.hypot(ddx, ddy) || 1;
          const spd = st.speed * dt;
          if (len > 2) {
            d.x += (ddx / len) * Math.min(spd, len);
            d.y += (ddy / len) * Math.min(spd, len);
          }

          // 攻击：射程内且冷却到 → 发射弱子弹（拦截机带轻微追踪）
          if (nearest && d.attackTimer <= 0) {
            const dist = Math.sqrt(bestD);
            if (dist < st.range) {
              const ang = Math.atan2(nearest.y - d.y, nearest.x - d.x);
              this.wandSystem.spawnAuxProjectile(
                d.ownerId, d.ownerTeam, d.x, d.y, ang,
                st.damage, 300, 3, st.range + 40,
                DRONE_COLORS[d.variant],
                0, d.variant === "interceptor" ? 0.05 : 0,
              );
              d.attackTimer = st.interval * (0.8 + Math.random() * 0.4);
            }
          }
          break;
        }
      }
    }
    this.drones = this.drones.filter(d => d.isAlive);
  }

  private explodeAt(x: number, y: number, r: number, dmg: number,
                    ownerTeam: number, ownerId: number, enemies: Enemy[]): void {
    this.onExplosion?.(x, y, r);
    // v2.15 修复屏幕震动bug：无人机爆炸是玩家主动攻击敌人（正反馈），不应触发屏幕震动
    // （震动是负反馈，只用于玩家被攻击/基地被攻击）
    for (const e of enemies) {
      if (!e.isAlive || e.team === ownerTeam) continue;
      const dx = e.x - x; const dy = e.y - y;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < r) {
        const falloff = 1 - dist / r;
        const dmgDealt = Math.max(1, Math.round(dmg * falloff * 0.8));
        e.takeDamage(dmgDealt, ownerTeam, 0, 0, ownerId);
        this.onHit?.(e.x, e.y, dmgDealt);
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const d of this.drones) {
      if (!d.isAlive) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      // 机身
      ctx.fillStyle = DRONE_COLORS[d.variant];
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
      // 两片小桨叶（旋转）
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      for (let i = 0; i < 2; i++) {
        const a = d.orbitAngle + (i ? Math.PI : 0);
        ctx.fillRect(Math.cos(a) * 6 - 2.5, Math.sin(a) * 6 - 1, 5, 2);
      }
      // 自爆机：红色警示灯闪烁
      if (d.variant === "kamikaze" && Math.floor(Date.now() / 120) % 2 === 0) {
        ctx.fillStyle = "#f00";
        ctx.beginPath(); ctx.arc(0, 0, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }
}
