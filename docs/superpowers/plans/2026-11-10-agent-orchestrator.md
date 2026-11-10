# Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one OhMyGame project run several coding agents at once, each with a named role, exchanging messages while the user watches, continuing on their own until the goal is met.

**Architecture:** A role is an ordinary conversation in the same project, so the existing per-conversation session stack, JSONL persistence and SSE replay are reused unchanged. Each role is a `writer` or an `advisor`. The one-turn-per-project lock in `AgentManager` becomes capability-aware: at most one writer turn at a time, any number of advisor turns in parallel, advisors limited to the read-only tool set that already exists. A supervisor advances the writer after each completed turn, and three new tools carry messages between roles.

**Tech Stack:** TypeScript, Fastify (daemon), React (renderer), Vitest, TypeBox for tool parameters, `@earendil-works/pi-coding-agent` for `defineTool` and `SessionManager`.

**Spec:** `docs/superpowers/specs/2026-11-10-agent-orchestrator-design.md`

## Global Constraints

- Tests run with `bun run test -- test/<file>.test.ts`. Never call a real model; every test uses `ScriptedDriver` and `SessionManager.inMemory()`.
- No token or cost budgets. The only guards are the stop control, ping-pong detection and write serialization.
- Stored data carries a `version`; migrate on load; never overwrite a store that cannot be read (`docs/compatibility.md`).
- HTTP routes between the renderer and its own daemon are internal: change every caller in the same PR, leave no wrapper for the old shape.
- New UI text goes into both `src/renderer/locales/en.ts` and `src/renderer/locales/zh-CN.ts` in the same PR. Text sent to the agent stays in English.
- Lint must stay clean: `bun run lint` reports 0 warnings and 0 errors (`oxlint --deny-warnings`).
- Conventional Commit messages. Branch names `feat/<short-name>`.
- A project without an orchestrator must behave exactly as it does today. Every default preserves current behaviour.

---

## File Structure

**New files**

| Path | Responsibility |
| --- | --- |
| `src/shared/orchestrator.ts` | Types shared by daemon and renderer: role config, role state, run status. No logic. |
| `src/daemon/orchestrator-store.ts` | Read and write `<project storage>/orchestrator.json`, including the version rule. |
| `src/daemon/orchestrator.ts` | `OrchestratorSupervisor`: roster lifecycle, admission decisions, the advance loop, ping-pong detection, message delivery. |
| `src/daemon/orchestrator-tools.ts` | The three agent-facing tools and their delivery callbacks. |
| `src/daemon/orchestrator-routes.ts` | `registerOrchestratorRoutes`, following `src/daemon/checkpoint-routes.ts:32`. |
| `src/renderer/orchestrator-panel.tsx` | The Team panel: goal, roster with status, start and stop. |
| `src/renderer/orchestrator-timeline.tsx` | Merged timeline across role conversations, labelled by author. |
| `test/orchestrator-concurrency.test.ts` | Writer/advisor admission in `AgentManager`. |
| `test/orchestrator-store.test.ts` | Store load, save, refuse-newer-version. |
| `test/orchestrator.test.ts` | Supervisor: start, stop, advance, ping-pong, delivery. |
| `test/orchestrator-tools.test.ts` | Tool presence, gating and behaviour. |
| `docs/orchestrator.md` | User-facing documentation, linked from `docs/README.md`. |

**Modified files**

| Path | Change |
| --- | --- |
| `src/daemon/agent.ts` | `isWriterConversation` option, `isProjectWriteBusy`, capability-aware guard at `:864`. |
| `src/shared/contracts.ts` | Two `RuntimeEventData` entries, two `RUNTIME_EVENT_TYPES` names, optional `author` on the `userMessage` thread item. |
| `src/daemon/agent-tools.ts` | Orchestrator names in both allowlist branches, gated by a new parameter. |
| `src/daemon/app.ts` | Build the supervisor, pass the resolver to `AgentManager`, add persona to `instructions` at `:1088`, add orchestrator tools in `projectAgentTools` at `:984`, register routes. |
| `src/daemon/external-mcp.ts` | Publish the three tools to external agents (`:29-44`, `:60`). |
| `src/renderer/api.ts` | Four client functions and event handling. |
| `src/renderer/state.ts` | Reducer cases for the two new events. |
| `src/renderer/project-shell.tsx` | Mount the panel and the merged timeline. |
| `src/renderer/locales/en.ts`, `zh-CN.ts` | New strings. |
| `docs/README.md` | Link the new doc. |

---

# Phase 1 — Foundations

## Task 1: Shared orchestrator types

**Files:**
- Create: `src/shared/orchestrator.ts`
- Test: `test/orchestrator-store.test.ts` (created here with the type-shape assertions; extended in Task 4)

**Interfaces:**
- Consumes: `AgentStatus` and `ModelRef` from `src/shared/contracts.ts`.
- Produces: `OrchestratorRoleCapability`, `OrchestratorRoleConfig`, `OrchestratorRoleState`, `OrchestratorStatus`, `OrchestratorConfig`, `OrchestratorState`, `OrchestratorDiagnostic`, `ORCHESTRATOR_STORE_VERSION`, `ORCHESTRATOR_MAX_ROLES`, `ORCHESTRATOR_ROLE_ID_PATTERN`. Every later task imports these names exactly.

- [ ] **Step 1: Write the failing test**

```ts
// test/orchestrator-store.test.ts
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_STORE_VERSION,
  type OrchestratorConfig,
  type OrchestratorRoleConfig,
} from "../src/shared/orchestrator.js";

function role(id: string, capability: "writer" | "advisor"): OrchestratorRoleConfig {
  return { id, name: id, persona: `You are the ${id}.`, capability, model: { provider: "pi", id: "test" } };
}

describe("orchestrator types", () => {
  it("holds a versioned config with a goal and a roster", () => {
    const config: OrchestratorConfig = {
      version: ORCHESTRATOR_STORE_VERSION,
      goal: "Make the night level playable",
      roles: [role("programmer", "writer"), role("critic", "advisor")],
    };
    expect(config.version).toBe(1);
    expect(config.roles.map((item) => item.capability)).toEqual(["writer", "advisor"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-store.test.ts`
Expected: FAIL — cannot resolve `../src/shared/orchestrator.js`.

- [ ] **Step 3: Write the module**

```ts
// src/shared/orchestrator.ts
import type { AgentModelRef, AgentStatus } from "./contracts.js";

/** Bumped only with a migration step in orchestrator-store.ts. */
export const ORCHESTRATOR_STORE_VERSION = 1;
export const ORCHESTRATOR_MAX_ROLES = 8;
export const ORCHESTRATOR_ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** A writer may change files; an advisor may only read and talk. */
export type OrchestratorRoleCapability = "writer" | "advisor";

export interface OrchestratorRoleConfig {
  /** Stable slug, used in messages and events. */
  id: string;
  name: string;
  /** Appended to this role's system prompt. */
  persona: string;
  capability: OrchestratorRoleCapability;
  model: AgentModelRef;
}

export interface OrchestratorRoleState {
  config: OrchestratorRoleConfig;
  /** Filled in when the run starts. */
  conversationId?: string;
  status: AgentStatus;
  lastTurnId?: string;
}

export type OrchestratorStatus = "idle" | "running" | "stopped" | "completed" | "error";

export interface OrchestratorDiagnostic {
  /** Set when ping-pong detection paused the run. */
  code: "ping-pong";
  message: string;
  roleIds: string[];
}

export interface OrchestratorConfig {
  version: number;
  goal: string;
  roles: OrchestratorRoleConfig[];
  updatedAt: string;
}

export interface OrchestratorState {
  config: OrchestratorConfig;
  status: OrchestratorStatus;
  roles: OrchestratorRoleState[];
  diagnostic?: OrchestratorDiagnostic;
}
```

`AgentModelRef` is `src/shared/contracts.ts:75`, an alias of `ModelRef` at `:70-73`, which is exactly `{ provider: string; id: string }` — note the field is `id`, not `model`. `AgentStatus` is at `:10`. `ConversationManager.create` already takes an `AgentModelRef` (`src/daemon/conversations.ts:54`), so a role's model passes straight through.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/orchestrator-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/orchestrator.ts test/orchestrator-store.test.ts
git commit -m "feat(orchestrator): add the shared role and run types"
```

---

## Task 2: Orchestrator runtime events

**Files:**
- Modify: `src/shared/contracts.ts:1399-1477` (`RuntimeEventData`, `RUNTIME_EVENT_TYPES`) and the `userMessage` member of the `ThreadItem` union (`:860-960`)
- Test: `test/orchestrator.test.ts` (created here; extended in Tasks 5, 10, 11)

**Interfaces:**
- Consumes: `OrchestratorState` from Task 1.
- Produces: event types `"orchestrator.state"` with payload `{ state: OrchestratorState }` and `"orchestrator.message"` with payload `{ fromRoleId: string; toRoleId: string; text: string }`; `ThreadItemAuthor` and the optional `author` field on the `userMessage` thread item.

- [ ] **Step 1: Write the failing test**

```ts
// test/orchestrator.test.ts
import { describe, expect, it } from "vitest";
import { RUNTIME_EVENT_TYPES, type RuntimeEventData, type ThreadItem } from "../src/shared/contracts.js";
import type { OrchestratorState } from "../src/shared/orchestrator.js";

describe("orchestrator events", () => {
  it("registers both event names", () => {
    expect(RUNTIME_EVENT_TYPES).toContain("orchestrator.state");
    expect(RUNTIME_EVENT_TYPES).toContain("orchestrator.message");
  });

  it("carries the roster on a state event and the endpoints on a message event", () => {
    const state: RuntimeEventData["orchestrator.state"] = {
      state: { config: { version: 1, goal: "g", roles: [], updatedAt: new Date(0).toISOString() }, status: "running", roles: [] } satisfies OrchestratorState,
    };
    const message: RuntimeEventData["orchestrator.message"] = { fromRoleId: "critic", toRoleId: "programmer", text: "The jump feels floaty." };
    expect(state.state.status).toBe("running");
    expect(message.toRoleId).toBe("programmer");
  });

  it("labels a user message with its real author", () => {
    const item: Extract<ThreadItem, { type: "userMessage" }> = {
      id: "item-1", turnId: "turn-1", type: "userMessage", text: "hello",
      author: { kind: "agent", roleId: "critic", name: "Critic" },
    };
    expect(item.author?.roleId).toBe("critic");
  });
});
```

Read the existing `userMessage` member of `ThreadItem` first (`grep -n "userMessage" src/shared/contracts.ts`) and copy its required fields into the test literal above so it compiles.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — `RUNTIME_EVENT_TYPES` does not contain the new names; `author` is not a known property.

- [ ] **Step 3: Add the contracts**

In `RuntimeEventData`, after the `"scheduled.changed"` entry:

```ts
  /** The whole orchestrator picture, so a client can resync without a fetch. */
  "orchestrator.state": { state: OrchestratorState };
  /** One role spoke to another. The prompt itself arrives as a userMessage. */
  "orchestrator.message": { fromRoleId: string; toRoleId: string; text: string };
```

Add to the top of `contracts.ts` with the other shared imports:

```ts
import type { OrchestratorState } from "./orchestrator.js";
```

Add both names to `RUNTIME_EVENT_TYPES`, immediately after `"scheduled.changed"`.

Add next to the other thread-item helper types:

```ts
export interface ThreadItemAuthor {
  kind: "user" | "agent";
  /** Present when kind is "agent". */
  roleId?: string;
  name?: string;
}
```

On the `userMessage` member of `ThreadItem`, add the optional field:

```ts
  /** Absent for a message the person typed, and for anything recorded before roles existed. */
  author?: ThreadItemAuthor;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator.test.ts && bun run typecheck`
Expected: PASS, and no new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): add the run state and message events"
```

