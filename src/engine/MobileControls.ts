// MobileControls.ts - Dynamic virtual joystick + buttons for touch devices
// Joystick appears at the point where you first touch the left 50% of screen
import { InputManager, type ControlMode } from "./InputManager";
import { logicalCanvasSize } from "./Renderer";

const JOYSTICK_MAX_R = 55;   // max thumb distance from origin
const DEAD_ZONE = 12;
const TAP_MAX_MOVE = 14;     // 视为轻触的最大位移（px）
const TAP_MAX_TIME = 300;    // 视为轻触的最长持续时间（ms）

/** 判断当前操作模式是否为触控类（touch/mobile/tablet 均启用虚拟摇杆+按钮） */
function isTouchMode(mode: ControlMode): boolean {
  return mode === "touch" || mode === "mobile" || mode === "tablet";
}

interface TouchBtn {
  id: string;
  x: number; y: number; w: number; h: number;
  label: string;
  color: string;
  key: string;
  // v2.21 圆形按钮（竖屏方向盘右侧的开火键）：优先使用 cx/cy/r 命中与绘制
  cx?: number; cy?: number; r?: number;
  // 直接选择炮筒 (0-3)，不走 boolean key
  cannonIdx?: number;
}

export class MobileControls {
  /** 全局 UI 覆盖层标志：菜单/设置/大厅等非游戏画面时，所有实例放行触摸（让 pointerdown 处理按钮） */
  static uiOverlayActive = false;
  /** v2.19 全局虚拟按键显示开关：设置中可隐藏（触屏设备），隐藏时不渲染也不响应 */
  static showVirtual = true;
  /** 当前活动炮筒索引 (0-3)：由游戏层设置，用于手机端高亮显示 */
  static activeCannon: number = 0;
  private canvas: HTMLCanvasElement;
  private input: InputManager;
  readonly isTouch: boolean;
  /** 总开关：联机观战等场景由外部按需启停（关闭时忽略所有触摸并清空输入） */
  enabled = true;

  setEnabled(b: boolean): void {
    this.enabled = b;
    if (!b) {
      this.input.touchP1 = {};
      this.joyTouchId = null;
      this.joyOrigin = null;
    }
  }

  // Dynamic joystick state  origin follows first touch in left half
  private joyOrigin: { x: number; y: number } | null = null;
  private joyThumb: { x: number; y: number } = { x: 0, y: 0 };
  private joyTouchId: number | null = null;

  // Action buttons (right side)
  private buttons: TouchBtn[] = [];

  // 轻触检测：点按信息栏/升级选项等 UI 时，通过 onTap 转发给模式系统处理
  // （触屏 preventDefault 会让浏览器 click 失效，必须走这里）
  onTap?: (x: number, y: number) => void;
  private tapStart: { id: number; x: number; y: number; t: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.input = InputManager.getInstance();
    this.isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    // v2.24 键盘输入检测：检测到键盘（WASD 等游戏键）输入 → 自动切回键盘模式，收起虚拟按键；
    // 之后再触摸屏幕会切回手机模式（触屏优先）
    this.input.onKeyboardDetected = () => {
      if (this.isTouch && isTouchMode(this.input.getMode())) {
        this.input.setMode("keyboard");
        this.input.touchP1 = {};
        this.joyTouchId = null;
        this.joyOrigin = null;
      }
    };
    if (this.isTouch) {
      this.setupTouch();
      // v2.24 触屏优先：任意一次手指触摸都切回手机模式（虚拟按键重新出现），无需手动设置；
      // 键盘输入出现时再自动收起（双向动态判定）
      const touchActivate = (): void => {
        if (!isTouchMode(this.input.getMode())) {
          this.input.setMode("mobile");
        }
      };
      window.addEventListener("touchstart", touchActivate, { capture: true, passive: true });
    }
  }

