// src/net/entry-match.test.mjs ─ 稳定入口（稳定链接 ↔ 当前临时地址）自测
//
// 运行：npm run net:entry-test     （node --test，退出码 0 = 全绿）
//
// 覆盖：
//   匹配表：绑定 / 查询 / 过期清条 / 形状校验（不瞎猜）
//   origin 判定：回环 / 私网 / 公网 IP / 域名 / 残留占位符（纯逻辑）
//   服务器：/<sid>/join/<room> 302（带 ?room）、老域名自动跟到当前地址、
//           换新 sid 给可操作提示页、不误伤 / 与静态资源
//   🔴 回归（Issue #15）：匿名 /entry/localtip（?origin= 攻击者域名/公网 IP，含伪造 x-forwarded-*）
//           一律 403、不得改写入口、不得落盘；带部署令牌的合法自救仍可用（公网 IP / 域名）
//   🔴 回归（PR #7 评审）：伪造 Host 的匿名 HTTP 请求**不得**改写「当前入口」，
//           即分享出去的稳定链接不可能被一条 curl 指向攻击者域名
//   🔴 回归（Issue #15）：**匿名请求不得改写「当前入口」** —— `/entry/localtip` 曾经无令牌即可
//           改写入口并落盘（一条 curl 把分享链接 302 到攻击者域名，重启仍生效）。
//           现在只放行「带令牌」或「本机/同内网自救（上报地址 = 本机网卡 IP + 私网/回环对端）」；
//           任意公网域名/公网 IP 一律 403，且已落盘的入口不变（不持久化劫持）。
//   🔴 回归（Issue #11 评审 🔴2）：**IP / 局域网形态部署**（deploy/ 主推形态）带令牌登记后，
//           稳定链接必须 302 到**那个 IP**（不是访问者自己的 127.0.0.1）；没有入口时给提示页
//   🔴 回归（Issue #11 评审 🔴3）：模板里含**残留占位符**（{{port}} 大小写/拼写变化）时，
//           绝不允许它成为「当前入口」（否则全量分享链接 302 到死链）
//   🟡 回归：显式登记优先级最高（不被下一次平台模板刷新顶回）、响应返回真实落盘值；
//           令牌文件 0600 + 不跟随符号链接（低权进程读不到）
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEntryMatcher, entryPath, makeSid, normalizeOrigin, SID_RE, originScope, ipScope, hasTemplatePlaceholder, localTipAllowedFor } from "../../shared/entry-match.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "..", "..", "server", "index.mjs");
const SID = "11223344";

// ── 匹配表（纯逻辑，无网络）────────────────────────────────────────
test("匹配表：绑定的稳定入口能查到当前地址", () => {
  const m = createEntryMatcher(makeSid());
  const e = m.bind(SID, "https://a.example.com/", 7);
  assert.equal(e.current, "https://a.example.com");
  assert.equal(m.lookup(SID).current, "https://a.example.com");
  assert.equal(m.size(), 1);
});

test("匹配表：地址/形状不合法时不登记（不瞎猜）", () => {
  const m = createEntryMatcher(makeSid());
  assert.equal(m.bind(SID, ""), null);
  assert.equal(m.bind("not-a-sid", "https://a.example.com"), null);
  assert.equal(m.size(), 0);
});

test("匹配表：超过 TTL 未刷新的条目被清掉（服务器每 15s 刷新会持续续期）", () => {
  let now = 1_000_000;
  const m = createEntryMatcher(makeSid(), { now: () => now });
  m.bind(SID, "https://a.example.com");
  now += 5 * 60 * 1000 + 1;
  assert.equal(m.lookup(SID), null, "超过 TTL 未刷新应查不到");
  assert.equal(m.size(), 0, "过期条目应被清掉");
  now += 1000;
  m.bind(SID, "https://b.example.com");
  now += 4 * 60 * 1000;
  assert.ok(m.lookup(SID), "4 分钟内应仍然有效");
});

test("路径与 origin 工具：entryPath / normalizeOrigin / originScope / ipScope", () => {
  assert.equal(entryPath(SID), `/${SID}/join/`);
  assert.equal(entryPath(SID, 12), `/${SID}/join/12`);
  assert.equal(normalizeOrigin("https://a.example.com:443/x?y=1#z"), "https://a.example.com");
  assert.equal(normalizeOrigin("http://1.2.3.4:3001/?room=7"), "http://1.2.3.4:3001");
  assert.ok(SID_RE.test(makeSid()));

  // 回环 / 私网 / 公网 / 域名
  assert.equal(ipScope("127.0.0.1"), "loopback");
  assert.equal(ipScope("192.168.1.50"), "private");
  assert.equal(ipScope("10.0.0.5"), "private");
  assert.equal(ipScope("172.20.3.4"), "private");
  assert.equal(ipScope("169.254.1.1"), "private");
  assert.equal(ipScope("100.64.0.1"), "private");
  assert.equal(ipScope("203.0.113.9"), "public");
  assert.equal(ipScope("8.8.8.8"), "public");
  assert.equal(ipScope("999.1.1.1"), "invalid");

  // 默认（匿名/非登记路径）：公网 IP 可用、私网 IP 与回环不可用
  assert.equal(originScope("http://203.0.113.9:3001").ok, true, "公网 IP 应当可用（无域名部署形态）");
  assert.equal(originScope("https://game.example.com").ok, true);
  assert.equal(originScope("http://192.168.1.50:3001").ok, false, "私网 IP 默认不可用");
  assert.equal(originScope("http://192.168.1.50:3001", { allowPrivateIp: true }).ok, true, "可信来源显式登记可放行");
  assert.equal(originScope("http://127.0.0.1:3001", { allowPrivateIp: true }).ok, false, "回环永远不可用");
  assert.equal(originScope("http://localhost:3001").ok, false);
  assert.equal(originScope("").ok, false);

  // 🔴3 残留占位符 / 域名形态
  assert.equal(hasTemplatePlaceholder("https://env-{{port}}.cnb.run"), true);
  assert.equal(originScope("https://env-{{port}}.cnb.run").ok, false, "含残留占位符的地址绝不能当入口");
  assert.equal(originScope("https://env-{{PORT}}.cnb.run").ok, false);
  assert.equal(originScope("ftp://game.example.com").ok, false, "只支持 http/https");
});

