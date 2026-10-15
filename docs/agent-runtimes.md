# Agent Runtime integration specification

Status: proposal, reviewed against the current daemon and the open PR comments.

This document defines the boundary for adding native agent CLIs to OhMyGame. The first
batch is Pi, Codex CLI, Claude Code CLI, and OpenCode. It defines daemon, renderer,
plugin, canvas, and model contracts; each adapter still owns the version-specific CLI
flags and wire protocol.

## Decisions

- `Provider` continues to represent a model service, authentication, model catalog, and
  API protocol.
- An `Agent Runtime` owns an agent loop, tool execution, permissions, sessions, and, for
  native runtimes, an external process.
- Pi remains the first-party Direct Runtime and the default path for existing projects,
  API providers, and local models.
- Codex, Claude Code, and OpenCode are optional Native Runtimes. They are not modeled as
  ordinary `ProviderSummary` entries.
- Image, video, and 3D providers remain daemon-owned. Native runtimes reach them through
  the same OhMyGame tool services that Pi uses; adapters do not implement media jobs.
- Existing `ModelRef`, `models.json`, `auth.json`, model visibility, and media defaults
  remain compatible.
- Wire protocols stay native: Codex App Server JSON-RPC, Claude stream-json or the
  official Agent SDK, and OpenCode JSON events.
- `AgentManager` remains the only turn and session orchestrator. New code handles runtime
  selection, native process ownership, protocol translation, and native session metadata.
- The renderer continues to consume the existing `RuntimeEvent` and `ThreadItem` model.
  No parallel public `agent.tool.*` or `agent.run.*` event family is introduced.

## Current boundary

The daemon currently loads language models through Pi's `ModelRuntime`; `app.ts` wires
`auth.json` and `models.json` and creates Pi sessions. `createPiSession` owns the Pi model
loop, tools, Skills, MCP, and transcript integration.

`AgentManager` already owns session caching, active turns, prompt and steering queues,
cancellation, state, errors, checkpoints, and event forwarding. `CodingSession` is the
existing session boundary. A Native Runtime adapter must implement that boundary, or a
thin wrapper around it, instead of adding another turn/session orchestrator.

The shared model reference remains:

```ts
interface ModelRef {
  provider: string;
  id: string;
}
```

The same shape is used for language, image, video, and 3D models. A CLI-native model
must not be inserted into the existing provider model catalog. Provider capabilities
remain `language`, `image`, `video`, and `3d`.

The existing `ProviderImages`, `ProviderVideos`, `ProviderModels3D`, `ToolRunner`,
`CanvasStore`, preview services, and plugin services remain the owners of their behavior.
Native adapters must not copy model selection, default resolution, asynchronous jobs,
artifacts, cancellation, retries, or canvas history.

Relevant code entry points:

- [daemon runtime initialization](../src/daemon/app.ts)
- [AgentManager and Pi session implementation](../src/daemon/agent.ts)
- [shared model and runtime event contracts](../src/shared/contracts.ts)
- [provider model settings](../src/daemon/provider-model-settings.ts)
- [agent tools](../src/daemon/agent-tools.ts)
- [media job runner](../src/daemon/tools.ts)

## Terms

### Direct Runtime

A runtime whose model requests and agent loop are driven by OhMyGame/Pi. Pi can use
OpenAI-compatible APIs, Anthropic APIs, Ollama, LM Studio, and other configured providers.
The API provider itself is not a runtime.

### Native Runtime

A runtime whose CLI or official agent protocol drives the complete agent loop. Codex,
Claude Code, and OpenCode retain their own authentication, permissions, model semantics,
and native session identifiers.

### Agent run

A run managed by the existing `AgentManager` and `ActiveTurn`, associated with an
OhMyGame project/conversation and, when available, a native session ID. It is not a new
persistent run table.

### Tool/MCP bridge

A daemon-owned protocol boundary that exposes OhMyGame project, plugin, canvas, preview,
media, and file services to a native runtime. It translates schemas and transports; it
does not become a second implementation of those services.

