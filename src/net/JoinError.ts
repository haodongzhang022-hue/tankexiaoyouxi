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

/** 服务端 error 帧的机器码（与 shared/net-error-codes.mjs 保持同一套值） */
export const ERR_ROOM_NOT_FOUND = "room_not_found";
export const ERR_ROOM_FULL = "room_full";
export const ERR_ROOM_PLAYING = "room_playing";
export const ERR_UNKNOWN = "unknown";

export type JoinErrorKind = "full" | "not_found" | "playing" | "unknown";

export interface JoinErrorDecision {
  kind: JoinErrorKind;
  /** 是否值得重试（只有「本局进行中」值得：等本局结束再点一次） */
  retry: boolean;
  /** 判定依据：服务端机器码 or 旧服务端关键词兜底（便于自测/排障） */
  via: "code" | "msg";
}

/** code → 分档 */
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
  if (c) return { kind: "unknown", retry: false, via: "code" };  // 认得的码之外的码 → 明确不重试，别瞎猜
  const byMsg = kindOfMsg(m);
  return { kind: byMsg, retry: byMsg === "playing", via: "msg" };
}

/** 加入房间失败时给玩家看的话（文案与"重不重试"解耦：这里只产出文字） */
export function joinErrorText(kind: JoinErrorKind, roomId: number, rawMsg = ""): string {
  switch (kind) {
    case "full":
      return `邀请的房间 #${roomId} 已满，已停在大厅：请选别的桌或等一位空位（座位释放后重新点开邀请链接即可）`;
    case "not_found":
      return `邀请链接里的房间 #${roomId} 已不存在，已停在大厅：请向好友要新链接，或自行选桌/开房`;
    case "playing":
      return `邀请房间 #${roomId} 本局进行中，等本局结束…`;
    default:
      return `邀请房间 #${roomId} 加入失败（${rawMsg}），已停在大厅：请自行选桌/开房`;
  }
}
