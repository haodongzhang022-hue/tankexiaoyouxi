//  StageMode.ts ─
// v2.3 闯关模式：30 关（6 章 x 5 关，每 5 关一个 BOSS）+ 过关商店 + 按章节主题地形
// 共享编排（系统构造/战斗帧/背包仓库/装备/击杀/渲染）见 framework/GameModeCore.ts
import { GameModeCore } from "../framework/GameModeCore";
import { generateMap, biomeForStage } from "../systems/terrain/MapGenerator";
import { ALL_MODULES } from "../systems/wand/ModuleRegistry";
import type { GameLayout } from "../types/GameLayout";
import type { Renderer } from "../engine/Renderer";
import { getSoundManager } from "../engine/SoundManager";

const TOTAL_STAGES = 30;

// Stage config: enemy count & composition bonus
interface StageConfig {
  wave: number;        // internal wave number for grading
  enemyCount: number;
  bossStage: boolean;
  bgColor: string;
}

function makeStageConfig(stage: number): StageConfig {
  const chapter = Math.floor((stage - 1) / 5);
  const bossStage = stage % 5 === 0;
  return {
    wave: stage,
    enemyCount: 6 + stage * 2 + (bossStage ? 2 : 0),
    bossStage,
    bgColor: ["#111","#112","#121","#211","#122","#221"][chapter % 6],
  };
}

type ShopItem = { type: "module"; moduleId: string; price: number; name: string; quality: string }
              | { type: "item"; itemId: string; price: number; name: string };

export class StageMode extends GameModeCore {
  currentStage: number = 1;
  isWin = false;

  // Phase: "playing" | "between" | "shop" | "levelup" | "gameover"
  private phase: "playing" | "between" | "shop" | "levelup" | "gameover" = "playing";
  private betweenTimer = 0;
  private shopTimer = 0;
  private shopMaxTimer = 20;
  private shopExtended = false;
  private shopItems: ShopItem[] = [];
  private shopMsg = "";
  private shopMsgTimer = 0;

  constructor(canvas: HTMLCanvasElement, layout?: GameLayout) {
    super(canvas, layout);
    this.loadStage(1);
  }

  // ── 差异钩子 ──
  /** 闯关：地图在 loadStage 中按章节主题生成（每 5 关一个章节） */
  protected configureSpawn(): void {
    this.spawnSystem.onWaveComplete = () => this.onStageComplete();
  }

  protected onBaseDestroyed(): void {
    this.isOver = true;
    this.phase = "gameover";
    getSoundManager().play("game_over");
  }

  protected onTeamEliminated(): void {
    this.isOver = true;
    this.phase = "gameover";
    getSoundManager().play("game_over");
  }

  // ── 关卡流程 ──
  private loadStage(stage: number): void {
    this.currentStage = stage;
    this.tilemap = new (this.tilemap.constructor as new (cols: number, rows: number) => typeof this.tilemap)(this.mapCols, this.mapRows);
    // v2.3 主题化地形生成：每 5 关一个章节主题，难度随关卡提升
    generateMap(
      this.tilemap,
      biomeForStage(stage),
      stage * 7919 + 13,
      Math.min(1, stage / 30),
    );
    this.syncBaseWallTiles();
    this.spawnSystem.activeEnemies = [];
    this.killedIds.clear();
    this.spawnSystem.startWave(makeStageConfig(stage).wave);
    this.phase = "playing";
  }

  private onStageComplete(): void {
    if (this.currentStage >= TOTAL_STAGES) {
      this.isWin = true;
      this.phase = "gameover";
      return;
    }
    this.shopItems = this.generateShopItems();
    this.phase = "shop";
    this.shopTimer = 20;
    this.shopMaxTimer = 20;
    this.shopExtended = false;
    this.shopMsg = "";
    this.shopMsgTimer = 0;
  }

