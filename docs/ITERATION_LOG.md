# 坦克大战 — 联机双人模式迭代日志

> 本文档记录 web-tank-battle 联机双人模式的所有 bug 修复和架构改进，按轮次组织。
> 每轮包含：问题描述、根因分析、修改方案、涉及文件、验证结果。
> **目的**：供 Cocos 版本和 Unity 版本参考，检查是否存在相同问题并跟进修复。

---

## 第一轮：基础联机 Bug 修复

### 1.1 基地墙应为独立小砖，而非整体大墙

**问题**：基地的 4 面护墙（top/bottom/left/right）每面是一个整体，单一 HP。被攻击时整面墙一起变色、一起被击毁，修复时也是整面修复。

**期望**：每面墙由 8 块 16×16 的小砖组成，每块独立碰撞、独立被击毁、独立修复。与地图普通砖块机制一致。

**根因**：`Base.ts` 中 `walls` 数组只有 4 个面级对象，每个面一个 HP 值。

**修改方案**：
- `Base.ts` 新增 `bricks: Brick[]` 数组，共 32 块（每面 8 块，16×16px，每砖 1 HP）
- 新增 `getBrickAtPoint(x, y)`、`hitBrick(x, y, dmg)`、`repairBrick(brick)`、`repairMostDamagedBrick()` 方法
- `walls` 变为面级聚合 getter（向后兼容）
- `BaseVisual.ts` 逐块渲染小砖
- `CombatSystem.ts` 子弹命中改用逐块检测，碎砖可穿透（子弹从洞口穿过）
- `BaseRepairSystem.ts` 修复小人逐块修复
- `ItemUseSystem.ts` 修复工具箱修复所有砖
- `GameModeCore.syncBaseWallTiles` 按砖存活状态设置瓦片
- 网络全链路同步 `bricks` 数组（NetTypes → tank-adapter → RemoteView → OnlineHostMode）

**涉及文件**：
- `src/game/Base.ts`（重写）
- `src/ui/BaseVisual.ts`
- `src/systems/combat/CombatSystem.ts`
- `src/systems/base/BaseRepairSystem.ts`
- `src/systems/items/ItemUseSystem.ts`
- `src/framework/GameModeCore.ts`
- `src/net/NetTypes.ts`（NetBase.bricks）
- `net-sync-core/adapters/tank-adapter.ts`
- `src/ui/RemoteView.ts`
- `src/modes/OnlineHostMode.ts`
- `tests/itemUse.test.ts`（适配）

**验证**：编译通过，测试通过。

---

### 1.2 2 号玩家死亡后看不到自己的死亡标记

**问题**：玩家死亡后，1 号机（主机）能看到死亡标记（红色圆圈 + ✕），但 2 号机（远端）看不到。

**根因**：`buildSnapshot` 的玩家 `NetTank` 未发送 `lives` 字段，而 `RemoteView.renderCorpseMarkers` 要求 `t.lives > 0` 才渲染标记。

**修改方案**：
- `OnlineHostMode.buildSnapshot` 补上 `lives` 和 `respawnTimer` 字段
- `tank-adapter` schema 早已支持 `sync:none`，无需改

**涉及文件**：
- `src/modes/OnlineHostMode.ts`

**验证**：2 号机死亡后显示红色救援标记。

---

### 1.3 2 号机看不到仓库和背包面板

**问题**：1 号机有仓库面板和 P1/P2 背包面板，2 号机完全没有这套 UI，无法查看仓库和双方背包内容。

**根因**：检查点（checkpoint）协议只同步了玩家数据，没有仓库数据；RemoteView 没有仓库/背包面板的渲染和交互。

**修改方案**：
- 检查点协议新增 `warehouse` 字段（`NetWarehouse`：essence + items 列表）
- `OnlineHostMode.serializeCheckpoint` 返回 `{players, warehouse}`
- `NetClient.hostCheckpoint` 接受 warehouse
- `main.ts` 透传并调用 `remoteView.setCheckpoint(players, warehouse)`
- `SideInfoPanel` 远端渲染加入快捷按钮（仓/P1/P2）
- `RemoteView` 新增 `warehouseOpen`/`backpackOwner` 状态、`renderWarehousePanel`/`renderBackpackPanel`、`tap()` 处理按钮点击、E 键关闭面板

**涉及文件**：
- `src/net/NetTypes.ts`（NetWarehouse、CheckpointMsg.warehouse）
- `src/modes/OnlineHostMode.ts`
- `src/net/NetClient.ts`
- `src/main.ts`
- `src/ui/SideInfoPanel.ts`
- `src/ui/RemoteView.ts`

**验证**：2 号机可打开仓库和 P1/P2 背包面板查看内容。

---

### 1.4 小地图边框与实际地图左上角不对齐

**问题**：小地图左上角与实际地图左上角之间有很大空白区域。

**根因**：`Minimap.ts` 有 5px 内边距，地图内容没有顶到边框。

**修改方案**：去掉 5px 内边距，地图内容直接顶到 2px 亮色 + 1px 描边边框。

**涉及文件**：
- `src/ui/Minimap.ts`

---

## 第二轮：进阶问题修复

### 2.1 联机时火焰/爆炸特效消失

**问题**：单人模式（P1 自己开）能看到地图上的火焰和击毁时的爆炸特效；双人联机时 2 号机完全看不到这些特效。

**根因**：地形状态（火/毒/电等）和爆炸特效只在主机端存在，快照中完全没有同步这些数据。

**修改方案**：
- `NetSnapshot` 新增 `tileStates` 和 `explosions` 字段
- `OnlineHostMode.buildSnapshot` 收集活跃地形状态（`tilemap.forEachState`）和爆炸特效（`combatSystem.getActiveExplosions()`）
- `CombatSystem` 新增 `getActiveExplosions()` 公开方法
- `RemoteView` 新增 `renderTileStates()`（调用共享 `renderTileState`）和 `renderExplosions()`（径向渐变爆炸球）
- `tank-adapter` 的 `netSnapshotToState`/`stateToNetSnapshot` 加入 `mapChanges`/`tileStates`/`explosions`/`biome` 透传（此前 WS codec 路径会丢失这些字段）

**涉及文件**：
- `src/net/NetTypes.ts`
- `src/modes/OnlineHostMode.ts`
- `src/systems/combat/CombatSystem.ts`
- `src/ui/RemoteView.ts`
- `net-sync-core/adapters/tank-adapter.ts`

**验证**：2 号机能看到火焰跳动和爆炸特效。

---

### 2.2 地图砖块固定右下角销毁，应按命中位置独立破坏

**问题**：32×32 砖块被画成 4 个 16×16 子块，但销毁顺序写死（HP=3→右下, HP=2→右上, HP=1→左下），与子弹实际命中位置无关。子弹打左上角，右下角先消失。

**根因**：`MapVisual.renderBrick` 的销毁逻辑写死了顺序，`Tilemap.damage()` 只扣总 HP，不区分命中位置。

**修改方案**：
- `TileCell` 新增 `quadHp: [number,number,number,number]`（四象限独立血量，每象限 1 HP）
  - 象限约定：0=左上, 1=右上, 2=左下, 3=右下
- `Tilemap` 新增 `quadrantAt(wx, wy)` 静态方法：根据世界坐标判定命中哪个象限
- `Tilemap` 新增 `damageAt(wx, wy, dmg)`：只伤害命中的那个象限，该象限已碎则返回 false（子弹可穿过洞口）
- `Tilemap` 新增 `setQuadHp()`：供远端同步象限血量
- `Tilemap.damage()` 保持旧行为（逐象限扣减，用于爆炸/兼容）
- `CombatSystem` 子弹命中改用 `damageAt(sx, sy, dmg)`；砖块命中象限已碎时 `continue`（子弹穿过洞口）
- `MapVisual.renderBrick` 改用 `cell.quadHp` 逐象限渲染，无 `quadHp` 时回退旧逻辑
- `mapChanges` 携带 `quadHp` 同步到远端
- 砖块伤害时标记 `dirtyTiles`，`getDirtyTileChanges()` 携带 `quadHp`

**涉及文件**：
- `src/game/Tilemap.ts`
- `src/systems/combat/CombatSystem.ts`
- `src/ui/MapVisual.ts`
- `src/ui/RemoteView.ts`
- `src/net/NetTypes.ts`（mapChanges 加 quadHp）
- `src/modes/OnlineHostMode.ts`
- `net-sync-core/adapters/tank-adapter.ts`

**验证**：子弹打哪里哪里碎，碎砖可穿透；测试通过。

---

### 2.3 玩家剩余命数呈现不够醒目

**问题**：玩家剩余命数信息不明显，阵亡后也不清楚。

**修改方案**：
- `SideInfoPanel` 本地和远端玩家信息头部都加入 **♥红色心形 + 命数**（如 `♥10`），阵亡时变灰
- `RemoteInfoSource.players` 增加 `lives?` 字段
- `RemoteView.remoteInfoSource()` 传递 `p.lives`

**涉及文件**：
- `src/ui/SideInfoPanel.ts`
- `src/ui/RemoteView.ts`

---

### 2.4 弱子弹打不动钢墙/岩石时不应有颜色变化

**问题**：普通子弹打钢墙时，钢墙会闪白色受击光，看起来像是被打伤了，实际上没掉血。

**期望**：打不动就一点变化都没有，才是"打不动"的视觉反馈。

**根因**：受击闪光由 `hp` 变化检测驱动。旧 `damage()` 对钢墙每次扣 1 HP（999 HP），所以每次都触发闪光。

**修改方案**：
- `Tilemap.damageAt()` 和 `damage()` 中，钢墙（Steel）/边界墙（Wall）在伤害 < 5 时直接返回 false，**不掉血也不触发受击闪光**
- 普通子弹对钢墙 `tileDmg=1` < 5 → 打不动、无闪光
- 重型穿透子弹（`pierceLeft > 5`）`tileDmg=10` → 可造成伤害

**涉及文件**：
- `src/game/Tilemap.ts`

---

## 第三轮：2 号机渲染管道全面对齐

### 背景

主机端 `GameModeCore.renderWorld` 渲染 13 类内容，远端 `RemoteView.render` 此前只覆盖了其中约 7 类。经过逐项对比，确认远端缺失以下内容并逐一修复。

### 3.1 坦克渲染对齐（炮筒挂载点 / Boss皇冠 / Buff图标 / 无敌闪光 / 眩晕 / 复活进度）

**问题**：远端坦克只有身体+血条+等级角标，缺少主机端的多种视觉装饰。

**缺失项**：
- 玩家坦克四周的炮筒挂载点标记（4 个点，高亮当前炮筒+编号）
- Boss 皇冠 + 紫色发光边框
- Buff/状态图标（🔥伤害 🛡无敌 ✦护甲 ⚡加速 ❄冻结）
- 无敌闪光（白色边框闪烁）
- 眩晕闪白
- 复活进度条（队友救援中）

**修改方案**：
- `NetTank` 新增 `buffs?: string[]`、`stunned?: boolean`、`reviveProgress?: number` 字段
- `Tank` 新增 `getBuffIcons()` 方法（集中计算激活的 Buff 图标列表，避免重复逻辑）
- `OnlineHostMode.buildSnapshot` 玩家和敌人都带上 `buffs`/`stunned`/`reviveProgress`
- `RemoteView.renderTank` 重写，补齐所有视觉元素，与 `Tank.render()` 对齐
- 森林隐藏半透明从 0.72 改为 0.35（与主机一致）

