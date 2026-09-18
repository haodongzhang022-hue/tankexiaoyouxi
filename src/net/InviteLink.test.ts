import { describe, it, expect } from "vitest";
import { parseInviteRoom, buildInviteUrl, buildLobbyUrl, isValidRoomId } from "./InviteLink";

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

  // v2.38：锁死「只认十进制正整数」——Number() 会把下面这些都当数字（太宽），必须显式拦下
  it("Number() 能接受、但不是十进制正整数的写法 → 一律不算房号", () => {
    for (const bad of [
      "?room=0x10",   // 16（十六进制）
      "?room=1e3",    // 1000（科学计数法）
      "?room=0b11",   // 3（二进制）
      "?room=0o17",   // 15（八进制）
      "?room=+5",     // 5（前导正号；URLSearchParams 还会把 + 解成空格）
      "?room=12.0",   // 12（小数写法）
      "?room=%205",   // " 5"（前导空格）
      "?room=5%20",   // "5 "（尾随空格）
      "?room=Infinity",
      "?room=1_000",  // 数字分隔符（Number 不认，双保险）
    ]) {
      expect(parseInviteRoom(bad)).toBeNull();
    }
  });

  it("十进制正整数仍照常解析（收窄语义不影响正常链接）", () => {
    expect(parseInviteRoom("?room=0007")).toBe(7);   // 前导零仍算十进制整数
    expect(parseInviteRoom("?room=99999")).toBe(99999);
  });

  it("?room= 非法但 ?r= 合法 → 取合法值（别名兜底）", () => {
    expect(parseInviteRoom("?room=abc&r=9")).toBe(9);
    expect(parseInviteRoom("?room=0x10&r=9")).toBe(9);
  });

  it("混合参数只取房间号，忽略其它入口参数", () => {
    expect(parseInviteRoom("?server=ws%3A%2F%2F1.2.3.4%3A3001&room=5&debug=1")).toBe(5);
  });
});

describe("isValidRoomId：与 parseInviteRoom 同一口径（避免双份校验漂移）", () => {
  it("正整数合法；0/负数/小数/非数非法", () => {
    expect(isValidRoomId(1)).toBe(true);
    expect(isValidRoomId(99999)).toBe(true);
    expect(isValidRoomId(0)).toBe(false);
    expect(isValidRoomId(-1)).toBe(false);
    expect(isValidRoomId(1.5)).toBe(false);
    expect(isValidRoomId(NaN)).toBe(false);
    expect(isValidRoomId(Infinity)).toBe(false);
    expect(isValidRoomId("7")).toBe(false);
  });

  it("parseInviteRoom 的判定与 isValidRoomId 一致（同口径回归）", () => {
    for (const n of [1, 7, 23, 99999]) {
      expect(isValidRoomId(n)).toBe(true);
      expect(parseInviteRoom(`?room=${n}`)).toBe(n);
    }
    for (const n of [0, -1, 1.5, NaN]) {
      expect(isValidRoomId(n)).toBe(false);
      expect(parseInviteRoom(`?room=${n}`)).toBeNull();
    }
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

  it("base 自带 query 时用 & 拼接（不再有未覆盖分支）", () => {
    expect(buildInviteUrl("https://h/?debug=1", 5)).toBe("https://h/?debug=1&room=5");
    expect(parseInviteRoom(new URL(buildInviteUrl("https://h/?debug=1", 5)).search)).toBe(5);
  });
});

describe("buildLobbyUrl：生成大厅链接（不带房间号）", () => {
  it("纯入口地址 → 原样返回（不带任何 query）", () => {
    expect(buildLobbyUrl("https://game.example.com/")).toBe("https://game.example.com/");
  });

  it("保留额外入口参数（server= 等），但不带房间号", () => {
    const url = buildLobbyUrl("http://1.2.3.4:3001/", "server=ws%3A%2F%2F1.2.3.4%3A3001");
    expect(url).toBe("http://1.2.3.4:3001/?server=ws%3A%2F%2F1.2.3.4%3A3001");
    expect(url).not.toContain("room=");
  });

  it("额外参数里混入房号也会被去掉（防御）", () => {
    expect(buildLobbyUrl("https://h/", "room=9&debug=1")).toBe("https://h/?debug=1");
  });

  it("大厅链接解析结果 = null（好友进大厅）", () => {
    expect(parseInviteRoom(new URL(buildLobbyUrl("https://h/")).search)).toBeNull();
    expect(parseInviteRoom(new URL(buildLobbyUrl("https://h/", "server=ws%3A%2F%2F1.2.3.4%3A3001")).search)).toBeNull();
  });

  it("不再依赖 buildInviteUrl(0)（旧实现会先生成 ?room=0 这条非法链接）", () => {
    expect(buildLobbyUrl("https://h/")).not.toContain("room=0");
  });
});
