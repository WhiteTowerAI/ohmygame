import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import {
  CheckpointChangedError,
  CheckpointIncompleteError,
  CheckpointStore,
  checkpointDirectory,
} from "../src/daemon/checkpoints.js";
import {
  DamagedObjectError,
  readCommitTree,
  readTree,
  verifyBlob,
  writeCommit,
  writeObject,
  writeTree,
} from "../src/daemon/checkpoint-objects.js";

const hooks = vi.hoisted(() => ({
  beforeStat: undefined as ((target: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((target: string) => Promise<void>) | undefined,
  afterRename: undefined as ((target: string) => Promise<void>) | undefined,
  beforeRead: undefined as ((target: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (originalImport) => {
  const original = await originalImport<typeof import("node:fs/promises")>();
  const patched = {
    ...original,
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      await hooks.beforeStat?.(String(args[0]));
      return original.lstat(...args);
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      await hooks.beforeRename?.(String(args[1]));
      await original.rename(...args);
      await hooks.afterRename?.(String(args[1]));
    },
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      await hooks.beforeRead?.(String(args[0]));
      return original.readFile(...args);
    },
  };
  return { ...patched, default: patched };
});
const roots: string[] = [];
afterEach(async () => {
  hooks.beforeStat = undefined;
  hooks.beforeRename = undefined;
  hooks.afterRename = undefined;
  hooks.beforeRead = undefined;
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function game() {
  const storagePath = await mkdtemp(
    path.join(tmpdir(), "ohmygame-checkpoint-safety-"),
  );
  roots.push(storagePath);
  const workspacePath = path.join(storagePath, "workspace");
  await mkdir(path.join(workspacePath, "src"), { recursive: true });
  await writeFile(path.join(workspacePath, "src/a.ts"), "one");
  return { workspacePath, storagePath };
}

function objectFile(project: Awaited<ReturnType<typeof game>>, oid: string) {
  return path.join(
    checkpointDirectory(project),
    "objects",
    oid.slice(0, 2),
    oid.slice(2),
  );
}

it("rolls files back when persisting the associated conversation rewind fails", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const target = await store.snapshot(project);
  await writeFile(file, "two");
  const previous = await store.snapshot(project);
  await expect(
    store.restore(project, target, async (undo) => {
      expect(undo).toBe(previous);
      expect(await store.unfinished(project)).toBe(previous);
      expect(await readFile(file, "utf8")).toBe("one");
      throw new Error("conversation I/O failure");
    }),
  ).rejects.toThrow("conversation I/O failure");
  expect(await readFile(file, "utf8")).toBe("two");
  expect(await store.unfinished(project)).toBeUndefined();
});

it("retains the original recovery target when a rewind failure cannot roll files back", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const target = await store.snapshot(project);
  await writeFile(file, "two");
  const previous = await store.snapshot(project);
  await expect(
    store.restore(project, target, async () => {
      hooks.beforeRename = async (destination) => {
        if (destination === file) throw new Error("rollback I/O failure");
      };
      throw new Error("conversation I/O failure");
    }),
  ).rejects.toMatchObject({ previous, found: previous });
  expect(await store.unfinished(project)).toBe(previous);
  await expect(store.restore(project, target)).rejects.toBeInstanceOf(
    CheckpointIncompleteError,
  );
  hooks.beforeRename = undefined;
  await new CheckpointStore().restore(project, previous);
  expect(await readFile(file, "utf8")).toBe("two");
  expect(await store.unfinished(project)).toBeUndefined();
});

it("retains recovery when bookkeeping fails after creating a file", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  await rm(file);
  hooks.afterRename = async (target) => {
    if (target !== file) return;
    hooks.afterRename = undefined;
    hooks.beforeStat = async (target) => {
      if (target !== file) return;
      hooks.beforeStat = undefined;
      throw Object.assign(new Error("post-create I/O failure"), {
        code: "EIO",
      });
    };
  };
  const failed = await store
    .restore(project, original)
    .catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(CheckpointIncompleteError);
  expect(await store.unfinished(project)).toBe(
    (failed as CheckpointIncompleteError).previous,
  );
  await new CheckpointStore().restore(
    project,
    (failed as CheckpointIncompleteError).previous,
  );
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await store.unfinished(project)).toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "rejects a replaced workspace root even when every leaf retains its identity",
  async () => {
    const project = await game();
    const outside = path.join(project.storagePath, "outside");
    const store = new CheckpointStore();
    const original = await store.snapshot(project);
    await writeFile(path.join(project.workspacePath, "src/a.ts"), "two");
    hooks.afterRename = async (target) => {
      if (path.basename(target) !== "ohmygame-stat-cache.json") return;
      hooks.afterRename = undefined;
      await rename(project.workspacePath, outside);
      await symlink(outside, project.workspacePath);
    };
    await expect(store.restore(project, original)).rejects.toBeInstanceOf(
      CheckpointChangedError,
    );
    expect(await readFile(path.join(outside, "src/a.ts"), "utf8")).toBe("two");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects an ancestor swap during a snapshot",
  async () => {
    const project = await game();
    const file = path.join(project.workspacePath, "src/a.ts");
    const outside = path.join(project.storagePath, "outside");
    hooks.beforeStat = async (target) => {
      if (target !== file) return;
      hooks.beforeStat = undefined;
      await rename(path.join(project.workspacePath, "src"), outside);
      await symlink(outside, path.join(project.workspacePath, "src"));
    };
    await expect(
      new CheckpointStore().snapshot(project),
    ).rejects.toBeInstanceOf(CheckpointChangedError);
    expect(await readFile(path.join(outside, "a.ts"), "utf8")).toBe("one");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects an ancestor swap while preparing replacement content and leaves external files alone",
  async () => {
    const project = await game();
    const file = path.join(project.workspacePath, "src/a.ts");
    const outside = path.join(project.storagePath, "outside");
    const store = new CheckpointStore();
    const original = await store.snapshot(project);
    await writeFile(file, "two");
    hooks.beforeStat = async (target) => {
      if (
        !target.startsWith(
          path.join(project.workspacePath, "src/.ohmygame-checkpoint-"),
        )
      )
        return;
      hooks.beforeStat = undefined;
      await rename(path.join(project.workspacePath, "src"), outside);
      await symlink(outside, path.join(project.workspacePath, "src"));
    };
    // Permission calculation for a restored, newly created file stats its temporary file.
    await rm(file);
    await writeFile(
      path.join(project.workspacePath, "src/untouched.ts"),
      "untouched",
    );
    await expect(store.restore(project, original)).rejects.toBeInstanceOf(
      CheckpointIncompleteError,
    );
    await expect(lstat(path.join(outside, "a.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The unrelated removal cannot be rolled back through the moved directory.
    expect(await store.unfinished(project)).toBeDefined();
  },
);

it.skipIf(process.platform === "win32")(
  "never deletes through a parent symlink during undo",
  async () => {
    const project = await game();
    const file = path.join(project.workspacePath, "src/a.ts");
    await rm(file);
    const outside = path.join(project.storagePath, "outside");
    const store = new CheckpointStore();
    const before = await store.snapshot(project);
    await writeFile(file, "two");
    const after = await store.snapshot(project);
    hooks.afterRename = async (target) => {
      if (path.basename(target) !== "ohmygame-stat-cache.json") return;
      hooks.afterRename = undefined;
      await rename(path.join(project.workspacePath, "src"), outside);
      await symlink(outside, path.join(project.workspacePath, "src"));
    };
    await expect(store.undo(project, { before, after })).rejects.toBeInstanceOf(
      CheckpointChangedError,
    );
    expect(await readFile(path.join(outside, "a.ts"), "utf8")).toBe("two");
  },
);

it.skipIf(process.platform === "win32")(
  "checks ancestry again after loading a blob, before creating any temporary output",
  async () => {
    const project = await game();
    const file = path.join(project.workspacePath, "src/a.ts");
    const outside = path.join(project.storagePath, "outside");
    const store = new CheckpointStore();
    const original = await store.snapshot(project);
    await writeFile(file, "two");
    const oid = createHash("sha1").update("blob 3\0one").digest("hex");
    hooks.beforeRead = async (target) => {
      if (target !== objectFile(project, oid)) return;
      hooks.beforeRead = undefined;
      await rename(path.join(project.workspacePath, "src"), outside);
      await symlink(outside, path.join(project.workspacePath, "src"));
    };
    await expect(store.restore(project, original)).rejects.toBeInstanceOf(
      CheckpointChangedError,
    );
    expect(await readFile(path.join(outside, "a.ts"), "utf8")).toBe("two");
    expect(await readdir(outside)).toEqual(["a.ts"]);
  },
);

it("blocks other mutations until an interrupted operation is recovered, including no-op undo", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  await writeFile(file, "partial");
  const partial = await store.snapshot(project);
  await writeFile(
    path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
    JSON.stringify({ previous: original }),
  );
  for (const operation of [
    () => store.restore(project, partial),
    () => store.undo(project, { before: partial, after: partial }),
    () =>
      store.undo(
        project,
        { before: original, after: partial },
        { conflicts: { overwrite: [] } },
      ),
  ]) {
    await expect(operation()).rejects.toMatchObject({ previous: original });
    expect(await store.unfinished(project)).toBe(original);
    expect(await readFile(file, "utf8")).toBe("partial");
  }
  await store.restore(project, original);
  expect(await store.unfinished(project)).toBeUndefined();
});

it("keeps the original recovery target while a retry is in progress", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  await writeFile(file, "partial");
  await writeFile(
    path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
    JSON.stringify({ previous: original }),
  );
  hooks.beforeRename = async (target) => {
    if (target === file)
      expect(await new CheckpointStore().unfinished(project)).toBe(original);
  };
  await store.restore(project, original);
  expect(await readFile(file, "utf8")).toBe("one");
  expect(await store.unfinished(project)).toBeUndefined();
});

it.each(["not json", "{}", "null", '{"previous":"../../config"}'])(
  "refuses to discard a malformed recovery record: %s",
  async (record) => {
    const project = await game();
    const store = new CheckpointStore();
    const original = await store.snapshot(project);
    const marker = path.join(
      checkpointDirectory(project),
      "ohmygame-unfinished.json",
    );
    await writeFile(marker, record);
    await expect(store.restore(project, original)).rejects.toThrow();
    await expect(
      store.undo(project, { before: original, after: original }),
    ).rejects.toThrow();
    expect(await readFile(marker, "utf8")).toBe(record);
    expect(
      await readFile(path.join(project.workspacePath, "src/a.ts"), "utf8"),
    ).toBe("one");
  },
);

it("does not treat an unreadable recovery marker as an absent one", async () => {
  const project = await game();
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  const marker = path.join(
    checkpointDirectory(project),
    "ohmygame-unfinished.json",
  );
  hooks.beforeRead = async (target) => {
    if (target === marker)
      throw Object.assign(new Error("marker unavailable"), { code: "EIO" });
  };
  await expect(store.restore(project, original)).rejects.toThrow(
    "marker unavailable",
  );
  await expect(
    store.undo(project, { before: original, after: original }),
  ).rejects.toThrow("marker unavailable");
});

it.each(["missing", "damaged"] as const)(
  "repairs a %s blob even when both source and object verification were cached",
  async (fault) => {
    const project = await game();
    const file = path.join(project.workspacePath, "src/a.ts");
    const store = new CheckpointStore();
    vi.useFakeTimers({
      toFake: ["Date"],
      now: (await lstat(file)).ctimeMs + 3_000,
    });
    const original = await store.snapshot(project);
    await store.snapshot(project);
    const oid = createHash("sha1").update("blob 3\0one").digest("hex");
    if (fault === "missing") await rm(objectFile(project, oid));
    else await writeFile(objectFile(project, oid), deflateSync("blob 3\0xxx"));
    const snapshot = await store.snapshot(project);
    expect(snapshot).toBe(original);
    expect(
      Buffer.from(
        (await store.read(project, snapshot, "src/a.ts"))!,
      ).toString(),
    ).toBe("one");
    expect(await new CheckpointStore().snapshot(project)).toBe(original);
  },
);

it("repairs a damaged streamed asset without losing the readable source", async () => {
  const project = await game();
  const source = Buffer.alloc(5 * 1024 * 1024, "asset");
  const file = path.join(project.workspacePath, "pack.bin");
  await writeFile(file, source);
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  const oid = createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
  await writeFile(
    objectFile(project, oid),
    Buffer.from("nonempty damaged object"),
  );
  expect(await store.snapshot(project)).toBe(original);
  expect(
    Buffer.from((await store.read(project, original, "pack.bin"))!).equals(
      source,
    ),
  ).toBe(true);
});

it("fails snapshot when repairing an object fails instead of trusting its damaged replacement", async () => {
  const project = await game();
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  const oid = createHash("sha1").update("blob 3\0one").digest("hex");
  const damaged = objectFile(project, oid);
  await writeFile(damaged, deflateSync("blob 3\0xxx"));
  hooks.beforeRename = async (target) => {
    if (target === damaged) throw new Error("object store unavailable");
  };
  await expect(store.snapshot(project)).rejects.toThrow(
    "object store unavailable",
  );
  hooks.beforeRename = undefined;
  expect(await store.snapshot(project)).toBe(original);
  expect(
    Buffer.from((await store.read(project, original, "src/a.ts"))!).toString(),
  ).toBe("one");
});

it("ignores malformed stat-cache entries and reads the actual source", async () => {
  const project = await game();
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  const stats = await lstat(path.join(project.workspacePath, "src/a.ts"));
  await writeFile(
    path.join(checkpointDirectory(project), "ohmygame-stat-cache.json"),
    JSON.stringify({
      "src/a.ts": {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        ino: stats.ino,
        dev: stats.dev,
        mode: "100644",
        oid: "invalid",
      },
    }),
  );
  expect(await store.snapshot(project)).toBe(original);
});

it("preserves generated history and caches while restoring creative state, including from older checkpoints", async () => {
  const project = await game();
  await mkdir(path.join(project.workspacePath, "canvas"));
  await mkdir(path.join(project.workspacePath, ".data"));
  await mkdir(path.join(project.workspacePath, ".godot"));
  const history = path.join(project.workspacePath, "canvas/jobs.json");
  const assets = path.join(project.workspacePath, ".data/assets.json");
  const cache = path.join(project.workspacePath, ".godot/imported.bin");
  await writeFile(history, "current history");
  await writeFile(assets, "old assets");
  await writeFile(cache, "current cache");
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  expect(
    await store.read(project, original, "canvas/jobs.json"),
  ).toBeUndefined();
  expect(
    await store.read(project, original, ".godot/imported.bin"),
  ).toBeUndefined();
  const gitdir = checkpointDirectory(project);
  // Simulate a checkpoint written before the exclusion policy was updated.
  const root = await readTree(gitdir, await readCommitTree(gitdir, original));
  const blob = await writeObject(gitdir, "blob", Buffer.from("old history"));
  const canvas = await writeTree(gitdir, [
    { mode: "100644", name: "jobs.json", oid: blob },
  ]);
  const legacyTree = await writeTree(gitdir, [
    ...root,
    { mode: "40000", name: "canvas", oid: canvas },
  ]);
  const legacy = await writeCommit(gitdir, legacyTree, undefined, []);
  expect(await store.diff(project, original, legacy)).toEqual([]);
  await writeFile(assets, "new assets");
  const after = await store.snapshot(project);
  expect((await store.restore(project, legacy)).changed).toEqual([
    ".data/assets.json",
  ]);
  expect(await readFile(history, "utf8")).toBe("current history");
  expect(await readFile(cache, "utf8")).toBe("current cache");
  await writeFile(assets, "new assets");
  expect(
    (await store.undo(project, { before: legacy, after })).changed,
  ).toEqual([".data/assets.json"]);
  expect(await readFile(assets, "utf8")).toBe("old assets");
  expect(await readFile(history, "utf8")).toBe("current history");
});

it.each(["commit", "wrong size"])(
  "rejects a hash-valid non-blob or malformed streamed header: %s",
  async (kind) => {
    const project = await game();
    const gitdir = checkpointDirectory(project);
    await new CheckpointStore().snapshot(project);
    const raw = Buffer.from(
      kind === "commit" ? "commit 3\0one" : "blob 4\0one",
    );
    const oid = createHash("sha1").update(raw).digest("hex");
    await mkdir(path.dirname(objectFile(project, oid)), { recursive: true });
    await writeFile(objectFile(project, oid), deflateSync(raw));
    await expect(verifyBlob(gitdir, oid)).rejects.toBeInstanceOf(
      DamagedObjectError,
    );
  },
);

it.each([
  Buffer.from("broken tree"),
  Buffer.concat([Buffer.from("100644 ../outside\0"), Buffer.alloc(20)]),
  Buffer.from("100644 file\0short"),
])("rejects hash-valid malformed tree entries", async (content) => {
  const project = await game();
  const gitdir = checkpointDirectory(project);
  const tree = await writeObject(gitdir, "tree", content);
  await expect(readTree(gitdir, tree)).rejects.toBeInstanceOf(
    DamagedObjectError,
  );
});
it("a successful snapshot must have readable blobs even after an existing blob is damaged", async () => {
  const project = await game();
  const store = new CheckpointStore();
  await store.snapshot(project);
  const oid = createHash("sha1").update("blob 3\0one").digest("hex");
  await writeFile(objectFile(project, oid), deflateSync("blob 3\0xxx"));
  const snapshot = await store.snapshot(project);
  expect(
    Buffer.from((await store.read(project, snapshot, "src/a.ts"))!).toString(),
  ).toBe("one");
});

it("a successful snapshot must repair a damaged tree when the original workspace remains available", async () => {
  const project = await game();
  const store = new CheckpointStore();
  const first = await store.snapshot(project);
  const rootTree = await readCommitTree(checkpointDirectory(project), first);
  await writeFile(objectFile(project, rootTree), Buffer.from("truncated-tree"));
  const snapshot = await store.snapshot(project);
  expect(
    Buffer.from((await store.read(project, snapshot, "src/a.ts"))!).toString(),
  ).toBe("one");
});

it("a failure after rename must roll back the file or retain an unfinished recovery marker", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const before = await store.snapshot(project);
  await writeFile(file, "two");
  let placed = false;
  hooks.afterRename = async (target) => {
    if (target === file) placed = true;
  };
  hooks.beforeStat = async (target) => {
    if (placed && target === file) {
      hooks.beforeStat = undefined;
      throw Object.assign(new Error("post-rename I/O failure"), {
        code: "EIO",
      });
    }
  };
  const failed = await store
    .restore(project, before)
    .catch((error: unknown) => error);
  hooks.afterRename = undefined;
  const actual = {
    error: (failed as Error).constructor.name,
    file: await readFile(file, "utf8"),
    unfinished: await store.unfinished(project),
  };
  expect(actual.file === "two" || actual.unfinished !== undefined).toBe(true);
  expect(failed).toBeInstanceOf(CheckpointIncompleteError);
  expect((failed as CheckpointIncompleteError).previous).toBe(
    actual.unfinished,
  );
  await new CheckpointStore().restore(project, actual.unfinished!);
  expect(await readFile(file, "utf8")).toBe("two");
  expect(await store.unfinished(project)).toBeUndefined();
});

it.skipIf(process.platform === "win32")(
  "a replaced ancestor directory must not redirect restore outside the workspace",
  async () => {
    const project = await game();
    const file = path.join(project.workspacePath, "src/a.ts");
    const outside = path.join(project.storagePath, "outside");
    const store = new CheckpointStore();
    const before = await store.snapshot(project);
    await writeFile(file, "two");
    hooks.afterRename = async (target) => {
      if (path.basename(target) !== "ohmygame-stat-cache.json") return;
      hooks.afterRename = undefined;
      await rename(path.join(project.workspacePath, "src"), outside);
      await symlink(outside, path.join(project.workspacePath, "src"));
    };
    const result = await store
      .restore(project, before)
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CheckpointChangedError);
    expect(await readFile(path.join(outside, "a.ts"), "utf8")).toBe("two");
  },
);

it("failed recovery must retain the original unfinished recovery target", async () => {
  const project = await game();
  const file = path.join(project.workspacePath, "src/a.ts");
  const store = new CheckpointStore();
  const original = await store.snapshot(project);
  // Emulate an interrupted restore: the workspace is partial and the marker
  // still identifies the complete state that recovery must return to.
  await writeFile(file, "partial");
  await writeFile(
    path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
    JSON.stringify({ previous: original }),
  );
  hooks.beforeRename = async (target) => {
    if (target === file) throw new Error("recovery destination unavailable");
  };
  const failed = await store
    .restore(project, original)
    .catch((error: unknown) => error);
  expect(failed).toBeInstanceOf(CheckpointIncompleteError);
  expect(failed).toMatchObject({
    previous: original,
    cause: { message: "recovery destination unavailable" },
  });
  const observed = await store.unfinished(project);
  expect(observed).toBe(original);
  expect(await readFile(file, "utf8")).toBe("partial");
  hooks.beforeRename = undefined;
  await new CheckpointStore().restore(project, original);
  expect(await readFile(file, "utf8")).toBe("one");
  expect(await store.unfinished(project)).toBeUndefined();
});