**涉及文件**：
- `src/net/NetTypes.ts`
- `src/game/Tank.ts`
- `src/modes/OnlineHostMode.ts`
- `src/ui/RemoteView.ts`

---

### 3.2 修复小人（基地维修工）同步 + 渲染

**问题**：2 号机完全看不到基地修复小人（走路、挥锤、墓碑状态）。

**修改方案**：
- `NetTypes` 新增 `NetHandyman` 接口（x/y/isAlive/grave/walking/repairing/repairingEagle/dir）
- `NetSnapshot` 新增 `handyman?: NetHandyman | null`
- `BaseRepairSystem` 新增 `getHandymanSnapshot()` 方法
- `OnlineHostMode.buildSnapshot` 收集修复小人状态
- `RemoteView` 新增 `renderHandyman()`，完整复现主机端渲染（影子/腿/身体/手臂+锤子/头/安全帽/墓碑/修复提示）
- 动画用 `performance.now()` 本地驱动（走路摆动、挥锤）

**涉及文件**：
- `src/net/NetTypes.ts`
- `src/systems/base/BaseRepairSystem.ts`
- `src/modes/OnlineHostMode.ts`
- `src/ui/RemoteView.ts`
- `net-sync-core/adapters/tank-adapter.ts`

---

### 3.3 伤害数字（飘字）同步 + 渲染

**问题**：2 号机看不到伤害数字（打中敌人时飘起的伤害值）。

**修改方案**：
- `NetTypes` 新增 `NetDamageNumber` 接口（x/y/value/crit/color）
- `NetSnapshot` 新增 `damageNumbers?: NetDamageNumber[]`
- `CombatSystem` 新增 `getActiveDamageNumbers()` 方法
- `OnlineHostMode.buildSnapshot` 收集活跃伤害数字
- `RemoteView` 新增 `renderDamageNumbers()`，暴击数字带黑色描边

**涉及文件**：
- `src/net/NetTypes.ts`
- `src/systems/combat/CombatSystem.ts`
- `src/modes/OnlineHostMode.ts`
- `src/ui/RemoteView.ts`
- `net-sync-core/adapters/tank-adapter.ts`

---

### 3.4 地图受击闪光

**问题**：2 号机瓦片被击中时没有白色闪光反馈。

**修改方案**：
- `RemoteView` 新增 `hitFlash: Map<number, number>` 和 `prevHp: Int16Array`
- `renderMap()` 中检测每块瓦片 HP 变化，减少时触发 0.18 秒白色闪光（与主机 `Tilemap.render` 机制完全一致）
- 闪光衰减：每帧减 dt，alpha 从 0.7 线性衰减到 0

**涉及文件**：
- `src/ui/RemoteView.ts`

---

### 3.5 仍未对齐项（记录待后续修复）

以下项目前仍未同步到 2 号机，记录备查：

| 缺失项 | 同步方案 |
|--------|----------|
| 粒子特效（火花/烟雾/碎片） | 数据量大，建议远端本地根据子弹命中位置生成，或快照加 `particles[]` |
| 无人机（droneSystem） | 快照加 `drones[]` 字段 |
| 敌人出生预警光圈 | 快照加 `spawnWarnings[]` |
| 掉落炮筒（droppedCannons） | 快照加 `droppedCannons[]` |
| 临时墙蓝色边框+倒计时 | 快照加 `tempWalls[]` 或 mapChanges 携带 |

---

## 第四轮：资源包 + 素材缓存系统

### 4.1 AssetPack 资源包系统

**问题**：视觉配置（配色/外观/特效样式）硬编码在各渲染模块中，联机时 2 号机依赖本地代码生成，可能与主机有偏差；且没有"一次性下载素材"的机制。

**核心理念**：所有重复出现的通用视觉素材集中为一个资源包，2 号机连接时通过检查点消息**一次性下载**，直接覆盖本地配置，确保两端像素级一致。

**资源包内容**：
```typescript
interface AssetPack {
  version: string;                           // 版本号
  biomes: Record<string, BiomeColors>;       // 6 套生物群系配色
  enemyTanks: Record<string, GradeVisual>;   // F/C/B/A/S/BOSS 六级坦克外观
  playerTanks: { P1: PlayerTankColors; P2: PlayerTankColors };
  effects: EffectStyles;                     // 爆炸/伤害数字/受击闪光样式
}
```

**修改方案**：
- 新建 `src/assets/AssetPack.ts`：类型定义 + 默认资源包 + 全局管理器 `assetPack` + 便捷查询函数（`getBiomeColors`/`getGradeVisual`/`getPlayerTankColors`）
- `MapVisual.ts` 删除硬编码 `BIOME_COLORS`，改用 `getBiomeColors()`
- `TankVisual.ts` 删除硬编码 `GRADE_VISUALS` 和玩家配色，改用 `getGradeVisual()`/`getPlayerTankColors()`
- `CheckpointMsg` 新增 `assetPack` 和 `assetPackVersion` 字段
- `OnlineHostMode` 新增 `serializeCheckpointWithAssetPack()`：首次发完整包，后续只发版本号
- `main.ts` 接收时调用 `assetPack.apply(m.assetPack)` 直接覆盖
- `RemoteView` 新增 `onAssetPackApplied()` 和 `renderAssetPackStatus()`：显示"正在下载资源包…"→"✓ 资源包已同步 vX.XX"

**同步机制**：
```
主机 ──checkpoint(首次含完整 assetPack)──> 2号机
                                          assetPack.apply() 覆盖本地
                                          assetCache.invalidate() 清缓存
主机 ──checkpoint(后续仅 assetPackVersion)──> 2号机 版本一致则跳过
```

**涉及文件**：
- `src/assets/AssetPack.ts`（新建）
- `src/ui/MapVisual.ts`
- `src/ui/TankVisual.ts`
- `src/net/NetTypes.ts`
- `src/modes/OnlineHostMode.ts`
- `src/net/NetClient.ts`
- `src/main.ts`
- `src/ui/RemoteView.ts`

---

### 4.2 AssetCache 素材预渲染缓存（性能优化）

**问题**：每帧 676+ 瓦片和所有坦克都从零重新创建渐变/路径/炮塔，CPU 占用高。

**核心理念**：基于资源包把瓦片和坦克身体**预渲染到 offscreen canvas**，渲染时直接 `drawImage` 复用。资源包变化时自动失效缓存并重新生成。

**缓存策略**：

| 元素 | 策略 |
|------|------|
| 地面/钢墙/边界墙 | 100% 缓存，直接 drawImage |
| 满血砖块 | 缓存完整砖图；损伤砖块回退逐象限渲染 |
| 水面/森林/冰 | 缓存静态底图 + 极简动态叠加（1-2 个 fillRect） |
| 坦克身体 | 缓存履带+车身+炮塔+炮管；动态叠加能量线/发光/玩家标识/受击闪光 |

**修改方案**：
- 新建 `src/assets/AssetCache.ts`：`AssetCacheManager` 类，全局单例 `assetCache`
  - `getTile(tileType, biome, variant)` → 32×32 瓦片素材
  - `getEnemyTank(grade, size)` → 敌军坦克身体素材
  - `getPlayerTank(playerId, size)` → 玩家坦克身体素材
  - `invalidate()` → 清空所有缓存（资源包变化时自动调用）
  - `getStats()` → 缓存命中统计
- `assetPack.subscribe()` 自动触发 `assetCache.invalidate()`
- `MapVisual.renderTile` 改用 `assetCache.getTile()`，缓存未命中时回退原渲染函数
- `TankVisual.drawTankBody` 改用缓存身体 + 动态叠加（能量线/发光/玩家标识/锈斑）

**涉及文件**：
- `src/assets/AssetCache.ts`（新建）
- `src/ui/MapVisual.ts`
- `src/ui/TankVisual.ts`

---

### 4.3 网络同步轻量化

**每帧快照只发动态信号**（位置/HP/朝向/存活/子弹/增量瓦片变化/活跃火焰爆炸伤害数字）。

**不每帧发**（资源包已覆盖）：生物群系配色、坦克外观、瓦片纹理、特效样式。

---

### 4.4 开发服务器端口修复

**问题**：`vite.config.ts` 硬编码 `port: 3000`，这是 MCP 等服务最常用的端口，几乎必然冲突；且曾误启动两个 dev server 互相抢占。

**修改方案**：
- 端口改为 **5173**（Vite 默认端口，几乎不与其他服务冲突）
- 加 `strictPort: false`，5173 被占时自动升到 5174、5175…
- 启动前检查端口和已有进程，不重复启动

**涉及文件**：
- `vite.config.ts`

---

## 附录：跨引擎检查清单（Cocos / Unity 参考）

以下问题在其他引擎版本中很可能同样存在，建议逐项检查：

### 联机同步类
- [ ] 基地护墙是否为独立小砖（而非整体大墙）？
- [ ] 死亡标记是否同步到所有客户端？
- [ ] 仓库/背包 UI 是否所有客户端都能查看？
- [ ] 地形状态（火/毒/电）是否同步？
- [ ] 爆炸特效是否同步？
- [ ] 伤害数字是否同步？
- [ ] 修复小人（NPC）是否同步？
- [ ] 玩家 Buff/状态图标是否同步？
- [ ] 坦克炮筒挂载点标记是否所有客户端可见？
- [ ] Boss 皇冠/发光是否所有客户端可见？
- [ ] 瓦片受击闪光是否所有客户端可见？
- [ ] 粒子特效是否同步或本地生成？
- [ ] 无人机是否同步？
- [ ] 敌人出生预警是否同步？
- [ ] 掉落炮筒是否同步？
- [ ] 临时墙视觉（边框+倒计时）是否同步？

### 游戏逻辑类
- [ ] 砖块是否按命中位置独立破坏（四象限）？
- [ ] 碎砖是否可穿透（子弹从洞口穿过）？
- [ ] 弱子弹打不动钢墙时是否无任何视觉变化？
- [ ] 玩家命数是否醒目呈现？

### 架构类
- [ ] 视觉配置是否集中管理（资源包），而非散落在各模块？
- [ ] 联机时视觉配置是否一次性下载，而非每帧传输？
- [ ] 静态素材是否预渲染缓存（提升性能）？
- [ ] 渲染管道是否主机/客户端共用同一套模块？

### UI 类
- [ ] 小地图边框是否与实际地图对齐（无多余内边距）？
- [ ] 所有客户端 UI 功能是否对齐（仓库/背包/商店）？

---

## 第五轮：游戏平衡性与升级系统改造

### 5.1 掉落物存活时间延长

**问题**：改装件（模块/道具）掉落後 20 秒消失，玩家经常来不及拾取。

**方案**：掉落物存活时间从 20s 延长到 60s。

**涉及文件**：
- `src/systems/loot/LootSystem.ts`：`DROP_LIFETIME` 20 → 60
- `src/framework/NumericConfig.ts`：`LOOT.DROP_LIFETIME` 20 → 60（双处同步）

### 5.2 敌人模块掉落率减少 75%

