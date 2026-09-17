//  Base.ts ─
// Eagle base: protective walls built from individual small bricks + core.
// v2.16 基地护墙拆分为独立小砖块：每面墙由 8 块 16×16 小砖组成，
// 每块砖独立碰撞、独立被击毁、独立修复，与地图砖墙机制一致。
import type { Renderer } from "../engine/Renderer";
import { TILE_SIZE } from "./Tilemap";
// v2.15 基地渲染共享模块：主机端和成员端都调用 BaseVisual，确保联机版本一致
import { renderBase as renderBaseVisual } from "../ui/BaseVisual";

export type BaseSide = "top" | "bottom" | "left" | "right";

/** 单块基地护墙砖（16×16，独立血量/碰撞/修复） */
export interface BaseBrick {
  side: BaseSide;
  index: number;   // 该面内的序号 0..7
  hp: number;
  maxHp: number;
  x: number; y: number; w: number; h: number;
  /** 重建后碰撞延迟（秒），>0 期间忽略碰撞，防止玩家被卡住 */
  collisionDelay: number;
}

/** 兼容旧代码的面级聚合视图（只读，用于 UI 汇总显示） */
export interface BaseWallView {
  side: BaseSide;
  hp: number;
  maxHp: number;
}

const BRICK_SIZE = 16;
const BRICKS_PER_SIDE = 8;
const BRICK_HP = 1;       // 每块小砖 1 HP（子弹一击即碎，需逐块修复）
const EAGLE_HP = 20;      // 基地核心血量

export class Base {
  // Center pixel position of eagle
  x: number;
  y: number;
  eagleHp: number = EAGLE_HP;
  eagleMaxHp: number = EAGLE_HP;
  isDestroyed: boolean = false;

  // 基地加固等级（1→2→3），每级四面墙更厚（每砖 maxHp +1）
  wallLevel: number = 1;
  static readonly MAX_WALL_LEVEL = 3;

  // 护墙累计吸收的伤害（体现墙体/修复小人对基地的保护贡献）
  wallDamageAbsorbed: number = 0;

  // Repair-complete flash FX (triggered when a brick just reached full hp)
  repairFlashTimer: number = 0;
  repairFlashSide: BaseSide | null = null;

  // 修复进度显示：当前正在修复的目标（墙 or 基地核心）与进度 0..1
  repairTarget: BaseSide | "eagle" | null = null;
  repairProgress: number = 0;

