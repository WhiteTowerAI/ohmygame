import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCanvasTable,
  type CanvasTableDetail,
} from "../src/shared/canvas-table.js";
import type { CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import {
  CanvasTableStorage,
  readTableGenerations,
} from "../src/renderer/canvas-table-storage.js";

let entries: Map<string, string>;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
});

describe("AI table editing", () => {
  const model = { provider: "test", id: "model" };
  it("applies an unchanged snapshot, saves it, and lets one undo restore the original", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    const candidate = { ...base.table, title: "AI equipment" };
    api.generate.mockResolvedValue({
      status: "complete",
      table: candidate,
      model,
      revision: base.revision,
    });
    storage.changeGeneration("items", { instruction: "Balance equipment" });
    await storage.generate("items", model, "high");
    expect(api.generate).toHaveBeenCalledWith("project", "items", {
      instruction: "Balance equipment",
      model,
      reasoningLevel: "high",
      revision: "base",
    });
    expect(storage.sessions.get("items")!.local.title).toBe("AI equipment");
    expect(storage.generations.items!.proposal).toBeUndefined();
    expect(storage.generations.items!.generating).toBe(false);
    storage.history("items", "undo");
    expect(storage.sessions.get("items")!.local).toEqual(base.table);
  });

  it("keeps edits made during generation and requires explicit candidate adoption", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    let finish!: (value: unknown) => void;
    api.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    storage.changeGeneration("items", { instruction: "Add weapons" });
    const pending = storage.generate("items", model);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    storage.update({ ...base.table, title: "My manual edit" });
    const candidate = { ...base.table, title: "AI weapons" };
    finish({ status: "complete", table: candidate, model, revision: "base" });
    await pending;
    expect(storage.sessions.get("items")!.local.title).toBe("My manual edit");
    expect(storage.generations.items!.proposal).toEqual(candidate);
    expect(api.save).not.toHaveBeenCalled();
    await storage.applyGeneration("items");
    expect(storage.sessions.get("items")!.local.title).toBe("AI weapons");
    storage.history("items", "undo");
    expect(storage.sessions.get("items")!.local.title).toBe("My manual edit");
  });

  it("keeps a candidate for review if disk changed before the workspace poll", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    const candidate = { ...base.table, title: "AI weapons" };
    api.generate.mockResolvedValue({
      status: "complete",
      table: candidate,
      model,
      revision: "base",
    });
    api.get.mockResolvedValue({
      table: { ...base.table, title: "External edit" },
      revision: "remote",
    });
    storage.changeGeneration("items", { instruction: "Add weapons" });
    await storage.generate("items", model);
    expect(storage.sessions.get("items")!.local).toEqual(base.table);
    expect(storage.generations.items!.proposal).toEqual(candidate);
    expect(api.save).not.toHaveBeenCalled();
  });

  it("keeps the instruction and original data when generation is incomplete", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    api.generate.mockResolvedValue({
      status: "incomplete",
      error: "Output limit",
      model,
      revision: "base",
    });
    storage.changeGeneration("items", { instruction: "Create items" });
    await storage.generate("items", model);
    expect(storage.generations.items).toMatchObject({
      instruction: "Create items",
      error: "Output limit",
      generating: false,
    });
    expect(storage.sessions.get("items")!.local).toEqual(base.table);
    expect(api.save).not.toHaveBeenCalled();
  });

  it("restores an interrupted AI operation as an editable instruction and valid candidate", () => {
    const proposal = createCanvasTable("AI weapons", "items");
    entries.set(
      "canvas-table-generations:project",
      JSON.stringify({
        items: {
          instruction: "Create weapons",
          model,
          reasoningLevel: "high",
          generating: true,
          proposal,
        },
      }),
    );
    const restored = readTableGenerations("canvas-table-generations:project");
    expect(restored.items).toMatchObject({
      instruction: "Create weapons",
      model,
      reasoningLevel: "high",
      proposal,
      error: expect.stringContaining("interrupted"),
    });
    expect(restored.items!.generating).toBeUndefined();
  });
});
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const base: CanvasTableDetail = {
    table: createCanvasTable("Items", "items"),
    revision: "base",
  };
  const api = {
    create: vi.fn().mockResolvedValue(base),
    generate: vi.fn(),
    get: vi.fn().mockResolvedValue(base),
    save: vi.fn().mockImplementation(async (_id, detail) => ({
      ...detail,
      revision: "saved",
    })),
  };
  const storage = new CanvasTableStorage("project", api);
  return { base, api, storage };
}
const workspace = (detail: CanvasTableDetail): CanvasWorkspaceDetail => ({
  version: 1,
  boards: [],
  documents: [],
  assets: [],
  tables: [
    {
      ...detail.table,
      revision: detail.revision,
      source: "canvas/tables/items.json",
    },
  ],
});

