// CollisionSystem.ts - Centralised collision handling
// Replaces per-tank soft-push with stable multi-pass resolution.
// Also cancels bullets between opposing teams.

import type { Projectile } from "../wand/WandTypes";
import type { Tank } from "../../game/Tank";
import type { Tilemap } from "../../game/Tilemap";

export class CollisionSystem {
  // 3-pass tank separation (stable, no per-tank fighting)
  resolveTankTank(tanks: Tank[], tilemap: Tilemap): void {
    const alive = tanks.filter(t => t.isAlive);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i];
          const b = alive[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist2 = dx * dx + dy * dy;
          const minDist = (a.config.width + b.config.width) / 2;
          if (dist2 < minDist * minDist && dist2 > 0.001) {
            const dist = Math.sqrt(dist2);
            const overlap = (minDist - dist) * 0.5;
            const nx = dx / dist;
            const ny = dy / dist;
            const hw_a = a.config.width / 2;
            const hh_a = a.config.height / 2;
            const hw_b = b.config.width / 2;
            const hh_b = b.config.height / 2;
            const ax2 = a.x + nx * overlap;
            const ay2 = a.y + ny * overlap;
            const bx2 = b.x - nx * overlap;
            const by2 = b.y - ny * overlap;
            if (!tilemap.checkTankCollision(ax2 - hw_a, ay2 - hh_a, a.config.width, a.config.height)) {
              a.x = ax2; a.y = ay2;
            }
            if (!tilemap.checkTankCollision(bx2 - hw_b, by2 - hh_b, b.config.width, b.config.height)) {
              b.x = bx2; b.y = by2;
            }
          }
        }
      }
    }
  }

  // Bullet-bullet cancellation: player (team=0) bullets cancel enemy (team=1) bullets
  resolveBulletBullet(projectiles: Projectile[]): void {
    const alive = projectiles.filter(p => p.isAlive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (!a.isAlive || !b.isAlive) continue;
        // Only cancel bullets from opposing teams (player vs enemy)
        if (a.ownerTeam === b.ownerTeam) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy;
        const hitDist = (a.radius + b.radius) * 1.5;
        if (dist2 < hitDist * hitDist) {
          a.isAlive = false;
          b.isAlive = false;
        }
      }
    }
  }
}
