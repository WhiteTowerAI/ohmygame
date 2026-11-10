import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rolePersonaInstructions } from "../src/daemon/agent-prompts.js";
import { OrchestratorSupervisor, PING_PONG_LIMIT, type OrchestratorDeps } from "../src/daemon/orchestrator.js";
import { RUNTIME_EVENT_TYPES, type CheckpointChangeItem, type ProjectState, type RuntimeEventData, type ThreadItem } from "../src/shared/contracts.js";
import type { OrchestratorConfig, OrchestratorRoleConfig, OrchestratorState } from "../src/shared/orchestrator.js";

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
      id: "item-1",
      turnId: "turn-1",
      type: "userMessage",
      text: "hello",
      author: { kind: "agent", roleId: "critic", name: "Critic" },
    };
    expect(item.author?.roleId).toBe("critic");
  });
});

const writer: OrchestratorRoleConfig = { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model: { provider: "pi", id: "test" } };
const advisor: OrchestratorRoleConfig = { id: "critic", name: "Critic", persona: "Judge the feel.", capability: "advisor", model: { provider: "pi", id: "test" } };
const changed = [{ path: "src/a.ts" }] as unknown as CheckpointChangeItem[];

function config(roles: OrchestratorRoleConfig[], goal = "Make it playable"): OrchestratorConfig {
  return { version: 1, goal, roles, updatedAt: new Date(0).toISOString() };
}

async function tempProject(id = "project-1"): Promise<ProjectState> {
  const storagePath = await mkdtemp(path.join(tmpdir(), "orchestrator-supervisor-"));
  return { id, name: "Project", type: "general", updatedAt: new Date(0).toISOString(), workspacePath: path.join(storagePath, "workspace"), storagePath, preview: { status: "waiting" } };
}

/** Records what the supervisor asked of the agent layer instead of running it. */
async function harness(options: { refusePrompt?: () => boolean } = {}) {
  const published: Array<{ type: string; data: unknown; conversationId?: string }> = [];
  const prompts: Array<{ conversationId: string; text: string }> = [];
  const created: string[] = [];
  const cancelled: string[] = [];
  const archived: string[] = [];
  const deps: OrchestratorDeps = {
    events: {
      publish: ((_projectId: string, type: string, data: unknown, scope?: { conversationId?: string }) => {
        published.push({ type, data, ...(scope?.conversationId ? { conversationId: scope.conversationId } : {}) });
        return {};
      }) as unknown as OrchestratorDeps["events"]["publish"],
    },
    createConversation: async (_project, title) => {
      created.push(title);
      return `conversation-${created.length}`;
    },
    prompt: async (_project, conversationId, text) => {
      if (options.refusePrompt?.()) throw new Error("Wait for the other conversation in this project to finish");
      prompts.push({ conversationId, text });
      return { turnId: `turn-${prompts.length}` };
    },
    cancel: async (_projectId, conversationId) => {
      cancelled.push(conversationId);
    },
    archiveConversation: async (_project, conversationId) => {
      archived.push(conversationId);
    },
    now: () => new Date(0).toISOString(),
  };
  const project = await tempProject();
  const supervisor = new OrchestratorSupervisor(deps);
  /** Configures and starts a writer-and-advisor team, returning both conversations. */
  const started = async () => {
    await supervisor.configure(project, config([writer, advisor]));
    await supervisor.start(project);
    const roles = supervisor.state(project.id)!.roles;
    return { programmer: roles[0]!.conversationId!, critic: roles[1]!.conversationId! };
  };
  return { supervisor, project, published, prompts, created, cancelled, archived, started };
}