describe("canvas table storage", () => {
  it("recovers unsaved drafts and supports table undo/redo after disk save", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    storage.update({ ...base.table, title: "Weapons" });
    expect(entries.has("canvas-tables:project")).toBe(true);
    const restored = new CanvasTableStorage("project", api);
    await restored.sync(workspace(base));
    expect(restored.sessions.get("items")!.local.title).toBe("Weapons");
    await storage.flush();
    expect(entries.has("canvas-tables:project")).toBe(false);
    storage.history("items", "undo");
    expect(storage.sessions.get("items")!.local.title).toBe("Items");
    storage.history("items", "redo");
    expect(storage.sessions.get("items")!.local.title).toBe("Weapons");
  });
  it("merges a revision conflict with another cell, including edits made while saving", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    const local = structuredClone(base.table),
      remote = structuredClone(base.table);
    local.rows[0]!.cells[local.columns[0]!.id] = "Sword";
    remote.rows[0]!.cells[remote.columns[1]!.id] = "10";
    storage.update(local);
    api.save.mockRejectedValueOnce({ status: 409 });
    api.get.mockResolvedValue({ table: remote, revision: "remote" });
    await storage.flush();
    expect(storage.sessions.get("items")!.local.rows[0]!.cells).toEqual({
      [local.columns[0]!.id]: "Sword",
      [local.columns[1]!.id]: "10",
    });
    expect(api.save.mock.calls[1]![1].revision).toBe("remote");
    storage.history("items", "undo");
    expect(storage.sessions.get("items")!.local.rows[0]!.cells).toEqual({
      [local.columns[1]!.id]: "10",
    });
    storage.history("items", "redo");
    let finish!: (detail: CanvasTableDetail) => void;
    api.save.mockImplementationOnce(
      () =>
        new Promise<CanvasTableDetail>((resolve) => {
          finish = resolve;
        }),
    );
    const before = storage.sessions.get("items")!.local;
    storage.update({ ...before, title: "Weapons" });
    const pending = storage.flush();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    storage.update({
      ...storage.sessions.get("items")!.local,
      title: "Equipment",
    });
    finish({ table: { ...before, title: "Weapons" }, revision: "weapons" });
    await pending;
    expect(api.save.mock.calls.at(-1)![1].table.title).toBe("Equipment");
  });
  it("preserves a same-cell conflict through reload and explicit resolution", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    const local = structuredClone(base.table),
      remote = structuredClone(base.table),
      column = local.columns[0]!.id;
    local.rows[0]!.cells[column] = "Sword";
    remote.rows[0]!.cells[column] = "Shield";
    storage.update(local);
    api.get.mockResolvedValue({ table: remote, revision: "remote" });
    await storage.sync(workspace({ table: remote, revision: "remote" }));
    await expect(storage.flush()).rejects.toThrow("conflict");
    expect(api.save).not.toHaveBeenCalled();
    const restored = new CanvasTableStorage("project", api);
    await restored.sync(workspace({ table: remote, revision: "remote" }));
    expect(
      restored.sessions.get("items")!.conflict?.local.rows[0]!.cells[column],
    ).toBe("Sword");
    restored.resolve("items", "local");
    await restored.flush();
    expect(api.save.mock.calls[0]![1]).toMatchObject({
      revision: "remote",
      table: local,
    });
  });
  it("keeps drafts when resource files or index entries disappear", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    storage.update({ ...base.table, title: "My draft" });
    await storage.sync({
      tables: [],
    });
    expect(storage.sessions.get("items")!.local.title).toBe("My draft");
    await expect(storage.flush()).rejects.toThrow("removed");
    expect(api.save).not.toHaveBeenCalled();
    expect(entries.has("canvas-tables:project")).toBe(true);
  });
  it("discards a poll response overtaken by a successful save", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    storage.update({ ...base.table, title: "Saved draft" });
    let finish!: (detail: CanvasTableDetail) => void;
    api.get.mockImplementationOnce(
      () =>
        new Promise<CanvasTableDetail>((resolve) => {
          finish = resolve;
        }),
    );
    const poll = storage.sync(workspace({ ...base, revision: "old-poll" }));
    await storage.flush();
    finish(base);
    await poll;
    expect(storage.sessions.get("items")!.local.title).toBe("Saved draft");
    expect(storage.sessions.get("items")!.base.revision).toBe("saved");
  });

  it("discards an old poll failure after a newer poll succeeds", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    let fail!: (cause: Error) => void;
    api.get.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const stale = storage.sync(workspace({ ...base, revision: "stale" }));
    const remote = {
      table: { ...base.table, title: "Latest" },
      revision: "latest",
    };
    api.get.mockResolvedValue(remote);
    await storage.sync(workspace(remote));
    fail(new Error("Old request failed"));
    await stale;
    expect(storage.sessions.get("items")!.base.revision).toBe("latest");
    expect(storage.sessions.get("items")!.issue).toBeUndefined();
  });

  it.each(["conflict", "missing", "save-error"])(
    "saves unrelated tables when another table has a %s",
    async (problem) => {
      const { storage, base, api } = fixture();
      const other = {
        table: createCanvasTable("Other", "other"),
        revision: "other-base",
      };
      await storage.sync({
        tables: [...workspace(base).tables!, ...workspace(other).tables!],
      });
      storage.update({ ...base.table, title: "My draft" });
      storage.update({ ...other.table, title: "Other edit" });
      if (problem === "conflict") {
        const remote = {
          table: { ...base.table, title: "External edit" },
          revision: "remote",
        };
        api.get.mockResolvedValue(remote);
        await storage.sync({
          tables: [...workspace(remote).tables!, ...workspace(other).tables!],
        });
      } else if (problem === "missing") {
        await storage.sync(workspace(other));
      } else {
        api.save.mockRejectedValueOnce(new Error("Offline"));
      }
      await expect(storage.flush()).rejects.toThrow();
      expect(
        api.save.mock.calls.some(([, detail]) => detail.table.id === "other"),
      ).toBe(true);
      expect(storage.sessions.get("other")!.base.table.title).toBe(
        "Other edit",
      );
      expect(storage.sessions.get("items")!.local.title).toBe("My draft");
    },
  );

  it("clears redo when a grouped cell edit branches from an undone value", async () => {
    const { storage, base } = fixture();
    await storage.sync(workspace(base));
    storage.update({ ...base.table, title: "First" });
    storage.history("items", "undo");
    storage.update({ ...base.table, title: "Second" }, false);
    storage.history("items", "redo");
    expect(storage.sessions.get("items")!.local.title).toBe("Second");
  });

  it("ignores reordered JSON object keys instead of creating a dirty draft", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    const { title, ...rest } = base.table;
    storage.update({ title, ...rest });
    await storage.flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(storage.sessions.get("items")!.undo).toHaveLength(0);
  });

  it("does not resave a clean table after accepting an external edit", async () => {
    const { storage, base, api } = fixture();
    await storage.sync(workspace(base));
    const remote = {
      table: { ...base.table, title: "External edit" },
      revision: "remote",
    };
    api.get.mockResolvedValue(remote);
    await storage.sync(workspace(remote));
    await storage.flush();
    expect(api.save).not.toHaveBeenCalled();
    expect(entries.has("canvas-tables:project")).toBe(false);
  });
});