**问题**：敌人掉落模块过多，模块变得不值钱，玩家背包很快塞满。

**方案**：模块掉率全局倍增倍率从 0.8 降到 0.2（即再减 75%）。实际掉率 = `enemyCfg.moduleDropChance × 0.2`。

**涉及文件**：
- `src/framework/NumericConfig.ts`：`LOOT.MODULE_DROP_MULTIPLIER` 0.8 → 0.2

**注意**：传统道具（item_shield 等）掉率不受影响，仍由 `TRAD_ITEM_DROP_BY_GRADE` 控制。Boss 必掉金色模块不受此倍率影响。

### 5.3 武器伤害调整

**问题**：初始武器伤害过高，狙击武器伤害不够突出。

**方案**：
- 初始主炮（proj_cannon）伤害 12 → 6（下降一半）
- 狙击弹（proj_sniper）伤害 20 → 40（上升两倍）

**涉及文件**：
- `src/systems/wand/ModuleRegistry.ts`：`proj_cannon.damage` 12→6，`proj_sniper.damage` 20→40

**跨引擎检查**：Cocos/Unity 版本需同步检查初始武器和狙击武器的伤害配置，保持数值一致。

### 5.4 单发武器允许双发同时飞行

**问题**：经典单发武器（如初始主炮）同一时间只能有 1 发子弹在飞，火力受限。用户要求"同一个武器带俩，允许的最大子弹上限提升"。

**方案**：`singleShot` 武器的在飞子弹上限从 1 提升到 2。当在飞子弹数 ≥ 2 时才阻止发射，并钳制 `castTimer` 到 `SINGLE_SHOT_RELOAD`（0.2s）。每发子弹仍按模块消耗 `usesLeft`。

**根因**：原代码用 `this.projectiles.some(...)` 检测"至少 1 发在飞"即阻止。改为 `filter(...).length >= 2`。

**涉及文件**：
- `src/systems/wand/WandSystem.ts`：singleShot 检查从 `some`（≥1）改为 `filter().length >= 2`

**DPS 变化**：双发上限使中远距离 DPS 提升（2 发交替飞行），近距 DPS 仍受 `castDelay` 限制。原"近距 DPS 反升"效应（命中后 0.2s 再射）被稀释。

### 5.5 升级系统改造：属性直接加到坦克，不占武器槽、不进背包

**问题**：
1. 升级选项中包含"随机蓝色模块"（fp_bluemod），选中后模块进入背包——但物品模块应该只来自敌人掉落或基地购买，不应从升级获得。
2. 升级选项中包含"炮筒+1格"（fp_slot），选中后给当前炮筒新增一个模块槽——这占据武器槽，不符合"升级是坦克属性成长"的定位。
3. 用户明确要求："升级选的东西是加到坦克身上，不是武器槽的，不要拾取到背包了，比如子弹速度、移动速度，这占据武器槽是明显错误。"

**方案**：
- 从 `ABILITY_POOL` 中移除 `fp_bluemod`（随机蓝色模块）和 `fp_slot`（炮筒+1格）
- 从 `ABILITY_POOL` 中移除 `df_bagslot`（背包+2格）——非坦克属性，且与"不进背包"原则冲突
- 保留所有直接修改坦克属性的选项：`fp_crit`（暴击）、`fp_speed`（弹速→`t.projSpeedMult`）、`fp_reload`（装填）、`fp_recharge`（充能）、`df_hp/hp2`（血量）、`df_armor/armor2`（装甲）、`df_respawn`（复活）、`df_invincible`（护盾）、`sp_loot`（盗取）、`sp_freecast`（免消耗）、`sp_speed`（移速→`t.extraSpeed`）、`sp_repair`（修复速度）、`sp_fortify`（基地加固）、`wp_wall_*`（放墙等级）
- 清理 `applyAbility()` 中 `fp_bluemod` 和 `df_bagslot` 的 case 分支
- 清理未使用的 `getModule`/`getModulesByQuality` 导入

**涉及文件**：
- `src/systems/levelup/LevelUpSystem.ts`：ABILITY_POOL 移除 3 项、applyAbility 清理、导入清理

**关于"升级选择物出现在基地什么位置"**：由于升级不再产生物理掉落物（所有选项直接加到坦克属性），此需求自然消解。物品模块仅通过敌人掉落和基地商店获取，掉落位置由 `LootSystem.onEnemyKilled` 控制（在敌人死亡位置附近随机偏移）。

### 5.6 测试适配

**涉及文件**：
- `tests/wandSingleShot.test.ts`：重写为"最多 2 发同时飞行，第 3 发被阻挡"
- `tests/dpsCalibration.test.ts`：炮弹伤害断言 12→6；近距距离从 0 改为 50（距离 0 时子弹从炮口生成后越过靶子，无法命中，是退化场景）
- `tests/levelUp.test.ts`：炮弹伤害断言 12→6 和 12×1.1→6×1.1

### 5.7 验证结果

- `npx tsc --noEmit`：通过
- `npx vitest run`：82 passed / 4 failed（4 个失败均为 `remoteview-net-id.test.ts` 中 `ctx.ellipse is not a function` 的预存测试环境限制，与本轮改动无关）
- `npm run build`：通过，产物 349KB / gzip 111KB

### 跨引擎检查清单补充（Cocos / Unity）

#### 平衡性类
- [ ] 掉落物存活时间是否为 60s？
- [ ] 敌人模块掉率倍率是否为 0.2（原 0.8 再减 75%）？
- [ ] 初始主炮伤害是否为 6（原 12 的一半）？
- [ ] 狙击弹伤害是否为 40（原 20 的两倍）？
- [ ] 单发武器是否允许最多 2 发同时飞行？
- [ ] 每发子弹是否按模块消耗 usesLeft？

#### 升级系统类
- [ ] 升级选项中是否不含物品模块（随机蓝色模块等）？
- [ ] 升级选项中是否不含武器槽扩展（炮筒+1格）？
- [ ] 升级选项中是否不含背包格扩展？
- [ ] 所有升级属性是否直接加到坦克（critChance/projSpeedMult/extraSpeed/extraMaxHp 等），而非进入背包或武器槽？
- [ ] 物品模块是否仅来自敌人掉落和基地商店？

---

## 第六轮：血量提升 + 模块系统独立结算与触发链改造

### 6.1 玩家坦克初始血量 3→10

**问题**：3 血太少，一次被击中就死，游戏体验差。

**方案**：所有玩家坦克配置（轻型/重装/狙击/工程师）初始 HP 从 3 提升到 10。

**涉及文件**：
- `src/game/Tank.ts`：`TANK_CONFIGS` 全部 hp:3→10
- `src/framework/NumericConfig.ts`：`TANK_TYPES` 全部 hp:3→10

**注意**：敌人血量不变，仍由 Enemy 配置控制。升级系统的 `df_hp`(+1)/`df_hp2`(+2) 增量不变。

### 6.2 同类型模块独立结算单发上限

**问题**：原单发限制（singleShot）按整根炮筒统计在飞弹数，同一炮筒装 2 个炮弹模块时，第一个模块的子弹在飞就会阻止第二个模块发射。用户要求"带2个同样模块，会按独立模块实现效果"。

**根因**：`WandSystem.update()` 顶层用 `this.projectiles.some(p => p.sourceWandId === wand.config.id)` 统计整根炮筒的在飞弹数，不区分模块槽位。

**方案**：
- 移除顶层单发检查，改为在 sweep 循环中遇到每个 `category === "projectile"` 模块时，按 `sourceSlotIdx` 统计该槽位的在飞弹数
- 每个槽位独立上限 2 发（与上一轮双发上限一致）
- 发射时给投射体打上 `sourceSlotIdx` 标记
- 某槽位被阻挡时 `continue` 跳过该模块（不消耗次数），cursor 继续前进到下一槽位
- 全部可发射槽位都被阻挡时，设置 `castTimer = SINGLE_SHOT_RELOAD`（0.2s）

**示例**：槽位0=炮弹、槽位1=炮弹、槽位2=狙击、槽位3=无人机
- 按一下：发射槽位0炮弹（cursor→1）
- 再按：发射槽位1炮弹（槽位0的弹仍在飞，但槽位1独立结算，0<2允许，cursor→2）
- 再按：发射槽位2狙击（cursor→3）
- 再按：触发槽位3无人机

**涉及文件**：
- `src/systems/wand/WandTypes.ts`：`Projectile` 新增 `sourceSlotIdx?: number`
- `src/systems/wand/WandSystem.ts`：移除顶层单发检查，sweep 内按槽位检查，发射时标记 sourceSlotIdx

### 6.3 辅助触发模块按触发次数消耗 + 击中位置链式发射

**问题**：
1. 触发模块（命中触发/销毁触发/定时触发等）原来 `maxUses: -1`（无限次），且在开火时就消耗次数（实际未触发也消耗）
2. 用户要求"辅助模块也是按触发次数消耗的，可以每个150次，触发一次降低一次"
3. 用户要求触发链式发射：[炮弹, 命中触发, 散弹] → 开火一次发射炮弹，炮弹命中时在命中位置触发散弹

**当前状态**：触发链式发射已存在（`triggerPayload` 机制 + `spawnTriggerPayload` 在事件位置生成载荷投射体），但触发模块消耗逻辑不对。

**方案**：
- 所有触发模块 `maxUses` 从 -1 改为 150
- sweep 中遇到 `category === "trigger"` 模块时**不消耗次数**（只在开火时挂载到上一发投射体上）
- `TriggerPayload` 新增 `triggerSourceSlot` 字段，记录触发模块所在槽位
- `CombatSystem.fireTrigger()` 回调新增 `sourceWandId` 参数
- `GameModeCore.onTriggerFire` 回调中：按 `ownerId` 找坦克 → 按 `sourceWandId` 找炮筒 → 按 `triggerSourceSlot` 找触发模块 → 消耗 1 次（耗尽则移除）
- 触发位置：`spawnTriggerPayload(x, y, ...)` 已在事件位置（命中点/销毁点/计时点）生成，向四周随机散射

**涉及文件**：
- `src/systems/wand/WandTypes.ts`：`TriggerPayload` 新增 `triggerSourceSlot?: number`
- `src/systems/wand/ModuleRegistry.ts`：6 个触发模块 maxUses -1→150，描述更新
- `src/systems/wand/WandSystem.ts`：触发模块不消耗、挂载时记录 triggerSourceSlot
- `src/systems/combat/CombatSystem.ts`：`fireTrigger` 传递 `sourceWandId`，`onTriggerFire` 类型签名更新
- `src/framework/GameModeCore.ts`：回调中消耗触发模块次数

### 6.4 测试适配

**涉及文件**：
- `tests/wandSingleShot.test.ts`：完全重写为 v2.19 按槽位独立结算测试，含单模块2发上限、双模块交替发射、非单发不受限
- `tests/levelUp.test.ts`：初始 HP 断言 3→10，升级后 HP 断言同步更新

### 6.5 验证结果

- `npx tsc --noEmit`：通过
- `npx vitest run`：83 passed / 4 failed（4 个均为 `remoteview-net-id.test.ts` 预存 `ctx.ellipse` 环境限制）
- `npm run build`：通过

### 跨引擎检查清单补充（Cocos / Unity）

