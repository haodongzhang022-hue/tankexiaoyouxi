//  DpsTestMode.ts ─
//  v2.3.5 数值打靶测试场：实测三种初始武器在不同距离下的真实 DPS
//  目标曲线校验（800px 宽场地）：
//    1) 炮弹（小炮）：单发高伤，近处因命中销毁后 0.2s 再射 → 近距 DPS 反而最高
//    2) 散弹：近距多弹全中覆盖广，DPS 高于机枪
//    3) 机枪：每发 1 伤持续输出（267px DPS≈3.5）
//    4) 远距(>340px)：只有射程 780 的炮弹仍有效
//  原理：直接驱动真实 Tank.fireWand + WandSystem 发射，按真实弹道/射程/单发限制
//        逐帧结算命中，对每个 (武器 × 距离) 组合自动跑 10 游戏秒，统计伤害 → DPS。
//  加速：每渲染帧内推进 120 步模拟（2 游戏秒/帧），全部 30 组合约 2.5 秒自动跑完，
//        结果表格常驻画面并给出 PASS/FAIL 判定（打靶期间静音防音频风暴）。
import { Renderer } from "../engine/Renderer";
import { WandSystem } from "../systems/wand/WandSystem";
import { Tank, TANK_CONFIGS } from "../game/Tank";
import { projectileHitDamage } from "../systems/combat/CombatSystem";
import { getSoundManager } from "../engine/SoundManager";
import { InputManager } from "../engine/InputManager";
import type { GameLayout } from "../types/GameLayout";
const TEST_SECONDS = 10;           // 每个 (武器×距离) 组合打靶时长（游戏秒）
const SIM_STEPS_PER_FRAME = 120;   // 每渲染帧推进的模拟步数（120×1/60 = 2 游戏秒/帧）
const SIM_DT = 1 / 60;

const WEAPONS: Array<{ idx: number; name: string; color: string }> = [
  { idx: 0, name: "机枪", color: "#8f8" },
  { idx: 1, name: "炮弹", color: "#ffe060" },
  { idx: 2, name: "散弹", color: "#f8f" },
];

const DISTANCES = [0, 50, 100, 150, 200, 267, 336, 400, 500, 600];
const D0 = 267;   // 1/3 屏参考距离

export class DpsTestMode {
  private wandSystem: WandSystem;
  private tank: Tank;
  private worldW: number;
  private worldH: number;
  private tx: number;
  private ty: number;
  private readonly tr = 15;        // 靶子半径 ≈ 坦克半宽(13) + 弹体半径(3)
  private input: InputManager;

  private testIdx = 0;             // 当前组合序号（武器主序 × 距离）
  private simAccum = 0;            // 当前组合已模拟的游戏秒
  private damageAccum = 0;
  private results: Array<{ dps: number[] }> = [];
  private done = false;

  // ── v2.15 手动模式：自动化测试完成后进入，玩家可控制坦克/切换武器/移动靶子 ──
  private manualMode = false;
  private manualWeaponIdx = 0;     // 当前选中的武器索引
  private targetMoveMode = false;  // 靶子移动模式（按T切换，方向键移动靶子）
  private damageNumbers: Array<{ x: number; y: number; value: number; life: number; crit: boolean }> = [];
  private totalDamage = 0;         // 手动模式累计伤害
  private shotsFired = 0;          // 手动模式射击次数
  private hitsLanded = 0;          // 手动模式命中次数
  private manualTime = 0;           // 手动模式累计时间（用于DPS计算）

  // ── v2.15 道具栏：可装备模块测试伤害叠加 ──
  private static readonly TEST_MODULES: Array<{ id: string; name: string; key: string; color: string }> = [
    { id: "mod_damage_up", name: "伤害+50%", key: "Z", color: "#ff8" },
    { id: "mod_damage_up2", name: "伤害+100%", key: "X", color: "#fa4" },
    { id: "mod_split_2", name: "散射一分二", key: "C", color: "#9fe" },
    { id: "mod_pierce_add", name: "+2穿透", key: "V", color: "#8f8" },
    { id: "mod_cooldown_reduce", name: "冷却-30%", key: "B", color: "#f8a" },
    { id: "mod_speed_up", name: "飞速+30%", key: "N", color: "#aff" },
  ];
  private equippedModules: string[] = [];  // 已装备的模块ID（最多3个）
  private moduleSlotIdx = 0;               // 当前选中的模块槽位（0~2）