  /** 32 块独立小砖（每面 8 块） */
  bricks: BaseBrick[] = [];

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.initBricks();
  }

  /** 初始化四面墙的小砖布局（每面 8 块 16×16） */
  private initBricks(): void {
    this.bricks = [];
    const T = TILE_SIZE;
    const B = BRICK_SIZE;
    const hp = BRICK_HP + (this.wallLevel - 1);  // 加固等级提升每砖血量
    // top / bottom：4 列 × 2 行 = 8 块（宽 64，高 32）
    for (const side of ["top", "bottom"] as BaseSide[]) {
      const baseY = side === "top" ? this.y - 2 * T : this.y + T;
      let idx = 0;
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          this.bricks.push({
            side, index: idx++, hp, maxHp: hp,
            x: this.x - T + c * B, y: baseY + r * B, w: B, h: B,
            collisionDelay: 0,
          });
        }
      }
    }
    // left / right：2 列 × 4 行 = 8 块（宽 32，高 64）
    for (const side of ["left", "right"] as BaseSide[]) {
      const baseX = side === "left" ? this.x - 2 * T : this.x + T;
      let idx = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 2; c++) {
          this.bricks.push({
            side, index: idx++, hp, maxHp: hp,
            x: baseX + c * B, y: this.y - T + r * B, w: B, h: B,
            collisionDelay: 0,
          });
        }
      }
    }
  }

  /** 面级聚合视图（兼容旧 UI 代码：sum/max 汇总） */
  get walls(): BaseWallView[] {
    const sides: BaseSide[] = ["top", "bottom", "left", "right"];
    return sides.map((side) => {
      const bs = this.bricks.filter((b) => b.side === side);
      return {
        side,
        hp: bs.reduce((s, b) => s + b.hp, 0),
        maxHp: bs.reduce((s, b) => s + b.maxHp, 0),
      };
    });
  }

  /** 获取某一面的所有砖 */
  getBricksOnSide(side: BaseSide): BaseBrick[] {
    return this.bricks.filter((b) => b.side === side);
  }

  /** 获取某一面仍存活（hp>0）的砖 */
  getAliveBricksOnSide(side: BaseSide): BaseBrick[] {
    return this.bricks.filter((b) => b.side === side && b.hp > 0);
  }

  /** 点命中检测：返回被点中的存活砖（用于子弹碰撞） */
  getBrickAtPoint(px: number, py: number): BaseBrick | null {
    for (const b of this.bricks) {
      if (b.hp <= 0) continue;
      if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) return b;
    }
    return null;
  }

  /** 每帧更新：递减砖块碰撞延迟计时器；如果玩家仍在上面则继续延长 */
  updateBrickDelay(dt: number, playerBoxes?: {x:number;y:number;w:number;h:number}[]): void {
    for (const b of this.bricks) {
      if (b.collisionDelay > 0) {
        // 检查是否有玩家站在该砖上
        let playerOnTop = false;
        if (playerBoxes) {
          for (const pb of playerBoxes) {
            if (pb.x < b.x + b.w && pb.x + pb.w > b.x && pb.y < b.y + b.h && pb.y + pb.h > b.y) {
              playerOnTop = true;
              break;
            }
          }
        }
        if (playerOnTop) {
          b.collisionDelay = 1.0; // 延长延迟，等玩家离开
        } else {
          b.collisionDelay = Math.max(0, b.collisionDelay - dt);
        }
      }
    }
  }

  /** AABB 重叠检测：返回与矩形重叠的存活砖（用于坦克碰撞/范围伤害） */
  getAliveBricksInRect(wx: number, wy: number, ww: number, wh: number): BaseBrick[] {
    const result: BaseBrick[] = [];
    for (const b of this.bricks) {
      if (b.hp <= 0) continue;
      if (b.collisionDelay > 0) continue; // 重建后延迟碰撞，防止卡住玩家
      if (wx < b.x + b.w && wx + ww > b.x && wy < b.y + b.h && wy + wh > b.y) {
        result.push(b);
      }
    }
    return result;
  }

  /** 坦克 AABB 是否碰到任何存活砖（用于坦克移动碰撞） */
  checkTankCollision(wx: number, wy: number, ww: number, wh: number): boolean {
    return this.getAliveBricksInRect(wx, wy, ww, wh).length > 0;
  }

  // Repair one brick; returns the actual HP restored (0 if already full)
  repairBrick(brick: BaseBrick, amount = 1): number {
    if (brick.hp >= brick.maxHp) return 0;
    const wasFull = brick.hp >= brick.maxHp;
    const restored = Math.min(brick.maxHp, brick.hp + amount) - brick.hp;
    brick.hp = Math.min(brick.maxHp, brick.hp + amount);
    // 重建后延迟碰撞，防止玩家被卡在砖块里
    brick.collisionDelay = 1.0;
    // Trigger golden flash when a brick finishes repairing
    if (!wasFull && brick.hp >= brick.maxHp) {
      this.repairFlashTimer = 0.8;
      this.repairFlashSide = brick.side;
    }
    return restored;
  }

  /** 修复指定面最破损的一块砖（修复小人/玩家修墙用），返回实际恢复量 */
  repairMostDamagedBrickOnSide(side: BaseSide, amount = 1): number {
    const damaged = this.getBricksOnSide(side)
      .filter((b) => b.hp < b.maxHp)
      .sort((a, b) => a.hp - b.hp);
    if (damaged.length === 0) return 0;
    return this.repairBrick(damaged[0], amount);
  }

  /** 全局修复：找所有砖中最破损的一块（修复小人优先修核心，核心满后修最破的砖） */
  repairMostDamagedBrick(amount = 1): { restored: number; side: BaseSide | null } {
    const damaged = this.bricks
      .filter((b) => b.hp < b.maxHp)
      .sort((a, b) => a.hp - b.hp);
    if (damaged.length === 0) return { restored: 0, side: null };
    const brick = damaged[0];
    const restored = this.repairBrick(brick, amount);
    return { restored, side: brick.side };
  }

  // Repair all walls to full
  repairFull(): void {
    for (const b of this.bricks) b.hp = b.maxHp;
  }

  // 修复基地核心（回血）；返回实际恢复量（满血返回0）
  repairEagle(amount = 1): number {
    if (this.isDestroyed) return 0;
    const restored = Math.min(this.eagleMaxHp, this.eagleHp + amount) - this.eagleHp;
    this.eagleHp = Math.min(this.eagleMaxHp, this.eagleHp + amount);
    return restored;
  }

  // 基地加固：每级所有砖 maxHp/hp 提升（1→2→3）
  upgradeWalls(): boolean {
    if (this.wallLevel >= Base.MAX_WALL_LEVEL) return false;
    this.wallLevel++;
    for (const b of this.bricks) {
      b.maxHp += 1;
      b.hp = Math.min(b.maxHp, b.hp + 1);
    }
    return true;
  }

  /** 击中一块砖；返回 true 表示该砖已碎（子弹可继续穿透到后面的鹰标） */
  hitBrick(brick: BaseBrick, dmg: number): boolean {
    if (brick.hp <= 0) return true;  // 已碎，子弹可穿过
    const absorbed = Math.min(brick.hp, dmg);
    brick.hp = Math.max(0, brick.hp - dmg);
    this.wallDamageAbsorbed += absorbed;
    return brick.hp <= 0;
  }

  // AABB for walls (px) —— 保留面级外接矩形，用于修复闪光/进度条的大致区域
  getWallRect(side: BaseSide): { x: number; y: number; w: number; h: number } | null {
    const T = TILE_SIZE;
    const cx = this.x;
    const cy = this.y;
    switch (side) {
      case "top":    return { x: cx - T,     y: cy - 2*T, w: 2*T, h: T };
      case "bottom": return { x: cx - T,     y: cy + T,   w: 2*T, h: T };
      case "left":   return { x: cx - 2*T,   y: cy - T,   w: T,   h: 2*T };
      case "right":  return { x: cx + T,     y: cy - T,   w: T,   h: 2*T };
    }
  }

  render(renderer: Renderer, now: number): void {
    const { ctx } = renderer;

    // v2.15 调用共享渲染模块 BaseVisual，确保主机端和成员端渲染完全一致
    renderBaseVisual(ctx, {
      x: this.x,
      y: this.y,
      eagleHp: this.eagleHp,
      eagleMaxHp: this.eagleMaxHp,
      isDestroyed: this.isDestroyed,
      walls: this.walls,
      bricks: this.bricks,
      repairFlashTimer: this.repairFlashTimer,
      repairFlashSide: this.repairFlashSide,
      repairTarget: this.repairTarget,
      repairProgress: this.repairProgress,
    }, now);

    // 修复闪光计时器递减（状态更新，不属于渲染逻辑）
    if (this.repairFlashTimer > 0) this.repairFlashTimer -= 1 / 60;
  }
}
