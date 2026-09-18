//  src/net/NetTypes.ts ─
//  联机协议类型（与 server/index.mjs 同步维护同一套消息结构）
//  消息统一 JSON，字段 `t` 为消息类型。发送端 → 接收端。

import type { PlayerInput } from "../engine/InputManager";

/** 一张桌子的对外视图（给大厅列表/成员展示） */
export interface NetTable {
  id: number;
  name: string;
  mode: "endless" | "stage";
  hostName: string;
  hostClientId: number;
  state: "lobby" | "playing";
  seats: Array<{ clientId: number; name: string; ready: boolean } | null>;
  /** v2.35 房间方向（房主开局时决定的地图/画面方向；成员进入后按此适配布局） */
  orient?: "landscape" | "portrait";
}

// ── 服务端 → 客户端 ──
/** 服务器附带的地址信息（用于生成可分享的邀请链接） */
export interface ServerInfo {
  lanIps: string[];   // 本机局域网 IPv4（已按可分享概率排序）
  port: number;       // 联机端口
}
/** v3.0 服务器可信来源确立的当前入口：host 供展示，origin 供生成邀请链接（含协议/端口，IP 形态也能用） */
export interface EntryOriginFields { publicHost?: string; publicOrigin?: string; }
export interface WelcgMsg extends EntryOriginFields { t: "welcome"; clientId: number; serverInfo?: ServerInfo; }
export interface TablesMsg extends EntryOriginFields { t: "tables"; tables: NetTable[]; }
export interface TableMsg { t: "table"; table: NetTable; }
export interface StartMsg {
  t: "start";
  tableId: number;                 // v2.11 端到端令牌重连需要：断线后凭 (tableId, token) 回到原位
  mode: "endless" | "stage";
  myIndex: number;                 // 玩家索引：房主=0，成员=1
  players: Array<{ clientId: number; name: string }>;
  seed: number;
  rejoinToken?: string;            // v2.11 对局身份令牌（断线重连凭令牌回到原座位）
  /** v2.35 房间方向（成员端据此对齐布局，避免"电脑建房手机画面掉屏外"） */
  orient?: "landscape" | "portrait";
}
/** v2.11 服务器响应 rejoin：结构与 start 一致（客户端复用 beginOnlineGame 直接恢复对局） */
export interface RejoinOkMsg { t: "rejoin_ok"; mode: "endless" | "stage"; myIndex: number; players: Array<{ clientId: number; name: string }>; seed: number; rejoinToken: string; orient?: "landscape" | "portrait"; }
export interface SnapshotMsg { t: "snapshot"; data: NetSnapshot; }
export interface GameOverMsg { t: "gameover"; info: { reason: string; score: number }; }
export interface ErrorMsg { t: "error"; msg: string; }
export interface LeftMsg { t: "left"; }
/** 服务器 RTT 探测回包：ts 为客户端发起时的原时间戳（ping / input 携带 clientSendTime 均触发），RTT = Date.now() - ts */
export interface PongMsg { t: "pong"; ts: number; }

// ── 远端升级选择（主机权威：主机把升级选项广播给成员，成员点选后回传）──
/** 升级选项的对外视图（不含 apply 函数，仅供成员展示/选择） */
export interface NetLvlChoice { name: string; desc: string; category: string; }
/** 主机 → 成员：某玩家出现升级选项（成员可点选或看自动倒计时演示） */
export interface LevelUpMsg { t: "levelup"; playerIdx: number; choices: NetLvlChoice[]; }
/** 成员 → 主机：回传所选的升级项下标 */
export interface PickLevelUpMsg { t: "pick_levelup"; playerIdx: number; choice: number; }

// ── v2.9 基地商店全局同步（主机权威：库存/折扣广播，成员点选回传，钱包在快照 scope.wallets 对齐）──
/** 商店单件货物的对外视图 */
export interface ShopStockView { id: string; price: number; discount: number; }
/** 主机 → 成员：商店库存（刷新/购买后变更即广播） */
export interface ShopStateMsg { t: "shopstate"; stock: ShopStockView[]; }
/** 成员 → 主机：回传所选货物下标（主机扣该玩家经验钱包并结算） */
export interface ShopBuyMsg { t: "shop_buy"; playerIdx: number; choice: number; }

