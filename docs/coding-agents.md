# Coding agents

A conversation can run on a coding agent CLI that is already installed on the
computer: Claude Code, Codex, or OpenCode. The CLI runs the agent loop with its
own sign-in and model. OhMyGame keeps the conversation, checkpoints and Undo,
its canvas, media, game and plugin tools, and the approval decisions.

## Using one

Providers & Models lists the coding agents under **Coding agents**. Each row
shows whether the CLI was found, its version, and how its requests are billed.
The switch offers the agent's models in the conversation model picker; the
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

Choosing a coding agent's model on the home composer, or through
`PUT /models/default`, makes it the default for new conversations. It is stored
as `defaultModel` in `agent-runtimes.json`, not in Pi's settings, because canvas
text and other one-off generation can only use Pi's models; plain `GET /models`
keeps reporting Pi's default. Choosing a Pi model as the default clears it, and
an agent that is turned off no longer starts new conversations.

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
  `ohmygame-native-session` custom entry on the branch. The next message
  continues it (`--resume`, `thread/resume`, the OpenCode session). An edit or
  restore that goes back before that entry, or a later session of another
  agent, means the CLI has not seen the current branch; the next message starts
  a new native session.
- **Handoff.** When an agent joins a conversation it has not seen, its first
  message carries a summary built from the stored record: recent turns and the
  files the earlier agent worked on. It asks no model, and private context such
  as file references is left out. Moving back to Pi needs no summary; Pi reads
  the stored messages.

## How each agent is driven

| Agent       | Transport                                                        | OhMyGame tools                                          | Approvals                                         |
| ----------- | ---------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| Claude Code | `claude -p` with stream-json in and out; one process per session | In-process MCP server answered over the same pipe       | `can_use_tool` control requests over the pipe     |
| Codex       | `codex app-server` JSON-RPC; one thread per conversation         | The thread's dynamic tools, answered over the same pipe | App server approval requests                      |
| OpenCode    | `opencode serve` on loopback with its own password               | Remote MCP on the daemon with a session token           | `permission.asked` events, answered on the server |

Each stdin stays open for the session, so follow-up messages, mid-turn
messages and approval answers reach the running agent. Processes run in their
own process group, are registered with the desktop app for crash cleanup, and
are stopped when the daemon closes.

OhMyGame's tools are the handlers Pi uses (`createAgentTools`), offered through
`ToolBridge`. Plugin MCP servers reach the agent through the same `mcp` tool
Pi uses, run in a model-less session in the daemon, so plugin settings,
switches and credentials stay in the daemon. Skills (plugin Skills and
OhMyGame's own) are copied into a private folder for the session and handed to
the CLI: a session plugin for Claude Code, `skills/extraRoots/set` for Codex,
`skills.paths` for OpenCode. Nothing is written to the workspace.

The OpenCode tool endpoint, `POST /agent-runtime-bridge/mcp`, takes the
session's token instead of the app's. The token works only while a turn of that
conversation runs and is revoked with the session.

New plugin capabilities must be expressible as Skills or MCP servers; Pi
extensions do not reach coding agents.

## Approvals and limits

In the project folder an agent works without asking, as OhMyGame's own agent
does. `judgeApproval` decides each request first:

- **Deny** anything that reaches a CLI sign-in folder (`~/.claude`,
  `~/.codex`, OpenCode's folders), `~/.ssh` and similar, OhMyGame's data folder,
  or another project. A command reaches a folder when it names it or a folder
  that holds it, quoted or not.
- **Allow** file changes and commands inside the workspace, and commands that
  only name temporary files or installed programs.
- **Ask** the person for everything else: paths outside the workspace and
  commands that publish, escalate or pipe a download into a shell. A request
  Codex makes to leave its sandbox always asks, because Codex only makes one
  when its sandbox would stop the command.

A request the policy leaves to the person appears as an approval card above the
composer: Allow, Allow for this conversation, or Deny. Answered requests stay
in the timeline. Stopping the turn denies every request still waiting.

## Environment and isolation

A CLI gets an environment built from an allowlist: PATH, HOME, locale,
temporary folders, proxies, certificates, and that CLI's own configuration
folder variable. API keys are left out, so an ambient key never moves a
subscription to metered billing; Claude Code keeps `CLAUDE_CODE_OAUTH_TOKEN`,
which is a subscription sign-in. The daemon's token and `OHMYGAME_*` variables
never reach a CLI. The executable is resolved to an absolute path from the
person's choice, PATH, the login shell's PATH and the usual install folders.

By default each agent runs without the person's own configuration:

- Claude Code: `--setting-sources ""` and `--strict-mcp-config`.
- Codex: the person's MCP servers and notification hook are turned off for the
  thread. Codex still loads Skills, plugins and AGENTS.md from its own folder;
  the settings page says so.
- OpenCode: a private configuration folder, `--pure`, and no project
  configuration.

**Use my own CLI configuration** lifts this for an agent.

## Settings and API

`agent-runtimes.json` in the data directory stores, per agent, `enabled`
(default on), `isolateUserConfig` (default on) and an optional absolute
`binaryPath`. A damaged file falls back to the defaults.

| Route                                                     | Purpose                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /agent-runtimes`                                     | Status of every agent; `?recheck=1` probes again               |
| `PATCH /agent-runtimes/:id`                               | `enabled`, `isolateUserConfig`, `binaryPath`                   |
| `POST /agent-runtimes/:id/recheck`                        | Probe one agent again                                          |
| `POST /agent-runtimes/:id/login`                          | Start the CLI's sign-in; returns a browser URL or a command    |
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
