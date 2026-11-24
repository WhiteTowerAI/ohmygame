import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { registerPluginIconRoutes, validatePluginIconImage } from "../src/daemon/plugin-icons.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { PluginSetupManager, registerPluginSetupRoutes, type PluginWorkspaceProjects } from "../src/daemon/plugin-setup.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { PluginMcpHost } from "../src/daemon/plugin-mcp-host.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { exportPlugin } from "../src/daemon/plugin-export.js";
import { GitHubAccount } from "../src/daemon/plugin-github.js";
import { PluginConfigurationStore } from "../src/daemon/plugin-configuration.js";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { extractArchive } from "../src/daemon/archive-extraction.js";
import { writeProjectFile } from "../src/daemon/project-plugins.js";
import { checkFolder } from "../scripts/plugin-check.js";
import { loadSkills, SessionManager } from "@earendil-works/pi-coding-agent";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function environment(projectFolders?: string[]) {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-builder-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  const host = new PluginMcpHost();
  cleanup.push(() => host.close());
  const invalidate = vi.fn();
  const services = new PluginServices({ directory: path.join(directory, "plugin-store"), ...(projectFolders ? { projectFolders: () => projectFolders } : {}) });
  cleanup.push(() => services.close());
  const projects = workspaceProjects(directory);
  function manager() { return new PluginSetupManager(directory, agentDir, host, services, invalidate, projects); }
  const setup = manager();
  const app = Fastify();
  registerPluginSetupRoutes(app, setup);
  registerPluginIconRoutes(app, async () => undefined, async () => undefined);
  cleanup.push(() => app.close());
  return { directory, agentDir, host, services, setup, manager, app, invalidate, projects };
}
/** The hidden projects behind the workspaces, as the app keeps them. */
function workspaceProjects(directory: string) {
  const all = new Map<string, ProjectState>();
  const working = new Set<string>();
  /** Projects held from taking turns, as the app's workspace lock does. */
  const held: string[] = [];
  return {
    all, working, held,
    async create(name: string | undefined, workspacePath: string): Promise<ProjectState> {
      const id = randomUUID();
      const project: ProjectState = { id, name: name ?? "Untitled project", nameSource: name ? "manual" : "default", type: "plugin", updatedAt: new Date(0).toISOString(),
        workspacePath, storagePath: path.join(directory, "projects", id), preview: { status: "stopped" } };
      all.set(id, project);
      return project;
    },
    get: (id: string) => all.get(id),
    async remove(project: ProjectState) { all.delete(project.id); },
    busy: (id: string) => working.has(id),
    async exclusive<T>(id: string, operation: () => Promise<T>) {
      held.push(id);
      try { return await operation(); } finally { held.splice(held.indexOf(id), 1); }
    },
  } satisfies PluginWorkspaceProjects & Record<string, unknown>;
}
const ID = "personal/design-review";
async function writeDraft(directory: string, sessionId: string, mcp = false) {
  const root = path.join(directory, "plugin-setup", sessionId, "workspace", "design-review");
  await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills/review"), { recursive: true });
  await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), JSON.stringify({
    id: ID, version: "0.1.0", engines: { "ohmygame-api": "^2.0.0" },
    displayName: "Design Review", description: "Review game design documents",
    examples: ["Review my game design"],
    ...(mcp ? {
      configuration: { key: { type: "secret", title: "API key", required: true } },
      capabilities: { processes: ["node"], secrets: true },
    } : {}),
    contributes: {
      skills: "./skills/",
      ...(mcp ? { mcpServers: [{ id: "api", title: "API", command: "node", args: ["./server.mjs"], env: { API_KEY: "${config.key}" }, tools: ["echo"] }] } : {}),
    },
  }));
  await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review a game design document.\n---\n\n# Review\n\nRead the document and prioritize improvements.");
  if (mcp) await writeFile(path.join(root, "server.mjs"), await readFile(path.resolve("test/fixtures/plugin-mcp-server.mjs")));
  return root;
}
async function setManifest(root: string, change: (manifest: Record<string, unknown>) => void) {
  const file = path.join(root, ".ohmygame-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  change(manifest);
  await writeFile(file, JSON.stringify(manifest));
}

describe("Plugin Builder", () => {
  it.each([
    "# Review\nReview the game design.",
    "---\nname: review\n---\n\nReview the game design.",
    "---\ndescription: Review game design.\n---\n\nReview the game design.",
  ])("rejects incomplete Skill metadata and installs the corrected Skill for the runtime", async content => {
    const { setup, directory, services, agentDir } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const file = path.join(root, "skills/review/SKILL.md");
    await writeFile(file, content);
    const invalid = await setup.prepare(state.id, root);
    expect(invalid.errors.join(" ")).toContain("/contributes/skills/review");
    expect(invalid.plugin).toBeUndefined();
    expect((await setup.file(state.id, "skills/review/SKILL.md")).content).toBe(content);
    await expect(setup.installDraft(state.id, invalid.revision!)).rejects.toThrow("/contributes/skills/review");
    expect(services.index.entries()).toEqual([]);

    await writeFile(file, "---\nname: review\ndescription: |\n  Review a game design document.\n---\n\nPrioritize design improvements.");
    const corrected = await setup.prepare(state.id, root);
    expect(corrected.errors).toEqual([]);
    const installed = await setup.installDraft(state.id, corrected.revision!);
    expect(installed.pluginId).toBe(ID);
    const loaded = loadSkills({ cwd: root, agentDir, includeDefaults: false,
      skillPaths: [path.join(services.index.get(ID)!.root, "skills/review/SKILL.md")],
    });
    expect(loaded.skills).toMatchObject([{ name: "review", description: "Review a game design document.\n" }]);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("describes what a draft adds, what it asks for and where it applies", async () => {
    const { setup, directory } = await environment();
    const skillsOnly = await setup.create();
    expect(await setup.prepare(skillsOnly.id, await writeDraft(directory, skillsOnly.id))).toMatchObject({
      errors: [],
      plugin: { id: ID, version: "0.1.0", displayName: "Design Review", appWide: true, asks: [], settings: false, mcpServers: [], skills: [{ id: "skills/review/SKILL.md", name: "review" }], adds: { skills: 1, mcpServers: [] } },
    });
    const withServer = await setup.create();
    const draft = await setup.prepare(withServer.id, await writeDraft(directory, withServer.id, true));
    expect(draft.errors).toEqual([]);
    expect(draft.plugin).toMatchObject({ appWide: false, settings: true, mcpServers: [{ id: "api", title: "API" }], adds: { mcpServers: ["API"] } });
    expect(draft.plugin?.asks.length).toBeGreaterThan(0);
  });

  it("only makes personal plugins, so a draft can't replace what the app or a publisher ships", async () => {
    const { setup, directory, services } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setManifest(root, manifest => { manifest.id = "ohmygame/blender"; });
    const draft = await setup.prepare(state.id, root);
    expect(draft.errors).toEqual(["The plugin's id must be personal/<name>, not ohmygame/blender"]);
    expect(draft.plugin).toBeUndefined();
    await expect(setup.installDraft(state.id, draft.revision!)).rejects.toThrow("personal/<name>");
    await expect(services.installPersonal(root, { consent: false })).rejects.toThrow("personal/<name>");
    expect(services.index.entries()).toEqual([]);
  });

  it("exports a plugin it made as a package to publish under the person's publisher", async () => {
    const { setup, directory, services } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await services.installPersonal(root, { consent: false });
    const entry = services.index.get(ID)!;
    const into = path.join(directory, "exports");
    await expect(exportPlugin(entry, "personal", into)).rejects.toThrow("kept for OhMyGame");
    const folder = await exportPlugin(entry, "acme", into);
    const name = ID.slice("personal/".length);
    expect(folder).toBe(path.join(into, name));
    expect(JSON.parse(await readFile(path.join(folder, ".ohmygame-plugin/plugin.json"), "utf8")).id).toBe(`acme/${name}`);
    expect(JSON.parse(await readFile(path.join(folder, "package.json"), "utf8"))).toMatchObject({ name: `@acme/${name}`, version: "0.1.0" });
    // It passes; this draft has no icon, which is only a warning.
    expect((await checkFolder(folder)).map(({ level, message }) => `${level}: ${message}`)).toEqual([expect.stringMatching(/^warning: There is no icon/)]);
    // Nothing installed changes, and a folder with files isn't overwritten.
    expect(services.index.entries().map((item) => item.id)).toEqual([ID]);
    await expect(exportPlugin(entry, "acme", into)).rejects.toThrow("already has files");
    // Nor is a file of that name.
    const other = path.join(directory, "elsewhere");
    await mkdir(other);
    await writeFile(path.join(other, name), "mine");
    await expect(exportPlugin(entry, "acme", other)).rejects.toThrow("already has files");
    expect(await readFile(path.join(other, name), "utf8")).toBe("mine");
    await expect(exportPlugin({ ...entry, id: "acme/other" }, "acme", into)).rejects.toThrow("Only a plugin you made");
  });

  it("allows what a reviewed draft asks for, but not one the agent installs", async () => {
    const { setup, directory, services } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id, true);
    const draft = await setup.prepare(state.id, root);
    await services.installPersonal(root, { consent: false });
    expect(services.grants.plugin(ID)).toBeUndefined();
    await services.uninstall(ID);
    await setup.installDraft(state.id, draft.revision!);
    expect(services.grants.plugin(ID)?.allowed).toEqual(draft.plugin?.asks);
  });

  it("replaces older versions, keeping those a project still names, unless the plugin only adds Skills", async () => {
    const folders: string[] = [];
    const { setup, directory, services } = await environment(folders);
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setup.installDraft(state.id, (await setup.prepare(state.id, root)).revision!);
    await setManifest(root, manifest => { manifest.version = "0.2.0"; });
    await setup.installDraft(state.id, (await setup.draft(state.id)).revision!);
    expect(services.index.versions(ID).map(entry => entry.version)).toEqual(["0.2.0"]);

    const other = await setup.create();
    const withServer = path.join(directory, "plugin-setup", other.id, "workspace", "design-review");
    await writeDraft(directory, other.id, true);
    await setManifest(withServer, manifest => { manifest.id = "personal/design-tools"; });
    await setup.installDraft(other.id, (await setup.prepare(other.id, withServer)).revision!);
    // No project names 0.1.0, so 0.2.0 replaces it: an update doesn't leave a version to clean up.
    await setManifest(withServer, manifest => { manifest.version = "0.2.0"; });
    await setup.installDraft(other.id, (await setup.draft(other.id)).revision!);
    expect(services.index.versions("personal/design-tools").map(entry => entry.version)).toEqual(["0.2.0"]);
    // A project that names 0.2.0 keeps it when 0.3.0 comes.
    const pinned = path.join(directory, "pinned");
    await mkdir(pinned);
    await writeProjectFile(pinned, (file) => file, { type: "general", plugins: { "personal/design-tools": "0.2.0" } });
    folders.push(pinned);
    await setManifest(withServer, manifest => { manifest.version = "0.3.0"; });
    await setup.installDraft(other.id, (await setup.draft(other.id)).revision!);
    expect(services.index.versions("personal/design-tools").map(entry => entry.version)).toEqual(["0.3.0", "0.2.0"]);
    // A project file that can't be read might name any, so all are kept.
    const broken = path.join(directory, "broken");
    await mkdir(broken);
    await writeFile(path.join(broken, "ohmygame.json"), "{");
    folders.push(broken);
    await setManifest(withServer, manifest => { manifest.version = "0.4.0"; });
    await setup.installDraft(other.id, (await setup.draft(other.id)).revision!);
    expect(services.index.versions("personal/design-tools").map(entry => entry.version)).toEqual(["0.4.0", "0.3.0", "0.2.0"]);
    // Going back to an older version leaves the newer ones in place.
    folders.splice(0);
    await setManifest(withServer, manifest => { manifest.version = "0.1.0"; });
    await setup.installDraft(other.id, (await setup.draft(other.id)).revision!);
    expect(services.index.versions("personal/design-tools").map(entry => entry.version)).toEqual(["0.4.0", "0.3.0", "0.2.0", "0.1.0"]);
  });

  it("saves icon paths with revision checks and retains them after install and restart", async () => {
    const { setup, directory, services, app, manager } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
    const draft = await setup.prepare(state.id, root);
    const asset = { type: "asset", path: "./assets/icon.svg" };
    const changed = await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: { revision: draft.revision, icon: asset } });
    expect(changed.statusCode, changed.body).toBe(200);
    const preview = changed.json();
    expect(preview.plugin.icon).toEqual(asset);
    expect(preview.revision).not.toBe(draft.revision);
    expect((await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: { revision: draft.revision, icon: asset } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: { revision: preview.revision, icon: { type: "preset", id: "image" } } })).statusCode).toBe(400);
    await expect(setup.installDraft(state.id, draft.revision!)).rejects.toThrow("changed");
    await setup.installDraft(state.id, preview.revision);
    expect(services.index.get(ID)?.manifest.icon).toBe("./assets/icon.svg");
    const resumed = manager();
    expect((await resumed.draft(state.id)).plugin?.icon).toEqual(asset);
    expect((await resumed.list()).find(session => session.id === state.id)?.icon).toEqual(preview.plugin?.icon);
    const reset = await resumed.updateIcon(state.id, { revision: preview.revision, icon: null });
    expect(reset.plugin?.icon).toBeUndefined();
    expect(services.index.get(ID)?.manifest.icon).toBe("./assets/icon.svg");
    await resumed.installDraft(state.id, reset.revision!);
    expect(services.index.get(ID)?.manifest.icon).toBeUndefined();
  });

  it.each(["png", "webp", "svg"] as const)("uploads, previews and installs %s icons", async format => {
    const { setup, directory, services, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    const mediaType = format === "svg" ? "image/svg+xml" : `image/${format}`;
    const bytes = format === "svg"
      ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#ed563b"/></svg>')
      : await sharp({ create: { width: 32, height: 32, channels: 4, background: "#ed563b" } }).toFormat(format).toBuffer();
    const result = await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: {
      revision: draft.revision, image: { mediaType, data: bytes.toString("base64") },
    } });
    expect(result.statusCode, result.body).toBe(200);
    const preview = result.json();
    expect(preview.plugin.icon).toMatchObject({ type: "asset" });
    expect(await readFile(path.join(root, preview.plugin.icon.path))).toEqual(bytes);
    const icon = await app.inject({ url: `/plugins/setup-sessions/${state.id}/icon` });
    expect(icon.headers["content-type"]).toBe(mediaType);
    expect(icon.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(icon.headers["x-content-type-options"]).toBe("nosniff");
    expect(icon.rawPayload).toEqual(bytes);
    const pathPreview = await app.inject({ url: `/plugins/setup-sessions/${state.id}/icon?${new URLSearchParams({ path: preview.plugin.icon.path })}` });
    expect(pathPreview.rawPayload).toEqual(bytes);
    await setup.installDraft(state.id, preview.revision);
    const installed = services.index.get(ID)!;
    expect(await readFile(path.join(installed.root, installed.manifest.icon!))).toEqual(bytes);
  });

  it("rejects invalid image contents, large images, missing files and paths outside the package", async () => {
    const { setup, directory, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    await expect(setup.updateIcon(state.id, { revision: draft.revision!, image: { mediaType: "image/png", data: Buffer.from("not an image").toString("base64") } })).rejects.toThrow();
    await expect(validatePluginIconImage(Buffer.alloc(1024 * 1024 + 1))).rejects.toThrow("1 MB");
    const oversized = await sharp({ create: { width: 2049, height: 1, channels: 4, background: "red" } }).png().toBuffer();
    await expect(validatePluginIconImage(oversized)).rejects.toThrow("2048");
    for (const resource of ["./missing.png", "./../outside.png", "/tmp/icon.png", "https://example.com/icon.png", "./assets/icon.svg"]) {
      await expect(setup.updateIcon(state.id, { revision: draft.revision!, icon: { type: "asset", path: resource } })).rejects.toThrow();
    }
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    await writeFile(path.join(directory, "outside.png"), bytes);
    await symlink(path.join(directory, "outside.png"), path.join(root, "linked.png"));
    expect((await app.inject({ url: `/plugins/setup-sessions/${state.id}/icon?path=./linked.png` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/plugins/setup-sessions/${state.id}/icon?path=./../outside.png` })).statusCode).toBe(404);
  });

  it.each(["missing", "oversized", "undecodable"])("doesn't accept a draft with an %s icon", async kind => {
    const { setup, directory, services } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setManifest(root, manifest => { manifest.icon = "./assets/icon.png"; });
    if (kind !== "missing") {
      await mkdir(path.join(root, "assets"));
      const bytes = kind === "oversized" ? Buffer.alloc(1024 * 1024 + 1)
        : (await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer()).subarray(0, 20);
      await writeFile(path.join(root, "assets/icon.png"), bytes);
    }
    const draft = await setup.prepare(state.id, root);
    expect(draft.errors.length).toBeGreaterThan(0);
    expect(draft.plugin).toBeUndefined();
    await expect(setup.installDraft(state.id, draft.revision ?? "a".repeat(64))).rejects.toThrow();
    expect(services.index.entries()).toEqual([]);
  });

  it("reuses successful image validation by content while checking each requested media type", async () => {
    const { PhotonImage } = await import("@silvia-odwyer/photon-node");
    const decode = vi.spyOn(PhotonImage, "new_from_byteslice");
    try {
      const bytes = await sharp({ create: { width: 17, height: 13, channels: 4, background: "#40a976" } }).png().toBuffer();
      const [first, second] = await Promise.all([validatePluginIconImage(bytes), validatePluginIconImage(Buffer.from(bytes))]);
      expect(second.revision).toBe(first.revision);
      expect(decode).toHaveBeenCalledTimes(1);
      await expect(validatePluginIconImage(bytes, "image/webp")).rejects.toThrow("PNG, WebP, or static SVG");
      expect(decode).toHaveBeenCalledTimes(1);
      const changed = await sharp({ create: { width: 17, height: 13, channels: 4, background: "#40a977" } }).png().toBuffer();
      expect((await validatePluginIconImage(changed)).revision).not.toBe(first.revision);
      expect(decode).toHaveBeenCalledTimes(2);
    } finally { decode.mockRestore(); }
  });

  it("keeps new workspaces separate, each with its own hidden project, and lists them after restart", async () => {
    const { setup, manager, projects } = await environment();
    const first = await setup.create(), second = await setup.create();
    expect(second.id).not.toBe(first.id);
    expect(second.projectId).not.toBe(first.projectId);
    expect(projects.get(first.projectId)).toMatchObject({ type: "plugin", workspacePath: expect.stringContaining(first.id) });
    // The workspace works while its project's agent does.
    projects.working.add(first.projectId);
    const listed = await manager().list();
    expect(listed).toHaveLength(2);
    expect(listed.find(item => item.id === first.id)).toMatchObject({ status: "working", projectId: first.projectId });
    expect(listed.find(item => item.id === second.id)).toMatchObject({ status: "idle" });
  });

  it("names a new workspace after its project until its draft has a name", async () => {
    const { setup, directory, projects } = await environment();
    const state = await setup.create();
    expect(state.title).toBe("New plugin");
    Object.assign(projects.get(state.projectId)!, { name: "Level ideas", nameSource: "ai" });
    expect((await setup.read(state.id)).title).toBe("Level ideas");
    await setup.prepare(state.id, await writeDraft(directory, state.id));
    expect((await setup.read(state.id)).title).toBe("Design Review");
  });

  it("gives the agent of a workspace's project the plugin tool, and other projects none", async () => {
    const { setup, projects } = await environment();
    const state = await setup.create();
    expect((await setup.agentTools(projects.get(state.projectId)!)).map(tool => tool.name)).toEqual(["plugin_manage"]);
    expect(await setup.agentTools({ id: state.projectId, type: "general" })).toEqual([]);
  });

  it("previews and validates an uninstalled draft, rejects a stale revision, and installs the reviewed version", async () => {
    const { setup, directory, services, app, invalidate, projects } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    expect(draft).toMatchObject({ plugin: { displayName: "Design Review" }, errors: [] });
    expect(services.index.entries()).toEqual([]);
    expect((await setup.file(state.id, "skills/review/SKILL.md")).content).toContain("prioritize improvements");
    await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review game documents.\n---\n\nUpdated instructions.");
    const stale = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: draft.revision } });
    expect(stale.statusCode).toBe(409);
    const updated = await setup.draft(state.id);
    expect(updated.revision).not.toBe(draft.revision);
    // The project takes no turn while it installs, so the agent can't change the reviewed draft.
    const install = services.installPersonal.bind(services);
    let heldWhileInstalling: string[] = [];
    vi.spyOn(services, "installPersonal").mockImplementation(async (...args) => { heldWhileInstalling = [...projects.held]; return install(...args); });
    const installed = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: updated.revision } });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ status: "installed", pluginId: ID });
    expect(heldWhileInstalling).toEqual([state.projectId]);
    expect(projects.held).toEqual([]);
    expect(invalidate).toHaveBeenCalledOnce();
    expect((await setup.draft(state.id)).installedRevision).toBe(updated.revision);
    expect(services.index.versions(ID)).toHaveLength(1);
    await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), "{}");
    expect((await setup.draft(state.id)).errors).not.toEqual([]);
    await expect(setup.installDraft(state.id, updated.revision!)).rejects.toThrow();
    expect(services.index.versions(ID)).toHaveLength(1);
  });

  it("keeps an installed draft's id", async () => {
    const { setup, directory, services } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setup.installDraft(state.id, (await setup.prepare(state.id, root)).revision!);
    await setManifest(root, manifest => { manifest.id = "personal/another-name"; });
    const renamed = await setup.draft(state.id);
    expect(renamed.errors).toEqual([`This draft updates ${ID}, so it must keep that id`]);
    await expect(setup.installDraft(state.id, renamed.revision!)).rejects.toThrow("must keep");
    expect(services.index.get("personal/another-name")).toBeUndefined();
  });

  it("keeps preview paths inside the workspace, including symbolic links", async () => {
    const { setup, directory } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setup.prepare(state.id, root);
    await writeFile(path.join(directory, "private.txt"), "outside the builder");
    await expect(setup.file(state.id, "../../../../private.txt")).rejects.toThrow("inside");
    await symlink(path.join(directory, "private.txt"), path.join(root, "outside.txt"));
    await expect(setup.file(state.id, "outside.txt")).rejects.toThrow("inside");
    expect((await setup.draft(state.id)).errors.join(" ")).toContain("symbolic links");
  });

  it("runs a draft's panels in its own workspace under a draft id, with the playground as their project", async () => {
    const { setup, directory, services, projects, manager } = await environment();
    const state = await setup.create();
    const other = await setup.create();
    const root = await writeDraft(directory, state.id);
    await mkdir(path.join(root, "ui"), { recursive: true });
    await writeFile(path.join(root, "ui/panel.html"), "<p>Review</p>");
    await writeFile(path.join(root, "ui/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"/>");
    await setManifest(root, (manifest) => {
      manifest.icon = "./ui/icon.svg";
      manifest.capabilities = { "project.files": "read" };
      manifest.contributes = { ...(manifest.contributes as object), panels: [{ id: "main", title: "Review board", area: "right", entry: "./ui/panel.html" }] };
    });
    // Nothing runs before the agent hands the draft over.
    expect(await setup.draftPanels(state.projectId, "en")).toEqual([]);
    await setup.prepare(state.id, root);
    const playground = path.join(directory, "plugin-setup", state.id, "workspace", "playground");
    expect(await setup.draftPanels(state.projectId, "en")).toEqual([expect.objectContaining({
      id: "main", plugin: `_draft/${state.id}`, title: "Review board", area: "right",
      capabilities: { "project.files": "read" }, playground,
    })]);
    expect((await stat(playground)).isDirectory()).toBe(true);
    expect(await setup.draftRuntimeOf(state.id)).toMatchObject({ plugin: `_draft/${state.id}`, entry: { id: ID, root: await realpath(root) } });
    // Only its own workspace runs it, and nothing is installed.
    expect(await setup.draftPanels(other.projectId, "en")).toEqual([]);
    expect(await setup.draftPanels(randomUUID(), "en")).toEqual([]);
    expect(services.index.entries()).toEqual([]);
    expect(await manager().draftPanels(state.projectId, "en")).toHaveLength(1);

    // What its pages reported is the agent's to read, apart from any other plugin's, until it prepares again.
    services.logs.add(`_draft/${state.id}`, { level: "error", source: "panel", text: "Review board: x is undefined" });
    const tool = (await setup.agentTools(projects.get(state.projectId)!))[0]!;
    const logs = async () => {
      const [content] = (await tool.execute("call", { action: "logs" }, undefined, undefined, undefined as never)).content;
      return JSON.parse(content?.type === "text" ? content.text : "null") as unknown;
    };
    expect(await logs()).toEqual({ draft: [expect.objectContaining({ text: "Review board: x is undefined" })] });
    await setup.prepare(state.id, root);
    expect(await logs()).toEqual({ draft: [] });

    // A playground that is a link would take its pages out of the workspace, so the draft doesn't run.
    await rm(playground, { recursive: true });
    await symlink(directory, playground);
    expect(await setup.draftPanels(state.projectId, "en", { fresh: true })).toEqual([]);
    await rm(playground);
    expect(await setup.draftPanels(state.projectId, "en", { fresh: true })).toHaveLength(1);
    // Nor does one in the playground.
    const inside = path.join(playground, "copy");
    await cp(root, inside, { recursive: true });
    await setup.prepare(state.id, inside);
    expect(await setup.draftPanels(state.projectId, "en")).toEqual([]);
    await setup.prepare(state.id, root);

    // A draft that fails its checks, or sits at the workspace's root over its playground, doesn't run.
    await setManifest(root, (manifest) => { manifest.version = "not semver"; });
    await setup.prepare(state.id, root);
    expect(await setup.draftPanels(state.projectId, "en")).toEqual([]);
    const flat = await setup.create();
    const workspace = path.join(directory, "plugin-setup", flat.id, "workspace");
    await cp(root, workspace, { recursive: true });
    await setManifest(workspace, (manifest) => { manifest.version = "0.1.0"; });
    expect((await setup.prepare(flat.id, workspace)).errors).toEqual([]);
    expect(await setup.draftPanels(flat.projectId, "en")).toEqual([]);

    // A draft without pages gets no playground.
    const skills = await setup.create();
    await setup.prepare(skills.id, await writeDraft(directory, skills.id));
    expect(await setup.draftRuntimeOf(skills.id)).toMatchObject({ plugin: `_draft/${skills.id}` });
    await expect(stat(path.join(directory, "plugin-setup", skills.id, "workspace", "playground"))).rejects.toThrow();
  });

  it("runs a draft's native code in a host of its own once the person allows it, with the playground as its project", async () => {
    const { setup, directory, services, projects, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await mkdir(path.join(root, "native"), { recursive: true });
    await mkdir(path.join(root, "tools"), { recursive: true });
    await writeFile(path.join(root, "tools/echo.input.json"), JSON.stringify({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }));
    const code = (word: string) => `export function activate(context) {
  context.registerTool("echo", async (input) => ({ said: "${word} " + input.text, folder: context.project?.folder }));
  context.registerCommand("count", async () => { console.log("counting"); return { count: 1 }; });
  context.registerHook("turn.completed", async (event) => ({ notice: "heard " + event.turn }));
}
`;
    await writeFile(path.join(root, "native/index.mjs"), code("first"));
    await setManifest(root, (manifest) => {
      manifest.capabilities = { native: true };
      manifest.entrypoints = { native: "./native/index.mjs" };
      manifest.contributes = { ...(manifest.contributes as object),
        tools: [{ name: "echo", description: "Echoes", input: "./tools/echo.input.json" }],
        commands: [{ id: "count", title: "Count", run: { native: "count", changesFiles: false } }],
        hooks: ["turn.completed"] };
    });
    const draft = await setup.prepare(state.id, root);
    expect(draft.errors).toEqual([]);
    expect(draft.plugin!.native).toMatchObject({ tools: [{ name: "echo", input: { required: ["text"] } }], commands: [{ id: "count", title: "Count" }], hooks: ["turn.completed"] });
    expect(draft.runAllowed).toBe(false);

    // Nothing runs until the person allows what the draft asks for.
    const tool = (await setup.agentTools(projects.get(state.projectId)!))[0]!;
    const run = async (input: unknown) => {
      const [content] = (await tool.execute("call", { action: "run", input }, undefined, undefined, undefined as never)).content;
      return JSON.parse(content?.type === "text" ? content.text : "null") as unknown;
    };
    await expect(setup.runDraft(state.id, { tool: "echo" }, { text: "hi" })).rejects.toThrow("hasn't allowed");
    expect((await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/allow-run`, payload: { key: "0".repeat(32) } })).statusCode).toBe(409);
    expect((await setup.allowRun(state.id, draft.plugin!.native!.key)).runAllowed).toBe(true);

    const playground = await realpath(path.join(directory, "plugin-setup", state.id, "workspace", "playground"));
    expect(await run({ tool: "echo", input: { text: "hi" } })).toMatchObject({ ok: true, result: { said: "first hi", folder: playground } });
    // Input is checked against the draft's own schema, as an installed tool's is.
    expect(await run({ tool: "echo", input: {} })).toMatchObject({ ok: false, error: expect.stringContaining("input") });
    expect(await run({ command: "count" })).toMatchObject({ ok: true, result: { count: 1 }, log: [expect.objectContaining({ text: expect.stringContaining("counting") })] });
    expect(await run({ hook: "turn.completed", input: { turn: "t1", files: [] } })).toMatchObject({ ok: true, result: { notice: "heard t1" } });
    expect(await run({ tool: "missing" })).toMatchObject({ ok: false, error: expect.stringContaining("does not declare a tool named missing") });
    // What a run logged comes back with it, however full the draft's log already is.
    for (let index = 0; index < 600; index += 1) services.logs.add(`_draft/${state.id}`, { level: "info", source: "panel", text: `old ${index}` });
    expect(await run({ command: "count" })).toMatchObject({ ok: true, log: [expect.objectContaining({ text: expect.stringContaining("counting") })] });
    const both = await tool.execute("call", { action: "run", input: { tool: "echo", command: "count" } }, undefined, undefined, undefined as never);
    expect(both).toMatchObject({ isError: true, content: [{ text: "Name one of tool, command or hook to run" }] });
    // It runs as its draft id, never as the plugin it would install.
    expect(services.log(ID).entries).toEqual([]);

    // Changed code runs once handed over again, in a new host.
    await writeFile(path.join(root, "native/index.mjs"), code("second"));
    await setup.prepare(state.id, root);
    expect(await run({ tool: "echo", input: { text: "hi" } })).toMatchObject({ ok: true, result: { said: "second hi" } });
    // Asking for more needs the person again.
    await setManifest(root, (manifest) => { manifest.capabilities = { native: true, network: ["api.example.com"] }; });
    expect((await setup.prepare(state.id, root)).runAllowed).toBe(false);
    await expect(setup.runDraft(state.id, { tool: "echo" }, { text: "hi" })).rejects.toThrow("hasn't allowed");
    await setup.remove(state.id);
  });

  it("says what installing a draft would change in the installed plugin", async () => {
    const { setup, directory, services, manager } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    // Nothing is installed, so there is nothing to compare.
    expect(draft.update).toBeUndefined();
    await setup.installDraft(state.id, draft.revision!);
    expect((await setup.draft(state.id)).update).toBeUndefined();

    await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review a game design document.\n---\n\nNew steps.");
    await writeFile(path.join(root, "notes.md"), "notes");
    await setManifest(root, (manifest) => { manifest.capabilities = { network: ["api.example.com"] }; manifest.configuration = { key: { type: "text", title: "Key" } }; });
    expect((await setup.draft(state.id)).update).toEqual({
      version: { from: "0.1.0", to: "0.1.0" },
      asks: { added: ["network:api.example.com"], removed: [] },
      files: { added: ["notes.md"], removed: [], changed: [".ohmygame-plugin/plugin.json", "skills/review/SKILL.md"] },
    });
    await setManifest(root, (manifest) => { manifest.version = "0.2.0"; });
    await rm(path.join(root, "notes.md"));
    expect((await setup.draft(state.id)).update).toMatchObject({ version: { from: "0.1.0", to: "0.2.0" }, files: { added: [], removed: [] } });
    // What it asks for more is said even when the installed package can't be read.
    await rm(services.index.get(ID)!.root, { recursive: true, force: true });
    const unread = (await manager().draft(state.id)).update;
    expect(unread).toMatchObject({ asks: { added: ["network:api.example.com"] } });
    expect(unread?.files).toBeUndefined();
  });

  it("shows the agent a draft's panel as the open workspace captures it", async () => {
    const { setup, directory, projects } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await mkdir(path.join(root, "ui"), { recursive: true });
    await writeFile(path.join(root, "ui/panel.html"), "<p>Review</p>");
    await writeFile(path.join(root, "ui/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"/>");
    await setManifest(root, (manifest) => {
      manifest.icon = "./ui/icon.svg";
      manifest.contributes = { ...(manifest.contributes as object), panels: [{ id: "board", title: "Board", area: "right", entry: "./ui/panel.html" }] };
    });
    await setup.prepare(state.id, root);
    const tool = (await setup.agentTools(projects.get(state.projectId)!))[0]!;
    const preview = (input?: unknown) => tool.execute("call", { action: "preview", input }, undefined, undefined, undefined as never);
    // Outside the desktop app nobody can answer.
    expect(await preview()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("desktop app") }] });

    // The open workspace hears the request on its project's events and answers it.
    const asked: Array<{ projectId: string; setupId: string; request: string; panel?: string; revision: string; expires: number }> = [];
    setup.serveCaptures((projectId, data) => {
      asked.push({ projectId, ...data });
      // Another workspace can't answer this one's request.
      expect(setup.answerCapture(randomUUID(), data.request, { error: "x" })).toBe(false);
      setup.answerCapture(state.id, data.request, { image: { panel: "board", mediaType: "image/webp", data: "AAAA", width: 400, height: 300, theme: "dark" } });
    });
    expect(await preview({ panel: "board" })).toMatchObject({ content: [
      { type: "text", text: JSON.stringify({ panel: "board", width: 400, height: 300, theme: "dark" }) },
      { type: "image", data: "AAAA", mimeType: "image/webp" },
    ] });
    // It names the draft its preview must show, and when it is too late to answer.
    expect(asked).toEqual([{ projectId: state.projectId, setupId: state.id, request: expect.any(String), panel: "board",
      revision: (await setup.draftRuntimeOf(state.id))!.entry.digest.slice(0, 16), expires: expect.any(Number) }]);
    expect(asked[0]!.expires).toBeGreaterThan(Date.now());
    expect(await preview({ panel: "missing" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no panel missing") }] });
    // The page's reason reaches the agent.
    setup.serveCaptures((_projectId, data) => { setup.answerCapture(state.id, data.request, { error: "Panels can only be captured in the desktop app" }); });
    expect(await preview()).toMatchObject({ isError: true, content: [{ text: "Panels can only be captured in the desktop app" }] });
    // An answer nobody waits for is refused.
    expect(setup.answerCapture(state.id, randomUUID(), { error: "late" })).toBe(false);
  });

  it("restores an uninstalled plugin to a draft and supports reinstalling it after restart", async () => {
    const { setup, directory, services, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id));
    await setup.installDraft(state.id, draft.revision!);
    await services.uninstall(ID);
    const resumed = manager();
    expect(await resumed.read(state.id)).toMatchObject({ status: "ready", pluginId: undefined });
    const preview = await resumed.draft(state.id);
    expect(preview.installedRevision).toBeUndefined();
    expect(preview.files).toEqual(draft.files);
    expect(await resumed.installDraft(state.id, preview.revision!)).toMatchObject({ status: "installed", pluginId: ID });
  });

  it("has no draft once undo takes away the folder the draft was made in", async () => {
    const { setup, directory } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setup.prepare(state.id, root);
    await rm(root, { recursive: true, force: true });
    expect(await setup.draft(state.id)).toEqual({ files: [], errors: [] });
  });

  it("deletes a draft workspace and only that one", async () => {
    const { setup, directory, app, manager } = await environment();
    const first = await setup.create(), second = await setup.create();
    await setup.prepare(first.id, await writeDraft(directory, first.id));
    await setup.prepare(second.id, await writeDraft(directory, second.id));
    const removed = await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${first.id}` });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await app.inject({ method: "GET", url: `/plugins/setup-sessions/${first.id}` })).statusCode).toBe(404);
    await expect(readFile(path.join(directory, "plugin-setup", first.id, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = manager();
    expect((await resumed.list()).map(item => item.id)).toEqual([second.id]);
  });

  it("deletes an installed workspace while preserving its package, settings and ability to edit again", async () => {
    const { setup, directory, app, services, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.installDraft(state.id, draft.revision!);
    await services.configure(ID, { key: "saved-key" });
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(204);
    await expect(readFile(path.join(directory, "plugin-setup", state.id, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = manager();
    const editing = await resumed.create(ID, "edit");
    expect(editing).toMatchObject({ mode: "edit", pluginId: ID, status: "installed", title: "Design Review" });
    const root = path.join(directory, "plugin-setup", editing.id, "workspace", "design-review");
    expect((await resumed.draft(editing.id)).revision).toBe((await resumed.draft(editing.id)).installedRevision);
    await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Updated review.\n---\nNew instructions.");
    const updated = await resumed.draft(editing.id);
    await resumed.installDraft(editing.id, updated.revision!);
    expect(services.index.versions(ID)).toHaveLength(1);
    expect(services.values.forNative(services.index.get(ID)!).key).toBe("saved-key");
    expect(await readFile(path.join(services.index.get(ID)!.root, "skills/review/SKILL.md"), "utf8")).toContain("New instructions");
  });

  it("only edits installed personal plugins", async () => {
    const { setup, directory, services } = await environment();
    await expect(setup.create("personal/not-installed", "edit")).rejects.toThrow("Select an installed plugin");
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setManifest(root, manifest => { manifest.id = "acme/design-review"; });
    await services.installManaged(root);
    await expect(setup.create("acme/design-review", "edit")).rejects.toThrow("Only a plugin you made");
  });

  it("leaves out sessions that configured an older kind of plugin", async () => {
    const { setup, directory } = await environment();
    const id = "11111111-2222-4333-8444-555555555555";
    await mkdir(path.join(directory, "plugin-setup", id), { recursive: true });
    await writeFile(path.join(directory, "plugin-setup", id, "state.json"), JSON.stringify({ id, mode: "configure", pluginId: "personal:tool" }));
    expect(await setup.list()).toEqual([]);
    await expect(setup.read(id)).rejects.toThrow("no longer available");
    // A plugin to work on opens the person's own one to edit; there is no configuring mode.
    await expect(setup.create("personal:tool")).rejects.toThrow("Select an installed plugin");
  });

  it("moves a workspace from before projects into one, conversation and all, once", async () => {
    const { setup, directory, manager, projects } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id));
    const workspace = path.join(directory, "plugin-setup", state.id);
    const stored = JSON.parse(await readFile(path.join(workspace, "state.json"), "utf8"));
    delete stored.projectId;
    await writeFile(path.join(workspace, "state.json"), JSON.stringify({ ...stored, status: "working", model: { provider: "fixture", id: "model" } }));
    projects.all.clear();
    const history = SessionManager.create(path.join(workspace, "workspace"), path.join(workspace, "sessions"));
    history.appendMessage({ role: "user", content: "Review my plugin", timestamp: Date.now() });
    history.appendMessage({ role: "assistant", content: [{ type: "text", text: "Reviewed." }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const resumed = manager();
    const [read, listed] = await Promise.all([resumed.read(state.id), resumed.list()]);
    expect(projects.all.size).toBe(1);
    expect(listed[0]?.projectId).toBe(read.projectId);
    expect(read).toMatchObject({ status: "ready", title: "Design Review" });
    const project = projects.get(read.projectId)!;
    const moved = SessionManager.continueRecent(project.workspacePath, path.join(project.storagePath!, "session"));
    expect(moved.getBranch().some(entry => entry.type === "message" && entry.message.role === "user")).toBe(true);
    await expect(readFile(path.join(workspace, "sessions"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await manager().read(state.id)).projectId).toBe(read.projectId);
    expect((await resumed.draft(state.id)).revision).toBe(draft.revision);
  });

  it("rejects overwriting another draft's installed plugin and rejects updates from an outdated editing workspace", async () => {
    const { setup, directory } = await environment();
    const first = await setup.create();
    const draft = await setup.prepare(first.id, await writeDraft(directory, first.id));
    await setup.installDraft(first.id, draft.revision!);
    const second = await setup.create();
    const other = await setup.prepare(second.id, await writeDraft(directory, second.id));
    await expect(setup.installDraft(second.id, other.revision!)).rejects.toThrow("already installed");
    const editing = await setup.create(ID, "edit");
    await writeFile(path.join(directory, "plugin-setup", first.id, "workspace", "design-review", "skills/review/SKILL.md"), "---\nname: review\ndescription: New review.\n---\nChanged outside the editing workspace.");
    await setup.installDraft(first.id, (await setup.draft(first.id)).revision!);
    await expect(setup.installDraft(editing.id, (await setup.draft(editing.id)).revision!)).rejects.toThrow("installed plugin changed");
  });

  it("blocks deleting a workspace with an in-progress test", async () => {
    const { setup, directory, app, services } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = services.draftMcpServer.bind(services);
    const spy = vi.spyOn(services, "draftMcpServer").mockImplementation(async (...args) => { await gate; return server(...args); });
    const testing = setup.testDraft(state.id, "api", draft.revision!);
    try {
      await vi.waitFor(async () => expect((await setup.read(state.id)).status).toBe("working"));
      expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(409);
    } finally { release(); await testing; spy.mockRestore(); }
    expect((await setup.read(state.id)).status).toBe("ready");
  });

  it("waits for the agent of a workspace's project before deleting or installing", async () => {
    const { setup, directory, app, projects } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id));
    projects.working.add(state.projectId);
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(409);
    await expect(setup.installDraft(state.id, draft.revision!)).rejects.toThrow("Wait for the builder");
    projects.working.delete(state.projectId);
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(204);
    expect(projects.get(state.projectId)).toBeUndefined();
  });

  it("tests a draft's MCP server without installing it, using the settings saved for it", async () => {
    const { setup, directory, services, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id, true);
    const draft = await setup.prepare(state.id, root);
    // It needs a setting that can't be filled in until it is installed.
    const waiting = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/test/api`, payload: { revision: draft.revision } });
    expect(waiting.json()).toMatchObject({ status: "failed", message: expect.stringContaining("Install this draft") });
    expect((await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/test/missing`, payload: { revision: draft.revision } })).statusCode).toBe(400);
    expect(services.index.entries()).toEqual([]);

    await setup.installDraft(state.id, draft.revision!);
    await services.configure(ID, { key: "private-test-key" });
    const tested = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/test/api`, payload: { revision: draft.revision } });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ status: "connected", toolCount: 1 });
    expect((await setup.draft(state.id)).checks?.api).toMatchObject({ revision: draft.revision, result: { status: "connected" } });
    expect(await readFile(path.join(directory, "plugin-setup", state.id, "state.json"), "utf8")).not.toContain("private-test-key");
  });

  it("keeps saved settings from a draft that names an installed plugin", async () => {
    const { setup, directory, services } = await environment();
    const owner = await setup.create();
    const root = await writeDraft(directory, owner.id, true);
    const draft = await setup.prepare(owner.id, root);
    await setup.installDraft(owner.id, draft.revision!);
    await services.configure(ID, { key: "private-test-key" });
    const probed = vi.spyOn(services, "draftMcpServer");

    // Another workspace names the same plugin.
    const other = await setup.create();
    const copy = await setup.prepare(other.id, await writeDraft(directory, other.id, true));
    expect(await setup.testDraft(other.id, "api", copy.revision!)).toMatchObject({ status: "failed", message: expect.stringContaining("Install this draft") });
    expect((await probed.mock.results.at(-1)!.value).secrets).toEqual([]);

    // Its own workspace changed the package since the person installed it.
    await setManifest(root, manifest => { manifest.description = "Changed after review"; });
    const changed = await setup.draft(owner.id);
    expect(await setup.testDraft(owner.id, "api", changed.revision!)).toMatchObject({ status: "failed" });
    expect((await probed.mock.results.at(-1)!.value).secrets).toEqual([]);
  });

  it("lets one of two workspaces install a name both chose", async () => {
    const { setup, directory, services } = await environment();
    const first = await setup.create(), second = await setup.create();
    const [one, two] = [await setup.prepare(first.id, await writeDraft(directory, first.id)), await setup.prepare(second.id, await writeDraft(directory, second.id))];
    const results = await Promise.allSettled([setup.installDraft(first.id, one.revision!), setup.installDraft(second.id, two.revision!)]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(services.index.versions(ID)).toHaveLength(1);
  });
});

