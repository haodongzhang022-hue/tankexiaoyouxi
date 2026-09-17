// Tank.ts - 4-directional movement, 3-cannon system, new armor formula
import type { Renderer } from "../engine/Renderer";
import type { WandState } from "../systems/wand/WandTypes";
import { WandSystem } from "../systems/wand/WandSystem";
import { Tilemap, TILE_SIZE, isTankPassable } from "./Tilemap";
import { StatusSystem, STATUS_ICONS, type StatusId, type StatusEffect } from "../systems/status/StatusSystem";
import { drawTankBody, drawTankShadow } from "../ui/TankVisual";

export interface TankConfig {
  id: string;
  name: string;
  hp: number;
  armor: number;
  speed: number;
  cannonSlots: number;  // modules per cannon (5)
  castDelay: number;
  color: string;
  width: number;
  height: number;
}

export const TANK_CONFIGS: Record<string, TankConfig> = {
  tank_light:    { id:"tank_light",    name:"轻型",   hp:10,  armor:0, speed:80,  cannonSlots:5, castDelay:0.20, color:"#4af", width:26, height:26 },
  tank_heavy:    { id:"tank_heavy",    name:"重装",   hp:10,  armor:0, speed:60,  cannonSlots:5, castDelay:0.50, color:"#888", width:30, height:30 },
  tank_sniper:   { id:"tank_sniper",   name:"狙击",   hp:10,  armor:0, speed:80,  cannonSlots:5, castDelay:0.80, color:"#a4f", width:26, height:26 },
  tank_engineer: { id:"tank_engineer", name:"工程师", hp:10,  armor:0, speed:60,  cannonSlots:5, castDelay:0.35, color:"#4c4", width:28, height:28 },
};

// Stun constants (friendly fire)
const FRIENDLY_STUN_DURATION       = 1.5;
const FRIENDLY_STUN_IMMUNE_DURATION = 5.0;
const FRIENDLY_STUN_IMMUNE_THRESHOLD = 5.0;

// 4 directions as angle for rendering
export const DIR_ANGLES: Record<string, number> = {
  up:    -Math.PI / 2,
  down:   Math.PI / 2,
  left:   Math.PI,
  right:  0,
};

// 默认武器（玩家 4 根炮筒初始只装 1 把；敌人由各自模块表接管）
// v2.6.3 初始武器=经典单发主炮：子弹命中/撞墙消失后可再发 → 机枪/散弹改为敌人掉落，不再白送
const INITIAL_WEAPON = "proj_cannon";  // 单发炮弹（命中销毁 → 0.2s 后可再发）

export class Tank {
  readonly id: number;
  readonly playerId: number;
  readonly team: number;
  config: TankConfig;

  x: number;
  y: number;
  facing: "up" | "down" | "left" | "right" = "up";

  hp: number;
  maxHp: number;
  armor: number;

  speed: number;
  isAlive: boolean = true;

  stunTimer: number = 0;
  stunHitAccum: number = 0;
  stunImmuneTimer: number = 0;

  // Hit flash: white/red overlay frames after taking damage
  hitFlashTimer: number = 0;

  // 3 cannons (each is a WandState)
  cannons: WandState[];
  activeCannon: number = 0;  // 0/1/2/3
  protected wandSystem: WandSystem;

  // 切换武器延迟：切炮后短时间内不能开火（防止频繁切换重置攻速）
  switchTimer: number = 0;
  static readonly SWITCH_DELAY = 0.6;  // 半秒多一点，略偏"一秒"手感

  moveX: number = 0;
  moveY: number = 0;
  isFiring: boolean = false;

  respawnTimer: number = 0;
  respawnTimeScale: number = 1;   // df_respawn: 复活更快（3s→2s）
  invincibleTimer: number = 0;
  lives: number = 3;   // v2.20：初始3条命（PLAYER.INITIAL_LIVES）；每条命满血，复活继承升级血量上限
  lastHitByTeam: number = -1;  // team that last damaged this tank (for kill scoring)
  lastHitById: number = -1;    // tank id that last damaged this tank (per-player kill credit)

