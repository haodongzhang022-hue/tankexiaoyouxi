//  ai-host.mjs ─ AI 主机（浏览器自动化驱动的房主端，供人类当 2 号实测网络效果）
//  行为：
//    1. 启动有头 Edge（可见窗口）打开联机服 → 覆盖 prompt → 自动：联机 → 无尽 → 建桌
//    2. 打印邀请链接（本机 + 局域网 IP），等人类 2 号加入并准备
//    3. 检测到成员入座并 ready → 自动开始
//    4. 持续驾驶 P1：走位 + 开火 + 大招轮换（制造持续动态，供成员观察平滑/虚影）
//  用法：node scripts/ai-host.mjs   （默认 3001；SERVER= 覆盖；EDGE_PATH= 覆盖）
//  注意：profile 目录名避开 ".cdp"，防止 e2e 清理脚本误杀本窗口。
// ============================================================================
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const ROOT = process.env.SERVER ?? "http://localhost:3001/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VK = { Enter: 13, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyC: 67, KeyH: 72, KeyE: 69 };

(async () => {
  const port = 9400 + Math.floor(Math.random() * 300);
  const profile = join(__dirname, "..", "tests", `profile-aihost-${process.pid}`);
  const chrome = spawn(EDGE, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--window-size=1180,760", "--force-device-scale-factor=1", "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = list.find((x) => x.type === "page" && !x.url.startsWith("devtools"));
      if (t) { target = t.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(250);
  }
  if (!target) { console.log("[ai-host] Edge 未就绪"); execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore", windowsHide: true }); process.exit(1); }

  let seq = 0; const pending = new Map();
  const cdp = new WebSocket(target);
  cdp.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result ?? {}); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 5000 }); if (r?.exceptionDetails) return null; return r?.result?.value; };
  const press = async (code, holdMs = 0) => {
    const vk = VK[code] ?? code.charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code.toLowerCase(), code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    if (holdMs > 0) await sleep(holdMs);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code.toLowerCase(), code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(90);
  };
  await new Promise((r) => cdp.on("open", r));
  await send("Page.enable"); await send("Runtime.enable");
  // 覆盖 prompt（建桌弹窗），再加载游戏页（?debug=1 挂载 __tankDebug 供状态判定/邀请链接）
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.prompt = () => "AI主机房";` });
  // ROOT 带 ?debug=1（保留已有 query）
  const rootUrl = ROOT + (ROOT.includes("?") ? "&debug=1" : "?debug=1");
  await send("Page.navigate", { url: rootUrl });
  await sleep(2800);

  const dbg = async (expr) => evalJs(`window.__tankDebug ? (${expr}) : null`);
  const dbgState = async (tag) => {
    const s = await dbg(`JSON.stringify({...window.__tankDebug.state(), url: location.href})`);
    console.log(`  [${tag}] ${s ?? "no-debug-hook"}`);
  };
  console.log("[ai-host] 页面就绪，进入联机…");
  await dbgState("after-load");
  await press("ArrowDown"); await press("ArrowDown"); await press("ArrowDown"); await press("Enter"); await sleep(900);
  await dbgState("menu-enter");
  await press("Enter");          // 无尽
  await sleep(900);
  await dbgState("lobby-enter");
  await press("KeyC");           // 建桌（prompt 已覆盖为默认，直接建）
  await sleep(600);
  await dbgState("after-C");

  // ── 等建桌成功（inTable=true）──
  let inTable = false;
  for (let i = 0; i < 15; i++) {
    const s = await dbg(`window.__tankDebug.state().inTable`);
    if (s === true) { inTable = true; break; }
    await dbgState("wait-table");
    await sleep(700);
    // prompt 若仍被吞：再按一次 C
    if (i === 6) await press("KeyC");
  }
  if (!inTable) {
    console.log("[ai-host] 建桌超时。请手动在主机窗口按 C 建桌。");
  } else {
    // ── 建桌成功：提取邀请链接并打印 ──
    const invite = await dbg(`window.__tankDebug.inviteUrl()`);
    const room = invite ? /[?&]room=(\d+)/.exec(invite)?.[1] : null;
    const portStr = new URL(ROOT).port;
    const lan = (() => { const ifs = os.networkInterfaces(); for (const k of Object.keys(ifs)) for (const i of ifs[k]) if (i.family === "IPv4" && !i.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) return i.address; return null; })();
    console.log(`\n[ai-host] === 邀请链接（请用你的浏览器打开当 2 号）===\n`);
    if (room) {
      console.log(`  本机/同一台电脑:  ${ROOT.endsWith("/") ? ROOT : ROOT + "/"}?room=${room}`);
      if (lan) console.log(`  同一WiFi（手机等其他设备）:  http://${lan}:${portStr}/?room=${room}`);
    } else {
      console.log(`  ${ROOT}  （进大厅后找房名「AI主机房」加入）`);
    }
    console.log(`\n  加入后请按 空格(Space) 准备——检测到你就绪后，我会自动开始对局。\n`);
  }

  // ── 等人类 2 号加入并准备（最多 150s），然后开始 ──
  console.log("[ai-host] 等待 2 号加入并准备…");
  // 轮询服务器：查「AI主机房」桌的入座数（用新 WS 连接，不依赖页面）
  const tableSeats = () => new Promise((res) => {
    const ws = new WebSocket(`ws://${new URL(ROOT).host}`);
    const tomb = setTimeout(() => { try { ws.close(); } catch {} res(-1); }, 3000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "list" })));
    ws.on("message", (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.t === "tables") {
          const t = m.tables.find((x) => x.state === "lobby" && x.name === "AI主机房");
          clearTimeout(tomb);
          ws.close();
          res(t ? t.seats.filter(Boolean).length : 0);
        }
      } catch {}
    });
  });

  let started = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const n = await tableSeats();
    if (n === -1) { await sleep(1500); continue; }
    if (n >= 2) {
      // 成员已入座：尝试开始（若成员未准备 server 拒绝 → 重试直到成功）
      for (let k = 0; k < 25 && !started; k++) {
        await press("KeyS");
        await sleep(1200);
        const st = await dbg(`window.__tankDebug.state().state`);
        if (st === "online_host" || st === "online_client") {
          const hostOk = await dbg(`!!window.__tankDebug.getHost()`);
          if (hostOk) { started = true; break; }
        }
      }
      if (!started) console.log("[ai-host] 已检测到 2 号入座但开始未成功（对方是否已按空格准备？）继续等…");
    }
    await sleep(2000);
  }
  if (!started) { console.log("[ai-host] 等待 2 号超时（150s）。可重新运行。"); }

  console.log("[ai-host] 对局已开始，进入驾驶模式（P1 走位+开火+大招）。Ctrl+C 停止。");
  const patterns = [
    async () => { await press("KeyW", 550); await press("KeyH", 140); },
    async () => { await press("KeyD", 550); await press("KeyH", 180); },
    async () => { await press("KeyS", 550); await press("KeyH", 140); },
    async () => { await press("KeyA", 550); await press("KeyH", 180); },
    async () => { await press("KeyE", 80); },
  ];
  let beat = 0;
  while (true) {
    await patterns[beat % patterns.length]();
    beat++;
    if (beat % 3 === 0) {
      const hud = await dbg(`(() => { const h = window.__tankDebug.getHost(); return h ? JSON.stringify({ rtt: h.netHud.rtt, jitter: h.netHud.jitter, p2lag: h.peerInputLag }) : null; })()`);
      console.log(`[ai-host] 心跳#${Math.floor(beat / 3)} net=${hud ?? "无"}`);
    }
    await sleep(200);
  }
})();