// Enemy.ts - 5-grade enemies + 17 HP tiers, classic tank AI
import { Tank, type TankConfig } from "./Tank";
import { WandSystem } from "../systems/wand/WandSystem";
import { TILE_SIZE, type Tilemap } from "./Tilemap";
import type { StatusId } from "../systems/status/StatusSystem";

export type EnemyGrade = "F"|"C"|"B"|"A"|"S"|"S2"|"S3"|"S4"|"S5"|"BOSS";

// v2.27 用户指定阶梯：F=5 / C=12 / B=50 / A=150 / S=400 / S2=1000 / S3=3000 / S4=5000 / S5=10000 / BOSS=15000
// （质量随隐藏难度分转化：骰子制逐渐把基础小坦克折算成更高档，"能转化多少转化多少"）
export const HP_TIERS = [5, 12, 50, 150, 400, 1000, 3000, 5000, 10000, 15000];

export interface EnemyConfig extends TankConfig {
  grade: EnemyGrade;
  hpTier: number;      // index into HP_TIERS
  moduleDropIds: string[];
  moduleDropChance: number;
  expReward: number;
  goldReward: number;
  // v2.3 元素抗性表：值为"受到该元素效果的比例"（0=免疫，0.3=减免70%，1=全额）
  elementResist: Partial<Record<StatusId, number>>;
  // v2.3 精英召唤：可召唤 F 级小兵
  summonable: boolean;
}

// Base armor per grade (reduced so basic bullets deal meaningful damage)
const GRADE_ARMOR: Record<EnemyGrade, number> = { F:0, C:3, B:10, A:20, S:50, S2:70, S3:100, S4:140, S5:190, BOSS:40 };

function makeEnemyCfg(grade: EnemyGrade, hpTier: number, speed: number,
                      castDelay: number, color: string, w: number,
                      modules: string[], dropChance: number,
                      exp: number, gold: number,
                      elementResist: Partial<Record<StatusId, number>> = {},
                      summonable = false): EnemyConfig {
  const hp = HP_TIERS[Math.min(hpTier, HP_TIERS.length-1)];
  return {
    id:`enmy_${grade}`, name:`${grade}级坦克`, grade,
    hp, armor: GRADE_ARMOR[grade], speed, cannonSlots:5,
    castDelay, color, width: w, height: w,
    moduleDropIds: modules, moduleDropChance: dropChance,
    expReward: exp, goldReward: gold, hpTier,
    elementResist, summonable,
  };
}

