//  RtcPeer.ts ─ v2.10 快照链路直连（WebRTC DataChannel）
//  目的：同网段/局域网对战时，快照走 P2P 低延迟通道，拉掉"中继一跳"。
//  原则与约束：
//    - 信令仍走现有 WS 中继（服务器仅转发 rtc_signal 给目标 clientId，不感知内容）；
//    - 不做 STUN/TURN（公网跨 NAT 不保证连通）→ 连通失败自动保持 WS 兜底，游戏不受影响；
//    - 环境变量 VITE_ICE_SERVERS（如 "stun:stun.qq.com" 逗号分隔）可注入 STUN 服务器；
//      两端都配置时公网 P2P 直连成功率更高（快照少走一跳中继，实测再降 RTT）；
//      不配置则行为与原来完全一致（纯直连，失败回落 WS）；
//    - 快照"双发"：WS 兜底 + P2P（P2P 帧先到即先渲染，成员端按帧号天然去重）。
export type RtcRole = "host" | "member";
export type RtcState = "idle" | "negotiating" | "connected" | "failed" | "closed";

const ICE_TIMEOUT_MS = 900; // host 候选收集超时限（同机/局域网足够）

/** ICE 服务器（可选）：VITE_ICE_SERVERS="stun:stun.qq.com,stun:stun.cloudflare.com"；留空=纯直连 */
const ICE_SERVERS: RTCIceServer[] = (() => {
  try {
    const raw = (import.meta as { env?: Record<string, string> }).env?.VITE_ICE_SERVERS || "";
    return raw.split(",").map((s) => s.trim()).filter(Boolean).map((urls) => ({ urls }));
  } catch { return []; }
})();

export class RtcPeer {
  state: RtcState = "idle";
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private noopCb = () => {};

  /** 成员端收到主机 P2P 快照（data 为原始 DeltaSnapshot 结构）；主机端为 null */
  onRemoteData: ((data: unknown) => void) | null = null;
  /** 状态变化（供 main 更新 HUD / e2e 读取 __rtc.state） */
  onStateChange: ((s: RtcState) => void) | null = null;

  constructor(
    private sendSignal: (to: number, payload: unknown) => void,
    private peerId: number,
    private role: RtcRole,
  ) {}

  /** 开始协商：host 发起 offer；member 等待 offer。返回最终状态（异步等待最大 ~1s） */
  async start(): Promise<RtcState> {
    if (this.state !== "idle") return this.state;
    this.state = "negotiating";
    try {
      this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS }); // 默认纯直连；配置 VITE_ICE_SERVERS 后公网更易连通
      this.pc.onicecandidate = (e) => {
        if (e.candidate) this.sendSignal(this.peerId, { kind: "ice", candidate: e.candidate.toJSON() });
      };
      if (this.role === "host") {
        this.dc = this.pc.createDataChannel("snap");
        this.hookChannel(this.dc);
      } else {
        this.pc.ondatachannel = (e) => { this.dc = e.channel; this.hookChannel(this.dc); };
      }
      if (this.role === "host") {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.sendSignal(this.peerId, { kind: "offer", sdp: this.pc.localDescription });
      }
      // 等待连接建立或超时
      const result = await new Promise<RtcState>((resolve) => {
        const finish = (s: RtcState) => { clearTimeout(tomb); this.setState(s); resolve(s); };
        const tomb = setTimeout(() => finish(this.dc?.readyState === "open" ? "connected" : "failed"), 5000);
        const onOpen = () => finish("connected");
        if (this.dc) this.dc.addEventListener("open", onOpen, { once: true });
        this.pc!.addEventListener("connectionstatechange", () => {
          if (this.pc?.connectionState === "connected" && this.dc?.readyState === "open") finish("connected");
          if (this.pc?.connectionState === "failed") finish("failed");
        });
      });
      return result;
    } catch {
      this.setState("failed");
      return "failed";
    }
  }

  /** 收到的信令（来自服务器 rtc_signal 中继） */
  async onSignal(from: number, payload: { kind: string; sdp?: unknown; candidate?: unknown }): Promise<void> {
    if (from !== this.peerId || !payload || this.state === "closed") return;
    try {
      if (payload.kind === "offer" && this.role === "member" && this.pc) {
        await this.pc.setRemoteDescription(payload.sdp as RTCSessionDescriptionInit);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal(this.peerId, { kind: "answer", sdp: this.pc.localDescription });
      } else if (payload.kind === "answer" && this.role === "host" && this.pc) {
        await this.pc.setRemoteDescription(payload.sdp as RTCSessionDescriptionInit);
      } else if (payload.kind === "ice" && this.pc) {
        await this.pc.addIceCandidate(payload.candidate as RTCIceCandidateInit);
      }
    } catch { /* 信令乱序/无效：忽略，失败自然回落 WS */ }
  }

  /** 通道就绪（HUD/发送方据此判断） */
  ready(): boolean { return this.state === "connected" && this.dc?.readyState === "open"; }

  /** 主机：把快照推入 P2P 通道（WS 兜底仍由 main 负责） */
  send(obj: unknown): void {
    if (!this.ready()) return;
    try { this.dc!.send(JSON.stringify(obj)); } catch { /* 通道抖动：下一帧恢复 */ }
  }

  close(): void { this.setState("closed"); try { this.dc?.close(); this.pc?.close(); } catch { /* 忽略 */ } }

  private hookChannel(dc: RTCDataChannel): void {
    dc.onopen = () => this.ready();
    dc.onmessage = (e) => { if (this.onRemoteData) this.onRemoteData(JSON.parse(e.data as string)); };
  }
  private setState(s: RtcState): void {
    if (this.state === s) return;
    this.state = s;
    if (this.onStateChange) this.onStateChange(s);
    else this.noopCb();
  }
}