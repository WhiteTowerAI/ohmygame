import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PreinstalledPluginManager } from "../src/daemon/preinstalled-plugins.js";
import { packageSkills } from "../src/daemon/plugin-conversion.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";
import { projectFolderKey } from "../src/daemon/project-plugins.js";
import { PluginSources } from "../src/daemon/plugin-sources.js";
import { prepareNpmPlugin, isLockedNpmPlugin } from "../scripts/preinstalled-npm.js";
import { create as createTar } from "tar";
import { unpackPlugin } from "../src/daemon/plugin-pack.js";
import { PluginServices } from "../src/daemon/plugin-services.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("preinstalled plugins", () => {
  it("waits for first-run plugin installation beyond the default ten-second hook timeout", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-slow-");
    const bundledPluginsDirectory = await temporary("ohmygame-preinstalled-bundled-");
    let started!: () => void;
    const installing = new Promise<void>((resolve) => { started = resolve; });
    const seed = vi.spyOn(PreinstalledPluginManager.prototype, "seed").mockImplementation(async () => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 10_001));
      return [];
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const app = createApp({ dataDirectory, bundledPluginsDirectory });
      apps.push(app);
      const ready = Promise.resolve(app.ready());
      void ready.catch(() => {});
      await installing;
      await vi.advanceTimersByTimeAsync(10_001);
      await ready;
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
      seed.mockRestore();
    }
  });

  it("rejects archive paths outside the prepared directory", () => {
    const release = {
      pluginId: "plugin-1", releaseId: "release-1", id: "ohmygame/unsafe", version: "1.0.0",
      artifactFile: "plugin.zip",
      artifactSha256: "a".repeat(64), artifactBytes: 1,
      origin: { type: "github", repository: "example/unsafe", commit: "abc123" },
    };
    expect(isPreparedPluginIndex({ version: 1, plugins: [release] })).toBe(true);
    expect(isPreparedPluginIndex({ version: 1, plugins: [release, release] })).toBe(false);
    const npm = { ...release, artifactFile: "plugin.tgz", origin: { type: "npm", package: "@ohmygame/unsafe", version: "1.0.0", registry: "npmjs" } };
    expect(isPreparedPluginIndex({ version: 1, plugins: [npm] })).toBe(true);
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...npm, origin: { ...npm.origin, registry: "https://another.example" } }] })).toBe(false);
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...npm, origin: { ...npm.origin, package: "@another/unsafe" } }] })).toBe(false);
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...npm, origin: { ...npm.origin, version: "2.0.0" } }] })).toBe(false);
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...release, artifactFile: "../plugin.zip" }] })).toBe(false);
    // What an older app prepared has no plugin id, so it is prepared again.
    const { id: _id, ...older } = release;
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...older, name: "unsafe" }] })).toBe(false);
  });

  it("installs a prepared plugin in the store without replacing it on restart", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-data-");
    const prepared = await preparedPlugin();
    const first = await start(dataDirectory, prepared.directory);

    expect(await listed(first)).toMatchObject({
      id: ID,
      version: "1.0.0",
      everyProject: true,
      bundled: false,
      preinstalled: true,
      grants: { enabled: true },
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
      skills: [{ id: "skills/reference/SKILL.md", name: "reference" }],
    });
    const icon = await first.inject({ method: "GET", url: `/plugins/${encodeURIComponent(ID)}/icon` });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    expect(icon.body).toBe(prepared.iconContent);
    // It applies by itself, so a project's composer offers it and its Skill.
    const mentions = (await first.inject({ method: "GET", url: "/composer/capabilities" })).json();
    expect(mentions.plugins.map((plugin: { id: string }) => plugin.id)).toContain(ID);
    expect(mentions.skills.map((skill: { name: string }) => skill.name)).toContain("reference");

    const installedSkill = path.join(dataDirectory, "plugin-store", "packages", "ohmygame", "reference-tools", "1.0.0", "skills", "reference", "SKILL.md");
    expect((await first.inject({ method: "PUT", url: `/plugin-store/${ID}/every-project`, payload: { on: false } })).statusCode).toBe(204);
    await writeFile(installedSkill, `${prepared.skillContent}\nLocal marker`);
    await close(first);

    const second = await start(dataDirectory, prepared.directory);
    expect(await readFile(installedSkill, "utf8")).toContain("Local marker");
    expect((await listed(second)).everyProject).toBe(false);
  });

  it.each(["1.0.0", "2.0.0"])("replaces a prepared release at version %s while keeping its switch", async (version) => {
    const dataDirectory = await temporary("ohmygame-preinstalled-upgrade-");
    const firstPrepared = await preparedPlugin();
    const first = await start(dataDirectory, firstPrepared.directory);
    await first.inject({ method: "PUT", url: `/plugin-store/${ID}/every-project`, payload: { on: false } });
    await close(first);

    const secondPrepared = await preparedPlugin({
      releaseId: "33333333-3333-4333-8333-333333333333",
      version,
      skillContent: "---\nname: reference\ndescription: Rebuild a newer reference.\n---\n",
      iconContent: firstPrepared.iconContent.replace("#f00", "#00f"),
    });
    const second = await start(dataDirectory, secondPrepared.directory);

    expect(await listed(second)).toMatchObject({
      version,
      everyProject: false,
      skills: [{ description: "Rebuild a newer reference." }],
    });
    expect((await second.inject({ method: "GET", url: "/plugin-store/plugins" })).json().filter((plugin: { id: string }) => plugin.id === ID)).toHaveLength(1);
    expect((await second.inject({ method: "GET", url: `/plugins/${encodeURIComponent(ID)}/icon` })).body).toBe(secondPrepared.iconContent);
    if (version !== "1.0.0") {
      await expect(readFile(path.join(dataDirectory, "plugin-store", "packages", "ohmygame", "reference-tools", "1.0.0", "skills", "reference", "SKILL.md")))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(JSON.parse(await readFile(path.join(dataDirectory, "plugins", "preinstalled-plugins.json"), "utf8")))
      .toMatchObject({ plugins: { [secondPrepared.pluginId]: { seededReleaseId: secondPrepared.releaseId, removed: false } } });
  });

  it("does not restore a preinstalled plugin after the user removes it", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-remove-");
    const prepared = await preparedPlugin();
    const first = await start(dataDirectory, prepared.directory);
    expect((await first.inject({ method: "DELETE", url: `/plugin-store/${ID}/1.0.0` })).statusCode).toBe(204);
    await close(first);

    const second = await start(dataDirectory, prepared.directory);
    expect(await listed(second)).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(dataDirectory, "plugins", "preinstalled-plugins.json"), "utf8")))
      .toMatchObject({ plugins: { [prepared.pluginId]: { seededReleaseId: prepared.releaseId, removed: true } } });
  });

  it("updates only the version it installed, leaving one installed apart", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-update-");
    const services = new PluginServices({ directory: path.join(dataDirectory, "plugin-store") });
    const seed = async (prepared: Awaited<ReturnType<typeof preparedPlugin>>) => {
      const manager = new PreinstalledPluginManager(prepared.directory, dataDirectory);
      await manager.load();
      expect(await manager.seed(services)).toEqual([]);
    };
    await seed(await preparedPlugin());
    const apart = path.join(await temporary("ohmygame-preinstalled-apart-"), "package");
    await cp(services.index.get(ID, "1.0.0")!.root, apart, { recursive: true });
    const manifestPath = path.join(apart, ".ohmygame-plugin", "plugin.json");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, "utf8")), version: "9.0.0" }));
    expect((await services.index.add(apart)).ok).toBe(true);
    await seed(await preparedPlugin({ releaseId: "33333333-3333-4333-8333-333333333333", version: "1.1.0" }));
    expect(services.index.versions(ID).map((entry) => entry.version)).toEqual(["9.0.0", "1.1.0"]);
    await services.close();
  });

  it("removes the copy it installed of a plugin it no longer brings, once, keeping one installed apart", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-retired-");
    const services = new PluginServices({ directory: path.join(dataDirectory, "plugin-store") });
    const seed = async (directory: string) => {
      const manager = new PreinstalledPluginManager(directory, dataDirectory);
      await manager.load();
      expect(await manager.seed(services)).toEqual([]);
    };
    const retired = "ohmygame/img2threejs";
    await seed((await preparedPlugin({ pluginId: "98d626d2-8e51-42a9-adfe-a3a1e19372c9", id: retired })).directory);
    const apart = path.join(await temporary("ohmygame-preinstalled-retired-apart-"), "package");
    await cp(services.index.get(retired, "1.0.0")!.root, apart, { recursive: true });
    const manifestPath = path.join(apart, ".ohmygame-plugin", "plugin.json");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(await readFile(manifestPath, "utf8")), version: "9.0.0" }));
    expect((await services.index.add(apart)).ok).toBe(true);
    const none = await temporary("ohmygame-prepared-none-");
    await writeFile(path.join(none, "index.json"), JSON.stringify({ version: 1, plugins: [] }));
    await seed(none);
    expect(services.index.versions(retired).map((entry) => entry.version)).toEqual(["9.0.0"]);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "plugins", "preinstalled-plugins.json"), "utf8")).plugins["98d626d2-8e51-42a9-adfe-a3a1e19372c9"]).toMatchObject({ removed: true });
    // It is done once: the version kept apart stays on the next start.
    await seed(none);
    expect(services.index.versions(retired).map((entry) => entry.version)).toEqual(["9.0.0"]);
    await services.close();
  });

  it("reports a plugin store that can't load instead of stopping startup", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-unready-");
    const prepared = await preparedPlugin();
    const manager = new PreinstalledPluginManager(prepared.directory, dataDirectory);
    await manager.load();
    const services = new PluginServices({ directory: path.join(dataDirectory, "plugin-store") });
    vi.spyOn(services, "ready").mockRejectedValueOnce(new Error("no access"));
    expect(await manager.seed(services)).toEqual([expect.stringContaining("no access")]);
    await services.close();
  });

  it("keeps startup available when one prepared archive fails verification", async () => {
    const prepared = await preparedPlugin();
    await writeFile(path.join(prepared.directory, `${prepared.releaseId}.zip`), "damaged");
    const app = await start(await temporary("ohmygame-preinstalled-invalid-"), prepared.directory);
    expect(await listed(app)).toBeUndefined();
  });
});

