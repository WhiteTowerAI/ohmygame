# Agent Orchestrator — Design

Run several coding agents on one project at the same time, each with its own
role, talking to each other while the user watches, and continuing on their own
until the goal is met.

Chosen approach: **role-based read/write**. Every role is either a `writer` or
an `advisor`. At most one writer turn runs per project at a time; any number of
advisor turns run in parallel. Advisors get the read-only tool set that already
exists, so no new permission machinery is needed and two agents can never write
the same file at once.

Rejected alternatives:

- **Worktree per agent, merge back.** True parallel writes, but a project
  workspace is not a git repository — checkpoints live in a separate git
  directory outside it (`src/daemon/checkpoints.ts:265`). Worktrees would mean
  introducing a real repository per project plus a three-way merge and a
  conflict-resolution story. That is the largest and riskiest part of the whole
  feature, and it changes stored data.
- **One shared workspace, serialized writes, no roles.** Simpler, but the
  parallelism is illusory when every agent writes, and the user never sees what
  each agent is for.

## Why the roles model is safe

Two existing facts drive the design.

A project workspace is snapshotted as a whole. Checkpoints record the entire
workspace into a git object store outside it, and restore/undo/put-back rewrite
the workspace from that store. Two agents writing concurrently would put each
other's half-finished work into a snapshot, and one undo could erase another
agent's edits. The system already detects concurrent modification
(`FileChangedError`, `src/daemon/checkpoints.ts:1414`), so write contention is
a known hazard rather than a theoretical one.

A read-only tool set already exists and is tested. `planningPiToolNames()`
returns `read`, `grep`, `find`, `ls`, `web_search`, `questionnaire`,
`update_plan` and nothing that can write (`src/daemon/agent-tools.ts:47-49`).
`projectPiToolNames()` already switches on mode
(`src/daemon/agent-tools.ts:51-60`). An advisor is a conversation whose tools
come from the read-only branch.

## Concepts

**Orchestrator** — a per-project configuration plus a run. Holds the goal, the
roster of roles, and the run status.

**Role** — one agent in the roster:

| Field | Meaning |
| --- | --- |
| `id` | Stable slug, used in messages and events, for example `programmer`. |
| `name` | Display name, for example `Programmer`. |
| `persona` | Text appended to that agent's system prompt describing its job. |
| `capability` | `writer` or `advisor`. |
| `model` | Provider and model for this role. Advisors can use a cheaper model. |
| `conversationId` | Filled in at start; the conversation backing this role. |

**The reuse that makes this cheap:** a role is an ordinary conversation in the
same project. `AgentManager` already holds many sessions at once, keyed by
`projectId:conversationId` (`src/daemon/agent.ts:499`, `:2366`), and already
persists each as its own JSONL file
(`src/daemon/conversations.ts:96`, `:349`). The orchestrator therefore adds a
scheduler, a message bus and a supervisor loop — not a second session stack.

## Concurrency

Today a project allows one active turn across all its conversations:

```ts
if (!active && this.options.checkpoints && this.isProjectBusy(project.id))
  throw new Error("Wait for the other conversation in this project to finish");
```

`src/daemon/agent.ts:864`, with `isProjectBusy` matching the `projectId:` prefix
across active turns and revisions (`src/daemon/agent.ts:2365-2368`). The comment
above it states the reason: no turn may write files while a restore, undo or
put-back changes them.

That guard becomes capability-aware.

- `AgentManager` gains an injected resolver
  `isWriterConversation?(projectId, conversationId): boolean`. When it is
  absent, or the conversation is not part of a run, **every conversation counts
  as a writer** — which makes the new check identical to `isProjectBusy` and
  leaves single-agent projects behaving exactly as they do now.
- New `isProjectWriteBusy(projectId)`: true when an active turn or revision
  belongs to a writer conversation.
- The guard splits in two:
  - A **writer** turn may not start while `isProjectWriteBusy(project.id)` or
    `#puttingBack.has(project.id)`.
  - An **advisor** turn may not start while `#puttingBack.has(project.id)`.
    A put-back rewrites files under it, so even a reader would see an
    inconsistent workspace. Put-backs are short; nothing else blocks advisors.
- The existing 409 guards on build, delete and export
  (`src/daemon/app.ts:1789`, `:2075`, `:2888`, `:4439`) keep using
  `isProjectBusy`, because those operations touch the whole project regardless
  of who is writing.

Admission goes through a small `OrchestratorScheduler` that the supervisor asks
before starting a turn, so the queue order is visible and testable instead of
emerging from event timing.

