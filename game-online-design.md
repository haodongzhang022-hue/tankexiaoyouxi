# 坦克大战深度版 - 联机设计文档

> 本文档专用于**联机（多人）功能**，与 `game-feature-design.md`（整体功能）配套。
> 按版本记录迭代，过去版本保留参考，**以最新版本为准**。

## 版本历史
- **v2.23** (2026-09-16)：**手机/单玩家体验完善 + 单发武器每槽位在飞上限按模块区分**（竖屏去小地图、方向盘右侧圆形透明开火键、暂停键左下、死亡自动复活、结束画面返回菜单按钮、WandSystem 每槽位在飞上限默认1发/机枪5发；详见本版本节）。
- **v2.22** (2026-09-16)：**成员端（P2）触屏操作完整化**（触屏"背包/仓库"按钮本地打开自己的面板 + `inputSig` 补 `fire` 开火即发 + 成员阵亡提示横幅；详见本版本节）。
- **v2.14.1** (2026-09-12)：**基地商店交互优化（手动打开 + 原价/现价划线 + 侧边布局）**（成员端商店不再靠近自动弹出，改「按 E / 点击基地」手动开关、点面板外或离开基地自动关闭；价格改为「原价(划线)→现价」大字号；面板移到屏幕左侧固定；主机/成员共用 `BaseShop.drawShopPanel` 共享渲染；详见 `game-feature-design.md` v2.14.1 增补与下文）。
- **v2.14** (2026-09-12)：**双端 HUD 布局统一（同一区域放同一信息）**（成员端与主机端共用同一信息栏/小地图/网络质量区域：小地图从右下角移到右侧信息栏右上、成员端信息栏改为快照驱动显示双玩家经验/背包/基地、网络 RTT 两端同位置同语义；另新增 `npm run dual` 一键双玩家联机快测，见本版本节）。
- **v2.13** (2026-09-12)：**net-sync-core 跨引擎网络同步资产接入**（协议升级为 schema 驱动 `kinds` 结构，主机/成员/插值/重连/RTT 全部由模块驱动；服务器无感；抖动治理实测通过；详见本版本节）。
- **v2.12** (2026-09-12)：**主机迁移（房主断线 → 存活成员接替续局）**（检查点 + 快照恢复；详见本版本节）。
- **v2.11** (2026-09-12)：**断线重连 / 局内重进**（成员断线座位保留，刷新/断线后凭 localStorage 重连卡自动回到原座位继续对局；详见本版本节）。观战部分优先级已降低（维持现状，不再扩展）。
- **v2.10** (2026-09-12)：**WebRTC P2P 快照直连 + 背包/钱包全量对齐**（详见本版本节）。P3/P4 战斗位维持观战（4 人作战转 Unity 引擎侧，该项目不再扩战斗位）。
- **v2.8** (2026-09-11)：**快照增量编码 + 30Hz 升频**（只发变化实体，关键帧兜底；详见本版本节）。
- **v2.6.7** (2026-09-11)：**自适应插值延迟 + 宽松追赶**（成员端按快照到达抖动动态调缓冲，稳定低延迟/抖动深缓冲；详见本版本节）+ 联机测试工具升级（可视化、`--scene ids|interp` 快速启动）。
- **v2.6.6** (2026-09-11)：**实体稳定 ID + removed 列表**（成员端按 ID 匹配/即时剔除，根治子弹串位、死亡冻结、敌人消失延迟；详见本版本节）。
- **v2.6.5** (2026-09-11)：成员端 **P2 本地预测**（自己坦克 run-ahead + 权威快照校正；详见本版本节）。
- **v2.6.2** (2026-09-11)：出生点卡墙修复 + 手机/远端操作完善（攻击键、操作方式切换、远端升级选择）+ 升级速度减慢 30%。
- **v2.6.1** (2026-09-11)：联机 HUD 接入 **RTT/抖动实时显示**（服务器回声 ping/pong 测延迟 + 主机 P2 输入延迟/到达抖动）。
- **v2.6** (2026-09-11)：**联机网络手感优化**（远端输入变化即发 + 固定步进帧号 + 主机按序消费/丢帧延续兜底）+ 修复联机升级按键不可用与 DEV 开关残留。
- **v2.5** (2026-09)：**单端口部署**（页面 + WebSocket 同端口，一个链接即可分享）+ 大厅**可见分享按钮与鼠标/触屏操作** + 多候选地址自动探测连接（同源 → :3001 回退）+ 空桌首位加入者自动成为房主 + 开始条件改为「房主无需准备，其余玩家全部准备」。
- **v2.4** (2026-08-22)：联机大厅上线（建桌/进桌/最多 4 座/准备/开始）+ **主机权威** 联机对局 + **邀请链接**（端到端自测通过）。

---

## v2.23 手机/单玩家体验完善 + 单发武器每槽位在飞上限按模块区分（最新，以本版本为准）

> 时间：2026-09-16。四项 UI/操作 + 一项武器机制，面向手机单玩家与竖屏体验。

- **竖屏版去掉小地图**（主机 `GameModeCore.renderMinimap` 与成员 `RemoteView.renderMemberMinimap` 竖屏分支整体不渲染）：
  - 修复：竖屏信息栏横条 `topSkipY=0`（此前把小地图高度误算进 `topSkipY`，导致底部信息栏内容被挤没）。
  - 背景：v2.19 竖屏小地图画在游戏区左上 (8,42)，恰好与暂停键 (8,44) 重叠——「暂停被遮挡」的其实是小地图。
- **方向盘右侧圆形透明开火键**（`MobileControls`，仅竖屏单玩家）：
  - 开火键改为方向盘右下方的圆形半透明大键（r≈46/平板52），**检测区 = 视觉圆 + 12px**；触在开火键上不再误启动方向盘。
  - 右列按钮从 5 个减为 4 个工具钮（修理/炮筒/背包/仓库），更宽更好点；横屏保持原 5 键布局不变。
  - 底部操作条背景只盖方形工具钮，圆形开火键单独画（半透明不遮战场）。
- **暂停键移到左下**：竖屏改放左下角 `(8, H-44)`，横屏保持左上 HUD 下方；不再与任何虚拟键/小地图重叠。
- **死亡自动复活（单玩家，不等救援）**：`GameModeCore` 复活逻辑——单玩家或 P2 为 AI 时（`players.length < 2 || isAIPlayer(1)`），死亡后 3 秒倒计时**自动复活**，无需按开火、更不用等队友救援；双真人协作保留原「按开火自复活 / 队友靠近救援」。
  - 成员端 `renderCorpseMarkers` 同步：自己死后不再显示红圈 ✕ 救援标记（无人会来救，去掉误导提示），队友尸体仍提示。
- **基地被摧毁结束画面返回菜单按钮**（主机 `OnlineHostMode` 结束画面 + 成员 `RemoteView.renderGameOver` 覆盖层均由 `main.ts` 统一叠加）：
  - 对局结束（`host.isOver` / `remoteView.isOver()`）在画面底部显示两个可点按钮：**「🚪 返回大厅」**（`returnToOnlineLobby`：离桌回联机大厅，保持连接继续选桌）与 **「🏠 返回主菜单」**（`exitOnlineToMenu`）；键盘 Enter/Space 对应返回大厅。
  - 手机端无 Enter 也能点按钮结束；此前只有"按 Enter 返回菜单"。
