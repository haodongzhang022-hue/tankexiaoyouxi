import { Tank, DIR_ANGLES } from "../../game/Tank";
import type { Base } from "../../game/Base";
import type { Enemy } from "../../game/Enemy";
import type { Tilemap } from "../../game/Tilemap";
import { TileType, TILE_SIZE } from "../../game/Tilemap";

export interface ItemUseContext {
  base: Base;
  enemies: Enemy[];
  tilemap?: Tilemap;
  onExplosion?: (x: number, y: number, radius: number) => void;
  onBrickPlaced?: (col: number, row: number) => void;
}

export function useTraditionalItem(
  itemId: string,
  player: Tank,
  ctx: ItemUseContext,
): boolean {
  if (!player.isAlive) return false;

  switch (itemId) {
    case "item_shield":
      player.flatArmor += 50;
      return true;

    case "item_timestop":
      for (const e of ctx.enemies) {
        if (e.isAlive) e.freezeTimer = Math.max(e.freezeTimer, 3);
      }
      return true;

    case "item_bomb": {
      const cx = player.x;
      const cy = player.y;
      const radius = 420;
      ctx.onExplosion?.(cx, cy, radius);
      for (const e of ctx.enemies) {
        if (!e.isAlive) continue;
        const dx = e.x - cx;
        const dy = e.y - cy;
        if (dx * dx + dy * dy < radius * radius) {
          e.takeDamage(40, player.team, 0, 0, player.id);
        }
      }
      return true;
    }

    case "item_extra_life":
      player.lives++;
      return true;

    case "item_repair_kit": {
      // v2.16 修复工具箱：修复所有破损的小砖（每块 +maxHp），再给核心回血
      let repaired = false;
      for (const b of ctx.base.bricks) {
        if (b.hp < b.maxHp) {
          ctx.base.repairBrick(b, b.maxHp);
          repaired = true;
        }
      }
      if (!repaired && ctx.base.eagleHp < 10) ctx.base.eagleHp = Math.min(10, ctx.base.eagleHp + 5);
      return true;
    }

    case "item_speed_boost":
      player.speedBoostBonus = player.config.speed * 0.5;
      player.speedBoostTimer = 15;
      return true;

    case "item_damage_boost":
      player.damageBoostTimer = 10;
      return true;

    case "item_bricks": {
      // 放砖：在朝向方向前方2格处放置一块可破坏砖块（HP=6）
      if (!ctx.tilemap) return false;
      const angle = DIR_ANGLES[player.facing] ?? 0;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const baseCol = Math.floor(player.x / TILE_SIZE);
      const baseRow = Math.floor(player.y / TILE_SIZE);
      // 选前方2格（主轴）
      let col = baseCol, row = baseRow;
      if (Math.abs(dx) > Math.abs(dy)) col = baseCol + (dx > 0 ? 2 : -2);
      else row = baseRow + (dy > 0 ? 2 : -2);
      const cell = ctx.tilemap.get(col, row);
      const valid = cell && (cell.type === TileType.Empty || cell.type === TileType.Forest || cell.type === TileType.Ice);
      if (valid && ctx.tilemap.getTeamWall(col, row) === null) {
        ctx.tilemap.placeTeamWall(col, row, player.team, TileType.Brick, 6, false);
        ctx.onBrickPlaced?.(col, row);
        return true;
      }
      return false;
    }

    default:
      return false;
  }
}
