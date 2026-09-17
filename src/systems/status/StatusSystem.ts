//  StatusSystem.ts ─
//  v2.3 通用状态效果框架：燃烧/冻结/湿润/感电/中毒/覆油
//  挂在 Tank/Enemy 上（tank.statuses），由 StatusSystem.update 统一推进。
import type { Tank } from "../../game/Tank";
import type { Tilemap } from "../../game/Tilemap";
import { EventManager } from "../../framework/EventManager";

const events = EventManager.getInstance();

export type StatusId = "burn" | "freeze" | "wet" | "electric" | "poison" | "oil";

export interface StatusEffect {
  id: StatusId;
  remaining: number;      // 剩余秒数
  tickTimer: number;      // 下一跳倒计时
  intensity: number;      // 强度（层数）：影响伤害/效果
  sourceTeam: number;     // 来源阵营（击杀归属）
  sourceId: number;       // 来源坦克 id
}

// 头顶图标（复用现有 buff 图标区）
export const STATUS_ICONS: Record<StatusId, string> = {
  burn: "🔥",
  freeze: "❄",
  wet: "💧",
  electric: "⚡",
  poison: "☠",
  oil: "🛢",
};

// 每种状态的每跳基础伤害（intensity=1 时）
const DOT_PER_TICK: Partial<Record<StatusId, number>> = {
  burn: 2,
  poison: 1.5,
  electric: 2,
};

// 状态持续时间（intensity 越高越久）
const BASE_DURATION: Record<StatusId, number> = {
  burn: 2.5,
  freeze: 2.2,
  wet: 4.0,
  electric: 1.2,
  poison: 4.0,
  oil: 6.0,
};

export class StatusSystem {
  /** 施加/刷新一个状态（同类刷新取更长时间、更高强度） */
  static apply(tank: Tank, id: StatusId, duration?: number, intensity = 1, sourceTeam = -1, sourceId = -1): void {
    if (!tank.isAlive) return;
    const statuses = tank.statuses;
    const prev = statuses.get(id);
    const dur = duration ?? BASE_DURATION[id];
    if (prev) {
      prev.remaining = Math.max(prev.remaining, dur);
      prev.intensity = Math.max(prev.intensity, intensity);
      prev.sourceTeam = sourceTeam;
      prev.sourceId = sourceId;
      if (prev.tickTimer > 0.5) prev.tickTimer = 0.5;  // 刷新后尽快跳
    } else {
      statuses.set(id, { id, remaining: dur, tickTimer: 0.5, intensity, sourceTeam, sourceId });
    }
  }

  static has(tank: Tank, id: StatusId): boolean {
    return tank.statuses.has(id);
  }

  static get(tank: Tank, id: StatusId): StatusEffect | undefined {
    return tank.statuses.get(id);
  }

  static clear(tank: Tank, id: StatusId): void {
    tank.statuses.delete(id);
  }

  /** 实体是否带任何影响移速的状态 */
  static slowFactor(tank: Tank): number {
    // v2.3 元素抗性可减免减速：抗性值=受到效果的比例（0=免疫，1=全额）
    const resistOf = (id: StatusId) => tank.elementResist?.[id] ?? 1;
    if (tank.statuses.has("freeze")) {
      const r = resistOf("freeze");
      return 0.35 + 0.65 * (1 - r);   // r=1→0.35 全减速；r=0→1.0 免疫
    }
    if (tank.statuses.has("oil")) {
      const r = resistOf("oil");
      return 0.9 + 0.1 * (1 - r);
    }
    if (tank.statuses.has("wet")) {
      const r = resistOf("wet");
      return 0.95 + 0.05 * (1 - r);
    }
    return 1;
  }

  /**
   * 推进一个实体的所有状态：
   * - burn/poison/electric 按 tick 结算持续伤害
   * - freeze 到时间可转为深度冻结（freezeTimer 全停）
   * - electric 沿湿润实体/地形传导（对敌对阵营电弧）
   */
  static update(dt: number, tank: Tank, allTanks: Tank[], tilemap?: Tilemap): void {
    const statuses = tank.statuses;
    if (statuses.size === 0) return;

    const expired: StatusId[] = [];
    for (const eff of statuses.values()) {
      eff.remaining -= dt;
      if (eff.remaining <= 0) {
        // 冻结状态结束：若此前叠到高强，立即补一个短深度冻结（全停）
        if (eff.id === "freeze" && eff.intensity >= 3) {
          tank.freezeTimer = Math.max(tank.freezeTimer, 1.2);
        }
        expired.push(eff.id);
        continue;
      }

      eff.tickTimer -= dt;
      if (eff.tickTimer > 0) continue;

      // 到 tick
      const dps = DOT_PER_TICK[eff.id] ?? 0;
      // v2.3 元素抗性表：减免对应元素 DOT 伤害（0=免疫，0.3=减免70%）
      const resist = tank.elementResist?.[eff.id] ?? 1;
      const perTick = dps * eff.intensity * Math.max(0, resist);
      eff.tickTimer = 0.6;

      if (perTick > 0) {
        tank.takeStatusDamage(perTick, eff.sourceTeam, eff.sourceId);
      }

      // 感电：沿湿润实体/导电地形传导电弧（对敌对阵营，避免队友电击）
      if (eff.id === "electric") {
        const fromWet = tank.statuses.has("wet");
        const chainRange = fromWet ? 150 : 90;
        let best: Tank | null = null;
        let bestD = chainRange * chainRange;
        for (const other of allTanks) {
          if (other === tank || !other.isAlive) continue;
          if (other.team === tank.team) continue;   // 电弧只打敌方
          const dx = other.x - tank.x;
          const dy = other.y - tank.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD) { bestD = d2; best = other; }
        }
        if (best) {
          // 传导：命中者受电击伤害，湿润实体传导更远更痛（电抗减免）
          const arcDmg = perTick * (fromWet ? 2 : 1);
          const resist = best.elementResist?.["electric"] ?? 1;
          best.takeStatusDamage(arcDmg * Math.max(0, resist), eff.sourceTeam, eff.sourceId);
          if (resist > 0.2) {
            StatusSystem.apply(best, "electric", 0.8, Math.max(1, eff.intensity), eff.sourceTeam, eff.sourceId);
          }
          // 落点特效走事件（CombatSystem 订阅画电弧）
          events.emit("element:arc", tank.x, tank.y, best.x, best.y, best.team);
        }
      }
    }

    for (const id of expired) statuses.delete(id);
  }
}
