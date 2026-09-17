//  scripts/net-two-ip-demo.mjs ─ 双端远程联机演示（玩家A=房主）
//  用法: node net-two-ip-demo.mjs <wsUrl> <host|guest> [tableId]
//  房主: 建桌 → 等对方入座并准备 → 开始 → 收到对方按键 → 广播快照 → 结束
import WebSocket from "ws";

const [, , urlArg, role, tableIdArg] = process.argv;
const URL = urlArg || "ws://127.0.0.1:3001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const c = {
    ws, name, inbox,
    waitForOpen: (timeout = 4000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) { clearInterval(iv); res(); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(name + " 连接超时")); }
      }, 25);
    }),
    send: (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o)),
    waitFor: (t, timeout = 8000, pred = null) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const i = inbox.findIndex((m) => m.t === t && (!pred || pred(m)));
        if (i >= 0) { clearInterval(iv); res(inbox.splice(i, 1)[0]); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(name + " 超时等待 " + t)); }
      }, 30);
    }),
  };
  return c;
}

const ok = (cond, label) => console.log((cond ? "  ✓ " : "  ✗ ") + label);

async function runHost() {
  const me = client("玩家A(房主)");
  await me.waitForOpen();
  const w = await me.waitFor("welcome");
  ok(!!w.clientId, `A 已连接 ${URL}，分配 clientId=${w.clientId}`);
  me.send({ t: "create", name: "跨IP演示房", mode: "endless" });
  const wt = await me.waitFor("table");
  const tid = wt.table.id;
  console.log("TABLE_ID=" + tid);
  ok(wt.table.seats.length === 4, "建桌成功，4 座");
  console.log("  … 等待远程玩家入座并准备（最多 40 秒）…");
  // 等待：有人坐进非房主座位且已准备
  const t2 = await me.waitFor("table", 40000, (m) =>
    m.table.seats.some((s, i) => i > 0 && s && s.ready));
  ok(true, `远程玩家已入座并准备（当前 ${t2.table.seats.filter(Boolean).length}/4 座）`);
  me.send({ t: "start" });
  const st = await me.waitFor("start");
  ok(st.myIndex === 0, "对局开始，A 为 P1(idx=0)，seed=" + st.seed);
  const pi = await me.waitFor("peer_input", 15000);
  ok(pi.idx === 1 && pi.flags.up === true, "收到远程玩家的按键中继 (idx=1 up=true)");
  me.send({ t: "snapshot", data: { t: Date.now(), players: [], enemies: [], projectiles: [], base: {}, loot: [], powerups: [], map: [[]], scope: { score: 7, wave: 1, over: false } } });
  await me.waitFor("gameover", 100).catch(() => {});
  await sleep(500);
  me.send({ t: "gameover", info: { reason: "跨IP演示完成", score: 42 } });
  console.log("HOST_DONE");
  me.ws.close();
}

async function runGuest() {
  const me = client("玩家B(远程)");
  await me.waitForOpen();
  const w = await me.waitFor("welcome");
  ok(!!w.clientId, `B 已连接 ${URL}，clientId=${w.clientId}`);
  me.send({ t: "join", tableId: Number(tableIdArg) });
  const jt = await me.waitFor("table", 8000, (m) => m.table.seats.some((s) => s && s.clientId === w.clientId));
  ok(true, `已入座 ${jt.table.name}`);
  me.send({ t: "ready", value: true });
  const st = await me.waitFor("start", 20000);
  ok(st.myIndex === 1, "收到开始指令，B 为 P2(idx=1)");
  me.send({ t: "input", flags: { up: true, down: false, left: false, right: false, fire: false, w0: true, w1: false, w2: false, w3: false, interact: false, switchCannon: false, inventory: false, warehouse: false, revive: false } });
  const sn = await me.waitFor("snapshot", 15000);
  ok(!!sn.data, "收到房主广播的权威快照");
  const go = await me.waitFor("gameover", 20000);
  ok(go.info.score === 42, "收到对局结束 score=" + go.info.score);
  console.log("GUEST_DONE");
  me.ws.close();
}

(role === "host" ? runHost() : runGuest())
  .then(() => process.exit(0))
  .catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
