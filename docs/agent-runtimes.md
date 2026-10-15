# Agent Runtime 接入规范

状态：提案，已按当前代码审查精简，供后续实现和评审使用。

本文定义 OhMyGame 接入原生 Agent CLI 的边界和实现方式。第一批 Runtime 包括
Pi、Codex CLI、Claude Code CLI 和 OpenCode。本文只规定 daemon、renderer、插件、
画布和模型系统之间的契约；具体 CLI 参数必须由各自的 adapter 根据已探测到的
版本和能力生成。

## 决策摘要

- `Provider` 继续表示模型服务、认证、模型目录和 API 协议。
- `Agent Runtime` 表示拥有 agent loop、工具调用、权限、session 和进程生命周期的执行后端。
- Pi 继续是第一方 Direct Runtime，也是旧项目和 API/本地模型的默认路径。
- Codex、Claude Code 和 OpenCode 是可选的 Native Runtime，不能伪装成普通 Provider。
- 图片、视频和 3D Provider 继续由 OhMyGame daemon 管理；Native Runtime 通过统一的 Tool/MCP Bridge 使用它们，Pi 继续通过现有 direct tools 使用同一批 daemon 服务。
- 旧的 `ModelRef`、`models.json`、`auth.json`、`model-visibility.json` 和媒体默认模型必须保持兼容。
- Runtime 的 wire protocol 不统一：Codex 使用 App Server JSON-RPC，Claude 使用 stream-json/Agent SDK，OpenCode 使用 JSON event stream。
- 统一的是执行状态、事件、artifact、插件编译和恢复契约。
- `AgentManager` 仍是唯一的运行编排入口；新增层只负责 Runtime 选择、外部进程和协议适配。
- Renderer 继续使用现有 `RuntimeEvent` 和 `ThreadItem`，不再引入平行的 `agent.*` / `agent.tool.*` 公共事件协议。

## 背景和当前边界

当前语言模型由 Pi 的 `ModelRuntime` 管理，daemon 在
`src/daemon/app.ts` 中读取 `auth.json` 和 `models.json`。会话入口固定调用
`createPiSession`，Pi 负责模型请求、工具循环、Skills、MCP 和 session transcript。

当前 `AgentManager` 已经负责 session 缓存、active turn、prompt queue、取消、steering、
状态、错误、checkpoint 和事件转发；`CodingSession` 是现有的会话边界。Native Runtime
应实现这个边界，或由一个很薄的 adapter 包装它，不应再引入第二个 turn/session
orchestrator。

当前共享模型引用仍然是：

```ts
interface ModelRef {
  provider: string;
  id: string;
}
```

这个类型同时用于语言、图片、视频和 3D 模型，不能把 CLI native model 直接写进
当前 Provider 模型目录。Provider 的能力集合仍然是 `language`、`image`、`video`
和 `3d`。

现有媒体管线包括 `ProviderImages`、`ProviderVideos`、`ProviderModels3D` 和
`ToolRunner`。它们负责模型选择、默认值、异步任务、artifact、取消和重试。CLI
Runtime 不得复制这些能力。

相关入口：

- [daemon runtime 初始化](../src/daemon/app.ts)
- [Pi session 创建](../src/daemon/app.ts)
- [Pi session 实现](../src/daemon/agent.ts)
- [共享模型引用](../src/shared/contracts.ts)
- [Provider 能力类型](../src/shared/contracts.ts)
- [媒体模型设置](../src/daemon/provider-model-settings.ts)
- [Agent 媒体工具](../src/daemon/agent-tools.ts)
- [媒体任务运行器](../src/daemon/tools.ts)

## 术语

### Direct Runtime

由 OhMyGame/Pi 驱动模型请求和工具循环的 Runtime。Pi、OpenAI-compatible API、
Anthropic API、Ollama 和 LM Studio 都属于这条路径，但 API Provider 本身不是
Runtime。

### Native Runtime

由外部 CLI 或官方 Agent 协议驱动完整 agent loop 的 Runtime。Codex、Claude Code
和 OpenCode 属于这条路径。它们保留自己的认证、工具循环、权限、模型语义和
native session。

### Agent run

一次由现有 `AgentManager`/`ActiveTurn` 管理的运行。它关联 OhMyGame 的
project/conversation 和可选的 native session ID；Renderer 只消费现有
`RuntimeEvent`，不直接读取 CLI stdout。这个概念不对应一张新的持久化运行表。

### Tool/MCP Bridge

