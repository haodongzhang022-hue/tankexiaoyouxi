// MapVisual.ts - 地图美化渲染模块
// 以"新增+修改指向"方式提供美化后的瓦片和地形状态渲染。
// 所有渲染函数兼容测试环境（mock canvas 不支持渐变/路径时回退为纯色）。

import type { Tilemap, TileCell, TileState, TileElement } from "../game/Tilemap";
import { TileType, TILE_SIZE } from "../game/Tilemap";
import type { BiomeId } from "../systems/terrain/MapGenerator";
// v2.17 视觉配置统一从资源包读取，确保联机两端一致
import { getBiomeColors, type BiomeColors } from "../assets/AssetPack";

// ═══════════════════════════════════════════════════════════
//  生物群系配色（已迁移至 AssetPack，此处保留类型别名兼容）
// ═══════════════════════════════════════════════════════════
export type { BiomeColors };

// ═══════════════════════════════════════════════════════════
//  安全渐变工具（测试环境回退为纯色）
// ═══════════════════════════════════════════════════════════
function safeLinearGradient(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  c1: string, c2: string,
): string | CanvasGradient {
  if (typeof ctx.createLinearGradient !== "function") return c1;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  return g;
}

function safeRadialGradient(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  c1: string, c2: string,
): string | CanvasGradient {
  if (typeof ctx.createRadialGradient !== "function") return c1;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  return g;
}

