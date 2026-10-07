import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationManager } from "../src/daemon/conversations.js";
import { ConversationImageStore } from "../src/daemon/conversation-images.js";
import { conversationItems } from "../src/daemon/agent.js";
import { RuntimeEventBus } from "../src/shared/events.js";
import type { ProjectState, ThreadItem } from "../src/shared/contracts.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-chat-cache-"));
  directories.push(directory);
  const project: ProjectState = { id: "project", name: "Game", type: "web-game", workspacePath: path.join(directory, "workspace"),
    storagePath: directory, updatedAt: new Date(0).toISOString(), preview: { status: "waiting" } };
  const images = new ConversationImageStore(path.join(directory, "images"));
  const conversations = new ConversationManager(images);
  const stored = await conversations.create(project, { provider: "test", id: "model" }, "medium");
  const session = conversations.open(project, stored);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect" },
    { type: "image", mimeType: "image/png", data: Buffer.from("image content").toString("base64") }], timestamp: 10 } as never);
  session.appendMessage({ role: "assistant", provider: "test", model: "model", content: [{ type: "text", text: "Done" }], timestamp: 20, stopReason: "stop" } as never);
  return { directory, project, images, conversations, stored, session };
}

describe("conversation UI cache", () => {
  it("loads legacy inline images as references without changing the authoritative Pi file", async () => {
    const { project, stored, images, conversations } = await fixture();
    const original = await readFile(stored.sessionPath);
    await conversations.get(project, stored.summary.id);
    const view = await conversations.view(project, stored);
    const items = conversationItems(view.getBranch());
    const user = items.find((item) => item.type === "userMessage")!;
    const image = user.images![0];
    expect(image.data).toBe("");
    expect(JSON.stringify(items)).not.toContain(Buffer.from("image content").toString("base64"));
    expect((await images.read(project.id, image.url!.split("/").at(-1)!))?.data).toEqual(Buffer.from("image content"));
    expect(await readFile(stored.sessionPath)).toEqual(original);
    const reopened = SessionManager.open(stored.sessionPath).buildSessionContext();
    expect(JSON.stringify(reopened.messages)).toContain(Buffer.from("image content").toString("base64"));
    expect(await conversations.model(project, stored)).toEqual({ provider: "test", id: "model" });
    expect(await conversations.reasoningLevel(project, stored)).toBe("medium");
  });

  it("reuses unchanged views and invalidates metadata and branch content after appends and rewrites", async () => {
    const { project, stored, conversations, session } = await fixture();
    const first = await conversations.view(project, stored);
    expect(await conversations.view(project, stored)).toBe(first);
    session.appendModelChange("test", "next");
    session.appendThinkingLevelChange("high");
    session.appendCustomEntry("ohmygame-plan", { mode: "awaiting_approval", plan: { steps: [] } });
    session.appendSessionInfo("Renamed");
    const updated = await conversations.get(project, stored.summary.id);
    expect(updated?.summary).toMatchObject({ title: "Renamed", messageCount: 2 });
    expect(await conversations.view(project, stored)).not.toBe(first);
    expect(await conversations.model(project, stored)).toEqual({ provider: "test", id: "next" });
    expect(await conversations.reasoningLevel(project, stored)).toBe("high");
    expect(await conversations.planState(project, stored)).toEqual({ mode: "awaiting_approval", plan: { steps: [] } });
    const rewritten = (await readFile(stored.sessionPath, "utf8")).replace('"name":"Renamed"', '"name":"Changed"');
    await writeFile(stored.sessionPath, rewritten);
    expect((await conversations.get(project, stored.summary.id))?.summary.title).toBe("Changed");
  });

  it("recovers a partially appended record once it is complete", async () => {
    const { project, stored, conversations } = await fixture();
    await conversations.view(project, stored);
    const entry = JSON.stringify({ type: "session_info", id: "rename", parentId: null, timestamp: new Date().toISOString(), name: "Partial" });
    await appendFile(stored.sessionPath, entry.slice(0, 30));
    await conversations.view(project, stored);
    await appendFile(stored.sessionPath, `${entry.slice(30)}\n`);
    expect((await conversations.get(project, stored.summary.id))?.summary.title).toBe("Partial");
  });

  it("includes records appended while an asynchronous read is yielding", async () => {
    const { project, stored, conversations, images, session } = await fixture();
    vi.spyOn(images, "flush").mockImplementationOnce(async () => {
      session.appendSessionInfo("Finished during read");
    });
    expect((await conversations.get(project, stored.summary.id))?.summary.title).toBe("Finished during read");
  });

  it("invalidates a rewritten prefix even when the previous file boundary is unchanged", async () => {
    const { project, stored, conversations, session } = await fixture();
    session.appendCustomEntry("padding", { text: "x".repeat(512) });
    await conversations.view(project, stored);
    const original = await readFile(stored.sessionPath, "utf8");
    const rewritten = original.replace('"text":"Inspect"', '"text":"Changed"');
    expect(rewritten.slice(-256)).toBe(original.slice(-256));
    await writeFile(stored.sessionPath, rewritten);
    await appendFile(stored.sessionPath, `${JSON.stringify({ type: "session_info", id: "renamed", parentId: null,
      timestamp: new Date().toISOString(), name: "Renamed" })}\n`);
    const entries = (await conversations.view(project, stored)).getEntries();
    const user = conversationItems(entries).find((item) => item.type === "userMessage");
    expect(user).toMatchObject({ text: "Changed" });
  });

  it("retries failed media writes and rebuilds removed media from the authoritative session", async () => {
    const { directory, project, images } = await fixture();
    await writeFile(path.join(directory, "images"), "blocks cache creation");
    const image = { mediaType: "image/png" as const, data: Buffer.from("retry image").toString("base64") };
    const first = images.project(project.id, image);
    await images.flush();
    await rm(path.join(directory, "images"));
    const retried = images.project(project.id, image);
    expect(retried).not.toBe(first);
    const id = retried.url!.split("/").at(-1)!;
    expect((await images.read(project.id, id))?.data).toEqual(Buffer.from("retry image"));
    await images.removeProject(project.id);
    expect(await images.read(project.id, id)).toBeUndefined();
    const rebuilt = images.project(project.id, { ...image });
    expect(rebuilt.url).toBe(retried.url);
    expect((await images.read(project.id, id))?.data).toEqual(Buffer.from("retry image"));
  });

  it("keeps images in context edits out of the UI view", async () => {
    const { project, stored, conversations, session } = await fixture();
    const imageData = Buffer.from("edited image").toString("base64");
    await appendFile(stored.sessionPath, `${JSON.stringify({ type: "context_edit", id: "edit", parentId: session.getLeafId(),
      timestamp: new Date().toISOString(), targetId: session.getLeafId(), replacement: {
        content: [{ type: "image", mimeType: "image/png", data: imageData }],
      } })}\n`);
    expect(JSON.stringify((await conversations.view(project, stored)).getEntries())).not.toContain(imageData);
    expect(await readFile(stored.sessionPath, "utf8")).toContain(imageData);
  });

  it("preserves Pi's first text prompt and user/assistant activity timestamps", async () => {
    const { project, stored, conversations, session } = await fixture();
    const lines = (await readFile(stored.sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const first = lines.find((entry) => entry.type === "message" && entry.message.role === "user");
    first.message.content = first.message.content.filter((block: { type: string }) => block.type === "image");
    await writeFile(stored.sessionPath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await appendFile(stored.sessionPath, `${JSON.stringify({ type: "message", id: "text", parentId: session.getLeafId(),
      timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Build" }, { type: "text", text: "game" }], timestamp: 30 } })}\n`);
    await appendFile(stored.sessionPath, `${JSON.stringify({ type: "message", id: "tool", parentId: "text",
      timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [], timestamp: 999 } })}\n`);
    expect((await conversations.get(project, stored.summary.id))?.summary).toMatchObject({
      title: "Build game", updatedAt: new Date(30).toISOString(), messageCount: 4,
    });
  });

  it("stores only image references in live and retained events, including prompt replay", async () => {
    const { project, images } = await fixture();
    const bus = new RuntimeEventBus(10, (event) => images.event(event));
    const image = { mediaType: "image/png" as const, data: Buffer.from("screenshot").toString("base64") };
    const item: ThreadItem = { id: "capture", turnId: "turn", type: "dynamicToolCall", toolCallId: "capture", tool: "game_use", status: "completed", images: [image] };
    const received: unknown[] = [];
    bus.subscribe(project.id, (event) => received.push(event));
    bus.publish(project.id, "item.completed", { item });
    bus.publish(project.id, "agent.started", { prompt: "Inspect", images: [image] }, undefined, { prompt: "Inspect" });
    expect(JSON.stringify(received)).not.toContain(image.data);
    expect(bus.since(project.id)).toEqual(received);
    expect(bus.since(project.id)[1].data).toMatchObject({ images: [{ data: "", url: expect.any(String) }] });
    expect(item.images?.[0].data).toBe(image.data);
    expect(await images.read("another-project", images.project(project.id, image).url!.split("/").at(-1)!)).toBeUndefined();
    expect(await images.read(project.id, "../session.jsonl")).toBeUndefined();
    await images.flush();
  });
});