由 daemon 拥有的工具入口。它把 CLI 的工具请求路由到 OhMyGame 的项目、插件、
画布、游戏预览、媒体和文件服务。它是协议适配边界，不是第二套工具业务实现；
已有 `createAgentTools`、`ToolRunner`、`CanvasStore` 和项目服务继续拥有实际行为。

### Native runtime state

外部 Runtime 需要保存的只有选择和 native session 元数据，例如 runtime、native model、
native session ID 和版本。运行中的状态、turn、队列和错误继续由 `AgentManager` 与
现有事件/turn 模型拥有。

## 当前代码审查结论

| Spec 中的抽象                                        | 当前已有能力                                                                     | 结论                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ExecutionSupervisor`                                | `AgentManager` 已管理 session、turn、队列、取消和事件                            | 删除这个总编排层；只新增 CLI 专用 `CliProcessSupervisor`                      |
| `AgentExecutionRecord`                               | `ActiveTurn`、`ManagedSession`、conversation transcript 和 checkpoint            | 不保存第二套运行记录；新增 `ConversationRuntimeState` 只保存 native 元数据    |
| `agent.message.delta`、`agent.tool.*`、`agent.run.*` | `RuntimeEvent`、`ThreadItem`、`item.*` 和 `agent.*` 已被 renderer 消费           | 外部协议映射到现有 session/event 路径；必要的新 UI 项目使用现有 `item.*` 事件 |
| `PluginRuntimeCompiler`                              | `PluginCapabilities.effective()`、`PluginMcpHost`、plugin settings/configuration | 保留“按 Runtime 编译”的纯适配函数，不复制插件发现、配置和状态系统             |
| `Tool/MCP Bridge`                                    | `createAgentTools`、`ToolRunner`、`CanvasStore` 和 preview services              | 保留协议桥这个边界，只转换 schema、输入和输出，不复制媒体或画布逻辑           |
| `RuntimeSessionStore`                                | Pi session 文件、conversation manager 和 checkpoint                              | 不新建通用 session store；为 native ID 建一个轻量 sidecar/store 即可          |

因此，推荐的最小新增面是：Runtime registry/discovery、CLI process supervisor、各 CLI
protocol adapter、native state store，以及将它们接到现有 `AgentManager` 的选择代码。

## 目标和非目标

### 目标

- 让用户在项目中选择 Pi、Codex CLI、Claude Code CLI 或 OpenCode。
- 继续使用现有语言 LLM/API/本地模型配置。
- 让三个 Native Runtime 使用 OhMyGame 的游戏工具、画布工具和媒体工具。
- 在 UI 中保持一致的消息、工具调用、文件修改、artifact 和错误显示。
- 保留 native session ID，同时拥有 OhMyGame 自己的 transcript、checkpoint 和 artifact 记录。
- 支持 CLI 探测、版本兼容检查、认证状态、取消、恢复和 daemon 重启后的进程回收。
- 未来可增加其他 CLI，而不修改 Provider 和媒体系统。

### 非目标

- 不把 Codex、Claude Code 或 OpenCode 做成普通 `ProviderSummary`。
- 不复制或代理第三方订阅 OAuth token。
- 不强制所有 CLI 使用 ACP 或同一种 wire protocol。
- 不在 CLI adapter 中复制图片、视频、3D provider 和任务恢复逻辑。
- 不要求第一版实现所有 CLI 的所有特有功能，例如原生 compaction、复杂 steering 或完整 usage 额度。
- 不保证 Pi transcript 可以无损转换为任意 CLI 的 native session。

## 总体架构

```text
Renderer
  │ local HTTP + SSE
  ▼
AgentManager
  ├── RuntimeRegistry / Discovery
  ├── Pi CodingSession
  └── Native Runtime CodingSession adapters
       ├── Codex App Server
       ├── Claude stream-json
       └── OpenCode JSON

Native Runtime adapters
  ├── CliProcessSupervisor (CLI only)
  ├── protocol transport/parser
  ├── native state store
  ├── existing AgentSessionEvent/ThreadItem mapping
  └── thin Tool/MCP protocol adapter

Tool/MCP Bridge
  ├── Plugin Skills and MCP
  ├── CanvasStore
  ├── ToolRunner
  ├── Game Use / Preview
  └── Workspace and artifact services

Provider and Model Layer
  ├── Language/API providers
  ├── Image providers
  ├── Video providers
  └── 3D providers
