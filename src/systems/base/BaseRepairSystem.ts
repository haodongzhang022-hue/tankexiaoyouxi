//  BaseRepairSystem.ts ─
// Cute base handyman: walks to damaged walls, swings hammer, repairs gradually.
// Death → tombstone (no auto-respawn). Revive via "修复徽章" (badge) item near base.
import type { Base } from "../../game/Base";
import type { Tank } from "../../game/Tank";
import type { Enemy } from "../../game/Enemy";
import { BASE_REPAIR } from "../../framework/NumericConfig";

const REPAIR_DISTANCE = 90;
const HANDYMAN_REPAIR_INTERVAL = 1.2;  // 修复小人每 1.2 秒"敲一锤"+1 hp（离散，不是连续回血）
const SIDES = ["top","bottom","left","right"] as const;

// NPC Handyman
export interface Handyman {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  isAlive: boolean;
  grave: boolean;        // dead → tombstone (awaiting revive)
  repairTimer: number;   // 距离下一次锤击的进度（0..1 到 +1hp）
  targetSide: typeof SIDES[number];
  // animation state
  animTime: number;      // walk/swing cycle clock
  walking: boolean;      // currently moving toward the target
  repairing: boolean;    // 正在挥锤修复（区别于走路/待机，只有修的时候才有挥锤动作）
  repairingEagle: boolean; // 正在给基地核心回血
  swingPhase: number;    // 0..3 hammer swing frames
  dir: number;           // facing (-1 left / 1 right)
  // home position (patrol origin near base)
  homeX: number;
  homeY: number;
  moveTimer: number;     // small delay before returning home
  deadTimer: number;     // 阵亡倒计时：有储备徽章时到0自动复活（消耗1枚）
  reviveProgress: number; // v2.24 就近救援进度 0..1（玩家靠近墓碑即缓慢救活，无需按键）
}

export class BaseRepairSystem {
  private base: Base;
  private handyman: Handyman | null = null;
  private repairSpeedMultiplier: number = 1;

  // ── 小人贡献统计（让修复小人更有"队友"感）──
  private handymanRepairs: number = 0;      // 修墙次数（每完成 +1hp 计一次）
  private handymanRepairedHp: number = 0;   // 累计修复耐久

  // Per-player repair timers
  private playerRepairTimers: Map<number, number> = new Map();
  // v2.20 玩家靠近基地时自身回血的累加器（连续回血，按整 HP 结算）
  private playerHealTimers: Map<number, number> = new Map();
  // v2.20 基地核心被动自愈累加器（无人维修也缓慢回血，约3HP/秒）
  private eagleRegenAcc: number = 0;

  // ── Revival / reserve ──
  private stored: number = 0;   // reserved handyman badges (collected but not used)

  constructor(base: Base) {
    this.base = base;
  }

  enableHandyman(): void {
    this.handyman = this.makeHandyman();
  }

  private makeHandyman(): Handyman {
    return {
      x: this.base.x - 20,
      y: this.base.y - 24,
      hp: 30, maxHp: 30,
      isAlive: true, grave: false,
      repairTimer: 0,
      targetSide: "top",
      animTime: 0, walking: false, repairing: false, repairingEagle: false, swingPhase: 0, dir: 1,
      homeX: this.base.x - 20, homeY: this.base.y - 24,
      moveTimer: 0,
      deadTimer: 4,
      reviveProgress: 0,
    };
  }

  setRepairMultiplier(mult: number): void {
    this.repairSpeedMultiplier = mult;
  }

  /** Reserve a badge (pickup item_handyman → stored++). Returns new stored count. */
  grantBadge(): number {
    this.stored++;
    return this.stored;
  }

  get storedCount(): number { return this.stored; }
  get isHandymanAlive(): boolean { return !!this.handyman?.isAlive; }
  get isHandymanGrave(): boolean { return !!this.handyman && !this.handyman.isAlive; }
  get handymanRepairCount(): number { return this.handymanRepairs; }
  get handymanRepairedHpTotal(): number { return this.handymanRepairedHp; }