// v2.27 HP 阶梯（用户指定）: F=5(1发炮) / C=12 / B=50 / A=150 / S=400 / S2=1000 / S3=3000 / S4=5000 / S5=10000 / BOSS=15000
// v2.3 元素抗性：C绿=毒免疫、B蓝=冰免疫、A红=火免疫(可召唤)、S品红=电抗(可召唤)、BOSS=全抗
// v2.3.3 掉落表改为"武器模块为主"：初始只给机枪，狙击/粉弹等武器改为敌人掉落；
//        模块掉率普遍提高（F 级也开始掉白武/修饰器），传统手动道具掉率砍半（见 LootSystem）
export const ENEMY_CONFIGS: Record<EnemyGrade, EnemyConfig> = {
  F: makeEnemyCfg("F", 0,  40, 2.5, "#964", 24,
      ["proj_pew","proj_pink","proj_cannon","proj_gatling","mod_damage_up","mod_speed_up","mod_cooldown_reduce"], 0.12, 10, 8),
  C: makeEnemyCfg("C", 1,  34, 2.0, "#696", 26,
      ["proj_spread","proj_bounce","proj_gatling","proj_flame","proj_seeking","proj_rocket","mod_damage_up","mod_speed_up","mod_pierce_add","mod_bounce_add","spec_wall"], 0.35, 25, 15, { poison: 0 }),
  B: makeEnemyCfg("B", 2,  48, 1.5, "#66a", 28,
      ["proj_seeking","proj_pierce","proj_missile","proj_laser","proj_crescent","proj_fireball","proj_iceshard","proj_cannon","proj_pink","proj_sniper","mod_cooldown_reduce","mod_homing","mod_fire","mod_ice","spec_wall","spec_drone_swarm"], 0.60, 55, 40, { freeze: 0 }),
  A: makeEnemyCfg("A", 3,  40, 1.2, "#a44", 30,
      ["proj_bomb","proj_missile","proj_laser","proj_crescent","proj_arc","proj_toxic","proj_oilsplat","proj_rocket","proj_spread","mod_damage_up2","mod_lightning","mod_poison","mod_oil","spec_chain_lightning","spec_wall_gold","spec_drone_kamikaze"], 0.80, 110, 80, { burn: 0 }, true),
  S: makeEnemyCfg("S", 4,  28, 0.9, "#f22", 40,
      ["proj_bullet_gold","mod_damage_up_gold","spec_drone_interceptor","spec_drone_swarm_x3","proj_crescent","mod_speed_up"], 1.00, 250, 240, { electric: 0.3 }, true),
  S2: makeEnemyCfg("S2", 5, 24, 0.8, "#f80", 44,
      ["proj_bullet_gold","mod_damage_up_gold","spec_drone_interceptor","spec_drone_swarm_x3","proj_missile","mod_homing_med"], 1.00, 400, 350, { electric: 0.3, burn: 0.3 }, true),
  S3: makeEnemyCfg("S3", 6, 20, 0.7, "#c3f", 48,
      ["proj_bullet_gold","mod_damage_up_gold","spec_chain_lightning","proj_laser","proj_bomb","mod_homing_strong"], 1.00, 700, 550, { electric: 0.4, burn: 0.4, freeze: 0.3 }, true),
  S4: makeEnemyCfg("S4", 7, 16, 0.6, "#0cf", 52,
      ["proj_bullet_gold","mod_damage_up_gold","spec_chain_lightning","proj_bomb","spec_drone_kamikaze","mod_homing_strong"], 1.00, 1100, 850, { electric: 0.4, burn: 0.4, freeze: 0.4, poison: 0.3 }, true),
  S5: makeEnemyCfg("S5", 8, 12, 0.5, "#fd0", 56,
      ["proj_bullet_gold","mod_damage_up_gold","spec_chain_lightning","proj_bomb","spec_black_hole_gold","mod_homing_strong"], 1.00, 1600, 1200, { electric: 0.5, burn: 0.5, freeze: 0.4, poison: 0.4 }, true),
  BOSS: makeEnemyCfg("BOSS", 9, 24, 0.6, "#f0f", 56, ["spec_black_hole_gold","proj_bullet_gold","mod_damage_up_gold","mod_speed_up","spec_drone_interceptor"], 1.00, 1500, 1500, { burn:0.6, poison:0.6, electric:0.6, freeze:0.5 }, true),
};

// Default loadouts per grade（v2.28：仅 F/C 基础档使用默认单发武器；B 及以上在构造器随机武器）
const ENEMY_MODULES: Record<EnemyGrade, string[]> = {
  F: ["proj_bullet"],
  C: ["proj_spread"],
  B: ["proj_seeking"],
  A: ["proj_rocket","mod_damage_up"],
  S: ["proj_bomb","trig_on_hit","proj_spread"],
  S2: ["proj_bullet_gold","mod_damage_up_gold"],
  S3: ["proj_bullet_gold","mod_damage_up_gold","trig_on_hit"],
  S4: ["proj_bullet_gold","mod_damage_up_gold","trig_on_hit","proj_laser"],
  S5: ["proj_bullet_gold","mod_damage_up_gold","spec_chain_lightning"],
  BOSS: ["spec_black_hole_gold","proj_bullet_gold","mod_damage_up_gold"],
};

