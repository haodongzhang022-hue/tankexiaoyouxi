//  src/net/JoinError.ts ── 加入房间失败的**分档判定**（纯逻辑，单一事实源，可单测）
//
//  为什么要单独一个模块（Issue #16 D1）：
//    邀请链接自动进房的重试策略曾经写成 `msg.includes("已满") / ("不存在") / ("对局中")` ——
//    把「重试还是不重试」这个**行为**耦合到了服务端的中文文案上。服务端一改词（本地化/加前缀），
//    前端就静默落到「未知错误 → 停止重试」分支：
//      ·「不存在」退化成通用「加入失败」，不再提示"要新链接"；
//      ·「对局中」直接放弃重试，丢掉"等本局结束再进"的能力。
//
//  现在的口径：
//    ① **优先按服务端 error 帧的 `code` 机器码分档**（shared/net-error-codes.mjs 是与服务端共用的
//       契约；服务端与前端导出的常量同名同值）；
//    ② `code` 缺失（新前端 + 旧服务端混版本）时，**才**回落到关键词兜底，保证不退化；
//    ③ 文案只用于展示，改文案不再改变行为。
//
//  ⚠ 评审返工（v2.41）：分档表**不做黑名单**。此前版本按「已分类但不是加入房间的码」把
//    `room_not_found` / `room_full` 一起踢出映射 —— 而这两个恰恰是**最典型的加入错误**：
//    `join` 处理器对「房号不存在」发 room_not_found、「4 座全占」发 room_full，
//    踢掉后它们全都落到 unknown → 文案退化成通用「加入失败（房间不存在）」，
//    丢掉「请向好友要新链接」这个可操作提示（正是本 Issue 要修的东西）。
//    现在：**加 房间的失败 = 加入错误**，判据只看「这条错误是否描述加入失败」，
//    不掺「在哪个流程里出现」的上下文；流程之间的差异由调用方决定（见 main.ts 的两个分支）。
//    码的清单只有**一份**（shared/net-error-codes.mjs）—— 本文件直接读它、不再手抄，
//    避免"两边各写一遍、漂移了 CI 也看不见"（评审 🔴2）。
//    错误帧该显示什么、要不要重试，统一由 decideErrorFrame() 单点决定（评审 🔴1）。

// 服务端 error 帧的机器码：**直接读 shared/net-error-codes.mjs**（与服务端同一份，禁止手抄）。
// 手抄过一份同名常量的后果：两边漂移时 `npm run net:entry-test` 照样全绿（评审 🔴2 实证）。
// @ts-expect-error —— shared/ 是给 server(mjs) 与前端共用的 .mjs，没有 .d.ts；此处按契约取成员。
import * as _codes from "../../shared/net-error-codes.mjs";

interface NetErrorCodes {
  ERR_ROOM_NOT_FOUND: string;
  ERR_ROOM_FULL: string;
  ERR_ROOM_PLAYING: string;
  ERR_ALREADY_IN_TABLE: string;
  ERR_HOST_ONLY: string;
  ERR_START_PRECONDITION: string;
  ERR_NO_REJOIN: string;
  ERR_UNKNOWN: string;
}
const codes = _codes as unknown as NetErrorCodes;

export const ERR_ROOM_NOT_FOUND = codes.ERR_ROOM_NOT_FOUND;
export const ERR_ROOM_FULL = codes.ERR_ROOM_FULL;
export const ERR_ROOM_PLAYING = codes.ERR_ROOM_PLAYING;
export const ERR_ALREADY_IN_TABLE = codes.ERR_ALREADY_IN_TABLE;
export const ERR_HOST_ONLY = codes.ERR_HOST_ONLY;
export const ERR_START_PRECONDITION = codes.ERR_START_PRECONDITION;
export const ERR_NO_REJOIN = codes.ERR_NO_REJOIN;
export const ERR_UNKNOWN = codes.ERR_UNKNOWN;

/**
 * 这些码**一定不是**「加入房间失败」（房间都还没试）→ 不带"加入失败"前缀，原样展示服务端原文。
 * 语义与命名一致：**NOT-join** = 不是加入错误（不是「不是错误」，更不是「不要判」）。
 * 用法：错误帧统一走 decideErrorFrame()，由它查这张表决定文案口径（评审 🟡1：此前定义后零引用）。
 */
