//  GameModeCore.ts ─
//  v2.3 整体架构核心：无尽/闯关两模式共享编排
//  抽出两模式近千行重复逻辑，统一为单一事实来源：
//    - 系统构造（战斗/元素/无人机/碰撞/掉落/道具/基地/小人/刷怪）
//    - 战斗帧更新（玩家移动/开火/拾取、敌人AI、击杀结算、碰撞、元素、投射体、相机）
//    - 背包/仓库/精准装配/装备卸载/炮筒丢弃
//    - 复活/小人修复/掉落处理/信息栏点击
//    - 渲染（世界层/背包弹窗/仓库/BOSS血条/升级面板/出生预警/掉落炮筒/结算统计）
//  两模式仅保留差异：无尽（连续刷怪+波次计数+切炮键+随机主题）、闯关（阶段机+商店+按章节主题）。
//
//  设计要点：
//  1. 子类通过覆写钩子注入差异（buildMap / configureSpawn / handleExtraInput / onBaseDestroyed / ...）
//  2. 共享系统一律走本核心，修复无尽模式漏掉无人机 update/render 的对齐缺口
//  3. 所有共享状态字段集中声明，两模式不再各自维护
import { SpawnSystem } from "../systems/spawn/SpawnSystem";
import { LootSystem } from "../systems/loot/LootSystem";
import { LEVEL_UP as CFG_LEVEL_UP, PLAYER as CFG_PLAYER } from "./NumericConfig";
import {
  LevelUpSystem, levelUpLabelsFor, levelUpPanelGeo, levelUpPanelChoiceAt,
  type Ability,
} from "../systems/levelup/LevelUpSystem";
import { BaseRepairSystem } from "../systems/base/BaseRepairSystem";
import { BaseShop, shopItemOf, drawShopHint, drawSubmitHint } from "../systems/base/BaseShop";
import { CombatSystem } from "../systems/combat/CombatSystem";
import { ElementSystem } from "../systems/element/ElementSystem";
import { CollisionSystem } from "../systems/collision/CollisionSystem";
import { PowerUpSystem, POWERUP_INFO } from "../systems/powerup/PowerUpSystem";
import { WandSystem } from "../systems/wand/WandSystem";
import { DroneSystem } from "../systems/drone/DroneSystem";
import { getModule } from "../systems/wand/ModuleRegistry";
import { InventorySystem, getTradItemName } from "../systems/wand/InventorySystem";
import type { WandState } from "../systems/wand/WandTypes";
import type { GameLayout } from "../types/GameLayout";
import { Tank, TANK_CONFIGS } from "../game/Tank";
import { Enemy } from "../game/Enemy";
import { Base } from "../game/Base";
import { Tilemap, TileType, TILE_SIZE } from "../game/Tilemap";
import { InputManager } from "../engine/InputManager";
import { Camera } from "../engine/Camera";
import { MobileControls } from "../engine/MobileControls";
import { Minimap } from "../ui/Minimap";
import { SideInfoPanel, fortifyCost } from "../ui/SideInfoPanel";
import { loadSettings } from "../ui/SettingsMenu";
import type { Renderer } from "../engine/Renderer";
import { logicalCanvasSize } from "../engine/Renderer";
import type { LootDrop } from "../systems/loot/LootSystem";
import { useTraditionalItem } from "../systems/items/ItemUseSystem";
import { isTeamEliminated } from "../utils/GameOver";
import { getSoundManager } from "../engine/SoundManager";
import { Warehouse } from "../systems/warehouse/Warehouse";
import { EquipController, EQUIP_PANEL, UNEQUIP_COST, type EquipCtx } from "../input/EquipController";
import { renderBackpackPanel, renderWarehousePanel, handleWarehouseClick } from "../ui/BackpackPanel";

// 开发/验证开关：开局直接给该玩家弹 3 个互不相同的升级选项（playerIdx：0=玩家1号，1=玩家2号）。
// 用于验证 P1(T/Y/U) 与 P2(小键盘7/8/9) 的升级按键完全独立、互不干扰。
// 已确认无误，保持 -1 关闭（联机模式下开启会导致 P2 开局永久挂升级面板）。
const DEV_LEVELUP_TEST_PLAYER = -1;

export abstract class GameModeCore {
  // ── 共享系统 ──
  protected wandSystem: WandSystem;
  protected spawnSystem: SpawnSystem;
  protected lootSystem: LootSystem;
  protected combatSystem: CombatSystem;
  protected elementSystem: ElementSystem;
  protected collisionSystem: CollisionSystem;
  protected droneSystem: DroneSystem;
  protected baseRepair: BaseRepairSystem;
  protected input: InputManager;
  protected tilemap: Tilemap;
  protected base: Base;
  protected camera: Camera;
  protected mobile: MobileControls;
  protected minimap: Minimap;
  protected powerUps: PowerUpSystem;

  protected players: Tank[] = [];
  protected levelSystems: LevelUpSystem[];
  protected inventories: InventorySystem[] = [];
  protected infoPanel: SideInfoPanel;
  protected infoPanel2: SideInfoPanel | null = null;

  // ── 信息栏/画布几何 ──
  protected mapCols: number;
  protected mapRows: number;
  protected worldW: number;
  protected worldH: number;
  protected viewW: number;
  protected viewH: number;
  protected screenW: number;
  protected screenH: number;
  protected infoX = 0; protected infoY = 0; protected infoW = 0; protected infoH = 0;

  // ── 通用状态 ──
  score = 0;               // 队伍总分 = 双人得分之和
  isOver = false;
  protected startTime: number = 0;
  pendingLevelUp: { playerIdx: number; choices: Ability[]; autoTimer: number } | null = null;

  // 击杀追踪
  protected killedIds = new Set<number>();

  // 炮筒掉落（丢弃后地上可捡回）
  protected droppedCannons: Array<{id:number; x:number; y:number; cannon: WandState; timer:number}> = [];
  private _dropId = 0;

  // 点击/悬停
  protected mousePos = {x:0, y:0};
  protected pendingClick: {x:number;y:number} | null = null;
  /** v2.7 基地商店（单机/主机端）：60s 刷新、经验购买、基地交互面板 */
  protected shop = new BaseShop();
  /** 商店就近玩家索引（进基地半径内才能打开/购买，购买归属该玩家钱包） */
  private shopNearPlayer = -1;
  /** v2.14.2 商店面板所有者：谁按 E 打开的归谁，购买全走此人归属；-1=未锁定 */
  private shopOwner = -1;
  /** v2.14.1 商店改为手动打开：就近玩家的 interact 边沿（E/触屏修理键）切换开关 */
  private prevNearInteract = false;
  /** 提交模块按钮命中区（靠近基地时显示） */
  private _submitBtnRect: { rx: number; ry: number; rw: number; rh: number; playerIndex: number } | null = null;
  /** v2.9 商店库存广播钩子（联机主机把库存同步给成员；null=单机忽略） */
  onShopState: ((stock: Array<{ id: string; price: number; discount: number }>) => void) | null = null;
  private lastShopVersion = -1;

  // v2.6.3 画面控制（全屏/缩放）按钮命中区：与 main.ts 的 __tankView 桥接，网页端随时可全屏/调画面大小
  private viewBtns: Array<{ x:number; y:number; w:number; h:number; act: () => void }> = [];

  // 基地仓库 + 精准装配（三套操作：鼠标/触屏点击两段式 + 手柄焦点框）
  protected warehouse: Warehouse = new Warehouse();
  protected warehouseOpen = false;
  protected warehousePage = 0;
  protected warehouseMsg = "";
  protected warehouseMsgTimer = 0;
  protected equipCtrls: EquipController[] = [];
  protected backpackOwner: -1 | 0 | 1 | 2 | 3 = -1;
  protected prevInvHeld: [boolean, boolean] = [false, false];
  protected prevWhHeld = false;
  /** 切炮边沿检测（键盘 Tab/Shift + 触屏"炮筒"按钮统一走这里，一次按下只切一档） */
  protected prevSwitchP1 = false;
  protected prevSwitchP2 = false;

  /** 玩家数量（1=单人联机/离线、2=双人）。默认 2，OnlineHostMode 按入座人数覆写 */
  protected playerCount = 2;
  /** P2 自动 AI（离线双人：P2 无输入时由怪物式 AI 接管；联机主机强制关闭，远端成员不被夺权） */
  protected p2Bot = true;
  /** v2.18 多AI队友：哪些玩家索引由AI控制（联机房间手动设置3/4号座位为AI时填入） */
  protected aiPlayerIndices: number[] = [];
  /** v2.24 联机模式标记（OnlineHostMode 置 true）：联机时本地只有1个操作者，信息栏只显示本人 */
  protected onlineMode = false;
  /** v2.15 P2 真人输入空闲计时器：真人玩家有输入时重置为0；超过3秒无输入才允许AI接管，防止AI抢控制权 */
  private p2HumanIdleTimer = 0;
  /** v2.15 P2 AI接管锁定：真人玩家输入期间锁定为真人控制，AI完全不接管 */
  private p2HumanLocked = false;

  /** v2.24 是否本地键盘双人（离线、P2为真人、非联机）：只有这种模式保留双信息栏/双背包，且不用虚拟按键 */
  protected isLocalKeyboard2P(): boolean {
    return this.players.length > 1 && !this.isAIPlayer(1) && !this.onlineMode;
  }

  /** v2.24 本地键盘双人 = 不用虚拟按键（键盘直接玩）；其他情况（单机/AI队友/联机）虚拟按键+键盘双输入都保留 */
  protected updateMobileEnabled(): void {
    this.mobile.setEnabled(!this.isLocalKeyboard2P());
  }

  /** v2.18 设置AI队友索引（联机房间手动设置3/4号座位为AI时调用） */
  setAIPlayers(indices: number[]): void {
    this.aiPlayerIndices = indices.filter(i => i >= 0 && i < this.playerCount);
  }

  /** v2.18 判断指定玩家是否由AI控制 */
  protected isAIPlayer(idx: number): boolean {
    if (idx === 1 && this.p2Bot && !this.p2HumanLocked) return true;
    return this.aiPlayerIndices.includes(idx);
  }