  // Revive state (when dead and teammate is nearby reviving)
  reviveProgress: number = 0;  // 0-4 seconds
  projSpeedScale: number = 1.0;  // bullet speed multiplier (enemies use < 1)

  // Permanent upgrades from level-up abilities
  projSpeedMult: number = 1;    // fp_speed: 弹速+X%
  damageMult: number = 1;       // （v2.6.3 起无"全武器伤害"升级，仅保留防引报错；单武器增强走 wandDamageMults）
  wandDamageMults: number[] = [1, 1, 1, 1];  // v2.6.3 每根炮筒独立伤害倍率（升级"炮筒N伤害+10%"累乘，克制平滑增长）
  critChance: number = 0;       // fp_crit: 暴击率+X%（v2.26 初始0%，由升级/暴击模块提升）
  critMultiplier: number = 2.0; // fp_crit_dmg: 暴击伤害倍率（初始200%=2倍，可升级/模块提升）

  // Ice sliding momentum
  iceSlidingX: number = 0;
  iceSlidingY: number = 0;
  readonly ICE_FRICTION: number = 0.92;   // momentum decay per frame
  readonly ICE_PUSH_FORCE: number = 0.3;  // how much input pushes while sliding

  // Freeze (timestop) — set by clock power-up on enemies
  freezeTimer: number = 0;

  // v2.3 通用状态效果（燃烧/冻结/湿润/感电/中毒/覆油），由 StatusSystem 推进
  statuses: Map<StatusId, StatusEffect> = new Map();

  // v2.3 元素抗性表：值为"受到该元素效果的比例"（0=免疫，0.3=减免70%，1=全额）。
  // 用于 DOT 伤害/减速/感电传导，部分敌人对自身属性地形免疫并回血（地形协同）
  elementResist: Partial<Record<StatusId, number>> = {};

  // Forest hiding: tank is semi-transparent when in forest
  hidden: boolean = false;

  extraSpeed: number = 0;
  extraArmor: number = 0;
  extraMaxHp: number = 0;
  extraArmorPen: number = 0;       // fp_penetration: 穿甲比例（0~0.8）
  pickupRangeMult: number = 1;     // fp_pickup: 拾取范围倍率
  chainImmuneTimer: number = 0;    // 链式闪电自身免伤倒计时（秒）
  damageBoostTimer: number = 0;
  speedBoostTimer: number = 0;
  speedBoostBonus: number = 0;

  // Death position (for loot drop)
  deathX: number = 0;
  deathY: number = 0;

  flatArmor: number = 0;      // consumable block armor (each point absorbs 1 dmg, then gone)
  pctDefense: number = 0;     // permanent percentage defense (0.0-1.0, small values)

  // ── 升级能力 flags ──
  hasInvincibleShield: boolean = false;  // df_invincible: 15% chance 3s shield on hit
  hasModuleSteal: boolean = false;       // (deprecated) 旧 sp_loot 直接偷取模块，已改为 moduleDropMult
  hasFreeCast: boolean = false;          // sp_freecast: 3% chance to not consume module uses
  moduleDropMult: number = 1;            // sp_loot: 敌人模块掉落率倍率（每次+50%可叠加）

  // ── 放墙技能等级（1小墙→2厚墙→3岩石→4坚不可摧）──
  wallLevel: number = 1;
  wallCooldown: number = 0;
  wallCooldownScale: number = 1;

  isBoss: boolean = false;              // Boss enemy (larger, special render)

  // Enemy grade letter badge (set for enemies); undefined for players
  gradeLabel?: string;

  // ── 统计追踪 ──
  stats: {
    score: number;           // 个人得分（击杀归属）
    exp: number;            // 个人经验（全游戏唯一货币）（拾取获得，可花费）
    kills: number;
    damageDealt: number;
    damageTaken: number;
    shotsFired: number;
    hitsLanded: number;
    goldCollected: number;   // 累计拾取经验（含击杀参考值）
    modulesUsed: number;
  } = { score:0, exp: 0, kills:0, damageDealt:0, damageTaken:0, shotsFired:0, hitsLanded:0, goldCollected:0, modulesUsed:0 };

