import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createApp, type AppOptions } from "../src/daemon/app.js";
import {
  CheckpointStore,
  checkpointDirectory,
} from "../src/daemon/checkpoints.js";
import {
  CHECKPOINT_ENTRY,
  CHECKPOINT_UNDONE_ENTRY,
  TURN_END_ENTRY,
} from "../src/daemon/checkpoint-extension.js";
import type { ProjectState } from "../src/shared/contracts.js";
import {
  readWorkspaceNotice,
  readWorkspaceVersion,
} from "../src/daemon/workspace-notice.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const createSession: NonNullable<AppOptions["createSession"]> = async (
  project,
  conversation,
) => {
  const session = SessionManager.open(
    conversation.sessionPath,
    undefined,
    project.workspacePath,
  );
  return {
    messages: [],
    sessionManager: session,
    prompt: async () => {},
    abort: async () => {},
    dispose() {},
    subscribe: () => () => {},
  };
};

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-checkpoint-routes-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const app = createApp({
    dataDirectory: directory,
    createSession,
  });
  cleanup.push(() => app.close());
  const project = (
    await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Checkpoint" },
    })
  ).json<ProjectState>();
  const store = new CheckpointStore();
  await writeFile(path.join(project.workspacePath, "game.txt"), "before");
  const before = await store.snapshot(project);
  const session = SessionManager.create(
    project.workspacePath,
    path.join(project.storagePath!, "session"),
  );
  const checkpointId = session.appendCustomEntry(CHECKPOINT_ENTRY, {
    version: 1,
    commit: before,
  });
  const userId = session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Change files" }],
    timestamp: Date.now(),
  });
  await writeFile(path.join(project.workspacePath, "game.txt"), "after");
  await writeFile(path.join(project.workspacePath, "created.txt"), "new");
  await mkdir(path.join(project.workspacePath, "canvas"));
  await writeFile(
    path.join(project.workspacePath, "canvas", "jobs.json"),
    "history",
  );
  const after = await store.snapshot(project);
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Changed" }],
    api: "openai-completions",
    provider: "openai",
    model: "test",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  session.appendCustomEntry(TURN_END_ENTRY, {
    version: 1,
    checkpoint: checkpointId,
    commit: after,
    files: (await store.diff(project, before, after)).length,
  });
  const base = `/projects/${project.id}/conversations/${session.getSessionId()}/checkpoints`;
  return {
    directory,
    app,
    project,
    store,
    session,
    userId,
    checkpointId,
    base,
    before,
    after,
  };
}