  constructor(canvas: HTMLCanvasElement, layout?: GameLayout, playerCount = 2) {
    this.playerCount = Math.max(1, Math.min(4, playerCount));
    // 从持久化设置读取 P2 自动 AI 开关（联机子类随后覆写为 false）
    this.p2Bot = loadSettings().p2Bot;
    this.equipCtrls = Array.from({ length: this.playerCount }, () => new EquipController());
    this.mapCols = layout?.mapCols ?? 25;
    this.mapRows = layout?.mapRows ?? 20;
    this.worldW = this.mapCols * TILE_SIZE;
    this.worldH = this.mapRows * TILE_SIZE;
    this.viewW = this.worldW;   // 世界视口 = 地图尺寸（场地固定左上角，不滚动）
    this.viewH = this.worldH;

    // 整块画布 = 场地 + 信息栏；场地(世界)固定左上角，信息栏不遮挡场地
    this.screenW = layout?.canvasW ?? this.viewW;
    this.screenH = layout?.canvasH ?? this.viewH;
    if (layout) {
      this.infoW = layout.infoW;
      this.infoH = layout.infoH;
      this.infoX = layout.infoW > 0 ? this.worldW : 0;
      this.infoY = layout.infoH > 0 ? this.worldH : 0;
      if (layout.infoW === 0) this.infoW = this.worldW;
      if (layout.infoH === 0) this.infoH = this.worldH;
    }

    this.wandSystem = new WandSystem();
    this.wandSystem.mapW = this.worldW;
    this.wandSystem.mapH = this.worldH;

    this.tilemap = new Tilemap(this.mapCols, this.mapRows);

    // 基地（底中）
    const bx = Math.floor(this.mapCols / 2) * TILE_SIZE;
    const by = (this.mapRows - 4) * TILE_SIZE;
    this.base = new Base(bx, by);
    this.baseRepair = new BaseRepairSystem(this.base);
    this.baseRepair.enableHandyman();   // 两模式统一启用修墙小人（闯关此前遗漏）

    // 地形生成钩子：无尽=随机主题；闯关=每关按章节主题（在 loadStage 中）
    this.buildMap();
    this.syncBaseWallTiles();

    this.camera = new Camera(this.viewW, this.viewH, this.worldW, this.worldH);
    this.minimap = new Minimap(this.viewW, this.viewH, this.worldW, this.worldH);
    this.powerUps = new PowerUpSystem();
    this.powerUps.mapW = this.worldW;
    this.powerUps.mapH = this.worldH;
    this.lootSystem = new LootSystem();
    this.lootSystem.mapW = this.worldW;
    this.lootSystem.mapH = this.worldH;
    this.combatSystem = new CombatSystem();
    this.combatSystem.onShake = (i, d) => this.camera.addShake(i, d);
    // v2.3 元素系统：燃烧/冻结/感电/毒雾/油渍 与地形交互
    this.elementSystem = new ElementSystem();
    this.combatSystem.elementSystem = this.elementSystem;
    // 触发系统：击中/销毁/弹跳/击杀触发生成的载荷投射体，转发给炮筒系统
    // v2.19: 触发模块按触发次数消耗（每次触发消耗1次，不再在开火时消耗）
    this.combatSystem.onTriggerFire = (x, y, angle, payload, ownerId, ownerTeam, sourceWandId) => {
      this.wandSystem.spawnTriggerPayload(x, y, angle, payload, ownerId, ownerTeam);
      // 消耗触发模块的次数：按 ownerId 找坦克，按 sourceWandId 找炮筒，按 triggerSourceSlot 找模块
      if (payload.triggerSourceSlot !== undefined && sourceWandId) {
        const tank = this.players.find(t => t.id === ownerId);
        if (tank) {
          const wand = tank.cannons.find(c => c.config.id === sourceWandId);
          if (wand) {
            const mod = wand.modules[payload.triggerSourceSlot];
            if (mod && mod.usesLeft > 0) {
              mod.usesLeft--;
              if (mod.usesLeft === 0) wand.modules[payload.triggerSourceSlot] = null;
            }
          }
        }
      }
    };
    // 无人机系统：投放部署 + 敌弹可击毁无人机（蜂群支援单位）
    this.droneSystem = new DroneSystem(this.wandSystem);
    this.combatSystem.onDroneDeploy = (x, y, variant, count, ownerId, ownerTeam) => {
      this.droneSystem.spawnDrone(ownerId, ownerTeam, x, y, variant, count);
    };
    this.combatSystem.onDroneHit = (x, y, r, byTeam) => this.droneSystem.hitAt(x, y, r, byTeam);
    this.droneSystem.onHit = (x, y, dmg) => this.combatSystem.spawnDamageNumber(x, y, dmg, false);
    this.droneSystem.onExplosion = (x, y, r) => this.combatSystem.spawnExplosionAt(x, y, r);
    this.droneSystem.onShake = (i, d) => this.camera.addShake(i, d);
    this.collisionSystem = new CollisionSystem();
    this.input = InputManager.getInstance();
    this.mobile = new MobileControls(canvas);
    // 触屏轻触：转发为点击（升级选项/信息栏/仓库/背包图标等），与鼠标 click 走同一套逻辑
    this.mobile.onTap = (x, y) => { this.pendingClick = { x, y }; };

    // 玩家（P1 轻型 / P2 工兵 / P3 突击 / P4 重型；单人联机只建 P1）
    const p1 = new Tank(1, 0, 0, TANK_CONFIGS["tank_light"],    this.wandSystem, bx - 80, by - 80);
    this.players = [p1];
    if (this.playerCount >= 2) {
      const p2 = new Tank(2, 1, 0, TANK_CONFIGS["tank_engineer"], this.wandSystem, bx + 80, by - 80);
      this.players.push(p2);
    }
    if (this.playerCount >= 3) {
      const p3 = new Tank(3, 2, 0, TANK_CONFIGS["tank_light"], this.wandSystem, bx - 40, by - 120);
      this.players.push(p3);
    }
    if (this.playerCount >= 4) {
      const p4 = new Tank(4, 3, 0, TANK_CONFIGS["tank_engineer"], this.wandSystem, bx + 40, by - 120);
      this.players.push(p4);
    }
    this.players.forEach(p => {
      p.facing = "up";
      p.lives = CFG_PLAYER.INITIAL_LIVES;   // v2.20：每位玩家初始3条命
    });

    // 道具注入
    this.powerUps.players = this.players;
    this.powerUps.base = this.base;
    this.powerUps.getEnemies = () => this.spawnSystem.activeEnemies;
    this.powerUps.onPickup = (tank, type) => {
      const info = POWERUP_INFO[type];
      this.combatSystem.spawnFloatText(tank.x, tank.y - 22, `${info.name}!`, info.color);
    };

    // 升级/背包
    this.levelSystems = [];
    this.inventories  = [];
    for (let i = 0; i < this.playerCount; i++) {
      const ls = new LevelUpSystem();
      const inv = new InventorySystem(8);
      ls.setBaseContext(this.base, this.baseRepair);
      ls.setInventory(inv);
      ls.setTank(this.players[i]);   // v2.6.3 升级按"当前炮筒"优先给该武器增强（权重×2）
      // v2.18 经验满自动升级 → 弹出三选一属性面板（与 requestLevelUp 共用 pendingLevelUp）
      const playerIdx = i;
      ls.onLevelUp = (choices) => {
        if (!this.pendingLevelUp) {
          this.pendingLevelUp = { playerIdx, choices, autoTimer: 30 };
          getSoundManager().play("levelup");
        }
      };
      this.levelSystems.push(ls);
      this.inventories.push(inv);
    }

    // 持久信息栏：场地之外显示背包/炮筒模块次数/基地状态
    // v2.21 竖屏已去掉小地图（infoY>0=底部信息栏），信息栏内容无需再给小地图让位（topSkipY=0 恢复横条内容）；
    // 横屏小地图在右侧信息栏顶 y=42，topSkipY = 小地图底部 + 间距 - 信息栏自身PAD=6。
    const mm = this.minimap.size;
    const topSkipY = this.infoY > 0 ? 0 : (42 + mm.h + 4 - 6);
    // v2.24 仅本地键盘双人显示双信息栏（P1左/P2右）；
    // v2.25 改为两块都在右侧信息栏上下堆叠（原先 P1 在左侧会遮挡地图左侧，导致玩家/敌军被面板盖住）
    // 单机(AI队友)/联机 = 非本地双人 → 只显示本地操作者(P1)一人份
    const local2P = this.isLocalKeyboard2P();
    if (local2P && this.infoW > 0) {
      // 本地双人：右侧竖栏上下两半 —— P1 上半 / P2 下半，各自全宽
      const half = Math.floor(this.infoH / 2);
      this.infoPanel = new SideInfoPanel(
        this.infoX, this.infoY, this.infoW, half,
        this.players, this.inventories, this.base, this.baseRepair,
        this.levelSystems, Math.max(0, topSkipY), 0, false,
      );
      this.infoPanel2 = new SideInfoPanel(
        this.infoX, this.infoY + half, this.infoW, this.infoH - half,
        this.players, this.inventories, this.base, this.baseRepair,
        this.levelSystems, 0, 1, false,
      );
    } else {
      this.infoPanel = new SideInfoPanel(
        this.infoX, this.infoY, this.infoW, this.infoH,
        this.players, this.inventories, this.base, this.baseRepair,
        this.levelSystems, Math.max(0, topSkipY), 0, false,
      );
      this.infoPanel2 = null;
    }
    // v2.24 虚拟按键可用性：本地键盘双人关闭，其余（单机/AI/联机）保留
    this.updateMobileEnabled();

    // 出生点（顶部 5 列）
    const topY = TILE_SIZE * 2;
    const spawnCols = [
      Math.floor(this.mapCols * 0.1), Math.floor(this.mapCols * 0.25),
      Math.floor(this.mapCols * 0.5), Math.floor(this.mapCols * 0.75),
      Math.floor(this.mapCols * 0.9),
    ];
    this.spawnSystem = new SpawnSystem(this.wandSystem);
    this.spawnSystem.setBase(bx, by);
    this.spawnSystem.setMapSize(this.worldW, this.worldH);
    this.spawnSystem.setSpawnPoints(spawnCols.map(c => ({ x: c * TILE_SIZE, y: topY })));
    // 出生空位校验：出生/召唤前确保目标格无墙可通行，避免怪物生成在墙里卡死
    //（tankTeam=-1 → 所有队伍墙都视作阻挡，出生以最严格口径校验）
    this.spawnSystem.isSpawnClear = (x, y, hw, hh) =>
      !this.tilemap.checkTankCollision(Math.floor(x - hw), Math.floor(y - hh), hw * 2, hh * 2, -1);
    // 刷怪差异钩子：无尽=连续刷怪+波次计数；闯关=波次完成进阶段机
    this.configureSpawn();

    // v2.25 DPR 高清：鼠标/触摸换算必须用逻辑尺寸（canvas.width 已是物理像素）
    canvas.addEventListener('mousemove', (ev) => {
      const r = canvas.getBoundingClientRect();
      const lc = logicalCanvasSize(canvas);
      this.mousePos = {x:(ev.clientX-r.left)*(lc.w/r.width), y:(ev.clientY-r.top)*(lc.h/r.height)};
    });
    canvas.addEventListener('click', (ev) => {
      const r = canvas.getBoundingClientRect();
      const lc = logicalCanvasSize(canvas);
      this.pendingClick = {
        x: (ev.clientX-r.left)*(lc.w/r.width),
        y: (ev.clientY-r.top)*(lc.h/r.height),
      };
    });

    this.startTime = Date.now();
  }

  // ── 子类差异钩子 ──
  /** 地图生成：无尽=随机主题；闯关=在 loadStage 中按章节生成（默认空实现） */
  protected buildMap(): void { /* override */ }
  /** 刷怪配置：无尽=continuous；闯关=onWaveComplete→阶段机 */
  protected configureSpawn(): void { /* override */ }
  /** 额外按键（无尽=Tab/ShiftRight 切炮） */
  protected handleExtraInput(_i1: unknown, _i2: unknown, _dt: number): void { /* override */ }
  /** 基地被摧毁 / 全员阵亡 */
  protected onBaseDestroyed(): void { this.isOver = true; getSoundManager().play("game_over"); }
  protected onTeamEliminated(): void { this.isOver = true; getSoundManager().play("game_over"); }
  /** 击杀奖励钩子（无尽=addKillBonus 连续波次推进） */
  protected onEnemyKilledBonus(_e: Enemy, _timeAlive: number): void { /* override */ }

  // ── 基地墙砖同步（坦克可穿过己方基地墙，子弹仍阻挡） ──
  // v2.16 按独立小砖判定：一个 32×32 瓦片内只要有任意一块存活小砖，就阻挡坦克；
  // 全部碎完才变为可通行。子弹碰撞由 CombatSystem 逐块检测，不走 tilemap。
  protected syncBaseWallTiles(): void {
    const T = TILE_SIZE;
    const bcol = Math.floor(this.base.x / T);
    const brow = Math.floor(this.base.y / T);
    const wallTiles: { cols: number[]; rows: number[] }[] = [
      { cols: [bcol-1, bcol],   rows: [brow-2]       },  // top
      { cols: [bcol-1, bcol],   rows: [brow+1]       },  // bottom
      { cols: [bcol-2],          rows: [brow-1, brow] },  // left
      { cols: [bcol+1],          rows: [brow-1, brow] },  // right
    ];
    for (const wt of wallTiles) {
      for (const c of wt.cols) for (const r of wt.rows) {
        const tileX = c * T, tileY = r * T;
        const hasBrick = this.base.getAliveBricksInRect(tileX, tileY, T, T).length > 0;
        // v2.9 基地墙恢复"阻挡玩家"：坦克/敌人均不可踩墙、不可穿墙进基地（原本设计）
        const t = hasBrick ? TileType.Water : TileType.Empty;
        this.tilemap.set(c, r, t);
      }
    }
  }

