// ============================================================================
//  net-sync-core / adapters / tank-adapter.ts ─ 坦克大战对接示例（填表即对接）
//  ----------------------------------------------------------------------------
//  本文件是「对接表」的一份已填好实例 + 状态转换函数，证明：
//    1. 通用核心（core.ts）的 schema 声明能完整覆盖坦克真实同步数据——
//       玩家/敌人（tank）、子弹（projectile）、掉落（loot）、道具（powerup）、
//       基地/分数/波次/经验钱包/背包（scope）、地图（payload）、检查点（checkpoint）；
//    2. 填表 + 转换函数即可接入，无需改通用核心。
//  其他项目（Unity/Cocos/UE）按同一张表的格式自填一份 adapter，替换本文件。
//  版本：2026-09-12 v1.0.0（对齐 src/net/NetTypes.ts 现行协议）。
// ============================================================================

import type { EntityRecord, SyncState } from "../core";
import type { SyncSchema } from "../schema";
import type { NetSnapshot } from "../../src/net/NetTypes";

// ── 对接表（TANK 实例）：坦克 v2.12 协议 → 通用契约 ──────────────────────────

export const TANK_SYNC_SCHEMA: SyncSchema = {
  version: "2026-09-12-v1",
  project: "web-tank-battle",
  tickRate: 30,                  // 快照 30Hz（增量后带宽可控）
  keyFrameEvery: 60,             // 每 60 帧（≈2s）关键全量帧，防丢包累积错乱
  forceFullRatio: 0.6,           // 单类变化超 60% 强制全量

  // ── 实体种类表 ──
  entities: [
    {
      kind: "tank",
      idField: "id",             // 稳定 ID：玩家 P1=1/P2=2、敌人 1000 起、全局唯一
      fields: [
        // 参与 diff（变化才发）——对齐 v2.8 sameTank 比较集
        { name: "x", type: "int", sync: "eq", note: "像素级取整，减 ~40% 体积" },
        { name: "y", type: "int", sync: "eq" },
        { name: "hp", type: "int", sync: "eq" },
        { name: "facing", type: "enum", sync: "eq" },
        { name: "activeCannon", type: "int", sync: "eq" },
        { name: "hidden", type: "bool", sync: "eq", note: "出生保护半透明" },
        { name: "alive", type: "bool", sync: "eq" },
        // 低频/常量字段：不参与 diff，随记录携带
        { name: "id", type: "int", sync: "none" },
        { name: "playerId", type: "int", sync: "none" },
        { name: "team", type: "int", sync: "none" },
        { name: "maxHp", type: "int", sync: "none" },
        { name: "isBoss", type: "bool", sync: "none" },
        { name: "gradeLabel", type: "string", sync: "none", note: "敌人等级标签（渲染用）" },
        { name: "respawnTimer", type: "int", sync: "none" },
        { name: "lives", type: "int", sync: "none", note: "剩余生命（死亡救援标记）" },
      ],
    },
    {
      kind: "projectile",
      idField: "id",             // WandSystem 自增，同一颗子弹跨帧稳定
      fields: [
        { name: "x", type: "int", sync: "eq" },
        { name: "y", type: "int", sync: "eq" },
        { name: "radius", type: "int", sync: "eq" },
        { name: "color", type: "string", sync: "eq" },
        { name: "type", type: "string", sync: "eq" },
        { name: "ownerTeam", type: "int", sync: "eq" },
        { name: "id", type: "int", sync: "none" },
      ],
    },
    {
      kind: "loot",
      alwaysFull: true,          // 无稳定 ID：每帧全量（等价 v2.8 行为）
      fields: [
        { name: "x", type: "int", sync: "always" },
        { name: "y", type: "int", sync: "always" },
        { name: "type", type: "string", sync: "always", note: "module/item/exp/gold" },
        { name: "quality", type: "string", sync: "always", note: "white/blue/gold/none" },
        { name: "moduleId", type: "string", sync: "always" },
        { name: "itemId", type: "string", sync: "always" },
        { name: "value", type: "int", sync: "always", note: "经验/金币数值" },
      ],
    },
    {
      kind: "powerup",
      alwaysFull: true,
      fields: [
        { name: "x", type: "int", sync: "always" },
        { name: "y", type: "int", sync: "always" },
        { name: "type", type: "string", sync: "always" },
      ],
    },
  ],

  // ── 全局小状态（变化才发）──
  scope: [
    { name: "score", type: "int", sync: "eq", note: "总分" },
    { name: "wave", type: "int", sync: "eq", note: "波次" },
    { name: "over", type: "bool", sync: "eq" },
    { name: "wallets", type: "array", sync: "eq", note: "每玩家经验钱包（金币），成员端据此显示/校验购买余额" },
    { name: "bp", type: "array", sync: "eq", note: "每玩家背包视图（传统道具计数+模块数），成员端对齐查看" },
    { name: "diff", type: "int", sync: "eq", note: "v2.30 难度分（顶栏显示，主机权威）" },
    { name: "hidden", type: "int", sync: "eq", note: "v2.30 隐藏分（顶栏显示，主机权威）" },
    { name: "base", type: "object", sync: "eq", note: "基地（鹰标血量/墙等级/墙体耐久/独立小砖）", sub: [
      { name: "x", type: "int", sync: "eq" }, { name: "y", type: "int", sync: "eq" },
      { name: "eagleHp", type: "int", sync: "eq" }, { name: "eagleMaxHp", type: "int", sync: "eq" },
      { name: "isDestroyed", type: "bool", sync: "eq" }, { name: "wallLevel", type: "int", sync: "eq" },
      { name: "walls", type: "array", sync: "eq", note: "[{side,hp,maxHp}] 面级聚合" },
      { name: "bricks", type: "array", sync: "eq", note: "v2.16 [{side,index,hp,maxHp,x,y,w,h}] 独立小砖" },
    ] },
  ],

  // ── 首帧大数据（仅全量帧携带）──
  payload: [
    { name: "map", type: "array", sync: "none", note: "地图二维数组，首帧发一次，成员端缓存" },
  ],

  // ── 事件表（可靠中继，不混入快照流）──
  events: [
    { name: "levelup", dir: "host_to_members", reliable: true, fields: [
      { name: "playerIdx", type: "int", sync: "eq" }, { name: "choices", type: "array", sync: "eq" } ] },
    { name: "pick_levelup", dir: "member_to_host", reliable: true, fields: [
      { name: "playerIdx", type: "int", sync: "eq" }, { name: "choice", type: "int", sync: "eq" } ] },
    { name: "shopstate", dir: "host_to_members", reliable: true, fields: [
      { name: "stock", type: "array", sync: "eq" } ] },
    { name: "shop_buy", dir: "member_to_host", reliable: true, fields: [
      { name: "playerIdx", type: "int", sync: "eq" }, { name: "choice", type: "int", sync: "eq" } ] },
    { name: "gameover", dir: "host_to_members", reliable: true, fields: [
      { name: "info", type: "object", sync: "eq", sub: [
        { name: "reason", type: "string", sync: "eq" }, { name: "score", type: "int", sync: "eq" } ] } ] },
    { name: "checkpoint", dir: "host_to_members", reliable: true, fields: [
      { name: "players", type: "array", sync: "eq", note: "每玩家检查点（见下方 checkpoint 表）" } ] },
    { name: "rtc_signal", dir: "any", reliable: true, fields: [
      { name: "from", type: "int", sync: "eq" }, { name: "to", type: "int", sync: "eq" }, { name: "payload", type: "object", sync: "eq" } ] },
  ],

  // ── 检查点（快照未携带的重状态，每 2s 广播，接替续局用）──
  checkpoint: [
    { name: "cannons", type: "array", sync: "eq", note: "4 根炮筒（config + 模块 id/剩余次数 + active）" },
    { name: "level", type: "int", sync: "eq", note: "等级" },
    { name: "exp", type: "int", sync: "eq", note: "经验" },
    { name: "lives", type: "int", sync: "eq", note: "剩余生命" },
    { name: "stats", type: "object", sync: "eq", note: "kills/damageDealt/goldCollected…" },
    { name: "wandDamageMults", type: "array", sync: "eq" },
    { name: "critChance", type: "float", sync: "eq" },
    { name: "projSpeedMult", type: "float", sync: "eq" },
    { name: "extraMaxHp", type: "int", sync: "eq" },
    { name: "flatArmor", type: "int", sync: "eq" },
    { name: "pctDefense", type: "float", sync: "eq" },
    { name: "hasInvincibleShield", type: "bool", sync: "eq" },
    { name: "hasModuleSteal", type: "bool", sync: "eq" },
    { name: "hasFreeCast", type: "bool", sync: "eq" },
    { name: "wallLevel", type: "int", sync: "eq" },
    { name: "inv", type: "array", sync: "eq", note: "背包槽位 [{kind,id,uses} | null]" },
  ],

  interp: {
    delayMinMs: 30,               // 对齐 v2.6.7 RemoteView
    delayMaxMs: 200,
    adaptive: true,               // 抖动驱动加深缓冲
    stepMs: 34,                   // 单帧最大推进（快照间隔 ~50ms 的 2/3）
    catchUpMult: 2.2,             // 追赶倍率
    backoffMult: 0.6,             // 后撤铺缓冲倍率
  },
  reconnect: { tokenKey: "tank_rejoin_v1", timeoutMs: 300 },
  heartbeatMs: 1000,              // RTT 探测/心跳间隔
  transport: { primary: "ws", fallback: "rtc", dualSend: true }, // P2P 双发 + WS 兜底
};