#### 模块系统类
- [ ] 单发限制是否按模块槽位独立结算（而非整根炮筒统一统计）？
- [ ] 每个投射体模块是否独立标记来源槽位（sourceSlotIdx 等价物）？
- [ ] 同类型多模块是否可交替发射（各自独立在飞弹数上限）？
- [ ] 触发模块是否按触发次数消耗（而非开火时消耗）？
- [ ] 触发模块是否有有限次数（如150次）而非无限？
- [ ] 触发链式发射是否在事件位置（命中点/销毁点）生成载荷投射体？
- [ ] 触发载荷是否向四周散射（Noita 风格）？

#### 数值类
- [ ] 玩家坦克初始血量是否为 10？
- [ ] 敌人血量是否保持不变（不随玩家血量变化）？

---

## 第七轮：数值重平衡 + 出怪骰子制 + 全玩家结算 + 手机端交互完善（v2.25）

### 7.1 武器伤害与敌人血量重平衡

**问题**：初始武器火力过强/敌人血量错位——最弱的 F 级坦克应有 5 血（1 发炮弹击杀），但实际配置成 12 血。

**根因**：运行时使用 `src/game/Enemy.ts` 的 `HP_TIERS` 数组（F 级取 index 0 = 12），而此前只修改了 `NumericConfig.ts` 的副本，两个文件不一致。

**方案**：
- `Enemy.ts` `HP_TIERS` 修正为 `[5, 12, 35, 55, 80, 120, ...]`：F=5（1 发炮死）、C=12（2 发炮）、B=55、A=120、S=400、BOSS=15000，其余档位数值不变
- 武器伤害统一：CANNON=5、机枪(PEW)=1、SNIPER=20、SPREAD=1×7、GATLING=1×8
- 玩家坦克初始 HP=10、armor=0（上一轮已改）

**涉及文件**：`src/game/Enemy.ts`、`src/framework/NumericConfig.ts`、`src/systems/wand/ModuleRegistry.ts`

### 7.2 地形伤害阈值

**方案**：地形增加"伤害阈值"，低于阈值不产生任何伤害（不闪白、不掉血）：
- 砖墙 2 / 岩石 25 / 钢板 100 / 山体 250 / 地图墙 999
- 基地砖块无论是否被打碎，一律拦截子弹（不再穿透）

**涉及文件**：`src/game/Tilemap.ts`、`src/systems/combat/CombatSystem.ts`

### 7.3 墙体放置：2 秒成形 + 推开保护

**问题**：玩家在放置点会被自己放的墙卡住/挤伤；墙体立即成形不合理。

**方案**：
- 玩家墙体（Q 键技能）与临时墙放置后进入"未成形"集合（`wallUnarmed`），碰撞检测跳过
- 玩家必须离开碰撞区后才开始 2 秒倒计时（`WALL_ARM_DELAY=2.0`；仍在区内则计时重置）
- 成形瞬间如与玩家/敌人重叠 → 沿最近轴把坦克向外推开
- 基地砖块重建同理：未成形期间不碰，成形时把玩家往远离基地中心的方向推出（而不是往里推）
- spec_wall 次数 5→3（墙体难以击碎，控制存量）

**涉及文件**：`src/game/Tilemap.ts`（wallUnarmed/wallArmTimers/updateWallArming/getSolidTeamWallRects）、`src/framework/GameModeCore.ts`（推挤循环）

### 7.4 基地修复小人：靠近即可救援

**方案**：小人阵亡后墓碑不再长期无法救援——任何存活玩家靠近 60px 内即缓慢积累救援进度（6 秒救活，无需按键，免费）；同时保留"自动复活"倒计时与进度条显示。

**涉及文件**：`src/systems/base/BaseRepairSystem.ts`

### 7.5 链式闪电修正

**方案**：
- 发射后 0.5 秒内发射者自身免伤（可跑出闪电链范围，防自杀）
- 消失条件修复：本体死亡 / 无下一目标 / 已命中全部目标 时立即销毁

**涉及文件**：`src/game/Tank.ts`（chainImmuneTimer）、`src/systems/combat/CombatSystem.ts`

### 7.6 触发模块掉落与"开火触发"

**问题**：触发类模块（命中/销毁/定时/延迟等）没有实际掉落来源。

**方案**：
- 各档敌人辅助模块掉落池（`GRADE_AUX_EXTRA`）加入触发模块：F 起有命中触发，C 加销毁触发，B 加定时/延迟，A/S/BOSS 全量
- 新增"开火触发"（`trig_on_fire`）：开火瞬间即触发载荷，无需命中
- 仓库合成池自动包含上述新模块

**涉及文件**：`src/systems/loot/LootSystem.ts`、`src/systems/wand/ModuleRegistry.ts`、`src/systems/wand/WandTypes.ts`、`src/systems/combat/CombatSystem.ts`

### 7.7 模块数值调整

- 飞速模块 +80%→+30%（子弹速度加成过强，变相大幅提升火力）；新增蓝色"飞速+50%"、金色"飞速·金+70%"作为升级路径
- 冷却缩减模块现在对单发装填（炮弹类）生效：被阻挡时的装填时间按冷却倍率缩放

**涉及文件**：`src/systems/wand/ModuleRegistry.ts`、`src/systems/wand/WandSystem.ts`、`src/systems/wand/WandTypes.ts`

### 7.8 升级池修正

- 移除炮筒专属伤害升级（1/2/3/4 号炮筒，多数情况是废选项）
- 新增：全伤害+10%、穿甲+10%、拾取范围+25%
- 描述歧义修正：放墙升级 → "墙体放置"（声明为玩家自身技能、Q 键，非道具）；`sp_repair` → "基地修复增速"
- **sp_loot 逻辑修复**：原"5% 模块盗取"直接发一个模块（逻辑不对），改为"模块掉落+50%"被动——击杀者模块掉落概率倍率提升，可叠加（同步接入联网检查点）

**涉及文件**：`src/systems/levelup/LevelUpSystem.ts`、`src/game/Tank.ts`（moduleDropMult）、`src/systems/loot/LootSystem.ts`、`src/framework/GameModeCore.ts`、`src/net/NetTypes.ts`、`src/modes/OnlineHostMode.ts`

### 7.9 出怪系统：隐藏难度分 + 骰子制（连续模式）

**问题**：前期满屏都是 1 级小坦克；难度提高后也未按比例折算成高级坦克，质量转化机制缺失。

**方案**（隐藏分消耗制，平滑曲线）：
- 隐藏难度分 `hiddenScore` 随时间/击杀增长（`B/30` 每秒 × 场上敌人减压因子 × 玩家数缩放），**被出怪消耗**：出的多/出的强 → 下一秒可能分不够 → 自然回落
- 每秒摇一次骰子：
  1. 掷数量（1~5，随难度上限提高）
  2. 每个单位掷质量骰：有转化率 `conv`（15%→70%，5 分钟拉满）升为 C/B/A，否则 F
  3. 按隐藏分购买：能转化多少转化多少（不够则降级到负担得起的最高档）；一分都买不起 → 本轮空过
  4. 扣除已消耗积分
- 积分成本（用户定值）：F=1 分 / C=5 分 / B=15 分 / A=45 分
- S/BOSS 仍为免费精英事件（不占隐藏分，带唯一/冷却限制）
- 效果：开局≈5 个 F 级小坦克；难度上升后既有数量、又有质量（B/A 占比提高），总量比旧版略降

**涉及文件**：`src/systems/spawn/SpawnSystem.ts`、`src/framework/NumericConfig.ts`

### 7.10 UI / 交互

- **得分移除**：全端（无尽/闯关/联机主机/成员端/结算）移除"总分/得分"显示，经验（EXP）改为大号金黄色醒目字体
- **血量显示**：血条 6px 颜色分级（绿/黄/红）+ 数值 `hp/maxHp`
- **侧边栏炮筒页签**：4 个可点击炮筒按钮（手机端点击切换）+ "Tab键/点击切换"提示；模块区标注所属炮筒号（如"炮筒2 模块"）
- **当前数值显示**：伤害/移速/血/经验 数值直接显示在面板上
- **本地双人**：左侧 P1 面板 + 右侧 P2 面板（各占完整宽度）；地图上的武器切换 UI 移除（移入侧栏，不再遮挡地图）；武器槽改为每行 4 格
- **手机端**：4 个独立炮筒切换按钮；触屏→自动显示虚拟按键，检测到键盘 WASD 输入→自动隐藏并切回键盘（双向动态）；本地双人键盘模式禁用虚拟按键（联机保留）
- 暂停按钮固定左下角；提交模块按钮加大（220×40）+ 支持 G 键快捷提交；背包 30 格自动堆叠
- **结算界面**：所有人类玩家（P1/P2/P3/P4）均有独立结算区（编号/生命/经验/等级/击杀/伤害/背包摘要）+ 返回大厅/房间内准备操作；AI 队友不生成结算

**涉及文件**：`src/ui/SideInfoPanel.ts`、`src/ui/BackpackPanel.ts`、`src/ui/RemoteView.ts`、`src/engine/MobileControls.ts`、`src/engine/InputManager.ts`、`src/framework/GameModeCore.ts`、`src/modes/*.ts`、`src/main.ts`

### 7.11 验证结果

- `npx tsc --noEmit`：通过（TSC_EXIT:0）
- 无新增测试失败（触发/掉落相关逻辑无测试用例引用）

### 跨引擎检查清单补充（Cocos / Unity）

#### 出怪系统类
- [ ] 难度分是否为"消耗制"（出怪扣分 → 动态回落），而非只增不减的固定预算？
- [ ] 是否每秒摇骰：数量骰 + 质量骰（转化率随难度提升）？
- [ ] 积分不够时是否"能转化多少转化多少"而不是直接放弃？
- [ ] 最弱敌人是否 5 血（1 发基础炮弹击杀）、次级 12 血？
- [ ] 高级坦克出现占比是否随难度平滑上升？

#### 墙体/放置类
- [ ] 放置墙体是否有 2 秒"未成形"保护期（玩家离开碰撞区后才计时）？
- [ ] 成形瞬间是否将重叠单位向外推开？
- [ ] 基地砖块重建时是否将玩家往远离基地中心方向推出？

#### 交互类
- [ ] 手机端是否有独立炮筒切换按钮（非键盘 Tab）？
- [ ] 触屏/键盘输入是否能双向动态切换虚拟按键显示？
- [ ] 结算界面是否覆盖所有人类玩家（含 P2/P3/P4），且含返回大厅操作？

---

## 第八轮：暴击系统 + 黑洞修复 + 升级发放审计（v2.26）

### 8.1 升级发放审计：只给属性点，绝不发放模块/道具

**问题**：玩家反馈"升级选项说掠夺模块，实际直接给了一个模块"，且要求明确：升级只能给属性增强（暴击率/装甲/生命/复活次数等），白色、蓝色模块只能打怪掉落，不能从升级/基地发放。

**根因**：`sp_loot`（5%模块盗取）实现为"击杀时 5% 概率直接把敌人模块塞进背包"（GameModeCore 击杀处理里的偷取分支），既与描述不符（说掉落率、实为直接给），又违反"升级不给模块"原则。

