//  EndlessMode.ts ─
// v2.3 无尽模式：连续刷怪 + 波次计数 + 切炮键 + 随机主题地形
// 共享编排（系统构造/战斗帧/背包仓库/装备/击杀/渲染）见 framework/GameModeCore.ts
import { GameModeCore } from "../framework/GameModeCore";
import { generateMap, BIOMES } from "../systems/terrain/MapGenerator";
import type { Enemy } from "../game/Enemy";
import type { GameLayout } from "../types/GameLayout";
import type { Renderer } from "../engine/Renderer";
import { getSoundManager } from "../engine/SoundManager";

export class EndlessMode extends GameModeCore {
  private wave: number = 0;
  private gameOverReason: "base" | "team" = "team";

  constructor(canvas: HTMLCanvasElement, layout?: GameLayout) {
    super(canvas, layout);
  }

  // ── 差异钩子 ──
  /** 无尽：开局随机主题（经典/冰雪/火山/沼泽/钢铁/丛林） */
  protected buildMap(): void {
    generateMap(
      this.tilemap,
      BIOMES[Math.floor(Math.random() * BIOMES.length)],
      Math.floor(Math.random() * 1e9),
      0.25,
    );
  }

  /** 无尽：连续刷怪，按击杀批量推进波次计数 */
  protected configureSpawn(): void {
    this.spawnSystem.continuous = true;
    this.spawnSystem.onWaveComplete = () => { this.wave++; };
  }

  /** 无尽：Tab/ShiftRight 切换当前炮筒 */
  protected handleExtraInput(_i1: unknown, _i2: unknown, _dt: number): void {
    // 切炮已在 GameModeCore.updateBattle 统一处理（键盘 Tab/Shift + 触屏"炮筒"按钮边沿检测）
  }

  protected onBaseDestroyed(): void {
    this.isOver = true;
    this.gameOverReason = "base";
    getSoundManager().play("game_over");
  }

  protected onTeamEliminated(): void {
    this.isOver = true;
    this.gameOverReason = "team";
    getSoundManager().play("game_over");
  }

  /** 无尽：击杀 → addKillBonus（推进连续刷怪波次/难度；Boss 级击杀按出 boss 分数 1/5 加难度分） */
  protected onEnemyKilledBonus(e: Enemy, timeAlive: number): void {
    this.spawnSystem.addKillBonus(timeAlive, e);
  }

  // ── 模式逻辑 ──
  update(dt: number): void {
    if (this.isOver) return;
    this.updateLevelUpAutoPick(dt);
    this.updateBattle(dt);
  }

  render(renderer: Renderer, now: number): void {
    renderer.clear("#111");

    this.renderWorld(renderer, now);

    // HUD (screen-space, not scrolled)
    this.renderHUD(renderer, now);

    // 持久信息栏（场地外，始终可见，不遮挡场地）
    this.infoPanel.render(renderer, now);
    this.infoPanel2?.render(renderer, now);

    // Boss HP bar (screen-space, top)
    this.renderBossBar(renderer);

    // Minimap (top-right)
    this.renderMinimap(renderer);

    // 仓库/背包/升级弹窗 + 触屏控件
    this.renderCommonOverlays(renderer);
    this.mobile.render(renderer.ctx);

    if (this.isOver) this.renderGameOver(renderer);
  }

