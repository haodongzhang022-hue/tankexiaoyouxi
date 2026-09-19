// shared/net-error-codes.mjs ── 联机 error 帧的**机器码**分类桶（单一事实源）
//
// 为什么要有它（Issue #16 D1）：
//   前端曾用 `msg.includes("已满") / ("不存在") / ("对局中")` 判断"这条错误还能不能重试"。
//   一旦服务端改文案（本地化、加前缀、换词），前端就会**静默落到"未知错误 → 停止重试"**分支：
//     ·「不存在」→ 退化成通用"加入失败"，不再提示"要新链接"；
//     ·「对局中」→ 直接放弃重试，丢掉"等本局结束再进"的能力。
//   现在：服务端 error 帧额外带 `code`（本文件的机器码），前端**只按 code 分档**，文案只做展示。
//
// 兼容策略（重要）：
//   `code` 是**新增的可选字段**。新前端 + 旧服务端（没有 code）时，前端回落到关键词兜底
//   （见 src/net/JoinError.ts 的 classifyJoinError），所以混版本部署不会退化成"未知错误"。
//
// 命名口径：`<对象>_<原因>`，小写下划线，稳定不变（可当协议契约用）。

/** 房间号在服务器上不存在（邀请链接已失效 / 房号打错） */
export const ERR_ROOM_NOT_FOUND = "room_not_found";
/** 房间坐满了（4 座全占） */
export const ERR_ROOM_FULL = "room_full";
/** 房间正在对局中（等本局结束再进；唯一"值得重试"的加入错误） */
export const ERR_ROOM_PLAYING = "room_playing";
/** 已经在某张桌子内了 */
export const ERR_ALREADY_IN_TABLE = "already_in_table";
/** 只有房主能做这个操作（更改方向 / 开局） */
export const ERR_HOST_ONLY = "host_only";
/** 开局前置条件不满足（没人 / 有人没准备） */
export const ERR_START_PRECONDITION = "start_precondition";
/** 没有可重连的对局（令牌失效 / 对局已结束） */
export const ERR_NO_REJOIN = "no_rejoin";
/** 其它未分类错误（客户端按"未知错误 → 不重试"处理，并把原文展示出来） */
export const ERR_UNKNOWN = "unknown";

/** 加入房间时"值得重试"的码：本局进行中 → 等本局结束再点一次 */
export const RETRYABLE_JOIN_CODES = new Set([ERR_ROOM_PLAYING]);

/** 判断一个 error 帧的 code 是否属于"加入房间值得重试" */
export function isRetryableJoinCode(code) {
  return RETRYABLE_JOIN_CODES.has(String(code || ""));
}
