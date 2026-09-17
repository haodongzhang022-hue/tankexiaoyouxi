// scripts/probe-menu.mjs — 临时诊断：探主菜单导航与联机流程
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = "http://localhost:3001/";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VK = { Enter: 13, Space: 32, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyC: 67, KeyH: 72, KeyE: 69 };

(async () => {
  const port = 9800 + Math.floor(Math.random() * 150);
  const profile = join(__dirname, "..", "tests", `profile-probe-${process.pid}`);
  const chrome = spawn(EDGE, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1180,760", "about:blank",
  ], { stdio: "ignore" });

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const t = list.find((x) => x.type === "page" && !x.url.startsWith("devtools"));
        if (t) { target = t.webSocketDebuggerUrl; break; }
      } catch {}
      await sleep(250);
    }
    const cdp = new WebSocket(target);
    let seq = 0; const pend = new Map();
    cdp.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result ?? {}); } });
    await new Promise((r) => cdp.on("open", r));
    const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method, params })); });
    await send("Page.enable"); await send("Runtime.enable");
    const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 8000 }); if (r?.exceptionDetails) return "EXC:" + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails); return r?.result?.value; };
    const press = async (code, holdMs = 0) => {
      const vk = VK[code] ?? code.charCodeAt(0);
      const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.toLowerCase();
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      if (holdMs) await sleep(holdMs);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(120);
    };
    const dump = async (tag) => {
      const d = await evalJs(`(() => { const t = window.__tankDebug; if (!t) return "NO_DEBUG"; let s=""; try { s = JSON.stringify(t.state()); } catch(e) { s = "stateErr"; } let m=""; try { m = JSON.stringify(t.rawState()); } catch(e) { m = "rawErr"; } return s + " | " + m; })()`);
      console.log(`[${tag}] ${d}`);
    };

    await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.prompt = () => "ProbeRoom";` });
    await send("Page.navigate", { url: ROOT + "?debug=1" });
    await sleep(3500);
    console.log("URL:", await evalJs(`location.href`));
    await dump("loaded");

    for (let i = 1; i <= 5; i++) {
      await press("ArrowDown");
      await dump(`down#${i}`);
    }
    await press("Enter"); await sleep(1000);
    await dump("enter1");
    await press("Enter"); await sleep(1000);
    await dump("enter2");
    await press("Enter"); await sleep(1000);
    await dump("enter3");
    // 试 C 建桌
    await press("KeyC"); await sleep(1500);
    await dump("KeyC");
    // 服务器桌列表
    const tables = await evalJs(`(async () => { return await new Promise((res) => { try { const ws = new (WebSocket)("ws://localhost:3001"); const tm = setTimeout(() => { try{ws.close();}catch{}; res("ws-timeout"); }, 3000); ws.onopen = () => ws.send(JSON.stringify({t:"list"})); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === "tables") { clearTimeout(tm); ws.close(); res(JSON.stringify(m.tables.slice(0,3))); } }; } catch(e) { res("ws-err:" + e.message); } }); })()`);
    console.log("[server tables]", tables);
  } catch (e) {
    console.error("probe error:", e.message);
  } finally {
    try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore", windowsHide: true }); } catch {}
    process.exit(0);
  }
})();
