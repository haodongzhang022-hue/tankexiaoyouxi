// VisualTheme.ts - 美化主题核心模块
// 以"新增+修改指向"方式提供美化后的绘制工具，不删除原有绘制逻辑。
// 所有函数均为纯绘制，不改变游戏逻辑。

import type { Renderer } from "../engine/Renderer";

// ═══════════════════════════════════════════════════════════
//  颜色主题 —— 科技军事风：深蓝底 + 霓虹青/金 强调
// ═══════════════════════════════════════════════════════════
export const THEME = {
  // 背景
  bgDeep: "#05070d",
  bgPanel: "rgba(10, 14, 28, 0.94)",
  bgPanelLight: "rgba(18, 24, 44, 0.94)",
  bgSlot: "#0e1220",
  bgSlotHover: "#161c30",

  // 边框
  borderDim: "#1e2840",
  borderNormal: "#2e3d5c",
  borderBright: "#4a6a9e",
  borderCyan: "#00d4ff",
  borderGold: "#ffd700",
  borderGreen: "#39d94a",
  borderRed: "#ff4444",

  // 文字
  textPrimary: "#e8eef7",
  textSecondary: "#8a9bb8",
  textDim: "#556680",
  textGold: "#ffd700",
  textCyan: "#00d4ff",
  textGreen: "#39d94a",
  textRed: "#ff6666",

  // 渐变用色
  gradPanelTop: "#141b30",
  gradPanelBottom: "#0a0e1c",
  gradButtonTop: "#1a2540",
  gradButtonBottom: "#0e1428",
  gradButtonActiveTop: "#243560",
  gradButtonActiveBottom: "#162040",

  // 品质色
  qualityWhite: "#c8d0e0",
  qualityBlue: "#4a9eff",
  qualityGold: "#ffd700",
  qualityGreen: "#39d94a",
  qualityPurple: "#c060ff",
  qualityRed: "#ff5050",
} as const;

// ═══════════════════════════════════════════════════════════
//  通用工具
// ═══════════════════════════════════════════════════════════

/** 创建线性渐变（垂直方向）；测试环境不支持时回退为纯色字符串 */
export function verticalGradient(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  top: string, bottom: string,
): CanvasGradient | string {
  if (typeof ctx.createLinearGradient !== "function") return top;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  return g;
}

/** 创建线性渐变（水平方向）；测试环境不支持时回退为纯色字符串 */
export function horizontalGradient(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  left: string, right: string,
): CanvasGradient | string {
  if (typeof ctx.createLinearGradient !== "function") return left;
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, left);
  g.addColorStop(1, right);
  return g;
}

/** 绘制带发光的文字 */
export function drawGlowText(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number,
  opts: {
    font?: string;
    color?: string;
    align?: CanvasTextAlign;
    baseline?: CanvasTextBaseline;
    glowColor?: string;
    glowBlur?: number;
  } = {},
): void {
  ctx.save();
  ctx.font = opts.font ?? "12px monospace";
  ctx.fillStyle = opts.color ?? "#fff";
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = opts.baseline ?? "top";
  if (opts.glowColor && opts.glowBlur) {
    ctx.shadowColor = opts.glowColor;
    ctx.shadowBlur = opts.glowBlur;
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  美化面板 —— 渐变背景 + 双层边框 + 角落装饰
// ═══════════════════════════════════════════════════════════
export interface PanelOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 边框颜色，默认霓虹蓝 */
  borderColor?: string;
  /** 边框宽度，默认1 */
  borderWidth?: number;
  /** 是否显示角落装饰（科技感），默认true */
  corners?: boolean;
  /** 背景透明度覆盖，默认使用主题色 */
  bgOverride?: string;
}

export function drawThemedPanel(
  ctx: CanvasRenderingContext2D,
  opts: PanelOpts,
): void {
  const { x, y, w, h } = opts;
  const borderColor = opts.borderColor ?? THEME.borderBright;
  const borderWidth = opts.borderWidth ?? 1;

  // 渐变背景
  ctx.fillStyle = opts.bgOverride ?? verticalGradient(
    ctx, x, y, w, h, THEME.gradPanelTop, THEME.gradPanelBottom,
  );
  ctx.fillRect(x, y, w, h);

  // 内层微光（顶部高光线）
  ctx.fillStyle = "rgba(100, 160, 255, 0.06)";
  ctx.fillRect(x, y, w, Math.min(3, h * 0.1));

  // 边框
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = borderWidth;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  // 内层细边框（增加层次感）
  if (w > 20 && h > 20) {
    ctx.strokeStyle = "rgba(80, 120, 180, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
  }

  // 角落装饰（科技感L型角标）
  if (opts.corners !== false && w > 30 && h > 30) {
    const cLen = Math.min(10, w * 0.08, h * 0.12);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    // 左上
    ctx.beginPath();
    ctx.moveTo(x, y + cLen); ctx.lineTo(x, y); ctx.lineTo(x + cLen, y);
    ctx.stroke();
    // 右上
    ctx.beginPath();
    ctx.moveTo(x + w - cLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + cLen);
    ctx.stroke();
    // 左下
    ctx.beginPath();
    ctx.moveTo(x, y + h - cLen); ctx.lineTo(x, y + h); ctx.lineTo(x + cLen, y + h);
    ctx.stroke();
    // 右下
    ctx.beginPath();
    ctx.moveTo(x + w - cLen, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - cLen);
    ctx.stroke();
  }
}

// ═══════════════════════════════════════════════════════════
//  美化按钮 —— 渐变 + 边框光效 + 选中态
// ═══════════════════════════════════════════════════════════
export interface ButtonOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  active?: boolean;
  disabled?: boolean;
  /** 主色调，默认蓝 */
  color?: string;
  fontSize?: number;
  /** 圆角半径，默认4 */
  radius?: number;
}

