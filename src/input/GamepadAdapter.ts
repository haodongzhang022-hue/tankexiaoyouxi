//  GamepadAdapter.ts ─
// 手柄操作适配：把手柄状态映射为 P1/P2 的 PlayerInput，写入 InputManager.gamepadP1/P2。
// P1 = 手柄索引0，P2 = 手柄索引1。左摇杆移动，A/B/X/Y 对应炮筒1-4开火。
import { InputManager, type PlayerInput } from "../engine/InputManager";

const DEAD = 0.25;

function axis(g: Gamepad, i: number): number {
  return (g.axes[i] ?? 0);
}

function btn(g: Gamepad, i: number): boolean {
  return (g.buttons[i]?.pressed ?? false);
}

function mapPad(g: Gamepad): Partial<PlayerInput> {
  const out: Partial<PlayerInput> = {};
  const ax = axis(g, 0);
  const ay = axis(g, 1);
  // 左摇杆 / 十字键
  if (ax < -DEAD || btn(g, 14)) out.left = true;
  if (ax >  DEAD || btn(g, 15)) out.right = true;
  if (ay < -DEAD || btn(g, 12)) out.up = true;
  if (ay >  DEAD || btn(g, 13)) out.down = true;
  // A/B/X/Y → 炮筒1-4
  if (btn(g, 0)) out.w0 = true;
  if (btn(g, 1)) out.w1 = true;
  if (btn(g, 2)) out.w2 = true;
  if (btn(g, 3)) out.w3 = true;
  // LB 修复 / RB 换炮筒 / Back 背包 / Start 复活
  if (btn(g, 4)) out.interact = true;
  if (btn(g, 5)) out.switchCannon = true;
  if (btn(g, 6) || btn(g, 8)) out.inventory = true;
  if (btn(g, 9)) out.revive = true;
  return out;
}

export class GamepadAdapter {
  private input: InputManager;

  constructor(input: InputManager) {
    this.input = input;
  }

  /** 每帧调用：读取手柄并写入 InputManager。 */
  poll(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const g1 = pads[0] ?? null;
    const g2 = pads[1] ?? null;
    this.input.gamepadP1 = g1 ? mapPad(g1) : {};
    this.input.gamepadP2 = g2 ? mapPad(g2) : {};
  }
}
