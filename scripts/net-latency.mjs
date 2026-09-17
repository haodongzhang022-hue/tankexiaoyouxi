//  scripts/net-latency.mjs ─ 延迟实测（HTTP 首字节 + WS 握手 + 中继 ping/pong RTT）
//
//  用途：量化"公网入口到底快了多少"，直接对比 cpolar 的 ≈600ms。
//        输出的 WS 中继 RTT 与游戏内 HUD 同一口径，可直接对比。
//
//  用法：
//    npm run net:latency -- http://<服务器IP>:3001           常驻服务器入口（推荐）
//    npm run net:latency -- http://127.0.0.1:3001            本机回环基线
//    npm run net:latency -- A B                              一次跑两个并对比
//
//  ⚠ CNB 云原生开发的端口预览地址（https://<环境ID>-3001.cnb.run）**不要**再用来测：
//     环境一回收该地址就 302 跳回 cnb.cool（因为它是通配域名，环境不存在时统一跳首页），
//     测出来的"延迟"是跳转的延迟，不是游戏链路的延迟。
//     本脚本检测到 302/3xx 会直接判为「地址已失效」并给出正确做法。
//     常驻入口请见 deploy/README.md。
//
//  环境变量：SAMPLES=20（ping 样本数，默认 20）
import { WebSocket } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = process.argv.slice(2).filter((a) => a && !a.startsWith("--"));
if (!targets.length) {
  console.error("用法: npm run net:latency -- <url> [第二个 url]");
  console.error("例:   npm run net:latency -- https://j3sxxxx-3001.cnb.run");
  process.exit(1);
}
const SAMPLES = Number(process.env.SAMPLES || 20);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const jit = s.reduce((a, b) => a + Math.abs(b - avg), 0) / s.length;
  return { text: `avg=${avg.toFixed(0)}ms p50=${pct(s, 0.5).toFixed(0)} p95=${pct(s, 0.95).toFixed(0)} max=${s[s.length - 1].toFixed(0)} jitter=${jit.toFixed(0)}`, avg };
};

async function httpTiming(base) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    try {
      const res = await fetch(base + "/", { cache: "no-store", redirect: "manual" });
      await res.arrayBuffer();
      // 3xx：多半是端口预览地址已随环境回收失效（cnb.run 通配域名会 302 跳 cnb.cool）
      if (res.status >= 300 && res.status < 400) {
        const to = res.headers.get("location") || "?";
        console.log(`    HTTP #${i + 1} ${res.status} → ${to}`);
        console.log(`    ✗ 该地址不是游戏服务（重定向到 ${to}），延迟数字无意义`);
        return null;
      }
      if (res.status !== 200) {
        console.log(`    HTTP #${i + 1} ${res.status}（非 200，可能服务没起）`);
        return null;
      }
      out.push(performance.now() - t);
      console.log(`    HTTP #${i + 1} ${res.status} ${out[out.length - 1].toFixed(0)}ms`);
    } catch (e) {
      console.log(`    HTTP #${i + 1} 失败: ${e.message}`);
      return null;
    }
  }
  return out;
}

function wsRtt(wsUrl) {
  return new Promise((resolve) => {
    const samples = [];
    let t0 = 0;
    let i = 0;
    let connectAt = 0;
    let welcomed = false;
    let started = false;
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000 });
    const tOpen = performance.now();
    const done = (why) => {
      try { ws.close(); } catch {}
      console.log(`    WS 握手 ${connectAt ? (connectAt - tOpen).toFixed(0) + "ms" : "未完成"}${why ? "（" + why + "）" : ""}`);
      resolve(samples.length ? stat(samples).avg : null);
    };
    const next = () => {
      if (i++ >= SAMPLES) return done("");
      t0 = performance.now();
      ws.send(JSON.stringify({ t: "ping", ts: i }));
    };
    const begin = () => { if (started) return; started = true; next(); };
    ws.on("open", () => { connectAt = performance.now(); console.log("    WS 已连接（页面与通道同源可用）"); });
    ws.on("message", (d) => {
      let m; try { m = JSON.parse(String(d)); } catch { return; }
      if (m.t === "welcome") { welcomed = true; setTimeout(begin, 200); }
      if (m.t === "pong" && welcomed) { samples.push(performance.now() - t0); setTimeout(next, 60); }
    });
    ws.on("error", (e) => { console.log(`    WS 失败: ${e.message}`); resolve(null); });
    setTimeout(() => done("超时"), 30000);
    setTimeout(() => { if (!welcomed && !started) done("未收到 welcome（该地址不是坦克联机服，或服务器没起）"); }, 8000);
  });
}

async function run(target) {
  const base = target.replace(/\/+$/, "");
  const wsUrl = base.replace(/^http/i, "ws");
  const isLoopback = /127\.0\.0\.1|localhost/.test(base);
  console.log(`\n=== 延迟实测: ${base} ${isLoopback ? "（本机回环基线）" : "（公网入口）"} ===`);
  console.log("  [HTTP 静态页首字节]");
  const http = await httpTiming(base);
  console.log("  [WS 中继 RTT（客户端→服务器→客户端，游戏内 HUD 同口径）]");
  const ws = await wsRtt(wsUrl);
  // 测量期间服务端未起时 ws=null，这里统一给出结论行
  console.log("");
  return { http, ws };
}

const results = [];
for (const t of targets) results.push({ target: t, ...(await run(t)) });

console.log("\n================ 结论 ================");
for (const r of results) {
  const loop = /127\.0\.0\.1|localhost/.test(r.target);
  console.log(`  ${loop ? "本机基线" : "公网入口"}: ${r.target}`);
  console.log(`    HTTP 页面加载 ${r.http ? stat(r.http).text : "失败"}`);
  console.log(`    WS 中继 RTT  ${r.ws != null ? `avg=${r.ws.toFixed(0)}ms` : "失败"}`);
}
const pub = results.find((r) => !/127\.0\.0\.1|localhost/.test(r.target));
const loc = results.find((r) => /127\.0\.0\.1|localhost/.test(r.target));
if (pub && loc && pub.ws != null && loc.ws != null) {
  console.log(`\n  公网额外开销 ≈ ${Math.max(0, pub.ws - loc.ws).toFixed(0)}ms（公网 RTT − 本机回环 RTT）`);
}
console.log("  参考：cpolar 免费链路实测 ≈600ms；<100ms 属正常，<50ms 体验良好。");
console.log("=====================================\n");
process.exit(0);