### Native runtime state

The small amount of metadata needed to resume a native session: runtime ID, native model,
native version, and native session ID. Runtime status, turn state, queues, errors, and
checkpoints remain owned by `AgentManager` and the existing event model.

## Review conclusions and non-duplication rules

| Proposed abstraction                                 | Existing capability                                                                   | Rule                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionSupervisor`                                | `AgentManager` already manages sessions, turns, queues, cancellation, and events      | Do not add a second orchestrator. Add only a CLI process supervisor.                                                                                 |
| `AgentExecutionRecord`                               | `ActiveTurn`, `ManagedSession`, conversation transcripts, and checkpoints             | Persist only native session metadata; keep run status in the existing manager/events.                                                                |
| `agent.message.delta`, `agent.tool.*`, `agent.run.*` | `RuntimeEvent`, `ThreadItem`, `item.*`, and `agent.*` are already renderer-facing     | Map native events into the existing session/event path.                                                                                              |
| `PluginRuntimeCompiler`                              | `PluginCapabilities.effective()`, `PluginMcpHost`, plugin settings, and configuration | Keep only a pure per-runtime serializer; do not duplicate plugin discovery or state.                                                                 |
| Tool/MCP bridge business logic                       | `createAgentTools`, `ToolRunner`, `CanvasStore`, and preview services                 | Reuse existing handlers; add only protocol/schema translation.                                                                                       |
| Generic `RuntimeSessionStore`                        | Pi session files, `ConversationManager`, and checkpoints                              | Store conversation runtime metadata as versioned session-tree entries. A separate journal is allowed only for process ownership and orphan recovery. |

The minimum new implementation surface is therefore runtime registry/discovery, a CLI
process supervisor, three protocol adapters, per-runtime configuration serialization,
and the `AgentManager` session-factory selection.

## Goals and non-goals

### Goals

- Let a conversation choose Pi, Codex CLI, Claude Code CLI, or OpenCode.
- Preserve existing language LLM/API/local model configuration.
- Let native runtimes use OhMyGame game, canvas, media, plugin, and preview tools.
- Keep message, tool-call, file-change, artifact, approval, and error displays consistent.
- Persist both the OhMyGame transcript/checkpoints and the native session identifier.
- Support CLI discovery, version capability checks, authentication status, cancellation,
  recovery, and daemon restart cleanup.
- Make adding another CLI or removing the first batch independent of the Provider and
  media systems.

### Non-goals

- Do not proxy or copy third-party subscription OAuth refresh tokens.
- Do not force every CLI to use ACP or one common wire protocol.
- Do not copy image, video, 3D, canvas, or task-recovery implementations into adapters.
- Do not require every CLI-specific feature in the first release, such as full usage
  quotas, complex steering, or native compaction parity.
- Do not promise lossless import of a Codex thread, Claude hidden context, or OpenCode
  session into Pi.

## Architecture

```text
Renderer
  │ local HTTP + SSE
  ▼
AgentManager
  ├── Runtime registry / discovery
  ├── existing Pi CodingSession
  └── Native Runtime CodingSession adapters
       ├── Codex App Server
       ├── Claude stream-json / Agent SDK
       └── OpenCode JSON

Native Runtime adapters
  ├── CliProcessSupervisor (external process ownership only)
  ├── protocol transport and parser
  ├── native session metadata entries
  ├── mapping into existing SessionEntry / ThreadItem / RuntimeEvent
  └── thin Tool/MCP protocol adapter

OhMyGame services
  ├── PluginCapabilities / PluginMcpHost
  ├── createAgentTools / ToolRunner
  ├── CanvasStore
  ├── game preview services
  └── workspace and artifact services

Provider and model layer
  ├── language/API providers
  ├── image providers
  ├── video providers
  └── 3D providers
```

Suggested files for the new native-runtime code:

```text
src/daemon/agent-runtime/
  contracts.ts
  registry.ts
  discovery.ts
  cli-process-supervisor.ts
  runtime-config.ts
  adapters/
    codex-app-server.ts
    claude-stream-json.ts
    opencode-json.ts