  constructor(_canvas: HTMLCanvasElement, layout?: GameLayout, input?: InputManager) {
    this.worldW = (layout?.mapCols ?? 25) * 32;
    this.worldH = (layout?.mapRows ?? 20) * 32;
    this.input = input ?? InputManager.getInstance();
    this.wandSystem = new WandSystem();
    this.wandSystem.mapW = this.worldW;
    this.wandSystem.mapH = this.worldH;
    this.tank = new Tank(1, 0, 0, TANK_CONFIGS["tank_light"], this.wandSystem, 120, 320);
    this.tank.facing = "right";
    // 打靶场固定装 3 把测试武器（v2.3.3 初始只装 1 把，这里手动补全，保证测试不受初始配置影响）
    for (let i = 0; i < WEAPONS.length; i++) {
      this.wandSystem.equipModule(this.tank.cannons[i], 0,
        ["proj_pew", "proj_cannon", "proj_pink"][i]);
    }
    // v2.6.3 初始炮筒1改单发主炮：打靶场按武器特性重设单发标志
    //（机枪/散弹按冷却连发保持 DPS 曲线；炮弹保留"命中销毁后0.2s再射"的经典单发测试语义）
    for (const c of this.tank.cannons) c.config.singleShot = false;
    this.tank.cannons[1].config.singleShot = true;
    this.tx = this.tank.x + 267;  // 靶子默认在267px距离
    this.ty = this.tank.y;
    for (let w = 0; w < WEAPONS.length; w++) this.results.push({ dps: DISTANCES.map(() => 0) });
    getSoundManager().setEnabled(false);   // 打靶场静音
  }

  get isDone(): boolean { return this.done; }
  get totalCombos(): number { return WEAPONS.length * DISTANCES.length; }
  get completedCombos(): number { return Math.min(this.testIdx, this.totalCombos); }

  /** 某武器在指定距离下的实测 DPS（供日志读取） */
  getWeaponDps(weaponIdx: number, distance: number): number {
    const di = DISTANCES.indexOf(distance);
    return di >= 0 ? this.results[weaponIdx].dps[di] : 0;
  }

  // ── v2.15 应用已装备的模块到当前武器 ──
  private applyModules(): void {
    const cannon = this.tank.cannons[this.manualWeaponIdx];
    // 清除所有模块槽位（保留第0个投射物模块）
    for (let i = 1; i < cannon.modules.length; i++) {
      cannon.modules[i] = null;
    }
    // 装备已选模块（从第1个槽位开始）
    this.equippedModules.forEach((modId, i) => {
      if (i + 1 < cannon.modules.length) {
        this.wandSystem.equipModule(cannon, i + 1, modId);
      }
    });
  }

  update(dt: number): void {
    // 自动化测试阶段
    if (!this.done) {
      for (let s = 0; s < SIM_STEPS_PER_FRAME; s++) this.simStep();
      if (this.done) {
        // 自动化测试完成，进入手动模式
        this.manualMode = true;
        this.tank.x = 120;
        this.tank.y = this.worldH / 2;
        this.tx = this.tank.x + 267;
        this.ty = this.tank.y;
        this.wandSystem.getProjectiles().length = 0;
        getSoundManager().setEnabled(true);  // 手动模式恢复声音
      }
      return;
    }

    // ── 手动模式：玩家可控制坦克/切换武器/移动靶子 ──
    if (this.manualMode) {
      this.updateManual(dt);
    }
  }

