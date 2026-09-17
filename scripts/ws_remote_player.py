#!/usr/bin/env python3
"""纯标准库 WebSocket 远程玩家（从 WSL 等另一网络端点连入）。
用法: python3 ws_remote_player.py ws://<host>:<port> join <tableId>
流程: 连接 → 入桌 → 准备 → 等开局 → 上报按键 → 收快照 → 收结束 → 退出
"""
import socket, base64, os, json, struct, sys, time

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

class WS:
    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        port = int(port or 80)
        path = "/" + path
        self.sock = socket.create_connection((host, port), timeout=20)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
               "Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        head, _, rest = buf.partition(b"\r\n\r\n")
        assert b"101" in head.split(b"\r\n")[0], head[:120]
        self.buf = rest

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv_msg(self):
        """返回一条文本消息(str)；关闭返回 None"""
        while True:
            b1, b2 = self._recv_exact(2)
            opcode = b1 & 0x0F
            ln = b2 & 0x7F
            if ln == 126: ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127: ln = struct.unpack(">Q", self._recv_exact(8))[0]
            payload = self._recv_exact(ln) if ln else b""
            if opcode == 8: return None
            if opcode == 9:  # ping → pong(带掩码)
                self._send_raw(10, payload); continue
            if opcode == 1: return payload.decode()

    def _send_raw(self, opcode, payload):
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126: header += bytes([0x80 | n])
        elif n < 65536: header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else: header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send(self, obj):
        self._send_raw(1, json.dumps(obj).encode())

def main():
    url, _, table_id = sys.argv[1], sys.argv[2], int(sys.argv[3])
    ws = WS(url)
    def wait_for(t, timeout=20):
        t0 = time.time()
        while time.time() - t0 < timeout:
            m = ws.recv_msg()
            if m is None: raise ConnectionError("server closed")
            d = json.loads(m)
            if d.get("t") == t: return d
        raise TimeoutError(t)
    w = wait_for("welcome")
    print(f"  [OK] 远程端已连接 {url}，clientId={w['clientId']}")
    si = w.get("serverInfo") or {}
    if si.get("lanIps"): print(f"       （服务器报告的可分享地址首位: {si['lanIps'][0]}:{si['port']}）")
    ws.send({"t": "join", "tableId": table_id})
    jt = wait_for("table")
    name = next(s["name"] for s in jt["table"]["seats"] if s)
    print(f"  [OK] 已入座 {jt['table']['name']}（座位名 {name}）")
    ws.send({"t": "ready", "value": True})
    st = wait_for("start", 30)
    print(f"  [OK] 收到开始指令 myIndex={st['myIndex']} seed={st['seed']}")
    ws.send({"t": "input", "flags": {"up": True, "down": False, "left": False, "right": False,
             "fire": False, "w0": True, "w1": False, "w2": False, "w3": False,
             "interact": False, "switchCannon": False, "inventory": False,
             "warehouse": False, "revive": False}})
    sn = wait_for("snapshot", 15)
    print("  [OK] 收到房主的权威快照（20Hz 同步流正常）")
    go = wait_for("gameover", 30)
    print(f"  [OK] 收到对局结束 score={go['info']['score']}")
    print("GUEST_DONE")

if __name__ == "__main__":
    main()
