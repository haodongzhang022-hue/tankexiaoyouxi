// PowerUpSystem.ts - Classic Battle City power-ups
// star/shield/clock/shovel/helmet/bomb. Spawned from enemies, picked up on touch.
import type { Tank } from "../../game/Tank";
import type { Enemy } from "../../game/Enemy";
import type { Base } from "../../game/Base";
import { getSoundManager } from "../../engine/SoundManager";
// v2.15 共享渲染模块：主机端和成员端都调用 EntityVisual，确保联机版本一致
import { renderPowerUps as renderPowerUpsVisual } from "../../ui/EntityVisual";

export type PowerUpType = "star" | "shield" | "clock" | "shovel" | "helmet" | "bomb";

export interface PowerUp {
  id: number;
  type: PowerUpType;
  x: number;
  y: number;
  lifetime: number;  // seconds before despawn
  maxLifetime: number;
}

let powerUpIdCounter = 0;

// Icon glyph + color for each power-up
export const POWERUP_INFO: Record<PowerUpType, { glyph: string; color: string; name: string }> = {
  star:   { glyph: "★", color: "#ffd700", name: "火力强化" },
  shield: { glyph: "▣", color: "#4af",   name: "基地护盾" },
  clock:  { glyph: "◷", color: "#4f4",   name: "冻结敌人" },
  shovel: { glyph: "⌂", color: "#a66",   name: "基地铁壁" },
  helmet: { glyph: "◉", color: "#ccc",   name: "无敌护甲" },
  bomb:   { glyph: "◎", color: "#f44",   name: "全屏爆破" },
};

function randomPowerUpType(): PowerUpType {
  // Weighted: star most common, bomb rarest
  const roll = Math.random();
  if (roll < 0.25) return "star";
  if (roll < 0.40) return "helmet";
  if (roll < 0.55) return "shield";
  if (roll < 0.70) return "clock";
  if (roll < 0.85) return "shovel";
  return "bomb";
}

export class PowerUpSystem {
  active: PowerUp[] = [];
  mapW: number = 800;
  mapH: number = 640;

  // External references injected by the mode
  players: Tank[] = [];
  getEnemies: () => Enemy[] = () => [];
  base: Base | null = null;

  // 拾取反馈回调（由模式注入：飘字 + 音效）
  onPickup?: (tank: Tank, type: PowerUpType) => void;

  onEnemyKilled(e: Enemy): void {
    // Boss ~50% chance, normal enemy ~7%
    const chance = e.isBoss ? 0.5 : 0.07;
    if (Math.random() > chance) return;
    this.spawnAt(e.x, e.y);
  }

  spawnAt(x: number, y: number): void {
    const pad = 24;
    const sx = Math.max(pad, Math.min(this.mapW - pad, x));
    const sy = Math.max(pad, Math.min(this.mapH - pad, y));
    this.active.push({
      id: powerUpIdCounter++,
      type: randomPowerUpType(),
      x: sx, y: sy,
      lifetime: 20,
      maxLifetime: 20,
    });
  }

  update(dt: number, playerPositions?: Array<{ x: number; y: number }>): void {
    // Decay lifetimes
    this.active = this.active.filter(p => { p.lifetime -= dt; return p.lifetime > 0; });
    if (!playerPositions) return;

    // Pickup check
    this.active = this.active.filter(p => {
      for (const pp of playerPositions) {
        const dx = p.x - pp.x;
        const dy = p.y - pp.y;
        if (dx * dx + dy * dy < 24 * 24) {
          // Find which tank touched it (match by position)
          const tank = this.players.find(t =>
            t.isAlive && Math.abs(t.x - pp.x) < 2 && Math.abs(t.y - pp.y) < 2);
          this.apply(p.type, tank ?? this.players[0]);
          getSoundManager().play("pickup");
          this.onPickup?.(tank ?? this.players[0], p.type);
          return false;
        }
      }
      return true;
    });
  }

  /** Apply a power-up's effect to a tank */
  apply(type: PowerUpType, tank: Tank): void {
    switch (type) {
      case "star":
        // Firepower: boost damage + fire rate for 12s
        tank.damageBoostTimer = Math.max(tank.damageBoostTimer, 12);
        break;

      case "helmet":
        // Invincibility 6s
        tank.invincibleTimer = Math.max(tank.invincibleTimer, 6);
        break;

      case "shield":
        // Fortify base walls + give tank block armor
        this.base?.repairFull();
        tank.flatArmor += 30;
        break;

      case "clock":
        // Freeze all enemies 6s
        for (const e of this.getEnemies()) {
          if (e.isAlive) e.freezeTimer = Math.max(e.freezeTimer, 6);
        }
        break;

      case "shovel":
        // Steel walls around base (full repair + tank speed protection)
        this.base?.repairFull();
        tank.flatArmor += 15;
        break;

      case "bomb": {
        // Screen-wide blast: heavy damage to all enemies
        for (const e of this.getEnemies()) {
          if (!e.isAlive) continue;
          e.takeDamage(60, tank.team, 0, 0, tank.id);
        }
        break;
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, now: number): void {
    // v2.15 调用共享渲染模块 EntityVisual，确保主机端和成员端渲染完全一致
    renderPowerUpsVisual(ctx, {
      powerups: this.active,
    }, now);
  }
}
