import { File } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createComposerDraftStore } from "../src/renderer/composer-drafts.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const scope = { projectId: "project-a", conversationId: "chat-a" };
const plugin = { name: "game-helper", displayName: "Game helper", marketplaceId: "local" };

describe("conversation composer drafts", () => {
  it("retains complete drafts across input remounts and isolates projects and conversations", () => {
    const store = createComposerDraftStore(memoryStorage());
    const draft = store.get(scope);
    const file = new File(["draft attachment"], "notes.txt") as unknown as globalThis.File;
    draft.update({ prompt: "  未完成的消息\n下一行  ", attachments: [{ id: "file-1", file, relativePath: "notes.txt" }],
      reference: { text: "selected answer" } });

    expect(store.get(scope).getSnapshot()).toMatchObject({ prompt: "  未完成的消息\n下一行  ", reference: { text: "selected answer" } });
    expect(store.get(scope).getSnapshot().attachments[0]?.file).toBe(file);
    expect(store.get({ ...scope, conversationId: "chat-b" }).getSnapshot().prompt).toBe("");
    expect(store.get({ ...scope, projectId: "project-b" }).getSnapshot().prompt).toBe("");
  });

  it("restores text, capability selections, planning and explicit references after a reload", () => {
    const storage = memoryStorage();
    const draft = createComposerDraftStore(storage).get(scope);
    draft.update({ prompt: "  revise this\n", mentions: [plugin], selectedSkill: "writer", selectedPlugin: plugin,
      planning: true, reference: { text: "the earlier answer" },
      designReference: { references: [{ type: "workspace-file", path: "canvas/documents/design.md" }],
        context: { kind: "design-document", label: "Game design", text: "Reference this document" } },
      attachments: [{ id: "file-1", file: new File(["attachment"], "notes.txt") as unknown as globalThis.File, relativePath: "notes.txt" }],
      submitting: true, focusRequestId: "request-1" });

    const restored = createComposerDraftStore(storage).get(scope).getSnapshot();
    expect(restored).toMatchObject({ prompt: "  revise this\n", mentions: [plugin], selectedSkill: "writer", selectedPlugin: plugin,
      planning: true, reference: draft.getSnapshot().reference, designReference: draft.getSnapshot().designReference });
    expect(restored.attachments).toEqual([]);
    expect(restored.submitting).toBe(false);
    expect(restored.focusRequestId).toBeUndefined();
    expect([...storage.values.values()][0]).not.toContain("attachment");
  });

  it("preserves an initial capability draft without requiring a first keystroke", () => {
    const storage = memoryStorage();
    const initial = { prompt: "$writer @Game helper Build a game", mentions: [plugin] };
    const snapshot = createComposerDraftStore(storage).get(scope, initial).getSnapshot();
    expect(snapshot).toMatchObject({ prompt: "Build a game", selectedSkill: "writer", selectedPlugin: plugin, mentions: [plugin] });
    expect(createComposerDraftStore(storage).get(scope).getSnapshot()).toMatchObject(snapshot);
  });

  it("gives the saved draft priority over a repeated initial prefill", () => {
    const storage = memoryStorage();
    createComposerDraftStore(storage).get(scope).update({ prompt: "my edited text" });
    expect(createComposerDraftStore(storage).get(scope, { prompt: "initial text", mentions: [] }).getSnapshot().prompt).toBe("my edited text");
  });

  it("does not rewrite stored drafts or write empty entries while opening conversations", () => {
    const storage = memoryStorage();
    createComposerDraftStore(storage).get(scope).update({ prompt: "saved draft" });
    const setItem = vi.spyOn(storage, "setItem");
    const removeItem = vi.spyOn(storage, "removeItem");
    const store = createComposerDraftStore(storage);

    expect(store.get(scope).getSnapshot().prompt).toBe("saved draft");
    expect(store.get({ ...scope, conversationId: "empty-chat" }).getSnapshot().prompt).toBe("");
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("notifies inputs without rewriting unchanged persisted content", () => {
    const storage = memoryStorage();
    const session = createComposerDraftStore(storage).get(scope);
    session.update({ prompt: "a draft", mentions: [plugin] });
    const setItem = vi.spyOn(storage, "setItem");
    const removeItem = vi.spyOn(storage, "removeItem");
    const listener = vi.fn();
    session.subscribe(listener);

    session.update({ submitting: true });
    session.update({ submitting: false, focusRequestId: "request-1" });
    session.update({ focusRequestId: undefined });
    session.update({ attachments: [{ id: "file-1", file: new File(["attachment"], "notes.txt") as unknown as globalThis.File, relativePath: "notes.txt" }] });
    session.update({ mentions: [{ ...plugin }] });
    expect(listener).toHaveBeenCalledTimes(5);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();

    session.update({ planning: true, prompt: "changed draft" });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(createComposerDraftStore(storage).get(scope).getSnapshot()).toMatchObject({ prompt: "changed draft", planning: true });
  });

  it("keeps an input without a resolved conversation out of storage", () => {
    const storage = memoryStorage();
    const store = createComposerDraftStore(storage);
    store.get().update({ prompt: "unresolved" });
    expect(storage.length).toBe(0);
    expect(store.get(scope).getSnapshot().prompt).toBe("");
  });

  it("keeps sending status on remount and preserves the draft when a send fails", () => {
    const storage = memoryStorage();
    const store = createComposerDraftStore(storage);
    const session = store.get(scope);
    session.update({ prompt: "retry me", submitting: true });
    expect(store.get(scope).getSnapshot().submitting).toBe(true);
    session.update({ submitting: false });
    expect(createComposerDraftStore(storage).get(scope).getSnapshot().prompt).toBe("retry me");
  });

  it("clears a successful submission in its original conversation after navigating away", () => {
    const storage = memoryStorage();
    const store = createComposerDraftStore(storage);
    const original = store.get(scope);
    original.update({ prompt: "send me", reference: { text: "answer" } });
    const sent = original.getSnapshot();
    original.update({ submitting: true });
    const next = store.get({ ...scope, conversationId: "chat-b" });
    next.update({ prompt: "a different draft" });

    expect(original.clearSubmitted(sent)).toBe(true);
    original.update({ submitting: false });
    expect(store.get(scope).getSnapshot()).toMatchObject({ prompt: "", reference: undefined });
    expect(next.getSnapshot().prompt).toBe("a different draft");
    expect(createComposerDraftStore(storage).get(scope).getSnapshot().prompt).toBe("");
  });

  it("does not erase text or references added while a submission is pending", () => {
    const store = createComposerDraftStore();
    const session = store.get(scope);
    session.update({ prompt: "original" });
    const sent = session.getSnapshot();
    session.insertPrompt("another request");
    const requestId = session.getSnapshot().focusRequestId;
    expect(session.clearSubmitted(sent)).toBe(false);
    expect(session.getSnapshot().prompt).toBe("original\nanother request");
    expect(session.getSnapshot().focusRequestId).toBe(requestId);

    const nextSent = session.getSnapshot();
    session.update({ reference: { text: "newly selected answer" } });
    expect(session.clearSubmitted(nextSent)).toBe(false);
    expect(session.getSnapshot().reference?.text).toBe("newly selected answer");
  });

  it("clears sent content even if the agent changed plan mode during submission", () => {
    const session = createComposerDraftStore().get(scope);
    session.update({ prompt: "make a plan", planning: true });
    const sent = session.getSnapshot();
    session.update({ planning: false, submitting: true });
    expect(session.clearSubmitted(sent)).toBe(true);
    expect(session.getSnapshot().prompt).toBe("");
  });

  it("inserts an editor request once while the input is hidden", () => {
    const store = createComposerDraftStore();
    const session = store.get(scope);
    session.update({ prompt: "my draft" });
    session.insertPrompt("fix the selected node");
    expect(store.get(scope).getSnapshot().prompt).toBe("my draft\nfix the selected node");
  });

  it("clears a pending focus request when its message was successfully submitted", () => {
    const session = createComposerDraftStore().get(scope);
    session.insertPrompt("send before the input can focus");
    const sent = session.getSnapshot();
    session.update({ submitting: true });

    expect(session.clearSubmitted(sent)).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ prompt: "", focusRequestId: undefined });
  });

  it("removes persisted content when the user clears it", () => {
    const storage = memoryStorage();
    const session = createComposerDraftStore(storage).get(scope);
    session.update({ prompt: "a draft" });
    expect(storage.length).toBe(1);
    session.update({ prompt: "" });
    expect(storage.length).toBe(0);
  });

  it("notifies mounted inputs of updates and successful clearing", () => {
    const session = createComposerDraftStore().get(scope);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    session.update({ prompt: "a draft" });
    session.clearSubmitted(session.getSnapshot());
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    session.update({ prompt: "next draft" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("retains memory drafts when browser storage is unavailable or full", () => {
    const storage = memoryStorage();
    storage.getItem = () => { throw new Error("Storage unavailable"); };
    storage.setItem = () => { throw new Error("Quota exceeded"); };
    storage.removeItem = () => { throw new Error("Storage unavailable"); };
    const store = createComposerDraftStore(storage);
    expect(() => store.get(scope).update({ prompt: "keep this in memory" })).not.toThrow();
    expect(store.get(scope).getSnapshot().prompt).toBe("keep this in memory");
  });

  it("ignores corrupt stored drafts and filters malformed capability references", () => {
    const storage = memoryStorage();
    createComposerDraftStore(storage).get(scope).update({ prompt: "a draft" });
    const key = [...storage.values.keys()][0]!;
    for (const value of ["invalid JSON", "null", JSON.stringify({ version: 2, prompt: "wrong version", mentions: [], planning: false })]) {
      storage.setItem(key, value);
      expect(createComposerDraftStore(storage).get(scope).getSnapshot().prompt).toBe("");
    }
    storage.setItem(key, JSON.stringify({ version: 1, prompt: "recover text", mentions: [plugin, null, {}], planning: false,
      selectedPlugin: {}, reference: { text: 1 }, designReference: { references: [null], context: {} } }));
    expect(createComposerDraftStore(storage).get(scope).getSnapshot()).toMatchObject({ prompt: "recover text", mentions: [plugin],
      selectedPlugin: undefined, reference: undefined, designReference: undefined });
  });

  it("cleans all project drafts and prevents pending sends from restoring a deleted project's draft", () => {
    const storage = memoryStorage();
    const store = createComposerDraftStore(storage);
    const session = store.get(scope);
    session.update({ prompt: "a draft", planning: true, submitting: true });
    store.get({ ...scope, conversationId: "chat-b" }).update({ prompt: "another draft" });
    store.get({ ...scope, projectId: "project-ab" }).update({ prompt: "keep other project" });
    // Also remove a stored conversation that has not been opened this run.
    createComposerDraftStore(storage).get({ ...scope, conversationId: "closed-chat" }).update({ prompt: "closed draft" });

    store.deleteProject(scope.projectId);
    session.update({ submitting: false, prompt: "late response" });
    expect(session.getSnapshot().prompt).toBe("");
    expect(storage.length).toBe(1);
    expect(createComposerDraftStore(storage).get(scope).getSnapshot().prompt).toBe("");
    expect(store.get({ ...scope, projectId: "project-ab" }).getSnapshot().prompt).toBe("keep other project");
  });
});
