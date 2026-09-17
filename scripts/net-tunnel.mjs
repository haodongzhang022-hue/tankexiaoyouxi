//  scripts/net-tunnel.mjs ─ 发现并打印「公网可分享地址」（CNB 云原生开发端口预览），可选自动实测
//
//  为什么需要它：CNB 云原生开发给每个环境注入 CNB_VSCODE_PROXY_URI（形如
//    https://<环境ID>-{{port}}.cnb.run
//  把 {{port}} 换成联机服务器端口（默认 3001）就是**该端口的公网地址**，
//  页面与 WebSocket 同源、一个链接即可联机，不需要 cpolar / ngrok。
//
//  用法（在 CNB 云原生开发环境的 IDE 终端里跑）：
//    npm run net:tunnel            打印地址（含健康检查与实测命令）
//    npm run net:tunnel -- --test  打印地址并直接测延迟
//    PORT=3000 npm run net:tunnel  指定端口（默认 3001）
//
//  注意：脚本读不到平台变量时不会瞎猜地址，会明确告诉你去哪找（PORTS 面板 / 终端标签），
//        并把本机基线自测命令打出来 —— 保证「跑了一定有有用输出」。
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
  line(`  公网地址(端口预览): ${publicUrl}`);
  line(`  变量来源:           ${found.map((f) => f.key).join(", ")}`);
  line(`  检测到的端口:       ${PORT}（服务器需监听 0.0.0.0:${PORT}）`);
  line();
  line("  ▸ 玩法：把这个地址直接发给好友，打开即进大厅（页面 + WS 同源）");
  line(`  ▸ 本机实测:  npm run net:latency -- ${publicUrl}`);
  line(`  ▸ 健康检查:  curl -s -o /dev/null -w "%{http_code}\\n" ${publicUrl}/`);
  line(`  ▸ WS 地址:   ${wsUrl(publicUrl)}`);
} else {
  line("  ✗ 未检测到 CNB 端口预览变量（CNB_VSCODE_PROXY_URI 等）");
  line("    → 说明当前不在云原生开发环境（例如在 CI 容器里跑），平台不会分配公网域名。");
  line("    → 请在「云原生开发」环境（WebIDE / CodeBuddy Web）的终端里跑本命令；");
  line("      若仍未打印，看 WebIDE 的 **PORTS 面板**：映射端口后它会直接给出");
  line(`      https://<环境ID>-${PORT}.cnb.run 这类地址（也可从终端里 forw 出来的链接复制）。`);
}

line();
line("  ── 本机基线（用来确认服务器本身正常，和公网数字区分开）──");
line(`  本机:      http://127.0.0.1:${PORT}`);
if (lan.length) line(`  局域网:    ${lan.map((ip) => `http://${ip}:${PORT}`).join("  ")}`);
line(`  基线实测:  npm run net:latency -- http://127.0.0.1:${PORT}`);
line(`  服务器没起:  npm run build && npm run online   （或 node server/index.mjs）`);
line("  ⚠ 以上是本机/局域网地址，好友打不开；出公网必须走上面的端口预览（或本机挂 cpolar/ngrok）");
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
