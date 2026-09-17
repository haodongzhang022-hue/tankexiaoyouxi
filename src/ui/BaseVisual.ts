// BaseVisual.ts - 基地美化绘制模块
// v2.16 护墙改为逐块渲染独立小砖（每面 8 块 16×16），每块有独立血量/损伤状态。
// 主机端 Base.render() 和成员端 RemoteView.renderBase() 都调用本模块，
// 确保联机版本一致，杜绝两套渲染逻辑产生分歧。

import { TILE_SIZE } from "../game/Tilemap";
import type { BaseBrick, BaseSide } from "../game/Base";

// ═══════════════════════════════════════════════════════════
//  基地渲染参数（主机端 Base 和成员端 NetBase 都能映射到这个结构）
// ═══════════════════════════════════════════════════════════
export interface BaseVisualParams {
  x: number;
  y: number;
  eagleHp: number;
  eagleMaxHp: number;
  isDestroyed: boolean;
  /** 面级聚合（兼容旧字段，UI 汇总用；渲染以 bricks 为准） */
  walls?: Array<{ side: string; hp: number; maxHp: number }>;
  /** v2.16 独立小砖列表（每面 8 块，逐块渲染） */
  bricks?: Array<{ side: string; index: number; hp: number; maxHp: number; x: number; y: number; w: number; h: number }>;
  /** 修复闪光（可选，主机端有，成员端快照可能没有） */
  repairFlashTimer?: number;
  repairFlashSide?: string | null;
  /** 修复进度（可选） */
  repairTarget?: string | null;
  repairProgress?: number;
}