// ── Issue #15：/entry/localtip 准入判定（纯逻辑，与服务器同一份实现）────
test("🔴 回归（Issue #15）：可达性上报准入 —— 匿名公网域名/IP 一律拒，只认「本机 IP + 私网对端」", () => {
  const own = ["192.168.1.50", "172.17.0.8"];
  // ① 钓鱼入口的写法：任意公网域名 / 任意公网 IP —— 一律拒（这正是本 Issue 的复现姿势）
  for (const tip of ["http://phish.example.net", "http://203.0.113.9:3001", "https://evil.example.com:3001"]) {
    const r = localTipAllowedFor({ tip, peerIp: "172.17.0.1", ownIps: own });
    assert.equal(r.ok, false, `${tip} 必须被拒`);
    assert.ok(r.reason, "被拒必须给原因（不能静默）");
  }
  // ② 本机网卡自己的 IP + 同内网对端 → 放行（Issue #11 的房主同 WiFi 自救）
  const ok = localTipAllowedFor({ tip: "http://192.168.1.50:3001", peerIp: "192.168.1.9", ownIps: own });
  assert.equal(ok.ok, true, "本机 LAN IP + 同内网对端应放行");
  assert.ok(ok.via);
  // 回环对端（本机打开）同样放行
  assert.equal(localTipAllowedFor({ tip: "http://172.17.0.8:3001", peerIp: "127.0.0.1", ownIps: own }).ok, true);
  // 双栈监听下 IPv4 对端带 ::ffff: 前缀也要认（否则私网对端会被误判成 public）
  assert.equal(localTipAllowedFor({ tip: "http://172.17.0.8:3001", peerIp: "::ffff:192.168.1.9", ownIps: own }).ok, true);

  // ③ 外网对端即使猜到本机 IP，也不得改写全局入口
  const far = localTipAllowedFor({ tip: "http://192.168.1.50:3001", peerIp: "203.0.113.9", ownIps: own });
  assert.equal(far.ok, false, "公网来源不得匿名改写入口");
  assert.match(far.reason, /不是本机\/同内网/);

  // ④ 回环/非法地址仍旧一律不可当入口（准入不放松）
  for (const tip of ["http://127.0.0.1:3001", "http://localhost:3001", "not-a-url", ""]) {
    assert.equal(localTipAllowedFor({ tip, peerIp: "192.168.1.9", ownIps: own }).ok, false, `${tip} 不得成为入口`);
  }
});

// ── 服务器（真起进程 + 真发 HTTP）──────────────────────────────────
/**
 * 起一台服务器（随机端口 + 固定 sid），等 /healthz 就绪后回调。
 * @param {{env?:object, tokenFile?:string, tokenMode?:number, tokenSymlink?:string}} [opts]
 */