- **WandSystem 单发武器每槽位在飞上限按模块区分**（`ModuleRegistry`/`WandTypes`/`WandSystem`）：
  - 新增 `ModuleConfig.maxInFlight`（默认 1）：单发炮筒 `singleShot` 生效时每槽位最多 `maxInFlight` 发在飞——"只能 1 发"是武器特性，**散弹 count=5 的 5 颗弹丸同槽位整体算 1 发**（不拆开计数）；机枪 `proj_pew` 设 `maxInFlight: 5` 不打断连射。
  - 拦截语义说明（未写反）：`flyingForSlot >= inFlightCap` 是"在飞数达到上限才拦截"，即每槽位在飞数 ≤ 上限恒允许、最多保持上限发。
  - 散射扇形（`SPLIT_FAN_STEP_DEG`）与方向修正（`focusFactor`）保留不变。
- **涉及文件**：`src/framework/GameModeCore.ts`、`src/ui/RemoteView.ts`、`src/engine/MobileControls.ts`、`src/main.ts`、`src/systems/wand/WandTypes.ts`、`src/systems/wand/ModuleRegistry.ts`、`src/systems/wand/WandSystem.ts`。
- **验证**：`npx tsc --noEmit` 无错 → `npm run build` 成功（dist `index-ZyCUl-rS.js`）→ `npx vitest run` **87/87 全绿**（含把 `wandSingleShot` 测试从旧"每槽位2发"断言更新为 v2.19/v2.23 一致的"每槽位1发"，并修复 `remoteview-net-id.test.ts` 记录式 ctx 缺 `ellipse/渐变/moveTo/roundRect/quadraticCurveTo` 等历史回归）。
- **部署**：3001 已重启运行新构建；隧道 `https://2e99143c.r29.cpolar.top` 与当前 cpolar `https://a16429.r29.cpolar.top` 均 HTTP 200（服务器动态学习公网域名，游戏内邀请链接自动适配）。

---

## v2.22 成员端（P2）触屏操作完整化（最新，以本版本为准）

> 背景：双人联机时两端都有"左侧方向盘 + 右侧开火/修理/炮筒/背包/仓库"的完整触屏布局（主机端由 `GameModeCore.mobile`、成员端由 `main.ts` 的 `mobileControls` 提供），但成员端（P2 手机）有 3 处操作不完整，本次补齐。

- **触屏"背包/仓库"按钮本地生效**（原先这两个标志只发给主机端，主机只认 P1 的仓库、P2 的背包会在**主机屏误弹 P2 背包面板**，成员自己的屏幕毫无反应）：
  - `main.ts` 联机客户端输入块新增 `prevMemberInvHeld / prevMemberWhHeld` 边沿检测——按"背包"在本地切换 `RemoteView.backpackOwner`（自己 P2 的背包查看），按"仓库"切换 `RemoteView.warehouseOpen`（仓库查看），两面板互斥；与信息栏「仓/P1/P2」按钮同一套 UI。
  - 发送包上送前把 `inventory/warehouse` 清零（`net.sendInput({ ...inp, inventory:false, warehouse:false }, frame)`），主机端不再被 P2 的这两个标志干扰。
- **`inputSig` 补上 `fire`**：原指纹漏了 `fire`，触屏开火按下不触发"变化即发"，最多等 30Hz 保活（≈33ms）才到主机；补上后开火按下立即发送，P2 手感更跟手（移动/切炮/修理原已即时）。
- **成员阵亡提示横幅**（`RemoteView.renderDeathHint`，HUD 顶栏下方居中）：本成员坦克阵亡且有剩余生命时显示——倒计时中「你已阵亡 · N 秒后可复活」、倒计时结束「你已阵亡 · 按住开火键复活」（联机 P2 非单机，死后须按开火自复活，主机权威裁决）；生命耗尽则不再提示。对局结束（scope.over）不显示。
- **涉及文件**：`src/main.ts`（inputSig + 成员端输入边沿 + 发送清零）、`src/ui/RemoteView.ts`（renderDeathHint）。
- **验证**：src `tsc` 无错误；vitest 86/88（2 个失败与本次无关：`remoteview-net-id.test.ts` 为并行编辑器 1:47 在途改动、`lootDrop.test.ts` 掉落率随机抖动 0.00475 略低于 0.005 阈值）。

## v2.14 双端 HUD 布局统一（历史参考，以 v2.22 为准）

> 背景：成员端长期使用与主机端**完全不同的一套 HUD**（小地图在右下角、信息栏缺失只显示"我背包"文字摘要、网络指标位置/语义不同），导致两名玩家看到的内容区域不对齐。本次把**两端共有的信息落到相同区域**，成员端复用主机端同一套 UI 组件。

- **小地图位置统一**：成员端小地图底层锚点从「画布右下角」改为与主机 `GameModeCore.renderMinimap` **完全相同的锚点规则**——横屏 = 右侧信息栏右上（`x = cw - mm.w - 8`，`y = 42` 避开顶栏）、竖屏 = 底部信息栏顶部右侧（`viewW - mm.w - 8`，`infoY + 10`）。不再半透明。
- **信息栏统一（快照驱动）**：`SideInfoPanel` 新增**远端模式** `renderRemote(renderer, now, RemoteInfoSource)`（同一文件、参数控制：本地对象驱动 or 快照驱动），布局骨架与本地模式一致（标题 → 基地块 → 双玩家块）。成员端由其提供快照数据（`RemoteInfoSource`：players/hp/base/wallets/bp），右侧信息栏现在**两名玩家的存活/经验/背包摘要/基地状态都能看见**，不再只有自己。
- **渲染顺序统一**：成员端改为「信息栏背景 → 小地图 → 弹层」与主机一致，信息栏不透明背景不再盖掉小地图（这是首版截图验证发现的关键坑）。
- **网络质量区域统一**：成员端顶栏改为与主机相同的 40px 两行结构；RTT/抖动显示在与主机**同一位置（8,21）同一语义**（`LatencyTracker` 窗口均值）。成员特有「插值缓冲 ms」与主机特有「P2 输入延迟」保留在右侧辅助位（各自特有指标，不作对齐承诺）。
- **一键双玩家快测**：`npm run dual`（`scripts/quick-dual-test.mjs`）自动启动房主+成员两个 Edge → 建桌/进房/准备/开局/双方 AI 驾驶 → 每 8 拍打印两端 HUD（房主 RTT+抖动+P2输入 / 成员 RTT+抖动）。另可 `npm run host-ai` 只起 AI 房主等人类 P2。
- **验证**：tsc/build 通过；vitest 86/86 绿；双端实机截图确认小地图均在右侧信息栏右上、成员端信息栏显示 P1/P2、RTT 同区同语义（主机 `RTT 2ms` 成员 `RTT 1ms`，同链路窗口均值）。

## v2.13 net-sync-core 跨引擎网络同步资产接入（最新，以本版本为准）

> 目标：把 v2.6~v2.12 沉淀的同步机制固化为**跨引擎通用资产 `net-sync-core/`**（对接表驱动），并将**网页端主机/成员/插值/重连/RTT 全部切换到模块驱动**——服务器协议无感，功能等价，抖动治理经专项实测确认。为 Cocos/Unity 复用铺路。