## Message bus

Three tools, declared with `defineTool` in `src/daemon/agent-tools.ts`
following the `questionnaire` template (`:174-201`):

| Tool | Parameters | Behaviour |
| --- | --- | --- |
| `list_agents` | none | The roster: id, name, capability, current status, one-line persona. |
| `send_message_to_agent` | `agent`, `message` | Delivers `message` to that role's conversation as a prompt. |
| `mark_goal_complete` | `summary` | Tells the supervisor the goal is met; ends the run. |

Delivery reuses the existing prompt path. When the target is mid-turn the
message queues as a follow-up and is injected into the live run
(`src/daemon/agent.ts:865-909`), so no second queue is needed.

Gating:

- The three names go into both allowlist branches
  (`src/daemon/agent-tools.ts:41-60`) **only for conversations that belong to a
  run**, so an ordinary conversation never sees them. Advisors need
  `list_agents` and `send_message_to_agent` in the read-only branch; only
  writers get `mark_goal_complete`, since only a writer can finish the work.
- `projectAgentTools()` (`src/daemon/app.ts:984-1001`) includes them under the
  same condition.
- Native CLI runtimes receive them with no extra work: tools already reach
  Claude Code, Codex and OpenCode through the in-process MCP server named
  `ohmygame` (`src/daemon/agent-runtimes/tool-bridge.ts:37-64`).
- External agents get them via the public list and hints in
  `src/daemon/external-mcp.ts:29-44`, `:60`.

An agent-to-agent message arrives in the target conversation as a `userMessage`
thread item, because that is what it is — a prompt to that agent. To keep the
real author visible, `userMessage` gains an optional
`author?: { kind: "user" | "agent"; roleId?: string; name?: string }`. The field
is additive and optional, so recorded conversations from before it still load;
per `docs/compatibility.md` a thread item is internal code and needs no
migration, and older readers ignore an unknown optional field.

## Supervisor loop

New module `src/daemon/orchestrator.ts` exporting `OrchestratorSupervisor`,
following the `ScheduledMessages` pattern (`src/daemon/scheduled-messages.ts`):
the schedule lives in memory, is rebuilt from persisted state on load, and ends
when the app quits.

1. **Start.** Create one conversation per role, set each role's model, append
   the persona to its system prompt. Claude Code already takes
   `--append-system-prompt` (`src/daemon/agent-runtimes/claude-code.ts:230-254`).
   Give the writer the goal and start it. Advisors start idle.
2. **Advance.** On `agent.completed` for a role, while status is `running`:
   if the goal was marked complete, finish; otherwise the writer takes the next
   turn. Its prompt is the messages that arrived for it since its last turn,
   rendered as one text block — `- <RoleName>: <message>` per line, oldest
   first, wrapped in a short header saying these came from teammates — followed
   by the standing instruction to continue towards the goal. When no message
   arrived, the prompt is the standing instruction alone. Advisors wake only
   when addressed. This keeps exactly one agent doing work that can conflict,
   and keeps the loop deterministic.
3. **Restart.** Run state is persisted, so a daemon restart resumes a run that
   was `running` and re-arms the supervisor.
4. **Stop.** Cancel every active turn through the existing cancel path, stop
   the supervisor, persist `stopped`.

**Ping-pong detection.** The supervisor counts consecutive agent-to-agent
message pairs with no writer file change in between. When the same pair has
exchanged more than three rounds without any file being written, the run pauses
and publishes a diagnostic. Two agents replying to each other forever is a
fault, not progress, so this is a correctness guard rather than a budget cap.

**No budget cap.** The user explicitly declined token or cost limits. The
controls that remain are the stop button, ping-pong detection and write
serialization.

## Persistence

New store `<project.storagePath>/orchestrator.json`:

```json
{
  "version": 1,
  "goal": "Make the night level playable end to end",
  "status": "stopped",
  "roles": [],
  "updatedAt": "2026-11-10T00:00:00.000Z"
}
```

Rules from `docs/compatibility.md`: it carries a `version`; loading migrates
stepwise from the stored version to the current one and writes the result back;
a file from a newer version or a damaged file is left untouched and the change
refused with a reason, never overwritten with an empty or partial store. There
is only version 1 today, so the loader's job now is to refuse what it cannot
read. Each migration step gets a fixture test.

Role conversations are ordinary conversations and stay in their existing JSONL
files. Deleting an orchestrator archives its conversations instead of deleting
them, matching the archive behaviour already in
`src/daemon/conversations.ts:344`.

