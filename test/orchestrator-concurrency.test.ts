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

/** A protocol adapter that plays a script for each turn, as in test/agent-runtime-session.test.ts. */
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
  id: "project-1",
  name: "Project",
  type: "general",
  updatedAt: new Date(0).toISOString(),
  workspacePath: "/tmp/project-1",
  preview: { status: "waiting" },
};

function conversation(id: string): StoredConversation {
  return {
    sessionPath: `/tmp/${id}.jsonl`,
    summary: {
      id,
      projectId: project.id,
      title: id,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
    },
  };
}

/** One manager, several conversations, and a set naming which of them may write. */
function team(scripts: Script[], writers?: Set<string>) {
  const events = new RuntimeEventBus();
  let manager!: AgentManager;
  manager = new AgentManager(events, {
    createSession: async () =>
      new NativeCodingSession({
        runtime: "claude-code-cli",
        model: "sonnet",
        sessionManager: SessionManager.inMemory("/tmp/project-1"),
        createDriver: () => new ScriptedDriver(scripts),
        snapshotBeforeMessage: async () => "commit",
        requestApproval: (details, toolCallId, signal) => manager.askApproval(project.id, "conversation-1", toolCallId, details, signal),
        toolNames: [],
      }),
    activeToolNames: (_project, mode, session) => projectPiToolNames(mode, [], session.getAllTools?.().map((tool) => tool.name)),
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
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const script: Script = async () => {
    await waiting;
    return { status: "completed" };
  };
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
      await advisor.result;
      expect(manager.isProjectWriteBusy(project.id)).toBe(true);
      finish();
      await run.result;
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
      expect(() => manager.prompt(project, conversation("artist"), "draw it")).toThrow("Wait for the other conversation in this project to finish");
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
      expect(() => manager.prompt(project, conversation("b"), "work")).toThrow("Wait for the other conversation in this project to finish");
      finish();
      await run.result;
    } finally {
      finish();
      await manager.close();
    }
  });
});