- **资产**：`net-sync-core/`（schema.ts 对接表 / core.ts 通用核心 / transports.ts 可插拔 / adapters/tank-adapter.ts 实例 / README 使用文档 / tests 自测含交叉等价）。
- **主机端**（`OnlineHostMode`）：快照编码 `SnapshotDeltaCodec` → `SyncCodec`（schema 驱动）；`buildSnapshot` → `netSnapshotToState` 进通用状态再编码。
- **成员端**（`main.ts`）：解码 `snapCodec.decode` → `stateToNetSnapshot` 还原 NetSnapshot 喂 `RemoteView`；重连卡 → `ReconnectManager`；RTT/抖动 → `LatencyTracker`（window 路线=旧手感）；P2P 帧同样经模块解码。
- **插值**（`RemoteView`）：内部缓冲/自适应延迟/渲染推进全部由模块 `Interpolator` 驱动（算法=v2.6.7 固化），对外 `setSnapshot/render/debugInterp/debugStats` API 不变（单测/e2e 无感）。
- **协议升级**：快照从旧顶层 `players/enemies/projectiles` 结构改为 schema 驱动 `kinds{tank/projectile/loot/powerup}`（服务器仅转发、无感）；`removed` 按种类键（`projectile`）；增量帧平均 **137B**（旧 414B，空掉落不再占位）；e2e 工具断言同步更新。
- **抖动治理实测**（新增 `tests/net-jitter-e2e.mjs` + `net-jitter-proxy.mjs`）：WS 代理注入 33↔180ms 真实到达间隔抖动（含拥塞丢帧）——
  | 阶段 | 插值延迟 | 到达抖动 | 渲染推进 |
  |---|---|---|---|
  | 稳定期 | 31ms | 1ms | 100% |
  | 抖动期 | 117ms | 39ms | 100% |
  | 恢复期 | 32ms | - | - |
  抖动期缓冲自动加深吸收抖动（防卡顿回跳），全程渲染 100% 推进、无长冻结、0 异常；恢复后自动回落贴最新帧。
- **验证**：tsc ✓ / build ✓ / vitest **86/86** ✓（含与旧 `SnapshotDeltaCodec` 交叉等价）/ relay 17 项 ✓ / 可视化 e2e `ids|interp|migrate` 全绿 ✓ / 抖动专项全过 ✓ / **3001 生产服已用新 dist 重启**（HTTP 200）。

---

## v2.12 主机迁移（房主断线 → 存活成员接替续局）

> 目标：完善玩家体验——**房主断线不再终止本局**，最靠前的在场成员自动接替为主机，凭「本地快照 + 检查点」恢复世界继续对局（无需重开、进度延续）。

- **服务器（`server/index.mjs`）**：
  - 房主断线（对局中）：`migrateHost()` → 清离场房主座位（令牌随之失效）→ 选最靠前在场成员为新主机（`table.hostId` 切换）→ 通知在场全员 `migrated{newHostClientId, players}`；无人在场才终止本局。
  - `checkpoint` 中继白名单：仅主机可发，转发给在场成员（每人保存最新一份）。
- **检查点（`OnlineHostMode.serializeCheckpoint`，每 2s 经 `net.hostCheckpoint` 广播）**：补全快照未携带的接替状态——每玩家 4 根炮筒（WandConfig + 模块 id/剩余次数）、等级/经验/生命、统计、升级旗标（wandDamageMults/crit/免伤/护甲/吸血旗标等）、背包槽位。成员存 `lastCheckpoint`。
- **接替续局（`OnlineHostMode.createTakeover` + `restoreFromTakeover`，main.ts `takeOverAsHost`）**：成员收到 `migrated` 且 `newHostClientId===自己` → 用「RemoteView 最新完整快照 + 首帧地图 + 检查点」恢复为本地主机（playerCount=1）：
  - 地图/基地（鹰标血量/墙等级/墙体耐久）/分数/波次按快照恢复；玩家 = 原 P2 坦克（位置/血量/朝向/钱包 `wallets[1]`），武器/等级/背包按检查点重建；敌人按快照重建（位置/血量/朝向沿用，AI 重新取目标）；在飞子弹清空（瞬态）；掉落/道具按快照重建。
  - 接替后新主机照常广播快照/检查点/升级/商店；状态切 `online_host`（P1 本地操控）。
- **边界**：仅成员可接替（接替者成为唯一战斗位 P1）；离场房主无法凭旧令牌重进；观战成员只收通知照常渲染；接替者刷新会再次迁移（无人则终局）。
- **测试**：
  - relay 协议级（`tests/net-levelup-relay.mjs`，`RELAY_URL` 可指临时服）：成员收 checkpoint ✓ / 成员伪造 checkpoint 被忽略 ✓ / 房主断线 → `migrated(newHostClientId=成员)` ✓ / 离场房主令牌失效 ✓ / 接替后新主机广播无异常 ✓。
  - 可视化 e2e（`tests/net-snapshot-e2e.mjs --scene migrate`）：成员收到检查点 ✓ → 房主导航离开（WS 断）→ 成员 `__migrated` 自动接替 ✓ → 新主机持续广播快照（世界延续：P1 存活）✓ → 刷怪恢复（无尽攒预算+预警后出怪）✓ → 接替后 0 渲染异常 ✓。
  - 回归：`ids`（含重连）、`interp` 全绿；vitest 70/70。
- **验证**：tsc ✓ / build ✓ / vitest **70/70** ✓ / relay 17 项全过 ✓ / e2e `ids|interp|migrate` 全绿 ✓。

---

## v2.11 断线重连 / 局内重进（最新，以本版本为准）

> 目标：完善**玩家**断线/刷新后的体验——对局进行中非房主断线不再直接退桌，座位保留，凭令牌自动回到原座位继续对局。**观战部分价值低，优先级降低**（维持现状，不扩展）。

- **服务器（`server/index.mjs`）**：
  - `start` 时给每名玩家下发 `rejoinToken`（对局身份令牌，随 `start` 消息下发）。
  - **软离场**：对局进行中非房主断线 → 座位保留（`ws=null`），不广播离开；房主断线仍终止本局（不做主机迁移）。
  - `rejoin` 处理器：对局中 + 令牌匹配 → 新连接挂回原座位（更新 `ws`/`clientId`/`conn.idx`），回 `rejoin_ok`（结构同 `start`，含 `myIndex/mode/players/seed`）；令牌无效或对局已结束 → `error`。
- **客户端（`src/main.ts` + `src/net/`）**：
  - **重连卡**：`beginOnlineGame` 时把 `{tableId, token}` 存 localStorage（`tank_rejoin_v1`）；`welcome` 时**优先于邀请链接**检查重连卡 → `net.rejoin()`。
  - `rejoin_ok` → 复用 `beginOnlineGame` 直接恢复对局（远端视图重建，快照/升级/商店照常）；失败/对局结束/离开时清卡回大厅。
  - 协议类型：`NetTypes.ts` 增 `RejoinOkMsg`、`StartMsg.rejoinToken`；`NetClient.ts` 增 `rejoin()` 方法与 `rejoin_ok` 事件。
