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
import { BundledPluginAdapter, LocalPluginAdapter, PluginCatalogService } from "../src/daemon/plugin-catalog.js";
import { discoverPlugins } from "../src/daemon/plugin-discovery.js";
import { BundledPluginStore } from "../src/daemon/bundled-plugins.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
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
  const bundled = new BundledPluginStore(path.resolve("plugins"));
  await bundled.load();
  const capabilities = new PluginCapabilities(directory, agentDir, [bundled, local], local, settings);
  await capabilities.configuration.load();
  cleanup.push(() => capabilities.host.close());
  const catalog = new PluginCatalogService([new BundledPluginAdapter(bundled), new LocalPluginAdapter(local)], settings);
  const invalidate = vi.fn();
  function manager() { return new PluginSetupManager(directory, agentDir, capabilities, catalog, local, invalidate, async () => { throw new Error("No test model"); }); }
  const setup = manager();
  const app = Fastify();
  registerPluginSetupRoutes(app, setup);
  registerPluginIconRoutes(app, [local]);
  cleanup.push(() => app.close());
  return { directory, agentDir, settings, local, capabilities, setup, manager, app, invalidate };
}
async function writeDraft(directory: string, sessionId: string, mcp = false) {
  const root = path.join(directory, "plugin-setup", sessionId, "workspace", "design-review");
  await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills/review"), { recursive: true });
  await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), JSON.stringify({
    name: "design-review", version: "0.1.0", description: "Review game design documents", skills: "./skills/",
    interface: { displayName: "Design Review", defaultPrompt: ["Review my game design"] },
    ...(mcp ? { mcpServers: "./mcp.json", configuration: { key: { type: "secret", label: "API key", required: true } } } : {}),
  }));
  await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review a game design document.\n---\n\n# Review\n\nRead the document and prioritize improvements.");
  if (mcp) await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { api: {
    command: process.execPath, args: [path.resolve("test/fixtures/plugin-mcp-server.mjs")], env: { API_KEY: "${config.key}" },
  } } }));
  return root;
}

