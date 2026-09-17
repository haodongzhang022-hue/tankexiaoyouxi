//  BackpackPanel.ts ─
// 共享 UI：背包 + 4根炮筒精准装配 + 基地仓库/合成。
// 精准装配由 EquipController 操作模块驱动（鼠标/触屏点击两段式 + 手柄焦点框），
// 本文件只负责渲染；动作执行在 EquipController.pointerTap / confirmHeldInput。
import type { Tank } from "../game/Tank";
import type { InventorySystem } from "../systems/wand/InventorySystem";
import type { Warehouse } from "../systems/warehouse/Warehouse";
import { QUALITY_ORDER } from "../systems/warehouse/Warehouse";
import { EquipController, EQUIP_PANEL } from "../input/EquipController";
import { tradItemIcon } from "../systems/wand/InventorySystem";
import {
  THEME, drawThemedSlot, drawThemedPanel, verticalGradient,
} from "./VisualTheme";

/** 获取道具图标 */
function getTradItemIcon(itemId: string): { glyph: string; color: string } {
  return tradItemIcon(itemId);
}

const QUALITY_COLORS: Record<string, string> = { white: "#ddd", blue: "#4af", gold: "#ffd700" };

// ── 背包布局常量 ──
const INV_COLS = 5;          // 每行 5 格
const INV_ROWS = 6;          // 最多 6 行 = 30 格
const INV_SLOT_SIZE = 42;    // 每格尺寸
const INV_GAP = 4;           // 格间距
const WAND_COLS = 5;         // 炮筒模块每行 5 格
const WAND_MAX_ROWS = 3;     // 最多 3 行 = 15 模块
const WAND_SLOT_SIZE = 34;
const WAND_GAP = 3;
const WAND_PER_ROW = 5;     // 每行5格 → 每个炮筒最多5个模块

export interface PanelOpts {
  ctx: CanvasRenderingContext2D;
  panelX: number;
  panelY: number;
  inv: InventorySystem;
  player: Tank;
  playerLabel: string;
  toggleKey: string;
  useKey: string;
  /** 精准装配操作模块：驱动选中高亮（selectedInv）与焦点框 */
  equip: EquipController;
}

// 动态面板尺寸：根据实际背包格数计算
function getInvWidth(): number { return INV_COLS * (INV_SLOT_SIZE + INV_GAP) + 8; }
function getPanelWidth(): number {
  // 左侧背包 + 间距 + 右侧炮筒
  return getInvWidth() + 16 + WAND_COLS * (WAND_SLOT_SIZE + WAND_GAP) + 12;
}
function getPanelHeight(): number {
  const invH = 22 + INV_ROWS * (INV_SLOT_SIZE + INV_GAP) + 30;
  const wandH = 22 + WAND_MAX_ROWS * (WAND_SLOT_SIZE + WAND_GAP) + 20;
  return Math.max(invH, wandH) + 16;
}

function invSlotRect(panelX: number, panelY: number, i: number): { x: number; y: number; s: number } {
  const col = i % INV_COLS;
  const row = Math.floor(i / INV_COLS);
  return { x: panelX + 8 + col * (INV_SLOT_SIZE + INV_GAP), y: panelY + 24 + row * (INV_SLOT_SIZE + INV_GAP), s: INV_SLOT_SIZE };
}

function wandSlotRect(panelX: number, panelY: number, wandIdx: number, slotIdx: number): { x: number; y: number; s: number } {
  const wandX = panelX + getInvWidth() + 16;
  // 每个炮筒5格宽，按列排
  const col = slotIdx % WAND_COLS;
  const row = Math.floor(slotIdx / WAND_COLS);
  return {
    x: wandX + col * (WAND_SLOT_SIZE + WAND_GAP),
    y: panelY + 24 + wandIdx * (WAND_MAX_ROWS * (WAND_SLOT_SIZE + WAND_GAP) + 12) + row * (WAND_SLOT_SIZE + WAND_GAP),
    s: WAND_SLOT_SIZE,
  };
}