/** v2.28 档位次序（随机武器池 / 伤害成长按它取值） */
const GRADE_RANK: Record<EnemyGrade, number> = { F:0, C:1, B:2, A:3, S:4, S2:5, S3:6, S4:7, S5:8, BOSS:9 };

/** v2.28 档位伤害倍率：除血量外，伤害与防御（GRADE_ARMOR）同步随档位成长 */
const GRADE_DAMAGE_MULT: Record<EnemyGrade, number> = { F:0.8, C:0.9, B:1.0, A:1.1, S:1.3, S2:1.5, S3:1.8, S4:2.1, S5:2.5, BOSS:2.8 };

function pickOne<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

/** v2.28 随机武器池：B 档 T2 / A-S 档 T3 / S2+ 档 T4（含金弹） */
const WEAPON_POOL_T2 = ["proj_seeking", "proj_pierce", "proj_missile", "proj_laser", "proj_crescent",
  "proj_fireball", "proj_iceshard", "proj_gatling", "proj_pink", "proj_spread", "proj_bounce"];
const WEAPON_POOL_T3 = [...WEAPON_POOL_T2, "proj_bomb", "proj_arc", "proj_toxic", "proj_oilsplat",
  "proj_rocket", "proj_sniper", "proj_flame", "proj_cannon"];
const WEAPON_POOL_T4 = [...WEAPON_POOL_T3, "proj_bullet_gold"];
/** v2.28 随机修饰池 */
const MOD_POOL_T2 = ["mod_damage_up", "mod_cooldown_reduce", "mod_speed_up", "mod_homing",
  "mod_pierce_add", "mod_bounce_add"];
const MOD_POOL_T3 = [...MOD_POOL_T2, "mod_damage_up2", "mod_homing_med", "mod_fire", "mod_ice", "mod_size_up"];
const MOD_POOL_T4 = [...MOD_POOL_T3, "mod_damage_up_gold", "mod_homing_strong", "mod_lightning",
  "mod_poison", "mod_oil", "mod_crit_up", "mod_critdmg"];

let enemyIdCounter = 1000;

// Classic tank AI states
type AIState = "move" | "turn" | "reverse";

export class Enemy extends Tank {
  readonly grade: EnemyGrade;
  readonly enemyCfg: EnemyConfig;
  readonly isBoss: boolean;

  private aiState: AIState = "move";
  private stateTimer: number = 0;
  private baseX: number = 400;  // target base position
  private baseY: number = 600;

  // Current AI direction (0=up,1=down,2=left,3=right)
  private aiDir: 0|1|2|3 = 0;

  fireTimer: number;               // independent fire cooldown
  readonly spawnedAt: number;      // timestamp when spawned (for kill time tracking)
  freezeTimer: number = 0;         // timestop — skip AI while > 0

  // v2.3 精英召唤：A/S/BOSS 定期召唤 F 级小兵
  readonly summonable: boolean;
  private summonTimer: number = 0;
  onSummon?: (x: number, y: number) => void;