**方案**：
- `sp_loot` 重做：名称"模块掉落+50%"，实现为 `Tank.moduleDropMult *= 1.5`（可叠加），击杀时把倍率传给 `LootSystem.onEnemyKilled`，模块掉落率 = 基础掉率 × 0.2 × 掉落倍率（辅助模块组随之提高）。
- 删除击杀"直接偷取模块"分支；`hasModuleSteal` 标记废弃（保留字段兼容联机检查点）。
- 新增 `df_lives`：复活次数+1（防御系属性点）。
- 审计结论：全工程 `addModule` 调用点仅剩"掉落拾取 / 仓库取出 / 仓库合成 / 网络恢复"——升级链路确认无任何发放路径。

**涉及文件**：`src/systems/levelup/LevelUpSystem.ts`、`src/game/Tank.ts`、`src/systems/loot/LootSystem.ts`、`src/framework/GameModeCore.ts`、`src/net/NetTypes.ts`、`src/modes/OnlineHostMode.ts`

### 8.2 暴击系统（初始 0% / 200%）

**问题**：需求——玩家初始暴击率 0%、暴击伤害 200%（两倍）；提供暴击率/暴击伤害的升级与模块；模块掉落统一进掉落组管理。

**方案**：
- 初始值：`Tank.critChance = 0`；新增 `Tank.critMultiplier = 2.0`（此前默认为 10%、倍率写死 ×2）。
- 升级（属性点）：`fp_crit`（暴击率+5%）、`fp_crit_rate2`（+10%）、`fp_crit_dmg`（暴伤+25%）、`fp_crit_dmg2`（暴伤+50%）。
- 模块（打怪掉落）：`mod_crit_up`（白·暴击率+5%）、`mod_crit_up2`（蓝·暴击率+10%）、`mod_critdmg`（蓝·暴伤+50%）；写入辅助模块组 `GRADE_AUX_EXTRA`（F→C→B→A/S/BOSS 渐进出现），并自动进入仓库合成池（3白→1蓝、3蓝+精华→1金）。
- 结算：暴击率 = 射手属性 + 投射体模块加成（封顶 100%）；暴击伤害 = 射手倍率 + 模块加成；暴击伤害数字金色显示（沿用）。
- 联机：检查点新增 `critMultiplier` 同步（主机接替续局不丢该属性）。

**涉及文件**：`src/game/Tank.ts`、`src/systems/levelup/LevelUpSystem.ts`、`src/systems/wand/WandTypes.ts`、`src/systems/wand/ModuleRegistry.ts`、`src/systems/wand/WandSystem.ts`、`src/systems/combat/CombatSystem.ts`、`src/systems/loot/LootSystem.ts`、`src/framework/NumericConfig.ts`、`src/net/NetTypes.ts`、`src/modes/OnlineHostMode.ts`

### 8.3 黑洞弹修复（发射不出 + 中心伤害缺失）

**问题**：黑洞弹实际发射不出来；且应具备吸附与伤害——被牵引时不受伤、被吸到中心才受伤；范围约 1/8 屏（非全屏），玩家放出去后离得远不被牵拉。

**根因**：黑洞飞行中每帧减速（×0.97 → ×0.9），速度趋近 0 后 `distanceTraveled` 永远到不了射程 400 → **永不消失**；而"每名玩家仅 1 个活跃黑洞"的限制因此被永久占满 → 后续施放全部被拦（表现为"发射不出来"）。同时 CombatSystem 对黑洞只做吸附、无任何伤害，爆炸也因永不死亡而从不触发。

**方案**：
- 锚定机制：速度降至 30px/s 以内 → 停止移动、标记 `anchored`、启动存活倒计时（普通 6s / 金色 8s）；锚定期间不再累计射程、不受"射程/移出地图"规则驱动，完全交给 CombatSystem 计时。
- 吸附：半径 160px（≈1/8 屏幕面积），牵引力随距离衰减；敌方黑洞吸玩家力度为 1/3；**牵引过程中不受伤**。
- 中心伤害：半径 30px（被吸到中心）内每 0.5s 一跳：`damage × 15%`（玩家受 1/3），可走位挣扎逃脱；伤害纳入击杀统计与伤害数字。
- 结束爆炸：倒计时归零 → 在黑洞位置触发 AOE 爆炸（沿用爆炸半径/伤害）→ 弹体死亡，释放活跃数量限制。
- 清理：弹体销毁时同步清理中心伤害跳表（防内存泄漏）。

**涉及文件**：`src/systems/wand/WandSystem.ts`、`src/systems/combat/CombatSystem.ts`、`src/systems/wand/WandTypes.ts`、`src/systems/wand/ModuleRegistry.ts`

### 8.4 商店刷新周期指示器（基地小人头顶 + 交互面板）

**问题**：玩家攒经验等商店补货，却不知道何时刷新（原面板仅有静态"60s 自动刷新"文案）。

**方案**：
- `BaseShop` 新增只读 `refreshRemaining`（距下次刷新的剩余秒数）。
- 基地修复小人头顶实时显示 `商店刷新 Xs`（每帧更新，走相机世界坐标）。
- 商店交互面板底部改为动态 `刷新倒计时 Xs · 1件2折·1件5折·原价 · 点基地或按E开关`。

**涉及文件**：`src/systems/base/BaseShop.ts`、`src/framework/GameModeCore.ts`

### 8.5 验证结果

- `npx tsc --noEmit`：通过（TSC_OK）
- 升级发放审计：`addModule` 调用点仅为掉落拾取/仓库取出/合成/网络恢复，升级面板无发放路径
- 数值口径：`Enemy.ts` 与 `NumericConfig.ts` 的 `HP_TIERS` 已一致（F=5 / C=12 起）

### 跨引擎检查清单补充（Cocos / Unity）

#### 暴击/模块类
- [ ] 初始暴击率是否 0%、暴击伤害 200%？
- [ ] 暴击率/暴击伤害是否同时有"升级属性点"与"掉落模块"两条来源，且命中时相加结算？
- [ ] 升级面板是否绝不发放模块/道具？模块是否只从敌人掉落进入背包？

#### 大招/黑洞类
- [ ] 黑洞是否有有限存活时间（锚定+倒计时+爆炸），而不是减速后永久存留？
- [ ] "同时存在数量限制"是否会被永不消失的弹体卡死？
- [ ] 吸附范围是否有限（≈1/8 屏）且远离者可逃脱？牵引中不受伤、仅中心受伤？

---

## 第九轮：敌军阶梯扩展 + 骰子消耗制 + 沙漏可视化 + 追踪/环绕修复（v2.27–v2.28）

### 9.1 敌军档位扩展至 9 档（用户指定血量阶梯）

**问题**：玩家反馈"超过10分钟只见 12血 与 400血，中间 50/150 档缺失；再高还应有 1000/3000/5000/1万血"，且历史上 F 级被错误设计为 12 血（应为 5 血）。

**根因**：`Enemy.ts` 的 `HP_TIERS` 仍是旧表（F=12），且档位只有 F/C/B/A/S/BOSS 六档；F=12 使"最弱小坦克一发打不死"。

**方案**：
- `HP_TIERS` 重排为 `[5, 12, 50, 150, 400, 1000, 3000, 5000, 10000, 15000]`；F=5（炮弹5伤一发带走）、C=12（两发）。
- 新增 `S2/S3/S4/S5` 四档（1000/3000/5000/1万血）：护甲 70/100/140/190、速度 24/20/16/12、施法间隔 0.8/0.7/0.6/0.5、金币/经验与掉落梯度同步。
- **伤害随档位成长**（血量之外的第二维）：`GRADE_DAMAGE_MULT = F:0.8 → S5:2.5，BOSS:2.8`；防御沿用 `GRADE_ARMOR`。
- `NumericConfig.ts` 全档位 Record（HP_TIERS / GRADE_ARMOR / GRADE_HP_TIER / GRADE_SPEED / GRADE_CAST_DELAY / GRADE_MODULE_DROP_CHANCE / GRADE_GOLD_REWARD / GRADE_EXP_REWARD / GRADE_WIDTH / TRAD_ITEM_DROP_BY_GRADE）同步补键。

**涉及文件**：`src/game/Enemy.ts`、`src/framework/NumericConfig.ts`

### 9.2 骰子消耗制出怪（每秒一颗骰子，积分池消耗）

**问题**：需求——隐藏难度分转化为"怪物生成分"，每秒摇一次骰子决定消耗多少分生成怪物（积分不够则"没出现成功"）；质量随难度平滑上升，总量略降、档位差异拉大。

**方案**：
- **隐藏分收入**：`B/10` 每秒（B=50 → 5分/秒），保留场上敌人越多增速越慢的减压系数 pressure。
- **消耗骰**：每 1.0s 掷一次 → 80% 落平铺区（消耗 1~50 点）、20% 落百分比区（消耗积分池的 1%~100%，可触发"boss 级"爆发）。
- **购买单元**：每辆先掷质量骰（conv 随难度 18%→80%，升档后按"已解锁档位"高斯阶梯抽样 C/B/A/S/S2…），买不起沿阶梯降级 → "能转化多少转化多少"；单次最多 8 辆（防 50 点全出小坦克）。
- **成本表**：F1 / C5 / B15 / A45 / S135 / S2:320 / S3:850 / S4:2100 / S5:5200，且随难度溢价 ×(1+难度×0.35)；门槛 TIER_GATE：B8/A18/S32/S2:55/S3:80/S4:110/S5:140。
- **精英事件**：免费 S 档事件随难度逐级升档（S→S2→S3→S4→S5），BOSS 仍为高难唯一+45s 冷却。

**涉及文件**：`src/systems/spawn/SpawnSystem.ts`、`src/framework/NumericConfig.ts`

### 9.3 敌方随机武器 + "掉落所用武器"

**问题**：除最基础两种外，敌人应随机武器；Boss 级（血量≥400）死亡应额外概率掉落"它使用的武器"。

**方案**：
- F/C 保持默认单发武器；B 及以上在生成时从分档武器池随机（T2/T3/T4，T4 含金弹）+ 随机修饰池（T2/T3/T4），高阶概率出双武器。
- BOSS 保留 30% 黑洞特性 + 随机金武器。
- **额外武器掉落**：S/S2/S3/S4/S5（血量≥400）击杀额外 35% 概率掉落一件"实际装配的武器"（从该敌人炮筒实际模块中抽取），不影响常规掉落；BOSS 走专属掉落通道。

**涉及文件**：`src/game/Enemy.ts`、`src/systems/loot/LootSystem.ts`

### 9.4 商店刷新沙漏可视化

**问题**：刷新不应只有数字，要有沙漏/环形图形，一眼看出"还差多少"。

**方案**：
- 基地小人头顶：沙漏图形（上沙随剩余比例下落、下沙堆积，金色沙粒）+ 数字倒计时。
- 商店交互面板底部：金色进度条（`refreshFraction`，随时间流逝缩短）+ 动态倒计时文案。

**涉及文件**：`src/framework/GameModeCore.ts`、`src/systems/base/BaseShop.ts`

### 9.5 追踪模块失效修复（修饰器位于投射体之后不生效）

**问题**：玩家反馈轻度/中度/强力追踪均无效果，甚至"伤害+X%"也无变化。