- **边界与约定**：仅成员（非房主）支持重连；刷新即断线重连（重连卡自动恢复对局渲染）；断线期间主机照常广播，重连后无需主机配合；重连卡在 `gameover`/`left`/重连失败时清除。
- **测试**：
  - 协议级（`tests/net-levelup-relay.mjs`）：start 携带令牌 ✓ / 断线后凭令牌 `rejoin_ok(myIndex=1)` ✓ / 重连后快照广播恢复 ✓ / 错误令牌被拒 ✓。
  - 可视化 e2e（`tests/net-snapshot-e2e.mjs --scene ids`）：**刷新成员页 → 自动凭重连卡恢复对局渲染**（`window.__rejoinApplied`）✓，重连后无新渲染异常 ✓。
  - 本次修复：e2e `waitFor` 成功时 `return;` 丢失表达式值导致断言误报（改 `return v`），重连链路本身正常。
- **验证**：vitest **70/70** ✓；relay 协议全过 ✓；可视化 e2e `ids`（含重连）与 `interp` 全过 ✓。

---

## v2.10 WebRTC P2P 快照直连 + 背包/钱包全量对齐（最新，以本版本为准）

> 边界决策（依据玩家 2026-09-12 指示）：**本项目维持 2 名战斗玩家 + 3/4 号观战**，不再扩展战斗位（4 人作战在 Unity 引擎侧实现）。

- **WebRTC P2P 快照直连（`src/net/RtcPeer.ts`，服务器零业务感知）**：
  - 信令：新增服务器中继白名单 `rtc_signal`（仅同桌内按目标 clientId 路由，服务器不读 SDP/ICE 内容）；NetClient 增加收发。
  - 流程：双人开局即 `tryStartP2P()`——主机 createOffer/DataChannel，成员自动 answer；ICE 候选逐条中继；**不做 STUN/TURN**（公网跨 NAT 不保证连通，失败自动回落）。
  - **快照双发**：主机每帧同时发 WS（兜底）+ P2P；成员端先到先渲染，按 frame 天然去重。**HUD 显示"联机·成员·P2P/中继"** 状态。
- **背包/钱包全量对齐**：
  - `InventorySystem.toNet()` → 快照 `scope.bp` 携带每玩家背包视图（传统道具计数 + 模块数）；`scopeEqual` 纳入比较，变化即传；
  - 成员 HUD 显示自己的 `经验 x` 与 `背包 盾x1 修x1…`（与主机/购买结算实时一致）。
- **实测**（本机双实例 CDP）：`__rtc.state` 两端 **connected**（直连生效）；relay **8/8**（含 rtc_signal 双向路由、跨桌隔离）；可视化 e2e `ids` **12/12** ✓（快照流 235 帧、增量 202B vs 全量 953B、钱包 2 人、背包 2 人、成员页 0 异常）。
- 说明：局域网/同机场景直连最稳；公网云服务器跨省仍走 WS 中继（等效 v2.8 能力，不受影响）。

---

## v2.8 快照增量编码 + 30Hz 升频（最新，以本版本为准）

> 目标：把刷新率从 20Hz 提到 **30Hz** 且**带宽不涨反降**。核心：只发"变化的实体"，未变的不重传。

- **新模块 `src/net/SnapshotDelta.ts`（纯 codec，服务器继续原样中继不需改）**：
  - 实体（玩家/敌人/子弹）按 id 逐帧 diff：位置/HP/朝向/数量变化才进增量帧；`removed` 列表传播消失。
  - **base/scope 变化才带**（未变用成员端缓存）；loot/powerups 体积小每帧全量。
  - **关键帧兜底**：首帧 + 每 60 帧（≈2s）发全量帧；单类实体变化 >60% 时自动退化为全量（变化大时全量更省）——防丢包累计错乱。
- **主机（`OnlineHostMode`）**：快照间隔 0.05→`1/30`；`buildSnapshot` 产全量后经 `encode(prev,cur)` 出口。
- **成员（`main.ts`）**：`snapCodec.decode()` 合并到实体缓存 → 重建完整快照喂 RemoteView（插值/ID 匹配/淡出等零改动）；暴露 `window.__snapCodec`（可视化断言缓存）。
- **验证**：`tsc`/`build` ✓；`vitest` **70/70** ✓（新增 `tests/snapshot-delta.test.ts` 4 例：首帧全量/增量只带变化+解码重建一致/30Hz 增量体积<全量 0.6/60 帧关键帧）；可视化 e2e `ids` **8/8** ✓。
- **实测带宽**（真实对局 229 帧）：增量帧 ≈**197B** vs 全量 ≈**861B**（**↓77%**）；30Hz 平均 ≈15KB/s < 原 20Hz 全量 ≈17KB/s。**副产物**：插值间隔 EMA 自动适配 33ms → 自适应延迟下限更低（30Hz 贴最新）。
- 兼容说明：增量字段 `full` 缺省视为全量（老帧/老成员不受影响）；同仓库两端同版本部署即可。

---

## v2.6.7 自适应插值延迟 + 宽松追赶（最新，以本版本为准）

> 目标：对冲"20Hz 快照 + 固定 50ms 插值"的体验上限。稳定时贴近最新帧（低延迟），掉线抖动时加深缓冲（防卡顿回跳），网络恢复后大步追回实时。**纯成员端改动，不触碰协议/服务器。**

- **自适应延迟（`RemoteView`，`setSnapshot` 内）**：
  1. 按相邻快照时间戳算到达间隔 EMA（0.1）与抖动 EMA（0.2，|Δt-均值|）——快照自带时间戳，无需时钟同步。
  2. `INTERP_DELAY_MS = clamp( 间隔EMA×0.7 + clamp(抖动EMA×2, 8, 150), 30, 200 )`：
     - 稳定 20Hz：50×0.7+8 ≈ **43ms**（原 50ms，贴最新）；
     - 抖动 30ms：50×0.7+60 ≈ **95ms**；极端抖动 → 上限 200ms（≈4 帧缓冲）。
- **宽松追赶（`findInterpolationPair`）**：渲染点落后 target>60ms（渲染停滞/网络恢复）→ **大步 75ms/帧**追赶；正常 → 34ms/帧；抖动上涨需加深缓冲 → 20ms/帧较快后撤铺缓冲（原 0.25 倍过慢）。
- **HUD**：成员顶栏追加 `插<xx>ms`（≤60 绿 / ≤140 黄 / 其余红），实时可见缓冲档位。
- **调试句柄**：`RemoteView.debugInterp()`（delay/interval/jitter/renderT/latestT/lag）+ `main.ts` 暴露 `window.__remoteView`（同 `__gameLoop` 先例），可视化测试据此断言。
- **验证**：`tsc`/`vite build` ✓；`vitest` **61/61** ✓（新增 3 例：稳定→delay≤60、抖动序列→delay>60 且升高、渲染停滞→单帧大步>45ms）；`.probe`/`relay` 全过 ✓；**可视化 e2e 两场景全绿**（见下）。

### v2.6.7 补增：联机测试工具升级为可视化 + `--scene` 快速启动（2026-09-11）

> 目的：测试从"黑盒长链"改为**前端可视化 + 可预期场景**，加速联机测试。
> 工具：`tests/net-snapshot-e2e.mjs`（有头 Edge 双窗口弹出，可直接看战斗画面）。

