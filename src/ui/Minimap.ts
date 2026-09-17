// Minimap.ts - Top-right minimap showing enemy/player/base positions
import type { Renderer } from "../engine/Renderer";
import { THEME, verticalGradient } from "./VisualTheme";

export interface MinimapTarget {
  x: number;
  y: number;
  color: string;
  size?: number;
}

export class Minimap {
  private worldW: number;
  private worldH: number;
  private viewW: number;
  private mapW: number = 154;   // 横屏小地图宽（v2.18 扩大40%: 110→154）
  private mapH: number = 123;
  /** 竖屏标志（世界高>宽）：竖屏用小尺寸半透明覆盖右上角，避免撑爆/遮挡底部信息栏 */
  private portrait: boolean = false;
  private padX: number = 8;
  private padY: number = 8;

  constructor(viewW: number, viewH: number, worldW: number, worldH: number) {
    this.viewW = viewW;
    this.worldW = worldW;
    this.worldH = worldH;
    const aspect = worldH / worldW;
    this.portrait = aspect > 1;
    if (this.portrait) {
      // 竖屏：限制高度（约132px），宽度按世界宽高比缩放（≈79px），右上角小窗覆盖
      this.mapH = 132;
      this.mapW = Math.round(this.mapH / aspect);
    } else {
      // 横屏：固定宽 154，高按宽高比
      this.mapW = 154;
      this.mapH = Math.round(this.mapW * aspect);
    }
  }

  /** 小地图外形尺寸（供外部锚定位置用） */
  get size(): { w: number; h: number } { return { w: this.mapW, h: this.mapH }; }

  /** 是否竖屏小窗模式（外部据此选锚点/透明度） */
  get isPortrait(): boolean { return this.portrait; }

  /**
   * Render minimap. players/enemies/base are world-space positions with colors.
   * anchor 可选：小地图左上角在画布上的位置；缺省 = 画布(viewW)右上角。
   */
  render(renderer: Renderer, points: MinimapTarget[], anchor?: { x: number; y: number }): void {
    const { ctx } = renderer;
    const mx = anchor?.x ?? (this.viewW - this.mapW - this.padX);
    const my = anchor?.y ?? this.padY;
    const now = performance.now();

    // 竖屏小窗覆盖在游戏区上：整体半透明，透出后方战场减少遮挡感
    ctx.save();
    if (this.portrait) ctx.globalAlpha = 0.82;

    // 外层面板（渐变 + 边框）——地图内容直接顶到边框，无内边距，左上角与实际地图对齐
    const panelX = mx, panelY = my;
    const panelW = this.mapW, panelH = this.mapH;
    ctx.fillStyle = verticalGradient(ctx, panelX, panelY, panelW, panelH, "#141b30", "#0a0e1c");
    ctx.fillRect(panelX, panelY, panelW, panelH);
    // 加粗外边框（2px 亮色 + 1px 描边），更醒目
    ctx.strokeStyle = THEME.borderBright;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX + 1, panelY + 1, panelW - 2, panelH - 2);
    ctx.strokeStyle = THEME.borderNormal;
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1);
    // 左上角装饰
    ctx.fillStyle = THEME.textCyan;
    ctx.fillRect(panelX, panelY, 6, 2);
    ctx.fillRect(panelX, panelY, 2, 6);

    // 地图区域（深色，填充整个面板内部）
    const innerX = panelX + 2, innerY = panelY + 2;
    const innerW = panelW - 4, innerH = panelH - 4;
    ctx.fillStyle = "#0a0e18";
    ctx.fillRect(innerX, innerY, innerW, innerH);

    // 网格线（用 fillRect 绘制 1px 线，兼容测试环境）
    ctx.fillStyle = "rgba(60, 100, 160, 0.1)";
    const gridSize = innerW / 5;
    for (let gx = innerX; gx <= innerX + innerW; gx += gridSize) {
      ctx.fillRect(gx, innerY, 1, innerH);
    }
    for (let gy = innerY; gy <= innerY + innerH; gy += gridSize) {
      ctx.fillRect(innerX, gy, innerW, 1);
    }

    // 扫描线动画（用 fillRect 渐变条，兼容测试环境）
    const scanY = innerY + ((now / 40) % innerH);
    if (typeof ctx.createLinearGradient === "function") {
      const scanGrad = ctx.createLinearGradient(innerX, scanY - 10, innerX, scanY + 10);
      scanGrad.addColorStop(0, "rgba(0, 212, 255, 0)");
      scanGrad.addColorStop(0.5, "rgba(0, 212, 255, 0.08)");
      scanGrad.addColorStop(1, "rgba(0, 212, 255, 0)");
      ctx.fillStyle = scanGrad;
    } else {
      ctx.fillStyle = "rgba(0, 212, 255, 0.05)";
    }
    ctx.fillRect(innerX, scanY - 10, innerW, 20);

    // World border (visual map bounds)
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.strokeRect(innerX + 0.5, innerY + 0.5, innerW - 1, innerH - 1);

    // Draw points（带发光）——坐标映射到内部区域
    for (const pt of points) {
      const sx = innerX + (pt.x / this.worldW) * innerW;
      const sy = innerY + (pt.y / this.worldH) * innerH;
      const s = pt.size ?? 3;
      // 发光
      ctx.save();
      ctx.shadowColor = pt.color;
      ctx.shadowBlur = 4;
      ctx.fillStyle = pt.color;
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
      ctx.restore();
    }

    // "MAP" 标签
    ctx.save();
    ctx.font = "bold 7px monospace";
    ctx.fillStyle = "rgba(0,212,255,0.5)";
    ctx.textAlign = "left";
    ctx.fillText("MAP", panelX + 4, panelY + panelH - 4);
    ctx.restore();

    ctx.restore(); // 竖屏半透明覆盖层的整体 alpha
  }
}
