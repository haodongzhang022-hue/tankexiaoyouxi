# 资源包与素材缓存系统使用说明

## 概述

本系统解决联机双人模式下 2 号机与主机的**视觉对齐**和**性能**问题，由两层组成：

| 层级 | 模块 | 职责 |
|------|------|------|
| **资源包层** | `src/assets/AssetPack.ts` | 集中管理所有视觉配置（配色/外观/特效样式），联机时一次性下载 |
| **素材缓存层** | `src/assets/AssetCache.ts` | 基于资源包预渲染瓦片/坦克到 offscreen canvas，渲染时 drawImage 复用 |

---

## 一、AssetPack（资源包）

### 核心理念

所有重复出现的通用视觉素材**不通过每帧快照传输**，而是在 2 号机连接时通过检查点消息**一次性下载**，直接覆盖本地配置。确保两端像素级一致，避免"各自生成导致偏差"。

### 资源包内容

```typescript
interface AssetPack {
  version: string;                          // 版本号，如 "2.17"
  biomes: Record<string, BiomeColors>;      // 6 套生物群系配色
  enemyTanks: Record<string, GradeVisual>;  // F/C/B/A/S/BOSS 六级坦克外观
  playerTanks: { P1: PlayerTankColors; P2: PlayerTankColors };
  effects: EffectStyles;                    // 爆炸/伤害数字/受击闪光样式
}
```

### 使用方法

#### 1. 读取配置（渲染模块）

```typescript
import { getBiomeColors, getGradeVisual, getPlayerTankColors } from "./assets/AssetPack";

// 获取生物群系配色
const colors = getBiomeColors("classic");

// 获取敌军坦克等级外观
const visual = getGradeVisual("BOSS");

// 获取玩家坦克配色（0=P1, 1=P2）
const playerColors = getPlayerTankColors(0);
```

#### 2. 应用资源包（2 号机接收时）

```typescript
import { assetPack } from "./assets/AssetPack";

// 直接覆盖，无需玩家手动操作
assetPack.apply(receivedPack);
```

#### 3. 新增视觉配置

1. 在 `AssetPack.ts` 的 `DEFAULT_ASSET_PACK` 中加字段
2. 渲染模块用 `assetPack.get()` 或便捷函数读取
3. 自动随检查点同步到 2 号机，无需改网络协议

### 同步机制

```
主机 (P1)                              2号机 (P2)
  │                                       │
  │  checkpoint (首次含完整 assetPack)    │
  │──────────────────────────────────────>│
  │                                       │  assetPack.apply() 覆盖本地
  │                                       │  assetCache.invalidate() 清缓存
  │                                       │
  │  checkpoint (后续仅 assetPackVersion) │
  │──────────────────────────────────────>│  版本一致则跳过
```

- 首次检查点发送完整资源包（~2KB JSON）
- 后续只发版本号，已同步则不重复传输
- 资源包变化时自动触发素材缓存失效

---

## 二、AssetCache（素材缓存）

### 核心理念

瓦片和坦克身体等**静态视觉元素**不再每帧重新创建渐变/路径，而是基于资源包预渲染到 offscreen canvas，渲染时直接 `drawImage`。

### 性能收益

| 项目 | 优化前 | 优化后 |
|------|--------|--------|
| 地面瓦片 | 每帧创建渐变+填充 | drawImage 位图 |
| 钢墙 | 每帧创建金属渐变 | drawImage 位图 |
| 砖块（满血） | 每帧画 4 象限砖纹 | drawImage 位图 |
| 坦克身体 | 每帧创建渐变+路径+炮塔 | drawImage 位图 + 轻量动态叠加 |
| 水面/森林/冰 | 每帧完整重绘 | 缓存底图 + 极简动画叠加 |

### 使用方法

#### 1. 获取瓦片素材

```typescript
import { assetCache } from "./assets/AssetCache";
import { TileType } from "./game/Tilemap";

// 获取 32×32 瓦片素材（自动缓存）
const img = assetCache.getTile(TileType.Steel, "classic");
if (img) ctx.drawImage(img, x, y);
```

#### 2. 获取坦克身体素材

```typescript
// 敌军坦克（按等级）
const body = assetCache.getEnemyTank("BOSS", 32);

// 玩家坦克（0=P1, 1=P2）
const body = assetCache.getPlayerTank(0, 32);
```

#### 3. 缓存自动失效

```typescript
// assetPack.apply() 被调用时，AssetCache 自动清空所有缓存
// 下一帧按需重新生成（基于新资源包）
assetPack.apply(newPack);  // → assetCache.invalidate() 自动触发
```

#### 4. 查看缓存统计

```typescript
const stats = assetCache.getStats();
// { tiles: 12, tanks: 8, hits: 15420, misses: 20, version: "2.17" }
```

### 缓存策略

- **静态瓦片**（地面/钢墙/边界墙）：100% 缓存，直接 drawImage
- **满血砖块**：缓存完整砖图；损伤砖块回退逐象限渲染
- **动画瓦片**（水/森林/冰）：缓存静态底图 + 极简动态叠加（1-2 个 fillRect）
- **坦克身体**：缓存履带+车身+炮塔+炮管；动态叠加能量线/发光/玩家标识/受击闪光

---

## 三、网络同步轻量化

### 快照中每帧发送的数据（动态信号）

| 字段 | 说明 |
|------|------|
| players/enemies | 位置/HP/朝向/存活 |
| projectiles | 子弹位置/颜色 |
| mapChanges | 增量瓦片变化（砖块打掉等） |
| tileStates | 活跃地形状态（火/毒/电） |
| explosions | 活跃爆炸 |
| handyman | 修复小人位置/状态 |
| damageNumbers | 活跃伤害数字 |

### 快照中**不**每帧发送的数据（资源包已覆盖）

- 生物群系配色 → 资源包
- 坦克外观配色 → 资源包
- 瓦片纹理样式 → 资源包 + 素材缓存
- 特效颜色/字体 → 资源包

---

## 四、文件清单

| 文件 | 职责 |
|------|------|
| `src/assets/AssetPack.ts` | 资源包类型定义 + 默认值 + 全局管理器 |
| `src/assets/AssetCache.ts` | 素材预渲染缓存 + 自动失效 |
| `src/ui/MapVisual.ts` | 瓦片渲染，改用 assetCache.getTile() |
| `src/ui/TankVisual.ts` | 坦克渲染，改用 assetCache.getEnemyTank()/getPlayerTank() |
| `src/modes/OnlineHostMode.ts` | 检查点携带资源包 |
| `src/main.ts` | 接收资源包并 apply |
| `src/ui/RemoteView.ts` | 资源包下载状态 UI |

---

## 五、常见问题

**Q: 2 号机看到的画面和主机不一样？**
A: 检查资源包是否已下载。2 号机顶部会显示 "✓ 资源包已同步 vX.XX"。若未显示，检查 checkpoint 消息是否包含 assetPack 字段。

**Q: 修改了配色但 2 号机没变化？**
A: 资源包版本号未变会被跳过。修改 DEFAULT_ASSET_PACK 后请递增 version 字段。

**Q: 性能没有提升？**
A: 用 `assetCache.getStats()` 查看命中率。若 misses 持续增长，检查 assetPack 是否频繁变化（会导致缓存反复失效）。
