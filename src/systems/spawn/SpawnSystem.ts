// SpawnSystem.ts - Wave spawning, top-only spawn points
// v2.34 刷怪难度系统（用户定稿 v4：慢升 + 慢降 + 首怪 + 大怪更贵）：
//   1. 难度分从 1 开始，按场上敌人数分档（每秒）：0只 +2（清全场会加速，防止无限好刷）/
//      ≤3只 +0.5 / ≤10只 +0.2 / ≤30只 +0.1 / >30只 −0.1（怪太多玩家扛不住 → 难度回落）；
//   2. 开局首怪：进场立即生成 1 只最弱敌，避免"0 怪状态"把难度瞬间顶高；
//   3. 隐藏分池 = 难度分 × 0.1 每秒累积，出怪时消耗（骰子不加难度）；
//   4. 每 3 秒一颗出怪骰：消耗 = 随机 1~20% 池子取整（控制消耗速度，让池子能攒起来）；
//   5. Boss 事件（每 60 秒一次）：池子够 S(400分) 才出，升序选"能负担的最强档"，
//      余量 > 50 再出一个小 boss；1 分钟时池子不够 → 不会过早出现 400 血 boss；
//   6. 击杀 Boss 级（S 及以上）→ 按其出 boss 分数的 1/5 加到难度分（越打越难）。
import { Enemy, type EnemyGrade } from "../../game/Enemy";
import { WandSystem } from "../wand/WandSystem";
import { TILE_SIZE } from "../../game/Tilemap";

export interface SpawnPoint { x: number; y: number; }

// Pending spawn: shows warning glow before enemy appears
export interface PendingSpawn {
  x: number; y: number;
  grade: EnemyGrade;
  delay: number;  // seconds until enemy appears
  maxDelay: number;
}

export interface WaveConfig {
  wave: number;
  count: number;
  gradeWeights: Record<EnemyGrade, number>;
  spawnInterval: number;
}

// 四档概率权重（v2.25 起仅作文档参考，连续模式已改为骰子制）：
const TIER_WEIGHTS: Record<EnemyGrade, number> = { F:18, C:6, B:2, A:1, S:0, S2:0, S3:0, S4:0, S5:0, BOSS:0 };
// 各档积分（v2.34 阶梯：F=1 / C=5 / B=15 / A=45 / S=400 / S2=800 / S3=1600 / S4=3200 / S5=6000 / BOSS=10000）
//   "能转化多少转化多少"：质量阶梯按积分池购买，S 系列同时有难度阈值门槛（TIER_GATE）
//   v2.34：400 血 S 级门槛提高（400 分），1 分钟时池子不够 → 不会过早出现；等高阶同步上移
const TIER_COST: Record<EnemyGrade, number> = { F:1, C:5, B:15, A:45, S:400, S2:800, S3:1600, S4:3200, S5:6000, BOSS:10000 };

// v2.27 质量阶梯（骰子升档用）+ 各档解锁门槛（难度分达到门槛后才有资格被掷出）
const QUALITY_LADDER: EnemyGrade[] = ["C", "B", "A", "S", "S2", "S3", "S4", "S5"];
const TIER_GATE: Partial<Record<EnemyGrade, number>> = { C: 0, B: 8, A: 18, S: 32, S2: 420, S3: 900, S4: 1500, S5: 2200 };

// ── v2.34 难度分推进：难度分从 1 开始，按场上敌人数分档（每秒）──
//   0只 +2（玩家清全场 → 加速，防止无限好刷）/ ≤3只 +0.5 / ≤10只 +0.2 / ≤30只 +0.1 / >30只 −0.1（怪太多 → 降难度）
const DIFF_START = 1;
const DIFF_GAIN_TIERS: Array<[number, number]> = [[0, 2.0], [3, 0.5], [10, 0.2], [30, 0.1], [Infinity, -0.1]];
const HIDDEN_SCORE_RATIO = 0.1;    // 隐藏分池累积 = 难度分 × 0.1 / 秒
const DICE_INTERVAL = 3.0;         // 出怪骰间隔（秒，v2.33 ×3：出怪频率降低 66.7%）

// ── v2.34 出怪骰·普通区间：消耗 = 随机 1~20% 池子取整（v2.34 从 30% 降到 20%：避免池子被抽干、boss 分数攒不起来）──
const DICE_SPEND_MIN_RATIO = 0.01;
const DICE_SPEND_MAX_RATIO = 0.20;
const MAX_UNITS_PER_ROLL = 6;      // 单次骰子最多 6 辆（防开局爆发）

