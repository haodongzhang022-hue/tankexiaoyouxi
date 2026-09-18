//  src/net/InviteLink.ts ─ 邀请链接的「房间号绑定」纯逻辑（单一事实源，可单测）
//
//  设计目标（对应需求）：
//    · 邀请链接**带房间号** → 好友打开后直接坐到该房间的座位上；
//    · 邀请链接**不带房间号**（大厅链接）→ 好友打开后进大厅，自己选桌/开房，不占座位。
//
//  规则：
//    · 房间号 = 服务器桌号（与大厅列表里的桌 ID 一致，稳定不变），不是房间名文字；
//    · 房间号非法（空 / 非数字 / 0 / 负数 / 小数）= 视为「不带房间号」→ 进大厅。
//  与 main.ts 解耦，便于单测锁死行为（曾经踩过：?room= 被静默忽略 / 链接不带房号）。

/** 服务端桌号的合法范围：正整数。 */
export function isValidRoomId(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Number.isInteger(n);
}

/**
 * 解析邀请链接里的房间号。
 * 兼容 ?room= / ?r= / ?table= 三种写法（分享出去的链接可能被手动改过、或被旧链接沿用）。
 * @param search location.search（可带前导 ?，也可不带）
 * @returns 合法桌号；没有或非法 → null（调用方据此走「进大厅」分支）
 */
export function parseInviteRoom(search: string): number | null {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of ["room", "r", "table"]) {
    const raw = qs.get(key);
    if (raw === null || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    // 该参数存在但非法（?room=abc）→ 继续看下一个别名，全都不合法才算「不带房间号」
  }
  return null;
}

/** 从 URL 里去掉所有房间号参数（生成「大厅链接」用）。 */
export function stripRoomParams(search: string): string {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of ["room", "r", "table"]) qs.delete(key);
  return qs.toString();
}

/**
 * 生成邀请链接（带房间号）。
 * @param base  入口地址（协议+主机+路径，不含 query），例如 https://game.example.com/
 * @param roomId 服务器桌号
 * @param extraQuery 额外入口参数（如 ?server=ws://...），可为空
 */
export function buildInviteUrl(base: string, roomId: number, extraQuery = ""): string {
  const qs = new URLSearchParams(extraQuery.startsWith("?") ? extraQuery.slice(1) : extraQuery);
  qs.set("room", String(roomId));           // 带房间号 = 直接进该房座位
  return `${base}${base.includes("?") ? "&" : "?"}${qs.toString()}`;
}