export function renderBackpackPanel(o: PanelOpts): void {
  const { ctx, panelX, panelY, inv, player } = o;
  const BP_W = getPanelWidth();
  const BP_H = getPanelHeight();

  // 美化面板背景
  drawThemedPanel(ctx, {
    x: panelX, y: panelY, w: BP_W, h: BP_H,
    borderColor: THEME.borderBright, corners: true,
  });
  // 标题
  ctx.save();
  ctx.font = "bold 13px monospace";
  ctx.fillStyle = THEME.textGold;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.shadowColor = THEME.textGold;
  ctx.shadowBlur = 4;
  ctx.fillText(`${o.playerLabel} 背包 [${o.toggleKey}] 道具[${o.useKey}]`, panelX + 10, panelY + 6);
  ctx.restore();

  // ── 背包格子（5列×6行） ──
  const slots = inv.getAll();
  const maxInvSlots = INV_COLS * INV_ROWS; // 30
  for (let i = 0; i < Math.min(slots.length, maxInvSlots); i++) {
    const r = invSlotRect(panelX, panelY, i);
    const sel = o.equip.selectedInv === i;
    const it = slots[i]?.item;
    // 美化槽位
    drawThemedSlot(ctx, {
      x: r.x, y: r.y, size: r.s,
      quality: (it && 'config' in it) ? it.config.quality : "white",
      selected: sel,
    });
    if (it && 'config' in it) {
      const qc = QUALITY_COLORS[it.config.quality] || "#ddd";
      const grad = ctx.createLinearGradient(r.x + 2, r.y + 2, r.x + 2, r.y + r.s - 16);
      grad.addColorStop(0, qc);
      grad.addColorStop(1, darkenHex(qc, 0.3));
      ctx.fillStyle = grad;
      ctx.fillRect(r.x + 2, r.y + 2, r.s - 4, r.s - 16);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(r.x + 2, r.y + 2, r.s - 4, 1.5);
      // 模块名：显示最多6个字，加大字号
      ctx.fillStyle = "#000"; ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
      const name = it.config.name.length > 6 ? it.config.name.slice(0, 6) : it.config.name;
      ctx.fillText(name, r.x + r.s / 2, r.y + r.s - 10);
      // 剩余次数
      if (it.config.maxUses > 0) {
        ctx.font = "8px monospace";
        ctx.fillStyle = it.usesLeft > 50 ? "#4a4" : it.usesLeft > 10 ? "#aa4" : "#a44";
        ctx.fillText(`×${it.usesLeft}`, r.x + r.s - 4, r.y + 3);
      }
    } else if (it && "kind" in it) {
      const icon = getTradItemIcon(it.id);
      ctx.fillStyle = icon.color;
      ctx.fillRect(r.x + 2, r.y + 2, r.s - 4, r.s - 16);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(r.x + 2, r.y + 2, r.s - 4, 1.5);
      ctx.fillStyle = "#000"; ctx.font = "bold 11px monospace"; ctx.textAlign = "center";
      ctx.fillText(icon.glyph, r.x + r.s / 2, r.y + r.s / 2 - 2);
      // 道具名（小字）
      ctx.font = "9px monospace";
      ctx.fillText(it.name.slice(0, 4), r.x + r.s / 2, r.y + r.s - 10);
    }
  }

  // Hint
  ctx.fillStyle = "#aaa"; ctx.font = "10px monospace"; ctx.textAlign = "left";
  ctx.fillText("点背包→选中(黄框)→点炮筒槽装入", panelX + 6, panelY + BP_H - 18);
  ctx.fillText("点已装模块→花15金卸下；覆盖则销毁", panelX + 6, panelY + BP_H - 6);

  // ── 炮筒模块（右侧，每个炮筒5格×3行 = 最多15格） ──
  const wandX = panelX + getInvWidth() + 16;
  ctx.fillStyle = "#aaa"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
  ctx.fillText("炮筒模块", wandX, panelY + 6);

  for (let w = 0; w < 4; w++) {
    const cannon = player.cannons[w] ?? player.currentCannon;
    const active = w === player.activeCannon;
    ctx.save();
    ctx.fillStyle = active ? THEME.textCyan : "#889";
    ctx.font = active ? "bold 11px monospace" : "10px monospace";
    ctx.textAlign = "left";
    if (active) {
      ctx.shadowColor = THEME.textCyan;
      ctx.shadowBlur = 3;
    }
    const wandY = panelY + 24 + w * (WAND_MAX_ROWS * (WAND_SLOT_SIZE + WAND_GAP) + 12);
    ctx.fillText(`${w + 1}号${active ? " ◀" : ""}`, wandX, wandY - 2);
    ctx.restore();
    for (let s = 0; s < cannon.modules.length; s++) {
      const r = wandSlotRect(panelX, panelY, w, s);
      const mod = cannon.modules[s];
      drawThemedSlot(ctx, {
        x: r.x, y: r.y, size: r.s,
        quality: (mod && 'config' in mod) ? mod.config.quality : "white",
        borderColor: active ? "#46a" : THEME.borderNormal,
      });
      if (mod) {
        const qc = QUALITY_COLORS[mod.config.quality] || "#ddd";
        const grad = ctx.createLinearGradient(r.x + 2, r.y + 2, r.x + 2, r.y + r.s - 14);
        grad.addColorStop(0, qc);
        grad.addColorStop(1, darkenHex(qc, 0.3));
        ctx.fillStyle = grad;
        ctx.fillRect(r.x + 2, r.y + 2, r.s - 4, r.s - 14);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(r.x + 2, r.y + 2, r.s - 4, 1.5);
        ctx.fillStyle = "#000"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
        const name = mod.config.name.length > 5 ? mod.config.name.slice(0, 5) : mod.config.name;
        ctx.fillText(name, r.x + r.s / 2, r.y + r.s - 5);
      }
    }
  }
}

