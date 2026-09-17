//  Tilemap.ts ─
// Tile IDs and the tilemap grid system.
import { renderTile, renderTileState } from "../ui/MapVisual";
import type { BiomeId } from "../systems/terrain/MapGenerator";

export const enum TileType {
  Empty   = 0,
  Brick   = 1,  // grnd001: destructible (4 hp), blocks movement & bullets
  Steel   = 2,  // grnd002: indestructible (only heavy tank pierces), blocks all
  Water   = 3,  // grnd003: blocks tanks, bullets pass through
  Forest  = 4,  // grnd004: tanks & bullets pass through, tanks hidden
  Ice     = 5,  // grnd005: tanks slide (inertia), bullets pass through
  Base    = 6,  // Eagle base tile (special)
  Wall    = 7,  // Map boundary (indestructible)
  Rock    = 8,  // 岩石：需要单发≥50伤害才能打碎
  Mountain = 9, // 山体：需要单发≥500伤害才能打碎
}

export interface TileCell {
  type: TileType;
  hp: number;       // Current HP (bricks start at 4)
  maxHp: number;
  /** v2.17 砖块四象限独立血量（仅 Brick 类型使用；0=左上,1=右上,2=左下,3=右下）。
   *  每象限 1 HP，子弹命中哪个象限就销毁哪个象限，不再按固定顺序消失。 */
  quadHp?: [number, number, number, number];
}

// ── v2.3 地形状态层：平行于类型层的动态状态 ──
export type TileElement = "none" | "fire" | "ice" | "wet" | "oil" | "electric" | "poison" | "steam";

export interface TileState {
  element: TileElement;
  timer: number;       // 剩余秒数（<=0 清除）
  intensity: number;   // 1=普通，2=大火（火+油）
  burnAccum?: number;  // 累计燃烧时间（用于森林燃尽/油渍耗尽）
  persistent?: boolean; // v2.3 永久地形危险（岩浆/油渍/毒沼）：不参与动态演化
}

// 可燃地形判定：森林，或带有油渍的空地（油+火=大火）
export function isFlammable(type: TileType, state?: TileState): boolean {
  if (type === TileType.Forest) return true;
  if (type === TileType.Empty && state?.element === "oil") return true;
  return false;
}

// Pixel size of each tile (3232)
export const TILE_SIZE = 32;

// Max HP per tile type
const TILE_MAX_HP: Record<TileType, number> = {
  [TileType.Empty]:  0,
  [TileType.Brick]:  4,
  [TileType.Steel]:  999,
  [TileType.Water]:  0,
  [TileType.Forest]: 0,
  [TileType.Ice]:    0,
  [TileType.Base]:   10,
  [TileType.Wall]:   999,
  [TileType.Rock]:   150,     // 50阈值 × 3
  [TileType.Mountain]: 1500,  // 500阈值 × 3
};

// ── v2.20 地形伤害阈值：单发伤害低于阈值则无任何效果 ──
export const TERRAIN_DAMAGE_THRESHOLDS: Record<TileType, number> = {
  [TileType.Empty]:  0,
  [TileType.Brick]:  2,   // 砖墙：≥2伤害就能打（削弱一半）
  [TileType.Steel]:  100, // 钢板：≥100伤害才能打（削弱一半）
  [TileType.Water]:  0,
  [TileType.Forest]: 0,
  [TileType.Ice]:    0,
  [TileType.Base]:   0,
  [TileType.Wall]:   999, // 边界墙：几乎不可能打破
  [TileType.Rock]:   25,  // 岩石：≥25伤害才能打（削弱一半）
  [TileType.Mountain]: 250, // 山体：≥250伤害才能打（削弱一半）
};

// True if tanks can move onto this tile
export function isTankPassable(type: TileType): boolean {
  return type === TileType.Empty || type === TileType.Forest || type === TileType.Ice;
}

// True if bullets can pass through this tile
export function isBulletPassable(type: TileType, canPierceSteel = false): boolean {
  if (type === TileType.Empty || type === TileType.Forest ||
      type === TileType.Water || type === TileType.Ice) return true;
  if (type === TileType.Steel && canPierceSteel) return true;
  return false;
}

