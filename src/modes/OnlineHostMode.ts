//  OnlineHostMode.ts ─
//  联机·主机权威模式（桌主运行）：复用 GameModeCore 完整模拟 + 渲染。
//  差异点：
//    - P2（玩家2）的按键来自远端成员（setOverrideP2 合并为 P2 输入），
//      P1 由主机本地（WASD）操控。单人开局（playerCount=1）只创建 P1。
//    - 座位 3~4 为观战成员：只收快照，不贡献按键。
//    - 每 50ms 序列化一份权威快照(NetSnapshot)广播给远端成员。
//  玩法默认无尽（连续刷怪），便于两人协作测试。

import { GameModeCore } from "../framework/GameModeCore";
import { generateMap, BIOMES } from "../systems/terrain/MapGenerator";
import { Enemy, type EnemyGrade } from "../game/Enemy";
import { TILE_SIZE } from "../game/Tilemap";
import type { GameLayout } from "../types/GameLayout";
import type { Renderer } from "../engine/Renderer";
import type { PlayerInput } from "../engine/InputManager";
import { EMPTY_INPUT } from "../engine/InputManager";
// ── net-sync-core 通用资产：主机端快照用 schema 驱动编解码（协议格式随两端一起升级，服务器无感）──
import { SyncCodec } from "../../net-sync-core/core";
import type { SyncState } from "../../net-sync-core/core";
import { TANK_SYNC_SCHEMA, netSnapshotToState } from "../../net-sync-core/adapters/tank-adapter";
import { isAllHumanPlayersDead } from "../utils/GameOver";
import type {
  NetSnapshot, NetTank, NetProjectile, NetLootDrop, NetPowerUp, NetLvlChoice, CheckpointPlayer, NetWarehouse,
} from "../net/NetTypes";
import { getSoundManager } from "../engine/SoundManager";
import type { PowerUpType } from "../systems/powerup/PowerUpSystem";
import { assetPack } from "../assets/AssetPack";

export class OnlineHostMode extends GameModeCore {
  /** 远端成员（玩家2）的最近一帧按键，由 main 收到 peer_input 后写入 */
  remoteInput: PlayerInput = EMPTY_INPUT();
  /** 快照/结束广播回调，由 main 注入（源自 NetClient.hostSnapshot/hostGameOver） */
  onSendSnapshot: ((s: NetSnapshot) => void) | null = null;
  onSendGameOver: ((info: { reason: string; score: number }) => void) | null = null;
  /** 升级选项广播回调（由 main 注入 → net.hostLevelUp） */
  onSendLevelUp: ((d: { playerIdx: number; choices: NetLvlChoice[] }) => void) | null = null;
  /** 远端成员断线时（对局仍可继续） */
  onRemoteLeft: (() => void) | null = null;
  /** v2.12 检查点广播回调（由 main 注入 → net.hostCheckpoint；成员保存最新一份用于接替续局） */
  onSendCheckpoint: ((data: { players: CheckpointPlayer[]; warehouse: NetWarehouse; assetPack?: import("../assets/AssetPack").AssetPack; assetPackVersion: string }) => void) | null = null;
  /** v2.23 装配/加固结果回执（由 main 注入 → net.equipRes / net.fortifyRes；成员拖动/点按钮后收到反馈） */
  onEquipResult: ((playerIdx: number, ok: boolean, msg: string) => void) | null = null;
  onFortifyResult: ((ok: boolean, msg: string) => void) | null = null;

  private snapshotTimer = 0;
  private snapshotFrame = 0;                    // 单调递增帧号
  /** v2.12 检查点发送周期（2s：快照未携带的武器/等级/背包状态，接替续局用） */
  private checkpointTimer = 0;
  /** v2.17 资源包是否已发送（首次检查点发完整包；v2.35 起每 8 个检查点补发一次） */
  private assetPackSent = false;
  /** v2.35 检查点序号（用于资源包周期补发） */
  private checkpointSerial = 0;
  private readonly CHECKPOINT_INTERVAL = 2;
  /** v2.8 快照增量编码（30Hz 保证带宽不涨）——net-sync-core SyncCodec（schema 驱动） */
  private snapCodec = new SyncCodec(TANK_SYNC_SCHEMA);
  private lastSentState: SyncState | null = null;
  private readonly SNAPSHOT_INTERVAL = 1 / 30;  // 30Hz（增量后带宽反而小于原 20Hz 全量）
  /** 上次已广播的升级标识（playerIdx+选项序列），用于触发新面板广播 */
  private lastLvlKey = "";
  private gameOverReason: "base" | "team" = "team";
  private gameOverNotified = false;
  private wave = 0;
  private mapArray: number[][] = [];
  /** 地图已发送标志（只在首个快照携带地图数据，后续帧设为 null 省带宽） */
  private mapSent = false;
  /** 上一快照的实体 ID 集合（用于计算 removed 差集；坦克 ID 全局唯一，仅敌人会消失/玩家常驻） */
  private prevTankIds = new Set<number>();
  private prevProjIds = new Set<number>();
  /** 最近一次收到远端输入的服务端时间（用于粗略 RTT） */
  lastPeerInputTime = 0;
  /** 主机侧网络 RTT（由 main 经 net.ping 测量后写入） */
  netHud: { rtt: number; jitter: number } = { rtt: 0, jitter: 0 };
  /** P2 输入新鲜度：距最近一次收到远端输入毫秒（-1=尚未收到） */
  peerInputLag = -1;
  /** P2 输入到达抖动：到达间隔相对均值的偏差 EMA（ms） */
  peerInputJitter = 0;
  private lastPeerRecvTime = 0;
  private peerDtEma = 0;
  private peerJitterEma = 0;