it("serves persisted and live turn diffs, undoes only files, and rejects old editor writes", async () => {
  const { checkpointId, app, project, session, userId, base } = await fixture();
  for (const id of [checkpointId]) {
    const changes = await app.inject({
      method: "GET",
      url: `${base}/${id}/changes`,
    });
    expect(changes.statusCode, changes.body).toBe(200);
    expect(changes.json().changes).toEqual([
      {
        path: "created.txt",
        kind: "added",
        state: "applied",
        lines: { added: 1, removed: 0 },
      },
      {
        path: "game.txt",
        kind: "modified",
        state: "applied",
        lines: { added: 1, removed: 1 },
      },
    ]);
  }
  expect(
    (
      await app.inject({
        method: "GET",
        url: `${base}/${checkpointId}/file?path=game.txt`,
      })
    ).json(),
  ).toEqual({
    path: "game.txt",
    before: { binary: false, content: "before" },
    after: { binary: false, content: "after" },
  });
  expect(
    (
      await app.inject({
        method: "GET",
        url: `${base}/${checkpointId}/file?path=../secret`,
      })
    ).statusCode,
  ).toBe(404);
  const undo = await app.inject({
    method: "POST",
    url: `${base}/${checkpointId}/undo`,
    payload: {},
  });
  expect(undo.statusCode, undo.body).toBe(200);
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("before");
  await expect(
    readFile(path.join(project.workspacePath, "created.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(
      path.join(project.workspacePath, "canvas/jobs.json"),
      "utf8",
    ),
  ).toBe("history");
  const restored = SessionManager.open(session.getSessionFile()!);
  expect(
    restored.getBranch().filter((entry) => entry.type === "message"),
  ).toHaveLength(2);
  expect(await readWorkspaceNotice(project)).toContain(
    "undid file changes from an earlier turn",
  );
  expect(
    restored.getBranch().some((entry) => entry.type === "custom_message"),
  ).toBe(false);
  const stale = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/files`,
    headers: { "x-workspace-version": "0" },
    payload: { name: "stale.txt", kind: "file" },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("workspace_stale");
  const fresh = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/files`,
    headers: { "x-workspace-version": undo.headers["x-workspace-version"] },
    payload: { name: "fresh.txt", kind: "file" },
  });
  expect(fresh.statusCode, fresh.body).toBe(201);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/${checkpointId}/undo`,
        payload: {},
      })
    ).statusCode,
  ).toBe(200);
});

it.each(["keep", "overwrite"] as const)(
  "returns no-write conflicts and honors explicit %s",
  async (policy) => {
    const { checkpointId, app, project, base } = await fixture();
    await writeFile(path.join(project.workspacePath, "game.txt"), "later edit");
    const refused = await app.inject({
      method: "POST",
      url: `${base}/${checkpointId}/undo`,
      payload: {},
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(await readWorkspaceVersion(project)).toBe("0");
    expect(refused.json()).toMatchObject({
      conflicts: ["game.txt"],
    });
    expect(
      await readFile(path.join(project.workspacePath, "created.txt"), "utf8"),
    ).toBe("new");
    const accepted = await app.inject({
      method: "POST",
      url: `${base}/${checkpointId}/undo`,
      payload: {
        conflicts: policy,
        ...(policy === "overwrite" ? { expected: ["game.txt"] } : {}),
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
    ).toBe(policy === "keep" ? "later edit" : "before");
  },
);

it("recovers the recorded interrupted operation and blocks creative writes until recovery", async () => {
  const { checkpointId, app, project, before } = await fixture();
  await writeFile(
    path.join(checkpointDirectory(project), "ohmygame-unfinished.json"),
    JSON.stringify({ previous: before }),
  );
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/projects/${project.id}/checkpoints/unfinished`,
      })
    ).json(),
  ).toEqual({ unfinished: true });
  const blocked = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/files`,
    payload: { name: "blocked.txt", kind: "file" },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().code).toBe("workspace_recovery");
  for (const route of ["canvas/workspace", "playable"]) {
    const read = await app.inject({
      method: "GET",
      url: `/projects/${project.id}/${route}`,
    });
    expect(read.statusCode, read.body).toBe(409);
  }
  const result = await app.inject({
    method: "POST",
    url: `/projects/${project.id}/checkpoints/unfinished/restore`,
  });
  expect(result.statusCode, result.body).toBe(204);
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("before");
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/projects/${project.id}/checkpoints/unfinished`,
      })
    ).json(),
  ).toEqual({ unfinished: false });
});

