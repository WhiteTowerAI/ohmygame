# Google Playground 风格多人游戏实现方案

## 1. 文档目的

本文为 OhMyGame 增加一种类似 Google Playground 的 Web 游戏发布能力：用户打开发布链接即可游玩，设计者可以选择单人、回合制多人或实时多人；游戏可以创建房间、通过邀请链接加入，并在刷新、断线和服务重启后按产品规则恢复。

本文把“Google Playground”理解为一种发布体验和多人游戏能力，而不是复制某个未公开的内部实现。目标是保留当前项目的静态发布能力，同时增加可选的公开游戏后端。

## 2. 当前项目基线

当前仓库的渲染器通过 HTTP 和 SSE 与本地 Fastify daemon 通信，daemon 负责项目、预览、资源和发布；它默认监听本机回环地址，不是面向玩家的多人游戏服务器（见 [docs/README.md](README.md) 和 [src/daemon/server.ts](../src/daemon/server.ts)）。

发布流程只上传静态构建产物，发布后的玩家从 `manifest.json` 加载游戏定义和资源；当前玩家状态保存在浏览器本地，没有房间 ID、玩家身份、服务器权威状态或游戏 WebSocket（见 [runtime.md](runtime.md#publishing) 和 [published-player.tsx](../src/renderer/published-player.tsx)）。

因此，多人能力应作为发布协议的可选扩展和独立服务实现：单人游戏继续只依赖静态资源，多人游戏才连接游戏服务。

## 架构决策（第一版）

- **第一版直接加入 Colyseus**。不先做一套临时 HTTP/SSE 多人协议，再迁移到 Colyseus。
- **回合制和实时多人统一使用 Colyseus 房间和 WebSocket**。回合制只是消息频率较低、状态推进由命令触发，不需要另写一套通信层。
- **复用项目现有的 Supabase Auth**。设计者在项目中登录的账号和发布后用于多人身份的账号来自同一个 Supabase 项目；游戏是否强制登录仍由 `authPolicy` 决定。
- **HTTP 只负责控制面**，例如获取发布配置、登录、创建房间、公开房间列表和故障后的完整快照；进入房间后的命令和状态同步统一走 Colyseus WebSocket。
- **现有 SSE 保留给本地 daemon 的运行事件**。它服务于编辑器和预览，不作为发布游戏的多人通信协议。

## 3. 目标和范围

### 3.1 目标

- 发布链接在桌面和移动浏览器中可直接打开。
- 设计者可为每个游戏选择单人、回合制多人或实时多人。
- 支持公开房间、邀请码房间和邀请链接。
- 支持游客身份，也支持可选的账号登录；是否强制登录由游戏配置决定。
- 服务器校验所有改变游戏状态的操作。
- 支持刷新、短暂断网、重复点击、重复提交和版本切换等常见情况。
- 在 Railway 上运行，先支持单实例，再为多实例保留扩展路径。

### 3.2 暂不包含

- 跨游戏的统一好友、聊天、排行榜和支付系统。
- 需要 UDP 或专用游戏引擎的高频竞技游戏。
- 把现有本地 daemon 直接暴露到公网。
- 在没有压测数据时承诺固定的单实例人数。

## 4. 总体架构

```text
浏览器
  ├─ 静态游戏资源：Cloud/Publish CDN
  └─ 多人 SDK
       ├─ 控制面：HTTPS API
       └─ 回合制和实时：Colyseus WebSocket
              │
              ▼
      Multiplayer Service（Node.js + Colyseus）
       ├─ 房间生命周期和匹配
       ├─ 权威游戏状态和操作校验
       ├─ 回合计时、断线和重连
       ├─ Redis：在线状态、跨实例 Presence、短期房间数据
       └─ PostgreSQL/Supabase：账号、游戏、房间记录、回合历史
```

Railway 可以托管 Node.js/Colyseus 服务和公开 WebSocket。初期使用一个服务实例和一个进程；需要多实例时，再增加 Redis Presence/Driver，并让负载均衡和房间分配配合使用。静态发布服务、多人服务和本地 daemon 使用不同的职责和凭证。

Colyseus 可以自主处理房间创建、加入、离开、匹配、WebSocket 连接、Schema 状态同步、消息分发和基础重连。它不会替游戏决定回合规则、胜负、权限、Supabase JWT 校验、数据库持久化、发布版本隔离或滥用限制；这些仍属于多人服务和游戏适配器的职责。

## 5. 发布协议扩展

现有发布产物继续包含 `index.html`、`manifest.json`、游戏定义和资源。对多人游戏，在 manifest 中加入可选字段：

```json
{
  "multiplayer": {
    "enabled": true,
    "mode": "turn-based",
    "gameId": "game_123",
    "deploymentId": "deployment_123",
    "protocolVersion": 1,
    "serverUrl": "https://game-api.example.com",
    "authPolicy": "guest-or-account",
    "roomPolicy": "invite-or-public",
    "maxClients": 8,
    "reconnectSeconds": 120
  }
}
```

字段含义如下：

- `mode`：`single-player`、`turn-based` 或 `realtime`。
- `gameId`：发布的逻辑游戏 ID，不使用某一次部署的临时 URL。
- `protocolVersion`：服务器与客户端的协议版本，用于拒绝不兼容的旧客户端。
- `authPolicy`：`anonymous`、`guest-or-account` 或 `account-required`。
- `roomPolicy`：公开匹配、邀请码加入或仅邀请链接。
- `maxClients`：房间保护上限；不应把“没有产品限制”理解为没有运行保护。
- `reconnectSeconds`：断线后保留座位和状态的时间。

发布部署必须绑定一个不可变的 `deploymentId`。房间创建时记录部署版本；游戏更新后，旧房间继续运行旧版本，禁止把新旧协议混在同一房间。

## 6. 房间和账号模型

### 6.1 核心数据

```text
User
  id, provider, displayName, createdAt

Game
  id, publisherId, activeDeploymentId, multiplayerConfig

Room
  id, gameId, deploymentId, mode, status, ownerId,
  joinCodeHash, maxClients, createdAt, lastActivityAt

RoomMember
  roomId, playerId, userId?, seat, role, status,
  joinedAt, lastSeenAt, reconnectTokenHash

Turn / Command
  id, roomId, sequence, actorId, commandType,
  payload, serverTime, resultHash, createdAt
```

Redis 保存运行中的房间状态、连接和短期重连信息；PostgreSQL/Supabase 保存需要跨重启、审计或查询的内容。单实例 MVP 可以先用进程内状态，但必须接受进程重启会丢失未持久化房间的事实。

### 6.2 登录策略

项目当前的登录上下文由 Supabase Auth 提供：渲染器从 Supabase 会话获取 access token，并同步给云端服务（见 [auth.tsx](../src/renderer/auth.tsx)）。多人服务应复用这个 Supabase 项目和 JWT 校验规则，而不是再创建一套账号表和登录页面。

登录不是多人游戏的必选项。推荐默认使用游客身份：首次打开时可调用 Supabase Anonymous Sign-Ins，或者由多人服务签发短期 guest token。用户输入昵称后即可创建或加入房间。需要跨设备、找回长期数据、社交关系或反作弊时，再要求用户完成现有的 Supabase OAuth 登录。

同一个 Supabase 用户可以同时是项目设计者、社区发布者和游戏玩家；多人服务只额外保存 `RoomMember`、座位、昵称和游戏进度。账号权限仍要分开判断：能编辑或发布游戏，不代表能读取其他房间的状态。

发布游戏的登录策略如下：

- `anonymous`：只允许游客，服务不要求 Supabase 正式账号。
- `guest-or-account`：游客可以开始，用户可在游戏中升级到现有项目账号。
- `account-required`：加入房间前必须使用现有项目登录。

多人服务验证 Supabase JWT 的签名、过期时间、发行方和用户 ID。它不能信任浏览器传来的 `userId`，也不能把本地开发用的 debug token 当作生产凭证。

游客升级为账号时，需要把 guest player、房间历史和成就绑定到正式用户，并处理账号已绑定其他游客身份的冲突。不要把 Supabase 的前端 token 当作游戏状态权限；每次加入房间都应由多人服务验证 token、游戏 ID、部署版本和房间权限。

## 7. 回合制多人实现（仍使用 Colyseus）

回合制不要求所有玩家持续在线，但玩家进入房间后的通信仍使用 Colyseus WebSocket。服务器保存房间状态和当前回合，玩家在自己的回合通过 Colyseus message 提交一次带幂等键的操作：

```ts
room.send("command", {
  commandId: "client-command-123",
  expectedSequence: 41,
  type: "play-card",
  payload: { cardId: "c7" },
});
```

服务器按以下顺序处理：校验 WebSocket 会话、身份和座位、校验房间版本、确认是否轮到该玩家、校验命令参数、在事务中写入命令并推进状态、广播新序号和状态摘要。重复提交同一个 `commandId` 必须返回第一次的结果；序号落后时发送冲突事件，客户端重新接收 Colyseus 状态快照。

Colyseus 的状态同步和重连机制负责把最新状态送回重新连接的客户端。玩家离线时房间仍可推进的规则必须由设计者明确，例如自动跳过、超时判负、AI 接管或无限等待。所有计时都以服务器时间为准，客户端倒计时只用于显示。

回合制使用 WebSocket 的原因是通信层和房间层可以与实时模式完全一致：客户端只维护一个房间 SDK，服务器只维护一套身份、状态、重连、错误和版本协议；回合制的低频并不会因为使用 WebSocket 而增加业务复杂度。WebSocket 也允许服务器在玩家离线前及时发送回合变化，减少轮询和状态竞态。

## 8. 实时多人实现

实时模式与回合制共用 Colyseus 房间和 WebSocket，只是状态更新由固定 tick 和玩家输入驱动：

1. 客户端通过 Colyseus SDK 创建、匹配或加入房间；需要展示公开列表时才调用 HTTPS 控制面 API。
2. 服务端验证 Supabase/guest token，返回房间 ID、连接令牌和当前部署版本。
3. 客户端通过 Colyseus WebSocket 加入房间。
4. 客户端只发送输入或意图，例如移动、射击、准备；不直接提交最终位置、血量或胜负。
5. 房间服务器按固定 tick 更新权威状态，向客户端发送状态变更或差量。
6. 客户端对远端玩家做插值，对本地输入可做预测；服务器状态到达后进行校正。

游戏逻辑应放在 room 类或独立的纯逻辑模块中，渲染和输入留在发布前端。服务器必须限制消息大小、消息频率和单个玩家的操作频率；无效操作只返回错误，不改变状态。

每个房间由一个进程负责。单实例下可以使用 Colyseus 默认的内存 Presence；多实例、跨进程匹配或故障转移时使用 Redis Presence/Driver。Redis 不是游戏权威状态的替代品，关键状态仍需按游戏需求持久化。

## 9. 主要 API 和事件

建议先固定一个版本化协议：

```text
POST   /v1/games/{gameId}/rooms       创建房间
GET    /v1/games/{gameId}/rooms       查询可加入的公开房间
GET    /v1/rooms/{roomId}/snapshot   获取完整状态
WS     /v1/rooms/{roomId}/connect    实时连接
```

加入、离开、回合制命令和实时输入由 Colyseus Client/Room API 完成；创建房间和公开列表可以直接调用 Colyseus Matchmaker，也可以由控制面 API 包装。`snapshot` 只用于冷启动、重连失败后的恢复和服务端持久化恢复，不是另一套实时同步协议。

服务端事件至少包含 `room.ready`、`member.joined`、`member.left`、`state.updated`、`turn.changed`、`room.finished`、`room.closed` 和 `protocol.error`。这些事件通过 Colyseus 消息或 Schema 状态同步传递。每个业务事件带 `roomId`、`deploymentId`、单调递增 `sequence` 和服务器时间，客户端按序处理并丢弃旧事件。

## 10. 仓库实现拆分

建议按以下边界实现：

1. `src/shared/multiplayer-protocol.ts`：manifest、Colyseus 消息、事件和错误码的类型及运行时校验。
2. `src/renderer/multiplayer-client.ts`：封装 Colyseus Client/Room，处理创建/加入房间、重连、状态快照、命令幂等和连接状态。
3. `src/renderer/published-player.tsx`：检测 manifest 的 multiplayer 配置；单人路径保持现状，多人路径加载客户端并把状态交给游戏适配器。
4. 独立的 `multiplayer-server/` 或相邻服务包：从第一版开始安装并运行 Colyseus，包含 rooms、认证、匹配和持久化。不要把公网房间服务塞进本地 daemon。
5. 发布服务：验证游戏配置，生成 manifest 的多人字段，拒绝未知协议版本和不合法的 server URL。
6. 测试：协议校验、重复命令、并发加入、重连、房间关闭、部署版本隔离和浏览器刷新。

游戏代码通过一个小适配器接入：

```ts
interface MultiplayerGameAdapter<State, Command> {
  initialState(): State;
  validateCommand(state: State, playerId: string, command: Command): void;
  applyCommand(state: State, playerId: string, command: Command): State;
  onDisconnect?(state: State, playerId: string): void;
}
```

适配器不应读取浏览器中的“最终状态”来决定胜负；服务器保存的状态是唯一可信来源。

## 11. 断线、重连和恢复

- 刷新页面：保留本地 `roomId`、玩家 ID 和加密重连令牌，重新获取快照后再订阅事件。
- 短暂断网：服务器保留座位和状态，连接恢复后发送快照及未确认的序号。
- 重连超时：按游戏规则标记离线、托管、弃权或释放座位。
- 重复标签页：默认允许观察者连接，但只允许一个连接拥有玩家控制权；或者明确拒绝第二个控制连接。
- 服务重启：回合制从数据库恢复；实时房间要么从快照恢复，要么关闭房间并给出可理解的结果，不能静默生成一份新状态。
- Railway 部署：滚动发布前应停止接收新房间，等待或迁移旧房间；WebSocket 客户端必须能够识别服务代次并重连。

## 12. 安全、作弊和滥用防护

- 服务器校验所有操作、回合、碰撞、资源和胜负结果。
- 房间邀请码只保存哈希，日志不得记录完整邀请码、访问令牌或个人资料。
- 限制每个 IP、账号、房间和玩家的创建、加入、消息和重连频率。
- 限制消息体大小、房间人数、房间空闲时间和单个房间的广播频率。
- 公开房间列表只返回必要信息，房间所有者可关闭房间和踢出玩家。
- 游戏发布版本和多人协议版本必须绑定，避免旧客户端调用新服务器规则。
- 记录审计事件，但对聊天、昵称和账号数据设置保留期限。

## 13. 风险和应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 继续按静态发布理解多人游戏 | 玩家互不同步，功能看似成功但无法对局 | manifest 明确标记多人模式，发布前做连接检查 |
| 一个房间耗尽单实例资源 | 同实例的其他房间一起延迟或断开 | 设置 `maxClients`、消息限流、房间级 CPU/广播监控 |
| 只使用内存状态 | 重启后未保存对局丢失 | 回合制持久化命令；实时模式定期快照并定义恢复策略 |
| 客户端决定位置或胜负 | 容易作弊 | 服务器权威状态和命令校验 |
| 部署时新旧协议混用 | 房间状态无法解析 | `deploymentId` 和 `protocolVersion` 双重校验 |
| WebSocket 长连接不稳定 | 移动网络和浏览器休眠导致掉线 | 心跳、重连令牌、快照恢复和断线规则 |
| 无账号的游客无法找回 | 换设备后丢失进度 | 明示游客边界，提供账号升级和房间邀请链接 |
| 房间和账号数据暴露 | 隐私和滥用风险 | 最小化数据、令牌轮换、日志脱敏、访问限流 |
| 没有真实压测就估容量 | 发布后突然崩溃 | 使用目标 Railway 资源压测，并按 p95 延迟、CPU、内存和断线率定容量 |

## 14. 必须明确的边界情况

产品和游戏设计者在接入前需要决定：房主离开是否解散或转移房主；最后一名玩家离开后房间保留多久；匹配到不同部署版本时如何处理；回合超时是否自动执行；实时玩家中途退出是否由 AI 接管；同一账号能否同时加入多个房间；游客升级账号时如何合并数据；被踢出、封禁或房间关闭时客户端显示什么；服务端恢复失败时是否判定对局无效。

这些规则不能由前端临时推断，否则不同客户端会产生不同结果。

## 15. 分阶段实施

### 阶段一：Colyseus 基础和回合制 MVP

- 增加多人 manifest 和协议校验。
- 加入 Colyseus server、Colyseus client 和一个最小 Room。
- 接入现有 Supabase Auth JWT；实现游客身份和账号身份。
- 实现创建/加入/离开房间，以及统一的 WebSocket 重连。
- 实现一个基于 Colyseus message、数据库命令序列和状态快照的回合制示例游戏。
- 支持刷新、重复命令、超时和房间关闭。
- 单实例 Railway 部署，暂不做跨实例迁移。

### 阶段二：Colyseus 实时房间

- 增加 Colyseus server 和一个示例实时房间。
- 加入 WebSocket 心跳、重连、输入校验、tick 和状态同步。
- 增加房间人数保护、消息限流和基础指标。
- 发布同一游戏的单人、回合制和实时三种模式示例。

### 阶段三：稳定性和扩展

- Redis Presence/Driver、多实例部署和房间路由。
- 数据库快照、审计、服务重启恢复和滚动发布策略。
- 账号升级、跨设备恢复、封禁和管理操作。
- 使用固定脚本压测并记录每种游戏模板的安全容量。

## 16. 验收标准

- 单人游戏不加载多人服务也能正常打开。
- 回合制玩家可以在不同时间加入、刷新和提交操作，重复提交不会重复结算。
- 实时玩家可以在移动网络短暂断开后恢复到同一房间和状态。
- 客户端篡改位置、回合、分数或部署 ID 时，服务器拒绝操作。
- 旧部署的房间不被新部署的客户端误加入。
- 房间达到保护上限时返回明确错误，不影响其他房间。
- 服务重启后的行为符合该游戏声明的恢复策略。
- 压测结果包含并发房间数、每房间人数、tick 频率、消息大小、p95 延迟、CPU、内存、带宽和断线率。

真正的“最多承载人数”应在阶段二完成后，以目标 Railway 实例和具体游戏逻辑压测得出；代码本身无法提供一个适用于所有游戏的固定数字。

## 17. 本仓库实现与运行

当前实现提供独立 Colyseus 服务、浏览器客户端、SQLite 回合快照和命令结果、游客令牌及 Supabase Auth 验证。示例适配器有两个：回合制的 21 石子和实时的中心竞速。服务器验证命令与输入；客户端只渲染权威快照。交互故事的 Node Runtime 尚无通用的服务器游戏规则适配器，因此交互故事发布仍是单人，不能通过设置一个 manifest 把任意故事自动变成多人游戏。

先运行 `bun run build:host` 和 `bun run build:player`。准备一份只由运营者写入的部署注册文件，内容是 `MultiplayerManifestConfig[]`。每个部署 ID 保持不可变；发布配置的 `serverUrl` 使用公开 HTTPS 源地址，Railway 的代理负责 TLS 和 WebSocket 转发。服务端要求 Node.js 22.19 或更新版本，并使用单实例和持久卷：

```sh
MULTIPLAYER_DEPLOYMENTS_FILE=/data/deployments.json \
MULTIPLAYER_DATABASE_PATH=/data/multiplayer.sqlite \
MULTIPLAYER_GUEST_SECRET='<at-least-32-random-bytes>' \
MULTIPLAYER_PUBLIC_ADDRESS='games.example.com' \
SUPABASE_URL='https://project.supabase.co' \
SUPABASE_PUBLISHABLE_KEY='<publishable-key>' \
bun run start:multiplayer
```

Railway 设置 `PORT`、一个持久卷和单副本。匿名游戏可省略 Supabase 两项；强制账号的部署必须填写与编辑器相同的 Supabase 项目。`GET /healthz` 用作健康检查。浏览器不能访问原始 HTTP 地址；本地开发可通过 HTTPS 反向代理访问服务。每个进程默认限制 100 个房间，可设置 `MULTIPLAYER_MAX_ROOMS`；这只是保护阈值，不代表经压测的承载量。

要生成独立的示例静态站点，先构建 player，再执行：

```sh
bun run build:player
bun scripts/build-multiplayer-example.ts /data/turn-deployment.json ./multiplayer-example
```

`turn-deployment.json` 是注册数组中的一项；将生成目录以 HTTPS 静态托管后即可创建房间和邀请玩家。把 `mode` 改为 `realtime`、使用另一个不可变部署 ID，可生成中心竞速示例。示例 manifest 的运行时是 `multiplayer-example`，不会替换已发布的交互故事。

普通 Web Game 在构建产物的 `manifest.json` 中放入同一份 `multiplayer` 配置，自行使用 `@colyseus/sdk` 或 `src/renderer/multiplayer-client.ts` 所示的封装与服务通信，并提供与服务端对应的游戏适配器。上传前本地 daemon 会读取配置并检查服务端注册内容是否完全一致；必须把 `MULTIPLAYER_PUBLISH_SERVER_URL` 设为同一个 HTTPS 源地址。配置不能从浏览器指定任意服务器，也不能把交互故事声明为多人。Web Game 的游戏规则不会由发布器自动转换或上传到 Colyseus；新游戏规则需要部署服务端适配器。

回合房间的状态和首次命令结果在一个 SQLite 事务内保存，进程重启后用原 room ID 恢复。实时房间在服务重启时关闭，客户端需明确创建新局。刷新优先使用 Colyseus 重连令牌；令牌过期后用已验证身份找回回合座位。重复控制标签页会被拒绝。当前游客令牌有效期为 24 小时；游客换设备、升级正式账号、Redis Presence、多实例迁移和实际容量压测属于后续阶段。
