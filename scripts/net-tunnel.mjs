//  scripts/net-tunnel.mjs ─ 拿到「云原生开发端口预览地址」，确认它是不是真的游戏服务
//
//  结论先行（也是这次要回答的问题）：
//    云原生开发【可以】当临时服务器把联机跑起来、也【可以】用它测延迟 —— 端口预览就是平台给的
//    公网入口（页面 + WebSocket 同源，一个地址即可联机）。但它是**临时**的，只适合自测：
//      · <环境ID> 每次环境重建都会变 → 分享出去的链接很快失效；
//      · 环境被回收（关闭页面 10 分钟无操作 / 最长 18h / 凌晨 4-6 点强制）后链接直接打不开；
//      · 域名是通配的，环境不存在时一律 302 跳回 cnb.cool
//        —— 这就是上次"点进去是写代码的网站、不是游戏"的原因：那个环境已经回收了。
//
//  所以：想先用云原生开发把延迟测出来，用本脚本拿地址 + 探测；想长期可玩，用 deploy/README.md 的常驻服务器。
//
//  用法（在云原生开发环境的 IDE 终端里跑）：
//    npm run net:tunnel            打印预览地址 + 探测是不是游戏服务
//    npm run net:tunnel -- --test  顺带实测该地址的延迟（公网真实数字）
//    PORT=3000 npm run net:tunnel  指定端口（默认 3001）
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 预览地址变量表/落盘读写的「单一事实源」（与 server/index.mjs 共用同一份，避免漂移）
import { PREVIEW_TPL_KEYS, PUBLIC_URL_FILE, buildPreviewUrl, readPublicUrl, portOfUrl } from "../shared/preview-url.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LATENCY = path.join(__dirname, "net-latency.mjs");

const PORT = String(process.env.PORT || 3001);
const argv = process.argv.slice(2);
const wantTest = argv.includes("--test");

// 平台注入的端口预览模板（变量名表来自 shared/preview-url.mjs 单一事实源）
const found = [];
for (const k of PREVIEW_TPL_KEYS) {
  const v = process.env[k];
  if (v) found.push({ key: k, uri: v });
}

const lan = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const ni of list || []) if (ni.family === "IPv4" && !ni.internal) lan.push(ni.address);
}

const buildUrl = (tpl) => buildPreviewUrl(tpl, PORT);

/** 探测目标是不是我们的游戏服务（关键：识别平台「环境不存在」的 302 跳转，别把跳转当游戏）。 */
async function probe(url) {
  const out = { reachable: false, isGame: false, status: 0, location: "", note: "" };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url + "/__whoami", { redirect: "manual", signal: ac.signal });
    clearTimeout(t);
    out.reachable = true;
    out.status = res.status;
    out.location = res.headers.get("location") || "";
    if (res.status >= 300 && res.status < 400) {
      out.note = `预览返回 ${res.status} 跳转${out.location ? " → " + out.location : ""}（环境很可能已被回收，或地址不是本环境）`;
      return out;
    }
    const body = await res.text();
    out.isGame = body.includes("坦克大战");
    out.note = out.isGame ? "✔ 确认是我们的游戏服务，地址可用" : "✗ 返回的不是游戏服务（检查是否替换了端口占位符 / 环境是否还在）";
  } catch (e) {
    out.note = `不可达：${e && e.message ? e.message : e}`;
  }
  return out;
}

const line = (s = "") => console.log(s);

line();
line("================ 坦克大战 · 联机公网入口 ================");