---

## Task 3: Capability-aware write lock

This is the change that makes parallel agents possible. Read `src/daemon/agent.ts:855-875` and `:2360-2370` before editing.

**Files:**
- Modify: `src/daemon/agent.ts:397-417` (`AgentManagerOptions`), `:864` (the guard), `:2365-2368` (next to `isProjectBusy`)
- Test: `test/orchestrator-concurrency.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentManagerOptions.isWriterConversation?: (projectId: string, conversationId: string) => boolean`; `AgentManager.isProjectWriteBusy(projectId: string): boolean`. Task 7 passes the resolver.

- [ ] **Step 1: Write the failing test**

The harness below is modelled on `test/agent-runtime-session.test.ts:27-144`. Copy the `ScriptedDriver` class from there rather than retyping it, and keep `SessionManager.inMemory` so nothing touches disk.

```ts
// test/orchestrator-concurrency.test.ts
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentManager } from "../src/daemon/agent.js";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";
import {
  NativeCodingSession,
  type NativeDriver,
  type NativeTurnInput,
  type NativeTurnOutcome,
  type NativeTurnSink,
} from "../src/daemon/agent-runtimes/native-session.js";
import type { StoredConversation } from "../src/daemon/conversations.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

type Script = (input: NativeTurnInput, sink: NativeTurnSink, signal: AbortSignal) => Promise<NativeTurnOutcome>;

class ScriptedDriver implements NativeDriver {
  readonly inputs: NativeTurnInput[] = [];
  constructor(private readonly scripts: Script[]) {}
  async runTurn(input: NativeTurnInput, sink: NativeTurnSink, signal: AbortSignal): Promise<NativeTurnOutcome> {
    this.inputs.push(input);
    const script = this.scripts.shift();
    return script ? script(input, sink, signal) : { status: "completed" };
  }
  async interrupt(): Promise<void> {}
  dispose(): void {}
}

const project: ProjectState = {
  id: "project-1", name: "Project", type: "general",
  updatedAt: new Date(0).toISOString(),
  workspacePath: "/tmp/project-1", preview: { status: "waiting" },
};

function conversation(id: string): StoredConversation {
  return {
    sessionPath: `/tmp/${id}.jsonl`,
    summary: {
      id, projectId: project.id, title: id,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(), messageCount: 0,
    },
  };
}

/** One manager, several conversations, and a set naming which of them may write. */
function team(scripts: Script[], writers?: Set<string>) {
  const events = new RuntimeEventBus();
  const sessionManager = SessionManager.inMemory("/tmp/project-1");
  let manager!: AgentManager;
  manager = new AgentManager(events, {
    createSession: async () =>
      new NativeCodingSession({
        runtime: "claude-code-cli",
        model: "sonnet",
        sessionManager,
        createDriver: () => new ScriptedDriver(scripts),
        snapshotBeforeMessage: async () => "commit",
        // Mirrors test/agent-runtime-session.test.ts:118-124 so approvals route through the manager.
        requestApproval: (details, toolCallId, signal) =>
          manager.askApproval(project.id, "conversation-1", toolCallId, details, signal),
        toolNames: [],
      }),
    activeToolNames: (_project, mode, session) =>
      projectPiToolNames(mode, [], session.getAllTools?.().map((tool) => tool.name)),
    checkpoints: {
      snapshot: async () => "commit",
      changed: async () => ({ files: 0, items: [] }),
    },
    ...(writers ? { isWriterConversation: (_projectId: string, conversationId: string) => writers.has(conversationId) } : {}),
  });
  return { manager, events };
}

/** Holds a turn open until the test lets it finish. */
function gated() {
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const script: Script = async () => { await waiting; return { status: "completed" }; };
  return { script, finish };
}

describe("orchestrator concurrency", () => {
  it("lets an advisor start while a writer is mid-turn", async () => {
    const { script, finish } = gated();
    const { manager } = team([script], new Set(["programmer"]));
    try {
      const run = manager.prompt(project, conversation("programmer"), "build it");
      await expect.poll(() => manager.isProjectWriteBusy(project.id)).toBe(true);
      expect(manager.isProjectBusy(project.id)).toBe(true);
      const advisor = manager.prompt(project, conversation("critic"), "review it");
      expect(advisor.queued).toBe(false);
      finish();
      await run.result;
      await advisor.result;
      expect(manager.isProjectWriteBusy(project.id)).toBe(false);
    } finally {
      finish();
      await manager.close();
    }
  });

  it("refuses a second writer while one is mid-turn", async () => {
    const { script, finish } = gated();
    const { manager } = team([script], new Set(["programmer", "artist"]));
    try {
      const run = manager.prompt(project, conversation("programmer"), "build it");
      await expect.poll(() => manager.isProjectWriteBusy(project.id)).toBe(true);
      await expect(manager.prompt(project, conversation("artist"), "draw it"))
        .rejects.toThrow("Wait for the other conversation in this project to finish");
      finish();
      await run.result;
    } finally {
      finish();
      await manager.close();
    }
  });

  it("keeps one turn per project when no resolver is given", async () => {
    const { script, finish } = gated();
    const { manager } = team([script]);
    try {
      const run = manager.prompt(project, conversation("a"), "work");
      await expect.poll(() => manager.isProjectBusy(project.id)).toBe(true);
      expect(manager.isProjectWriteBusy(project.id)).toBe(true);
      await expect(manager.prompt(project, conversation("b"), "work"))
        .rejects.toThrow("Wait for the other conversation in this project to finish");
      finish();
      await run.result;
    } finally {
      finish();
      await manager.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-concurrency.test.ts`
Expected: FAIL — `isProjectWriteBusy` is not a function, and the advisor case is refused.

- [ ] **Step 3: Add the option and the method**

In `AgentManagerOptions` (`src/daemon/agent.ts:397-417`), after `onMcpToolFailed`:

```ts
  /**
   * Which conversations may write files. Absent, or a conversation it does not
   * name, means it may — so a project with no orchestrator behaves as before.
   */
  isWriterConversation?: (projectId: string, conversationId: string) => boolean;
```

Next to `isProjectBusy` (`src/daemon/agent.ts:2365-2368`):

```ts
  /** True while a turn that may write files is active in this project. Advisor turns never make it true. */
  isProjectWriteBusy(projectId: string): boolean {
    const prefix = `${projectId}:`;
    return [...this.#activeTurns.keys(), ...this.#revisions].some(
      (key) => key.startsWith(prefix) && this.#mayWrite(key),
    );
  }

  /** A conversation key's last segment is its conversation id; neither id contains a colon. */
  #mayWrite(key: string): boolean {
    const resolver = this.options.isWriterConversation;
    if (!resolver) return true;
    return resolver(key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1));
  }
```

- [ ] **Step 4: Split the guard**

Replace `src/daemon/agent.ts:864`:

```ts
    if (!active && this.options.checkpoints && this.isProjectBusy(project.id)) throw new Error("Wait for the other conversation in this project to finish");
```

with:

```ts
    // Only a turn that writes files has to wait for another writer. An advisor reads, and the
    // put-back check above already holds it off while a restore changes files under it.
    if (!active && this.options.checkpoints && this.#mayWrite(key) && this.isProjectWriteBusy(project.id))
      throw new Error("Wait for the other conversation in this project to finish");
```

`key` is already in scope: `const key = conversationKey(project.id, conversation.summary.id);` at `src/daemon/agent.ts:842`, twenty-two lines above the guard. Leave the `#puttingBack` and `#revisions` guards above it untouched, and leave the four 409 guards in `app.ts` (`:1789`, `:2075`, `:2888`, `:4439`) on `isProjectBusy`, because build, delete and export touch the whole project whoever is writing.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator-concurrency.test.ts && bun run test -- test/agent.test.ts`
Expected: PASS. `test/agent.test.ts` is the regression gate for the unchanged default.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/agent.ts test/orchestrator-concurrency.test.ts
git commit -m "feat(orchestrator): let advisor conversations run while a writer holds the project"
```

---

# Phase 2 — Store, roster and routes

## Task 4: The orchestrator store

**Files:**
- Create: `src/daemon/orchestrator-store.ts`
- Test: `test/orchestrator-store.test.ts` (extend the file from Task 1)

**Interfaces:**
- Consumes: `OrchestratorConfig`, `ORCHESTRATOR_STORE_VERSION` from Task 1; `ProjectState` from `src/shared/contracts.ts`.
- Produces:
  - `orchestratorFile(project: Pick<ProjectState, "storagePath" | "workspacePath">): string`
  - `loadOrchestratorConfig(project): Promise<OrchestratorConfig | undefined>`
  - `saveOrchestratorConfig(project, config: OrchestratorConfig): Promise<void>`
  - `class OrchestratorStoreUnreadableError extends Error` with a `reason: "newer-version" | "damaged"` field.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator-store.test.ts
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OrchestratorStoreUnreadableError,
  loadOrchestratorConfig,
  orchestratorFile,
  saveOrchestratorConfig,
} from "../src/daemon/orchestrator-store.js";

async function tempProject() {
  const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-"));
  return { id: "project-1", name: "Project", type: "general" as const, updatedAt: new Date(0).toISOString(), workspacePath: path.join(storagePath, "workspace"), storagePath, preview: { status: "waiting" as const } };
}

