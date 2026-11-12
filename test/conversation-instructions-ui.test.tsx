// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationInstructions } from "../src/shared/agent-instructions.js";

let instructions: ConversationInstructions;
const api = {
  getConversationInstructions: vi.fn(async (_projectId: string, _conversationId: string) => instructions),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { ConversationInstructionsDialog } = await import("../src/renderer/conversation-instructions-dialog.js");
const { ConversationMenu } = await import("../src/renderer/conversation-menu.js");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const sectionTitles = () => [...document.querySelectorAll(".conversation-instructions .ui-code-block-head > span")].map((title) => title.textContent);

it("offers the current conversation's instructions from the conversation menu", async () => {
  const onShowInstructions = vi.fn();
  const menu = (currentConversationId?: string) => (
    <ConversationMenu
      conversations={[{ id: "c1", title: "First", createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" } as never]}
      currentConversationId={currentConversationId}
      disabled={false}
      onRename={vi.fn()}
      onSelect={vi.fn()}
      onShowInstructions={onShowInstructions}
    />
  );
  const entry = () => [...document.querySelectorAll<HTMLButtonElement>(".conversation-archive-link")].find((button) => button.textContent === "This conversation's instructions");

  await act(async () => root.render(menu()));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Conversation history"]')!.click());
  expect(entry()).toBeUndefined();

  await act(async () => root.render(menu("c1")));
  await act(async () => entry()!.click());
  expect(onShowInstructions).toHaveBeenCalledOnce();
  expect(entry()).toBeUndefined();
});

it("shows every part of the system prompt and every tool the model last received", async () => {
  instructions = {
    kind: "ohmygame",
    started: true,
    sections: [
      { name: "preamble", text: "You are an expert coding assistant." },
      { name: "addendum", text: "Build browser games.\n\nReply in Chinese." },
      { name: "new_section", text: "Something a later pi adds." },
    ],
    tools: [{ name: "read", description: "Read a file" }],
  };
  await act(async () => root.render(<ConversationInstructionsDialog projectId="p1" conversationId="c1" onClose={vi.fn()} />));
  expect(api.getConversationInstructions).toHaveBeenCalledWith("p1", "c1");
  // OhMyGame's own part opens first; a section the app doesn't know keeps its name.
  expect(sectionTitles()).toEqual(["OhMyGame's instructions"]);
  const triggers = [...document.querySelectorAll<HTMLElement>(".conversation-instructions .ui-collapsible-trigger")];
  expect(triggers.map((trigger) => trigger.textContent)).toEqual([
    expect.stringContaining("The agent's own instructions"),
    expect.stringContaining("OhMyGame's instructions"),
    expect.stringContaining("new_section"),
    expect.stringContaining("1 tool"),
  ]);
  await act(async () => triggers.at(-1)!.click());
  expect(document.querySelector(".conversation-instructions-tools")?.textContent).toBe("readRead a file");
});

it("says what a coding agent is told and when a conversation hasn't started", async () => {
  instructions = { kind: "coding-agent", runtime: "codex-cli", text: "Use OhMyGame's tools." };
  await act(async () => root.render(<ConversationInstructionsDialog projectId="p1" conversationId="c1" onClose={vi.fn()} />));
  expect(document.body.textContent).toContain("A coding agent has its own instructions");
  expect(document.querySelector(".conversation-instructions pre")?.textContent).toBe("Use OhMyGame's tools.");

  instructions = { kind: "ohmygame", started: false, sections: [], tools: [] };
  await act(async () => root.render(<ConversationInstructionsDialog projectId="p1" conversationId="c2" onClose={vi.fn()} />));
  expect(document.body.textContent).toContain("Send the first message to see what the agent is told");
  expect(document.querySelector(".conversation-instructions pre")).toBeNull();
});