  constructor(id: number, playerId: number, team: number, config: TankConfig,
              wandSystem: WandSystem, x = 100, y = 100) {
    this.id = id;
    this.playerId = playerId;
    this.team = team;
    this.config = config;
    this.wandSystem = wandSystem;
    this.x = x;
    this.y = y;
    this.hp = config.hp;
    this.maxHp = config.hp;
    this.armor = config.armor;
    this.speed = config.speed;

    // ── 攻速（发/秒）：castDelay = 1/fps ──
    // v2.3.2 攻速回调到合理节奏（旧值机枪0.13s→7.7发/s 明显过快）
    // v2.6.3 炮筒1=经典单发主炮：命中/撞墙后 0.2s 再发（castDelay 仅作下限，
    //       实际速率受"子弹飞行时间 + 0.2s"主导，见 WandSystem 单发逻辑）
    //       炮筒2/3=预设射速（拾取的机枪/散弹等装配后按其节奏），炮筒4=默认
    const MAIN_GUN_REFIRE = 0.2;                       // 单发主炮再发间隔下限
    const WAND_FIRE_RATE = [null, 3.5, 1.5, null];     // [主炮(单发), 机枪, 散弹, 默认]
    // Create 4 wands (Noita-style)
    this.cannons = [0, 1, 2, 3].map(i => wandSystem.createWandState({
      id: `cannon_${id}_${i}`,
      name: `炮筒${i+1}`,
      slots: config.cannonSlots,
      castDelay: i === 0 ? MAIN_GUN_REFIRE : (WAND_FIRE_RATE[i] as number) ? 1 / (WAND_FIRE_RATE[i] as number) : config.castDelay,
      rechargeTime: 1.0,
      shuffle: false,
      singleShot: i === 0 && team === 0,  // 炮筒1=经典单发：同一子弹在场时不能再发（命中/消失后0.2s可再发）
    }));

    // 初始只配 1 把武器：经典单发主炮（v2.6.3；v2.3.3 的机枪改为敌人掉落）
    // 机枪/散弹/狙击等全部敌人掉落（见 Enemy.ts 掉落表，F 级即掉 proj_pew），突出"捡武器升级"特色
    wandSystem.equipModule(this.cannons[0], 0, INITIAL_WEAPON);
  }

  get cx(): number { return this.x; }
  get cy(): number { return this.y; }
  get effectiveSpeed(): number {
    return this.speed + this.extraSpeed + (this.speedBoostTimer > 0 ? this.speedBoostBonus : 0);
  }
  /** v2.3 状态效果导致的移速倍率（冻结/覆油/湿润减速） */
  get movementMult(): number {
    return this.statuses.size > 0 ? StatusSystem.slowFactor(this) : 1;
  }
  get effectiveArmor(): number { return this.armor + this.extraArmor; }
  get effectiveMaxHp(): number { return this.maxHp + this.extraMaxHp; }
  get isStunned(): boolean { return this.stunTimer > 0; }
  get isImmune(): boolean { return this.invincibleTimer > 0 || this.stunImmuneTimer > 0; }
  get currentCannon(): WandState { return this.cannons[this.activeCannon]; }

  /** v2.17 当前激活的 Buff/状态图标列表（供快照同步给远端渲染对齐） */
  getBuffIcons(): string[] {
    const icons: string[] = [];
    if (this.damageBoostTimer > 0)  icons.push("🔥");
    if (this.invincibleTimer > 0)   icons.push("🛡");
    if (this.flatArmor > 0)         icons.push("✦");
    if (this.speedBoostTimer > 0)   icons.push("⚡");
    if (this.freezeTimer && this.freezeTimer > 0) icons.push("❄");
    for (const id of this.statuses.keys()) {
      const ic = STATUS_ICONS[id];
      if (ic && !icons.includes(ic)) icons.push(ic);
    }
    return icons;
  }