const NOT_ADD_ERRORS: ReadonlySet<string> = new Set<string>([
  ERR_ALREADY_IN_TABLE,      // 已经在桌内：不是"加不进去"，是"没必要加"
  ERR_HOST_ONLY,             // 房主专属操作（改方向/开局）：与加入无关
  ERR_START_PRECONDITION,    // 开局前置不满足（没人/没准备）：与加入无关
]);

/** 错误帧展示的口径：join=加入失败（分档文案）｜not_add=明确不是加入错误（原样原文）｜other=未知（兜底 + 原文） */
export type ErrorFrameKind = "join" | "not_add" | "other";

/**
 * 由机器码判断展示口径。`NOT_ADD_ERRORS` 在这里被真正消费（评审 🟡1：此前定义后零引用）。
 * @param knownAsJoin 调用方是否明说「这是一次加房间请求」（此时 even host_only 也算加房间失败？
 *                    不 —— host_only 等码永远不是加入失败，故本参数只对 unknown 码生效）
 */
export function frameKindOfCode(code: unknown, knownAsJoin = false): ErrorFrameKind {
  const c = typeof code === "string" ? code : "";
  if (NOT_ADD_ERRORS.has(c)) return "not_add";       // 房主专属/开局前置/已在桌内：一定不是加入失败
  if (kindOfCode(c)) return "join";                  // room_full / room_not_found / room_playing：典型的加入错误
  if (c) return knownAsJoin ? "join" : "other";      // 服务端新增码：只有调用方确认是加房间请求才算加入失败
  return "other";                                    // 无 code（旧服务端）→ 交回文案兜底
}

export type JoinErrorKind = "full" | "not_found" | "playing" | "unknown";

export interface JoinErrorDecision {
  kind: JoinErrorKind;
  /** 是否值得重试（只有「本局进行中」值得：等本局结束再点一次） */
  retry: boolean;
  /** 判定依据：服务端机器码 or 旧服务端关键词兜底（便于自测/排障） */
  via: "code" | "msg";
}

/** code → 分档（白名单式：认得就判，不认得的码交回上层按 unknown 处理） */
function kindOfCode(code: string): JoinErrorKind | null {
  switch (code) {
    case ERR_ROOM_FULL: return "full";
    case ERR_ROOM_NOT_FOUND: return "not_found";
    case ERR_ROOM_PLAYING: return "playing";
    default: return null;
  }
}

/**
 * 旧服务端（没有 `code`）的关键词兜底：**只**为了让混版本部署不退化，不作为主路径。
 * 命中顺序与旧实现一致（已满 → 不存在 → 对局中）。
 */
function kindOfMsg(msg: string): JoinErrorKind {
  if (msg.includes("已满")) return "full";
  if (msg.includes("不存在")) return "not_found";
  if (msg.includes("对局中")) return "playing";
  return "unknown";
}

/**
 * 判定一条 error 帧该怎么处理。
 * @param code 服务端 error 帧的机器码（可选；缺失 = 旧服务端）
 * @param msg  服务端 error 帧的展示文案（仅兜底用）
 */
export function classifyJoinError(code: unknown, msg: unknown): JoinErrorDecision {
  const c = typeof code === "string" ? code : "";
  const m = typeof msg === "string" ? msg : "";
  const byCode = kindOfCode(c);
  if (byCode) return { kind: byCode, retry: byCode === "playing", via: "code" };
  // 认得的码之外一律 unknown（明确不重试，别瞎猜）：可能是「一定不是加入错误」的码
  // （NOT_ADD_ERRORS：已经在桌内 / 房主专属 / 开局前置，见 decideErrorFrame），
  // 也可能是**服务端将来新增的加入错误码**
  // —— 后者等本文件的映射表补上，此处不带猜行为，只把原文带出来给玩家看。
  if (c) return { kind: "unknown", retry: false, via: "code" };
  const byMsg = kindOfMsg(m);
  return { kind: byMsg, retry: byMsg === "playing", via: "msg" };
}

