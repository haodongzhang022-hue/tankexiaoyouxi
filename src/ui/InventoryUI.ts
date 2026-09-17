//  InventoryUI.ts 
// Renders backpack grid + wand slot visualization.
// Call render() each frame when inventory is open.
// Drag-drop uses mouse input; call handleMouse() each frame.

import type { InventorySystem } from "../systems/wand/InventorySystem";
import type { WandState } from "../systems/wand/WandTypes";
import type { WandSystem } from "../systems/wand/WandSystem";
import type { Renderer } from "../engine/Renderer";

const SLOT_SIZE = 44;
const SLOT_GAP  = 6;
const PANEL_PAD = 12;

export class InventoryUI {
  private inventory: InventorySystem;
  private wand: WandState;
  private wandSystem: WandSystem;
  private playerLabel: string;

  // Drag state
  private dragging: { slotIdx: number } | null = null;
  private mouseX = 0;
  private mouseY = 0;

  // Panel position
  private ox: number;
  private oy: number;

  constructor(inventory: InventorySystem, wand: WandState, wandSystem: WandSystem,
              ox: number, oy: number, label = "P1") {
    this.inventory = inventory;
    this.wand = wand;
    this.wandSystem = wandSystem;
    this.ox = ox;
    this.oy = oy;
    this.playerLabel = label;
  }

  handleMouse(mouseX: number, mouseY: number, clicked: boolean, released: boolean): void {
    this.mouseX = mouseX;
    this.mouseY = mouseY;

    if (clicked && !this.dragging) {
      const slot = this.hitTestBackpack(mouseX, mouseY);
      if (slot !== -1 && this.inventory.getAll()[slot].item) {
        this.dragging = { slotIdx: slot };
      }
    }

    if (released && this.dragging) {
      const wandSlot = this.hitTestWand(mouseX, mouseY);
      if (wandSlot !== -1) {
        // Move module from backpack to wand slot
        const item = this.inventory.removeAt(this.dragging.slotIdx);
        if (item && "config" in item) {
          // If wand slot is occupied, swap back to backpack
          const existing = this.wandSystem.removeModule(this.wand, wandSlot);
          if (existing) this.inventory.addModule(existing.config.id);
          this.wandSystem.equipModule(this.wand, wandSlot, item.config.id);
        }
      }
      this.dragging = null;
    }
  }

  private hitTestBackpack(mx: number, my: number): number {
    const cols = 4;
    const slots = this.inventory.getAll();
    for (let i = 0; i < slots.length; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = this.ox + PANEL_PAD + c * (SLOT_SIZE + SLOT_GAP);
      const y = this.oy + PANEL_PAD + 20 + r * (SLOT_SIZE + SLOT_GAP);
      if (mx >= x && mx < x+SLOT_SIZE && my >= y && my < y+SLOT_SIZE) return i;
    }
    return -1;
  }

  private hitTestWand(mx: number, my: number): number {
    const wandY = this.oy + PANEL_PAD + 20 + Math.ceil(this.inventory.totalSlots / 4) * (SLOT_SIZE + SLOT_GAP) + 20;
    for (let i = 0; i < this.wand.modules.length; i++) {
      const x = this.ox + PANEL_PAD + i * (SLOT_SIZE + SLOT_GAP);
      const y = wandY;
      if (mx >= x && mx < x+SLOT_SIZE && my >= y && my < y+SLOT_SIZE) return i;
    }
    return -1;
  }

  render(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    const cols = 4;
    const slots = this.inventory.getAll();
    const rows = Math.ceil(slots.length / cols);
    const wandY = this.oy + PANEL_PAD + 20 + rows * (SLOT_SIZE + SLOT_GAP) + 20;
    const panelH = wandY - this.oy + SLOT_SIZE + PANEL_PAD * 2;
    const panelW = PANEL_PAD * 2 + cols * (SLOT_SIZE + SLOT_GAP) - SLOT_GAP;

    // Background panel
    ctx.fillStyle = "rgba(0,0,0,0.85)";
    ctx.fillRect(this.ox, this.oy, panelW, panelH);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.strokeRect(this.ox, this.oy, panelW, panelH);

    ctx.font = "12px monospace"; ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText(`${this.playerLabel} 背包`, this.ox + PANEL_PAD, this.oy + PANEL_PAD + 10);

    // Backpack slots
    for (let i = 0; i < slots.length; i++) {
      if (this.dragging?.slotIdx === i) continue;
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = this.ox + PANEL_PAD + c * (SLOT_SIZE + SLOT_GAP);
      const y = this.oy + PANEL_PAD + 20 + r * (SLOT_SIZE + SLOT_GAP);
      this.drawSlot(ctx, x, y, slots[i].item, now);
    }

    // Wand section
    ctx.fillStyle = "#333"; ctx.fillText("炮筒模块", this.ox + PANEL_PAD, wandY - 6);
    for (let i = 0; i < this.wand.modules.length; i++) {
      const x = this.ox + PANEL_PAD + i * (SLOT_SIZE + SLOT_GAP);
      const mod = this.wand.modules[i];
      this.drawSlot(ctx, x, wandY, mod, now, true);
    }

    // Dragging item
    if (this.dragging) {
      const item = slots[this.dragging.slotIdx].item;
      if (item) this.drawItemAt(ctx, this.mouseX - SLOT_SIZE/2, this.mouseY - SLOT_SIZE/2, item, now);
    }
  }

  private drawSlot(ctx: CanvasRenderingContext2D, x: number, y: number,
                   item: any, now: number, isWand = false): void {
    ctx.fillStyle = isWand ? "#2a2a4a" : "#1a1a1a";
    ctx.fillRect(x, y, SLOT_SIZE, SLOT_SIZE);
    ctx.strokeStyle = isWand ? "#44f" : "#444";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, SLOT_SIZE, SLOT_SIZE);
    if (item) this.drawItemAt(ctx, x, y, item, now);
  }

  private drawItemAt(ctx: CanvasRenderingContext2D, x: number, y: number, item: any, _now: number): void {
    const qualityColors: Record<string, string> = { white:"#ddd", blue:"#4af", gold:"#ffd700" };
    if ("config" in item) {
      const col = qualityColors[item.config.quality] ?? "#ddd";
      ctx.fillStyle = col;
      ctx.fillRect(x+4, y+4, SLOT_SIZE-8, SLOT_SIZE-8);
      ctx.fillStyle = "#000"; ctx.font = "8px monospace"; ctx.textAlign = "center";
      // Truncate name
      const label = item.config.name.slice(0, 5);
      ctx.fillText(label, x + SLOT_SIZE/2, y + SLOT_SIZE/2 - 2);
      if (item.config.maxUses !== -1) {
        ctx.fillStyle = "#333"; ctx.font = "8px monospace";
        ctx.fillText(`${item.usesLeft}`, x + SLOT_SIZE/2, y + SLOT_SIZE/2 + 8);
      }
    } else if (item.kind === "traditional") {
      ctx.fillStyle = "#f84";
      ctx.beginPath(); ctx.arc(x+SLOT_SIZE/2, y+SLOT_SIZE/2, SLOT_SIZE/2-6, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle="#000"; ctx.font="7px monospace"; ctx.textAlign="center";
      ctx.fillText(item.name.slice(0,4), x+SLOT_SIZE/2, y+SLOT_SIZE/2+3);
    }
  }
}