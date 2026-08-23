import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ConversationManager, defaultConversationTitle } from "../src/daemon/conversations.js";
import type { ProjectState } from "../src/shared/contracts.js";

describe("ConversationManager", () => {
  it("creates and reopens a pending Pi session", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();

    const created = await conversations.create(project);
    const reopened = await conversations.get(project, created.summary.id);

    expect(reopened).toEqual(created);
    expect(await conversations.list(project)).toEqual([created.summary]);
    expect(created.summary).toMatchObject({
      projectId: project.id,
      title: "New conversation",
      messageCount: 0,
    });
  });

  it("discovers existing Pi sessions and derives a title from the first prompt", async () => {
    const project = await createProject();
    const session = SessionManager.create(project.workspacePath, sessionDirectory(project));
    session.appendMessage({ role: "user", content: "Build a tiny platform game", timestamp: Date.now() } as never);
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    } as never);

    const items = await new ConversationManager().list(project);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: session.getSessionId(),
      title: "Build a tiny platform game",
      messageCount: 2,
    });
  });

  it("stores a renamed title in Pi session metadata", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);

    const renamed = await conversations.rename(project, created.summary.id, "  New   title  ");

    expect(renamed?.title).toBe("New title");
    expect((await conversations.get(project, created.summary.id))?.summary.title).toBe("New title");
  });

  it("keeps a first prompt title for a pending session", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);

    conversations.setInitialTitle(project.id, created.summary.id, "  Build   a game  ");

    expect((await conversations.get(project, created.summary.id))?.summary.title).toBe("Build a game");
  });

  it("does not replace a manually renamed pending title", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);
    await conversations.rename(project, created.summary.id, "New conversation");

    conversations.setInitialTitle(project.id, created.summary.id, "Build a game");

    expect((await conversations.get(project, created.summary.id))?.summary.title).toBe("New conversation");
  });

  it("uses persisted Pi metadata after a pending session receives messages", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);
    const session = conversations.open(project, created);
    appendCompletedTurn(session, "Hello", "Hi");

    const persisted = await conversations.get(project, created.summary.id);
    const renamed = await conversations.rename(project, created.summary.id, "Renamed");

    expect(persisted?.summary).toMatchObject({ title: "Hello", messageCount: 2 });
    expect(renamed).toMatchObject({ title: "Renamed", messageCount: 2 });
  });

  it("returns undefined for an unknown session", async () => {
    const project = await createProject();
    await expect(new ConversationManager().get(project, "missing")).resolves.toBeUndefined();
  });

  it("persists plan state and recovers interrupted modes for approval", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);
    const plan = { steps: [{ step: "Inspect files", status: "in_progress" as const }] };

    conversations.open(project, created).appendCustomEntry("open-game-plan", { mode: "planning", plan });

    expect(conversations.planState(project, created)).toEqual({ mode: "awaiting_approval", plan });
  });

  it("normalizes deterministic fallback titles", () => {
    expect(defaultConversationTitle("   ")).toBe("New conversation");
    expect(defaultConversationTitle("hello\n    world")).toBe("hello world");
    expect(defaultConversationTitle("x".repeat(100))).toBe(`${"x".repeat(77)}...`);
  });
});

async function createProject(): Promise<ProjectState> {
  const directory = await mkdtemp(path.join(tmpdir(), "open-game-conversations-"));
  return {
    id: path.basename(directory),
    name: "Project",
    updatedAt: new Date(0).toISOString(),
    workspacePath: path.join(directory, "workspace"),
    preview: { status: "waiting" },
  };
}

function sessionDirectory(project: ProjectState): string {
  return path.join(path.dirname(project.workspacePath), "session");
}

function appendCompletedTurn(session: SessionManager, prompt: string, response: string): void {
  session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() } as never);
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: response }],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as never);
}