  // ── 远端输入队列（主机侧消费/抗抖动）──
  /** 远端输入队列：{ frame: 客户端固定步进帧号, input: PlayerInput, recvTime: number } */
  private remoteInputQueue: Array<{ frame: number; input: PlayerInput; recvTime: number }> = [];
  /** 已应用到 P2 的最新客户端帧号（用于丢弃乱序/过期帧） */
  private remoteInputSeq = 0;
  /** 连续无新输入的固定帧数（超过阈值则清空输入，防止断线后坦克一直自动走） */
  private staleTicks = 0;
  /** 无新输入时保持上一输入的最多固定帧数（≈167ms 容抖） */
  private readonly STALE_MAX_TICKS = 10;
  /** 上一帧实际应用的输入（供沿用/兜底） */
  private lastAppliedInput: PlayerInput | null = null;
  /** 固定模拟帧时间 (1/60) */
  private readonly FIXED_DT = 1 / 60;
  /** 累积的模拟时间，用于固定步进 */
  private _accumulatedSimTime = 0;

  /** main.ts 收到 peer_input 时调用：把远端输入按帧号入队（重复帧保留最新状态） */
  enqueueRemoteInput(input: PlayerInput, clientFrame: number, recvTime: number): void {
    // 简单去重：同一帧只保留最新
    const existing = this.remoteInputQueue.find(q => q.frame === clientFrame);
    if (existing) {
      existing.input = input;
      existing.recvTime = recvTime;
      return;
    }
    this.remoteInputQueue.push({ frame: clientFrame, input, recvTime });
    // 按帧号排序
    this.remoteInputQueue.sort((a, b) => a.frame - b.frame);
    // 限制队列长度（最多缓存 1 秒 ≈ 60 帧）
    if (this.remoteInputQueue.length > 60) this.remoteInputQueue.shift();

    // 到达间隔抖动（EMA of |dt - 均值|）：供 HUD 显示 P2 输入链路稳定性
    if (this.lastPeerRecvTime > 0) {
      const dt = recvTime - this.lastPeerRecvTime;
      if (dt > 0 && dt < 2000) {
        if (this.peerDtEma === 0) this.peerDtEma = dt; else this.peerDtEma += 0.15 * (dt - this.peerDtEma);
        const jd = Math.abs(dt - this.peerDtEma);
        if (this.peerJitterEma === 0) this.peerJitterEma = jd; else this.peerJitterEma += 0.2 * (jd - this.peerJitterEma);
        this.peerInputJitter = Math.round(this.peerJitterEma);
      }
    }
    this.lastPeerRecvTime = recvTime;
  }

  constructor(canvas: HTMLCanvasElement, layout?: GameLayout, playerCount = 2, aiSeats: number[] = []) {
    // v2.18 引擎支持 1~4 名战斗玩家；3~4 号可为AI座位（房间手动设置）
    super(canvas, layout, Math.min(4, Math.max(1, playerCount)));
    // v2.14.2 AI队友：大厅开启后覆写此标记（由 main.ts 的 setAICompanion 方法在开局前调用）
    this.p2Bot = false;   // 联机 P2 由远端成员控制（大厅开启 AI 时覆写）
    this.onlineMode = true;   // v2.24 联机标记：信息栏只显示本地操作者，虚拟按键保留
    // v2.18 3/4号AI座位：由房间座位状态决定，手动设置不自动出现
    if (aiSeats.length > 0) this.setAIPlayers(aiSeats);
    this.mapArray = this.tilemap.toArray();
  }

  // ── 差异钩子（沿无尽模式）──
  protected buildMap(): void {
    generateMap(
      this.tilemap,
      BIOMES[Math.floor(Math.random() * BIOMES.length)],
      Math.floor(Math.random() * 1e9),
      0.25,
    );
  }
  protected configureSpawn(): void {
    this.spawnSystem.continuous = true;
    this.spawnSystem.onWaveComplete = () => { this.wave++; };
  }
  /**
   * v3.0.4 渲染后补标操作者姓名（1~4 人局）。
   * 为什么放在这层：主机画面上只有坦克 + 编号，房间里的 3/4 号位真人和 AI 席位长得一样，
   * 而联机的一切操作（发快照、认升级面板、看复活进度）都按玩家索引走 —— 能让玩家对上的
   * 唯一线索就是名字，所以名字必须画在坦克上，而不是只活在大厅列表里。
   */
  protected renderPlayersExtra(renderer: Renderer): void {
    for (let pi = 0; pi < this.players.length; pi++) {
      const name = (this.seatNames[pi] ?? "").slice(0, 8);
      if (!name) continue;
      const p = this.players[pi];
      if (!p.isAlive) continue;
      renderer.drawText(name, Math.round(p.x), Math.round(p.y) - 20,
        { font: "10px monospace", color: pi === 0 ? "#9df" : "#cfc", align: "center" });
    }
  }

