import { describe, it, expect } from "vitest";
import { parseInviteRoom, buildInviteUrl, stripRoomParams, isValidRoomId } from "./InviteLink";

describe("parseInviteRoom：房间号绑定", () => {
  it("带房间号 → 返回桌号（好友直接坐进该桌）", () => {
    expect(parseInviteRoom("?room=7")).toBe(7);
    expect(parseInviteRoom("room=12")).toBe(12);
    expect(parseInviteRoom("?r=3")).toBe(3);
    expect(parseInviteRoom("?table=40")).toBe(40);
  });

  it("不带房间号 → null（好友进大厅，自己选桌）", () => {
    expect(parseInviteRoom("")).toBeNull();
    expect(parseInviteRoom("?debug=1")).toBeNull();
    expect(parseInviteRoom("?server=ws%3A%2F%2F1.2.3.4%3A3001")).toBeNull();
  });

  it("房间号非法 → 一律按「不带房间号」处理，不会去猜", () => {
    for (const bad of ["?room=", "?room=abc", "?room=0", "?room=-3", "?room=1.5", "?room=NaN"]) {
      expect(parseInviteRoom(bad)).toBeNull();
    }
  });

  it("?room= 非法但 ?r= 合法 → 取合法值（别名兜底）", () => {
    expect(parseInviteRoom("?room=abc&r=9")).toBe(9);
  });

  it("混合参数只取房间号，忽略其它入口参数", () => {
    expect(parseInviteRoom("?server=ws%3A%2F%2F1.2.3.4%3A3001&room=5&debug=1")).toBe(5);
  });
});

describe("buildInviteUrl：生成带房间号的邀请链接", () => {
  it("带房间号，且保留额外入口参数", () => {
    expect(buildInviteUrl("https://game.example.com/", 7)).toBe("https://game.example.com/?room=7");
    expect(buildInviteUrl("http://1.2.3.4:3001/", 7, "server=ws%3A%2F%2F1.2.3.4%3A3001"))
      .toBe("http://1.2.3.4:3001/?server=ws%3A%2F%2F1.2.3.4%3A3001&room=7");
  });

  it("生成的链接能被 parseInviteRoom 还原（闭环）", () => {
    const url = buildInviteUrl("https://game.example.com/", 23, "debug=1");
    expect(parseInviteRoom(new URL(url).search)).toBe(23);
  });

  it("房间号必须来自服务器桌号 → 非法桌号不进链接", () => {
    expect(isValidRoomId(1)).toBe(true);
    expect(isValidRoomId(0)).toBe(false);
    expect(isValidRoomId(-1)).toBe(false);
    expect(isValidRoomId(1.5)).toBe(false);
    expect(isValidRoomId(NaN)).toBe(false);
  });
});

describe("stripRoomParams：生成大厅链接（不带房间号）", () => {
  it("去掉所有房间号参数，其余参数保留", () => {
    expect(stripRoomParams("?room=7&debug=1")).toBe("debug=1");
    expect(stripRoomParams("?room=7&r=8&table=9")).toBe("");
  });

  it("大厅链接解析结果 = null（好友进大厅）", () => {
    expect(parseInviteRoom("?" + stripRoomParams("?room=7"))).toBeNull();
  });
});
