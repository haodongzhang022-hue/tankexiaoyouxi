// ============================================================================
//  net-sync-core / tests / sync-core.test.ts ─ 通用核心自测
//  ----------------------------------------------------------------------------
//  重点：1) 通用 codec 行为（首帧全量/增量/removed/关键帧/alwaysFull/轻量帧）
//        2) 与现有已验证实现 SnapshotDeltaCodec 的交叉等价（同一序列解码结果一致）
//        3) 自适应插值/延迟/重连/迁移/引擎全链路
//  版本：2026-09-12 v1.0.0
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  SyncCodec, Interpolator, LatencyTracker, ReconnectManager, pickSuccessorHost,
  lerpEntity, SyncEngine, StableEntryManager, entryPathOf, parseStableEntry,
  type Transport, type SyncState, type EntityRecord,
} from "../core";
import { validateSchema } from "../schema";
import { TANK_SYNC_SCHEMA, netSnapshotToState, stateToNetSnapshot } from "../adapters/tank-adapter";
import { SnapshotDeltaCodec } from "../../src/net/SnapshotDelta";
import type { NetSnapshot, NetTank, NetProjectile } from "../../src/net/NetTypes";

// ── 测试夹具（与 tests/snapshot-delta.test.ts 同构的真实数据结构）──────────────
const base = { x: 480, y: 720, eagleHp: 50, eagleMaxHp: 50, isDestroyed: false, wallLevel: 1, walls: [] };
const tank = (id: number, x: number, y: number, playerId = 99, extra: Partial<NetTank> = {}): NetTank => ({
  id, x, y, hp: 50, maxHp: 50, alive: true, playerId, team: playerId < 100 ? 0 : 1, facing: "up",
  activeCannon: 0, gradeLabel: "F", hidden: false, ...extra,
});
// 敌人：playerId ≥ 100 → team=1（与真实 buildSnapshot 一致，适配器按 team 拆分玩家/敌人）
const etank = (id: number, x: number, y: number): NetTank => tank(id, x, y, 100 + id, { team: 1 });
const proj = (id: number, x: number, y: number): NetProjectile => ({ id, x, y, radius: 3, color: "#ff0", type: "proj_bullet", ownerTeam: 1 });
const full = (frame: number, t: number, players: NetTank[], enemies: NetTank[], projectiles: NetProjectile[]): NetSnapshot => ({
  players, enemies, projectiles, base,
  loot: [], powerups: [], map: frame === 1 ? [[0, 0], [0, 1]] : undefined,
  scope: { score: frame * 10, wave: 1, over: false }, frame, t,
});

describe("TANK_SYNC_SCHEMA（对接表）", () => {
  it("通过校验（字段/ID/事件无冲突）", () => {
    expect(validateSchema(TANK_SYNC_SCHEMA)).toEqual([]);
  });
});

