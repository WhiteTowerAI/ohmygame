import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCanvasDocument } from "../src/shared/contracts.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";

const api = {
  getCanvasBoard: vi.fn(), saveCanvasBoard: vi.fn(), generateCanvasMedia: vi.fn(),
  listCanvasJobs: vi.fn(), cancelCanvasJob: vi.fn(),
};
vi.doMock(fileURLToPath(new URL("../src/renderer/canvas-api.ts", import.meta.url)), () => api);
const { createCanvasBoardStorage } = await import("../src/renderer/canvas-board-storage.js");

const recoveryKey = "canvas-board:project:board";
let entries: Map<string, string>;
let browserStorage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetAllMocks();
  entries = new Map();
  browserStorage = {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }),
    removeItem: vi.fn((key: string) => { entries.delete(key); }),
  };
  vi.stubGlobal("localStorage", browserStorage);
  api.saveCanvasBoard.mockImplementation(async (_id, detail) => ({ ...detail, revision: "saved" }));
});
afterEach(() => vi.unstubAllGlobals());

function canvas(): AssetCanvasDocument {
  const value = createAssetCanvasDocument();
  value.nodes = [{ id: "node", type: "text", title: "Original", position: { x: 0, y: 0 }, data: { text: "Rules", instruction: "" } }];
  value.editorLayout.nodes.node = value.nodes[0]!.position;
  return value;
}
function detail(canvas: AssetCanvasDocument, revision = "disk"): CanvasBoardDetail {
  return { board: { ...canvas, id: "board" }, revision };
}
function adapter(onConflict = vi.fn(), flushDocuments = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  return createCanvasBoardStorage({ projectId: "project", boardId: "board", onConflict, flushDocuments });
}