  private generateShopItems(): ShopItem[] {
    const items: ShopItem[] = [];
    // Pick 3-4 random modules from the pool
    const pool = ALL_MODULES.filter(m => m.quality !== "gold" && m.category !== "trigger");
    const count = 3 + Math.floor(Math.random() * 2); // 3-4 items
    const used = new Set<number>();
    for (let i = 0; i < count && used.size < pool.length; i++) {
      let idx: number;
      do { idx = Math.floor(Math.random() * pool.length); } while (used.has(idx));
      used.add(idx);
      const mod = pool[idx];
      const price = mod.quality === "blue" ? 50 : mod.quality === "gold" ? 120 : 20;
      items.push({ type: "module", moduleId: mod.id, price, name: mod.name, quality: mod.quality });
    }
    // Possibly add a traditional item
    if (Math.random() < 0.5) {
      const tradItems = ["item_shield","item_timestop","item_bomb","item_extra_life","item_repair_kit","item_speed_boost","item_damage_boost"];
      const ti = tradItems[Math.floor(Math.random() * tradItems.length)];
      items.push({ type: "item", itemId: ti, price: 30, name: ti.replace("item_","").replace("_"," ") });
    }
    return items;
  }

  private buyShopItem(index: number, playerIdx: number): void {
    if (this.shopTimer <= 0) return;
    const item = this.shopItems[index];
    if (!item) return;
    // 商店按各自金币购买（博弈：金币独立，各买各的）
    const wallet = this.players[playerIdx].stats;
    if (wallet.exp < item.price) {
      this.shopMsg = `P${playerIdx+1} 金币不足！`;
      this.shopMsgTimer = 2;
      return;
    }
    wallet.exp -= item.price;
    if (item.type === "module") {
      this.inventories[playerIdx].addModule(item.moduleId);
      this.shopMsg = `P${playerIdx+1} 购买了 ${item.name}`;
    } else {
      this.inventories[playerIdx].addTraditionalItem(item.itemId);
      this.shopMsg = `P${playerIdx+1} 购买了 ${item.name}`;
    }
    this.shopMsgTimer = 2;
    this.shopItems.splice(index, 1);
    getSoundManager().play("pickup");
  }

  // ── 模式逻辑 ──
  update(dt: number): void {
    if (this.phase === "gameover") return;

    // 升级自动选（游戏不暂停）
    this.updateLevelUpAutoPick(dt);

    if (this.phase === "between") {
      this.betweenTimer -= dt;
      if (this.betweenTimer <= 0) this.loadStage(this.currentStage + 1);
      return;
    }

    // ── Shop phase ──
    if (this.phase === "shop") {
      this.shopTimer -= dt;
      if (this.shopMsgTimer > 0) this.shopMsgTimer -= dt;

      // Extend prep time: P1 E / P2 / adds 60s (cap 5 minutes)
      if (this.input.wasJustPressed("KeyE") || this.input.wasJustPressed("Slash")) {
        this.shopTimer = Math.min(300, this.shopTimer + 60);
        this.shopMaxTimer = Math.max(this.shopMaxTimer, this.shopTimer);
        if (!this.shopExtended) {
          this.shopExtended = true;
          this.shopMsg = "准备时间延长 +60s（最长5分钟）";
          this.shopMsgTimer = 2.5;
        }
      }

      // P1: Digit1-4 buy for P1, P2: Numpad1-4 buy for P2
      const i1 = this.input.getP1();
      const i2 = this.input.getP2();
      for (let i = 0; i < this.shopItems.length; i++) {
        if (this.input.wasJustPressed(`Digit${i+1}`)) this.buyShopItem(i, 0);
        if (this.input.wasJustPressed(`Numpad${i+1}`)) this.buyShopItem(i, 1);
      }
      // Press Enter/Space to skip shop early
      if (this.input.wasJustPressed("Enter") || this.input.wasJustPressed("Space")) {
        this.shopTimer = 0;
      }
      // 商店阶段也可开仓库/精准装配（B / Num6；I / Num5）
      if (this.input.wasJustPressed("KeyB") || this.input.wasJustPressed("Numpad6")) {
        this.warehouseOpen = !this.warehouseOpen;
      }
      if (this.warehouseMsgTimer > 0) this.warehouseMsgTimer -= dt;
      for (let pi = 0; pi < 2; pi++) this.equipCtrls[pi].update(dt);
      if (this.input.wasJustPressed("KeyI")) this.toggleBackpack(0);
      if (this.input.wasJustPressed("Numpad5")) this.toggleBackpack(1);
      for (let pi = 0; pi < 2; pi++) {
        const held = (pi === 0 ? i1 : i2).inventory;
        if (held && !this.prevInvHeld[pi]) this.toggleBackpack(pi);
        this.prevInvHeld[pi] = held;
      }
      // 触屏"仓库"按钮按下沿 → 开/关仓库
      if (i1.warehouse && !this.prevWhHeld) {
        this.warehouseOpen = !this.warehouseOpen;
        this.backpackOwner = -1;
      }
      this.prevWhHeld = i1.warehouse;
      if (this.backpackOwner >= 0) this.pollEquipGamepad(dt);
      if (this.pendingClick) {
        if (this.tryLevelUpClick()) {
          // 点击到升级选项，已处理
        } else if (this.backpackOwner >= 0) this.handleBackpackClickShared();
        else if (this.warehouseOpen) this.handleWarehouseClickShared();
      }
      this.pendingClick = null;

      if (this.shopTimer <= 0) {
        // Full heal between stages
        for (const p of this.players) {
          if (p.isAlive) p.hp = p.effectiveMaxHp;
        }
        this.base.repairFull();
        this.phase = "between";
        this.betweenTimer = 2;
      }
      return;
    }

    // ── Playing phase：共享战斗帧 ──
    this.updateBattle(dt);
  }

