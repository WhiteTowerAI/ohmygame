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
  return createCanvasBoardStorage({ projectId: "project", boardId: "board", revision: 0, onConflict, flushDocuments });
}

describe("canvas board storage", () => {
  it("keeps a conflicting recovery draft through autosave, polling, generation and reload", async () => {
    const base = canvas(), local = structuredClone(base), remote = structuredClone(base);
    local.nodes[0]!.title = "My version"; remote.nodes[0]!.title = "Disk version";
    const draft = JSON.stringify({ base, local }); entries.set(recoveryKey, draft);
    api.getCanvasBoard.mockResolvedValue(detail(remote));
    const onConflict = vi.fn(), storage = adapter(onConflict);
    expect(await storage.load()).toEqual(remote);
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
    await expect(storage.save(value)).resolves.toEqual(value);
    expect(api.saveCanvasBoard).toHaveBeenCalledTimes(1);
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