  /** v2.17 返回修复小人的快照数据（供联机同步给远端渲染） */
  getHandymanSnapshot(): { x: number; y: number; isAlive: boolean; grave: boolean; walking: boolean; repairing: boolean; repairingEagle: boolean; dir: number } | null {
    if (!this.handyman) return null;
    const hm = this.handyman;
    return {
      x: Math.round(hm.x), y: Math.round(hm.y),
      isAlive: hm.isAlive, grave: hm.grave,
      walking: hm.walking, repairing: hm.repairing, repairingEagle: hm.repairingEagle,
      dir: hm.dir,
    };
  }

  /** Revive the dead handyman near the base (consumes one stored badge). */
  tryReviveNearBase(px: number, py: number, dist = REPAIR_DISTANCE): boolean {
    if (!this.handyman || this.handyman.isAlive) return false;
    if (this.stored <= 0) return false;
    const dx = px - this.base.x;
    const dy = py - this.base.y;
    if (dx*dx + dy*dy > dist * dist) return false;
    this.stored--;
    this.handyman = this.makeHandyman();
    return true;
  }

  // 玩家靠近基地即触发（无需按键）：
  //  1) 玩家自身回血 PLAYER_HEAL_RATE（吃修复倍率，"修玩家快"）
  //  2) 主动维修基地核心/墙 ACTIVE_REPAIR_RATE（快于被动自愈，吃修复倍率，"修墙快"）
  playerRepair(player: Tank, dt: number): void {
    if (this.base.isDestroyed) return;
    if (!player.isAlive) return;
    const dx = player.x - this.base.x;
    const dy = player.y - this.base.y;
    if (dx*dx + dy*dy > REPAIR_DISTANCE * REPAIR_DISTANCE) return;

    const mult = this.repairSpeedMultiplier;

    // ── 玩家自身回血（连续，按整 HP 结算）──
    const healAcc = (this.playerHealTimers.get(player.id) ?? 0) + dt * BASE_REPAIR.PLAYER_HEAL_RATE * mult;
    const healWhole = Math.floor(healAcc);
    if (healWhole >= 1) {
      player.heal(healWhole);
      this.playerHealTimers.set(player.id, healAcc - healWhole);
    } else {
      this.playerHealTimers.set(player.id, healAcc);
    }

    // ── 基地核心 / 墙主动维修（连续，优先核心，满血后修最破损小砖）──
    const repAcc = (this.playerRepairTimers.get(player.id) ?? 0) + dt * BASE_REPAIR.ACTIVE_REPAIR_RATE * mult;
    let budget = Math.floor(repAcc);
    if (budget >= 1) {
      let restored = 0;
      while (budget > 0) {
        if (this.base.eagleHp < this.base.eagleMaxHp) {
          restored += this.base.repairEagle(1);
          this.base.repairTarget = "eagle";
          this.base.repairProgress = repAcc - Math.floor(repAcc);
        } else {
          const result = this.base.repairMostDamagedBrick(1);
          restored += result.restored;
          if (result.side) {
            this.base.repairTarget = result.side;
            this.base.repairProgress = repAcc - Math.floor(repAcc);
          }
        }
        budget--;
        if (restored === 0 && this.base.eagleHp >= this.base.eagleMaxHp &&
            this.base.bricks.every(b => b.hp >= b.maxHp)) break;  // 全满，避免空转累加
      }
      this.playerRepairTimers.set(player.id, repAcc - Math.floor(repAcc));
    } else {
      this.playerRepairTimers.set(player.id, repAcc);
    }
  }

