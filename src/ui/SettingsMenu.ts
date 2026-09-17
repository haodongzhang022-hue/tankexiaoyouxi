//  SettingsMenu.ts ─
// 设置菜单：操作模式（键盘/触屏/手柄）、音量、屏幕方向。
// 设置持久化到 localStorage；渲染与导航由 main.ts 驱动。
import type { Renderer } from "../engine/Renderer";
import type { ControlMode } from "../engine/InputManager";
import { drawMenuBackground, drawSettingsRow, drawThemedTitle } from "./MenuVisual";

export interface GameSettings {
  mode: ControlMode;   // 操作模式
  volume: number;      // 0-100
  orient: number;      // 0=横屏 1=竖屏
  p2Bot: boolean;      // 单机模式队友AI（默认开）；联机模式由房间内座位状态控制，不受此设置影响
  showVirtualControls: boolean;  // v2.19 手机端虚拟按键显示开关（默认开，触屏设备可隐藏）
}

export const DEFAULT_SETTINGS: GameSettings = { mode: "keyboard", volume: 30, orient: 0, p2Bot: true, showVirtualControls: true };

const KEY = "tank_battle_settings_v1";

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw);
    return {
      mode: (p.mode === "touch" || p.mode === "mobile" || p.mode === "tablet" || p.mode === "gamepad") ? p.mode : "keyboard",
      volume: typeof p.volume === "number" ? Math.max(0, Math.min(100, p.volume)) : DEFAULT_SETTINGS.volume,
      orient: p.orient === 1 ? 1 : 0,
      p2Bot: p.p2Bot !== false,   // 默认开（旧存档无该字段 → 视为开）
      showVirtualControls: p.showVirtualControls !== false,  // 默认开
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: GameSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const MODE_LABELS: Record<ControlMode, string> = {
  keyboard: "键盘鼠标",
  touch: "触屏(兼容)",
  mobile: "手机触屏",
  tablet: "平板触屏",
  gamepad: "游戏手柄",
};

// 操作模式循环顺序（设置菜单中左右键切换时使用）
export const MODE_CYCLE: ControlMode[] = ["keyboard", "mobile", "tablet", "gamepad"];

export const ORIENT_LABELS = ["横屏 (宽地图)", "竖屏 (高地图)"];

const ROW_H = 44;
const ROW_X = 20;

/** 设置菜单共有 7 行：操作模式 / 音量 / 屏幕方向 / 按键绑定 / 队友AI / 虚拟按键 / 返回 */
export const SETTINGS_ROWS = 7;

export function renderSettings(renderer: Renderer, W: number, H: number,
                               s: GameSettings, sel: number): void {
  const now = performance.now();
  // 美化背景
  drawMenuBackground(renderer, W, H, now);

  // 标题
  drawThemedTitle(renderer.ctx, "设  置", W / 2, 50, {
    color: "#ffd700", fontSize: 26, width: 200, align: "center",
  });

  const panelW = Math.min(520, W - 40);
  const startY = 100;
  const ROW_H = 44;
  const rows: { label: string; value: string; isReturn?: boolean; hasBar?: boolean; hint?: string }[] = [
    { label: "操作模式", value: MODE_LABELS[s.mode], hint: "←→ 切换" },
    { label: "音量", value: `${s.volume}%`, hasBar: true },
    { label: "屏幕方向", value: ORIENT_LABELS[s.orient] },
    { label: "按键绑定", value: "自定义键位", hint: "Enter 设置" },
    { label: "队友AI(单机默认)", value: s.p2Bot ? "开" : "关", hint: "联机在房间内设置" },
    { label: "虚拟按键", value: s.showVirtualControls ? "显示" : "隐藏", hint: "触屏设备生效" },
    { label: "返回", value: "", isReturn: true },
  ];

  rows.forEach((r, i) => {
    const y = startY + i * (ROW_H + 6);
    const x = W / 2 - panelW / 2;
    drawSettingsRow(
      renderer.ctx, x, y, panelW, ROW_H,
      r.label, r.value, i === sel, r.isReturn,
      r.hasBar ? { value: s.volume, max: 100 } : undefined,
    );
    // 显示提示文字
    if (r.hint) {
      renderer.ctx.save();
      renderer.ctx.font = "10px monospace";
      renderer.ctx.fillStyle = i === sel ? "#8af" : "#556";
      renderer.ctx.textAlign = "right";
      renderer.ctx.fillText(r.hint, x + panelW - 12, y + ROW_H / 2 + 4);
      renderer.ctx.restore();
    }
  });

  // 底部提示
  renderer.ctx.save();
  renderer.ctx.font = "12px monospace";
  renderer.ctx.fillStyle = "#556680";
  renderer.ctx.textAlign = "center";
  renderer.ctx.fillText("↑↓ 选择   ←→ 修改   Enter 确认/设置键位   ESC 返回", W / 2, H - 24);
  renderer.ctx.restore();
}