```

Do not add a Pi adapter that merely wraps `createPiSession`, an
`execution-supervisor.ts`, a second event bus, or independent media/canvas services.

## Runtime definitions and capabilities

A runtime definition declares static identity and probing. The protocol adapter starts the
session and translates events.

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

Capabilities must come from the installed binary/version probe. Do not infer a flag,
event, or model from the runtime name. Cache probe results by resolved binary path,
version, and modification time; re-probe on explicit Recheck or binary changes.

The adapter surface stays small:

```text
probe
authStatus
createSession(context) -> NativeCodingSession
```

`NativeCodingSession` implements the existing `CodingSession` methods (`prompt`,
`followUp`, `steer`, `abort`, `dispose`, and `subscribe`). The native adapter owns
stdin/stdout, JSON-RPC, JSONL, process groups, and protocol parsing. `AgentManager` remains
the caller of session operations and the publisher of public events.

## Runtime-specific transports

### Codex CLI

Use Codex App Server JSON-RPC for an interactive session:

```text
initialize
thread/start or thread/resume
turn/start
notifications
approval responses
thread/compact when supported
```

`codex exec --json` is a one-shot or compatibility fallback, not the primary interactive
transport. The adapter discovers the binary and version, checks Codex's own login state,
obtains native model/reasoning capabilities, stores the thread ID, translates tool,
approval, limit, error, cancel, resume, and compaction events, and injects the OhMyGame
bridge using the supported App Server mechanism.

Authentication uses Codex's own login/configuration. The daemon does not read or copy a
Codex refresh token.

### Claude Code CLI

Use stream-json or the official Agent SDK according to the installed version:

```text
claude -p --input-format stream-json --output-format stream-json
```

The adapter probes supported flags, checks Claude's native login state, writes prompt and
follow-up JSONL messages to a long-lived stdin pipe, keeps `--session-id`/`--resume`
semantics, translates permissions/tool/error/cancel events, and injects MCP through the
per-run mechanism described below. It must not assume `bypassPermissions` is safe or
available.

### OpenCode

Use the installed OpenCode JSON event dialect, for example:

```text
opencode run --format json
```

The adapter probes the dialect, discovers models and variants with the supported command,
captures `sessionID`, resumes with the supported session option, and handles native
provider/model/variant semantics. It may use a one-shot process per turn or a persistent
pipe when the installed version supports it; the adapter declares the mode instead of
assuming that every runtime has the same stdin lifecycle.

OpenCode can use Zen, OpenAI, Anthropic, Ollama, or another provider. The UI must show the
actual authentication and billing source rather than labeling every OpenCode session as a
Zen/OpenCode subscription.

## Conversation settings and persistence

Runtime selection is conversation-scoped in the first release. The project workspace UI
may expose the setting while a conversation is selected, but there is no competing
project-level runtime field. Existing conversations and missing fields default to `pi`.
A future project default, if needed, must define `project default -> conversation override`
precedence before it is added.

Extend the existing `ConversationAgentSettings` contract instead of introducing a second
selection object. The existing `model` and `reasoningLevel` fields are retained for Pi and
remain typed exactly as they are today:

```ts
interface NativeModelSelection {
  id: string; // runtime-native model ID or alias
  provider?: string; // required when the runtime has multiple provider namespaces
  variant?: string; // OpenCode-style variant, when supported
}