const ID = "ohmygame/reference-tools";

async function start(dataDirectory: string, preinstalledPluginsDirectory: string) {
  const app = createApp({
    dataDirectory,
    bundledPluginsDirectory: await temporary("ohmygame-preinstalled-bundled-"),
    preinstalledPluginsDirectory,
    publishFetch: async () => Response.json([]),
  });
  apps.push(app);
  await app.ready();
  return app;
}

async function close(app: Awaited<ReturnType<typeof start>>) {
  await app.close();
  apps.splice(apps.indexOf(app), 1);
}

async function listed(app: Awaited<ReturnType<typeof start>>) {
  return (await app.inject({ method: "GET", url: "/plugin-store/plugins" })).json().find((plugin: { id: string }) => plugin.id === ID);
}

/** A prepared release: a package made from a repository with one `SKILL.md` at its root, as img2threejs was. */
async function preparedPlugin(options: { npm?: boolean; configuration?: boolean; pluginId?: string; id?: string; releaseId?: string; version?: string; skillContent?: string; iconContent?: string } = {}) {
  const directory = await temporary("ohmygame-prepared-plugin-");
  const source = await temporary("ohmygame-prepared-source-");
  const pluginId = options.pluginId ?? "11111111-1111-4111-8111-111111111111";
  const releaseId = options.releaseId ?? "22222222-2222-4222-8222-222222222222";
  const skillContent = options.skillContent ?? "---\nname: reference\ndescription: Rebuild a reference.\n---\n";
  const iconContent = options.iconContent ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#f00"/></svg>';
  const manifest = {
    name: "reference-tools",
    version: options.version ?? "1.0.0",
    description: "Rebuild a reference.",
    skills: ["./SKILL.md"],
    interface: {
      displayName: "Reference Tools", shortDescription: "Rebuild a reference.",
      icon: { type: "asset", path: "./assets/icon.svg" } as const,
    },
  };
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(path.join(source, "assets", "icon.svg"), iconContent);
  await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(source, "SKILL.md"), skillContent);
  const packaged = path.join(await temporary("ohmygame-prepared-converted-"), "package");
  const converted = await packageSkills({ root: source, manifest }, packaged, { id: options.id ?? ID });
  if (options.configuration) {
    const file = path.join(packaged, ".ohmygame-plugin", "plugin.json");
    const value = JSON.parse(await readFile(file, "utf8"));
    value.configuration = { label: { type: "text", title: "Label" }, token: { type: "secret", title: "Token" } };
    await writeFile(file, JSON.stringify(value));
  }
  const archive = await createPluginArchive(packaged);
  const artifactSha256 = createHash("sha256").update(archive).digest("hex");
  await writeFile(path.join(directory, `${releaseId}.zip`), archive);
  const index: PreparedPluginIndex = {
    version: 1,
    plugins: [{
      pluginId,
      releaseId,
      id: converted.entry.id,
      version: converted.entry.version,
      artifactFile: `${releaseId}.zip`,
      artifactSha256,
      artifactBytes: archive.length,
      origin: options.npm ? { type: "npm", package: "@ohmygame/reference-tools", version: converted.entry.version, registry: "npmjs" } : { type: "github", repository: "example/reference-tools", commit: "abc123" },
    }],
  };
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
  return { directory, source, packaged, pluginId, releaseId, skillContent, iconContent, artifactSha256 };
}