describe("orchestrator supervisor", () => {
  it("creates one conversation per role and starts only the writer", async () => {
    const { supervisor, project, prompts, created } = await harness();
    await supervisor.configure(project, config([writer, advisor]));
    const state = await supervisor.start(project);
    expect(created).toEqual(["Programmer", "Critic"]);
    expect(state.status).toBe("running");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Make it playable");
    expect(state.roles.map((role) => role.status)).toEqual(["running", "idle"]);
  });

  it("refuses a team with no writer, a bad id, or a repeated id", async () => {
    const { supervisor, project } = await harness();
    await expect(supervisor.configure(project, config([advisor]))).rejects.toThrow("write files");
    await expect(supervisor.configure(project, config([{ ...writer, id: "Not A Slug" }]))).rejects.toThrow("not a valid role id");
    await expect(supervisor.configure(project, config([writer, writer]))).rejects.toThrow("both called");
  });

  it("names the writer of a conversation and leaves an ordinary conversation writable", async () => {
    const { supervisor, project, started } = await harness();
    const { programmer, critic } = await started();
    expect(supervisor.isWriterConversation(project.id, programmer)).toBe(true);
    expect(supervisor.isWriterConversation(project.id, critic)).toBe(false);
    expect(supervisor.isWriterConversation(project.id, "some-other-conversation")).toBe(true);
    expect(supervisor.personaFor(project.id, critic)).toBe("Judge the feel.");
  });

  it("stops by cancelling the running turns", async () => {
    const { supervisor, project, started, cancelled } = await harness();
    const { programmer } = await started();
    const state = await supervisor.stop(project.id);
    expect(state?.status).toBe("stopped");
    expect(cancelled).toEqual([programmer]);
    expect(state?.roles.every((role) => role.status === "idle")).toBe(true);
  });

  it("refuses to change a running team", async () => {
    const { supervisor, project, started } = await harness();
    await started();
    await expect(supervisor.configure(project, config([writer], "other"))).rejects.toThrow("Stop the team");
  });

  it("keeps a role's conversation when the team is saved again and restarted", async () => {
    const { supervisor, project, started, created } = await harness();
    const { programmer } = await started();
    await supervisor.stop(project.id);
    await supervisor.configure(project, config([writer], "A new goal"));
    await supervisor.start(project);
    expect(created).toEqual(["Programmer", "Critic"]);
    expect(supervisor.state(project.id)!.roles[0]!.conversationId).toBe(programmer);
  });

  it("stays stopped when the writer cannot start because another conversation is busy", async () => {
    let refuse = false;
    const { supervisor, project } = await harness({ refusePrompt: () => refuse });
    await supervisor.configure(project, config([writer, advisor]));
    refuse = true;
    await expect(supervisor.start(project)).rejects.toThrow("Wait for the other conversation");
    expect(supervisor.state(project.id)!.status).toBe("stopped");
  });

  it("disbands a stopped team by archiving its conversations", async () => {
    const { supervisor, project, started, archived } = await harness();
    const { programmer, critic } = await started();
    await expect(supervisor.remove(project)).rejects.toThrow("Stop the team");
    await supervisor.stop(project.id);
    await supervisor.remove(project);
    expect(archived).toEqual([programmer, critic]);
    expect(await supervisor.loaded(project)).toBeUndefined();
  });
});

describe("role persona", () => {
  it("adds nothing when the conversation has no role", () => {
    expect(rolePersonaInstructions(undefined)).toEqual([]);
  });

  it("states the role and that teammates can be messaged", () => {
    const lines = rolePersonaInstructions("You are the Critic. Judge the feel.").join("\n");
    expect(lines).toContain("You are the Critic.");
    expect(lines).toContain("send_message_to_agent");
  });
});

