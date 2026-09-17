//  scripts/quick-dual-test.mjs ─ 一键双玩家联机快测
//  场景：AI 房主自动建桌 → AI 成员自动进房/准备 → 房主自动开始 → 双方持续驾驶
//  目的：快速产生真实双向网络流量，HUD 有 RTT/抖动读数
//  前提：node server/index.mjs 已运行
//  用法：node scripts/quick-dual-test.mjs
//  退出：Ctrl+C 清理两个 Edge 进程
// ============================================================================
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SERVER ?? "http://localhost:3001/";
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VK = { Enter: 13, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyC: 67, KeyH: 72, KeyE: 69 };

// ── 通用：启动 Edge + 建立 CDP + 操作 ──────────────────────
function newDriver(label, profile, winSize = "1180,760") {
  const port = 9600 + Math.floor(Math.random() * 300);
  const chrome = spawn(EDGE, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--window-size=" + winSize, "--force-device-scale-factor=1", "about:blank",
  ], { stdio: "ignore" });

  const connect = async () => {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const t = list.find((x) => x.type === "page" && !x.url.startsWith("devtools"));
        if (t) { target = t.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(250);
    }
    if (!target) throw new Error(`${label} CDP 超时`);

    let seq = 0; const pending = new Map();
    const cdp = new WebSocket(target);
    cdp.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result ?? {}); }
    });
    await new Promise((r) => cdp.on("open", r));
    const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method, params })); });
    await send("Page.enable"); await send("Runtime.enable");
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 5000 }); if (r?.exceptionDetails) return null; return r?.result?.value; };
    const press = async (code, holdMs = 0) => {
      const vk = VK[code] ?? code.charCodeAt(0);
      const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.toLowerCase();
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      if (holdMs > 0) await sleep(holdMs);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(90);
    };
    return { send, evalJs, press };
  };

  const kill = () => { try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore", windowsHide: true }); } catch {} };
  return { label, port, chrome, connect, kill };
}

// ── 服务器轮询：查桌状态 ──────────────────────────────────
async function getTableByName(name) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://${new URL(ROOT).host}`);
    const tomb = setTimeout(() => { try { ws.close(); } catch {}; res(null); }, 3000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "list" })));
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.t === "tables") { const t = m.tables.find((x) => x.name === name); clearTimeout(tomb); ws.close(); res(t ?? null); }
      } catch {}
    });
  });
}