  private canvasCoord(t: Touch): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    // v2.25 DPR 高清：坐标换算必须用逻辑尺寸（canvas.width 已是物理像素）
    const lc = logicalCanvasSize(this.canvas);
    return {
      x: (t.clientX - r.left) * (lc.w / r.width),
      y: (t.clientY - r.top)  * (lc.h / r.height),
    };
  }

  private buildButtons(): void {
    const { w: W, h: H } = logicalCanvasSize(this.canvas);
    const vertical = H > W;          // 竖屏布局
    const mode = this.input.getMode();
    // 手机模式：按钮稍小更紧凑；平板模式：按钮稍大更易点
    const isTablet = mode === "tablet";
    // ── 标准手游左右布局（关键）──
    // 左半屏：方向摇杆（不含任何按钮）；右半屏：动作按钮
    const barH  = vertical ? (isTablet ? 66 : 58) : (isTablet ? 80 : 70);
    const barY  = H - barH - 8;
    const leftX = Math.floor(W * 0.5) + 4;   // 按钮严格从中线右侧开始
    const rightX = W - 6;

    // ── v2.21 竖屏（手机单玩家）：开火键为圆形大键 ──
    if (vertical) {
      const fireR = isTablet ? 52 : 46;
      // v2.35 开火键移至右下角（原在左半屏，与摇杆区域重叠导致移动/开火互相干扰）
      const fireCx = rightX - fireR - 4;
      const fireCy = barY - fireR - 14;
      this.buttons = [{ id: "fire", x: 0, y: 0, w: 0, h: 0,
        label: "开火", color: "#c00", key: "fire", cx: fireCx, cy: fireCy, r: fireR }];
      // 右列 7 个工具钮：修理/1/2/3/4 炮筒/背包/仓库
      const gap = 3, n = 7;
      const bw = Math.max(isTablet ? 36 : 32, Math.floor((rightX - leftX - gap * (n - 1)) / n));
      const CANNON_COLORS = ["#06c", "#0a0", "#a60", "#a0a"];
      const defs: Array<{ id: string; label: string; color: string; key: string }> = [
        { id:"repair",    label:"修理", color:"#060", key:"interact"     },
      ];
      // 4个炮筒按钮
      for (let ci = 0; ci < 4; ci++) {
        defs.push({ id:`c${ci}`, label:`${ci+1}号`, color: CANNON_COLORS[ci], key:"selectCannon" });
      }
      defs.push({ id:"bag",       label:"背包", color:"#440", key:"inventory"    });
      defs.push({ id:"warehouse", label:"仓库", color:"#0a3", key:"warehouse"    });
      defs.forEach((d, i) => {
        const btn: TouchBtn = { id: d.id, x: leftX + i * (bw + gap), y: barY, w: bw, h: barH,
          label: d.label, color: d.color, key: d.key };
        if (d.id.startsWith("c") && d.id !== "repair") btn.cannonIdx = parseInt(d.id.slice(1));
        this.buttons.push(btn);
      });
      return;
    }

    // ── 横屏：7 键工具条（修理/1-4炮筒/背包/仓库）+ 右侧独立大号圆形开火键 ──
    // v2.36 开火键从 8 键条最右（太小不显眼）改为右侧大圆键，与竖屏一致、符合手机操控习惯
    const gap = 4;
    const n = 7;
    const bw = Math.max(isTablet ? 36 : 32, Math.floor((rightX - leftX - gap * (n - 1)) / n));
    const CANNON_COLORS = ["#06c", "#0a0", "#a60", "#a0a"];
    const defs: Array<{ id: string; label: string; color: string; key: string }> = [
      { id:"repair",    label:"修理", color:"#060", key:"interact"     },
    ];
    for (let ci = 0; ci < 4; ci++) {
      defs.push({ id:`c${ci}`, label:`${ci+1}`, color: CANNON_COLORS[ci], key:"selectCannon" });
    }
    defs.push({ id:"bag",       label:"背包", color:"#440", key:"inventory"    });
    defs.push({ id:"warehouse", label:"仓库", color:"#0a3", key:"warehouse"    });
    this.buttons = [];
    const fireR = isTablet ? 56 : 50;
    const fireCx = rightX - fireR - 2;
    const fireCy = barY - fireR - 10;
    this.buttons.push({ id: "fire", x: 0, y: 0, w: 0, h: 0,
      label: "开火", color: "#c00", key: "fire", cx: fireCx, cy: fireCy, r: fireR });
    defs.forEach((d, i) => {
      const btn: TouchBtn = { id: d.id, x: leftX + i * (bw + gap), y: barY, w: bw, h: barH,
        label: d.label, color: d.color, key: d.key };
      if (d.id.startsWith("c") && d.id !== "repair") btn.cannonIdx = parseInt(d.id.slice(1));
      this.buttons.push(btn);
    });
  }

  private isOverButton(x: number, y: number): boolean {
    for (const b of this.buttons) {
      if (b.r && b.cx !== undefined && b.cy !== undefined) {
        const hitR = b.r + 12;   // v2.21 圆形键检测区比视觉大 12px，更好按
        const dx = x - b.cx, dy = y - b.cy;
        if (dx*dx + dy*dy <= hitR*hitR) return true;
      } else if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) {
        return true;
      }
    }
    return false;
  }

  private setupTouch(): void {
    const opts = { passive: false };
    // v2.19 修复：仅在控件激活（enabled + 触摸设备 + 触控模式 + 无 UI 覆盖层）时才拦截触摸；
    // 菜单/设置/大厅等界面放行，让 pointerdown 正常触发按钮点击
    const active = (): boolean =>
      this.enabled && this.isTouch && isTouchMode(this.input.getMode())
      && !MobileControls.uiOverlayActive && MobileControls.showVirtual;
    this.canvas.addEventListener("touchstart",  e => { if (!active()) return; e.preventDefault(); this.onStart(e); },  opts);
    this.canvas.addEventListener("touchmove",   e => { if (!active()) return; e.preventDefault(); this.onMove(e); },   opts);
    this.canvas.addEventListener("touchend",    e => { if (!active()) return; e.preventDefault(); this.onEnd(e, false); }, opts);
    this.canvas.addEventListener("touchcancel", e => { if (!active()) return; e.preventDefault(); this.onEnd(e, true);  }, opts);
  }

  private onStart(e: TouchEvent): void {
    if (!this.enabled) return;
    this.buildButtons();
    const now = performance.now();
    for (const t of Array.from(e.changedTouches)) {
      const { x, y } = this.canvasCoord(t);
      // 记录首个触点作为"轻触候选"（起点）
      if (this.tapStart === null) {
        this.tapStart = { id: t.identifier, x, y, t: now };
      }
      if (x < logicalCanvasSize(this.canvas).w * 0.5 && this.joyTouchId === null && !this.isOverButton(x, y)) {
        // Start joystick at touch point（v2.21：按压圆形开火键时不再触发方向盘，避免方向盘出生在开火键上）
        this.joyTouchId = t.identifier;
        this.joyOrigin = { x, y };
        this.joyThumb  = { x, y };
      }
    }
    this.applyAll(e.touches);
  }

  /** 当前模式下的摇杆最大半径（平板稍大） */
  private joyMaxR(): number {
    return this.input.getMode() === "tablet" ? JOYSTICK_MAX_R + 8 : JOYSTICK_MAX_R;
  }

  private onMove(e: TouchEvent): void {
    if (!this.enabled) return;
    this.buildButtons();
    // 位移过大则取消轻触候选（变成拖动）
    for (const t of Array.from(e.changedTouches)) {
      if (this.tapStart && t.identifier === this.tapStart.id) {
        const { x, y } = this.canvasCoord(t);
        if (Math.hypot(x - this.tapStart.x, y - this.tapStart.y) > TAP_MAX_MOVE ||
            performance.now() - this.tapStart.t > TAP_MAX_TIME) {
          this.tapStart = null;
        }
      }
    }
    // Update joystick thumb
    if (this.joyTouchId !== null && this.joyOrigin) {
      const maxR = this.joyMaxR();
      for (const t of Array.from(e.touches)) {
        if (t.identifier === this.joyTouchId) {
          const { x, y } = this.canvasCoord(t);
          const dx = x - this.joyOrigin.x;
          const dy = y - this.joyOrigin.y;
          const len = Math.sqrt(dx*dx + dy*dy);
          if (len <= maxR) {
            this.joyThumb = { x, y };
          } else {
            const s = maxR / len;
            this.joyThumb = { x: this.joyOrigin.x + dx*s, y: this.joyOrigin.y + dy*s };
          }
        }
      }
    }
    this.applyAll(e.touches);
  }

  private onEnd(e: TouchEvent, wasCancelled = false): void {
    if (!this.enabled) return;
    // Check if joystick touch ended
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joyTouchId) {
        this.joyTouchId = null;
        this.joyOrigin  = null;
      }
    }
    // 轻触检测：快速点按且不在按钮上 → 转发给 UI（信息栏/升级选项等）
    this.buildButtons();
    if (this.tapStart && !wasCancelled) {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.tapStart.id) {
          const { x, y } = this.canvasCoord(t);
          const ts = this.tapStart;
          const move = Math.hypot(x - ts.x, y - ts.y);
          const dur = performance.now() - ts.t;
          if (move <= TAP_MAX_MOVE && dur <= TAP_MAX_TIME && !this.isOverButton(x, y)) {
            this.onTap?.(x, y);
          }
          this.tapStart = null;
          break;
        }
      }
    }
    if (e.touches.length === 0) {
      this.input.touchP1 = {};
      this.tapStart = null;
      this.input.sync();  // v2.19 松开所有触点后也要 sync，清空方向
      return;
    }
    this.applyAll(e.touches);
  }

  private applyAll(touches: TouchList): void {
    // 触控类模式（touch/mobile/tablet）均启用虚拟摇杆/按键
    if (!isTouchMode(this.input.getMode())) { this.input.touchP1 = {}; return; }
    this.input.touchP1 = {};
    this.buildButtons();

    // Apply joystick direction
    if (this.joyOrigin && this.joyTouchId !== null) {
      const dx = this.joyThumb.x - this.joyOrigin.x;
      const dy = this.joyThumb.y - this.joyOrigin.y;
      const len = Math.sqrt(dx*dx + dy*dy);
      if (len > DEAD_ZONE) {
        if (Math.abs(dx) > Math.abs(dy)) {
          if (dx > 0) this.input.touchP1.right = true;
          else        this.input.touchP1.left  = true;
        } else {
          if (dy > 0) this.input.touchP1.down = true;
          else        this.input.touchP1.up   = true;
        }
      }
    }

    // Apply button touches
    for (const t of Array.from(touches)) {
      if (t.identifier === this.joyTouchId) continue;
      const { x, y } = this.canvasCoord(t);
      for (const btn of this.buttons) {
        let hit = false;
        if (btn.r && btn.cx !== undefined && btn.cy !== undefined) {
          const hitR = btn.r + 12;
          const dx = x - btn.cx, dy = y - btn.cy;
          hit = dx*dx + dy*dy <= hitR*hitR;
        } else {
          hit = x >= btn.x && x < btn.x+btn.w && y >= btn.y && y < btn.y+btn.h;
        }
        if (hit) {
          if (btn.cannonIdx !== undefined) {
            // 直接选择炮筒 (0-3)
            this.input.touchP1.selectCannon = btn.cannonIdx;
          } else {
            (this.input.touchP1 as any)[btn.key] = true;
          }
        }
      }
    }
    // v2.19 关键修复：触摸变化后必须 sync()，否则 touchP1 不会合并到 p1（sync 只在键盘事件触发）
    this.input.sync();
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.isTouch) return;
    if (!MobileControls.showVirtual) return;
    // v2.19 UI 覆盖层（暂停/菜单/设置）激活时清空摇杆，避免暂停后方向键卡住
    if (!this.enabled || MobileControls.uiOverlayActive) {
      this.input.touchP1 = {};
      this.joyTouchId = null;
      this.joyOrigin = null;
      return;
    }
    // 触控类模式（touch/mobile/tablet）均绘制虚拟控件；键盘模式下同时清理残留触摸状态
    if (!isTouchMode(this.input.getMode())) {
      this.input.touchP1 = {};
      this.joyTouchId = null;
      this.joyOrigin = null;
      return;
    }
    const mode = this.input.getMode();
    const isTablet = mode === "tablet";
    const joyR = isTablet ? JOYSTICK_MAX_R + 8 : JOYSTICK_MAX_R;
    this.buildButtons();
    ctx.save();
    ctx.globalAlpha = 0.5;

    // Dynamic joystick (only when active)
    if (this.joyOrigin) {
      // Outer ring
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.joyOrigin.x, this.joyOrigin.y, joyR, 0, Math.PI*2);
      ctx.stroke();
      // Center dot
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.joyOrigin.x, this.joyOrigin.y, 6, 0, Math.PI*2);
      ctx.stroke();
      // Thumb
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.beginPath();
      ctx.arc(this.joyThumb.x, this.joyThumb.y, isTablet ? 28 : 24, 0, Math.PI*2);
      ctx.fill();
    } else {
      // Show hint circle in bottom-left when not active
      const lc = logicalCanvasSize(this.canvas);
      const hx = lc.w * 0.18;
      const hy = lc.h * 0.82;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(hx, hy, joyR, 0, Math.PI*2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.font = isTablet ? "13px sans-serif" : "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("触摸移动", hx, hy);
    }

    // 底部操作条背景（半透明，不遮挡场上内容但标识可操作区域；只覆盖方形工具钮，圆形开火键单独画）
    const rectBtns = this.buttons.filter(b => !b.r);
    if (rectBtns.length > 1) {
      const b0 = rectBtns[0], bN = rectBtns[rectBtns.length - 1];
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.roundRect(b0.x - 6, b0.y - 4, (bN.x + bN.w) - b0.x + 12, b0.h + 8, 10);
      ctx.fill();
    }

    for (const btn of this.buttons) {
      // 炮筒按钮：根据当前活动炮筒判断高亮
      const isCannonBtn = btn.cannonIdx !== undefined;
      const active = isCannonBtn
        ? (btn.cannonIdx === MobileControls.activeCannon)
        : !!(this.input.touchP1 as any)[btn.key];
      // ── v2.21 圆形透明开火键（竖屏：方向盘右侧）──
      if (btn.r && btn.cx !== undefined && btn.cy !== undefined) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = active ? "rgba(255,255,255,0.9)" : btn.color + "22";
        ctx.beginPath();
        ctx.arc(btn.cx, btn.cy, btn.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = active ? "#fff" : "rgba(255,255,255,0.6)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(btn.cx, btn.cy, btn.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = active ? btn.color : "#fff";
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(btn.label, btn.cx, btn.cy - 4);
        ctx.globalAlpha = 0.5;
        continue;
      }
      ctx.fillStyle = active ? "#fff" : btn.color + "cc";
      ctx.beginPath();
      ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 10);
      ctx.fill();
      ctx.fillStyle = active ? btn.color : "#fff";
      ctx.font = "bold 16px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(btn.label.slice(0, 1), btn.x + btn.w / 2, btn.y + btn.h / 2 - 6);
      ctx.font = "9px sans-serif";
      ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2 + 12);
    }

    ctx.restore();
  }
}