it("preserves the restored workspace version across daemon restart", async () => {
  const { checkpointId, app, directory, project, base } = await fixture();
  const undo = await app.inject({
    method: "POST",
    url: `${base}/${checkpointId}/undo`,
    payload: {},
  });
  expect(undo.statusCode, undo.body).toBe(200);
  await app.close();
  const restarted = createApp({ dataDirectory: directory, createSession });
  cleanup.push(() => restarted.close());
  const read = await restarted.inject({
    method: "GET",
    url: `/projects/${project.id}`,
  });
  expect(read.headers["x-workspace-version"]).toBe(
    undo.headers["x-workspace-version"],
  );
  const stale = await restarted.inject({
    method: "POST",
    url: `/projects/${project.id}/files`,
    payload: { name: "stale.txt", kind: "file" },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("workspace_stale");
});

it("shows binary and oversized files without unbounded text reads", async () => {
  const { checkpointId, app, project, store, session, base, before } =
    await fixture();
  await writeFile(
    path.join(project.workspacePath, "binary.bin"),
    Buffer.from([0, 1, 255]),
  );
  await writeFile(
    path.join(project.workspacePath, "large.txt"),
    "x".repeat(300 * 1024),
  );
  const after = await store.snapshot(project);
  const previewId = session.appendCustomEntry(CHECKPOINT_ENTRY, {
    version: 1,
    commit: before,
  });
  session.appendCustomEntry(TURN_END_ENTRY, {
    version: 1,
    checkpoint: previewId,
    commit: after,
    files: (await store.diff(project, before, after)).length,
  });
  const binary = await app.inject({
    method: "GET",
    url: `${base}/${previewId}/file?path=binary.bin`,
  });
  expect(binary.json().after).toEqual({ binary: true });
  const large = await app.inject({
    method: "GET",
    url: `${base}/${previewId}/file?path=large.txt`,
  });
  expect(large.json().after).toMatchObject({ truncated: true, binary: false });
  expect(large.json().after.content).toHaveLength(256 * 1024);
});

it("reapplies exact pre-undo contents, survives restart, and keeps the conversation and unrelated files", async () => {
  const { checkpointId, app, directory, project, base, session } =
    await fixture();
  const call = (host: typeof app, action: string, payload = {}) =>
    host.inject({
      method: "POST",
      url: `${base}/${checkpointId}/${action}`,
      payload,
    });
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "player edit after the turn",
  );
  await writeFile(
    path.join(project.workspacePath, "unrelated.txt"),
    "leave alone",
  );
  expect((await call(app, "undo")).statusCode).toBe(409);
  const undo = await call(app, "undo", {
    conflicts: "overwrite",
    expected: ["game.txt"],
  });
  expect(undo.json()).toEqual({
    changed: ["created.txt", "game.txt"],
    conflicts: [],
    undone: true,
    kept: 0,
  });
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("before");
  await app.close();
  const restarted = createApp({ dataDirectory: directory, createSession });
  cleanup.push(() => restarted.close());
  for (let cycle = 0; cycle < 2; cycle++) {
    const reapplied = await call(restarted, "reapply");
    expect(reapplied.statusCode, reapplied.body).toBe(200);
    expect(reapplied.json()).toEqual({
      changed: ["created.txt", "game.txt"],
      conflicts: [],
      undone: false,
      kept: 0,
    });
    expect(
      await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
    ).toBe("player edit after the turn");
    expect(
      await readFile(path.join(project.workspacePath, "created.txt"), "utf8"),
    ).toBe("new");
    expect(
      await readFile(path.join(project.workspacePath, "unrelated.txt"), "utf8"),
    ).toBe("leave alone");
    expect(await readWorkspaceNotice(project)).toContain(
      "reapplied previously undone file changes",
    );
    const branch = SessionManager.open(session.getSessionFile()!).getBranch();
    expect(branch.filter((entry) => entry.type === "message")).toHaveLength(2);
    if (cycle === 0)
      expect(
        (
          await call(restarted, "undo", {
            conflicts: "overwrite",
            expected: ["game.txt"],
          })
        ).statusCode,
      ).toBe(200);
  }
  const history = (
    await restarted.inject({
      method: "GET",
      url: base.slice(0, base.lastIndexOf("/checkpoints")),
    })
  ).json();
  expect(
    history.turns
      .flatMap((turn: { items: { type: string }[] }) => turn.items)
      .find((item: { type: string }) => item.type === "userMessage").changes,
  ).toEqual({ files: 2 });
});

it("reapplies only undone paths, including Undo rest paths from different snapshots", async () => {
  const { checkpointId, app, project, base } = await fixture();
  const call = (action: string, payload = {}) =>
    app.inject({
      method: "POST",
      url: `${base}/${checkpointId}/${action}`,
      payload,
    });
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "first player edit",
  );
  const partial = await call("undo", { conflicts: "keep" });
  expect(partial.json()).toEqual({
    changed: ["created.txt"],
    conflicts: ["game.txt"],
    undone: true,
    kept: 1,
  });
  expect((await call("reapply")).json()).toEqual({
    changed: ["created.txt"],
    conflicts: [],
    undone: false,
    kept: 0,
  });
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("first player edit");
  await call("undo", { conflicts: "keep" });
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "second player edit",
  );
  await call("undo", { conflicts: "overwrite", expected: ["game.txt"] });
  const result = await call("reapply");
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toEqual({
    changed: ["created.txt", "game.txt"],
    conflicts: [],
    undone: false,
    kept: 0,
  });
  expect(
    await readFile(path.join(project.workspacePath, "created.txt"), "utf8"),
  ).toBe("new");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("second player edit");
});