// ── v2.23 成员端拖动装配/卸载 + 基地加固（主机权威：成员发请求，主机结算后回执）──
/** 成员 → 主机：装配/卸载请求（拖动面板产生）。action=equip 把背包格 invIdx 装入炮筒 wand 的 slot；unequip 把槽卸回背包 */
export interface EquipReqMsg { t: "equip_req"; playerIdx: number; action: "equip" | "unequip"; invIdx: number; wand: number; slot: number; }
/** 主机 → 成员：装配/卸载结果（ok=false 时 msg 为原因；成功也会带提示，例如"已卸下 -15经验"） */
export interface EquipResMsg { t: "equip_res"; playerIdx: number; ok: boolean; msg: string; }
/** 成员 → 主机：请求加固基地墙（成员信息栏"加固"按钮） */
export interface FortifyReqMsg { t: "fortify_req"; playerIdx: number; }
/** 主机 → 成员：加固结果 */
export interface FortifyResMsg { t: "fortify_res"; ok: boolean; msg: string; }

// ── v2.12 主机迁移：检查点（快照未携带的武器/等级/背包状态）+ 接替通知 ──
/** 单根炮筒的序列化视图（重建 WandState 所需全部字段） */
export interface CheckpointCannon {
  config: { id: string; name: string; slots: number; castDelay: number; rechargeTime: number; shuffle: boolean; singleShot?: boolean };
  modules: Array<{ id: string; uses: number } | null>;
  active: boolean;
}
/** 单玩家的检查点（快照 scope 之外、接替续局必须保留的状态） */
export interface CheckpointPlayer {
  cannons: CheckpointCannon[];
  level: number; exp: number; lives: number;
  stats: { score: number; exp: number; kills: number; damageDealt: number; damageTaken: number; shotsFired: number; hitsLanded: number; goldCollected: number; modulesUsed: number };
  wandDamageMults: number[]; critChance: number; critMultiplier?: number; projSpeedMult: number;
  extraMaxHp: number; flatArmor: number; pctDefense: number;
  hasInvincibleShield: boolean; hasModuleSteal: boolean; hasFreeCast: boolean;
  moduleDropMult?: number;
  wallLevel: number;
  inv: Array<{ kind: "module" | "item"; id: string; uses: number } | null>;
}
/** v2.16 仓库的网络视图（模块列表 + 强化材料），供成员端查看仓库 */
export interface NetWarehouse {
  essence: number;
  items: Array<{ id: string; name: string; quality: string; usesLeft: number }>;
}
/** 主机 → 服务器 → 成员：定期检查点（每 2s；成员保存最新一份用于接替） */
export interface CheckpointMsg { t: "checkpoint"; players: CheckpointPlayer[]; warehouse: NetWarehouse; assetPack?: import("../assets/AssetPack").AssetPack; assetPackVersion?: string; }
/** 服务器 → 成员：房主断线，已由在场成员接替（newHostClientId=新主机；成员凭本地快照+检查点恢复） */
export interface MigratedMsg {
  t: "migrated";
  newHostClientId: number;
  players: Array<{ clientId: number; name: string }>;
}

// 客户端 → 服务端 → 客户端（中继）
export interface PeerInputMsg { t: "peer_input"; idx: number; flags: PlayerInput; clientSendTime: number; clientFrame?: number; }

// ── 网络快照（主机权威模拟的对外序列化，20Hz 广播）──
/** 稳定实体 ID 由主机分配：玩家 P1=1/P2=2、敌人从 1000 起自增、子弹由 WandSystem 自增 —— 全局唯一，
 *  成员端据此按 ID 匹配插值/检出消失，根治"子弹串位/死亡冻结/敌人消失延迟"。 */
