// InputManager.ts - Keyboard + Touch input for 2 players
// Keyboard: document-level (no canvas focus needed)
// Touch: virtual joystick + buttons on mobile

export interface PlayerInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;      // any of the 4 wand fire keys held
  w0: boolean;        // wand 1 fire (P1 H / P2 Numpad1)
  w1: boolean;        // wand 2 fire (P1 J / P2 Numpad2)
  w2: boolean;        // wand 3 fire (P1 K / P2 Numpad3)
  w3: boolean;        // wand 4 fire (P1 L / P2 Numpad4)
  interact: boolean;   // E key = repair/revive
  switchCannon: boolean; // Tab = cycle cannon
  selectCannon: number;  // 直接选择炮筒 (0-3), -1=无选择 (手机端按钮)
  inventory: boolean;
  warehouse: boolean;  // 基地仓库开关（触屏按钮/扩展键位）
  revive: boolean;     // F key = consume life to revive teammate
}

// One active direction at a time (last-pressed wins)
export type Direction4 = "up" | "down" | "left" | "right" | "none";

// 操作模式（设置菜单切换）
// v2.15 扩展：keyboard=键盘鼠标, mobile=手机触屏(竖屏布局), tablet=平板触屏(横屏布局), gamepad=手柄
// touch 保留为兼容别名（等同于 mobile）
export type ControlMode = "keyboard" | "touch" | "mobile" | "tablet" | "gamepad";

export function EMPTY_INPUT(): PlayerInput {
  return { up:false, down:false, left:false, right:false, fire:false,
           w0:false, w1:false, w2:false, w3:false,
           interact:false, switchCannon:false, selectCannon:-1, inventory:false, warehouse:false, revive:false };
}

// P1: WASD + H/J/K/L(fire 4 wands) + E(interact) + Tab(switchCannon) + F(revive)
// P2: Arrows + Num1-4(fire 4 wands) + /(interact) + RShift(switchCannon) + RCtrl(revive)
const P1_MAP: Record<string, keyof PlayerInput> = {
  KeyW:"up", KeyS:"down", KeyA:"left", KeyD:"right",
  KeyH:"w0", KeyJ:"w1", KeyK:"w2", KeyL:"w3",
  KeyE:"interact", Tab:"switchCannon", KeyF:"revive",
};
const P2_MAP: Record<string, keyof PlayerInput> = {
  ArrowUp:"up", ArrowDown:"down", ArrowLeft:"left", ArrowRight:"right",
  Numpad1:"w0", Numpad2:"w1", Numpad3:"w2", Numpad4:"w3",
  Slash:"interact", ShiftRight:"switchCannon", ControlRight:"revive",
};

// P2 直接选择炮筒：7/8/9/0 对应 炮筒1/2/3/4
const P2_CANNON_SELECT: Record<string, number> = {
  Digit7: 0, Digit8: 1, Digit9: 2, Digit0: 3,
};

// Keys that open menus (no game action)
const MENU_KEYS = new Set(["Enter","Space","Digit1","Digit2","Digit3","Numpad1","Numpad2","Numpad3",
                            "Digit7","Digit8","Digit9","Digit0","KeyI","Escape"]);

export class InputManager {
  private static instance: InputManager;
  private held = new Set<string>();
  private justPressed = new Set<string>();
  private p1: PlayerInput = EMPTY_INPUT();
  private p2: PlayerInput = EMPTY_INPUT();

  // 4-direction per player (last-active axis wins)
  private p1Dir: Direction4 = "none";
  private p2Dir: Direction4 = "none";
  private p1DirStack: string[] = []; // ordered list of held directional keys
  private p2DirStack: string[] = [];

  // Touch overrides (set by MobileControls)
  touchP1: Partial<PlayerInput> = {};
  touchP2: Partial<PlayerInput> = {};

  // Gamepad overrides (set by GamepadAdapter)
  gamepadP1: Partial<PlayerInput> = {};
  gamepadP2: Partial<PlayerInput> = {};

  // 联机主机开启：屏蔽本地键盘/触屏对 P2 的控制（该座位已由远程玩家接管），
  // 但保留 gamepadP2 通道 —— 远端按键正是通过它合并进来的。
  private suppressLocalP2 = false;
  setSuppressLocalP2(b: boolean): void { this.suppressLocalP2 = b; this.sync(); }

  // 操作模式（设置菜单切换）
  private mode: ControlMode = "keyboard";

  // 键盘输入检测回调：由 MobileControls 注册，检测到键盘输入时隐藏虚拟按键
  onKeyboardDetected?: () => void;

  static getInstance(): InputManager {
    if (!InputManager.instance) InputManager.instance = new InputManager();
    return InputManager.instance;
  }

  setMode(m: ControlMode): void { this.mode = m; }
  getMode(): ControlMode { return this.mode; }

  init(): void {
    // Document-level  works without canvas focus
    document.addEventListener("keydown", e => {
      const wasHeld = this.held.has(e.code);
      if (!wasHeld) this.justPressed.add(e.code);
      this.held.add(e.code);
      // 键盘输入检测：自动隐藏手机虚拟按键
      const GAME_KEYS = ["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
                         "KeyH","KeyJ","KeyK","KeyL","Tab","KeyE","KeyF",
                         "Numpad1","Numpad2","Numpad3","Numpad4","Slash","ShiftRight","ControlRight",
                         "Digit7","Digit8","Digit9","Digit0"];
      if (GAME_KEYS.includes(e.code)) {
        this.onKeyboardDetected?.();
      }
      // Prevent browser shortcuts
      if (["Tab","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"].includes(e.code)) {
        e.preventDefault();
      }
      this.updateDirStack(e.code, true);
      this.sync();
    });
    document.addEventListener("keyup", e => {
      this.held.delete(e.code);
      this.updateDirStack(e.code, false);
      this.sync();
    });
    window.addEventListener("blur", () => {
      this.held.clear();
      this.p1DirStack = [];
      this.p2DirStack = [];
      this.sync();
    });
  }