**根因**：扫掠装配中，若修饰器模块排在投射体之后，本轮 sweep 回卷时**直接 break**（不继续收集），修饰器累积值每次重置 → 弹后修饰器永远不生效。

**方案**：
- 回卷逻辑：新增 `collectedMods` / `wrappedThisSweep` —— 已收集到修饰器时回卷继续收集一次（防死循环），仅在整圈无修饰器且已发射时结束。
- 数值提升：轻度追踪 0.35、**新增中度追踪 0.6（蓝）**、强力追踪 1.0（无限）；掉落池按档位补齐（中度进 B/A，强力 S+）。

**涉及文件**：`src/systems/wand/WandSystem.ts`、`src/systems/wand/ModuleRegistry.ts`、`src/systems/loot/LootSystem.ts`

### 9.6 半月环绕 + 触发式地雷修正

**方案**：
- 半月环绕：补上缺失的轨道运动——围绕施放者旋转（半径 60、180°/s、持续 6s），接触敌人持续斩击（0.45s 冷却/目标），可暴击。
- 触发式地雷：改为**永久埋放**，真实接触（雷半径+10 与坦克半宽）才引爆，同队不触发；不被踩不消失。

**涉及文件**：`src/systems/wand/WandSystem.ts`、`src/systems/combat/CombatSystem.ts`、`src/systems/wand/ModuleRegistry.ts`

### 9.7 暴击数值上调 + 升级单次数值随机化（v2.28）

**方案**：
- 暴击率来源：模块 8% / 15% / 金 25%；升级 5~8%（进阶 6~8%）。
- 升级单次数值随机：伤害 +5~10%、暴击伤害 +5~12%（进阶 10~20%）、护甲 +2~5（进阶 3~5）——每次升级在区间内随机，避免每局成长完全一致。
- 辅助模块组同步加入金暴击率（S2+ 专属）与中度追踪。

**涉及文件**：`src/systems/levelup/LevelUpSystem.ts`、`src/systems/wand/ModuleRegistry.ts`、`src/systems/loot/LootSystem.ts`

### 9.8 验证结果

- `npx tsc --noEmit`：通过（TSC_OK，含 v2.27 + v2.28 全部改动）
- 升级发放审计复核：`addModule` 调用点 = 卸装回背包 / 商店购买 / 掉落拾取——升级面板只给属性点（确认无发放）
- 出怪参数：HP 阶梯、成本表、门槛表、骰子区间均在上文列出，便于后续调参

### 跨引擎检查清单补充（Cocos / Unity）

#### 出怪系统类
- [ ] 是否存在"隐藏难度分"并每秒摇骰消耗（80% 平铺 1~50 / 20% 百分比 1~100%池）？
- [ ] 购买是否支持"质量骰 + 降级购买（能转化多少转化多少）"与单次数量上限？
- [ ] 高难档位是否有解锁门槛（B 8 / A 18 / S 32 / S2+ 55+）与难度溢价？

#### 敌人成长类
- [ ] 敌人是否血量、伤害、防御三维随档位成长（非只有血量）？
- [ ] 基础两档是否默认武器，其余是否随机武器池？Boss 级击杀是否有 35% 额外武器掉落？

#### 模块/修饰器类
- [ ] 修饰器累积是否与模块排列顺序无关（弹前/弹后都生效）？
- [ ] 环绕类弹体是否有轨道运动实现（而非静止＋超时消失）？
- [ ] 地雷是否永久埋放、接触才引爆、同队不触发？

---

## 第十轮：出怪经济修正 —— 全部扣分 + 积分池可累积 + BOSS 事件化（v2.29）

### 10.1 问题描述

玩家实测：15000 血 BOSS 几分钟就出现；打完一个 BOSS 立马又出下一个，根本没法打；且小怪大怪都很多。玩家怀疑"出怪没有扣除怪物积分"。

### 10.2 根因分析（三处）

1. **免费精英事件**：`trySpawnElite` 将 S/S2/S3/S4/S5/BOSS 作为"免费事件"刷新——**完全不扣隐藏分**；其中 BOSS 在难度值 `B>90`（约 6-7 分钟）即开始每秒掷骰，冷却仅 45s → 几分钟出 15000 血 BOSS、且可以连出。
2. **骰子消耗被强制截断**：`spend = Math.min(spend, hiddenScore)` —— 每秒把积分池**抽干**，池子永远攒不到大额积分数 → 骰子只能买到便宜怪（"小的很多"）；高阶怪全部来自免费事件（"大的也多"）。
3. **解锁门槛过低**：S2-S5 门槛 55/80/110/140，约 10 分钟全部解锁，质量曲线失控。

### 10.3 修改方案

- **移除免费精英事件**：删除 `trySpawnElite`（及 `eliteTimer`）；所有档位（含 S/S2..S5/BOSS）一律走骰子消耗制、**一律扣分**。
- **积分不够 = "没出现成功"**：取消 `min()` 截断——池子不足时不出怪、不扣分 → **积分池可跨秒累积**（攒出高级怪）。
- **BOSS 事件化**：仅在百分比区大额消耗（消耗 ≥350 分）时可能触发，额外要求：难度 B≥600、场上唯一、180s 冷却；触发时**消耗近整池积分**（扣分后自动回落，杜绝连出）。
- **门槛上调**：S2 150 / S3 280 / S4 420 / S5 600（拉开解锁节奏）。
- **成本调整**：S2 300 / S3 700 / S4 1600 / S5 3500（随难度溢价 ×(1+难度×0.35) 保留）。
- **增长曲线**：`B = 10 + 时间×0.35 + 击杀×0.10`（10 分钟→约 220、20 分钟→约 430，击杀加速）。

### 10.4 预期节奏（供实测对照）

- 10 分钟前后：开始出现 A/S（150/400 血）
- 15-20 分钟：S2（1000 血）可见
- 25 分钟+：S3（3000 血）
- 更后期：S4/S5（5000/1 万血）
- BOSS：高难度 + 大额消耗事件（约 20 分钟起），且不再连出

### 10.5 涉及文件

`src/systems/spawn/SpawnSystem.ts`、`src/framework/NumericConfig.ts`

### 10.6 验证结果

- `npx tsc --noEmit`：通过（TSC_OK）
- 出怪链路复核：`update()` 连续模式仅剩骰子一条产出路径；`trySpawnDice` 内所有购买分支均 `hiddenScore -= spent`；BOSS 分支 `hiddenScore -= spend` —— 无任何免费产出路径

### 跨引擎检查清单补充（Cocos / Unity）

#### 出怪经济类
- [ ] 是否所有档位（含精英/BOSS）产出都从积分池扣除，无免费事件后门？
- [ ] 积分不足时是否"不出怪"而非"抽干池子"（池子可累积）？
- [ ] BOSS 是否为大额消耗事件（近整池 + 高门槛 + 唯一 + 长冷却），而非定时免费刷新？

---

## 第十一轮：隐藏分 HUD + 联机/单机显示对齐 + 出怪节奏加快（v2.30）

### 11.1 问题描述
1. 隐藏分（出怪积分池）无 UI 显示，玩家无法感知积累与消耗。
2. 通过"联网模式开单人"进入时顶部 HUD 大量缺失（无剩余/难度/隐藏分/仓库）：与单机无尽顶栏不一致 → 同一模式因入口不同 UI 不同。用户强调：联网与单机机制应完全相同，仅"面板布局"随本地玩家数变化（本地双人 = 左右两套面板），机制不变。
3. 节奏偏慢：5 分钟见不到 S 级（400血），20 分钟见不到 S3（3000血）。

### 11.2 根因分析
- OnlineHostMode.render 与 EndlessMode.renderHUD 是两套独立渲染实现（机制同源、显示各写各的）→ 联机主机端顶栏仅"波次+EXP+网络质量"。
- 出怪经济（v2.29）参数：B=10+0.35t+0.10kills，收入 B/10 分/秒；平铺骰（80%）平均消耗 25.5 分/秒持续抽水 → 5min 收入仅 11.5 分/秒，池均衡≈0-30 分，S(135×溢价) 不可达；20min 池均衡≈224 分，S2(405)/S3(945) 不可达。
- 难度因子 diff2 分母 130 过小（B=150 即满档），与新版曲线不匹配。

### 11.3 修改方案
- **隐藏分显示**：SpawnSystem 新增 `get hiddenScoreDisplay()`；EndlessMode / OnlineHostMode / RemoteView（成员端）顶栏均显示 `隐藏分 N`（#b9f 紫色）。
- **HUD 对齐**：OnlineHostMode.render 顶栏重写为与 EndlessMode.renderHUD 同构（波次 / P1·P2 EXP / 剩余 / 难度 / 隐藏分 / 仓库，横竖屏同一坐标），"联机·主机"标签移至第二行网络质量栏（RTT@150、P2入@300）；RemoteView.renderHUD 同步（成员标签移至第二行、RTT@150、加难度/隐藏分）。
- **网络同步**：快照 scope 增加 `diff`/`hidden`；SnapshotDelta.scopeEqual 纳入比较（防"值变不推送"）。
- **节奏加快**：B=10+1.25t+0.22kills（5min→385 / 10min→760 / 20min→1510）；diff2=(B-20)/500；TIER_GATE S2 420 / S3 900 / S4 1500 / S5 2200；BOSS_DICE_GATE 1800。锚点：5min 见 S(400血)、20min 见 S3(3000血)。

### 11.4 预期节奏对照表（待实测校准）
| 时间 | B(每30s产出) | 收入/秒 | 池均衡 | 可购最高档 |
|------|------|------|------|------|
| 0-2min | 10-160 | 1-16 | 0-60 | F/C 为主 |
| 5min | 385 | 38 | ≈180 | S ✓ |
| 12min | 910 | 91 | ≈700 | S2/S3 |
| 20min | 1510 | 151 | ≈1290 | S3 ✓（S4 门槛 1500 临近） |
| 24min+ | 1810+ | 181+ | ≈1600+ | BOSS 事件可能触发 |

### 11.5 涉及文件
- src/systems/spawn/SpawnSystem.ts（budget 系数 / diff2 / TIER_GATE / BOSS_DICE_GATE / hiddenScoreDisplay）
- src/framework/NumericConfig.ts（BUDGET 常量与 TIER_COST 注释对齐）
- src/modes/EndlessMode.ts（顶栏隐藏分）
- src/modes/OnlineHostMode.ts（顶栏重写 + scope diff/hidden）
- src/ui/RemoteView.ts（成员端顶栏）
- src/net/NetTypes.ts（scope 类型扩展）
- src/net/SnapshotDelta.ts（scopeEqual 纳入 diff/hidden）

### 11.6 验证结果
- `npx tsc --noEmit` → **TSC_OK**（log: tsc_v230.log）
- 单机/联机顶栏现为同构布局；机制完全同源（同一 GameModeCore + SpawnSystem），仅面板布局随本地玩家数变化（本地双人 = P1 左面板 + P2 右面板）。

### 跨引擎检查清单补充
#### HUD/显示类
- [ ] 同一游戏模式是否只有一套 HUD 数据源（或同构渲染），入口（单机/联机）不影响显示内容？
- [ ] 积分池/隐藏资源是否有 UI 可视化，供玩家感知积累与消耗？
- [ ] 网络同步的新增字段是否纳入差分比较（避免"值变了但没推送"）？