  // Armor formula: damage * 200 / (armor + 200)
  static calcDamage(rawDamage: number, armor: number, flatPen = 0, pctPen = 0): number {
    const eff = Math.max(0, armor * (1 - pctPen) - flatPen);
    return Math.max(1, Math.round(rawDamage * 200 / (eff + 200)));
  }

  cycleCannon(): void {
    if (this.switchTimer > 0) return;  // 防切炮乱按
    this.activeCannon = (this.activeCannon + 1) % 4;
    this.switchTimer = Tank.SWITCH_DELAY;
  }

  /** 直接指定当前炮筒（用于装配/显示），同样触发切换延迟 */
  setActiveCannon(idx: number): void {
    const i = ((idx % 4) + 4) % 4;
    if (i === this.activeCannon) return;
    this.activeCannon = i;
    this.switchTimer = Tank.SWITCH_DELAY;
  }

  update(dt: number, tilemap: Tilemap, allTanks?: Tank[]): void {
    if (!this.isAlive) {
      if (this.respawnTimer > 0) this.respawnTimer -= dt;
      return;
    }

    if (this.stunTimer > 0) { this.stunTimer -= dt; return; }
    if (this.stunImmuneTimer > 0) this.stunImmuneTimer -= dt;
    if (this.invincibleTimer > 0) this.invincibleTimer -= dt;
    if (this.damageBoostTimer > 0) this.damageBoostTimer -= dt;
    if (this.speedBoostTimer > 0) this.speedBoostTimer -= dt;
    if (this.hitFlashTimer > 0) this.hitFlashTimer -= dt;
    if (this.wallCooldown > 0) this.wallCooldown -= dt;
    if (this.switchTimer > 0) this.switchTimer -= dt;
    if (this.chainImmuneTimer > 0) this.chainImmuneTimer -= dt;

    const spd = this.effectiveSpeed * this.movementMult;
    const hw = this.config.width / 2;
    const hh = this.config.height / 2;

    // ── Ice sliding logic ──
    const onIce = tilemap.isOnIce(this.x, this.y, this.config.width, this.config.height);
    let dx: number, dy: number;

    if (onIce) {
      // Accumulate input into momentum (push force)
      this.iceSlidingX += this.moveX * spd * this.ICE_PUSH_FORCE;
      this.iceSlidingY += this.moveY * spd * this.ICE_PUSH_FORCE;
      // Apply friction
      this.iceSlidingX *= this.ICE_FRICTION;
      this.iceSlidingY *= this.ICE_FRICTION;
      // Use momentum when input is small
      const inputStrength = Math.abs(this.moveX) + Math.abs(this.moveY);
      if (inputStrength < 0.1) {
        dx = this.iceSlidingX * dt;
        dy = this.iceSlidingY * dt;
      } else {
        // Blend input + momentum
        dx = (this.moveX * spd * 0.5 + this.iceSlidingX * 0.5) * dt;
        dy = (this.moveY * spd * 0.5 + this.iceSlidingY * 0.5) * dt;
      }
    } else {
      // No ice - reset momentum
      this.iceSlidingX = 0;
      this.iceSlidingY = 0;
      dx = this.moveX * spd * dt;
      dy = this.moveY * spd * dt;
    }

    // Update facing from movement (only when not purely sliding on ice)
    if (Math.abs(this.moveX) > 0.1) this.facing = this.moveX > 0 ? "right" : "left";
    else if (Math.abs(this.moveY) > 0.1) this.facing = this.moveY > 0 ? "down" : "up";

    // X movement — block only, no snap, no bounce
    if (dx !== 0) {
      const nx = this.x + dx;
      if (!tilemap.checkTankCollision(nx - hw, this.y - hh, this.config.width, this.config.height, this.team)) {
        this.x = nx;
      } else {
        // Hit a wall while sliding on ice: stop momentum
        this.iceSlidingX = 0;
      }
    }

    // Y movement — block only
    if (dy !== 0) {
      const ny = this.y + dy;
      if (!tilemap.checkTankCollision(this.x - hw, ny - hh, this.config.width, this.config.height, this.team)) {
        this.y = ny;
      } else {
        this.iceSlidingY = 0;
      }
    }

    // Forest/steam hiding: check after movement（森林与蒸汽都会遮挡实体）
    this.hidden = tilemap.isOnForest(this.x - hw, this.y - hh, this.config.width, this.config.height)
               || tilemap.isOnElement(this.x - hw, this.y - hh, this.config.width, this.config.height, "steam");

    // Clamp to map bounds (prevent out-of-map)
    const mapW = tilemap.cols * TILE_SIZE;
    const mapH = tilemap.rows * TILE_SIZE;
    this.x = Math.max(hw + 1, Math.min(mapW - hw - 1, this.x));
    this.y = Math.max(hh + 1, Math.min(mapH - hh - 1, this.y));

    // Tank-vs-tank soft push (no bounce, just gentle separation)
    if (allTanks) {
      for (const other of allTanks) {
        if (other === this || !other.isAlive) continue;
        const odx = this.x - other.x;
        const ody = this.y - other.y;
        const dist2 = odx*odx + ody*ody;
        const minDist = (this.config.width + other.config.width) / 2;
        if (dist2 < minDist * minDist && dist2 > 0) {
          const dist = Math.sqrt(dist2);
          const push = (minDist - dist) * 0.5;
          const nx2 = this.x + (odx / dist) * push;
          const ny2 = this.y + (ody / dist) * push;
          // Only push if new pos is valid
          if (!tilemap.checkTankCollision(nx2 - hw, ny2 - hh, this.config.width, this.config.height, this.team)) {
            this.x = nx2; this.y = ny2;
          }
        }
      }
    }
  }