async function startServer(opts = {}) {
  const port = 34000 + Math.floor(Math.random() * 2000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tank-entry-"));
  const tokenFile = opts.tokenFile || path.join(dir, "token");
  if (opts.tokenSymlink) {
    // 预先放一个**指向别处**的符号链接（模拟"令牌路径是符号链接"的部署），目标文件预置 0666
    fs.writeFileSync(opts.tokenSymlink, "attacker-placeholder\n", { mode: 0o666 });
    try { fs.symlinkSync(opts.tokenSymlink, tokenFile); } catch { /* 不支持符号链接则跳过该场景 */ }
  } else if (opts.tokenMode != null) {
    fs.writeFileSync(tokenFile, "preset-token\n", { mode: opts.tokenMode });
  }
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      TANK_SID: SID,
      TANK_ENTRY_TOKEN_FILE: tokenFile,
      TANK_KEEPALIVE: "0",
      PUBLIC_URL_FILE: path.join(dir, "public-url.txt"),
      // 默认关掉「服务器自找入口」：老用例锁的是「没有可信来源时 current 必须为空」，
      // 自动登记会把它变成非空 → 老回归锁失效。要测自动登记的用例显式打开（TANK_AUTO_ENTRY=1）。
      TANK_AUTO_ENTRY: "0",
      // 清掉可能存在的预览模板：本测试要的是「没有可信来源时 current 保持为空」
      CNB_VSCODE_PROXY_URI: "",
      CNB_VSCODE_PROXY_URI_HTTPS: "",
      CNB_PROXY_URI: "",
      CNB_PORT_PREVIEW_URI: "",
      CNB_PREVIEW_URI: "",
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += String(d); });
  child.stderr.on("data", (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(base + "/healthz");
      if (r.ok) {
        await r.json();
        break;
      }
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error("服务器 15s 内未就绪：\n" + log);
    await new Promise((r) => setTimeout(r, 150));
  }
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch { /* 符号链接被挡 / 未落盘 */ }
  return {
    port, base, token, tokenFile, dir, log: () => log,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 发一个带自定义 Host 的 GET，拿 { status, location, body }（redirect: manual，不发第二次请求） */
function rawGet(url, { host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: { ...(host ? { Host: host } : {}), ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location || "", body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const health = async (base) => (await fetch(base + "/healthz")).json();
async function redirectOf(url, opts) {
  const r = await rawGet(url, opts);
  return { status: r.status, location: r.location, body: r.body };
}
/** 带令牌登记入口；返回 { status, json } */
async function register(base, url, token, headers = {}) {
  const res = await fetch(`${base}/entry/register?url=${encodeURIComponent(url)}`, {
    headers: { ...(token ? { "X-Tank-Entry-Token": token } : {}), ...headers },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * 模拟「外部世界」：socket 连本机端口，但 URL 里用真实域名、Host 头也写这个域名。
 * 用来验证「稳定链接的 302 目标由服务器自己决定，不由访问者自报的 Host 决定」。
 */
async function viaExternal(url, { host, headers } = {}) {
  const u = new URL(url);
  return redirectOf(`http://127.0.0.1:${u.port}${u.pathname}${u.search}`, { host: host ?? u.hostname, headers });
}

test("🔴 回归：无客户端连接时，仅凭伪造 Host 的匿名请求不得改写「当前入口」", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  // 1) 起服务，current 为空（本机自测无公网预览模板 = 没有可信来源）
  assert.equal((await health(s.base)).current, null, "初始不应有当前入口");

  // 2) 【复现原漏洞的姿势】外部攻击者：Host 自报 evil.example.com 打各条公开路由
  for (const target of ["/healthz", `/healthz?probe_token=deadbeef`, `/entry/${SID}`, `/${SID}/join/7`]) {
    const r = await viaExternal(`http://evil.example.com:${s.port}${target}`, { host: "evil.example.com" });
    assert.ok(r.status >= 200 && r.status < 400, `${target} 应正常响应（不被劫持影响）`);
    assert.ok(!/evil\.example\.com/.test(String(r.location)), `${target} 不得跳到攻击者域名`);
  }
  const forged = await rawGet(s.base + "/healthz", { host: "evil.example.com" });
  assert.equal(forged.status, 200);

  // 3) current 不得被劫持
  assert.equal((await health(s.base)).current, null, "伪造 Host 不得建立当前入口");

  // 4) 稳定链接不得把好友 302 到攻击者域名，也不得回退到访问者自己的 127.0.0.1
  const r = await viaExternal(`http://evil.example.com:${s.port}/${SID}/join/7`, { host: "evil.example.com" });
  assert.ok(!/evil\.example\.com/.test(String(r.location)), "稳定链接绝不能被 Host 劫持到攻击者域名");
  assert.equal(r.location, "", "没有可信入口时不得 302（应给提示页）");
  assert.ok(!/127\.0\.0\.1[^<]*\?room=/.test(r.body), "提示页里不得把好友指向他自己的 127.0.0.1");

  // 5) 错误的令牌 / 带攻击者域名的登记请求同样无效
  await rawGet(s.base + "/healthz?probe_token=deadbeef", { host: "evil2.example.com" });
  const badReg = await register(s.base, "https://evil.example.com", "deadbeef");
  assert.equal(badReg.status, 403, "错误令牌不得登记入口");
  assert.equal((await health(s.base)).current, null, "错误的令牌不得建立当前入口");
  assert.ok(!/evil\.example\.com|evil2\.example\.com/.test(s.log()), "攻击者域名不应被写入匹配表/日志");

  // 6) 已确立的当前入口 + 攻击者 Host：仍跳回当前入口，不被顶掉
  await register(s.base, "https://game.example.com", s.token);
  const r3 = await viaExternal(`http://evil.example.com:${s.port}/${SID}/join/7`, { host: "evil.example.com" });
  assert.equal(r3.location, "https://game.example.com/?room=7", "攻击者 Host 不得顶掉已确立的当前入口");
});

test("🔴 回归（Issue #11 🔴2）：IP 形态部署登记后，稳定链接 302 到那个 IP（不是 127.0.0.1）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  // deploy/Dockerfile + start-server.sh 主推形态：没有域名，只有「服务器公网 IP:端口」
  const r0 = await register(s.base, "http://203.0.113.9:3001", s.token);
  assert.equal(r0.status, 200, "带令牌登记公网 IP 必须成功（此前被 isShareableOrigin 一律拒收）");
  assert.equal(r0.json.applied, true);
  assert.equal(r0.json.current, "http://203.0.113.9:3001", "响应必须回真实生效值，不能是 200 + current:null");
  assert.equal((await health(s.base)).current, "http://203.0.113.9:3001");

  // 好友点稳定链接 → 302 到那台服务器，而不是他自己机器的 127.0.0.1
  const r = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(r.status, 302);
  assert.equal(r.location, "http://203.0.113.9:3001/?room=7");
  assert.ok(!/127\.0\.0\.1/.test(r.location), "绝不能把好友送到他自己的回环地址");

  // 攻击者再伪造 Host，也顶不掉这个 IP 入口
  const r2 = await viaExternal(`http://evil.example.com:${s.port}/${SID}/join/9`, { host: "evil.example.com" });
  assert.equal(r2.location, "http://203.0.113.9:3001/?room=9");

  // 局域网 IP（同 WiFi 分享）同样有效：可信来源显式登记即可
  const r3 = await register(s.base, "http://192.168.1.50:3001", s.token);
  assert.equal(r3.json.current, "http://192.168.1.50:3001");
  const r4 = await redirectOf(`${s.base}/${SID}/join/3`);
  assert.equal(r4.location, "http://192.168.1.50:3001/?room=3");
});

test("🔴 回归（Issue #11 🔴2）：没有入口时给可操作提示页（含登记命令），绝不回退 127.0.0.1", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const r = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(r.status, 200, "提示页用 200，浏览器可直接看到");
  assert.equal(r.location, "", "没有入口时不得 302");
  assert.match(r.body, /还没有对外入口/, "应说明「服务器还没有对外入口」");
  assert.match(r.body, /entry\/register/, "应给出可操作的登记命令");
  assert.ok(!/http:\/\/127\.0\.0\.1:\d+\/\?room=/.test(r.body), "不得把好友指向他自己的回环地址");
});

test("🔴 回归（Issue #11 🔴3）：模板含残留占位符时不得成为「当前入口」", async (t) => {
  // 平台变量拼写变化（大小写等）→ {{PORT}} 替不掉；旧实现把它原样当 current，全量链接 302 到死链
  const bad = await startServer({ env: { CNB_VSCODE_PROXY_URI: "https://env-{{PORT}}.cnb.run" } });
  t.after(() => bad.stop());
  assert.equal((await health(bad.base)).current, null, "残留 {{PORT}} 的模板必须作废");
  const r = await redirectOf(`${bad.base}/${SID}/join/7`);
  assert.equal(r.location, "", "作废后不得 302");
  assert.match(r.body, /还没有对外入口/);

  // 另一种坏模板：环境 ID 被一起吃掉的写法（旧实现的 replace(/-0\./, ".") 产物）不该再出现
  const bad2 = await startServer({ env: { CNB_VSCODE_PROXY_URI: "https://abc-{{port}}.cnb.run" } });
  t.after(() => bad2.stop());
  assert.equal((await health(bad2.base)).current, `https://abc-${bad2.port}.cnb.run`, "端口占位符应被正确替换成端口");
  const r2 = await redirectOf(`${bad2.base}/${SID}/join/7`);
  assert.equal(r2.location, `https://abc-${bad2.port}.cnb.run/?room=7`, "入口必须是可用的完整地址");
  assert.ok(!/\{\{/.test(r2.location), "302 目标里绝不能有残留占位符");

  // 平台变量拼写正常 → 模板仍然照常生效（别把好路径一起修坏）
  const ok = await startServer({ env: { CNB_VSCODE_PROXY_URI: "https://env-5201-{{port}}.cnb.run" } });
  t.after(() => ok.stop());
  assert.equal((await health(ok.base)).current, `https://env-5201-${ok.port}.cnb.run`);
});

test("🔴 回归（Issue #11 🔴2）：未授权的私网/回环地址不能当入口", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  for (const bad of ["http://127.0.0.1:3001", "http://localhost:3001", "http://0.0.0.0:3001", "not-a-url"]) {
    const r = await register(s.base, bad, s.token);
    assert.ok(r.status >= 400, `${bad} 应被拒（HTTP ${r.status}）`);
    assert.equal(r.json.ok, false);
    assert.ok(r.json.error, `${bad} 被拒时必须给出原因（不能静默）`);
  }
  assert.equal((await health(s.base)).current, null, "被拒的地址不得生效");
});

test("🟡 回归（Issue #11 🟡1）：显式登记优先级最高，不被平台模板刷新顶回；响应回真实落盘值", async (t) => {
  const s = await startServer({ env: { CNB_VSCODE_PROXY_URI: "https://env-5201-{{port}}.cnb.run" } });
  t.after(() => s.stop());
  assert.equal((await health(s.base)).current, `https://env-5201-${s.port}.cnb.run`, "初始按平台模板");

  // 部署者显式登记自己的域名（如 cpolar / 自有域名）
  const r = await register(s.base, "https://my.cpolar.cn", s.token);
  assert.equal(r.json.applied, true);
  assert.equal(r.json.current, "https://my.cpolar.cn", "响应必须是落盘后的真实值");
  assert.equal(r.json.persisted, true, "应落盘（服务器重启后仍生效）");

  // 再打几次 /healthz（每次都走 refreshCurrentOriginFromTrusted）→ 不得被模板顶回
  for (let i = 0; i < 3; i++) {
    await health(s.base);
    assert.equal((await health(s.base)).current, "https://my.cpolar.cn", "显式登记不得被下一次刷新顶回");
  }
  const h = await health(s.base);
  assert.equal(h.currentSource, "register", "来源应标为 register");
  const r2 = await redirectOf(`${s.base}/${SID}/join/5`);
  assert.equal(r2.location, "https://my.cpolar.cn/?room=5");

  // 落盘文件确实写了（重启后仍生效的依据）
  assert.equal(fs.readFileSync(s.tokenFile + ".url", "utf8").trim(), "https://my.cpolar.cn");
});

test("🟡 回归（Issue #11 🟡3）：令牌文件 0600，且不跟随符号链接", async (t) => {
  // ① 预置 0644 的令牌文件 → 启动后必须被收成 0600
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tank-token-"));
  const tf = path.join(dir, "token");
  const s = await startServer({ tokenFile: tf, tokenMode: 0o644 });
  t.after(() => s.stop());
  const mode = fs.statSync(tf).mode & 0o777;
  assert.equal(mode, 0o600, `令牌文件权限应为 0600，实际 ${mode.toString(8)}`);

  // ② 令牌路径是符号链接（指向 0666 的目标）→ 不得把令牌写进目标文件
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tank-token2-"));
  const target = path.join(dir2, "target-0666");
  const link = path.join(dir2, "token-link");
  const s2 = await startServer({ tokenFile: link, tokenSymlink: target });
  t.after(() => s2.stop());
  const targetContent = fs.readFileSync(target, "utf8");
  assert.equal(targetContent.trim(), "attacker-placeholder", "符号链接目标不得被写入令牌（O_NOFOLLOW）");
  // 低权进程即使读到了这个 0666 目标文件，拿到的也只是垃圾 —— 用它登记必须 403
  const leaked = await register(s2.base, "https://phish.example.com", targetContent.trim());
  assert.equal(leaked.status, 403, "从符号链接目标读到的内容不得成为有效令牌");
  assert.equal((await health(s2.base)).current, null);
});

test("可信来源：带一次性令牌的部署探针可登记公网入口，稳定链接随之 302", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  assert.ok(s.token && s.token.length >= 16, "令牌应落盘");

  const denied = await register(s.base, "https://attacker.example.com", "");
  assert.equal(denied.status, 403);
  assert.equal((await health(s.base)).current, null);

  const ok = await register(s.base, "https://game.example.com", s.token);
  assert.equal(ok.status, 200);
  assert.equal((await health(s.base)).current, "https://game.example.com");

  const r = await redirectOf(`${s.base}/${SID}/join/12`);
  assert.equal(r.status, 302);
  assert.equal(r.location, "https://game.example.com/?room=12");
});

test("老域名打开稳定链接：自动跟到当前地址（换域名不用改链接）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await register(s.base, "https://new.example.com", s.token);

  const r = await redirectOf(`${s.base}/${SID}/join/3`, { host: "old.example.com" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "https://new.example.com/?room=3");
});

test("换新 sid：老链接给出可操作提示页而不是白屏 404", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const r = await redirectOf(`${s.base}/aabbccdd/join/1`);
  assert.equal(r.status, 200, "提示页用 200 便于浏览器直接看到");
  assert.match(r.body, /重新分享/, "应提示房主重新分享一条链接");
});

test("不误伤：/、静态资源、healthz、__whoami 都不受影响", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  // ⚠ dist 是否已构建：按**被测服务器所在目录**解析（与 __dirname 硬编码相对路径会让
  //    "拿旧版 server 跑新测试"这类对照场景假失败）
  const hasDist = fs.existsSync(path.join(path.dirname(SERVER), "..", "dist", "index.html"));
  const root = await redirectOf(s.base + "/");
  if (hasDist) assert.equal(root.status, 200, "/ 应返回 index.html");
  else assert.ok(root.status === 200 || root.status === 404, "/ 不应被入口路由吞掉（200 引导页 / 404 均可）");
  assert.equal(root.location, "", "/ 不应跳转到别处");
  assert.ok(!/evil\.example\.com/.test(root.body), "/ 页面里不应出现攻击者域名");

  const h = await fetch(s.base + "/healthz");
  assert.equal(h.status, 200);
  const hj = await h.json();
  assert.equal(hj.sid, SID);
  assert.equal(typeof hj.matched, "number");
  assert.equal(typeof hj.uptimeS, "number");
  assert.equal(typeof hj.clients, "number");
  assert.ok("currentSource" in hj, "/healthz 应暴露入口来源（便于部署者核对「登记到底生效没」）");

  const who = await fetch(s.base + "/__whoami");
  assert.equal(who.status, 200);
  assert.equal((await who.json()).kind, "game-server");

  const nope = await redirectOf(s.base + "/nope.txt");
  assert.equal(nope.status, 404, "未知静态文件仍是 404");
});

test("心跳保鲜：有客户端连着时 /healthz 的 lastClientSeenS 有值", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const before = (await health(s.base)).lastClientSeenS;
  assert.equal(before, null, "还没人连过 → null");

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}`);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  ws.send(JSON.stringify({ t: "ping", ts: Date.now() }));
  const pong = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("pong 超时")), 5000);
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.t === "pong") { clearTimeout(to); res(m); } });
  });
  assert.equal(pong.sid, SID, "pong 应回带 sid（客户端据此自动匹配）");
  ws.close();
  assert.equal(typeof (await health(s.base)).lastClientSeenS, "number", "有活人连过 → 有秒数");
});

// ── Issue #11 核心：玩家视角「打开就能玩」────────────────────────────
// 病根：入口只能靠「读得到 0600 令牌」的手动登记 → 非 root / 直接 node 跑的玩家拿不到入口，
//       点开邀请链接只看到「还没有对外入口」提示页。
// 修法：服务器启动时自己找一次对外入口（模板 → TANK_PUBLIC_ENTRY → 本机公网 IP → 局域网 IP）
//       并落盘；「可写令牌文件目录」= 部署者身份，所以 root / 非 root 都成立。

test("🔴 回归（Issue #11）：服务器自己登记本机入口 → 打开页面直接能玩，无需任何手动前置", async (t) => {
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "1", TANK_PUBLIC_ENTRY: "http://203.0.113.9:3001" } });
  t.after(() => s.stop());

  const h = await health(s.base);
  assert.equal(h.current, "http://203.0.113.9:3001", "启动即应有入口（不再要求玩家先跑 curl）");
  assert.equal(h.currentSource, "register");

  // 玩家点稳定链接 → 直接 302 进游戏，不是「还没有对外入口」拦路页
  const r = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(r.status, 302);
  assert.equal(r.location, "http://203.0.113.9:3001/?room=7");
  assert.ok(!/还没有对外入口/.test(r.body), "不该再看到「没有入口」拦住玩家");

  // 落盘 → 重启后依然生效（不依赖任何手动步骤）
  assert.equal(fs.readFileSync(s.tokenFile + ".url", "utf8").trim(), "http://203.0.113.9:3001");
});

test("🔴 回归（Issue #11）：显式登记优先级高于自动登记（自动登记不覆盖部署者选择）", async (t) => {
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "1", TANK_PUBLIC_ENTRY: "http://198.51.100.7:3001" } });
  t.after(() => s.stop());
  assert.equal((await health(s.base)).current, "http://198.51.100.7:3001");

  // 部署者随后显式登记自己的域名 → 必须以它为准，且不被自动登记/模板刷新顶回
  const r = await register(s.base, "https://my.domain.example", s.token);
  assert.equal(r.json.current, "https://my.domain.example");
  for (let i = 0; i < 3; i++) {
    await health(s.base);
    assert.equal((await health(s.base)).current, "https://my.domain.example", "显式登记必须一直赢");
  }
});

test("🔴 回归（Issue #11）：玩家访问到「非服务器入口」的地址时能看到自动自救入口", async (t) => {
  // 场景：反代/隧道把玩家送到了别的地址（页面与 WS 不同源），此时不能把玩家拦在「没有入口」页上——
  // 只要这个端口打得开，本机/内网访问者就必须看得到「直接开玩」的按钮与自动跳转。
  const s = await startServer();
  t.after(() => s.stop());

  const r = await rawGet(`${s.base}/${SID}/join/7`, { host: "127.0.0.1" });
  assert.equal(r.status, 200);
  assert.match(r.body, /还没有对外入口/);
  assert.match(r.body, /直接开玩/, "本机访问者应看到「直接开玩」入口");
  assert.match(r.body, /location\.replace\("\/"\)/, "本机访问者应被自动带回游戏页（而不是干等）");

  // 远程访问者（公网域名 Host）不该看到「本机直接开玩」的自动跳转
  const remote = await rawGet(`${s.base}/${SID}/join/7`, { host: "203.0.113.9:3001" });
  assert.ok(!/直接开玩/.test(remote.body), "远程访问者不该被告知「服务器就在你身边」");
});

test("🔴 回归（Issue #11）：/__whoami 暴露 sid + 当前入口（页面据此自愈到正确入口）", async (t) => {
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "1", TANK_PUBLIC_ENTRY: "http://203.0.113.9:3001" } });
  t.after(() => s.stop());
  const who = await (await fetch(s.base + "/__whoami")).json();
  assert.equal(who.kind, "game-server");
  assert.equal(who.sid, SID);
  assert.equal(who.current, "http://203.0.113.9:3001");
  assert.equal(who.entryPath, `/${SID}/join/`);
});

test("🔴 回归（Issue #11）：入口从玩家那侧连不上时，允许按「实际能连到的地址」修正（仅本机/同内网自救）", async (t) => {
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "1", TANK_PUBLIC_ENTRY: "http://203.0.113.9:3001" } });
  t.after(() => s.stop());
  assert.equal((await health(s.base)).current, "http://203.0.113.9:3001");

  // main 的加固口径（Issue #15）：该路由要求一次性部署令牌 —— 部署者（后端网络到不了登记的入口）
  // 持令牌上报「我这里实际能连到 198.51.100.20:3001」；本 PR 的准入（令牌 或 本机/同内网自救）
  // 与之一致，此路径照旧 200；匿名版本已按漏洞修掉（见下方 🔴 回归）。
  const r = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://198.51.100.20:3001")}`, {
    headers: { "X-Tank-Entry-Token": s.token },
  });
  const j = await r.json();
  assert.equal(r.status, 200, `带令牌的自救应被接受（实际 ${r.status}）`);
  assert.equal(j.applied, true);
  assert.equal(j.previous, "http://203.0.113.9:3001");
  assert.equal(j.current, "http://198.51.100.20:3001");
  assert.equal((await health(s.base)).current, "http://198.51.100.20:3001", "入口应被修正为玩家真的连得上的地址");
  const red = await redirectOf(`${s.base}/${SID}/join/4`);
  assert.equal(red.location, "http://198.51.100.20:3001/?room=4");

  // 本机/同内网自救（本 PR 的准入②）：房主就在本机打开、上报本机网卡 IP → 同样放行
  const lanIp = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .find((ni) => ni.family === "IPv4" && !ni.internal)?.address;
  assert.ok(lanIp, "本机应有至少一个非回环 IPv4（用于本用例）");
  const local = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent(`http://${lanIp}:${s.port}`)}`);
  assert.equal(local.status, 200, "本机/同内网自救应被接受");
  assert.equal((await local.json()).current, `http://${lanIp}:${s.port}`);
});

