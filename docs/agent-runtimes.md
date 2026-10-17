# Agent Runtime integration specification

Status: reviewed integration design. The implementation first merged in
[PR #289](https://github.com/WhiteTowerAI/ohmygame/pull/289), was reverted by
[#290](https://github.com/WhiteTowerAI/ohmygame/pull/290) pending acceptance,
and is reintroduced with review fixes. Native runtimes are optional and
disabled by default; implementation, automated coverage, and real acceptance
are distinct milestones.

This document records the architecture and delivery decisions from
[PR #258](https://github.com/WhiteTowerAI/ohmygame/pull/258). It replaces the
initial transport examples and phased proposal with the boundary used by the
reviewed implementation. The implementation guide is
[coding-agents.md](coding-agents.md); shared types and tests remain the source
of truth for individual protocol fields.

## Decisions and ownership

- A Provider represents a model service, authentication, catalog, and API
  protocol. An Agent Runtime owns an agent loop, native context, permissions,
  and, for external CLIs, a process.
- Pi remains the default Direct Runtime for existing conversations, API
  providers, and local models. Claude Code, Codex, and OpenCode are optional
  Native Runtimes using their own sign-in and model semantics.
- `AgentManager` remains the sole conversation/turn orchestrator. A
  `NativeCodingSession` implements the existing `CodingSession` boundary;
  protocol drivers implement transport and translate events.
- Conversation files, checkpoints, plan state, queues, errors, and public
  events retain their existing owners. Do not add a second conversation
  database, run/event store, or execution supervisor.
- The CLI process layer owns spawn, pipes, cancellation, process groups,
  ownership records, and private directory cleanup. Its journal stores process
  identities for orphan recovery, never conversation state.
- Image, video, 3D, canvas, preview, and plugin behavior stays in daemon services.
  Adapters reuse those services through a tool bridge.

```text
Renderer: existing model picker, timeline, approvals, context/usage
  │ HTTP + SSE / RuntimeEvent / ThreadItem
  ▼
AgentManager: turns, queues, checkpoints, errors, cancellation
  ├── existing Pi CodingSession
  └── NativeCodingSession: shared transcript, native context lifecycle
       ├── Claude Code driver: stream-json/control requests
       ├── Codex driver: App Server JSON-RPC
       └── OpenCode driver: local HTTP + SSE
            │
            ├── CLI process ownership and private runtime files
            └── ToolBridge → existing tools, canvas/media/preview, plugin MCP
```

The implementation lives in `src/daemon/agent-runtimes/`, with public types in
`src/shared/agent-runtimes.ts` and `src/shared/contracts.ts`. These are module
boundaries, not a requirement for a new generic framework. A future SDK may
replace a driver's transport without changing orchestration or persistence.

## Selection, settings, and discovery

Configure CLIs under **Providers & Models → Coding agents** and choose native
models in the existing conversation model picker. Do not add a competing
runtime selector or runtime-specific conversation settings route.

The existing `ModelRef { provider, id }` identifies both the runtime and its
native model. Runtime provider IDs are `claude-code-cli`, `codex-cli`, and
`opencode-cli`; the suffix avoids collisions with ordinary Pi providers, such
as `opencode`. These are not `ProviderSummary` records and are not inserted
into the Provider language catalog. A separate persisted `runtime` field would
create another source of truth and is unnecessary.

`ConversationAgentSettings.model` retains this shared reference. Pi
`reasoningLevel` keeps its existing enum; native effort/variant values are
stored separately as `nativeReasoningLevel` and validated against that native
model's advertised values. A native model lists no Pi reasoning levels, and
routes that take a default or a new conversation's level accept
`nativeReasoningLevel` for it and reject Pi's `reasoningLevel`. Neither value
is coerced into the other. Preserve stored native effort while discovery is pending,
including when a conversation is reopened after daemon restart.

The selected conversation model wins. New conversations reuse the project's
recent model selection, then configured defaults/available models. Global
native defaults retain model and effort together. An explicitly different
model does not inherit an incompatible effort. Existing conversations with no
native selection continue through Pi.

`agent-runtimes.json` stores per-runtime `enabled` (default false),
`isolateUserConfig` (default true), optional absolute `binaryPath`, and optional
`defaultModel`. It contains no credentials. Damaged settings fall back to safe
defaults.

| API                                                       | Contract                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /models`                                             | Pi/API language models and Pi default; unchanged for one-off generation        |
| `GET /models?runtimes=1`                                  | Conversation catalog including enabled native models; reports loading runtimes |
| `PUT /models/default`                                     | Save the selected default; retain native effort with a native model            |
| `PUT /projects/:p/conversations/:c/model`                 | Change the conversation model and derive its runtime                           |
| `PUT /projects/:p/conversations/:c/reasoning`             | Validate Pi reasoning or native effort for the selected model                  |
| `GET /agent-runtimes`                                     | Discovery/status; `?recheck=1` refreshes probes                                |
| `PATCH /agent-runtimes/:id`                               | Enablement, configuration isolation, executable override                       |
| `POST /agent-runtimes/:id/recheck`                        | Refresh one runtime                                                            |
| `POST /agent-runtimes/:id/login`                          | Return the CLI's login URL or terminal command                                 |
| `POST /projects/:p/conversations/:c/approvals/:requestId` | Answer a pending approval                                                      |

Discovery is lazy; Pi requests do not wait for it. An explicit executable wins.
Otherwise choose the newest installed SemVer among PATH, login-shell PATH,
common install directories, and known bundled copies. Resolve the executable
to an absolute path and deduplicate real paths. Version/probe caches are
bounded, expire failed results, honor Recheck, and discard in-flight catalog
results after configuration changes. Paginated native catalogs must be read
completely. A successful model listing is not proof of account entitlement;
billing/auth sources that cannot be established remain unknown.

## Shared transcript and native context

Every production native session uses a persistent Pi `SessionManager` at the
existing conversation session path. Conversation listing, branch navigation,
Undo, plan state, prompt details, errors, and restart recovery depend on it.
An optional interface property for Pi test doubles does not make production
native persistence optional.

Native messages/tool results are display and recovery records in that file.
Adapters must not reconstruct native hidden context or promise lossless replay
into another runtime. Native compaction and terminal approval decisions use
versioned custom entries when ordinary messages do not represent them.
Reloading approval history never restores permission grants.

Native resume metadata is also a session-tree custom entry, not a sidecar:

```ts
interface StoredNativeSession {
  version: 2;
  runtime: AgentRuntimeId;
  state: "active" | "ready" | "invalid";
  sessionId?: string;
}
```

Only the latest matching `ready` marker on the current branch may resume.
Write `active` before native work and `ready` only after successful completion;
crashes, failed turns, cancellation, and interrupted writes cannot reuse a
previous ready context. Invalidate on every rewind/edit/restore, even if the
native ID is unchanged, and after intervening Pi work, incompatible model
changes, or legacy metadata.

When context is absent or invalid, start fresh with a deterministic, bounded
handoff: recent visible turns, changed files, the structured plan, and restore
notices. Exclude private prompt context and do not make another model call.
An explicitly expired/not-found native resume receives one fresh-context retry,
without appending the user message twice. Other failures remain visible.
Moving back to Pi uses the shared messages; native hidden state is not imported.

## Checkpoints, queues, and cancellation

Extract/reuse `recordCheckpoint` at the existing Pi checkpoint boundary:
immediately before storing/delivering each user message. Pi keeps its extension;
`NativeCodingSession` calls the same helper. Moving all checkpoint logic into
`AgentManager` is unnecessary if queued deliveries preserve this invariant.
This is a deliberate adjustment to the review's proposed core refactor.

Every queued native message gets its own snapshot before delivery. Native
**Next** messages wait for the active turn, then run FIFO before ordinary
follow-ups. They are not concurrent mid-turn injection. Pi retains its own
steering behavior. The UI must describe the supported queue behavior instead
of claiming steering parity across CLIs.

A CLI idle for ten minutes is stopped and its replacement resumes the ready
native session with the next message, so open conversations do not each keep
a process. Check abort before spawning and again before delivery. Interrupt waits are
bounded and fall back to stopping the process group. A turn must settle on
spawn failure, close, transport loss, timeout, and cancellation, including
startup races. Ignore late callbacks/results after settlement.

Register children with desktop lifecycle management and persist verified
owner/child process identities for standalone orphan recovery. Reclaim only
verified orphans; preserve other live daemons' processes and directories.
Delete generated configuration and Skills after the child stops. Process-group
cleanup cannot reclaim unidentifiable processes or children that escape the
group; it is not an OS-wide process supervisor or resource scheduler.

## Runtime transports and compatibility

| Runtime     | Interactive transport and tools                                                        | Tested protocol floor |
| ----------- | -------------------------------------------------------------------------------------- | --------------------- |
| Claude Code | Long-lived stream-json stdin/stdout; control requests and MCP tool callbacks           | 2.1.76                |
| Codex       | App Server JSON-RPC; native `dynamicTools`, approval responses, thread/turn lifecycle  | 0.163.0-alpha.10.2    |
| OpenCode    | Private authenticated loopback `serve`; HTTP requests, SSE events, daemon MCP endpoint | 1.18.33               |

These are tested capability floors, not certification of all later releases.
Check required capabilities and refuse unsafe fallbacks. Direct protocols keep
the installed executable and avoid introducing SDK dependencies now. Prefer an
SDK later if it removes maintenance while preserving hooks, permissions, MCP,
resume, and cancellation; no separate SDK architecture is needed.

Claude's permission controls use both `PreToolUse` and `can_use_tool`; validate
control callbacks, planning restrictions, and allowed MCP calls. Planning runs in
Claude's default permission mode, not its plan mode, so Claude records the plan
with `update_plan` rather than its own plan file. Background tasks and scheduled
prompts are disabled, because their reports would arrive after the turn ends.
Bridge tools are marked always loaded so tool search does not hide them. Discover
models from `initialize` or `list_models` as supported; expose failed/empty
catalogs as diagnostics. A sole callback path is not a sufficient assumption.

Codex requires named permission profiles and verifies `activePermissionProfile`
before delivering input. Do not silently fall back to legacy `workspaceWrite`,
which permits reads outside the workspace. Use native scoped permission
requests; disable unrestricted command/patch escalation. Planning gets a
read-only profile and cannot grant writes. Disable shell snapshots and rebuild
the tool environment without native authentication tokens.

OpenCode must establish the SSE connection before sending a prompt; HTTP calls
have timeouts and stream loss fails/stops the active turn. Permission paths use
the native worktree/search metadata, not an assumed common root. Verify child
session ancestry through the API before handling its approval; unrelated
sessions cannot inherit authority.

The first batch uses interactive pipes or HTTP/SSE. A future one-shot plain-text
adapter may use a private `0600` prompt file and close stdin after consumption.
Never apply that lifecycle to JSON-RPC or stream-json, which need later input.
`codex exec --json` and `opencode run --format json` are not the implemented
interactive transports or a permission fallback.

## Tools, plugins, and Skills

Expose one daemon-owned OhMyGame tool surface using `createAgentTools` and the
existing canvas/media/preview services. Proxy active plugin MCP through the
existing plugin adapter, hosted in a model-less Pi session. It does not run a
second model loop. Effective plugin capabilities and project-type rules remain
the source of truth, and plugin credentials stay in the daemon.

Claude uses its control/MCP callbacks, Codex uses dynamic tools, and OpenCode
uses a private loopback MCP endpoint. Any network bridge capability is scoped
to the current turn, permits multiple calls during that turn, and is revoked
permanently on completion, failure, cancellation, or disposal. Rotate it for
every later turn. Pass abort signals to tools and discard late results. Never
reuse the daemon token or write `.mcp.json`/credentials into a workspace.

Stage enabled Skills in a private session directory outside the workspace.
Copy regular files only, omit symbolic links, and require a regular `SKILL.md`.
Permit reads only within that session's staged roots; writes and neighboring
app data stay protected. Executing staged scripts still needs command approval.
Remove staged files only after the CLI stops.

New plugin capabilities must be expressible as Skills or MCP. Pi extensions are
not portable. Native canvas file edits still need `canvas_check`; media jobs,
artifacts, retries, defaults, and cancellation reuse their existing handlers.
A native language model is not an image, video, or 3D model.

## Permission and configuration boundary

Approvals ship with each adapter, including exact command/path/access/network
information and `allow`, `allow-session`, or `deny`. Keep terminal outcomes in
the timeline; deny pending requests on stop and allow retry after an HTTP error.
Cache conversation grants only for the exact request. Do not issue broad native
command-prefix grants.

The shared policy resolves symlinks and missing descendants, accounts for
custom CLI credential roots, and denies direct requests for credential homes,
OhMyGame data, other projects, or ancestors that expose them. Workspace file
operations and a small set of simple read commands may proceed; external paths,
builds, interpreters, Git, compound commands, and unknown scopes need approval.
Globs, brace expansion, and recursive link-following options (`grep -R`,
`rg -L`, `ls -LR`) are unknown scopes: they reach paths the command text does
not name. A native agent's own tools that touch no file and run no command,
such as Claude Code's task list, Skill loading, subagents and web research,
run without approval; their subagents' tool calls are still checked.
Explicit permission grants must contain understood, concrete roots; reject
root-filesystem grants, globs, unknown forms, and protected paths.

This policy is not universal OS isolation. Codex command execution has a native
OS sandbox with minimal runtime/workspace/private-temp/Skill access and
explicit protected-root denials. Its parent process still uses native auth and
configuration. Claude/OpenCode callback controls cannot guarantee confinement
of arbitrary approved programs, plugins, or subprocesses. Shell text inspection
alone is heuristic. Strong credential confidentiality across all runtimes
requires a separate sandbox and isolated credentials; that is deferred work.

Build the child environment from an allowlist: PATH, HOME, locale, temp,
proxy/certificate settings, and the runtime's own configuration directories.
Claude may retain its subscription `CLAUDE_CODE_OAUTH_TOKEN`; do not forward
ambient provider API keys, the daemon token, or unrelated `OHMYGAME_*` values.
An explicit environment API-key profile is not implemented. Native stored
provider credentials may still determine billing; display only what is known.

Configuration isolation defaults on:

- Claude: empty `--setting-sources` and strict MCP configuration.
- Codex: turn off user MCP and notification hooks; fail startup if inspection
  fails. User Skills, plugins, and AGENTS.md can still load; disclose partial
  isolation in settings.
- OpenCode: private config, `--pure`, external Skills disabled, and project
  config disabled.

A per-runtime **Use my own CLI configuration** toggle opts into configuration
inheritance. It does not disable the shared approval policy. Configuration
isolation and process sandboxing are separate capabilities.

## Events and UI

Map native events into the existing `AgentSessionEvent`, `SessionEntry`,
`ThreadItem`, and `RuntimeEvent` path. Shared contracts are authoritative;
examples include `agent.*`, `item.*`, `plan.mode.changed`, and `prompt.*`.
Do not introduce a parallel native SSE/event family or untyped metadata bags.
Unknown tool output or measurements remain unknown rather than invented.

Show native model/effort, approvals, compaction, and context/usage in the existing
controls. Use native context windows when reported; keep Codex quota windows
and reset times separate from context occupancy. Add UI text in both English
and Chinese; prompts sent to agents remain English.

## Delivery status and release gate

The three adapters have Full integration scope: OhMyGame tools, approval UI,
resume/rebuild, manual/native compaction, queued continuation, usage where
reported, and checkpoint recovery. Full describes implemented scope, not a
promise of identical native features or completed platform acceptance. There
is no generic Basic tier: adding a declarative entry alone cannot run another
CLI.

The implementation covers shared infrastructure, all three
drivers, plugin/Skill bridging, settings/model selection, approvals, and
lifecycle recovery. Focused fixtures cover branch invalidation, expired resume,
queue checkpoints, cancellation races, token revocation, SSE loss, model/default
migration, planning writes, child approvals, staged Skill boundaries, and
verified orphan recovery. No rewrite of the runtime architecture is required.

Validation recorded during review on macOS:

- Public local checks: 2,916 tests passed and 23 skipped; typecheck, renderer
  build, Node startup/build, plugin preparation, and changelog checks passed.
  Private cloud contracts remain skipped where unavailable.
- Real Codex 0.163.0-alpha.10.2 and OpenCode 1.18.33 acceptance passed: file
  edits, shared tool use, continuation, daemon restart, compaction, message edit,
  checkpoint restore, external dummy-file denial, approval history, and
  cancellation during an executing shell command.
- Actual Codex sandbox commands additionally verified workspace read/write,
  denied external/protected/symlink reads, and denied planning writes. Actual
  OpenCode read a staged Skill reference without manual approval.
- Native effort selection/reload was exercised in the browser. Fixture/API
  approval tests passed; an extra real Codex browser approval click scenario
  did not complete and is not counted as passed.

Real Claude Code 2.1.302 / Sonnet 5.5 acceptance passed on macOS for the
reintroduced implementation: the same workflow as above (cancellation in
619 ms), loading a staged Skill without approval, and a planning turn that
searched with read-only commands, recorded its plan with `update_plan` and left
the workspace unchanged. OpenCode 1.18.33 / `mimo-v2.6-flash-free` passed the
same extended workflow after its fixes. That acceptance found and fixed: tools never shown as
running, subagents and shells that ran in the background past the turn, Claude's
own plan-file workflow in place of `update_plan`, planning that could not
search, OhMyGame tools deferred behind Claude's tool search, OpenCode
subagents refused in planning, and bare OpenCode rejections that ended the
planning loop. Codex 0.163.0 (the first stable release with named
permission profiles) / `gpt-6-luna` passed the same extended workflow after
one more fix: it reads `AGENTS.md` from every folder between the Git root and
the workspace through the permission profile, so a workspace inside another
repository failed to start a thread. `project_root_markers = []` makes the
workspace its own root, so only the workspace's `AGENTS.md` is read, as for
OhMyGame's own agent. Linux/Windows real CLI acceptance,
Electron-specific native lifecycle acceptance, paid media/game-playtest flows,
and universal OS confinement are not established by these checks. On Windows,
discovery finds `.exe` programs only: Node cannot start the `.cmd` shims npm
installs without a shell. Keep native
runtimes opt-in and require real acceptance on a target platform before
advertising it as validated. Latest-head CI must pass before merging; earlier
local evidence or an old green check does not satisfy that gate.

Deferred work includes a generic Basic adapter, stronger cross-runtime OS
isolation, explicit API-key environment profiles, and maintenance/migration of
version-specific transports. New runtime support needs a driver plus protocol
and real acceptance tests. This boundary is the long-term design; CLI wire
protocols and capability floors remain maintained compatibility code.

## Related contracts

- [Agent/session orchestration](../src/daemon/agent.ts)
- [Shared model and runtime events](../src/shared/contracts.ts)
- [Agent tools](../src/daemon/agent-tools.ts)
- [Checkpoint and Undo contract](checkpoints.md)
- [Plugin package and portability contract](plugins.md)
- [Runtime and trust boundary](runtime.md)
- [Contribution checks](../CONTRIBUTING.md#make-and-check-your-change)