// ── 状态转换（NetSnapshot ↔ SyncState）───────────────────────────────────────

/** 主机/成员：把坦克快照转换为通用状态（removed 由 codec 自行计算，无需带入） */
export function netSnapshotToState(snap: NetSnapshot): SyncState {
  const kinds: Record<string, EntityRecord[]> = {
    tank: [...(snap.players ?? []), ...(snap.enemies ?? [])] as unknown as EntityRecord[],
    projectile: (snap.projectiles ?? []) as unknown as EntityRecord[],
    loot: (snap.loot ?? []) as unknown as EntityRecord[],
    powerup: (snap.powerups ?? []) as unknown as EntityRecord[],
  };
  return {
    frame: snap.frame,
    t: snap.t,
    kinds,
    scope: {
      score: snap.scope?.score ?? 0,
      wave: snap.scope?.wave ?? 0,
      over: snap.scope?.over ?? false,
      wallets: snap.scope?.wallets,
      bp: snap.scope?.bp,
      diff: snap.scope?.diff,
      hidden: snap.scope?.hidden,
      base: snap.base,
      mapChanges: snap.mapChanges,
      tileStates: snap.tileStates,
      explosions: snap.explosions,
      biome: snap.biome,
      handyman: snap.handyman,
      damageNumbers: snap.damageNumbers,
    },
    payload: snap.map ? { map: snap.map } : undefined,
  };
}