  // ── 手动模式更新 ──
  private updateManual(dt: number): void {
    const inp = this.input;
    this.manualTime += dt;

    // T 键切换靶子移动模式
    if (inp.wasJustPressed("KeyT")) {
      this.targetMoveMode = !this.targetMoveMode;
      getSoundManager().play("pickup");
    }

    // 1/2/3 切换武器
    if (inp.wasJustPressed("Digit1")) { this.manualWeaponIdx = 0; this.applyModules(); getSoundManager().play("pickup"); }
    if (inp.wasJustPressed("Digit2")) { this.manualWeaponIdx = 1; this.applyModules(); getSoundManager().play("pickup"); }
    if (inp.wasJustPressed("Digit3")) { this.manualWeaponIdx = 2; this.applyModules(); getSoundManager().play("pickup"); }
    // Tab 键循环切换武器
    if (inp.wasJustPressed("Tab")) {
      this.manualWeaponIdx = (this.manualWeaponIdx + 1) % WEAPONS.length;
      this.applyModules();
      getSoundManager().play("pickup");
    }

    // ── 道具栏：Z/X/C/V/B/N 装备/卸下模块（最多3个）──
    for (const mod of DpsTestMode.TEST_MODULES) {
      if (inp.wasJustPressed("Key" + mod.key)) {
        const idx = this.equippedModules.indexOf(mod.id);
        if (idx >= 0) {
          // 已装备，卸下
          this.equippedModules.splice(idx, 1);
          this.applyModules();
          getSoundManager().play("pickup");
        } else if (this.equippedModules.length < 3) {
          // 未装备，装备
          this.equippedModules.push(mod.id);
          this.applyModules();
          getSoundManager().play("pickup");
        } else {
          // 槽位已满，替换当前选中的槽位
          this.equippedModules[this.moduleSlotIdx] = mod.id;
          this.applyModules();
          getSoundManager().play("pickup");
        }
      }
    }
    // R 键重置所有模块
    if (inp.wasJustPressed("KeyR")) {
      this.equippedModules = [];
      this.applyModules();
      this.totalDamage = 0;
      this.shotsFired = 0;
      this.hitsLanded = 0;
      this.manualTime = 0;
      getSoundManager().play("pickup");
    }

    // 靶子移动模式：方向键移动靶子
    if (this.targetMoveMode) {
      const speed = 200 * dt;
      if (inp.isHeld("ArrowUp") || inp.isHeld("KeyW")) this.ty -= speed;
      if (inp.isHeld("ArrowDown") || inp.isHeld("KeyS")) this.ty += speed;
      if (inp.isHeld("ArrowLeft") || inp.isHeld("KeyA")) this.tx -= speed;
      if (inp.isHeld("ArrowRight") || inp.isHeld("KeyD")) this.tx += speed;
      // 限制靶子在地图范围内
      this.tx = Math.max(50, Math.min(this.worldW - 50, this.tx));
      this.ty = Math.max(50, Math.min(this.worldH - 50, this.ty));
    } else {
      // 坦克移动模式：WASD 移动坦克
      const speed = 150 * dt;
      let mx = 0, my = 0;
      if (inp.isHeld("KeyW")) { my -= 1; this.tank.facing = "up"; }
      if (inp.isHeld("KeyS")) { my += 1; this.tank.facing = "down"; }
      if (inp.isHeld("KeyA")) { mx -= 1; this.tank.facing = "left"; }
      if (inp.isHeld("KeyD")) { mx += 1; this.tank.facing = "right"; }
      if (mx !== 0 && my !== 0) { mx *= 0.707; my *= 0.707; }
      this.tank.x += mx * speed;
      this.tank.y += my * speed;
      // 限制坦克在地图范围内
      this.tank.x = Math.max(20, Math.min(this.worldW - 20, this.tank.x));
      this.tank.y = Math.max(20, Math.min(this.worldH - 20, this.tank.y));
    }

    // 开火：空格或H键
    const firing = inp.isHeld("Space") || inp.isHeld("KeyH");
    if (firing) {
      this.shotsFired++;
      this.tank.fireWand(dt, this.manualWeaponIdx, true);  // 修复：firing 应为 true
    }

    // 更新投射物
    this.wandSystem.updateProjectiles(
      dt,
      () => null,
      new Map([[this.tank.id, { x: this.tank.x, y: this.tank.y }]]),
    );

    // 命中检测
    for (const p of this.wandSystem.getProjectiles()) {
      if (!p.isAlive) continue;
      const dx = p.x - this.tx;
      const dy = p.y - this.ty;
      const hitR = this.tr + p.radius;
      if (dx * dx + dy * dy <= hitR * hitR) {
        const dmg = projectileHitDamage(p, false);
        this.totalDamage += dmg;
        this.hitsLanded++;
        this.damageNumbers.push({ x: this.tx, y: this.ty - 20, value: dmg, life: 1.0, crit: false });
        p.isAlive = false;
      }
    }

    // 更新伤害数字
    this.damageNumbers = this.damageNumbers.filter(d => {
      d.life -= dt * 1.5;
      d.y -= dt * 30;
      return d.life > 0;
    });

    this.input.flush();
  }

