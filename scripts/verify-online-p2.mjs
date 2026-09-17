// ============================================================================
//  scripts/verify-online-p2.mjs ─ 本地双端联机功能验证（v2.31）
//  目的：模拟两个玩家（房主 + 成员）通过联机模式进入，验证：
//    1. 成员端 UI：面板炮筒标签行（4 个 zone）存在 + 截图（HUD/面板人工核对）
//    2. 点击面板标签③ → 主机 P2 activeCannon=2 → 成员高亮跟随（新链路）
//    3. 键盘 Tab 切换 → 主机 activeCannon 循环（原有链路回归）
//    4. 成员移动：主机权威坐标变化（移动链路）
//    5. 成员开火：主机子弹池出现 P2 归属子弹（开火链路）
//  前提：npm run build 已执行；node server/index.mjs 已运行（端口 3001）
//  运行：node scripts/verify-online-p2.mjs
// ============================================================================
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SERVER ?? "http://localhost:3001/";
const MEMBER_ROOT = process.env.MEMBER_SERVER ?? "http://192.168.3.9:3001/"; // 本地 WiFi（LAN IP）
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = join(__dirname, "..", "tests", "shots");
const VK = {
  Enter: 13, Space: 32, Tab: 9, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyB: 66, KeyC: 67, KeyH: 72, KeyJ: 74, KeyE: 69, KeyF: 70,
};
const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  <- " + detail : ""}`);
}

// ── 通用：启动 Edge + CDP 操作（与 quick-dual-test.mjs 同款）────────────
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
      const msg = JSON.parse(String(d));
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result ?? {}); }
    });
    await new Promise((r) => cdp.on("open", r));
    const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method, params })); });
    await send("Page.enable"); await send("Runtime.enable");
    const evalJs = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 8000 });
      if (r?.exceptionDetails) return null;
      return r?.result?.value;
    };
    const press = async (code, holdMs = 0) => {
      const vk = VK[code] ?? code.charCodeAt(0);
      const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code.toLowerCase();
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      if (holdMs > 0) await sleep(holdMs);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(90);
    };
    const shot = async (file) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    };
    return { send, evalJs, press, shot };
  };
  const kill = () => { try { execSync(`taskkill /PID ${chrome.pid} /T /F`, { stdio: "ignore", windowsHide: true }); } catch {} };
  return { label, port, chrome, connect, kill };
}

// ── 服务器轮询：查桌状态 ──
async function listTables() {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://${new URL(ROOT).host}`);
    const tomb = setTimeout(() => { try { ws.close(); } catch {} res([]); }, 3000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "list" })));
    ws.on("message", (d) => {
      try { const m = JSON.parse(String(d)); if (m.t === "tables") { clearTimeout(tomb); ws.close(); res(m.tables || []); } } catch {}
    });
  });
}
async function getTableByName(name) {
  const tables = await listTables();
  return tables.find((x) => x.name === name) ?? null;
}
async function getTableById(id) {
  const tables = await listTables();
  return tables.find((x) => x.id === id) ?? null;
}