  // ── 共享战斗帧更新（无尽/闯关共用，含输入/玩家/敌人/击杀/碰撞/元素/投射体/相机） ──
  protected updateBattle(dt: number): void {
    if (this.base.isDestroyed) { this.onBaseDestroyed(); return; }
    if (isTeamEliminated(this.players)) { this.onTeamEliminated(); return; }

    // v2.24 每帧同步虚拟按键可用性（P2 真人锁变 AI 等状态切换时保持一致）
    this.updateMobileEnabled();

    const i1 = this.input.getP1();
    const i2 = this.input.getP2();

    // 玩家移动/开火
    this.players[0].moveX = (i1.right?1:0)-(i1.left?1:0);
    this.players[0].moveY = (i1.down?1:0)-(i1.up?1:0);
    this.players[0].isFiring = i1.fire;
    if (this.players.length >= 2) {
      this.players[1].moveX = (i2.right?1:0)-(i2.left?1:0);
      this.players[1].moveY = (i2.down?1:0)-(i2.up?1:0);
      this.players[1].isFiring = i2.fire;
    }

    // 切炮（键盘 Tab/Shift + 触屏"炮筒"按钮统一边沿检测：一次按下切一档，覆盖联机远端合并输入）
    const s1 = i1.switchCannon;
    if (s1 && !this.prevSwitchP1) this.players[0].cycleCannon();
    this.prevSwitchP1 = s1;
    // 手机端直接选择炮筒 (0-3)
    if (i1.selectCannon >= 0 && i1.selectCannon <= 3) this.players[0].setActiveCannon(i1.selectCannon);
    // 同步手机端炮筒高亮
    MobileControls.activeCannon = this.players[0].activeCannon;
    if (this.players.length >= 2) {
      const s2 = i2.switchCannon;
      if (s2 && !this.prevSwitchP2) this.players[1].cycleCannon();
      this.prevSwitchP2 = s2;
      if (i2.selectCannon >= 0 && i2.selectCannon <= 3) this.players[1].setActiveCannon(i2.selectCannon);
    }

    this.handleExtraInput(i1, i2, dt);

    // 道具使用（常驻右侧信息栏；G/Num0 用第一个道具）
    if (this.input.wasJustPressed("KeyG")) this.useFirstItem(0);
    if (this.input.wasJustPressed("Numpad0") && this.playerCount >= 2) this.useFirstItem(1);

    // 精准装配背包弹窗（P1 I / P2 Num5；手柄 Back 键）：点击两段式 + 手柄焦点框
    for (let pi = 0; pi < this.playerCount; pi++) this.equipCtrls[pi].update(dt);
    if (this.input.wasJustPressed("KeyI")) this.toggleBackpack(0);
    if (this.input.wasJustPressed("Numpad5") && this.playerCount >= 2) this.toggleBackpack(1);
    for (let pi = 0; pi < this.playerCount; pi++) {
      const held = (pi === 0 ? i1 : i2).inventory;
      if (held && !this.prevInvHeld[pi]) this.toggleBackpack(pi);
      this.prevInvHeld[pi] = held;
    }
    if (this.backpackOwner >= 0) this.pollEquipGamepad(dt);

    // 基地仓库 (P1 B / P2 Num6) + 触屏"仓库"按钮
    if (this.input.wasJustPressed("KeyB") || this.input.wasJustPressed("Numpad6")) {
      this.warehouseOpen = !this.warehouseOpen;
    }
    if (i1.warehouse && !this.prevWhHeld) {
      this.warehouseOpen = !this.warehouseOpen;
      this.backpackOwner = -1;
    }
    this.prevWhHeld = i1.warehouse;
    if (this.warehouseMsgTimer > 0) this.warehouseMsgTimer -= dt;

    // 点击处理（画面控制按钮 / 升级面板 / 背包弹窗优先）
    if (this.pendingClick) {
      if (this.tryViewButtonClick()) {
        // 画面控制按钮（全屏/缩放），已处理
      } else if (this.tryLevelUpClick()) {
        // 点击到升级选项，已处理
      } else if (this.backpackOwner >= 0) this.handleBackpackClickShared();
      else {
        if (this.warehouseOpen) this.handleWarehouseClickShared();
        this.handleInfoClick();
      }
    }

    // 炮筒丢弃（X / Delete）→ 掉地上可捡回
    if (this.input.wasJustPressed("KeyX"))    this.discardCannon(0);
    if (this.input.wasJustPressed("Delete") && this.players.length >= 2) this.discardCannon(1);

    // v2.14.2 扔背包模块让队友捡（Q 键：有背包面板打开 + 选中模块 → 掉地上公开掉落）
    if (this.input.wasJustPressed("KeyQ") && this.backpackOwner >= 0) {
      const ec = this.equipCtrls[this.backpackOwner];
      if (ec.selectedInv !== null) this.discardBackpackModule(this.backpackOwner, ec.selectedInv);
    }

    // 消耗一条命复活队友（F / CtrlRight）
    if (this.players.length >= 2) {
      if (this.input.wasJustPressed("KeyF") && !this.players[0].isAlive && this.players[1].lives >= 2) {
        this.players[1].lives--;
        this.players[0].respawn(this.base.x - 80, this.base.y - 80, true);
      }
      if (this.input.wasJustPressed("ControlRight") && !this.players[1].isAlive && this.players[0].lives >= 2) {
        this.players[0].lives--;
        this.players[1].respawn(this.base.x + 80, this.base.y - 80, true);
      }
    }

    // 接近复活（E 键复活小人 / 靠近尸体复活）
    this.updateRevive(dt);

    // 基地自动修复（靠近即修，无需按键）
    for (const p of this.players) {
      if (p.isAlive) this.baseRepair.playerRepair(p, dt);
    }

    // 复活小人：按 E (P1) / / (P2)，消耗一个徽章
    if (i1.interact || i2.interact) {
      for (const p of this.players) {
        if (!p.isAlive) continue;
        if (this.baseRepair.tryReviveNearBase(p.x, p.y)) {
          this.combatSystem.spawnFloatText(p.x, p.y, "小人复活了!", "#4f4");
          getSoundManager().play("levelup");
          break;
        }
      }
    }

    const allTanks: Tank[] = [...this.players, ...this.spawnSystem.activeEnemies];

    // ── 自动 AI 控制（v2.18 支持多AI队友：P2单机AI + 3/4号联机AI座位）──
    // P2：真人有输入时锁定为真人，3秒无输入才允许AI接管；3/4号AI座位：直接AI控制
    const botFiringMap = new Map<number, boolean>();

    // P2 单机AI（带真人输入检测）
    if (this.p2Bot && this.players.length >= 2 && this.players[1].isAlive) {
      const hasHumanInput = !!(i2.up || i2.down || i2.left || i2.right || i2.fire ||
        i2.w0 || i2.w1 || i2.w2 || i2.w3 || i2.interact || i2.switchCannon);

      if (hasHumanInput) {
        this.p2HumanIdleTimer = 0;
        this.p2HumanLocked = true;
      } else {
        this.p2HumanIdleTimer += dt;
        if (this.p2HumanIdleTimer > 3) this.p2HumanLocked = false;
      }

      if (!this.p2HumanLocked) {
        const bot = this.drivePlayerBot(this.players[1], allTanks, 1);
        this.players[1].moveX = bot.mx;
        this.players[1].moveY = bot.my;
        this.players[1].isFiring = bot.firing;
        botFiringMap.set(1, bot.firing);
      }
    }

    // 3/4号 AI 座位（联机房间手动设置，直接AI控制）
    for (const aiIdx of this.aiPlayerIndices) {
      if (aiIdx === 1) continue;  // P2 已在上面处理
      if (aiIdx >= this.players.length) continue;
      const p = this.players[aiIdx];
      if (!p.isAlive) continue;
      const bot = this.drivePlayerBot(p, allTanks, aiIdx);
      p.moveX = bot.mx;
      p.moveY = bot.my;
      p.isFiring = bot.firing;
      botFiringMap.set(aiIdx, bot.firing);
    }

    // 玩家更新 + 发射炮筒 + 拾取掉落
    for (const p of this.players) {
      if (!p.isAlive) {
        if (p.respawnTimer > 0) p.respawnTimer -= dt;
        continue;
      }
      p.update(dt, this.tilemap, allTanks);
      const pIdx = this.players.findIndex(q => q === p);
      const pInp = pIdx === 0 ? i1 : i2;
      // 触屏"开火"按钮只带 fire 标志：未指定具体炮筒时，打在当前激活的炮筒上（修复手机/远端无法攻击）
      const wFire = [pInp.w0, pInp.w1, pInp.w2, pInp.w3];
      const aiFiring = botFiringMap.get(pIdx) ?? false;
      if (!wFire.some(Boolean) && (pInp.fire || (aiFiring && p.isFiring))) {
        wFire[p.activeCannon] = true;
      }
      if (wFire[0]) p.fireWand(dt, 0);
      if (wFire[1]) p.fireWand(dt, 1);
      if (wFire[2]) p.fireWand(dt, 2);
      if (wFire[3]) p.fireWand(dt, 3);
      const drops = this.lootSystem.pickup(p.x, p.y, 60, pIdx);
      this.processDrops(drops, pIdx);

      // v2.18 AI队友：武器耗尽的模块自动存入基地仓库（不占槽位）
      if (this.isAIPlayer(pIdx)) {
        for (const cannon of p.cannons) {
          for (let si = 0; si < cannon.modules.length; si++) {
            const mod = cannon.modules[si];
            if (mod && mod.usesLeft === 0) {
              this.warehouse.store({ config: mod.config, usesLeft: 0 });
              cannon.modules[si] = null;
              this.combatSystem.spawnFloatText(p.x, p.y - 20, `AI:${mod.config.name}耗尽→存库`, "#aaa");
            }
          }
        }
      }
    }

    // 炮筒掉落拾取（走过去替换当前炮）
    for (let pi = 0; pi < this.players.length; pi++) {
      const p = this.players[pi];
      if (!p.isAlive) continue;
      for (let di = this.droppedCannons.length - 1; di >= 0; di--) {
        const dc = this.droppedCannons[di];
        const dx = p.x - dc.x; const dy = p.y - dc.y;
        if (dx*dx + dy*dy < 30*30) {
          p.cannons[p.activeCannon] = dc.cannon;
          this.droppedCannons.splice(di, 1);
          break;
        }
      }
    }
    // 掉落炮筒倒计时
    for (let di = this.droppedCannons.length - 1; di >= 0; di--) {
      this.droppedCannons[di].timer -= dt;
      if (this.droppedCannons[di].timer <= 0) this.droppedCannons.splice(di, 1);
    }

    // 复活：v2.21 单玩家（P2 为 AI / 无队友）死亡后 3 秒倒计时自动复活，无需按开火、更不用等救援；
    // 双真人协作仍保留"按开火自复活 / 队友靠近救援"（不打断救援节奏）。
    const soloHuman = this.players.length < 2 || this.isAIPlayer(1);
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.isAlive && p.respawnTimer <= 0 && p.lives > 0) {
        const inp = i === 0 ? i1 : i2;
        if (soloHuman || inp.fire) {
          const ox = i === 0 ? -80 : 80;
          p.respawn(this.base.x + ox, this.base.y - 80);
        }
      }
    }

    // 敌人 AI
    for (const e of this.spawnSystem.activeEnemies) {
      if (!e.isAlive) continue;
      e.updateAI(dt, this.tilemap, allTanks);
      e.fireCast(dt);
    }

    // 击杀结算（必须在 spawnSystem.update 移除尸体前）
    this.processEnemyKills();

    // 玩家数量缩放：按存活玩家数调节刷怪速率（1人=1.0 / 2人=1.5 / 3人=2.0 / 4人=2.5）
    const alivePlayers = Math.max(1, this.players.filter(p => p.isAlive).length);
    this.spawnSystem.playerCountScale = 1 + (Math.min(alivePlayers, 4) - 1) * 0.5;

    this.spawnSystem.update(dt);
    this.lootSystem.update(dt);   // v2.7：掉落物不再追踪玩家，只走生命周期
    this.powerUps.update(dt, this.players.filter(p => p.isAlive).map(p => ({x:p.x, y:p.y})));
    this.baseRepair.update(dt, this.spawnSystem.activeEnemies, this.players);
    this.droneSystem.update(dt, this.spawnSystem.activeEnemies, this.players);
    // 重建砖块碰撞延迟：如果玩家仍在砖上则继续延长延迟
    const playerBoxes = this.players.filter(p => p.isAlive).map(p => ({
      x: p.x - p.config.width / 2, y: p.y - p.config.height / 2,
      w: p.config.width, h: p.config.height,
    }));
    this.base.updateBrickDelay(dt, playerBoxes);
    this.syncBaseWallTiles();

    // 集中碰撞
    this.collisionSystem.resolveTankTank(allTanks, this.tilemap);
    this.collisionSystem.resolveBulletBullet(this.wandSystem.getProjectiles());
    this.combatSystem.resolveProjectiles(
      this.wandSystem.getProjectiles(), allTanks, this.base, this.tilemap, dt);

    // v2.3 地形状态推进 + 元素对实体结算（燃烧/毒雾/电流/冰面）
    this.tilemap.updateTileStates(dt);
    // v2.15 临时墙更新：检查是否超时（30秒），超时则自动消失
    this.tilemap.updateTempWalls(performance.now());
    // v2.24 墙体成形推进：放置后先免碰撞，等内部清空 + 2秒后才成形
    const wallBoxes = allTanks.map(t => ({
      x: t.x - t.config.width / 2, y: t.y - t.config.height / 2,
      w: t.config.width, h: t.config.height,
    }));
    this.tilemap.updateWallArming(dt, wallBoxes);
    // v2.24 成形墙体：把仍卡在里面的玩家往外推（最小位移方向弹出）
    for (const p of this.players) {
      if (!p.isAlive) continue;
      const hw = p.config.width / 2, hh = p.config.height / 2;
      const rects = this.tilemap.getSolidTeamWallRects(p.x - hw, p.y - hh, p.config.width, p.config.height);
      for (const r of rects) {
        const pushL = (p.x + hw) - r.x;
        const pushR = (r.x + r.w) - (p.x - hw);
        const pushT = (p.y + hh) - r.y;
        const pushB = (r.y + r.h) - (p.y - hh);
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const minX = Math.min(pushL, pushR), minY = Math.min(pushT, pushB);
        if (minX <= minY) p.x += p.x < cx ? -(pushL + 0.5) : (pushR + 0.5);
        else              p.y += p.y < cy ? -(pushT + 0.5) : (pushB + 0.5);
      }
    }
    // v2.24 基地砖块成形：把被卡在里面的玩家往外推（远离基地中心，防卡死）
    for (const p of this.players) {
      if (!p.isAlive) continue;
      const hw = p.config.width / 2, hh = p.config.height / 2;
      for (const b of this.base.bricks) {
        if (b.hp <= 0) continue;
        if (p.x - hw < b.x + b.w && p.x + hw > b.x && p.y - hh < b.y + b.h && p.y + hh > b.y) {
          const dx = p.x - this.base.x, dy = p.y - this.base.y;
          if (Math.abs(dx) >= Math.abs(dy)) p.x += Math.sign(dx || 1) * 2;
          else                              p.y += Math.sign(dy || 1) * 2;
        }
      }
    }
    this.elementSystem.update(dt, allTanks, this.tilemap);

    // 投射体（追踪/主逻辑）
    this.wandSystem.updateProjectiles(dt, (proj) => {
      let best: {x:number;y:number}|null = null; let bestD = Infinity;
      for (const e of this.spawnSystem.activeEnemies) {
        if (!e.isAlive || e.team === proj.ownerTeam) continue;
        const d = (e.x-proj.x)**2+(e.y-proj.y)**2;
        if (d < bestD) { bestD=d; best={x:e.x,y:e.y}; }
      }
      return best;
    }, new Map(this.players.filter(p=>p.isAlive).map(p => [p.id, {x:p.x, y:p.y}])));

    this.combatSystem.updateFX(dt);

    // 相机跟随存活玩家平均
    const alive = this.players.filter(p => p.isAlive);
    if (alive.length > 0) {
      const avgX = alive.reduce((s,p)=>s+p.x,0)/alive.length;
      const avgY = alive.reduce((s,p)=>s+p.y,0)/alive.length;
      this.camera.follow(avgX, avgY);
    }
    this.camera.update(dt);

    // ── v2.7 基地商店：玩家进基地半径 → 面板打开；60s 刷新；键盘 1-5 快捷购买 ──
    this.shop.update(dt);
    // v2.18 升级服务动态价 = 当前等级升级所需经验（与自动升级扣费一致）
    const so2 = this.shopOwner >= 0 ? this.shopOwner : this.shopNearPlayer;
    const lvlSys = this.levelSystems[so2 >= 0 ? so2 : 0];
    this.shop.levelupCost = lvlSys ? lvlSys.getExpToNextLevel() : 25;
    const so = this.shopOwner >= 0 ? this.shopOwner : this.shopNearPlayer;
    this.shop.levelupEnabled = so >= 0 && this.players[so]?.isAlive && !this.pendingLevelUp;
    // v2.9 库存版本变化 → 广播给成员（开局立即、刷新后）
    if (this.onShopState && this.shop.version !== this.lastShopVersion) {
      this.lastShopVersion = this.shop.version;
      this.onShopState(this.shop.stockNow().map((s) => ({ id: s.id, price: s.id === "levelup" ? this.shop.levelupCost : s.price, discount: s.discount })));
    }
    let near = -1, bestD = 95 * 95;
    this.players.forEach((p, i) => {
      if (!p.isAlive) return;
      const dx = p.x - this.base.x, dy = p.y - this.base.y;
      const dd = dx * dx + dy * dy;
      if (dd < bestD) { bestD = dd; near = i; }
    });
    this.shopNearPlayer = near;
    if (near >= 0) {
      this.shop.anchorX = this.base.x; this.shop.anchorY = this.base.y - 20;
      // v2.14.1 改为手动打开：就近玩家按 E（或触屏"修理"交互键）切换开关，不再靠近自动弹出
      const nInp = near === 0 ? i1 : i2;
      if (nInp.interact && !this.prevNearInteract) {
        if (!this.shop.open) {
          // 打开 → 锁 owner
          this.shop.open = true;
          this.shopOwner = near;
          getSoundManager().play("levelup");
        } else if (this.shopOwner === near) {
          // owner 自己再按 → 关闭
          this.shop.open = false;
          this.shopOwner = -1;
        } else {
          // 非 owner 按 → 切换 owner（让另一位玩家也能用）
          this.shopOwner = near;
          getSoundManager().play("pickup");
        }
      }
      this.prevNearInteract = nInp.interact;
    } else {
      this.prevNearInteract = false;
      this.shop.open = false;   // 离开基地半径自动关闭
      this.shopOwner = -1;
    }
    // 快捷键提交模块：靠近基地时按 G 自动提交背包中的模块到仓库
    if (near >= 0 && this.input.wasJustPressed("KeyG")) {
      this.autoSubmitModules(near);
    }
    if (this.shop.open && near >= 0) {
      for (let k = 0; k < this.shop.stockNow().length; k++) {
        const buyer = this.shopOwner >= 0 ? this.shopOwner : near;
         if (this.input.wasJustPressed(`Digit${k + 1}`)) { this.buyFromShop(buyer, k); break; }
      }
    }

    this.pendingClick = null;
  }

  // ── 自动 AI（v2.18 智能状态机：撤退/避弹/守家/拾取/战斗）──
  // 优先级：HP低撤退 > 子弹威胁避弹 > 基地受攻击回防 > 附近物品拾取 > 正常战斗风筝
  // playerIdx: 该AI在 players 数组中的索引（用于专属掉落判断等）
  private drivePlayerBot(p: Tank, allTanks: Tank[], playerIdx = 1): { mx: number; my: number; firing: boolean } {
    const hw = p.config.width / 2, hh = p.config.height / 2;
    const clear = (tx: number, ty: number) =>
      !this.tilemap.checkTankCollision(tx - hw, ty - hh, p.config.width, p.config.height, p.team);
    const STEP = 3;

    // ── 工具：朝目标点移动，撞墙自动尝试垂直绕路 ──
    const moveToward = (tx: number, ty: number): { mx: number; my: number } => {
      const dx = tx - p.x, dy = ty - p.y;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      let mx = 0, my = 0;
      // 主轴优先
      if (ax >= ay) {
        mx = dx > 0 ? 1 : -1;
        if (!clear(p.x + mx * STEP, p.y)) {
          mx = 0;  // 主轴撞墙 → 尝试垂直
          my = dy > 0 ? 1 : (dy < 0 ? -1 : (Math.random() > 0.5 ? 1 : -1));
          if (!clear(p.x, p.y + my * STEP)) my = 0;
        }
      } else {
        my = dy > 0 ? 1 : -1;
        if (!clear(p.x, p.y + my * STEP)) {
          my = 0;  // 主轴撞墙 → 尝试水平
          mx = dx > 0 ? 1 : (dx < 0 ? -1 : (Math.random() > 0.5 ? 1 : -1));
          if (!clear(p.x + mx * STEP, p.y)) mx = 0;
        }
      }
      // 更新朝向
      if (mx !== 0) p.facing = mx > 0 ? "right" : "left";
      else if (my !== 0) p.facing = my > 0 ? "down" : "up";
      return { mx, my };
    };

    // ── 扫描附近威胁子弹 ──
    let nearestProj: { x: number; y: number; vx: number; vy: number; d: number } | null = null;
    let projThreat = 0;
    for (const pr of this.wandSystem.getProjectiles()) {
      if (!pr.isAlive || pr.ownerTeam === p.team) continue;
      const dx = pr.x - p.x, dy = pr.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 180 * 180) {
        projThreat++;
        const d = Math.sqrt(d2);
        if (!nearestProj || d < nearestProj.d) nearestProj = { x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, d };
      }
    }

    // ── 挑最近活敌人 ──
    let best: Tank | null = null; let bd = Infinity;
    for (const e of allTanks) {
      if (!e.isAlive || e.team === p.team) continue;
      const d2 = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
      if (d2 < bd) { bd = d2; best = e; }
    }

    // ── 基地附近敌人（守家优先级）──
    let baseThreat: Tank | null = null; let baseThreatD = Infinity;
    const BASE_GUARD_RADIUS = 160;
    for (const e of allTanks) {
      if (!e.isAlive || e.team === p.team) continue;
      const d2 = (e.x - this.base.x) ** 2 + (e.y - this.base.y) ** 2;
      if (d2 < BASE_GUARD_RADIUS * BASE_GUARD_RADIUS && d2 < baseThreatD) {
        baseThreatD = d2; baseThreat = e;
      }
    }

    // ── 附近物品（6格 ≈ 96px 内主动拾取）──
    let nearestLoot: { x: number; y: number } | null = null; let lootD = Infinity;
    const LOOT_PICKUP_RADIUS = 96;
    for (const d of this.lootSystem.drops) {
      const d2 = (d.x - p.x) ** 2 + (d.y - p.y) ** 2;
      if (d2 < LOOT_PICKUP_RADIUS * LOOT_PICKUP_RADIUS && d2 < lootD) {
        // 只捡公开掉落或自己的专属掉落
        if (d.ownerId === undefined || d.ownerId === playerIdx) {
          lootD = d2; nearestLoot = { x: d.x, y: d.y };
        }
      }
    }

    const hpRatio = p.hp / Math.max(1, p.effectiveMaxHp);
    let mx = 0, my = 0;
    let firing = false;

    // ── 状态1：HP 低于 30% → 撤退跑基地（同时躲避子弹）──
    if (hpRatio < 0.30) {
      const m = moveToward(this.base.x, this.base.y);
      mx = m.mx; my = m.my;
      // 撤退中也反击
      if (best && bd < 300 * 300) {
        const dx = best.x - p.x, dy = best.y - p.y;
        const sameCol = Math.abs(dx) <= hw + 14 && Math.abs(dy) < 400;
        const sameRow = Math.abs(dy) <= hh + 14 && Math.abs(dx) < 400;
        firing = sameCol || sameRow;
        if (firing) p.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      }
      return { mx, my, firing };
    }

    // ── 状态2：子弹密集（≥3发）或有子弹正对自己 → 侧向躲避 ──
    if (projThreat >= 2 && nearestProj) {
      // 计算子弹是否朝自己飞来
      const toMeX = p.x - nearestProj.x, toMeY = p.y - nearestProj.y;
      const dot = nearestProj.vx * toMeX + nearestProj.vy * toMeY;
      const incoming = dot > 0;  // 子弹朝自己方向
      if (incoming || projThreat >= 4) {
        // 侧向躲避：垂直于子弹方向移动
        const len = Math.sqrt(nearestProj.vx ** 2 + nearestProj.vy ** 2) || 1;
        const perpX = -nearestProj.vy / len, perpY = nearestProj.vx / len;
        // 选择离基地更近的一侧躲避
        const toBaseX = this.base.x - p.x, toBaseY = this.base.y - p.y;
        const side = (perpX * toBaseX + perpY * toBaseY) > 0 ? 1 : -1;
        const dodgeX = perpX * side, dodgeY = perpY * side;
        if (Math.abs(dodgeX) >= Math.abs(dodgeY)) {
          mx = dodgeX > 0 ? 1 : -1;
          if (!clear(p.x + mx * STEP, p.y)) { mx = 0; my = dodgeY > 0 ? 1 : -1; if (!clear(p.x, p.y + my * STEP)) my = 0; }
          else p.facing = mx > 0 ? "right" : "left";
        } else {
          my = dodgeY > 0 ? 1 : -1;
          if (!clear(p.x, p.y + my * STEP)) { my = 0; mx = dodgeX > 0 ? 1 : -1; if (!clear(p.x + mx * STEP, p.y)) mx = 0; }
          else p.facing = my > 0 ? "down" : "up";
        }
        // 躲避中反击
        if (best && bd < 320 * 320) {
          const dx = best.x - p.x, dy = best.y - p.y;
          firing = (Math.abs(dx) <= hw + 14 && Math.abs(dy) < 400) || (Math.abs(dy) <= hh + 14 && Math.abs(dx) < 400);
          if (firing) p.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        }
        return { mx, my, firing };
      }
    }

    // ── 状态3：基地受攻击 → 回防优先 ──
    if (baseThreat) {
      const m = moveToward(baseThreat.x, baseThreat.y);
      mx = m.mx; my = m.my;
      // 对准基地附近的敌人开火
      const dx = baseThreat.x - p.x, dy = baseThreat.y - p.y;
      const dist = Math.sqrt(baseThreatD);
      firing = dist < 380 && ((Math.abs(dx) <= hw + 14 && Math.abs(dy) < 400) || (Math.abs(dy) <= hh + 14 && Math.abs(dx) < 400));
      if (firing) p.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      return { mx, my, firing };
    }

    // ── 状态4：附近有物品 → 主动拾取（战斗不紧急时）──
    if (nearestLoot && (!best || bd > 200 * 200)) {
      const m = moveToward(nearestLoot.x, nearestLoot.y);
      mx = m.mx; my = m.my;
      // 拾取途中也警戒
      if (best && bd < 300 * 300) {
        const dx = best.x - p.x, dy = best.y - p.y;
        firing = (Math.abs(dx) <= hw + 14 && Math.abs(dy) < 400) || (Math.abs(dy) <= hh + 14 && Math.abs(dx) < 400);
        if (firing) p.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      }
      return { mx, my, firing };
    }

    // ── 状态5：正常战斗（保持射程环绕风筝）──
    if (!best) return { mx: 0, my: 0, firing: false };

    const dx = best.x - p.x, dy = best.y - p.y;
    const dist = Math.sqrt(bd);
    const DESIRED = 200;
    const tooClose = dist < DESIRED * 0.55;
    const tooFar   = dist > DESIRED * 1.35;
    const ax = Math.abs(dx), ay = Math.abs(dy);

    if (tooClose) {
      // 后撤（背对敌人）
      const m = moveToward(p.x - dx, p.y - dy);
      mx = m.mx; my = m.my;
    } else if (tooFar) {
      // 前压（朝向敌人）
      const m = moveToward(best.x, best.y);
      mx = m.mx; my = m.my;
    } else {
      // 环绕：垂直方向平移
      if (ax >= ay) {
        my = (dx > 0 ? 1 : -1);
        if (!clear(p.x, p.y + my * STEP)) { my = 0; mx = (dy > 0 ? 1 : -1); if (!clear(p.x + mx * STEP, p.y)) mx = 0; }
        else p.facing = dx > 0 ? "right" : "left";
      } else {
        mx = (dy > 0 ? 1 : -1);
        if (!clear(p.x + mx * STEP, p.y)) { mx = 0; my = (dx > 0 ? 1 : -1); if (!clear(p.x, p.y + my * STEP)) my = 0; }
        else p.facing = dy > 0 ? "down" : "up";
      }
    }

    // 对准开火
    const sameCol = ax <= hw + 14 && Math.abs(dy) < 420;
    const sameRow = ay <= hh + 14 && Math.abs(dx) < 420;
    firing = bd < 380 * 380 && (sameCol || sameRow);
    if (firing) p.facing = ax >= ay ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    return { mx, my, firing };
  }

  // ── 升级自动选择（无尽/闯关各自 update 顶部调用，游戏不暂停） ──
  /** v2.14.2：基地商店手动触发三选一。price 为经验消耗（调用方已验证余额）。
   *  生成 choices → 设 pendingLevelUp → 玩家在面板里选/按 TYU 确认。 */
  requestLevelUp(playerIdx: number, costExp: number): boolean {
    const p = this.players[playerIdx];
    if (!p || !p.isAlive) return false;
    if (this.pendingLevelUp) return false;  // 已有升级面板开着
    if (p.stats.exp < costExp) return false;
    p.stats.exp -= costExp;
    const choices = this.levelSystems[playerIdx].generateAndConsumeChoices();
    this.pendingLevelUp = { playerIdx, choices, autoTimer: 30 };  // 30s 超时自动抽
    return true;
  }

  protected updateLevelUpAutoPick(dt: number): void {
    // 开发/验证用：开局给指定玩家直接弹出三个互不相同的升级选项，
    // 用来验证 P1(T/Y/U) 与 P2(小键盘7/8/9) 的升级按键完全独立、互不干扰。
    // 设 -1 关闭（正常游玩）；设 0/1 分别测试玩家1号/玩家2号。
    this.maybeStageLevelUpTest();
    if (!this.pendingLevelUp) return;
    this.pendingLevelUp.autoTimer -= dt;
    if (this.pendingLevelUp.autoTimer <= 0) {
      this.chooseLevelUpAbility(Math.floor(Math.random() * this.pendingLevelUp.choices.length));
    }
  }

  // 一键测试场景：开局仅给选中的玩家注入 3 个不同的升级选项（autoTimer=999 关闭自动选）
  private devLevelUpTestDone = false;
  protected maybeStageLevelUpTest(): void {
    if (!this.devLevelUpTestDone) this.devLevelUpTestDone = true; // 标记不论是否执行，避免重复
    else return;
    if (DEV_LEVELUP_TEST_PLAYER < 0) return;
    if (!this.players[DEV_LEVELUP_TEST_PLAYER]) return;
    this.pendingLevelUp = {
      playerIdx: DEV_LEVELUP_TEST_PLAYER,
      choices: this.levelSystems[DEV_LEVELUP_TEST_PLAYER].generateChoices(),
      autoTimer: 999,   // 关闭自动选，避免它干扰独立按键验证
    };
  }

  /** 击杀结算：爆炸特效/掉落/经验经验归属（命中者全额、存活队友一半） */
  private processEnemyKills(): void {
    for (const e of this.spawnSystem.activeEnemies) {
      if (!e.isAlive && !this.killedIds.has(e.id)) {
        this.killedIds.add(e.id);
        const timeAlive = Date.now()/1000 - e.spawnedAt;
        this.onEnemyKilledBonus(e, timeAlive);
        // 死亡爆炸特效（BOSS 更大）
        this.combatSystem.spawnExplosionAt(e.x, e.y, e.isBoss ? 72 : 26);
        // 先算 killerIdx（玩家索引）再决定 ownerId（undefined=公开掉落）
        const killerIdx = this.players.findIndex(p => p.id === e.lastHitById && p.isAlive);
        const killerId = killerIdx >= 0 ? killerIdx : undefined;
        // v2.25 sp_loot：击杀者的模块掉落率倍率（默认1；「模块掉落+50%」可叠加）
        const dropMult = killerIdx >= 0 ? (this.players[killerIdx].moduleDropMult ?? 1) : 1;
        this.lootSystem.onEnemyKilled(e, killerId, dropMult);
        this.powerUps.onEnemyKilled(e);
        // 仅玩家击杀（team 0）计分，敌人友军误伤不计
        if (e.lastHitByTeam === 0) {
          getSoundManager().play("enemy_die");
          const expAmt = e.enemyCfg.expReward;
          const goldRef = e.enemyCfg.goldReward;
          // 击杀归属（博弈）：命中者拿全额得分/经验，存活队友拿一半经验（协作助攻）
          if (killerIdx >= 0) {
            const killer = this.players[killerIdx];
            killer.stats.score += expAmt;
            killer.stats.kills++;
            killer.stats.goldCollected += goldRef;
            this.score += expAmt;   // 队伍总分（=双人得分之和）
            this.levelSystems[killerIdx].addExp(expAmt);
            // 协作激励：存活队友获得一半经验（单人局只自己）
            for (let pi = 0; pi < this.players.length; pi++) {
              if (pi !== killerIdx && this.players[pi].isAlive) {
                this.levelSystems[pi].addExp(Math.ceil(expAmt / 2));
              }
            }
          } else {
            // 归属不明（道具/特殊击杀）：存活玩家平分
            this.score += expAmt;
            for (let pi = 0; pi < this.players.length; pi++) {
              if (this.players[pi].isAlive) {
                this.players[pi].stats.score += Math.ceil(expAmt / 2);
                this.players[pi].stats.kills++;
                this.players[pi].stats.goldCollected += goldRef;
                this.levelSystems[pi].addExp(Math.ceil(expAmt / 2));
              }
            }
          }
        }
      }
    }
  }

  // ── 炮筒丢弃 ──
  protected discardCannon(pi: number): void {
    const p = this.players[pi];
    const cannon = p.cannons[p.activeCannon];
    this.droppedCannons.push({id:this._dropId++, x:p.x, y:p.y+30, cannon, timer:30});
    // 替换为一把全新空炮筒
    const newCannon = this.wandSystem.createWandState({
      id:`cannon_${p.id}_${p.activeCannon}_${Date.now()}`,
      name:`炮筒${p.activeCannon+1}`,
      slots:p.config.cannonSlots,
      castDelay:p.config.castDelay,
      rechargeTime:1.0,
      shuffle:false,
    });
    p.cannons[p.activeCannon] = newCannon;
  }

  /** v2.14.2 扔背包模块：背包选中格 → 从 inventory 取下 → LootSystem 公开掉落（队友也能捡） */
  protected discardBackpackModule(pi: number, slotIdx: number): void {
    const inv = this.inventories[pi];
    const tank = this.players[pi];
    const entry = inv.getAll()[slotIdx]?.item;
    if (!entry) return;
    if (!("config" in entry)) return;  // 只扔模块，传统道具不走这里
    const cfg = entry.config;
    inv.removeAt(slotIdx);
    // 掉地上：公开掉落（ownerId=undefined），队友可以捡
    this.lootSystem.drops.push({
      id: Date.now() % 1000000 + Math.floor(Math.random() * 1000),
      x: tank.x + (Math.random() - 0.5) * 24,
      y: tank.y - 18,
      type: "module", moduleId: cfg.id,
      lifetime: this.lootSystem.DROP_LIFETIME,
      quality: cfg.quality as "white" | "blue" | "gold" | "none",
      ownerId: undefined,   // 公开，双方都能捡
    });
    this.combatSystem.spawnFloatText(tank.x, tank.y - 22, `已丢弃 ${cfg.name}（可让队友捡）`, "#f8c");
    getSoundManager().play("pickup");
    // 清空选中
    this.equipCtrls[pi].selectedInv = null;
  }

  /** v2.23 基地加固共享逻辑（信息栏点击 / 成员协议请求共用）：成功返回 null，失败返回原因 */
  protected tryFortifyBaseShared(): string | null {
    const cost = fortifyCost(this.base.wallLevel);
    if (cost <= 0) return "墙已满级";
    const totalGold = this.players.reduce((s, t) => s + t.stats.exp, 0);
    if (totalGold < cost) return "经验不足";
    // 加固是公共品博弈：双人各付一半（不足由另一人补齐）；单人自付
    if (this.players.length >= 2) {
      const half = Math.ceil(cost / 2);
      const p0Pay = Math.min(this.players[0].stats.exp, half);
      const p1Pay = cost - p0Pay;
      this.players[0].stats.exp -= p0Pay;
      this.players[1].stats.exp -= p1Pay;
    } else {
      this.players[0].stats.exp -= cost;
    }
    this.base.upgradeWalls();
    getSoundManager().play("levelup");
    this.combatSystem.spawnFloatText(this.base.x, this.base.y, "基地墙升级!", "#ffd700");
    return null;
  }

  /** 信息栏点击：基地加固 / 背包模块装入当前炮筒 / 炮筒槽卸下回包 */
  protected handleInfoClick(): void {
    if (!this.pendingClick) return;
    const { x, y } = this.pendingClick;
    // v2.7 基地商店点选优先于信息栏（面板打开时）
    if (this.shop.open && this.shopNearPlayer >= 0) {
      const bi = this.shop.tapAt(x, y);
      const clickBuyer = this.shopOwner >= 0 ? this.shopOwner : this.shopNearPlayer; if (bi >= 0) { this.buyFromShop(clickBuyer, bi); this.pendingClick = null; return; }
      if (this.shop.tapClose(x, y)) { this.shop.open = false; this.pendingClick = null; return; }  // v2.14.1 点面板外关闭
    }
    // v2.14.1 点击基地本体：开/关商店（触屏"点击基地"与鼠标一致；基地坐标需经相机转屏幕）
    if (this.shopNearPlayer >= 0) {
      const bp = this.camera.worldToScreen(this.base.x, this.base.y);
      const dx = x - bp.x, dy = y - bp.y;
      if (dx * dx + dy * dy <= 52 * 52) {
        this.shop.open = !this.shop.open;
        this.pendingClick = null;
        return;
      }
    }
    // 提交模块按钮点击：自动合成（3白→1蓝，3蓝+1材料→1金）
    if (this._submitBtnRect && this.shopNearPlayer >= 0) {
      const sb = this._submitBtnRect;
      if (x >= sb.rx && x < sb.rx + sb.rw && y >= sb.ry && y < sb.ry + sb.rh) {
        this.autoSubmitModules(sb.playerIndex);
        this.pendingClick = null;
        return;
      }
    }
    let info = this.infoPanel.handleClick(x, y);
    if (!info && this.infoPanel2) info = this.infoPanel2.handleClick(x, y);
    if (!info) return;
    const p = this.players[info.pi];
    const inv = this.inventories[info.pi];
    if (info.kind === "fortify") {
      const err = this.tryFortifyBaseShared();
      if (err) {
        this.combatSystem.spawnFloatText(p.x, p.y, err, "#f66");
        getSoundManager().play("deny");
      }
    } else if (info.kind === "equip") {
      // 背包格点击：传统道具=直接使用；模块→当前炮筒第一个空槽（先取出再清槽，避免 removeAt 把引用置空导致模块丢失）
      const slot = inv.getAll()[info.index];
      const item = slot?.item;
      if (item && "kind" in item && item.kind === "traditional") {
        this.useItemAt(info.pi, info.index);
      } else if (item && "config" in item) {
        const cannon = p.cannons[p.activeCannon];
        const freeIdx = cannon.modules.findIndex(m => !m);
        if (freeIdx < 0) {
          this.combatSystem.spawnFloatText(p.x, p.y, "该炮筒已满", "#f66");
          getSoundManager().play("deny");
        } else {
          inv.removeAt(info.index);
          cannon.modules[freeIdx] = item;
          getSoundManager().play("pickup");
        }
      }
    } else if (info.kind === "remove") {
      // 当前炮筒槽 → 背包：消耗经验卸载（保留剩余次数，不是重置成全新模块）
      const cannon = p.cannons[p.activeCannon];
      const mod = cannon.modules[info.index];
      if (mod) {
        if (p.stats.exp < UNEQUIP_COST) {
          this.combatSystem.spawnFloatText(p.x, p.y, `卸装需${UNEQUIP_COST}经验`, "#f66");
          getSoundManager().play("deny");
        } else if (inv.freeSlots <= 0) {
          this.combatSystem.spawnFloatText(p.x, p.y, "背包已满", "#f66");
        } else {
          p.stats.exp -= UNEQUIP_COST;
          inv.addModuleInstance(mod);
          cannon.modules[info.index] = null;
          getSoundManager().play("pickup");
          this.combatSystem.spawnFloatText(p.x, p.y, `已卸下 -${UNEQUIP_COST}经验`, "#7f7");
        }
      }
    } else if (info.kind === "warehouse") {
      // 共用仓库：两位玩家都能点图标打开/关闭（触屏同样可用）
      this.warehouseOpen = !this.warehouseOpen;
      this.backpackOwner = -1;
    } else if (info.kind === "backpack") {
      // 各自背包：点图标打开对应玩家的精准装配弹窗
      this.toggleBackpack(info.pi);
    } else if (info.kind === "cannonTab") {
      // v2.24 点击炮筒页签切换（手机端无需键盘 Tab）
      p.setActiveCannon(info.index);
      getSoundManager().play("pickup");
    }
  }

  protected handleWarehouseClickShared(): void {
    if (!this.pendingClick) return;
    const { x, y } = this.pendingClick;
    const inv = this.inventories[0];
    const panelX = Math.max(10, (this.viewW - 500) / 2);
    const panelY = 40;
    handleWarehouseClick(x, y, {
      ctx: undefined as any,
      panelX, panelY, warehouse: this.warehouse, inv,
      page: this.warehousePage,
      onSetPage: (p) => { this.warehousePage = p; },
      onWithdraw: (idx) => {
        if (this.warehouse.withdrawToInventory(idx, inv)) {
          this.warehouseMsg = "已存回背包";
          this.warehouseMsgTimer = 1.5;
          getSoundManager().play("pickup");
        }
      },
      onSynthesize: (target) => {
        const made = this.warehouse.synthesize(target);
        if (made) {
          this.warehouse.store(made);
          this.warehouseMsg = target === "blue" ? "合成蓝色模块!" : "合成金色模块!";
          this.warehouseMsgTimer = 2;
          getSoundManager().play("levelup");
          this.combatSystem.spawnFloatText(this.base.x, this.base.y, this.warehouseMsg, "#ffd700");
        } else {
          this.warehouseMsg = "合成条件不足";
          this.warehouseMsgTimer = 1.5;
        }
      },
      onMessage: (msg) => { this.warehouseMsg = msg; this.warehouseMsgTimer = 1.5; },
    });
  }

  /** 提交模块按钮：自动将背包中的模块提交到仓库，然后自动合成 */
  private autoSubmitModules(pi: number): void {
    const inv = this.inventories[pi];
    if (!inv) return;
    const slots = inv.getAll();
    let submitted = 0;
    for (let i = slots.length - 1; i >= 0; i--) {
      const item = slots[i]?.item;
      if (!item) continue;
      if ('config' in item) {
        // 模块：提交到仓库
        this.warehouse.store(item);
        inv.removeAt(i);
        submitted++;
      }
    }
    if (submitted === 0) {
      this.combatSystem.spawnFloatText(this.base.x, this.base.y, "背包无可提交模块", "#aaa");
      return;
    }
    // 自动合成
    let made = 0;
    while (this.warehouse.countByQuality("white") >= 3) {
      const m = this.warehouse.synthesize("blue");
      if (m) { this.warehouse.store(m); made++; }
      else break;
    }
    while (this.warehouse.countByQuality("blue") >= 3 && this.warehouse.essence >= 1) {
      const m = this.warehouse.synthesize("gold");
      if (m) { this.warehouse.store(m); made++; }
      else break;
    }
    this.combatSystem.spawnFloatText(this.base.x, this.base.y,
      `提交${submitted}个模块${made > 0 ? `，合成${made}个` : ""}`, "#ffd700");
    this.warehouseMsg = `已提交${submitted}个模块${made > 0 ? `，合成${made}个` : ""}`;
    this.warehouseMsgTimer = 2;
    getSoundManager().play("levelup");
  }

  /** 升级面板点击：点中某个选项则直接选择（鼠标与触屏通用） */
  protected tryLevelUpClick(): boolean {
    if (!this.pendingClick || !this.pendingLevelUp) return false;
    const { playerIdx, choices } = this.pendingLevelUp;
    const idx = levelUpPanelChoiceAt(
      levelUpPanelGeo(playerIdx, this.viewW, this.viewH),
      choices.length, this.pendingClick.x, this.pendingClick.y);
    if (idx >= 0) { this.chooseLevelUpAbility(idx); return true; }
    return false;
  }

  // ── v2.6.3 画面控制按钮：− (缩小) / ⛶ (全屏) / + (放大) ──
  // 顶栏中央三个小按钮，供网页端随时全屏、并按需调整画面大小（与 main.ts __tankView 桥接）
  private renderViewButtons(renderer: Renderer): void {
    this.viewBtns = [];
    const acts = [
      () => (window as any).__tankView?.zoomOut?.(),
      () => (window as any).__tankView?.fullscreen?.(),
      () => (window as any).__tankView?.zoomIn?.(),
    ];
    const labels = ["−", "⛶", "+"];
    const bw = 30, bh = 22, gap = 4;
    const W = this.viewW;
    const x0 = Math.round(W / 2 - (bw * 3 + gap * 2) / 2);
    const y0 = 2;
    const { ctx } = renderer;
    for (let i = 0; i < 3; i++) {
      const x = x0 + i * (bw + gap);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x, y0, bw, bh);
      ctx.strokeStyle = "#567";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y0 + 0.5, bw - 1, bh - 1);
      ctx.fillStyle = i === 1 ? "#9df" : "#9b8";
      ctx.font = "13px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(labels[i], x + bw / 2, y0 + 3);
      this.viewBtns.push({ x, y: y0, w: bw, h: bh, act: acts[i] });
    }
  }

  private tryViewButtonClick(): boolean {
    if (!this.pendingClick) return false;
    for (const b of this.viewBtns) {
      if (this.pendingClick.x >= b.x && this.pendingClick.x < b.x + b.w &&
          this.pendingClick.y >= b.y && this.pendingClick.y < b.y + b.h) {
        getSoundManager().play("pickup");
        b.act();
        return true;
      }
    }
    return false;
  }

  private updateRevive(dt: number): void {
    const REVIVE_DIST = 56;   // 容错半径 — 靠近尸体即可
    const REVIVE_TIME = 3;    // 3 秒救援

    // P2 靠近 P1 尸体 → 接近复活（需剩余生命）；单人时 P1 仅靠重生倒计时
    if (this.players.length >= 2) {
      if (!this.players[0].isAlive && this.players[1].isAlive && this.players[0].lives > 0) {
        const dx = this.players[1].x - this.players[0].deathX;
        const dy = this.players[1].y - this.players[0].deathY;
        if (dx*dx + dy*dy < REVIVE_DIST*REVIVE_DIST) {
          this.players[0].reviveProgress += dt;
          if (this.players[0].reviveProgress >= REVIVE_TIME) {
            this.players[0].respawn(this.players[0].deathX, this.players[0].deathY, true);  // v2.20 复活满血
          }
        } else {
          this.players[0].reviveProgress = Math.max(0, this.players[0].reviveProgress - dt*2);
        }
      } else if (this.players[0].isAlive) {
        this.players[0].reviveProgress = 0;
      }

      // P1 靠近 P2 尸体 → 接近复活
      if (!this.players[1].isAlive && this.players[0].isAlive && this.players[1].lives > 0) {
        const dx = this.players[0].x - this.players[1].deathX;
        const dy = this.players[0].y - this.players[1].deathY;
        if (dx*dx + dy*dy < REVIVE_DIST*REVIVE_DIST) {
          this.players[1].reviveProgress += dt;
          if (this.players[1].reviveProgress >= REVIVE_TIME) {
            this.players[1].respawn(this.players[1].deathX, this.players[1].deathY, true);  // v2.20 复活满血
          }
        } else {
          this.players[1].reviveProgress = Math.max(0, this.players[1].reviveProgress - dt*2);
        }
      } else if (this.players[1].isAlive) {
        this.players[1].reviveProgress = 0;
      }
    }
  }

  private getItemContext() {
    return {
      base: this.base,
      enemies: this.spawnSystem.activeEnemies,
      tilemap: this.tilemap,
      onExplosion: (x: number, y: number, r: number) =>
        this.combatSystem.spawnExplosionAt(x, y, r),
    };
  }

  protected useFirstItem(pi: number): void {
    const inv = this.inventories[pi];
    const p = this.players[pi];
    const itemId = inv.takeFirstTraditionalItem();
    if (itemId) useTraditionalItem(itemId, p, this.getItemContext());
  }

  protected useItemAt(pi: number, idx: number): void {
    const inv = this.inventories[pi];
    const p = this.players[pi];
    const id = inv.takeTraditionalItemAt(idx);
    if (id) {
      useTraditionalItem(id, p, this.getItemContext());
      this.combatSystem.spawnFloatText(p.x, p.y, "道具使用!", "#ffd700");
      getSoundManager().play("pickup");
    }
  }

  /** 升级选择（main.ts 在暂停时也处理按键；鼠标/触屏点击也走这里） */
  chooseLevelUpAbility(idx: number): void {
    if (!this.pendingLevelUp) return;
    const { playerIdx, choices } = this.pendingLevelUp;
    if (!choices[idx]) return;
    this.levelSystems[playerIdx].applyAbility(choices[idx], this.players[playerIdx]);
    this.pendingLevelUp = null;
    getSoundManager().play("levelup");
    // v2.26 升级只给属性点（用户要求：升级不掉模块卡——模块只能打怪掉落 / 基地商店购买）
  }

  /** v2.7 基地商店购买：扣经验钱包；模块→装当前炮筒空槽（满则进背包）；道具→入背包或直接结算 */
  protected buyFromShop(pi: number, idx: number): void {
    const s = this.shop.stockNow()[idx];
    const c = s && shopItemOf(s.id);
    if (!s || !c) return;
    const p = this.players[pi];
    // 升级服务：价格 = 当前等级升级所需经验（与自动升级扣费完全一致，不产生分歧）
    const price = c.kind === "levelup"
      ? this.levelSystems[pi].getExpToNextLevel()
      : s.price;

    if (p.stats.exp < price) {
      this.shop.notify(`${c.name}（需${price}经验）`, false);
      this.combatSystem.spawnFloatText(p.x, p.y, "经验不足", "#f66");
      getSoundManager().play("deny");
      return;
    }
    if (c.kind === "levelup" && !c) return;   // 占位

    // ── 原子化：先扣费，发货失败 → 回滚；成功 → 调 consumeItem 删库存 ──
    p.stats.exp -= price;

    let ok = true;
    if (c.kind === "module") {
      const cfg = getModule(c.id)!;
      const cannon = p.cannons[p.activeCannon];
      const freeIdx = cannon.modules.findIndex(m => !m);
      if (freeIdx >= 0) {
        cannon.modules[freeIdx] = { config: cfg, usesLeft: cfg.maxUses };
        this.combatSystem.spawnFloatText(p.x, p.y, `${c.name} 已装配`, "#8ff");
      } else if (this.inventories[pi].addModule(c.id)) {
        this.combatSystem.spawnFloatText(p.x, p.y, `${c.name} 已入背包`, "#8ff");
      } else {
        this.warehouse.store({ config: cfg, usesLeft: cfg.maxUses });
        this.combatSystem.spawnFloatText(p.x, p.y, "背包满→已存仓库", "#8af");
      }
    } else if (c.id === "repair_base") {
      this.base.upgradeWalls();
      this.base.eagleHp = this.base.eagleMaxHp;
      this.combatSystem.spawnFloatText(this.base.x, this.base.y, "基地大修完成!", "#2d9");
    } else if (c.kind === "levelup") {
      // v2.14.2 升级服务：直接生成三选一 → 设 pendingLevelUp，不调 requestLevelUp（避免二次扣费）
      if (this.pendingLevelUp) {
        // 已有面板 → 回滚扣费并拒绝
        p.stats.exp += price;
        this.shop.notify("已有升级面板开着", false);
        this.combatSystem.spawnFloatText(p.x, p.y, "已有升级面板", "#f66");
        getSoundManager().play("deny");
        return;
      }
      const choices = this.levelSystems[pi].generateAndConsumeChoices();
      this.pendingLevelUp = { playerIdx: pi, choices, autoTimer: 30 };
      this.combatSystem.spawnFloatText(p.x, p.y, "升级面板已弹出!", "#ffd700");
      this.shop.notify("请在升级面板里选一项", true);
      getSoundManager().play("levelup");
      // levelup 是常驻项，不从库存删除（下次刷新时会一直保留在最后一格）
      return;
    } else if (c.id.startsWith("item_cannon_slot_")) {
      // v2.34 炮筒扩容（用户口径）：1~4 号炮筒各自 +1 模块位；买一次当场售罄（下次刷新可再出），上限 16 孔
      const ci = Number(c.id.slice("item_cannon_slot_".length)) - 1;
      const cannon = p.cannons[ci];
      if (!cannon || cannon.modules.length >= 16) {
        // 已满 16 孔 / 非法炮筒 → 回滚扣费并拒绝
        p.stats.exp += price;
        this.shop.notify("该炮筒已满16孔", false);
        this.combatSystem.spawnFloatText(p.x, p.y, "已满16孔", "#f66");
        getSoundManager().play("deny");
        return;
      }
      cannon.modules.push(null);
      cannon.config.slots = cannon.modules.length;   // 同步快照/联机序列化（slots=实际槽数）
      this.combatSystem.spawnFloatText(p.x, p.y, `炮筒${ci + 1} 模块位+1（${cannon.modules.length}/16）`, "#8f8");
    } else if (c.id === "item_bag_slot") {
      // v2.34 背包扩容（用户口径）：背包格 +1，上限 16；买一次当场售罄（下次刷新可再出）
      if (this.inventories[pi].totalSlots >= 16) {
        p.stats.exp += price;
        this.shop.notify("背包已满16格", false);
        this.combatSystem.spawnFloatText(p.x, p.y, "背包已满16格", "#f66");
        getSoundManager().play("deny");
        return;
      }
      this.inventories[pi].expand(1);
      this.combatSystem.spawnFloatText(p.x, p.y, `背包格+1（${this.inventories[pi].totalSlots}/16）`, "#fb4");
    } else {
      if (!this.inventories[pi].addTraditionalItem(c.id)) {
        // 背包满 → 回滚
        p.stats.exp += price;
        this.shop.notify("背包已满", false);
        this.combatSystem.spawnFloatText(p.x, p.y, "背包已满", "#f66");
        getSoundManager().play("deny");
        return;
      }
    }

    // 成功分支：删库存（levelup 常驻已提前 return 跳过这里）
    if (ok) {
      this.shop.consumeItem(idx);
    }
    this.shop.notify(c.name, true);
    getSoundManager().play("levelup");
  }

  // v2.26 已移除 dropUpgradeRelic（升级掉模块）：用户要求升级只能给属性点增强，
  // 不得给模块卡；模块的唯一来源 = 打怪掉落 / 基地商店购买 / 仓库合成。

  // ── 精准装配背包弹窗（三套操作：鼠标/触屏点击两段式 + 手柄焦点框） ──
  protected toggleBackpack(pi: number): void {
    if (this.backpackOwner === pi) {
      this.backpackOwner = -1;
      this.equipCtrls[pi].reset();
    } else {
      if (this.backpackOwner >= 0) this.equipCtrls[this.backpackOwner].reset();
      this.backpackOwner = Math.min(pi, this.playerCount - 1) as -1 | 0 | 1 | 2 | 3;
      this.warehouseOpen = false;   // 与仓库互斥
    }
    getSoundManager().play("pickup");
  }

  protected backpackPanelX(): number {
    return Math.max(10, (this.viewW - EQUIP_PANEL.w) / 2);
  }

  protected handleBackpackClickShared(): void {
    if (!this.pendingClick) return;
    const { x, y } = this.pendingClick;
    const pi = this.backpackOwner;
    if (pi < 0) return;
    const panelX = this.backpackPanelX();
    const panelY = 40;
    const inPanel = x >= panelX && x < panelX + EQUIP_PANEL.w &&
                    y >= panelY && y < panelY + EQUIP_PANEL.h;
    if (!this.equipCtrls[pi].pointerTap(x, y, panelX, panelY, this.equipCtx(pi)) && !inPanel) {
      this.toggleBackpack(pi);   // 点击面板外关闭
    }
  }

  protected equipCtx(pi: number): EquipCtx {
    const p = this.players[pi];
    return {
      inv: this.inventories[pi],
      player: p,
      onUseItem: (idx) => this.useItemAt(pi, idx),
      onFeedback: (msg, color) => this.combatSystem.spawnFloatText(p.x, p.y, msg, color),
      onPlay: (sfx) => getSoundManager().play(sfx),
      gold: () => p.stats.exp,
      spendGold: (amt) => {
        if (p.stats.exp < amt) return false;
        p.stats.exp -= amt;
        return true;
      },
    };
  }

  /** 手柄焦点框导航：仅当背包打开时由模式调用 */
  protected pollEquipGamepad(dt: number): void {
    const pi = this.backpackOwner;
    if (pi < 0) return;
    const ec = this.equipCtrls[pi];
    const pads = navigator.getGamepads?.() ?? [];
    const g = pads[pi] ?? null;
    if (!g) return;
    const ctx = this.equipCtx(pi);
    const ax = g.axes[0] ?? 0, ay = g.axes[1] ?? 0;
    const l = g.buttons[14]?.pressed ?? false, r = g.buttons[15]?.pressed ?? false;
    const u = g.buttons[12]?.pressed ?? false, d = g.buttons[13]?.pressed ?? false;
    let dx = 0, dy = 0;
    if (l || ax < -0.4) dx = -1; else if (r || ax > 0.4) dx = 1;
    if (u || ay < -0.4) dy = -1; else if (d || ay > 0.4) dy = 1;
    if (dx !== 0 || dy !== 0) ec.moveFocus(dx, dy, ctx);
    ec.confirmHeldInput(g.buttons[0]?.pressed ?? false, ctx);   // A 确认
    if (g.buttons[1]?.pressed) this.toggleBackpack(pi);          // B 关闭
  }

  protected processDrops(drops: LootDrop[], pi: number): void {
    let picked = false;
    for (const d of drops) {
      if (d.type==="exp")  {
        // v2.18 统一经验：通过 LevelUpSystem.addExp 加到 tank.stats.exp 并自动检查升级
        this.levelSystems[pi].addExp(d.value ?? 0);
        this.combatSystem.spawnFloatText(d.x, d.y, `经验 +${d.value}`, "#7f7");
        getSoundManager().play("coin");
        picked = true;
      }
      else if (d.type==="module" && d.moduleId) {
        const cfg = getModule(d.moduleId);
        // v2.18 AI队友自动装配：拾取模块后优先装到当前炮筒空槽
        if (this.isAIPlayer(pi) && cfg) {
          const cannon = this.players[pi].cannons[this.players[pi].activeCannon];
          const freeIdx = cannon.modules.findIndex(m => !m);
          if (freeIdx >= 0) {
            cannon.modules[freeIdx] = { config: cfg, usesLeft: cfg.maxUses };
            this.combatSystem.spawnFloatText(d.x, d.y, `AI已装配:${cfg.name}`, "#8ff");
            picked = true;
          } else if (!this.inventories[pi].addModule(d.moduleId)) {
            // 炮筒满+背包满 → 存入基地仓库
            this.warehouse.store({ config: cfg, usesLeft: cfg.maxUses });
            this.combatSystem.spawnFloatText(d.x, d.y, "背包满→已存仓库", "#8af");
            picked = true;
          } else {
            picked = true;
          }
        } else if (!this.inventories[pi].addModule(d.moduleId)) {
          // 背包已满 → 自动存入基地仓库（低级模块不浪费）
          if (cfg) {
            this.warehouse.store({ config: cfg, usesLeft: cfg.maxUses });
            this.combatSystem.spawnFloatText(d.x, d.y, "背包满→已存仓库", "#8af");
          }
          picked = true;
        } else {
          picked = true;
        }
      }
      else if (d.type==="item"   && d.itemId) {
        if (d.itemId === "item_handyman") {
          this.baseRepair.grantBadge();
          this.combatSystem.spawnFloatText(d.x, d.y, "小人徽章+1", "#ffd700");
        } else if (d.itemId === "item_essence") {
          this.warehouse.essence++;
          this.combatSystem.spawnFloatText(d.x, d.y, "强化材料✦+1", "#ffd700");
        } else if (!this.inventories[pi].addTraditionalItem(d.itemId)) {
          this.combatSystem.spawnFloatText(d.x, d.y, "背包已满", "#f66");
        } else {
          // 拾取反馈：道具名 + 使用提示（v2.3.1：解决"不知道是什么/怎么用"）
          this.combatSystem.spawnFloatText(d.x, d.y, `拾取:${getTradItemName(d.itemId)} (点图标/G用)`, "#fa0");
        }
        picked = true;
      }
    }
    if (picked) getSoundManager().play("pickup");
  }

  // ── 共享渲染 ──
  /** 世界层渲染（相机变换内）：地形/基地/掉落/道具/小人/投射体/特效/伤害数字/敌我/无人机/出生预警/掉落炮筒 */
  protected renderWorld(renderer: Renderer, now: number): void {
    this.camera.applyToCtx(renderer.ctx);
    this.tilemap.render(renderer.ctx, this.camera.x, this.camera.y, this.viewW, this.viewH);
    this.base.render(renderer, now);
    this.lootSystem.render(renderer.ctx, now, 0);   // v2.14.2 归属视觉：viewer=0 是房主视角
    this.powerUps.render(renderer.ctx, now);
    this.baseRepair.render(renderer.ctx);
    this.renderHandymanShopTimer(renderer);
    this.combatSystem.renderProjectiles(renderer.ctx, this.wandSystem.getProjectiles());
    this.combatSystem.renderFX(renderer.ctx);
    this.combatSystem.renderDamageNumbers(renderer.ctx);
    for (const e of this.spawnSystem.activeEnemies) {
      if (this.camera.isVisible(e.x, e.y)) e.render(renderer, now);
    }
    for (const p of this.players) p.render(renderer, now);
    this.droneSystem.render(renderer.ctx);
    this.renderSpawnWarnings(renderer, now);
    this.renderDroppedCannons(renderer);
    this.camera.restoreCtx(renderer.ctx);
  }

  /** v2.26 小人头顶"商店刷新倒计时"周期指示器；v2.27 增加沙漏图形（不看数字也能一眼看出剩余） */
  private renderHandymanShopTimer(renderer: Renderer): void {
    const hm = this.baseRepair.getHandymanSnapshot();
    if (!hm || !hm.isAlive) return;
    const { ctx } = renderer;
    const sec = Math.ceil(this.shop.refreshRemaining);
    const frac = Math.max(0, Math.min(1, this.shop.refreshFraction));
    ctx.save();
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(`商店刷新 ${sec}s`, hm.x + 1, hm.y - 33);
    ctx.fillStyle = "#9fd8ff";
    ctx.fillText(`商店刷新 ${sec}s`, hm.x, hm.y - 34);

    // ── v2.27 沙漏图形：上沙随剩余时间下落、下沙堆积（金色沙粒） ──
    const hx = hm.x, hy = hm.y - 58;   // 沙漏中心
    const w = 8, hh = 11;              // 半宽 / 半高
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#9fd8ff";
    ctx.beginPath();
    ctx.moveTo(hx - w, hy - hh); ctx.lineTo(hx + w, hy - hh);          // 上盖
    ctx.moveTo(hx - w, hy + hh); ctx.lineTo(hx + w, hy + hh);          // 下盖
    ctx.moveTo(hx - w, hy - hh); ctx.lineTo(hx, hy); ctx.lineTo(hx + w, hy - hh); // 上锥
    ctx.moveTo(hx - w, hy + hh); ctx.lineTo(hx, hy); ctx.lineTo(hx + w, hy + hh); // 下锥
    ctx.stroke();
    ctx.fillStyle = "#ffd700";
    if (frac > 0.02) {  // 上沙：剩余比例
      ctx.beginPath();
      ctx.moveTo(hx, hy - 1);
      ctx.lineTo(hx - w * frac, hy - hh * frac);
      ctx.lineTo(hx + w * frac, hy - hh * frac);
      ctx.closePath(); ctx.fill();
    }
    if (frac < 0.98) {  // 下沙：已流逝堆积
      ctx.beginPath();
      ctx.moveTo(hx - w, hy + hh);
      ctx.lineTo(hx + w, hy + hh);
      ctx.lineTo(hx + w * frac, hy + hh * frac);
      ctx.lineTo(hx - w * frac, hy + hh * frac);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /** 出生预警光圈（敌人即将出现的位置） */
  private renderSpawnWarnings(renderer: Renderer, now: number): void {
    const { ctx } = renderer;
    for (const ps of this.spawnSystem.pendingSpawns) {
      const pct = 1 - ps.delay / ps.maxDelay;  // 0→1 as enemy gets closer
      const pulse = 0.4 + 0.6 * Math.abs(Math.sin(now / 200));
      const isBoss = ps.grade === "BOSS";
      const gradeColors: Record<string, string> = {
        F:"#ff6", C:"#6f6", B:"#66f", A:"#f44", S:"#f0f", BOSS:"#ff0"
      };
      const gc = gradeColors[ps.grade] || "#fff";
      ctx.save();
      if (isBoss) {
        // Boss: larger, more intense warning
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(now / 300));
        ctx.fillStyle = gc;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 20 + pct * 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 30, 0, Math.PI * 2 * pct);
        ctx.stroke();
        // Boss skull icon
        ctx.fillStyle = "#fff";
        ctx.font = "bold 20px monospace";
        ctx.textAlign = "center";
        ctx.fillText("☠", ps.x, ps.y + 7);
      } else {
        ctx.globalAlpha = pulse * (0.4 + pct * 0.5);
        ctx.fillStyle = gc;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 8 + pct * 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = gc;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ps.x, ps.y, 18, 0, Math.PI * 2 * pct);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** 掉落炮筒（丢弃的炮筒） */
  private renderDroppedCannons(renderer: Renderer): void {
    const { ctx } = renderer;
    for (const dc of this.droppedCannons) {
      ctx.fillStyle = "#b8860b";
      ctx.fillRect(dc.x - 12, dc.y - 12, 24, 24);
      ctx.strokeStyle = "#ffd700";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(dc.x - 12, dc.y - 12, 24, 24);
      ctx.fillStyle = "#000";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText("炮", dc.x, dc.y + 4);
    }
  }

  /** 小地图（横屏→右侧信息栏内左上对齐；v2.21 竖屏版整体去掉小地图） */
  protected renderMinimap(renderer: Renderer): void {
    if (this.infoY > 0) return;   // v2.21 竖屏：去掉小地图（不遮挡战场，腾出操作空间）
    const mmPoints: Array<{ x: number; y: number; color: string; size?: number }> = [];
    for (const p of this.players) {
      if (p.isAlive) mmPoints.push({ x: p.x, y: p.y, color: p.playerId === 0 ? "#3a8cff" : "#39d94a", size: 4 });
    }
    for (const e of this.spawnSystem.activeEnemies) {
      if (!e.isAlive) continue;
      mmPoints.push({ x: e.x, y: e.y, color: e.isBoss ? "#f0f" : "#f44", size: e.isBoss ? 5 : 3 });
    }
    // 基地始终显示（金色、稍大），避免"缩略图看不到基地"
    mmPoints.push({ x: this.base.x, y: this.base.y, color: "#ffd700", size: 5 });

    const mm = this.minimap.size;
    // v2.19 竖屏小地图改为右上角半透明小窗（原放底部信息栏会撑出 257px 遮挡战场/面板）
    const anchor: { x: number; y: number } = this.infoW > 0
      ? { x: this.infoX + 8, y: 42 }   // 横屏：右侧信息栏内左上对齐（避开顶部 HUD 条）
      : { x: this.worldW - mm.w - 6, y: 44 }; // 竖屏：游戏区右上角，避开顶部 40px HUD
    this.minimap.render(renderer, mmPoints, anchor);
  }

  /** 仓库/背包/升级弹窗（非阶段层的通用覆盖层） */
  protected renderCommonOverlays(renderer: Renderer): void {
    // v2.14.1 基地商店改为手动打开：靠近但未开时，在基地上方显示"按E/点基地打开"提示
    if (this.shopNearPlayer >= 0 && !this.shop.open) {
      const bp = this.camera.worldToScreen(this.base.x, this.base.y);
      drawShopHint(renderer.ctx, bp.x, bp.y - 40);
      // 提交模块按钮：在商店提示下方
      const inv = this.inventories[this.shopNearPlayer];
      const wh = inv ? this.warehouse : null;
      if (wh) {
        const wc = wh.countByQuality("white");
        const bc = wh.countByQuality("blue");
        const es = wh.essence;
        const btnRect = drawSubmitHint(renderer.ctx, bp.x, bp.y - 10, wc, bc, es);
        // 注册点击区域
        this._submitBtnRect = { ...btnRect, playerIndex: this.shopNearPlayer };
      }
    } else {
      this._submitBtnRect = null;
    }
    // v2.7 基地商店面板 (侧边固定，不遮挡战场中心)
    if (this.shop.open && this.shopNearPlayer >= 0) {
      const so3 = this.shopOwner >= 0 ? this.shopOwner : this.shopNearPlayer;
      this.shop.render(renderer, this.viewW, this.viewH, this.players[so3]?.stats.exp ?? 0, so3);
    }
    // v2.6.3 顶栏画面控制按钮（全屏/缩放）：网页端随时可全屏、调整画面大小
    this.renderViewButtons(renderer);
    if (this.warehouseOpen) {
      renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.45)");
      this.renderWarehouse(renderer);
    }
    if (this.backpackOwner >= 0) this.renderBackpackOverlay(renderer);
    if (this.pendingLevelUp) this.renderLevelUpHUD(renderer);
  }

  /** 精准装配背包弹窗渲染（置于顶层） */
  protected renderBackpackOverlay(renderer: Renderer): void {
    const pi = this.backpackOwner;
    if (pi < 0) return;
    renderer.fillRect(0, 0, this.viewW, this.viewH, "rgba(0,0,0,0.45)");
    const panelX = this.backpackPanelX();
    const panelY = 40;
    renderBackpackPanel({
      ctx: renderer.ctx,
      panelX, panelY,
      inv: this.inventories[pi],
      player: this.players[pi],
      playerLabel: `P${pi + 1}`,
      toggleKey: pi === 0 ? "I" : "Num5",
      useKey: pi === 0 ? "G" : "Num0",
      equip: this.equipCtrls[pi],
    });
    this.equipCtrls[pi].renderFocus(renderer.ctx, panelX, panelY, this.equipCtx(pi));
    renderer.drawText(
      `${pi === 0 ? "I" : "Num5"}关闭 · 点击背包模块→选中(黄框)→点炮筒槽装入 · 手柄方向键移动+A确认`,
      this.viewW / 2, panelY + EQUIP_PANEL.h + 18,
      { font: "11px monospace", color: "#aaa", align: "center" });
  }

  protected renderWarehouse(renderer: Renderer): void {
    const panelX = Math.max(10, (this.viewW - 500) / 2);
    const panelY = 40;
    const inv = this.inventories[0];
    renderWarehousePanel({
      ctx: renderer.ctx,
      panelX, panelY, warehouse: this.warehouse, inv,
      page: this.warehousePage,
      onSetPage: (p) => { this.warehousePage = p; },
      onWithdraw: (idx) => {
        if (this.warehouse.withdrawToInventory(idx, inv)) {
          this.warehouseMsg = "已存回背包";
          this.warehouseMsgTimer = 1.5;
        }
      },
      onSynthesize: (target) => {
        const made = this.warehouse.synthesize(target);
        if (made) {
          this.warehouse.store(made);
          this.warehouseMsg = target === "blue" ? "合成蓝色模块!" : "合成金色模块!";
          this.warehouseMsgTimer = 2;
          this.combatSystem.spawnFloatText(this.base.x, this.base.y, this.warehouseMsg, "#ffd700");
        } else {
          this.warehouseMsg = "合成条件不足";
          this.warehouseMsgTimer = 1.5;
        }
      },
      onMessage: (msg) => { this.warehouseMsg = msg; this.warehouseMsgTimer = 1.5; },
    });
    if (this.warehouseMsgTimer > 0) {
      renderer.drawText(this.warehouseMsg, this.viewW / 2, panelY + 345,
        { font: "14px monospace", color: "#ff0", align: "center" });
    }
  }

  /** BOSS 血条（屏幕顶） */
  protected renderBossBar(renderer: Renderer): void {
    const boss = this.spawnSystem.activeEnemies.find(e => e.isAlive && e.isBoss);
    if (!boss) return;
    const { ctx } = renderer;
    const W = this.viewW;
    const bw = Math.min(560, W - 80);
    const bh = 16;
    const bx = (W - bw) / 2;
    const by = 36;

    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(bx - 8, by - 4, bw + 16, bh + 24);
    ctx.strokeStyle = "#f0f";
    ctx.lineWidth = 2;
    ctx.strokeRect(bx - 8, by - 4, bw + 16, bh + 24);

    ctx.fillStyle = "#f0f";
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    ctx.fillText("☠ BOSS", W / 2, by - 8);

    const frac = Math.max(0, boss.hp / boss.effectiveMaxHp);
    ctx.fillStyle = "#300";
    ctx.fillRect(bx, by, bw, bh);
    const grad = ctx.createLinearGradient(bx, by, bx + bw, by);
    grad.addColorStop(0, "#f44");
    grad.addColorStop(1, "#f80");
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw * frac, bh);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);

    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px monospace";
    ctx.fillText(`${Math.ceil(boss.hp)} / ${boss.effectiveMaxHp}`, W / 2, by + 12);
  }

  /** 升级选择面板（侧边，不遮挡战场） */
  protected renderLevelUpHUD(renderer: Renderer): void {
    if (!this.pendingLevelUp) return;
    const { ctx } = renderer;
    const { playerIdx, choices, autoTimer } = this.pendingLevelUp;
    const W = this.viewW; const H = this.viewH;
    const label = playerIdx === 0 ? "P1" : "P2";
    const col   = playerIdx === 0 ? "#4af" : "#4c4";
    const keyLabels = levelUpLabelsFor(playerIdx);   // 明确告诉玩家按哪个键

    // Side panel: P1 on left edge, P2 on right edge — doesn't block gameplay view
    const panelW = 160;
    const panelH = 180;
    const panelX = playerIdx === 0 ? 4 : W - panelW - 4;
    // v2.35 面板下移：不居中挡视野（贴底部按钮区上沿）
    const panelY = Math.max(8, H - panelH - 190);

    ctx.fillStyle = "rgba(0,0,20,0.94)";
    ctx.fillRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.strokeRect(panelX, panelY, panelW, panelH);

    renderer.drawText(`${label} 升级!`, panelX + panelW/2, panelY + 12,
      {font:"12px monospace", color:col, align:"center"});
    renderer.drawText(`(${Math.ceil(autoTimer)}s自动)`, panelX + panelW/2, panelY + 24,
      {font:"9px monospace", color:"#666", align:"center"});

    const btnH = 40;
    choices.forEach((c, i) => {
      const bx = panelX + 4;
      const by = panelY + 32 + i * (btnH + 4);
      const bw = panelW - 8;
      const catCol = c.category==="firepower"?"#f80":c.category==="defense"?"#4af":"#a4f";
      ctx.fillStyle = "#111";
      ctx.fillRect(bx, by, bw, btnH);
      ctx.strokeStyle = catCol;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bw, btnH);
      ctx.fillStyle = catCol;
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`[${keyLabels[i]}] ${c.name}`, bx + bw/2, by + 14);
      ctx.fillStyle = "#888";
      ctx.font = "8px monospace";
      ctx.fillText(c.desc.slice(0, 18), bx + bw/2, by + 26);
      if (c.desc.length > 18) ctx.fillText(c.desc.slice(18, 36), bx + bw/2, by + 36);
    });

    const pct = Math.max(0, autoTimer / 15);
    const barY = panelY + panelH - 8;
    ctx.fillStyle = "#222";
    ctx.fillRect(panelX+4, barY, panelW-8, 4);
    ctx.fillStyle = pct > 0.5 ? "#4f4" : pct > 0.25 ? "#fa0" : "#f44";
    ctx.fillRect(panelX+4, barY, (panelW-8)*pct, 4);
  }

  /** 结算统计面板（P1~P4 动态列宽 + 总览 + 小人贡献 + 每人背包摘要 + 操作按钮区域） */
  protected renderGameOverStats(renderer: Renderer): void {
    const W = this.viewW;
    const H = this.viewH;
    const n = this.players.length;
    const statY = 100;
    const PLAYER_COLORS = ["#4af", "#4c4", "#fa0", "#f4a"];
    const colW = W / (n > 2 ? n : 2);

    // ── 标题 ──
    renderer.drawText("— 对局结算 —", W / 2, 30, { font: "22px monospace", color: "#ffd700", align: "center" });
    renderer.drawText(`用时 ${this.elapsedText()}`, W / 2, 56,
      { font: "14px monospace", color: "#fff", align: "center" });

    const statLabels = ["经验", "等级", "击杀", "伤害输出", "伤害承受"];
    for (let pi = 0; pi < this.players.length; pi++) {
      const p = this.players[pi];
      const s = p.stats;
      const ls = this.levelSystems[pi];
      const sx = colW * pi + colW / 2;
      const col = PLAYER_COLORS[pi] ?? "#ccc";

      // ── 玩家列头 ──
      renderer.drawText(`P${pi + 1}`, sx, statY, { font: "14px monospace", color: col, align: "center" });
      // 剩余命数
      const lives = p.lives ?? 0;
      renderer.drawText(`♥${lives}`, sx + 28, statY, { font: "12px monospace", color: lives > 0 ? "#f44" : "#666", align: "left" });

      const vals = [
        `${s.exp}`,
        `Lv.${ls.level} (${ls.exp}/${Math.max(1, ls.getExpToNextLevel())})`,
        `${s.kills}`,
        `${s.damageDealt}`,
        `${s.damageTaken}`,
      ];
      statLabels.forEach((label, i) => {
        renderer.drawText(`${label}: ${vals[i]}`, sx, statY + 22 + i * 16,
          { font: "11px monospace", color: i === 0 ? "#ff0" : col, align: "center" });
      });

      // ── 每人背包摘要（继承自 inventory）──
      const inv = this.inventories[pi];
      if (inv) {
        const net = inv.toNet();
        const bpItems = Object.entries(net).filter(([, count]) => count > 0)
          .map(([k, count]) => `${k}×${count}`).join(" ");
        const bpY = statY + 22 + statLabels.length * 16 + 4;
        renderer.drawText(bpItems ? `背包: ${bpItems}` : "背包: 空",
          sx, bpY, { font: "10px monospace", color: "#8cf", align: "center" });
      }
    }

    // ── 总览行 ──
    const totalKills = this.players.reduce((sum, p) => sum + p.stats.kills, 0);
    const totalDmg = this.players.reduce((sum, p) => sum + p.stats.damageDealt, 0);
    const totalExp = this.players.reduce((sum, p) => sum + p.stats.exp, 0);
    const summaryY = statY + 22 + statLabels.length * 16 + 26;
    renderer.drawText(`合计击杀 ${totalKills}  总经验 ${totalExp}  总伤害 ${totalDmg}`,
      W / 2, summaryY, { font: "12px monospace", color: "#ffd700", align: "center" });
    renderer.drawText(
      `修复小人: 修墙${this.baseRepair.handymanRepairCount}面 回复${this.baseRepair.handymanRepairedHpTotal}HP 护墙替基地挡${this.base.wallDamageAbsorbed}伤`,
      W / 2, summaryY + 18, { font: "11px monospace", color: "#6f6", align: "center" });

    // ── 操作按钮区域（手机端无 Enter 键，给触屏玩家点击） ──
    const btnY = H - 120;
    const btnW = 140, btnH = 40, btnGap = 14;
    const btnCount = 3;
    const btnX0 = W / 2 - (btnW * btnCount + btnGap * (btnCount - 1)) / 2;
    this._gameOverBtnRects = [
      { x: btnX0, y: btnY, w: btnW, h: btnH, action: "restart" },
      { x: btnX0 + (btnW + btnGap), y: btnY, w: btnW, h: btnH, action: "return_lobby" },
      { x: btnX0 + (btnW + btnGap) * 2, y: btnY, w: btnW, h: btnH, action: "return_menu" },
    ];
    this._drawGameOverBtn(renderer, btnX0, btnY, btnW, btnH, "🔄 重新开始", "#2a1a0a", "#fa0", "#fd7");
    this._drawGameOverBtn(renderer, btnX0 + (btnW + btnGap), btnY, btnW, btnH, "🏠 返回大厅", "#1a2a1a", "#4af", "#9df");
    this._drawGameOverBtn(renderer, btnX0 + (btnW + btnGap) * 2, btnY, btnW, btnH, "🚪 返回主菜单", "#1a1a2a", "#888", "#ccc");
    // 键盘提示
    renderer.drawText("Enter=重新开始  Esc=返回菜单", W / 2, H - 30, { font: "12px monospace", color: "#555", align: "center" });
  }

  /** 结算界面按钮点击区域（供 main 读取） */
  _gameOverBtnRects: Array<{ x: number; y: number; w: number; h: number; action: string }> = [];

  /** 美化按钮绘制 */
  private _drawGameOverBtn(r: Renderer, x: number, y: number, w: number, h: number, label: string, bg: string, border: string, textCol: string): void {
    const { ctx } = r;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.stroke();
    r.drawText(label, x + w / 2, y + h / 2 + 4, { font: "14px monospace", color: textCol, align: "center" });
  }

  /** 用时字符串（游戏时长） */
  protected elapsedText(): string {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins}:${secs.toString().padStart(2,'0')}`;
  }
}
