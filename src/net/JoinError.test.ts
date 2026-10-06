import { describe, it, expect } from "vitest";
import { classifyJoinError, decideErrorFrame, frameKindOfCode, joinErrorText, inviteJoinErrorText, rejoinErrorText, ERR_HOST_ONLY, ERR_START_PRECONDITION, ERR_NO_REJOIN, ERR_ALREADY_IN_TABLE, ERR_ROOM_FULL, ERR_ROOM_NOT_FOUND, ERR_ROOM_PLAYING } from "./JoinError";
// @ts-expect-error —— shared/ 是给 server(mjs) 共用的 .mjs（无 .d.ts）：本用例就是要读它的**真值**
import * as sharedCodesRaw from "../../shared/net-error-codes.mjs";
const sharedCodes = sharedCodesRaw as Record<string, unknown>;

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

// ── 评审 🔴1：错误帧的**单一决策入口**（流程差异只体现在入参，不靠调用方手写分支）──
describe("decideErrorFrame：文案口径 + 是否重试单点决定", () => {
  it("🔴 回归：大厅里的「不是加入错误」码 → 原样服务端原文，绝不说成「加入房间失败」", () => {
    for (const c of [ERR_HOST_ONLY, ERR_START_PRECONDITION, ERR_NO_REJOIN]) {
      const d = decideErrorFrame(c, "仅房主可开始", { attemptJoin: false, roomId: 7, rawMsg: "仅房主可开始" });
      expect(d.kind).toBe("unknown");       // 不是加入错误的码 → 认不出，不瞎猜
      expect(d.isJoinFailure).toBe(false);  // ★ 关键：不得被渲染成"加入房间失败"
      expect(d.text).toBe("仅房主可开始");    // 原样带出，玩家看到的是真实原因
      expect(d.text).not.toContain("加入房间");
      expect(d.retry).toBe(false);
    }
  });

  it("🔴 回归：真·加房间请求（attemptJoin=true）→ 按码分档，unknown 也带原文", () => {
    const full = decideErrorFrame(ERR_ROOM_FULL, "房间已满", { attemptJoin: true, roomId: 3, rawMsg: "房间已满" });
    expect(full.kind).toBe("full");
    expect(full.isJoinFailure).toBe(true);
    expect(full.text).toContain("已满");
    expect(full.stopFlow).toBe(true);         // 邀请流程：一次定性，停止空转重试

    const nf = decideErrorFrame(ERR_ROOM_NOT_FOUND, "房间不存在", { attemptJoin: true, roomId: 99, rawMsg: "房间不存在" });
    expect(nf.text).toContain("新链接");

    const playing = decideErrorFrame(ERR_ROOM_PLAYING, "该房间对局中", { attemptJoin: true, roomId: 5, rawMsg: "该房间对局中" });
    expect(playing.retry).toBe(true);         // 唯一会重试：等本局结束
    expect(playing.stopFlow).toBe(false);

    const unknown = decideErrorFrame("brand_new_code", "服务端新错误", { attemptJoin: true, roomId: 5, rawMsg: "服务端新错误" });
    expect(unknown.isJoinFailure).toBe(true);
    expect(unknown.text).toContain("服务端新错误");   // 不吞原因
    expect(unknown.retry).toBe(false);
  });

  it("🔴 回归：重连场景用「重连对局」口径，且**不再**说成加入房间失败", () => {
    const d = decideErrorFrame(ERR_NO_REJOIN, "重连令牌无效或已失效", { rejoining: true, roomId: 12, rawMsg: "重连令牌无效或已失效" });
    expect(d.isJoinFailure).toBe(false);
    expect(d.text).toContain("重连令牌无效或已失效");  // 不是加入错误 → 原文（不臆造"加入房间失败"）
    expect(d.text).toContain("已回到大厅");           // 但**必须**说清已回大厅
    expect(d.text).not.toContain("加入房间");
    // 重连桌上恰好"满了/没了"这两个**加入错误**码：按重连口径渲染，并说明已回大厅
    for (const [code, raw, word] of [[ERR_ROOM_FULL, "房间已满", "已被占满"], [ERR_ROOM_NOT_FOUND, "房间不存在", "已不存在"]] as const) {
      const r = decideErrorFrame(code, raw, { rejoining: true, roomId: 12, rawMsg: raw });
      expect(r.isJoinFailure).toBe(true);
      expect(r.text).toContain("重连对局");
      expect(r.text).toContain("已回到大厅");          // ★ 关键：玩家必须看到"已回大厅"
      expect(r.text).toContain(word);
      expect(r.text).not.toContain("邀请");
    }
  });

  it("重试只在「加房间 + 本局进行中」时成立（非加入错误不得空转重试）", () => {
    // attemptJoin 省略 = "只有码本身说明是加入错误才算"（大厅里点桌 / 邀请进房都用它）
    expect(decideErrorFrame(ERR_ROOM_PLAYING, "对局中", { rawMsg: "对局中" }).retry).toBe(true);
    expect(decideErrorFrame(ERR_ROOM_PLAYING, "对局中", { rawMsg: "对局中" }).stopFlow).toBe(false);
    expect(decideErrorFrame(ERR_HOST_ONLY, "仅房主", { attemptJoin: false, rawMsg: "仅房主" }).retry).toBe(false);
    // ⚠ attemptJoin:false 是**明说"这次不是在加房间"** → 连 playing 也不许重试
    //   （这是修掉「重连失败 → 3s 一次无限重试」的那道闸，见下方归属用例）
    expect(decideErrorFrame(ERR_ROOM_PLAYING, "对局中", { attemptJoin: false, rawMsg: "对局中" }).retry).toBe(false);
  });

  it("重连文案出口与 rejoinErrorText 一致（同一句话只有一处定义）", () => {
    const d = decideErrorFrame(ERR_ROOM_FULL, "房间已满", { rejoining: true, roomId: 12, rawMsg: "房间已满" });
    expect(d.text).toBe(rejoinErrorText("full", 12));
  });
});

