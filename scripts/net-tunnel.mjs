//  scripts/net-tunnel.mjs ─ 打印当前公网入口（CNB 端口预览 / 本机 LAN），并可直接测延迟
//  用法（在 CNB 云原生开发环境或容器内执行）：
//    node scripts/net-tunnel.mjs            打印地址
//    node scripts/net-tunnel.mjs --test     打印地址并跑 net-latency 实测
//  说明：CNB 云原生开发会给环境注入 CNB_VSCODE_PROXY_URI（形如 https://xxx-{{port}}.cnb.run），
//        把 {{port}} 换成联机服务器端口（默认 3001）即为可分享的公网地址；无需 cpolar 等内网穿透。
import { spawnSync } from "node:child_process";
import os from "node:os";

const PORT = process.env.PORT || "3001";
const tpl = process.env.CNB_VSCODE_PROXY_URI || "";
const url = tpl ? tpl.replace(/\{\{port\}\}/g, PORT).replace(/\/$/, "") : "";

const lan = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) lan.push(ni.address);
}

console.log("\n=== 联机公网入口 ===");
if (url) {
  console.log(`  公网地址(端口预览): ${url}`);
  console.log(`  本机自测:           node scripts/net-latency.mjs ${url}`);
  console.log(`  好友入口:           把这个地址发给好友即可（页面 + WS 同源）`);
} else {
  console.log("  未检测到 CNB_VSCODE_PROXY_URI（不在云原生开发环境，或未开放端口预览）");
  console.log(`  局域网可先用:  ${lan.map((ip) => `http://${ip}:${PORT}`).join("  ") || "(无网卡)"}`);
  console.log(`  云原生开发里:  在 WebIDE PORTS 面板映射 ${PORT}，然后重跑本命令`);
}
console.log(`  健康检查:           curl -s -o /dev/null -w "%{http_code}\\n" ${url || `http://127.0.0.1:${PORT}`}/\n`);

if (process.argv.includes("--test") && url) {
  console.log("=== 延迟实测 ===");
  spawnSync(process.execPath, ["scripts/net-latency.mjs", url], { stdio: "inherit" });
}
