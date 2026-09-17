// ============================================================================
//  net-sync-core / schema.ts ─ 对接表（单一事实源 · 语言无关契约）
//  ----------------------------------------------------------------------------
//  用途：一个项目接入本资产时，只填这一份表（字段 + 同步模式 + 事件 + 参数），
//        通用核心（core.ts）即按此表驱动「快照 / 增量 / 插值 / 事件 / 检查点」。
//        背包、经验、金币、等级等需要网络对齐的内容，全部在这一张表里声明。
//  语言无关：本文件是 TS 形态的契约；Unity(C#) / UE(C++) 端按同一张表生成对应类型。
//  版本：2026-09-12 v1.0.0（首次固化：从坦克大战 v2.6~v2.12 实战沉淀）。
//  约定：最新版本最高权重；历史字段保留参考，不再适用时标记 note 说明而非删除。
// ============================================================================

/** 字段类型（与各端序列化器一一对应，跨端保持一致） */
export type FieldType =
  | "int" | "float" | "string" | "bool" | "enum" | "object" | "array";

/**
 * 同步模式：
 *  - eq     变化才进增量帧（网络主开销，需在带宽与精度间权衡）
 *  - always 每帧全量发送（适合小字段 / 无稳定 ID 的短命对象）
 *  - none   不参与 diff 判定，但随实体记录携带（如稳定 ID、阵营等低频字段）
 */
export type SyncMode = "eq" | "always" | "none";

/** 单字段声明（对接表的一行） */
export interface FieldSpec {
  name: string;                 // 字段名（跨端一致，同一时刻全端统一）
  type: FieldType;
  sync: SyncMode;
  sub?: FieldSpec[];            // object 的子字段
  note?: string;                // 对接批注（填写说明 / 端侧差异 / 单位）
}

/** 实体种类（如 tank / projectile） */
export interface EntityKind {
  kind: string;                 // 种类名（跨端一致）
  /** 稳定 ID 字段（全局唯一、跨帧不变，成员端按此匹配插值/检出消失）。
   *  无稳定 ID 的种类（如一次性掉落）置空并配合 alwaysFull=true 每帧全量。 */
  idField?: string;
  /** 每帧全量发送/替换（无稳定 ID 或个体不重要时用；如 loot/powerup） */
  alwaysFull?: boolean;
  fields: FieldSpec[];
}

/** 事件（升级 / 商店 / 结束 / 信令等：走可靠中继，不混入快照流） */
export interface EventSpec {
  name: string;                 // 事件名（消息 `t` 字段，跨端一致）
  dir: "host_to_members" | "member_to_host" | "any";
  reliable: boolean;            // 必须送达（检查点/结束）；否则走最廉价通道
  fields: FieldSpec[];
}

/** 传输偏好（各端 transport 按此对接） */
export interface TransportPref {
  primary: "ws" | "rtc" | "udp" | "tcp";
  fallback: "ws" | "rtc" | "none";
  /** 双发：P2P + 中继同时发，先到先渲染（快照专用；成员端按帧号天然去重） */
  dualSend: boolean;
}

/** 插值参数（成员端渲染缓冲） */
export interface InterpPref {
  delayMinMs: number;           // 延迟下限（稳定时贴最新帧，低延迟）
  delayMaxMs: number;           // 延迟上限（极端抖动最多缓冲的深度）
  adaptive: boolean;            // 自适应延迟（抖动驱动加深缓冲；false=固定 delayMin）
  stepMs: number;               // 单帧最大推进量
  catchUpMult: number;          // 落后严重时的追赶倍率
  backoffMult: number;          // 抖动后撤建立缓冲的倍率
}

/** 一份完整的对接表 */
export interface SyncSchema {
  version: string;              // 契约版本（协议演进追踪，变更即递增）
  project: string;              // 项目标识（如 tank-battle / cocos-x / unity-y）
  tickRate: number;             // 快照频率（Hz）
  keyFrameEvery: number;        // 关键帧间隔（帧数，防丢包累积错乱）
  forceFullRatio: number;       // 单类实体变化超此比例 → 强制全量帧（0.6 = 60%）
  entities: EntityKind[];       // 实体种类表
  scope: FieldSpec[];           // 全局小状态（分数/波次/血量/钱包/背包/基地…变化才发）
  payload: FieldSpec[];         // 首帧大数据（如地图），仅全量帧携带，未变省略
  events: EventSpec[];          // 事件表
  checkpoint: FieldSpec[];      // 检查点（快照未携带的重状态：武器/等级/背包…周期广播）
  interp: InterpPref;
  reconnect: { tokenKey: string; timeoutMs: number };
  heartbeatMs: number;          // 心跳/RTT 探测间隔（ms）
  transport: TransportPref;
}

/** 校验一份对接表：返回错误列表（空数组 = 通过）。跨项目填表后先跑一遍再接入。 */
export function validateSchema(s: SyncSchema): string[] {
  const errs: string[] = [];
  if (!s.version) errs.push("version 缺失");
  if (!s.project) errs.push("project 缺失");
  if (s.tickRate <= 0) errs.push("tickRate 必须 > 0");
  if (s.keyFrameEvery <= 0) errs.push("keyFrameEvery 必须 > 0");
  if (s.forceFullRatio <= 0 || s.forceFullRatio > 1) errs.push("forceFullRatio 需在 (0,1]");
  if (s.interp.delayMinMs < 0 || s.interp.delayMaxMs < s.interp.delayMinMs) {
    errs.push("插值延迟区间非法（delayMax 需 >= delayMin）");
  }
  if (!s.reconnect.tokenKey) errs.push("reconnect.tokenKey 缺失");
  if (s.heartbeatMs <= 0) errs.push("heartbeatMs 必须 > 0");

  const idSet = new Set<string>();
  for (const e of s.entities) {
    if (idSet.has(e.kind)) errs.push(`实体种类重复：${e.kind}`);
    idSet.add(e.kind);
    if (e.idField && !e.fields.some((f) => f.name === e.idField)) {
      errs.push(`${e.kind} 的 idField「${e.idField}」不在字段表中`);
    }
    if (!e.alwaysFull && !e.idField) {
      errs.push(`${e.kind} 既不是 alwaysFull，也缺 idField（无法 diff）`);
    }
    for (const f of e.fields) {
      if (f.type === "object" && (!f.sub || f.sub.length === 0)) {
        errs.push(`${e.kind}.${f.name} 为 object 但缺 sub`);
      }
    }
  }
  const evSet = new Set<string>();
  for (const ev of s.events) {
    if (evSet.has(ev.name)) errs.push(`事件重复：${ev.name}`);
    evSet.add(ev.name);
  }
  return errs;
}