test("🔴 回归（Issue #15）：匿名 /entry/localtip 不得改写全局入口（复现姿势：?origin=攻击者域名）", async (t) => {
  // 复现前提与原 Issue 一致：服务器**启动即自动登记**本机 LAN IP（currentSource=register），
  // 于是旧实现那句「只在已有登记入口时才接受修正」的防护**默认恒为真**，等于没有。
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "1" } });
  t.after(() => s.stop());
  const h0 = await health(s.base);
  const baseline = h0.current;
  assert.ok(baseline, "自动登记后应有当前入口（这正是旧防护失效的前提）");

  // ① 匿名改写（无需任何令牌）—— 必须被拒，且不能落盘
  const r = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://phish.example.net")}`);
  const j = await r.json();
  assert.equal(r.status, 403, `匿名公网域名必须 403（实际 ${r.status}）`);
  assert.equal(j.ok, false);
  assert.equal(j.applied, false);
  assert.ok(j.reason, "被拒必须给原因");
  assert.equal((await health(s.base)).current, baseline, "被拒后当前入口必须原样不变");
  const persisted = (() => { try { return fs.readFileSync(s.tokenFile + ".url", "utf8").trim(); } catch { return ""; } })();
  assert.notEqual(persisted, "http://phish.example.net", "攻击者域名绝不能被落盘（否则重启仍生效）");

  // ② 房主分享出去的稳定链接仍指向原入口，没有被 302 到攻击者域名
  const red = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(red.location, `${baseline}/?room=7`);
  assert.ok(!/phish\.example\.net/.test(String(red.location)), "稳定链接绝不能被匿名请求劫持");
  assert.ok(!/phish\.example\.net/.test(s.log()), "攻击者域名不应被写进日志/匹配表");

  // ③ 公网 IP（非本机网卡）同样拒 —— 只放行「本机/同内网自救」
  const r2 = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://203.0.113.9:3001")}`);
  assert.equal(r2.status, 403, "匿名公网 IP 也必须 403");
  assert.equal((await health(s.base)).current, baseline);

  // ④ 不带 origin / 非法 origin：400（参数问题，不是准入问题）
  const r3 = await fetch(`${s.base}/entry/localtip`);
  assert.equal(r3.status, 400);

  // ⑤ 带令牌的合法自救仍然可用（不回归 Issue #11）
  const r4 = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://203.0.113.9:3001")}`, {
    headers: { "X-Tank-Entry-Token": s.token },
  });
  const j4 = await r4.json();
  assert.equal(r4.status, 200, "带令牌自救必须可用");
  assert.equal(j4.applied, true);
  assert.equal(j4.current, "http://203.0.113.9:3001");
  // previous 必须是「本请求到达前」的入口（不能回显被本请求改过的值）
  assert.equal(j4.previous, baseline, "previous 应是请求到达前的入口");
  assert.notEqual(j4.previous, j4.current);
  const red4 = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(red4.location, "http://203.0.113.9:3001/?room=7");
});