export interface NetTank {
  id: number;
  x: number; y: number;
  hp: number; maxHp: number;
  alive: boolean;
  playerId: number; team: number;
  facing: "up" | "down" | "left" | "right";
  activeCannon: number;
  isBoss?: boolean;
  gradeLabel?: string;
  hidden?: boolean;
  respawnTimer?: number;
  lives?: number;
  /** v2.17 状态/Buff图标（🔥🛡✦⚡❄等），供远端渲染对齐 */
  buffs?: string[];
  /** v2.17 是否眩晕（眩晕闪白） */
  stunned?: boolean;
  /** v2.17 复活进度（0..4，队友救援时） */
  reviveProgress?: number;
}

export interface NetProjectile {
  id: number;                 // 同一颗子弹跨帧保持稳定（WandSystem 自增）
  x: number; y: number;
  radius: number;
  color: string;
  type: string;
  ownerTeam: number;
}

export interface NetLootDrop {
  x: number; y: number;
  type: string;        // module/item/exp/gold
  quality: string;
  moduleId?: string;
  itemId?: string;
  value?: number;
  /** v2.14.2 归属权：ownerId 存在表示该掉落只属于该玩家（idx），undefined=公开 */
  ownerId?: number;
}

export interface NetPowerUp {
  x: number; y: number;
  type: string;
}

/** v2.17 修复小人（基地维修工）同步数据 */
export interface NetHandyman {
  x: number; y: number;
  isAlive: boolean;
  grave: boolean;
  walking: boolean;
  repairing: boolean;
  repairingEagle: boolean;
  dir: number;
}

/** v2.17 伤害数字同步 */
export interface NetDamageNumber {
  x: number; y: number;
  value: number;
  crit: boolean;
  color?: string;
}

export interface NetBase {
  x: number; y: number;
  eagleHp: number; eagleMaxHp: number;
  isDestroyed: boolean;
  wallLevel: number;
  /** v2.16 面级聚合（兼容旧字段，UI 汇总用） */
  walls: Array<{ side: string; hp: number; maxHp: number }>;
  /** v2.16 独立小砖列表（每面 8 块，逐块同步血量） */
  bricks?: Array<{ side: string; index: number; hp: number; maxHp: number; x: number; y: number; w: number; h: number }>;
}

export interface NetSnapshot {
  players: NetTank[];
  enemies: NetTank[];
  projectiles: NetProjectile[];
  base: NetBase;
  loot: NetLootDrop[];
  powerups: NetPowerUp[];
  map?: number[][];       // 首帧发送一次，后续省略；远端缓存上次的地图
  biome?: string;          // v2.15 地图生物群系（每帧发送，确保远端地图配色与主机一致）
  /** v2.15 地图增量变化：自上一快照起变化的瓦片（{col,row,type,quadHp?}），远端据此更新本地地图，确保砖块打掉等状态同步 */
  mapChanges?: Array<{ col: number; row: number; type: number; quadHp?: [number, number, number, number] }>;
  /** v2.17 活跃地形状态（火/毒/电等），供远端渲染火焰等特效 */
  tileStates?: Array<{ col: number; row: number; element: string; timer: number; intensity: number }>;
  /** v2.17 活跃爆炸特效（位置+半径+进度），供远端渲染爆炸 */
  explosions?: Array<{ x: number; y: number; r: number; maxR: number; t: number; maxT: number }>;
  /** v2.17 修复小人（基地维修工）状态，供远端渲染 */
  handyman?: NetHandyman | null;
  /** v2.17 活跃伤害数字（飘字），供远端渲染 */
  damageNumbers?: NetDamageNumber[];
  scope: { score: number; wave: number; over: boolean; wallets?: number[]; bp?: Array<Record<string, number>>;
    /** v2.30 难度 / 隐藏分（成员端 HUD 与主机对齐显示） */
    diff?: number; hidden?: number };
  /** 自上一快照起消失的实体 ID（坦克/子弹分列；空则省略省带宽）。成员据此立即剔除+淡出，杜绝死亡冻结/消失延迟。 */
  removed?: { tanks: number[]; projectiles: number[] };
  /** 服务端帧号（单调递增，用于去重/乱序检测） */
  frame: number;
  /** 服务端发送时的时间戳（毫秒，Date.now()） */
  t: number;
  /** 客户端发送输入时的本地时间（用于 RTT 估算），仅 input 消息携带 */
  clientSendTime?: number;
}