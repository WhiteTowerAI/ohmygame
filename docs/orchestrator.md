# Agent teams

A project can run a team: several agents at once, each with a role, sending
each other messages while you watch, and carrying on by themselves until the
goal is met. Open it from the **Team** button in the chat header.

## Roles

A team has up to 20 roles (`ORCHESTRATOR_MAX_ROLES`). Advisors run at the same
time, so a large team can mean many model requests in flight and may meet a
provider's concurrency limits. A role has a name, instructions (its persona,
added to that agent's system prompt) and a capability:

- **Writer** — may change files. A team has at least one.
- **Advisor** — reads the project and messages teammates. It gets the
  read-only tool set plan mode uses (`read`, `grep`, `find`, `ls`,
  `web_search`, `update_plan`), whatever its own plan mode is, so a coding
  agent such as Claude Code also runs it read-only. It does not get
  `questionnaire`: it runs unattended and must not stop to wait for you.

Each role is an ordinary conversation in the project, titled after the role
and using the model of the chat the team was set up from. Its history is kept
in the usual session file, so **Open chat** on a role shows everything it did.
A role keeps its conversation when the team is edited or started again.

## Why only one writer works at a time

A checkpoint records the whole workspace, and Undo, Reapply and restore rewrite
it. Two agents writing at once would put each other's half-finished work into
a snapshot, and one Undo could erase another agent's edits. So a project still
takes one writing turn at a time, across every conversation; advisor turns run
beside it. A put-back holds off every turn, advisors included.

`AgentManager` asks `isWriterConversation(projectId, conversationId)` before
starting a turn. Without a team every conversation counts as a writer, so a
project with no team behaves exactly as before. Build, delete and export still
wait for every turn, whoever is writing.

## Tools

A conversation a role owns gets three more tools; no other conversation sees
them.

| Tool | Who | What it does |
| --- | --- | --- |
| `list_agents` | every role | The roster: id, name, capability, status and persona. |
| `send_message_to_agent` | every role | Sends a message to a teammate, found by id or name. An idle teammate starts a turn on it; a busy one gets every message that arrived meanwhile when its turn ends. |
| `mark_goal_complete` | writers | Ends the run with a summary of what was achieved. |

Messages appear in the team's **Team messages** list as they are sent
(`orchestrator.message` events) and arrive in the target conversation as an
ordinary prompt that names who sent them.

## How a run goes

**Start team** creates any missing role conversations and gives the writer the
goal. Advisors wait until someone messages them. Each time the writer finishes
a turn, it is given the next one: the teammate messages that arrived meanwhile,
or, when none did, an instruction to carry on with the goal. With more than one
writer, a message to a writer that must wait for another is held, and that
writer takes the next turn once the working one finishes. A run ends when:

- the writer calls `mark_goal_complete` — the team shows **Goal complete** and
  its summary;
- you select **Stop team** — every running role turn is cancelled;
- the writer's turn fails or is stopped from its own chat — the team stops
  rather than retrying blindly;
- the team pauses for ping-pong, below.

There is no token or cost limit. The stop control, ping-pong detection and the
single writer are the guards.

### Ping-pong

Roles that only message each other without any file changing are stuck, not
making progress. When the same two roles trade more than three rounds of
messages (`PING_PONG_LIMIT`, counted in either direction) without the writer
changing a file, the run pauses and the team explains which roles were
involved. Each pair is counted on its own, so a writer collecting one report
from every advisor is not a loop. Clarify
the goal or the roles, then start the team again; starting clears the pause.

## Restart and storage

The roster is saved in `orchestrator.json` beside the project's conversations
(`<project storage>/orchestrator.json`, outside the workspace the agents edit),
with the conversation each role uses. It carries a `version`; a file from a
newer OhMyGame, or one that is damaged, is left untouched and the team shows
why it cannot be read instead of being replaced.

A run does not resume by itself after OhMyGame restarts: the team loads as
stopped and **Start team** continues it in the same conversations. A role
conversation that never received a message is not saved yet, so it is made
again when the team starts. **Disband**
removes the saved team and archives its conversations, so their history stays
readable under the archived chats.

## Code

- `src/shared/orchestrator.ts` — the role and run types.
- `src/daemon/orchestrator.ts` — `OrchestratorSupervisor`: roster, start and
  stop, delivery, the advance loop and ping-pong detection.
- `src/daemon/orchestrator-tools.ts` — the three tools.
- `src/daemon/orchestrator-store.ts` — `orchestrator.json`.
- `src/daemon/orchestrator-routes.ts` — `GET`, `PUT` and `DELETE
  /projects/:projectId/orchestrator`, and `POST …/start` and `…/stop`.
- `src/renderer/orchestrator-panel.tsx` — the Team dialog.

Tests: `test/orchestrator.test.ts`, `test/orchestrator-concurrency.test.ts`,
`test/orchestrator-tools.test.ts`, `test/orchestrator-store.test.ts`,
`test/orchestrator-routes.test.ts` and `test/orchestrator-panel.test.tsx`. None
of them calls a model.