  private renderGameOver(renderer: Renderer): void {
    renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.8)");
    const msg = this.gameOverReason === "base" ? "基地被摧毁！" : "全员阵亡！";
    renderer.drawText(msg, this.viewW / 2, 40,
      { font: "32px monospace", color: "#f44", align: "center" });
    renderer.drawText(`坚持到第 ${this.wave} 波`, this.viewW / 2, 75,
      { font: "bold 20px sans-serif", color: "#fff", align: "center" });
    renderer.drawText(`用时 ${this.elapsedText()}`, this.viewW / 2, 100,
      { font: "14px monospace", color: "#aaa", align: "center" });
    this.renderGameOverStats(renderer);
  }

  private renderHUD(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    const W = this.viewW; const H = this.viewH;

    // Top bar（v2.24 去掉总分：经验显著化；v2.25 竖屏两行排版，右上角给视图按钮让位；v2.30 新增隐藏分显示）
    const portrait = this.infoW === 0;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0, 0, W, 30);
    if (portrait) {
      renderer.drawText(`波次 ${this.wave}`, 8, 3, { font: "12px monospace", color: "#ff0" });
      renderer.drawText(`P1 EXP ${this.players[0].stats.exp}`, 85, 2,
        { font: "bold 13px sans-serif", color: "#4af" });
      if (this.players.length > 1) {
        renderer.drawText(`P2 EXP ${this.players[1].stats.exp}`, 196, 2,
          { font: "bold 13px sans-serif", color: "#4c4" });
      }
      renderer.drawText(`剩余 ${this.spawnSystem.aliveEnemyCount}+${this.spawnSystem.pendingEnemyCount}/${this.spawnSystem.totalThisWave}`,
        8, 16, { font: "11px monospace", color: "#f88" });
      renderer.drawText(`难度 ${Math.floor(this.spawnSystem.spawnScore)}`,
        120, 16, { font: "11px monospace", color: "#fa0" });
      renderer.drawText(`隐藏分 ${this.spawnSystem.hiddenScoreDisplay}`,
        192, 16, { font: "11px monospace", color: "#b9f" });
      renderer.drawText(`仓库[B] ${this.warehouse.usedSlots} ✦${this.warehouse.essence}`,
        W - 112, 16, { font: "11px monospace", color: "#ffd700", align: "right" });
    } else {
      renderer.drawText(`波次 ${this.wave}`, 8, 7, { font: "14px monospace", color: "#ff0" });
      renderer.drawText(`P1 EXP ${this.players[0].stats.exp}`, 112, 6,
        { font: "bold 15px sans-serif", color: "#4af" });
      if (this.players.length > 1) {
        renderer.drawText(`P2 EXP ${this.players[1].stats.exp}`, 258, 6,
          { font: "bold 15px sans-serif", color: "#4c4" });
      }
      renderer.drawText(`剩余 ${this.spawnSystem.aliveEnemyCount}+${this.spawnSystem.pendingEnemyCount}/${this.spawnSystem.totalThisWave}`,
        380, 7, { font: "12px monospace", color: "#f88" });
      renderer.drawText(`难度 ${Math.floor(this.spawnSystem.spawnScore)}`,
        495, 7, { font: "12px monospace", color: "#fa0" });
      renderer.drawText(`隐藏分 ${this.spawnSystem.hiddenScoreDisplay}`,
        580, 7, { font: "12px monospace", color: "#b9f" });
      renderer.drawText(`仓库[B] ${this.warehouse.usedSlots} ✦${this.warehouse.essence}`,
        this.infoX - 8, 7, { font: "12px monospace", color: "#ffd700", align: "right" });
    }

    // Bottom HUD（v2.24 炮筒切换/模块已移到信息栏；v2.25 横屏块移入右侧信息栏底部，不再遮挡地图；竖屏不画；AI队友不显示P2块）
    if (this.infoW > 0 && !this.infoPanel2) {
      this.renderPlayerHUD(renderer, 0, this.infoX, H - 52);
      if (this.players.length > 1 && !this.isAIPlayer(1)) {
        this.renderPlayerHUD(renderer, 1, this.infoX, H - 104);
      }
    }
  }

  private renderPlayerHUD(renderer: Renderer, pi: number, ox: number, oy: number): void {
    const { ctx } = renderer;
    const p = this.players[pi];
    const ls = this.levelSystems[pi];
    const label = pi === 0 ? "P1" : "P2";
    const col   = pi === 0 ? "#4af" : "#4c4";
    const W = 168; const Hh = 48;

    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.beginPath(); ctx.roundRect(ox, oy, W, Hh, 8); ctx.fill();

    // 名字 + 命数 + 血量（清晰字体）
    renderer.drawText(`${label} ♥${p.lives}`, ox + 8, oy + 4,
      { font: "bold 13px sans-serif", color: p.isAlive ? col : "#666" });
    renderer.drawText(`血 ${Math.ceil(Math.max(0, p.hp))}/${p.effectiveMaxHp}`, ox + W - 8, oy + 4,
      { font: "bold 12px sans-serif", color: "#ddd", align: "right" });

    // HP bar（颜色随血量变化）
    ctx.fillStyle = "#500"; ctx.fillRect(ox + 8, oy + 20, W - 16, 6);
    if (p.isAlive) {
      const f = Math.max(0, p.hp / p.effectiveMaxHp);
      ctx.fillStyle = f > 0.5 ? "#4d4" : f > 0.25 ? "#dd4" : "#d44";
      ctx.fillRect(ox + 8, oy + 20, (W - 16) * f, 6);
    }

    // EXP（醒目大号）+ 等级
    const need = Math.max(1, ls.getExpToNextLevel());
    const frac = Math.min(1, ls.exp / need);
    renderer.drawText(`EXP ${p.stats.exp}`, ox + 8, oy + 28,
      { font: "bold 13px sans-serif", color: "#ffd700" });
    renderer.drawText(`Lv.${ls.level}`, ox + W - 8, oy + 29,
      { font: "bold 11px sans-serif", color: "#88f", align: "right" });
    ctx.fillStyle = "#223"; ctx.fillRect(ox + 8, oy + 43, W - 16, 4);
    ctx.fillStyle = "#6688ff"; ctx.fillRect(ox + 8, oy + 43, (W - 16) * frac, 4);

    // Dead + revive indicator（覆盖显示）
    if (!p.isAlive) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath(); ctx.roundRect(ox, oy, W, Hh, 8); ctx.fill();
      if (p.reviveProgress > 0) {
        renderer.drawText(`救援中 ${Math.floor((p.reviveProgress / 3) * 100)}%`, ox + W / 2, oy + 8,
          { font: "bold 12px sans-serif", color: "#ff0", align: "center" });
        ctx.fillStyle = "#00f4"; ctx.fillRect(ox + 14, oy + 30, W - 28, 6);
        ctx.fillStyle = "#ff0"; ctx.fillRect(ox + 14, oy + 30, (W - 28) * (p.reviveProgress / 3), 6);
      } else {
        renderer.drawText(p.lives > 0 ? "已阵亡 · 等待复活" : "已阵亡 · 永久", ox + W / 2, oy + 14,
          { font: "bold 12px sans-serif", color: "#f66", align: "center" });
      }
    }
  }
}
