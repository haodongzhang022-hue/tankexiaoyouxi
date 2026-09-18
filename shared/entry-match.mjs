// shared/entry-match.mjs ─ 「稳定入口 ↔ 当前临时地址」的自动匹配表（单一事实源）
//
// 背景（为什么要做这个）：
//   平台/隧道给出的地址会变（云原生开发环境重建换域名、隧道重开换域名、服务器更换 IP），
//   但玩家手里的**分享链接**是固定的。于是需要一个机制：
//     固定链接（稳定入口）  ──自动匹配──▶  当前实际在用的临时地址
//   服务器每隔几秒刷新自己的「当前入口」，并把它上报给匹配表；
//   玩家点固定链接打开时，由匹配表把它 302 到最新地址 —— 环境重建/换域名都不用手动改链接。
//
// 设计要点：
//   · **服务器内部 id 恒定**：只要环境没重启（进程还在），内部 id 永远是 sid（8 位十六进制）；
//     链接 `/<sid>/join/<roomId>` 因此是稳定的；重建/重启后内部 id 会变，但会自动匹配到新的临时地址。
//   · **关系自动维护**：客户端每次 ping/pong 心跳都会上报自己当前连着的地址，
//     服务器据此把「稳定入口 → 临时地址」自动绑定，5 分钟无心跳自动解绑（陈旧地址不会一直挂着）。
//   · **不额外延迟**：匹配只发生在打开链接的**第一步**（一次 302），进入房间后的通道不变。
import crypto from "node:crypto";

/** 稳定入口的路径形状：/<sid>/join/<roomId>（sid = 服务器内部 id） */
export const SID_LEN = 8;
export const SID_RE = new RegExp(`^[0-9a-f]{${SID_LEN}}$`);
export const ENTRY_TTL_MS = 5 * 60 * 1000;          // 绑定无心跳存活时间
export const ENTRY_SWEEP_MS = 15 * 1000;            // 后台清理周期
export const ENTRY_KEEPALIVE_MS = 60 * 1000;        // 云原生环境最长回收窗口内保活一次

/** 生成服务器内部 id（环境重建/进程重启后自动换新） */
export function makeSid() {
  return crypto.randomBytes(SID_LEN / 2).toString("hex");
}

/** 稳定入口路径（不含域名；域名由「谁把链接发出去」决定，换域名不影响路径） */
export function entryPath(sid, roomId = null) {
  return roomId == null ? `/${sid}/join/` : `/${sid}/join/${roomId}`;
}

/** 把「当前地址」规整成可比较的 origin（去尾斜杠、去 query/hash） */
export function normalizeOrigin(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url));
    const host = u.host.replace(/:80$/, "").replace(/:443$/, "");   // http:80 / https:443 是默认端口，去掉更干净
    return `${u.protocol}//${host}`;
  } catch { return ""; }
}

/** 从请求里取「当前入口地址」：优先平台预览地址（https），其次 Host 头拼出来的地址 */
export function currentOrigin(candidates) {
  for (const c of candidates || []) {
    const o = normalizeOrigin(c);
    if (o) return o;
  }
  return "";
}

/**
 * 稳定入口 → 当前临时地址 的自动匹配表。
 * @param {string} sid 服务器内部 id（恒定，直到进程重启）
 * @param {{now?:()=>number}} [opts] 便于测试注入时钟
 */
export function createEntryMatcher(sid, opts = {}) {
  const now = opts.now || (() => Date.now());
  /** key = sid 或条目 id；value = { id, sid, roomId, current, at, hits } */
  const table = new Map();

  const keyOf = (id) => String(id || "").trim();

  /** 登记/刷新一条绑定：稳定入口 id → 当前地址；返回条目（含 roomId 供进房用） */
  function bind(id, current, roomId = null) {
    const k = keyOf(id);
    const cur = normalizeOrigin(current);
    if (!k || !SID_RE.test(k) || !cur) return null;      // sid 形状不对/地址无效：不登记（不瞎猜）
    const prev = table.get(k);
    let rid = roomId == null ? null : Number(roomId);
    if (!Number.isFinite(rid) || rid <= 0) rid = prev?.roomId ?? null;
    const entry = { id: k, sid, roomId: rid, current: cur, at: now(), hits: prev?.hits ?? 0 };
    table.set(k, entry);
    return entry;
  }

  /** 查一条绑定；过期（超过 TTL 无心跳）/未知返回 null */
  function lookup(id) {
    const e = table.get(keyOf(id));
    if (!e) return null;
    if (now() - e.at > ENTRY_TTL_MS) { table.delete(e.id); return null; }
    e.hits++;
    return e;
  }

  function sweep() {
    const t = now();
    for (const [k, e] of table) if (t - e.at > ENTRY_TTL_MS) table.delete(k);
  }

  function size() { return table.size; }
  function list() {
    return [...table.values()].map((e) => ({ id: e.id, roomId: e.roomId, current: e.current, ageMs: now() - e.at, hits: e.hits }));
  }
  return { sid, bind, lookup, sweep, size, list };
}