  fireCast(dt: number): ReturnType<WandSystem["update"]> {
    return this.fireWand(dt, this.activeCannon, this.isFiring);
  }

  /** Fire a specific wand (index 0-3). `firing` = whether that wand's key/button is held. */
  fireWand(dt: number, idx: number, firing = true): ReturnType<WandSystem["update"]> {
    if (!this.isAlive || this.isStunned) return [];
    if (this.switchTimer > 0) return [];  // 切换武器后的延迟期内不能开火（防止两边同时用重置攻速）
    const cannon = this.cannons[idx] ?? this.currentCannon;
    // Wall wand: blocked entirely while on cooldown
    const hasWallMod = cannon.modules.some(m => m && (m.config.id === "spec_wall" || m.config.id === "spec_wall_gold"));
    if (hasWallMod && this.wallCooldown > 0) return [];
    const angle = DIR_ANGLES[this.facing];
    // v2.18+ 从坦克中心发射，避免卡在砖块里出不来
    const spawnX = this.x;
    const spawnY = this.y;
    const dmgBoost = (this.damageBoostTimer > 0 ? 1.3 : 1) * this.damageMult * (this.wandDamageMults[idx] ?? 1);
    const result = this.wandSystem.update(
      cannon, dt, this.id, this.team,
      spawnX, spawnY, angle,
      firing, this.projSpeedScale * this.projSpeedMult, dmgBoost, this.hasFreeCast,
      this.wallLevel,
    );
    // Wall placement has a per-tank cooldown (prevent wall spam)
    if (result.some(p => p.type === "spec_wall" || p.type === "spec_wall_gold")) {
      const gold = result.some(p => p.type === "spec_wall_gold");
      this.wallCooldown = (gold ? 0.8 : 1.2) * this.wallCooldownScale;
    }
    // Increment shot counter when any projectiles fired
    if (result.length > 0) {
      this.stats.shotsFired += result.length;
    }
    // 链式闪电：发射后0.5秒自身免伤
    if (result.some(p => p.type === "spec_chain_lightning")) {
      this.chainImmuneTimer = 0.5;
    }
    return result;
  }