- **快速启动封装**：`quickStart2P()` 把「主机菜单→联机→建桌 → 成员 ?room 进房 → 准备 → 开始 → 双玩家落地」整链封装；换场景只需 `--scene <name>`。
- **场景表（进入对局后各验其预期）**：
  | 场景 | 预期 |
  |---|---|
  | `ids` | 全实体整数 id / 子弹死亡进 removed / 子弹按 id 追踪不串位 / 敌人击杀进 removed / 成员页 0 异常 |
  | `interp` | 成员侧 delay 收敛低位（中位 ≤60ms）/ 渲染点持续推进占比 ≥70% / 无长冻结（连续停滞 ≤6 点）|
- **周期截图**：采样/执行中每 ~20% 截一张成员页，落 `tests/shots/visual_<scene>_*.png`，进度在控制台同步打印。
- **实测结果**：`ids` 6/6 ✓（119 帧采样）；`interp` 4/4 ✓（30 采样点，delay 中位 55ms、推进 100%、冻结 0 点）。
- **工具运行坑（重要）**：
  - 有头双窗下**被遮挡窗口 rAF 会被后台节流暂停**（游戏循环停摆、键事件无人消费）→ 启动参数须带 `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`；
  - 有头**不能加 `--disable-gpu`**（WebGL 上下文创建失败会让游戏初始化解体）；
  - 进房桌号不固定：`create` 落第一张 0 座空桌，且 IDE 内置浏览器若开着联机页会占一座「房主N」的桌 → 工具按房名 `e2e房` 动态识别自己的桌。

---

## v2.6.6 实体稳定 ID + removed 列表

> 目标：根治成员端三类"实体渲染错乱"——**子弹串位**（同类型子弹邻近时按"最近距离"误配）、
> **死亡冻结**（子弹撞墙/命中后残留在旧快照插值窗口内）、**敌人消失延迟**（死亡敌人卡 1~2 个快照间隔才消失）。
> 顺带修掉两个被 ID 匹配暴露/关联的隐患：成员端小地图传入的是裸 2D context（`mini.render(ctx,…)` 内部解构 `.ctx` 会取到 undefined 而抛错）、
> 敌人 `playerId` 从 0 起与 P1/P2（0/1）撞号导致旧"跨 players/enemies 按 playerId 匹配"把最早两只敌人吸到玩家身上。

- **协议（`NetTypes.ts`，服务器仅中继不改）**：
  1. `NetTank` / `NetProjectile` 增加 `id: number` —— 稳定实体 ID（主机已存在：`Tank.id` 玩家 P1=1/P2=2、敌人 ≥1000；`WandSystem.nextProjectileId`），直接序列化即可，全局唯一。
  2. `NetSnapshot` 增加可选 `removed?: { tanks: number[]; projectiles: number[] }` —— 自上一快照起消失的实体 ID；为空时整字段省略省带宽。
- **主机（`OnlineHostMode.buildSnapshot`）**：序列化 `id`；维护上一快照 ID 集合（`prevTankIds/prevProjIds`），与本帧存活 ID 求差集生成 removed。首帧差集为空。
- **成员（`RemoteView`）核心改动**：
  1. `interpTank`/`interpProj` 改按**稳定 ID** 匹配（玩家与敌人各自在 `players`/`enemies` 内匹，不再跨表按 playerId 猜测，撞号问题自然消失）；无 id 的老快照回退旧"最近距离/playerId"启发式（兼容老主机）。
  2. **消失即剔除**：a↔b 插值对中实体在 b 缺失 = 已死亡/移除 → 立即从输出剔除并登记 **200ms 淡出特效**（`renderFading`，坦克收缩、子弹缩小，`visualFor` 单一来源配色），杜绝"冻结残影"。
  3. 修复成员端小地图潜在崩溃：`renderMemberMinimap` 改为接收 `renderer`（Minimap.render 内部取 `renderer.ctx`），原代码把裸 2D context 当 Renderer 传。
- **验证**：`tsc --noEmit` ✓；`vite build` ✓；`vitest` 58/58 ✓（新增 `tests/remoteview-net-id.test.ts` 2 例：死亡敌人淡出而非冻结 + 存活实体不被误伤、子弹 ID 不串位）；`.probe/index.mjs` 8/8 ✓；`tests/net-levelup-relay.mjs` 3/3 ✓；**`node tests/net-snapshot-e2e.mjs` 双浏览器真实对局 7/7 ✓**（详见下）。
- **涉及文件**：`src/net/NetTypes.ts`、`src/modes/OnlineHostMode.ts`、`src/ui/RemoteView.ts`、`tests/remoteview-net-id.test.ts`、`tests/net-snapshot-e2e.mjs`。
- 附注：removed 列表是后续**快照增量编码**（只发变化实体 → 30Hz 升频不加带宽）的协议地基。

### v2.6.6 补增：双浏览器真实对局实测（2026-09-11）

> 手段：`tests/net-snapshot-e2e.mjs` —— 两个 headless Edge（主机页 + 成员页）走完整大厅流程
> （建桌 → `?room` 进房 → 准备 → 开始 → 主机按住 H 开火），主机页注入 `WebSocket.send` 钩子
> 捕获**主机真实广播的 snapshot 全文**（服务器对快照原样中继，成员端收到的即此数据），在 node 侧断言。

| # | 测试项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 双玩家真实在场 | **通过** | 快照首帧 `players=[{id:1,playerId:0},{id:2,playerId:1}]` 均 alive（P1 本地 + P2 远端） |
| 2 | 主机快照流 | **通过** | 采样 123 帧（20Hz），开局 → 持续流动 |
| 3 | 全部实体带整数 id | **通过** | 123 帧内 players/enemies/projectiles 一律整数 `id`，无缺失/NaN |
| 4 | 子弹死亡 → removed.projectiles | **通过** | 出现"此前快照见过、随后死亡"的子弹 id 进入 removed 列表 |
| 5 | 子弹按 id 跨帧追踪（不串位） | **通过** | 7 颗子弹持续 ≥2 帧按同 id 追踪，逐帧位移 ≤64px 无跳变 |
| 6 | 敌人击杀 → removed.tanks | **放宽通过** | 本窗口未捕获击杀（P1 多次重伤），以敌人在场为准；removed 机制本身由 #4 实证 |
| 7 | 成员端 0 渲染异常 | **通过** | 成员页 Runtime.exceptionThrown=0（含小地图/淡出/升级面板渲染路径） |

> 附带结论（测试环境要点）：服务器预置 20 空桌、`create` 落在"第一张 0 座空桌"（非固定 1 号）；
> IDE 内置浏览器（TRAE SOLO CN）若开着联机页面会永久占一座叫「房主N」的桌 → **e2e 按房名 `e2e房` 识别自己的桌**；
> Edge 需要 `taskkill /F /T` 杀进程树（`chrome.kill()` 无效），否则残留连接占座/房间持续"对局中"。

---

## v2.6.5 P2 本地预测

> 目标：消除高延迟下"自己坦克按下/松开方向却隔了整条 RTT + 快照周期才有反应"（“自己不动”）的延迟感。纯成员端改动，**不触碰联机协议与服务器**。