  render(renderer: Renderer, now: number): void {
    renderer.clear("#111");

    this.renderWorld(renderer, now);

    // HUD (screen-space)
    this.renderHUD(renderer);

    // Boss HP bar while playing
    if (this.phase === "playing") this.renderBossBar(renderer);

    // Minimap (top-right)
    this.renderMinimap(renderer);

    // 持久信息栏（场地之外，不遮挡场地）
    this.infoPanel.render(renderer, now);
    this.infoPanel2?.render(renderer, now);

    // 仓库/背包/升级弹窗 + 触屏控件
    this.renderCommonOverlays(renderer);
    this.mobile.render(renderer.ctx);

    // ── Shop overlay（置于最上层，仓库/背包再叠于其上） ──
    if (this.phase === "shop") {
      renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.7)");
      this.renderShop(renderer, now);
      if (this.warehouseOpen) {
        renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.45)");
        this.renderWarehouse(renderer);
      }
      if (this.backpackOwner >= 0) this.renderBackpackOverlay(renderer);
    }

    if (this.phase === "between") {
      renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.6)");
      renderer.drawText(`第 ${this.currentStage} 关通过！`, this.viewW / 2, this.viewH / 2 - 20,
        { font: "28px monospace", color: "#ff0", align: "center" });
      renderer.drawText("准备下一关", this.viewW / 2, this.viewH / 2 + 20,
        { font: "16px monospace", color: "#aaa", align: "center" });
    }

    if (this.phase === "gameover") {
      renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.8)");
      const msg = this.isWin ? "全关通关！恭喜！" : (this.base.isDestroyed ? "基地被摧毁！" : "全员阵亡！");
      renderer.drawText(msg, this.viewW / 2, 40,
        { font: "32px monospace", color: this.isWin ? "#ff0" : "#f44", align: "center" });
      renderer.drawText(`P1 EXP ${this.players[0].stats.exp}   P2 EXP ${this.players[1].stats.exp}`,
        this.viewW / 2, 75,
        { font: "bold 18px sans-serif", color: "#ffd700", align: "center" });
      renderer.drawText(`用时 ${this.elapsedText()}`, this.viewW / 2, 100,
        { font: "14px monospace", color: "#aaa", align: "center" });
      this.renderGameOverStats(renderer);
    }
  }

  private renderShop(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    const W = this.viewW;
    const H = this.viewH;
    const panelW = 460;
    const panelH = 220;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2 - 20;

    ctx.fillStyle = "rgba(0,0,20,0.95)";
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = "#ffd700";
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    renderer.drawText("关 后 商 店", panelX + panelW / 2, panelY + 16,
      { font: "16px monospace", color: "#ffd700", align: "center" });
    // 金币分开显示（博弈）：P1 蓝 / P2 绿，各自金币购买
    renderer.drawText(`P1经验: ${this.players[0].stats.exp}   P2经验: ${this.players[1].stats.exp}`,
      panelX + panelW / 2, panelY + 32,
      { font: "12px monospace", color: "#ff0", align: "center" });

    const btnW = 100;
    const btnH = 60;
    const gap = 8;
    const totalW = this.shopItems.length * (btnW + gap) - gap;
    const startX = panelX + (panelW - totalW) / 2;

    this.shopItems.forEach((item, i) => {
      const bx = startX + i * (btnW + gap);
      const by = panelY + 48;
      const qc: Record<string, string> = { white: "#ddd", blue: "#4af", gold: "#ffd700" };
      const color = item.type === "module" ? (qc[item.quality] || "#ddd") : "#4c4";

      ctx.fillStyle = "#111";
      ctx.fillRect(bx, by, btnW, btnH);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, by, btnW, btnH);

      ctx.fillStyle = color;
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(item.name.slice(0, 8), bx + btnW / 2, by + 16);

      ctx.fillStyle = "#ffd700";
      ctx.font = "11px monospace";
      ctx.fillText(`💰${item.price}`, bx + btnW / 2, by + 34);

      ctx.fillStyle = "#666";
      ctx.font = "8px monospace";
      ctx.fillText(`[${i + 1}]`, bx + btnW / 2, by + 52);
    });

    // Timer bar
    const pct = Math.max(0, this.shopTimer / Math.max(1, this.shopMaxTimer));
    const barY = panelY + panelH - 12;
    ctx.fillStyle = "#222";
    ctx.fillRect(panelX + 4, barY, panelW - 8, 6);
    ctx.fillStyle = pct > 0.5 ? "#4f4" : pct > 0.25 ? "#fa0" : "#f44";
    ctx.fillRect(panelX + 4, barY, (panelW - 8) * pct, 6);

    renderer.drawText(
      `准备时间 ${Math.ceil(this.shopTimer)}s${this.shopExtended ? "  (已延长)" : ""}`,
      panelX + panelW / 2, panelY + panelH + 4,
      { font: "10px monospace", color: this.shopExtended ? "#4af" : "#888", align: "center" });

    if (this.shopMsgTimer > 0) {
      renderer.drawText(this.shopMsg, W / 2, panelY + panelH + 20,
        { font: "14px monospace", color: "#ff0", align: "center" });
    }

    renderer.drawText("按Enter跳过  [1-4]P1买 [小键盘1-4]P2买  E或/延长准备时间", W / 2, panelY + panelH + 36,
      { font: "10px monospace", color: "#666", align: "center" });
  }

  private renderHUD(renderer: Renderer): void {
    const { ctx } = renderer;
    const W = this.viewW; const H = this.viewH;
    const portrait = this.infoW === 0;
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, 0, W, 28);
    renderer.drawText(`关卡 ${this.currentStage}/${TOTAL_STAGES}`, 8, 6, { font: "14px monospace", color: "#ff0" });
    renderer.drawText(`P1 EXP ${this.players[0].stats.exp}`, 150, 5, { font: "bold 14px sans-serif", color: "#ffd700" });
    renderer.drawText(`P2 EXP ${this.players[1].stats.exp}`, 280, 5, { font: "bold 14px sans-serif", color: "#ffd700" });
    // v2.25 竖屏：敌数挪到 340（右上角 x376~474 是视图按钮区，避免文字被按钮盖住）
    renderer.drawText(`敌 ${this.spawnSystem.aliveEnemyCount}+${this.spawnSystem.pendingEnemyCount}`,
      portrait ? 340 : 455, 6, { font: "14px monospace", color: "#f88" });
    renderer.drawText(`仓库[B] ${this.warehouse.usedSlots} ✦${this.warehouse.essence}`,
      portrait ? W - 112 : this.infoX - 8, 6, { font: "12px monospace", color: "#ffd700", align: "right" });
    // v2.25 底部 HP 行：横屏移入右侧信息栏底部（不再压在地图上）；竖屏不画（底部信息栏已含状态）
    if (!portrait) {
      const p1 = this.players[0]; const p2 = this.players[1];
      renderer.drawText(`P1 HP:${Math.ceil(p1.hp)}/${p1.effectiveMaxHp} Lv:${this.levelSystems[0].level} 命${p1.lives}`,
        this.infoX + 6, H - 30, { font: "11px monospace", color: "#4af" });
      renderer.drawText(`P2 HP:${Math.ceil(p2.hp)}/${p2.effectiveMaxHp} Lv:${this.levelSystems[1].level} 命${p2.lives}`,
        this.infoX + 6, H - 16, { font: "11px monospace", color: "#4c4" });
    }
  }
}