describe("orchestrator store", () => {
  it("returns undefined when nothing was saved", async () => {
    const project = await tempProject();
    expect(await loadOrchestratorConfig(project)).toBeUndefined();
  });

  it("round-trips a config", async () => {
    const project = await tempProject();
    const config: OrchestratorConfig = {
      version: ORCHESTRATOR_STORE_VERSION, goal: "ship it",
      roles: [role("programmer", "writer")], updatedAt: new Date(0).toISOString(),
    };
    await saveOrchestratorConfig(project, config);
    expect(await loadOrchestratorConfig(project)).toEqual(config);
  });

  it("refuses a newer version and leaves the file alone", async () => {
    const project = await tempProject();
    await mkdir(path.dirname(orchestratorFile(project)), { recursive: true });
    const future = JSON.stringify({ version: 99, goal: "from the future", roles: [], updatedAt: new Date(0).toISOString() });
    await writeFile(orchestratorFile(project), future, "utf8");
    await expect(loadOrchestratorConfig(project)).rejects.toBeInstanceOf(OrchestratorStoreUnreadableError);
    expect(await readFile(orchestratorFile(project), "utf8")).toBe(future);
  });

  it("refuses damaged json and leaves the file alone", async () => {
    const project = await tempProject();
    await mkdir(path.dirname(orchestratorFile(project)), { recursive: true });
    await writeFile(orchestratorFile(project), "{not json", "utf8");
    await expect(loadOrchestratorConfig(project)).rejects.toMatchObject({ reason: "damaged" });
    expect(await readFile(orchestratorFile(project), "utf8")).toBe("{not json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-store.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/orchestrator-store.js`.

- [ ] **Step 3: Write the store**

```ts
// src/daemon/orchestrator-store.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ORCHESTRATOR_STORE_VERSION, type OrchestratorConfig } from "../shared/orchestrator.js";

type OrchestratorProject = { storagePath?: string; workspacePath: string };

/** Saved beside the project's conversations, outside the workspace the agents edit. */
export function orchestratorFile(project: OrchestratorProject): string {
  const root = project.storagePath ?? path.dirname(project.workspacePath);
  return path.join(root, "orchestrator.json");
}

export class OrchestratorStoreUnreadableError extends Error {
  constructor(readonly reason: "newer-version" | "damaged", message: string) {
    super(message);
  }
}

/**
 * Undefined when nothing was saved yet. A file this build cannot understand is
 * left exactly as it is, so a newer version's data is never replaced.
 */
export async function loadOrchestratorConfig(project: OrchestratorProject): Promise<OrchestratorConfig | undefined> {
  let text: string;
  try {
    text = await readFile(orchestratorFile(project), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrchestratorStoreUnreadableError("damaged", "The orchestrator file is not valid JSON.");
  }
  const config = parsed as Partial<OrchestratorConfig>;
  if (typeof config?.version !== "number" || !Array.isArray(config.roles)) {
    throw new OrchestratorStoreUnreadableError("damaged", "The orchestrator file is missing its version or roster.");
  }
  if (config.version > ORCHESTRATOR_STORE_VERSION) {
    throw new OrchestratorStoreUnreadableError(
      "newer-version",
      `This orchestrator was saved by a newer OhMyGame (version ${config.version}). Update to read it.`,
    );
  }
  // compat: since beta.5.6. Version 1 is the only shape today; add a step here per new version.
  return config as OrchestratorConfig;
}

/** Written through a temporary file, so a crash mid-write cannot leave a partial store. */
export async function saveOrchestratorConfig(project: OrchestratorProject, config: OrchestratorConfig): Promise<void> {
  const file = orchestratorFile(project);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
```

Set the `compat:` release in the comment to the version this actually ships in — read `version` in `package.json` and use the next beta.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/orchestrator-store.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator-store.ts test/orchestrator-store.test.ts
git commit -m "feat(orchestrator): persist the roster beside the project's conversations"
```

---

## Task 5: Supervisor roster, start and stop

No autonomous loop yet — this task creates the conversations, tracks status, and stops cleanly. Task 10 adds the advance loop.

**Files:**
- Create: `src/daemon/orchestrator.ts`
- Test: `test/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: types from Task 1, `loadOrchestratorConfig`/`saveOrchestratorConfig` from Task 4, `AgentManager.prompt`/`cancelPrompt`, `RuntimeEventBus.publish`, `ConversationManager` for creating conversations.
- Produces the class `OrchestratorSupervisor`:
  - `constructor(deps: OrchestratorDeps)`
  - `state(projectId: string): OrchestratorState | undefined`
  - `isWriterConversation(projectId: string, conversationId: string): boolean`
  - `personaFor(projectId: string, conversationId: string): string | undefined`
  - `configure(project, config): Promise<OrchestratorState>`
  - `start(project): Promise<OrchestratorState>`
  - `stop(projectId: string): Promise<OrchestratorState | undefined>`
  - `load(project): Promise<void>`
  - `close(): Promise<void>`
  - and `interface OrchestratorDeps` as written below.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator.test.ts
import { OrchestratorSupervisor, type OrchestratorDeps } from "../src/daemon/orchestrator.js";

/** Records what the supervisor asked of the agent layer instead of running it. */
function harness(roles: OrchestratorRoleConfig[]) {
  const published: Array<{ type: string; conversationId?: string }> = [];
  const prompts: Array<{ conversationId: string; text: string }> = [];
  const created: string[] = [];
  const deps: OrchestratorDeps = {
    // RuntimeEventBus.publish is (projectId, type, data, scope?) — src/shared/events.ts:19-25.
    events: {
      publish: (projectId: string, type: string, _data: unknown, scope?: { conversationId?: string }) => {
        published.push({ type, ...(scope?.conversationId ? { conversationId: scope.conversationId } : {}) });
        return { id: published.length };
      },
    } as unknown as OrchestratorDeps["events"],
    createConversation: async (_project, title) => {
      const id = `conversation-${created.length + 1}`;
      created.push(title);
      return id;
    },
    prompt: async (_project, conversationId, text) => {
      prompts.push({ conversationId, text });
      return { turnId: `turn-${prompts.length}` };
    },
    cancel: async () => {},
    now: () => new Date(0).toISOString(),
  };
  const project = { id: "project-1", name: "Project", type: "general" as const, updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1", preview: { status: "waiting" as const } };
  const supervisor = new OrchestratorSupervisor(deps);
  return { supervisor, project, published, prompts, created, roles };
}

describe("orchestrator supervisor", () => {
  it("creates one conversation per role and starts only the writer", async () => {
    const { supervisor, project, prompts, created } = harness([
      { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } },
      { id: "critic", name: "Critic", persona: "Judge the feel.", capability: "advisor", model: { provider: "pi", id: "test" } },
    ]);
    await supervisor.configure(project, {
      version: 1, goal: "Make it playable",
      roles: [
        { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } },
        { id: "critic", name: "Critic", persona: "Judge the feel.", capability: "advisor", model: { provider: "pi", id: "test" } },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    const state = await supervisor.start(project);
    expect(created).toEqual(["Programmer", "Critic"]);
    expect(state.status).toBe("running");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Make it playable");
    expect(state.roles.map((role) => role.status)).toEqual(["running", "idle"]);
  });

  it("names the writer of a conversation and leaves an ordinary conversation writable", async () => {
    const { supervisor, project } = harness([]);
    await supervisor.configure(project, {
      version: 1, goal: "g",
      roles: [
        { id: "programmer", name: "Programmer", persona: "p", capability: "writer", model: { provider: "pi", id: "test" } },
        { id: "critic", name: "Critic", persona: "c", capability: "advisor", model: { provider: "pi", id: "test" } },
      ],
      updatedAt: new Date(0).toISOString(),
    });
    await supervisor.start(project);
    const state = supervisor.state(project.id)!;
    const writer = state.roles.find((role) => role.config.id === "programmer")!.conversationId!;
    const advisor = state.roles.find((role) => role.config.id === "critic")!.conversationId!;
    expect(supervisor.isWriterConversation(project.id, writer)).toBe(true);
    expect(supervisor.isWriterConversation(project.id, advisor)).toBe(false);
    expect(supervisor.isWriterConversation(project.id, "some-other-conversation")).toBe(true);
    await supervisor.stop(project.id);
    expect(supervisor.state(project.id)!.status).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/orchestrator.js`.

- [ ] **Step 3: Write the supervisor**

```ts
// src/daemon/orchestrator.ts
import { ORCHESTRATOR_MAX_ROLES, ORCHESTRATOR_ROLE_ID_PATTERN, ORCHESTRATOR_STORE_VERSION, type OrchestratorConfig, type OrchestratorRoleState, type OrchestratorState } from "../shared/orchestrator.js";
import type { AgentModelRef, ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import { OrchestratorStoreUnreadableError, loadOrchestratorConfig, saveOrchestratorConfig } from "./orchestrator-store.js";

export interface OrchestratorDeps {
  events: RuntimeEventBus;
  /** Creates a conversation for a role and titles it after the role. Returns its id. */
  createConversation(project: ProjectState, title: string, model?: AgentModelRef): Promise<string>;
  /** Sends a prompt to a role's conversation and returns the turn, so it can be cancelled. */
  prompt(project: ProjectState, conversationId: string, text: string): Promise<{ turnId: string }>;
  cancel(projectId: string, conversationId: string, turnId: string): Promise<void>;
  now(): string;
}

interface Run {
  project: ProjectState;
  state: OrchestratorState;
}

/** Consecutive agent-to-agent rounds with no writer file change before the run pauses. */
export const PING_PONG_LIMIT = 3;

export class OrchestratorSupervisor {
  readonly #runs = new Map<string, Run>();

  constructor(private readonly deps: OrchestratorDeps) {}

  state(projectId: string): OrchestratorState | undefined {
    return this.#runs.get(projectId)?.state;
  }

  /** A conversation the orchestrator does not own is an ordinary one, so it may write. */
  isWriterConversation(projectId: string, conversationId: string): boolean {
    const run = this.#runs.get(projectId);
    if (!run) return true;
    const role = run.state.roles.find((item) => item.conversationId === conversationId);
    return role ? role.config.capability === "writer" : true;
  }

  personaFor(projectId: string, conversationId: string): string | undefined {
    return this.#runs.get(projectId)?.state.roles
      .find((item) => item.conversationId === conversationId)?.config.persona;
  }

  async configure(project: ProjectState, config: OrchestratorConfig): Promise<OrchestratorState> {
    if (this.#runs.get(project.id)?.state.status === "running") throw new Error("Stop the team before changing it");
    if (config.roles.length > ORCHESTRATOR_MAX_ROLES) throw new Error(`A team has at most ${ORCHESTRATOR_MAX_ROLES} roles`);
    const ids = new Set<string>();
    for (const role of config.roles) {
      if (!ORCHESTRATOR_ROLE_ID_PATTERN.test(role.id)) throw new Error(`"${role.id}" is not a valid role id`);
      if (ids.has(role.id)) throw new Error(`Two roles are both called "${role.id}"`);
      ids.add(role.id);
    }
    if (!config.roles.some((role) => role.capability === "writer")) throw new Error("A team needs one role that can write files");
    const saved: OrchestratorConfig = { ...config, updatedAt: this.deps.now() };
    await saveOrchestratorConfig(project, saved);
    const state: OrchestratorState = {
      config: saved, status: "idle",
      roles: saved.roles.map((role) => ({ config: role, status: "idle" as const })),
    };
    this.#runs.set(project.id, { project, state });
    return this.#publish(project.id, state);
  }

  async start(project: ProjectState): Promise<OrchestratorState> {
    const run = this.#runs.get(project.id);
    if (!run) throw new Error("Configure the team before starting it");
    if (run.state.status === "running") return run.state;
    this.#roundsWithoutWrite = 0;
    this.#goalComplete = false;
    const roles: OrchestratorRoleState[] = [];
    for (const role of run.state.roles) {
      // A run that was stopped keeps its conversations, so restarting continues where it left off.
      const conversationId = role.conversationId ?? await this.deps.createConversation(project, role.config.name, role.config.model);
      roles.push({ ...role, config: role.config, conversationId, status: "idle" });
    }
    run.state = { ...run.state, roles, status: "running", diagnostic: undefined };
    const writer = roles.find((role) => role.config.capability === "writer");
    if (writer) await this.#promptRole(run, writer, openingPrompt(run.state.config.goal));
    return this.#publish(project.id, run.state);
  }

  async stop(projectId: string): Promise<OrchestratorState | undefined> {
    const run = this.#runs.get(projectId);
    if (!run || run.state.status !== "running") return run?.state;
    await Promise.all(run.state.roles
      .filter((role) => role.conversationId && role.lastTurnId && role.status === "running")
      .map((role) => this.deps.cancel(projectId, role.conversationId!, role.lastTurnId!)));
    run.state = { ...run.state, status: "stopped", roles: run.state.roles.map((role) => ({ ...role, status: "idle" as const })) };
    return this.#publish(projectId, run.state);
  }

  /** Rebuilds a run from what was saved, so a restart does not lose the roster. */
  async load(project: ProjectState): Promise<void> {
    if (this.#runs.has(project.id)) return;
    const config = await loadOrchestratorConfig(project);
    if (!config) return;
    // A run that was going when the app closed is not going now; nothing resumes it by itself.
    this.#runs.set(project.id, {
      project,
      state: { config, status: "stopped", roles: config.roles.map((role) => ({ config: role, status: "idle" as const })) },
    });
  }

  async close(): Promise<void> {
    for (const projectId of [...this.#runs.keys()]) await this.stop(projectId);
    this.#runs.clear();
  }

  #publish(projectId: string, state: OrchestratorState): OrchestratorState {
    this.deps.events.publish(projectId, "orchestrator.state", { state });
    return state;
  }
}

/** The first thing the writer is told. English, because it goes to the model. */
export function openingPrompt(goal: string): string {
  return `You are working as part of a team on this project.\n\nGoal: ${goal}\n\nStart on the goal now. Use send_message_to_agent when a teammate should weigh in, and mark_goal_complete when the goal is met.`;
}
```

`RuntimeEventBus.publish` is `publish<T>(projectId, type, data, scope?, replayData?)` (`src/shared/events.ts:19-25`) — the scope object carries `conversationId` and `turnId`, it is not a positional argument. Every publish call in this plan follows that shape.

`#promptRole` and the two counters (`#roundsWithoutWrite`, `#goalComplete`) are declared in Tasks 9 and 11. To keep this task compiling on its own, declare them here as `#roundsWithoutWrite = 0;`, `#goalComplete = false;` and

```ts
  async #promptRole(run: Run, role: OrchestratorRoleState, text: string): Promise<void> {
    role.status = "running";
    role.lastTurnId = (await this.deps.prompt(run.project, role.conversationId!, text)).turnId;
    this.#publish(run.project.id, run.state);
  }
```

then delete the duplicate declarations when Tasks 9 and 11 add their own versions.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: PASS — both new cases and the Task 2 event cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): start and stop a team of role conversations"
```

---

## Task 6: Routes

**Files:**
- Create: `src/daemon/orchestrator-routes.ts`
- Modify: `src/daemon/app.ts` (register, following `registerCheckpointRoutes(app, {...})` at `:2178`)
- Test: `test/orchestrator-routes.test.ts`

**Interfaces:**
- Consumes: `OrchestratorSupervisor` from Task 5, `ProjectManager` for looking a project up.
- Produces: `registerOrchestratorRoutes(app: FastifyInstance, deps: OrchestratorRouteDeps): void` and the four routes in the table below.

| Method | Path | Success | Refusal |
| --- | --- | --- | --- |
| `GET` | `/projects/:projectId/orchestrator` | `200` `OrchestratorState` | `404` unknown project, `404` no team |
| `PUT` | `/projects/:projectId/orchestrator` | `200` new state | `400` bad body, `409` running |
| `POST` | `/projects/:projectId/orchestrator/start` | `200` new state | `400` no team configured |
| `POST` | `/projects/:projectId/orchestrator/stop` | `200` new state | `404` no run |
| `DELETE` | `/projects/:projectId/orchestrator` | `204`, conversations archived | `409` running |

- [ ] **Step 1: Write the failing test**

Follow the existing route-test pattern — find one with `grep -rln "app.inject" test/ | head -3` and copy how it builds the Fastify instance and authenticates. The assertions to write:

```ts
// test/orchestrator-routes.test.ts
describe("orchestrator routes", () => {
  it("saves a roster and reads it back", async () => {
    const response = await app.inject({
      method: "PUT", url: "/projects/project-1/orchestrator",
      payload: { goal: "Make it playable", roles: [{ id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("idle");
    const read = await app.inject({ method: "GET", url: "/projects/project-1/orchestrator" });
    expect(read.json().config.goal).toBe("Make it playable");
  });

  it("refuses a roster with no writer", async () => {
    const response = await app.inject({
      method: "PUT", url: "/projects/project-1/orchestrator",
      payload: { goal: "g", roles: [{ id: "critic", name: "Critic", persona: "c", capability: "advisor", model: { provider: "pi", id: "test" } }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a role id that is not a slug", async () => {
    const response = await app.inject({
      method: "PUT", url: "/projects/project-1/orchestrator",
      payload: { goal: "g", roles: [{ id: "Not A Slug", name: "x", persona: "p", capability: "writer", model: { provider: "pi", id: "test" } }] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to change a team that is running", async () => {
    await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/start" });
    const response = await app.inject({
      method: "PUT", url: "/projects/project-1/orchestrator",
      payload: { goal: "other", roles: [{ id: "programmer", name: "Programmer", persona: "p", capability: "writer", model: { provider: "pi", id: "test" } }] },
    });
    expect(response.statusCode).toBe(409);
  });

  it("404s for a project that does not exist", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/nope/orchestrator" });
    expect(response.statusCode).toBe(404);
  });

  it("disbands a stopped team and refuses a running one", async () => {
    await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/start" });
    expect((await app.inject({ method: "DELETE", url: "/projects/project-1/orchestrator" })).statusCode).toBe(409);
    await app.inject({ method: "POST", url: "/projects/project-1/orchestrator/stop" });
    expect((await app.inject({ method: "DELETE", url: "/projects/project-1/orchestrator" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/projects/project-1/orchestrator" })).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-routes.test.ts`
Expected: FAIL — 404 on every route.

- [ ] **Step 3: Write the route module**

```ts
// src/daemon/orchestrator-routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentModelRef } from "../shared/contracts.js";
import { ORCHESTRATOR_MAX_ROLES, ORCHESTRATOR_ROLE_ID_PATTERN, ORCHESTRATOR_STORE_VERSION } from "../shared/orchestrator.js";
import type { OrchestratorSupervisor } from "./orchestrator.js";
import type { ProjectManager } from "./projects.js";

const roleSchema = {
  type: "object",
  required: ["id", "name", "persona", "capability", "model"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 40, pattern: ORCHESTRATOR_ROLE_ID_PATTERN.source },
    name: { type: "string", minLength: 1, maxLength: 80 },
    persona: { type: "string", minLength: 1, maxLength: 4_000 },
    capability: { type: "string", enum: ["writer", "advisor"] },
    model: { type: "object", required: ["provider", "id"], properties: { provider: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 } } },
  },
};

const configSchema = {
  type: "object",
  required: ["goal", "roles"],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 4_000 },
    roles: { type: "array", minItems: 1, maxItems: ORCHESTRATOR_MAX_ROLES, items: roleSchema },
  },
};

interface RouteBody {
  goal: string;
  roles: Array<{ id: string; name: string; persona: string; capability: "writer" | "advisor"; model: AgentModelRef }>;
}

export function registerOrchestratorRoutes(app: FastifyInstance, deps: { projects: ProjectManager; orchestrator: OrchestratorSupervisor }): void {
  // ProjectManager.get is synchronous and returns undefined for an unknown id (src/daemon/projects.ts:292).
  const project = (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
    const found = deps.projects.get(request.params.projectId);
    if (!found) reply.code(404).send({ error: "Unknown project" });
    return found;
  };

  app.get("/projects/:projectId/orchestrator", async (request, reply) => {
    const found = project(request, reply);
    if (!found) return reply;
    const state = deps.orchestrator.state(found.id) ?? await deps.orchestrator.loaded(found);
    return state ?? reply.code(404).send({ error: "This project has no team" });
  });

  app.put("/projects/:projectId/orchestrator", { schema: { body: configSchema } }, async (request, reply) => {
    const found = project(request, reply);
    if (!found) return reply;
    const body = request.body as RouteBody;
    try {
      return await deps.orchestrator.configure(found, { version: ORCHESTRATOR_STORE_VERSION, goal: body.goal, roles: body.roles, updatedAt: new Date().toISOString() });
    } catch (cause) {
      const message = (cause as Error).message;
      return reply.code(message === "Stop the team before changing it" ? 409 : 400).send({ error: message });
    }
  });

  app.post("/projects/:projectId/orchestrator/start", async (request, reply) => {
    const found = project(request, reply);
    if (!found) return reply;
    try {
      return await deps.orchestrator.start(found);
    } catch (cause) {
      return reply.code(400).send({ error: (cause as Error).message });
    }
  });

  app.post("/projects/:projectId/orchestrator/stop", async (request, reply) => {
    const found = project(request, reply);
    if (!found) return reply;
    const state = await deps.orchestrator.stop(found.id);
    return state ?? reply.code(404).send({ error: "This project has no team" });
  });

  app.delete("/projects/:projectId/orchestrator", async (request, reply) => {
    const found = project(request, reply);
    if (!found) return reply;
    try {
      return await deps.orchestrator.remove(found);
    } catch (cause) {
      return reply.code(409).send({ error: (cause as Error).message });
    }
  });
}
```

Add to `OrchestratorSupervisor` the two helpers the routes use. `loaded` goes next to `load` from Task 5; `remove` archives the role conversations rather than deleting them, matching `ConversationManager`'s archive behaviour (`src/daemon/conversations.ts:344`):

```ts
  /** The saved state, loading it on first ask. Undefined when the project has no team. */
  async loaded(project: ProjectState): Promise<OrchestratorState | undefined> {
    await this.load(project);
    return this.state(project.id);
  }

  /** Disbands the team. The conversations are archived, not deleted, so their history stays readable. */
  async remove(project: ProjectState): Promise<void> {
    const run = this.#runs.get(project.id);
    if (run?.state.status === "running") throw new Error("Stop the team before removing it");
    for (const role of run?.state.roles ?? []) {
      if (role.conversationId) await this.deps.archiveConversation(project, role.conversationId);
    }
    this.#runs.delete(project.id);
    await removeOrchestratorConfig(project);
  }
```

Add `archiveConversation(project: ProjectState, conversationId: string): Promise<void>` to `OrchestratorDeps`, and `removeOrchestratorConfig(project)` to `src/daemon/orchestrator-store.ts`:

```ts
/** Deletes the store, and only the store. A file that is not there is already the wanted result. */
export async function removeOrchestratorConfig(project: OrchestratorProject): Promise<void> {
  await rm(orchestratorFile(project), { force: true });
}
```

with `rm` added to the `node:fs/promises` import in that file.

Register in `src/daemon/app.ts` beside `registerCheckpointRoutes(app, {` at `:2178`:

```ts
  registerOrchestratorRoutes(app, { projects, orchestrator });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator-routes.test.ts && bun run lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator-routes.ts src/daemon/orchestrator.ts src/daemon/app.ts test/orchestrator-routes.test.ts
git commit -m "feat(orchestrator): expose the team over the project routes"
```

---

## Task 7: Wire the supervisor into the daemon

This is the task that makes Phase 1 and Phase 2 meet. After it, a configured team really runs an advisor in parallel with a writer.

**Files:**
- Modify: `src/daemon/app.ts` — the `AgentManager` construction, `instructions` at `:1088`, `projectAgentTools` at `:984-1001`
- Modify: `src/daemon/agent-prompts.ts:54` if the persona is added there instead
- Test: `test/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `OrchestratorSupervisor.isWriterConversation` and `.personaFor` from Task 5.
- Produces: nothing new; later tasks rely on the wired `orchestrator` instance being reachable inside `app.ts` as `orchestrator`.

- [ ] **Step 1: Write the failing test**

Assert the two wiring facts that are cheap to test in isolation, in `test/orchestrator.test.ts`:

```ts
import { rolePersonaInstructions } from "../src/daemon/agent-prompts.js";

describe("role persona", () => {
  it("adds nothing when the conversation has no role", () => {
    expect(rolePersonaInstructions(undefined)).toEqual([]);
  });

  it("states the role and that teammates can be messaged", () => {
    const lines = rolePersonaInstructions("You are the Critic. Judge the feel.");
    expect(lines.join("\n")).toContain("You are the Critic.");
    expect(lines.join("\n")).toContain("send_message_to_agent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — `rolePersonaInstructions` is not exported.

- [ ] **Step 3: Add the helper and wire it**

In `src/daemon/agent-prompts.ts`, beside `appendSystemPromptForProject` (`:54`):

```ts
/** What a role adds to its agent's instructions. Empty for a conversation with no role. */
export function rolePersonaInstructions(persona: string | undefined): string[] {
  if (!persona) return [];
  return [
    `Your role on this team:\n${persona}`,
    "You are one of several agents working on this project at the same time. Use list_agents to see the others and send_message_to_agent to talk to one. Messages from teammates arrive as user messages naming their author.",
  ];
}
```

In `src/daemon/app.ts`, build the supervisor before the `AgentManager`, then pass the resolver. Find the construction with `grep -n "new AgentManager" src/daemon/app.ts`. These are the real signatures, verified against the source:

- `ConversationManager.create(project, model?, reasoningLevel?): Promise<StoredConversation>` — `src/daemon/conversations.ts:54`
- `ConversationManager.get(project, conversationId): Promise<StoredConversation | undefined>` — `:92`
- `ConversationManager.rename(project, conversationId, title): Promise<ConversationSummary | undefined>` — `:156`
- `ConversationManager.archive(project, conversationId): Promise<boolean>` — `:112`
- `AgentManager.prompt(project, conversation: StoredConversation, prompt, ...): { turnId; queued; result? }` — synchronous, `src/daemon/agent.ts:828-839`
- `AgentManager.cancel(projectId, conversationId, turnId): Promise<void>` — `:1286`
- `ProjectManager.get(id): ProjectState | undefined` and `list(): ProjectState[]` — both synchronous, `src/daemon/projects.ts:285`, `:292`

```ts
  const orchestrator = new OrchestratorSupervisor({
    events,
    createConversation: async (project, title, model) => {
      const stored = await conversations.create(project, model);
      await conversations.rename(project, stored.summary.id, title);
      return stored.summary.id;
    },
    prompt: async (project, conversationId, text) => {
      const stored = await conversations.get(project, conversationId);
      if (!stored) throw new Error(`Conversation ${conversationId} is gone`);
      // AgentManager.prompt is synchronous and hands back the turn it started.
      return { turnId: agents.prompt(project, stored, text).turnId };
    },
    cancel: (projectId, conversationId, turnId) => agents.cancel(projectId, conversationId, turnId),
    archiveConversation: (project, conversationId) => conversations.archive(project, conversationId).then(() => {}),
    now: () => new Date().toISOString(),
  });
```

Use the local variable names this file actually uses for the event bus, conversation manager and agent manager — check with `grep -n "const events = \|new ConversationManager\|new AgentManager" src/daemon/app.ts`.

Add to the `AgentManager` options object:

```ts
      isWriterConversation: (projectId, conversationId) => orchestrator.isWriterConversation(projectId, conversationId),
```

At `src/daemon/app.ts:1088`, add the persona:

```ts
      instructions: [...appendSystemPromptForProject(project), ...rolePersonaInstructions(orchestrator.personaFor(project.id, conversation.summary.id))].join("\n\n"),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator.test.ts && bun run test -- test/agent.test.ts && bun run typecheck`
Expected: PASS. `test/agent.test.ts` proves the default is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/app.ts src/daemon/agent-prompts.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): run roles through the existing agent stack"
```

---

# Phase 3 — Message bus

## Task 8: The three agent-facing tools

**Files:**
- Create: `src/daemon/orchestrator-tools.ts`
- Test: `test/orchestrator-tools.test.ts`

**Interfaces:**
- Consumes: `OrchestratorSupervisor.deliver` and `.roster` (added in this task), types from Task 1.
- Produces: `createOrchestratorTools(context: OrchestratorToolContext): PiToolDefinition[]` returning tools named exactly `list_agents`, `send_message_to_agent`, `mark_goal_complete`; and on the supervisor:
  - `roster(projectId: string): OrchestratorRosterEntry[]` where `OrchestratorRosterEntry = { id: string; name: string; capability: OrchestratorRoleCapability; status: AgentStatus; persona: string }`
  - `deliver(fromProjectId: string, fromConversationId: string, toRoleId: string, text: string): Promise<{ delivered: boolean; queued: boolean }>`
  - `completeGoal(projectId: string, conversationId: string, summary: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// test/orchestrator-tools.test.ts
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorTools } from "../src/daemon/orchestrator-tools.js";

function context(overrides: Partial<Parameters<typeof createOrchestratorTools>[0]> = {}) {
  return {
    projectId: "project-1",
    conversationId: "conversation-1",
    roleId: "critic",
    capability: "advisor" as const,
    roster: () => [
      { id: "programmer", name: "Programmer", capability: "writer" as const, status: "running" as const, persona: "Write the code." },
      { id: "critic", name: "Critic", capability: "advisor" as const, status: "idle" as const, persona: "Judge the feel." },
    ],
    deliver: vi.fn(async () => ({ delivered: true, queued: false })),
    completeGoal: vi.fn(async () => {}),
    ...overrides,
  };
}

function find(tools: ReturnType<typeof createOrchestratorTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return tool;
}

describe("orchestrator tools", () => {
  it("lists the team with roles and status", async () => {
    const result = await find(createOrchestratorTools(context()), "list_agents").execute("call-1", {}, undefined, () => {});
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("programmer");
    expect(text).toContain("writer");
    expect(text).toContain("running");
  });

  it("delivers a message to a named teammate", async () => {
    const deliver = vi.fn(async () => ({ delivered: true, queued: true }));
    const result = await find(createOrchestratorTools(context({ deliver })), "send_message_to_agent")
      .execute("call-1", { agent: "programmer", message: "The jump feels floaty." }, undefined, () => {});
    expect(deliver).toHaveBeenCalledWith("project-1", "conversation-1", "programmer", "The jump feels floaty.");
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("queued");
  });

  it("refuses an unknown teammate by name", async () => {
    await expect(find(createOrchestratorTools(context()), "send_message_to_agent")
      .execute("call-1", { agent: "nobody", message: "hi" }, undefined, () => {}))
      .rejects.toThrow("nobody");
  });

  it("gives mark_goal_complete to writers only", () => {
    expect(find(createOrchestratorTools(context({ capability: "writer" })), "mark_goal_complete").name).toBe("mark_goal_complete");
    expect(createOrchestratorTools(context({ capability: "advisor" })).map((tool) => tool.name)).not.toContain("mark_goal_complete");
  });

  it("ends the run when the goal is marked complete", async () => {
    const completeGoal = vi.fn(async () => {});
    await find(createOrchestratorTools(context({ capability: "writer", completeGoal })), "mark_goal_complete")
      .execute("call-1", { summary: "The level plays end to end." }, undefined, () => {});
    expect(completeGoal).toHaveBeenCalledWith("project-1", "conversation-1", "The level plays end to end.");
  });
});
```

Read one existing tool test first (`sed -n '70,100p' test/agent-tools.test.ts`) and match how it calls `execute` — the fourth argument and the result shape must agree with the `defineTool` version in this repo.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-tools.test.ts`
Expected: FAIL — cannot resolve `../src/daemon/orchestrator-tools.js`.

- [ ] **Step 3: Write the tools**

```ts
// src/daemon/orchestrator-tools.ts
import { defineTool, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentStatus } from "../shared/contracts.js";
import type { OrchestratorRoleCapability } from "../shared/orchestrator.js";

export interface OrchestratorRosterEntry {
  id: string;
  name: string;
  capability: OrchestratorRoleCapability;
  status: AgentStatus;
  persona: string;
}

export interface OrchestratorToolContext {
  projectId: string;
  conversationId: string;
  roleId: string;
  capability: OrchestratorRoleCapability;
  roster(): OrchestratorRosterEntry[];
  deliver(projectId: string, conversationId: string, toRoleId: string, text: string): Promise<{ delivered: boolean; queued: boolean }>;
  completeGoal(projectId: string, conversationId: string, summary: string): Promise<void>;
}

export function createOrchestratorTools(context: OrchestratorToolContext): PiToolDefinition[] {
  const named = (id: string) => context.roster().find((entry) => entry.id === id);
  return [
    defineTool({
      name: "list_agents",
      label: "List Team",
      description: "List the other agents working on this project, what each is for, and whether each is busy.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{
          type: "text" as const,
          text: context.roster()
            .map((entry) => `- ${entry.id} (${entry.name}), ${entry.capability}, ${entry.status}${entry.id === context.roleId ? " — you" : ""}: ${entry.persona}`)
            .join("\n"),
        }],
        details: { roster: context.roster() },
      }),
    }),
    defineTool({
      name: "send_message_to_agent",
      label: "Message Teammate",
      description: "Send a message to another agent on this project. Use it to ask a teammate for something only their role can give. The message arrives as their next prompt; a busy teammate gets it queued.",
      parameters: Type.Object({
        agent: Type.String({ minLength: 1, maxLength: 40, description: "The teammate's id, from list_agents" }),
        message: Type.String({ minLength: 1, maxLength: 4_000, description: "What to tell them, in English" }),
      }),
      execute: async (_toolCallId, input) => {
        const target = named(input.agent);
        if (!target) throw new Error(`No agent called "${input.agent}". Use list_agents.`);
        if (target.id === context.roleId) throw new Error("That is you.");
        const result = await context.deliver(context.projectId, context.conversationId, target.id, input.message);
        return {
          content: [{ type: "text" as const, text: result.queued ? `Queued for ${target.name}, who is busy now.` : `Delivered to ${target.name}.` }],
          details: result,
        };
      },
    }),
    // Only a writer can finish the work, so only a writer can say it is finished.
    ...(context.capability === "writer" ? [defineTool({
      name: "mark_goal_complete",
      label: "Goal Complete",
      description: "Say the team's goal is met and stop the run. Use it only when the goal is genuinely done, not to end a difficult turn.",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 2_000, description: "What was achieved, in English" }),
      }),
      execute: async (_toolCallId, input) => {
        await context.completeGoal(context.projectId, context.conversationId, input.summary);
        return { content: [{ type: "text" as const, text: "The run is complete. Stop working." }], details: { summary: input.summary } };
      },
    })] : []),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/orchestrator-tools.test.ts`
Expected: PASS — all five cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator-tools.ts test/orchestrator-tools.test.ts
git commit -m "feat(orchestrator): give agents the team tools"
```

---

## Task 9: Delivery, roster and goal completion on the supervisor

**Files:**
- Modify: `src/daemon/orchestrator.ts`
- Test: `test/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `OrchestratorDeps.prompt` and `.cancel` from Task 5.
- Produces: `roster(projectId)`, `deliver(projectId, fromConversationId, toRoleId, text)`, `completeGoal(projectId, conversationId, summary)` with the signatures declared in Task 8, and `pendingFor(projectId, conversationId): OrchestratorPendingMessage[]` where `OrchestratorPendingMessage = { fromRoleId: string; fromName: string; text: string }` — Task 10 drains it.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator.test.ts
describe("orchestrator delivery", () => {
  it("prompts an idle teammate straight away", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const state = supervisor.state(project.id)!;
    const critic = state.roles.find((role) => role.config.id === "critic")!.conversationId!;
    const programmer = state.roles.find((role) => role.config.id === "programmer")!.conversationId!;
    prompts.length = 0;
    const result = await supervisor.deliver(project.id, critic, "programmer", "The jump feels floaty.");
    expect(result).toEqual({ delivered: true, queued: false });
    expect(prompts[0]!.text).toContain("Critic: The jump feels floaty.");
    expect(prompts[0]!.conversationId).toBe(programmer);
  });

  it("holds a message for a teammate that is mid-turn", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    prompts.length = 0;
    // The writer is running from start(), so a message to it waits.
    const critic = supervisor.state(project.id)!.roles.find((role) => role.config.id === "critic")!.conversationId!;
    const result = await supervisor.deliver(project.id, critic, "programmer", "Also the audio.");
    expect(result.queued).toBe(true);
    expect(prompts).toHaveLength(0);
    expect(supervisor.pendingFor(project.id, supervisor.state(project.id)!.roles[0]!.conversationId!))
      .toEqual([{ fromRoleId: "critic", fromName: "Critic", text: "Also the audio." }]);
  });

  it("refuses a role that is not on the team", async () => {
    const { supervisor, project } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    await expect(supervisor.deliver(project.id, "conversation-2", "nobody", "hi")).rejects.toThrow("nobody");
  });

  it("completes the run when a writer marks the goal done", async () => {
    const { supervisor, project, published } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const programmer = supervisor.state(project.id)!.roles[0]!.conversationId!;
    await supervisor.completeGoal(project.id, programmer, "The level plays end to end.");
    expect(supervisor.state(project.id)!.status).toBe("completed");
    expect(published.some((event) => event.type === "orchestrator.state")).toBe(true);
  });

  it("ignores a goal marked by a conversation that is not the writer", async () => {
    const { supervisor, project } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const critic = supervisor.state(project.id)!.roles.find((role) => role.config.id === "critic")!.conversationId!;
    await expect(supervisor.completeGoal(project.id, critic, "done")).rejects.toThrow("writer");
  });
});
```

Define `writer`, `advisor` and a `config(roles)` helper at the top of the file so these cases stay short; `config` returns an `OrchestratorConfig` with `version: 1`, a goal and `updatedAt: new Date(0).toISOString()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — `deliver`, `roster`, `pendingFor` and `completeGoal` do not exist.

- [ ] **Step 3: Implement them**

Add to `OrchestratorSupervisor`. `#promptRole`, `#roundsWithoutWrite` and `#goalComplete` already exist from Task 5 — do not redeclare them:

```ts
  readonly #pending = new Map<string, OrchestratorPendingMessage[]>();

  roster(projectId: string): OrchestratorRosterEntry[] {
    return this.#runs.get(projectId)?.state.roles.map((role) => ({
      id: role.config.id,
      name: role.config.name,
      capability: role.config.capability,
      status: role.status,
      persona: role.config.persona,
    })) ?? [];
  }

  /** What has arrived for a conversation since its last turn drained. */
  pendingFor(projectId: string, conversationId: string): OrchestratorPendingMessage[] {
    return this.#pending.get(`${projectId}:${conversationId}`) ?? [];
  }

  async deliver(projectId: string, fromConversationId: string, toRoleId: string, text: string): Promise<{ delivered: boolean; queued: boolean }> {
    const run = this.#runs.get(projectId);
    if (!run) throw new Error("This project has no team");
    const from = run.state.roles.find((role) => role.conversationId === fromConversationId);
    if (!from) throw new Error("The sending conversation is not on this team");
    const to = run.state.roles.find((role) => role.config.id === toRoleId);
    if (!to?.conversationId) throw new Error(`No agent called "${toRoleId}"`);
    this.deps.events.publish(projectId, "orchestrator.message", {
      fromRoleId: from.config.id, toRoleId: to.config.id, text,
    }, { conversationId: to.conversationId });
    const message = { fromRoleId: from.config.id, fromName: from.config.name, text };
    if (to.status === "running") {
      const key = `${projectId}:${to.conversationId}`;
      this.#pending.set(key, [...(this.#pending.get(key) ?? []), message]);
      return { delivered: true, queued: true };
    }
    await this.#promptRole(run, to, teammatePrompt([message]));
    return { delivered: true, queued: false };
  }

  async completeGoal(projectId: string, conversationId: string, summary: string): Promise<void> {
    const run = this.#runs.get(projectId);
    const role = run?.state.roles.find((item) => item.conversationId === conversationId);
    if (!run || !role) throw new Error("This project has no team");
    if (role.config.capability !== "writer") throw new Error("Only a writer role can end the run");
    this.#goalComplete = true;
    run.state = { ...run.state, status: "completed", roles: run.state.roles.map((item) => ({ ...item, status: "idle" as const })) };
    this.#publish(projectId, run.state);
    await this.deps.prompt(run.project, conversationId, `The goal is recorded as complete: ${summary}\n\nDo not start new work. Summarise what the team achieved and stop.`);
  }

  /** Drains what arrived for a role and renders it as the head of its next prompt. */
  drain(projectId: string, conversationId: string): OrchestratorPendingMessage[] {
    const key = `${projectId}:${conversationId}`;
    const messages = this.#pending.get(key) ?? [];
    this.#pending.delete(key);
    return messages;
  }
```

And two module-level helpers beside `openingPrompt`:

```ts
/** Teammate messages, oldest first, as the head of the next prompt. */
export function teammatePrompt(messages: readonly OrchestratorPendingMessage[]): string {
  const lines = messages.map((message) => `- ${message.fromName}: ${message.text}`).join("\n");
  return `Messages from your teammates:\n${lines}\n\nRespond to what they raised, then carry on with the goal.`;
}
```

Export the pending-message type:

```ts
export interface OrchestratorPendingMessage {
  fromRoleId: string;
  fromName: string;
  text: string;
}
```

Import `OrchestratorRosterEntry` from `./orchestrator-tools.js`. If that creates an import cycle, move `OrchestratorRosterEntry` and `OrchestratorPendingMessage` into `src/shared/orchestrator.ts` and import from there in both places — no logic lives in `src/shared/`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator.test.ts && bun run test -- test/orchestrator-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator.ts src/shared/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): carry messages between roles"
```

---

## Task 10: Gate and register the tools

**Files:**
- Modify: `src/daemon/agent-tools.ts:41-60` (both allowlist branches), `src/daemon/app.ts:984-1001` (`projectAgentTools`), `src/daemon/external-mcp.ts:29-44` and `:60`
- Test: `test/orchestrator-tools.test.ts` (extend)

**Interfaces:**
- Consumes: `createOrchestratorTools` from Task 8, `OrchestratorSupervisor.roster`/`.deliver`/`.completeGoal` from Task 9.
- Produces: `activePiToolNames(enabledTools, registeredToolNames, webSearchEnabled, orchestrated?)` and `planningPiToolNames(webSearchEnabled, orchestrated?)` — the new last parameter defaults to `false`, so every existing call site is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator-tools.test.ts
import { activePiToolNames, planningPiToolNames, projectPiToolNames } from "../src/daemon/agent-tools.js";

const TEAM_TOOLS = ["list_agents", "send_message_to_agent"];

describe("orchestrator tool gating", () => {
  it("hides the team tools from an ordinary conversation", () => {
    expect(activePiToolNames([], [])).not.toContain("send_message_to_agent");
    expect(planningPiToolNames()).not.toContain("list_agents");
  });

  it("gives an orchestrated advisor the messaging tools but nothing that writes", () => {
    const names = projectPiToolNames("planning", [], [], true, true);
    expect(names).toEqual(expect.arrayContaining(TEAM_TOOLS));
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("mark_goal_complete");
  });

  it("gives an orchestrated writer the messaging tools and the goal tool", () => {
    const names = projectPiToolNames("normal", [], [], true, true);
    expect(names).toEqual(expect.arrayContaining([...TEAM_TOOLS, "mark_goal_complete", "write", "edit"]));
  });

  it("leaves an unorchestrated conversation exactly as it was", () => {
    expect(projectPiToolNames("planning", [], [], true, false)).toEqual(planningPiToolNames());
    expect(projectPiToolNames("normal", [], [], true, false)).toEqual(activePiToolNames([], []));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-tools.test.ts`
Expected: FAIL — the functions take no fifth argument.

- [ ] **Step 3: Add the parameter**

In `src/daemon/agent-tools.ts`:

```ts
const ORCHESTRATOR_TOOL_NAMES = ["list_agents", "send_message_to_agent"];
/** Only a writer can end a run, so only a writer sees the tool that does. */
const ORCHESTRATOR_WRITER_TOOL_NAMES = ["mark_goal_complete"];

export function activePiToolNames(
  enabledTools: readonly ToolId[],
  registeredToolNames: readonly string[] = [],
  webSearchEnabled = true,
  orchestrated = false,
): string[] {
  const ohMyGameToolNames = new Set(Object.values(PI_TOOL_NAMES));
  const extensionTools = registeredToolNames.filter((name) => !ohMyGameToolNames.has(name) && !PI_BUILTIN_TOOL_NAMES.has(name));
  return [...new Set([...extensionTools, "read", "write", "edit", "bash", ...(webSearchEnabled ? ["web_search"] : []), "update_plan", "install_plugin", ...enabledTools.map((id) => PI_TOOL_NAMES[id]), ...(enabledTools.length && registeredToolNames.includes("generate_canvas_media") ? ["generate_canvas_media"] : []), ...(orchestrated ? [...ORCHESTRATOR_TOOL_NAMES, ...ORCHESTRATOR_WRITER_TOOL_NAMES] : [])])];
}

export function planningPiToolNames(webSearchEnabled = true, orchestrated = false): string[] {
  return ["read", "grep", "find", "ls", ...(webSearchEnabled ? ["web_search"] : []), "questionnaire", "update_plan", ...(orchestrated ? ORCHESTRATOR_TOOL_NAMES : [])];
}

export function projectPiToolNames(
  mode: PlanMode,
  enabledTools: readonly ToolId[],
  registeredToolNames: readonly string[] = [],
  webSearchEnabled = true,
  orchestrated = false,
): string[] {
  return mode === "planning"
    ? [...planningPiToolNames(webSearchEnabled, orchestrated), ...(registeredToolNames.includes("canvas_check") ? ["canvas_check"] : [])]
    : activePiToolNames(enabledTools, registeredToolNames, webSearchEnabled, orchestrated);
}
```

Add the three names to `PI_BUILTIN_TOOL_NAMES` (`src/daemon/agent-tools.ts:40`) so the `extensionTools` filter does not pass them through twice:

```ts
const PI_BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "web_search", "update_plan", "questionnaire", "install_plugin", "generate_canvas_media", "list_agents", "send_message_to_agent", "mark_goal_complete"]);
```

- [ ] **Step 4: Register the tools for orchestrated conversations**

In `projectAgentTools` (`src/daemon/app.ts:984-1001`), after the `createAgentTools(...)` spread and before `...await pluginSetup.agentTools(project)`:

```ts
      ...orchestratorTools(project, conversation),
```

with the helper defined just above `projectAgentTools`:

```ts
  /** The team tools, only for a conversation a role owns. */
  const orchestratorTools = (project: ProjectState, conversation: StoredConversation) => {
    const role = orchestrator.roleFor(project.id, conversation.summary.id);
    if (!role) return [];
    return createOrchestratorTools({
      projectId: project.id,
      conversationId: conversation.summary.id,
      roleId: role.config.id,
      capability: role.config.capability,
      roster: () => orchestrator.roster(project.id),
      deliver: (projectId, conversationId, toRoleId, text) => orchestrator.deliver(projectId, conversationId, toRoleId, text),
      completeGoal: (projectId, conversationId, summary) => orchestrator.completeGoal(projectId, conversationId, summary),
    });
  };
```

Add `roleFor` to `OrchestratorSupervisor`, next to `personaFor` from Task 5, and reimplement `personaFor` in terms of it:

```ts
  roleFor(projectId: string, conversationId: string): OrchestratorRoleState | undefined {
    return this.#runs.get(projectId)?.state.roles.find((role) => role.conversationId === conversationId);
  }

  personaFor(projectId: string, conversationId: string): string | undefined {
    return this.roleFor(projectId, conversationId)?.config.persona;
  }
```

Pass `orchestrated` where the tool names are computed. Find the call sites with `grep -n "projectPiToolNames(\|activeToolNames:" src/daemon/app.ts` and add the fifth argument `Boolean(orchestrator.roleFor(project.id, conversation.summary.id))`.

Publish to external agents: add the three names to the public list in `src/daemon/external-mcp.ts:29-44`, and to `UNAVAILABLE_HINTS` (`:60`) with the text `"Only available inside a project with a team running."`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator-tools.test.ts && bun run test -- test/agent-tools.test.ts && bun run test -- test/external-mcp.test.ts && bun run lint`
Expected: PASS, lint clean. `test/agent-tools.test.ts` proves the default allowlists did not move.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/agent-tools.ts src/daemon/app.ts src/daemon/orchestrator.ts src/daemon/external-mcp.ts test/orchestrator-tools.test.ts
git commit -m "feat(orchestrator): gate the team tools to orchestrated conversations"
```

---

# Phase 4 — The autonomous loop

## Task 11: Advance the writer after each turn

**Files:**
- Modify: `src/daemon/orchestrator.ts`, `src/daemon/app.ts` (hook the existing `onTurnEnded`/`onRunFinished` options at `src/daemon/agent.ts:404-407`)
- Test: `test/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `OrchestratorSupervisor.drain` from Task 9; `AgentManagerOptions.onTurnEnded(project, { conversationId, status, changes })`.
- Produces: `OrchestratorSupervisor.turnEnded(project, end: { conversationId: string; status: "completed" | "failed" | "cancelled"; changes: CheckpointChangeItem[] }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator.test.ts
describe("orchestrator loop", () => {
  it("gives the writer the next turn with the messages that arrived", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const roles = supervisor.state(project.id)!.roles;
    const programmer = roles[0]!.conversationId!;
    const critic = roles[1]!.conversationId!;
    prompts.length = 0;

    await supervisor.deliver(project.id, critic, "programmer", "The jump feels floaty.");
    await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [{ path: "src/player.ts" }] });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.conversationId).toBe(programmer);
    expect(prompts[0]!.text).toContain("Critic: The jump feels floaty.");
  });

  it("stops advancing once the goal is complete", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const programmer = supervisor.state(project.id)!.roles[0]!.conversationId!;
    await supervisor.completeGoal(project.id, programmer, "done");
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
    expect(prompts).toHaveLength(0);
  });

  it("does not advance after a cancelled turn", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const programmer = supervisor.state(project.id)!.roles[0]!.conversationId!;
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: programmer, status: "cancelled", changes: [] });
    expect(prompts).toHaveLength(0);
    expect(supervisor.state(project.id)!.roles[0]!.status).toBe("idle");
  });

  it("ignores a turn from a conversation that is not on the team", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: "unrelated", status: "completed", changes: [] });
    expect(prompts).toHaveLength(0);
  });

  it("still advances a writer that received no messages", async () => {
    const { supervisor, project, prompts } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const programmer = supervisor.state(project.id)!.roles[0]!.conversationId!;
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Carry on");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — `turnEnded` does not exist.

- [ ] **Step 3: Implement the advance**

`CheckpointChangeItem` comes from `src/shared/contracts.ts:1181` — add it to the existing type import from `../shared/contracts.js` at the top of `src/daemon/orchestrator.ts`. The signature below matches `AgentManagerOptions.onTurnEnded` at `src/daemon/agent.ts:405` exactly, so the handler can be passed straight through.

Add to `OrchestratorSupervisor`:

```ts
  /** Called when a turn closes. The writer carries on unless the run already ended. */
  async turnEnded(project: ProjectState, end: { conversationId: string; status: "completed" | "failed" | "cancelled"; changes: CheckpointChangeItem[] }): Promise<void> {
    const run = this.#runs.get(project.id);
    if (!run || run.state.status !== "running") return;
    const role = run.state.roles.find((item) => item.conversationId === end.conversationId);
    if (!role) return;
    role.status = "idle";
    if (end.changes.length) this.#roundsWithoutWrite = 0;
    if (end.status !== "completed" || this.#goalComplete) {
      this.#publish(project.id, run.state);
      return;
    }
    // Only the writer advances the work. Advisors act when a teammate addresses them.
    if (role.config.capability !== "writer") {
      this.#publish(project.id, run.state);
      return;
    }
    const messages = this.drain(project.id, role.conversationId!);
    const text = messages.length
      ? teammatePrompt(messages)
      : `Carry on with the goal: ${run.state.config.goal}\n\nCheck what is in the project now, do the next thing it needs, and use mark_goal_complete when it is genuinely done.`;
    await this.#promptRole(run, role, text);
  }
```

Declare the counter beside `#pending`:

```ts
  /** Agent-to-agent rounds since a writer last changed a file. Task 12 turns this into a pause. */
  #roundsWithoutWrite = 0;
```

In `src/daemon/app.ts`, add to the `AgentManager` options, beside `isWriterConversation` from Task 7:

```ts
      onTurnEnded: (project, end) => {
        void orchestrator.turnEnded(project, end).catch((cause) => log.error({ err: cause }, "orchestrator advance failed"));
      },
```

If `onTurnEnded` is already used, chain the orchestrator call into the existing handler instead of replacing it — check with `grep -n "onTurnEnded" src/daemon/app.ts`. Use whatever logger the surrounding code uses.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator.test.ts && bun run test -- test/agent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator.ts src/daemon/app.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): continue the writer after each completed turn"
```

---

## Task 12: Ping-pong detection

**Files:**
- Modify: `src/daemon/orchestrator.ts`
- Test: `test/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `#roundsWithoutWrite` from Task 11, `PING_PONG_LIMIT` from Task 5, `OrchestratorDiagnostic` from Task 1.
- Produces: no new public surface — `deliver` starts pausing the run and setting `state.diagnostic` once the limit is passed.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator.test.ts
describe("orchestrator ping-pong detection", () => {
  it("pauses the run after three rounds with nothing written", async () => {
    const { supervisor, project } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const roles = () => supervisor.state(project.id)!.roles;
    const programmer = () => roles()[0]!.conversationId!;
    const critic = () => roles()[1]!.conversationId!;

    for (let round = 1; round <= PING_PONG_LIMIT; round++) {
      await supervisor.deliver(project.id, critic(), "programmer", `Round ${round} from the critic.`);
      await supervisor.turnEnded(project, { conversationId: programmer(), status: "completed", changes: [] });
      expect(supervisor.state(project.id)!.status).toBe("running");
      await supervisor.deliver(project.id, programmer(), "critic", `Round ${round} from the writer.`);
      // The advisor is idle, so this one prompts it; end its turn too.
      await supervisor.turnEnded(project, { conversationId: critic(), status: "completed", changes: [] });
    }

    await supervisor.deliver(project.id, critic(), "programmer", "Once more.");
    const state = supervisor.state(project.id)!;
    expect(state.status).toBe("error");
    expect(state.diagnostic?.code).toBe("ping-pong");
    expect(state.diagnostic?.roleIds.sort()).toEqual(["critic", "programmer"]);
  });

  it("a writer file change resets the count", async () => {
    const { supervisor, project } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const programmer = supervisor.state(project.id)!.roles[0]!.conversationId!;
    const critic = supervisor.state(project.id)!.roles[1]!.conversationId!;
    for (let round = 0; round < PING_PONG_LIMIT; round++) {
      await supervisor.deliver(project.id, critic, "programmer", "note");
      await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [{ path: "src/a.ts" }] });
    }
    await supervisor.deliver(project.id, critic, "programmer", "note");
    expect(supervisor.state(project.id)!.status).toBe("running");
    expect(supervisor.state(project.id)!.diagnostic).toBeUndefined();
  });

  it("starting again clears the diagnostic", async () => {
    const { supervisor, project } = harness([writer, advisor]);
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const programmer = supervisor.state(project.id)!.roles[0]!.conversationId!;
    const critic = supervisor.state(project.id)!.roles[1]!.conversationId!;
    for (let round = 0; round <= PING_PONG_LIMIT; round++) {
      await supervisor.deliver(project.id, critic, "programmer", "note");
      await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
    }
    await supervisor.stop(project.id);
    const state = await supervisor.start(project);
    expect(state.diagnostic).toBeUndefined();
    expect(state.status).toBe("running");
  });
});
```

Import `PING_PONG_LIMIT` from `../src/daemon/orchestrator.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — the run keeps going forever.

- [ ] **Step 3: Implement the guard**

In `deliver`, immediately before the `if (to.status === "running")` branch from Task 9:

```ts
    // Two roles replying to each other without anything being written is a fault, not progress.
    if (++this.#roundsWithoutWrite > PING_PONG_LIMIT) {
      run.state = {
        ...run.state,
        status: "error",
        diagnostic: {
          code: "ping-pong",
          roleIds: [from.config.id, to.config.id].sort(),
          message: `${from.config.name} and ${to.config.name} exchanged ${this.#roundsWithoutWrite} messages without any file changing. The run paused; start it again once the goal or the roles are clearer.`,
        },
      };
      this.#publish(projectId, run.state);
      throw new Error(`The run paused: ${from.config.name} and ${to.config.name} are messaging each other without progress.`);
    }
```

Both counters are already reset in `start` (Task 5), and `turnEnded` already zeroes `#roundsWithoutWrite` when `end.changes.length` is truthy (Task 11). Nothing else to add.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: PASS — all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator.ts test/orchestrator.test.ts
git commit -m "fix(orchestrator): pause a run whose roles only message each other"
```

---

## Task 13: Survive a daemon restart

**Files:**
- Modify: `src/daemon/orchestrator.ts`, `src/daemon/app.ts` (call `load` per project on startup)
- Test: `test/orchestrator.test.ts` (extend)

**Interfaces:**
- Consumes: `loadOrchestratorConfig` from Task 4, `load` from Task 5.
- Produces: `OrchestratorSupervisor.loadAll(projects: ProjectState[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// appended to test/orchestrator.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("orchestrator restart", () => {
  it("rebuilds a stopped run from the saved roster", async () => {
    const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-restart-"));
    const saved = {
      version: 1, goal: "Make it playable", updatedAt: new Date(0).toISOString(),
      roles: [{ id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } }],
    };
    await writeFile(path.join(storagePath, "orchestrator.json"), JSON.stringify(saved), "utf8");
    const project = { id: "project-9", name: "Project", type: "general" as const, updatedAt: new Date(0).toISOString(), workspacePath: path.join(storagePath, "workspace"), storagePath, preview: { status: "waiting" as const } };

    const supervisor = new OrchestratorSupervisor({ ...minimalDeps() });
    await supervisor.loadAll([project]);
    const state = supervisor.state("project-9")!;
    expect(state.status).toBe("stopped");
    expect(state.config.goal).toBe("Make it playable");
    expect(state.roles).toHaveLength(1);
    // Nothing is running, so the writer conversation is writable by default again.
    expect(supervisor.isWriterConversation("project-9", "anything")).toBe(true);
  });

  it("leaves a project with no team alone", async () => {
    const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-empty-"));
    const project = { id: "project-8", name: "Project", type: "general" as const, updatedAt: new Date(0).toISOString(), workspacePath: storagePath, storagePath, preview: { status: "waiting" as const } };
    const supervisor = new OrchestratorSupervisor({ ...minimalDeps() });
    await supervisor.loadAll([project]);
    expect(supervisor.state("project-8")).toBeUndefined();
  });

  it("keeps an unreadable store and reports it rather than replacing it", async () => {
    const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-bad-"));
    await writeFile(path.join(storagePath, "orchestrator.json"), JSON.stringify({ version: 99, goal: "future", roles: [], updatedAt: new Date(0).toISOString() }), "utf8");
    const project = { id: "project-7", name: "Project", type: "general" as const, updatedAt: new Date(0).toISOString(), workspacePath: storagePath, storagePath, preview: { status: "waiting" as const } };
    const supervisor = new OrchestratorSupervisor({ ...minimalDeps() });
    await supervisor.loadAll([project]);
    expect(supervisor.state("project-7")?.status).toBe("error");
    expect(supervisor.state("project-7")?.diagnostic?.message).toContain("newer OhMyGame");
  });
});
```

Add a `minimalDeps()` helper returning an `OrchestratorDeps` whose `events.publish` records nothing and whose other members are no-ops, so these cases do not need the full harness.

The third case needs a diagnostic that is not `code: "ping-pong"`. Widen the type in `src/shared/orchestrator.ts`:

```ts
export interface OrchestratorDiagnostic {
  code: "ping-pong" | "store-unreadable";
  message: string;
  roleIds: string[];
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator.test.ts`
Expected: FAIL — `loadAll` does not exist.

- [ ] **Step 3: Implement it**

```ts
  /** Rebuilds every project's roster at startup. A run that was going is stopped, not resumed. */
  async loadAll(projects: readonly ProjectState[]): Promise<void> {
    for (const project of projects) {
      try {
        await this.load(project);
      } catch (cause) {
        if (!(cause instanceof OrchestratorStoreUnreadableError)) throw cause;
        // The file stays as it is. The team shows why it cannot load instead of looking empty.
        const config = await loadOrchestratorConfig(project).catch(() => undefined);
        this.#runs.set(project.id, {
          project,
          state: {
            config: config ?? { version: ORCHESTRATOR_STORE_VERSION, goal: "", roles: [], updatedAt: this.deps.now() },
            status: "error",
            roles: [],
            diagnostic: { code: "store-unreadable", message: cause.message, roleIds: [] },
          },
        });
      }
    }
  }
```

Import `OrchestratorStoreUnreadableError` and `ORCHESTRATOR_STORE_VERSION`.

In `src/daemon/app.ts`, call it once the project list is available at startup — find where other per-project managers are warmed with `grep -n "scheduledMessages.load\|await projects.list" src/daemon/app.ts` and add beside it:

```ts
  await orchestrator.loadAll(projects.list());
```

Match the real `ProjectManager` list method name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/orchestrator.test.ts && bun run test -- test/orchestrator-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/orchestrator.ts src/shared/orchestrator.ts src/daemon/app.ts test/orchestrator.test.ts
git commit -m "feat(orchestrator): rebuild teams when the daemon starts"
```

---

# Phase 5 — Interface

## Task 14: Renderer client

**Files:**
- Modify: `src/renderer/api.ts`
- Test: `test/renderer-api.test.ts` if it exists (`ls test | grep -i api`); otherwise covered by Task 15's component test.

**Interfaces:**
- Consumes: `OrchestratorState`, `OrchestratorConfig` from Task 1; the four routes from Task 6.
- Produces:
  - `getOrchestrator(projectId: string): Promise<OrchestratorState | undefined>`
  - `saveOrchestrator(projectId: string, config: { goal: string; roles: OrchestratorRoleConfig[] }): Promise<OrchestratorState>`
  - `startOrchestrator(projectId: string): Promise<OrchestratorState>`
  - `stopOrchestrator(projectId: string): Promise<OrchestratorState>`
  - `removeOrchestrator(projectId: string): Promise<void>`

- [ ] **Step 1: Write the five functions**

`src/renderer/api.ts` already has the only helper needed: `export async function request<T>(path, init): Promise<T>` (`:1517`). It sets the auth and content-type headers, tracks the workspace version, parses the JSON body, and **throws `ApiError` when the response is not ok** (`:1534`, `:1537`). `ApiError` carries `.status`. So there is no `response.ok` to check and no `apiError` helper to call — do not add either.

```ts
export async function getOrchestrator(projectId: string): Promise<OrchestratorState | undefined> {
  try {
    return await request<OrchestratorState>(`/projects/${projectId}/orchestrator`);
  } catch (cause) {
    // No team yet is a normal state, not a failure.
    if (cause instanceof ApiError && cause.status === 404) return undefined;
    throw cause;
  }
}

export function saveOrchestrator(projectId: string, config: { goal: string; roles: OrchestratorRoleConfig[] }): Promise<OrchestratorState> {
  return request<OrchestratorState>(`/projects/${projectId}/orchestrator`, { method: "PUT", body: JSON.stringify(config) });
}

export function startOrchestrator(projectId: string): Promise<OrchestratorState> {
  return request<OrchestratorState>(`/projects/${projectId}/orchestrator/start`, { method: "POST" });
}

export function stopOrchestrator(projectId: string): Promise<OrchestratorState> {
  return request<OrchestratorState>(`/projects/${projectId}/orchestrator/stop`, { method: "POST" });
}

export function removeOrchestrator(projectId: string): Promise<void> {
  return request<void>(`/projects/${projectId}/orchestrator`, { method: "DELETE" });
}
```

Import `OrchestratorState` and `OrchestratorRoleConfig` from `../shared/orchestrator.js`. `ApiError` is already exported from this file at `:1501`, so reference it directly.

- [ ] **Step 2: Handle the two events in the reducer**

In `src/renderer/state.ts`, beside the `item.updated` and `agent.completed` cases (`:177-206`), add cases for `"orchestrator.state"` (replace the stored state wholesale) and `"orchestrator.message"` (append to a per-project message list so the timeline can show it even before the target conversation records it). Follow the existing `dispatch({ type: "runtime-event", event })` shape from `src/renderer/project-shell.tsx:487-495`.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/api.ts src/renderer/state.ts
git commit -m "feat(orchestrator): read and drive the team from the renderer"
```

---

## Task 15: Team panel and merged timeline

**Files:**
- Create: `src/renderer/orchestrator-panel.tsx`, `src/renderer/orchestrator-timeline.tsx`
- Modify: `src/renderer/project-shell.tsx` (mount beside the conversation list; `AgentTimeline` is mounted at `:1649` and `:1711`, the `Composer` at `:1503`)
- Test: `test/orchestrator-panel.test.tsx`

**Interfaces:**
- Consumes: the four client functions from Task 14, `OrchestratorState`, `AgentTimeline` from `src/renderer/agent-timeline.tsx:87`.
- Produces: `<OrchestratorPanel projectId state onState />` and `<OrchestratorTimeline projectId roles />`.

- [ ] **Step 1: Write the failing test**

Match the existing component-test setup — find one with `grep -rln "render(" test/*.tsx | head -3` and copy its imports and test-library helpers.

```tsx
// test/orchestrator-panel.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrchestratorPanel } from "../src/renderer/orchestrator-panel.js";
import type { OrchestratorState } from "../src/shared/orchestrator.js";

const running: OrchestratorState = {
  config: {
    version: 1, goal: "Make the night level playable", updatedAt: new Date(0).toISOString(),
    roles: [
      { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } },
      { id: "critic", name: "Critic", persona: "Judge the feel.", capability: "advisor", model: { provider: "pi", id: "test" } },
    ],
  },
  status: "running",
  roles: [
    { config: { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } }, conversationId: "c1", status: "running" },
    { config: { id: "critic", name: "Critic", persona: "Judge the feel.", capability: "advisor", model: { provider: "pi", id: "test" } }, conversationId: "c2", status: "idle" },
  ],
};

describe("OrchestratorPanel", () => {
  it("shows the goal and every role with its capability and status", () => {
    render(<OrchestratorPanel projectId="p1" state={running} onState={() => {}} />);
    expect(screen.getByText("Make the night level playable")).toBeTruthy();
    expect(screen.getByText("Programmer")).toBeTruthy();
    expect(screen.getByText("Critic")).toBeTruthy();
    expect(screen.getAllByText(/writer|writes files/i)).toHaveLength(1);
  });

  it("always offers a stop control while running", () => {
    const onState = vi.fn();
    render(<OrchestratorPanel projectId="p1" state={running} onState={onState} />);
    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
  });

  it("shows why a paused run stopped", () => {
    render(<OrchestratorPanel projectId="p1" state={{ ...running, status: "error", diagnostic: { code: "ping-pong", message: "Programmer and Critic are only talking.", roleIds: ["programmer", "critic"] } }} onState={() => {}} />);
    expect(screen.getByText(/only talking/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- test/orchestrator-panel.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Write the components**

`OrchestratorPanel` renders: the goal text; one row per role with its `name`, a capability badge, and a status dot driven by `role.status`; the `diagnostic.message` in a danger-styled block when present; and a single control that calls `stopOrchestrator` while `status === "running"` or `startOrchestrator` otherwise, then `onState(next)`. Roster editing is a separate concern: render the goal and roles read-only in this task, and add editing only if the reviewer asks — the routes already accept a `PUT`.

`OrchestratorTimeline` takes the roles, reads each role's `conversationId`, and renders one `AgentTimeline` per role under a heading with the role's name, in roster order. Do not build a new item renderer: reuse `AgentTimeline` (`src/renderer/agent-timeline.tsx:87`) so thread items keep one implementation. The existing project event subscription already carries `conversationId` (`src/shared/contracts.ts:1479-1489`), so `src/renderer/project-shell.tsx:487-495` needs no second stream.

Mount both in `src/renderer/project-shell.tsx`: the panel beside the conversation list, and the timeline in place of the single `AgentTimeline` when the project has a running team.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- test/orchestrator-panel.test.tsx && bun run lint && bun run typecheck`
Expected: PASS, lint clean.

- [ ] **Step 5: Verify in the running app**

Run: `bun run dev:desktop`
Configure a two-role team on a scratch project — one writer, one advisor — start it, and confirm in the window: both roles appear, the advisor's turn overlaps the writer's, agent-to-agent messages show the author's name, and the stop control ends the run. Record what was checked in the PR description; a component test cannot prove the live overlap.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/orchestrator-panel.tsx src/renderer/orchestrator-timeline.tsx src/renderer/project-shell.tsx test/orchestrator-panel.test.tsx
git commit -m "feat(orchestrator): show the team and its conversation in one place"
```

---

## Task 16: Strings and documentation

**Files:**
- Modify: `src/renderer/locales/en.ts`, `src/renderer/locales/zh-CN.ts`, `docs/README.md`
- Create: `docs/orchestrator.md`

**Interfaces:**
- Consumes: the string keys Task 15 introduced.
- Produces: nothing consumed by code.

- [ ] **Step 1: Add every key Task 15 used to `en.ts`**

At minimum: panel title, goal label, capability badges for `writer` and `advisor`, the four status words, start, stop, the ping-pong explanation, and the empty state for a project with no team. Keep the copy plain and say what happens, not what the button is called.

- [ ] **Step 2: Add the same keys to `zh-CN.ts`**

Same keys, same order, translated. `agents.md` requires both in one PR. Text that is sent to the model stays English — that text lives in `src/daemon/orchestrator.ts` and `src/daemon/agent-prompts.ts`, not in the locale files.

- [ ] **Step 3: Verify neither file is missing a key**

Run: `bun run typecheck && bun run lint && bun run test -- test/locales.test.ts`
Expected: PASS. If `test/locales.test.ts` does not exist, find the locale parity check with `ls test | grep -i local` and run that instead; if there is none, compare the two key sets by hand and say so in the PR.

- [ ] **Step 4: Write `docs/orchestrator.md`**

Cover: what a role is; the writer/advisor rule and why only one writer runs at a time; the three tools and who gets them; how a run advances and ends; what ping-pong pausing means and how to clear it; that a run does not resume itself after a restart; where `orchestrator.json` lives. Follow the tone and length of a comparable existing doc such as `docs/checkpoints.md`, and add it to the module table in `docs/README.md`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/locales/en.ts src/renderer/locales/zh-CN.ts docs/orchestrator.md docs/README.md
git commit -m "docs(orchestrator): document teams in both interface languages"
```

---

## Final verification

Run before opening the PR:

```bash
bun run lint
bun run typecheck
bun run test
bun run changelog:check
```

All four must pass. On Windows the suite may need sharding: `bun run test -- --shard=1/2 --config=vitest.windows.config.ts` and `2/2` (`CONTRIBUTING.md:161`).

Then confirm the two invariants that this feature could silently break:

1. A project with no team behaves exactly as before — one turn at a time, no team tools visible. `test/orchestrator-concurrency.test.ts` and `test/orchestrator-tools.test.ts` both assert this; `test/agent.test.ts` and `test/agent-tools.test.ts` are the wider regression gate.
2. Nothing spent tokens. No test in this plan may reach a real model. If any test needs a network, it is wrong.