interface ConversationAgentSettings {
  runtime?: AgentRuntimeId; // omitted means "pi"
  model?: AgentModelRef; // Direct Runtime only
  reasoningLevel?: AgentReasoningLevel; // Direct Runtime only
  nativeModel?: NativeModelSelection; // Native Runtime model/alias
  nativeReasoningLevel?: string; // Native Runtime-specific value
}
```

The shared response type and the conversation persistence are extended together. Runtime
settings are read from and written to the same conversation detail returned to the renderer;
the runtime selection and native fields are stored in versioned session-tree custom entries.
The existing model and reasoning routes remain the source of truth for Pi, and new runtime
routes update the same conversation settings. A native model is never written into the
Provider language model catalog, and a native reasoning value is never coerced into Pi's
`AgentReasoningLevel`. Existing Pi model and reasoning values remain available when a user
switches back from a native runtime.

The create-conversation request accepts these fields as optional additions, with omitted
`runtime` meaning `pi`. Add a runtime update route such as
`PUT /projects/:projectId/conversations/:conversationId/runtime` with the native selection
and reasoning fields. The existing `/model` and `/reasoning` routes stay backwards-compatible
Pi routes; they do not try to validate or persist a native model. Runtime and native values
are validated against the selected runtime's capability result before being written.

Every native adapter must provide a persistent transcript through the shared
`SessionManager` contract used by `CodingSession`:

```ts
interface NativeCodingSession extends CodingSession {
  readonly sessionManager: Pick<
    SessionManager,
    "appendCustomEntry" | "getBranch"
  >;
}
```

The value must be backed by a real, persistent Pi `SessionManager` opened or created at the
existing conversation session path; an in-memory object is suitable only for tests. The
adapter may keep the full package object internally while exposing the current narrow
`CodingSession` view. The existing TypeScript property may remain optional for Pi test
doubles, but production native adapters must not omit it. `ConversationManager` discovers
conversation files through Pi session files, and `AgentManager` records plan state, prompt
details, errors, checkpoints, and turn ends through that manager. Omitting it would make
native conversations disappear after restart and would break transcript, Undo, and recovery.

Native wire events must be written to the shared transcript as user messages, assistant
messages, tool results, errors, and versioned custom entries when no ordinary
`SessionEntry` fits. Do not create a renderer-only transcript database.

Native session metadata is stored as a versioned custom entry in the active session tree,
for example:

```ts
interface NativeRuntimeEntry {
  version: 1;
  runtime: AgentRuntimeId;
  nativeSessionId?: string;
  nativeModel?: NativeModelSelection;
  nativeReasoningLevel?: string;
  nativeVersion?: string;
  turnId?: string;
  checkpointId?: string;
}
```

Append the entry when a native session is created or changes. Read the latest entry on the
current branch. Because it is part of the session tree, navigating to a branch before the
native session entry removes that resume metadata naturally; the adapter must create a new
native session when the entry is absent or its checkpoint/turn no longer matches. A process
ownership journal may still live outside the session tree for daemon restart orphan cleanup.

Existing `/models` continues to return Pi/API language models. Runtime discovery endpoints
may be added separately:

```text
GET  /agent-runtimes
GET  /agent-runtimes/:runtimeId
GET  /agent-runtimes/:runtimeId/models
POST /agent-runtimes/:runtimeId/recheck
POST /agent-runtimes/:runtimeId/login
```

## Prompt delivery, process ownership, and security

The process supervisor must declare the stdin mode instead of applying one rule to every
runtime:

```ts
type StdinMode =
  | { kind: "one-shot-file" } // plain-text prompt; close after the child consumes it
  | { kind: "persistent-pipe" }; // stream-json or JSON-RPC; close on session dispose