// ── 主流程 ────────────────────────────────────────────────────────────
(async () => {
  const pid = process.pid;
  fs.mkdirSync(SHOTS, { recursive: true });
  const hostProfile = join(__dirname, "..", "tests", `profile-vp2host-${pid}`);
  const memProfile = join(__dirname, "..", "tests", `profile-vp2mem-${pid}`);
  const tableName = "VP2" + (pid % 10000);

  console.log(`\n=== 联机双端功能验证 ===\n房主: ${ROOT}\n成员: ${MEMBER_ROOT}\n房名: ${tableName}\n`);

  const host = newDriver("房主", hostProfile);
  let member = null;
  const cleanup = () => { console.log("[清理] 关闭浏览器…"); host.kill(); member?.kill?.(); };
  process.on("SIGINT", cleanup); process.on("SIGTERM", cleanup);

  try {
    // ═══ 阶段 1：房主建桌 ═══
    console.log("[房主] 启动浏览器 + 建桌…");
    const h = await host.connect();
    await h.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.prompt = () => "${tableName}";` });
    await h.send("Page.navigate", { url: ROOT + "?debug=1" });
    await sleep(2800);

    // 菜单 → 联机 → 无尽模式 → 一键建桌（KeyB）
    await h.press("ArrowDown"); await h.press("ArrowDown"); await h.press("ArrowDown");
    await h.press("Enter"); await sleep(1200);   // 进入联机大厅（模式选择）
    await h.press("Enter"); await sleep(1200);   // 选择"无尽"模式（房间列表）

    // 等连接成功后建桌（KeyB=一键新建房间；KeyC=快速加入，勿用）
    let table = null;
    for (let i = 0; i < 18 && !table; i++) {
      await h.press("KeyB");
      await sleep(900);
      const inTable = await h.evalJs(`window.__tankDebug.state().inTable`);
      const myId = await h.evalJs(`window.__tankDebug.getNetClient()?.myClientId`);
      if (inTable && typeof myId === "number") {
        const tables = await (async () => {
          return new Promise((res) => {
            const ws = new WebSocket(`ws://${new URL(ROOT).host}`);
            const tomb = setTimeout(() => { try { ws.close(); } catch {} res(null); }, 3000);
            ws.on("open", () => ws.send(JSON.stringify({ t: "list" })));
            ws.on("message", (d) => { try { const m = JSON.parse(String(d)); if (m.t === "tables") { clearTimeout(tomb); ws.close(); res(m.tables); } } catch {} });
          });
        })();
        table = (tables || []).find((x) => x.seats.some((s) => s && s.clientId === myId)) ?? null;
      }
    }
    if (!table) throw new Error("房主建桌失败");
    console.log(`[房主] 建桌成功 id=${table.id} name=${table.name}`);

    // ═══ 阶段 2：成员经 LAN IP 进房 + 准备 ═══
    console.log(`[成员] 启动浏览器（LAN: ${MEMBER_ROOT}）进房…`);
    member = newDriver("成员", memProfile);
    const m = await member.connect();
    await m.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.prompt = () => "Member";` });
    await m.send("Page.navigate", { url: MEMBER_ROOT.replace(/\/$/, "") + `/?room=${table.id}&debug=1` });
    await sleep(3200);

    let seated = false;
    for (let i = 0; i < 15 && !seated; i++) {
      const t = await getTableById(table.id);
      if (t && t.seats.filter(Boolean).length >= 2) seated = true;
      if (!seated) await sleep(700);
    }
    report("成员进房", seated);
    if (!seated) throw new Error("成员进房失败");

    await m.press("Space"); await sleep(900);
    // ═══ 阶段 3：房主开始 ═══
    console.log("[房主] 开始对局…");
    await h.press("KeyS"); await sleep(1800);
    let hs = await h.evalJs(`JSON.stringify(window.__tankDebug.state())`);
    if (!hs || !hs.includes("online_host")) { await h.press("KeyS"); await sleep(1500); hs = await h.evalJs(`JSON.stringify(window.__tankDebug.state())`); }
    report("对局开始（房主 online_host）", !!hs && hs.includes("online_host"), hs ?? "");
    await sleep(3500); // 等几秒让游戏稳定 + 敌人出现

    const ms = await m.evalJs(`JSON.stringify(window.__tankDebug.state())`);
    report("成员进入对局（online_client）", !!ms && ms.includes("online_client"), ms ?? "");

    // 成员快照 scope 核验（难度/隐藏分是否下发到成员端）
    const scopeInfo = await m.evalJs(`(() => {
      const r = window.__tankDebug.getRemoteView();
      const s = r && r.getLatestSnap ? r.getLatestSnap() : null;
      return s ? JSON.stringify({ diff: s.scope?.diff, hidden: s.scope?.hidden }) : "no-snap";
    })()`);
    let scopeOk = false;
    try { const o = JSON.parse(scopeInfo || "{}"); scopeOk = o.diff !== undefined && o.hidden !== undefined; } catch {}
    report("成员收到 难度/隐藏分 字段", scopeOk, scopeInfo ?? "");

    // ═══ 验证 1：成员面板炮筒标签 zones ═══
    const zonesRaw = await m.evalJs(`(() => {
      const r = window.__tankDebug.getRemoteView();
      if (!r) return null;
      const zs = (r.sidePanel && r.sidePanel.zones) || [];
      return JSON.stringify(zs.filter(z => z.kind === "cannonTab"));
    })()`);
    let zones = [];
    try { zones = JSON.parse(zonesRaw || "[]"); } catch {}
    report("成员面板炮筒标签×4 存在", zones.length === 4, `count=${zones.length}`);

    // 截图（成员面板 + HUD）
    await m.shot(join(SHOTS, "member_before_switch.png"));

    // ═══ 验证 2：点击面板标签③（index=2）→ 主机 P2 activeCannon=2 ═══
    if (zones.length === 4) {
      const z3 = zones.find(z => z.index === 2);
      const cx = z3.x + z3.w / 2, cy = z3.y + z3.h / 2;
      await m.evalJs(`window.__tankDebug.click(${cx}, ${cy})`);
      await sleep(1200);
      const hostCannon = await h.evalJs(`window.__tankDebug.getHost()?.players?.[1]?.activeCannon`);
      const pend = await m.evalJs(`window.__tankDebug.getRemoteView()?.pendingCannonSelect`);
      report("点击标签③ → 主机 P2 炮筒=2", hostCannon === 2, `host activeCannon=${hostCannon}, pendingSend=${pend}`);
      // 成员高亮跟随
      for (let i = 0; i < 10; i++) {
        const myc = await m.evalJs(`window.__tankDebug.getRemoteView()?.myActiveCannon`);
        if (myc === 2) break;
        await sleep(300);
      }
      const myc = await m.evalJs(`window.__tankDebug.getRemoteView()?.myActiveCannon`);
      report("成员高亮跟随=2", myc === 2, `myActiveCannon=${myc}`);
      await m.shot(join(SHOTS, "member_after_switch.png"));
    } else {
      report("点击标签③ → 主机 P2 炮筒=2", false, "跳过：zones 缺失");
    }

    // ═══ 验证 3：键盘 Tab 切换（回归）═══
    const before = await h.evalJs(`window.__tankDebug.getHost()?.players?.[1]?.activeCannon`);
    await m.press("Tab", 380);   // 按住 380ms，确保游戏循环采样到 held 状态
    await sleep(900);
    const after = await h.evalJs(`window.__tankDebug.getHost()?.players?.[1]?.activeCannon`);
    report("成员 Tab 切换炮筒（循环）", before !== after, `${before} → ${after}`);

    // ═══ 验证 4：成员移动（主机权威坐标）═══
    const posA = await h.evalJs(`(() => { const p = window.__tankDebug.getHost()?.players?.[1]; return p ? {x: p.x, y: p.y} : null; })()`);
    await m.press("KeyA", 900); await sleep(400);
    const posB = await h.evalJs(`(() => { const p = window.__tankDebug.getHost()?.players?.[1]; return p ? {x: p.x, y: p.y} : null; })()`);
    const moved = posA && posB ? Math.hypot(posB.x - posA.x, posB.y - posA.y) : 0;
    report("成员移动生效（P2 坐标变化）", moved > 4, `位移=${moved.toFixed(1)}px`);

    // ═══ 验证 5：成员开火（主机子弹池出现 P2 子弹）═══
    const shots = [];
    let fired = false;
    for (let attempt = 0; attempt < 4 && !fired; attempt++) {
      // 轮换 H/J/K/L（4 炮筒）持续按
      for (const k of ["KeyH", "KeyJ", "KeyK", "KeyL"]) {
        await m.press(k, 550);
        const p2proj = await h.evalJs(`(() => {
          const ws = window.__tankDebug.getHost()?.wandSystem;
          if (!ws || !ws.projectiles) return -1;
          return ws.projectiles.filter(p => p.ownerId === 2).length;
        })()`);
        shots.push(p2proj);
        if (typeof p2proj === "number" && p2proj > 0) { fired = true; break; }
      }
    }
    report("成员开火（P2 子弹出现）", fired, `组内观测子弹数样本=${JSON.stringify(shots)}`);

    // ═══ 截图：房主全景 ═══
    await h.shot(join(SHOTS, "host_view.png"));

    // 汇总
    const ok = results.filter((r) => r.ok).length;
    console.log(`\n=== 汇总：${ok}/${results.length} 通过 ===`);
    fs.writeFileSync(join(SHOTS, "verify_result.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
    console.log(`截图目录: ${SHOTS}`);
  } catch (e) {
    console.error("异常:", e.message);
    report("脚本执行", false, e.message);
  } finally {
    cleanup();
    await sleep(600);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
})();