```

推荐的 daemon 模块结构：

```text
src/daemon/agent-runtime/
  contracts.ts
  registry.ts
  discovery.ts
  cli-process-supervisor.ts
  native-state-store.ts
  runtime-config.ts
  adapters/
    codex-app-server.ts
    claude-stream-json.ts
    opencode-json.ts
```

这些模块不应把 Provider、媒体模型或 renderer 细节反向引入 CLI adapter。第一版不需要
包装现有 `createPiSession` 的 `pi.ts`、`execution-supervisor.ts`、第二套事件总线或独立
的媒体/画布服务。

## Runtime 定义和能力

Runtime 定义负责声明静态信息和探测方法；协议 adapter 负责真正的启动和事件处理。

```ts
type AgentRuntimeId = "pi" | "codex-cli" | "claude-code" | "opencode";

interface RuntimeDefinition {
  id: AgentRuntimeId;
  name: string;
  binary: string;
  fallbackBinaries?: string[];
  versionArgs: string[];
  helpArgs?: string[];
  capabilityProbe?: CapabilityProbe;
  transport: "pi" | "codex-app-server" | "claude-stream-json" | "opencode-json";
}

interface RuntimeCapabilities {
  modelDiscovery: boolean;
  nativeResume: boolean;
  imageInput: boolean;
  workspaceFiles: boolean;
  mcp: boolean;
  approvals: boolean;
  steering: boolean;
  compaction: boolean;
  usage: boolean;
}
```

能力必须通过实际版本探测得到。不能仅凭 Runtime 名称假定某个 flag、事件或模型
存在。探测结果应按 binary 的真实路径、版本和修改时间缓存；用户执行 Recheck 或
binary 发生变化时重新探测。

Runtime adapter 的公共职责保持最小化：

```text
probe
authStatus
createSession(context) -> CodingSession
```

`CodingSession` 的 `prompt`、`followUp`、`steer`、`abort`、`dispose` 和 `subscribe`
继续由现有 `AgentManager` 调用。CLI 的 stdin/stdout、JSON-RPC、JSONL 和进程组细节
留在 adapter 与 `CliProcessSupervisor` 内部。模型发现、审批、图片输入、steering、usage
和 compaction 都属于可选能力。

## 三个 Native Runtime

### Codex CLI

交互式主协议使用 Codex App Server JSON-RPC：

```text
initialize
thread/start 或 thread/resume
turn/start
notifications
approval
thread/compact
```

`codex exec --json` 可以作为批处理或兼容降级路径，但不作为长期交互式主协议。

Codex adapter 负责：

- 发现 `codex` binary 和版本。
- 查询原生登录状态。
- 通过 App Server 获取可用模型和 reasoning 能力。
- 保存 thread/session ID。
- 处理 turn、工具、审批、错误和限额事件。
- 注入 OhMyGame MCP/tool bridge。
- 处理取消、恢复和 compaction。

认证必须使用 Codex 自己的登录机制。daemon 只查询状态或启动登录流程，不读取和
转存 Codex 的 refresh token。

### Claude Code CLI

首选 stream-json：

```text
claude -p
  --input-format stream-json
  --output-format stream-json
```

Claude adapter 负责：

- 发现 binary、版本和实际支持的 flags。
- 调用 Claude 原生登录和状态检查。
- 通过 stdin 传递完整 prompt 和后续 JSONL 消息。
- 通过 `--session-id` 创建可控 session。
- 通过 `--resume` 恢复 native session。
- 通过 `.mcp.json` 或官方支持的配置方式注入 MCP。
- 处理权限模式、工具事件、错误和取消。

Claude 的权限模式必须单独建模，不能无条件复制其他项目的
`bypassPermissions` 行为。

### OpenCode

首选：

```text
opencode run --format json
```

OpenCode adapter 负责：

- 发现 binary、版本和 CLI dialect。
- 使用 `opencode models --verbose` 获取模型和 variant。
- 从 JSON event stream 捕获 `sessionID`。
- 后续使用 session 参数继续运行。
- 通过 `OPENCODE_CONFIG_CONTENT` 注入 MCP，避免修改用户持久化配置。
- 处理 provider/model/variant 的 native 语义。

OpenCode 可能使用 Zen、OpenAI、Anthropic、Ollama 或其他 provider，因此 UI 必须
显示真实的认证和计费来源，不能把所有 OpenCode 会话都标成 OpenCode 订阅。

## Agent 选择和持久化

现有 `ModelRef` 保持不变。新增选择类型：

```ts
interface AgentRuntimeSelection {
  runtime: AgentRuntimeId;