  constructor(grade: EnemyGrade, x: number, y: number, wandSystem: WandSystem, baseX = 400, baseY = 600) {
    const cfg = ENEMY_CONFIGS[grade];
    super(enemyIdCounter++, enemyIdCounter - 1000, 1, cfg, wandSystem, x, y);
    this.grade = grade;
    this.enemyCfg = cfg;
    this.isBoss = grade === "BOSS";
    this.lives = 1;
    this.baseX = baseX;
    this.baseY = baseY;
    this.facing = "down";
    this.aiDir = 1; // start moving down
    // v2.3 元素抗性 + 召唤能力取自配置表
    this.elementResist = cfg.elementResist;
    this.summonable = cfg.summonable;
    this.summonTimer = 6 + Math.random() * 6;

    // ── v2.28 武器装配：F/C 基础档=默认单发武器；其余档=随机武器（掉落来源=实际装配的武器）──
    let mods: string[];
    if (grade === "F" || grade === "C") {
      mods = ENEMY_MODULES[grade];
    } else if (this.isBoss) {
      mods = ["spec_black_hole_gold", pickOne(WEAPON_POOL_T4), "mod_damage_up_gold", pickOne(MOD_POOL_T4)];
    } else {
      const rank = GRADE_RANK[grade];
      mods = [pickOne(rank <= 2 ? WEAPON_POOL_T2 : rank <= 4 ? WEAPON_POOL_T3 : WEAPON_POOL_T4)];
      const modPool = rank <= 2 ? MOD_POOL_T2 : rank <= 4 ? MOD_POOL_T3 : MOD_POOL_T4;
      const modCount = rank <= 2 ? (Math.random() < 0.5 ? 1 : 0)
        : (rank <= 4 ? 1 + (Math.random() < 0.5 ? 1 : 0) : 2);
      for (let k = 0; k < modCount; k++) mods.push(pickOne(modPool));
      if (rank >= 5 && Math.random() < 0.4) mods.push(pickOne(WEAPON_POOL_T4)); // 高阶双武器
    }
    mods.forEach((m, i) => wandSystem.equipModule(this.cannons[0], i, m));
    // BOSS: only 30% chance to carry a black hole (otherwise random gold weapon loadout)
    if (this.isBoss && Math.random() >= 0.3) {
      this.cannons[0].modules[0] = null;
    }
    // v2.28 伤害随档位成长（血量之外的第二维成长：F 0.8 → S5 2.5，BOSS 2.8）
    this.damageMult = GRADE_DAMAGE_MULT[grade];

    this.fireTimer = 0.8 + Math.random() * 2;  // 初始开火延迟缩短（初始难度↑）
    this.spawnedAt = Date.now() / 1000;
    this.projSpeedScale = 0.65;  // enemy bullets 35% slower
  }

  setBase(bx: number, by: number): void { this.baseX = bx; this.baseY = by; }

  updateAI(dt: number, tilemap: Tilemap, allTanks: Tank[]): void {
    if (!this.isAlive) return;

    if (this.freezeTimer > 0) {
      this.freezeTimer -= dt;
      this.moveX = 0;
      this.moveY = 0;
      this.isFiring = false;
      return;
    }

    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      this.chooseNextAction();
    }

    // v2.3 精英召唤：A/S 每 8~12 秒召唤 F 级小兵，BOSS 召唤 2 个
    if (this.summonable) {
      this.summonTimer -= dt;
      if (this.summonTimer <= 0) {
        this.summonTimer = 8 + Math.random() * 4;
        const n = this.isBoss ? 2 : 1;
        for (let k = 0; k < n; k++) {
          this.onSummon?.(this.x + (Math.random() - 0.5) * 40, this.y + (Math.random() - 0.5) * 40);
        }
      }
    }

    // v2.3 撤退 + 危险地形规避（低血量逃离玩家 / 不踏入燃烧·毒地形）
    this.avoidHazardsAndRetreat(tilemap, allTanks);

    // Apply movement from AI direction
    this.moveX = 0; this.moveY = 0; this.isFiring = false;
    switch (this.aiDir) {
      case 0: this.moveY = -1; this.facing = "up";    break;
      case 1: this.moveY =  1; this.facing = "down";  break;
      case 2: this.moveX = -1; this.facing = "left";  break;
      case 3: this.moveX =  1; this.facing = "right"; break;
    }