describe("Plugin Builder", () => {
  it("saves preset icons with revision checks and retains them after install and restart", async () => {
    const { setup, directory, local, app, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id));
    const changed = await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: {
      revision: draft.revision, icon: { type: "preset", id: "palette" },
    } });
    expect(changed.statusCode, changed.body).toBe(200);
    const preview = changed.json();
    expect(preview.plugin.icon).toEqual({ type: "preset", id: "palette" });
    expect(preview.revision).not.toBe(draft.revision);
    expect((await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: {
      revision: draft.revision, icon: { type: "preset", id: "image" },
    } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: {
      revision: preview.revision, icon: { type: "preset", id: "invented" },
    } })).statusCode).toBe(409);
    await expect(setup.installDraft(state.id, draft.revision!)).rejects.toThrow("changed");
    await setup.installDraft(state.id, preview.revision);
    expect((await local.read("personal:design-review"))?.icon).toEqual(preview.plugin.icon);
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect((await resumed.draft(state.id)).plugin?.icon).toEqual(preview.plugin.icon);
    const reset = await resumed.updateIcon(state.id, { revision: preview.revision, icon: null });
    expect(reset.plugin?.icon).toBeUndefined();
    expect((await local.read("personal:design-review"))?.icon).toEqual(preview.plugin.icon);
    await resumed.installDraft(state.id, reset.revision!);
    expect((await local.read("personal:design-review"))?.icon).toBeUndefined();
  });

  it.each(["png", "webp"] as const)("uploads, previews, installs and updates %s icons", async format => {
    const { setup, directory, local, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#ed563b" } }).toFormat(format).toBuffer();
    const result = await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/icon`, payload: {
      revision: draft.revision, image: { mediaType: `image/${format}`, data: bytes.toString("base64") },
    } });
    expect(result.statusCode, result.body).toBe(200);
    const preview = result.json();
    expect(preview.plugin.icon).toMatchObject({ type: "asset" });
    expect(await readFile(path.join(root, preview.plugin.icon.path))).toEqual(bytes);
    const icon = await app.inject({ url: `/plugins/setup-sessions/${state.id}/icon` });
    expect(icon.headers["content-type"]).toBe(`image/${format}`);
    expect(icon.headers["x-content-type-options"]).toBe("nosniff");
    expect(icon.rawPayload).toEqual(bytes);
    const pathPreview = await app.inject({ url: `/plugins/setup-sessions/${state.id}/icon?${new URLSearchParams({ path: preview.plugin.icon.path })}` });
    expect(pathPreview.rawPayload).toEqual(bytes);
    await setup.installDraft(state.id, preview.revision);
    const installedIcon = await app.inject({ url: "/plugins/personal%3Adesign-review/icon" });
    expect(installedIcon.rawPayload).toEqual(bytes);
    expect(installedIcon.headers["cache-control"]).toBe("private, no-cache");
    const etag = installedIcon.headers.etag;
    expect(etag).toBe(`"${preview.plugin.iconRevision}"`);
    const unchanged = await app.inject({ url: "/plugins/personal%3Adesign-review/icon", headers: { "if-none-match": `W/${etag}` } });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload.length).toBe(0);
    const installedPath = path.join((await local.installedPath("personal:design-review"))!, preview.plugin.icon.path);
    const replacement = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#386def" } }).toFormat(format).toBuffer();
    await writeFile(installedPath, replacement);
    const modified = await app.inject({ url: "/plugins/personal%3Adesign-review/icon", headers: { "if-none-match": etag } });
    expect(modified.statusCode).toBe(200);
    expect(modified.headers.etag).not.toBe(etag);
    expect(modified.rawPayload).toEqual(replacement);
    await writeFile(installedPath, replacement.subarray(0, 20));
    expect((await app.inject({ url: "/plugins/personal%3Adesign-review/icon", headers: { "if-none-match": modified.headers.etag } })).statusCode).toBe(404);
    expect((await local.read("personal:design-review"))?.icon).toBeUndefined();
    expect((await local.list()).errors).toEqual([]);
    await writeFile(installedPath, bytes);
    const imported = new LocalPluginStore(directory);
    expect((await imported.read("personal:design-review"))?.icon).toEqual(preview.plugin.icon);
    const next = await setup.updateIcon(state.id, { revision: preview.revision, icon: { type: "preset", id: "music" } });
    await setup.installDraft(state.id, next.revision!);
    expect((await app.inject({ url: "/plugins/personal%3Adesign-review/icon" })).statusCode).toBe(404);
    await local.remove("personal:design-review");
    expect((await app.inject({ url: "/plugins/personal%3Adesign-review/icon" })).statusCode).toBe(404);
  });

  it("rejects invalid image contents, large images, missing files and paths outside the package", async () => {
    const { setup, directory, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    await expect(setup.updateIcon(state.id, { revision: draft.revision!, image: { mediaType: "image/png", data: Buffer.from("not an image").toString("base64") } })).rejects.toThrow("PNG or WebP");
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

  it.each(["missing", "oversized", "undecodable"])("loads a plugin with an %s icon while Builder validation stays strict", async kind => {
    const { setup, directory, local } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const manifestPath = path.join(root, ".ohmygame-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.interface.icon = { type: "asset", path: "./assets/icon.png" };
    await writeFile(manifestPath, JSON.stringify(manifest));
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
    const installed = await local.install(root);
    expect(installed.icon).toBeUndefined();
    expect(installed.skills).toHaveLength(1);
    expect((await local.read(installed.id))?.icon).toBeUndefined();
    expect(await local.list()).toMatchObject({ plugins: [{ id: installed.id }], errors: [] });
  });

  it("reuses successful image validation by content while checking each requested media type", async () => {
    const { PhotonImage } = await import("@silvia-odwyer/photon-node");
    const decode = vi.spyOn(PhotonImage, "new_from_byteslice");
    try {
      const bytes = await sharp({ create: { width: 17, height: 13, channels: 4, background: "#40a976" } }).png().toBuffer();
      const [first, second] = await Promise.all([validatePluginIconImage(bytes), validatePluginIconImage(Buffer.from(bytes))]);
      expect(second.revision).toBe(first.revision);
      expect(decode).toHaveBeenCalledTimes(1);
      await expect(validatePluginIconImage(bytes, "image/webp")).rejects.toThrow("PNG or WebP");
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
    const { setup, directory, local, app, invalidate } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    expect(draft).toMatchObject({ plugin: { installed: false, displayName: "Design Review" }, errors: [] });
    expect((await local.list()).plugins).toEqual([]);
    expect((await setup.file(state.id, "skills/review/SKILL.md")).content).toContain("prioritize improvements");
    await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review game documents.\n---\n\nUpdated instructions.");
    const stale = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: draft.revision } });
    expect(stale.statusCode).toBe(409);
    const updated = await setup.draft(state.id);
    expect(updated.revision).not.toBe(draft.revision);
    const installed = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: updated.revision } });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ status: "installed", pluginId: "personal:design-review" });
    expect(invalidate).toHaveBeenCalledOnce();
    expect((await setup.draft(state.id)).installedRevision).toBe(updated.revision);
    expect((await local.list()).plugins).toHaveLength(1);
    await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), "{}");
    expect((await setup.draft(state.id)).errors).not.toEqual([]);
    await expect(setup.installDraft(state.id, updated.revision!)).rejects.toThrow("manifest");
    expect((await local.list()).plugins).toHaveLength(1);
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
    const { setup, directory, local, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id));
    await setup.installDraft(state.id, draft.revision!);
    await local.remove("personal:design-review");
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect(await resumed.read(state.id)).toMatchObject({ status: "ready", pluginId: undefined });
    const preview = await resumed.draft(state.id);
    expect(preview.installedRevision).toBeUndefined();
    expect(preview.files).toEqual(draft.files);
    expect(await resumed.installDraft(state.id, preview.revision!)).toMatchObject({ status: "installed", pluginId: "personal:design-review" });
  });

  it("preserves the latest configuration and cleared secrets through uninstall, restart, and reinstall", async () => {
    const { setup, directory, local, capabilities, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.configuration(state.id, { key: "original-key" });
    await setup.installDraft(state.id, draft.revision!);
    await setup.configuration(state.id, { key: "latest-key" });
    const stored = JSON.parse(await readFile(capabilities.configuration.filePath, "utf8"));
    expect(stored.plugins[`draft:${state.id}`]).toBeUndefined();
    expect(Object.keys(stored.credentials)).toHaveLength(1);
    await local.remove("personal:design-review");
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect((await resumed.configuration(state.id)).configuredSecrets).toEqual(["key"]);
    await resumed.installDraft(state.id, draft.revision!);
    const plugin = (await local.read("personal:design-review"))!;
    expect(capabilities.configuration.resolved(plugin).key).toBe("latest-key");
    await local.remove(plugin.id);
    await resumed.configuration(state.id, { key: null });
    await resumed.installDraft(state.id, draft.revision!);
    expect(capabilities.configuration.view(plugin).configuredSecrets).toEqual([]);
  });

  it("retains an installed package and its draft credentials for retry when configuration promotion fails", async () => {
    const { setup, directory, app, local, capabilities, manager, invalidate } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.configuration(state.id, { key: "draft-private-key" });
    const promote = vi.spyOn(capabilities.configuration, "promoteDraft").mockRejectedValueOnce(new Error("Configuration write failed"));
    const failed = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: draft.revision } });
    expect(failed.statusCode).toBe(409);
    expect(await setup.read(state.id)).toMatchObject({ pluginId: "personal:design-review", status: "error", busy: false, error: "Configuration write failed" });
    expect((await local.list()).plugins).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledOnce();
    expect((await setup.read(state.id)).busy).toBe(false);
    expect((await setup.configuration(state.id)).configuredSecrets).toEqual(["key"]);
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect(await resumed.installDraft(state.id, draft.revision!)).toMatchObject({ status: "installed", pluginId: "personal:design-review", error: undefined });
    expect(capabilities.configuration.resolved((await local.read("personal:design-review"))!).key).toBe("draft-private-key");
    expect((await resumed.draft(state.id)).installedRevision).toBe(draft.revision);
    promote.mockRestore();
  });

  it("does not overwrite installed values when retrying a draft that was already promoted", async () => {
    const { setup, directory, capabilities, local } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.configuration(state.id, { key: "draft-key" });
    await setup.installDraft(state.id, draft.revision!);
    const plugin = (await local.read("personal:design-review"))!;
    await capabilities.configuration.update(plugin, { key: "latest-key" });
    await capabilities.configuration.promoteDraft({ ...draft.plugin!, id: `draft:${state.id}` }, plugin);
    expect(capabilities.configuration.resolved(plugin).key).toBe("latest-key");
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

  it("deletes a draft workspace and only its own saved configuration", async () => {
    const { setup, directory, app, capabilities, manager } = await environment();
    const first = await setup.create(), second = await setup.create();
    await setup.prepare(first.id, await writeDraft(directory, first.id, true));
    await setup.prepare(second.id, await writeDraft(directory, second.id, true));
    await setup.configuration(first.id, { key: "first-private-key" });
    await setup.configuration(second.id, { key: "second-private-key" });
    const removed = await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${first.id}` });
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await app.inject({ method: "GET", url: `/plugins/setup-sessions/${first.id}` })).statusCode).toBe(404);
    await expect(readFile(path.join(directory, "plugin-setup", first.id, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const config = JSON.parse(await readFile(capabilities.configuration.filePath, "utf8"));
    expect(config.plugins[`draft:${first.id}`]).toBeUndefined();
    expect(Object.keys(config.credentials)).toHaveLength(1);
    expect((await setup.configuration(second.id)).configuredSecrets).toEqual(["key"]);
    const resumed = manager(); cleanup.push(() => resumed.close());
    expect((await resumed.list()).map(item => item.id)).toEqual([second.id]);
  });

  it("deletes an installed workspace while preserving its package, configuration and ability to edit again", async () => {
    const { setup, directory, app, local, capabilities, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.configuration(state.id, { key: "saved-key" });
    await setup.installDraft(state.id, draft.revision!);
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(204);
    const plugin = (await local.read("personal:design-review"))!;
    expect(plugin.source).toEqual({ type: "authored" });
    expect(capabilities.configuration.resolved(plugin).key).toBe("saved-key");
    await expect(readFile(path.join(directory, "plugin-setup", state.id, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await setup.close();
    const resumed = manager(); cleanup.push(() => resumed.close());
    const editing = await resumed.create(plugin.id, "edit");
    const root = path.join(directory, "plugin-setup", editing.id, "workspace", plugin.name);
    await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Updated review.\n---\nNew instructions.");
    const updated = await resumed.draft(editing.id);
    await resumed.installDraft(editing.id, updated.revision!);
    expect((await local.list()).plugins.map(item => item.id)).toEqual([plugin.id]);
    expect(capabilities.configuration.resolved((await local.read(plugin.id))!).key).toBe("saved-key");
    expect(await readFile(path.join((await local.installedPath(plugin.id))!, "skills/review/SKILL.md"), "utf8")).toContain("New instructions");
  });

  it("deletes a built-in plugin's configuration workspace and guards configuration mode from authoring", async () => {
    const { setup, app } = await environment();
    const created = await app.inject({ method: "POST", url: "/plugins/setup-sessions", payload: { pluginId: "ohmygame:web-game-studio", mode: "configure" } });
    expect(created.statusCode).toBe(201);
    const state = created.json();
    expect(state.mode).toBe("configure");
    await expect(setup.prepare(state.id, ".")).rejects.toThrow("cannot author");
    await expect(setup.installDraft(state.id, "a".repeat(64))).rejects.toThrow("cannot install");
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(204);
    expect((await setup.list()).map(item => item.id)).not.toContain(state.id);
    await expect(setup.create("ohmygame:web-game-studio", "edit")).rejects.toThrow("Public");
    expect((await setup.create("ohmygame:web-game-studio")).mode).toBe("configure");
  });

  it("deletes conversation history across restart while retaining the draft and its credentials", async () => {
    const { setup, directory, app, manager } = await environment();
    const state = await setup.create();
    const draft = await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    await setup.configuration(state.id, { key: "draft-key" });
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
    expect((await resumed.configuration(state.id)).configuredSecrets).toEqual(["key"]);
    const restarted = manager(); cleanup.push(() => restarted.close());
    expect((await restarted.read(state.id)).turns).toEqual([]);
    expect((await restarted.draft(state.id)).revision).toBe(draft.revision);
  });

  it("edits a Codex marketplace import in place and keeps its identity when reinstalling the edited draft", async () => {
    const { setup, directory, local } = await environment();
    const source = path.join(directory, "imported");
    await mkdir(path.join(source, ".codex-plugin"), { recursive: true });
    await mkdir(path.join(source, "skills/review"), { recursive: true });
    await writeFile(path.join(source, ".codex-plugin/plugin.json"), JSON.stringify({ name: "review", description: "Review designs", skills: "./skills/" }));
    await writeFile(path.join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review designs.\n---\nReview carefully.");
    const candidate = (await discoverPlugins(source))[0]!;
    const plugin = await local.install(source, { type: "directory", path: source }, candidate.manifest, { id: "game-tools", displayName: "Game Tools" });
    const editing = await setup.create(plugin.id, "edit");
    const draft = await setup.draft(editing.id);
    expect(draft.errors).toEqual([]);
    expect(draft.plugin).toMatchObject({ id: plugin.id, marketplace: plugin.marketplace });
    const older = await setup.create(plugin.id, "edit");
    const file = path.join(directory, "plugin-setup", editing.id, "workspace", "review", "skills/review/SKILL.md");
    await writeFile(file, "---\nname: review\ndescription: Review designs.\n---\nUpdated imported instructions.");
    await setup.installDraft(editing.id, (await setup.draft(editing.id)).revision!);
    expect((await local.list()).plugins.map(item => item.id)).toEqual([plugin.id]);
    await expect(readFile(path.join(directory, "plugin-setup", editing.id, "workspace", "review", ".codex-plugin/plugin.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(setup.installDraft(older.id, (await setup.draft(older.id)).revision!)).rejects.toThrow("installed plugin changed");
    await local.remove(plugin.id);
    expect((await setup.read(editing.id)).pluginId).toBeUndefined();
    const reinstalled = await setup.installDraft(editing.id, (await setup.draft(editing.id)).revision!);
    expect(reinstalled.pluginId).toBe(plugin.id);
    expect((await local.read(plugin.id))!.marketplace).toEqual(plugin.marketplace);
  });

  it("rejects overwriting another draft's installed plugin and rejects updates from an outdated editing workspace", async () => {
    const { setup, directory } = await environment();
    const first = await setup.create();
    const draft = await setup.prepare(first.id, await writeDraft(directory, first.id));
    await setup.installDraft(first.id, draft.revision!);
    const second = await setup.create();
    const other = await setup.prepare(second.id, await writeDraft(directory, second.id));
    await expect(setup.installDraft(second.id, other.revision!)).rejects.toThrow("already installed");
    const editing = await setup.create("personal:design-review", "edit");
    await writeFile(path.join(directory, "plugin-setup", first.id, "workspace", "design-review", "skills/review/SKILL.md"), "---\nname: review\ndescription: New review.\n---\nChanged outside the editing workspace.");
    await setup.installDraft(first.id, (await setup.draft(first.id)).revision!);
    await expect(setup.installDraft(editing.id, (await setup.draft(editing.id)).revision!)).rejects.toThrow("installed plugin changed");
  });

  it("blocks deleting a workspace with an in-progress configuration operation", async () => {
    const { setup, directory, app, capabilities } = await environment();
    const state = await setup.create();
    await setup.prepare(state.id, await writeDraft(directory, state.id, true));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const update = capabilities.configuration.update.bind(capabilities.configuration);
    const spy = vi.spyOn(capabilities.configuration, "update").mockImplementation(async (...args) => { await gate; return update(...args); });
    const saving = setup.configuration(state.id, { key: "private-key" });
    try {
      await vi.waitFor(async () => expect((await setup.read(state.id)).busy).toBe(true));
      expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(409);
    } finally { release(); await saving; spy.mockRestore(); }
    expect((await setup.read(state.id)).busy).toBe(false);
  });

  it("configures and probes a draft without installing it or exposing credentials, and invalidates checks after configuration changes", async () => {
    const { setup, directory, local, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id, true);
    const draft = await setup.prepare(state.id, root);
    expect((await setup.configuration(state.id)).missing).toEqual(["key"]);
    const saved = await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/configuration`, payload: { values: { key: "private-test-key" } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain("private-test-key");
    const other = await setup.create();
    await setup.prepare(other.id, await writeDraft(directory, other.id, true));
    expect((await setup.configuration(other.id)).missing).toEqual(["key"]);
    const tested = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/test/api`, payload: { revision: draft.revision } });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ status: "connected", toolCount: 1 });
    expect((await setup.draft(state.id)).checks?.api).toMatchObject({ revision: draft.revision, result: { status: "connected" } });
    expect((await local.list()).plugins).toHaveLength(0);
    const metadata = await readFile(path.join(directory, "plugin-setup", state.id, "state.json"), "utf8");
    expect(metadata).not.toContain("private-test-key");
    expect(await readFile(path.join(root, "mcp.json"), "utf8")).not.toContain("private-test-key");
    await setup.configuration(state.id, { key: "replacement-key" });
    expect((await setup.draft(state.id)).checks).toEqual({});
    await setup.installDraft(state.id, draft.revision!);
    expect((await setup.configuration(state.id)).configuredSecrets).toEqual(["key"]);
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