// ── v2.33 Boss 事件：每 60 秒一次，消耗池子出最强的可负担 boss；余量 > 50 再出一个小 boss ──
const BOSS_EVENT_INTERVAL = 60;    // boss 事件间隔（秒）
const BOSS_SECOND_MIN_REMAINDER = 50; // 余量超过该值 → 追加一个副 boss
const ELITE_LADDER: EnemyGrade[] = ["S", "S2", "S3", "S4", "S5", "BOSS"]; // 分数→boss 转化阶梯（池子够哪档买哪档）
const LADDER_DOWN: EnemyGrade[] = ["S5", "S4", "S3", "S2", "S", "A", "B", "C", "F"];

function gradeForWave(wave: number): Record<EnemyGrade, number> {
  // v2.3.4：基础四档概率比 18:6:2:1 恒定（低级占多数、高级稀有），
  // 随波次解锁更多 S 精英；每5波固定 BOSS
  const boss = (wave % 5 === 0) ? 1 : 0;
  const sElite = boss ? 0 : Math.min(0.01 + wave * 0.008, 0.05);
  return { F:18, C:6, B:2, A:1, S: sElite, S2:0, S3:0, S4:0, S5:0, BOSS: boss };
}

function pickGrade(weights: Record<EnemyGrade, number>): EnemyGrade {
  const grades: EnemyGrade[] = ["F","C","B","A","S","S2","S3","S4","S5","BOSS"];
  const total = grades.reduce((s, g) => s + (weights[g] || 0), 0);
  let r = Math.random() * total;
  for (const g of grades) { r -= (weights[g] || 0); if (r <= 0) return g; }
  return "F";
}

// 出生点卡墙修复：各档敌人半宽（视觉尺寸+余量），用于出生空位校验
const GRADE_HALF: Record<EnemyGrade, number> = { F:14, C:15, B:16, A:17, S:20, S2:22, S3:24, S4:26, S5:28, BOSS:28 };

export class SpawnSystem {
  private spawnPoints: SpawnPoint[] = [];
  private pendingCount: number = 0;
  private spawnedThisWave: number = 0;
  private spawnTimer: number = 0;
  private currentWaveConfig: WaveConfig | null = null;
  private wandSystem: WandSystem;
  private baseX: number = 0;
  private baseY: number = 0;

  // Continuous (endless) mode: auto-refill enemies without waiting for all to die
  continuous: boolean = false;

  // ── v2.3.4 积分预算制状态 ──
  private difficultyTime: number = 0;   // 难度时钟（秒，用于出 boss 区间开启）
  private totalKills: number = 0;       // 累计击杀
  private spawnBudget: number = 0;      // （旧）已累积的"积分"
  private continuousWaveKills: number = 0; // kills this wave

  // ── v2.33 难度分 + 隐藏分池 + 出怪骰 ──
  // 难度分：从 1 开始按场上敌人数分档缓慢上涨（×1/3，用户定稿）；隐藏分池 = 难度分 × 0.1 /秒，
  // 出怪时消耗（玩家不可见）：出得厉害→池子被抽干→下一秒出得少，形成平滑的质量转化曲线。
  private difficulty: number = DIFF_START;
  private hiddenScore: number = 0;
  private rollTimer: number = 0;        // 每 3 秒摇一次出怪骰子（v2.33 频率 ×1/3）
  private bossTimer: number = BOSS_EVENT_INTERVAL; // v2.33 Boss 事件倒计时（每 60s 一次）
  private firstWaveSpawned = false;     // v2.34 开局首怪：进场立即放 1 只最弱敌

  // 玩家数量缩放：1人=1.0 / 2人=1.5 / 3人=2.0 / 4人=2.5。
  playerCountScale: number = 1;

  // Boss: only one on the field at a time, plus a cooldown after each boss
  private bossCooldown: number = 0;

  activeEnemies: Enemy[] = [];
  pendingSpawns: PendingSpawn[] = [];  // warning beacons before spawn

  /** v2.31 难度分（从 1 缓慢上涨；无尽 HUD「难度」显示用） */
  spawnScore: number = 0;
  totalThisWave: number = 0;

  /** v2.30 隐藏分（HUD「隐藏分」显示用；整数化） */
  get hiddenScoreDisplay(): number { return Math.floor(this.hiddenScore); }