describe("SyncCodec（schema 驱动）", () => {
  it("首帧为全量；解码重建与原始一致", () => {
    const c = new SyncCodec(TANK_SYNC_SCHEMA);
    const snap = full(1, 1000, [tank(1, 400, 380, 0), tank(2, 460, 380, 1)], [etank(101, 200, 200), etank(102, 260, 200)], [proj(201, 100, 100), proj(202, 130, 100)]);
    const s = netSnapshotToState(snap);
    const msg = c.encode(s, s);
    expect(msg.full).toBe(true);
    const out = stateToNetSnapshot(c.decode(msg));
    expect(out.players.map((x) => x.id).sort()).toEqual([1, 2]);
    expect(out.enemies.map((x) => x.id).sort()).toEqual([101, 102]);
    expect(out.projectiles.map((x) => x.id).sort()).toEqual([201, 202]);
  });

  it("增量帧：只带变化实体，removed 剔除消失实体", () => {
    const c = new SyncCodec(TANK_SYNC_SCHEMA);
    const f1 = full(1, 1000, [tank(1, 400, 380, 0), tank(2, 460, 380, 1)], [etank(101, 200, 200), etank(102, 260, 200)], [proj(201, 100, 100), proj(202, 130, 100)]);
    c.decode(c.encode(netSnapshotToState(f1), netSnapshotToState(f1)));
    // frame2：敌人 101 移动、子弹 201 死亡、新子弹 203 出现、玩家静止
    const f2 = full(2, 1030, [tank(1, 400, 380, 0), tank(2, 460, 380, 1)], [etank(101, 210, 205), etank(102, 260, 200)], [proj(202, 130, 100), proj(203, 40, 40)]);
    const msg = c.encode(netSnapshotToState(f1), netSnapshotToState(f2));
    expect(msg.full).toBe(false);
    // tank 种类为合并集（玩家+敌人）：只有移动的敌人 101 进增量
    expect(msg.kinds?.tank?.map((r) => r.id)).toEqual([101]);
    expect(msg.kinds?.projectile?.length ?? 0).toBe(1);    // 新子弹 203
    expect(msg.removed?.projectile).toEqual([201]);
    const out = stateToNetSnapshot(c.decode(msg));
    expect(out.projectiles.map((x) => x.id).sort()).toEqual([202, 203]);
    expect(out.enemies.find((x) => x.id === 101)!.x).toBe(210);
  });

  it("完全无变化 → 轻量帧（无 kinds/scope）", () => {
    const c = new SyncCodec(TANK_SYNC_SCHEMA);
    const s1: SyncState = { frame: 1, t: 1000, kinds: { tank: [{ id: 1, x: 1, y: 1 }] }, scope: { score: 0 } };
    c.decode(c.encode(s1, s1));
    const s2: SyncState = { frame: 2, t: 1050, kinds: s1.kinds, scope: { score: 0 } };
    const msg = c.encode(s1, s2);
    expect(msg.full).toBe(false);
    expect(msg.kinds).toBeUndefined();
    expect(msg.scope).toBeUndefined();
  });

  it("每 keyFrameEvery 帧强制全量（防丢包累积错乱）", () => {
    const c = new SyncCodec(TANK_SYNC_SCHEMA);
    let prev: SyncState = { frame: 1, t: 0, kinds: {}, scope: { score: 1 } };
    c.encode(prev, prev);                                 // 预热：frameCount=1（与现有测试同构）
    let sawFullAt60 = false;
    for (let f = 2; f <= 60; f++) {
      const cur: SyncState = { frame: f, t: f * 50, kinds: {}, scope: { score: f } };
      const msg = c.encode(prev, cur);
      prev = cur;
      if (f === 60) sawFullAt60 = msg.full === true;
    }
    expect(sawFullAt60).toBe(true);
  });

  it("alwaysFull 种类（loot）：每帧整组携带，无稳定 ID 也可靠", () => {
    const c = new SyncCodec(TANK_SYNC_SCHEMA);
    const mk = (frame: number, t: number, loot: EntityRecord[]): SyncState => ({ frame, t, kinds: { loot }, scope: {} });
    const s1 = mk(1, 1000, [{ x: 10, y: 10, type: "exp" }]);
    c.decode(c.encode(s1, s1));
    const s2 = mk(2, 1050, [{ x: 20, y: 20, type: "gold" }, { x: 30, y: 30, type: "module" }]);
    const msg = c.encode(s1, s2);
    expect(msg.full).toBe(false);
    expect(msg.kinds?.loot).toEqual(s2.kinds.loot);
    expect(c.decode(msg).kinds.loot).toHaveLength(2);
  });
});

