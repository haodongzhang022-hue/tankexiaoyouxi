// EntityVisual.ts - 游戏实体共享渲染模块
// 统一掉落物(Loot)、道具(PowerUp)、子弹(Projectile)的渲染逻辑，
// 主机端和成员端都调用本模块，确保联机版本一致，杜绝两套渲染逻辑产生分歧。

import type { LootDrop } from "../systems/loot/LootSystem";
import { getModule } from "../systems/wand/ModuleRegistry";
import { tradItemIcon } from "../systems/wand/InventorySystem";
import { POWERUP_INFO } from "../systems/powerup/PowerUpSystem";

// ═══════════════════════════════════════════════════════════
//  掉落物渲染（统一 LootSystem.render 和 RemoteView.renderLoot）
// ═══════════════════════════════════════════════════════════
export interface LootVisualParams {
  drops: Array<{
    x: number; y: number;
    type: string;
    quality?: string;
    moduleId?: string;
    itemId?: string;
    value?: number;
    lifetime?: number;
    ownerId?: number;
  }>;
  /** 观看者玩家索引（用于归属视觉），undefined 表示不区分归属 */
  viewer?: number;
}

export function renderLoot(
  ctx: CanvasRenderingContext2D,
  params: LootVisualParams,
  now: number,
): void {
  const { drops, viewer } = params;
  const colors: Record<string, string> = {
    none: "#ff0", white: "#eee", blue: "#4af", gold: "#ffd700",
  };

  for (const d of drops) {
    const blink = Math.floor(now / 400) % 2 === 0;
    const flicker = (d.lifetime ?? 999) < 3 && !blink;
    if (flicker) continue;

    // 归属视觉：别人的专属掉落半透明灰
    const isOthersPrivate = d.ownerId !== undefined && viewer !== undefined && d.ownerId !== viewer;
    ctx.save();
    if (isOthersPrivate) ctx.globalAlpha = 0.35;

    if (d.type === "gold") {
      ctx.fillStyle = "#ffd700";
      ctx.beginPath(); ctx.arc(d.x, d.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#000"; ctx.font = "bold 8px monospace";
      ctx.textAlign = "center"; ctx.fillText("$", d.x, d.y + 3);
    } else if (d.type === "module") {
      ctx.fillStyle = colors[d.quality ?? "none"];
      ctx.fillRect(d.x - 9, d.y - 9, 18, 18);
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      ctx.strokeRect(d.x - 9, d.y - 9, 18, 18);
      ctx.fillStyle = "#000";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      const mod = d.moduleId ? getModule(d.moduleId) : null;
      ctx.fillText(mod ? mod.name.charAt(0) : "?", d.x, d.y + 4);
    } else if (d.type === "item") {
      if (d.itemId === "item_essence") {
        ctx.fillStyle = "#ffd700";
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-6, -6, 12, 12);
        ctx.restore();
        ctx.strokeStyle = "#a60"; ctx.lineWidth = 1;
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeRect(-6, -6, 12, 12);
        ctx.restore();
        ctx.fillStyle = "#000";
        ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
        ctx.fillText("✦", d.x, d.y + 3);
      } else {
        const icon = tradItemIcon(d.itemId ?? "");
        ctx.fillStyle = icon.color;
        ctx.beginPath(); ctx.arc(d.x, d.y, 8, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = "#000"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
        ctx.fillText(icon.glyph, d.x, d.y + 3);
      }
    } else if (d.type === "exp") {
      // v2.18 经验球颜色与玩家经验条统一（#6688ff），视觉对齐
      ctx.fillStyle = "#6688ff";
      ctx.beginPath(); ctx.arc(d.x, d.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#3344aa"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(d.value ?? 0), d.x, d.y + 13);
    }
    ctx.restore();

    // 归属提示：别人的专属掉落在顶部加小角标 "P2"
    if (isOthersPrivate) {
      ctx.fillStyle = "#f88";
      ctx.font = "bold 8px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`P${(d.ownerId ?? 0) + 1}`, d.x, d.y - 12);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  道具渲染（统一 PowerUpSystem.render 和 RemoteView.renderPowerUps）
// ═══════════════════════════════════════════════════════════
export interface PowerUpVisualParams {
  powerups: Array<{
    x: number; y: number;
    type: string;
    lifetime?: number;
    id?: number;
  }>;
}

export function renderPowerUps(
  ctx: CanvasRenderingContext2D,
  params: PowerUpVisualParams,
  now: number,
): void {
  for (const p of params.powerups) {
    const info = POWERUP_INFO[p.type as keyof typeof POWERUP_INFO];
    if (!info) continue;
    const blink = Math.floor(now / 500) % 2 === 0;
    const fade = (p.lifetime ?? 999) < 3 && !blink;
    if (fade) continue;

    // Soft glow
    const pulse = 0.5 + 0.5 * Math.sin(now / 200 + (p.id ?? 0));
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.3 * pulse;
    ctx.fillStyle = info.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Icon box
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(p.x - 10, p.y - 10, 20, 20);
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 10, p.y - 10, 20, 20);

    // Glyph
    ctx.fillStyle = info.color;
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(info.glyph, p.x, p.y + 1);
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════
//  子弹渲染（统一 CombatSystem.renderProjectiles 和 RemoteView.renderProjectiles）
// ═══════════════════════════════════════════════════════════
export interface ProjectileVisualParams {
  projectiles: Array<{
    x: number; y: number;
    radius: number;
    color: string;
    type: string;
    vx?: number;
    vy?: number;
    isAlive?: boolean;
    id?: number;
  }>;
  /** 地雷就位状态映射（主机端有，成员端可传 undefined 表示都已就位） */
  explosiveTimers?: Map<number, number>;
}

export function renderProjectiles(
  ctx: CanvasRenderingContext2D,
  params: ProjectileVisualParams,
  now: number,
): void {
  const { projectiles, explosiveTimers } = params;
  for (const p of projectiles) {
    if (p.isAlive === false) continue;
    ctx.fillStyle = p.color;

    // Flame rendering: larger, pulsing fire patch
    if (p.type === "proj_flame") {
      const pulse = 0.7 + 0.3 * Math.abs(Math.sin(now / 120));
      ctx.globalAlpha = 0.6;
      if (typeof ctx.createRadialGradient === "function") {
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 2 * pulse);
        grad.addColorStop(0, "rgba(255,200,50,0.9)");
        grad.addColorStop(0.4, "rgba(255,100,0,0.6)");
        grad.addColorStop(1, "rgba(200,0,0,0)");
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = "rgba(255,150,0,0.7)";
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * 2 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (p.type === "proj_laser") {
      // Laser: beam effect
      ctx.strokeStyle = "#f0f";
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.8;
      const beamLen = 40;
      const angle = Math.atan2(p.vy ?? 0, p.vx ?? 1);
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(angle) * beamLen, p.y - Math.sin(angle) * beamLen);
      ctx.lineTo(p.x + Math.cos(angle) * beamLen, p.y + Math.sin(angle) * beamLen);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (p.type === "proj_mine") {
      // 地雷：暗色圆盘 + 就位后红色警示灯闪烁
      const armed = !explosiveTimers || (explosiveTimers.get(p.id ?? -1) ?? 0) <= 0;
      ctx.fillStyle = "#3a3a3a";
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#666"; ctx.lineWidth = 1; ctx.stroke();
      if (armed && Math.floor(now / 150) % 2 === 0) {
        ctx.fillStyle = "#f22";
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
    } else if (p.type === "proj_dynamite" || p.type === "proj_bomb") {
      // 引线炸药包：包裹 + 火花引线
      ctx.fillStyle = p.type === "proj_bomb" ? "#777" : "#8a5a2b";
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.fillRect(-p.radius, -p.radius * 0.7, p.radius * 2, p.radius * 1.4);
      ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.strokeRect(-p.radius, -p.radius * 0.7, p.radius * 2, p.radius * 1.4);
      if (Math.floor(now / 60) % 2 === 0) {
        ctx.fillStyle = "#ff6";
        ctx.beginPath(); ctx.arc(p.radius * 0.4, -p.radius * 0.8, 2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