    // Independent fire timer (boss fires more often) — 频率提升~25%（20~30%区间）
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.isFiring = true;
      this.fireTimer = this.isBoss ? 0.3 + Math.random() * 0.8 : 0.7 + Math.random() * 3;
    }

    this.update(dt, tilemap, allTanks);
  }

  private chooseNextAction(): void {
    const rand = Math.random();

    // Boss: 30% toward base (more aggressive)
    if (this.isBoss) {
      // Boss spends more time moving toward base
      if (rand < 0.30) {
        this.aiDir = this.dirToward(this.baseX, this.baseY);
        this.aiState = "move";
        this.stateTimer = 0.6 + Math.random() * 1.0;
        return;
      }
      // 20% random direction
      if (rand < 0.50) {
        this.aiDir = (Math.floor(Math.random() * 4)) as 0|1|2|3;
        this.aiState = "move";
        this.stateTimer = 0.5 + Math.random() * 1.0;
        return;
      }
      // 50% reverse
      this.aiDir = this.reverseDir(this.aiDir);
      this.aiState = "reverse";
      this.stateTimer = 0.5 + Math.random() * 1.0;
      return;
    }

    // 10% toward base
    if (rand < 0.10) {
      this.aiDir = this.dirToward(this.baseX, this.baseY);
      this.aiState = "move";
      this.stateTimer = 0.4 + Math.random() * 0.8;
      return;
    }

    // 20% reverse
    if (rand < 0.30) {
      this.aiDir = this.reverseDir(this.aiDir);
      this.aiState = "reverse";
      this.stateTimer = 0.5 + Math.random() * 1.0;
      return;
    }

    // 70% random direction
    this.aiDir = (Math.floor(Math.random() * 4)) as 0|1|2|3;
    this.aiState = "move";
    this.stateTimer = 0.5 + Math.random() * 1.5;
  }

  private dirToward(tx: number, ty: number): 0|1|2|3 {
    const dx = tx - this.x;
    const dy = ty - this.y;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 3 : 2;
    return dy > 0 ? 1 : 0;
  }

  private reverseDir(d: 0|1|2|3): 0|1|2|3 {
    return ([1, 0, 3, 2][d]) as 0|1|2|3;
  }

  /** v2.3 撤退：低血量（非 Boss）时远离最近玩家 */
  private dirAwayFrom(tx: number, ty: number): 0|1|2|3 {
    const dx = this.x - tx;
    const dy = this.y - ty;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 3 : 2;
    return dy > 0 ? 1 : 0;
  }

  /** v2.3 当前朝向正前方一格的元素状态（用于规避危险地形） */
  private nextTileState(tilemap: Tilemap) {
    let col = Math.floor(this.x / TILE_SIZE);
    let row = Math.floor(this.y / TILE_SIZE);
    switch (this.aiDir) {
      case 0: row--; break;
      case 1: row++; break;
      case 2: col--; break;
      case 3: col++; break;
    }
    return tilemap.getTileState(col, row);
  }

  /** v2.3 危险地形规避 + 低血量撤退 */
  private avoidHazardsAndRetreat(tilemap: Tilemap, allTanks: Tank[]): void {
    // 撤退：非 Boss 血量低于 25% 时逃离最近玩家（比原地等死更有"求生感"）
    if (!this.isBoss && this.hp / this.maxHp < 0.25 && this.stateTimer <= 0) {
      let nearest: Tank | null = null;
      let bestD = Infinity;
      for (const t of allTanks) {
        if (!t.isAlive || t.team !== 0) continue;
        const d2 = (t.x - this.x) ** 2 + (t.y - this.y) ** 2;
        if (d2 < bestD) { bestD = d2; nearest = t; }
      }
      if (nearest) {
        this.aiDir = this.dirAwayFrom(nearest.x, nearest.y);
        this.stateTimer = 0.4 + Math.random() * 0.4;
      }
    }
    // 危险地形规避：前方是燃烧/毒渍 → 换向（不踏入岩浆/毒沼/火海）
    const ahead = this.nextTileState(tilemap);
    if (ahead && (ahead.element === "fire" || ahead.element === "poison")) {
      const pick = (Math.floor(Math.random() * 4)) as 0|1|2|3;
      if (pick !== this.aiDir) this.aiDir = pick;
      else this.aiDir = this.reverseDir(this.aiDir);
      this.stateTimer = 0.3 + Math.random() * 0.3;
    }
  }
}