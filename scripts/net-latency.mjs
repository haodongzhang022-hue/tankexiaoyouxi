//  scripts/net-latency.mjs ─ 隧道/公网入口延迟实测（HTTP + WebSocket 中继 RTT）
//  用途：把 cpolar 换成 CNB 云原生开发端口预览后，量化"公网入口到底快了多少"。
//  用法：
//    npm run net:latency -- https://j3sxxxx-3001.cnb.run
//    npm run net:latency -- http://127.0.0.1:3001              （本机基线，作对照）
//  输出：HTTP 首字节耗时 + WS 连接握手耗时 + 20 次 ping/pong 往返统计（avg/p50/p95/max/jitter）。
import { WebSocket } from "ws";

const target = (process.argv[2] || "").trim();
if (!target) {
  console.error("用法: npm run net:latency -- https://<env>-3001.cnb.run");
  process.exit(1);
}
const base = target.replace(/\/+$/, "");
const wsUrl = base.replace(/^http/i, "ws");
const SAMPLES = Number(process.env.SAMPLES || 20);

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const jit = s.reduce((a, b) => a + Math.abs(b - avg), 0) / s.length;
  return `avg=${avg.toFixed(0)}ms p50=${pct(s, 0.5).toFixed(0)} p95=${pct(s, 0.95).toFixed(0)} max=${s[s.length - 1].toFixed(0)} jitter=${jit.toFixed(0)}`;
};

async function httpTiming() {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try {
      const res = await fetch(base + "/", { cache: "no-store" });
      await res.arrayBuffer();
      out.push(performance.now() - t);
      process.stdout.write(`  HTTP #${i + 1} ${res.status} ${out[out.length - 1].toFixed(0)}ms\n`);
    } catch (e) {
      console.log(`  HTTP #${i + 1} 失败: ${e.message}`);
      return null;
    }
  }
  return out;
}

function wsRtt() {
  return new Promise((resolve) => {
    const samples = [];
    let t0 = 0;
    let i = 0;
    const ws = new WebSocket(wsUrl);
    const tOpen = performance.now();
    const done = (why) => {
      try { ws.close(); } catch {}
      console.log(`  WS 握手 ${(connectAt - tOpen).toFixed(0)}ms${why ? "（" + why + "）" : ""}`);
      resolve(samples.length ? stat(samples) : null);
    };
    let connectAt = 0;
    let welcomed = false;
    const next = () => {
      if (i++ >= SAMPLES) return done("");
      t0 = performance.now();
      ws.send(JSON.stringify({ t: "ping", ts: i }));
    };
    ws.on("open", () => { connectAt = performance.now(); console.log("  WS 已连接（同源可用）"); });
    // 等 welcome（确认是自家联机服）再开始探测，避开 tables 广播的干扰
    let started = false;
    const begin = () => { if (started) return; started = true; next(); };
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(String(d)); } catch { return; }
      if (m.t === "welcome") { welcomed = true; setTimeout(begin, 200); }
      if (m.t === "pong" && welcomed) { samples.push(performance.now() - t0); setTimeout(next, 60); }
    });
    ws.on("error", (e) => { console.log(`  WS 失败: ${e.message}`); resolve(null); });
    setTimeout(() => done("超时"), 30000);
    setTimeout(() => { if (!welcomed) done("未收到 welcome（该地址可能不是坦克联机服）"); }, 8000);
  });
}

console.log(`\n=== 延迟实测: ${base} ===`);
console.log("[HTTP 静态页]");
const http = await httpTiming();
console.log("[WS 中继 RTT（客户端→服务器→客户端，游戏内 HUD 同口径）]");
const ws = await wsRtt();
console.log("\n结论：");
console.log(`  HTTP 页面加载 ${http ? stat(http) : "失败"}`);
console.log(`  WS 中继 RTT ${ws || "失败"}`);
console.log("  参考：cpolar 免费链路实测 ≈600ms；<100ms 属正常，<50ms 体验良好。\n");
process.exit(0);