it("refuses Reapply without writes when files change after Undo, and renews overwrite consent", async () => {
  const { checkpointId, app, project, base } = await fixture();
  const call = (action: string, payload = {}) =>
    app.inject({
      method: "POST",
      url: `${base}/${checkpointId}/${action}`,
      payload,
    });
  await call("undo");
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "edit after Undo",
  );
  const version = await readWorkspaceVersion(project);
  const refused = await call("reapply");
  expect(refused.statusCode).toBe(409);
  expect(refused.json().conflicts).toEqual(["game.txt"]);
  expect(await readWorkspaceVersion(project)).toBe(version);
  await expect(
    readFile(path.join(project.workspacePath, "created.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(
    path.join(project.workspacePath, "created.txt"),
    "also edited",
  );
  expect(
    (await call("reapply", { conflicts: "overwrite", expected: ["game.txt"] }))
      .statusCode,
  ).toBe(409);
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("edit after Undo");
  await rm(path.join(project.workspacePath, "created.txt"));
  const partial = await call("reapply", { conflicts: "keep" });
  expect(partial.json()).toMatchObject({
    changed: ["created.txt"],
    conflicts: ["game.txt"],
    undone: true,
  });
  expect(
    await readFile(path.join(project.workspacePath, "created.txt"), "utf8"),
  ).toBe("new");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("edit after Undo");
  const rest = await call("reapply", {
    conflicts: "overwrite",
    expected: ["game.txt"],
  });
  expect(rest.json()).toEqual({
    changed: ["game.txt"],
    conflicts: [],
    undone: false,
    kept: 0,
  });
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("after");
  expect((await call("reapply")).json()).toEqual({
    changed: [],
    conflicts: [],
    undone: false,
    kept: 0,
  });
});

it("reapplies legacy Undo records conservatively without guessing paths edited afterward", async () => {
  const { checkpointId, app, project, base, store, session, before, after } =
    await fixture();
  const undone = await store.undo(project, { before, after });
  session.appendCustomEntry(CHECKPOINT_UNDONE_ENTRY, {
    version: 1,
    checkpoint: checkpointId,
    previous: undone.previous,
    kept: 0,
  });
  await writeFile(
    path.join(project.workspacePath, "game.txt"),
    "edit after legacy Undo",
  );
  const result = await app.inject({
    method: "POST",
    url: `${base}/${checkpointId}/reapply`,
    payload: {},
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toEqual({
    changed: ["created.txt"],
    conflicts: [],
    undone: false,
    kept: 0,
  });
  expect(
    await readFile(path.join(project.workspacePath, "created.txt"), "utf8"),
  ).toBe("new");
  expect(
    await readFile(path.join(project.workspacePath, "game.txt"), "utf8"),
  ).toBe("edit after legacy Undo");
});

it("repeated Undo keeps file-folder targets consistent instead of mixing incompatible snapshots", async () => {
  const { app, project, store, session, base } = await fixture();
  await writeFile(path.join(project.workspacePath, "shape"), "original file");
  const before = await store.snapshot(project);
  const checkpointId = session.appendCustomEntry(CHECKPOINT_ENTRY, {
    version: 1,
    commit: before,
  });
  session.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Replace file with folder" }],
    timestamp: Date.now(),
  });
  await rm(path.join(project.workspacePath, "shape"));
  await mkdir(path.join(project.workspacePath, "shape"));
  await writeFile(
    path.join(project.workspacePath, "shape/child"),
    "turn child",
  );
  const after = await store.snapshot(project);
  session.appendCustomEntry(TURN_END_ENTRY, {
    version: 1,
    checkpoint: checkpointId,
    commit: after,
    files: 2,
  });
  const call = (action: string, payload = {}) =>
    app.inject({
      method: "POST",
      url: `${base}/${checkpointId}/${action}`,
      payload,
    });
  expect((await call("undo")).statusCode).toBe(200);
  await writeFile(
    path.join(project.workspacePath, "shape"),
    "player edit after first Undo",
  );
  const repeated = await call("undo", {
    conflicts: "overwrite",
    expected: ["shape"],
  });
  expect(repeated.statusCode, repeated.body).toBe(200);
  const result = await call("reapply");
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toEqual({
    changed: ["shape"],
    conflicts: [],
    undone: false,
    kept: 0,
  });
  expect(
    await readFile(path.join(project.workspacePath, "shape"), "utf8"),
  ).toBe("player edit after first Undo");
});