```

For a one-shot plain-text run, write a `0600` prompt file in a private runtime directory,
pass it as stdin, close the daemon descriptor after spawn, and remove it after the child
exits. This mode is suitable for `codex exec` and other commands that consume one prompt.

For Claude stream-json, Codex App Server JSON-RPC, and any OpenCode dialect that supports
interactive input, use a daemon-owned pipe. Keep the write side open for the native
session lifetime. Follow-up/steering messages and Codex approval responses must be sent
through that pipe; `dispose` closes it after the process exits. A one-shot file must never
be used for a protocol that expects later JSONL or JSON-RPC messages.

Every child has an independent process group. Cancellation terminates the complete process
tree. The daemon records owned process metadata and reclaims orphaned processes on startup.
The supervisor limits process count by runtime and project without blocking Pi's request
queue.

Discovery resolves each selected executable to an absolute path and records the version used
for the capability result. The supervisor starts that resolved path instead of resolving a
binary from the project workspace or an untrusted child `PATH`; the child may receive a
minimal safe `PATH` only for its own helper processes.

### Environment policy

The default policy is subscription-first and explicit: construct the child environment from
an allowlist, rather than copying `process.env`. This prevents an ambient API key from
silently changing the billing source. A user may explicitly select an API-key runtime
profile; the UI must then identify that source and the adapter may pass only the selected
key variables.

| Runtime     | Keep by default                                                                                                               | Pass credential variables only when explicitly selected                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Codex       | `PATH`, locale/temp variables, the user-selected native Codex config/auth directory, and `CODEX_HOME` when configured         | `OPENAI_API_KEY`                                                                                 |
| Claude Code | `PATH`, locale/temp variables, the user-selected native Claude config/auth directory, and `CLAUDE_CONFIG_DIR` when configured | `CLAUDE_CODE_OAUTH_TOKEN` for explicit CLI-token auth; `ANTHROPIC_API_KEY` for explicit API mode |
| OpenCode    | `PATH`, locale/temp variables, native OpenCode config/auth paths, and daemon-generated `OPENCODE_CONFIG_CONTENT`              | The selected provider's variables, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`               |

`HOME` is passed only when required by the selected native config path, preferably as an
explicit runtime config directory. Proxy variables are passed only when allowed by the
OhMyGame network policy. Never pass the daemon token, unrelated `OHMYGAME_*` variables,
unselected credential variables, or secrets in argv, prompts, transcripts, or logs.

### MCP and bridge capability lifetime

Never write a per-turn `.mcp.json` into a user's workspace. Workspaces may be tracked,
published, exported, or already contain user configuration, and concurrent conversations
would race on one file.

Use the strongest local transport supported by the runtime and version:

- Claude CLI uses a private `0600` `--mcp-config` file; add `--strict-mcp-config` only when
  the installed version probe confirms both flags and the expected config format, or use an
  official in-process SDK server.
- Codex uses App Server dynamic tools when the capability probe confirms them, or a private
  runtime configuration/stdio shim.
- OpenCode uses `OPENCODE_CONFIG_CONTENT` when supported, or a private stdio shim.

A temporary config is stored outside the workspace and lives until the child has consumed
it. For a persistent session it remains in the private runtime directory until session
dispose, then is removed. It is never logged or placed in argv when the protocol offers a
file or environment channel.

If a network bridge is unavoidable, issue a bridge capability scoped to the current
project, conversation, runtime, and turn. It is valid for every MCP/tool call during that
turn (it is not single-use), is revoked on completion, cancellation, failure, daemon
shutdown, or session disposal, and is not reused for the next turn. A long-lived MCP
connection must either refresh the turn capability in call metadata or reconnect before
that next turn. Local dynamic tools and in-process/SDK bridges are preferred because they
avoid a network credential entirely. A stdio shim that calls daemon HTTP must use the same
turn capability; a private inherited descriptor or IPC channel may avoid it.

## Plugins, Skills, canvas, and media

`PluginCapabilities.effective(projectType)` and the existing plugin skill resolver remain
the only inputs for enabled plugin capabilities. A pure `compileRuntimeConfig` step may
serialize that effective configuration for a runtime, but it does not own plugin
installation, settings, credentials, status, or lifecycle.

| Plugin capability   | Pi                       | Codex                           | Claude Code                  | OpenCode                           |
| ------------------- | ------------------------ | ------------------------------- | ---------------------------- | ---------------------------------- |
| Skills              | Native loading           | Context/files                   | Context/files                | Context/files                      |
| MCP servers         | Existing `PluginMcpHost` | App Server/config/dynamic tools | Strict per-run config or SDK | `OPENCODE_CONFIG_CONTENT` or stdio |
| Plugin settings     | Daemon-managed           | Daemon-managed                  | Daemon-managed               | Daemon-managed                     |
| Pi extensions/hooks | Native                   | Not directly compatible         | Not directly compatible      | Not directly compatible            |
| Plugin UI           | Renderer                 | Renderer                        | Renderer                     | Renderer                           |

