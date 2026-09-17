// ============================================================================
//  net-sync-core / transports.ts ─ 可插拔传输实现（同一机制多实现，按环境/参数选择）
//  ----------------------------------------------------------------------------
//  - WsTransport：WebSocket 消息通道（主传输，中继兜底）
//  - RtcTransport：WebRTC DataChannel（P2P 低延迟通道，快照双发用）
//  约定：仅实现「消息收发」语义（不关心协议内容），序列化由引擎统一处理；
//        信令（offer/answer/ice）不属于传输层，由项目复用大厅中继。
//  版本：2026-09-12 v1.0.0（固化自 RtcPeer 的已验证行为：失败自然回落 WS，不影响游戏）。
// ============================================================================

import type { Transport } from "./core";

/** 类 WebSocket 的最小可用形态（浏览器 WebSocket 天然满足；Node ws 亦满足） */
export interface WsLike {
  send(data: string): void;
  readyState: number;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

/** WebSocket 传输 */
export class WsTransport implements Transport {
  readonly kind = "ws" as const;
  private cb: ((raw: unknown) => void) | null = null;

  constructor(private ws: WsLike | null) {
    if (ws) {
      ws.onmessage = (ev) => {
        if (!this.cb) return;
        let m: unknown;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        this.cb(m);
      };
    }
  }

  ready(): boolean { return !!this.ws && this.ws.readyState === 1; } // OPEN
  send(msg: unknown): void {
    if (this.ready()) this.ws!.send(JSON.stringify(msg));
  }
  onMessage(cb: (raw: unknown) => void): void { this.cb = cb; }
  close(): void { try { this.ws?.close(); } catch { /* 忽略 */ } }
}

/** 类 RTCDataChannel 的最小可用形态 */
export interface DcLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** WebRTC DataChannel 传输（P2P 快照直连；状态未 open 时 send 自动丢弃，由中继兜底） */
export class RtcTransport implements Transport {
  readonly kind = "rtc" as const;
  private cb: ((raw: unknown) => void) | null = null;

  constructor(private dc: DcLike | null) {
    if (dc) {
      dc.onmessage = (ev) => {
        if (!this.cb) return;
        let m: unknown;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        this.cb(m);
      };
    }
  }

  ready(): boolean { return !!this.dc && this.dc.readyState === "open"; }
  send(msg: unknown): void {
    if (this.ready()) this.dc!.send(JSON.stringify(msg));
  }
  onMessage(cb: (raw: unknown) => void): void { this.cb = cb; }
  close(): void { try { this.dc?.close(); } catch { /* 忽略 */ } }
}