/** 颜色变暗工具 */
function darkenHex(hex: string, amount: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = Math.max(0, Math.round(parseInt(m[1], 16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(m[2], 16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(m[3], 16) * (1 - amount)));
  return `rgb(${r},${g},${b})`;
}

// ── 基地仓库 ─────────────────────────────────────────────

const WH_W = 500;
const WH_H = 330;
const PER_PAGE = 8;

export interface WarehousePanelOpts {
  ctx: CanvasRenderingContext2D;
  panelX: number;
  panelY: number;
  warehouse: Warehouse;
  /** 目标背包（谁在用仓库，就存入谁） */
  inv: InventorySystem;
  page: number;
  onSetPage: (p: number) => void;
  onWithdraw: (index: number) => void;
  onSynthesize: (target: "blue" | "gold") => void;
  onMessage: (msg: string) => void;
}

export function renderWarehousePanel(o: WarehousePanelOpts): void {
  const { ctx, panelX, panelY, warehouse } = o;
  // 美化面板
  drawThemedPanel(ctx, {
    x: panelX, y: panelY, w: WH_W, h: WH_H,
    borderColor: THEME.borderGold, borderWidth: 2, corners: true,
  });

  // 标题
  ctx.save();
  ctx.font = "bold 14px monospace";
  ctx.fillStyle = THEME.textGold;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.shadowColor = THEME.textGold;
  ctx.shadowBlur = 6;
  ctx.fillText("基 地 仓 库  [B]", panelX + WH_W / 2, panelY + 12);
  ctx.restore();
  ctx.save();
  ctx.font = "11px monospace";
  ctx.fillStyle = "#ffaa00";
  ctx.textAlign = "center";
  ctx.fillText(`✦ 强化材料 ${warehouse.essence}`, panelX + WH_W / 2, panelY + 32);
  ctx.restore();

  // Synthesis buttons
  const btnY = panelY + 38;
  const btnH = 34;
  const synthWhite = warehouse.countByQuality("white");
  const synthBlue = warehouse.countByQuality("blue");
  const canWhite = synthWhite >= 3;
  const canBlue = synthBlue >= 3 && warehouse.essence >= 1;
  // 白→蓝
  ctx.fillStyle = canWhite ? "#3a2a00" : "#1a1a1a";
  ctx.fillRect(panelX + 8, btnY, 230, btnH);
  ctx.strokeStyle = canWhite ? "#fa0" : "#444"; ctx.lineWidth = 1;
  ctx.strokeRect(panelX + 8, btnY, 230, btnH);
  ctx.fillStyle = canWhite ? "#ffd700" : "#777";
  ctx.font = "10px monospace"; ctx.textAlign = "left";
  ctx.fillText(`[合成] 3×白 → 1×蓝  (现有 ${synthWhite})`, panelX + 14, btnY + 15);
  ctx.fillStyle = "#888"; ctx.font = "8px monospace";
  ctx.fillText(canWhite ? "点击合成" : "白色模块不足3个", panelX + 14, btnY + 28);
  // 蓝→金
  ctx.fillStyle = canBlue ? "#003a5a" : "#1a1a1a";
  ctx.fillRect(panelX + 8 + 234, btnY, 250, btnH);
  ctx.strokeStyle = canBlue ? "#4af" : "#444"; ctx.lineWidth = 1;
  ctx.strokeRect(panelX + 8 + 234, btnY, 250, btnH);
  ctx.fillStyle = canBlue ? "#4af" : "#777";
  ctx.font = "10px monospace"; ctx.textAlign = "left";
  ctx.fillText(`[合成] 3×蓝 + 1✦ → 1×金  (蓝${synthBlue}/✦${warehouse.essence})`, panelX + 8 + 234 + 6, btnY + 15);
  ctx.fillStyle = "#888"; ctx.font = "8px monospace";
  ctx.fillText(canBlue ? "点击合成" : "蓝色模块不足3个或缺少强化材料", panelX + 8 + 234 + 6, btnY + 28);

  // Warehouse slots (paginated)
  const all = warehouse.all;
  const pageCount = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const page = Math.min(o.page, pageCount - 1);
  const start = page * PER_PAGE;
  const ctx2 = ctx;
  for (let i = 0; i < PER_PAGE; i++) {
    const idx = start + i;
    const col = i % 4;
    const row = Math.floor(i / 4);
    const sx = panelX + 12 + col * 50;
    const sy = panelY + 84 + row * 50;
    const m = all[idx];
    // 美化槽位
    drawThemedSlot(ctx2, {
      x: sx, y: sy, size: 44,
      quality: (m && 'config' in m) ? m.config.quality : "white",
    });
    if (m) {
      const qc = QUALITY_COLORS[m.config.quality] || "#ddd";
      const grad = ctx2.createLinearGradient(sx + 2, sy + 2, sx + 2, sy + 28);
      grad.addColorStop(0, qc);
      grad.addColorStop(1, darkenHex(qc, 0.3));
      ctx2.fillStyle = grad;
      ctx2.fillRect(sx + 2, sy + 2, 40, 26);
      ctx2.fillStyle = "rgba(255,255,255,0.2)";
      ctx2.fillRect(sx + 2, sy + 2, 40, 1.5);
      ctx2.fillStyle = "#000"; ctx2.font = "7px monospace"; ctx2.textAlign = "center";
      ctx2.fillText(m.config.name.slice(0, 4), sx + 22, sy + 19);
    }
  }

  // Page nav
  ctx.fillStyle = "#aaa"; ctx.font = "10px monospace"; ctx.textAlign = "center";
  ctx.fillText(`← [上一页]    ${page + 1}/${pageCount}    [下一页] →`, panelX + WH_W / 2, panelY + WH_H - 14);
  ctx.fillStyle = "#888"; ctx.font = "8px monospace";
  ctx.fillText("点击仓库模块→存回背包", panelX + WH_W / 2, panelY + WH_H - 2);
}

export function handleWarehouseClick(x: number, y: number, o: WarehousePanelOpts): boolean {
  const { panelX, panelY, warehouse, inv } = o;
  if (x < panelX || x > panelX + WH_W || y < panelY || y > panelY + WH_H) return false;

  const all = warehouse.all;
  const pageCount = Math.max(1, Math.ceil(all.length / PER_PAGE));
  const page = Math.min(o.page, pageCount - 1);

  // Synthesis buttons
  if (y >= panelY + 38 && y < panelY + 72) {
    if (x >= panelX + 8 && x < panelX + 238) { o.onSynthesize("blue"); return true; }
    if (x >= panelX + 8 + 234 && x < panelX + 8 + 234 + 250) { o.onSynthesize("gold"); return true; }
  }

  // Warehouse slots
  const start = page * PER_PAGE;
  for (let i = 0; i < PER_PAGE; i++) {
    const idx = start + i;
    const col = i % 4;
    const row = Math.floor(i / 4);
    const sx = panelX + 8 + col * 48;
    const sy = panelY + 80 + row * 48;
    if (x >= sx && x < sx + 44 && y >= sy && y < sy + 44 && all[idx]) {
      if (inv.freeSlots <= 0) { o.onMessage("背包已满！"); return true; }
      o.onWithdraw(idx);
      return true;
    }
  }

  // Page nav
  const navY = panelY + WH_H - 14;
  if (y >= navY - 8 && y < navY + 8) {
    if (x < panelX + WH_W / 2) o.onSetPage((page + pageCount - 1) % pageCount);
    else                       o.onSetPage((page + 1) % pageCount);
    return true;
  }
  return false;
}

export { QUALITY_ORDER };