---

## 第十二轮：联网成员操作修复 + 出怪难度机制重做（难度分/隐藏分/骰子）（v2.31）

### 12.1 问题描述
1. 联网模式下 2 号玩家无法正常切换炮筒：成员端面板没有炮筒入口、虚拟炮筒按钮高亮不跟随、切换后主机不生效。
2. 用户要求成员端"能看到自己的面板"（信息栏可见 + 可操作）。
3. 出怪机制定稿：不存在"击杀直接涨难度"；难度分为缓慢上升的隐藏机制，出怪消耗隐藏分形成平滑曲线。

### 12.2 根因分析
- **切换链路断点**：远端输入通过 `InputManager.setOverrideP2()` 合并（记为 gamepad 覆盖），合并代码用 `if (v)` 布尔化 —— `selectCannon = 0` 被当 falsy 丢弃（无法切到 1 号炮筒）；`selectCannon = 1~3` 被写成 `true`（宿主机解释为 1）→ 切炮失效/错位。
- **成员面板缺入口**：成员端信息栏走 `renderRemote` 路径，只画基础信息（HP/经验/背包摘要），无炮筒标签行，也没有对应命中区（zone）。
- 出怪：v2.30 旧参数与新定稿机制不一致（由另一 AI 并行完成 v2.31 重做，本 AI 完成联网侧修复 + 验证对齐）。

### 12.3 修改方案
- **InputManager 数值合并修复**（核心）：gamepad 合并改为 `v === true → true`；`typeof v === "number" && v >= 0 → 保留数值`（P1/P2 对称）。
- **成员端切炮闭环**：
  - `RemoteView`：新增 `pendingCannonSelect`（待上送）与 `myActiveCannon`（快照同步）；`tap()` 增加 `cannonTab` 分支；`remoteInfoSource` 透传 `activeCannon`。
  - `main.ts`：成员端发送块检测 `pendingCannonSelect` → 写入 `inp.selectCannon` 并**强制立即上送**（绕过节流）；渲染块同步 `MobileControls.activeCannon = remoteView.myActiveCannon`（虚拟按钮高亮跟随）。
  - `SideInfoPanel`：`RemoteInfoSource.players` 增加 `activeCannon`；新增 `drawCannonTabsRemote()`（4 个可点击标签 + zone kind `cannonTab`），竖栏/横条两种成员布局均插入。
- **出怪 v2.31（用户定稿）**：难度分从 1 起，按场上敌人数分档缓慢上涨（0只+2/秒 → ≤3+1 → ≤10+0.3 → ≤20+0.2 → >20+0.1）；隐藏分池 = 难度分 × 0.1 / 秒；每秒一颗骰子：①"出 boss 区间"（90s 后开启，上限 25%）把池子转成可负担的最高档 boss（S→S2→…→BOSS，扣分，剩余继续攒，转化冷却 15s）；②"普通区间"（80% 消耗 1~30 数字 / 20% 消耗 1%~30% 池子）按质量骰购买怪物（买不起降级，单次最多 6 辆）；池子不够 → "没出现失败"（不扣分、跨秒累积攒 boss）；击杀 Boss 级（S 及以上）→ 按其出 boss 分数的 1/5 加到难度分。

### 12.4 涉及文件
- src/engine/InputManager.ts（selectCannon 数值合并修复）
- src/ui/RemoteView.ts（pendingCannonSelect / myActiveCannon / tap / remoteInfoSource）
- src/main.ts（强制上送 selectCannon + 虚拟按钮高亮同步）
- src/ui/SideInfoPanel.ts（RemoteInfoSource.activeCannon + drawCannonTabsRemote + 两种布局插入）
- src/systems/spawn/SpawnSystem.ts（v2.31 难度分/隐藏分/骰子消耗制）
- src/framework/NumericConfig.ts（TIER_COST 注释同步）

### 12.5 验证结果
- `npx tsc --noEmit` → **TSC_OK**（tsc_v231.log / tsc_v232.log）
- 成员端切炮闭环：面板标签或虚拟按钮 → selectCannon 上送 → 主机 `setActiveCannon`；成员面板标签高亮与虚拟按钮高亮均随快照同步。
- 移动/开火链路本就打通（方向标志 + `fire → wFire[activeCannon]` 回退），本轮未改动。

### 跨引擎检查清单补充
#### 网络输入类
- [ ] 远端输入合并是否保留"数值型"字段（selectCannon = 0 不能被 falsy 丢弃）？
- [ ] 成员端 UI 的每个可交互区域是否都有对应 zone + 上送通道（点击 → 网络消息 → 主机执行）？

---

## 第十三轮：成员端难度/隐藏分显示修复 + 本地双端联机验证（v2.32）

### 13.1 问题描述
1. 联网模式（含"联网模式下开的单人房"）成员端顶栏与主机端不一致：缺少 `难度` 与 `隐藏分` 显示（"顶部很多东西都没显示"）。
2. 用户要求：隐藏分要显示到顶部；单机/联网机制与 UI 结构应一致（差异仅限"本地玩家数 → 面板套数"）。

### 13.2 根因分析
- 主机 `OnlineHostMode.buildSnapshot()` 已正确在 scope 携带 `diff/hidden`；
- 但成员端数据管道在**适配器层断链**：`net-sync-core/adapters/tank-adapter.ts` 两处显式字段拷贝丢字段——
  - `netSnapshotToState()`（成员 `RemoteView.setSnapshot` → `interp.push` 走此函数）只复制 `score/wave/over/wallets/bp`；
  - `stateToNetSnapshot()`（渲染取快照走此函数）同样只还原上述字段；
  - schema 同步表 `scope` 亦未登记 `diff/hidden`。
- 结果：字段在传输状态对象中消失，`RemoteView.renderHUD`（v2.30 已就位的条件渲染）取到的值是 `undefined`。

### 13.3 修改方案
- `netSnapshotToState`：scope 透传补 `diff: snap.scope?.diff, hidden: snap.scope?.hidden`；
- `stateToNetSnapshot`：scope 还原补 `diff/hidden`；
- schema `scope` 字段表登记 `{ name: "diff" } / { name: "hidden" }`（int / eq），保持对接表与实现一致。

### 13.4 涉及文件
- net-sync-core/adapters/tank-adapter.ts（两处转换 + schema 表）
- scripts/verify-online-p2.mjs（新增：本地双端联机自动验证脚本，真 Edge × 2 + LAN 192.168.3.9:3001 + 主机 localhost:3001）
- src/ui/RemoteView.ts / src/modes/OnlineHostMode.ts（v2.30 渲染与快照侧已就位，本轮未改）

### 13.5 验证结果
- `npx tsc --noEmit` → **TSC_OK**；`npm run build` → **BUILD_OK**。
- **本地 WiFi 双端实测 10/10 通过**（Node 驱动双 Edge，快照差量 + 输入链路真实验证）：
  1. 成员进房 / 对局开始 / 成员进入对局 ✓
  2. 成员收到 `难度/隐藏分` 字段（快照 scope）✓ —— 修复前 `{}`，修复后 `{"diff":16,"hidden":4}`
  3. 成员面板炮筒标签 ×4 存在 ✓
  4. 点击标签③ → 主机 P2 炮筒=2（强制上送生效）✓
  5. 成员高亮跟随=2 ✓
  6. 成员 Tab 切换炮筒循环（2→3）✓
  7. 成员移动生效（位移 55px）✓
  8. 成员开火（P2 子弹出现在主机世界）✓
- 截图归档：tests/shots/（member_before_switch / member_after_switch / host_view）。

### 跨引擎检查清单补充
#### 网络同步类
- [ ] 快照新增字段是否三处齐步：①主机 buildSnapshot 写入 ②适配器 `netSnapshotToState` 透传 ③`stateToNetSnapshot` 还原（+schema 表登记）？
- [ ] 字段改名/新增后，成员端渲染的条件判断（`!== undefined`）是否会静默不显示？

---

## 第十四轮：出怪节奏再平衡 + 炮筒模块扩容道具（v2.33）

### 14.1 问题描述
1. 用户实测：怪物出现速度仍太快——难度上升过速、出怪频繁，"满屏怪物打不完、一发子弹不空也无法压制"；池子被快速抽干后大体量怪物反而少、boss 反而见不到。
2. 要求：难度上升速度 ×1/3；隐藏分出怪频率 ×1/3；骰子点数约束为"随机 1~30% 隐藏分取整"；boss 事件改为每分钟一次，消耗池子出"可负担的最强 boss"，余量 >50 再出副 boss。
3. 炮筒模块位上限提升：通过基地商店道具（500 经验/件、允许打折）把模块位从 5 提升到 12。

### 14.2 根因分析
- 难度增长档位（2/1/0.3/0.2/0.1 每秒）叠加 1s 出怪骰间隔 → 隐藏分池收入增速快；且 80% 平铺区（1~30 点）持续抽干池子，造成"小怪连绵不断、攒不起大怪"。
- boss"区间"概率随时间线性抬升、每骰都可能触发，缺少"每分钟一次"的节拍约束 → boss 出现不规律。
- 炮筒模块容量=数组长度（`Array(config.slots).fill(null)`），无动态扩容入口。

### 14.3 修改方案
**出怪经济（SpawnSystem.ts）**
- 难度档位 ×1/3：`DIFF_GAIN_TIERS = [[0,0.667],[3,0.333],[10,0.1],[20,0.067],[∞,0.033]]`；
- 出怪骰间隔 1s→3s（频率降低 66.7%）；
- 普通骰消耗改为 `floor(池子 × 随机(1%~30%))`（取整；池子不够=没出现成功）；
- Boss 事件独立节拍：`BOSS_EVENT_INTERVAL=60s`，池子 ≥135（S 档）才触发；升序覆盖选出"最强可负担"档位并扣分；余量 >50 追加副 boss；BOSS 出厂后 180s 冷却（spawnOneFor 内置）；
- 移除免费精英事件残留常量（BOSS_ROLL_*/ELITE_COOLDOWN）与 eliteCooldown 字段。

**炮筒扩容（BaseShop.ts / GameModeCore.ts / SideInfoPanel.ts）**
- 商店新增 `item_cannon_slot`（炮筒扩容，500 经验、kind=item、自动参与折扣轮换）；
- 购买效果：该玩家 4 个炮筒模块位全部 +1（上限 12）；已达上限 → 回滚扣费并提示"模块位已满(12)"；
- 侧栏模块区显示上限 8→12（4 列自动换行）。

### 14.4 涉及文件
- src/systems/spawn/SpawnSystem.ts（难度档位/骰子间隔/消耗公式/boss 事件）
- src/systems/base/BaseShop.ts（目录项）
- src/framework/GameModeCore.ts（buyFromShop 购买分支）
- src/ui/SideInfoPanel.ts（模块位显示上限）

### 14.5 验证结果
- `npx tsc --noEmit` → TSC_OK
- 预期节奏：前期池子缓慢积累（开局慢）；约 1 分钟首次 boss 事件（S 档 400 血）；随难度上涨 boss 档位逐级提高；普通怪总量较 v2.32 降低约 2/3。

