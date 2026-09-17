//  ElementSystem.ts ─
//  v2.3 元素系统：投射体命中实体/地形时施加元素状态与地形交互
//  - 火焰：点燃可燃地形（森林/油渍），蔓延，灼烧实体
//  - 寒冰：冻结水面（可通行）、减速/深冻实体
//  - 雷电：感电、沿湿地面/湿润实体导电连锁
//  - 毒：持续掉血，沼泽/湿面扩散毒雾
//  - 油：泼洒油渍，油渍遇火变大火
import type { Projectile } from "../wand/WandTypes";
import type { Tank } from "../../game/Tank";
import { Tilemap, TileType, isFlammable, TILE_SIZE } from "../../game/Tilemap";
import { StatusSystem, type StatusId } from "../status/StatusSystem";
import { EventManager } from "../../framework/EventManager";

const events = EventManager.getInstance();

// 组合矩阵：地形状态间的反应由 Tilemap.updateTileStates + 本系统共同实现
export class ElementSystem {
  // 地形对踩踏实体的状态施加冷却（避免每帧刷新重置 DOT tick）
  private terrainTick: Map<number, number> = new Map();
  private readonly TERRAIN_INTERVAL = 0.5;

  update(dt: number, allTanks: Tank[], tilemap: Tilemap): void {
    // 推进冷却
    for (const [id, t] of this.terrainTick) {
      const nt = t - dt;
      if (nt <= 0) this.terrainTick.delete(id);
      else this.terrainTick.set(id, nt);
    }

    for (const tank of allTanks) {
      if (!tank.isAlive) continue;
      StatusSystem.update(dt, tank, allTanks, tilemap);
      this.applyTerrainToTank(tank, tilemap, allTanks);
    }
  }