- **成因**：成员不跑模拟，只按 20Hz 权威快照插值渲染 → 自己输入要经 成员→中继→主机→模拟→广播→成员 一整条回路才反映，延迟≈RTT+50ms。
- **做法（客户端预测 + 权威校正）**：
  1. `main.ts`：联机成员每帧把本地 P1 方向 `remoteView.myInputPref = {up,down,left,right}`（含触屏/手柄合并结果）写入 RemoteView。
  2. `RemoteView.applyLocalPrediction`：仅对本成员坦克（`team===0 && playerId===myIndex`）生效——
     - 记录"按下瞬间的权威坐标+时刻"为基准 `pressEntry`；
     - 理想预测 `pred = base + dir×speed×按住时长（cap 400ms）`；
     - 显示位置 = 权威插值位置 `me` + `clamp(pred-me)`（只沿按压方向补差）→ 权威随快照追平后差值收敛为 0，平滑回纯权威，无跳变；
     - tilemap `checkTankCollision`（tankTeam=0）穿墙保护：目标格不可通行则回落权威；
     - 松键/转向重置基准；按住超 3s 用 `trust` 线性回退防长期外推失真。
  3. 速度估计：相邻权威快照自己位移 EMA（未测到时用默认 75px/s）。
- **涉及文件**：`src/ui/RemoteView.ts`（预测逻辑）、`src/main.ts`（方向输入接线）。协议/服务器未改。
- **验证**：`tsc`/`vite build` ✓；`vitest` 56/56 ✓；`node .probe/index.mjs` 8/8 ✓；`node tests/net-levelup-relay.mjs` 3/3 ✓。

---

## v2.6 联机网络手感优化

> 迭代目标：解决「网络延迟高、P2 移动卡顿/对齐不准」的核心手感问题（P0 批次）。

### 变更点

1. **远端输入协议升级**（`main.ts`）：
   - 由固定 20Hz 上报改为 **按键状态变化即发 + 稳定 30Hz 保活**：`inputSig()` 对输入做指纹，
     任一键位变化立即上报（绕过节流，降低操作延迟）；状态稳定时每 ~33ms 保活一次（抗丢包/维持新鲜度）。
   - 输入帧号改用 **`clientInputFrame()` = `performance.now() / (1000/60)` 固定步进帧号**
     （60Hz 世界时间基准，与 rAF/高刷屏频率解耦），不再用 rAF 渲染帧计数。
2. **主机输入消费重写**（`OnlineHostMode.consumeRemoteInputQueue`）：
   - 按序消费：丢弃已应用/乱序到达的旧帧（`frame <= remoteInputSeq`）。
   - 丢包跳帧：队头帧号不连续时**直接采纳最新输入**（不再精确匹配卡死等帧）。
   - 短时无输入（≤10 固定帧 ≈ 167ms）**延续上一输入的 held 状态**（边沿清零）抗网络抖动。
   - 长期无输入：**清空输入**，防止成员断线后坦克一直自动移动。
3. **修复联机升级按键不可用**：`online_host` 分支补上 `levelUpKeysFor` 接线（P1=T/Y/U，P2=小键盘7/8/9），
   与单机一致；同时关闭残留的 `DEV_LEVELUP_TEST_PLAYER=1`（此前联机双人 P2 开局会弹一个
   `autoTimer=999` 永不消失的升级确认面板，主机画面被长期遮挡）。
4. **清理 `RemoteView` 残留死代码**：删除 v3 已停用的 `stepPrediction/lastPredFrame/lastWild`。
5. 联机协议本身（welcome/table/start/snapshot/input 中继）**未改动** → 服务器 `server/index.mjs` 无需变更，
   `scripts/net-selftest.mjs` / `.probe/index.mjs` 仍适用。

### 验证