  /** 出生空位校验（由模式注入）：返回 (x,y) 处能否放下 hw×hh 的坦克（true=可放/无墙） */
  isSpawnClear?: (x: number, y: number, hw: number, hh: number) => boolean;

  onEnemySpawned?: (e: Enemy) => void;
  onWaveComplete?: (wave: number) => void;

  constructor(wandSystem: WandSystem) { this.wandSystem = wandSystem; }

  setSpawnPoints(pts: SpawnPoint[]): void { this.spawnPoints = pts; }
  setBase(bx: number, by: number): void { this.baseX = bx; this.baseY = by; }

  /** 创建一个敌人并接入系统（统一接线：出生回调 + 精英召唤小兵） */
  private createEnemy(grade: EnemyGrade, x: number, y: number): Enemy {
    const e = new Enemy(grade, x, y, this.wandSystem, this.baseX, this.baseY);
    // v2.3 精英召唤：A/S/BOSS 召唤的 F 级小兵也接入同一系统（可再被精英召唤）
    e.onSummon = (sx, sy) => this.spawnEnemyAt("F", sx, sy);
    this.activeEnemies.push(e);
    this.onEnemySpawned?.(e);
    return e;
  }

  /** v2.3 精英召唤：直接在指定位置生成小兵（不经出生预警，靠近召唤者） */
  spawnEnemyAt(grade: EnemyGrade, x: number, y: number): void {
    // 限制地图边界与出生区，避免召唤到地图外
    const margin = 32;
    const cx = Math.max(margin, Math.min(this.mapW - margin, x));
    const cy = Math.max(margin, Math.min(this.mapH - margin, y));
    // 就近找一个无墙空格，避免召唤进墙里卡死
    const spot = this.findSpawnSpot(cx, cy, grade);
    this.createEnemy(grade, spot.x, spot.y);
    this.totalThisWave++;
  }