  /** 投射体命中实体：施加状态 + 组合（油+火=大火灼烧） */
  onProjectileHitEntity(proj: Projectile, tank: Tank, allTanks: Tank[], tilemap: Tilemap): void {
    const el = proj.element;
    if (!el || !tank.isAlive) return;
    const team = proj.ownerTeam;
    const sid = proj.ownerId;
    switch (el) {
      case "fire": {
        // 覆油的实体被点燃 → 大火（强度2，更久更痛）
        const hasOil = tank.statuses.has("oil");
        const hasWet = tank.statuses.has("wet");
        StatusSystem.apply(tank, "burn", 2.5, hasOil ? 2 : 1, team, sid);
        if (hasOil) StatusSystem.clear(tank, "oil");
        if (hasWet) {
          // 火+湿 = 蒸汽：清湿并在实体周围产生蒸汽遮挡（火系敌人免疫燃烧不受影响）
          StatusSystem.clear(tank, "wet");
          const tcol = Math.floor(tank.x / TILE_SIZE);
          const trow = Math.floor(tank.y / TILE_SIZE);
          for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
            const nc = tcol + dc, nr = trow + dr;
            const ncell = tilemap.get(nc, nr);
            if (ncell && ncell.type === TileType.Empty && !tilemap.getTileState(nc, nr)) {
              tilemap.setTileState(nc, nr, "steam", 1.6, 1);
            }
          }
        }
        break;
      }
      case "ice":
        StatusSystem.apply(tank, "freeze", 2.2, 1, team, sid);
        break;
      case "electric": {
        // 湿润实体被电 → 强感电 + 传导
        const fromWet = tank.statuses.has("wet");
        StatusSystem.apply(tank, "electric", 1.2, fromWet ? 2 : 1, team, sid);
        if (fromWet) {
          this.conductElectricFrom(tank.x, tank.y, tilemap, allTanks, team, sid, 3);
        }
        break;
      }
      case "poison":
        StatusSystem.apply(tank, "poison", 4.0, 1, team, sid);
        break;
      case "oil":
        StatusSystem.apply(tank, "oil", 6.0, 1, team, sid);
        break;
    }
  }

  /** 投射体命中地形：点燃 / 冻结 / 导电 / 毒雾 / 油渍 */
  onProjectileToTile(proj: Projectile, col: number, row: number, tilemap: Tilemap): void {
    const el = proj.element;
    if (!el) return;
    const cell = tilemap.get(col, row);
    if (!cell) return;
    const state = tilemap.getTileState(col, row);

    switch (el) {
      case "fire": {
        // 火落在湿面 → 蒸汽（遮挡视线），不点燃
        if (state?.element === "wet") {
          tilemap.setTileState(col, row, "steam", 2.0, 1);
          break;
        }
        if (isFlammable(cell.type, state)) {
          // 油渍遇火 → 大火（强度2）；森林 → 普通火；setTileState 已替换油渍为火，勿再清状态
          const isOil = cell.type === TileType.Empty && state?.element === "oil";
          tilemap.setTileState(col, row, "fire", 2.6, isOil ? 2 : 1);
        }
        break;
      }
      case "ice": {
        if (cell.type === TileType.Water) {
          tilemap.setTileState(col, row, "ice", 3.0, 1);   // 冻结水面（可通行）
        } else {
          tilemap.setTileState(col, row, "ice", 2.2, 1);   // 冰面减速
        }
        break;
      }
      case "electric": {
        tilemap.setTileState(col, row, "electric", 0.35, 1);
        // 落在湿面/水面 → 沿导电地形连锁
        if (state?.element === "wet" || cell.type === TileType.Water) {
          tilemap.setTileState(col, row, "electric", 0.6, 1);
          this.conductElectricFrom(col * TILE_SIZE + 16, row * TILE_SIZE + 16, tilemap, [], -1, -1, 4);
        }
        break;
      }
      case "poison": {
        // 湿面/水面 → 毒雾扩散；普通地面 → 毒渍
        tilemap.setTileState(col, row, "poison", 4.0, 1);
        if (state?.element === "wet" || cell.type === TileType.Water) {
          this.spreadPoison(col, row, tilemap, 2);
        }
        break;
      }
      case "oil": {
        tilemap.setTileState(col, row, "oil", 6.0, 1);
        // 溅射：相邻一格也有油渍
        for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nc = col + dc, nr = row + dr;
          const ncell = tilemap.get(nc, nr);
          if (ncell && ncell.type === TileType.Empty && !tilemap.getTileState(nc, nr)) {
            tilemap.setTileState(nc, nr, "oil", 5.0, 1);
          }
        }
        break;
      }
    }
  }

  /** 地形状态 → 踩踏实体：燃烧地形/毒雾/电流/冰面 */
  private applyTerrainToTank(tank: Tank, tilemap: Tilemap, allTanks: Tank[]): void {
    if (!tank.isAlive) return;
    if (this.terrainTick.has(tank.id)) return;
    this.terrainTick.set(tank.id, this.TERRAIN_INTERVAL);

    const hw = tank.config.width / 2;
    const hh = tank.config.height / 2;
    const team = -1;  // 环境伤害无归属

    // 燃烧地形
    if (tilemap.isOnElement(tank.x - hw, tank.y - hh, tank.config.width, tank.config.height, "fire")) {
      // v2.3 地形协同：火系敌人（火免疫）在火地形上回血，其余受灼烧
      const burnResist = tank.elementResist?.["burn"] ?? 1;
      if (burnResist <= 0.2) tank.heal(1.5);
      else {
        StatusSystem.apply(tank, "burn", 2.0, 1, team);
        events.emit("element:burnfx", tank.x, tank.y);
      }
    }
    // 毒雾/毒渍
    if (tilemap.isOnElement(tank.x - hw, tank.y - hh, tank.config.width, tank.config.height, "poison")) {
      // v2.3 地形协同：毒系敌人（毒免疫）在毒沼上回血
      const poisonResist = tank.elementResist?.["poison"] ?? 1;
      if (poisonResist <= 0.2) tank.heal(1.5);
      else StatusSystem.apply(tank, "poison", 2.5, 1, team);
    }
    // 电流地形
    if (tilemap.isOnElement(tank.x - hw, tank.y - hh, tank.config.width, tank.config.height, "electric")) {
      const elecResist = tank.elementResist?.["electric"] ?? 1;
      tank.takeStatusDamage(3 * Math.max(0, elecResist), team);
      if (elecResist > 0.2) {
        StatusSystem.apply(tank, "electric", 1.0, 1, team);
        events.emit("element:arc", tank.x, tank.y, tank.x + 12, tank.y - 8, tank.team);
      }
    }
    // 冰面减速（弱冻结）
    if (tilemap.isOnElement(tank.x - hw, tank.y - hh, tank.config.width, tank.config.height, "ice")) {
      // v2.3 冰系敌人（冰免疫）不受冰面减速
      const freezeResist = tank.elementResist?.["freeze"] ?? 1;
      if (freezeResist > 0.2) StatusSystem.apply(tank, "freeze", 0.6, 1, team);
    }
  }

  /** 沿湿润/水面导电链（BFS），传导伤害到链上的敌方坦克 */
  private conductElectricFrom(
    x: number, y: number,
    tilemap: Tilemap, allTanks: Tank[],
    team: number, sourceId: number, depth: number,
  ): void {
    const start = tilemap.worldToTile(x, y);
    const visited = new Set<number>();
    const queue: Array<{ col: number; row: number }> = [{ col: start.col, row: start.row }];
    let steps = 0;
    const chainDmg = 6;

    while (queue.length > 0 && steps < depth * 4) {
      const { col, row } = queue.shift()!;
      if (!tilemap.inBounds(col, row)) continue;
      const key = row * tilemap.cols + col;
      if (visited.has(key)) continue;
      visited.add(key);

      const cell = tilemap.get(col, row);
      const st = tilemap.getTileState(col, row);
      // 只沿导电地形走：湿/水面/电流
      if (cell && !(cell.type === TileType.Water ||
                    st?.element === "wet" || st?.element === "electric" || st?.element === "ice")) continue;
      steps++;

      // 传导伤害到站在该格/邻近的敌方坦克（电抗减免）
      const tx = col * TILE_SIZE + 16;
      const ty = row * TILE_SIZE + 16;
      for (const tank of allTanks) {
        if (!tank.isAlive || tank.team === team) continue;
        if (Math.hypot(tank.x - tx, tank.y - ty) < 42) {
          const resist = tank.elementResist?.["electric"] ?? 1;
          tank.takeStatusDamage(chainDmg * Math.max(0, resist), team, sourceId);
          if (resist > 0.2) StatusSystem.apply(tank, "electric", 0.8, 1, team, sourceId);
          events.emit("element:arc", x, y, tank.x, tank.y, tank.team);
        }
      }

      for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        queue.push({ col: col + dc, row: row + dr });
      }
    }
  }

  /** 毒雾在相邻湿/水面扩散 */
  private spreadPoison(col: number, row: number, tilemap: Tilemap, depth: number): void {
    for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
      const nc = col + dc, nr = row + dr;
      const ncell = tilemap.get(nc, nr);
      const nstate = tilemap.getTileState(nc, nr);
      if (ncell && (ncell.type === TileType.Water || nstate?.element === "wet") && depth > 0) {
        tilemap.setTileState(nc, nr, "poison", 4.0, 1);
        this.spreadPoison(nc, nr, tilemap, depth - 1);
      }
    }
  }
}