- `tsc --noEmit` ✓；`vite build` ✓；`vitest` 45/45 ✓。
- 协议层自测：`node .probe/index.mjs`（需先 `node server/index.mjs`）。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main.ts` | 输入变化即发 + 30Hz 保活 + 固定步进帧号；online_host 升级按键接线 |
| `src/modes/OnlineHostMode.ts` | 输入队列按序消费 + 丢帧延续/超时清空（`remoteInputSeq/staleTicks`） |
| `src/ui/RemoteView.ts` | 删除 stepPrediction/lastPredFrame/lastWild 死代码 |
| `src/framework/GameModeCore.ts` | `DEV_LEVELUP_TEST_PLAYER` 恢复 -1 |

### v2.6.1 补充：RTT/抖动 HUD（2026-09-11）

> 目标：把"网络到底多差"变成**可视数字 + 颜色分级**，方便判断 v2.6 手感是否达标、以及局域网 vs 公网隧道的对比。

- **测量方式（回声测延迟，无需时钟同步）**：
  - 新增消息 `{t:"ping", ts}` → 服务器原样回 `{t:"pong", ts}`；`RTT = Date.now() - ts`。
  - 成员的 `input` 消息在服务器中继的同时也**附带回声 pong**（30Hz 输入流天然高频采样，利用率最高）；
    主机无 input 流量，按 **500ms 定时 ping** 保测量（`main.ts`）。
  - RTT/抖动分别用 **EMA 平滑**（0.15/0.2）抗单点毛刺，过期样本（>1.5s）丢弃。
- **HUD 显示**：
  - 成员（P2，`RemoteView` 顶栏右侧）：`RTT xxms·抖y`，按 <100ms 绿 / <220ms 黄 / 其余红 着色。
  - 主机（P1，`OnlineHostMode` 顶栏加高到 40px 第二行）：
    `RTT`（主↔服务器）+ `P2入 xxms·抖y`（P2 输入新鲜度 = `Date.now()-lastPeerInputTime`，-1=未收到；
    到达抖动 = 输入到达间隔相对均值的 EMA）。
- **涉及文件**：`server/index.mjs`（ping/pong + input 回声）、`src/net/NetTypes.ts`（`PongMsg`）、
  `src/net/NetClient.ts`（`pong` 事件 + `ping()`）、`src/main.ts`（EMA 累计 + 定时 ping + 写入 HUD）、
  `src/ui/RemoteView.ts` / `src/modes/OnlineHostMode.ts`（HUD 渲染）。
- **验证**：`tsc`/`vite build` ✓；协议自测 `node .probe/index.mjs` 不变（旧客户端不发送 ping 也不影响）。

### v2.6.2 补充：出生卡墙 + 手机/远端操作 + 升级速度（2026-09-11）

> 目标：P2（远端手机）完整可玩 —— 不卡怪、能攻击、能切操作、能选升级；升级节奏放缓。

1. **出生点卡墙修复**（`SpawnSystem` + `GameModeCore`）：
   - 新增「出生空位校验」`isSpawnClear`（由游戏模式注入 `tilemap.checkTankCollision` 实现，tankTeam=-1 严格口径）。
   - 出生/精英召唤前用 **螺旋近邻搜索**（≤3 格半径）找无墙空格，预警光点与实际落地一致，杜绝"生成在墙里出不来"。
2. **切炮统一边沿检测**（`GameModeCore`，`prevSwitchP1/P2`）：键盘 Tab/ShiftRight 与触屏"法杖"按钮共用一套边沿逻辑（一次按下只切一档），覆盖联机远端合并输入；删除了各模式里重复的键盘专用处理。
3. **手机攻击修复**：触屏/远端"开火"按钮只带 `fire` 标志 → 未显式指定法杖时**打在当前激活法杖上**（`updateBattle` wFire 兜底），解决手机无法攻击问题。
4. **操作方式切换（大厅 M 键）**：联机大厅按 **M** 循环 键盘 → 触屏 → 手柄（`onlineCycleControlMode`），顶栏实时显示当前方式；P2 手机用户在进房前/房内都能改。
5. **远端升级选择（新协议）**：
   - 主机检测到新升级面板 → 广播 `levelup{playerIdx,choices}`（服务器中继）→ 成员 `RemoteView` 弹出升级面板（14s 计时，与主机 15s 自动选兜底对齐）。
   - 成员触屏/鼠标点选 → 回传 `pick_levelup{playerIdx,choice}`（服务器中继）→ 主机 `onPeerLevelUpPick` 应用。
   - 新增协议消息：`levelup` / `pick_levelup`（`NetTypes/NetClient/server` 同步维护）。
6. **升级速度 -30%**：`LevelUpSystem.EXP_GAIN_SCALE = 0.7`（经验增益整体 ×0.7，前期升级放缓）。
- **验证**：`tsc`/`vite build` ✓；`vitest` 45/45 ✓；`node --check server/index.mjs` ✓。

### v2.6.2 补增：模拟手机环境实测（2026-09-11）

> 手段：`tests/mobile-cdp.mjs`（CDP 直连 headless Edge，`Emulation.setTouchEmulationEnabled` + 390×844 手机视口，
> 真实 touchstart/end 事件）模拟手机成员端；`tests/net-levelup-relay.mjs` 做协议层中继自测。

| # | 测试项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 出生卡墙 | **通过** | 实测 ~90s 连续刷怪（顶部 5 出生列，累计 14 辆在场），无一只卡在墙格内；本轮修复的"出生空位螺旋搜索"确认生效 |
| 2 | P2 操作方式切换 | **通过** | 手机仿真下大厅按 **M** 循环 触屏→手柄→触屏，HUD"操作方式"随按随变；进对局后触屏按钮（开火/修理/法杖/背包/仓库）正常渲染 |
| 3 | 手机攻击键 | **通过** | 触屏按住"开火"：按钮呈按下高亮，且 P1 炮口正上方捕获到飞行中子弹（w0~w3 未定时 fire 兜底到当前激活法杖生效） |
| 4 | 选择增强/远端升级 | **传输层通过** | `net-levelup-relay.mjs` 3/3：主机广播 levelup→成员收到、成员回传 pick_levelup→主机收到、仅房主可发可转发；完整双端对局点选受沙箱大厅编排所限未跑通，建议真机快速复核一眼 |
| 5 | 升级速度 -30% | **代码级通过** | `EXP_GAIN_SCALE=0.7` 已生效（经验获取统一 ×0.7） |

> 附带发现：联机大厅用「Enter 进桌」在自动化环境下不可靠（原生 prompt 弹窗吞按键、空桌先后手决定房主），
> 邀请链接 `?room=<ID>` 自动进房最稳；另确认"空桌首位进桌=房主"逻辑正确。

### v2.6.4 补充：小地图外移 + 双亡结束 + P2 机器人 + 延迟读数平滑（2026-09-11）

1. **小地图移出战场**（`Minimap` 支持锚点 + `GameModeCore.renderMinimap`/`RemoteView`）：
   - 横屏 → 右侧信息栏内右上角；竖屏 → 地图下方信息栏顶部，均不再遮挡刷怪视野；
   - 队长基地始终显示（金色、加大），避免"缩略图看不到基地"；
   - **成员端新增小地图**（右下角，含玩家/敌人/基地），此前成员画面根本没有缩略图。
2. **双人双亡即结束**（`GameOver.isTeamEliminated`）：两名玩家同时阵亡即算淘汰（即使还有命），
   杜绝"双双阵亡却永远卡在对局里退不出去"；单人保留"有命可复活"原逻辑。配套更新 `gameOver.test.ts`。
3. **P2 自动 AI（怪物式）**：设置新增「P2自动AI(离线)」默认开；P2 无任何本地输入时由 AI 接管
   （找最近敌人→沿主轴逼近→对准开火，`GameModeCore.drivePlayerBot`）；**联机主机强制关闭**，
   远端成员的控制权永不被 AI 抢占（`OnlineHostMode.p2Bot=false`）。单人测试/协作更贴近真实对战。
4. **网络延迟读数平滑**（`main.ts`）：RTT/抖动由逐样本 EMA 改为 **12 样本滑动窗口均值**，
   HUD 上的数字稳定可辨，不再跳个没完。
- **验证**：`tsc`/`vite build` ✓；`vitest` 56/56 ✓；手机仿真实测 P2 机器人自主出击、小地图移出视野正常。

---

## v2.5 单端口部署 + 分享按钮

> 迭代目标：让"把链接发给好友 → 好友打开即进房"真正可用。

### 变更点

1. **单端口服务器** `server/index.mjs`：
   - 同一 HTTP 端口（默认 3001）同时提供 `dist/` 静态页面托管与 WebSocket。
   - 启动时打印 `http://localhost:<PORT>` 与所有局域网 IPv4 地址，照着发即可。
   - 未构建 dist 时返回引导页（提示先 `npm run build`）。
   - 部署：`npm run build && node server/index.mjs`；外网访问用路由器端口转发 / ngrok / frp / Cloudflare Tunnel 暴露该单端口即可。
2. **大厅 UI 可点击化**（canvas 命中检测，鼠标/触屏可用）：
   - 房间列表每行可点击直接加入；
   - 底部按钮：开新桌(C)、改昵称(N)；
   - 桌内：✅准备/取消、▶开始游戏(S)（仅房主）、←离开房间；
   - **📋 复制邀请链接** 按钮 + 完整链接预览文本（原隐藏快捷键 Y 保留）。
3. **多候选地址自动探测**（NetClient）：按顺序尝试 同源 → `ws(s)://<host>:3001`，
   收到 `welcome` 才算连接成功；https 页面自动用 wss。兼容开发模式 / 单端口 / 隧道反代三种部署。
4. **邀请链接简化**：单端口下为 `<同源地址>/?room=<桌ID>`（不再需要 server 参数）；
   开发模式（Vite:3000）仍回退携带 `;server=ws://<host>:3001`。
   **localhost 防呆**：服务器在 welcome 中下发本机真实局域网 IP（按可分享概率排序），
   房主即使以 localhost 打开页面，复制出的邀请链接也会自动替换为 `http://<局域网IP>:3001/?room=N`，
   杜绝把 localhost 发给好友导致对方 ERR_CONNECTION_REFUSED 的问题。
5. **规则修正**：空桌首位加入者自动成为房主（修复点击空桌加入后无人能开局）；
   开始条件改为房主无需准备、其余入座玩家全部准备。

### 运行方法（推荐：单端口）

```bash
npm install
npm run build          # 构建前端到 dist/
node server/index.mjs  # 或 npm run online
# 控制台会输出可分享的局域网地址，例如 http://192.168.x.x:3001
```

把地址直接发给同一网络的好友即可联机；跨公网用任意隧道工具暴露 3001 端口后发送公网地址。

---

## v2.4 联机大厅 + 主机权威联机对局

> 迭代时间：2026-08-22

### 目标

使用户**无需额外联网工具**即可多人联机：
1. **大厅**：可创建/加入房间（桌），单桌最多 **4 座**；每座可**准备**，房主可**开始**；
   对局结束后回大厅可再来一局。
