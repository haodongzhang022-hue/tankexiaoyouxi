/**
 * AssetCache.ts —— 素材预渲染缓存系统
 *
 * 基于 AssetPack（资源包）把瓦片、坦克身体等重复出现的视觉素材预渲染到
 * offscreen canvas，渲染时直接 drawImage 复用，而非每帧重新创建渐变/路径。
 *
 * 三大收益：
 * 1. 性能：每帧从"重绘 676+ 瓦片的渐变/路径"降为"drawImage 位图"，CPU 占用大幅下降
 * 2. 对齐：主机和 2 号机基于同一份 AssetPack 生成素材，像素级一致
 * 3. 网络轻量化：视觉配置只在资源包里发一次，后续快照只发位置/HP 等动态信号
 *
 * 缓存失效：assetPack.apply() 时自动清空所有缓存，下一帧按需重新生成。
 */

import { TILE_SIZE, TileType } from "../game/Tilemap";
import type { BiomeId } from "../systems/terrain/MapGenerator";
import { assetPack, getBiomeColors, getGradeVisual, getPlayerTankColors, type AssetPack } from "./AssetPack";
import { renderGround, renderBrick, renderSteel, renderWall } from "../ui/MapVisual";
import { lightenColor, darkenColor } from "../ui/VisualTheme";

/** 离屏 canvas 工厂（兼容测试环境） */
function createCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  try {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  } catch {
    return null;
  }
}

class AssetCacheManager {
  /** 瓦片缓存：key = `${biome}:${tileType}:${variant}` */
  private tileCache = new Map<string, HTMLCanvasElement>();
  /** 坦克身体缓存：key = `${kind}:${id}`  kind=enemy|player */
  private tankCache = new Map<string, HTMLCanvasElement>();
  /** 当前缓存对应的资源包版本 */
  private cachedVersion = "";
  /** 缓存命中统计（调试用） */
  hits = 0;
  misses = 0;

  constructor() {
    // 资源包变化时自动失效缓存
    assetPack.subscribe(() => this.invalidate());
    this.cachedVersion = assetPack.getVersion();
  }

  /** 清空所有缓存（资源包变化时调用） */
  invalidate(): void {
    this.tileCache.clear();
    this.tankCache.clear();
    this.cachedVersion = assetPack.getVersion();
  }

