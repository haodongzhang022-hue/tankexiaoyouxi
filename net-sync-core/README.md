# net-sync-core · 跨引擎网络同步通用资产

> 资产定位：把「主机权威 + 快照增量 + 自适应插值 + 心跳/RTT + 断线重连 + 主机迁移」这一套网络同步机制固化为**语言无关的通用模块**，通过「对接表（Schema）」驱动；项目接入只需填一张表 + 写一个适配器，即可在 Web / Cocos(TS) / Unity(C#) / UE(C++) 间复用同一套机制。
>
> 约定：**对接表（单一事实源）在 `schema.ts`；通用机制在 `core.ts`；传输可插拔在 `transports.ts`；项目差异全部收敛在 `adapters/`**。坦克大战已填好一份完整参考实例 `adapters/tank-adapter.ts`（背包/经验/金币/等级/基地/检查点全量覆盖）。
>
> 版本：2026-09-12 v1.0.0（首次固化，交叉等价自测确认）。**最新版本最高权重**，历史节保留参考。

---

## 1. 是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 跨项目复用的**通用同步机制**（机制层） | 通信底层（WS/UDP 收发，那是传输选择；本模块只定义 Transport 接口） |
| 填表驱动的**契约资产**（对接表=待填写表单） | 游戏引擎 SDK / 渲染层（渲染由各端自己接） |
| 已验证行为的**通用化**（坦克 v2.6~v2.12 机制在此，行为等价） | 分布式服务器 / 房间大厅 / 匹配（大厅由项目各自实现） |

适用规模：小规模主机权威（2~多人一桌，单房主模拟全网快照）——正是坦克大战、小型协作/竞技项目形态。

## 2. 目录结构

```
net-sync-core/
├── schema.ts                  # 对接表模型 + 校验（语言无关契约定义）
├── core.ts                    # 通用同步核心（零引擎依赖，浏览器/Node 皆可）
│   ├── SyncCodec              快照增量编解码（schema 驱动）
│   ├── Interpolator           自适应插值缓冲（v2.6.7 算法）
│   ├── lerpEntity             通用实体插值
│   ├── LatencyTracker         RTT/抖动测量
│   ├── ReconnectManager       断线重连（凭令牌回位）
│   ├── pickSuccessorHost      主机迁移（接替选择）
│   ├── Transport              (interface) 可插拔传输
│   └── SyncEngine             编排：传输+codec+插值+心跳+事件
├── transports.ts              # 传输实现：WsTransport / RtcTransport（可加 UDP/TCP）
├── adapters/
│   └── tank-adapter.ts        # 项目实例：坦克（对接表已填 + 状态转换函数）
└── tests/
    └── sync-core.test.ts      # 自测（含与坦克旧实现交叉等价断言）
```

## 3. 接入流程（五个步骤，跨项目通用）

新项目（Unity/Cocos/UE/另一个网页项目）接入本资产：

1. **填对接表**：`adapters/<project>-adapter.ts` 中声明一份 `SyncSchema`
   - `entities`：要同步的实体种类 + 字段（位置/血量/朝向…）与同步模式（eq 变化才发 / always 每帧全量 / none 携带不参与 diff）
   - `scope`：全局小状态（分数/波次/经验钱包/背包/基地…）
   - `payload`：首帧大数据（地图…）
   - `events`：升级 / 商店 / 结束 / 信令…
   - `checkpoint`：快照未携带的重状态（等级/背包/装备…）
   - `interp` / `reconnect` / `heartbeatMs` / `transport`：机制参数
2. **校验**：`validateSchema(schema)` → 空数组即通过（ID 字段缺失、种类重复等在此暴露）
3. **接传输**：项目已有 WS/RTC 连接时，包一层 `WsTransport`/`RtcTransport`（或按 `Transport` 接口实现 UDP/TCP）
4. **接引擎**：`new SyncEngine(schema, transport, hooks)`，hooks 提供 `worldToState()`（主机）与 `onState()`（成员，喂你的渲染）+ `onEvent()`
5. **绑定插值**：成员端用 `SyncEngine.interp` 缓冲解码状态，`pair()` 取插值对，`lerpEntity` 按数值字段插值渲染

### 3.1 通用核心的路由（同一文件内参数控制，不复制实现）

- 主机路线：项目主循环调 `engine.hostTick()`（每 1/30s 一次即 30Hz）→ 编码 + 按传输偏好发送（WS 兜底 + P2P 双发）
- 成员路线：`engine.handleMessage(raw)`（任意通道）→ 帧号去重 → 解码 → `onState`
- 增量策略：`SyncCodec` 依 schema 自动「首帧全量 / 增量 / 关键帧 / alwaysFull / 轻量帧」

## 4. 对接表字段说明（填表字典）

- **FieldType**：`int | float | string | bool | enum | object | array`（跨端序列化器一致）
- **SyncMode**：`eq`（变化进增量帧，主开销）/ `always`（每帧全量，无稳定 ID 的短命对象用）/ `none`（低频常量，随记录携带）
- **EntityKind.idField**：稳定 ID 字段（全局唯一、跨帧不变）——成员端按此匹配插值 / 检出消失。无稳定 ID 的实体（掉落/道具）用 `alwaysFull=true` 整组每帧替换。
- **keyFrameEvery / forceFullRatio**：防丢包累积错乱——每 N 帧强制全量；单类变化超比例强制全量。
- **checkpoint**：断线重连 / 主机迁移后，仅靠快照恢复不了的状态（武器/等级/背包/升级旗标），周期性完整广播，成员保存最新一份用于接替。

## 5. 坦克大战实例（参考填法，`adapters/tank-adapter.ts`）

| 对接内容 | 声明位置 | 对应旧协议 |
|---|---|---|
| 玩家/敌人（坦克） | `entities[0].kind="tank"`，diff 集=旧 `sameTank` 比较集 | `NetTank` |
| 子弹 | `entities[1].kind="projectile"` | `NetProjectile` |
| 掉落 / 道具 | `alwaysFull` 种类 | `NetLootDrop` / `NetPowerUp` |
| 分数/波次/钱包/背包 | `scope`（`wallets`=每玩家经验金币、`bp`=每玩家背包视图） | `NetSnapshot.scope` |
| 基地 | `scope` 内嵌 `base` | `NetBase` |
| 地图 | `payload.map`（仅首帧携带） | `NetSnapshot.map` |
| 升级 / 商店 / 结束 / 检查点 / 信令 | `events` | `LevelUpMsg` 等 |
| 武器/等级/背包重状态 | `checkpoint` | `CheckpointPlayer` |
| 插值参数 | `interp` = `{delayMin:30, delayMax:200, adaptive:true, stepMs:34, catchUpMult:2.2, backoffMult:0.6}` | `RemoteView` v2.6.7 |
| 重连 | `reconnect.tokenKey="tank_rejoin_v1"` | v2.11 重连卡 |
| 迁移 | `pickSuccessorHost()`（最靠前在场非房主接替） | v2.12 `migrateHost` |
| 双发 | `transport.dualSend=true`（P2P + WS，先到先渲染） | v2.10 快照双发 |

### 旧实现 ↔ 模块 API 映射（坦克未来接入的替换指南）

| 旧（src/net/ 与 src/ui/） | 模块 API |
|---|---|
| `SnapshotDeltaCodec` | `SyncCodec`（schema 驱动，行为经交叉等价测试一致） |
| `RemoteView` 缓冲/推进/找插值对 | `Interpolator.push/advance/pair` + `lerpEntity` |
| `NetClient` 消息分发 | `SyncEngine.handleMessage` + hooks |
| RTT 统计（main 的 netRtt/净Jitter） | `LatencyTracker` / `engine.rtt/jitter` |
| 重连卡（localStorage） | `ReconnectManager(KVStorage, tokenKey)` |
| 主机迁移选择逻辑（server 端） | `pickSuccessorHost`（服务端同理可复用） |

> 说明：v1.0.0 采用「新增通用模块 + 交叉等价验证」策略，**未改动生产运行代码**（v2.12 已在产，避免回归）。坦克项目后续可选将 src/net 迁到模块驱动（迁移步骤见 §6），或作为新项目（Cocos/Unity）的首选同步层。

## 6. 迁移路线（坦克项目接入模块，可选，按需执行）

1. `main.ts` 联机分支：`SnapshotDeltaCodec` 替换为 `SyncCodec` + `netSnapshotToState`/`stateToNetSnapshot`
2. `server/index.mjs` `migrateHost`：替换为 `pickSuccessorHost`（逻辑等价）
3. 重连卡存取：替换为 `ReconnectManager`
4. RTT：替换为 `LatencyTracker`
5. 回归：`tests/net-snapshot-e2e.mjs`（ids/interp/migrate）+ relay 自测 + vitest 全绿后再上线

## 7. 跨端生成指引（Unity / Cocos / UE）

> 本资产 v1.0.0 交付「机制 + 契约 + TS 实例」；C#/C++ 端按接入流程实现同一机制（引擎核心逻辑一致，语言层各自实现）。

- **Cocos（TS）**：可直接复用整个 `net-sync-core/`（TS 源码），仅替换 `adapters/` 里的适配器与传输接入。
- **Unity（C#）**：以 `schema.ts` 为契约，手写或生成 C# 对应类型（`FieldSpec/SyncSchema` 结构 + 编解码/插值/延迟/重连/迁移的同构实现）；接口对齐 `core.ts` 的类名与钩子。
- **UE（C++）**：同上，生成 C++ struct + 同构实现；序列化走项目二进制协议或扩展 `transports.ts` 的 UDP/QUIC。

## 8. 测试与验证

- `npx tsc --noEmit`：全工程类型检查（模块纳入 `tsconfig.include`）
- `npx vitest run`：86/86 通过（原有 70 + 模块 16），含**交叉等价**：同一快照序列下模块与旧 `SnapshotDeltaCodec` 的全量/增量决策与解码结果一致

## 9. 版本历史

- **v1.1（2026-09-12）**：**已接入坦克网页端生产（3001）**。主机快照编码（`OnlineHostMode` → `SyncCodec`）、成员解码（`main.ts` → `SyncCodec` + `stateToNetSnapshot`）、插值缓冲（`RemoteView` → `Interpolator`，对外 API 不变）、重连卡（→ `ReconnectManager`）、RTT（→ `LatencyTracker` window 路线）全部由模块驱动；`LatencyTracker` 收敛 ema/window 两路线于同一文件。协议升级为 schema 驱动 `kinds` 结构（服务器无感），e2e 工具同步更新。**抖动专项实测**（`tests/net-jitter-e2e.mjs` + `net-jitter-proxy.mjs`，WS 代理注入 33↔180ms 到达间隔抖动）：稳定期 delay 31ms → 抖动期 117ms（自适应加深缓冲防卡顿）→ 恢复 32ms，全程渲染 100% 推进、0 异常。验证：tsc ✓ / build ✓ / vitest 86/86 ✓ / relay 17 项 ✓ / e2e ids·interp·migrate 全绿 ✓。
- **v1.0.0（2026-09-12）**：首次固化。从坦克 v2.6~v2.12 实战沉淀：快照增量（v2.8 等价）、自适应插值（v2.6.7 等价）、断线重连（v2.11 等价）、主机迁移（v2.12 等价）、P2P 双发（v2.10 等价）；新增「对接表 + 适配层」解耦；新增 `transports.ts` 可插拔传输；新增自测 + 交叉等价断言。