// ── 🔴 回归（Issue #15 验收）────────────────────────────────────────
//   匿名（无部署令牌 / 无任何伪造头）的 /entry/localtip 一律不得改写全局入口；
//   合法自救必须携带一次性部署令牌。
test("🔴 回归（Issue #15）：匿名 /entry/localtip 不得改写全局入口（?origin= 攻击者域名/公网 IP）", async (t) => {
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "0" } });
  t.after(() => s.stop());
  await register(s.base, "http://203.0.113.9:3001", s.token);   // 部署者显式登记
  const before = (await health(s.base)).current;
  assert.equal(before, "http://203.0.113.9:3001");

  // 1) 攻击者用域名劫持（原 Issue #15 复现姿势）
  for (const evil of ["https://phish.example.com", "http://198.51.100.7:3001"]) {
    const r = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent(evil)}`);
    assert.equal(r.status, 403, `匿名上报 ${evil} 必须 403`);
    assert.equal((await r.json()).applied, false);
    assert.equal((await health(s.base)).current, before, "匿名上报不得改写当前入口");
  }
  // 2) 伪造 x-forwarded-* 头也不能放行（对端身份只能看 TCP 对端）
  const fwd = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://198.51.100.7:3001")}`, {
    headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "10.0.0.1" },
  });
  assert.equal(fwd.status, 403, "伪造 x-forwarded-for/x-real-ip 不得放行");
  // 3) 落盘未被污染：重启后入口仍是部署者登记的那个
  assert.notEqual((await health(s.base)).current, "http://198.51.100.7:3001");
  const red = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(red.location, "http://203.0.113.9:3001/?room=7", "稳定链接不得 302 到攻击者地址");
});

