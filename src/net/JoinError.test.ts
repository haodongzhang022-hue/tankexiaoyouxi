import { describe, it, expect } from "vitest";
import { classifyJoinError, joinErrorText, inviteJoinErrorText } from "./JoinError";

// Issue #16 D1：加入房间失败的**分档判定**必须与中文文案解耦。
// 判据 = 服务端 error 帧的机器码（shared/net-error-codes.mjs）；
// 关键词只在「新前端 + 旧服务端（无 code）」时兜底。

describe("classifyJoinError：按服务端机器码分档（主路径）", () => {
  it("room_full → 已满，不重试", () => {
    const v = classifyJoinError("room_full", "房间已满");
    expect(v).toEqual({ kind: "full", retry: false, via: "code" });
  });

  it("room_not_found → 不存在，不重试（提示要新链接）", () => {
    const v = classifyJoinError("room_not_found", "房间不存在");
    expect(v).toEqual({ kind: "not_found", retry: false, via: "code" });
  });

  it("room_playing → 本局进行中，**唯一会重试**的情形", () => {
    const v = classifyJoinError("room_playing", "该房间对局中");
    expect(v).toEqual({ kind: "playing", retry: true, via: "code" });
  });

  it("其它机器码（不是加入房间错误 / 未知新码）→ 明确不重试，不瞎猜", () => {
    for (const c of ["already_in_table", "host_only", "start_precondition", "no_rejoin", "brand_new_code"]) {
      const v = classifyJoinError(c, "随便什么文案");
      expect(v.kind).toBe("unknown");
      expect(v.retry).toBe(false);
      expect(v.via).toBe("code");
    }
  });

  // ★ 评审返工（v2.41）核心：room_not_found / room_full 是 join 处理器直接发出的**加入错误**，
  //   绝不能被「不是加入错误」的黑名单剔掉（剔掉就判不出 not_found / full，文案退化成通用失败）。
  it("🔴 回归：room_not_found / room_full 必须判得出（不得被「不是加入错误」清单剔出映射）", () => {
    expect(classifyJoinError("room_not_found", "房间不存在")).toEqual({ kind: "not_found", retry: false, via: "code" });
    expect(classifyJoinError("room_full", "房间已满")).toEqual({ kind: "full", retry: false, via: "code" });
    // 服务端发这两个码时，即便文案被本地化/清空，分档也不变
    expect(classifyJoinError("room_not_found", "").kind).toBe("not_found");
    expect(classifyJoinError("room_full", "").kind).toBe("full");
    // 老实现的退化路径（拿别的流程的结论套过来）会落到这里：文案丢掉「要新链接」
    const degraded = joinErrorText(classifyJoinError("room_not_found", "房间不存在").kind, 99999);
    expect(degraded).toContain("新链接");
  });

  // ★ 本 Issue 的**核心回归锁**：服务端把文案换成机器码/英文/加前缀后，行为不得退化
  it("🔴 回归（D1）：服务端换文案（本地化/加前缀/机器码）后行为不变", () => {
    // 「对局中」曾经靠 msg.includes("对局中") 才能重试 —— 文案一变就丢掉重试能力
    expect(classifyJoinError("room_playing", "room is playing").retry).toBe(true);
    expect(classifyJoinError("room_playing", "[ERR] ROOM_PLAYING").retry).toBe(true);
    expect(classifyJoinError("room_playing", "该桌正在进行一局对战").retry).toBe(true);
    // 「不存在」曾经靠 msg.includes("不存在") 才能给出"要新链接"文案
    expect(classifyJoinError("room_not_found", "room not found").kind).toBe("not_found");
    expect(classifyJoinError("room_not_found", "404").kind).toBe("not_found");
    // 「已满」同理
    expect(classifyJoinError("room_full", "table is full").kind).toBe("full");
    // 旧文案下的判定与新文案一致（同一 code 同结果）
    expect(classifyJoinError("room_full", "房间已满")).toEqual(classifyJoinError("room_full", "FULL"));
  });

  it("有 code 时**不**采信文案（即使文案与 code 矛盾，也以 code 为准）", () => {
    // 服务端 code 说"满了"，文案里恰好带"对局中" → 必须按 code 判（不重试）
    expect(classifyJoinError("room_full", "该房间对局中，且已满").retry).toBe(false);
  });
});

