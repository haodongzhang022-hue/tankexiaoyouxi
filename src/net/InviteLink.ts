//  src/net/InviteLink.ts ─ 邀请链接的「房间号绑定」纯逻辑（单一事实源，可单测）
//
//  设计目标（对应需求）：
//    · 邀请链接**带房间号** → 好友打开后直接坐到该房间的座位上；
//    · 邀请链接**不带房间号**（大厅链接）→ 好友打开后进大厅，自己选桌/开房，不占座位。
//
//  规则：
//    · 房间号 = 服务器桌号（与大厅列表里的桌 ID 一致，稳定不变），不是房间名文字；
//    · 房间号只认**十进制正整数**（`/^\d+$/`）——`0x10`/`1e3`/`0b11`/`+5`/`1.5`/`0`/负数
//      一律视为「不带房间号」→ 进大厅（`Number()` 会把前几种都当数字，语义太宽，故显式收窄）；
//    · 房间号非法 = 视为「不带房间号」→ 进大厅。
//  与 main.ts 解耦，便于单测锁死行为（曾经踩过：?room= 被静默忽略 / 链接不带房号）。

/** 服务端桌号的合法范围：正整数（十进制、有限、整数、> 0）。 */
export function isValidRoomId(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Number.isInteger(n);
}

/**
 * 解析邀请链接里的房间号。
 * 兼容 `?room=` / `?r=` / `?table=` 三种写法（`?r=`/`?table=` **仅为兼容历史分享链接**，
 * 新链接只用 `?room=`；三者为「先到先得」：某个别名非法就继续看下一个别名）。
 * @param search location.search（可带前导 ?，也可不带）
 * @returns 合法桌号；没有或非法 → null（调用方据此走「进大厅」分支）
 */
export function parseInviteRoom(search: string): number | null {
  const qs = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of ["room", "r", "table"]) {
    const raw = qs.get(key);
    if (raw === null || raw.trim() === "") continue;
    // 只认十进制正整数：0x10/1e3/0b11/1.5/12.0/前导正负号 一律不算房号
    // （注意不 trim：URLSearchParams 会把 "?room=+5" 解成 " 5"，那也不是十进制整数写法）
    if (!/^\d+$/.test(raw)) continue;
    const n = Number(raw);
    if (isValidRoomId(n)) return n;              // 与 isValidRoomId 同一口径（0/负数/小数在这里被拦下）
    // 该参数存在但非法（?room=abc）→ 继续看下一个别名，全都不合法才算「不带房间号」
  }
  return null;
}

/**
 * 生成邀请链接（带房间号）。
 * @param base  入口地址（协议+主机+路径；不含 query 时最常用，含 query 也支持）
 * @param roomId 服务器桌号（必须合法，调用方先校验）
 * @param extraQuery 额外入口参数（如 ?server=ws://...），可为空
 */
export function buildInviteUrl(base: string, roomId: number, extraQuery = ""): string {
  const qs = new URLSearchParams(extraQuery.startsWith("?") ? extraQuery.slice(1) : extraQuery);
  qs.set("room", String(roomId));           // 带房间号 = 直接进该房座位
  return `${base}${base.includes("?") ? "&" : "?"}${qs.toString()}`;
}

/**
 * 生成「大厅链接」（不带房间号）：好友打开后进大厅自己选桌/开房，不占座位。
 * 直接由入口地址 + 额外参数构造（不再绕道 buildInviteUrl(roomId) 再删房号 ——
 * 那会先生成一条非法房号链接，且依赖"room=0 非法"这条未声明的隐式契约）。
 * @param base 入口地址（协议+主机+路径，不含 query）
 * @param extraQuery 额外入口参数（如 ?server=ws://...），可为空
 */
export function buildLobbyUrl(base: string, extraQuery = ""): string {
  const qs = new URLSearchParams(extraQuery.startsWith("?") ? extraQuery.slice(1) : extraQuery);
  for (const key of ["room", "r", "table"]) qs.delete(key);   // 防御：额外参数里带房号也去掉
  const q = qs.toString();
  if (!q) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${q}`;
}