export function drawThemedButton(
  ctx: CanvasRenderingContext2D,
  opts: ButtonOpts,
): void {
  const { x, y, w, h, label } = opts;
  const active = opts.active ?? false;
  const disabled = opts.disabled ?? false;
  const color = opts.color ?? THEME.borderCyan;
  const fontSize = opts.fontSize ?? 12;
  const radius = opts.radius ?? 4;

  ctx.save();

  // 圆角路径
  const r = Math.min(radius, w / 2, h / 2);
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

  // 渐变背景
  if (disabled) {
    ctx.fillStyle = "#11141c";
  } else if (active) {
    ctx.fillStyle = verticalGradient(ctx, x, y, w, h, THEME.gradButtonActiveTop, THEME.gradButtonActiveBottom);
  } else {
    ctx.fillStyle = verticalGradient(ctx, x, y, w, h, THEME.gradButtonTop, THEME.gradButtonBottom);
  }
  ctx.fill();

  // 顶部高光线
  if (!disabled) {
    ctx.fillStyle = active ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)";
    ctx.fillRect(x + r, y + 1, w - r * 2, 1);
  }

  // 边框
  ctx.strokeStyle = disabled ? "#222" : (active ? color : THEME.borderNormal);
  ctx.lineWidth = active ? 2 : 1;
  ctx.stroke();

  // 选中态发光
  if (active && !disabled) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // 文字
  ctx.fillStyle = disabled ? "#444" : (active ? THEME.textPrimary : THEME.textSecondary);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (active && !disabled) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;
  }
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  美化槽位 —— 内阴影 + 品质边框光效
// ═══════════════════════════════════════════════════════════
export interface SlotOpts {
  x: number;
  y: number;
  size: number;
  /** 品质：white/blue/gold，影响边框光效 */
  quality?: string;
  selected?: boolean;
  hover?: boolean;
  /** 自定义边框色 */
  borderColor?: string;
}

export function drawThemedSlot(
  ctx: CanvasRenderingContext2D,
  opts: SlotOpts,
): void {
  const { x, y, size } = opts;
  const quality = opts.quality ?? "white";
  const selected = opts.selected ?? false;
  const hover = opts.hover ?? false;

  // 品质色映射
  const qColors: Record<string, string> = {
    white: THEME.qualityWhite,
    blue: THEME.qualityBlue,
    gold: THEME.qualityGold,
    green: THEME.qualityGreen,
    purple: THEME.qualityPurple,
    red: THEME.qualityRed,
  };
  const qColor = qColors[quality] ?? THEME.qualityWhite;

  // 背景（内凹感）
  ctx.fillStyle = selected ? "#1a2240" : (hover ? THEME.bgSlotHover : THEME.bgSlot);
  ctx.fillRect(x, y, size, size);

  // 内阴影（顶部和左侧暗边）
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(x, y, size, 1);
  ctx.fillRect(x, y, 1, size);
  // 内高光（底部和右侧亮边）
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(x, y + size - 1, size, 1);
  ctx.fillRect(x + size - 1, y, 1, size);

  // 边框
  if (selected) {
    ctx.strokeStyle = THEME.textGold;
    ctx.lineWidth = 2;
    ctx.shadowColor = THEME.textGold;
    ctx.shadowBlur = 6;
    ctx.strokeRect(x + 1, y + 1, size - 2, size - 2);
    ctx.shadowBlur = 0;
  } else if (opts.borderColor) {
    ctx.strokeStyle = opts.borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  } else {
    ctx.strokeStyle = THEME.borderNormal;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }

  // 品质角标（右上角小三角）
  if (quality !== "white" && size > 20) {
    const tri = Math.min(6, size * 0.15);
    ctx.fillStyle = qColor;
    ctx.beginPath();
    ctx.moveTo(x + size - tri, y);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x + size, y + tri);
    ctx.closePath();
    ctx.fill();
  }
}