// ── 评审 🔴2：前后端常量**同值**必须由代码保证（此前前端手抄一份，漂移时 CI 无感）──
describe("🔴 前后端机器码同源（禁止手抄）", () => {
  it("前端导出的常量 === shared/net-error-codes.mjs 的值（逐一比对）", () => {
    const c = sharedCodes;
    expect(ERR_ROOM_NOT_FOUND).toBe(c.ERR_ROOM_NOT_FOUND);
    expect(ERR_ROOM_FULL).toBe(c.ERR_ROOM_FULL);
    expect(ERR_ROOM_PLAYING).toBe(c.ERR_ROOM_PLAYING);
    expect(ERR_HOST_ONLY).toBe(c.ERR_HOST_ONLY);
    expect(ERR_START_PRECONDITION).toBe(c.ERR_START_PRECONDITION);
    expect(ERR_NO_REJOIN).toBe(c.ERR_NO_REJOIN);
  });

  it("JoinError.ts 里不得再出现字面量机器码（手抄即漂移源）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./JoinError.ts", import.meta.url), "utf8");
    // 只查"赋值/比较"用法；注释与文档里提到码名是允许的
    for (const lit of ['= "room_full"', '= "room_not_found"', '= "room_playing"', '= "host_only"', '= "start_precondition"', '= "no_rejoin"', '=== "room_full"', '=== "room_playing"']) {
      expect(src, `JoinError.ts 不应手抄机器码字面量：${lit}`).not.toContain(lit);
    }
    expect(src).toContain('from "../../shared/net-error-codes.mjs"');   // 必须真读契约
  });
});

