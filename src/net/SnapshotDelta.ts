//  SnapshotDelta.ts ─ v2.8 快照增量编码（主机权威 → 成员端）
//  目标：30Hz 广播不涨带宽。策略：
//    - 实体（玩家/敌人/子弹）按 id 逐帧 diff：位置/HP/朝向/数量变化才进 delta；
//    - 小字段（loot/powerups/base/scope）本来就小，每帧全量；
//    - 首帧 / 每 60 帧 / 单类变化实体超 60% 时发关键"全量帧"，防丢包累计错乱；
//    - 服务器原样中继（不知道结构），纯编解码在两端。
//  成员端用 SnapshotDeltaCodec.decode() 重建完整 NetSnapshot 再喂 RemoteView（插值/ID 匹配零改动）。
import type { NetSnapshot, NetTank, NetProjectile, NetLootDrop, NetPowerUp, NetBase } from "./NetTypes";

/** 增量模式下的快照消息体（与 NetSnapshot 同字段；full=true 时三实体数组为全量，否则为变化子集） */
export interface DeltaSnapshot {
  full?: boolean;      // 缺省 true（兼容旧帧）
  frame: number;
  t: number;
  map?: number[][];
  players: NetTank[];
  enemies: NetTank[];
  projectiles: NetProjectile[];
  loot: NetLootDrop[];
  powerups: NetPowerUp[];
  base: NetBase;
  scope: NetSnapshot["scope"];
  removed?: { tanks: number[]; projectiles: number[] };
}

/** 相同判定（坐标已由 buildSnapshot 取整，直接比较即可；忽略 renderT 无关字段） */
function sameTank(a: NetTank, b: NetTank): boolean {
  return a.x === b.x && a.y === b.y && a.hp === b.hp && a.facing === b.facing
    && a.activeCannon === b.activeCannon && a.hidden === b.hidden && a.alive === b.alive;
}
function sameProj(a: NetProjectile, b: NetProjectile): boolean {
  return a.x === b.x && a.y === b.y && a.radius === b.radius
    && a.color === b.color && a.type === b.type && a.ownerTeam === b.ownerTeam;
}

const KEY_FRAME_EVERY = 60;   // ≈2s @30Hz 关键帧
const FORCE_FULL_RATIO = 0.6; // 单类变化超 60% → 全量更划算

export class SnapshotDeltaCodec {
  private frameCount = 0;

  /** 编码：返回可直接发给成员的消息体（full 帧=全量；否则=增量）。 */
  encode(prev: NetSnapshot, cur: NetSnapshot): DeltaSnapshot {
    this.frameCount++;

    // 关键帧判定
    let full = this.frameCount === 1 || this.frameCount % KEY_FRAME_EVERY === 0;
    if (!full) {
      const [dp, de, dq] = [diffTanks(prev.players, cur.players), diffTanks(prev.enemies, cur.enemies), diffProjs(prev.projectiles, cur.projectiles)];
      if (dp.changed.length > cur.players.length * FORCE_FULL_RATIO ||
          de.changed.length > cur.enemies.length * FORCE_FULL_RATIO + 2 ||
          dq.changed.length > cur.projectiles.length * FORCE_FULL_RATIO) {
        full = true;
      } else if (dp.changed.length + de.changed.length + dq.changed.length + dp.removed.length + dq.removed.length > 0) {
        // 有变化 → 增量帧（base/scope 仅在变化时附带，未变用缓存 → 体积最小化）
        const baseChanged = JSON.stringify(prev.base) !== JSON.stringify(cur.base);
        const scopeSame = this.scopeEqual(prev.scope, cur.scope);
        return {
          full: false, frame: cur.frame, t: cur.t,
          players: dp.changed, enemies: de.changed, projectiles: dq.changed,
          loot: cur.loot, powerups: cur.powerups,
          base: baseChanged ? cur.base : undefined,
          scope: scopeSame ? undefined : cur.scope,
          removed: { tanks: [...dp.removed, ...de.removed], projectiles: dq.removed },
        } as unknown as DeltaSnapshot;
      }
      // 完全没变化（敌人静止等）→ 退化为轻量帧：只带时间戳（最省）
      if (full === false) {
        return { full: false, frame: cur.frame, t: cur.t, players: [], enemies: [], projectiles: [],
          loot: cur.loot, powerups: cur.powerups, base: undefined, scope: undefined, removed: undefined } as unknown as DeltaSnapshot;
      }
    }
    // 全量帧（关键帧/大变化/首帧）
    return {
      full: true, frame: cur.frame, t: cur.t,
      map: cur.map, players: cur.players, enemies: cur.enemies, projectiles: cur.projectiles,
      loot: cur.loot, powerups: cur.powerups, base: cur.base, scope: cur.scope, removed: cur.removed,
    };
  }

