// TankVisual.ts - 坦克美化绘制模块
// 以"新增+修改指向"方式提供美化后的坦克身体绘制。
// 原有 Tank.ts render() 中的 HP 条、状态图标等逻辑保留，仅替换身体绘制部分。

import type { Tank } from "../game/Tank";
import { DIR_ANGLES } from "../game/Tank";
import { lightenColor, darkenColor } from "./VisualTheme";
// v2.17 视觉配置统一从资源包读取，确保联机两端一致
import { getGradeVisual, getPlayerTankColors, type GradeVisual } from "../assets/AssetPack";
import { assetCache } from "../assets/AssetCache";

export type { GradeVisual };

// ═══════════════════════════════════════════════════════════
//  主入口：绘制美化后的坦克身体
//  调用方：Tank.render() 在 ctx.save/translate/rotate 之后调用本函数
// ═══════════════════════════════════════════════════════════
export function drawTankBody(
  ctx: CanvasRenderingContext2D,
  tank: Tank,
  now: number,
): void {
  const w = tank.config.width;
  const h = tank.config.height;

  // 注意：阴影已移到旋转坐标系之外绘制（drawTankShadow），确保影子方向固定（右下方），不随坦克朝向旋转

  if (tank.team === 0) {
    // 玩家坦克 —— v2.17 优先用素材缓存（预渲染身体），动态叠加玩家标识
    const playerId = tank.playerId === 1 ? 1 : 0;
    const cached = assetCache.getPlayerTank(playerId, w);
    if (cached) {
      ctx.drawImage(cached, -w / 2, -h / 2);
      // v2.18 玩家标识移到炮塔中心（原在 y负方向=侧面，已修复）
      if (playerId === 0) {
        // P1：蓝色小三角在炮塔中心偏前
        ctx.fillStyle = "rgba(120,200,255,0.85)";
        ctx.shadowColor = "#88ccff";
        ctx.shadowBlur = 3;
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(-1, -3);
        ctx.lineTo(-1, 3);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        // P2：绿色小菱形在炮塔中心
        ctx.fillStyle = "rgba(120,255,150,0.8)";
        ctx.shadowColor = "#88ff88";
        ctx.shadowBlur = 3;
        ctx.save();
        ctx.translate(0, 0);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-2.5, -2.5, 5, 5);
        ctx.restore();
        ctx.shadowBlur = 0;
      }
      // v2.18 武器独立炮筒样式（根据当前激活炮筒的弹药类型）
      drawWeaponBarrelStyle(ctx, tank, w);
    } else {
      drawPlayerTank(ctx, w, h, playerId === 1 ? "P2" : "P1", now);
      // v2.18 非预渲染路径也加武器样式
      drawWeaponBarrelStyle(ctx, tank, w);
    }
  } else {
    // 敌方坦克 —— v2.17 优先用素材缓存，动态叠加能量线/发光
    const grade = (tank as any).grade as string | undefined;
    const visual = getGradeVisual(grade);
    const cached = assetCache.getEnemyTank(grade ?? "F", w);
    if (cached) {
      ctx.drawImage(cached, -w / 2, -h / 2);
      // 动态叠加：S/BOSS 能量线 + 发光
      if (visual.energyLines && visual.glowColor) {
        const pulse = 0.5 + 0.3 * Math.sin(now / 250);
        ctx.strokeStyle = visual.glowColor;
        ctx.globalAlpha = pulse * 0.6;
        ctx.lineWidth = 2;
        ctx.strokeRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4);
        ctx.globalAlpha = 1;
      }
      // F级锈斑
      if (grade === "F") {
        ctx.fillStyle = "rgba(80,40,20,0.4)";
        const spots = [[-w / 4, -h / 4, 2], [w / 5, h / 5, 1.5], [-w / 3, h / 3, 1.8], [w / 4, -h / 3, 1.2]];
        for (const [sx, sy, sr] of spots) {
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else {
      drawEnemyTank(ctx, w, h, visual, now, tank.isBoss, grade ?? "F");
      // v2.18 非预渲染路径也加武器样式
      drawWeaponBarrelStyle(ctx, tank, w);
    }
  }

  // 受击闪白（覆盖层）
  if (tank.hitFlashTimer > 0) {
    const a = Math.min(0.85, tank.hitFlashTimer / 0.15);
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    // 只覆盖车身区域（带圆角）
    roundRectPath(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, 3);
    ctx.fill();
  }

  // v2.18 伤害加成覆盖层（火力强化/永久伤害加成时身体变色）
  drawDamageBoostOverlay(ctx, tank, w, h, now);
}

// ═══════════════════════════════════════════════════════════
//  阴影（固定光源方向：右下方，不随坦克朝向旋转）
//  必须在 ctx.rotate() 之前调用，确保影子方向固定
// ═══════════════════════════════════════════════════════════
export function drawTankShadow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  // 影子固定在右下方（光源在左上方），不随坦克朝向旋转
  ctx.beginPath();
  ctx.ellipse(w / 4 + 2, h / 4 + 2, w / 2 + 2, h / 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  玩家坦克
// ═══════════════════════════════════════════════════════════
function drawPlayerTank(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  player: "P1" | "P2",
  now: number,
): void {
  // v2.17 从资源包读取玩家配色，确保联机两端一致
  const colors = getPlayerTankColors(player === "P1" ? 0 : 1);
  const { mainLight, mainDark, bodyMid, trackColor, turretLight, turretDark, accent } = colors;
  const isP1 = player === "P1";

  // 1. 履带（左右）
  drawTracks(ctx, w, h, trackColor, accent);

  // 2. 车身主体（渐变 + 圆角）
  const bodyInset = 3;
  const bw = w - bodyInset * 2;
  const bh = h - bodyInset * 2;
  const bodyGrad = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  bodyGrad.addColorStop(0, mainLight);
  bodyGrad.addColorStop(0.5, bodyMid);
  bodyGrad.addColorStop(1, mainDark);
  ctx.fillStyle = bodyGrad;
  roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, 3);
  ctx.fill();

  // 车身边缘高光
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  roundRectPath(ctx, -bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1, bh - 1, 3);
  ctx.stroke();

  // 车身底部暗边
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(-bw / 2, bh / 2 - 2, bw, 2);

  // 3. 装甲板细节（横向条纹）
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let i = 0; i < 2; i++) {
    const py = -bh / 2 + 4 + i * (bh / 2);
    ctx.fillRect(-bw / 2 + 2, py, bw - 4, 1.5);
  }

  // 4. 玩家标识
  if (isP1) {
    // P1：前方白色箭头（科技感）
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.shadowColor = "#88ccff";
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.moveTo(bw / 2 - 2, 0);
    ctx.lineTo(bw / 2 - 9, -5);
    ctx.lineTo(bw / 2 - 9, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else {
    // P2：双横白条 + 金色后置天线
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(-bw / 2 + 1, -bh / 2 + 3, bw - 2, 1.5);
    ctx.fillRect(-bw / 2 + 1, bh / 2 - 5, bw - 2, 1.5);
    // 金色天线
    ctx.save();
    ctx.strokeStyle = "#ffd700";
    ctx.lineWidth = 2;
    ctx.shadowColor = "#ffd700";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + 1, 0);
    ctx.lineTo(-bw / 2 - 7, 0);
    ctx.stroke();
    // 天线顶端指示灯
    ctx.fillStyle = "#ff4444";
    ctx.beginPath();
    ctx.arc(-bw / 2 - 7, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 4.5 后方排气口（所有玩家坦克通用，明确区分前后：前方有炮管，后方有排气口）
  drawExhaustPort(ctx, bw, bh);

  // 5. 炮管（指向前方 = x 正方向）
  drawBarrel(ctx, w, "#1a1a2a", "#3a3a5a");

  // 6. 炮塔
  if (isP1) {
    // P1：方炮塔
    const tw = Math.min(10, w * 0.38);
    const tGrad = ctx.createLinearGradient(0, -tw / 2, 0, tw / 2);
    tGrad.addColorStop(0, turretLight);
    tGrad.addColorStop(1, turretDark);
    ctx.fillStyle = tGrad;
    roundRectPath(ctx, -tw / 2, -tw / 2, tw, tw, 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    roundRectPath(ctx, -tw / 2 + 0.5, -tw / 2 + 0.5, tw - 1, tw - 1, 2);
    ctx.stroke();
    // 炮塔中心观察窗
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(-2, -2, 4, 4);
    ctx.fillStyle = "rgba(150,220,255,0.6)";
    ctx.fillRect(-1.5, -1.5, 3, 1);
  } else {
    // P2：圆炮塔
    const tr = Math.min(5.5, w * 0.2);
    const tGrad = ctx.createRadialGradient(-tr * 0.3, -tr * 0.3, 1, 0, 0, tr);
    tGrad.addColorStop(0, turretLight);
    tGrad.addColorStop(1, turretDark);
    ctx.fillStyle = tGrad;
    ctx.beginPath();
    ctx.arc(0, 0, tr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();
    // 炮塔中心
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.arc(0, 0, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ═══════════════════════════════════════════════════════════
//  敌方坦克（按等级视觉）
// ═══════════════════════════════════════════════════════════
function drawEnemyTank(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  v: GradeVisual,
  now: number,
  isBoss: boolean,
  grade: string = "F",
): void {
  // 能量光环（S/BOSS）
  if (v.glowColor) {
    const pulse = 0.5 + 0.3 * Math.sin(now / 250);
    ctx.save();
    ctx.strokeStyle = v.glowColor;
    ctx.globalAlpha = pulse * 0.5;
    ctx.lineWidth = 2;
    ctx.shadowColor = v.glowColor;
    ctx.shadowBlur = 8;
    roundRectPath(ctx, -w / 2 - 2, -h / 2 - 2, w + 4, h + 4, 4);
    ctx.stroke();
    ctx.restore();
  }

  // 1. 履带
  drawTracks(ctx, w, h, v.trackColor, v.accentColor);

  // 2. 车身主体
  const bodyInset = 3;
  const bw = w - bodyInset * 2;
  const bh = h - bodyInset * 2;
  const bodyGrad = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  bodyGrad.addColorStop(0, v.bodyLight);
  bodyGrad.addColorStop(0.5, lightenColor(v.bodyDark, 0.15));
  bodyGrad.addColorStop(1, v.bodyDark);
  ctx.fillStyle = bodyGrad;
  roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, 3);
  ctx.fill();

  // 车身边缘
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 1;
  roundRectPath(ctx, -bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1, bh - 1, 3);
  ctx.stroke();

  // 顶部高光
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(-bw / 2 + 2, -bh / 2 + 1, bw - 4, 1.5);

  // 3. 装甲板（按等级数量）
  if (v.armorPlates > 0) {
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.strokeStyle = v.accentColor;
    ctx.lineWidth = 0.8;
    const plateH = (bh - 6) / v.armorPlates;
    for (let i = 0; i < v.armorPlates; i++) {
      const py = -bh / 2 + 3 + i * plateH;
      ctx.fillRect(-bw / 2 + 2, py, bw - 4, plateH - 1);
      ctx.strokeRect(-bw / 2 + 2.5, py + 0.5, bw - 5, plateH - 2);
    }
  }

  // 4. 铆钉（C级及以上）
  if (v.armorPlates >= 1) {
    ctx.fillStyle = v.accentColor;
    const rivets = [
      [-bw / 2 + 3, -bh / 2 + 3], [bw / 2 - 3, -bh / 2 + 3],
      [-bw / 2 + 3, bh / 2 - 3], [bw / 2 - 3, bh / 2 - 3],
    ];
    for (const [rx, ry] of rivets) {
      ctx.beginPath();
      ctx.arc(rx, ry, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 5. 尖刺（A/S/BOSS）
  if (v.spikes) {
    ctx.fillStyle = v.accentColor;
    const spikeLen = 4;
    // 左右两侧尖刺
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 2; i++) {
        const sy = -bh / 2 + 4 + i * (bh - 8) / 1;
        ctx.beginPath();
        ctx.moveTo(side * (bw / 2), sy - 2);
        ctx.lineTo(side * (bw / 2 + spikeLen), sy);
        ctx.lineTo(side * (bw / 2), sy + 2);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // 6. 能量纹路（S/BOSS）
  if (v.energyLines && v.glowColor) {
    ctx.save();
    ctx.strokeStyle = v.glowColor;
    ctx.lineWidth = 1;
    ctx.shadowColor = v.glowColor;
    ctx.shadowBlur = 4;
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now / 200);
    // 车身中央能量线
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + 4, 0);
    ctx.lineTo(bw / 2 - 4, 0);
    ctx.stroke();
    // 分叉
    ctx.beginPath();
    ctx.moveTo(0, -bh / 2 + 3);
    ctx.lineTo(0, bh / 2 - 3);
    ctx.stroke();
    ctx.restore();
  }

  // 7. 锈斑（F级专属）
  if (grade === "F") {
    ctx.fillStyle = "rgba(80,40,20,0.4)";
    const spots = [
      [-bw / 4, -bh / 4, 2], [bw / 5, bh / 5, 1.5],
      [-bw / 3, bh / 3, 1.8], [bw / 4, -bh / 3, 1.2],
    ];
    for (const [sx, sy, sr] of spots) {
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 8. 炮管
  drawBarrel(ctx, w, "#111", "#333");

  // 8.5 后方排气口（敌方坦克通用，明确区分前后）
  drawExhaustPort(ctx, bw, bh);

  // 9. 炮塔（圆形，敌方通用）
  const tr = Math.min(5.5, w * 0.2);
  const tGrad = ctx.createRadialGradient(-tr * 0.3, -tr * 0.3, 1, 0, 0, tr);
  tGrad.addColorStop(0, lightenColor(v.turretColor, 0.2));
  tGrad.addColorStop(1, v.turretColor);
  ctx.fillStyle = tGrad;
  ctx.beginPath();
  ctx.arc(0, 0, tr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // 炮塔中心
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.beginPath();
  ctx.arc(0, 0, 2, 0, Math.PI * 2);
  ctx.fill();

  // BOSS 额外装饰：皇冠在 Tank.render 中已有，这里加炮塔光环
  if (isBoss && v.glowColor) {
    ctx.save();
    ctx.strokeStyle = v.glowColor;
    ctx.globalAlpha = 0.4 + 0.3 * Math.sin(now / 200);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, tr + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ═══════════════════════════════════════════════════════════
//  履带（分段纹理）
// ═══════════════════════════════════════════════════════════
function drawTracks(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  color: string,
  accent: string,
): void {
  const trackW = 4.5;
  const trackH = h - 2;

  for (const side of [-1, 1]) {
    const tx = side * (w / 2 - trackW / 2 - 0.5);

    // 履带主体
    const tGrad = ctx.createLinearGradient(tx - trackW / 2, 0, tx + trackW / 2, 0);
    tGrad.addColorStop(0, darkenColor(color, 0.3));
    tGrad.addColorStop(0.5, color);
    tGrad.addColorStop(1, darkenColor(color, 0.3));
    ctx.fillStyle = tGrad;
    roundRectPath(ctx, tx - trackW / 2, -trackH / 2, trackW, trackH, 1.5);
    ctx.fill();

    // 履带分段纹理
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    const segCount = Math.max(4, Math.floor(trackH / 5));
    const segH = trackH / segCount;
    for (let i = 0; i < segCount; i++) {
      const sy = -trackH / 2 + i * segH + segH * 0.15;
      ctx.fillRect(tx - trackW / 2 + 0.5, sy, trackW - 1, segH * 0.25);
    }

    // 履带边缘高光
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(tx - trackW / 2 + 0.5, -trackH / 2 + 0.5, 0.8, trackH - 1);
  }
}

// ═══════════════════════════════════════════════════════════
//  炮管（渐变 + 炮口制退器）
// ═══════════════════════════════════════════════════════════
function drawBarrel(
  ctx: CanvasRenderingContext2D,
  w: number,
  dark: string,
  light: string,
): void {
  const barrelLen = w / 2 + 6;
  const barrelH = 5;

  // 炮管主体渐变
  const bGrad = ctx.createLinearGradient(0, -barrelH / 2, 0, barrelH / 2);
  bGrad.addColorStop(0, light);
  bGrad.addColorStop(0.3, dark);
  bGrad.addColorStop(0.7, dark);
  bGrad.addColorStop(1, lightenColor(dark, 0.1));
  ctx.fillStyle = bGrad;
  ctx.fillRect(0, -barrelH / 2, barrelLen, barrelH);

  // 炮管顶部高光线
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(1, -barrelH / 2 + 0.5, barrelLen - 2, 0.8);

  // 炮口制退器
  const muzzleW = 3;
  ctx.fillStyle = lightenColor(dark, 0.15);
  ctx.fillRect(barrelLen - muzzleW, -barrelH / 2 - 1, muzzleW, barrelH + 2);
  // 炮口开口
  ctx.fillStyle = "#000";
  ctx.fillRect(barrelLen - 0.5, -1.5, 1.5, 3);
}

// ═══════════════════════════════════════════════════════════
//  后方排气口（明确区分前后：前方有炮管，后方有排气口）
// ═══════════════════════════════════════════════════════════
function drawExhaustPort(
  ctx: CanvasRenderingContext2D,
  bw: number, bh: number,
): void {
  // 后方（x 负方向）排气口：深色矩形 + 网格纹理
  const ex = -bw / 2 - 1;
  const ew = 3;
  const eh = bh * 0.5;
  const ey = -eh / 2;

  // 排气口主体
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(ex, ey, ew, eh);

  // 排气口内部网格（横向条纹）
  ctx.fillStyle = "#0a0a0a";
  const slatCount = 3;
  const slatH = eh / (slatCount * 2);
  for (let i = 0; i < slatCount; i++) {
    ctx.fillRect(ex + 0.5, ey + i * slatH * 2 + slatH * 0.5, ew - 1, slatH);
  }

  // 排气口边缘高光
  ctx.fillStyle = "rgba(255,255,255,0.15)";
  ctx.fillRect(ex, ey, ew, 0.8);
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(ex, ey + eh - 0.8, ew, 0.8);
}

// ═══════════════════════════════════════════════════════════
//  v2.18 武器独立炮筒样式：根据当前激活炮筒的弹药类型，在炮筒口画不同装饰
//  只占据炮筒口附近一小块区域，不改变炮筒主体
// ═══════════════════════════════════════════════════════════
export function drawWeaponBarrelStyle(
  ctx: CanvasRenderingContext2D,
  tank: Tank,
  w: number,
): void {
  // v2.19 防御：RemoteView 的 tankAdapter 没有 cannons（快照不含武器模块），直接返回避免黑屏
  if (!tank.cannons || !Array.isArray(tank.cannons)) return;
  const cannon = tank.cannons[tank.activeCannon];
  if (!cannon) return;
  // 取第一个非空模块的弹药类型
  const mod = cannon.modules.find(m => m && m.config && m.config.category === "projectile");
  if (!mod) return;
  const id = mod.config.id;
  const barrelLen = w / 2 + 4;  // 与 AssetCache/TankVisual 炮筒长度一致
  const bx = barrelLen;         // 炮筒口 x 坐标
  const by = 0;

  ctx.save();

  // 各武器炮口装饰（只占炮筒口附近 4-6px 区域）
  switch (id) {
    case "proj_gatling":  // 机枪：三根平行小管
      ctx.fillStyle = "#2a2a2a";
      for (let i = -1; i <= 1; i++) {
        ctx.fillRect(bx - 1, by + i * 2.2 - 0.8, 4, 1.6);
      }
      ctx.fillStyle = "#555";
      ctx.fillRect(bx + 2, by - 2, 1.5, 4);  // 旋转膛口
      break;

    case "proj_sniper":  // 狙击：加长细管 + 上方瞄准镜
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(bx - 2, by - 1, 6, 2);
      ctx.fillStyle = "#333";
      ctx.fillRect(bx - 1, by - 4, 3, 2);  // 瞄准镜
      ctx.fillStyle = "#f44";
      ctx.fillRect(bx, by - 3.5, 1, 1);    // 瞄准镜红点
      break;

    case "proj_spread":  // 散弹：双管
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(bx - 1, by - 3, 4, 2);
      ctx.fillRect(bx - 1, by + 1, 4, 2);
      ctx.fillStyle = "#444";
      ctx.fillRect(bx + 2, by - 3.5, 1, 3);
      ctx.fillRect(bx + 2, by + 0.5, 1, 3);
      break;

    case "proj_rocket":
    case "proj_missile":  // 火箭/导弹：方形发射管口
      ctx.fillStyle = "#2a2a3a";
      ctx.fillRect(bx - 1, by - 3, 4, 6);
      ctx.fillStyle = "#4a4a6a";
      ctx.fillRect(bx + 2, by - 2.5, 1.5, 5);
      ctx.fillStyle = "#f80";
      ctx.fillRect(bx + 3, by - 1, 1, 2);  // 管口橙光
      break;

    case "proj_laser":  // 激光：发光环
      ctx.strokeStyle = "#f44";
      ctx.lineWidth = 1.5;
      ctx.shadowColor = "#f44";
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(bx + 1, by, 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(255,80,80,0.4)";
      ctx.beginPath();
      ctx.arc(bx + 1, by, 2, 0, Math.PI * 2);
      ctx.fill();
      break;

    case "proj_flame":  // 火焰：喇叭形宽口
      ctx.fillStyle = "#3a1a0a";
      ctx.beginPath();
      ctx.moveTo(bx - 1, by - 2);
      ctx.lineTo(bx + 4, by - 4);
      ctx.lineTo(bx + 4, by + 4);
      ctx.lineTo(bx - 1, by + 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#f80";
      ctx.fillRect(bx + 3, by - 1.5, 1.5, 3);  // 管口火光
      break;

    case "proj_cannon":  // 加农炮：粗炮口
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(bx - 2, by - 3.5, 5, 7);
      ctx.fillStyle = "#333";
      ctx.fillRect(bx + 2, by - 4, 1.5, 8);
      break;

    case "proj_pierce":  // 穿透：箭头形炮口
      ctx.fillStyle = "#2a2a4a";
      ctx.beginPath();
      ctx.moveTo(bx + 4, by);
      ctx.lineTo(bx - 1, by - 2.5);
      ctx.lineTo(bx - 1, by + 2.5);
      ctx.closePath();
      ctx.fill();
      break;

    case "proj_bounce":  // 弹跳：圆形炮口
      ctx.fillStyle = "#2a4a2a";
      ctx.beginPath();
      ctx.arc(bx + 1, by, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4a8a4a";
      ctx.beginPath();
      ctx.arc(bx + 1, by, 1.5, 0, Math.PI * 2);
      ctx.fill();
      break;

    case "proj_seeking":
    case "mod_homing":  // 追踪：小型雷达碟
      ctx.fillStyle = "#3a3a1a";
      ctx.beginPath();
      ctx.ellipse(bx + 1, by - 3, 3, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#aa0";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(bx + 1, by - 3);
      ctx.lineTo(bx + 1, by);
      ctx.stroke();
      break;

    case "spec_black_hole":
    case "spec_black_hole_gold":  // 黑洞：紫色漩涡炮口
      ctx.fillStyle = "#2a0a3a";
      ctx.beginPath();
      ctx.arc(bx + 1, by, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#a4f";
      ctx.lineWidth = 1;
      ctx.shadowColor = "#a4f";
      ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.arc(bx + 1, by, 2, 0, Math.PI * 1.5);
      ctx.stroke();
      ctx.shadowBlur = 0;
      break;

    case "proj_pink":  // 粉色弹：粉色炮口
      ctx.fillStyle = "#f4a";
      ctx.fillRect(bx - 1, by - 2, 3, 4);
      ctx.fillStyle = "#fce";
      ctx.fillRect(bx + 1, by - 1, 1.5, 2);
      break;

    default:  // 基础子弹等：小炮口强化
      ctx.fillStyle = "#222";
      ctx.fillRect(bx - 1, by - 2, 3, 4);
      break;
  }

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  v2.18 伤害加成覆盖层：坦克有伤害增益时，身体覆盖一层颜色
//  以图层覆盖方式，不修改本体贴图
// ═══════════════════════════════════════════════════════════
export function drawDamageBoostOverlay(
  ctx: CanvasRenderingContext2D,
  tank: Tank,
  w: number, h: number,
  now: number,
): void {
  const hasBoost = tank.damageBoostTimer > 0;
  const hasMult = tank.damageMult > 1.05;
  if (!hasBoost && !hasMult) return;

  ctx.save();
  const pulse = 0.15 + 0.1 * Math.sin(now / 120);

  if (hasBoost) {
    // 短期伤害加成（火力强化道具）：橙红色光晕
    ctx.globalAlpha = pulse;
    ctx.fillStyle = "#ff6600";
    roundRectPath(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, 3);
    ctx.fill();
    // 边缘发光
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = "#ff8800";
    ctx.lineWidth = 1.5;
    ctx.shadowColor = "#ff6600";
    ctx.shadowBlur = 6;
    roundRectPath(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, 3);
    ctx.stroke();
  } else if (hasMult) {
    // 永久伤害加成（升级/模块）：淡红色覆盖
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = "#ff4444";
    roundRectPath(ctx, -w / 2 + 1, -h / 2 + 1, w - 2, h - 2, 3);
    ctx.fill();
  }

  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  工具：圆角矩形路径
// ═══════════════════════════════════════════════════════════
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