  takeDamage(damage: number, fromTeam: number, flatPen = 0, pctPen = 0, fromId = -1): void {
    if (!this.isAlive || this.isImmune) return;

    const isFriendly = (fromTeam === this.team && this.team === 0);

    if (isFriendly) {
      // Friendly fire: stun instead of damage
      // Accumulate hits; after threshold, stun
      this.stunHitAccum++;
      if (this.stunHitAccum >= FRIENDLY_STUN_IMMUNE_THRESHOLD) {
        this.stunHitAccum = 0;
        this.stunTimer = FRIENDLY_STUN_DURATION;
        this.stunImmuneTimer = FRIENDLY_STUN_IMMUNE_DURATION;
      }
      return;
    }

    this.lastHitByTeam = fromTeam;
    this.lastHitById = fromId;

    // ── df_invincible: 15% chance to trigger 3s shield on hit ──
    if (this.hasInvincibleShield && Math.random() < 0.15) {
      this.invincibleTimer = Math.max(this.invincibleTimer, 3);
      return; // Shield absorbs the damage completely
    }

    // Percentage armor reduction
    const eff = Math.max(0, this.effectiveArmor * (1 - pctPen) - flatPen);
    if (eff > 0) damage = Math.max(1, Math.round(damage * 200 / (eff + 200)));

    // Flat armor absorption (consumable, min 1 always goes through)
    const canAbsorb = Math.max(0, damage - 1);
    const absorbed = Math.min(this.flatArmor, canAbsorb);
    this.flatArmor = Math.max(0, this.flatArmor - absorbed);
    damage -= absorbed;

    damage = Math.max(1, damage);

    this.hp -= damage;
    this.stats.damageTaken += damage;
    this.hitFlashTimer = 0.15;  // white flash frames on hit
    if (this.hp <= 0) this.die();
  }

  die(): void {
    this.isAlive = false;
    this.hp = 0;
    this.deathX = this.x;
    this.deathY = this.y;
    this.lives--;
    if (this.lives > 0) this.respawnTimer = 3 * this.respawnTimeScale;  // 3s auto-respawn
  }

  /** v2.3 状态伤害（燃烧/中毒/感电/地形）：绕过友伤眩晕，直接扣血；记录击杀归属 */
  takeStatusDamage(damage: number, sourceTeam = -1, sourceId = -1): void {
    if (!this.isAlive || this.isImmune) return;
    this.lastHitByTeam = sourceTeam;
    this.lastHitById = sourceId;
    this.hp -= damage;
    this.stats.damageTaken += damage;
    this.hitFlashTimer = 0.15;
    if (this.hp <= 0) this.die();
  }

  /** v2.3 恢复生命（上限为有效最大生命；地形协同回血用） */
  heal(amount: number): void {
    if (!this.isAlive) return;
    this.hp = Math.min(this.effectiveMaxHp, this.hp + amount);
  }

  respawn(x: number, y: number, fullHp = true): void {
    this.isAlive = true;
    this.hp = fullHp ? this.effectiveMaxHp : Math.ceil(this.effectiveMaxHp * 0.5);
    this.x = x;
    this.y = y;
    this.stunTimer = 0;
    this.stunHitAccum = 0;
    this.reviveProgress = 0;
    this.invincibleTimer = 10;  // 10s spawn protection
  }

