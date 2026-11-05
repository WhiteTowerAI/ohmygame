import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import type { CheckpointChangeItem, ProjectState } from "../src/shared/contracts.js";
import { pluginUiRefusal, readPluginUiRequest } from "../src/shared/plugin-ui-protocol.js";
import { projectHistory, projectUsage } from "../src/daemon/plugin-data.js";
import { projectPanelFetch } from "../src/daemon/project-panels.js";
import { CHECKPOINT_ENTRY, TURN_END_ENTRY } from "../src/daemon/checkpoint-extension.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const fixtures: { app: ReturnType<typeof createApp>; directories: string[] }[] = [];
afterEach(async () => {
  for (const { app, directories } of fixtures.splice(0)) {
    await app.close();
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

/** A project using a plugin with a panel that asks for `project.files` at `level`, if any. */
async function setup(level?: "read" | "write", id = "acme/files", capabilities: Record<string, unknown> = {}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-files-"));
  const source = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-files-source-"));
  const app = createApp({ dataDirectory });
  fixtures.push({ app, directories: [dataDirectory, source] });
  await app.ready();
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(source, "ui"), { recursive: true });
  await writeFile(path.join(source, "ui/panel.html"), "<p>panel</p>");
  await writeFile(path.join(source, "ui/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify({
    id, version: "1.0.0", engines: { "ohmygame-api": "^2.2.0" }, displayName: "Files", description: "Uses files.", icon: "./ui/icon.svg",
    ...(level || Object.keys(capabilities).length ? { capabilities: { ...(level ? { "project.files": level } : {}), ...capabilities } } : {}),
    contributes: { panels: [{ id: "main", title: "Main", area: "right", entry: "./ui/panel.html" }] },
  }));
  const payload = { source: { type: "directory", path: source } };
  const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
  expect(inspected.statusCode, inspected.body).toBe(200);
  const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
  expect(added.statusCode, added.body).toBe(201);
  const consent = await app.inject({ method: "POST", url: `/plugin-store/${id}/consent`, payload: { allowed: inspected.json().asks } });
  expect(consent.statusCode, consent.body).toBe(204);
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Files" } })).json<ProjectState>();
  const on = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/${id}`, payload: { on: true, version: "1.0.0" } });
  expect(on.statusCode, on.body).toBe(204);
  const base = `/projects/${project.id}/plugin-files/${id}`;
  const workspace = (...parts: string[]) => path.join(project.workspacePath, ...parts);
  const put = (filePath: string, body: string | Buffer) =>
    app.inject({ method: "PUT", url: `${base}/content?path=${encodeURIComponent(filePath)}`, headers: { "content-type": "application/octet-stream" }, payload: body });
  return { app, project, base, workspace, put };
}

describe("plugin page files API", () => {
  it("lists, reads, writes, moves and deletes the project's files, each change undoable", async () => {
    const { app, project, base, workspace, put } = await setup("write");
    const written = await put("assets/levels/one.json", '{"level":1}');
    expect(written.statusCode, written.body).toBe(200);
    expect(written.json()).toEqual({ value: "assets/levels/one.json" });
    expect(await readFile(workspace("assets/levels/one.json"), "utf8")).toBe('{"level":1}');
    // Bytes arrive as they were sent.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    expect((await put("assets/dot.png", png)).statusCode).toBe(200);
    const read = await app.inject({ method: "GET", url: `${base}/content?path=assets/dot.png` });
    expect(read.statusCode).toBe(200);
    expect(read.headers["content-type"]).toBe("image/png");
    expect(read.headers["x-content-type-options"]).toBe("nosniff");
    expect(read.rawPayload.equals(png)).toBe(true);

    await writeFile(workspace(".env"), "SECRET=1");
    await mkdir(workspace("node_modules/pkg"), { recursive: true });
    await writeFile(workspace("node_modules/pkg/index.js"), "");
    const listing = (await app.inject({ method: "GET", url: `${base}?recursive=true` })).json();
    const paths = listing.entries.map((entry: { path: string }) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(["assets", "assets/dot.png", "assets/levels", "assets/levels/one.json", "node_modules"]));
    // Hidden files never show, and a recursive listing doesn't go into generated folders.
    expect(paths.filter((entry: string) => entry.startsWith(".") || entry.includes("/."))).toEqual([]);
    expect(paths).not.toContain("node_modules/pkg");
    expect(listing.entries.find((entry: { path: string }) => entry.path === "assets/dot.png")).toMatchObject({ kind: "file", size: 8, mediaType: "image/png" });
    expect(listing.truncated).toBe(false);
    const folder = (await app.inject({ method: "GET", url: `${base}?path=assets` })).json();
    expect(folder.entries.map((entry: { path: string }) => entry.path)).toEqual(["assets/dot.png", "assets/levels"]);

    expect((await app.inject({ method: "POST", url: `${base}/folder`, payload: { path: "assets/sounds" } })).json()).toEqual({ value: "assets/sounds" });
    const moved = await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "assets/levels", to: "levels" } });
    expect(moved.json()).toEqual({ value: "levels" });
    expect(await readFile(workspace("levels/one.json"), "utf8")).toBe('{"level":1}');
    // A move never replaces anything, and a folder can't go into itself.
    expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "assets/dot.png", to: "levels/one.json" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "levels", to: "levels/inner" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${base}?path=levels` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${base}/content?path=levels/one.json` })).statusCode).toBe(404);

    // Each change is one the person can take back, by the plugin's name.
    const history = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-changes` })).json<Array<{ id: string; plugin: string; title: string }>>();
    expect(history.map((change) => change.title)).toEqual(["Delete levels", "Move assets/levels to levels", "Write assets/dot.png", "Write assets/levels/one.json"]);
    expect(history.every((change) => change.plugin === "acme/files")).toBe(true);
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/plugin-changes/${history[0]!.id}/undo` })).statusCode).toBe(200);
    expect(await readFile(workspace("levels/one.json"), "utf8")).toBe('{"level":1}');

    // With a change left unrecorded, opening the list holds the workspace, and doesn't wait for itself however the address is spelled.
    const changes = path.join(project.storagePath!, "plugin-changes.json");
    const saved = JSON.parse(await readFile(changes, "utf8")) as { changes: Array<{ after: string }> };
    await writeFile(changes, JSON.stringify({ ...saved, pending: { id: "left", plugin: "acme/files", action: "files:write", title: "Left over", before: saved.changes.at(-1)!.after, at: new Date().toISOString() } }));
    const listed = await app.inject({ method: "GET", url: `/projects/${project.id}/%70lugin-changes` });
    expect(listed.statusCode).toBe(200);
  });

  it("keeps pages away from hidden files, links, the project file and an agent's instructions", async () => {
    const { app, base, workspace, put } = await setup("write");
    await writeFile(workspace(".env"), "SECRET=1");
    await mkdir(workspace(".claude"), { recursive: true });
    for (const hidden of [".env", ".claude/settings.json", "assets/.cache", ".git/config", ".ohmygame/x", "CLAUDE~1/settings.json"]) {
      expect((await app.inject({ method: "GET", url: `${base}/content?path=${encodeURIComponent(hidden)}` })).statusCode, hidden).toBe(403);
      expect((await put(hidden, "x")).statusCode, hidden).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: `${base}?path=.claude` })).statusCode).toBe(403);
    expect(await readFile(workspace(".env"), "utf8")).toBe("SECRET=1");
    for (const refused of ["ohmygame.json", "AGENTS.md", "docs/CLAUDE.md", "gemini.md", "AGENTS.override.md", "CLAUDE.local.md", "canvas/board.json", "Canvas/board.json", "CLAUDE~1.MD"]) {
      expect((await put(refused, "x")).statusCode, refused).toBe(403);
      expect((await app.inject({ method: "DELETE", url: `${base}?path=${encodeURIComponent(refused)}` })).statusCode, refused).toBe(403);
    }
    // Reading them is fine: they are what the project is.
    expect((await app.inject({ method: "GET", url: `${base}/content?path=ohmygame.json` })).statusCode).toBe(200);
    for (const invalid of ["../outside.txt", "/etc/passwd", "a//b", "C:/x", "a/../b", "AGENTS.md ", " notes.txt"])
      expect((await put(invalid, "x")).statusCode, invalid).toBeGreaterThanOrEqual(400);

    // A link is never followed, whether it is the file or a folder on the way.
    const outside = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-files-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, workspace("linked"));
    await symlink(path.join(outside, "secret.txt"), workspace("secret.txt"));
    expect((await app.inject({ method: "GET", url: `${base}/content?path=linked/secret.txt` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${base}/content?path=secret.txt` })).statusCode).toBe(400);
    expect((await put("linked/planted.txt", "x")).statusCode).toBe(400);
    expect((await put("secret.txt", "x")).statusCode).toBe(400);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
    const listing = (await app.inject({ method: "GET", url: base })).json();
    expect(listing.entries.map((entry: { path: string }) => entry.path)).not.toContain("linked");
    await rm(outside, { recursive: true, force: true });
  });

  it("changes only what Undo can bring back, and no folder holding what a page can't touch", async () => {
    const { app, base, workspace, put } = await setup("write");
    await writeFile(workspace(".gitignore"), "*.log\nsecret/\n");
    for (const kept of ["node_modules/pkg/index.js", "dist/game.js", "debug.log", "secret/key.txt"])
      expect((await put(kept, "x")).statusCode, kept).toBe(403);
    // Build output is left out at the root only; a game may keep its own.
    expect((await put("levels/build/one.json", "{}")).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${base}/folder`, payload: { path: "node_modules/new" } })).statusCode).toBe(403);

    await mkdir(workspace("vendor/game"), { recursive: true });
    await writeFile(workspace("vendor/game/main.js"), "");
    await writeFile(workspace("vendor/game/.env"), "SECRET=1");
    await mkdir(workspace("docs"), { recursive: true });
    await writeFile(workspace("docs/AGENTS.md"), "rules");
    await mkdir(workspace("art/old"), { recursive: true });
    await writeFile(workspace("art/old/hero.png"), "png");
    await writeFile(workspace("art/old/trace.log"), "ignored");
    for (const folder of ["vendor", "docs", "art"]) {
      expect((await app.inject({ method: "DELETE", url: `${base}?path=${folder}` })).statusCode, folder).toBe(403);
      expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: folder, to: `moved-${folder}` } })).statusCode, folder).toBe(403);
    }
    expect(await readFile(workspace("vendor/game/.env"), "utf8")).toBe("SECRET=1");
    expect(await readFile(workspace("docs/AGENTS.md"), "utf8")).toBe("rules");
    // A folder may carry what the system leaves, and moves where everything it holds is still kept.
    await mkdir(workspace("sprites"), { recursive: true });
    await writeFile(workspace("sprites/hero.png"), "png");
    await writeFile(workspace("sprites/.DS_Store"), "");
    expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "sprites", to: "secret/sprites" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "sprites", to: "art/sprites" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `${base}?path=art/sprites` })).statusCode).toBe(200);
    // A folder's own .gitignore decides what Undo keeps of it, so the folder stays.
    await writeFile(workspace(".gitignore"), "*.log\nsecret/\nnotes/*.txt\n");
    await mkdir(workspace("notes"));
    await writeFile(workspace("notes/.gitignore"), "!important.txt\n");
    await writeFile(workspace("notes/important.txt"), "keep me");
    expect((await app.inject({ method: "DELETE", url: `${base}?path=notes` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "notes", to: "archive" } })).statusCode).toBe(403);
    expect(await readFile(workspace("notes/important.txt"), "utf8")).toBe("keep me");
  });

  it("reads no file that has another name, and keeps a file's permissions when it replaces it", async () => {
    const { app, base, workspace, put } = await setup("write");
    await writeFile(workspace(".env"), "SECRET=1");
    await link(workspace(".env"), workspace("public.txt"));
    // macOS may resolve the path to the file's other name, which is refused as a link before the count is looked at.
    const refused = [400, 403];
    const aliased = await app.inject({ method: "GET", url: `${base}/content?path=public.txt` });
    expect(refused, aliased.body).toContain(aliased.statusCode);
    expect(aliased.body).not.toContain("SECRET");
    // Nor changes it: Undo would bring the other name's contents back as a file of its own.
    expect(refused).toContain((await put("public.txt", "x")).statusCode);
    expect(refused).toContain((await app.inject({ method: "DELETE", url: `${base}?path=public.txt` })).statusCode);
    expect(await readFile(workspace(".env"), "utf8")).toBe("SECRET=1");
    // A name near the limit still has room for the file written beside it.
    expect((await put(`${"a".repeat(240)}.txt`, "long")).statusCode).toBe(200);
    if (process.platform === "win32") return;
    // What a snapshot can't read, Undo couldn't bring back.
    await writeFile(workspace("locked.txt"), "locked");
    await chmod(workspace("locked.txt"), 0o000);
    const lockedPut = await put("locked.txt", "x");
    expect(lockedPut.statusCode, lockedPut.body).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `${base}?path=locked.txt` })).statusCode).toBe(403);
    await chmod(workspace("locked.txt"), 0o644);
    // Nor anything in a folder it can't list, which it leaves out whole.
    await mkdir(workspace("private"));
    await writeFile(workspace("private/save.txt"), "save");
    await writeFile(workspace("loose.txt"), "loose");
    await chmod(workspace("private"), 0o300);
    const unlisted = [
      await put("private/save.txt", "x"),
      await put("private/new/file.txt", "x"),
      await app.inject({ method: "DELETE", url: `${base}?path=private/save.txt` }),
      await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "loose.txt", to: "private/loose.txt" } }),
      await app.inject({ method: "POST", url: `${base}/folder`, payload: { path: "private/more" } }),
    ];
    await chmod(workspace("private"), 0o755);
    expect(unlisted.map((reply) => reply.statusCode)).toEqual([403, 403, 403, 403, 403]);
    expect(await readFile(workspace("private/save.txt"), "utf8")).toBe("save");
    expect(await readFile(workspace("loose.txt"), "utf8")).toBe("loose");
    // A link to itself is refused without saying where the project is.
    await symlink("loop", workspace("loop"));
    const loop = await app.inject({ method: "GET", url: `${base}/content?path=loop` });
    expect(loop.statusCode).toBeGreaterThanOrEqual(400);
    expect(loop.statusCode).toBeLessThan(500);
    expect(loop.body).not.toContain(workspace());
    // A move that can't take the old name away leaves it where it was, with one name.
    await mkdir(workspace("held"));
    await writeFile(workspace("held/one.txt"), "one");
    await chmod(workspace("held"), 0o555);
    const held = await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "held/one.txt", to: "one.txt" } });
    await chmod(workspace("held"), 0o755);
    expect(held.statusCode).toBe(403);
    expect(held.body).not.toContain(workspace());
    expect((await stat(workspace("held/one.txt"))).nlink).toBe(1);
    await expect(stat(workspace("one.txt"))).rejects.toThrow();
    // A pipe is neither read, which would wait for a writer, nor changed.
    execFileSync("mkfifo", [workspace("pipe")]);
    expect((await app.inject({ method: "GET", url: `${base}/content?path=pipe` })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `${base}?path=pipe` })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/move`, payload: { from: "pipe", to: "moved-pipe" } })).statusCode).toBe(403);
    await writeFile(workspace("build.sh"), "echo old");
    await chmod(workspace("build.sh"), 0o755);
    expect((await put("build.sh", "echo new")).statusCode).toBe(200);
    expect((await stat(workspace("build.sh"))).mode & 0o777).toBe(0o755);
    expect(await readFile(workspace("build.sh"), "utf8")).toBe("echo new");
  });

  it("answers only a plugin that asked for the project's files, at the level it asked for", async () => {
    const reader = await setup("read");
    await writeFile(reader.workspace("notes.txt"), "hello");
    expect((await reader.app.inject({ method: "GET", url: `${reader.base}/content?path=notes.txt` })).body).toBe("hello");
    expect((await reader.put("notes.txt", "changed")).statusCode).toBe(403);
    expect((await reader.app.inject({ method: "DELETE", url: `${reader.base}?path=notes.txt` })).statusCode).toBe(403);
    expect(await readFile(reader.workspace("notes.txt"), "utf8")).toBe("hello");
    // Another plugin, or one the project doesn't use, gets nothing.
    expect((await reader.app.inject({ method: "GET", url: `/projects/${reader.project.id}/plugin-files/acme/other` })).statusCode).toBe(403);

    const none = await setup(undefined, "acme/plain");
    expect((await none.app.inject({ method: "GET", url: none.base })).statusCode).toBe(403);
  });
});