/** 成员端：把解码出的通用状态还原为坦克快照（喂 RemoteView / 接替续局） */
export function stateToNetSnapshot(s: SyncState): NetSnapshot {
  const tanks = s.kinds.tank ?? [];
  return {
    players: tanks.filter((t) => t.team === 0) as unknown as NetSnapshot["players"],
    enemies: tanks.filter((t) => t.team !== 0) as unknown as NetSnapshot["enemies"],
    projectiles: (s.kinds.projectile ?? []) as unknown as NetSnapshot["projectiles"],
    loot: (s.kinds.loot ?? []) as unknown as NetSnapshot["loot"],
    powerups: (s.kinds.powerup ?? []) as unknown as NetSnapshot["powerups"],
    base: s.scope.base as NetSnapshot["base"],
    map: (s.payload?.map as number[][]) ?? undefined,
    mapChanges: s.scope.mapChanges as NetSnapshot["mapChanges"],
    tileStates: s.scope.tileStates as NetSnapshot["tileStates"],
    explosions: s.scope.explosions as NetSnapshot["explosions"],
    biome: s.scope.biome as string | undefined,
    handyman: s.scope.handyman as NetSnapshot["handyman"],
    damageNumbers: s.scope.damageNumbers as NetSnapshot["damageNumbers"],
    scope: {
      score: s.scope.score as number,
      wave: s.scope.wave as number,
      over: s.scope.over as boolean,
      wallets: s.scope.wallets as number[] | undefined,
      bp: s.scope.bp as Array<Record<string, number>> | undefined,
      diff: s.scope.diff as number | undefined,
      hidden: s.scope.hidden as number | undefined,
    },
    frame: s.frame,
    t: s.t,
  };
}