// 落盘地址要校验端口/时效：文件可能来自上一次运行（端口不同）或环境早已回收
const fromFile = readPublicUrl({ port: PORT });
let publicUrl = found.length ? buildUrl(found[0].uri) : fromFile.url;
const urlPort = publicUrl ? portOfUrl(publicUrl) : "";
// 读文件得来的地址若校验不过（端口不符 / 过期 / 无元数据）→ 明确告警，别拿旧地址当真
if (!found.length && fromFile.url && !fromFile.ok) {
  line(`  ⚠ 落盘地址未通过校验：${fromFile.note}`);
  line(`     仍尝试探测，但若失败请先重新起服务器（npm run online）刷新 ${PUBLIC_URL_FILE}`);
}
if (!publicUrl && fromFile.note) line(`  ⚠ 忽略落盘地址：${fromFile.note}`);
if (publicUrl) {
  line(`  端口预览地址(临时·仅自测): ${publicUrl}`);
  if (found.length) line(`  变量来源:                   ${found.map((f) => f.key).join(", ")}`);
  else line(`  来源:                       ${PUBLIC_URL_FILE}（服务器启动时写入，${fromFile.note}）`);
  // 打印地址真实端口，避免"文件里是 9999 却显示 3001"的误导（端口编进主机名时说明走默认 443）
  line(`  地址端口:                   ${urlPort || (/^https:/i.test(publicUrl) ? "443（https 默认，端口编在主机名里）" : "80（http 默认）")}${urlPort && urlPort !== PORT ? `  ⚠ 与当前 PORT ${PORT} 不一致（服务器落盘的是别的端口）` : ""}`);
  line(`  服务器监听端口:             ${PORT}（须 0.0.0.0:${PORT}，否则预览代理回源不到）`);
  line();
  line("  ⚠ 这是**临时**入口，不要当长期游戏入口发给好友：");
  line("      · <环境ID> 每次环境重建都变 → 旧链接立即失效；");
  line("      · 环境回收（关页 10 分钟无操作 / 最长 18h / 凌晨 4-6 点强制）后链接打不开；");
  line("      · 环境不存在时一律 302 跳回 cnb.cool —— 上次「进去是写代码的网站」就是这个原因。");
  line();
  line("  ▸ 测延迟（这次要的就是它）：");
  line(`      npm run net:tunnel -- --test`);
  line(`      # 或单独：npm run net:latency -- ${publicUrl}`);
  line("  ▸ 好友一起测：把上面的地址发给好友（可先自己浏览器打开确认能看到《坦克大战深度版》）");
  line("  ▸ 长期可玩：部署常驻服务器，见 deploy/README.md（入口固定 http://<IP>:3001）");
} else {
  line("  ✗ 未检测到可用的端口预览地址（平台变量未注入，且 " + PUBLIC_URL_FILE + " 不存在/已失效）");
  if (fromFile.note) line("    落盘文件的情况：" + fromFile.note);
  line("    → 当前多半不在云原生开发环境（CI 容器不会分配公网域名）；");
  line("    → 在云原生开发环境里：WebIDE 的 **PORTS 面板** 映射 " + PORT + "，面板给出的地址即为预览地址；");
  line("      或先起服务器（npm run build && npm run online），它启动时会把预览地址写入 " + PUBLIC_URL_FILE + "。");
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

// ── 稳定入口（分享给好友的链接形状）──────────────────────────────
// 临时地址会变（环境重建换域名），但内部 id 恒定 → 链接不变；变了也由服务器 302 自动匹配。
try {
  const probe = publicUrl || `http://127.0.0.1:${PORT}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  const res = await fetch(probe + "/healthz", { signal: ac.signal });
  clearTimeout(t);
  const j = await res.json();
  if (j && j.sid) {
    line("  ── 稳定入口（发给好友的链接，换域名/换 IP 都自动匹配）──");
    line(`  稳定链接:   ${(publicUrl || `http://127.0.0.1:${PORT}`)}/${j.sid}/join/`);
    line(`  服务器内部 id: ${j.sid}（同一进程内恒定）`);
    line(`  当前入口:   ${j.current || "-"}   |  自动匹配表: ${j.matched} 条`);
    line(`  ⚠ 环境重建/服务器重启后内部 id 会换新 → 需要重新分享一条链接（其余情况无需改链接）`);
    line();
  }
} catch { /* healthz 拿不到就跳过（服务器可能没起，下面已有提示） */ }

if (publicUrl) {
  line("=== 探测预览地址是否为游戏服务 ===");
  const r = await probe(publicUrl);
  line(`  ${r.note}（HTTP ${r.status || "-"}）`);
  if (!r.isGame) line("  → 该地址不可用，别急着测延迟；先确认环境还在、端口已映射、服务器已起。");
  line();
}

if (wantTest) {
  const target = publicUrl || `http://127.0.0.1:${PORT}`;
  line(`=== 自动实测（目标 ${target}）===`);
  spawnSync(process.execPath, [LATENCY, target], { stdio: "inherit" });
  if (publicUrl) {
    line("=== 对照：本机回环基线（用于算「公网额外开销」）===");
    spawnSync(process.execPath, [LATENCY, `http://127.0.0.1:${PORT}`], { stdio: "inherit" });
  }
}
