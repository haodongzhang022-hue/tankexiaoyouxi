import { describe, it, expect } from "vitest";
import { parseIceServers } from "./RtcPeer";

// VITE_ICE_SERVERS（构建期注入）的解析契约：配了才有 STUN，没配 = 纯直连回落 WS。
// 之所以单独测：deploy/README.md 承诺了这个变量，必须确保它真的被代码消费。
describe("parseIceServers（VITE_ICE_SERVERS 解析）", () => {
  it("未配置 → 空数组（纯直连：仅同机/局域网，失败回落 WS）", () => {
    expect(parseIceServers(undefined)).toEqual([]);
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers("")).toEqual([]);
    expect(parseIceServers("  ")).toEqual([]);
  });
  it("单个 STUN", () => {
    expect(parseIceServers("stun:stun.qq.com")).toEqual([{ urls: "stun:stun.qq.com" }]);
  });
  it("逗号分隔多个 + 去空白", () => {
    expect(parseIceServers("stun:stun.qq.com, stun:1.2.3.4:3478")).toEqual([
      { urls: "stun:stun.qq.com" },
      { urls: "stun:1.2.3.4:3478" },
    ]);
  });
  it("turn URL 写法透传（含凭证/端口）", () => {
    expect(parseIceServers("turn:user:pass@coturn.example.com:3478")).toEqual([
      { urls: "turn:user:pass@coturn.example.com:3478" },
    ]);
  });
});
