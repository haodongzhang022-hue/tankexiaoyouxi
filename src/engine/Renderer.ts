//  Renderer.ts ─
// Thin wrapper around Canvas 2D context with helper draw methods.

export interface DrawTextOpts {
  font?: string;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
}

/** Renderer.resize 写入逻辑尺寸（CSS 像素坐标空间）的扩展画布 */
interface LogicalCanvas extends HTMLCanvasElement {
  __logicalW?: number;
  __logicalH?: number;
}

/**
 * 逻辑画布尺寸（CSS 像素坐标空间）。
 * v2.25 DPR 高清渲染后 canvas.width 是物理像素，鼠标/触摸坐标换算必须用本函数取逻辑尺寸。
 */
export function logicalCanvasSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const c = canvas as LogicalCanvas;
  return { w: c.__logicalW ?? canvas.width, h: c.__logicalH ?? canvas.height };
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** 逻辑尺寸（布局坐标系，见 resize） */
  private logicalW = 0;
  private logicalH = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D not supported");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
  }

  // v2.25 高清渲染：物理缓冲按 devicePixelRatio 放大（封顶 2.5），逻辑坐标系保持 w×h。
  // 修复：此前物理尺寸=逻辑尺寸，浏览器 CSS 缩放/手机高 DPI 屏下文字与线条发糊。
  resize(w: number, h: number): void {
    const dpr = Math.max(1, Math.min(2.5,
      (typeof window !== "undefined" && window.devicePixelRatio) || 1));
    this.logicalW = w;
    this.logicalH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    (this.canvas as LogicalCanvas).__logicalW = w;
    (this.canvas as LogicalCanvas).__logicalH = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  clear(color = "#000"): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.logicalW || this.canvas.width, this.logicalH || this.canvas.height);
  }

  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  strokeRect(x: number, y: number, w: number, h: number, color: string, lineWidth = 1): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  fillCircle(x: number, y: number, r: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawLine(x1: number, y1: number, x2: number, y2: number, color: string, lineWidth = 1): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
    this.ctx.stroke();
  }

  drawText(text: string, x: number, y: number, opts: DrawTextOpts = {}): void {
    this.ctx.font = opts.font ?? "12px monospace";
    this.ctx.fillStyle = opts.color ?? "#fff";
    this.ctx.textAlign = opts.align ?? "left";
    this.ctx.textBaseline = opts.baseline ?? "top";
    this.ctx.fillText(text, x, y);
  }

  // Draw a sprite (image)  pass null to draw a colored rect placeholder
  drawSprite(img: HTMLImageElement | null, sx: number, sy: number, sw: number, sh: number,
             dx: number, dy: number, dw: number, dh: number): void {
    if (img) {
      this.ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    } else {
      this.ctx.fillStyle = "#f0f";
      this.ctx.fillRect(dx, dy, dw, dh);
    }
  }

  // Draw a rotated rect (for tanks). cx/cy = center, angle in radians.
  drawRotatedRect(cx: number, cy: number, w: number, h: number, angle: number, color: string): void {
    this.ctx.save();
    this.ctx.translate(cx, cy);
    this.ctx.rotate(angle);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(-w / 2, -h / 2, w, h);
    this.ctx.restore();
  }

  // Blinking: returns true every other `interval` ms
  blink(now: number, interval = 200): boolean {
    return Math.floor(now / interval) % 2 === 0;
  }

  get width(): number { return this.logicalW || this.canvas.width; }
  get height(): number { return this.logicalH || this.canvas.height; }
}