describe("plugin page data API", () => {
  it("lets a page read the project's history and usage only with each capability", async () => {
    const history = await setup(undefined, "acme/history", { "project.history": true });
    const historyBase = `/projects/${history.project.id}/plugin-data/acme/history`;
    const turns = await history.app.inject({ method: "GET", url: `${historyBase}/history?limit=5` });
    expect(turns.statusCode, turns.body).toBe(200);
    expect(turns.json()).toEqual({ turns: [] });
    expect((await history.app.inject({ method: "GET", url: `${historyBase}/history?limit=0` })).statusCode).toBe(400);
    expect((await history.app.inject({ method: "GET", url: `${historyBase}/usage` })).statusCode).toBe(403);
    // Another plugin in the app can't read through this one's route.
    expect((await history.app.inject({ method: "GET", url: `/projects/${history.project.id}/plugin-data/acme/other/history` })).statusCode).toBe(403);

    const usage = await setup(undefined, "acme/usage", { "project.usage": true });
    const usageBase = `/projects/${usage.project.id}/plugin-data/acme/usage`;
    const rows = await usage.app.inject({ method: "GET", url: `${usageBase}/usage` });
    expect(rows.statusCode, rows.body).toBe(200);
    expect(rows.json()).toEqual({ rows: [] });
    expect((await usage.app.inject({ method: "GET", url: `${usageBase}/history` })).statusCode).toBe(403);
  });

  it("reads the turns that changed files, newest first, with what was asked", async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 12, minute)).toISOString();
    let parent: string | null = null;
    const entry = (fields: Record<string, unknown>) => {
      const made = { parentId: parent, ...fields } as unknown as SessionEntry;
      parent = made.id;
      return made;
    };
    const user = (id: string, text: string, minute: number) => entry({ type: "message", id, timestamp: at(minute), message: { role: "user", content: text, timestamp: Date.parse(at(minute)) } });
    const assistant = (id: string, minute: number) => entry({ type: "message", id, timestamp: at(minute), message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: Date.parse(at(minute)) } });
    const checkpoint = (id: string, digit: string, minute: number) => entry({ type: "custom", id, timestamp: at(minute), customType: CHECKPOINT_ENTRY, data: { version: 1, commit: digit.repeat(40) } });
    const end = (id: string, of: string, digit: string, minute: number, items: CheckpointChangeItem[]) => entry({ type: "custom", id, timestamp: at(minute), customType: TURN_END_ENTRY, data: { version: 1, checkpoint: of, commit: digit.repeat(40), files: items.length, items } });
    const branch = [
      checkpoint("c1", "a", 1), user("u1", "Add a boss fight", 1), assistant("a1", 2),
      end("e1", "c1", "b", 2, [{ path: "src/boss.js", kind: "added", lines: { added: 40, removed: 0 } }]),
      checkpoint("c2", "b", 3), user("u2", "What does the boss do?", 3), assistant("a2", 4), end("e2", "c2", "b", 4, []),
      checkpoint("c3", "b", 5), user("u3", "x".repeat(3_000), 5), assistant("a3", 6),
      end("e3", "c3", "c", 6, [{ path: "src/boss.js", kind: "modified" }]),
    ];
    const summary = { id: "conv-1", projectId: "p", title: "Boss", createdAt: at(1), updatedAt: at(6), messageCount: 3 };
    const conversations = {
      list: async () => [summary],
      get: async () => ({ summary }) as never,
      view: async () => ({ getBranch: () => branch }) as never,
    };
    const project = { id: "p" } as ProjectState;
    const turns = await projectHistory(project, conversations, 10);
    expect(turns.map((turn) => turn.message.slice(0, 16))).toEqual(["x".repeat(16), "Add a boss fight"]);
    expect(turns[0]!.message).toHaveLength(2_000);
    expect(turns[1]).toEqual({
      conversation: { id: "conv-1", title: "Boss" },
      at: at(1),
      message: "Add a boss fight",
      changes: [{ path: "src/boss.js", kind: "added", lines: { added: 40, removed: 0 } }],
    });
    expect(await projectHistory(project, conversations, 1)).toHaveLength(1);
  });

  it("keeps only the project's own usage rows, without its id", () => {
    const row = { date: "2026-11-04", provider: "openai", model: "gpt", input: 1, output: 2, cacheRead: 0, cacheWrite: 0, turns: 1, durationMs: 5 };
    expect(projectUsage([{ ...row, projectId: "a" }, { ...row, projectId: "b", turns: 9 }], "a")).toEqual([row]);
  });
});