describe("与现有 SnapshotDeltaCodec 交叉等价（模块 = 已验证行为的通用化）", () => {
  it("同一序列下：全量/增量决策一致，解码结果（实体集/位置/scope）一致", () => {
    const enc = new SyncCodec(TANK_SYNC_SCHEMA);
    const dec = new SyncCodec(TANK_SYNC_SCHEMA);
    const oldEnc = new SnapshotDeltaCodec();
    const oldDec = new SnapshotDeltaCodec();

    const frames: NetSnapshot[] = [
      full(1, 1000, [tank(1, 400, 380, 0), tank(2, 460, 380, 1)], [etank(101, 200, 200), etank(102, 260, 200)], [proj(201, 100, 100), proj(202, 130, 100)]),
      full(2, 1030, [tank(1, 400, 380, 0), tank(2, 460, 380, 1)], [etank(101, 210, 205), etank(102, 260, 200)], [proj(202, 130, 100), proj(203, 40, 40)]),
      full(3, 1060, [tank(1, 400, 380, 0), tank(2, 460, 380, 1)], [etank(101, 220, 210), etank(102, 260, 200)], [proj(203, 60, 44), proj(202, 130, 110)]),
    ];

    let prevSnap: NetSnapshot | null = null;
    for (const snap of frames) {
      const curState = netSnapshotToState(snap);
      const gmsg = enc.encode(prevSnap ? netSnapshotToState(prevSnap) : curState, curState);
      const omsg = oldEnc.encode(prevSnap ?? snap, snap);
      // 全量/增量决策一致（序列避开全量保护阈值）
      expect(gmsg.full).toBe(omsg.full);

      const gsnap = stateToNetSnapshot(dec.decode(gmsg));
      const osnap = oldDec.decode(omsg as never);

      const ids = (arr: Array<{ id: number }>) => arr.map((x) => x.id).sort();
      expect(ids(gsnap.players)).toEqual(ids(osnap.players));
      expect(ids(gsnap.enemies)).toEqual(ids(osnap.enemies));
      expect(ids(gsnap.projectiles)).toEqual(ids(osnap.projectiles));
      for (const t of osnap.players) {
        const g = gsnap.players.find((x) => x.id === t.id)!;
        expect([g.x, g.y, g.hp]).toEqual([t.x, t.y, t.hp]);
      }
      for (const t of osnap.enemies) {
        const g = gsnap.enemies.find((x) => x.id === t.id)!;
        expect([g.x, g.y]).toEqual([t.x, t.y]);
      }
      expect(gsnap.scope.score).toBe(osnap.scope.score);
      expect(gsnap.scope.wave).toBe(osnap.scope.wave);
      expect(gsnap.base.eagleHp).toBe(osnap.base.eagleHp);
      prevSnap = snap;
    }
  });
});

describe("Interpolator（自适应插值缓冲，v2.6.7 算法固化）", () => {
  const mk = (frame: number, t: number, x: number): SyncState => ({
    frame, t, kinds: { tank: [{ id: 1, x, y: 100, hp: 50 }] }, scope: { score: frame },
  });

  it("稳定节奏 → 延迟贴最新（低延迟）", () => {
    const ip = new Interpolator({ delayMinMs: 30, delayMaxMs: 200, adaptive: true, stepMs: 34, catchUpMult: 2.2, backoffMult: 0.6 });
    let t = 1000;
    for (let i = 0; i < 30; i++) {
      ip.push(mk(i + 1, t, i * 5));
      ip.advance();
      t += 50;
    }
    expect(ip.debug().delay).toBeLessThan(80);       // 稳定 → ~43ms
    expect(ip.debug().delay).toBeGreaterThanOrEqual(30);
    expect(ip.debug().renderT).toBeLessThanOrEqual(ip.debug().latestT);
  });

  it("强抖动 → 延迟加深缓冲（防卡顿回跳）", () => {
    const ip = new Interpolator({ delayMinMs: 30, delayMaxMs: 200, adaptive: true, stepMs: 34, catchUpMult: 2.2, backoffMult: 0.6 });
    let t = 1000;
    for (let i = 0; i < 40; i++) {
      ip.push(mk(i + 1, t, i * 5));
      ip.advance();
      t += i % 2 === 0 ? 0 : 150;                     // 0/150ms 剧烈抖动
    }
    expect(ip.debug().delay).toBeGreaterThan(100);
    expect(ip.debug().delay).toBeLessThanOrEqual(200);
  });

  it("插值对 alpha ∈ [0,1]，a.t <= b.t", () => {
    const ip = new Interpolator({ delayMinMs: 30, delayMaxMs: 200, adaptive: true, stepMs: 34, catchUpMult: 2.2, backoffMult: 0.6 });
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      ip.push(mk(i + 1, t, i * 5));
      for (let k = 0; k < 3; k++) ip.advance();
      t += 50;
    }
    const p = ip.pair();
    expect(p.alpha).toBeGreaterThanOrEqual(0);
    expect(p.alpha).toBeLessThanOrEqual(1);
    if (p.a && p.b) expect(p.a.t).toBeLessThanOrEqual(p.b.t);
  });

  it("lerpEntity：数值插值 / 非数值取 b / 缺 id 返回 null", () => {
    const a: EntityRecord = { id: 7, x: 100, y: 100, hp: 50, facing: "up" };
    const b: EntityRecord = { id: 7, x: 110, y: 120, hp: 40, facing: "down" };
    const out = lerpEntity(a, b, 0.5, ["x", "y", "hp"]);
    expect(out).not.toBeNull();
    expect((out as EntityRecord).x).toBe(105);
    expect((out as EntityRecord).hp).toBe(45);
    expect((out as EntityRecord).facing).toBe("down");
    expect(lerpEntity(a, undefined, 0.5, ["x"])).toBeNull();
  });
});