// ═══════════════════════════════════════════════════════════
//  美化进度条 —— 渐变 + 条纹动画 + 发光
// ═══════════════════════════════════════════════════════════
export interface ProgressBarOpts {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0~1 */
  value: number;
  /** 颜色，默认根据value自动（绿/黄/红） */
  color?: string;
  /** 背景色 */
  bgColor?: string;
  /** 是否显示条纹动画，默认false */
  striped?: boolean;
  /** 动画时间戳（用于条纹移动），striped时需要 */
  now?: number;
  /** 是否发光，默认true */
  glow?: boolean;
  /** 边框色 */
  borderColor?: string;
}

export function drawThemedProgressBar(
  ctx: CanvasRenderingContext2D,
  opts: ProgressBarOpts,
): void {
  const { x, y, w, h } = opts;
  const value = Math.max(0, Math.min(1, opts.value));
  const autoColor = value > 0.5 ? "#39d94a" : value > 0.25 ? "#ffaa00" : "#ff4444";
  const color = opts.color ?? autoColor;
  const bgColor = opts.bgColor ?? "#1a0a0a";
  const glow = opts.glow ?? true;
  const borderColor = opts.borderColor ?? "#333";

  // 背景
  ctx.fillStyle = bgColor;
  ctx.fillRect(x, y, w, h);

  // 背景内阴影
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);

  if (value > 0) {
    const fillW = w * value;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, fillW, h);
    ctx.clip();

    // 渐变填充
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, lightenColor(color, 0.3));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, darkenColor(color, 0.2));
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, fillW, h);

    // 顶部高光线
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(x, y, fillW, Math.max(1, h * 0.2));

    // 条纹动画
    if (opts.striped && opts.now !== undefined) {
      const stripeW = 6;
      const offset = (opts.now / 40) % (stripeW * 2);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      for (let sx = x - offset - stripeW; sx < x + fillW; sx += stripeW * 2) {
        ctx.fillRect(sx, y, stripeW, h);
      }
    }

    // 发光
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(x, y, fillW, h);
    }

    ctx.restore();
  }

  // 边框
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** 颜色变亮 */
export function lightenColor(hex: string, amount: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const r = Math.min(255, Math.round(c.r + (255 - c.r) * amount));
  const g = Math.min(255, Math.round(c.g + (255 - c.g) * amount));
  const b = Math.min(255, Math.round(c.b + (255 - c.b) * amount));
  return `rgb(${r},${g},${b})`;
}

/** 颜色变暗 */
export function darkenColor(hex: string, amount: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  const r = Math.max(0, Math.round(c.r * (1 - amount)));
  const g = Math.max(0, Math.round(c.g * (1 - amount)));
  const b = Math.max(0, Math.round(c.b * (1 - amount)));
  return `rgb(${r},${g},${b})`;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(hex);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  return null;
}

// ═══════════════════════════════════════════════════════════
//  美化标题栏 —— 带图标和装饰线的面板标题
// ═══════════════════════════════════════════════════════════
export function drawThemedTitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number, y: number,
  opts: {
    color?: string;
    fontSize?: number;
    width?: number;
    align?: "left" | "center";
  } = {},
): void {
  const color = opts.color ?? THEME.textGold;
  const fontSize = opts.fontSize ?? 12;
  const width = opts.width ?? 120;
  const align = opts.align ?? "left";

  ctx.save();
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.shadowColor = color;
  ctx.shadowBlur = 4;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;

  // 装饰线
  const textW = ctx.measureText(text).width;
  const lineY = y + fontSize + 2;
  if (align === "center") {
    const lineW = Math.max(width, textW + 20);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x - lineW / 2, lineY);
    ctx.lineTo(x - textW / 2 - 6, lineY);
    ctx.moveTo(x + textW / 2 + 6, lineY);
    ctx.lineTo(x + lineW / 2, lineY);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(x + textW + 8, lineY);
    ctx.lineTo(x + Math.max(width, textW + 20), lineY);
    ctx.stroke();
    // 端点
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x + Math.max(width, textW + 20) - 2, lineY - 1, 3, 3);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  扫描线效果 —— 科技感背景装饰
// ═══════════════════════════════════════════════════════════
export function drawScanlines(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  now: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // 水平扫描线移动
  const scanY = y + ((now / 30) % h);
  const grad = ctx.createLinearGradient(x, scanY - 20, x, scanY + 20);
  grad.addColorStop(0, "rgba(0, 212, 255, 0)");
  grad.addColorStop(0.5, "rgba(0, 212, 255, 0.06)");
  grad.addColorStop(1, "rgba(0, 212, 255, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(x, scanY - 20, w, 40);

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  网格背景 —— 科技感底纹
// ═══════════════════════════════════════════════════════════
export function drawGridBackground(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  gridSize = 32,
): void {
  ctx.save();
  ctx.strokeStyle = "rgba(60, 100, 160, 0.08)";
  ctx.lineWidth = 1;
  for (let gx = x; gx <= x + w; gx += gridSize) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
    ctx.stroke();
  }
  for (let gy = y; gy <= y + h; gy += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
    ctx.stroke();
  }
  ctx.restore();
}