describe("orchestrator delivery", () => {
  it("prompts an idle teammate straight away", async () => {
    const { supervisor, project, prompts, published, started } = await harness();
    const { programmer, critic } = await started();
    prompts.length = 0;
    const result = await supervisor.deliver(project.id, programmer, "critic", "Does the jump feel right?");
    expect(result).toEqual({ delivered: true, queued: false });
    expect(prompts).toEqual([{ conversationId: critic, text: expect.stringContaining("Programmer: Does the jump feel right?") }]);
    expect(published.find((event) => event.type === "orchestrator.message")).toMatchObject({
      conversationId: critic,
      data: { fromRoleId: "programmer", toRoleId: "critic", text: "Does the jump feel right?" },
    });
  });

  it("holds a message for a teammate that is mid-turn", async () => {
    const { supervisor, project, prompts, started } = await harness();
    const { programmer, critic } = await started();
    prompts.length = 0;
    const result = await supervisor.deliver(project.id, critic, "programmer", "Also the audio.");
    expect(result.queued).toBe(true);
    expect(prompts).toHaveLength(0);
    expect(supervisor.pendingFor(project.id, programmer)).toEqual([{ fromRoleId: "critic", fromName: "Critic", text: "Also the audio." }]);
  });

  it("refuses a role that is not on the team, and a team that is not running", async () => {
    const { supervisor, project, started } = await harness();
    const { critic } = await started();
    await expect(supervisor.deliver(project.id, critic, "nobody", "hi")).rejects.toThrow("nobody");
    await supervisor.stop(project.id);
    await expect(supervisor.deliver(project.id, critic, "programmer", "hi")).rejects.toThrow("not running");
  });

  it("completes the run when a writer marks the goal done", async () => {
    const { supervisor, project, started } = await harness();
    const { programmer } = await started();
    await supervisor.completeGoal(project.id, programmer, "The level plays end to end.");
    expect(supervisor.state(project.id)).toMatchObject({ status: "completed", summary: "The level plays end to end." });
  });

  it("refuses a goal marked by a conversation that is not the writer", async () => {
    const { supervisor, project, started } = await harness();
    const { critic } = await started();
    await expect(supervisor.completeGoal(project.id, critic, "done")).rejects.toThrow("writer");
  });
});

describe("orchestrator loop", () => {
  it("gives the writer the next turn with the messages that arrived", async () => {
    const { supervisor, project, prompts, started } = await harness();
    const { programmer, critic } = await started();
    prompts.length = 0;
    await supervisor.deliver(project.id, critic, "programmer", "The jump feels floaty.");
    await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
    expect(prompts).toEqual([{ conversationId: programmer, text: expect.stringContaining("Critic: The jump feels floaty.") }]);
    expect(supervisor.pendingFor(project.id, programmer)).toEqual([]);
  });

  it("still advances a writer that received no messages", async () => {
    const { supervisor, project, prompts, started } = await harness();
    const { programmer } = await started();
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Carry on");
  });

  it("stops advancing once the goal is complete", async () => {
    const { supervisor, project, prompts, started } = await harness();
    const { programmer } = await started();
    await supervisor.completeGoal(project.id, programmer, "done");
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
    expect(prompts).toHaveLength(0);
    expect(supervisor.state(project.id)!.roles[0]!.status).toBe("idle");
  });

  it("stops the team after the writer's turn is cancelled or fails", async () => {
    const { supervisor, project, prompts, started } = await harness();
    const { programmer } = await started();
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: programmer, status: "cancelled", changes: [] });
    expect(prompts).toHaveLength(0);
    expect(supervisor.state(project.id)!.status).toBe("stopped");
  });

  it("does not advance an advisor, and ignores a conversation not on the team", async () => {
    const { supervisor, project, prompts, started } = await harness();
    const { programmer, critic } = await started();
    await supervisor.deliver(project.id, programmer, "critic", "Look at the jump.");
    prompts.length = 0;
    await supervisor.turnEnded(project, { conversationId: critic, status: "completed", changes: [] });
    await supervisor.turnEnded(project, { conversationId: "unrelated", status: "completed", changes: [] });
    expect(prompts).toHaveLength(0);
    expect(supervisor.state(project.id)!.roles[1]!.status).toBe("idle");
  });
});