  // ── 模拟核心 ──
  private simStep(): void {
    const w = Math.floor(this.testIdx / DISTANCES.length);
    const di = this.testIdx % DISTANCES.length;
    if (w >= WEAPONS.length) { this.done = true; return; }

    if (this.simAccum === 0) this.beginTest();

    this.simAccum += SIM_DT;
    this.tank.fireWand(SIM_DT, w, true);
    this.wandSystem.updateProjectiles(
      SIM_DT,
      () => null,
      new Map([[this.tank.id, { x: this.tank.x, y: this.tank.y }]]),
    );

    // 真实几何命中结算：弹体中心进入靶圈 (tr + 弹体半径) 即命中
    // 伤害结算复用 CombatSystem.projectileHitDamage，与实机一致（炮弹无衰减=恒定伤害）
    for (const p of this.wandSystem.getProjectiles()) {
      if (!p.isAlive) continue;
      const dx = p.x - this.tx;
      const dy = p.y - this.ty;
      const hitR = this.tr + p.radius;
      if (dx >= -hitR && dx * dx + dy * dy <= hitR * hitR) {
        this.damageAccum += projectileHitDamage(p, false);
        p.isAlive = false;
      }
    }

    if (this.simAccum >= TEST_SECONDS) {
      this.results[w].dps[di] = this.damageAccum / TEST_SECONDS;
      this.testIdx++;
      this.simAccum = 0;   // 下一组合将重新 beginTest
    }
  }

  private beginTest(): void {
    this.simAccum = 0;
    this.damageAccum = 0;
    this.wandSystem.getProjectiles().length = 0;   // 清场
    for (const cannon of this.tank.cannons) {
      cannon.castTimer = 0;
      cannon.cursor = 0;
      cannon.isRecharging = false;
      cannon.rechargeTimer = 0;
    }
    const di = this.testIdx % DISTANCES.length;
    this.tx = this.tank.x + DISTANCES[di];
    this.ty = this.tank.y;
  }

  // ── 渲染 ──
  render(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    renderer.clear("#0b0b12");

    if (this.manualMode) {
      this.renderManualBackground(ctx);
      this.tank.render(renderer, now);
      this.renderDummyTarget(renderer, now);
      this.renderProjectiles(renderer);
      this.renderDamageNumbers(renderer);
      this.renderManualPanel(renderer);
    } else {
      this.renderRange(ctx);
      this.tank.render(renderer, now);
      this.renderTarget(renderer);
      this.renderProjectiles(renderer);
      this.renderPanel(renderer);
    }
  }