// ── 主流程 ────────────────────────────────────────────────
(async () => {
  const pid = process.pid;
  const hostProfile = join(__dirname, "..", "tests", `profile-dualhost-${pid}`);
  const memProfile  = join(__dirname, "..", "tests", `profile-dualmember-${pid}`);
  const tableName = "DualTest" + (pid % 10000);

  console.log(`\n=== 一键双玩家联机快测 ===`);
  console.log(`服务器: ${ROOT}`);
  console.log(`房名: ${tableName}`);
  console.log(`Ctrl+C 退出\n`);

  const host = newDriver("房主", hostProfile);
  let member = null;
  const cleanup = () => { console.log("\n[退出] 清理…"); host.kill(); member?.kill?.(); process.exit(0); };
  process.on("SIGINT", cleanup); process.on("SIGTERM", cleanup);

  // ═══ 阶段 1：房主建桌 ═══
  console.log("[房主] 启动浏览器…");
  const h = await host.connect();
  // 覆盖 prompt（房名简单字符串，避免语法问题）
  await h.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.prompt = () => "${tableName}";` });
  await h.send("Page.navigate", { url: ROOT + "?debug=1" });
  await sleep(2800);

  const hdbg = (e) => h.evalJs(`window.__tankDebug ? (${e}) : null`);
  console.log("[房主] 页面加载完成，进入联机…");

  // ↓↓↓ Enter → 联机菜单
  await h.press("ArrowDown"); await h.press("ArrowDown"); await h.press("ArrowDown");
  await h.press("Enter");
  await sleep(900);
  let s = await hdbg(`JSON.stringify(window.__tankDebug.state())`);
  console.log(`  联机菜单: ${s}`);

  // Enter → 无尽模式
  await h.press("Enter");
  await sleep(900);
  s = await hdbg(`JSON.stringify(window.__tankDebug.state())`);
  console.log(`  无尽大厅: ${s}`);

  // C → 建桌
  console.log("[房主] 建桌…");
  await h.press("KeyC");
  await sleep(600);

  // 验证建桌成功（和 ai-host.mjs 一样，本地 inTable 标志最直接）
  let table = null;
  let inTable = false;
  for (let i = 0; i < 15; i++) {
    inTable = await hdbg(`window.__tankDebug.state().inTable`);
    table = await getTableByName(tableName);
    if (inTable || table) break;
    await sleep(700);
    if (i === 6) { await h.press("KeyC"); await sleep(400); }
  }
  if (!inTable && !table) { console.error("[房主] 建桌失败"); cleanup(); return; }
  const tid = table?.id ?? (await hdbg(`window.__tankDebug.getNetClient?.()?.myClientId`));
  console.log(`[房主] 建桌成功！tableId=${tid} invite=${ROOT.replace(/\/$/, "")}/?room=${tid}`);

  // ═══ 阶段 2：成员进房 + 准备 ═══
  const invite = ROOT.replace(/\/$/, "") + `/?room=${table.id}&debug=1`;
  console.log(`\n[成员] 启动浏览器，加入房间…`);
  member = newDriver("成员", memProfile);
  const m = await member.connect();
  await m.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.prompt = () => "Member";` });
  await m.send("Page.navigate", { url: invite });
  await sleep(3000);

  // 成员自动 join（main.ts welcome 时会用 autoJoinRoom），等它坐下
  let seated = false;
  for (let i = 0; i < 15 && !seated; i++) {
    const t = await getTableByName(tableName);
    if (t && t.seats.filter(Boolean).length >= 2) seated = true;
    if (!seated) await sleep(700);
  }
  if (!seated) { console.error("[成员] 进桌失败"); cleanup(); return; }
  console.log("[成员] 已进桌");

  // 按空格准备
  await m.press("Space");
  await sleep(800);
  let ready = false;
  for (let i = 0; i < 10 && !ready; i++) {
    const t = await getTableByName(tableName);
    if (t) {
      const seats = t.seats.filter(Boolean);
      ready = seats.length >= 2 && seats.every((s) => s.ready);
    }
    if (!ready) await sleep(600);
  }
  console.log(`[成员] 准备=${ready}`);

  // ═══ 阶段 3：房主按 S 开始 ═══
  console.log("\n[房主] 开始对局…");
  await h.press("KeyS");
  await sleep(1500);
  s = await hdbg(`JSON.stringify(window.__tankDebug.state())`);
  console.log(`  房主状态: ${s}`);

  // 如果房主还没进入 online_host，再按一次
  if (!s?.includes("online_host")) {
    await h.press("KeyS");
    await sleep(2000);
  }

  const stateHost = await hdbg(`window.__tankDebug.state().state`);
  console.log(`[房主] 对局中 (state=${stateHost})！双方 AI 开始驾驶。Ctrl+C 退出\n`);

  // ═══ 阶段 4：双方驾驶 + 定时打印 HUD ═══
  const hPatterns = [
    async () => { await h.press("KeyW", 400); await h.press("KeyH", 120); },
    async () => { await h.press("KeyD", 400); await h.press("KeyH", 160); },
    async () => { await h.press("KeyS", 400); await h.press("KeyH", 120); },
    async () => { await h.press("KeyA", 400); await h.press("KeyH", 160); },
    async () => { await h.press("KeyE", 80); },
  ];
  const mPatterns = [
    async () => { await m.press("KeyW", 500); await m.press("KeyH", 150); },
    async () => { await m.press("KeyA", 500); await m.press("KeyH", 150); },
    async () => { await m.press("KeyD", 500); await m.press("KeyH", 150); },
    async () => { await m.press("KeyS", 500); await m.press("KeyH", 150); },
    async () => { await m.press("KeyE", 80); },
  ];

  let beat = 0;
  while (true) {
    await Promise.all([hPatterns[beat % 5](), mPatterns[beat % 5]()]);
    beat++;
    if (beat % 8 === 0) {
      const hud = await hdbg(`(() => { const x = window.__tankDebug.getHost(); return x ? JSON.stringify({ rtt: x.netHud.rtt, jitter: x.netHud.jitter, p2lag: x.peerInputLag, score: x.score, wave: x.wave }) : null; })()`);
      const mm = await m.evalJs(`(() => { const r = window.__remoteView; return r ? JSON.stringify({ rtt: r.netHud.rtt, jitter: r.netHud.jitter, p2p: r.netHud.p2p }) : null; })()`);
      const ts = new Date().toLocaleTimeString();
      console.log(`[${ts}] #${beat} 房主HUD=${hud ?? "无"} | 成员HUD=${mm ?? "无"}`);
    }
    await sleep(300);
  }
})().catch((e) => { console.error("脚本异常:", e.message); process.exit(1); });