describe("plugin page files protocol", () => {
  it("needs project.files at the level a method needs, writing covering reading", () => {
    expect(pluginUiRefusal("files.list", {})).toBe("files.list needs the project.files capability set to read");
    expect(pluginUiRefusal("files.read", { "project.files": "read" })).toBeUndefined();
    expect(pluginUiRefusal("files.read", { "project.files": "write" })).toBeUndefined();
    expect(pluginUiRefusal("files.write", { "project.files": "read" })).toBe("files.write needs the project.files capability set to write");
    expect(pluginUiRefusal("files.delete", { "project.files": "write" })).toBeUndefined();
  });

  it("takes a blob or text to write, and paths for the rest", () => {
    const ask = (method: string, params: unknown) => readPluginUiRequest({ id: 1, method, params });
    expect(ask("files.write", { path: "a.png", data: new Blob([new Uint8Array(300 * 1024)]) })).toMatchObject({ ok: true });
    expect(ask("files.write", { path: "a.txt", data: "text" })).toMatchObject({ ok: true });
    expect(ask("files.write", { path: "a.txt", data: 5 })).toMatchObject({ ok: false });
    expect(ask("files.read", {})).toMatchObject({ ok: false });
    expect(ask("files.move", { from: "a" })).toMatchObject({ ok: false });
    expect(ask("files.list", {})).toMatchObject({ ok: true });
    expect(ask("files.list", { recursive: "yes" })).toMatchObject({ ok: false });
  });
});