  private updateDirStack(code: string, pressed: boolean): void {
    const p1dir = ["KeyW","KeyS","KeyA","KeyD"];
    const p2dir = ["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"];
    if (p1dir.includes(code)) {
      if (pressed) { if (!this.p1DirStack.includes(code)) this.p1DirStack.push(code); }
      else this.p1DirStack = this.p1DirStack.filter(k => k !== code);
    }
    if (p2dir.includes(code)) {
      if (pressed) { if (!this.p2DirStack.includes(code)) this.p2DirStack.push(code); }
      else this.p2DirStack = this.p2DirStack.filter(k => k !== code);
    }
  }

  private codeToDir(code: string): Direction4 {
    if (code === "KeyW" || code === "ArrowUp")    return "up";
    if (code === "KeyS" || code === "ArrowDown")  return "down";
    if (code === "KeyA" || code === "ArrowLeft")  return "left";
    if (code === "KeyD" || code === "ArrowRight") return "right";
    return "none";
  }

  /** 合并 held/touch/gamepad 到 p1/p2。v2.19 改为 public：MobileControls 触摸变化后需主动调用 */
  sync(): void {
    this.p1 = EMPTY_INPUT();
    this.p2 = EMPTY_INPUT();

    // Non-movement keys (skip selectCannon which is number, not boolean)
    for (const code of this.held) {
      const k1 = P1_MAP[code];
      if (k1 && k1 !== "up" && k1 !== "down" && k1 !== "left" && k1 !== "right" && k1 !== "selectCannon") this.p1[k1] = true;
      const k2 = P2_MAP[code];
      if (!this.suppressLocalP2 && k2 && k2 !== "up" && k2 !== "down" && k2 !== "left" && k2 !== "right" && k2 !== "selectCannon") this.p2[k2] = true;
      // P2 直接选炮筒 (7/8/9/0 → cannon 0/1/2/3)
      if (!this.suppressLocalP2 && code in P2_CANNON_SELECT) {
        this.p2.selectCannon = P2_CANNON_SELECT[code];
      }
    }

    // 4-direction: use last pressed key in stack
    if (this.p1DirStack.length > 0) {
      const dir = this.codeToDir(this.p1DirStack[this.p1DirStack.length - 1]);
      this.p1Dir = dir;
      if (dir !== "none") this.p1[dir] = true;
    } else { this.p1Dir = "none"; }

    if (!this.suppressLocalP2 && this.p2DirStack.length > 0) {
      const dir = this.codeToDir(this.p2DirStack[this.p2DirStack.length - 1]);
      this.p2Dir = dir;
      if (dir !== "none") this.p2[dir] = true;
    } else { this.p2Dir = "none"; }

    // Merge touch overrides（远端接管 P2 时同样屏蔽本地触屏 P2）
    for (const [k, v] of Object.entries(this.touchP1)) {
      if (v === true) (this.p1 as any)[k] = true;
      else if (typeof v === 'number' && v >= 0) (this.p1 as any)[k] = v;
    }
    if (!this.suppressLocalP2) {
      for (const [k, v] of Object.entries(this.touchP2)) {
        if (v === true) (this.p2 as any)[k] = true;
        else if (typeof v === 'number' && v >= 0) (this.p2 as any)[k] = v;
      }
    }

    // Merge gamepad overrides（v2.31：数值字段如 selectCannon 需保留数字；boolean 只认 true）
    for (const [k, v] of Object.entries(this.gamepadP1)) {
      if (v === true) (this.p1 as any)[k] = true;
      else if (typeof v === "number" && v >= 0) (this.p1 as any)[k] = v;
    }
    for (const [k, v] of Object.entries(this.gamepadP2)) {
      if (v === true) (this.p2 as any)[k] = true;
      else if (typeof v === "number" && v >= 0) (this.p2 as any)[k] = v;
    }

    // fire = any of the 4 wand fire inputs held
    this.p1.fire = this.p1.fire || this.p1.w0 || this.p1.w1 || this.p1.w2 || this.p1.w3;
    this.p2.fire = this.p2.fire || this.p2.w0 || this.p2.w1 || this.p2.w2 || this.p2.w3;
  }

  getP1(): Readonly<PlayerInput> { return this.p1; }
  getP2(): Readonly<PlayerInput> { return this.p2; }

  /** 联机主机用：把远端玩家的按键合并为 P2 输入（覆盖本地方向键）。每帧调用以反映最新远端键位。 */
  setOverrideP2(o: Partial<PlayerInput>): void {
    this.gamepadP2 = o;
    this.sync();
  }

  /** 联机远端用：读主机端作为"我的输入"的键位快照（WASD+四炮筒） */
  peekP1(): PlayerInput { return this.p1; }
  getP1Dir(): Direction4 { return this.p1Dir; }
  getP2Dir(): Direction4 { return this.p2Dir; }
  isHeld(code: string): boolean { return this.held.has(code); }
  wasJustPressed(code: string): boolean { return this.justPressed.has(code); }
  flush(): void { this.justPressed.clear(); }
}