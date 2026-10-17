# Coding agents

A conversation can run on a coding agent CLI that is already installed on the
computer: Claude Code, Codex, or OpenCode. The CLI runs the agent loop with its
own sign-in and model. OhMyGame keeps the conversation, checkpoints and Undo,
its canvas, media, game and plugin tools, and the approval decisions.

The [integration specification](agent-runtimes.md) records the architecture,
accepted tradeoffs, and validation limits.

## Using one

Providers & Models lists the coding agents under **Coding agents**. Each row
shows whether the CLI was found, its version, and how its requests are billed.
Agents are off by default. Enabling the switch offers their models in the conversation model picker; the
detail page signs in, checks again, chooses the executable, and decides whether
the person's own CLI configuration applies.

The model picker lists each agent's models in a group named after the agent.
Choosing one runs the conversation on that agent. A model reference names both:
its provider is the agent's ID (`claude-code-cli`, `codex-cli`, `opencode-cli`),
its ID is the agent's own model name, such as `sonnet` or
`anthropic/claude-sonnet-5`. The `-cli` suffix keeps these apart from Pi
providers of the same name; Pi has its own `opencode` provider.

`GET /models` lists Pi's models only, for canvas text and other one-off
generation. Conversation pickers ask for `GET /models?runtimes=1`, which adds
the enabled agents' models. An agent that is slow to list them is named in
`loadingRuntimes`, and the picker asks again shortly. A new conversation in a
project keeps the coding agent the person was using; with no model provider
connected, the first conversation starts with the first agent that is set up.

Native effort/variant strings are exposed as `nativeReasoningLevels` and stored
separately from Pi's reasoning enum. Saving a native default keeps both model
and effort as `defaultModel` in `agent-runtimes.json`; it applies while that
agent is enabled and offers the model. Choosing a Pi default clears it. Plain
`GET /models` continues to report Pi's default for one-off generation.
An explicitly chosen different model does not inherit an incompatible effort.
Context usage uses the native context window when reported. Codex quota
windows and reset times are displayed separately; missing measurements remain
unknown rather than being inferred from token totals.

![Codex conversation with a denied read, a cancelled turn, and Medium effort selected](assets/coding-agent-native-effort.png)

## What OhMyGame keeps

A coding agent session (`NativeCodingSession`) implements the same
`CodingSession` interface as Pi, so `AgentManager` runs it unchanged: queues,
plan mode, cancellation, errors and events are the same code.

- **Conversation record.** Every user message, answer, reasoning block and tool
  result is stored as a Pi message in the conversation's session file, so the
  conversation list, history, message edits and restarts work as for Pi. These
  messages are a record; the CLI keeps its own context.
- **Checkpoints.** The workspace snapshot is taken before each user message is
  stored, exactly where Pi's checkpoint extension takes it, through the shared
  `recordCheckpoint`. Turn changes and Undo therefore cover whatever the CLI
  changed.
- **Native session.** The CLI's own session or thread ID is stored as an
  version-2 `ohmygame-native-session` custom entry on the branch. Only a
  `ready` marker resumes; `active` marks an unfinished turn and `invalid`
  requires a rebuild. The next message
  continues it (`--resume`, `thread/resume`, the OpenCode session). Every edit
  or restore invalidates context, even when the native ID is unchanged. Later
  Pi messages/model changes, cancellation, failure, legacy metadata and
  interrupted writes also invalidate it. An expired native session triggers
  one fresh-context retry with handoff rather than silently losing history.
- **Handoff.** When an agent joins a conversation it has not seen, its first
  message carries a summary built from the stored record: recent turns and the
  files the earlier agent worked on, the structured plan, and restore notices.
  It asks no model, and private context such
  as file references is left out. Moving back to Pi needs no summary; Pi reads
  the stored messages.

Terminal approval decisions and native compaction results are custom entries
in the same session file. Reload restores their history without restoring
permission grants. No second conversation manager or event database is needed.

## How each agent is driven

| Agent       | Transport                                                        | OhMyGame tools                                          | Approvals                                            |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Claude Code | `claude -p` with stream-json in and out; one process per session | In-process MCP server answered over the same pipe       | PreToolUse hook plus `can_use_tool` control requests |
| Codex       | `codex app-server` JSON-RPC; one thread per conversation         | The thread's dynamic tools, answered over the same pipe | App server approval requests                         |
| OpenCode    | `opencode serve` on loopback with its own password               | Remote MCP on the daemon with a turn token              | `permission.asked` events, answered on the server    |

Each stdin stays open for the session. Native queue prioritization means
**Next**: after the current turn, before ordinary follow-ups. Mid-turn native
injection is excluded because concurrent file writes cannot provide an
independent checkpoint before delivery. Processes run in their
own process group, are registered with the desktop app for crash cleanup, and
are stopped when the daemon closes.