  // runtime = "pi" 时使用，保持现有 provider/id 语义。
  model?: ModelRef;

  // Native Runtime 使用 CLI 自己的 model ID 或 alias。
  nativeModel?: string;

  // 具体取值由 Runtime 能力目录决定。
  reasoningLevel?: string;
}
```

选择 runtime 后，`AgentManager` 的 session factory 只在 `runtime: "pi"` 时解析现有
`ModelRuntime`。Native Runtime 的认证和语言模型由其 CLI 管理；图片、视频和 3D 工具
仍按现有 `ModelRef` 和媒体默认值解析，不能因为选择了 CLI 而改写 Provider 设置。

会话保存：

```ts
interface ConversationRuntimeState {
  projectId: string;
  conversationId: string;
  runtime: AgentRuntimeId;
  nativeSessionId?: string;
  nativeModel?: string;
  nativeVersion?: string;
}
```

`status`、`turnId`、`startedAt`、`completedAt` 和队列状态不放进这个 sidecar；它们已经
由 `AgentManager`、`ActiveTurn`、checkpoint 和现有事件表示。sidecar 可以按
`projectId/conversationId` 保存，也可以作为 conversation 的受控 custom entry，具体选
择不应改变 renderer 契约。

旧 conversation 没有 runtime 字段时，默认解释为：

```json
{
  "runtime": "pi"
}
```

已有 `model`、项目媒体默认模型和 Provider 设置不得被迁移脚本删除或重写。

建议新增：

```text
GET  /agent-runtimes
GET  /agent-runtimes/:runtimeId
GET  /agent-runtimes/:runtimeId/models
POST /agent-runtimes/:runtimeId/recheck
POST /agent-runtimes/:runtimeId/login
```

现有 `/models` 继续返回 Pi/API 语言模型，保证 renderer 和旧测试兼容。

## Prompt、进程和安全边界

CLI prompt 必须优先使用 stdin 或 daemon 管理的临时文件，不能把完整 prompt 放进
argv。推荐流程：

1. 在 run 目录写入权限为 `0600` 的 prompt 文件。
2. 启动子进程时将文件 descriptor 作为 stdin。
3. spawn 成功后关闭 daemon descriptor，并删除临时目录引用。
4. 子进程拥有独立 process group。
5. 取消时终止整个 process tree。
6. 为每个进程写入记录，daemon 启动时回收上一次遗留的 owned process。

CLI 子进程环境必须使用 allowlist：

- 不继承 OhMyGame daemon token。
- 不继承无关 API key 和内部 `OHMYGAME_*` 变量。
- 明确传递 project、workspace、runtime data 和 MCP 所需变量。
- 不把凭据写入 argv、prompt、transcript 或日志。

如果 CLI 需要访问 daemon-owned MCP bridge，传入的是 project/conversation/turn 作用域的
一次性 bridge capability；它与 daemon HTTP token 分开、可撤销、只允许当前 runtime 的
工具集合。这样既能让 CLI 调用画布、插件和媒体服务，也不会把 daemon 管理凭据交给外部
进程。

项目 cwd 不是操作系统安全边界。MCP 也不是 sandbox。Codex、Claude 和 OpenCode 的
权限模式、网络访问和文件系统范围必须作为 runtime policy 单独处理。

## 插件和 Skills

插件支持分为四层：

| 插件能力          | Pi          | Codex               | Claude Code       | OpenCode                  |
| ----------------- | ----------- | ------------------- | ----------------- | ------------------------- |
| Skills            | 原生加载    | 编译为上下文/文件   | 编译为上下文/文件 | 编译为上下文/文件         |
| MCP servers       | Pi MCP host | App Server/配置注入 | `.mcp.json`       | `OPENCODE_CONFIG_CONTENT` |
| 插件配置          | daemon 管理 | daemon 管理         | daemon 管理       | daemon 管理               |
| Pi Extension/hook | 原生        | 不直接兼容          | 不直接兼容        | 不直接兼容                |
| 插件 UI           | renderer    | renderer            | renderer          | renderer                  |

需要一个按 Runtime 输出格式的纯适配步骤（实现上可以叫
`compileRuntimeConfig`），但它不拥有插件生命周期，负责：

```text
启用插件
  ↓
按 project type 过滤
  ↓
解析 Skills、MCP 和配置
  ↓