If a runtime cannot represent a plugin capability, report that capability as unavailable;
do not silently build a second compatibility implementation. Configuration changes take
effect on the next turn or after the native session is restarted.

Native runtimes do not call the renderer. File-based canvas edits can use the runtime's
file tools and must be followed by `canvas_check`. Operations involving `CanvasStore`,
canvas generation history, cancellation, game preview, or media jobs go through daemon-owned
handlers. Those handlers reuse `createAgentTools`, `ToolRunner`, `CanvasStore`, and preview
services; adapters only translate schemas and transports.

Media model resolution remains:

```text
explicit ModelRef
→ project media default
→ global media default
→ first available compatible model
```

A native language model cannot be used as an image, video, or 3D model. Media calls return
the existing job ID, status, and artifact references; a text response from a CLI is not a
completed media job.

## Events and renderer display

`RuntimeEvent` in [shared contracts](../src/shared/contracts.ts) is the source of truth for
the SSE contract. A native adapter must not publish a second event family. The existing
`AgentManager` continues to emit the public events declared in `RuntimeEventData`, including:

```text
agent.started / agent.completed / agent.cancelled / agent.error
item.started / item.updated / item.completed
item.agentMessage.delta / item.reasoning.textDelta
plan.mode.changed
prompt.queued / prompt.steered / prompt.removed
```

Native wire events first map to the `CodingSession`/`SessionEntry` and `AgentSessionEvent`
path, then `AgentManager` creates `ThreadItem` and `RuntimeEvent` values. If a wire event
cannot fit an existing item, add a narrowly scoped `ThreadItem` subtype and continue using
`item.started`, `item.updated`, and `item.completed`; do not add a parallel SSE protocol.
Checkpoint, Undo, tree-navigation, usage, and workspace recovery details stay in the existing
session entries and manager state unless a future public event is deliberately added to the
shared contract and renderer.

Tool calls reuse `dynamicToolCall` and `mcpToolCall`. A native tool name or diagnostic value
must use an explicitly typed optional field or a dedicated `ThreadItem` subtype added to the
shared contract; do not rely on an untyped metadata bag that does not exist today. Approval,
compaction, sub-agent, and usage details use the same typed extension rule. If a CLI does not
provide complete input/output, show a marked summary rather than inventing details. CLI stdout
is never forwarded verbatim to the renderer.

## Performance and concurrency

Discovery is on demand and cached. Selecting Pi does not launch or probe every CLI, and
Pi's request path does not wait for native runtime discovery. Shared limits cover native
processes, MCP servers, media jobs, local-model GPU/memory, builds, npm processes, and
preview processes. A native runtime crash, timeout, or high CPU must not block Pi's queue.

## Recovery and migration

Persist both:

```text
OhMyGame transcript / checkpoint / artifact
Native CLI session ID in the active session-tree entry
```

The native ID is a fast resume path, not the only recovery source. If a CLI is removed,
its version changes incompatibly, or its session expires, create a new native session from
the latest OhMyGame transcript, checkpoint, workspace, and recovery summary.

Switching a conversation back to Pi means:

1. Set that conversation's `runtime` to `pi`.
2. Keep its existing Provider, `ModelRef`, reasoning setting, and media defaults.
3. Start a Pi session from the normalized transcript, workspace, and checkpoint.
4. Do not promise lossless native hidden-context import.

Removing a CLI later means disabling its adapter, discovery entry, and settings UI. Provider,
media, canvas, plugin, checkpoint, and Pi code remain usable without a migration rewrite.

## Implementation plan

### Phase 1: shared infrastructure

- Runtime definition, registry, discovery, and capability probes.
- `CliProcessSupervisor` with one-shot-file and persistent-pipe stdin modes.
- Process groups, cancellation, orphan recovery, environment profiles, and private runtime
  configuration files.