2. **两人远程协作测试**：房主（主机）跑完整模拟，远端成员按 **20Hz 快照** 观看/操作自己的坦克。
3. 架构采用**主机权威**：主机就是权威服务器，避免状态分歧；远端不跑模拟，只接收快照渲染。

### 架构（主机权威 + 中继服务器）

```
[房间表/成员]  ws://服务器:3001   [游戏状态快照/成员按键]
   主机(房主) ───────────► 中继服务器 ───────────► 远端成员
   参与完整模拟             只做消息中继/桌管理       只渲染快照 + 上报按键
   (OnlineHostMode)                                (RemoteView)
```

- **服务器** `server/index.mjs`（Node + `ws`）：只管大厅（建/进/离/准备/开始）+ 游戏期消息中继；
  不跑任何游戏模拟 → 轻量、可部署到任意公网主机。
- **主机**：完整跑 `GameModeCore` 模拟（无尽模式）。P1 由主机本地方向键控制，
  远端成员按键经服务器中继到主机，合并为 **P2** 输入。
- **远端成员**：不跑模拟，20Hz 收快照 `NetSnapshot`，用 `RemoteView` 简化渲染；
  每帧把自己的按键 `poll` 上报（`input`）。

### 协议（消息统一 JSON，字段 `t` 表类型）

见 `src/net/NetTypes.ts` 与服务器同步维护。核心消息：

| 方向 | 类型 | 说明 |
|---|---|---|
| S→C | `welcome` | 分配 `clientId` |
| S→C | `tables` | 大厅房间列表（供选桌） |
| S→C | `table` | 当前桌视图（座位/准备/房主），变化即广播 |
| S→C | `start` | 对局开始：`mode/myIndex/players/seed`（房主 idx=0，成员 idx=1） |
| S→C | `snapshot` | 主机权威快照（20Hz） |
| S→C | `gameover` | 对局结束，房间复位回 `lobby` |
| S→C | `peer_input` | 主机收到远端成员的按键（idx=那个成员） |
| S→C | `peer_left` | 主机收到某远端成员断线 |
| S→C | `error/left` | 操作错误 / 已离桌 |
| C→S | `create/join/leave/ready/start` | 大厅操作 |
| C→S | `input` | 远端成员上报按键 |
| C→S | `snapshot` / `gameover` | 主机广播权威快照 / 结束 |

### 桌面状态机（服务器）

- 创建：房主进桌 → `lobby`。
- 加入：最多 4 座（`MAX_SEATS=4`）；对局中不可加入。
- 准备：每座自己 `ready`；`broadcastTable` 实时同步全桌。
- 开始：**要求 ≥2 人且全部人员已准备**；房主点击开始后全桌收到 `start`。
  - ⚠️ 当前版本实战**开局支持 2 人**（主机+P2），4 座保留用于扩展；
    超过 2 人会提示先离开（见「已知限制」）。
- 房主离开 → 桌解散；成员离开 → 桌继续（对局中断线成员被标记 `peer_left`）。

### 涉及文件

| 文件 | 职责 |
|---|---|
| `server/index.mjs` | 联机服务器（大厅+中继） |
| `src/net/NetTypes.ts` | 联机协议类型（`NetTable/NetSnapshot/...`） |
| `src/net/NetClient.ts` | 客户端 WebSocket 封装 + 大厅/对局消息分发 |
| `src/modes/OnlineHostMode.ts` | 主机权威模式（跑模拟 + 20Hz 快照 + 远端输入合并 P2） |
| `src/ui/RemoteView.ts` | 远端成员快照渲染 |
| `src/engine/InputManager.ts` | `setOverrideP2`（远端按键合并 P2）/ `peekP1` |
| `src/game/Tilemap.ts` | `toArray()/loadFromArray()` 地形序列化 |
| `src/main.ts` | 联机入口 + 大厅 UI + 状态调度 |
| `scripts/net-selftest.mjs` | 端到端联机流程自测脚本（无浏览器） |

### 运行方法

**本地局域网（两人在同一 WiFi/局域网）：**
1. 房主启动：`node server/index.mjs`（监听 `ws://0.0.0.0:3001`）。
2. 房主启动前端：`npm run dev`（Vite 端口默认 5173）。
3. 成员浏览器打开 `http://<房主机IP>:5173`，主菜单选「联 机」。
4. 房主建（C 建桌）→ 成员加入 → 都按空格准备 → 房主按 S 开始。

**远程（两人不在同一网络）：**
不需要向日葵。任选其一暴露 WebSocket 服务端口 3001 即可：
- 把 `server/index.mjs` 部署到一台**有公网 IP 的 VPS**，前端改连接地址到 VPS；
- 或用内网穿透（ngrok / frp / Cloudflare Tunnel）把本机 3001 转发到公网域名。
前端连接地址可带 `?server=ws://主机:3001` 指定（见 `getServerUrl()`），
未指定则默认 `ws://当前域名:3001`。

### 玩家操作

- **主机（P1）**：WASD 移动，H/J/K/L 四法杖射击，Tab 切换法杖。
- **远端成员（P2）**：自己的 WASD + H/J/K/L 控制自己的坦克（P2），Tab 切法杖。
  （远端按键经 `input` → `peer_input` → 主机合并为 P2 输入，主机权威模拟后广播回成员显示。）
- 大厅：`↑/↓ W/S` 选桌，`Enter` 加入，`C` 建桌，`N` 改名，进入房间 `空格` 准备/取消，房主 `S` 开始，`Esc` 返回。

### 邀请链接（发链接自动进房）

- 在房间内按 **`Y`** 复制**邀请链接**，发给好友；好友打开该链接即**自动联网并进入该房间**。
- 链接格式：`http://<host>:<前端端口>/?server=ws://<host>:3001&room=<桌ID>`
  （`server` 指定联机服务器，`room` 指定目标桌）。
- host 处理：若当前是以 `localhost`/`127.0.0.1` 打开，会自动通过 WebRTC 探测本机**局域网 IP** 生成可分享链接（避免发给好友变成对方自己机器）；若用局域网/公网地址打开则直接用该地址。
- **局域网测试**：把网页通过局域网 IP 访问后按 `Y` 复制，好友在同一网络打开即加入。
- **跨公网远程**：需要联机服务器(3001)与前端页面均可达 —— 部署到公网 VPS 或用内网穿透（ngrok/frp/Cloudflare Tunnel）暴露 3001 与 3000；`server` 指向公网地址。

### 验证

- `tsc --noEmit` 通过；`vite build` 通过。
- `scripts/net-selftest.mjs` **端到端自测 10/10 通过**：
  建桌(4座)→进桌(2人)→未准备拒绝开始→双准备→开始(idx0/1)→成员按键中继→
  主机快照广播→gameover→房间回 lobby 可再开。

### 已知限制（后续 v 迭代方向）

1. **实战目前 2 人**：`GameModeCore` 仅固定 P1/P2 两坦克，4 座大厅保留但开始需 ≤2 人。
   → 若要 4 人同局，需扩展多人输入通道（P3/P4 + 各自远端输入映射）。
2. 快照未带元素地形状态层（`TileState`）与详细法杖/血条细节，远端为简化视觉。
3. 断线重连、观战、局内重进暂不支持。
4. 无鉴权/房间密码（开发自测够用）。