// ═══════════════════════════════════════════════════════════
//  主入口：绘制美化后的基地
//  调用方：Base.render() 和 RemoteView.renderBase()
// ═══════════════════════════════════════════════════════════
export function renderBase(
  ctx: CanvasRenderingContext2D,
  params: BaseVisualParams,
  now: number,
): void {
  const { x: cx, y: cy, eagleHp, eagleMaxHp, isDestroyed } = params;
  const T = TILE_SIZE;

  // 安全渐变工具（测试环境回退为纯色）
  const safeGrad = (x: number, y: number, w: number, h: number, c1: string, c2: string): string | CanvasGradient => {
    if (typeof ctx.createLinearGradient !== "function") return c1;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    return g;
  };
  const safeCircle = (x: number, y: number, r: number): void => {
    if (typeof ctx.arc !== "function" || typeof ctx.beginPath !== "function") {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      return;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // 获取护墙矩形（用于修复闪光/进度条的面级区域）
  const getWallRect = (side: string) => {
    let rx = cx, ry = cy, rw = 0, rh = 0;
    if (side === "top") { rx = cx - T; ry = cy - 2 * T; rw = 2 * T; rh = T; }
    else if (side === "bottom") { rx = cx - T; ry = cy + T; rw = 2 * T; rh = T; }
    else if (side === "left") { rx = cx - 2 * T; ry = cy - T; rw = T; rh = 2 * T; }
    else { rx = cx + T; ry = cy - T; rw = T; rh = 2 * T; }
    return { x: rx, y: ry, w: rw, h: rh };
  };

  // ── 1. 护墙：逐块渲染独立小砖（每块 16×16，有独立血量/损伤） ──
  if (params.bricks && params.bricks.length > 0) {
    for (const b of params.bricks) {
      if (b.hp <= 0) continue;
      const frac = b.hp / b.maxHp;
      // 小砖渐变（上亮下暗）
      ctx.fillStyle = safeGrad(b.x, b.y, b.w, b.h, "#d87020", "#8a3810");
      ctx.fillRect(b.x, b.y, b.w, b.h);
      // 砖纹（砖块内部的小分隔线，模拟砌砖纹理）
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(b.x, b.y, b.w, 1);
      ctx.fillRect(b.x, b.y + b.h / 2, b.w, 1);
      ctx.fillRect(b.x + b.w / 2, b.y, 1, b.h / 2);
      ctx.fillRect(b.x, b.y + b.h / 2, 1, b.h / 2);
      // 顶部高光
      ctx.fillStyle = "rgba(255,200,100,0.2)";
      ctx.fillRect(b.x + 1, b.y + 1, b.w - 2, 1);
      // 损伤裂纹（随HP减少加重）
      if (frac < 1) {
        const dmgFrac = 1 - frac;
        ctx.fillStyle = `rgba(0,0,0,${dmgFrac * 0.5})`;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        if (dmgFrac > 0.3 && typeof ctx.beginPath === "function") {
          ctx.strokeStyle = `rgba(20,10,0,${dmgFrac * 0.9})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(b.x + b.w * 0.2, b.y + b.h * 0.2);
          ctx.lineTo(b.x + b.w * 0.6, b.y + b.h * 0.6);
          ctx.lineTo(b.x + b.w * 0.8, b.y + b.h * 0.3);
          ctx.stroke();
        }
      }
      // 边框
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    }
  } else if (params.walls) {
    // 兼容旧数据（无 bricks 时用面级整墙渲染）
    for (const wall of params.walls) {
      const rect = getWallRect(wall.side);
      if (wall.hp <= 0) continue;
      const frac = wall.hp / wall.maxHp;
      ctx.fillStyle = safeGrad(rect.x, rect.y, rect.w, rect.h, "#d87020", "#8a3810");
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      if (wall.side === "top" || wall.side === "bottom") {
        ctx.fillRect(rect.x, rect.y, rect.w, 2);
        ctx.fillRect(rect.x, rect.y + rect.h / 2, rect.w, 2);
        for (let bx = rect.x; bx < rect.x + rect.w; bx += T / 2) {
          ctx.fillRect(bx, rect.y, 2, rect.h / 2);
          ctx.fillRect(bx + T / 4, rect.y + rect.h / 2, 2, rect.h / 2);
        }
      } else {
        ctx.fillRect(rect.x, rect.y, 2, rect.h);
        ctx.fillRect(rect.x + rect.w / 2, rect.y, 2, rect.h);
        for (let by = rect.y; by < rect.y + rect.h; by += T / 2) {
          ctx.fillRect(rect.x, by, rect.w / 2, 2);
          ctx.fillRect(rect.x + rect.w / 2, by + T / 4, rect.w / 2, 2);
        }
      }
      ctx.fillStyle = "rgba(255,200,100,0.2)";
      ctx.fillRect(rect.x + 2, rect.y + 2, rect.w - 4, 2);
      if (frac < 1) {
        const dmgFrac = 1 - frac;
        ctx.fillStyle = `rgba(0,0,0,${dmgFrac * 0.5})`;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  // ── 2. 修复闪光（金色发光边框 + 扩散光效） ──
  if (params.repairFlashTimer && params.repairFlashTimer > 0 && params.repairFlashSide) {
    const rect = getWallRect(params.repairFlashSide);
    if (rect) {
      const a = Math.min(1, params.repairFlashTimer) * 0.6;
      ctx.fillStyle = `rgba(255,220,80,${a * 0.5})`;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = `rgba(255,240,150,${a})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
      if (typeof ctx.createRadialGradient === "function") {
        const glow = ctx.createRadialGradient(
          rect.x + rect.w / 2, rect.y + rect.h / 2, 0,
          rect.x + rect.w / 2, rect.y + rect.h / 2, Math.max(rect.w, rect.h),
        );
        glow.addColorStop(0, `rgba(255,220,80,${a * 0.3})`);
        glow.addColorStop(1, "rgba(255,220,80,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(rect.x - 20, rect.y - 20, rect.w + 40, rect.h + 40);
      }
    }
  }

  // ── 3. 金色星星（外发光 + 渐变填充 + 呼吸动画 + 高光点） ──
  if (isDestroyed) {
    if (Math.floor(now / 300) % 2 === 0) {
      ctx.fillStyle = "#f00";
      safeCircle(cx, cy, T * 0.7);
    }
  } else {
    const breathe = 1 + Math.sin(now / 800) * 0.04;
    const starR = T * 0.65 * breathe;
    const starInner = T * 0.3 * breathe;

    // 外发光
    if (typeof ctx.createRadialGradient === "function") {
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, T * 1.1);
      glow.addColorStop(0, "rgba(255,215,0,0.35)");
      glow.addColorStop(0.5, "rgba(255,180,0,0.15)");
      glow.addColorStop(1, "rgba(255,150,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(cx - T * 1.2, cy - T * 1.2, T * 2.4, T * 2.4);
    }

    // 金色星星（渐变填充）
    if (typeof ctx.beginPath === "function" && typeof ctx.moveTo === "function") {
      const pts = 5;
      ctx.beginPath();
      for (let i = 0; i < pts * 2; i++) {
        const r = i % 2 === 0 ? starR : starInner;
        const a = (i * Math.PI / pts) - Math.PI / 2;
        i === 0 ? ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
                : ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.closePath();
      if (typeof ctx.createLinearGradient !== "function") {
        ctx.fillStyle = "#ffd700";
      } else {
        const sg = ctx.createLinearGradient(cx, cy - starR, cx, cy + starR);
        sg.addColorStop(0, "#fff0a0");
        sg.addColorStop(0.5, "#ffd700");
        sg.addColorStop(1, "#c89000");
        ctx.fillStyle = sg;
      }
      ctx.fill();
      ctx.strokeStyle = "#8a6000";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      safeCircle(cx - starR * 0.2, cy - starR * 0.3, starR * 0.12);
    } else {
      ctx.fillStyle = "#ffd700";
      safeCircle(cx, cy, T * 0.5);
    }
  }

  // ── 4. 修复进度条（渐变 + 发光） ──
  if (params.repairTarget && params.repairProgress !== undefined && params.repairProgress > 0 && params.repairProgress < 1) {
    const rect = params.repairTarget === "eagle"
      ? { x: cx - 2 * T, y: cy + T + 6, w: 4 * T, h: 4 }
      : getWallRect(params.repairTarget);
    if (rect) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(rect.x - 1, rect.y - 8, rect.w + 2, 5);
      if (typeof ctx.createLinearGradient !== "function") {
        ctx.fillStyle = "#ffd700";
      } else {
        const pg = ctx.createLinearGradient(rect.x, rect.y - 7, rect.x + rect.w, rect.y - 7);
        pg.addColorStop(0, "#fff0a0");
        pg.addColorStop(0.5, "#ffd700");
        pg.addColorStop(1, "#ffaa00");
        ctx.fillStyle = pg;
      }
      ctx.fillRect(rect.x, rect.y - 7, rect.w * params.repairProgress, 3);
      ctx.fillStyle = `rgba(255,220,80,${0.3 + Math.sin(now / 150) * 0.2})`;
      ctx.fillRect(rect.x + rect.w * params.repairProgress - 2, rect.y - 8, 4, 5);
    }
  }

  // ── 5. Eagle HP条（渐变 + 发光） ──
  if (!isDestroyed) {
    const bw = T * 2;
    const hpFrac = eagleHp / eagleMaxHp;
    ctx.fillStyle = "rgba(40,0,0,0.8)";
    ctx.fillRect(cx - bw / 2 - 1, cy + T - 1, bw + 2, 6);
    let hpColor1 = "#40ff40", hpColor2 = "#00a000";
    if (hpFrac < 0.3) { hpColor1 = "#ff4040"; hpColor2 = "#a00000"; }
    else if (hpFrac < 0.6) { hpColor1 = "#ffd040"; hpColor2 = "#c08000"; }
    if (typeof ctx.createLinearGradient !== "function") {
      ctx.fillStyle = hpColor1;
    } else {
      const hg = ctx.createLinearGradient(cx - bw / 2, cy + T, cx - bw / 2, cy + T + 4);
      hg.addColorStop(0, hpColor1);
      hg.addColorStop(1, hpColor2);
      ctx.fillStyle = hg;
    }
    ctx.fillRect(cx - bw / 2, cy + T, bw * hpFrac, 4);
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillRect(cx - bw / 2, cy + T, bw * hpFrac, 1);
  }
}
