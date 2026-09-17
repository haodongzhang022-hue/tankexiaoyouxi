// MenuVisual.ts - 菜单/界面美化模块
// 提供主菜单、暂停、设置、联机大厅等界面的美化绘制组件。
// 以"新增+修改指向"方式工作，原有逻辑保留，仅替换视觉绘制。

import type { Renderer } from "../engine/Renderer";
import {
  THEME, drawThemedPanel, drawThemedButton, drawThemedTitle,
  drawGridBackground, drawScanlines, verticalGradient,
} from "./VisualTheme";

// 重新导出，方便外部从 MenuVisual 统一导入
export { drawThemedTitle, drawThemedPanel, drawThemedButton, THEME };

// ═══════════════════════════════════════════════════════════
//  菜单背景 —— 深色渐变 + 网格 + 扫描线 + 装饰角标
// ═══════════════════════════════════════════════════════════
export function drawMenuBackground(
  renderer: Renderer,
  W: number, H: number,
  now: number,
): void {
  const { ctx } = renderer;

  // 深色渐变背景
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#080c18");
  bg.addColorStop(0.5, "#050810");
  bg.addColorStop(1, "#0a0e1a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 网格底纹
  drawGridBackground(ctx, 0, 0, W, H, 40);

  // 扫描线
  drawScanlines(ctx, 0, 0, W, H, now);

  // 顶部/底部装饰条
  const topGrad = ctx.createLinearGradient(0, 0, W, 0);
  topGrad.addColorStop(0, "rgba(0,212,255,0)");
  topGrad.addColorStop(0.3, "rgba(0,212,255,0.4)");
  topGrad.addColorStop(0.5, "rgba(255,215,0,0.5)");
  topGrad.addColorStop(0.7, "rgba(0,212,255,0.4)");
  topGrad.addColorStop(1, "rgba(0,212,255,0)");
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, 2);
  ctx.fillRect(0, H - 2, W, 2);

  // 四角装饰（科技感L型）
  const cornerLen = Math.min(30, W * 0.04);
  ctx.strokeStyle = "rgba(0,212,255,0.35)";
  ctx.lineWidth = 2;
  // 左上
  ctx.beginPath();
  ctx.moveTo(8, 8 + cornerLen); ctx.lineTo(8, 8); ctx.lineTo(8 + cornerLen, 8);
  ctx.stroke();
  // 右上
  ctx.beginPath();
  ctx.moveTo(W - 8 - cornerLen, 8); ctx.lineTo(W - 8, 8); ctx.lineTo(W - 8, 8 + cornerLen);
  ctx.stroke();
  // 左下
  ctx.beginPath();
  ctx.moveTo(8, H - 8 - cornerLen); ctx.lineTo(8, H - 8); ctx.lineTo(8 + cornerLen, H - 8);
  ctx.stroke();
  // 右下
  ctx.beginPath();
  ctx.moveTo(W - 8 - cornerLen, H - 8); ctx.lineTo(W - 8, H - 8); ctx.lineTo(W - 8, H - 8 - cornerLen);
  ctx.stroke();
}