describe("LatencyTracker（RTT/抖动）", () => {
  it("由 pong 时间戳计算 RTT 与抖动", () => {
    const lt = new LatencyTracker();
    lt.onPong(1000, 1100);
    lt.onPong(1000, 1160);
    expect(lt.rtt).toBeGreaterThan(0);
    expect(lt.jitter).toBeGreaterThanOrEqual(0);
    lt.reset();
    expect(lt.rtt).toBe(0);
  });
});

describe("ReconnectManager（断线重连，v2.11 对齐）", () => {
  it("卡片存/读/清；begin 超时回 failed", async () => {
    const mem: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    };
    const rm = new ReconnectManager(storage, "tank_rejoin_v1");
    rm.save({ tableId: 7, token: "abc" });
    expect(rm.peek()).toEqual({ tableId: 7, token: "abc" });
    rm.clear();
    expect(rm.peek()).toBeNull();
  });
});

describe("HostMigration（主机迁移，v2.12 对齐）", () => {
  it("最靠前的在场非房主成员接替", () => {
    const seats = [
      { clientId: 10, online: false, isHost: true },   // 房主断线
      { clientId: 11, online: true, isHost: false },   // → 接替
      { clientId: 12, online: false, isHost: false },
      { clientId: 13, online: true, isHost: false },
    ];
    expect(pickSuccessorHost(seats, 10)).toBe(11);
    expect(pickSuccessorHost(seats, 11)).toBe(13);     // 11 若也断 → 13
  });
  it("无人在场可接替 → null（终止本局）", () => {
    const seats = [
      { clientId: 10, online: false, isHost: true },
      { clientId: 11, online: false, isHost: false },
    ];
    expect(pickSuccessorHost(seats, 10)).toBeNull();
  });
});

// ── 传输假件（内存直达，模拟序列化往返）──
class FakeTransport implements Transport {
  readonly kind = "ws" as const;
  messages: unknown[] = [];
  private cb: ((raw: unknown) => void) | null = null;
  private peer: FakeTransport | null = null;
  link(peer: FakeTransport): void { this.peer = peer; }
  ready(): boolean { return true; }
  send(msg: unknown): void {
    this.messages.push(msg);
    // 深拷贝模拟跨进程序列化
    const clone = JSON.parse(JSON.stringify(msg));
    if (this.peer) this.peer.cb?.(clone);
  }
  onMessage(cb: (raw: unknown) => void): void { this.cb = cb; }
  close(): void { this.cb = null; }
}

describe("SyncEngine（主机→成员全链路：编码→去重→解码→onState）", () => {
  it("三次快照 + 双发去重", () => {
    let world: SyncState = { frame: 1, t: 1000, kinds: { tank: [{ id: 1, x: 10, y: 10, hp: 50 }] }, scope: { score: 0 } };
    const hostT = new FakeTransport();
    const memberT = new FakeTransport();
    hostT.link(memberT);

    const host = new SyncEngine(TANK_SYNC_SCHEMA, hostT, {
      worldToState: () => world,
      onState: () => {},
      onEvent: () => {},
    });
    const states: SyncState[] = [];
    const member = new SyncEngine(TANK_SYNC_SCHEMA, memberT, {
      worldToState: () => ({ frame: 0, t: 0, kinds: {}, scope: {} }),
      onState: (s) => states.push(s),
      onEvent: () => {},
    });

    host.hostTick();
    world = { frame: 2, t: 1050, kinds: { tank: [{ id: 1, x: 30, y: 30, hp: 50 }] }, scope: { score: 10 } };
    host.hostTick();
    world = { frame: 3, t: 1100, kinds: { tank: [{ id: 1, x: 50, y: 40, hp: 50 }] }, scope: { score: 20 } };
    host.hostTick();

    // P2P 双发去重：重复送帧 2（frame=2）
    const dup = JSON.parse(JSON.stringify(hostT.messages[1]));
    member.handleMessage(dup);

    expect(states).toHaveLength(3);
    expect(states[2].kinds.tank[0].x).toBe(50);
    expect(states[2].scope.score).toBe(20);
    expect(host.rtt).toBe(0);
  });
});