  /** 解码：增量帧合并到缓存，产出完整 NetSnapshot（供 RemoteView.setSnapshot） */
  decode(msg: DeltaSnapshot): NetSnapshot {
    this.frameCount = msg.frame;
    const scope = msg.scope ?? this.cacheScope ?? { score: 0, wave: 0, over: false };
    const b = msg.base ?? this.cacheBase;
    if (msg.full !== false) {
      // 全量帧：重建缓存
      this.cachePlayers = new Map(msg.players.map((t) => [t.id, t]));
      this.cacheEnemies = new Map(msg.enemies.map((t) => [t.id, t]));
      this.cacheProjs = new Map(msg.projectiles.map((p) => [p.id, p]));
      this.cacheBase = b;
      this.cacheScope = scope;
      return mergeFull(msg, scope, b);
    }
    // 增量/轻量帧：合并（base/scope 未带则沿用缓存）
    if (b) this.cacheBase = b;
    this.cacheScope = scope;
    if (msg.removed) {
      for (const id of msg.removed.tanks) { this.cachePlayers.delete(id); this.cacheEnemies.delete(id); }
      for (const id of msg.removed.projectiles) this.cacheProjs.delete(id);
    }
    for (const t of msg.players) this.cachePlayers.set(t.id, t);
    for (const t of msg.enemies) this.cacheEnemies.set(t.id, t);
    for (const p of msg.projectiles) this.cacheProjs.set(p.id, p);
    return {
      players: [...this.cachePlayers.values()],
      enemies: [...this.cacheEnemies.values()],
      projectiles: [...this.cacheProjs.values()],
      loot: msg.loot, powerups: msg.powerups,
      base: b ?? this.cacheBase!,
      scope,
      frame: msg.frame, t: msg.t,
    };
  }

  /** scope 是否相同（score/wave/over/wallets/bp/diff/hidden 全等才不发；钱包/背包变化会让成员实时感知） */
  private scopeEqual(a: NetSnapshot["scope"], c: NetSnapshot["scope"]): boolean {
    return a.score === c.score && a.wave === c.wave && a.over === c.over
      && a.diff === c.diff && a.hidden === c.hidden
      && JSON.stringify(a.wallets ?? null) === JSON.stringify(c.wallets ?? null)
      && JSON.stringify(a.bp ?? null) === JSON.stringify(c.bp ?? null);
  }

  /** 调试：缓存实体数（供可视化断言） */
  cacheSize(): { players: number; enemies: number; projectiles: number } {
    return { players: this.cachePlayers.size, enemies: this.cacheEnemies.size, projectiles: this.cacheProjs.size };
  }

  private cachePlayers = new Map<number, NetTank>();
  private cacheEnemies = new Map<number, NetTank>();
  private cacheProjs = new Map<number, NetProjectile>();
  private cacheBase: NetBase | undefined;
  private cacheScope: NetSnapshot["scope"] | undefined;
}

// ── 增量 diff：返回变化实体（新/异）+ 消失 id ──
function diffTanks(prev: NetTank[], cur: NetTank[]): { changed: NetTank[]; removed: number[] } {
  const prevMap = new Map(prev.map((t) => [t.id, t]));
  const curIds = new Set<number>();
  const changed: NetTank[] = [];
  for (const t of cur) {
    curIds.add(t.id);
    const p = prevMap.get(t.id);
    if (!p || !sameTank(p, t)) changed.push(t);
  }
  const removed: number[] = [];
  for (const t of prev) if (!curIds.has(t.id)) removed.push(t.id);
  return { changed, removed };
}
function diffProjs(prev: NetProjectile[], cur: NetProjectile[]): { changed: NetProjectile[]; removed: number[] } {
  const prevMap = new Map(prev.map((p) => [p.id, p]));
  const curIds = new Set<number>();
  const changed: NetProjectile[] = [];
  for (const p of cur) {
    curIds.add(p.id);
    const q = prevMap.get(p.id);
    if (!q || !sameProj(q, p)) changed.push(p);
  }
  const removed: number[] = [];
  for (const p of prev) if (!curIds.has(p.id)) removed.push(p.id);
  return { changed, removed };
}
function mergeFull(msg: DeltaSnapshot, scope: NetSnapshot["scope"], b?: NetBase): NetSnapshot {
  return {
    players: msg.players, enemies: msg.enemies, projectiles: msg.projectiles,
    loot: msg.loot, powerups: msg.powerups, base: b ?? msg.base, scope,
    map: msg.map, removed: msg.removed, frame: msg.frame, t: msg.t,
  };
}