- Native adapters implementing `CodingSession` with a required production `SessionManager`.
- Versioned native runtime custom entries and existing `RuntimeEvent`/`ThreadItem` mapping.
- Fake CLI fixtures for process, stream, cancellation, and recovery tests.

### Phase 2: OpenCode vertical slice

- Supported `opencode run --format json` dialect.
- Adapter-declared stdin mode and JSON event parser.
- Session ID capture/resume and model/variant discovery.
- `OPENCODE_CONFIG_CONTENT` or stdio MCP injection outside the workspace.
- One OhMyGame tool and one media job end to end.

### Phase 3: Claude Code

- Stream-json or SDK transport with persistent stdin when required.
- Native login/status, `--session-id`, and `--resume`.
- Strict per-run MCP configuration or SDK server.
- Permission modes and tool/file/media/canvas bridge.

### Phase 4: Codex App Server

- JSON-RPC initialize, thread/turn lifecycle, approval responses, native model/reasoning,
  rate-limit state, compaction, and resume.

### Phase 5: shared UI enhancements

- Runtime settings and native model picker.
- Approval, usage/limit, steering, sub-agent, and compaction display as ThreadItems.

## Acceptance criteria

### Compatibility

- Existing projects continue to use Pi without migration.
- Existing language providers, API/local models, Ollama, LM Studio, media defaults, project
  overrides, and model visibility remain intact.
- Existing `/models` responses remain compatible.

### Runtime

- Each CLI is independently detected, version-checked, and reported with login status.
- Each CLI uses its own protocol adapter and declares its stdin mode.
- Long prompts and follow-up/approval messages are not truncated or closed early.
- Cancellation terminates the complete process tree, and daemon restart reclaims owned orphans.
- Native IDs resume only when their active session-tree metadata and checkpoint still match.

### Tools and product behavior

- Enabled Skills and MCP are serialized per runtime without writing secrets to workspaces.
- Native runtimes can call canvas checks, canvas media generation, game tools, image, video,
  and 3D jobs through existing daemon handlers.
- Renderer uses existing events and tool cards; runtime-specific information is additive.
- Plan, prompt queue, checkpoint, Undo, transcript, and recovery behavior remain available.

### Security and recovery

- The daemon token and unrelated credentials never enter a child environment.
- Ambient API keys do not silently change billing; explicit API profiles identify their source.
- Bridge capabilities are turn-scoped, revocable, and never single-use or daemon-wide.
- Native session expiry falls back to the OhMyGame transcript/checkpoint.
- Removing a native adapter leaves Pi, Provider, media, canvas, and plugin systems usable.

## References and findings

- [Genex Desktop](https://github.com/genex-games/genex-desktop)
- [Open Design](https://github.com/nexu-io/open-design)
- [Genex engine implementations](https://github.com/genex-games/genex-desktop/tree/dev/src/substrate/engines), including
  [external process ownership](https://github.com/genex-games/genex-desktop/blob/dev/src/substrate/engines/external-cli.ts),
  [Codex App Server](https://github.com/genex-games/genex-desktop/blob/dev/src/substrate/engines/codex-app-server.ts),
  [Claude Code](https://github.com/genex-games/genex-desktop/blob/dev/src/substrate/engines/claude-code.ts), and
  [OpenCode](https://github.com/genex-games/genex-desktop/blob/dev/src/substrate/engines/opencode-cli.ts)
- [Open Design runtime implementations](https://github.com/nexu-io/open-design/tree/main/apps/daemon/src/runtimes), including
  [process launch](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/agent-process.ts),
  [MCP configuration](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/mcp.ts),
  [Claude stream handling](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/claude-stream.ts), and
  [OpenCode event handling](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/opencode-event-plugin.ts)

These files informed the boundary decisions in this proposal. They use different runtime
registries, process lifecycles, authentication policies, and event stores, so neither project
is treated as a drop-in architecture for OhMyGame. The common guidance extracted here is to
separate runtime discovery/process ownership from protocol adapters, choose stdin lifetime per
protocol, keep MCP configuration outside user workspaces, and prefer local or in-process tool
bridges when they avoid a network credential.