  protected handleExtraInput(_i1: unknown, _i2: unknown, _dt: number): void {
    // P1/P2 切炮已在 GameModeCore.updateBattle 统一边沿检测（含远端输入的 switchCannon 标志）
  }
  protected onBaseDestroyed(): void {
    this.isOver = true; this.gameOverReason = "base";
    getSoundManager().play("game_over");
  }
  /**
   * v3.0.4 淘汰判据（覆盖）：1~4 人联机局里只要有 AI 席位还活着，"全员阵亡"就永远不成立
   * —— `isTeamEliminated` 问的是"整支队伍"，单机语义正确，搬到联机里等于"永远输不了"，
   * 玩家感知就是"我死光了但游戏不结束"。这里只判**真人席位**（humanSeats，由 main 开局写入）：
   * 他们全部既不在场也没有命可复活 → 本局结束；AI 席位不替玩家续命。
   */
  protected onTeamEliminated(): void {
    if (!isAllHumanPlayersDead(this.players, this.humanSeats)) return;
    this.isOver = true; this.gameOverReason = "team";
    getSoundManager().play("game_over");
  }
  protected onEnemyKilledBonus(e: Enemy, timeAlive: number): void {
    this.spawnSystem.addKillBonus(timeAlive, e);
  }

  // ── 逻辑 ──
  update(dt: number): void {
    if (this.isOver) { this.notifyGameOver(); return; }
    this.updateLevelUpAutoPick(dt);

    // 升级选项广播：新面板出现时发给成员（成员可点选或按 15s 自动选兜底）
    if (this.pendingLevelUp && this.onSendLevelUp) {
      const key = `${this.pendingLevelUp.playerIdx}:${this.pendingLevelUp.choices.map(c => c.id).join(",")}`;
      if (key !== this.lastLvlKey) {
        this.lastLvlKey = key;
        this.onSendLevelUp({
          playerIdx: this.pendingLevelUp.playerIdx,
          choices: this.pendingLevelUp.choices.map(c => ({ name: c.name, desc: c.desc, category: c.category })),
        });
      }
    }

    // P2 输入新鲜度（供 HUD；-1 = 从未收到）
    this.peerInputLag = this.lastPeerInputTime > 0 ? Math.max(0, Date.now() - this.lastPeerInputTime) : -1;

    // ── 远端输入队列消费（固定 60Hz 步进，解耦网络抖动）──
    this.consumeRemoteInputQueue(dt);

    this.updateBattle(dt);

    this.snapshotTimer -= dt;
    if (this.snapshotTimer <= 0) {
      this.snapshotTimer = this.SNAPSHOT_INTERVAL;              // 30Hz
      const cur = this.buildSnapshot();
      // v2.8 增量编码（net-sync-core SyncCodec）：相对上一发送帧 diff（首帧/关键帧/大变化自动全量）
      const curState = netSnapshotToState(cur);
      const msg = this.snapCodec.encode(this.lastSentState ?? curState, curState);
      this.lastSentState = curState;
      if (this.onSendSnapshot) this.onSendSnapshot(msg as unknown as NetSnapshot);
      if (!this.mapSent) this.mapSent = true;                   // 首帧后标记地图已发送
      // v2.15 清空地图变化跟踪（已发送）
      this.tilemap.clearDirtyTiles();
    }

    // v2.12 检查点（每 2s）：快照未携带的武器/等级/背包状态 → 成员保存，房主断线后接替续局
    this.checkpointTimer -= dt;
    if (this.checkpointTimer <= 0) {
      this.checkpointTimer = this.CHECKPOINT_INTERVAL;
      if (this.onSendCheckpoint) this.onSendCheckpoint(this.serializeCheckpointWithAssetPack());
    }
  }

  /** 成员回传的升级选择：匹配当前面板并应用（无效/过期直接忽略） */
  onPeerLevelUpPick(playerIdx: number, choice: number): void {
    if (!this.pendingLevelUp || this.pendingLevelUp.playerIdx !== playerIdx) return;
    if (choice < 0 || choice >= this.pendingLevelUp.choices.length) return;
    this.chooseLevelUpAbility(choice);
  }