export class Tilemap {
  readonly cols: number;
  readonly rows: number;
  private cells: TileCell[];
  /** 生物群系（影响地图配色），由地图生成器设置；默认为 classic */
  biome: BiomeId = "classic";

  // ── 交互反馈：受击闪光系统（渲染层自动检测HP变化，不修改游戏逻辑）──
  private hitFlash: Map<number, number> = new Map();  // idx -> 剩余闪光时间(秒)
  private prevHp: Int16Array | null = null;            // 上一帧HP快照（懒初始化）

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: cols * rows }, () => ({
      type: TileType.Empty, hp: 0, maxHp: 0,
    }));
  }

  private idx(col: number, row: number): number { return row * this.cols + col; }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  get(col: number, row: number): TileCell | null {
    if (!this.inBounds(col, row)) return null;
    return this.cells[this.idx(col, row)];
  }

  set(col: number, row: number, type: TileType): void {
    if (!this.inBounds(col, row)) return;
    const maxHp = TILE_MAX_HP[type];
    const idx = this.idx(col, row);
    const cell: TileCell = { type, hp: maxHp, maxHp };
    // v2.17 砖块初始化四象限独立血量（每象限 1 HP）
    if (type === TileType.Brick) {
      cell.quadHp = [1, 1, 1, 1];
    }
    this.cells[idx] = cell;
    // 地形被重写时清掉状态（放墙/爆炸等）
    this.states.delete(idx);
    // v2.15 地图增量同步：记录变化的瓦片，供联机快照只发送变化部分
    this.dirtyTiles.add(idx);
  }

  // ── v2.15 地图增量同步：变化瓦片跟踪 ──
  /** 变化的瓦片索引集合（联机快照用，只发送变化部分） */
  dirtyTiles: Set<number> = new Set();
  /** 获取变化的瓦片列表（{col, row, type, quadHp?}），供联机快照发送 */
  getDirtyTileChanges(): Array<{ col: number; row: number; type: number; quadHp?: [number, number, number, number] }> {
    const changes: Array<{ col: number; row: number; type: number; quadHp?: [number, number, number, number] }> = [];
    for (const idx of this.dirtyTiles) {
      const col = idx % this.cols;
      const row = Math.floor(idx / this.cols);
      const cell = this.cells[idx];
      if (cell) {
        const ch: { col: number; row: number; type: number; quadHp?: [number, number, number, number] } = { col, row, type: cell.type };
        if (cell.type === TileType.Brick && cell.quadHp) ch.quadHp = [...cell.quadHp];
        changes.push(ch);
      }
    }
    return changes;
  }
  /** 清空变化瓦片集合（发送快照后调用） */
  clearDirtyTiles(): void {
    this.dirtyTiles.clear();
  }

  // ── v2.3 地形状态层操作 ──
  private states: Map<number, TileState> = new Map();

  setTileState(col: number, row: number, element: TileElement, timer: number, intensity = 1): void {
    if (!this.inBounds(col, row)) return;
    const key = this.idx(col, row);
    const prev = this.states.get(key);
    // 同类状态刷新时取更长的剩余时间、更大的强度
    if (prev && prev.element === element) {
      prev.timer = Math.max(prev.timer, timer);
      prev.intensity = Math.max(prev.intensity, intensity);
      if (prev.burnAccum !== undefined) prev.burnAccum = prev.burnAccum;
    } else {
      this.states.set(key, { element, timer, intensity });
    }
  }

  getTileState(col: number, row: number): TileState | undefined {
    if (!this.inBounds(col, row)) return undefined;
    return this.states.get(this.idx(col, row));
  }

  clearTileState(col: number, row: number): void {
    if (!this.inBounds(col, row)) return;
    this.states.delete(this.idx(col, row));
  }

  /** v2.9 地形危险（岩浆/油渍/毒沼）：默认 45s 时效，到期自然消散（不再永久残留） */
  setPersistentState(col: number, row: number, element: TileElement, intensity = 1, expiry = 45): void {
    if (!this.inBounds(col, row)) return;
    this.states.set(this.idx(col, row), { element, timer: expiry, intensity, persistent: true });
  }

  clearAllStates(): void { this.states.clear(); }

  forEachState(fn: (key: number, state: TileState) => void): void {
    for (const [key, s] of this.states) fn(key, s);
  }

  stateKeyToTile(key: number): { col: number; row: number } {
    return { col: key % this.cols, row: Math.floor(key / this.cols) };
  }

  /** 坦克 AABB 是否踩在带指定元素状态的地形上（用于燃烧/毒/电/冰地形伤害） */
  isOnElement(wx: number, wy: number, ww: number, wh: number, element: TileElement): boolean {
    const c0 = Math.floor(wx / TILE_SIZE);
    const r0 = Math.floor(wy / TILE_SIZE);
    const c1 = Math.floor((wx + ww - 1) / TILE_SIZE);
    const r1 = Math.floor((wy + wh - 1) / TILE_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const st = this.states.get(this.idx(c, r));
        if (st && st.element === element) return true;
      }
    }
    return false;
  }

  /** 推进所有地形状态：蔓延 / 燃尽 / 冻结水面通行 / 到期清除 */
  updateTileStates(dt: number): void {
    const expired: number[] = [];
    const toSpread: Array<{ col: number; row: number }> = [];
    const toBurn: Array<{ col: number; row: number }> = [];
    const toSteam: Array<{ col: number; row: number }> = [];

    for (const [key, s] of this.states) {
      // v2.9 持久地形危险也不得永久残留：仅静默倒计时消散（不蔓延/不燃尽），到期移除
      if (s.persistent) {
        s.timer -= dt;
        if (s.timer <= 0) expired.push(key);
        continue;
      }
      s.timer -= dt;
      if (s.timer <= 0) { expired.push(key); continue; }

      const { col, row } = this.stateKeyToTile(key);
      const cell = this.get(col, row);
      if (!cell) { expired.push(key); continue; }

      if (s.element === "fire") {
        // 累积燃烧时间：森林烧尽→空地；油渍耗尽→普通火
        s.burnAccum = (s.burnAccum ?? 0) + dt;
        if (cell.type === TileType.Forest && s.burnAccum >= 2.2) {
          toBurn.push({ col, row });
        } else if (cell.type === TileType.Empty && s.intensity >= 2 && s.burnAccum >= 1.4) {
          // 油渍燃尽：保留火一阵子然后自然消退
          toBurn.push({ col, row });
        }
        // 蔓延（约每 0.25s 向相邻可燃格扩散）
        if (s.timer % 0.25 < dt * 1.5) {
          const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
          for (const [dc, dr] of dirs) {
            const nc = col + dc, nr = row + dr;
            if (!this.inBounds(nc, nr)) continue;
            const ncell = this.get(nc, nr);
            const nstate = this.states.get(this.idx(nc, nr));
            if (!ncell) continue;
            if (nstate?.element === "wet") {
              // 火+湿 = 蒸汽（遮挡视线），湿格被消耗
              if (Math.random() < 0.6) toSteam.push({ col: nc, row: nr });
              continue;
            }
            if (isFlammable(ncell.type, nstate)) {
              toSpread.push({ col: nc, row: nr });
            }
          }
        }
      } else if (s.element === "ice") {
        // 冰状态在水面=冻结（可通行），到期由通行逻辑自动失效
      } else if (s.element === "electric") {
        // 电沿湿/水面传导
        if (s.timer % 0.18 < dt * 1.5) {
          const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
          for (const [dc, dr] of dirs) {
            const nc = col + dc, nr = row + dr;
            if (!this.inBounds(nc, nr)) continue;
            const nstate = this.states.get(this.idx(nc, nr));
            if (nstate?.element === "wet" || nstate?.element === "electric") {
              toSpread.push({ col: nc, row: nr });
            }
          }
        }
      } else if (s.element === "steam") {
        // 蒸汽：缓慢扩散到相邻空地（遮挡范围扩大），随后自然消散
        if (s.timer % 0.4 < dt * 1.5) {
          const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
          for (const [dc, dr] of dirs) {
            const nc = col + dc, nr = row + dr;
            if (!this.inBounds(nc, nr)) continue;
            const ncell = this.get(nc, nr);
            const nkey = this.idx(nc, nr);
            if (ncell && ncell.type === TileType.Empty && !this.states.has(nkey)) {
              this.states.set(nkey, { element: "steam", timer: 1.1, intensity: 1 });
            }
          }
        }
      }
    }

    for (const k of expired) this.states.delete(k);
    for (const b of toBurn) {
      const key = this.idx(b.col, b.row);
      const cell = this.get(b.col, b.row);
      if (!cell) continue;
      if (cell.type === TileType.Forest) {
        this.set(b.col, b.row, TileType.Empty);   // 森林烧成焦地
        this.setTileState(b.col, b.row, "fire", 1.0, 1);  // 余火
      } else if (cell.type === TileType.Empty) {
        const s = this.states.get(key);
        if (s && s.intensity >= 2) {
          // 油渍耗尽：恢复普通火，很快消退
          this.setTileState(b.col, b.row, "fire", Math.min(s.timer, 0.8), 1);
        }
      }
    }
    for (const sp of toSpread) {
      const cell = this.get(sp.col, sp.row);
      const st = this.states.get(this.idx(sp.col, sp.row));
      if (!cell) continue;
      // 油渍遇火 → 大火（强度2，范围扩大）
      const isOil = cell.type === TileType.Empty && st?.element === "oil";
      if (isOil) {
        this.setTileState(sp.col, sp.row, "fire", 2.2, 2);
      } else if (cell.type === TileType.Forest) {
        this.setTileState(sp.col, sp.row, "fire", 2.6, 1);
      } else if (st?.element === "electric") {
        this.setTileState(sp.col, sp.row, "electric", 0.35, 1);
      }
    }
    for (const sp of toSteam) {
      const key = this.idx(sp.col, sp.row);
      const st = this.states.get(key);
      if (!st) continue;
      if (st.element === "wet") {
        // 湿格被点燃 → 蒸汽；湿状态被消耗（变成蒸汽）
        this.states.set(key, { element: "steam", timer: 2.2, intensity: 1 });
      }
    }
  }

  // Returns true if tile was destroyed
  /** 根据世界坐标确定瓦片内象限（0=左上 1=右上 2=左下 3=右下） */
  static quadrantAt(wx: number, wy: number): number {
    const half = TILE_SIZE / 2;
    const lx = ((wx % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
    const ly = ((wy % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
    return (lx >= half ? 1 : 0) + (ly >= half ? 2 : 0);
  }

  /**
   * v2.17 按世界坐标伤害瓦片：砖块只伤害命中的那个象限（独立破坏），
   * 钢墙/岩石需要足够伤害才会掉血（弱子弹打不动且无闪光）。
   * 返回 true 表示瓦片被完全销毁。
   */
  damageAt(wx: number, wy: number, dmg: number): boolean {
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    const cell = this.get(col, row);
    if (!cell || cell.type === TileType.Empty) return false;
    if (this.indestructibleTiles.has(this.idx(col, row))) return false;

    // ── 伤害阈值检查：低于阈值则不产生任何伤害（含砖墙/岩石/钢板/山体） ──
    const threshold = TERRAIN_DAMAGE_THRESHOLDS[cell.type] ?? 0;
    if (threshold > 0 && dmg < threshold) return false;

    // 砖块：只伤害命中的象限
    if (cell.type === TileType.Brick && cell.quadHp) {
      const q = Tilemap.quadrantAt(wx, wy);
      if (cell.quadHp[q] <= 0) return false; // 该象限已碎，子弹可穿过
      cell.quadHp[q] = Math.max(0, cell.quadHp[q] - dmg);
      cell.hp = cell.quadHp.reduce((s, v) => s + v, 0);
      this.dirtyTiles.add(this.idx(col, row));  // v2.17 标记伤害变化供同步
      if (cell.hp <= 0) {
        cell.type = TileType.Empty;
        cell.hp = 0;
        cell.quadHp = undefined;
        this.clearWallKey(this.idx(col, row));
        return true;
      }
      return false;
    }

    // 其他瓦片（钢墙/岩石/山体被重弹击穿等）：整体伤害
    cell.hp -= dmg;
    if (cell.hp <= 0) {
      cell.type = TileType.Empty;
      cell.hp = 0;
      this.clearWallKey(this.idx(col, row));
      return true;
    }
    return false;
  }

  /** v2.17 远端同步：设置砖块瓦片的四象限血量（不触发脏标记） */
  setQuadHp(col: number, row: number, quadHp: [number, number, number, number]): void {
    const cell = this.get(col, row);
    if (!cell) return;
    if (cell.type !== TileType.Brick) {
      this.set(col, row, TileType.Brick);
    }
    const c = this.get(col, row)!;
    c.quadHp = [...quadHp];
    c.hp = c.quadHp.reduce((s, v) => s + v, 0);
    if (c.hp <= 0) {
      c.type = TileType.Empty;
      c.hp = 0;
      c.quadHp = undefined;
    }
  }

  damage(col: number, row: number, dmg: number): boolean {
    const cell = this.get(col, row);
    if (!cell || cell.type === TileType.Empty) return false;
    if (this.indestructibleTiles.has(this.idx(col, row))) return false;
    // ── 伤害阈值检查 ──
    const threshold = TERRAIN_DAMAGE_THRESHOLDS[cell.type] ?? 0;
    if (threshold > 0 && dmg < threshold) return false;
    // v2.17 砖块：无位置信息时逐象限扣减（从第一个非零象限开始，保持旧的总HP行为）
    if (cell.type === TileType.Brick && cell.quadHp) {
      let remaining = dmg;
      for (let q = 0; q < 4 && remaining > 0; q++) {
        if (cell.quadHp[q] > 0) {
          const take = Math.min(cell.quadHp[q], remaining);
          cell.quadHp[q] -= take;
          remaining -= take;
        }
      }
      cell.hp = cell.quadHp.reduce((s, v) => s + v, 0);
      this.dirtyTiles.add(this.idx(col, row));
      if (cell.hp <= 0) {
        cell.type = TileType.Empty;
        cell.hp = 0;
        cell.quadHp = undefined;
        this.clearWallKey(this.idx(col, row));
        return true;
      }
      return false;
    }
    cell.hp -= dmg;
    if (cell.hp <= 0) {
      cell.type = TileType.Empty;
      cell.hp = 0;
      this.clearWallKey(this.idx(col, row));
      return true;
    }
    return false;
  }

  // World pixel -> tile col/row
  worldToTile(wx: number, wy: number): { col: number; row: number } {
    return { col: Math.floor(wx / TILE_SIZE), row: Math.floor(wy / TILE_SIZE) };
  }

  // Tile col/row -> world pixel (top-left corner)
  tileToWorld(col: number, row: number): { x: number; y: number } {
    return { x: col * TILE_SIZE, y: row * TILE_SIZE };
  }

  // Base wall tiles that tanks may pass through (bullets still blocked/checked normally)
  private tankPassThrough: Set<number> = new Set();

  // Player-placed walls: key → placing team. Both friend and foe are blocked once armed.
  private teamWalls: Map<number, number> = new Map();
  // Indestructible placed walls (level-4): tilemap.damage() ignores them
  private indestructibleTiles: Set<number> = new Set();

  // ── v2.24 墙体成形保护：刚放置的墙体先免碰撞，等内部清空且稳定 2 秒后才成形 ──
  private wallUnarmed: Set<number> = new Set();
  private wallArmTimers: Map<number, number> = new Map();
  static readonly WALL_ARM_DELAY = 2.0; // 离开后还需等待的秒数

  /** v2.24 清除某格的一切墙体记录（放置/临时/成形状态） */
  private clearWallKey(key: number): void {
    this.teamWalls.delete(key);
    this.tankPassThrough.delete(key);
    this.wallUnarmed.delete(key);
    this.wallArmTimers.delete(key);
  }

  // ── v2.15 临时墙管理：记录临时墙的放置时间和所有者，30秒后自动消失 ──
  private tempWalls: Map<number, { placedAt: number; ownerId: number }> = new Map();
  static readonly TEMP_WALL_DURATION = 30;  // 30秒后消失

  /** 放置临时墙（30秒后自动消失） */
  placeTempWall(col: number, row: number, team: number, ownerId: number): boolean {
    const key = this.idx(col, row);
    if (!this.inBounds(col, row)) return false;
    // 每人最多同时存在1块临时墙：如果该所有者已有临时墙，先移除旧的
    for (const [k, v] of this.tempWalls) {
      if (v.ownerId === ownerId) {
        this.removeTempWallByKey(k);
      }
    }
    const maxHp = TILE_MAX_HP[TileType.Steel];
    this.cells[key] = { type: TileType.Steel, hp: maxHp, maxHp };
    this.teamWalls.set(key, team);
    this.tankPassThrough.add(key);
    // v2.24：新墙先免碰撞，等内部清空后再成形
    this.wallUnarmed.add(key);
    this.wallArmTimers.set(key, Tilemap.WALL_ARM_DELAY);
    this.tempWalls.set(key, { placedAt: performance.now(), ownerId });
    return true;
  }

  /** 检查指定所有者是否已有临时墙 */
  hasTempWall(ownerId: number): boolean {
    for (const v of this.tempWalls.values()) {
      if (v.ownerId === ownerId) return true;
    }
    return false;
  }

  /** 移除指定key的临时墙 */
  private removeTempWallByKey(key: number): void {
    this.tempWalls.delete(key);
    this.clearWallKey(key);
    this.cells[key] = { type: TileType.Empty, hp: 0, maxHp: 0 };
    this.states.delete(key);
  }

  /** 更新临时墙：检查是否超时，超时则移除 */
  updateTempWalls(now: number): void {
    const expired: number[] = [];
    for (const [key, v] of this.tempWalls) {
      if (now - v.placedAt > Tilemap.TEMP_WALL_DURATION * 1000) {
        expired.push(key);
      }
    }
    for (const key of expired) {
      this.removeTempWallByKey(key);
    }
  }

  /** 获取临时墙剩余时间（秒），用于渲染倒计时 */
  getTempWallRemaining(col: number, row: number): number | null {
    const key = this.idx(col, row);
    const v = this.tempWalls.get(key);
    if (!v) return null;
    const elapsed = (performance.now() - v.placedAt) / 1000;
    return Math.max(0, Tilemap.TEMP_WALL_DURATION - elapsed);
  }

  /** Mark a tile as tank-passable (e.g. base walls) while it still blocks bullets. */
  setTankPassThrough(col: number, row: number, on: boolean): void {
    const key = this.idx(col, row);
    if (on) this.tankPassThrough.add(key);
    else    this.tankPassThrough.delete(key);
  }

  /** Place a player wall. `team` = owning team. Both friend and foe are blocked. */
  placeTeamWall(col: number, row: number, team: number, type: TileType, hp = -1, indestructible = false): void {
    const key = this.idx(col, row);
    if (!this.inBounds(col, row)) return;
    const maxHp = hp > 0 ? hp : TILE_MAX_HP[type];
    this.cells[key] = { type, hp: maxHp, maxHp };
    this.teamWalls.set(key, team);
    if (indestructible) this.indestructibleTiles.add(key);
    // v2.24：新墙先免碰撞，等内部清空后再成形（防止把放置者/基地卡死）
    this.wallUnarmed.add(key);
    this.wallArmTimers.set(key, Tilemap.WALL_ARM_DELAY);
  }

  getTeamWall(col: number, row: number): number | null {
    return this.teamWalls.get(this.idx(col, row)) ?? null;
  }

  /** v2.24 墙体成形推进：内部无人时倒计时，2秒后成形；有人则重置计时（保持免碰撞） */
  updateWallArming(dt: number, boxes: { x: number; y: number; w: number; h: number }[]): void {
    if (this.wallUnarmed.size === 0) return;
    const ready: number[] = [];
    for (const key of this.wallUnarmed) {
      const col = key % this.cols;
      const row = Math.floor(key / this.cols);
      const x0 = col * TILE_SIZE, y0 = row * TILE_SIZE;
      const x1 = x0 + TILE_SIZE, y1 = y0 + TILE_SIZE;
      let occupied = false;
      for (const b of boxes) {
        if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) { occupied = true; break; }
      }
      if (occupied) {
        // 还有人卡在里面：保持免碰撞，并重置离开倒计时
        this.wallArmTimers.set(key, Tilemap.WALL_ARM_DELAY);
      } else {
        const t = (this.wallArmTimers.get(key) ?? Tilemap.WALL_ARM_DELAY) - dt;
        if (t <= 0) ready.push(key);
        else this.wallArmTimers.set(key, t);
      }
    }
    for (const key of ready) {
      this.wallUnarmed.delete(key);
      this.wallArmTimers.delete(key);
    }
  }

  /** v2.24 与矩形重叠的已成形玩家墙体（用于把仍被卡住的坦克往外推） */
  getSolidTeamWallRects(wx: number, wy: number, ww: number, wh: number): { x: number; y: number; w: number; h: number }[] {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const c0 = Math.floor(wx / TILE_SIZE);
    const r0 = Math.floor(wy / TILE_SIZE);
    const c1 = Math.floor((wx + ww - 1) / TILE_SIZE);
    const r1 = Math.floor((wy + wh - 1) / TILE_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!this.inBounds(c, r)) continue;
        const key = this.idx(c, r);
        if (this.teamWalls.has(key) && !this.wallUnarmed.has(key)) {
          out.push({ x: c * TILE_SIZE, y: r * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
        }
      }
    }
    return out;
  }

  // AABB overlap check: does rect (wx,wy,ww,wh) overlap any blocking tile?
  // `tankTeam` = tank's team (2=enemy); tiles owned by the same team are passable.
  checkTankCollision(wx: number, wy: number, ww: number, wh: number, tankTeam = -1): boolean {
    const c0 = Math.floor(wx / TILE_SIZE);
    const r0 = Math.floor(wy / TILE_SIZE);
    const c1 = Math.floor((wx + ww - 1) / TILE_SIZE);
    const r1 = Math.floor((wy + wh - 1) / TILE_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.get(c, r);
        if (!cell) continue;
        const key = this.idx(c, r);
        // Player walls: ALL tanks blocked once armed (unarmed walls stay passable until formed)
        if (this.teamWalls.has(key) && !this.wallUnarmed.has(key)) {
          return true;
        }
        if (this.tankPassThrough.has(key)) continue; // tanks may cross base walls
        // v2.3: 冻结的水面可通行（冰弹冻结水面后坦克可踏过）
        if (cell.type === TileType.Water && this.states.get(key)?.element === "ice") continue;
        if (!isTankPassable(cell.type)) return true;
      }
    }
    return false;
  }

  // Check if a tank AABB rect overlaps any ice tile
  isOnIce(wx: number, wy: number, ww: number, wh: number): boolean {
    const c0 = Math.floor(wx / TILE_SIZE);
    const r0 = Math.floor(wy / TILE_SIZE);
    const c1 = Math.floor((wx + ww - 1) / TILE_SIZE);
    const r1 = Math.floor((wy + wh - 1) / TILE_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.get(c, r);
        if (cell && cell.type === TileType.Ice) return true;
      }
    }
    return false;
  }

  // Check if a tank AABB rect overlaps any forest tile (for hiding)
  isOnForest(wx: number, wy: number, ww: number, wh: number): boolean {
    const c0 = Math.floor(wx / TILE_SIZE);
    const r0 = Math.floor(wy / TILE_SIZE);
    const c1 = Math.floor((wx + ww - 1) / TILE_SIZE);
    const r1 = Math.floor((wy + wh - 1) / TILE_SIZE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.get(c, r);
        if (cell && cell.type === TileType.Forest) return true;
      }
    }
    return false;
  }

  // Load from a 2D number array
  loadFromArray(data: number[][]): void {
    for (let r = 0; r < data.length && r < this.rows; r++) {
      for (let c = 0; c < data[r].length && c < this.cols; c++) {
        this.set(c, r, data[r][c] as TileType);
      }
    }
  }

  /** 联机：导出当前地形为二维类型数组（供远端重建渲染） */
  toArray(): number[][] {
    const data: number[][] = [];
    for (let r = 0; r < this.rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < this.cols; c++) row.push(this.get(c, r)!.type);
      data.push(row);
    }
    return data;
  }

  // camX/camY = camera world offset; viewW/viewH = viewport size (for culling)
  render(ctx: CanvasRenderingContext2D, camX = 0, camY = 0, viewW = 9999, viewH = 9999): void {
    const now = performance.now();
    const dt = 1 / 60;  // 帧间隔（用于闪光衰减）

    // 懒初始化上一帧HP快照
    if (!this.prevHp) {
      this.prevHp = new Int16Array(this.cols * this.rows);
      for (let i = 0; i < this.cells.length; i++) this.prevHp[i] = this.cells[i].hp;
    }

    // Cull to visible tile range
    const c0 = Math.max(0, Math.floor(camX / TILE_SIZE) - 1);
    const r0 = Math.max(0, Math.floor(camY / TILE_SIZE) - 1);
    const c1 = Math.min(this.cols - 1, Math.ceil((camX + viewW) / TILE_SIZE) + 1);
    const r1 = Math.min(this.rows - 1, Math.ceil((camY + viewH) / TILE_SIZE) + 1);

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const idx = this.idx(c, r);
        const cell = this.cells[idx];
        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;

        // ── 受击闪光检测：HP减少时触发白色闪光（渲染层自动检测，不改游戏逻辑）──
        if (cell.maxHp > 0 && cell.hp < this.prevHp[idx]) {
          this.hitFlash.set(idx, 0.18);  // 0.18秒闪光
        }
        this.prevHp[idx] = cell.hp;

        // v2.7.1 基地护墙（tankPassThrough，坦克可穿越）降半透明渲染：避免"坦克站在砖上"的观感冲突
        const passOver = this.tankPassThrough.has(idx);
        if (passOver) { ctx.save(); ctx.globalAlpha = 0.5; }

        // ── 美化后的瓦片渲染 ──
        renderTile(ctx, cell, x, y, c, r, now, this.biome);

        if (passOver) ctx.restore();   // 恢复半透明（元素覆盖层保持原样）

        // ── v2.3 地形状态覆盖层（美化版：火焰跳动/电流闪烁/毒雾气泡等）──
        const st = this.states.get(idx);
        if (st) {
          renderTileState(ctx, st, x, y, now, c, r);
        }

        // ── 受击闪光渲染：白色覆盖层（从亮到暗衰减）──
        const flash = this.hitFlash.get(idx);
        if (flash && flash > 0) {
          const alpha = Math.min(1, flash / 0.18) * 0.7;
          ctx.fillStyle = `rgba(255,255,255,${alpha})`;
          ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
          // 衰减
          const newFlash = flash - dt;
          if (newFlash > 0) this.hitFlash.set(idx, newFlash);
          else this.hitFlash.delete(idx);
        }

        // ── v2.15 临时墙视觉标识：蓝色发光边框 + 倒计时数字 ──
        const tempRemaining = this.getTempWallRemaining(c, r);
        if (tempRemaining !== null) {
          const pulse = 0.5 + 0.5 * Math.sin(now / 200);
          // 蓝色发光边框
          ctx.strokeStyle = `rgba(80,160,255,${0.6 + pulse * 0.4})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, TILE_SIZE - 2, TILE_SIZE - 2);
          // 内边框
          ctx.strokeStyle = `rgba(150,210,255,${0.3 + pulse * 0.3})`;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 3, y + 3, TILE_SIZE - 6, TILE_SIZE - 6);
          // 倒计时数字（最后10秒显示）
          if (tempRemaining <= 10) {
            const blink = tempRemaining <= 3 ? (Math.sin(now / 100) > 0 ? 1 : 0.3) : 1;
            ctx.fillStyle = `rgba(255,255,255,${blink})`;
            ctx.font = "bold 12px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(Math.ceil(tempRemaining).toString(), x + TILE_SIZE / 2, y + TILE_SIZE / 2);
          }
        }
      }
    }

    // ── 网格辅助线：在空地上显示极淡的网格，帮助玩家判断距离和定位（不遮挡墙体）──
    ctx.strokeStyle = "rgba(255,255,255,0.025)";
    ctx.lineWidth = 1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.cells[this.idx(c, r)];
        if (cell.type === TileType.Empty || cell.type === TileType.Ice) {
          const x = c * TILE_SIZE;
          const y = r * TILE_SIZE;
          ctx.strokeRect(x + 0.5, y + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        }
      }
    }
  }
}