test("🔴 回归（Issue #15）：带部署令牌的合法自救仍可用（?origin= 公网 IP / 域名）", async (t) => {
  const s = await startServer({ env: { TANK_AUTO_ENTRY: "0" } });
  t.after(() => s.stop());
  await register(s.base, "http://203.0.113.9:3001", s.token);
  const move = async (origin) => {
    const res = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent(origin)}`, { headers: { "X-Tank-Entry-Token": s.token } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const a = await move("http://198.51.100.20:3001");
  assert.equal(a.status, 200);
  assert.equal(a.json.applied, true);
  assert.equal((await health(s.base)).current, "http://198.51.100.20:3001");

  // 公网域名形态同样允许（部署者换域名场景）——唯一不可信的是请求方，不是地址形态
  const b = await move("https://new.example.com");
  assert.equal(b.status, 200);
  assert.equal((await health(s.base)).current, "https://new.example.com");
  const red = await redirectOf(`${s.base}/${SID}/join/9`);
  assert.equal(red.location, "https://new.example.com/?room=9", "稳定链接应跟到新域名");

  // 未带令牌/错令牌仍然 403
  const c = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://198.51.100.21:3001")}`);
  assert.equal(c.status, 403);
});

test("🔴 回归（Issue #11）：没有任何登记入口时，可达性上报不得凭请求方地址建立入口（钓鱼防线不退化）", async (t) => {
  const s = await startServer();   // TANK_AUTO_ENTRY=0、无模板 → 没有入口
  t.after(() => s.stop());
  const r = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("https://phish.example.com")}`);
  assert.ok(r.status === 403 || r.status === 409, `没有登记入口时必须拒绝（实际 ${r.status}）`);
  assert.equal((await health(s.base)).current, null, "钓鱼域名不得成为当前入口");

  // 回环地址同样不能借这条路径成为入口（回环永远不可分享）
  await register(s.base, "http://203.0.113.9:3001", s.token);
  const r2 = await fetch(`${s.base}/entry/localtip?origin=${encodeURIComponent("http://127.0.0.1:3001")}`);
  assert.ok(r2.status >= 400, "回环地址仍不得成为入口");
  assert.equal((await health(s.base)).current, "http://203.0.113.9:3001", "被拒时入口保持不变");
});

// ── Issue #16（D1）：error 帧的**机器码**契约 ────────────────────
// 病根：前端靠 `msg.includes("已满")/("不存在")/("对局中")` 决定"要不要重试"，
//      服务端一改文案（本地化/加前缀）前端就静默退化（「对局中」丢掉重试能力）。
// 修法：服务端 error 帧带 `code` 机器码（shared/net-error-codes.mjs），前端按码分档，文案只做展示。
// 本测试**真起服务器 + 真发 WebSocket**，锁住"加入房间三条错误路径的 code 不许改/不许丢"。

/** 连上服务器，等 welcome，返回一个极简的收发器 */
async function connect(port) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) { waiters.splice(i, 1)[0].res(m); }
    }
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const waitFor = (pred, ms = 5000) => {
    const hit = inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("等消息超时")), ms);
      waiters.push({ pred, res: (m) => { clearTimeout(to); res(m); } });
    });
  };
  return {
    ws,
    inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    welcome: () => waitFor((m) => m.t === "welcome"),
    waitFor,
    /** 发一条消息，等它换来的 error 帧（收不到则抛，避免"undefined.code"这种误导性失败） */
    async expectError(o) {
      const n = inbox.length;
      ws.send(JSON.stringify(o));
      const hit = await waitFor((m) => m.t === "error" && inbox.indexOf(m) >= n);
      return hit;
    },
    close: () => ws.close(),
  };
}

test("🔴 回归（Issue #16 D1）：加入房间的 error 帧必须带机器码（前端据此分档，不再耦合中文文案）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const { ERR_ROOM_NOT_FOUND, ERR_ROOM_FULL, ERR_ROOM_PLAYING, ERR_ALREADY_IN_TABLE } =
    await import("../../shared/net-error-codes.mjs");

  // ① 房间不存在
  const a = await connect(s.port);
  await a.welcome();
  const e1 = await a.expectError({ t: "join", tableId: 99999 });
  assert.equal(e1.code, ERR_ROOM_NOT_FOUND, "房间不存在必须带 code=room_not_found");
  assert.ok(e1.msg, "文案仍要保留（给玩家看）");

  // ② 房主建房 + 已在桌内的 join 错误
  a.send({ t: "create", mode: "endless" });
  const created = await a.waitFor((m) => m.t === "table" && m.table.seats[0] && m.table.seats[0].clientId);
  const roomId = created.table.id;
  const e2 = await a.expectError({ t: "join", tableId: roomId });
  assert.equal(e2.code, ERR_ALREADY_IN_TABLE);

  // ③ 房间已满：房主 + 3 名成员 == 4 座，第 5 人必须被拒
  const members = [];
  for (let i = 0; i < 3; i++) {
    const m = await connect(s.port);
    await m.welcome();
    m.send({ t: "join", tableId: roomId });
    members.push(m);
  }
  // 4 座全占（房主 + 3 成员）后再进第 5 人；等**服务器真的把桌坐满**再发，
  // 否则 join 可能先于第 3 个成员的入座处理，拿到的是"还没满"的假结论。
  await a.waitFor((x) => x.t === "table" && x.table.seats.filter(Boolean).length >= 4, 6000);
  const fifth = await connect(s.port);
  await fifth.welcome();
  const e3 = await fifth.expectError({ t: "join", tableId: roomId });
  assert.equal(e3.code, ERR_ROOM_FULL, "坐满时第 5 人必须拿到 code=room_full");

  // ④ 房间对局中：4 人全部准备 → 房主开局 → 后到的人拿到唯一"值得重试"的码
  // 所有人准备（房主自带 1 座，房主自己不需要准备）
  for (const m of members) m.send({ t: "ready", value: true });
  await a.waitFor((x) => x.t === "table" && x.table.seats.filter(Boolean).every((z) => z.clientId === created.table.seats[0].clientId || z.ready), 6000);
  a.send({ t: "start" });
  await a.waitFor((x) => x.t === "start", 6000);
  const late = await connect(s.port);
  await late.welcome();
  const e4 = await late.expectError({ t: "join", tableId: roomId });
  assert.equal(e4.code, ERR_ROOM_PLAYING, "开局后进房必须拿到 code=room_playing（前端据此重试）");

  for (const c of [a, ...members, fifth, late]) c.close();
});

test("🔴 回归（Issue #16 D1）：机器码常量与前端判定表同值（前后端同一套契约）", async () => {
  const m = await import("../../shared/net-error-codes.mjs");
  // 与 src/net/JoinError.ts 里导出的常量保持一致（前端是 TS、服务端是 mjs，两边都从这里对齐）
  assert.equal(m.ERR_ROOM_NOT_FOUND, "room_not_found");
  assert.equal(m.ERR_ROOM_FULL, "room_full");
  assert.equal(m.ERR_ROOM_PLAYING, "room_playing");
  // 唯一可重试的码 = room_playing（与前端 classifyJoinError 的 retry 口径一致）
  assert.deepEqual([...m.RETRYABLE_JOIN_CODES], ["room_playing"]);
  assert.equal(m.isRetryableJoinCode("room_playing"), true);
  assert.equal(m.isRetryableJoinCode("room_full"), false);
  assert.equal(m.isRetryableJoinCode(undefined), false);
  // 前端源码里必须是按 code 分档、且**不再**把关键词当主路径
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./JoinError.ts", import.meta.url), "utf8");
  assert.match(src, /kindOfCode/, "JoinError.ts 应有按 code 分档的实现");
  assert.match(src, /via: "msg"/, "JoinError.ts 应保留（且仅保留）旧服务端关键词兜底");
});