  // ── v2.12 主机检查点 + 接替续局（房主断线 → 成员凭本地快照+检查点恢复为本地主机）──
  /** 序列化检查点：快照未携带的武器/等级/背包/升级旗标 + 仓库（成员保存最新一份，接替时恢复 / 查看仓库背包） */
  serializeCheckpoint(): { players: CheckpointPlayer[]; warehouse: NetWarehouse } {
    const players = this.players.map((p, i) => {
      const ls = this.levelSystems[i];
      return {
        cannons: p.cannons.map((w, ci) => ({
          config: {
            id: w.config.id, name: w.config.name, slots: w.config.slots,
            castDelay: w.config.castDelay, rechargeTime: w.config.rechargeTime,
            shuffle: w.config.shuffle, singleShot: w.config.singleShot,
          },
          modules: w.modules.map((m) => (m ? { id: m.config.id, uses: m.usesLeft } : null)),
          active: ci === p.activeCannon,
        })),
        level: ls.level, exp: ls.exp, lives: p.lives,
        stats: { ...p.stats },
        wandDamageMults: [...p.wandDamageMults], critChance: p.critChance, critMultiplier: p.critMultiplier, projSpeedMult: p.projSpeedMult,
        extraMaxHp: p.extraMaxHp, flatArmor: p.flatArmor, pctDefense: p.pctDefense,
        hasInvincibleShield: p.hasInvincibleShield, hasModuleSteal: p.hasModuleSteal, hasFreeCast: p.hasFreeCast,
        moduleDropMult: p.moduleDropMult,
        wallLevel: p.wallLevel,
        inv: this.inventories[i].getAll().map((s) => {
          if (!s.item) return null;
          if ("config" in s.item) return { kind: "module" as const, id: s.item.config.id, uses: s.item.usesLeft };
          return { kind: "item" as const, id: s.item.id, uses: 1 };
        }),
      };
    });
    // v2.16 仓库数据：模块列表 + 强化材料
    const warehouse: NetWarehouse = {
      essence: this.warehouse.essence,
      items: this.warehouse.all.filter((m): m is NonNullable<typeof m> => !!m).map((m) => ({
        id: m.config.id, name: m.config.name, quality: m.config.quality, usesLeft: m.usesLeft,
      })),
    };
    return { players, warehouse };
  }

  /** v2.17 序列化检查点（含资源包）；v2.35 修复：每 8 个检查点（≈16s）重发一次完整包，覆盖后加入/断线重连的成员 */
  serializeCheckpointWithAssetPack(): { players: CheckpointPlayer[]; warehouse: NetWarehouse; assetPack?: import("../assets/AssetPack").AssetPack; assetPackVersion: string } {
    const cp = this.serializeCheckpoint();
    this.checkpointSerial++;
    // 首次必然发送；此后每 8 个检查点重发一次（新成员加入 / 成员重连后可拿到完整包）
    const needPack = !this.assetPackSent || this.checkpointSerial % 8 === 0;
    const pack = needPack ? assetPack.toJSON() : undefined;
    if (!this.assetPackSent) this.assetPackSent = true;
    return { ...cp, assetPack: pack, assetPackVersion: assetPack.getVersion() };
  }

  /**
   * 接替续局工厂：成员凭「本地最新快照 + 首帧地图 + 检查点」恢复为本地主机继续模拟。
   * 接替者（原 P2）成为新 P1（唯一战斗玩家）；敌人/基地/掉落/道具按快照重建（AI/瞬态重置）。
   */
  static createTakeover(
    canvas: HTMLCanvasElement, layout: GameLayout,
    snap: NetSnapshot, mapArray: number[][] | null, ck: CheckpointPlayer[] | null,
  ): OnlineHostMode {
    const h = new OnlineHostMode(canvas, layout, 1);
    h.restoreFromTakeover(snap, mapArray, ck);
    return h;
  }