  /** 在 (cx,cy) 附近（最多 3 格半径）找一个能放下 hw×hh 的空位；找不到则回退原位（概率极低） */
  private findSpawnSpot(cx: number, cy: number, grade: EnemyGrade): { x: number; y: number } {
    if (!this.isSpawnClear) return { x: cx, y: cy };
    const hw = GRADE_HALF[grade];
    const step = 16;                                   // 检索步长（半格）
    for (let r = 0; r <= TILE_SIZE * 3; r += step) {
      for (let i = 0; i < 16; i++) {                   // 每圈 16 个方向
        const a = (i / 16) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(a) * r);
        const y = Math.round(cy + Math.sin(a) * r);
        if (this.isSpawnClear(x, y, hw, hw)) return { x, y };
      }
    }
    return { x: cx, y: cy };
  }

  // 地图尺寸（用于召唤范围钳制）
  private mapW = 800;
  private mapH = 640;
  setMapSize(w: number, h: number): void { this.mapW = w; this.mapH = h; }

  get aliveEnemyCount(): number {
    return this.activeEnemies.filter(e => e.isAlive).length;
  }
  get pendingEnemyCount(): number {
    return this.pendingCount;
  }

  startWave(wave: number): void {
    // 每波敌人数：平缓线性增长（早期 8 个起步，后期慢慢增多），避免指数爆炸
    const count = Math.round(6 + wave * 2.2);
    this.currentWaveConfig = {
      wave, count,
      gradeWeights: gradeForWave(wave),
      // v2.3：关卡模式出怪也放缓并按玩家数缩放（1人×2慢 / 2人×1.33慢）
      spawnInterval: Math.max(0.4, (1.0 - wave * 0.02) * 2 / Math.max(1, this.playerCountScale)),
    };
    this.pendingCount = count;
    this.totalThisWave = count;
    this.spawnedThisWave = 0;
    this.spawnTimer = 0;
    this.activeEnemies = this.activeEnemies.filter(e => e.isAlive);
  }

  addKillBonus(timeAlive: number, enemy?: Enemy): void {
    this.totalKills += 1;
    // v2.31（用户定稿）：打死 Boss 级（S 及以上）→ 按其出 boss 分数的 1/5 直接加到难度分
    if (enemy && ELITE_LADDER.includes(enemy.grade)) {
      this.difficulty += (TIER_COST[enemy.grade] || 0) / 5;
    }
    // Continuous mode: track kills for wave counter
    if (this.continuous) {
      this.continuousWaveKills++;
      if (this.continuousWaveKills >= 8) {
        this.continuousWaveKills = 0;
        this.totalThisWave = 0;  // 新一波重置"本波已出怪数"（HUD 显示更准确）
        this.onWaveComplete?.(0);  // signal wave increment
      }
    }
  }

  /** v2.33 难度分推进（用户定稿）：按场上敌人数分档 +0.667/+0.333/+0.1/+0.067/+0.033 每秒（玩家数多倍率） */
  private advanceDifficulty(dt: number): void {
    const alive = this.aliveEnemyCount;
    let rate = DIFF_GAIN_TIERS[DIFF_GAIN_TIERS.length - 1][1];
    for (const [cap, r] of DIFF_GAIN_TIERS) { if (alive <= cap) { rate = r; break; } }
    this.difficulty += rate * dt * Math.max(1, this.playerCountScale);
  }

  private gradeForScore(): Record<EnemyGrade, number> {
    // 难度转化机制：随难度提升，权重从低级(F)向高级(C/B/A)偏移
    // 低难度：F占多数（18:6:2:1）；高难度：F减少，C/B/A增多（质量转化）
    const B = this.spawnScore;
    const df = Math.min(1, B / 60); // 0→1 难度因子（B=60时达到最大转化）
    const fW = Math.max(4, 18 - df * 12);   // F: 18→4（最多只剩4个F的权重）
    const cW = 6 + df * 8;                   // C: 6→14
    const bW = 2 + df * 6;                   // B: 2→8
    const aW = 1 + df * 4;                   // A: 1→5
    const s = B > 45 ? Math.min(0.08, (B - 45) / 600) : 0;
    const boss = B > 90 ? Math.min(0.06, (B - 90) / 900) : 0;
    return { F: fW, C: cW, B: bW, A: aW, S: s, S2: 0, S3: 0, S4: 0, S5: 0, BOSS: boss };
  }

  /** Is a boss already on the field or waiting to spawn? */
  private bossInPlay(): boolean {
    return this.activeEnemies.some(e => e.isAlive && e.isBoss) ||
           this.pendingSpawns.some(ps => ps.grade === "BOSS");
  }

  /** 直接生成一个敌人（出生预警 + 接线），BOSS 带冷却 */
  private spawnOneFor(grade: EnemyGrade): EnemyGrade {
    if (!this.spawnPoints.length) return grade;
    const pt = this.spawnPoints[Math.floor(Math.random() * this.spawnPoints.length)];
    const delay = grade === "BOSS" ? 3.0 : 1.5;
    if (grade === "BOSS") this.bossCooldown = 180;
    // 就近找无墙空格（含随机偏移），出生预警与实际落地位置一致，杜绝"卡在墙里出不来"
    const jx = pt.x + (Math.random() - 0.5) * 32;
    const jy = pt.y + (Math.random() - 0.5) * 16;
    const spot = this.findSpawnSpot(jx, jy, grade);
    this.pendingSpawns.push({
      x: spot.x,
      y: spot.y,
      grade,
      delay,
      maxDelay: delay,
    });
    return grade;
  }

  /** 按权重随机选档，BOSS 已被占/冷却时降为 S（闯关模式用） */
  private spawnOne(weights: Record<EnemyGrade, number>): EnemyGrade {
    if (!this.spawnPoints.length) return "F";
    let grade = pickGrade(weights);
    if (grade === "BOSS" && (this.bossInPlay() || this.bossCooldown > 0)) grade = "S";
    return this.spawnOneFor(grade);
  }

  /**
   * v2.31 出怪骰（连续模式核心，每秒一颗）— 用户定稿机制：
   *  1. 「出 boss 区间」：概率随难度时钟开启（90s 起 0% → 690s 约 25% 上限）。
   *     摇中 → 把当前隐藏分转化成"能负担的最高档 boss"（S→S2→…→BOSS，从池子扣其成本，
   *     剩下的继续攒着；BOSS 仍受"场上唯一 + 冷却"限制）；转化后有 15s 精英冷却。
   *  2. 「普通区间」：80% 数字区消耗 1~30；20% 百分比区消耗 1%~30% 池子。
   *     池子不够 → "没出现成功"（不扣分、不出怪，池子跨秒累积攒 boss）。
   *  3. 消耗额度按质量骰购买怪物（升档 + 高斯阶梯 + 买不起降级），单次最多 6 辆。
   *  4. 所有出怪一律扣隐藏分（骰子不涨难度）—— 出多出强后池子自动回落，形成平滑难度曲线。
   */
  private trySpawnDice(): void {
    if (this.hiddenScore < 1 || this.spawnPoints.length === 0) return;

    // ── 普通区间（v2.33）：消耗 = 随机 1~30% 池子取整 ──
    const spend = Math.max(1, Math.floor(this.hiddenScore * (DICE_SPEND_MIN_RATIO + Math.random() * (DICE_SPEND_MAX_RATIO - DICE_SPEND_MIN_RATIO))));
    // 池子不够 → "没出现成功"（不扣分、不出怪；池子继续累积）
    if (this.hiddenScore < spend) return;

    const diff2 = Math.min(1, this.difficulty / 500);                  // 质量难度因子：难度分≈500 → 满
    const conv = Math.min(0.8, 0.18 + diff2 * 0.62);                   // 质量转化率 18%→80%
    let spent = 0;
    let units = 0;
    while (units < MAX_UNITS_PER_ROLL) {
      const remaining = spend - spent;
      if (remaining < 1) break;                                        // 额度耗尽 → 停止
      let grade = this.rollQualityDice(conv, diff2, this.difficulty);
      if (this.tierCost(grade, diff2) > remaining) {
        // 降级：沿质量阶梯往下找"已解锁且负担得起"的最高档（能转化多少转化多少）
        grade = "F";
        for (const g of LADDER_DOWN) {
          if (this.difficulty >= (TIER_GATE[g] ?? 9999) && this.tierCost(g, diff2) <= remaining) { grade = g; break; }
        }
      }
      spent += this.tierCost(grade, diff2);
      this.spawnOneFor(grade);
      this.totalThisWave++;
      units++;
    }
    this.hiddenScore -= spent;                                         // 所有出怪一律扣隐藏分
  }

  /**
   * v2.33 Boss 事件（每 60 秒一次）：消耗池子出"能负担的最强 boss"（S→…→BOSS），
   * 余量 > 50 再追加一个副 boss；池子不够 S（135）→ 本秒跳过，池子继续攒。
   */
  private trySpawnBossEvent(): void {
    if (this.spawnPoints.length === 0) return;
    if (this.hiddenScore < TIER_COST["S"]) return;                     // 池子不够最便宜 boss → 继续攒
    for (let round = 0; round < 2; round++) {
      if (round === 1 && this.hiddenScore <= BOSS_SECOND_MIN_REMAINDER) break; // 余量不足 → 只出主 boss
      let pick: EnemyGrade | null = null;
      for (const g of ELITE_LADDER) {
        if (g === "BOSS" && (this.bossInPlay() || this.bossCooldown > 0)) continue;
        if (this.hiddenScore >= TIER_COST[g]) pick = g;                // 升序覆盖 → 最强可负担
      }
      if (!pick) break;
      this.hiddenScore -= TIER_COST[pick];
      this.spawnOneFor(pick);                                          // spawnOneFor 内部给 BOSS 设置冷却
      this.totalThisWave++;
    }
  }

  /** v2.27 消耗随难度略涨（基础成本 × (1 + 难度因子×0.35)） */
  private tierCost(grade: EnemyGrade, diff2: number): number {
    const base = TIER_COST[grade] || 1;
    return Math.max(1, Math.round(base * (1 + diff2 * 0.35)));
  }

  /**
   * v2.27 质量骰子（高斯阶梯）：conv 概率升档，升档后按难度在"已解锁"的质量阶梯上
   * 以正态权重抽样（难度越高，均值越靠向高档），保证 C/B/A/S/S2… 都能按比例出现，
   * 而不是永远只有最低档。
   */
  private rollQualityDice(conv: number, diff2: number, B: number): EnemyGrade {
    if (Math.random() >= conv) return "F";
    const unlocked = QUALITY_LADDER.filter(g => B >= (TIER_GATE[g] ?? 9999));
    if (unlocked.length === 0) return "C";
    const mu = diff2 * (unlocked.length - 1);            // 难度越高，均值越偏高
    const sigma = 1.15;                                  // 分布宽度：相邻档都能出
    let total = 0; const w: number[] = [];
    for (let i = 0; i < unlocked.length; i++) {
      const v = Math.exp(-((i - mu) * (i - mu)) / (2 * sigma * sigma)) + 0.05;
      w.push(v); total += v;
    }
    let r = Math.random() * total;
    for (let i = 0; i < unlocked.length; i++) { r -= w[i]; if (r <= 0) return unlocked[i]; }
    return unlocked[0];
  }

  /** S/BOSS 免费精英事件（v2.29 已移除：全部档位改由骰子消耗制产出，见 trySpawnDice） */

  update(dt: number): void {
    // 难度时钟推进
    this.difficultyTime += dt;
    this.bossCooldown = Math.max(0, this.bossCooldown - dt);

    // v2.33 难度分：按场上敌人数分档缓慢上涨（0只+0.667/秒 / ≤3+0.333 / ≤10+0.1 / ≤20+0.067 / >20+0.033）
    this.advanceDifficulty(dt);
    this.spawnScore = this.difficulty;

    // v2.31 隐藏分池累积：难度分 × 0.1 /秒（出怪时被消耗，骰子不涨难度）
    if (this.continuous) {
      this.hiddenScore += this.difficulty * HIDDEN_SCORE_RATIO * dt;
    }

    // Process pending spawns (warning → actual enemy)
    for (let i = this.pendingSpawns.length - 1; i >= 0; i--) {
      const ps = this.pendingSpawns[i];
      ps.delay -= dt;
      if (ps.delay <= 0) {
        this.createEnemy(ps.grade, ps.x, ps.y);
        this.pendingSpawns.splice(i, 1);
      }
    }

    // Remove dead enemies
    this.activeEnemies = this.activeEnemies.filter(e => e.isAlive);

    if (this.continuous) {
      // v2.29：免费精英事件已取消 —— 所有 S/S2..S5/BOSS 均由消耗制产出
      // ── v2.34 开局首怪：进场立即放 1 只最弱敌（防止"0 怪"档 +2/秒把开局难度顶飞）──
      if (!this.firstWaveSpawned) {
        this.firstWaveSpawned = true;
        if (this.spawnPoints.length > 0) this.spawnOneFor("F");
      }
      // ── 骰子出怪（v2.33）：每 3 秒摇一次，消耗 1~20% 池子 ──
      this.rollTimer -= dt;
      if (this.rollTimer <= 0 && this.spawnPoints.length > 0) {
        this.rollTimer = DICE_INTERVAL;
        this.trySpawnDice();
      }
      // ── Boss 事件（v2.33）：每 60 秒一次，消耗池子出最强可负担 boss（+余量副 boss）──
      this.bossTimer -= dt;
      if (this.bossTimer <= 0) {
        this.bossTimer = BOSS_EVENT_INTERVAL;
        this.trySpawnBossEvent();
      }
      return;
    }

    // Wave mode (stage)
    if (!this.currentWaveConfig) return;

    if (this.pendingCount > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.spawnPoints.length > 0) {
        const baseWeights = this.currentWaveConfig.gradeWeights;
        const scoreWeights = this.gradeForScore();
        const blended: Record<EnemyGrade, number> = {
          F: baseWeights.F * 0.5 + scoreWeights.F * 0.5,
          C: baseWeights.C * 0.5 + scoreWeights.C * 0.5,
          B: baseWeights.B * 0.5 + scoreWeights.B * 0.5,
          A: baseWeights.A * 0.5 + scoreWeights.A * 0.5,
          S: baseWeights.S * 0.5 + scoreWeights.S * 0.5,
          S2: baseWeights.S2 * 0.5 + scoreWeights.S2 * 0.5,
          S3: baseWeights.S3 * 0.5 + scoreWeights.S3 * 0.5,
          S4: baseWeights.S4 * 0.5 + scoreWeights.S4 * 0.5,
          S5: baseWeights.S5 * 0.5 + scoreWeights.S5 * 0.5,
          BOSS: baseWeights.BOSS * 0.5 + scoreWeights.BOSS * 0.5,
        };
        this.spawnOne(blended);
        this.pendingCount--;
        this.spawnedThisWave++;
        this.spawnTimer = this.currentWaveConfig.spawnInterval;
      }
    }

    // Wave complete: all spawned and all dead
    const aliveCount = this.activeEnemies.filter(e => e.isAlive).length;
    if (this.pendingCount === 0 && aliveCount === 0) {
      const w = this.currentWaveConfig.wave;
      this.currentWaveConfig = null;
      this.onWaveComplete?.(w);
    }
  }
}