/**
 * 一条 error 帧在**某个流程**里该怎么处置 —— 全项目唯一决策入口（评审 🔴1）。
 *
 * 为什么要有它：判据（classifyJoinError）是流程无关的，但"显示什么文案 + 要不要重试 +
 * 是否结束该流程"是**流程相关**的。此前 main.ts 手写三条分支，把流程 A（邀请链接进房的
 * full/not_found/playing 分档）无条件套到流程 B（大厅里的其它错误）上：
 *   · `host_only` / `start_precondition` / `no_rejoin` 是"不是加入错误"的码，却被渲染成
 *     「加入房间失败（仅房主可开始）」，且 `no_rejoin` 被说成"加入失败"；
 *   · 同一 handler 里刚发的「重连失败：…，已回大厅」被随后这条**盖掉**，玩家看不到"已回大厅"。
 * 现在：流程差异只体现在入参上（`rejoining` / `attemptJoin`），文案口径由本函数单点决定，
 * 调用方只负责执行动作（return / 重试 / 落卡）。
 */
export interface ErrorFrameContext {
  /** 是否处于「断线重连」场景：文案带"重连对局"前缀，且**不再**说成"加入房间失败" */
  rejoining?: boolean;
  /**
   * 这条错误是否来自一次**真的加房间请求**（邀请自动进房 / 点了某张桌）。
   * - true：加房间的失败 → 按 kind 分档（已满 / 不存在 / 对局中 / 未知）
   * - false：不是加房间（房主操作被拒等）→ 原样展示服务端原文，不臆造"加入失败"
   * - 省略：只有 kind 不是 unknown 时才算加入失败（如重连场景的 room_full/room_not_found）
   */
  attemptJoin?: boolean;
  /** 房号（展示用；重连场景是桌号） */
  roomId?: number | null;
  /** 服务端原文（unknown / 非加入错误时原样带出） */
  rawMsg?: string;
}

export interface ErrorFrameDecision {
  kind: JoinErrorKind;
  /** 是否**加房间**失败（决定文案口径；仅对加房间流程有意义） */
  isJoinFailure: boolean;
  /** 是否值得重试（只有「本局进行中」的**加房间**失败值得：等本局结束再点一次） */
  retry: boolean;
  /** 是否应结束当前进房流程（邀请自动进房：不重试即停） */
  stopFlow: boolean;
  /** 展示文案（已按场景渲染好，调用方直接 notify） */
  text: string;
  /** 展示口径（join / not_add / other）—— 排障与 e2e 断言用 */
  frameKind: ErrorFrameKind;
  via: "code" | "msg";
}

/** 统一入口：判定 + 文案一次算完（调用方不再手写分支，杜绝"拿 A 流程结论套 B 流程"） */
export function decideErrorFrame(code: unknown, msg: unknown, ctx: ErrorFrameContext = {}): ErrorFrameDecision {
  const raw = typeof msg === "string" ? msg : "";
  const c = typeof code === "string" ? code : "";
  const v = classifyJoinError(code, msg);
  // 口径由 frameKindOfCode 单点决定（真查 NOT_ADD_ERRORS，不再是"定义后零引用"）：
  //   · 明确不是加入错误的码（host_only / start_precondition / already_in_table）→ 永远原文，不被"加房间"结论带偏；
  //   · 典型加入错误码（room_full / not_found / playing）→ 分档文案；
  //   · 服务端新增码 → 只有调用方确认"这次真的在加房间"(attemptJoin) 才算加入失败，否则原文。
  const kindOfFrame = frameKindOfCode(code, ctx.attemptJoin === true);
  const isJoinFailure = kindOfFrame === "join";
  const roomId = ctx.roomId ?? null;
  let text: string;
  if (ctx.rejoining) {
    // 重连场景：**必须**带上"已回到大厅"（玩家要知道自己现在在哪），且不说成"加入房间失败"
    text = rejoinErrorText(v.kind, roomId, raw);
  } else if (kindOfFrame === "not_add" || !isJoinFailure) {
    text = raw;                        // 不做任何加工：服务端已经说清了（如「仅房主可开始」）
  } else {
    text = inviteJoinErrorText(v.kind, roomId, raw);
  }
  // 重试 == 判据说的"本局进行中"（等本局结束再点一次）。非加入错误的码判不出 playing，
  // 因此天然不会重试；不需要额外门闸（也不该有 —— classifyJoinError 的 retry 口径是权威）。
  const retry = v.retry;
  return { kind: v.kind, isJoinFailure, retry, stopFlow: ctx.attemptJoin === true && !retry, text, via: v.via, frameKind: kindOfFrame };
}

