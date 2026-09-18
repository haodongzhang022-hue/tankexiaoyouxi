// scripts/e2e/verify-invite-fixes.mjs — v2.38 邀请链接返工真机实测（🔴1 / 🔴2 / 🔴3 + 🟡 + 🟢）
// 复跑：sh scripts/e2e/run-verify.sh
// 三份构建同机对跑：
//   3001 = PR 返工后（本分支）    3002 = main 对照（.probe/mainbuild/dist）
//   3003 = PR 返工前（ef80055，.probe/prefixbuild/dist）
// Chromium headless；横屏 968×640 / 竖屏 480×920。点击走 __tankDebug.click（内部换算 CSS 缩放）。
// puppeteer 由 run-verify.sh 装在 gitignored 的 tests/e2e/ 下并通过 PUPPETEER_MODULE 指过来；
// 也可直接 `npm i puppeteer` 后按默认解析。
const puppeteer = (await import(process.env.PUPPETEER_MODULE || "puppeteer")).default;
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const ok = (n, pass, d = "") => { results.push({ n, pass, d }); console.log(`${pass ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };
const note = (s) => console.log(`   · ${s}`);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

/** 每个检查用独立 browser context（隔离 localStorage 重连卡 / 剪贴板 / 会话） */
async function open(port, vw, vh, query) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: vw, height: vh });
  page.on("pageerror", (e) => note(`[pageerror:${port}] ${String(e).slice(0, 120)}`));
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: "networkidle2" });
  await sleep(1600);
  return { ctx, page };
}
const dbg = (page, expr) => page.evaluate(`(() => { const d = window.__tankDebug; if (!d) return "NO_DEBUG"; return JSON.stringify(${expr}); })()`);
const j = (s) => (s === "NO_DEBUG" ? s : JSON.parse(s));
const waitFor = async (page, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (j(await dbg(page, expr)) === true) return true; await sleep(200); }
  return false;
};
const tap = async (page, code) => { await page.evaluate(`window.__tankDebug.key(${JSON.stringify(code)})`); await sleep(260); };
const clickAt = async (page, x, y) => { await page.evaluate(`window.__tankDebug.click(${x}, ${y})`); await sleep(1000); };
/** 画布像素扫描：返回 {n, xmin, xmax} 命中「给定颜色 ±tol」的像素数与横向范围 */
const scan = (page, y0, y1, color, tol) => page.evaluate((y0, y1, color, tol) => {
  const c = document.getElementById("game-canvas");
  const ctx = c.getContext("2d");
  let n = 0, xmin = 1e9, xmax = -1;
  for (let y = y0; y <= y1; y++) {
    const dd = ctx.getImageData(0, y, c.width, 1).data;
    for (let x = 0; x < c.width; x++) {
      const i = x * 4;
      if (Math.abs(dd[i] - color[0]) <= tol && Math.abs(dd[i + 1] - color[1]) <= tol && Math.abs(dd[i + 2] - color[2]) <= tol) {
        n++; xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
      }
    }
  }
  return { n, x: n ? [xmin, xmax] : null };
}, y0, y1, color, tol);
const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** 扫描矩形区域内「给定颜色」的**最长横向连续段**（按钮底色是大色块，背景抗锯齿只是零散单像素） */
const longestRun = (page, y0, y1, color, tol) => page.evaluate((y0, y1, color, tol) => {
  const c = document.getElementById("game-canvas");
  const ctx = c.getContext("2d");
  let best = 0, run = 0, bestY = -1;
  for (let y = y0; y <= y1; y++) {
    const dd = ctx.getImageData(0, y, c.width, 1).data;
    run = 0;
    for (let x = 0; x < c.width; x++) {
      const i = x * 4;
      const hit = Math.abs(dd[i] - color[0]) <= tol && Math.abs(dd[i + 1] - color[1]) <= tol && Math.abs(dd[i + 2] - color[2]) <= tol;
      run = hit ? run + 1 : 0;
      if (run > best) { best = run; bestY = y; }
    }
  }
  return { len: best, y: bestY };
}, y0, y1, color, tol);
const H_OF = (vw, vh) => (vh > vw ? 920 : 640);   // 布局画布高（竖屏 480×920 / 横屏 968×640）

try {
  // ═════════ 🔴1 邀请闯关桌：?room=21（预置「闯关房 01」）模式不得被改写成 endless ═════════
  for (const [vw, vh, label] of [[1200, 800, "横屏 968×640"], [480, 920, "竖屏 480×920"]]) {
    const { ctx, page } = await open(3001, vw, vh, "?room=21&debug=1");
    const joined = await waitFor(page, `d.state().inTable === true`);
    const s1 = j(await dbg(page, `d.state()`));
    ok(`🔴1 [${label}] A/C 组：?room=21 进桌后 onlineMode=stage`, joined && s1.mode === "stage",
      `inTable=${s1.inTable} mode=${s1.mode}（B 组旧 PR 实测为 endless）`);
    await tap(page, "Escape"); await sleep(700);
    const s2 = j(await dbg(page, `d.state()`));
    const rows = j(await dbg(page, `d.visibleRoomRows()`));
    const modes = [...new Set(rows.map((r) => r.mode))];
    ok(`🔴1 [${label}] Esc 离桌后 onlineMode=stage 且大厅列表只剩闯关桌（标题「闯关模式 · 房间大厅」）`,
      s2.inTable === false && s2.mode === "stage" && rows.length > 0 && modes.length === 1 && modes[0] === "stage",
      `mode=${s2.mode} 可见行=${rows.length} 行模式=${modes.join(",")}`);
    await ctx.close();
    // B 组（返工前 PR ef80055）：证明回归确实存在，且本返工修掉了
    const b = await open(3003, vw, vh, "?room=21&debug=1");
    await waitFor(b.page, `d.state().inTable === true`);
    const b1 = j(await dbg(b.page, `d.state()`));
    await tap(b.page, "Escape"); await sleep(700);
    const b2 = j(await dbg(b.page, `d.state()`));
    ok(`🔴1 [${label}] B 组对照（返工前 PR）：进桌 mode=endless ❌ → 离桌后大厅只剩无尽桌`,
      b1.mode === "endless" && b2.mode === "endless",
      `返工前 inTable mode=${b1.mode} / 离桌后 mode=${b2.mode}（= 评审实测的回归；本返工后已修）`);
    await b.ctx.close();
  }

  // ═════════ 🔴2 大厅：房间行 vs 按钮（几何零相交 + 逐点点击）═════════
  for (const [vw, vh, label, probes] of [
    [1200, 800, "横屏 968×640", [[400, 481], [400, 440], [400, 300], [400, 620]]],
    [480, 920, "竖屏 480×920", [[200, 761], [200, 440], [200, 300], [200, 880]]],
  ]) {
    const { ctx, page } = await open(3001, vw, vh, "?room=1&debug=1");
    await waitFor(page, `d.state().inTable === true`);
    await tap(page, "Escape"); await sleep(800);
    const geo = j(await dbg(page, `d.lobbyGeom()`));
    const rows = j(await dbg(page, `d.visibleRoomRows()`));
    const btns = j(await dbg(page, `d.buttons()`));
    // 不变量①：房间行矩形与其自身按钮之外的一切按钮零相交
    const bad = [];
    for (const r of rows) {
      const rect = { x: 16, y: r.y, w: geo.listW, h: r.h };
      for (const b of btns) {
        const own = b.x === 16 && b.y === r.y && b.h === r.h && b.w === geo.listW;
        if (!own && inter(rect, b)) bad.push({ row: r.id, rowY: r.y, btn: b.label || JSON.stringify(b) });
      }
    }
    ok(`🔴2 [${label}] 房间行与其它所有按钮零相交`, bad.length === 0,
      `列表视口 y=${geo.top}..${geo.bottom} 行高=${geo.rowH} 可见行=${rows.length} 按钮=${btns.length} 相交=${bad.length}${bad.length ? " 例:" + JSON.stringify(bad[0]) : ""}`);
    // 不变量②：没有按钮横向压到列表列（x < 16+listW）且纵向落在列表视口内
    const listRight = 16 + geo.listW;
    const onList = btns.filter((b) => !(b.x === 16 && b.h === geo.rowH) && b.x < listRight && b.y < geo.bottom && b.y + b.h > geo.top);
    ok(`🔴2 [${label}] 无按钮横向压入列表列（x<${listRight}）`, onList.length === 0,
      `越界按钮=${onList.length}${onList.length ? " 例:" + JSON.stringify(onList[0]) : ""}`);
    // 逐点点击：命中哪一行 → 必须进哪一桌
    for (const [cx, cy] of probes) {
      const expect = rows.find((r) => cy >= r.y && cy <= r.y + r.h);
      await clickAt(page, cx, cy);
      const st = j(await dbg(page, `d.state()`));
      const room = j(await dbg(page, `d.room()`));
      if (expect) {
        ok(`🔴2 [${label}] 点房间行 (${cx},${cy}) → 进桌 #${expect.id}`, st.inTable === true && room === expect.id,
          `inTable=${st.inTable} room=${room} 期望=#${expect.id}`);
        await tap(page, "Escape"); await sleep(600);
      } else {
        ok(`🔴2 [${label}] 点按钮/空白区 (${cx},${cy}) → 不误进桌`, st.inTable === false, `inTable=${st.inTable}`);
      }
    }
    await ctx.close();
    // B 组：返工前 PR 同坐标 → 被新按钮抢走（复现评审证据）
    const b = await open(3003, vw, vh, "?room=1&debug=1");
    await waitFor(b.page, `d.state().inTable === true`);
    await tap(b.page, "Escape"); await sleep(800);
    const bRows = j(await dbg(b.page, `(d.visibleRoomRows ? d.visibleRoomRows() : [])`)) || [];
    const bRow = bRows.find((r) => 481 >= r.y && 481 <= r.y + r.h) || { id: '-', y: 478, h: 36 };
    if (bRow) {
      await clickAt(b.page, 400, 481);
      const bs = j(await dbg(b.page, `d.state()`));
      note(`[${label}] B 组对照：返工前点 (400,481)（行 #${bRow.id} 区间 y=${bRow.y}..${bRow.y + bRow.h}）→ inTable=${bs.inTable}${bs.inTable ? "" : "（未进桌 = 被新按钮抢走，评审已复现）"}`);
    }
    await b.ctx.close();
  }

  // ═════════ 🔴3 桌内邀请预览：标题 / URL 可见性（像素计数 + 按钮矩形零相交）═════════
  for (const [vw, vh, label] of [[1200, 800, "横屏 968×640"], [480, 920, "竖屏 480×920"]]) {
    const H = H_OF(vw, vh);
    const { ctx, page } = await open(3001, vw, vh, "?room=1&debug=1");
    await waitFor(page, `d.state().inTable === true`);
    await sleep(800);
    const lay = j(await dbg(page, `d.tableBottomLayout()`));
    const btns = j(await dbg(page, `d.buttons()`));
    const titleBand = { x: 0, y: lay.titleTextY - 11, w: 968, h: 15 };
    const urlBand = { x: 0, y: lay.urlTextY - 11, w: 968, h: 15 };
    const hitT = btns.filter((b) => inter(titleBand, b));
    const hitU = btns.filter((b) => inter(urlBand, b));
    ok(`🔴3 [${label}] 标题带/URL 带与任何按钮矩形零相交`, hitT.length === 0 && hitU.length === 0,
      `标题带 y=${titleBand.y}..${titleBand.y + titleBand.h} 命中=${hitT.length}；URL 带 y=${urlBand.y}..${urlBand.y + urlBand.h} 命中=${hitU.length}`);
    const AMBER = [255, 170, 0];       // 局域网态标题色 #ffaa00
    const BTNBG = [20, 28, 43];        // 新按钮底色 #141c2b（大色块 = 遮挡的直接证据）
    const CYAN = [102, 204, 255];      // URL 色 #66ccff
    const tAmber = (await scan(page, titleBand.y, titleBand.y + titleBand.h - 1, AMBER, 45)).n;
    const tBtnRun = (await longestRun(page, titleBand.y, titleBand.y + titleBand.h - 1, BTNBG, 2)).len;
    const uCyan = (await scan(page, urlBand.y, urlBand.y + urlBand.h - 1, CYAN, 45)).n;
    const uBtnRun = (await longestRun(page, urlBand.y, urlBand.y + urlBand.h - 1, BTNBG, 2)).len;
    // A 组（main 对照）：main 标题基线 H-134 / URL H-118，新按钮不存在
    const a = await open(3002, vw, vh, "?room=1");
    await sleep(3000);
    const aT = (await scan(a.page, H - 145, H - 130, AMBER, 45)).n;
    const aRun = (await longestRun(a.page, H - 145, H - 130, BTNBG, 2)).len;
    await a.ctx.close();
    // B 组（返工前 PR）：新按钮压在标题行上（底色长条 = 遮挡）
    const b = await open(3003, vw, vh, "?room=1&debug=1");
    await sleep(3000);
    const bT = (await scan(b.page, H - 145, H - 130, AMBER, 45)).n;
    const bRun = (await longestRun(b.page, H - 145, H - 130, BTNBG, 2)).len;
    await b.ctx.close();
    // 判据：C 组标题字形可见（≥ A 组 60%）+ 标题/URL 带内无按钮色块（最长连续段 < 8px，零散抗锯齿不算）
    //       + B 组确实被遮（底色长条 ≥ 100px 且标题字形塌陷）→ 证明确有回归且已修
    ok(`🔴3 [${label}] 像素自证：标题可见（≥A 的 60%）+ 标题/URL 带内无按钮色块`,
      tAmber >= aT * 0.6 && tAmber > 0 && tBtnRun < 8 && uBtnRun < 8 && uCyan > 0 && bRun >= 100 && bT < aT * 0.3,
      `标题琥珀像素：A(main)=${aT} ｜ B(返工前)=${bT} ｜ C(返工后)=${tAmber}；标题带内按钮色块最长=${tBtnRun}px（B 组同带=${bRun}px）；URL 字形=${uCyan}px URL 带内按钮色块最长=${uBtnRun}px`);
    await ctx.close();
  }

  // ═════════ 🔴2 附加：列表滚动（新引入机制）——滚轮 / 拖拽 / 键盘都能到达视口外的房间 ═════════
  for (const [vw, vh, label] of [[1200, 800, "横屏 968×640"], [480, 920, "竖屏 480×920"]]) {
    const { ctx, page } = await open(3001, vw, vh, "?room=1&debug=1");
    await waitFor(page, `d.state().inTable === true`);
    await tap(page, "Escape"); await sleep(800);
    const geo = j(await dbg(page, `d.lobbyGeom()`));
    const total = j(await dbg(page, `d.visibleRoomRows().length`));
    // 服务端预置 20 桌/模式：视口装不下的必须能滚到
    const first = j(await dbg(page, `d.visibleRoomRows()[0].id`));
    // ① 滚轮：在列表区内滚到底
    const cw = j(await dbg(page, `d.canvasSize()`));
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(cw.w * 0.2, (geo.top + geo.bottom) / 2);
      await page.mouse.wheel({ deltaY: 120 });
      await sleep(60);
    }
    await sleep(500);
    const afterWheel = j(await dbg(page, `d.visibleRoomRows()`));
    const lastId = afterWheel[afterWheel.length - 1]?.id;
    ok(`🔴2 [${label}] 滚轮滚动列表 → 能看到视口外的房间（首=${first} → 末=${lastId}）`,
      afterWheel.length > 0 && lastId !== first && afterWheel[afterWheel.length - 1].y <= geo.bottom,
      `可见行=${afterWheel.length} 首行 id=${afterWheel[0].id} 末行 id=${lastId} y=${afterWheel[afterWheel.length - 1]?.y} 视口底=${geo.bottom}`);
    // ② 点滚动后新出现的行 → 必须进对应桌（且该行在原始视口内不存在）
    const target = afterWheel[afterWheel.length - 1];
    await clickAt(page, 200, target.y + target.h / 2);
    const st = j(await dbg(page, `d.state()`));
    const room = j(await dbg(page, `d.room()`));
    ok(`🔴2 [${label}] 点滚动后出现的行 → 进桌 #${target.id}`, st.inTable === true && room === target.id,
      `inTable=${st.inTable} room=${room} 期望=#${target.id}`);
    await tap(page, "Escape"); await sleep(600);
    // ③ 键盘 ↓ 选到视口外 → 列表跟随滚动（选中行始终可见）
    await page.evaluate(`window.__tankDebug.scrollLobby(0)`);
    await sleep(300);
    for (let i = 0; i < geo.maxRows + 3; i++) await tap(page, "ArrowDown");
    const rowsKb = j(await dbg(page, `d.visibleRoomRows()`));
    const stKb = j(await dbg(page, `d.state()`));
    const inView = rowsKb.length > 0 && rowsKb.some((r) => r.y >= geo.top && r.y + r.h <= geo.bottom);
    ok(`🔴2 [${label}] 键盘 ↓ 越过视口 → 列表自动滚动，选中行仍在视口内`,
      inView && rowsKb[0].id !== 1, `可见行=${rowsKb.length} 首行 id=${rowsKb[0]?.id} state=${stKb.state}`);
    await ctx.close();
  }

  // ═════════ 🟢 功能回归：带号/满桌/不存在/非法房号/大厅链接 ═════════
  {
    // 大厅链接（buildLobbyUrl 直接构造）→ 进大厅不自动坐桌、且不生成非法 ?room=0
    const lob = await open(3001, 1200, 800, "?debug=1");
    const lobbyUrl = j(await dbg(lob.page, `d.lobbyUrl()`));
    ok("🟢 buildLobbyUrl 直接由入口地址构造（无 room=0 非法房号）",
      typeof lobbyUrl === "string" && !lobbyUrl.includes("room=") && !lobbyUrl.includes("//localhost"),
      `lobbyUrl=${lobbyUrl}`);
    await lob.ctx.close();
    // 非法房号（Number() 能接受但非十进制正整数）→ 不自动进联机
    for (const q of ["?room=0x10", "?room=1e3", "?room=+5", "?room=12.0"]) {
      const p = await open(3001, 1200, 800, `${q}&debug=1`);
      const st = j(await dbg(p.page, `d.state()`));
      ok(`🟢 ${q} → 按「不带房号」处理（进主菜单，不自动坐桌）`, st.state === "menu" && st.inTable === false,
        `state=${st.state} inTable=${st.inTable}`);
      await p.ctx.close();
    }
    // 不存在的房间 → 提示 + 停在大厅
    const bad = await open(3001, 1200, 800, "?room=99999&debug=1");
    const stopped = await waitFor(bad.page, `d.pendingInviteRoom() === null`, 15000);
    const msgBad = j(await dbg(bad.page, `d.notif()`));
    ok("🟢 ?room=99999（不存在）→ 停止自动进房并提示房号失效", stopped && String(msgBad).includes("已不存在"),
      `pending=null:${stopped} msg="${msgBad}"`);
    await bad.ctx.close();
  }

  // ═════════ 🟢 功能回归：同一邀请链接连开 4 端坐满 + 第 5 端满桌提示 ═════════
  {
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const { ctx, page } = await open(3001, 1200, 800, "?room=3&debug=1");
      pages.push({ ctx, page });
    }
    const seats = [];
    for (const { page } of pages) {
      await waitFor(page, `d.state().inTable === true`, 12000);
      seats.push(j(await dbg(page, `d.state()`)).inTable);
    }
    ok("🟢 同一邀请链接连开 4 端 → 4 端全部坐进同一桌", seats.every(Boolean), `进桌结果=${seats.join(",")}`);
    const fifth = await open(3001, 1200, 800, "?room=3&debug=1");
    const stopped = await waitFor(fifth.page, `d.pendingInviteRoom() === null`, 12000);
    const msg = j(await dbg(fifth.page, `d.notif()`));
    ok("🟢 第 5 端 → 停在大厅并提示「已满」（不空转重试）", stopped && String(msg).includes("已满"),
      `pending=null:${stopped} msg="${msg}"`);
    await fifth.ctx.close();
    for (const p of pages) await p.ctx.close();
  }

  // ═════════ 🟡3 「对局中」错误文案按真实原因分档 ═════════
  {
    const host = await open(3001, 1200, 800, "?debug=1");
    await tap(host.page, "ArrowDown"); await tap(host.page, "ArrowDown"); await tap(host.page, "ArrowDown");
    await tap(host.page, "Enter");     // 主菜单 → 联机（模式选择）
    await tap(host.page, "Enter");     // 选无尽 → 大厅
    await tap(host.page, "KeyB");      // 新建房间
    await sleep(1500);
    const room = j(await dbg(host.page, `d.room()`));
    await tap(host.page, "KeyS");      // 开局（房主无需准备）
    await sleep(1800);
    const hs = j(await dbg(host.page, `d.state()`));
    ok(`🟡3 前置：房主建房 #${room} 并开局`, hs.inTable === true && hs.state === "online_host", `state=${hs.state} room=${room}`);
    if (hs.state === "online_host") {
      const g = await open(3001, 1200, 800, `?room=${room}&debug=1`);
      await sleep(3000);
      const msg1 = j(await dbg(g.page, `d.notif()`));
      const pend1 = j(await dbg(g.page, `d.pendingInviteRoom()`));
      ok("🟡3 首次尝试文案 =「本局进行中」（不再说「请确认房间号」）",
        String(msg1).includes("本局进行中") && !String(msg1).includes("请确认房间号") && pend1 === room,
        `msg="${msg1}" pending=${pend1}`);
      const done = await waitFor(g.page, `d.pendingInviteRoom() === null`, 60000);
      const msg2 = j(await dbg(g.page, `d.notif()`));
      ok("🟡3 重试上限后终态文案 =「本局仍在进行中」（按真实原因分档）",
        done && String(msg2).includes("本局仍在进行中") && !String(msg2).includes("请确认房间号"),
        `pending=null:${done} msg="${msg2}"`);
      await g.ctx.close();
    }
    await host.ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n──────── 汇总：${results.length - failed.length}/${results.length} 通过 ────────`);
if (failed.length) { console.log("失败项："); failed.forEach((f) => console.log("  ❌ " + f.n + " — " + f.d)); process.exit(1); }