  render(renderer: Renderer, now: number): void {
    if (!this.isAlive) {
      // Render corpse marker at death position (for rescue targeting)
      // v2.7.1 常显（不再 600ms 闪烁，避免"图标没显示"错觉），轻微呼吸强调
      if (this.team === 0 && this.lives > 0) {
        const { ctx } = renderer;
        ctx.fillStyle = "rgba(255,60,60,0.45)";
        ctx.beginPath();
        ctx.arc(this.deathX, this.deathY, 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#f44";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#f44";
        ctx.font = "10px monospace";
        ctx.textAlign = "center";
        ctx.fillText("✕", this.deathX, this.deathY + 4);
      }
      return;
    }
    const { ctx } = renderer;
    const w = this.config.width;
    const h = this.config.height;
    const angle = DIR_ANGLES[this.facing];

    // Stun flash
    if (this.isStunned && renderer.blink(now, 100)) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(angle);
      ctx.fillStyle = "#fff8";
      ctx.fillRect(-w/2, -h/2, w, h);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(this.x, this.y);

    // v2.15 影子必须在旋转之前绘制，确保影子方向固定（右下方），不随坦克朝向旋转
    drawTankShadow(ctx, w, h);

    ctx.rotate(angle);

    // Forest hiding: semi-transparent
    if (this.hidden) ctx.globalAlpha = 0.35;

    // ── 美化后的坦克身体绘制（渐变/履带/炮塔/炮管/受击闪白）──
    drawTankBody(ctx, this, now);

    // ── v2.18 移除坦克四周武器挂载位标记：避免误导为"四个方向都有炮筒" ──
    // 炮筒已由 drawTankBody → drawBarrel 画在主方向（x正方向），经 ctx.rotate 指向 facing
    // 武器槽状态改由信息栏显示，不再在坦克本体四周画点

    // Boss crown decoration
    if (this.isBoss) {
      ctx.save();
      ctx.rotate(-angle); // Keep crown upright regardless of facing
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("♛", 0, -h/2 - 6);
      // Boss glow effect
      ctx.strokeStyle = `rgba(255, 0, 255, ${0.2 + 0.3 * Math.sin(now/300)})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(-w/2 - 2, -h/2 - 2, w + 4, h + 4);
      ctx.restore();
    }

    // Invincible sparkle
    if (this.invincibleTimer > 0 && renderer.blink(now, 150)) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(-w/2, -h/2, w, h);
    }

    ctx.restore();

    // ── 敌军等级角标（世界坐标，仅敌军显示；玩家靠本体设计区分，不再用头顶旗帜挡视野）──
    ctx.save();
    ctx.translate(this.x, this.y);
    if (this.team !== 0 && this.gradeLabel) {
      // Enemy: grade letter badge (F/C/B/A/S/BOSS)
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(-7, -h/2 - 14, 14, 12);
      ctx.strokeStyle = this.isBoss ? "#ffd700" : "#f44";
      ctx.lineWidth = 1;
      ctx.strokeRect(-7, -h/2 - 14, 14, 12);
      ctx.fillStyle = this.isBoss ? "#ffd700" : "#f44";
      ctx.font = "bold 9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(this.gradeLabel, 0, -h/2 - 4);
    }
    // ── Buff / status icons (damage, shield, armor, freeze) ──
    const icons: string[] = [];
    if (this.damageBoostTimer > 0)  icons.push("🔥");
    if (this.invincibleTimer > 0)   icons.push("🛡");
    if (this.flatArmor > 0)         icons.push("✦");
    if (this.speedBoostTimer > 0)   icons.push("⚡");
    if (this.freezeTimer && this.freezeTimer > 0) icons.push("❄");
    // v2.3 通用状态图标（去重：避免与 buff 图标重复）
    for (const id of this.statuses.keys()) {
      const ic = STATUS_ICONS[id];
      if (ic && !icons.includes(ic)) icons.push(ic);
    }
    if (icons.length > 0) {
      ctx.font = "11px monospace";
      ctx.textAlign = "left";
      icons.forEach((ic, i) => {
        ctx.fillText(ic, w / 2 + 5, -h / 2 + 6 + i * 13);
      });
    }
    ctx.restore();

    // HP bar
    const barW = w + 4;
    const barH = 6;
    const bx = this.x - barW/2;
    const by = this.y - h/2 - 8;
    ctx.fillStyle = "#400"; ctx.fillRect(bx, by, barW, barH);
    const hpRatio = Math.max(0, this.hp / this.effectiveMaxHp);
    ctx.fillStyle = hpRatio > 0.5 ? "#0f0" : hpRatio > 0.25 ? "#ff0" : "#f00";
    ctx.fillRect(bx, by, barW * hpRatio, barH);
    // HP text (centered on bar)
    ctx.fillStyle = "#fff"; ctx.font = "bold 8px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${this.hp}/${this.effectiveMaxHp}`, this.x, by - 2);

    // Revive progress bar (when being revived)
    if (this.reviveProgress > 0) {
      ctx.fillStyle = "#ff0"; ctx.fillRect(bx, by - 6, barW * (this.reviveProgress / 4), 3);
    }
  }
}