async function temporary(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("npm preinstalled migration", () => {
  it("relocates bundled content while preserving settings, secrets, switches and project decisions", async () => {
    const data = await temporary("npm-migration-");
    const prepared = await preparedPlugin({ npm: true, configuration: true });
    const bundled = await temporary("npm-old-bundled-");
    await cp(prepared.packaged, path.join(bundled, "reference-tools"), { recursive: true });
    const project = await temporary("npm-pinned-project-");
    const projectFile = path.join(project, "ohmygame.json");
    const projectText = JSON.stringify({ type: "general", plugins: { [ID]: "1.0.0" } });
    await writeFile(projectFile, projectText);
    const offProject = await temporary("npm-off-project-");
    const offText = JSON.stringify({ type: "general", plugins: { [ID]: false } });
    await writeFile(path.join(offProject, "ohmygame.json"), offText);
    const directory = path.join(data, "plugin-store");
    const old = new PluginServices({ directory, bundled });
    await old.ready();
    const before = old.index.get(ID)!;
    await old.values.update(before, { label: "Keep my setup", token: "test-secret" });
    await old.grants.setEveryProject(ID, false);
    await old.grants.approve("/test/project", ID, ["project.files:read"]);
    const grants = structuredClone(old.grants.plugin(ID));
    await old.grants.approve(await projectFolderKey(project), ID, grants?.allowed ?? []);
    const originalProject = await old.resolve(project);
    expect(originalProject.ok && originalProject.plugins.find((plugin) => plugin.id === ID)?.status).toBe("active");
    await mkdir(old.dataFolder(ID), { recursive: true });
    await writeFile(path.join(old.dataFolder(ID), "kept.txt"), "saved plugin data");
    await old.close();
    const manager = new PreinstalledPluginManager(prepared.directory, data);
    const services = new PluginServices({ directory, bundled, bundledReplacements: () => manager.bundledReplacements() });
    const sources = new PluginSources(services, path.join(directory, "origins.json"));
    try {
      expect(await manager.seed(services, sources)).toEqual([]);
      const entry = services.index.get(ID)!;
      expect(entry.root.startsWith(services.packagesDirectory)).toBe(true);
      expect(entry.version).toBe(before.version);
      const resolved = await services.resolve(project);
      expect(resolved.ok && resolved.plugins.find((plugin) => plugin.id === ID)).toMatchObject({ version: "1.0.0", status: "active" });
      expect(await readFile(projectFile, "utf8")).toBe(projectText);
      expect(await readFile(path.join(offProject, "ohmygame.json"), "utf8")).toBe(offText);
      const off = await services.resolve(offProject);
      expect(off.ok && off.plugins.some((plugin) => plugin.id === ID && plugin.status === "active")).toBe(false);
      expect(services.grants.plugin(ID)).toEqual(grants);
      expect(services.grants.project("/test/project", ID)).toEqual({ allowed: ["project.files:read"] });
      expect(services.values.view(entry)).toEqual({ label: { type: "text", value: "Keep my setup" }, token: { type: "secret", configured: true } });
      expect(services.values.secret(entry, "token")).toBe("test-secret");
      expect(await readFile(path.join(services.dataFolder(ID), "kept.txt"), "utf8")).toBe("saved plugin data");
      expect(await sources.origin(ID, "1.0.0")).toEqual({ type: "npm", package: "@ohmygame/reference-tools", version: "1.0.0", registry: "npmjs" });
    } finally { await services.close(); }
    // The old app directory still exists. It must not take the ID back.
    const restarted = new PluginServices({ directory, bundled, bundledReplacements: () => manager.bundledReplacements() });
    try {
      await restarted.ready();
      expect(restarted.index.get(ID)!.root.startsWith(restarted.packagesDirectory)).toBe(true);
      expect(restarted.onInEveryProject(ID)).toBe(false);
      expect(restarted.values.secret(restarted.index.get(ID)!, "token")).toBe("test-secret");
    } finally { await restarted.close(); }
  });

  it("uses npm origins for updates and never resurrects the seeded version after an independent update", async () => {
    const data = await temporary("npm-seed-update-");
    const prepared = await preparedPlugin({ npm: true });
    const directory = path.join(data, "plugin-store");
    const services = new PluginServices({ directory });
    const fetch = vi.fn(async () => Response.json({ "dist-tags": { latest: "2.0.0" } }));
    const sources = new PluginSources(services, path.join(directory, "origins.json"), { fetch: fetch as typeof globalThis.fetch, download: vi.fn() });
    const manager = new PreinstalledPluginManager(prepared.directory, data);
    try {
      expect(await manager.seed(services, sources)).toEqual([]);
      expect(await sources.updates()).toEqual([{ id: ID, version: "2.0.0", source: { type: "npm", name: "@ohmygame/reference-tools", registry: "npmjs", version: "2.0.0" } }]);
      expect((fetch.mock.calls as unknown as string[][])[0]?.[0]).toContain("registry.npmjs.org/@ohmygame%2Freference-tools");
      const newer = await preparedPlugin({ version: "2.0.0" });
      await services.installManaged(newer.packaged, { consent: false });
      await services.uninstall(ID, "1.0.0");
      await services.grants.setEveryProject(ID, false);
      expect(await new PreinstalledPluginManager(prepared.directory, data).seed(services, sources)).toEqual([]);
      expect(services.index.versions(ID).map((entry) => entry.version)).toEqual(["2.0.0"]);
      expect(services.onInEveryProject(ID)).toBe(false);
      // A later application lock is not authority to silently update native code either.
      const later = await preparedPlugin({ npm: true, version: "3.0.0", releaseId: "later" });
      expect(await new PreinstalledPluginManager(later.directory, data).seed(services, sources)).toEqual([]);
      expect(services.index.versions(ID).map((entry) => entry.version)).toEqual(["2.0.0"]);
    } finally { await services.close(); }
  });

  it("does not restore a removed npm seed or fall back to its old bundled copy", async () => {
    const data = await temporary("npm-remove-");
    const prepared = await preparedPlugin({ npm: true });
    const bundled = await temporary("npm-remove-bundled-");
    await cp(prepared.packaged, path.join(bundled, "reference-tools"), { recursive: true });
    const first = createApp({ dataDirectory: data, bundledPluginsDirectory: bundled, preinstalledPluginsDirectory: prepared.directory });
    apps.push(first);
    await first.ready();
    expect(await listed(first)).toMatchObject({ bundled: false, preinstalled: true, origin: { type: "npm" } });
    expect((await first.inject({ method: "DELETE", url: `/plugin-store/${ID}/1.0.0` })).statusCode).toBe(204);
    await close(first);
    const second = createApp({ dataDirectory: data, bundledPluginsDirectory: bundled, preinstalledPluginsDirectory: prepared.directory });
    apps.push(second);
    await second.ready();
    expect(await listed(second)).toBeUndefined();
  });

  it("refuses mismatched archive identity without touching an installed plugin", async () => {
    const data = await temporary("npm-wrong-identity-");
    const prepared = await preparedPlugin({ npm: true });
    const services = new PluginServices({ directory: path.join(data, "plugin-store") });
    try {
      const original = await services.installManaged(prepared.packaged);
      const indexPath = path.join(prepared.directory, "index.json");
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      index.plugins[0].id = "ohmygame/another";
      index.plugins[0].origin.package = "@ohmygame/another";
      await writeFile(indexPath, JSON.stringify(index));
      const sources = new PluginSources(services, path.join(data, "plugin-store", "origins.json"));
      expect(await new PreinstalledPluginManager(prepared.directory, data).seed(services, sources)).toEqual([expect.stringContaining("archive holds")]);
      expect(services.index.get(ID)?.digest).toBe(original.digest);
      expect(await readFile(path.join(original.root, ".ohmygame-plugin", "plugin.json"), "utf8")).toContain(ID);
    } finally { await services.close(); }
  });

  it("preserves unknown receipt data, serializes removals, and refuses unreadable stores", async () => {
    const data = await temporary("npm-receipts-");
    const prepared = await preparedPlugin({ npm: true });
    const indexPath = path.join(prepared.directory, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.plugins.push({ ...index.plugins[0], pluginId: "other", releaseId: "other", id: "ohmygame/other", artifactFile: "other.zip", origin: { ...index.plugins[0].origin, package: "@ohmygame/other" } });
    await writeFile(indexPath, JSON.stringify(index));
    const file = path.join(data, "plugins", "preinstalled-plugins.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, future: 17, plugins: { [prepared.pluginId]: { seededReleaseId: "old", removed: false, extra: "keep" } } }));
    const manager = new PreinstalledPluginManager(prepared.directory, data);
    await Promise.all([manager.markRemoved(ID), manager.markRemoved("ohmygame/other")]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ future: 17, plugins: { [prepared.pluginId]: { removed: true, extra: "keep" }, other: { removed: true } } });
    for (const raw of ['{"version":99,"plugins":{}}', '{bad', '{"version":1,"plugins":[]}']) {
      await writeFile(file, raw);
      const invalid = new PreinstalledPluginManager(prepared.directory, data);
      await expect(invalid.load()).rejects.toThrow();
      await expect(invalid.markRemoved(ID)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });
});

describe("pinned npm preparation", () => {
  async function fixture(change: (pkg: Record<string, unknown>, manifest: Record<string, unknown>) => void = () => {}) {
    const directory = await temporary("npm-preparation-");
    const root = path.join(directory, "package");
    await cp(path.resolve(".runtime/preinstalled-plugin-sources/godot"), root, { recursive: true });
    const ignore = path.join(root, "templates/godot-game/.gitignore");
    const content = await readFile(ignore, "utf8");
    await writeFile(path.join(root, "templates/godot-game/gitignore"), content);
    await rm(ignore);
    await mkdir(path.join(root, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "fixture", "index.js"), "export default 1");
    await writeFile(path.join(root, "templates/godot-game/.engineconfig"), "keep hidden template files");
    const manifestFile = path.join(root, ".ohmygame-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const pkg = { name: "@ohmygame/godot", version: manifest.version };
    change(pkg, manifest);
    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
    await writeFile(manifestFile, JSON.stringify(manifest));
    const archive = path.join(directory, "fixture.tgz");
    await createTar({ cwd: directory, file: archive, gzip: true, portable: true }, ["package"]);
    const bytes = await readFile(archive);
    const lock = { type: "npm" as const, pluginId: "godot", releaseId: "godot-1.0.0", id: "ohmygame/godot", package: "@ohmygame/godot", version: "1.0.0", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
    const download = vi.fn(async (_url: string, file: string) => { await writeFile(file, bytes); });
    return { lock, download, content };
  }

  it("prepares the pinned tarball offline after download and restores project template ignore files", async () => {
    const { lock, download, content } = await fixture();
    const directory = await temporary("npm-prepared-output-");
    const archive = await prepareNpmPlugin(lock, directory, download);
    expect(download).toHaveBeenCalledWith("https://registry.npmjs.org/@ohmygame/godot/-/godot-1.0.0.tgz", path.join(directory, "package.tgz"), expect.any(Number), expect.any(AbortSignal));
    const tgz = path.join(directory, "prepared.tgz");
    await writeFile(tgz, archive);
    const destination = await temporary("npm-prepared-extracted-");
    const extracted = await unpackPlugin(tgz, destination, { published: true, error: (message) => new Error(message) });
    expect(await readFile(path.join(extracted, "templates/godot-game/.gitignore"), "utf8")).toBe(content);
    expect(await readFile(path.join(extracted, "native/index.mjs"), "utf8")).toContain("activate");
    const index: PreparedPluginIndex = { version: 1, plugins: [{
      pluginId: lock.pluginId, releaseId: lock.releaseId, id: lock.id, version: lock.version,
      artifactFile: "prepared.tgz", artifactBytes: archive.length, artifactSha256: createHash("sha256").update(archive).digest("hex"),
      origin: { type: "npm", package: lock.package, version: lock.version, registry: "npmjs" },
    }] };
    await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
    const data = await temporary("npm-prepared-installed-");
    const services = new PluginServices({ directory: path.join(data, "plugin-store") });
    const sources = new PluginSources(services, path.join(data, "plugin-store", "origins.json"));
    try {
      expect(await new PreinstalledPluginManager(directory, data).seed(services, sources)).toEqual([]);
      const installed = services.index.get(lock.id)!;
      expect(await readFile(path.join(installed.root, "templates/godot-game/.gitignore"), "utf8")).toBe(content);
      expect(await readFile(path.join(installed.root, "templates/godot-game/.engineconfig"), "utf8")).toBe("keep hidden template files");
      expect(await readFile(path.join(installed.root, "node_modules/fixture/index.js"), "utf8")).toBe("export default 1");
      expect(services.grants.plugin(lock.id)?.allowed ?? []).toEqual([]);
      expect(services.onInEveryProject(lock.id)).toBe(false);
    } finally { await services.close(); }
  });

  it("rejects checksum changes and invalid locks before trusting package contents", async () => {
    const { lock, download } = await fixture();
    await expect(prepareNpmPlugin({ ...lock, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }, await temporary("npm-bad-integrity-"), download)).rejects.toThrow("integrity");
    for (const invalid of [{ ...lock, releaseId: "../escape" }, { ...lock, version: "latest" }, { ...lock, package: "@someone/godot" }, { ...lock, integrity: "sha1-bad" }, { ...lock, id: "ohmygame/another" }]) {
      expect(isLockedNpmPlugin(invalid)).toBe(false);
    }
  });

  it.each(["package", "version", "manifest", "script"])("rejects %s contract violations without executing scripts", async (kind) => {
    const { lock, download } = await fixture((pkg, manifest) => {
      if (kind === "package") pkg.name = "@ohmygame/another";
      if (kind === "version") pkg.version = "2.0.0";
      if (kind === "manifest") manifest.version = "2.0.0";
      if (kind === "script") pkg.scripts = { install: "exit 99" };
    });
    await expect(prepareNpmPlugin(lock, await temporary("npm-invalid-package-"), download)).rejects.toThrow(/identity|installation scripts/);
  });
});

it("leaves an installed seed intact if recording removal fails, then allows retry", async () => {
  const data = await temporary("npm-remove-failure-");
  const prepared = await preparedPlugin({ npm: true });
  const app = await start(data, prepared.directory);
  const receipt = path.join(data, "plugins", "preinstalled-plugins.json");
  const original = await readFile(receipt, "utf8");
  await rm(receipt);
  await mkdir(receipt);
  expect((await app.inject({ method: "DELETE", url: `/plugin-store/${ID}/1.0.0` })).statusCode).toBe(500);
  expect(await listed(app)).toMatchObject({ id: ID });
  await rm(receipt, { recursive: true });
  await writeFile(receipt, original);
  expect((await app.inject({ method: "DELETE", url: `/plugin-store/${ID}/1.0.0` })).statusCode).toBe(204);
  await close(app);
  const restarted = await start(data, prepared.directory);
  expect(await listed(restarted)).toBeUndefined();
});

it("records the last removal once when two versions are uninstalled concurrently", async () => {
  const data = await temporary("npm-remove-versions-");
  const prepared = await preparedPlugin({ npm: true });
  const services = new PluginServices({ directory: path.join(data, "plugin-store") });
  const manager = new PreinstalledPluginManager(prepared.directory, data);
  try {
    await services.installManaged(prepared.packaged);
    await services.installManaged((await preparedPlugin({ version: "2.0.0" })).packaged);
    const beforeLast = vi.fn(() => manager.markRemoved(ID));
    await Promise.all([services.uninstall(ID, "1.0.0", { beforeLast }), services.uninstall(ID, "2.0.0", { beforeLast })]);
    expect(beforeLast).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(data, "plugins/preinstalled-plugins.json"), "utf8")).plugins[prepared.pluginId].removed).toBe(true);
  } finally { await services.close(); }
});

it("refuses unreadable or foreign origins without replacing retained data", async () => {
  const data = await temporary("npm-origin-failure-");
  const prepared = await preparedPlugin({ npm: true });
  const directory = path.join(data, "plugin-store");
  const services = new PluginServices({ directory });
  await services.ready();
  const file = path.join(directory, "origins.json");
  await mkdir(directory, { recursive: true });
  try {
    for (const raw of ["{damaged", "[]", JSON.stringify({ [`${ID}@1.0.0`]: { type: "development", folder: "/old/development" } })]) {
      await writeFile(file, raw);
      const sources = new PluginSources(services, file);
      expect(await new PreinstalledPluginManager(prepared.directory, data).seed(services, sources)).toHaveLength(1);
      expect(services.index.get(ID)).toBeUndefined();
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  } finally { await services.close(); }
});

it("does not let a late seed receipt undo a concurrent removal", async () => {
  const data = await temporary("npm-late-receipt-");
  const prepared = await preparedPlugin({ npm: true });
  const services = new PluginServices({ directory: path.join(data, "plugin-store") });
  const manager = new PreinstalledPluginManager(prepared.directory, data);
  const sources = new PluginSources(services, path.join(data, "plugin-store", "origins.json"));
  const install = services.installManaged.bind(services);
  const spy = vi.spyOn(services, "installManaged").mockImplementation(async (...args) => {
    const installed = await install(...args);
    await services.uninstall(ID, installed.version, { beforeLast: () => manager.markRemoved(ID) });
    return installed;
  });
  try {
    expect(await manager.seed(services, sources)).toEqual([]);
    expect(services.index.get(ID)).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(data, "plugins/preinstalled-plugins.json"), "utf8")).plugins[prepared.pluginId].removed).toBe(true);
    spy.mockRestore();
    expect(await new PreinstalledPluginManager(prepared.directory, data).seed(services, sources)).toEqual([]);
    expect(services.index.get(ID)).toBeUndefined();
  } finally { spy.mockRestore(); await services.close(); }
});

it("does not label an independent managed copy as seeded or relocate a different bundled version", async () => {
  const data = await temporary("npm-independent-copy-");
  const prepared = await preparedPlugin({ npm: true });
  const services = new PluginServices({ directory: path.join(data, "plugin-store") });
  const sources = new PluginSources(services, path.join(data, "plugin-store", "origins.json"));
  const manager = new PreinstalledPluginManager(prepared.directory, data);
  try {
    const independent = await services.installManaged(prepared.packaged);
    expect(await manager.seed(services, sources)).toEqual([]);
    expect(manager.origin(independent.id, independent.version, independent.digest)).toBeUndefined();
    expect(await sources.origin(independent.id, independent.version)).toBeUndefined();
    await services.uninstall(ID);
    const older = await preparedPlugin({ version: "0.9.0" });
    expect((await services.index.add(older.packaged)).ok).toBe(true);
    expect(await manager.seed(services, sources)).toEqual([expect.stringContaining("keep its installed version")]);
    expect(services.index.versions(ID).map((entry) => entry.version)).toEqual(["0.9.0"]);
  } finally { await services.close(); }
});

it("does not overwrite a package installed while the seed waits for the package mutation lock", async () => {
  const data = await temporary("npm-install-race-");
  const prepared = await preparedPlugin({ npm: true });
  const independent = await preparedPlugin({ skillContent: "---\nname: reference\ndescription: Independently installed content.\n---\n" });
  const services = new PluginServices({ directory: path.join(data, "plugin-store") });
  const sources = new PluginSources(services, path.join(data, "plugin-store", "origins.json"));
  const install = services.installManaged.bind(services);
  const spy = vi.spyOn(services, "installManaged").mockImplementation(async (...args) => {
    await install(independent.packaged);
    return install(...args);
  });
  try {
    expect(await new PreinstalledPluginManager(prepared.directory, data).seed(services, sources)).toEqual([expect.stringContaining("while preinstallation was waiting")]);
    expect(services.index.get(ID)?.skills[0]?.description).toBe("Independently installed content.");
    expect(await sources.origin(ID, "1.0.0")).toBeUndefined();
  } finally { spy.mockRestore(); await services.close(); }
});

it("restores bundled origin after a failed placement without discarding a committed npm origin", async () => {
  const data = await temporary("npm-placement-failure-");
  const prepared = await preparedPlugin({ npm: true });
  const services = new PluginServices({ directory: path.join(data, "plugin-store") });
  const sources = new PluginSources(services, path.join(data, "plugin-store", "origins.json"));
  const manager = new PreinstalledPluginManager(prepared.directory, data);
  await services.ready();
  expect((await services.index.add(prepared.packaged)).ok).toBe(true);
  const original = services.index.get(ID)!;
  const install = services.installManaged.bind(services);
  const spy = vi.spyOn(services, "installManaged").mockImplementation(async (_root, options) => {
    await options?.before?.();
    throw new Error("placement failed");
  });
  try {
    expect(await manager.seed(services, sources)).toEqual([expect.stringContaining("placement failed")]);
    expect(services.index.get(ID)?.root).toBe(original.root);
    expect(await sources.origin(ID, "1.0.0")).toBeUndefined();
    spy.mockImplementation(async (...args) => {
      await install(...args);
      throw new Error("notification failed after commit");
    });
    expect(await manager.seed(services, sources)).toEqual([expect.stringContaining("notification failed")]);
    expect(services.index.get(ID)?.root.startsWith(services.packagesDirectory)).toBe(true);
    expect(await sources.origin(ID, "1.0.0")).toMatchObject({ type: "npm", package: "@ohmygame/reference-tools" });
  } finally { spy.mockRestore(); await services.close(); }
});


describe("shipped npm preinstalls", () => {
  const prepared = path.resolve(".runtime/preinstalled-plugins");
  const sources = path.resolve(".runtime/preinstalled-plugin-sources");
  const offline = {
    fetch: async () => { throw new Error("Startup must not query a registry"); },
    download: async () => { throw new Error("Startup must not download a plugin"); },
  };
  const catalog = async (app: ReturnType<typeof createApp>) =>
    (await app.inject({ method: "GET", url: "/plugin-store/plugins" })).json<Array<{
      id: string; version: string; bundled: boolean; preinstalled: boolean;
      everyProject: boolean; grants: { enabled?: boolean; allowed?: string[] } | null;
      origin: { type: string; package: string };
    }>>();

  it("loads all locked packages offline without granting native access on a fresh install", async () => {
    const app = createApp({ dataDirectory: await temporary("shipped-npm-fresh-"), preinstalledPluginsDirectory: prepared, pluginSourceNetwork: offline });
    apps.push(app);
    await app.ready();
    const entries = await catalog(app);
    const lock = JSON.parse(await readFile("config/preinstalled-plugins.json", "utf8"));
    expect(entries.map((entry) => entry.id).sort()).toEqual(lock.plugins.map((entry: { id: string }) => entry.id).sort());
    expect(entries).toHaveLength(12);
    for (const entry of entries) {
      expect(entry).toMatchObject({ bundled: false, preinstalled: true, origin: { type: "npm", package: entry.id.replace("ohmygame/", "@ohmygame/") } });
      expect(entry.grants?.allowed ?? [], entry.id).toEqual([]);
      const icon = await app.inject({ method: "GET", url: `/plugins/${encodeURIComponent(entry.id)}/icon` });
      expect(icon.statusCode, entry.id).toBe(200);
      expect(icon.rawPayload.length, entry.id).toBeGreaterThan(0);
    }
    expect(entries.filter((entry) => entry.everyProject).map((entry) => entry.id).sort())
      .toEqual(["ohmygame/blender", "ohmygame/game-studio", "ohmygame/web-game-studio"]);
  });

  it("relocates an old profile, keeps settings, grants and project pins, and remembers removal", async () => {
    const dataDirectory = await temporary("shipped-npm-upgrade-");
    const old = createApp({ dataDirectory, bundledPluginsDirectory: sources, pluginSourceNetwork: offline });
    apps.push(old);
    await old.ready();
    const configuration = "/plugin-store/ohmygame/godot/configuration";
    expect((await old.inject({ method: "PUT", url: configuration, payload: { godotPath: "/keep/my-godot" } })).statusCode).toBe(200);
    expect((await old.inject({ method: "PUT", url: "/plugin-store/ohmygame/game-studio/every-project", payload: { on: false } })).statusCode).toBe(204);
    const project = (await old.inject({ method: "POST", url: "/projects", payload: { type: "general" } })).json();
    const pin = await old.inject({ method: "PUT", url: `/projects/${project.id}/plugins/ohmygame/godot`, payload: { on: true, version: "1.0.0" } });
    expect(pin.statusCode, pin.body).toBe(204);
    const projectFile = path.join(project.workspacePath, "ohmygame.json");
    const projectBefore = await readFile(projectFile, "utf8");
    const settings = (await old.inject({ url: configuration })).json();
    const before = await catalog(old);
    await old.close();
    apps.splice(apps.indexOf(old), 1);

    const upgraded = createApp({ dataDirectory, preinstalledPluginsDirectory: prepared, pluginSourceNetwork: offline });
    apps.push(upgraded);
    await upgraded.ready();
    const after = await catalog(upgraded);
    expect(after).toHaveLength(12);
    for (const entry of after) {
      const previous = before.find((item) => item.id === entry.id)!;
      expect(entry).toMatchObject({ bundled: false, preinstalled: true, everyProject: previous.everyProject, grants: previous.grants });
    }
    expect((await upgraded.inject({ url: configuration })).json()).toEqual(settings);
    expect(await readFile(projectFile, "utf8")).toBe(projectBefore);
    expect((await upgraded.inject({ method: "DELETE", url: "/plugin-store/ohmygame/web-game-studio/0.1.0" })).statusCode).toBe(204);
    await upgraded.close();
    apps.splice(apps.indexOf(upgraded), 1);

    const restarted = createApp({ dataDirectory, preinstalledPluginsDirectory: prepared, pluginSourceNetwork: offline });
    apps.push(restarted);
    await restarted.ready();
    const final = await catalog(restarted);
    expect(final).toHaveLength(11);
    expect(final.some((entry) => entry.id === "ohmygame/web-game-studio")).toBe(false);
    expect(final.find((entry) => entry.id === "ohmygame/game-studio")?.everyProject).toBe(false);
    expect((await restarted.inject({ url: configuration })).json()).toEqual(settings);
    expect(await readFile(projectFile, "utf8")).toBe(projectBefore);
  });
});