/** 安全填充圆（测试环境不支持 arc 时回退为小方块） */
function safeFillCircle(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
): void {
  if (typeof ctx.arc !== "function" || typeof ctx.beginPath !== "function") {
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    return;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

// ═══════════════════════════════════════════════════════════
//  空地背景渲染（带生物群系纹理）
// ═══════════════════════════════════════════════════════════
export function renderGround(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  col: number, row: number,
  biome?: BiomeId,
): void {
  const c = getBiomeColors(biome);
  // 棋盘格微差（避免大面积纯色单调）
  const alt = (col + row) % 2 === 0;
  ctx.fillStyle = alt ? c.ground : c.groundAlt;
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

  // 细微噪点（用确定性伪随机，避免闪烁）
  const seed = (col * 73 + row * 131) % 100;
  if (seed < 15) {
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    const nx = x + (seed % 4) * 7 + 2;
    const ny = y + ((seed * 3) % 4) * 7 + 2;
    ctx.fillRect(nx, ny, 3, 3);
  }
}

// ═══════════════════════════════════════════════════════════
//  砖墙渲染（4分块 + 渐变 + 砖纹 + 裂纹 + 受击状态）
//  一块32x32的砖分为4个16x16小块，根据HP逐块消失
// ═══════════════════════════════════════════════════════════
export function renderBrick(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  cell: TileCell,
  biome?: BiomeId,
): void {
  const c = getBiomeColors(biome);
  const T = TILE_SIZE;
  const half = T / 2;  // 16

  // v2.17 四象限独立血量：0=左上 1=右上 2=左下 3=右下
  // 有 quadHp 时按各象限独立血量渲染；无 quadHp（旧数据/爆炸整体伤害）时回退到 HP 比例
  const quadAlive: [boolean, boolean, boolean, boolean] = cell.quadHp
    ? [cell.quadHp[0] > 0, cell.quadHp[1] > 0, cell.quadHp[2] > 0, cell.quadHp[3] > 0]
    : [cell.hp > 0, cell.hp > 1, cell.hp > 2, cell.hp > 3]; // 兼容：HP=4全显,HP=3缺右下...
  const subBlocks = [
    { dx: 0, dy: 0, alive: quadAlive[0] },      // 左上
    { dx: half, dy: 0, alive: quadAlive[1] },   // 右上
    { dx: 0, dy: half, alive: quadAlive[2] },   // 左下
    { dx: half, dy: half, alive: quadAlive[3] }, // 右下
  ];

  // 先画底色（空地色，被打掉的块显示这个）
  renderGround(ctx, x, y, Math.floor(x / T), Math.floor(y / T), biome);

  // 逐个绘制仍存在的小块
  for (const block of subBlocks) {
    if (!block.alive) continue;

    const bx = x + block.dx;
    const by = y + block.dy;

    // 主体渐变
    ctx.fillStyle = safeLinearGradient(ctx, bx, by, half, half, c.brick, c.brickDark);
    ctx.fillRect(bx, by, half, half);

    // 砖纹（经典坦克大战风格，每块内部画砖缝）
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    // 水平灰缝
    ctx.fillRect(bx, by, half, 1.5);
    ctx.fillRect(bx, by + half / 2, half, 1.5);
    // 垂直灰缝（上下错开）
    ctx.fillRect(bx, by, 1.5, half / 2);
    ctx.fillRect(bx + half - 1.5, by + half / 2, 1.5, half / 2);
    ctx.fillRect(bx + half / 2, by + half / 2, 1.5, half / 2);
    ctx.fillRect(bx + half / 2, by, 1.5, half / 2);

    // 顶部高光
    ctx.fillStyle = "rgba(255,200,100,0.15)";
    ctx.fillRect(bx + 1.5, by + 1.5, half - 3, 1.5);

    // 小块之间的分隔缝（加深）
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    if (block.dx === 0) ctx.fillRect(bx + half - 1, by, 2, half);  // 右侧缝
    if (block.dy === 0) ctx.fillRect(bx, by + half - 1, half, 2);  // 底部缝
  }

  // 损伤裂纹（随 HP 减少加重，仅在还有砖块时显示）
  if (cell.hp < cell.maxHp && cell.hp > 0) {
    const dmgFrac = 1 - cell.hp / cell.maxHp;
    if (dmgFrac > 0.25 && typeof ctx.beginPath === "function") {
      ctx.strokeStyle = `rgba(20,10,0,${dmgFrac * 0.9})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 4);
      ctx.lineTo(x + T / 2, y + T / 2 - 2);
      ctx.lineTo(x + T - 6, y + T / 2 + 4);
      if (dmgFrac > 0.6) {
        ctx.moveTo(x + T / 2, y + T / 2 - 2);
        ctx.lineTo(x + T / 2 - 4, y + T - 4);
      }
      ctx.stroke();
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  钢墙渲染（金属渐变 + 高光 + 铆钉 + 反光）
// ═══════════════════════════════════════════════════════════
export function renderSteel(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  biome?: BiomeId,
): void {
  const c = getBiomeColors(biome);
  const T = TILE_SIZE;

  // 金属渐变
  ctx.fillStyle = safeLinearGradient(ctx, x, y, T, T, c.steel, c.steelDark);
  ctx.fillRect(x, y, T, T);

  // 对角金属纹理（拉丝效果）
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  for (let i = -T; i < T * 2; i += 6) {
    ctx.fillRect(x + i, y, 2, T);
  }

  // 四角铆钉
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  const rivets = [[4, 4], [T - 4, 4], [4, T - 4], [T - 4, T - 4]];
  for (const [rx, ry] of rivets) {
    safeFillCircle(ctx, x + rx, y + ry, 2);
  }
  // 铆钉高光
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  for (const [rx, ry] of rivets) {
    ctx.fillRect(x + rx - 1, y + ry - 1, 1, 1);
  }

  // 顶部和左侧高光线
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillRect(x, y, T, 1.5);
  ctx.fillRect(x, y, 1.5, T);
  // 底部和右侧暗边
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(x, y + T - 1.5, T, 1.5);
  ctx.fillRect(x + T - 1.5, y, 1.5, T);
}

// ═══════════════════════════════════════════════════════════
//  水面渲染（渐变 + 波纹动画 + 反光）
// ═══════════════════════════════════════════════════════════
export function renderWater(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number,
  col: number, row: number,
  biome?: BiomeId,
): void {
  const c = getBiomeColors(biome);
  const T = TILE_SIZE;

  // 深水底色
  ctx.fillStyle = c.waterDeep;
  ctx.fillRect(x, y, T, T);

  // 水面渐变
  ctx.fillStyle = safeLinearGradient(ctx, x, y, T, T, c.water, c.waterDeep);
  ctx.globalAlpha = 0.85;
  ctx.fillRect(x, y, T, T);
  ctx.globalAlpha = 1;

  // 波纹动画（横向移动的亮线，基于时间和位置）
  const waveOffset = (now / 60 + col * 8 + row * 5) % T;
  ctx.fillStyle = "rgba(180,220,255,0.25)";
  // 主波纹
  const wy1 = y + ((waveOffset * 0.6) % T);
  ctx.fillRect(x, wy1, T, 1.5);
  // 次波纹（反向）
  const waveOffset2 = (now / 80 + col * 6 + row * 9 + T / 2) % T;
  const wy2 = y + ((waveOffset2 * 0.5) % T);
  ctx.fillStyle = "rgba(150,200,255,0.15)";
  ctx.fillRect(x, wy2, T, 1);

  // 闪光点（确定性位置，随时间闪烁）
  const sparkle = Math.sin(now / 300 + col * 1.7 + row * 2.3) * 0.5 + 0.5;
  if (sparkle > 0.6) {
    ctx.fillStyle = `rgba(220,240,255,${(sparkle - 0.6) * 1.2})`;
    const sx = x + ((col * 13 + row * 7) % (T - 6)) + 3;
    const sy = y + ((col * 17 + row * 11) % (T - 6)) + 3;
    ctx.fillRect(sx, sy, 2, 2);
  }
}

// ═══════════════════════════════════════════════════════════
//  森林渲染（多层树冠 + 轻微摇摆 + 隐藏感）
// ═══════════════════════════════════════════════════════════
export function renderForest(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number,
  col: number, row: number,
  biome?: BiomeId,
): void {
  const c = getBiomeColors(biome);
  const T = TILE_SIZE;

  // 深绿底色
  ctx.fillStyle = c.forest;
  ctx.fillRect(x, y, T, T);

  // 轻微摇摆偏移（基于时间和位置，每棵树节奏不同）
  const sway = Math.sin(now / 500 + col * 2.1 + row * 1.7) * 1.2;

  // 多层树冠（大圆+小圆叠加，制造丛林感）
  const trees = [
    { dx: 8, dy: 10, r: 7, color: c.forestLight },
    { dx: 22, dy: 18, r: 8, color: c.forestLight },
    { dx: 12, dy: 24, r: 5, color: c.forest },
    { dx: 26, dy: 8, r: 5, color: c.forestLight },
  ];
  for (const t of trees) {
    ctx.fillStyle = t.color;
    safeFillCircle(ctx, x + t.dx + sway, y + t.dy, t.r);
    // 树冠高光
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    safeFillCircle(ctx, x + t.dx + sway - t.r * 0.3, y + t.dy - t.r * 0.3, t.r * 0.4);
  }

  // 地面草丛细节
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(x, y + T - 3, T, 3);
}

// ═══════════════════════════════════════════════════════════
//  冰面渲染（渐变 + 反光 + 裂纹纹理）
// ═══════════════════════════════════════════════════════════
export function renderIce(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number,
  col: number, row: number,
  biome?: BiomeId,
): void {
  const c = getBiomeColors(biome);
  const T = TILE_SIZE;

  // 冰面渐变
  ctx.fillStyle = safeLinearGradient(ctx, x, y, T, T, c.iceLight, c.ice);
  ctx.fillRect(x, y, T, T);

  // 反光高光（随时间轻微变化，模拟冰面闪烁）
  const shimmer = Math.sin(now / 400 + col * 1.3 + row * 1.9) * 0.5 + 0.5;
  ctx.fillStyle = `rgba(255,255,255,${0.1 + shimmer * 0.15})`;
  ctx.fillRect(x + 2, y + 2, T - 4, 2);
  ctx.fillRect(x + 2, y + 2, 2, T - 4);

  // 冰裂纹理（确定性伪随机）
  const seed = (col * 47 + row * 89) % 100;
  if (seed < 40 && typeof ctx.beginPath === "function") {
    ctx.strokeStyle = "rgba(100,150,200,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const sx = x + (seed % 5) * 5 + 4;
    const sy = y + ((seed * 3) % 5) * 5 + 4;
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + 6, sy + 8);
    ctx.lineTo(sx + 3, sy + 14);
    if (seed > 20) {
      ctx.moveTo(sx + 6, sy + 8);
      ctx.lineTo(sx + 12, sy + 6);
    }
    ctx.stroke();
  }
}

// ═══════════════════════════════════════════════════════════
//  边界墙渲染（科技感深色边框）
// ═══════════════════════════════════════════════════════════
export function renderWall(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  col: number, row: number,
): void {
  const T = TILE_SIZE;
  // 深色底
  ctx.fillStyle = "#2a2a32";
  ctx.fillRect(x, y, T, T);
  // 内层
  ctx.fillStyle = "#1a1a22";
  ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
  // 科技感条纹
  ctx.fillStyle = "rgba(80,120,180,0.15)";
  const alt = (col + row) % 2 === 0;
  if (alt) {
    ctx.fillRect(x + 4, y + T / 2 - 1, T - 8, 2);
  } else {
    ctx.fillRect(x + T / 2 - 1, y + 4, 2, T - 8);
  }
  // 边缘高光
  ctx.fillStyle = "rgba(100,150,200,0.2)";
  ctx.fillRect(x, y, T, 1);
  ctx.fillRect(x, y, 1, T);
}

// ═══════════════════════════════════════════════════════════
//  动态地形状态渲染（火焰/冰/湿/油/电/毒/蒸汽）
// ═══════════════════════════════════════════════════════════
export function renderTileState(
  ctx: CanvasRenderingContext2D,
  state: TileState,
  x: number, y: number,
  now: number,
  col: number, row: number,
): void {
  const T = TILE_SIZE;
  const cx = x + T / 2;
  const cy = y + T / 2;
  // 脉冲（每格相位不同，避免整齐划一）
  const pulse = 0.5 + 0.5 * Math.abs(Math.sin(now / 120 + col * 0.7 + row * 0.3));

  switch (state.element) {
    case "fire":
      renderFire(ctx, x, y, now, col, row, state.intensity, pulse);
      break;
    case "ice":
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = "#bfefff";
      ctx.fillRect(x, y, T, T);
      ctx.strokeStyle = "#eaffff";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 2.5, y + 2.5, T - 5, T - 5);
      // 冰晶
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      safeFillCircle(ctx, cx, cy, 3);
      ctx.globalAlpha = 1;
      break;
    case "wet":
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = "#3a7fd4";
      ctx.fillRect(x, y, T, T);
      // 湿润反光
      ctx.fillStyle = "rgba(180,220,255,0.2)";
      ctx.fillRect(x + 4, y + 4, T - 8, 2);
      ctx.globalAlpha = 1;
      break;
    case "oil":
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#2a1a0e";
      if (typeof ctx.ellipse === "function" && typeof ctx.beginPath === "function") {
        ctx.beginPath();
        ctx.ellipse(cx, cy, 13, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(x + 3, y + 6, T - 6, T - 12);
      }
      // 油膜虹彩反光
      ctx.globalAlpha = 0.25 + pulse * 0.15;
      ctx.fillStyle = "#6a4a8a";
      if (typeof ctx.ellipse === "function" && typeof ctx.beginPath === "function") {
        ctx.beginPath();
        ctx.ellipse(cx - 2, cy - 2, 6, 4, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    case "electric":
      renderElectric(ctx, x, y, now, col, row, pulse);
      break;
    case "poison":
      renderPoison(ctx, x, y, now, col, row, pulse);
      break;
    case "steam":
      renderSteam(ctx, x, y, now, col, row, pulse);
      break;
  }
}

// 火焰渲染（径向渐变 + 跳动 + 火星）
function renderFire(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number, col: number, row: number,
  intensity: number, pulse: number,
): void {
  const T = TILE_SIZE;
  const cx = x + T / 2;
  const cy = y + T / 2;
  const r = 14 * intensity;

  // 外层暗火
  ctx.globalAlpha = 0.4 + pulse * 0.3;
  ctx.fillStyle = safeRadialGradient(ctx, cx, cy, r, "rgba(255,100,20,0.8)", "rgba(120,10,0,0)");
  safeFillCircle(ctx, cx, cy, r);

  // 内层亮火（跳动偏移）
  const flickX = Math.sin(now / 80 + col * 2) * 1.5;
  const flickY = Math.cos(now / 70 + row * 2) * 1.5;
  ctx.globalAlpha = 0.6 + pulse * 0.4;
  const innerColor = intensity >= 2 ? "rgba(255,230,100,0.95)" : "rgba(255,180,60,0.9)";
  ctx.fillStyle = safeRadialGradient(ctx, cx + flickX, cy + flickY, r * 0.6, innerColor, "rgba(200,50,0,0)");
  safeFillCircle(ctx, cx + flickX, cy + flickY, r * 0.6);

  // 火星粒子（向上飘）
  const sparkCount = intensity >= 2 ? 3 : 2;
  for (let i = 0; i < sparkCount; i++) {
    const phase = (now / 300 + i * 0.33 + col * 0.1 + row * 0.15) % 1;
    const sx = cx + Math.sin(phase * 6 + i) * 6;
    const sy = cy + 8 - phase * 16;
    const sa = (1 - phase) * 0.8;
    ctx.globalAlpha = sa;
    ctx.fillStyle = phase < 0.5 ? "#ffe060" : "#ff8020";
    ctx.fillRect(sx - 1, sy - 1, 2, 2);
  }
  ctx.globalAlpha = 1;
}

// 电流渲染（闪电折线 + 闪烁 + 电弧）
function renderElectric(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number, col: number, row: number,
  pulse: number,
): void {
  const T = TILE_SIZE;
  if (typeof ctx.beginPath !== "function" || typeof ctx.moveTo !== "function") {
    // 测试环境回退
    ctx.globalAlpha = 0.3 + pulse * 0.5;
    ctx.fillStyle = "#ffe14a";
    ctx.fillRect(x + 4, y + 4, T - 8, T - 8);
    ctx.globalAlpha = 1;
    return;
  }

  // 背景电光
  ctx.globalAlpha = 0.15 + pulse * 0.2;
  ctx.fillStyle = "#ffe14a";
  ctx.fillRect(x, y, T, T);

  // 主闪电（折线，每帧随机但基于时间种子）
  ctx.globalAlpha = 0.5 + pulse * 0.5;
  ctx.strokeStyle = "#fff080";
  ctx.lineWidth = 2;
  ctx.shadowColor = "#ffe14a";
  ctx.shadowBlur = 6;
  ctx.beginPath();
  const seed = Math.floor(now / 60) + col * 7 + row * 13;
  let lx = x + 4 + ((seed * 3) % 6);
  let ly = y + T - 4;
  ctx.moveTo(lx, ly);
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const nx = x + ((seed * (i + 1) * 5) % (T - 8)) + 4;
    const ny = y + T - 4 - (i / steps) * (T - 8);
    ctx.lineTo(nx, ny);
    lx = nx; ly = ny;
  }
  ctx.stroke();

  // 分支电弧
  if (pulse > 0.6) {
    ctx.strokeStyle = "#ffe14a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(lx + 6, ly - 4);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

// 毒雾渲染（气泡上升 + 绿色光晕）
function renderPoison(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number, col: number, row: number,
  pulse: number,
): void {
  const T = TILE_SIZE;
  const cx = x + T / 2;
  const cy = y + T / 2;

  // 绿色光晕
  ctx.globalAlpha = 0.25 + pulse * 0.2;
  ctx.fillStyle = safeRadialGradient(ctx, cx, cy, 14, "rgba(120,220,80,0.6)", "rgba(40,100,20,0)");
  safeFillCircle(ctx, cx, cy, 14);

  // 气泡（上升动画）
  const bubbles = [
    { dx: 8, dy: 10, r: 4, speed: 0.8 },
    { dx: 22, dy: 18, r: 5, speed: 1.0 },
    { dx: 14, dy: 24, r: 3, speed: 0.6 },
  ];
  for (const b of bubbles) {
    const phase = (now / 600 * b.speed + b.dx * 0.1 + b.dy * 0.1) % 1;
    const by = y + T - 4 - phase * (T - 8);
    const bx = x + b.dx + Math.sin(phase * 4 + b.dx) * 2;
    const ba = (1 - phase * 0.5) * 0.6;
    ctx.globalAlpha = ba;
    ctx.fillStyle = "#8fdf6f";
    safeFillCircle(ctx, bx, by, b.r * (0.8 + phase * 0.4));
    // 气泡高光
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    safeFillCircle(ctx, bx - b.r * 0.3, by - b.r * 0.3, b.r * 0.3);
  }
  ctx.globalAlpha = 1;
}

// 蒸汽渲染（白色水汽 + 扩散 + 遮挡感）
function renderSteam(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  now: number, col: number, row: number,
  pulse: number,
): void {
  const T = TILE_SIZE;
  const cx = x + T / 2;
  const cy = y + T / 2;

  // 白色水汽罩
  ctx.globalAlpha = 0.35 + pulse * 0.25;
  ctx.fillStyle = "#eef4ff";
  ctx.fillRect(x, y, T, T);

  // 蒸汽团（扩散飘动）
  const puffs = [
    { dx: 10, dy: 16, r: 7 },
    { dx: 22, dy: 20, r: 6 },
    { dx: 16, dy: 10, r: 5 },
  ];
  for (const p of puffs) {
    const driftX = Math.sin(now / 400 + p.dx * 0.2) * 2;
    const driftY = Math.cos(now / 500 + p.dy * 0.2) * 1.5;
    ctx.globalAlpha = 0.3 + pulse * 0.2;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    if (typeof ctx.beginPath === "function") {
      ctx.beginPath();
      ctx.arc(x + p.dx + driftX, y + p.dy + driftY, p.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// ═══════════════════════════════════════════════════════════
//  统一瓦片渲染入口（供 Tilemap.render 调用）
//  v2.17：静态瓦片使用 AssetCache 预渲染素材（drawImage），动画瓦片画缓存底图+动态叠加
// ═══════════════════════════════════════════════════════════
import { assetCache } from "../assets/AssetCache";

export function renderTile(
  ctx: CanvasRenderingContext2D,
  cell: TileCell,
  x: number, y: number,
  col: number, row: number,
  now: number,
  biome?: BiomeId,
): void {
  const b = (biome ?? "classic") as BiomeId;

  switch (cell.type) {
    case TileType.Empty:
    case TileType.Base: {
      // 地面：棋盘格 alt 色，完全静态 → 缓存
      const variant = (col + row) % 2 === 0 ? "alt0" : "alt1";
      const img = assetCache.getTile(TileType.Empty, b, variant);
      if (img) { ctx.drawImage(img, x, y); } else { renderGround(ctx, x, y, col, row, biome); }
      break;
    }
    case TileType.Brick: {
      // 砖块：满血用缓存（绝大多数），损伤时回退逐象限渲染
      const fullHealth = !cell.quadHp || cell.quadHp.every((q) => q >= 1);
      if (fullHealth) {
        const img = assetCache.getTile(TileType.Brick, b);
        if (img) { ctx.drawImage(img, x, y); break; }
      }
      renderBrick(ctx, x, y, cell, biome);
      break;
    }
    case TileType.Steel: {
      const img = assetCache.getTile(TileType.Steel, b);
      if (img) { ctx.drawImage(img, x, y); } else { renderSteel(ctx, x, y, biome); }
      break;
    }
    case TileType.Wall: {
      const img = assetCache.getTile(TileType.Wall, b);
      if (img) { ctx.drawImage(img, x, y); } else { renderWall(ctx, x, y, col, row); }
      break;
    }
    case TileType.Water: {
      // 水面：缓存静态底色 + 动态波浪叠加
      const img = assetCache.getTile(TileType.Water, b);
      if (img) {
        ctx.drawImage(img, x, y);
        // 波浪动画（轻量叠加）
        const wave = Math.sin(now / 500 + col * 0.5 + row * 0.3) * 2;
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fillRect(x, y + 8 + wave, TILE_SIZE, 2);
        ctx.fillRect(x, y + 20 - wave, TILE_SIZE, 1);
      } else {
        renderWater(ctx, x, y, now, col, row, biome);
      }
      break;
    }
    case TileType.Forest: {
      // 森林：缓存树底图 + 轻微摇摆
      const img = assetCache.getTile(TileType.Forest, b);
      if (img) {
        ctx.drawImage(img, x, y);
        // 轻微闪光（模拟风吹）
        const shimmer = 0.05 + 0.03 * Math.sin(now / 400 + col + row);
        ctx.fillStyle = `rgba(180,255,150,${shimmer})`;
        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
      } else {
        renderForest(ctx, x, y, now, col, row, biome);
      }
      break;
    }
    case TileType.Ice: {
      // 冰面：缓存底图 + 闪光
      const img = assetCache.getTile(TileType.Ice, b);
      if (img) {
        ctx.drawImage(img, x, y);
        const shimmer = Math.sin(now / 300 + col * 0.7 + row * 0.5);
        if (shimmer > 0.5) {
          ctx.fillStyle = `rgba(255,255,255,${(shimmer - 0.5) * 0.3})`;
          ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
        }
      } else {
        renderIce(ctx, x, y, now, col, row, biome);
      }
      break;
    }
  }
}