describe("project panels", () => {
  /** A project holding a panel of its own, and an app that hasn't been asked about it. */
  async function panelSetup(manifest: unknown = { title: "Stats", capabilities: { "project.files": "read" }, net: ["api.example.com"] }) {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-project-panels-"));
    const app = createApp({ dataDirectory });
    fixtures.push({ app, directories: [dataDirectory] });
    await app.ready();
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "Panels" } })).json<ProjectState>();
    const folder = path.join(project.workspacePath, ".ohmygame/panels/stats");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "panel.json"), JSON.stringify(manifest));
    await writeFile(path.join(folder, "index.html"), "<p>stats</p>");
    const panels = async () => (await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-panels` })).json<{ plugin: string; url?: string; projectPanel?: { status: string; key?: string; issues?: string[] } }[]>();
    return { app, project, folder, panels };
  }

  it("runs a panel only once the person allows what it asks for, and again when that changes", async () => {
    const { app, project, folder, panels } = await panelSetup();
    await writeFile(path.join(project.workspacePath, "notes.txt"), "hello");
    const files = `/projects/${project.id}/plugin-files/_project/stats/content?path=notes.txt`;
    const [waiting] = await panels();
    expect(waiting).toMatchObject({ plugin: "_project/stats", projectPanel: { status: "needs-approval" } });
    expect(waiting!.url).toBeUndefined();
    expect((await app.inject({ method: "GET", url: files })).statusCode).toBe(403);

    const allow = (key: string) => app.inject({ method: "POST", url: `/projects/${project.id}/project-panels/stats/allow`, payload: { key } });
    expect((await allow("stale")).statusCode).toBe(409);
    expect((await allow(waiting!.projectPanel!.key!)).statusCode).toBe(204);
    const [allowed] = await panels();
    expect(allowed!.projectPanel!.status).toBe("allowed");
    const page = await fetch(allowed!.url!);
    expect(await page.text()).toBe("<p>stats</p>");
    expect(page.headers.get("content-security-policy")).toContain(`/_project/${project.id}/stats/`);
    expect((await app.inject({ method: "GET", url: files })).body).toBe("hello");
    // Its folder's files only, without following a link out of it.
    await symlink(path.join(project.workspacePath, "notes.txt"), path.join(folder, "linked.txt"));
    expect((await fetch(new URL("linked.txt", allowed!.url!))).status).toBe(404);
    expect((await fetch(new URL("panel.json", allowed!.url!))).status).toBe(200);
    // Read is all it asked for.
    expect((await app.inject({ method: "PUT", url: `/projects/${project.id}/plugin-files/_project/stats/content?path=notes.txt`, headers: { "content-type": "application/octet-stream" }, payload: "x" })).statusCode).toBe(403);
    // What was allowed is the app's, never in the project's folder.
    expect((await readdir(project.workspacePath, { recursive: true })).filter((name) => name.includes("approval"))).toEqual([]);

    // A page that changes keeps running; one that asks for more waits again.
    await writeFile(path.join(folder, "index.html"), "<p>stats 2</p>");
    const [changed] = await panels();
    expect(changed!.projectPanel!.status).toBe("allowed");
    expect(changed!.url).not.toBe(allowed!.url);
    await writeFile(path.join(folder, "panel.json"), JSON.stringify({ title: "Stats", capabilities: { "project.files": "write" } }));
    expect((await panels())[0]!.projectPanel!.status).toBe("needs-approval");
    expect((await fetch(allowed!.url!)).status).toBe(404);
    expect((await app.inject({ method: "GET", url: files })).statusCode).toBe(403);
  });

  it("shows why a panel can't be used", async () => {
    const { panels } = await panelSetup({ title: "Stats", capabilities: { native: true }, extra: 1 });
    expect((await panels())[0]!.projectPanel).toMatchObject({ status: "invalid", issues: ["unknown key extra", "unknown capability native"] });
  });

  it("refuses a panel with more files than it can watch for changes", async () => {
    const { folder, panels } = await panelSetup({ title: "Stats" });
    await mkdir(path.join(folder, "assets"));
    await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(path.join(folder, "assets", `${index}.txt`), "")));
    expect((await panels())[0]!.projectPanel).toMatchObject({ status: "invalid", issues: [expect.stringContaining("more than 500")] });
  });

  it("fetches only from hosts the panel lists, and keeps its errors where the agent reads them", async () => {
    const { app, project, panels } = await panelSetup();
    const fetchUrl = `/projects/${project.id}/plugin-net/_project/stats`;
    // Not allowed yet, so not reachable.
    expect((await app.inject({ method: "POST", url: fetchUrl, payload: { url: "https://api.example.com/x" } })).statusCode).toBe(403);
    await app.inject({ method: "POST", url: `/projects/${project.id}/project-panels/stats/allow`, payload: { key: (await panels())[0]!.projectPanel!.key } });
    expect((await app.inject({ method: "POST", url: fetchUrl, payload: { url: "https://other.example.com/x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: fetchUrl, payload: { url: "http://api.example.com/x" } })).statusCode).toBe(400);
    // A plugin can't reach the network this way.
    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/plugin-net/acme/files`, payload: { url: "https://api.example.com/x" } })).statusCode).toBe(403);

    expect((await app.inject({ method: "POST", url: `/projects/${project.id}/project-panels/stats/errors`, payload: { text: "TypeError: x is undefined" } })).statusCode).toBe(204);
    expect(await readFile(path.join(project.workspacePath, ".ohmygame/local/panel-errors/stats.log"), "utf8")).toContain("TypeError: x is undefined");
  });

  it("sends nothing of the person's, follows no redirect and stops at 5 MB", async () => {
    const calls: RequestInit[] = [];
    const answer = (response: Response) => (async (_url: unknown, init?: RequestInit) => { calls.push(init!); return response; }) as typeof fetch;
    const redirect = await projectPanelFetch({ net: ["api.example.com"] }, { url: "https://api.example.com/a", method: "POST", body: "x" },
      answer(new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/", "set-cookie": "a=b" } })));
    expect(redirect).toMatchObject({ status: 302, headers: { location: "https://elsewhere.example.com/" } });
    expect(redirect.headers["set-cookie"]).toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "POST", body: "x", redirect: "manual", credentials: "omit" });
    await expect(projectPanelFetch({ net: ["api.example.com"] }, { url: "https://api.example.com/big" },
      answer(new Response(new Uint8Array(5 * 1024 * 1024 + 1))))).rejects.toThrow("larger than 5 MB");
    await expect(projectPanelFetch({ net: ["api.example.com"] }, { url: "https://api.example.com:8443/" }, answer(new Response("")))).rejects.toThrow("port");
  });
});