describe("canvas board storage", () => {
  it("keeps a consumed remix fit request cleared when merging unsaved edits", async () => {
    const base = canvas();
    base.editorLayout.fitView = true;
    api.getCanvasBoard.mockResolvedValue(detail(base));
    const storage = adapter();
    const local = structuredClone(await storage.load());
    local.nodes[0]!.title = "Local edit";
    const remote = structuredClone(base);
    delete remote.editorLayout.fitView;
    remote.editorLayout.viewport = { x: 32, y: 64, zoom: 0.3 };
    api.getCanvasBoard.mockResolvedValue(detail(remote, "fitted"));
    const merged = await storage.refresh(local);
    expect(merged?.editorLayout.fitView).toBeUndefined();
    expect(merged?.editorLayout.viewport).toEqual(remote.editorLayout.viewport);
    expect(merged?.nodes[0]!.title).toBe("Local edit");
    expect(merged?.nodes[0]!.position).toEqual(base.nodes[0]!.position);
  });

  it("keeps a conflicting recovery draft through autosave, polling, generation and reload", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My version"; remote.nodes[0]!.title = "Disk version";
    const draft = JSON.stringify({ base, local }); entries.set(recoveryKey, draft);
    api.getCanvasBoard.mockResolvedValue(detail(remote));
    const onConflict = vi.fn(), storage = adapter(onConflict);
    expect(await storage.load()).toEqual(local);
    expect(onConflict).toHaveBeenCalledWith({ local, remote: detail(remote) });
    await expect(storage.save(remote)).rejects.toThrow("Choose a version");
    await expect(storage.refresh(remote)).rejects.toThrow("Choose a version");
    await expect(storage.generate("node")).rejects.toThrow("Choose a version");
    expect(api.saveCanvasBoard).not.toHaveBeenCalled();
    expect(api.generateCanvasMedia).not.toHaveBeenCalled();
    expect(entries.get(recoveryKey)).toBe(draft);
    const afterReload = vi.fn();
    await adapter(afterReload).load();
    expect(afterReload).toHaveBeenCalledWith({ local, remote: detail(remote) });
    expect(entries.get(recoveryKey)).toBe(draft);
  });

  it.each(["save", "refresh"] as const)("preserves unsaved edits when %s detects a disk conflict", async (operation) => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My version"; remote.nodes[0]!.title = "Disk version";
    api.getCanvasBoard.mockResolvedValueOnce(detail(base, "original")).mockResolvedValue(detail(remote));
    api.saveCanvasBoard.mockRejectedValue(Object.assign(new Error("Stale"), { status: 409 }));
    const onConflict = vi.fn(), storage = adapter(onConflict);
    await storage.load();
    await expect(storage[operation](local)).rejects.toThrow("Choose a version");
    expect(onConflict).toHaveBeenCalledWith({ local, remote: detail(remote) });
    expect(JSON.parse(entries.get(recoveryKey)!)).toEqual({ base, local });
    const writeCount = api.saveCanvasBoard.mock.calls.length;
    await expect(storage.save(remote)).rejects.toThrow("Choose a version");
    expect(api.saveCanvasBoard).toHaveBeenCalledTimes(writeCount);
    expect(JSON.parse(entries.get(recoveryKey)!)).toEqual({ base, local });
  });

  it("merges independent recovered edits and clears the draft after disk save", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title"; remote.nodes[0]!.description = "Disk description";
    entries.set(recoveryKey, JSON.stringify({ base, local }));
    api.getCanvasBoard.mockResolvedValue(detail(remote));
    const onConflict = vi.fn(), storage = adapter(onConflict), merged = await storage.load();
    expect(merged.nodes[0]).toMatchObject({ title: "My title", description: "Disk description" });
    await storage.save(merged);
    expect(api.saveCanvasBoard).toHaveBeenCalledWith("project", detail(merged));
    expect(entries.has(recoveryKey)).toBe(false);
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("keeps the rebased recovery draft if a retry fails after an independent disk edit", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title"; remote.nodes[0]!.description = "Disk description";
    api.getCanvasBoard.mockResolvedValueOnce(detail(base, "original")).mockResolvedValue(detail(remote));
    api.saveCanvasBoard.mockRejectedValueOnce(Object.assign(new Error("Stale"), { status: 409 })).mockRejectedValueOnce(new Error("Offline"));
    const storage = adapter(); await storage.load();
    await expect(storage.save(local)).rejects.toThrow("Offline");
    const draft = JSON.parse(entries.get(recoveryKey)!);
    expect(draft.base).toEqual(remote);
    expect(draft.local.nodes[0]).toMatchObject({ title: "My title", description: "Disk description" });
    expect(api.saveCanvasBoard.mock.calls[1]![1].revision).toBe("disk");
    expect((await adapter().load()).nodes[0]).toMatchObject({ title: "My title", description: "Disk description" });
  });

  it("does not report a successful disk save as failed when browser storage is unavailable", async () => {
    const value = canvas(); api.getCanvasBoard.mockResolvedValue(detail(value));
    browserStorage.setItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    browserStorage.removeItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    const storage = adapter(); await storage.load();
    const edited = structuredClone(value); edited.nodes[0]!.title = "Updated";
    await expect(storage.save(edited)).resolves.toEqual(edited);
    expect(api.saveCanvasBoard).toHaveBeenCalledTimes(1);
  });

  it("shares a pending load and waits for it before saving edits", async () => {
    let finish!: (value: CanvasBoardDetail) => void;
    api.getCanvasBoard.mockImplementation(() => new Promise<CanvasBoardDetail>((resolve) => { finish = resolve; }));
    const storage = adapter(), first = storage.load(), second = storage.load();
    expect(first).toBe(second);
    const local = canvas(); local.nodes[0]!.title = "Edited while loading";
    const saving = storage.save(local);
    await Promise.resolve();
    expect(api.saveCanvasBoard).not.toHaveBeenCalled();
    finish(detail(canvas()));
    await Promise.all([first, second]);
    await expect(saving).resolves.toEqual(local);
    expect(api.getCanvasBoard).toHaveBeenCalledTimes(1);
    expect(api.saveCanvasBoard).toHaveBeenCalledWith("project", detail(local));
  });

  it("can reload after an initial read fails during an agent edit", async () => {
    api.getCanvasBoard.mockRejectedValueOnce(new Error("Invalid JSON")).mockResolvedValue(detail(canvas()));
    const storage = adapter();
    await expect(storage.load()).rejects.toThrow("Invalid JSON");
    await expect(storage.load()).resolves.toEqual(canvas());
    const local = canvas(); local.nodes[0]!.title = "Recovered";
    await expect(storage.save(local)).resolves.toEqual(local);
  });

  it("does not rewrite an unchanged board when the editor first opens", async () => {
    api.getCanvasBoard.mockResolvedValue(detail(canvas()));
    const storage = adapter(); await storage.load();
    await storage.save(canvas());
    expect(api.saveCanvasBoard).not.toHaveBeenCalled();
  });

  it("keeps the last valid revision through a temporary sync failure", async () => {
    const base = canvas(), remote = structuredClone(base);
    remote.nodes[0]!.description = "Agent update";
    api.getCanvasBoard.mockResolvedValueOnce(detail(base, "before")).mockRejectedValueOnce(new Error("Invalid JSON")).mockResolvedValue(detail(remote, "after"));
    const storage = adapter(); await storage.load();
    const local = structuredClone(base); local.nodes[0]!.title = "My title";
    await expect(storage.refresh(local)).rejects.toThrow("Invalid JSON");
    const merged = await storage.refresh(local);
    expect(merged!.nodes[0]).toMatchObject({ title: "My title", description: "Agent update" });
    await storage.save(merged!);
    expect(api.saveCanvasBoard.mock.calls[0]![1].revision).toBe("after");
  });

  it("persists edits made after a conflict while retaining the original recovery base", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title"; remote.nodes[0]!.title = "Agent title";
    entries.set(recoveryKey, JSON.stringify({ base, local }));
    api.getCanvasBoard.mockResolvedValue(detail(remote));
    const onConflict = vi.fn(), storage = adapter(onConflict);
    await storage.load();
    local.nodes[0]!.description = "Edited after conflict";
    await expect(storage.save(local)).rejects.toThrow("Choose a version");
    expect(JSON.parse(entries.get(recoveryKey)!)).toEqual({ base, local });
    const afterReload = vi.fn();
    expect(await adapter(afterReload).load()).toEqual(local);
    expect(afterReload).toHaveBeenCalledWith({ local, remote: detail(remote) });
  });

  it("resolves a conflict with the latest local draft in the same storage session", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title"; remote.nodes[0]!.title = "Agent title";
    entries.set(recoveryKey, JSON.stringify({ base, local }));
    api.getCanvasBoard.mockResolvedValue(detail(remote));
    const storage = adapter(); await storage.load();
    local.nodes[0]!.description = "Edited after conflict";
    await expect(storage.resolveConflict("local", local)).resolves.toEqual(local);
    expect(entries.has(recoveryKey)).toBe(false);
    expect(await storage.load()).toEqual(local);
    await expect(storage.save(local)).resolves.toEqual(local);
    expect(api.saveCanvasBoard).toHaveBeenCalledTimes(1);
  });

  it("uses the current disk version without writing the conflicting draft", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title"; remote.nodes[0]!.title = "Agent title";
    entries.set(recoveryKey, JSON.stringify({ base, local }));
    api.getCanvasBoard.mockResolvedValueOnce(detail(remote));
    const storage = adapter(); await storage.load();
    remote.nodes[0]!.description = "Newer agent edit";
    api.getCanvasBoard.mockResolvedValue(detail(remote, "newer"));
    await expect(storage.resolveConflict("remote", local)).resolves.toEqual(remote);
    expect(await storage.load()).toEqual(remote);
    await expect(storage.save(remote)).resolves.toEqual(remote);
    expect(entries.has(recoveryKey)).toBe(false);
    expect(api.saveCanvasBoard).not.toHaveBeenCalled();
  });

  it("keeps recovery data when applying a chosen version fails", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title"; remote.nodes[0]!.title = "Agent title";
    entries.set(recoveryKey, JSON.stringify({ base, local }));
    api.getCanvasBoard.mockResolvedValue(detail(remote));
    const storage = adapter(); await storage.load();
    local.nodes[0]!.description = "Latest draft";
    api.saveCanvasBoard.mockRejectedValueOnce(new Error("Offline"));
    await expect(storage.resolveConflict("local", local)).rejects.toThrow("Offline");
    expect(JSON.parse(entries.get(recoveryKey)!)).toEqual({ base: remote, local });
    await expect(storage.resolveConflict("local", local)).resolves.toEqual(local);
  });

  it("serializes sync with a pending save so revision updates cannot race", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My title";
    remote.nodes[0]!.title = "My title"; remote.nodes[0]!.description = "Agent description";
    api.getCanvasBoard.mockResolvedValueOnce(detail(base, "original")).mockResolvedValue(detail(remote, "newer"));
    let finish!: (value: CanvasBoardDetail) => void;
    api.saveCanvasBoard.mockImplementationOnce(() => new Promise<CanvasBoardDetail>((resolve) => { finish = resolve; }));
    const storage = adapter(); await storage.load();
    const saving = storage.save(local);
    await vi.waitFor(() => expect(api.saveCanvasBoard).toHaveBeenCalledTimes(1));
    const syncing = storage.refresh(local);
    expect(api.getCanvasBoard).toHaveBeenCalledTimes(1);
    finish(detail(local, "saved"));
    await saving;
    expect((await syncing)!.nodes[0]).toMatchObject({ title: "My title", description: "Agent description" });
  });

  it("waits for pending document edits before generating from the saved node", async () => {
    let finish!: () => void;
    const flushDocuments = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    api.generateCanvasMedia.mockResolvedValue({ id: "job" });
    const generation = adapter(vi.fn(), flushDocuments).generate("node");
    expect(flushDocuments).toHaveBeenCalledTimes(1);
    expect(api.generateCanvasMedia).not.toHaveBeenCalled();
    finish(); await expect(generation).resolves.toEqual({ id: "job" });
    expect(api.generateCanvasMedia).toHaveBeenCalledWith("project", "board", "node");
  });

  it("does not generate when linked documents cannot be saved", async () => {
    const flushDocuments = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Document conflict"));
    await expect(adapter(vi.fn(), flushDocuments).generate("node")).rejects.toThrow("Document conflict");
    expect(api.generateCanvasMedia).not.toHaveBeenCalled();
  });
});
