import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSetupManager, registerPluginSetupRoutes } from "../src/daemon/plugin-setup.js";
import { PluginCapabilities } from "../src/daemon/plugin-capabilities.js";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { LocalPluginAdapter, PluginCatalogService } from "../src/daemon/plugin-catalog.js";
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
  const capabilities = new PluginCapabilities(directory, agentDir, [local], local, settings);
  await capabilities.configuration.load();
  cleanup.push(() => capabilities.host.close());
  const catalog = new PluginCatalogService([new LocalPluginAdapter(local)], settings);
  const invalidate = vi.fn();
  function manager() { return new PluginSetupManager(directory, agentDir, capabilities, catalog, local, invalidate, async () => { throw new Error("No test model"); }); }
  const setup = manager();
  const app = Fastify();
  registerPluginSetupRoutes(app, setup);
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
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(409);
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

  it("blocks workspace deletion while its plugin is installed", async () => {
    const { setup, directory, app, local } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    await setup.installDraft(state.id, draft.revision!);
    const blocked = await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("Uninstall");
    expect(await setup.file(state.id, "skills/review/SKILL.md")).toHaveProperty("content");
    expect((await local.list()).plugins).toHaveLength(1);
    await local.remove("personal:design-review");
    expect((await app.inject({ method: "DELETE", url: `/plugins/setup-sessions/${state.id}` })).statusCode).toBe(204);
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
