//  scripts/net-tunnel.mjs ─ 排查看「当前进程能不能出公网」，并指向正确做法
//
//  ⚠ 重要纠正（上一版把大家带沟里了）：
//    CNB 云原生开发的端口预览（https://<环境ID>-{{port}}.cnb.run）**不是可长期使用的游戏入口**：
//      1. <环境ID> 每次环境重建都会变 → 分享出去的链接很快失效；
//      2. 环境离线约 10 分钟被平台回收 → 链接直接打不开；
//      3. cnb.run 是通配域名，环境不存在时一律 302 跳回 cnb.cool
//         → 这就是"点进去是写代码的网站、不是游戏"的直接原因。
//
//    正确定位：端口预览 = 开发时自己看一眼页面；公网可玩入口 = 常驻服务器
//    （见 deploy/README.md：Docker / 腾讯云轻量，入口固定如 http://<IP>:3001，重启不变）。
//
//  用法（CNB 云原生开发环境的 IDE 终端里跑，只为确认服务本身活着）：
//    npm run net:tunnel            打印本机/局域网地址 + 常驻部署指引
//    npm run net:tunnel -- --test  顺带实测本机回环基线
//    PORT=3000 npm run net:tunnel  指定端口（默认 3001）
//
//  脚本读不到平台变量时不会瞎猜地址，会明确给出可操作的下一步。
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LATENCY = path.join(__dirname, "net-latency.mjs");

const PORT = String(process.env.PORT || 3001);
const argv = process.argv.slice(2);
const wantTest = argv.includes("--test");

/** 平台注入的端口预览模板：https://<env>-{{port}}.cnb.run（不同版本变量名可能略有差异，全部兜一遍） */
const tplKeys = [
  "CNB_VSCODE_PROXY_URI",
  "CNB_VSCODE_PROXY_URI_HTTPS",
  "CNB_PROXY_URI",
  "CNB_PORT_PREVIEW_URI",
];
const found = [];
for (const k of tplKeys) {
  const v = process.env[k];
  if (v) found.push({ key: k, uri: v });
}

const buildUrl = (tpl) =>
  tpl.includes("{{port}}")
    ? tpl.replace(/\{\{port\}\}/g, PORT).replace(/\/$/, "")
    : tpl.replace(/\/$/, "");

const lan = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) lan.push(ni.address);
}

const wsUrl = (u) => u.replace(/^http/i, "ws");
const line = (s = "") => console.log(s);

line();
line("================ 坦克大战 · 联机公网入口 ================");

let publicUrl = "";
if (found.length) {
  publicUrl = buildUrl(found[0].uri);
  line(`  端口预览地址(仅开发自测): ${publicUrl}`);
  line(`  变量来源:                 ${found.map((f) => f.key).join(", ")}`);
  line(`  检测到的端口:             ${PORT}（服务器需监听 0.0.0.0:${PORT}）`);
  line();
  line("  ⚠ 这个地址【不要】当游戏入口发给好友，原因三选一都足以致命：");
  line("      · <环境ID> 每次环境重建都变，旧链接立即失效；");
  line("      · 环境离线约 10 分钟被平台回收，链接随之打不开；");
  line("      · cnb.run 是通配域名，环境一旦不存在就 302 跳回 cnb.cool（也就是\"进去是写代码的网站\"）；");
  line();
  line("  ▸ 开发自测（就你自己看）：浏览器开上面的地址，能看到《坦克大战深度版》说明服务是活的");
  line(`  ▸ 本机实测:  npm run net:latency -- http://127.0.0.1:${PORT}`);
  line("  ▸ 要长期可玩 / 要测真实延迟：用常驻服务器，见 deploy/README.md");
  line("      docker build -f deploy/Dockerfile -t tank-online . && docker run -d -p 3001:3001 --restart=always tank-online");
  line("      入口 = http://<服务器公网IP>:3001，固定不变，好友打开即进大厅");
} else {
  line("  ✗ 未检测到 CNB 端口预览变量（CNB_VSCODE_PROXY_URI 等）");
  line("    → 当前不在云原生开发环境（例如在 CI 容器里跑），平台不会分配端口预览域名。");
  line("    → 想做**长期可玩**的公网入口，本就不该依赖端口预览，请用常驻服务器：");
  line("      deploy/README.md（Docker / 腾讯云轻量，入口固定如 http://<IP>:3001）");
}

line();
line("  ── 本机基线（用来确认服务器本身正常，和公网数字区分开）──");
line(`  本机:      http://127.0.0.1:${PORT}`);
if (lan.length) line(`  局域网:    ${lan.map((ip) => `http://${ip}:${PORT}`).join("  ")}`);
line(`  基线实测:  npm run net:latency -- http://127.0.0.1:${PORT}`);
line(`  服务器没起:  npm run build && npm run online   （或 node server/index.mjs）`);
line("  ⚠ 以上是本机/局域网地址，好友打不开；要出公网且长期可用，请部署常驻服务器（deploy/README.md）");
line("=========================================================");
line();

if (wantTest) {
  const target = publicUrl || `http://127.0.0.1:${PORT}`;
  line(`=== 自动实测（目标 ${target}）===`);
  spawnSync(process.execPath, [LATENCY, target], { stdio: "inherit" });
  if (publicUrl) {
    line("=== 对照：本机回环基线 ===");
    spawnSync(process.execPath, [LATENCY, `http://127.0.0.1:${PORT}`], { stdio: "inherit" });
  }
}
