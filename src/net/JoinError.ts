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
//    `NOT_ADD_ERRORS` 是显式黑名单：只有**确定不是加入错误**的码才剔除映射。

/** 服务端 error 帧的机器码（与 shared/net-error-codes.mjs 保持同一套值） */
export const ERR_ROOM_NOT_FOUND = "room_not_found";
export const ERR_ROOM_FULL = "room_full";
export const ERR_ROOM_PLAYING = "room_playing";
export const ERR_ALREADY_IN_TABLE = "already_in_table";
export const ERR_HOST_ONLY = "host_only";
export const ERR_START_PRECONDITION = "start_precondition";
export const ERR_NO_REJOIN = "no_rejoin";
export const ERR_UNKNOWN = "unknown";

/**
 * 这些码**一定不是**「加入房间失败」（房间都还没试），剔出映射 → 走 unknown 分支（不重试、带原文）。
 * 语义与命名一致：**NOT-join** = 不是加入错误（不是「不是错误」，更不是「不要判」）。
 */
const NOT_ADD_ERRORS = new Set<string>([
  ERR_ALREADY_IN_TABLE,      // 已经在桌内：不是"加不进去"，是"没必要加"
  ERR_HOST_ONLY,             // 房主专属操作（改方向/开局）：与加入无关
  ERR_START_PRECONDITION,    // 开局前置不满足（没人/没准备）：与加入无关
]);

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
  // 认得的码之外一律 unknown（明确不重试，别瞎猜）：可能是「一定不是加入错误」的黑名单码
  // （NOT_ADD_ERRORS：已经在桌内 / 房主专属 / 开局前置），也可能是**服务端将来新增的加入错误码**
  // —— 后者等本文件的映射表补上，此处不带猜行为，只把原文带出来给玩家看。
  if (c) return { kind: "unknown", retry: false, via: "code" };
  const byMsg = kindOfMsg(m);
  return { kind: byMsg, retry: byMsg === "playing", via: "msg" };
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
 * （邀请：已停在大厅 / 重连：已回到大厅）。流程差异放在调用方，判据本身保持流程无关。
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

/** 按上下文渲染完整提示语（断线重连：桌号是服务器桌 ID，没有可分享的邀请链接语义） */
export function rejoinErrorText(kind: JoinErrorKind | string, tableId: number | null, rawMsg = ""): string {
  return renderJoinErrorText(kind, { roomId: tableId, prefix: "重连对局" }, rawMsg);
}

/** 统一出口：前缀 + 原因/办法 + 后缀（所有文案都从这里出，避免调用方手写字符串漏掉"怎么办"） */
export function renderJoinErrorText(kind: JoinErrorKind | string, ctx: JoinErrorContext = {}, rawMsg = ""): string {
  const prefix = ctx.prefix ?? "邀请";
  const suffix = ctx.suffix ?? "，已停在大厅";
  return `${prefix}${joinErrorText(kind, ctx.roomId, rawMsg)}${suffix}`;
}