  private restoreFromTakeover(
    snap: NetSnapshot, mapArray: number[][] | null, ck: CheckpointPlayer[] | null,
  ): void {
    // 1. 地图：用成员端缓存的首帧地图（新地图会改变基地墙/地形，接替必须沿用）
    if (mapArray && mapArray.length) {
      this.tilemap.loadFromArray(mapArray);
      this.mapArray = mapArray;
    }
    // 2. 分数/波次
    this.score = snap.scope?.score ?? 0;
    this.wave = snap.scope?.wave ?? 0;
    // 3. 基地（鹰标血量/墙等级/墙体耐久/独立小砖）
    if (snap.base) {
      const b = snap.base;
      this.base.eagleHp = b.eagleHp; this.base.eagleMaxHp = b.eagleMaxHp;
      this.base.wallLevel = b.wallLevel; this.base.isDestroyed = b.isDestroyed;
      // v2.16 恢复独立小砖状态（优先用 bricks，没有则用面级 walls 近似）
      if (b.bricks && b.bricks.length > 0) {
        for (const nb of b.bricks) {
          const brick = this.base.bricks.find((x) => x.side === nb.side && x.index === nb.index);
          if (brick) { brick.hp = nb.hp; brick.maxHp = nb.maxHp; }
        }
      } else {
        for (const w of b.walls) {
          const sideBricks = this.base.getBricksOnSide(w.side as "top"|"bottom"|"left"|"right");
          const perBrick = Math.ceil(w.hp / Math.max(1, sideBricks.length));
          for (const br of sideBricks) {
            br.hp = Math.min(br.maxHp, perBrick);
          }
        }
      }
    }
    this.syncBaseWallTiles();
    // 4. 玩家：接替者 = 旧 P2（playerId 1），成为新 P1（唯一战斗位）
    const selfNet = snap.players.find((p) => p.team === 0 && p.playerId === 1) ?? snap.players[0];
    const p = this.players[0];
    const c0 = ck && ck[0];
    // 恢复前先清掉"新坦克"默认的初始主炮，再按检查点完整重建 4 根炮筒
    if (c0 && Array.isArray(c0.cannons) && c0.cannons.length >= 1) {
      p.cannons = c0.cannons.map((c) => {
        const w = this.wandSystem.createWandState({
          id: c.config.id, name: c.config.name, slots: c.config.slots,
          castDelay: c.config.castDelay, rechargeTime: c.config.rechargeTime,
          shuffle: c.config.shuffle, singleShot: c.config.singleShot,
        });
        (c.modules ?? []).forEach((m, si) => {
          if (!m) return;
          if (this.wandSystem.equipModule(w, si, m.id) && typeof m.uses === "number") {
            const inst = w.modules[si];
            if (inst) inst.usesLeft = m.uses;
          }
        });
        return w;
      });
    }
    if (selfNet) {
      p.x = selfNet.x; p.y = selfNet.y; p.facing = selfNet.facing;
      p.isAlive = selfNet.alive; p.hidden = !!selfNet.hidden;
      p.extraMaxHp = c0?.extraMaxHp ?? 0;
      p.maxHp = Math.max(1, (selfNet.maxHp || p.maxHp) - p.extraMaxHp);
      p.hp = Math.min(selfNet.hp, p.effectiveMaxHp);
    }
    if (c0) {
      p.lives = c0.lives ?? p.lives;
      if (c0.stats) p.stats = { ...p.stats, ...c0.stats };
      p.wandDamageMults = c0.wandDamageMults ?? p.wandDamageMults;
      p.critChance = c0.critChance ?? p.critChance;
      p.critMultiplier = c0.critMultiplier ?? p.critMultiplier;
      p.projSpeedMult = c0.projSpeedMult ?? p.projSpeedMult;
      p.flatArmor = c0.flatArmor ?? p.flatArmor;
      p.pctDefense = c0.pctDefense ?? p.pctDefense;
      p.hasInvincibleShield = c0.hasInvincibleShield ?? p.hasInvincibleShield;
      p.hasModuleSteal = c0.hasModuleSteal ?? p.hasModuleSteal;
      p.hasFreeCast = c0.hasFreeCast ?? p.hasFreeCast;
      p.moduleDropMult = c0.moduleDropMult ?? p.moduleDropMult;
      p.wallLevel = c0.wallLevel ?? p.wallLevel;
      const ls = this.levelSystems[0];
      if (typeof c0.level === "number") ls.level = c0.level;
      if (typeof c0.exp === "number") p.stats.exp = c0.exp;  // v2.18 统一经验：写入 tank.stats.exp
      if (Array.isArray(c0.inv)) this.inventories[0].restoreFromNet(c0.inv);
    }
    // 经验钱包：快照 wallets[1]（接替者旧索引）比检查点更新（30Hz 快照）
    const wv = (snap.scope?.wallets ?? [])[1];
    if (typeof wv === "number") p.stats.exp = wv;
    // 5. 敌人：按快照重建（位置/血量/朝向沿用；AI 重新取目标）
    this.spawnSystem.activeEnemies = (snap.enemies ?? []).map((net) => {
      const grade = (net.gradeLabel ?? "F") as EnemyGrade;
      const e = new Enemy(grade, net.x, net.y, this.wandSystem, this.base.x, this.base.y);
      e.hp = Math.min(net.hp, net.maxHp || e.maxHp);
      e.maxHp = net.maxHp || e.maxHp;
      e.facing = net.facing;
      e.isAlive = net.alive;
      e.gradeLabel = net.gradeLabel;
      return e;
    });
    // 6. 在飞子弹：瞬态，接替瞬间清空（重新装填打出），避免无向量的"冻结子弹"
    this.wandSystem.getProjectiles().length = 0;
    // 7. 掉落/道具：按快照重建（lifetime 重置）
    this.lootSystem.drops = (snap.loot ?? []).map((d) => ({
      id: Date.now() % 1000000 + Math.floor(Math.random() * 1000),
      x: d.x, y: d.y, type: d.type as "module" | "item" | "exp",
      moduleId: d.moduleId, itemId: d.itemId, value: d.value,
      lifetime: this.lootSystem.DROP_LIFETIME, quality: d.quality as "white" | "blue" | "gold" | "none",
      ownerId: d.ownerId,
    }));
    this.powerUps.active = (snap.powerups ?? []).map((pu) => ({
      id: Date.now() % 1000000 + Math.floor(Math.random() * 1000),
      type: pu.type as PowerUpType, x: pu.x, y: pu.y, lifetime: 10, maxLifetime: 10,
    }));
    // 8. 标记已接替（e2e/调试断言用）
    (window as any).__takeoverHost = true;
    (window as any).__takeoverHostRef = this;
  }

  /** v2.9 成员回传的商店购买：主机扣该成员经验钱包并结算（结果经快照 wallets 回流给成员） */
  public memberShopBuy(playerIdx: number, choice: number): void {
    if (playerIdx < 0 || playerIdx >= this.players.length) return;
    this.buyFromShop(playerIdx, choice);
  }

  /**
   * v3.0.4 由**真人**操作的席位索引（玩家索引；房主固定含 0）。
   * 由 main 在开局时按 `start.players` 写入 —— 用于淘汰判据：只看真人席位，
   * AI 席位（3/4 号 AI、P2 由 AI 接管）不替玩家续命。
   */
  humanSeats: number[] = [0];