describe("classifyJoinError：旧服务端（无 code）关键词兜底", () => {
  it("缺 code 时按旧关键词兜底，保证混版本部署不退化", () => {
    expect(classifyJoinError(undefined, "房间已满")).toEqual({ kind: "full", retry: false, via: "msg" });
    expect(classifyJoinError(undefined, "房间不存在")).toEqual({ kind: "not_found", retry: false, via: "msg" });
    expect(classifyJoinError(undefined, "该房间对局中")).toEqual({ kind: "playing", retry: true, via: "msg" });
  });

  it("空 code / 非字符串 code 也走兜底；认不出的文案 → unknown 不重试", () => {
    expect(classifyJoinError("", "房间已满").via).toBe("msg");
    expect(classifyJoinError(null, "房间已满").via).toBe("msg");
    expect(classifyJoinError(123, "房间已满").via).toBe("msg");
    expect(classifyJoinError(undefined, "连不上服务器")).toEqual({ kind: "unknown", retry: false, via: "msg" });
    expect(classifyJoinError(undefined, undefined)).toEqual({ kind: "unknown", retry: false, via: "msg" });
  });

  it("code 与 msg 同时缺失/均为空 → unknown（不空转重试）", () => {
    for (const [c, m] of [[undefined, undefined], ["", ""], [null, null]] as const) {
      const v = classifyJoinError(c, m);
      expect(v.kind).toBe("unknown");
      expect(v.retry).toBe(false);
    }
  });
});

describe("joinErrorText：文案只做展示，且必须说清「什么原因 + 怎么办」", () => {
  it("已满 → 提示等空位/选别的桌", () => {
    const t = joinErrorText("full", 3);
    expect(t).toContain("#3");
    expect(t).toContain("已满");
    expect(t).toContain("等一位空位");
  });

  it("不存在 → 提示要新链接（旧实现会退化成通用「加入失败」）", () => {
    const t = joinErrorText("not_found", 99999);
    expect(t).toContain("已不存在");
    expect(t).toContain("新链接");
  });

  it("对局中 → 提示等本局结束", () => {
    expect(joinErrorText("playing", 7)).toContain("本局进行中");
  });

  it("未知错误 → 原样带出服务端文案（便于排障），不吞掉原因", () => {
    const t = joinErrorText("unknown", 7, "连不上服务器");
    expect(t).toContain("连不上服务器");
    expect(t).toContain("#7");
  });

  it("kind 入参宽松：需要序列化的判定结果可直接透传（不必二次手写 \"playing\"）", () => {
    const serialized: { kind: string } = JSON.parse(JSON.stringify({ kind: classifyJoinError("room_playing", "x").kind }));
    expect(joinErrorText(serialized.kind, 5)).toContain("本局进行中");
  });

  it("房号未知（无房号）时不出现 undefined/null 噪声", () => {
    for (const t of [joinErrorText("unknown", null, "服务端说不行"), joinErrorText("unknown", undefined, "服务端说不行")]) {
      expect(t).not.toContain("undefined");
      expect(t).not.toContain("null");
      expect(t).toContain("服务端说不行");
    }
  });

  it("inviteJoinErrorText：邀请流程的前后缀（已停在大厅）由调用方上下文决定", () => {
    const t = inviteJoinErrorText(classifyJoinError("room_not_found", "房间不存在").kind, 42);
    expect(t).toContain("#42");
    expect(t).toContain("已不存在");
    expect(t).toContain("已停在大厅");
    expect(t).toContain("新链接");
  });
});