生成当前 Runtime 所需的 prompt、文件或 MCP 配置
```

输入应直接来自 `PluginCapabilities.effective(projectType)` 和现有 plugin skill resolver。
Pi 继续使用 `PluginMcpHost`；Claude、Codex 和 OpenCode 只把同一份有效配置序列化成各自
支持的 MCP/Skills 形式。若某个 Runtime 不支持某种插件能力，要报告能力缺失，不要悄悄
复制一套兼容实现。

插件安装或配置变化后，当前 native session 不保证立即载入新工具。daemon 应让当前
turn 结束，或重启该 runtime session 后使用新的编译结果。

## 画布、游戏和媒体工具

CLI 不直接调用 renderer。所有高层能力通过 daemon-owned Tool/MCP Bridge：

```text
Native Runtime
  ↓
OhMyGame Tool/MCP Bridge
  ├── canvas_initialize
  ├── canvas_check
  ├── generate_canvas_media
  ├── generate_image
  ├── generate_video
  ├── generate_3d_asset
  ├── animate_3d_asset
  ├── game_use
  └── plugin/tool services
```

文件型画布操作可以由 CLI 的 read/write/edit 工具完成；完成后调用
`canvas_check`。涉及 CanvasStore、媒体任务、画布生成历史和取消的操作必须经过
daemon bridge。

Bridge 的 handler 应复用现有 `createAgentTools` 对应的项目服务和 `ToolRunner`，只增加
CLI 协议所需的 schema/transport 转换；不要另做一份 `generate_image`、CanvasStore 或
媒体 job 实现。

媒体模型解析继续使用现有规则：

```text
显式 ModelRef
→ 项目媒体默认模型
→ 全局媒体默认模型
→ 自动选择可用模型
```

CLI 的 native model 不能被当成图片、视频或 3D 模型。

图片、视频和 3D 任务必须返回 job ID、状态和 artifact 引用。CLI 收到一段文本不
代表媒体任务已经完成。

## 事件和 UI 显示

Renderer 继续只消费已有的 daemon `RuntimeEvent`：

```text
agent.started
item.started
item.updated
item.completed
item.agentMessage.delta
item.reasoning.textDelta
agent.completed
agent.cancelled
agent.error
```

Native wire event 应先映射到现有 `CodingSession.subscribe` / `AgentSessionEvent` 消费路径，
再由 `AgentManager` 生成 `ThreadItem` 和 `RuntimeEvent`。如果某个 CLI 的 wire protocol
不能自然表示为 Pi 的内部事件，可以增加一个 daemon 内部的窄映射类型，但它不应成为
新的 HTTP/SSE 公共协议。

工具和审批显示应复用 `ThreadItem`。工具调用使用已有的
`dynamicToolCall`/`mcpToolCall`；adapter 可以在 item 的扩展 metadata 中保留
`nativeToolName` 等诊断信息，但不再定义一套 `AgentToolEvent`。审批或 CLI 特有的等待项
若需要 UI，增加对应的 `ThreadItem` 子类型并继续通过 `item.started/updated/completed`
传输。

Pi、Codex、Claude Code 和 OpenCode 可以使用同一套工具卡片、文件变更和 artifact
显示。Runtime 特有事件（审批、compact、子 Agent、usage）通过 `ThreadItem` 的扩展
字段或专用 item 显示，不能新增平行的 SSE 事件族，也不能把 CLI stdout 原样推送给
renderer。

如果某个 CLI 没有提供完整工具输入或输出，UI 显示摘要即可，但必须明确标记事件
来源和状态，不能伪造详细结果。

## 性能和并发

Runtime discovery 必须按需执行并缓存；选择 Pi 时不启动其他 CLI，也不在 Pi 请求
路径中探测所有 binary。

Pi 不应因增加 CLI adapter 而增加明显请求延迟。系统仍然需要限制共享资源：

- CLI 子进程数量。
- MCP server 数量。
- 媒体任务并发。
- 本地模型 GPU/内存使用。
- 构建、npm 和预览进程数量。

`CliProcessSupervisor` 只负责外部进程的 admission control、取消和回收；一个 CLI Runtime
的崩溃、超时或高 CPU 不得阻塞 `AgentManager` 的 Pi 请求队列。Pi 路径不应为了 CLI
增加 binary 探测或进程等待。

## 恢复和迁移

必须同时保存：

```text
OhMyGame transcript/checkpoint/artifact
Native CLI session ID
```

native session 是快速恢复路径，不是唯一恢复来源。如果 CLI 版本变化、session
失效或用户卸载 CLI，daemon 应从最近 checkpoint、文件状态和恢复摘要创建新 session。

Native adapter 还必须把用户消息、assistant 输出、工具结果和错误写入现有 conversation
transcript/checkpoint 路径，使 `conversationItems`、Undo 和恢复仍然可用。若某个 wire
event 不能直接表示为 Pi 的 `SessionEntry`，使用版本化 custom entry 并扩展现有读取器；
不要另建一份 renderer 专用 transcript 数据库。

从 CLI 切回 Pi 时：

1. 将项目或 conversation 的 runtime 改为 `pi`。
2. 保留原来的 Provider、ModelRef 和媒体设置。
3. 使用归一化 transcript、workspace 和 checkpoint 开始新的 Pi session。
4. 不承诺将 Codex thread、Claude hidden context 或 OpenCode session 无损导入 Pi。

如果未来移除 CLI 功能，只需要禁用对应 Runtime adapter 和设置入口；Provider、媒体、
画布、插件和 Pi session 不需要重写。

## 第一批实现计划

### 阶段一：公共基础设施

- Runtime definition 和 capability contract。
- Runtime registry/discovery。
- CLI discovery、版本和 capability probe。
- `CliProcessSupervisor`、file-backed stdin、process group、取消和 orphan recovery。
- `ConversationRuntimeState` 持久化。
- 将 adapter 接入现有 `AgentManager`/`CodingSession`/`RuntimeEvent` 路径。
- fake CLI fixtures。

### 阶段二：OpenCode vertical slice

- `opencode run --format json`。
- prompt stdin。
- JSON event parser。
- session ID 捕获和 resume。
- `models --verbose`。
- `OPENCODE_CONFIG_CONTENT` MCP 注入。
- 基础工具和媒体 bridge。

OpenCode 适合作为第一个工程验证 Runtime，因为协议、模型发现和 session 语义相对
直观，且可以验证通用的外部 CLI 生命周期。

### 阶段三：Claude Code

- stream-json stdin/stdout。
- native login/status。
- `--session-id` 和 `--resume`。
- `.mcp.json` 注入。
- 权限模式。
- 工具、文件、媒体和画布 bridge。

### 阶段四：Codex App Server

- JSON-RPC initialize。
- thread/turn 生命周期。
- approval 事件。
- native model/reasoning。
- rate limit 状态。
- compaction 和 session resume。

### 阶段五：统一 UI 和增强能力

- Agent Runtime 设置页。
- native model picker。
- approval UI。
- usage/限额显示。
- steering。
- 更完整的子 Agent 和 compaction 显示。

## 验收标准

### 兼容性

- 旧项目无需迁移即可继续使用 Pi。
- 现有语言模型、API provider、Ollama、LM Studio 和自定义 provider 不受影响。
- 图片、视频和 3D 默认模型、项目覆盖和模型可见性不受影响。
- `/models` 现有响应保持兼容。

### Runtime

- 三个 CLI 可以独立探测、报告版本和登录状态。
- 每个 CLI 使用自己的协议 adapter。
- prompt 不因 argv 长度或 daemon 重启而被截断。
- 取消会终止完整进程树。
- daemon 重启可以识别并回收 owned orphan process。
- native session ID 可以在支持的 Runtime 中恢复。

### 工具和产品能力

- Skills 和启用的 MCP 可以根据 Runtime 生成配置。
- CLI 可以调用画布检查、画布媒体生成和游戏工具。
- CLI 可以调用图片、视频、3D 工具并获得 job/artifact 状态。
- 工具调用在 renderer 中使用统一事件和卡片显示。
- Runtime 特有能力不会破坏 Pi 的现有显示和请求路径。

### 安全和恢复

- daemon token 不会进入 CLI 子进程。
- 凭据不进入 prompt、argv、transcript 或日志。
- 订阅 CLI 和 API Provider 的认证、计费来源分开显示。
- CLI session 失效时可以从 OhMyGame checkpoint 恢复。
- 移除 CLI adapter 后，Pi 和 Provider 系统仍可独立运行。

## 参考实现

- [Genex Desktop](https://github.com/genex-games/genex-desktop)
- [Open Design](https://github.com/nexu-io/open-design)
- Genex 的本地研究文档：`research/bring-your-own-ai-subscription-2026-09-04.md`
- [OhMyGame Runtime](runtime.md)
- [OhMyGame Plugins](plugins.md)
- [OhMyGame Canvas Agent](canvas-agent.md)
- [OhMyGame Custom Models](custom-models.md)
