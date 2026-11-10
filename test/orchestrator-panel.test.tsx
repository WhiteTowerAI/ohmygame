// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorPanel } from "../src/renderer/orchestrator-panel.js";
import type { OrchestratorRoleConfig, OrchestratorState } from "../src/shared/orchestrator.js";

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const model = { provider: "pi", id: "test" };
const programmer: OrchestratorRoleConfig = { id: "programmer", name: "Programmer", persona: "Write the code.", capability: "writer", model };
const critic: OrchestratorRoleConfig = { id: "critic", name: "Critic", persona: "Judge the feel.", capability: "advisor", model };

const running: OrchestratorState = {
  config: { version: 1, goal: "Make the night level playable", updatedAt: new Date(0).toISOString(), roles: [programmer, critic] },
  status: "running",
  roles: [
    { config: programmer, conversationId: "c1", status: "running" },
    { config: critic, conversationId: "c2", status: "idle" },
  ],
};

async function show(state: OrchestratorState | undefined, extra: { onOpenConversation?: (id: string) => void; messages?: Array<{ id: number; fromRoleId: string; toRoleId: string; text: string }> } = {}) {
  await act(async () => root.render(
    <OrchestratorPanel projectId="p1" state={state} messages={extra.messages ?? []} defaultModel={model} onState={() => {}} onOpenConversation={extra.onOpenConversation ?? (() => {})} />,
  ));
}

const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent?.trim());

describe("OrchestratorPanel", () => {
  it("shows the goal and every role with its capability and status", async () => {
    await show(running);
    const text = container.textContent ?? "";
    expect(text).toContain("Make the night level playable");
    expect(text).toContain("Programmer");
    expect(text).toContain("Critic");
    expect(container.querySelectorAll(".team-dot-running")).toHaveLength(1);
    expect([...container.querySelectorAll(".ui-badge")].map((badge) => badge.textContent)).toEqual(["Writer", "Advisor"]);
  });

  it("always offers a stop control while running, and no editing", async () => {
    await show(running);
    expect(buttons()).toContain("Stop team");
    expect(buttons()).not.toContain("Edit team");
    expect(buttons()).not.toContain("Disband");
  });

  it("opens a role's conversation", async () => {
    const onOpenConversation = vi.fn();
    await show(running, { onOpenConversation });
    const open = [...container.querySelectorAll("button")].filter((button) => button.textContent === "Open chat");
    await act(async () => open[1]!.click());
    expect(onOpenConversation).toHaveBeenCalledWith("c2");
  });

  it("shows why a paused run stopped", async () => {
    await show({ ...running, status: "error", diagnostic: { code: "ping-pong", message: "Programmer and Critic are only talking.", roleIds: ["critic", "programmer"] } });
    expect(container.textContent).toContain("only talking");
    expect(buttons()).toContain("Start team");
  });

  it("names both ends of a team message", async () => {
    await show(running, { messages: [{ id: 1, fromRoleId: "critic", toRoleId: "programmer", text: "The jump feels floaty." }] });
    expect(container.textContent).toContain("Critic → Programmer");
    expect(container.textContent).toContain("The jump feels floaty.");
  });

  it("starts a project with no team on a writer and an advisor to edit", async () => {
    await show(undefined);
    const names = [...container.querySelectorAll<HTMLInputElement>("input[aria-label='Role name']")].map((input) => input.value);
    expect(names).toEqual(["Programmer", "Critic"]);
    // There is no goal yet, so the team cannot be saved.
    expect(container.querySelector<HTMLButtonElement>("button[title='Add a goal for the team.']")?.disabled).toBe(true);
  });
});