  // ── 手动模式背景：网格+距离标记 ──
  private renderManualBackground(ctx: CanvasRenderingContext2D): void {
    // 网格背景
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let x = 0; x < this.worldW; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.worldH); ctx.stroke();
    }
    for (let y = 0; y < this.worldH; y += 32) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.worldW, y); ctx.stroke();
    }
    // 坦克到靶子的连线
    const dist = Math.sqrt((this.tx - this.tank.x) ** 2 + (this.ty - this.tank.y) ** 2);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.tank.x, this.tank.y);
    ctx.lineTo(this.tx, this.ty);
    ctx.stroke();
    ctx.setLineDash([]);
    // 距离显示
    ctx.fillStyle = "#8af";
    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(dist)}px`, (this.tank.x + this.tx) / 2, (this.tank.y + this.ty) / 2 - 8);
  }

  // ── 假人靶子：人形假人，可被攻击 ──
  private renderDummyTarget(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);

    // 靶子底座
    ctx.fillStyle = "#333";
    ctx.fillRect(this.tx - 20, this.ty + 15, 40, 6);
    ctx.fillStyle = "#222";
    ctx.fillRect(this.tx - 15, this.ty + 21, 30, 4);

    // 假人身体（人形）
    // 头
    ctx.fillStyle = this.targetMoveMode ? `rgba(255,200,80,${0.7 + pulse * 0.3})` : "rgba(220,180,140,0.9)";
    if (typeof ctx.arc === "function") {
      ctx.beginPath();
      ctx.arc(this.tx, this.ty - 12, 8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(this.tx - 8, this.ty - 20, 16, 16);
    }
    // 身体
    ctx.fillStyle = this.targetMoveMode ? `rgba(255,150,50,${0.7 + pulse * 0.3})` : "#c44";
    ctx.fillRect(this.tx - 10, this.ty - 4, 20, 22);
    // 手臂
    ctx.fillStyle = this.targetMoveMode ? `rgba(255,150,50,${0.6 + pulse * 0.3})` : "#a33";
    ctx.fillRect(this.tx - 15, this.ty - 2, 5, 16);
    ctx.fillRect(this.tx + 10, this.ty - 2, 5, 16);
    // 腿
    ctx.fillStyle = "#335";
    ctx.fillRect(this.tx - 8, this.ty + 18, 6, 12);
    ctx.fillRect(this.tx + 2, this.ty + 18, 6, 12);

    // 靶心标记
    ctx.strokeStyle = `rgba(255,255,255,${0.5 + pulse * 0.3})`;
    ctx.lineWidth = 1.5;
    if (typeof ctx.arc === "function") {
      ctx.beginPath();
      ctx.arc(this.tx, this.ty + 4, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.tx, this.ty + 4, 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 靶子移动模式提示
    if (this.targetMoveMode) {
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.fillText("← 移动靶子中 →", this.tx, this.ty - 32);
    }
  }

  // ── 伤害数字 ──
  private renderDamageNumbers(renderer: Renderer): void {
    const { ctx } = renderer;
    for (const d of this.damageNumbers) {
      const alpha = Math.min(1, d.life);
      ctx.fillStyle = `rgba(255,${d.crit ? 100 : 220},${d.crit ? 100 : 80},${alpha})`;
      ctx.font = `bold ${d.crit ? 16 : 13}px monospace`;
      ctx.textAlign = "center";
      ctx.fillText(`-${d.value}`, d.x, d.y);
    }
  }

  // ── 手动模式面板：武器选择+道具栏+统计+操作提示 ──
  private renderManualPanel(renderer: Renderer): void {
    const { ctx } = renderer;
    const W = renderer.width;
    const panelW = 340;
    const x0 = W - panelW - 8;
    const panelH = 280;

    // 面板背景
    ctx.fillStyle = "rgba(8,8,18,0.88)";
    ctx.fillRect(x0, 4, panelW, panelH);
    ctx.strokeStyle = "#335";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, 4.5, panelW - 1, panelH - 1);

    // 标题
    renderer.drawText("🎯 手动打靶测试场", x0 + 8, 10,
      { font: "13px monospace", color: "#ffd700" });

    // 武器选择
    renderer.drawText("武器选择 (1/2/3 或 Tab):", x0 + 8, 30,
      { font: "11px monospace", color: "#8af" });
    WEAPONS.forEach((w, i) => {
      const sel = i === this.manualWeaponIdx;
      const wx = x0 + 8 + i * 106;
      ctx.fillStyle = sel ? "rgba(40,80,40,0.8)" : "rgba(30,30,40,0.6)";
      ctx.fillRect(wx, 44, 98, 24);
      ctx.strokeStyle = sel ? w.color : "#445";
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(wx + 0.5, 44.5, 97, 23);
      renderer.drawText(`${i + 1}.${w.name}`, wx + 4, 50,
        { font: "11px monospace", color: sel ? w.color : "#888" });
    });

    // ── 道具栏：已装备模块 ──
    renderer.drawText("已装备道具 (最多3个):", x0 + 8, 78,
      { font: "11px monospace", color: "#f8a" });
    for (let i = 0; i < 3; i++) {
      const sx = x0 + 8 + i * 106;
      const modId = this.equippedModules[i];
      const modInfo = modId ? DpsTestMode.TEST_MODULES.find(m => m.id === modId) : null;
      ctx.fillStyle = modInfo ? "rgba(60,30,50,0.8)" : "rgba(20,20,30,0.6)";
      ctx.fillRect(sx, 92, 98, 24);
      ctx.strokeStyle = modInfo ? modInfo.color : "#334";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 0.5, 92.5, 97, 23);
      if (modInfo) {
        renderer.drawText(modInfo.name, sx + 4, 98,
          { font: "10px monospace", color: modInfo.color });
      } else {
        renderer.drawText("空槽位", sx + 4, 98,
          { font: "10px monospace", color: "#445" });
      }
    }

    // ── 可用道具列表 ──
    renderer.drawText("可用道具 (按键装备/卸下):", x0 + 8, 124,
      { font: "11px monospace", color: "#8f8" });
    DpsTestMode.TEST_MODULES.forEach((mod, i) => {
      const equipped = this.equippedModules.includes(mod.id);
      const mx = x0 + 8 + (i % 3) * 106;
      const my = 138 + Math.floor(i / 3) * 22;
      ctx.fillStyle = equipped ? "rgba(40,60,40,0.8)" : "rgba(25,25,35,0.6)";
      ctx.fillRect(mx, my, 98, 20);
      ctx.strokeStyle = equipped ? mod.color : "#334";
      ctx.lineWidth = equipped ? 2 : 1;
      ctx.strokeRect(mx + 0.5, my + 0.5, 97, 19);
      renderer.drawText(`[${mod.key}] ${mod.name}`, mx + 3, my + 4,
        { font: "9px monospace", color: equipped ? mod.color : "#778" });
    });

    // ── 统计信息 ──
    const accuracy = this.shotsFired > 0 ? (this.hitsLanded / this.shotsFired * 100).toFixed(1) : "0.0";
    const dps = this.manualTime > 0 ? (this.totalDamage / this.manualTime).toFixed(1) : "0.0";
    renderer.drawText(`总伤害: ${this.totalDamage}  DPS: ${dps}`, x0 + 8, 188,
      { font: "11px monospace", color: "#8f8" });
    renderer.drawText(`射击: ${this.shotsFired}  命中: ${this.hitsLanded}  命中率: ${accuracy}%`, x0 + 8, 204,
      { font: "11px monospace", color: "#ccc" });

    // 靶子位置
    const dist = Math.sqrt((this.tx - this.tank.x) ** 2 + (this.ty - this.tank.y) ** 2);
    renderer.drawText(`靶子距离: ${Math.round(dist)}px`, x0 + 8, 220,
      { font: "11px monospace", color: "#8af" });

    // 操作提示
    renderer.drawText("WASD: 移动坦克  空格/H: 开火", x0 + 8, 240,
      { font: "10px monospace", color: "#666" });
    renderer.drawText("T: 切换靶子移动  1/2/3/Tab: 切换武器", x0 + 8, 252,
      { font: "10px monospace", color: "#666" });
    renderer.drawText("Z/X/C/V/B/N: 装备道具  R: 重置统计", x0 + 8, 264,
      { font: "10px monospace", color: "#666" });
    renderer.drawText("ESC: 返回主菜单", x0 + 8, 276,
      { font: "10px monospace", color: "#666" });

    // 靶子移动模式提示
    if (this.targetMoveMode) {
      ctx.fillStyle = "rgba(255,200,0,0.15)";
      ctx.fillRect(x0, 0, panelW, 4);
    }
  }

  private renderRange(ctx: CanvasRenderingContext2D): void {
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(this.tank.x, this.tank.y);
    ctx.lineTo(this.tx, this.ty);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const d of DISTANCES) {
      const x = this.tank.x + d;
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillRect(x - 1, this.ty - 30, 2, 60);
    }
    ctx.fillStyle = "#666";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    for (const d of DISTANCES) ctx.fillText(`${d}`, this.tank.x + d, this.ty + 36);
  }

  private renderTarget(renderer: Renderer): void {
    renderer.fillCircle(this.tx, this.ty, this.tr, "rgba(255,70,70,0.6)");
    renderer.fillCircle(this.tx, this.ty, this.tr - 4, "rgba(120,20,20,0.7)");
    renderer.fillCircle(this.tx, this.ty, 3, "#ffd700");
  }

  private renderProjectiles(renderer: Renderer): void {
    for (const p of this.wandSystem.getProjectiles()) {
      if (!p.isAlive) continue;
      renderer.fillCircle(p.x, p.y, Math.max(2, p.radius), p.color);
    }
  }

  private renderPanel(renderer: Renderer): void {
    const { ctx } = renderer;
    const W = renderer.width;
    const panelW = 480;
    const x0 = 8;

    ctx.fillStyle = "rgba(8,8,18,0.82)";
    ctx.fillRect(x0, 4, panelW, this.done ? 322 : 96);
    ctx.strokeStyle = "#335";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, 4, panelW, this.done ? 322 : 96);

    renderer.drawText("数值打靶测试场 · 10s 实测 DPS", x0 + 8, 8,
      { font: "13px monospace", color: "#ffd700" });
    renderer.drawText("目标(v2.3.5): 炮弹近距销毁再射·DPS反升 · 近距散弹覆盖广 · 机枪1伤持续", x0 + 8, 22,
      { font: "10px monospace", color: "#999" });

    if (!this.done) {
      const pct = this.testIdx / this.totalCombos;
      renderer.drawText(`测试中… 组合 ${this.completedCombos}/${this.totalCombos}（武器×距离）`, x0 + 8, 40,
        { font: "11px monospace", color: "#8af" });
      ctx.fillStyle = "#222"; ctx.fillRect(x0 + 8, 52, panelW - 16, 6);
      ctx.fillStyle = "#4af"; ctx.fillRect(x0 + 8, 52, (panelW - 16) * pct, 6);
      // 当前测试：坦克实时开火展示
      const w = Math.min(WEAPONS.length - 1, Math.floor(this.testIdx / DISTANCES.length));
      const di = Math.min(DISTANCES.length - 1, this.testIdx % DISTANCES.length);
      renderer.drawText(
        `当前: ${WEAPONS[w].name} @ ${DISTANCES[di]}px  伤害 ${this.damageAccum.toFixed(0)}`,
        x0 + 8, 64, { font: "10px monospace", color: "#ccc" });
      renderer.drawText("ESC 返回菜单", x0 + 8, 80, { font: "10px monospace", color: "#555" });
      return;
    }

    // ── 结果表格 ──
    const cols = ["距离", "机枪", "炮弹", "散弹", "最佳"];
    const colX = [x0 + 8, x0 + 78, x0 + 138, x0 + 198, x0 + 262];
    const rowH = 20;
    const top = 42;

    ctx.fillStyle = "rgba(30,40,60,0.9)";
    ctx.fillRect(x0, top - 18, panelW - 16, rowH);
    ctx.fillStyle = "#8cf";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    cols.forEach((c, i) => ctx.fillText(c, colX[i], top - 14));

    const mg = this.results[0].dps, sn = this.results[1].dps, sg = this.results[2].dps;
    DISTANCES.forEach((d, di) => {
      const rowY = top + di * rowH;
      if (d === D0) {
        ctx.fillStyle = "rgba(255,215,0,0.10)";
        ctx.fillRect(x0, rowY - 2, panelW - 16, rowH);
      }
      ctx.fillStyle = d === D0 ? "#ffd700" : "#ccc";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(d === D0 ? `${d}px ★` : `${d}px`, colX[0], rowY + 2);
      const vals = [mg[di], sn[di], sg[di]];
      ctx.fillStyle = "#8f8"; ctx.fillText(vals[0].toFixed(1), colX[1], rowY + 2);
      ctx.fillStyle = "#ffe060"; ctx.fillText(vals[1].toFixed(1), colX[2], rowY + 2);
      ctx.fillStyle = "#f8f"; ctx.fillText(vals[2].toFixed(1), colX[3], rowY + 2);
      // 最佳列：1/3屏内近平→标≈，否则标最大者
      const max = Math.max(...vals);
      if (max > 0) {
        const maxIdx = vals.indexOf(max);
        if (d === D0 && (max - Math.min(...vals)) / max <= 0.15) {
          ctx.fillStyle = "#ffd700";
          ctx.fillText("≈持平", colX[4], rowY + 2);
        } else {
          ctx.fillStyle = WEAPONS[maxIdx].color;
          ctx.fillText(WEAPONS[maxIdx].name + "★", colX[4], rowY + 2);
        }
      } else {
        ctx.fillStyle = "#555";
        ctx.fillText("-", colX[4], rowY + 2);
      }
    });

    // ── 判定（v2.3.5 武器特色化）──
    const closeI = DISTANCES.indexOf(100);
    const farI = DISTANCES.indexOf(500);
    const midI = DISTANCES.indexOf(267);
    const pointBlankI = DISTANCES.indexOf(0);
    // 1) 炮弹近距>中距>远距：命中销毁后 0.2s 再射 → 近距 DPS 反而最高
    const falloffPass = sn[pointBlankI] > sn[midI] && sn[midI] > sn[farI];
    // 2) 近距(100px)：散弹覆盖广，DPS 高于机枪
    const closePass = sg[closeI] > mg[closeI];
    // 3) 远距(500px)：只有炮弹有效（机枪/散弹射程外）
    const farPass = sn[farI] > 0 && mg[farI] === 0 && sg[farI] === 0;
    // 4) 机枪 1伤/发：267px 实测 DPS ≈ 3.5（3.5发/s × 1伤），波动区间 2.5~4.5
    const mgPass = mg[D0] >= 2.5 && mg[D0] <= 4.5;

    const vy = top + DISTANCES.length * rowH + 4;
    renderer.drawText(`${falloffPass ? "✓" : "✗"} 炮弹近距销毁再射: 贴脸${sn[pointBlankI].toFixed(1)} > 267px${sn[midI].toFixed(1)} > 500px${sn[farI].toFixed(1)}`,
      x0 + 8, vy, { font: "11px monospace", color: falloffPass ? "#4f4" : "#f44" });
    renderer.drawText(`${closePass ? "✓" : "✗"} 近距(100px)散弹覆盖广: 散弹${sg[closeI].toFixed(1)} > 机枪${mg[closeI].toFixed(1)}（多弹命中）`,
      x0 + 8, vy + 16, { font: "11px monospace", color: closePass ? "#4f4" : "#f44" });
    renderer.drawText(`${farPass ? "✓" : "✗"} 远距(500px)仅炮弹有效: 炮弹${sn[farI].toFixed(1)}（机枪/散弹已超射程）`,
      x0 + 8, vy + 32, { font: "11px monospace", color: farPass ? "#4f4" : "#f44" });
    renderer.drawText(`${mgPass ? "✓" : "✗"} 机枪每发1伤: 267px DPS=${mg[D0].toFixed(1)}（应在2.5~4.5）`,
      x0 + 8, vy + 48, { font: "11px monospace", color: mgPass ? "#4f4" : "#f44" });
    renderer.drawText("ESC 返回菜单", x0 + 8, vy + 66, { font: "10px monospace", color: "#555" });
  }
}
