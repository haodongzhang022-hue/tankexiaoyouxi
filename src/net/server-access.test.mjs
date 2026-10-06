// src/net/server-access.test.mjs ─ 服务器**准入**自测（真起进程 + 真发 WebSocket）
//
// 运行：npm run net:server-test    （node --test，退出码 0 = 全绿）
//
// 为什么要单独一份（评审 🔴R3-4：CI 的准入锁是假锁）：
//   `.cnb.yml` 的线上门禁只跑 tsc / build / vitest / net:entry-test，
//   而唯一会启动 server/index.mjs 的 net:entry-test **云端被跳过** ——
//   也就是说服务端的准入逻辑（谁能在什么状态下做什么）**没有任何门禁**。
//   本文件把「真起服务器 + 真发 WS」这套打法固化成 CI 能跑的门禁，钉死会导致
//   「座位状态与真实座位错位 / 别人的错误帧算到我头上 / 4 座容量漏判」的那几条准入。
//
// 覆盖：
//   🔴 座位三态（setseat）：房主上报 → 服务器持有权威值 → 广播回流；非房主一律拒
//   🔴 加入容量：4 座**全占**才算满；座位数不是"2"
//   🔴 错误帧归属：error 帧必须带 `from`（发起者 clientId）—— 客户端据此只认自己的帧
//   🔴 重连归属：rejoin 的失败必须是 no_rejoin（而不是 join 的 room_not_found / room_playing）
//   🟡 非法座位状态 / 越界座位号：静默忽略，不许把畸形状态广播出去
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "..", "..", "server", "index.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一台真服务器（随机端口），返回 { base, wsUrl, stop } */
async function startServer() {
  const port = 36000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", TANK_KEEPALIVE: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += String(d); });
  child.stderr.on("data", (d) => { log += String(d); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try { const r = await fetch(base + "/healthz"); if (r.ok) break; } catch { /* 未就绪 */ }
    if (Date.now() > deadline) throw new Error("服务器 15s 内未就绪：\n" + log);
    await sleep(120);
  }
  return {
    base,
    wsUrl: `ws://127.0.0.1:${port}/`,
    log: () => log,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

/**
 * 一个"玩家"连接：能按类型等消息（不丢帧）。
 * 为什么要有它（而不是 `ws.once("message")`）：服务器会把 table/error/tables 混着发，
 * 用 once 抓"下一条"必然串台 —— 这是本文件能稳定断言的前提。
 */
async function openPlayer(wsUrl, name) {
  const ws = new WebSocket(wsUrl);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ t: "setname", name }));
  await sleep(60);
  const api = {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    /** 等一条匹配的消息（先翻收件箱，再挂等；超时抛错而非静默） */
    wait: (match, ms = 3000) => {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等消息超时：${match}`)), ms);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    drain: () => { inbox.length = 0; },
    close: () => { try { ws.close(); } catch { /* 已关 */ } },
  };
  return api;
}

/** 建房 → 返回房号（顺带把建房时的 table 帧消费掉） */
async function createRoom(host) {
  host.send({ t: "create", mode: "endless" });
  const m = await host.wait((x) => x.t === "table");
  return m.table.id;
}

test("🔴 座位三态：房主 setseat → 服务器持有权威值并广播回流（含房主自己）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const host = await openPlayer(s.wsUrl, "房主");
  const roomId = await createRoom(host);
  host.drain();

  host.send({ t: "setseat", idx: 2, state: "ai" });
  const back = await host.wait((x) => x.t === "table");
  assert.equal(back.table.seatStates[2], "ai", "服务器必须持有并回流房主设置的座位状态");
  assert.deepEqual(back.table.seatStates, ["open", "open", "ai", "open"]);

  // 大厅列表也要带上（否则列表里的空位提示与实际不符）
  // ⚠ 服务器会在建房/入座时主动广播 tables：先清空收件箱再要列表，免得到手的是旧快照
  host.drain();
  host.send({ t: "list" });
  const view = (await host.wait((x) => x.t === "tables")).tables.find((x) => x.id === roomId);
  assert.equal(view.seatStates[2], "ai", "大厅列表必须带座位状态");

  // 非法值 / 越界座位号：静默忽略，不许把畸形状态广播出去
  host.drain();
  host.send({ t: "setseat", idx: 2, state: "hacked" });
  host.send({ t: "setseat", idx: 99, state: "ai" });
  await sleep(250);
  host.drain();
  host.send({ t: "list" });
  const list2 = await host.wait((x) => x.t === "tables");
  assert.equal(list2.tables.find((x) => x.id === roomId).seatStates[2], "ai", "非法入参不得改动服务器状态");

  host.close();
});

test("🔴 座位三态：非房主 setseat 一律拒（host_only，且不动服务器状态）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const host = await openPlayer(s.wsUrl, "房主");
  const roomId = await createRoom(host);
  const guest = await openPlayer(s.wsUrl, "成员B");
  guest.send({ t: "join", tableId: roomId });
  await guest.wait((x) => x.t === "table");
  guest.drain();

  guest.send({ t: "setseat", idx: 3, state: "closed" });
  const err = await guest.wait((x) => x.t === "error");
  assert.equal(err.code, "host_only", "只有房主能调整座位");
  assert.equal(typeof err.from, "number", "error 帧必须带发起者（客户端据此只认自己的帧）");
  // 服务器状态不变（房主视角复查）
  host.send({ t: "list" });
  const list = await host.wait((x) => x.t === "tables");
  assert.deepEqual(list.tables.find((x) => x.id === roomId).seatStates, ["open", "open", "open", "open"]);
  host.close(); guest.close();
});

test("🔴 加入容量：4 个座位真的都能坐满（不是「2 人上限」）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const host = await openPlayer(s.wsUrl, "房主");
  const roomId = await createRoom(host);
  const guests = [];
  for (const n of ["成员B", "成员C", "成员D"]) {
    const g = await openPlayer(s.wsUrl, n);
    g.send({ t: "join", tableId: roomId });
    const tb = await g.wait((x) => x.t === "table");
    guests.push(g);
    assert.ok(tb.table.seats.some((x) => x && x.name === n), `${n} 应已入座`);
  }
  // 房主视角复查最终座位表（host 收件箱里可能还压着中间的 table 帧，取最后一条）
  let last = null;
  for (;;) {
    try { last = await host.wait((x) => x.t === "table", 300); } catch { break; }
  }
  assert.ok(last, "房主应收到本桌的 table 广播");
  assert.equal(last.table.seats.length, 4, "本桌是 4 座");
  assert.equal(last.table.seats.filter(Boolean).length, 4,
    "4 人同桌是支持的玩法：4 座真能坐满（不是「2 人上限」），第 5 个才该被 room_full 拒");
  host.close(); for (const g of guests) g.close();
});

test("🔴 错误帧归属：每一条 error 都要带 from（发起者 clientId）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const host = await openPlayer(s.wsUrl, "房主");
  const roomId = await createRoom(host);
  const guest = await openPlayer(s.wsUrl, "成员B");
  guest.send({ t: "join", tableId: roomId });
  await guest.wait((x) => x.t === "table");
  guest.drain();

  // 非房主点「开始」→ host_only，并且必须带发起者（否则大厅里的无关玩家会把它当成自己的错）
  guest.send({ t: "start" });
  const err = await guest.wait((x) => x.t === "error");
  assert.equal(err.code, "host_only");
  assert.equal(typeof err.from, "number", "error 帧必须带 from（发起者 clientId）");
  assert.ok(err.from > 0, "from 必须是真实 clientId");

  // 已经在桌内的人再 join → already_in_table（准入的第一道闸），from 仍是发起者本人
  guest.send({ t: "join", tableId: 999999 });
  const err2 = await guest.wait((x) => x.t === "error");
  assert.equal(err2.code, "already_in_table", "在桌内不得再抢别的座位");
  assert.equal(typeof err2.from, "number", "from 必须是发起者本人（否则会弹到别人屏幕上）");
  // 一个不在桌内的玩家加入不存在的房间：room_not_found，且 from = 他自己
  const stranger = await openPlayer(s.wsUrl, "路过的");
  stranger.send({ t: "join", tableId: 999999 });
  const err3 = await stranger.wait((x) => x.t === "error");
  assert.equal(err3.code, "room_not_found");
  assert.equal(typeof err3.from, "number");
  host.close(); guest.close(); stranger.close();
});

test("🔴 重连归属：rejoin 的失败走 no_rejoin（不是 join 的 room_not_found/room_playing）", async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const host = await openPlayer(s.wsUrl, "房主");
  const roomId = await createRoom(host);

  const lost = await openPlayer(s.wsUrl, "断线的人");
  lost.send({ t: "rejoin", tableId: 999999, token: "bogus" });
  const e1 = await lost.wait((x) => x.t === "error");
  assert.equal(e1.code, "no_rejoin", "没这局 → 是重连失败（no_rejoin），不是「房间不存在」（room_not_found）");

  // 房号存在但不在对局中（大厅态）：同样是"接不回去"，不是"加不进去"
  lost.send({ t: "rejoin", tableId: roomId, token: "bogus" });
  const e2 = await lost.wait((x) => x.t === "error");
  assert.equal(e2.code, "no_rejoin", "room_playing 与 no_rejoin 的分工必须清楚：join 用前者、rejoin 用后者");
  host.close(); lost.close();
});