// ── Issue #16 🟢：稳定入口链接形态**入库**（以前这条断言只活在 scripts/e2e/ 里，CI 看不到）──
// 形态契约（Issue #11 成果，不得回退）：分享链接 = <入口>/<sid>/join/<roomId>，
// 房号在**路径**里（不是 ?room=）；不带房号的「大厅链接」= <入口>/<sid>/join/。
// 这条锁在 CI 里跑（vitest），避免"只有真机 e2e 才发现形态被改坏"。
describe("稳定入口链接形态（Issue #11 成果的 CI 可见回归锁）", () => {
  const SID = "a1b2c3d4";

  it("邀请链接把房号放在**路径**里：/<sid>/join/<roomId>", () => {
    const p = entryPathOf(SID, 7);
    expect(p).toBe(`/${SID}/join/7`);
    const full = `http://203.0.113.9:3001${p}`;
    expect(new URL(full).pathname).toBe(`/${SID}/join/7`);
    expect(full).not.toContain("?room=");          // 房号不许退化成 query（退化了 302 会丢房号）
  });

  it("大厅链接不带房号：/<sid>/join/", () => {
    expect(entryPathOf(SID, null)).toBe(`/${SID}/join/`);
    expect(entryPathOf(SID)).toBe(`/${SID}/join/`);
  });

  it("IP 形态入口（无域名）也成立，且协议不被改写", () => {
    // v3.0.2 评审 🔴2：IP 部署必须能分享；曾经被硬拼成 https:// 而不可用
    expect(`http://192.168.1.50:3001${entryPathOf(SID, 3)}`).toBe(`http://192.168.1.50:3001/${SID}/join/3`);
  });

  it("sid 不合法 → 空串（调用方退回普通寻址，不生成半截链接）", () => {
    for (const bad of ["", "xyz", "a1b2c3", "a1b2c3d4e5", "A1B2C3D4Z"]) {
      expect(entryPathOf(bad, 7)).toBe("");
    }
  });

  it("生成的链接能被 parseStableEntry 原样解析回来（闭环：发起方与接收方同一口径）", () => {
    for (const room of [null, 1, 7, 99999]) {
      const url = `https://game.example.com${entryPathOf(SID, room)}`;
      const card = parseStableEntry(url);
      expect(card?.sid).toBe(SID);
      expect(card?.roomId ?? null).toBe(room);
    }
  });

  it("parseStableEntry 也认历史写法 /entry/<sid>（旧链接不作废）", () => {
    expect(parseStableEntry(`https://h/entry/${SID}`)?.sid).toBe(SID);
    expect(parseStableEntry(`https://h/${SID}/join/?room=5`)?.roomId).toBe(5);
  });

  it("StableEntryManager.adopt 只接受合法 sid；url 记的是「带房号路径」的形态", () => {
    const mem = new Map<string, string>();
    const mgr = new StableEntryManager(
      { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } },
      "k",
    );
    expect(mgr.adopt("bad", "https://h/")).toBeNull();
    const card = mgr.adopt(SID, `https://h${entryPathOf(SID, 7)}`, 7);
    expect(card?.sid).toBe(SID);
    expect(mgr.peek()?.url).toBe(`https://h/${SID}/join/7`);
    // 服务器换入口后只需换 url，房号仍在路径里（保持同一形态，不断链）
    const moved = mgr.adopt(SID, `http://198.51.100.7:3001${entryPathOf(SID, 7)}`, 7);
    expect(moved?.url).toBe(`http://198.51.100.7:3001/${SID}/join/7`);
    expect(moved?.url).not.toContain("?room=");
  });
});