// ═══════════════════════════════════════════════════════════
//  游戏标题 —— 带发光和副标题
// ═══════════════════════════════════════════════════════════
export function drawGameTitle(
  renderer: Renderer,
  W: number,
  titleY: number,
  subtitle?: string,
): void {
  const { ctx } = renderer;

  // 标题装饰线（左右）
  const title = "坦克大战  深度版";
  ctx.font = `bold ${W > 700 ? 34 : 26}px monospace`;
  const titleW = ctx.measureText(title).width;
  const lineY = titleY + 8;
  const lineLen = Math.max(40, (W - titleW) / 2 - 30);

  ctx.strokeStyle = "rgba(255,215,0,0.4)";
  ctx.lineWidth = 1;
  // 左线
  ctx.beginPath();
  ctx.moveTo(W / 2 - titleW / 2 - 20, lineY);
  ctx.lineTo(W / 2 - titleW / 2 - 20 - lineLen, lineY);
  ctx.stroke();
  // 右线
  ctx.beginPath();
  ctx.moveTo(W / 2 + titleW / 2 + 20, lineY);
  ctx.lineTo(W / 2 + titleW / 2 + 20 + lineLen, lineY);
  ctx.stroke();
  // 端点
  ctx.fillStyle = "rgba(255,215,0,0.6)";
  ctx.fillRect(W / 2 - titleW / 2 - 20 - lineLen - 2, lineY - 2, 4, 4);
  ctx.fillRect(W / 2 + titleW / 2 + 20 + lineLen - 2, lineY - 2, 4, 4);

  // 主标题（金色发光）
  ctx.save();
  ctx.font = `bold ${W > 700 ? 34 : 26}px monospace`;
  ctx.fillStyle = THEME.textGold;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(255,215,0,0.6)";
  ctx.shadowBlur = 12;
  ctx.fillText(title, W / 2, titleY);
  ctx.restore();

  // 副标题
  if (subtitle) {
    ctx.save();
    ctx.font = "13px monospace";
    ctx.fillStyle = THEME.textSecondary;
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,212,255,0.3)";
    ctx.shadowBlur = 4;
    ctx.fillText(subtitle, W / 2, titleY + (W > 700 ? 42 : 34));
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════
//  菜单选项行 —— 美化后的按钮
// ═══════════════════════════════════════════════════════════
export interface MenuOption {
  label: string;
  subLabel?: string;
  icon?: string;
}

export function drawMenuOption(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  opt: MenuOption,
  selected: boolean,
  index: number,
): void {
  // 背景
  if (selected) {
    const grad = verticalGradient(ctx, x, y, w, h, "#1a2548", "#0e1528");
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = "rgba(12,16,28,0.8)";
  }
  ctx.fillRect(x, y, w, h);

  // 选中态：左侧指示条
  if (selected) {
    const barGrad = ctx.createLinearGradient(x, y, x + 4, y);
    barGrad.addColorStop(0, THEME.textGold);
    barGrad.addColorStop(1, "rgba(255,215,0,0.2)");
    ctx.fillStyle = barGrad;
    ctx.fillRect(x, y + 4, 4, h - 8);

    // 发光边框
    ctx.strokeStyle = THEME.textGold;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = THEME.textGold;
    ctx.shadowBlur = 8;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.shadowBlur = 0;
  } else {
    ctx.strokeStyle = THEME.borderDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // 顶部高光线
  ctx.fillStyle = selected ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)";
  ctx.fillRect(x + 1, y + 1, w - 2, 1);

  // 序号（左侧）
  ctx.save();
  ctx.font = "bold 11px monospace";
  ctx.fillStyle = selected ? "rgba(255,215,0,0.6)" : "rgba(100,120,160,0.4)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`0${index + 1}`, x + 12, y + h / 2);
  ctx.restore();

  // 图标
  let textX = x + 36;
  if (opt.icon) {
    ctx.save();
    ctx.font = "16px monospace";
    ctx.fillStyle = selected ? THEME.textCyan : THEME.textDim;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(opt.icon, x + 34, y + h / 2);
    ctx.restore();
    textX = x + 56;
  }

  // 主标签
  ctx.save();
  ctx.font = selected ? "bold 14px monospace" : "13px monospace";
  ctx.fillStyle = selected ? THEME.textPrimary : THEME.textSecondary;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (selected) {
    ctx.shadowColor = "rgba(255,255,255,0.3)";
    ctx.shadowBlur = 4;
  }
  ctx.fillText(opt.label, textX, y + h / 2 - (opt.subLabel ? 6 : 0));
  ctx.restore();

  // 副标签
  if (opt.subLabel) {
    ctx.save();
    ctx.font = "10px monospace";
    ctx.fillStyle = selected ? THEME.textCyan : THEME.textDim;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(opt.subLabel, textX, y + h / 2 + 9);
    ctx.restore();
  }

  // 选中箭头（右侧）
  if (selected) {
    ctx.save();
    ctx.font = "bold 14px monospace";
    ctx.fillStyle = THEME.textGold;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.shadowColor = THEME.textGold;
    ctx.shadowBlur = 6;
    ctx.fillText("▶", x + w - 14, y + h / 2);
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════
//  暂停界面
// ═══════════════════════════════════════════════════════════
export function drawPauseOverlay(
  renderer: Renderer,
  W: number, H: number,
): void {
  const { ctx } = renderer;

  // 半透明遮罩
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, W, H);

  // 面板
  const pw = 320, ph = 210;
  const px = (W - pw) / 2, py = (H - ph) / 2;
  drawThemedPanel(ctx, {
    x: px, y: py, w: pw, h: ph,
    borderColor: THEME.borderGold,
    borderWidth: 2,
  });

  // 标题
  ctx.save();
  ctx.font = "bold 24px monospace";
  ctx.fillStyle = THEME.textGold;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.shadowColor = THEME.textGold;
  ctx.shadowBlur = 10;
  ctx.fillText("游 戏 暂 停", W / 2, py + 24);
  ctx.restore();

  // 装饰线
  ctx.strokeStyle = "rgba(255,215,0,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 30, py + 60);
  ctx.lineTo(px + pw - 30, py + 60);
  ctx.stroke();

  // 选项列表
  const options = [
    { label: "继续游戏", key: "ESC", color: THEME.textGreen },
    { label: "打开设置", key: "S", color: THEME.textCyan },
    { label: "返回菜单", key: "Enter", color: THEME.textSecondary },
    { label: "全屏 / 缩放", key: "O / -/+", color: THEME.textDim },
  ];
  options.forEach((opt, i) => {
    const oy = py + 78 + i * 28;
    // 选项行背景
    ctx.fillStyle = i === 0 ? "rgba(57,217,74,0.08)" : "transparent";
    ctx.fillRect(px + 16, oy - 4, pw - 32, 22);

    ctx.save();
    ctx.font = "14px monospace";
    ctx.fillStyle = opt.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(opt.label, px + 28, oy + 6);
    ctx.restore();

    // 按键提示
    ctx.save();
    ctx.font = "11px monospace";
    ctx.fillStyle = THEME.textDim;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`[${opt.key}]`, px + pw - 28, oy + 6);
    ctx.restore();
  });
}

// ═══════════════════════════════════════════════════════════
//  设置行（美化后的设置菜单项）
// ═══════════════════════════════════════════════════════════
export function drawSettingsRow(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string,
  value: string,
  selected: boolean,
  isReturn: boolean = false,
  valueBar?: { value: number; max: number },
): void {
  // 背景
  if (selected) {
    ctx.fillStyle = verticalGradient(ctx, x, y, w, h, "#1a2548", "#0e1528");
  } else {
    ctx.fillStyle = "rgba(14,18,32,0.8)";
  }
  ctx.fillRect(x, y, w, h);

  // 边框
  if (selected) {
    ctx.strokeStyle = THEME.textGold;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = THEME.textGold;
    ctx.shadowBlur = 6;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.shadowBlur = 0;
  } else {
    ctx.strokeStyle = THEME.borderDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // 顶部高光
  ctx.fillStyle = selected ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.02)";
  ctx.fillRect(x + 1, y + 1, w - 2, 1);

  // 标签
  ctx.save();
  ctx.font = "14px monospace";
  ctx.fillStyle = selected ? THEME.textPrimary : THEME.textSecondary;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  if (selected) {
    ctx.shadowColor = "rgba(255,255,255,0.2)";
    ctx.shadowBlur = 3;
  }
  ctx.fillText(label, x + 16, y + h / 2);
  ctx.restore();

  // 值（或音量条）
  if (valueBar) {
    const barW = 150, barH = 6;
    const bx = x + w - 16 - barW;
    const by = y + h / 2 - barH / 2;
    // 背景
    ctx.fillStyle = "#1a1a2a";
    ctx.fillRect(bx, by, barW, barH);
    // 填充
    const frac = valueBar.value / valueBar.max;
    const fillGrad = ctx.createLinearGradient(bx, by, bx, by + barH);
    fillGrad.addColorStop(0, "#6ab8ff");
    fillGrad.addColorStop(1, "#3a78df");
    ctx.fillStyle = fillGrad;
    ctx.fillRect(bx, by, barW * frac, barH);
    // 边框
    ctx.strokeStyle = THEME.borderNormal;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);
    // 数值文字
    ctx.save();
    ctx.font = "12px monospace";
    ctx.fillStyle = THEME.textCyan;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(value, bx - 8, y + h / 2);
    ctx.restore();
  } else {
    ctx.save();
    ctx.font = isReturn ? "14px monospace" : "bold 14px monospace";
    ctx.fillStyle = isReturn ? THEME.textDim : (selected ? THEME.textCyan : "#4a7abf");
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(value, x + w - 16, y + h / 2);
    ctx.restore();

    // 可修改项的左右箭头
    if (!isReturn && selected) {
      ctx.save();
      ctx.font = "10px monospace";
      ctx.fillStyle = THEME.textGold;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("◀ ▶", x + w - 16 - ctx.measureText(value).width - 12, y + h / 2);
      ctx.restore();
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  底部提示栏
// ═══════════════════════════════════════════════════════════
export function drawHintBar(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  hints: string[],
): void {
  const barH = hints.length * 16 + 12;
  const y = H - barH;

  // 背景渐变
  const grad = ctx.createLinearGradient(0, y, 0, H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.3, "rgba(0,0,0,0.6)");
  grad.addColorStop(1, "rgba(0,0,0,0.85)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, y, W, barH);

  hints.forEach((hint, i) => {
    ctx.save();
    ctx.font = `${i === 0 ? 11 : 10}px monospace`;
    ctx.fillStyle = i === 0 ? THEME.textSecondary : THEME.textDim;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(hint, W / 2, y + 6 + i * 16);
    ctx.restore();
  });
}