// ── 评审 🟡1：NOT_ADD_ERRORS 必须真被消费（不许"定义后零引用"的死代码）──
describe("frameKindOfCode：展示口径由码单点决定（真查 NOT_ADD_ERRORS）", () => {
  it("明确不是加入错误的码 → not_add（永远原样原文，不被「这次在加房间」带偏）", () => {
    for (const c of [ERR_HOST_ONLY, ERR_START_PRECONDITION, ERR_ALREADY_IN_TABLE]) {
      expect(frameKindOfCode(c, false)).toBe("not_add");
      expect(frameKindOfCode(c, true)).toBe("not_add");   // ★ 即便调用方说"在加房间"也不改口径
    }
  });

  it("典型加入错误码 → join（无需调用方声明）", () => {
    for (const c of [ERR_ROOM_FULL, ERR_ROOM_NOT_FOUND, ERR_ROOM_PLAYING]) {
      expect(frameKindOfCode(c, false)).toBe("join");
      expect(frameKindOfCode(c, true)).toBe("join");
    }
  });

  it("服务端新增码 / 无码 → other，除非调用方确认「这次真在加房间」", () => {
    expect(frameKindOfCode("brand_new_code", false)).toBe("other");
    expect(frameKindOfCode("brand_new_code", true)).toBe("join");
    expect(frameKindOfCode(undefined, true)).toBe("other");   // 旧服务端：无码可判，交文案兜底
    expect(frameKindOfCode("", true)).toBe("other");
  });

  it("与 decideErrorFrame 的口径一致（同一判定只有一处实现）", () => {
    expect(decideErrorFrame(ERR_HOST_ONLY, "仅房主", { attemptJoin: true, rawMsg: "仅房主" }).frameKind).toBe("not_add");
    expect(decideErrorFrame(ERR_ROOM_FULL, "已满", { attemptJoin: true, rawMsg: "已满" }).frameKind).toBe("join");
    expect(decideErrorFrame("x", "原文", { attemptJoin: true, rawMsg: "原文" }).frameKind).toBe("join");
  });
});

// ── 评审 🔴（v3.0.4）：error 帧的**归属**必须由发起动作决定，不能只看机器码 ──
// 为什么这条要在单测里钉：服务端错误码是**流程无关**的 —— 同一个 `room_playing` 既可能是
// "我加不进这张桌"（join），也可能是"我接不回那一局"（rejoin）。v2.42 把"值得重试"的结论
// 按邀请流程套给了所有房间内错误，于是"重连一个进行中的对局"被当成"邀请进房值得重试"，
// 3 秒一次无限重试，永远不可能成功（实测：起服务器 + 真发 rejoin 可复现）。
describe("🔴 错误帧归属：同一个码在加入/重连两条流程里必须得出不同结论", () => {
  it("room_playing 作为**加入**错误 → 值得重试（等本局结束再点一次）", () => {
    const d = decideErrorFrame(ERR_ROOM_PLAYING, "该房间对局中", { attemptJoin: true, roomId: 7, rawMsg: "该房间对局中" });
    expect(d.retry).toBe(true);
    expect(d.text).not.toContain("已回到大厅");   // 加入流程的文案不该出现重连语义
  });

  it("room_playing 作为**重连**结论 → 绝不可重试，且必须说清「已回到大厅」", () => {
    const d = decideErrorFrame(ERR_ROOM_PLAYING, "该房间对局中", { rejoining: true, roomId: 7, rawMsg: "该房间对局中" });
    // ★ 关键：重连场景的重试必须是 false —— 否则就是本次修的无限重试回路
    expect(d.retry).toBe(false);
    expect(d.text).toContain("已回到大厅");
    expect(d.text).not.toContain("加入房间");
    expect(d.stopFlow).toBe(false);              // 重连没有"进房流程"要停
  });

  it("重连分支优先于邀请分支（调用方按 rejoining 先判，不看 autoJoinRoom）", () => {
    // 这条锁的是调用顺序契约：只要带 rejoining，文案就必须是重连口径，
    // 无论此刻是否还挂着某个 autoJoinRoom（重连卡与邀请链接可能同时存在）。
    const rejoin = decideErrorFrame(ERR_NO_REJOIN, "重连令牌无效或已失效", { rejoining: true, roomId: 12, rawMsg: "重连令牌无效或已失效" });
    expect(rejoin.text).toContain("已回到大厅");
    expect(rejoin.text).toContain("重连令牌无效或已失效");
  });
});
