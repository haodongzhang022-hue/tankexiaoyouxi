//  shared/preview-url.mjs ─ 端口预览地址的「单一事实源」（single source of truth）
//
//  为什么单独抽一个文件：服务器（server/index.mjs）与脚本（scripts/net-tunnel.mjs）
//  都需要「平台注入的预览模板变量名」这张表。此前两边各写一份（一边 5 项、一边 4 项），
//  已经漂移过一次 —— 抽到这里，任何一边改动都自动同步。
import fs from "node:fs";

/** 平台注入的端口预览模板变量名（不同平台版本变量名可能不同，全部兜一遍）。 */
export const PREVIEW_TPL_KEYS = [
  "CNB_VSCODE_PROXY_URI",
  "CNB_VSCODE_PROXY_URI_HTTPS",
  "CNB_PROXY_URI",
  "CNB_PORT_PREVIEW_URI",
  "CNB_PREVIEW_URI",
];

/** 服务器启动时把预览地址落盘到这里；IDE 终端/脚本读同一份。 */
export const PUBLIC_URL_FILE = process.env.PUBLIC_URL_FILE || "/tmp/tank-public-url.txt";

/** 落盘地址的默认保鲜期：超过就认为环境大概率已回收（CNB 环境最长 18h）。 */
export const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** 模板 → 实际地址：替换 {{port}} 并去掉尾斜杠；替换不干净（仍含 {{）视为无效。 */
export function buildPreviewUrl(tpl, port) {
  if (!tpl) return "";
  const url = String(tpl)
    .replace(/\{\{\s*port\s*\}\}/g, String(port))
    .replace(/\/+$/, "");
  if (!url || url.includes("{{")) return "";
  return url;
}

/** 从环境变量里挑第一个能用的模板，替换成本端口的预览地址；读不到返回 ""（不瞎猜）。 */
export function detectPreviewUrl(port, env = process.env) {
  for (const k of PREVIEW_TPL_KEYS) {
    const url = buildPreviewUrl(env[k], port);
    if (url) return url;
  }
  return "";
}

/** 把预览地址 + 元数据落盘（.txt 供人 cat，.json 供程序校验）。 */
export function writePublicUrl(port, env = process.env) {
  const url = detectPreviewUrl(port, env);
  if (!url) return "";
  const meta = { url, port: Number(port), pid: process.pid, at: new Date().toISOString() };
  try {
    fs.writeFileSync(PUBLIC_URL_FILE, url + "\n", "utf8");
    fs.writeFileSync(PUBLIC_URL_FILE + ".json", JSON.stringify(meta, null, 2), "utf8");
  } catch (e) {
    console.warn("[public-url] 写入失败（不影响服务）: " + (e && e.message));
  }
  return url;
}

/**
 * 读回服务器落盘的预览地址，并做有效性校验，避免拿「陈旧文件里的旧环境地址」去探测。
 * 校验：① 落盘端口 == 当前 PORT；② 写入时间未超保鲜期。
 * @returns {{url:string, meta:object|null, note:string, ok:boolean}}
 */
export function readPublicUrl({ port, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  try {
    const meta = JSON.parse(fs.readFileSync(PUBLIC_URL_FILE + ".json", "utf8"));
    const url = String(meta.url || "").trim();
    if (!url) return { url: "", meta, note: `落盘文件 ${PUBLIC_URL_FILE}.json 里没有地址`, ok: false };
    if (port != null && Number(meta.port) !== Number(port)) {
      return {
        url: "",
        meta,
        note: `落盘地址端口 ${meta.port} ≠ 当前 PORT ${port}（服务器与终端端口不一致，或文件是上一次运行留下的）`,
        ok: false,
      };
    }
    const at = Date.parse(meta.at);
    if (Number.isFinite(at)) {
      const age = Date.now() - at;
      if (age > maxAgeMs) {
        return {
          url: "",
          meta,
          note: `落盘地址已过期（${Math.round(age / 60000)} 分钟前写入，环境大概率已被回收）`,
          ok: false,
        };
      }
      return { url, meta, note: `${Math.round((Date.now() - at) / 1000)}s 前写入，端口 ${meta.port}`, ok: true };
    }
    return { url, meta, note: "落盘文件缺少时间戳，无法校验时效", ok: true };
  } catch { /* 没有 .json → 退回旧格式 .txt */ }
  try {
    const url = fs.readFileSync(PUBLIC_URL_FILE, "utf8").trim();
    if (url) {
      return { url, meta: null, note: "只有 .txt（无端口/时间戳元数据），无法校验有效性", ok: false };
    }
  } catch { /* 文件不存在：正常，可能不在云原生开发环境 */ }
  return { url: "", meta: null, note: "", ok: false };
}

/**
 * 取 URL 里**显式写出**的端口（没有则返回 ""）。
 * 预览地址常把端口编进主机名（https://env-3001.cnb.run，走 443），此时不能与本地 PORT 比较，
 * 否则会误报「端口不一致」。只有显式端口（http://1.2.3.4:9999）才用于一致性校验。
 */
export function portOfUrl(url) {
  try {
    return new URL(url).port || "";
  } catch { return ""; }
}
