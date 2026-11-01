import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { registerPluginIconRoutes, validatePluginIconImage } from "../src/daemon/plugin-icons.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSetupManager, registerPluginSetupRoutes } from "../src/daemon/plugin-setup.js";
import { PluginCapabilities } from "../src/daemon/plugin-capabilities.js";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { LocalPluginAdapter, PluginCatalogService } from "../src/daemon/plugin-catalog.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { loadSkills, SessionManager } from "@earendil-works/pi-coding-agent";
import { readPluginBuilderInput, savePluginBuilderInput } from "../src/renderer/plugin-builder-drafts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-builder-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  const settings = new PluginSettingsStore(directory);
  await settings.load();
  const local = new LocalPluginStore(directory);
  const capabilities = new PluginCapabilities(directory, agentDir, [local], local, settings);
  await capabilities.configuration.load();
  cleanup.push(() => capabilities.host.close());
  const catalog = new PluginCatalogService([new LocalPluginAdapter(local)], settings);
  const invalidate = vi.fn();
  const services = new PluginServices({ directory: path.join(directory, "plugin-store") });
  cleanup.push(() => services.close());
  function manager() { return new PluginSetupManager(directory, agentDir, capabilities, catalog, services, invalidate, async () => { throw new Error("No test model"); }); }
  const setup = manager();
  const app = Fastify();
  registerPluginSetupRoutes(app, setup);
  registerPluginIconRoutes(app, [local]);
  cleanup.push(() => app.close());
  return { directory, agentDir, settings, local, capabilities, services, setup, manager, app, invalidate };
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
      plugin: { id: ID, version: "0.1.0", displayName: "Design Review", appWide: true, asks: [], settings: false, mcpServers: [], skills: [{ id: "skills/review/SKILL.md", name: "review" }] },
    });
    const withServer = await setup.create();
    const draft = await setup.prepare(withServer.id, await writeDraft(directory, withServer.id, true));
    expect(draft.errors).toEqual([]);
    expect(draft.plugin).toMatchObject({ appWide: false, settings: true, mcpServers: [{ id: "api", title: "API" }] });
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

  it("replaces older versions of a plugin that only adds Skills, and keeps them for any other", async () => {
    const { setup, directory, services } = await environment();
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
    await setManifest(withServer, manifest => { manifest.version = "0.2.0"; });
    await setup.installDraft(other.id, (await setup.draft(other.id)).revision!);
    expect(services.index.versions("personal/design-tools").map(entry => entry.version)).toEqual(["0.2.0", "0.1.0"]);
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
    expect((await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: { revision: preview.revision, icon: { type: "preset", id: "image" } } })).statusCode).toBe(409);
    await expect(setup.installDraft(state.id, draft.revision!)).rejects.toThrow("changed");
    await setup.installDraft(state.id, preview.revision);
    expect(services.index.get(ID)?.manifest.icon).toBe("./assets/icon.svg");
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect((await resumed.draft(state.id)).plugin?.icon).toEqual(asset);
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

  it("keeps new workspaces separate, lists them after restart, and retains interrupted status", async () => {
    const { setup, directory, manager } = await environment();
    const first = await setup.create(), second = await setup.create();
    expect(second.id).not.toBe(first.id);
    await setup.close();
    const file = path.join(directory, "plugin-setup", first.id, "state.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stored, status: "working", busy: true, model: { provider: "fixture", id: "model" } }));
    const resumed = manager(); cleanup.push(() => resumed.close());
    const listed = await resumed.list();
    expect(listed).toHaveLength(2);
    expect(listed.find(item => item.id === first.id)).toMatchObject({ status: "interrupted", model: { provider: "fixture", id: "model" } });
    expect((await resumed.read(first.id)).busy).toBe(false);
  });

  it("previews and validates an uninstalled draft, rejects a stale revision, and installs the reviewed version", async () => {
    const { setup, directory, services, app, invalidate } = await environment();
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
    const installed = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: updated.revision } });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ status: "installed", pluginId: ID });
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

  it("restores an uninstalled plugin to a draft and supports reinstalling it after restart", async () => {
    const { setup, directory, services, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id));
    await setup.installDraft(state.id, draft.revision!);
    await services.uninstall(ID);
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect(await resumed.read(state.id)).toMatchObject({ status: "ready", pluginId: undefined });
    const preview = await resumed.draft(state.id);
    expect(preview.installedRevision).toBeUndefined();
    expect(preview.files).toEqual(draft.files);
    expect(await resumed.installDraft(state.id, preview.revision!)).toMatchObject({ status: "installed", pluginId: ID });
  });

  it("lists workspace metadata without loading conversation history", async () => {
    const { setup, manager } = await environment();
    const state = await setup.create();
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
    const history = vi.spyOn(SessionManager, "continueRecent");
    try {
      expect((await resumed.list()).map(item => item.id)).toEqual([state.id]);
      expect(history).not.toHaveBeenCalled();
    } finally { history.mockRestore(); }
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
    const resumed = manager(); cleanup.push(() => resumed.close());
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
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
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

  it("deletes a plugin's configuration workspace and guards configuration mode from authoring", async () => {
    const { setup, app, directory, local } = await environment();
    const source = path.join(directory, "public-source");
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify({ name: "public-tool", version: "1.0.0", description: "Public" }));
    const { id } = await local.install(source, { type: "directory", path: source });
    const created = await app.inject({ method: "POST", url: "/plugins/setup-sessions", payload: { pluginId: id, mode: "configure" } });
    expect(created.statusCode).toBe(201);
    const state = created.json();
    expect(state.mode).toBe("configure");
    await expect(setup.prepare(state.id, ".")).rejects.toThrow("cannot author");
    await expect(setup.installDraft(state.id, "a".repeat(64))).rejects.toThrow("cannot install");
    // A format 1 plugin stays what it is: it can be configured, not rebuilt.
    expect(await setup.read(state.id)).toMatchObject({ pluginId: id });
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(204);
    expect((await setup.list()).map(item => item.id)).not.toContain(state.id);
    await expect(setup.create(id, "edit")).rejects.toThrow("Select an installed plugin");
    expect((await setup.create(id)).mode).toBe("configure");
  });

  it("deletes conversation history across restart while retaining the draft", async () => {
    const { setup, directory, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.close();
    const history = SessionManager.continueRecent(path.join(directory, "plugin-setup", state.id, "workspace"), path.join(directory, "plugin-setup", state.id, "sessions"));
    history.appendMessage({ role: "user", content: "Review my plugin", timestamp: Date.now() });
    history.appendMessage({ role: "assistant", content: [{ type: "text", text: "Reviewed." }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect((await resumed.read(state.id)).turns.length).toBeGreaterThan(0);
    const routes = Fastify(); registerPluginSetupRoutes(routes, resumed); cleanup.push(() => routes.close());
    const cleared = await routes.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}/conversation` });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().turns).toEqual([]);
    expect((await resumed.draft(state.id)).revision).toBe(draft.revision);
    const restarted = manager(); cleanup.push(() => restarted.close());
    expect((await restarted.read(state.id)).turns).toEqual([]);
    expect((await restarted.draft(state.id)).revision).toBe(draft.revision);
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
      await vi.waitFor(async () => expect((await setup.read(state.id)).busy).toBe(true));
      expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(409);
    } finally { release(); await testing; spy.mockRestore(); }
    expect((await setup.read(state.id)).busy).toBe(false);
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

  it("restores unsent input and model selection by workspace, including after malformed storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const input = { prompt: "未发送的请求", model: { provider: "fixture", id: "model" }, reasoningLevel: "high" as const };
    savePluginBuilderInput("one", input, storage);
    expect(readPluginBuilderInput("one", storage)).toEqual(input);
    expect(readPluginBuilderInput("two", storage)).toEqual({ prompt: "" });
    expect(readPluginBuilderInput("one", { getItem: () => "invalid JSON" })).toEqual({ prompt: "" });
  });
});