/**
 * 加入房间失败时给玩家看的话（文案与"重不重试"解耦：这里只产出文字）。
 * `kind` 入参宽松（string）→ 便于从需要序列化的判定结果直接透传（不必二次手写 "playing"）。
 * `roomId` 省略时按「没有房号的场景」措辞（重连失败只有桌号，没有可分享的邀请链接）。
 */
export function joinErrorText(kind: JoinErrorKind | string, roomId?: number | null, rawMsg = ""): string {
  const room = roomId == null ? "" : ` #${roomId}`;
  switch (kind) {
    case "full":
      return `房间${room}已满：请选别的桌或等一位空位（座位释放后重新打开邀请链接即可）`;
    case "not_found":
      return `房间${room}已不存在：请向好友要新链接，或自行选桌/开房`;
    case "playing":
      return `房间${room}本局进行中，等本局结束…`;
    default:
      return `加入房间${room}失败（${rawMsg}）：请自行选桌/开房`;
  }
}

/**
 * 调用方**上下文**：同一句「什么原因 + 怎么办」在邀请链接进房 / 断线重连两个流程里前后缀不同
 * （邀请：已停在大厅 / 重连：已回到大厅，后者见 rejoinErrorText）。流程差异放在调用方，
 * 判据本身保持流程无关。
 */
export interface JoinErrorContext {
  /** 房号（有就带上，如 `房间 #12`） */
  roomId?: number | null;
  /** 场景前后缀（如「邀请的房间 …，已停在大厅」「重连的桌 …，已回到大厅」） */
  prefix?: string;
  suffix?: string;
}

/** 按上下文渲染完整提示语（邀请链接自动进房） */
export function inviteJoinErrorText(kind: JoinErrorKind | string, roomId: number | null, rawMsg = ""): string {
  return renderJoinErrorText(kind, { roomId }, rawMsg);
}

/**
 * 按上下文渲染完整提示语（断线重连：桌号是服务器桌 ID，没有可分享的邀请链接语义）。
 * 后缀固定「，已回到大厅」—— 这是重连失败后玩家**必须知道**的事实（评审 🔴1：
 * 此前这句话被随后的"加入房间失败（…）"盖掉，玩家看不到自己已经回到大厅）。
 */
export function rejoinErrorText(kind: JoinErrorKind | string, tableId: number | null, rawMsg = ""): string {
  const room = tableId == null ? "" : ` #${tableId}`;
  // 不是加入错误（no_rejoin / host_only / 未知）→ 原样服务端原文 + 已回大厅，不臆造"加入房间失败"
  if (kind !== "full" && kind !== "not_found" && kind !== "playing") {
    const reason = rawMsg || "重连的桌已不可用";
    return /已回到大厅$/.test(reason) ? reason : `${reason}，已回到大厅`;
  }
  // 加入错误的三个码在**重连**场景下的措辞：桌号是服务器桌 ID，没有可分享的"邀请链接"语义，
  // 也不能说"加入房间失败"（玩家本来就在那局里）—— 只讲清楚"为什么没接上 + 已回大厅 + 现在能做什么"。
  const why = kind === "full"
    ? `重连对局${room}的座位已被占满`
    : kind === "not_found"
      ? `重连对局${room}已不存在（可能已结束）`
      : `重连对局${room}仍在进行中，暂时接不回去`;
  return `${why}，已回到大厅：可从大厅重新选桌/开房`;
}

/** 统一出口：前缀 + 原因/办法 + 后缀（所有文案都从这里出，避免调用方手写字符串漏掉"怎么办"） */
export function renderJoinErrorText(kind: JoinErrorKind | string, ctx: JoinErrorContext = {}, rawMsg = ""): string {
  const prefix = ctx.prefix ?? "邀请";
  const suffix = ctx.suffix ?? "，已停在大厅";
  return `${prefix}${joinErrorText(kind, ctx.roomId, rawMsg)}${suffix}`;
}