  /**
   * v3.0.4 每个席位的**操作者姓名**（索引 = 玩家索引；空串 = 无名字，如 AI 席位）。
   * 由 main 在开局时按 `start.players` 写入，渲染时标在坦克上方 ——
   * 以前只有 P1/P2 有"名字"概念，3/4 号位的真人在主机画面上就是「P3」「P4」，
   * 而"人头替"（房主断线接替）还会换人，只报编号根本认不出谁是谁。
   */
  seatNames: string[] = [];

  /** v2.15 简化：每帧直接应用队列中最新的远端输入，不再用固定步进（修复P2不能移动/被拉回的bug） */
  private consumeRemoteInputQueue(dt: number): void {
    // 丢弃已应用/乱序到达的旧帧
    while (this.remoteInputQueue.length > 0 && this.remoteInputQueue[0].frame <= this.remoteInputSeq) {
      this.remoteInputQueue.shift();
    }

    let p2Input: PlayerInput;
    if (this.remoteInputQueue.length > 0) {
      // 取队列中最新的一帧（按帧号排序后最后一个），确保输入最新
      const q = this.remoteInputQueue.pop()!;
      this.remoteInputSeq = q.frame;
      this.staleTicks = 0;
      p2Input = q.input;
      // 清空队列中剩余的旧帧（已经应用了最新的）
      this.remoteInputQueue.length = 0;
    } else if (this.lastAppliedInput && this.staleTicks < this.STALE_MAX_TICKS) {
      // 短时间无新输入（网络抖动/丢失）：沿用上一输入的 held 状态，边沿清零
      this.staleTicks++;
      const last = this.lastAppliedInput;
      p2Input = { ...last, w0: false, w1: false, w2: false, w3: false,
        interact: false, switchCannon: false, revive: false, warehouse: false, inventory: false };
    } else {
      // 长期无新输入（成员断线/暂停）：清空，防止坦克一直自动移动
      this.staleTicks = 0;
      this.lastAppliedInput = null;
      p2Input = EMPTY_INPUT();
    }

    this.lastAppliedInput = p2Input;
    this.input.setOverrideP2(p2Input);
  }

  private notifyGameOver(): void {
    if (this.gameOverNotified) return;
    this.gameOverNotified = true;
    if (this.onSendGameOver) {
      const reason = this.gameOverReason === "base" ? "基地被摧毁" : "全员阵亡";
      this.onSendGameOver({ reason, score: this.score });
    }
  }

