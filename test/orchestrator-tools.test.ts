import { describe, expect, it, vi } from "vitest";
import { activePiToolNames, planningPiToolNames, projectPiToolNames } from "../src/daemon/agent-tools.js";
import { createOrchestratorTools, type OrchestratorToolContext } from "../src/daemon/orchestrator-tools.js";

function context(overrides: Partial<OrchestratorToolContext> = {}): OrchestratorToolContext {
  return {
    projectId: "project-1",
    conversationId: "conversation-1",
    roleId: "critic",
    capability: "advisor",
    roster: () => [
      { id: "programmer", name: "Programmer", capability: "writer", status: "running", persona: "Write the code." },
      { id: "critic", name: "Critic", capability: "advisor", status: "idle", persona: "Judge the feel." },
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

const run = (tool: ReturnType<typeof find>, input: Record<string, unknown>) =>
  tool.execute("call-1", input as never, undefined, undefined, undefined as never);

function text(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe("orchestrator tools", () => {
  it("lists the team with roles and status", async () => {
    const listed = text(await run(find(createOrchestratorTools(context()), "list_agents"), {}));
    expect(listed).toContain("programmer");
    expect(listed).toContain("writer");
    expect(listed).toContain("running");
    expect(listed).toContain("critic (Critic), advisor, idle, this is you");
  });

  it("delivers a message to a named teammate", async () => {
    const deliver = vi.fn(async () => ({ delivered: true, queued: true }));
    const result = await run(find(createOrchestratorTools(context({ deliver })), "send_message_to_agent"), { agent: "programmer", message: "The jump feels floaty." });
    expect(deliver).toHaveBeenCalledWith("project-1", "conversation-1", "programmer", "The jump feels floaty.");
    expect(text(result)).toContain("Queued");
  });

  it("finds a teammate by name, and accepts a long report", async () => {
    const deliver = vi.fn(async () => ({ delivered: true, queued: false }));
    const tool = find(createOrchestratorTools(context({ deliver })), "send_message_to_agent");
    await run(tool, { agent: "Programmer", message: "x".repeat(12_000) });
    expect(deliver).toHaveBeenCalledWith("project-1", "conversation-1", "programmer", "x".repeat(12_000));
    expect(JSON.stringify(tool.parameters)).toContain("16000");
  });

  it("refuses an unknown teammate, naming the real ones, and the sender itself", async () => {
    const tool = find(createOrchestratorTools(context()), "send_message_to_agent");
    await expect(run(tool, { agent: "lead-programmer", message: "hi" })).rejects.toThrow('No agent called "lead-programmer". Your teammates are: programmer (Programmer).');
    await expect(run(tool, { agent: "critic", message: "hi" })).rejects.toThrow("That is you");
  });

  it("gives mark_goal_complete to writers only", () => {
    expect(find(createOrchestratorTools(context({ capability: "writer" })), "mark_goal_complete").name).toBe("mark_goal_complete");
    expect(createOrchestratorTools(context({ capability: "advisor" })).map((tool) => tool.name)).not.toContain("mark_goal_complete");
  });

  it("ends the run when the goal is marked complete", async () => {
    const completeGoal = vi.fn(async () => {});
    await run(find(createOrchestratorTools(context({ capability: "writer", completeGoal })), "mark_goal_complete"), { summary: "The level plays end to end." });
    expect(completeGoal).toHaveBeenCalledWith("project-1", "conversation-1", "The level plays end to end.");
  });
});

const TEAM_TOOLS = ["list_agents", "send_message_to_agent"];

describe("orchestrator tool gating", () => {
  it("hides the team tools from an ordinary conversation", () => {
    expect(activePiToolNames([], [])).not.toContain("send_message_to_agent");
    expect(planningPiToolNames()).not.toContain("list_agents");
  });

  it("gives an orchestrated advisor the messaging tools but nothing that writes", () => {
    const names = projectPiToolNames("planning", [], [], true, true);
    expect(names).toEqual(expect.arrayContaining(TEAM_TOOLS));
    for (const name of ["write", "edit", "bash", "mark_goal_complete"]) expect(names).not.toContain(name);
  });

  it("gives an orchestrated writer the messaging tools and the goal tool", () => {
    expect(projectPiToolNames("normal", [], [], true, true)).toEqual(expect.arrayContaining([...TEAM_TOOLS, "mark_goal_complete", "write", "edit"]));
  });

  it("does not pass registered team tools through as extension tools twice", () => {
    const names = activePiToolNames([], ["list_agents", "send_message_to_agent", "mark_goal_complete"]);
    expect(names).not.toContain("list_agents");
  });

  it("leaves an unorchestrated conversation exactly as it was", () => {
    expect(projectPiToolNames("planning", [], [], true, false)).toEqual(planningPiToolNames());
    expect(projectPiToolNames("normal", [], [], true, false)).toEqual(activePiToolNames([], []));
  });
});
