// src/net/entry-match.test.mjs ─ 稳定入口（稳定链接 ↔ 当前临时地址）自测
//
// 运行：npm run net:entry-test     （node --test，退出码 0 = 全绿）
//
// 覆盖：
//   匹配表：绑定 / 查询 / 过期解绑 / 形状校验（不瞎猜）
//   服务器：/<sid>/join/<room> 302（带 ?room）、老域名自动跟到当前地址、
//           换新 sid 给可操作提示页、不误伤 / 与静态资源
//   🔴 回归（PR #7 评审）：伪造 Host 的匿名 HTTP 请求**不得**改写「当前入口」，
//           即分享出去的稳定链接不可能被一条 curl 指向攻击者域名
//   可信来源：一次性令牌探针 / 落盘登记 才能刷新入口
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createEntryMatcher, entryPath, makeSid, normalizeOrigin, currentOrigin, SID_RE } from "../../shared/entry-match.mjs";

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

test("匹配表：5 分钟无心跳自动解绑", () => {
  let now = 1_000_000;
  const m = createEntryMatcher(makeSid(), { now: () => now });
  m.bind(SID, "https://a.example.com");
  now += 5 * 60 * 1000 + 1;
  assert.equal(m.lookup(SID), null, "超过 TTL 应查不到");
  assert.equal(m.size(), 0, "过期条目应被清掉");
  now += 1000;
  m.bind(SID, "https://b.example.com");
  now += 4 * 60 * 1000;
  assert.ok(m.lookup(SID), "4 分钟内应仍然有效");
});

test("路径与 origin 工具：entryPath / normalizeOrigin / currentOrigin", () => {
  assert.equal(entryPath(SID), `/${SID}/join/`);
  assert.equal(entryPath(SID, 12), `/${SID}/join/12`);
  assert.equal(normalizeOrigin("https://a.example.com:443/x?y=1#z"), "https://a.example.com");
  assert.equal(currentOrigin(["", "not a url", "http://b.example.com/"]), "http://b.example.com");
  assert.ok(SID_RE.test(makeSid()));
});

// ── 服务器（真起进程 + 真发 HTTP）──────────────────────────────────
/** 起一台服务器（随机端口 + 固定 sid），等 /healthz 就绪后回调 */
async function startServer({ env = {} } = {}) {
  const port = 34000 + Math.floor(Math.random() * 2000);
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tank-entry-")), "token");
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      TANK_SID: SID,
      TANK_ENTRY_TOKEN_FILE: tokenFile,
      TANK_KEEPALIVE: "0",
      PUBLIC_URL_FILE: path.join(path.dirname(tokenFile), "public-url.txt"),
      // 清掉可能存在的预览模板：本测试要的是「没有可信来源时 current 保持为空」
      CNB_VSCODE_PROXY_URI: "",
      CNB_VSCODE_PROXY_URI_HTTPS: "",
      CNB_PROXY_URI: "",
      CNB_PORT_PREVIEW_URI: "",
      CNB_PREVIEW_URI: "",
      ...env,
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
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  return {
    port, base, token, tokenFile, log: () => log,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
      try { fs.rmSync(path.dirname(tokenFile), { recursive: true, force: true }); } catch {}
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
/** 不跟随跳转地请求一个 URL，返回 Location（socket 连本机，Host 头可另指定 = 模拟外部伪造） */
async function redirectOf(url, opts) {
  const r = await rawGet(url, opts);
  return { status: r.status, location: r.location, body: r.body };
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
  //    （socket 连本机端口，但 Host 头写成攻击者域名 —— 与真实外网请求等价，无需 sid、无需 WS）
  for (const target of ["/healthz", `/healthz?probe_token=deadbeef`, `/entry/${SID}`, `/${SID}/join/7`]) {
    const r = await viaExternal(`http://evil.example.com:${s.port}${target}`, { host: "evil.example.com" });
    assert.ok(r.status >= 200 && r.status < 400, `${target} 应正常响应（不被劫持影响）`);
    assert.ok(!/evil\.example\.com/.test(String(r.location)), `${target} 不得跳到攻击者域名`);
  }
  const forged = await rawGet(s.base + "/healthz", { host: "evil.example.com" });
  assert.equal(forged.status, 200);

  // 3) current 不得被劫持
  assert.equal((await health(s.base)).current, null, "伪造 Host 不得建立当前入口");

  // 4) 稳定链接不得把好友 302 到攻击者域名（Host 是攻击者域名时也不能）
  const r = await viaExternal(`http://evil.example.com:${s.port}/${SID}/join/7`, { host: "evil.example.com" });
  assert.ok(!/evil\.example\.com/.test(String(r.location)), "稳定链接绝不能被 Host 劫持到攻击者域名");



  // 5) 错误的令牌 / 带攻击者域名的登记请求同样无效
  await rawGet(s.base + "/healthz?probe_token=deadbeef", { host: "evil2.example.com" });
  const badReg = await fetch(`${s.base}/entry/register?url=https://evil.example.com&probe_token=deadbeef`);
  assert.equal(badReg.status, 403, "错误令牌不得登记入口");
  assert.equal((await health(s.base)).current, null, "错误的令牌不得建立当前入口");
  assert.ok(!/evil\.example\.com|evil2\.example\.com/.test(s.log()), "攻击者域名不应被写入匹配表/日志");

  // 6) 已确立的当前入口 + 攻击者 Host：仍跳回当前入口，不被顶掉
  await fetch(`${s.base}/entry/register?url=https://game.example.com`, { headers: { "X-Tank-Entry-Token": s.token } });
  const r3 = await viaExternal(`http://evil.example.com:${s.port}/${SID}/join/7`, { host: "evil.example.com" });
  assert.equal(r3.location, "https://game.example.com/?room=7", "攻击者 Host 不得顶掉已确立的当前入口");
});

test("可信来源：带一次性令牌的部署探针可登记公网入口，稳定链接随之 302", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  assert.ok(s.token && s.token.length >= 16, "令牌应落盘 /tmp");

  // 匿名请求先尝试登记 → 403
  const denied = await fetch(`${s.base}/entry/register?url=https://attacker.example.com`);
  assert.equal(denied.status, 403);
  assert.equal((await health(s.base)).current, null);

  // 带令牌登记公网入口 → 200
  const ok = await fetch(`${s.base}/entry/register?url=https://game.example.com`, { headers: { "X-Tank-Entry-Token": s.token } });
  assert.equal(ok.status, 200);
  assert.equal((await health(s.base)).current, "https://game.example.com");

  // 稳定链接 302 到登记的当前入口，并带 ?room=
  const r = await redirectOf(`${s.base}/${SID}/join/12`);
  assert.equal(r.status, 302);
  assert.equal(r.location, "https://game.example.com/?room=12");
});

test("老域名打开稳定链接：自动跟到当前地址（换域名不用改链接）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await fetch(`${s.base}/entry/register?url=https://new.example.com`, { headers: { "X-Tank-Entry-Token": s.token } });

  // 玩家手里的还是老域名 → 老域名上这台服务器把它 302 到新域名（同一台服务，sid 一致）
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

  // dist/ 未构建 → 200 引导页；构建过 → 200 index.html。
  // 这里只锁「不被入口路由吞掉」：不得变成 302 到别处。
  const hasDist = fs.existsSync(path.resolve(__dirname, "..", "..", "dist", "index.html"));
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

  // 一次真实 WS 连接（客户端连上即证明「有活人 + 服务在跑」）
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
