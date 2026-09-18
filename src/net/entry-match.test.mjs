// src/net/entry-match.test.mjs ─ 稳定入口（稳定链接 ↔ 当前临时地址）自测
//
// 运行：npm run net:entry-test     （node --test，退出码 0 = 全绿）
//
// 覆盖：
//   匹配表：绑定 / 查询 / 过期清条 / 形状校验（不瞎猜）
//   origin 判定：回环 / 私网 / 公网 IP / 域名 / 残留占位符（纯逻辑）
//   服务器：/<sid>/join/<room> 302（带 ?room）、老域名自动跟到当前地址、
//           换新 sid 给可操作提示页、不误伤 / 与静态资源
//   🔴 回归（PR #7 评审）：伪造 Host 的匿名 HTTP 请求**不得**改写「当前入口」，
//           即分享出去的稳定链接不可能被一条 curl 指向攻击者域名
//   🔴 回归（PR #8 评审 🔴2）：**IP / 局域网形态部署**（deploy/ 主推形态）带令牌登记后，
//           稳定链接必须 302 到**那个 IP**（不是访问者自己的 127.0.0.1）；没有入口时给提示页
//   🔴 回归（PR #8 评审 🔴3）：模板里含**残留占位符**（{{port}} 大小写/拼写变化）时，
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
import { createEntryMatcher, entryPath, makeSid, normalizeOrigin, SID_RE, originScope, ipScope, hasTemplatePlaceholder } from "../../shared/entry-match.mjs";

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

test("🔴 回归（PR #8 🔴2）：IP 形态部署登记后，稳定链接 302 到那个 IP（不是 127.0.0.1）", async (t) => {
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

test("🔴 回归（PR #8 🔴2）：没有入口时给可操作提示页（含登记命令），绝不回退 127.0.0.1", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const r = await redirectOf(`${s.base}/${SID}/join/7`);
  assert.equal(r.status, 200, "提示页用 200，浏览器可直接看到");
  assert.equal(r.location, "", "没有入口时不得 302");
  assert.match(r.body, /还没有对外入口/, "应说明「服务器还没有对外入口」");
  assert.match(r.body, /entry\/register/, "应给出可操作的登记命令");
  assert.ok(!/http:\/\/127\.0\.0\.1:\d+\/\?room=/.test(r.body), "不得把好友指向他自己的回环地址");
});

test("🔴 回归（PR #8 🔴3）：模板含残留占位符时不得成为「当前入口」", async (t) => {
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

test("🔴 回归（PR #8 🔴2）：未授权的私网/回环地址不能当入口", async (t) => {
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

test("🟡 回归（PR #8 🟡1）：显式登记优先级最高，不被平台模板刷新顶回；响应回真实落盘值", async (t) => {
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

test("🟡 回归（PR #8 🟡3）：令牌文件 0600，且不跟随符号链接", async (t) => {
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
