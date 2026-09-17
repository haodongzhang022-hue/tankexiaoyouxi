//  scripts/net-selftest.mjs ─ 端到端联机流程自测（无需浏览器）
//  验证：建桌 → 第二人进桌 → 两人准备 → 房主开始 → 成员发输入中继给房主
//        → 房主广播快照给成员 → 房主广播 gameover → 房间回到 lobby 可再开。
//  先运行服务器：node server/index.mjs，再运行本脚本。
import WebSocket from "ws";

const URL = process.env.WS_URL || "ws://127.0.0.1:3001";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const c = {
    ws, name, inbox,
    waitForOpen: (timeout = 3000) => new Promise((res, rej) => {
      if (ws.readyState === WebSocket.OPEN) return res();
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) { clearInterval(iv); res(); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`${name} 连接超时`)); }
      }, 20);
    }),
    send: (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o)),
    waitFor: (t, timeout = 3000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i >= 0) { const m = inbox.splice(i, 1)[0]; clearInterval(iv); res(m); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`${name} 超时等待 ${t}`)); }
      }, 30);
    }),
  };
  return c;
}

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.error(`  ✗ ${label}`); } };

async function main() {
  const host = client("房主");
  const memA = client("成员A");
  await host.waitForOpen();
  await memA.waitForOpen();
  const welcomeH = await host.waitFor("welcome");
  const welcomeA = await memA.waitFor("welcome");
  host.clientId = welcomeH.clientId;
  memA.clientId = welcomeA.clientId;

  // 建桌
  host.send({ t: "create", name: "自测房", mode: "endless" });
  const wt = await host.waitFor("table");
  ok(wt.table.seats.length === 4, `建桌后 4 座，实际 ${wt.table.seats.length}`);
  ok(wt.table.hostClientId === host.clientId, "房主即 hostClientId");
  console.log("  桌ID =", wt.table.id);

  // 成员A 进桌
  memA.send({ t: "join", tableId: wt.table.id });
  await memA.waitFor("table");
  const hostT = await host.waitFor("table");
  const seated = hostT.table.seats.filter(Boolean);
  ok(seated.length === 2, `进桌后 2 人，实际 ${seated.length}`);

  // 一人未准备时房主 start 应被拒
  host.send({ t: "start" });
  const err1 = await host.waitFor("error");
  ok(err1.msg.includes("未准备"), `未准备不允许开始: ${err1.msg}`);

  // 两人准备
  memA.send({ t: "ready", value: true });
  await memA.waitFor("table");
  host.send({ t: "ready", value: true });
  await host.waitFor("table");

  // 房主开始
  host.send({ t: "start" });
  const startMem = await memA.waitFor("start");
  const startHos = await host.waitFor("start");
  ok(startMem.myIndex === 1 && startHos.myIndex === 0, "成员 idx=1，房主 idx=0");
  ok(startMem.mode === "endless", "模式无尽");

  // 成员发输入 → 房主应收到 peer_input idx=1
  memA.send({ t: "input", flags: { up: true, w0: true } });
  const pi = await host.waitFor("peer_input");
  ok(pi.idx === 1 && pi.flags.up === true && pi.flags.w0 === true, "成员按键中继给房主(up+w0)");

  // 房主广播快照 → 成员收到
  host.send({ t: "snapshot", data: { t: Date.now(), players: [{ x:1,y:2,hp:3,maxHp:100,alive:true,playerId:1,team:0,facing:"up",activeCannon:0 }], enemies: [], projectiles: [], base:{x:0,y:0,eagleHp:100,eagleMaxHp:100,isDestroyed:false,wallLevel:1,walls:[]}, loot: [], powerups: [], map: [[]], scope:{score:0,wave:1,over:false} } });
  const sn = await memA.waitFor("snapshot");
  ok(sn.data.players[0].x === 1 && sn.data.players[0].y === 2, "房主快照广播给成员");

  // 房主广播 gameover → 成员收到 + 房间复位
  host.send({ t: "gameover", info: { reason: "测试结束", score: 123 } });
  const go = await memA.waitFor("gameover");
  ok(go.info.score === 123, `gameover 广播成功 score=${go.info.score}`);
  const resetT = await host.waitFor("table");
  ok(resetT.table.state === "lobby", "对局结束后房间回到 lobby");

  host.ws.close(); memA.ws.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("测试异常:", e.message); process.exit(1); });