  update(dt: number, enemies: Enemy[], players?: Tank[]): void {
    if (this.base.isDestroyed) return;

    // ── v2.20 基地核心被动自愈：无人维修也缓慢回血（约3HP/秒，慢于主动修墙），吃修复倍率 ──
    if (this.base.eagleHp < this.base.eagleMaxHp) {
      this.eagleRegenAcc += dt * BASE_REPAIR.EAGLE_REGEN_RATE * this.repairSpeedMultiplier;
      const whole = Math.floor(this.eagleRegenAcc);
      if (whole >= 1) {
        this.base.repairEagle(whole);
        this.eagleRegenAcc -= whole;
      }
    } else {
      this.eagleRegenAcc = 0;
    }

    if (!this.handyman) return;
    const hm = this.handyman;

    // Grave state: 阵亡后禁止修墙，等待复活（靠近缓慢救援 / 储备徽章自动复活）
    if (hm.grave) {
      hm.animTime += dt;
      // 自动复活：只要有储备徽章，阵亡4秒后自动消耗1枚复活（玩家无需跑过去救）
      if (this.stored > 0) {
        hm.deadTimer -= dt;
        if (hm.deadTimer <= 0) {
          this.stored--;
          this.handyman = this.makeHandyman();
          return;
        }
      }
      // v2.24 就近救援：无需按键，存活玩家靠近墓碑即缓慢救活（约6秒）
      if (players) {
        let rescuer = false;
        for (const p of players) {
          if (!p.isAlive) continue;
          const dx = p.x - hm.x, dy = p.y - hm.y;
          if (dx * dx + dy * dy < 60 * 60) { rescuer = true; break; }
        }
        if (rescuer) {
          hm.reviveProgress += dt / 6; // 6 秒救活
          if (hm.reviveProgress >= 1) {
            this.handyman = this.makeHandyman();
            return;
          }
        }
      }
      return;
    }
    if (!hm.isAlive) {
      hm.isAlive = false;
      hm.grave = true;
      hm.deadTimer = 4;
      return;
    }

    hm.animTime += dt;

    // Take damage from nearby enemies
    for (const e of enemies) {
      if (!e.isAlive) continue;
      const dx = e.x - hm.x; const dy = e.y - hm.y;
      if (dx*dx + dy*dy < 40*40) {
        hm.hp -= 10 * dt;
        if (hm.hp <= 0) {
          hm.isAlive = false;
          hm.grave = true;
          hm.deadTimer = 4;
          return;
        }
      }
    }

    // 决定修复目标：优先基地核心回血，满血后再修最破损的小砖
    const eagleDamaged = this.base.eagleHp < this.base.eagleMaxHp;
    // v2.16 找最破损的小砖（所有面中 hp 最低的），修复小人走到那块砖旁边修
    const damagedBricks = this.base.bricks.filter(b => b.hp < b.maxHp).sort((a, b) => a.hp - b.hp);
    const targetBrick = damagedBricks[0] ?? null;

    let tx = hm.homeX, ty = hm.homeY;
    let target: "eagle" | typeof SIDES[number] | null = null;
    if (eagleDamaged) {
      target = "eagle";
      tx = this.base.x; ty = this.base.y + 20;   // 站到基地核心旁
    } else if (targetBrick) {
      target = targetBrick.side;
      // 走到那块小砖旁边（外侧）
      tx = targetBrick.x + targetBrick.w / 2;
      ty = targetBrick.y + targetBrick.h / 2;
      if (targetBrick.side === "top") ty -= 14;
      else if (targetBrick.side === "bottom") ty += 14;
      else if (targetBrick.side === "left") tx -= 14;
      else if (targetBrick.side === "right") tx += 14;
    }

    if (target) {
      hm.targetSide = target === "eagle" ? "top" : target;  // 仅墙体用 targetSide
      const dx = tx - hm.x; const dy = ty - hm.y;
      const d = Math.hypot(dx, dy);
      if (d > 6) {
        // 走向修复目标（走路状态：腿动、不挥锤）
        hm.walking = true;
        hm.repairing = false;
        const spd = 40 * dt;
        hm.x += (dx / d) * Math.min(spd, d);
        hm.y += (dy / d) * Math.min(spd, d);
        hm.dir = dx >= 0 ? 1 : -1;
        this.base.repairTarget = null;
        this.base.repairProgress = 0;
      } else {
        // 到达：挥锤离散修复（一锤一下 +1 hp，1.2 秒一锤）
        hm.walking = false;
        hm.repairing = true;
        hm.repairingEagle = target === "eagle";
        hm.dir = dx >= 0 ? 1 : -1;
        hm.swingPhase = Math.floor(hm.animTime * (4 / HANDYMAN_REPAIR_INTERVAL)) % 4;
        hm.repairTimer += dt / HANDYMAN_REPAIR_INTERVAL * this.repairSpeedMultiplier;
        // 进度条显示
        this.base.repairTarget = target === "eagle" ? "eagle" : targetBrick!.side;
        this.base.repairProgress = Math.min(1, hm.repairTimer);
        if (hm.repairTimer >= 1) {
          // v2.16 修复最破损的小砖（一锤 +1hp）
          const restored = target === "eagle"
            ? this.base.repairEagle(1)
            : this.base.repairMostDamagedBrick(1).restored;
          if (restored > 0) {
            this.handymanRepairs++;
            this.handymanRepairedHp += restored;
          }
          hm.repairTimer -= 1;
          this.base.repairProgress = 0;
        }
      }
    } else {
      // 无目标：溜达回基地（腿动、不挥锤）
      hm.walking = true;
      hm.repairing = false;
      hm.repairingEagle = false;
      this.base.repairTarget = null;
      this.base.repairProgress = 0;
      const dx = hm.homeX - hm.x; const dy = hm.homeY - hm.y;
      const d = Math.hypot(dx, dy);
      if (d > 4) {
        const spd = 30 * dt;
        hm.x += (dx / d) * Math.min(spd, d);
        hm.y += (dy / d) * Math.min(spd, d);
        hm.dir = dx >= 0 ? 1 : -1;
      } else {
        hm.walking = false;
        hm.swingPhase = 0;
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.handyman) return;
    const hm = this.handyman;

    // Tombstone (dead, awaiting revive)
    if (hm.grave) {
      const bob = Math.sin(hm.animTime * 3) * 1.5;
      // Grave stone
      ctx.fillStyle = "#8a8a8a";
      ctx.beginPath();
      ctx.arc(hm.x, hm.y - 8 + bob, 7, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(hm.x - 7, hm.y - 8 + bob, 14, 12);
      ctx.fillStyle = "#555";
      ctx.fillRect(hm.x - 4, hm.y - 4 + bob, 8, 7);
      // Cross
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hm.x, hm.y - 3 + bob); ctx.lineTo(hm.x, hm.y + 2 + bob);
      ctx.moveTo(hm.x - 2.5, hm.y - 0.5 + bob); ctx.lineTo(hm.x + 2.5, hm.y - 0.5 + bob);
      ctx.stroke();
      // 复活提示：靠近救援进度 > 自动复活倒计时 > 提示靠近救活
      let label: string;
      if (hm.reviveProgress > 0) {
        label = `救援中 ${Math.min(99, Math.floor(hm.reviveProgress * 100))}%`;
      } else if (this.stored > 0) {
        label = `自动复活 ${Math.ceil(Math.max(0, hm.deadTimer))}s`;
      } else {
        label = "靠近即可缓慢救活";
      }
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, hm.x, hm.y + 20 + bob);
      // v2.24 救援进度条
      if (hm.reviveProgress > 0) {
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(hm.x - 14, hm.y - 30 + bob, 28, 5);
        ctx.fillStyle = "#4f4";
        ctx.fillRect(hm.x - 14, hm.y - 30 + bob, 28 * Math.min(1, hm.reviveProgress), 5);
      }
      return;
    }
    if (!hm.isAlive) return;

    // ── Cute handyman ──
    const bob = Math.sin(hm.animTime * 8) * (hm.walking ? 1.2 : 0.6);
    const step = Math.sin(hm.animTime * 10);
    const dir = hm.dir;

    ctx.save();
    ctx.translate(hm.x, hm.y);

    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(0, 12, 9, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Legs (little walking steps)
    ctx.strokeStyle = "#3a4a8a";
    ctx.lineWidth = 3;
    const legSwing = hm.walking ? step * 3 : 0;
    ctx.beginPath();
    ctx.moveTo(-3, 6); ctx.lineTo(-3 + legSwing, 11);
    ctx.moveTo(3, 6);  ctx.lineTo(3 - legSwing, 11);
    ctx.stroke();

    // Body (blue overalls)
    ctx.fillStyle = "#3f7fd4";
    ctx.fillRect(-6, -4 + bob, 12, 12);
    // Belt
    ctx.fillStyle = "#2a3a6a";
    ctx.fillRect(-6, 4 + bob, 12, 2);

    // Arms + hammer
    ctx.strokeStyle = "#ffcc99";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(6, 0 + bob);
    // Hammer arm: swings ONLY while repairing (走路/待机时不挥锤)
    const swing = hm.repairing ? Math.sin(hm.animTime * 14) * 5 : 2;
    ctx.lineTo(6 + 4, 2 + bob + swing);
    ctx.stroke();
    // Hammer head
    ctx.fillStyle = "#b0622a";
    ctx.save();
    ctx.translate(10 + dir, 2 + bob + swing + 1);
    ctx.rotate(dir * (hm.repairing ? swing * 0.2 : 0));
    ctx.fillRect(-4, -2, 9, 4);
    ctx.fillStyle = "#6a3a10";
    ctx.fillRect(-4, -1, 9, 1);
    ctx.restore();

    // Head
    ctx.fillStyle = "#ffcc99";
    ctx.beginPath();
    ctx.arc(0, -11 + bob, 6, 0, Math.PI * 2);
    ctx.fill();
    // Eyes (looking at repair direction)
    ctx.fillStyle = "#222";
    ctx.beginPath(); ctx.arc(dir * 2.5, -12 + bob, 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(dir * 5.5, -12 + bob, 1.3, 0, Math.PI * 2); ctx.fill();
    // Cheek blush
    ctx.fillStyle = "rgba(255,120,120,0.5)";
    ctx.beginPath(); ctx.arc(dir * 7, -9.5 + bob, 1.5, 0, Math.PI * 2); ctx.fill();
    // Smile
    ctx.strokeStyle = "#c33";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(dir * 4, -8 + bob, 2, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();

    // Hard hat
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.arc(0, -14 + bob, 6.5, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(-6.5, -15 + bob, 13, 2);
    ctx.fillStyle = "#e0a000";
    ctx.fillRect(-2, -19 + bob, 4, 3);

    ctx.restore();

    // HP bar
    ctx.fillStyle = "#400";
    ctx.fillRect(hm.x - 10, hm.y - 22, 20, 3);
    ctx.fillStyle = "#0f0";
    ctx.fillRect(hm.x - 10, hm.y - 22, 20 * (hm.hp / hm.maxHp), 3);

    // 修复进度条（挥锤时显示：金色条填满即 +1hp 一锤）
    if (hm.repairing) {
      ctx.fillStyle = "#000";
      ctx.fillRect(hm.x - 8, hm.y - 27, 16, 3);
      ctx.fillStyle = "#ffd700";
      ctx.fillRect(hm.x - 8, hm.y - 27, 16 * Math.min(1, hm.repairTimer), 3);
    }

    // Stored badge count above the handyman
    if (this.stored > 0) {
      ctx.fillStyle = "#ffd700";
      ctx.font = "bold 10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`🛠x${this.stored}`, hm.x, hm.y - 26);
    }
  }
}