/**
 * GitHub's device flow and the parts of its REST API publishing uses, in
 * memory: `answers` are what the token endpoint says, one poll each.
 */
function fakeGitHub(login = "Octo", answers: Record<string, unknown>[] = [{ access_token: "gho_valid" }]) {
  type Repo = { full_name: string; default_branch: string; topics: string[]; fork: boolean; private: boolean; html_url: string;
    head?: string; files: Map<string, Buffer>; tags: Set<string>; releases: { tag: string; commit?: string; assets: { name: string; bytes: Buffer }[] }[] };
  const repos = new Map<string, Repo>();
  const objects = new Map<string, unknown>();
  let token = "gho_valid";
  let failUpload = false;
  let workflowFirst = false;
  let next = 0;
  const sha = () => (++next).toString(16).padStart(40, "0");
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" && url.host === "api.github.com" ? JSON.parse(init.body) : init.body;
    if (url.href === "https://github.com/login/device/code") return Response.json({ device_code: "device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    if (url.href === "https://github.com/login/oauth/access_token") {
      const answer = answers.shift() ?? { error: "expired_token" };
      return typeof answer.status === "number" ? new Response("Bad gateway", { status: answer.status }) : Response.json(answer);
    }
    if ((init.headers as Record<string, string>).authorization !== `Bearer ${token}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.host === "uploads.github.com") {
      if (failUpload) { failUpload = false; return Response.json({ message: "Server Error" }, { status: 502 }); }
      const [, owner, name, , id] = url.pathname.split("/").slice(1);
      const assets = repos.get(`${owner}/${name}`.toLowerCase())!.releases[Number(id)]!.assets;
      // The release workflow attached its package first.
      if (workflowFirst) {
        workflowFirst = false;
        assets.push({ name: url.searchParams.get("name")!, bytes: Buffer.from("from the workflow") });
        return Response.json({ message: "Validation Failed", errors: [{ resource: "ReleaseAsset", code: "already_exists", field: "name" }] }, { status: 422 });
      }
      assets.push({ name: url.searchParams.get("name")!, bytes: Buffer.from(body as Uint8Array) });
      return Response.json({}, { status: 201 });
    }
    const route = `${method} ${url.pathname}`;
    if (route === "GET /user") return Response.json({ login });
    if (route === "POST /user/repos") {
      const key = `${login}/${body.name}`.toLowerCase();
      if (repos.has(key)) return Response.json({ message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] }, { status: 422 });
      repos.set(key, { full_name: `${login}/${body.name}`, default_branch: "main", topics: [], fork: false, private: body.private, html_url: `https://github.com/${login}/${body.name}`, files: new Map(), tags: new Set(), releases: [] });
      return Response.json(repos.get(key), { status: 201 });
    }
    const [, owner, name, ...rest] = url.pathname.split("/").slice(1);
    const repo = repos.get(`${owner}/${name}`.toLowerCase());
    if (!repo || repo.private) return Response.json({ message: "Not Found" }, { status: 404 });
    const part = rest.join("/");
    if (route === `GET /repos/${owner}/${name}`) return Response.json(repo);
    if (part === `git/ref/heads/${repo.default_branch}`) return repo.head ? Response.json({ object: { sha: repo.head } }) : Response.json({ message: "Git Repository is empty." }, { status: 409 });
    if (method === "GET" && part.startsWith("git/ref/tags/")) {
      const tagged = repo.releases.find((release) => release.tag === part.slice("git/ref/tags/".length));
      return tagged ? Response.json({ object: { sha: tagged.commit ?? "tagged" } }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (part.startsWith("contents/")) {
      const file = part.slice("contents/".length);
      if (method === "PUT") {
        repo.files = new Map([[file, Buffer.from(body.content, "base64")]]);
        repo.head = commitOf(repo.files);
        return Response.json({ commit: { sha: repo.head } }, { status: 201 });
      }
      const bytes = repo.files.get(file);
      return bytes ? Response.json({ content: bytes.toString("base64") }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const made = (value: unknown) => { const key = sha(); objects.set(key, value); return Response.json({ sha: key }, { status: 201 }); };
    if (route.endsWith("/git/blobs")) return made(Buffer.from(body.content, "base64"));
    // A tree is the files it holds: its base tree's, then its own.
    if (route.endsWith("/git/trees")) {
      const files = new Map(body.base_tree ? objects.get(body.base_tree) as Map<string, Buffer> : []);
      for (const item of body.tree as { path: string; sha: string | null }[])
        if (item.sha === null) files.delete(item.path);
        else files.set(item.path, objects.get(item.sha) as Buffer);
      return made(files);
    }
    if (method === "GET" && part.startsWith("git/trees/"))
      return Response.json({ tree: [...(objects.get(part.slice("git/trees/".length)) as Map<string, Buffer>)].map(([file, bytes]) => ({
        path: file, type: "blob", mode: "100644", sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") })) });
    if (method === "GET" && part.startsWith("git/commits/")) return Response.json({ tree: { sha: objects.get(part.slice("git/commits/".length)) } });
    if (route.endsWith("/git/commits")) return body.parents[0] === repo.head ? made(body.tree) : Response.json({ message: "stale parent" }, { status: 422 });
    if (method === "PATCH" && part === `git/refs/heads/${repo.default_branch}`) {
      repo.files = new Map(objects.get(objects.get(body.sha) as string) as Map<string, Buffer>);
      repo.head = body.sha;
      return Response.json({});
    }
    if (method === "GET" && part.startsWith("releases/tags/")) {
      const id = repo.releases.findIndex((release) => release.tag === part.slice("releases/tags/".length));
      return id < 0 ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(release(owner!, name!, id));
    }
    if (method === "PUT" && part === "topics") { repo.topics = body.names; return Response.json({ names: body.names }); }
    if (method === "POST" && part === "releases") {
      if (repo.tags.has(body.tag_name)) return Response.json({ message: "Validation Failed", errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }] }, { status: 422 });
      repo.tags.add(body.tag_name);
      repo.releases.push({ tag: body.tag_name, commit: body.target_commitish, assets: [] });
      return Response.json(release(owner!, name!, repo.releases.length - 1), { status: 201 });
    }
    throw new Error(`Unexpected request: ${route}`);
  });
  /** A commit, made on GitHub, of these files. */
  function commitOf(files: Map<string, Buffer>): string {
    const tree = sha();
    objects.set(tree, new Map(files));
    const commit = sha();
    objects.set(commit, tree);
    return commit;
  }
  function release(owner: string, name: string, id: number) {
    const repo = repos.get(`${owner}/${name}`.toLowerCase())!;
    const { tag, assets } = repo.releases[id]!;
    return { upload_url: `https://uploads.github.com/repos/${owner}/${name}/releases/${id}/assets{?name,label}`, html_url: `${repo.html_url}/releases/tag/${tag}`, assets: assets.map((asset) => ({ name: asset.name })) };
  }
  return { fetch, repos, commitOf, revoke: () => { token = "revoked"; }, failNextUpload: () => { failUpload = true; }, workflowAttachesFirst: () => { workflowFirst = true; } };
}

describe("Publishing to GitHub", () => {
  async function account(github: ReturnType<typeof fakeGitHub>) {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-github-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PluginConfigurationStore(directory);
    await store.load();
    const waits: number[] = [];
    const signedIn = new GitHubAccount(store, { fetch: github.fetch as typeof fetch, wait: async (ms) => { waits.push(ms); } });
    return { account: signedIn, store, waits, directory };
  }
  const settled = (account: GitHubAccount) => vi.waitFor(() => expect(account.view().signIn).toBeUndefined());

  it("signs in with the device flow, waiting as GitHub asks, keeps the token encrypted and signs out", async () => {
    // A failed request in between doesn't end it.
    const github = fakeGitHub("Octo", [{ error: "authorization_pending" }, { status: 502 }, { error: "slow_down", interval: 10 }, { access_token: "gho_valid" }]);
    const { account: signedIn, waits, directory } = await account(github);
    expect(signedIn.view()).toEqual({});
    expect(await signedIn.signIn()).toMatchObject({ signIn: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" } });
    await settled(signedIn);
    expect(signedIn.view()).toEqual({ login: "Octo" });
    expect(waits).toEqual([5000, 5000, 5000, 10000]);
    expect(String(github.fetch.mock.calls[0]![1]!.body)).toBe("client_id=Ov23liAF11z3jirdi7hJ&scope=public_repo");
    expect(await readFile(path.join(directory, "plugin-configuration.json"), "utf8")).not.toContain("gho_valid");
    await signedIn.signOut();
    expect(signedIn.view()).toEqual({});
  });

  it.each([
    ["expired_token", "The code expired"],
    ["access_denied", "cancelled on GitHub"],
  ])("says why a sign-in didn't finish: %s", async (error, message) => {
    const { account: signedIn } = await account(fakeGitHub("Octo", [{ error: "authorization_pending" }, { error }]));
    await signedIn.signIn();
    await settled(signedIn);
    expect(signedIn.view()).toEqual({ error: expect.stringContaining(message) });
  });

  it("makes the repository and a release the market lists, then releases a new version there, never one twice", async () => {
    const { setup, directory, services } = await environment();
    const root = await writeDraft(directory, (await setup.create()).id);
    await writeFile(path.join(root, "skills/review/notes.md"), "Notes");
    await services.installPersonal(root, { consent: false });
    const github = fakeGitHub();
    const { account: signedIn } = await account(github);
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("Sign in to GitHub first");
    await signedIn.signIn();
    await settled(signedIn);

    expect(await signedIn.publish(services.index.get(ID)!)).toEqual({
      id: "octo/design-review", version: "0.1.0",
      repository: "https://github.com/Octo/design-review", release: "https://github.com/Octo/design-review/releases/tag/v0.1.0",
    });
    const repo = github.repos.get("octo/design-review")!;
    expect(repo).toMatchObject({ private: false, topics: ["ohmygame-plugin"], tags: new Set(["v0.1.0"]) });
    expect([...repo.files.keys()].sort()).toEqual([".ohmygame-plugin/plugin.json", "README.md", "package.json", "skills/review/SKILL.md", "skills/review/notes.md"]);
    // The market's judgement: one .zip, the package at its top, its id the owner's and its version the tag's.
    const [asset] = repo.releases[0]!.assets;
    expect(repo.releases[0]!.assets.map((item) => item.name)).toEqual(["design-review-v0.1.0.zip"]);
    const unpacked = path.join(directory, "unpacked");
    await writeFile(path.join(directory, "release.zip"), asset!.bytes);
    await extractArchive(path.join(directory, "release.zip"), unpacked, { maxEntries: 100, maxBytes: 1e7, error: (reason) => new Error(reason) });
    const indexed = await indexPluginPackage(unpacked);
    expect(indexed.ok && [indexed.entry.id, indexed.entry.version]).toEqual(["octo/design-review", "0.1.0"]);
    expect(services.index.entries().map((item) => item.id)).toEqual([ID]);

    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("Version 0.1.0 of octo/design-review is already released on GitHub. Raise the plugin's version");
    expect(repo.releases).toHaveLength(1);

    // A license added on GitHub stays.
    repo.head = github.commitOf(new Map([...repo.files, ["LICENSE", Buffer.from("MIT")]]));
    repo.files.set("LICENSE", Buffer.from("MIT"));
    // A file the plugin no longer has leaves the repository.
    await rm(path.join(root, "skills/review/notes.md"));
    await setManifest(root, (manifest) => { manifest.version = "0.2.0"; });
    await services.installPersonal(root, { consent: false });
    // An upload that fails leaves a release without its package, which publishing again completes,
    // with the package its commit holds only.
    github.failNextUpload();
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("Server Error");
    const skill = path.join(root, "skills/review/SKILL.md");
    const original = await readFile(skill, "utf8");
    await writeFile(skill, `${original}\nChanged since.\n`);
    await services.installPersonal(root, { consent: false });
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("already released");
    await writeFile(skill, original);
    await services.installPersonal(root, { consent: false });
    await signedIn.publish(services.index.get(ID)!);
    expect(github.fetch.mock.calls.filter(([url, init]) => String(url).endsWith("/user/repos") && init?.method === "POST")).toHaveLength(1);
    expect(repo.files.get("LICENSE")?.toString()).toBe("MIT");
    expect(repo.files.has("skills/review/notes.md")).toBe(false);
    expect(repo.releases.map((release) => [release.tag, release.assets.map((item) => item.name)])).toEqual([
      ["v0.1.0", ["design-review-v0.1.0.zip"]], ["v0.2.0", ["design-review-v0.2.0.zip"]],
    ]);
    expect(JSON.parse(repo.files.get(".ohmygame-plugin/plugin.json")!.toString())).toMatchObject({ id: "octo/design-review", version: "0.2.0" });

    // The release workflow attaching its package first is a release with its package.
    await setManifest(root, (manifest) => { manifest.version = "0.3.0"; });
    await services.installPersonal(root, { consent: false });
    github.workflowAttachesFirst();
    expect(await signedIn.publish(services.index.get(ID)!)).toMatchObject({ version: "0.3.0" });
    expect(repo.releases[2]!.assets.map((item) => item.name)).toEqual(["design-review-v0.3.0.zip"]);
  });

  it("stops a sign-in that GitHub hadn't answered yet when signing out", async () => {
    const github = fakeGitHub();
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-github-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new PluginConfigurationStore(directory);
    await store.load();
    const signedIn = new GitHubAccount(store, { wait: async () => {}, fetch: (async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/login/device/code")) await held;
      return github.fetch(input, init);
    }) as typeof fetch });
    const first = signedIn.signIn();
    const second = signedIn.signIn();
    await signedIn.signOut();
    answer();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signedIn.view()).toEqual({});
    expect(github.fetch.mock.calls.some(([url]) => String(url).endsWith("/login/oauth/access_token"))).toBe(false);
  });

  it("won't publish a package that leaves out what its manifest names", async () => {
    const { setup, directory, services } = await environment();
    const root = await writeDraft(directory, (await setup.create()).id);
    // npm's rules leave out what a folder's .gitignore names, so the release wouldn't hold the Skill.
    await writeFile(path.join(root, "skills/review/.gitignore"), "SKILL.md\n");
    await services.installPersonal(root, { consent: false });
    const github = fakeGitHub();
    const { account: signedIn } = await account(github);
    await signedIn.signIn();
    await settled(signedIn);
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("The package isn't valid");
    expect(github.repos.size).toBe(0);
  });

  it("won't publish into a repository of that name that isn't this plugin", async () => {
    const { setup, directory, services } = await environment();
    await services.installPersonal(await writeDraft(directory, (await setup.create()).id), { consent: false });
    const github = fakeGitHub();
    const { account: signedIn } = await account(github);
    await signedIn.signIn();
    await settled(signedIn);
    github.repos.set("octo/design-review", { full_name: "Octo/design-review", default_branch: "main", topics: [], fork: false, private: false, html_url: "", head: "1",
      files: new Map([[".ohmygame-plugin/plugin.json", Buffer.from(JSON.stringify({ id: "octo/other" }))]]), tags: new Set(), releases: [] });
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("already has a repository named design-review that isn't this plugin");
    // A private one the token can't see.
    github.repos.get("octo/design-review")!.private = true;
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("isn't this plugin");
  });

  it("asks to sign in again when GitHub no longer takes the token", async () => {
    const { setup, directory, services } = await environment();
    await services.installPersonal(await writeDraft(directory, (await setup.create()).id), { consent: false });
    const github = fakeGitHub();
    const { account: signedIn } = await account(github);
    await signedIn.signIn();
    await settled(signedIn);
    github.revoke();
    await expect(signedIn.publish(services.index.get(ID)!)).rejects.toThrow("Sign in to GitHub again");
    expect(signedIn.view()).toEqual({});
  });
});
