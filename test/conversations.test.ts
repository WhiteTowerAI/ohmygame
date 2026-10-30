import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { latestNativeSession } from "../src/daemon/agent-runtimes/native-session.js";
import { ConversationImageStore } from "../src/daemon/conversation-images.js";
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

    conversations.setInitialTitle(project, created.summary.id, "  Build   a game  ");

    expect((await conversations.get(project, created.summary.id))?.summary.title).toBe("Build a game");
    expect(conversations.open(project, created).getSessionName()).toBe("Build a game");
  });

  it("does not replace a manually renamed pending title", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);
    await conversations.rename(project, created.summary.id, "New conversation");

    conversations.setInitialTitle(project, created.summary.id, "Build a game");

    expect((await conversations.get(project, created.summary.id))?.summary.title).toBe("New conversation");
  });

  it("persists the title with the first completed Pi turn", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);
    conversations.setInitialTitle(project, created.summary.id, "Build a platform game");
    appendCompletedTurn(conversations.open(project, created), "Build a platform game", "Done");

    const listed = await new ConversationManager().list(project);

    expect(listed[0]?.title).toBe("Build a platform game");
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

  it("branches only through the selected response without changing the source or sharing native context", async () => {
    const project = await createProject();
    const conversations = new ConversationManager(new ConversationImageStore(path.join(path.dirname(project.workspacePath), "image-cache")));
    const created = await conversations.create(project, { provider: "claude-code-cli", id: "sonnet" });
    const session = conversations.open(project, created);
    session.appendCustomEntry("fixture-settings", { choice: "work" });
    const plan = { steps: [{ step: "Explore movement", status: "in_progress" as const }] };
    session.appendCustomEntry("ohmygame-plan", { mode: "planning", plan });
    session.appendCustomEntry("ohmygame-native-session", { version: 2, runtime: "claude-code-cli", state: "ready", sessionId: "old-thread", profileId: "work" });
    appendCompletedTurn(session, "First question", "First answer", "aW1hZ2U=");
    const target = session.getBranch().at(-1)!.id;
    appendCompletedTurn(session, "Later question", "Later answer");
    await conversations.view(project, created); // UI projection strips inline image payloads.
    await conversations.rename(project, created.summary.id, "x".repeat(80));
    const source = (await conversations.get(project, created.summary.id))!;
    const before = await readFile(created.sessionPath, "utf8");
    const branched = await conversations.branch(project, source, target);
    expect(branched.summary.title).toHaveLength(80);
    expect(branched.summary.title.endsWith(" (branch)")).toBe(true);
    expect(branched.summary.id).not.toBe(created.summary.id);
    expect(branched.summary.messageCount).toBe(2);
    expect(branched.summary.updatedAt >= branched.summary.createdAt).toBe(true);
    expect(await readFile(created.sessionPath, "utf8")).toBe(before);
    expect(await conversations.model(project, branched)).toEqual({ provider: "claude-code-cli", id: "sonnet" });
    const branch = conversations.open(project, branched);
    expect(JSON.stringify(branch.getBranch())).toContain("aW1hZ2U=");
    expect(branch.getBranch().find((entry) => entry.type === "custom" && entry.customType === "fixture-settings")).toMatchObject({ data: { choice: "work" } });
    expect(branch.getHeader()?.parentSession).toBe(created.sessionPath);
    expect(branch.getBranch().filter((entry) => entry.type === "message")).toHaveLength(2);
    expect(JSON.stringify(branch.getBranch())).not.toContain("Later question");
    for (const runtime of ["claude-code-cli", "codex-cli", "opencode-cli"] as const) {
      expect(latestNativeSession(branch.getBranch(), runtime)).toBeUndefined();
    }
    expect(await conversations.planState(project, source)).toEqual({ mode: "awaiting_approval", plan });
    expect(await conversations.planState(project, branched)).toEqual({ mode: "normal" });
    appendCompletedTurn(branch, "Independent question", "Independent answer");
    expect(await readFile(created.sessionPath, "utf8")).toBe(before);
    expect((await conversations.list(project)).map((chat) => chat.id)).toContain(branched.summary.id);
  });

  it("rejects missing, user, unfinished and abandoned branch points", async () => {
    const project = await createProject();
    const conversations = new ConversationManager();
    const created = await conversations.create(project);
    const session = conversations.open(project, created);
    appendCompletedTurn(session, "First", "Answer");
    const user = session.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
    const abandoned = session.getLeafId()!;
    for (const id of ["missing", user.id]) await expect(conversations.branch(project, created, id)).rejects.toThrow("completed agent response");
    session.branch(user.id);
    appendCompletedTurn(session, "Replacement", "New answer");
    await expect(conversations.branch(project, created, abandoned)).rejects.toThrow("completed agent response");
    const failed = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Failed" }], stopReason: "error", timestamp: Date.now() } as never);
    await expect(conversations.branch(project, created, failed)).rejects.toThrow("completed agent response");
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

    conversations.open(project, created).appendCustomEntry("ohmygame-plan", { mode: "planning", plan });

    expect(await conversations.planState(project, created)).toEqual({ mode: "awaiting_approval", plan });
  });

  it("retains independent runtime selections and defaults an unselected runtime to system", async () => {
    const project = await createProject(), conversations = new ConversationManager();
    const chat = await conversations.create(project);
    expect(await conversations.accountProfileId(project, chat, "claude-code-cli")).toBe("system");
    conversations.setAccountProfile(project, chat, "claude-code-cli", "work");
    conversations.setAccountProfile(project, chat, "codex-cli", "work");
    conversations.setAccountProfile(project, chat, "claude-code-cli", "personal");
    expect(await conversations.accountProfiles(project, chat)).toEqual({"claude-code-cli":"personal","codex-cli":"work"});
  });

  it("falls back from deleted accounts after restart and when restoring an old branch", async () => {
    const project = await createProject();
    let removed = false;
    const resolve = (_runtime: unknown, id: string) => removed && id === "work" ? "system" : id;
    const conversations = new ConversationManager(undefined, resolve);
    const chat = await conversations.create(project);
    const manager = conversations.open(project, chat);
    appendCompletedTurn(manager, "Hello", "Shared history");
    conversations.setAccountProfile(project, chat, "codex-cli", "work");
    manager.appendCustomEntry("ohmygame-native-session", { version: 2, runtime: "codex-cli", profileId: "work", state: "ready", sessionId: "work-thread" });
    const oldLeaf = manager.getLeafId()!;
    expect(latestNativeSession(manager.getBranch(), "codex-cli", "work")?.sessionId).toBe("work-thread");
    removed = true;
    const reopened = new ConversationManager(undefined, resolve);
    const stored = (await reopened.get(project, chat.summary.id))!;
    const restored = reopened.open(project, stored);
    const entries = restored.getBranch().length;
    expect(await reopened.accountProfileId(project, stored, "codex-cli")).toBe("system");
    // Reading the fallback writes nothing; the deleted account's marker no longer matches.
    expect(restored.getBranch()).toHaveLength(entries);
    expect(latestNativeSession(restored.getBranch(), "codex-cli", "system")).toBeUndefined();
    restored.branch(oldLeaf);
    restored.appendCustomEntry("restored-branch", {});
    expect(await reopened.accountProfileId(project, stored, "codex-cli")).toBe("system");
    expect(latestNativeSession(restored.getBranch(), "codex-cli", "system")).toBeUndefined();
    expect(restored.getBranch().filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("normalizes deterministic fallback titles", () => {
    expect(defaultConversationTitle("   ")).toBe("New conversation");
    expect(defaultConversationTitle("hello\n    world")).toBe("hello world");
    expect(defaultConversationTitle("x".repeat(100))).toBe(`${"x".repeat(77)}...`);
  });
});

async function createProject(): Promise<ProjectState> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-conversations-"));
  return {
    id: path.basename(directory),
    name: "Project",
    type: "web-game",
    updatedAt: new Date(0).toISOString(),
    workspacePath: path.join(directory, "workspace"),
    preview: { status: "waiting" },
  };
}

function sessionDirectory(project: ProjectState): string {
  return path.join(path.dirname(project.workspacePath), "session");
}

function appendCompletedTurn(session: SessionManager, prompt: string, response: string, image?: string): void {
  session.appendMessage({ role: "user", content: image ? [{ type: "text", text: prompt }, { type: "image", mimeType: "image/png", data: image }] : prompt, timestamp: Date.now() } as never);
  session.appendMessage({
    role: "assistant",
    provider: "claude-code-cli",
    model: "sonnet",
    content: [{ type: "text", text: response }],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as never);
}