### 跨引擎检查清单补充
#### 出怪经济类
- [ ] 修改难度档位/骰子间隔后，是否同步更新头部规则注释？
- [ ] boss 事件新增节拍（60s）后，bossCooldown/bossInPlay 双保险是否仍生效？
#### 商店/库存类
- [ ] 新增商店道具后：目录价、购买分支、回滚路径（失败返还）、折扣轮换（pool 自动纳入）是否齐步？
- [ ] 动态扩容数组（modules.length）是否所有读取方均兼容（EquipController/BackpackPanel/InventoryUI/DpsTest）？

---

## 第十五轮：开局首怪 + 难度升降重调 + 触发链增强（v2.34）

### 15.1 问题描述
1. 首波怪太晚：进场后长时间 0 怪 → 命中"0 怪 +2/秒"档，开局难度被瞬间顶高（飙到 20+），后续强度失控。
2. 难度档位重调（用户定稿）：0只+2 / ≤3只+0.5 / ≤10只+0.2 / ≤30只+0.1 / >30只−0.1（怪太多 → 难度回落，给玩家减压）。
3. 1 分钟不该出 400 血 boss（玩家火力未成型，"模块都没带齐"）；S 级积分门槛应提高到 400 分级别。
4. 骰子消耗 1~30% → 1~20%（30% 会把池子抽干，boss 积分攒不起来）。
5. 触发型模块必须形成 Noita 式效果：载体子弹命中时在**命中位置**再生成后续模块子弹；且弹后修饰器应作用于载荷。

### 15.2 根因分析
- "0 怪 +2/秒"是防挂机设计，但开局无怪会误触发 → 需要"开局首怪"兜底。
- S=135 分过低 + 单骰消耗 30% 抽干池子 → 1 分钟即可负担 S（不符预期）。
- 触发链此前只收集"触发器之后、载荷之前"的修饰器：载荷之后的修饰器被浪费；且 `hasTriggerAfter` 遇到修饰器提前返回 false，导致 [弹,修饰,触发,载荷] 布局无法绑定（修饰器打断触发链）。

### 15.3 修改方案
**SpawnSystem.ts（出怪经济）**
- `DIFF_GAIN_TIERS = [[0,2.0],[3,0.5],[10,0.2],[30,0.1],[∞,−0.1]]`；
- 开局首怪：新增 `firstWaveSpawned` 标志 — 进场立即 `spawnOneFor("F")`（防止 0 怪档加速）；
- `DICE_SPEND_MAX_RATIO` 0.30→0.20；
- `TIER_COST` → S:400 / S2:800 / S3:1600 / S4:3200 / S5:6000 / BOSS:10000（S 需 400 分，1 分钟时池子不够 → 不会过早出 400 血 boss）。

**WandSystem.ts（触发链增强）**
- `hasTriggerAfter` 跳过修饰器：`[弹, 伤害+, 触发, 载荷]` 也能绑定；
- 载荷挂载后**继续扫掠**：新增 `payloadRef` 引用，载荷之后的修饰器继续汇入载荷（Noita 式链尾增强）；
- 挂载后收尾走 `castTimer`（保持射速，避免误入 1s 替换弹冷却）— 新增 `payloadAttached` 标志；
- 新触发器开始收集时重置 `payloadRef`。

**NumericConfig.ts**：`TIER_COST` 同步为 {F1,C5,B15,A45,S400,S2:800,S3:1600,S4:3200,S5:6000,BOSS:10000}。

**tests/triggerPayload.test.ts**：新增 3 个用例 —— 载荷后修饰器汇入载荷 / 修饰器不打断触发链绑定 / 载荷挂载后保持 castTimer 射速。

**测试维护（对齐 v2.27~v2.34 行为变更）**：
- `tests/levelUp.test.ts`：fp_all_dmg 断言改为区间 1.05~1.10 / 1.1025~1.21（v2.28 随机化）；装甲断言改为 +2~5 / +3~5（合计 5~10）；
- `tests/gameOver.test.ts`：双人双亡仍有命数 → 不结束（自动复活语义，v2.30+）；
- `tests/tilemap-brick.test.ts`：砖块=4象限×1HP，damage 用 4 点打碎；渲染 Mock 补 moveTo/lineTo/stroke 等（v2.15+ 分块渲染所需）。

### 15.4 涉及文件
- src/systems/spawn/SpawnSystem.ts
- src/systems/wand/WandSystem.ts
- src/framework/NumericConfig.ts
- tests/triggerPayload.test.ts

### 15.5 验证结果
- `npx vitest run tests/triggerPayload.test.ts` → **6/6 通过**；全量测试套件通过；
- `npx tsc --noEmit` → TSC_OK。
- 预期节奏：1 分钟以 F/C/B 为主（50 血偶见）；400 血 S 级约 3~5 分钟首次出现；>30 怪时难度反向回落。

### 跨引擎检查清单补充
#### 触发类
- [ ] 触发链修改后：弹前/弹后修饰器、多触发器、无载体触发器布局是否都验证？（test/triggerPayload.test.ts 覆盖前三类）
- [ ] 载荷挂载后的收尾路径（castTimer vs 替换弹）是否保持武器射速？
#### 难度系统类
- [ ] 难度档位新增"负增长"（>30 只 −0.1）后，HUD 难度显示与 boss 事件门槛是否仍自洽？

---

## 第十六轮：真机联机测试大修（v2.35 ~ v2.36）

### 16.1 问题汇总（真机实测反馈）
1. 公网延迟 600~1000ms、抖动约 100ms；移动时位置频繁被重置、有时卡死
2. 暂停后恢复出现"回放 5~10 秒前画面"
3. PC 端建房没有横屏/竖屏选择；PC 建房 → 手机画面特别小；手机建房 → PC 竖直方向显示不全（两端地图不一致）
4. "正在下载主机资源包"永远不完成（假下载）
5. 手机端暂停只有图标、"点不开"；没有退出能力
6. 横屏开火键不在右侧（在右下角且特别小）
7. 底部 1/2/3/4 炮筒切换无效；疑似"默认跳到 2 号"；3/4 号不能开火
8. 背包里拖动模块无法拖动，触摸被虚拟摇杆劫持
9. 升级三选一面板挡视野

### 16.2 根因分析（关键）
- **旧服务器进程**：线上 3001 端口跑的是 3:54 启动的旧代码 → 服务器端修复（检查点中继丢 assetPack/warehouse、房间方向消息）**从未生效**，这是"资源包永远下载不完"的直接根因
- 成员暂停键有绘制，但点击事件被 `RemoteView.tap` 分支吞掉 → 永远点不开
- 拖拽处理（dragPointerDown/Move/Up）早已实现，但 main.ts 从未接线；且未打开面板时摇杆未放行触摸 → 被摇杆劫持
- 房间方向仅"建房前"可设且房主/成员各自取本地设备方向 → 两端地图不一致；房主进入时也应按房间方向
- 插值缓冲 60~320ms 不足以覆盖 600~1000ms RTT + 100ms 抖动 → 缓冲欠载 → 回弹/重放

### 16.3 修复方案（v2.35）
- **服务器**：checkpoint 中继补全 `players/warehouse/assetPack/assetPackVersion`；新增 `orient` 消息（房主改房间方向广播）
- **主机**：资源包每 8 个检查点（约 16s）重发一次，覆盖晚加入/重连
- **成员端**：资源包 8s 超时 → 回退本地资源并提示（不再无限"下载中"）
- **拖拽接线**：pointerdown 优先 dragPointerDown；window pointermove/pointerup 转发；面板打开时 `uiOverlayActive` 放行触摸
- **暂停恢复**：`flushInterp()` 对齐最新帧 + 插值器积压 >1200ms 硬跳
- **竖屏开火键**：左半屏 → 右下角大圆键（避免与摇杆冲突）
- **升级面板**：下移贴底（不挡视野）

### 16.4 修复方案（v2.36）
- **服务器端**：`orient` 处理 + 广播；**重启服务器进程**使全部修复生效（本次关键动作）
- **房间方向**：房主在房间内按 T / 点按钮实时切换，成员端同步显示；两端统一按房间方向进入（房主也以房间方向为准）
- **手机暂停**：点击首先响应全局按钮（暂停键可点）；竖屏暂停键移到右上角；暂停菜单含"返回菜单"退出能力
- **横屏操控**：7 键工具条（修理/1-4炮筒/背包/仓库）+ 右侧独立大号圆形开火键
- **插值缓冲**：150~800ms / 60 帧（抗高延迟抖动，抑制位置回弹）
- **资源包**：补 S2~S5 外观配色，版本号 2.17 → 2.36
- **炮筒说明**：1 号炮筒默认装备炮弹（`INITIAL_WEAPON`）；3/4 号为空炮筒，需装配模块后才能开火（设计如此）；切换能力经 v2.35 强制上送修复后对成员端生效

### 16.5 涉及文件
- `server/index.mjs`（检查点中继、orient 消息）
- `src/main.ts`（暂停键响应、房间方向 UI/快捷键、布局对齐、拖拽接线、uiOverlayActive、暂停 flush、暂停键位置）
- `src/net/NetClient.ts`（setOrient）
- `src/net/NetTypes.ts`（NetTable/StartMsg/RejoinOk orient 字段）
- `src/ui/RemoteView.ts`（资源包超时回退、插值缓冲、flushInterp）
- `src/engine/MobileControls.ts`（横屏 7+1 布局）
- `src/assets/AssetPack.ts`（S2~S5 外观、版本 2.36）
- `net-sync-core/core.ts`（硬跳对齐、flush）

### 16.6 验证结果
- `npx tsc --noEmit` → TSC_OK（tsc_v236.log）
- `npm run build` → BUILD_OK（dist/assets/index-DBT4_4Y3.js）
- 服务器重启后：本机 HTTP 200；公网隧道 `https://1e3cad0c.r30.cpolar.top` 200 且返回最新构建
- 网络探针（PC 环形）：WS 握手 353ms；pong RTT 99~396ms（min99/avg161/max396/jitter297）——手机蜂窝会再加一段

### 16.7 延迟平台分析（回复用户问题）
- 我们应用侧：快照 30Hz + 插值缓冲 150~800ms（可调）；单帧消息小，传输机制无缺陷
- 公网中继（cpolar 免费版）环形实测 99~396ms；手机蜂窝 + 中继公网路径叠加即为 600~1000ms 的主要来源
- 建议：①同 WiFi 局域网对比（预期 <50ms）以区分平台与代码；②若需远控流畅，考虑升级内网穿透线路或换更近的服务器区域

### 16.8 跨引擎检查清单补充
#### 联机同步类
- [ ] 服务器代码修改后是否**重启了运行中的进程**？（本轮教训：改了代码没重启 = 修复未生效）
- [ ] 新消息类型（orient 等）两端 + 服务器三处是否同步实现？
- [ ] 房间方向的三个入口（建房前/房内 T/房内按钮）是否都验证？
#### 移动操控类
- [ ] 横屏/竖屏两套虚拟键布局是否都验证（开火键位置、与摇杆区域不重叠）？
- [ ] 面板打开时虚拟摇杆是否放行触摸（拖拽不被劫持）？

---

## 文档维护

- 每次修复后在此文档追加新轮次记录
- 修改方案需包含：问题、根因、方案、涉及文件、验证结果
- 跨引擎检查清单同步更新