describe("orchestrator ping-pong detection", () => {
  it("pauses the run after three rounds with nothing written", async () => {
    const { supervisor, project, started } = await harness();
    const { programmer, critic } = await started();
    for (let round = 1; round <= PING_PONG_LIMIT; round++) {
      await supervisor.deliver(project.id, critic, "programmer", `Round ${round} from the critic.`);
      await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
      expect(supervisor.state(project.id)!.status).toBe("running");
      await supervisor.deliver(project.id, programmer, "critic", `Round ${round} from the writer.`);
      await supervisor.turnEnded(project, { conversationId: critic, status: "completed", changes: [] });
    }
    await expect(supervisor.deliver(project.id, critic, "programmer", "Once more.")).rejects.toThrow("paused");
    const state = supervisor.state(project.id)!;
    expect(state.status).toBe("error");
    expect(state.diagnostic?.code).toBe("ping-pong");
    expect(state.diagnostic?.roleIds).toEqual(["critic", "programmer"]);
  });

  it("a writer file change resets the count", async () => {
    const { supervisor, project, started } = await harness();
    const { programmer, critic } = await started();
    for (let round = 0; round < PING_PONG_LIMIT * 3; round++) {
      await supervisor.deliver(project.id, critic, "programmer", "note");
      await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: changed });
    }
    expect(supervisor.state(project.id)!.status).toBe("running");
    expect(supervisor.state(project.id)!.diagnostic).toBeUndefined();
  });

  it("starting again clears the diagnostic", async () => {
    const { supervisor, project, started } = await harness();
    const { programmer, critic } = await started();
    const exchange = async () => {
      for (let round = 0; round < 100; round++) {
        await supervisor.deliver(project.id, critic, "programmer", "note");
        await supervisor.turnEnded(project, { conversationId: programmer, status: "completed", changes: [] });
      }
    };
    await expect(exchange()).rejects.toThrow("paused");
    const state = await supervisor.start(project);
    expect(state.diagnostic).toBeUndefined();
    expect(state.status).toBe("running");
  });
});

function minimalDeps(): OrchestratorDeps {
  return {
    events: { publish: (() => ({})) as unknown as OrchestratorDeps["events"]["publish"] },
    createConversation: async () => "conversation",
    prompt: async () => ({ turnId: "turn" }),
    cancel: async () => {},
    archiveConversation: async () => {},
    now: () => new Date(0).toISOString(),
  };
}

describe("orchestrator restart", () => {
  it("rebuilds a stopped run from the saved roster, with its conversations", async () => {
    const project = await tempProject("project-9");
    const saved = { ...config([writer, advisor]), conversations: { programmer: "conversation-a", critic: "conversation-b" } };
    await writeFile(path.join(project.storagePath!, "orchestrator.json"), JSON.stringify(saved), "utf8");
    const supervisor = new OrchestratorSupervisor(minimalDeps());
    await supervisor.loadAll([project]);
    const state = supervisor.state("project-9")!;
    expect(state.status).toBe("stopped");
    expect(state.config.goal).toBe("Make it playable");
    expect(state.roles.map((role) => role.conversationId)).toEqual(["conversation-a", "conversation-b"]);
    expect(supervisor.isWriterConversation("project-9", "conversation-b")).toBe(false);
    expect(supervisor.isWriterConversation("project-9", "anything")).toBe(true);
  });

  it("leaves a project with no team alone", async () => {
    const project = await tempProject("project-8");
    const supervisor = new OrchestratorSupervisor(minimalDeps());
    await supervisor.loadAll([project]);
    expect(supervisor.state("project-8")).toBeUndefined();
  });

  it("keeps an unreadable store and reports it rather than replacing it", async () => {
    const project = await tempProject("project-7");
    const future = JSON.stringify({ version: 99, goal: "future", roles: [], updatedAt: new Date(0).toISOString() });
    const file = path.join(project.storagePath!, "orchestrator.json");
    await writeFile(file, future, "utf8");
    const supervisor = new OrchestratorSupervisor(minimalDeps());
    await supervisor.loadAll([project]);
    expect(supervisor.state("project-7")?.status).toBe("error");
    expect(supervisor.state("project-7")?.diagnostic?.message).toContain("newer OhMyGame");
    await expect(supervisor.remove(project)).rejects.toThrow("newer OhMyGame");
    await expect(supervisor.configure(project, config([writer]))).rejects.toThrow("newer OhMyGame");
    expect(await readFile(file, "utf8")).toBe(future);
  });
});