Cancellation checks before/after startup prevent late input delivery. Interrupt
waits are bounded, then the CLI is stopped. HTTP calls time out and loss of
OpenCode's SSE stream fails the pending turn. Standalone startup also reclaims
verified orphan process groups from `agent-runtimes/processes`, checking both
the daemon and child's executable/birth identity before killing anything.
Private folders carry the daemon's ownership identity as well: startup reclaims
verified orphans while preserving another live daemon's folders. Configuration
and Skills are removed only after the CLI stops. Unverifiable identities and
subprocesses that escape their group cannot be reclaimed this way.

OhMyGame's tools are the handlers Pi uses (`createAgentTools`), offered through
`ToolBridge`. Plugin MCP servers reach the agent through the same `mcp` tool
Pi uses, run in a model-less session in the daemon, so plugin settings,
switches and credentials stay in the daemon. Skills (plugin Skills and
OhMyGame's own) are copied into a private folder for the session and handed to
the CLI: a session plugin for Claude Code, `skills/extraRoots/set` for Codex,
`skills.paths` for OpenCode. Staging copies regular files and omits symbolic
links, so it cannot copy an external credential through a Skill's link. The
policy permits reading only this session's staged Skill roots, while their
writes and adjacent app data remain protected. Running a staged script still
requires command approval. Nothing is written to the workspace.

The OpenCode tool endpoint, `POST /agent-runtime-bridge/mcp`, takes the
turn's token instead of the app's. It is revoked permanently on completion,
cancellation, failure or disposal; each later turn gets a new token. Bridged
tools receive the turn's abort signal and late results do not enter its timeline.

New plugin capabilities must be expressible as Skills or MCP servers; Pi
extensions do not reach coding agents.

## Approvals and limits

In the project folder an agent works without asking, as OhMyGame's own agent
does. `judgeApproval` decides each request first:

- **Deny** anything that reaches a CLI sign-in folder (`~/.claude`,
  `~/.codex`, OpenCode's folders), `~/.ssh` and similar, OhMyGame's data folder,
  or another project. Paths resolve symlinks, including missing descendants,
  and include custom CLI credential homes. A command reaches a folder when it names it or a folder
  that holds it, quoted or not.
- **Allow** workspace file requests and a small set of simple read commands.
- **Ask** the person for paths outside the workspace and other commands,
  including build scripts, interpreters, Git and
  compound commands. A request
  Codex makes to leave its sandbox always asks, because Codex only makes one
  when its sandbox would stop the command.

A request the policy leaves to the person appears as an approval card above the
composer: Allow, Allow for this conversation, or Deny. Answered requests stay
in the timeline. Stopping the turn denies every request still waiting.

Explicit permission grants show all read/write roots and network access.
Codex grants only understood concrete paths that were reviewed, for one turn.
Conversation approvals are cached for the exact request; broad native prefix
grants are not issued. OpenCode read/edit/search/shell requests are mediated,
with file patterns resolved from its reported Git root rather than assuming
that it equals the application workspace. Search metadata identifies the actual
search directory. Child-session permission requests are admitted only after
verifying their ancestry through the native API; they cannot be dropped merely
because their session ID differs from the parent.

These are native permission controls, not a universal OS sandbox. CLIs run as
the signed-in OS user; hooks and sandbox capabilities differ, and do not
necessarily mediate every subprocess, plugin or read. Strong confidentiality
isolation requires a separate process/container sandbox and isolated
credentials. Shell syntax checks alone cannot provide it.

Codex requires named permission profiles and checks that its app server actually
activated the requested profile before delivering a prompt. The legacy
`workspaceWrite` policy is not a fallback: it permits reads outside the project.
The profiles allow runtime files, this workspace and private temporary/Skill
folders; credential roots, app data and other projects are denied. Unlisted
paths require a scoped permission request. Unrestricted command/patch sandbox
escapes are refused. Planning uses a read-only profile and cannot accept write
grants. The native `request_permissions` tool is enabled explicitly, with grants
limited to the current turn. Shell snapshots are off and the shell environment
is rebuilt from the same allowlist, without CLI authentication tokens.

This enforces Codex command boundaries through its own OS sandbox. It does not
isolate the CLI parent process, which still needs its sign-in and configuration.
The callback controls for Claude Code and OpenCode do not offer the same OS
boundary for arbitrary shell programs a person approves.

## Environment and isolation

A CLI gets an environment built from an allowlist: PATH, HOME, locale,
temporary folders, proxies, certificates, and that CLI's own configuration
folder variable. API keys are left out, so an ambient key never moves a
subscription to metered billing; Claude Code keeps `CLAUDE_CODE_OAUTH_TOKEN`,
which is a subscription sign-in. The daemon's token and `OHMYGAME_*` variables
never reach a CLI. The executable is resolved to an absolute path from the
person's choice, PATH, the login shell's PATH, usual install folders, and known
bundled copies such as ChatGPT's Codex. An explicit path wins; automatic
discovery chooses the newest SemVer, including prerelease ordering, and retries
failed version probes. Recheck also invalidates successful probes. Catalog
refreshes honor their TTL and discard results from a superseded configuration.

By default each agent runs without the person's own configuration:

- Claude Code: `--setting-sources ""` and `--strict-mcp-config`.
- Codex: the person's MCP servers and notification hook are turned off for the
  thread; a failure to inspect their configuration stops startup. Codex still loads Skills, plugins and AGENTS.md from its own folder;
  the settings page says so.
- OpenCode: a private configuration folder, `--pure` (external plugins off),
  external Skills disabled, and no project configuration.

**Use my own CLI configuration** lifts this for an agent.

## Settings and API

`agent-runtimes.json` in the data directory stores, per agent, `enabled`
(default off), `isolateUserConfig` (default on), an optional absolute
`binaryPath`, and an optional native model/effort `defaultModel`. A damaged file falls
back to the defaults. Credentials remain in the CLI's own store.

| Route                                                     | Purpose                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /agent-runtimes`                                     | Status of every agent; `?recheck=1` probes again               |
| `PATCH /agent-runtimes/:id`                               | `enabled`, `isolateUserConfig`, `binaryPath`                   |
| `POST /agent-runtimes/:id/recheck`                        | Probe one agent again                                          |
| `POST /agent-runtimes/:id/login`                          | Start the CLI's sign-in; returns a browser URL or a command    |
| `PUT /projects/:p/conversations/:c/reasoning`             | Select a native effort/variant string                          |
| `POST /projects/:p/conversations/:c/approvals/:requestId` | Answer an approval request: `allow`, `allow-session` or `deny` |

Status and models are probed only when asked for and cached by executable
signature; choosing Pi never starts a CLI.

## Adding an agent

1. Add its ID to `AGENT_RUNTIME_IDS` and a definition to
   `AGENT_RUNTIME_DEFINITIONS` (binaries, version arguments, minimum version,
   sign-in command).
2. Teach `probeAuth` and `probeModels` how to ask it who it is and what models
   it has.
3. Write a `NativeDriver` that runs a turn and reports through the
   `NativeTurnSink`, and create it in `AgentRuntimeService.createSession`.
4. Add an icon to `PROVIDER_ICONS` and test the driver against a fake process
   (`setAgentProcessSpawner`), as `test/agent-runtime-drivers.test.ts` does.

The Provider, media, canvas, checkpoint and plugin code does not change.

## Compatibility and real acceptance

The tested compatibility floors are Claude Code 2.1.76, Codex
0.163.0-alpha.10.2 (named permission profiles) and OpenCode 1.18.33. Version checks are protocol floors, not certification of every newer
release. Claude discovery accepts catalogs from either `initialize` or
`list_models`; failed/empty catalogs produce a `models-unavailable` diagnostic.
Being signed in and seeing a model does not guarantee account entitlement.

The direct adapters preserve the installed executable and shared host services.
Adopting an SDK is useful when it removes transport maintenance while retaining
hooks, MCP, resume and cancellation; it does not require replacing orchestration.
Claude's direct control protocol and Codex's experimental dynamic tools need
compatibility tests when their CLIs change. A generic Basic CLI adapter is not
implemented; each new CLI needs discovery, a driver, and acceptance tests.

Run public checks from [CONTRIBUTING](../CONTRIBUTING.md). Focused fixtures cover
branch invalidation, expired resume, queue checkpoint ordering, startup/interrupt
cancellation, bridge token revocation and abort, SSE loss, quotas, model
dialects/defaults, stale discovery results, catalog pagination, planning write
grants, child-session approvals, persisted approvals/compaction and verified
orphan recovery.

Real inference is opt-in and consumes the provider's quota:

```bash
bun run test:agent-runtimes:live opencode-cli opencode/mimo-v2.6-flash-free
bun run test:agent-runtimes:live codex-cli YOUR_AVAILABLE_MODEL
bun run test:agent-runtimes:live claude-code-cli YOUR_AVAILABLE_MODEL
```

Choose a currently listed model with a working account. The script uses isolated
app data and a disposable workspace, grants only scoped test requests, and saves
evidence under ignored `.runtime/`. It checks writes, an OhMyGame tool call,
continuation, daemon restart, compaction, editing a later message, checkpoint
restore, denial of external dummy files, approval persistence, and cancellation
during an executing shell tool. Keep a runtime opt-in until real acceptance
passes on the target platform; fixture success alone is insufficient.

An optional final argument selects an absolute executable path, for example
`bun run test:agent-runtimes:live codex-cli MODEL /absolute/path/to/codex`.
The test continues other checks after a protected-read failure, saves each
boundary failure and exits unsuccessfully. A missing denial record is not a
persistence regression when the runtime never requested approval at all.