  private buildSnapshot(): NetSnapshot {
    // 坐标取整到像素级（联网传输无需亚像素精度，JSON 编码体积减少 ~40%）
    const r = Math.round;
    const p: NetTank[] = this.players.map((t) => ({
      id: t.id, x: r(t.x), y: r(t.y), hp: t.hp, maxHp: t.effectiveMaxHp, alive: t.isAlive,
      playerId: t.playerId, team: t.team, facing: t.facing, activeCannon: t.activeCannon,
      gradeLabel: t.gradeLabel, hidden: t.hidden,
      lives: t.lives, respawnTimer: t.respawnTimer > 0 ? Math.ceil(t.respawnTimer) : 0,
      buffs: t.getBuffIcons(), stunned: t.isStunned, reviveProgress: t.reviveProgress,
    }));
    const e: NetTank[] = this.spawnSystem.activeEnemies.map((t) => ({
      id: t.id, x: r(t.x), y: r(t.y), hp: t.hp, maxHp: t.effectiveMaxHp, alive: t.isAlive,
      playerId: t.playerId, team: t.team, facing: t.facing, activeCannon: t.activeCannon,
      isBoss: t.isBoss, gradeLabel: t.gradeLabel, hidden: t.hidden,
      buffs: t.getBuffIcons(), stunned: t.isStunned,
    }));
    const proj: NetProjectile[] = this.wandSystem.getProjectiles()
      .filter((pr) => pr.isAlive)
      .map((pr) => ({ id: pr.id, x: r(pr.x), y: r(pr.y), radius: pr.radius, color: pr.color, type: pr.type, ownerTeam: pr.ownerTeam }));

    // ── removed 差集：本帧存活 ID 集合 vs 上一帧 → 消失的（子弹死亡/敌人被击杀移除/……）列表 ──
    const tankIds = new Set<number>();
    for (const t of p) tankIds.add(t.id);
    for (const t of e) tankIds.add(t.id);
    const projIds = new Set<number>();
    for (const pr of proj) projIds.add(pr.id);
    const removedTanks: number[] = [];
    const removedProjs: number[] = [];
    for (const id of this.prevTankIds) if (!tankIds.has(id)) removedTanks.push(id);
    for (const id of this.prevProjIds) if (!projIds.has(id)) removedProjs.push(id);
    this.prevTankIds = tankIds;
    this.prevProjIds = projIds;

    const loot: NetLootDrop[] = this.lootSystem.drops.map((d) => ({
      x: r(d.x), y: r(d.y), type: d.type, quality: d.quality, moduleId: d.moduleId, itemId: d.itemId, value: d.value, ownerId: d.ownerId,
    }));
    const powerups: NetPowerUp[] = this.powerUps.active.map((pu) => ({ x: r(pu.x), y: r(pu.y), type: pu.type }));

    this.snapshotFrame++;
    return {
      players: p,
      enemies: e,
      projectiles: proj,
      base: {
        x: r(this.base.x), y: r(this.base.y),
        eagleHp: this.base.eagleHp, eagleMaxHp: this.base.eagleMaxHp,
        isDestroyed: this.base.isDestroyed, wallLevel: this.base.wallLevel,
        walls: this.base.walls.map((w) => ({ side: w.side, hp: w.hp, maxHp: w.maxHp })),
        bricks: this.base.bricks.map((b) => ({
          side: b.side, index: b.index, hp: b.hp, maxHp: b.maxHp,
          x: b.x, y: b.y, w: b.w, h: b.h,
        })),
      },
      loot,
      powerups,
      // 地图只在首帧发送，后续帧省略（节省 ~2KB/帧 ≈ 40KB/s 带宽）
      map: this.mapSent ? undefined : this.mapArray,
      // v2.15 生物群系每帧都发送（只是一个字符串，带宽消耗很小），确保远端地图配色与主机一致
      biome: (this.tilemap as any).biome ?? "classic",
      // v2.15 地图增量变化：只发送自上一快照起变化的瓦片，远端据此更新本地地图（砖块打掉/临时墙放置等）
      mapChanges: this.tilemap.getDirtyTileChanges().length > 0 ? this.tilemap.getDirtyTileChanges() : undefined,
      // v2.17 活跃地形状态（火/毒/电等）+ 爆炸特效，供远端渲染
      tileStates: (() => {
        const states: Array<{ col: number; row: number; element: string; timer: number; intensity: number }> = [];
        this.tilemap.forEachState((key, st) => {
          states.push({
            col: key % this.tilemap.cols, row: Math.floor(key / this.tilemap.cols),
            element: st.element, timer: Math.round(st.timer * 10) / 10, intensity: st.intensity,
          });
        });
        return states.length > 0 ? states : undefined;
      })(),
      explosions: this.combatSystem.getActiveExplosions().length > 0
        ? this.combatSystem.getActiveExplosions().map((e) => ({ x: Math.round(e.x), y: Math.round(e.y), r: Math.round(e.r), maxR: Math.round(e.maxR), t: Math.round(e.t * 100) / 100, maxT: e.maxT }))
        : undefined,
      // v2.17 修复小人 + 伤害数字，供远端渲染对齐
      handyman: this.baseRepair.getHandymanSnapshot(),
      damageNumbers: this.combatSystem.getActiveDamageNumbers().length > 0
        ? this.combatSystem.getActiveDamageNumbers() : undefined,
      scope: { score: this.score, wave: this.wave, over: this.isOver,
        // v2.30 难度/隐藏分（成员端 HUD 与主机对齐显示）
        diff: Math.floor(this.spawnSystem.spawnScore), hidden: this.spawnSystem.hiddenScoreDisplay,
        // v2.9 玩家经验钱包（成员端据此显示/校验购买余额，全局对齐）
        wallets: this.players.map((p) => p.stats.exp),
        // v2.10 每玩家背包视图（传统道具计数+模块数）→ 成员端对齐查看
        bp: this.inventories.map((inv) => inv.toNet()) },
      removed: removedTanks.length > 0 || removedProjs.length > 0
        ? { tanks: removedTanks, projectiles: removedProjs } : undefined,
      frame: this.snapshotFrame,
      t: Date.now(),
    };
  }

  // ── 渲染（复用完整引擎渲染；主机画面即权威画面）──
  render(renderer: Renderer, now: number): void {
    renderer.clear("#111");
    this.renderWorld(renderer, now);

    const { ctx } = renderer;
    const W = this.viewW;
    const portrait = this.infoW === 0;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, W, 40);   // 顶栏 40px：第一行与单机无尽 HUD 完全对齐，第二行网络质量
    // ── 第一行：与 EndlessMode.renderHUD 相同结构（v2.30 修复"联机单人顶部缺 UI"）──
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

    // ── 第二行（网络质量 + 主机标识）：主 RTT + P2 输入延迟/抖动（按延迟着色）──
    const netY = portrait ? 29 : 21;
    renderer.drawText("联机·主机[P1本地]", 8, netY, { font: "11px monospace", color: "#6af" });
    const rttCol = this.netHud.rtt <= 0 ? "#666" : this.netHud.rtt < 100 ? "#4f4" : this.netHud.rtt < 220 ? "#fa0" : "#f55";
    renderer.drawText(`RTT ${Math.round(this.netHud.rtt)}ms·抖${Math.round(this.netHud.jitter)}`,
      150, netY, { font: "11px monospace", color: rttCol });
    const lagCol = this.peerInputLag < 0 ? "#888"
      : this.peerInputLag < 150 ? "#4f4" : this.peerInputLag < 300 ? "#fa0" : "#f55";
    const lagTxt = this.peerInputLag < 0 ? "P2入 --" : `P2入 ${this.peerInputLag}ms·抖${this.peerInputJitter}`;
    renderer.drawText(lagTxt, 300, netY, { font: "11px monospace", color: lagCol });

    this.infoPanel.render(renderer, now);
    this.infoPanel2?.render(renderer, now);
    this.renderBossBar(renderer);
    this.renderMinimap(renderer);
    this.renderCommonOverlays(renderer);
    this.mobile.render(renderer.ctx);