  /** 获取缓存统计 */
  getStats(): { tiles: number; tanks: number; hits: number; misses: number; version: string } {
    return {
      tiles: this.tileCache.size,
      tanks: this.tankCache.size,
      hits: this.hits,
      misses: this.misses,
      version: this.cachedVersion,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  瓦片缓存
  // ═══════════════════════════════════════════════════════════

  /**
   * 获取瓦片素材（32×32）。
   * variant: 地面用 "alt0"/"alt1"（棋盘格），砖块用损伤状态
   */
  getTile(tileType: TileType, biome: BiomeId, variant = "base"): HTMLCanvasElement | null {
    const key = `${this.cachedVersion}:${biome}:${tileType}:${variant}`;
    const cached = this.tileCache.get(key);
    if (cached) { this.hits++; return cached; }
    this.misses++;

    const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    switch (tileType) {
      case TileType.Empty:
      case TileType.Base:
        renderGround(ctx, 0, 0, variant === "alt1" ? 1 : 0, 0, biome);
        break;
      case TileType.Brick:
        // 完整砖块（4 象限全满血）
        renderBrick(ctx, 0, 0, { type: TileType.Brick, hp: 4, maxHp: 4, quadHp: [1, 1, 1, 1] } as any, biome);
        break;
      case TileType.Steel:
        renderSteel(ctx, 0, 0, biome);
        break;
      case TileType.Wall:
        renderWall(ctx, 0, 0, 0, 0);
        break;
      case TileType.Water:
        this.renderWaterBase(ctx, biome);
        break;
      case TileType.Forest:
        this.renderForestBase(ctx, biome);
        break;
      case TileType.Ice:
        this.renderIceBase(ctx, biome);
        break;
      default:
        renderGround(ctx, 0, 0, 0, 0, biome);
    }

    this.tileCache.set(key, canvas);
    return canvas;
  }

  /** 水面基础层（缓存静态部分，波浪动画由调用方叠加） */
  private renderWaterBase(ctx: CanvasRenderingContext2D, biome: BiomeId): void {
    const c = getBiomeColors(biome);
    const grad = ctx.createLinearGradient(0, 0, 0, TILE_SIZE);
    grad.addColorStop(0, c.water);
    grad.addColorStop(1, c.waterDeep);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  }

  /** 森林基础层（缓存树，摇摆动画由调用方叠加） */
  private renderForestBase(ctx: CanvasRenderingContext2D, biome: BiomeId): void {
    const c = getBiomeColors(biome);
    // 底色
    ctx.fillStyle = c.ground;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    // 4 棵小树
    const trees = [[8, 8], [24, 10], [10, 24], [26, 22]];
    for (const [tx, ty] of trees) {
      ctx.fillStyle = c.forest;
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = c.forestLight;
      ctx.beginPath();
      ctx.arc(tx - 1, ty - 1, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 冰面基础层（缓存静态部分，闪光动画由调用方叠加） */
  private renderIceBase(ctx: CanvasRenderingContext2D, biome: BiomeId): void {
    const c = getBiomeColors(biome);
    const grad = ctx.createLinearGradient(0, 0, TILE_SIZE, TILE_SIZE);
    grad.addColorStop(0, c.iceLight);
    grad.addColorStop(0.5, c.ice);
    grad.addColorStop(1, c.iceLight);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    // 裂纹
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, 6); ctx.lineTo(14, 16); ctx.lineTo(10, 28);
    ctx.moveTo(20, 4); ctx.lineTo(26, 14); ctx.lineTo(22, 26);
    ctx.stroke();
  }

  // ═══════════════════════════════════════════════════════════
  //  坦克身体缓存
  // ═══════════════════════════════════════════════════════════

  /** 获取敌军坦克身体素材（按等级） */
  getEnemyTank(grade: string, size: number): HTMLCanvasElement | null {
    const key = `${this.cachedVersion}:enemy:${grade}:${size}`;
    const cached = this.tankCache.get(key);
    if (cached) { this.hits++; return cached; }
    this.misses++;

    const canvas = createCanvas(size, size);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const v = getGradeVisual(grade);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    this.drawTankBodyToCtx(ctx, v.bodyLight, v.bodyDark, v.trackColor, v.turretColor, v.accentColor, size, v.armorPlates, v.spikes);
    ctx.restore();

    this.tankCache.set(key, canvas);
    return canvas;
  }

  /** 获取玩家坦克身体素材（P1=0, P2=1） */
  getPlayerTank(playerId: number, size: number): HTMLCanvasElement | null {
    const key = `${this.cachedVersion}:player:${playerId}:${size}`;
    const cached = this.tankCache.get(key);
    if (cached) { this.hits++; return cached; }
    this.misses++;

    const canvas = createCanvas(size, size);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const c = getPlayerTankColors(playerId);
    ctx.save();
    ctx.translate(size / 2, size / 2);
    this.drawTankBodyToCtx(ctx, c.mainLight, c.mainDark, c.trackColor, c.turretDark, c.accent, size, 2, false);
    ctx.restore();

    this.tankCache.set(key, canvas);
    return canvas;
  }

  /**
   * 通用坦克身体绘制（预渲染用，不含旋转/动画/受击闪光）
   * 绘制顺序：履带 → 车身渐变 → 装甲板 → 炮塔 → 炮管
   */
  private drawTankBodyToCtx(
    ctx: CanvasRenderingContext2D,
    bodyLight: string, bodyDark: string,
    trackColor: string, turretColor: string, accent: string,
    size: number, armorPlates: number, spikes: boolean,
  ): void {
    const w = size, h = size;
    const half = w / 2;

    // 1. 履带（左右）
    ctx.fillStyle = trackColor;
    ctx.fillRect(-half, -half + 2, 5, h - 4);
    ctx.fillRect(half - 5, -half + 2, 5, h - 4);
    // 履带纹理
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    for (let i = 0; i < 4; i++) {
      const ty = -half + 4 + i * ((h - 8) / 4);
      ctx.fillRect(-half, ty, 5, 2);
      ctx.fillRect(half - 5, ty, 5, 2);
    }

    // 2. 车身主体（渐变）
    const bodyInset = 4;
    const bw = w - bodyInset * 2;
    const bh = h - bodyInset * 2;
    const bodyGrad = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
    bodyGrad.addColorStop(0, bodyLight);
    bodyGrad.addColorStop(0.5, lightenColor(bodyDark, 0.15));
    bodyGrad.addColorStop(1, bodyDark);
    ctx.fillStyle = bodyGrad;
    this.roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 3);
    ctx.fill();

    // 车身边缘高光
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    this.roundRect(ctx, -bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1, bh - 1, 3);
    ctx.stroke();

    // 3. 装甲板（横向条纹）
    if (armorPlates > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      for (let i = 0; i < armorPlates; i++) {
        const py = -bh / 2 + 5 + i * ((bh - 10) / Math.max(1, armorPlates));
        ctx.fillRect(-bw / 2 + 3, py, bw - 6, 2);
      }
    }

    // 4. 尖刺（A级以上）
    if (spikes) {
      ctx.fillStyle = accent;
      const spikePositions = [[-bw / 2, -bh / 4], [-bw / 2, bh / 4], [bw / 2, -bh / 4], [bw / 2, bh / 4]];
      for (const [sx, sy] of spikePositions) {
        ctx.beginPath();
        ctx.moveTo(sx, sy - 3);
        ctx.lineTo(sx + (sx < 0 ? -4 : 4), sy);
        ctx.lineTo(sx, sy + 3);
        ctx.fill();
      }
    }

    // 5. 炮塔（圆形）
    const turretR = bw * 0.32;
    const tGrad = ctx.createRadialGradient(-turretR * 0.3, -turretR * 0.3, 0, 0, 0, turretR);
    tGrad.addColorStop(0, lightenColor(turretColor, 0.2));
    tGrad.addColorStop(1, darkenColor(turretColor, 0.2));
    ctx.fillStyle = tGrad;
    ctx.beginPath();
    ctx.arc(0, 0, turretR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 6. 炮管（向前 = x正方向，与 TankVisual.drawBarrel 一致；Tank.render 中 ctx.rotate(angle) 后指向 facing）
    // v2.18 修复：原炮管画在 y负方向(上方)，旋转后与 facing 偏差90度，导致"侧面开火"视觉bug
    const barrelLen = half + 4;
    const barrelH = 5;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, -barrelH / 2, barrelLen, barrelH);
    ctx.fillStyle = "#333";
    ctx.fillRect(0.5, -barrelH / 2 + 0.5, barrelLen - 1, barrelH - 1);
    // 炮口制退器
    ctx.fillStyle = "#444";
    ctx.fillRect(barrelLen - 2, -barrelH / 2 - 1, 3, barrelH + 2);
    // 炮口开口
    ctx.fillStyle = "#000";
    ctx.fillRect(barrelLen + 0.5, -1.5, 1.5, 3);
  }

  /** 圆角矩形路径 */
  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

/** 全局单例 */
export const assetCache = new AssetCacheManager();