## Contracts

Additions to `src/shared/contracts.ts`:

- `OrchestratorRoleCapability = "writer" | "advisor"`
- `OrchestratorRoleConfig` — `id`, `name`, `persona`, `capability`, `model`
- `OrchestratorRoleState` — `config`, `conversationId`, `status: AgentStatus`,
  `lastTurnId?`
- `OrchestratorStatus = "idle" | "running" | "stopped" | "completed" | "error"`
- `OrchestratorConfig` — `version`, `goal`, `roles`
- `OrchestratorState` — `config`, `status`, `roles`, `diagnostic?`, `updatedAt`
- `RuntimeEventData` gains `orchestrator.state` (full state) and
  `orchestrator.message` (`fromRoleId`, `toRoleId`, `text`); both names are
  added to `RUNTIME_EVENT_TYPES` (`src/shared/contracts.ts:1399-1477`).

Events flow through the existing `RuntimeEventBus` ring buffer with cursor
replay (`src/shared/events.ts:7-76`) and the existing project SSE stream
(`src/daemon/app.ts:4479-4503`). No new transport.

## Routes

Internal routes between the renderer and its own daemon need no compatibility
layer, per `docs/compatibility.md`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/projects/:projectId/orchestrator` | Current `OrchestratorState`. |
| `PUT` | `/projects/:projectId/orchestrator` | Save goal and roster; refused while running. |
| `POST` | `/projects/:projectId/orchestrator/start` | Start the run; `409` if a non-orchestrator turn is active. |
| `POST` | `/projects/:projectId/orchestrator/stop` | Stop the run and cancel its turns. |

Bodies are validated with a Fastify JSON Schema literal in the style of
`modelRefSchema` (`src/daemon/app.ts:513-531`).

## Interface

A Team panel in the project shell, next to the existing conversation list:

- The goal, editable while stopped.
- The roster with a live status dot per role and a writer/advisor badge.
- Start and stop, the stop control always visible while running.
- A merged timeline showing every role's messages in one stream, each labelled
  with its author, so agent-to-agent conversation is readable as it happens.

The merged timeline reuses `AgentTimeline` (`src/renderer/agent-timeline.tsx:87`)
fed by a selector over the role conversations. Events already carry
`conversationId` (`src/shared/contracts.ts:1479-1489`), so the renderer maps
conversation to role without a second subscription; it keeps using
`subscribeToProject` (`src/renderer/api.ts:1486-1499`).

New UI text goes into both `src/renderer/locales/en.ts` and `zh-CN.ts` in the
same change, per `agents.md`.

## Testing

Vitest. Run one file with `bun run test -- test/<file>.test.ts`.

Everything here is testable without spending tokens, using the existing
deterministic harness: `ScriptedDriver implements NativeDriver`
(`test/agent-runtime-session.test.ts:27-63`) injected through `createDriver`,
with `SessionManager.inMemory()` so nothing touches disk.

| Area | Test |
| --- | --- |
| Scheduler | One writer admitted, several advisors admitted at once, second writer waits. |
| No regression | With no resolver injected, behaviour matches today's one-turn-per-project exactly. |
| Tools | Presence and gating per capability, following the `game_use` pattern (`test/agent-tools.test.ts:79-96`). |
| Bus | A message to a busy agent queues as a follow-up; a message to an idle agent starts a turn. |
| Loop | Ping-pong detection pauses after three empty rounds; `mark_goal_complete` ends the run. |
| Routes | Start, stop, save, and the `409` cases. |
| Store | Loads version 1, refuses a higher version without overwriting it. |

## Phases

Each phase ships something that works and carries its own tests.

1. **Concurrency foundation** — capability-aware guard in `AgentManager`,
   injected resolver, `isProjectWriteBusy`, default behaviour preserved.
2. **Store, roles, routes** — `orchestrator.json`, role-to-conversation
   creation, `GET`/`PUT`/`start`/`stop` with manual prompting only.
3. **Message bus** — the three tools, allowlist gating, delivery, events.
4. **Supervisor loop** — autonomous continuation, goal completion, ping-pong
   detection, restart recovery.
5. **Interface** — Team panel, merged timeline, badges, stop control, `en` and
   `zh-CN` strings.

## Out of scope

- Parallel file writes, worktrees and merging.
- Orchestrating across more than one project.
- Token or cost budgets.
- Agents creating or editing roles at runtime.
- Changing the plugin API surface; nothing here is a contract with others.