    if (this.isOver) this.renderGameOver(renderer);
  }

  private renderGameOver(renderer: Renderer): void {
    const W = this.viewW;
    const H = this.viewH;
    renderer.fillRect(0, 0, W, H, "rgba(0,0,0,0.85)");

    const msg = this.gameOverReason === "base" ? "基地被摧毁！" : "全员阵亡！";
    renderer.drawText("— 对局结束 —", W / 2, 30, { font: "26px monospace", color: "#f44", align: "center" });
    renderer.drawText(msg, W / 2, 60, { font: "18px monospace", color: "#ff8", align: "center" });
    renderer.drawText(`第 ${this.wave} 波  用时 ${this.elapsedText()}`, W / 2, 86,
      { font: "14px monospace", color: "#fff", align: "center" });

    // ── 所有玩家统计列 ──
    const PLAYER_COLORS = ["#4af", "#4c4", "#fa0", "#f4a"];
    const n = this.players.length;
    const colW = W / (n > 2 ? n : 2);
    const statY = 110;
    const statLabels = ["经验", "等级", "击杀", "伤害输出", "伤害承受"];
    for (let pi = 0; pi < n; pi++) {
      const p = this.players[pi];
      const s = p.stats;
      const ls = this.levelSystems[pi];
      const sx = colW * pi + colW / 2;
      const col = PLAYER_COLORS[pi] ?? "#ccc";
      const isAI = this.isAIPlayer(pi);
      const label = isAI ? `P${pi + 1}(AI)` : `P${pi + 1}`;
      renderer.drawText(label, sx, statY, { font: "13px monospace", color: col, align: "center" });
      const lives = p.lives ?? 0;
      renderer.drawText(`♥${lives}`, sx + 24, statY, { font: "11px monospace", color: lives > 0 ? "#f44" : "#666", align: "left" });
      const vals = [
        `${s.exp}`,
        `Lv.${ls.level} (${ls.exp}/${Math.max(1, ls.getExpToNextLevel())})`,
        `${s.kills}`, `${s.damageDealt}`, `${s.damageTaken}`,
      ];
      statLabels.forEach((label, i) => {
        renderer.drawText(`${label}: ${vals[i]}`, sx, statY + 20 + i * 15,
          { font: "10px monospace", color: i === 0 ? "#ff0" : col, align: "center" });
      });
      // 每人背包摘要
      const inv = this.inventories[pi];
      if (inv) {
        const net = inv.toNet();
        const bpItems = Object.entries(net).filter(([, c]) => c > 0).map(([k, c]) => `${k}×${c}`).join(" ");
        renderer.drawText(bpItems ? `背: ${bpItems}` : "背包: 空",
          sx, statY + 20 + statLabels.length * 15 + 4, { font: "9px monospace", color: "#8cf", align: "center" });
      }
    }

    // ── 总览 ──
    const totalKills = this.players.reduce((sum, p) => sum + p.stats.kills, 0);
    const totalDmg = this.players.reduce((sum, p) => sum + p.stats.damageDealt, 0);
    const summaryY = statY + 20 + statLabels.length * 15 + 24;
    renderer.drawText(`合计击杀 ${totalKills}  总伤害 ${totalDmg}`, W / 2, summaryY,
      { font: "12px monospace", color: "#ffd700", align: "center" });
    renderer.drawText(`（对本局收取的远端成员，请他们留意本方屏幕提示）`,
      W / 2, summaryY + 18, { font: "11px monospace", color: "#aaa", align: "center" });

    // 操作按钮由 main.ts drawLobbyButton 统一绘制（可点击），这里不重复画
    renderer.drawText("按 Enter 返回菜单", W / 2, H - 30, { font: "12px monospace", color: "#555", align: "center" });
  }

  /** 供 main绘制报一个国家尺寸（供信息栏布局参考） */
  worldSize(): { w: number; h: number } {
    return { w: this.mapCols * TILE_SIZE, h: this.mapRows * TILE_SIZE };
  }

  /** v2.14.2 AI队友开关：大厅"加AI队友"按钮调此。AI 接管 P2 输入（本地状态机，不走网络）。 */
  setAICompanion(enabled: boolean): void {
    this.p2Bot = enabled;
    if (enabled) {
      // P2 没远端输入时，drivePlayerBot 会自动接管；同时清理 remoteInputQueue 防脏数据
      this.remoteInputQueue.length = 0;
    }
  }

  /** v2.23 成员装配/卸载请求（拖动协议）：主机权威侧执行并回执（成员端背包面板→equip_req） */
  memberEquip(playerIdx: number, action: "equip" | "unequip", invIdx: number, wand: number, slot: number): void {
    const p = this.players[playerIdx];
    if (!p) return;
    const ec = this.equipCtrls[playerIdx];
    if (!ec) return;
    const ctx = this.equipCtx(playerIdx);
    const err = action === "unequip"
      ? ec.unequipDirect(wand, slot, ctx)
      : ec.equipDirect(invIdx, wand, slot, ctx);
    this.onEquipResult?.(playerIdx, err === null, err ?? "操作成功");
  }

  /** v2.23 成员加固基地请求：主机权威侧执行并回执（成员信息栏"加固"按钮→fortify_req） */
  memberFortify(playerIdx: number): void {
    const err = this.tryFortifyBaseShared();
    this.onFortifyResult?.(err === null, err ?? "基地已加固");
  }
}