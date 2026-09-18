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
//   · **绑定只由服务器按「可信来源」维护**（不是客户端心跳自报）：
//     服务器每 15s（ENTRY_SWEEP_MS）按可信来源重算「当前入口」并 re-bind 一次，
//     所以只要进程活着，sid 这条绑定就被持续续期，不会因为「没人连着」而过期；
//     ENTRY_TTL_MS（5 分钟）约束的是**超过 5 分钟没被任何刷新碰过**的陈旧条目（sweep 顺手清掉）。
//     ⚠ 曾经的注释写「客户端 ping/pong 心跳上报地址 → 5 分钟无心跳自动解绑」，与实现不符：
//       请求方自报的 Host/地址**从不**参与绑定（可伪造，会把分享链接指向攻击者域名，见 PR #7 评审 🔴1）。
//   · **不额外延迟**：匹配只发生在打开链接的**第一步**（一次 302），进入房间后的通道不变。
import crypto from "node:crypto";

/** 稳定入口的路径形状：/<sid>/join/<roomId>（sid = 服务器内部 id） */
export const SID_LEN = 8;
export const SID_RE = new RegExp(`^[0-9a-f]{${SID_LEN}}$`);
export const ENTRY_TTL_MS = 5 * 60 * 1000;          // 绑定「超过这么久没被刷新碰过」即视为陈旧
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

/** 地址里是否残留模板占位符（如 `{{port}}` / `{{PORT}}`）—— 这种地址绝不能当 302 目标 */
export function hasTemplatePlaceholder(s) {
  return /\{\{|\}\}/.test(String(s || ""));
}

/** origin → host（含端口，小写）；非法返回 "" */
export function hostOfOrigin(origin) {
  try { return new URL(String(origin)).host.toLowerCase(); } catch { return ""; }
}

/** 主机名（不含端口，小写；IPv6 去掉方括号）；非法返回 "" */
export function hostnameOf(origin) {
  try { return new URL(String(origin)).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return ""; }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 是不是 IP 字面量（IPv4 点分 / IPv6 含冒号） */
export function isIpLiteral(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return IPV4_RE.test(h) || h.includes(":");
}

/**
 * IP 归属：loopback（回环）/ private（私网·链路本地·CGNAT）/ public（公网）/ invalid（不可用）。
 * 只按字面量判断，不做 DNS 解析（入口地址一律由可信来源给出，不解析、不联网）。
 */
export function ipScope(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const m = IPV4_RE.exec(h);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return "invalid";
    if (a === 127) return "loopback";
    if (a === 0 || a >= 224) return "invalid";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 169 && b === 254) return "private";          // 链路本地
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT（运营商大内网，外网不可达）
    return "public";
  }
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return "loopback";
    if (/^f[cd]/.test(h)) return "private";      // ULA fc00::/7
    if (/^fe[89ab]/.test(h)) return "private";   // 链路本地 fe80::/10
    return "public";
  }
  return "invalid";
}

/**
 * 判断一个 origin 能不能当「对外可分享的入口」，并给出理由。
 * @param {string} origin 形如 http(s)://host[:port]
 * @param {{allowPrivateIp?:boolean}} [opts] 可信来源**显式登记**时可放行私网/局域网 IP
 *        （无域名部署形态：http://192.168.1.50:3001 同 WiFi 分享；公网 IP 形态也走这里）。
 * @returns {{ok:boolean, origin:string, host:string, hostname:string, kind:"ip"|"domain", scope:string, reason:string}}
 */
export function originScope(origin, opts = {}) {
  const raw = String(origin || "").trim();
  const bad = (reason) => ({ ok: false, origin: "", host: "", hostname: "", kind: "domain", scope: "invalid", reason });
  if (!raw) return bad("空地址");
  if (hasTemplatePlaceholder(raw)) return bad("地址里残留未替换的模板占位符");
  let u;
  try { u = new URL(raw); } catch { return bad("不是合法 URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return bad("只支持 http/https 入口");
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || /[\s{}/\\]/.test(hostname)) return bad("主机名非法");
  const kind = isIpLiteral(hostname) ? "ip" : "domain";
  let scope;
  if (kind === "ip") {
    scope = ipScope(hostname);
    if (scope === "invalid") return bad("非法 IP");
  } else if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    scope = "loopback";
  } else if (hostname.endsWith(".local")) {
    scope = "private";
  } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    return bad("域名形态非法（需要至少两段，如 game.example.com）");
  } else {
    scope = "public";
  }
  if (scope === "loopback" || scope === "invalid") return bad("回环/非法地址不能当对外入口");
  if ((scope === "private" || scope === "linklocal") && !opts.allowPrivateIp) {
    return bad("私网/局域网 IP 只能由可信来源显式登记（避免把好友送到他自己家的内网）");
  }
  return { ok: true, origin: normalizeOrigin(raw), host: u.host, hostname, kind, scope, reason: "" };
}

/**
 * 从候选列表里取第一个可用 origin（仅规整，不做可信性判断 —— 可信性由调用方负责）。
 * v3.0.2：服务器已改为「按优先级分别校验」的写法（显式登记 > 平台模板 > 保持现状），
 * 这个"挑第一个非空"的旧工具没有调用方了，保留会让读者以为还存在"候选表顺序 = 优先级"的隐式约定。
 */

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

  /** 查一条绑定；过期（超过 TTL 没被刷新）/未知返回 null */
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
