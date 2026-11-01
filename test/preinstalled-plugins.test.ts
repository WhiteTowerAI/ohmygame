import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PreinstalledPluginManager } from "../src/daemon/preinstalled-plugins.js";
import { convertFormat1Package } from "../src/daemon/plugin-conversion.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";
import type { LocalPluginStore } from "../src/daemon/local-plugins.js";
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
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...release, artifactFile: "../plugin.zip" }] })).toBe(false);
    // What an older app prepared has no format 2 id, so it is prepared again.
    const { id: _id, ...older } = release;
    expect(isPreparedPluginIndex({ version: 1, plugins: [{ ...older, name: "unsafe" }] })).toBe(false);
  });

  it("installs a prepared plugin in the format 2 store without replacing it on restart", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-data-");
    const prepared = await preparedPlugin();
    const first = await start(dataDirectory, prepared.directory);

    expect(await listed(first)).toMatchObject({
      id: ID,
      version: "1.0.0",
      appWide: true,
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
    expect((await first.inject({ method: "PUT", url: `/plugin-store/${ID}/enabled`, payload: { enabled: false } })).statusCode).toBe(204);
    await writeFile(installedSkill, `${prepared.skillContent}\nLocal marker`);
    await close(first);

    const second = await start(dataDirectory, prepared.directory);
    expect(await readFile(installedSkill, "utf8")).toContain("Local marker");
    expect((await listed(second)).grants.enabled).toBe(false);
  });

  it.each(["1.0.0", "2.0.0"])("replaces a prepared release at version %s while keeping its switch", async (version) => {
    const dataDirectory = await temporary("ohmygame-preinstalled-upgrade-");
    const firstPrepared = await preparedPlugin();
    const first = await start(dataDirectory, firstPrepared.directory);
    await first.inject({ method: "PUT", url: `/plugin-store/${ID}/enabled`, payload: { enabled: false } });
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
      grants: { enabled: false },
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

  it("takes over from the copy format 1 kept", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-format-1-");
    const prepared = await preparedPlugin();
    const manager = new PreinstalledPluginManager(prepared.directory, dataDirectory);
    await manager.load();
    const services = new PluginServices({ directory: path.join(dataDirectory, "plugin-store") });
    // As an earlier app seeded it; one the person installed themselves stays.
    const copies: Record<string, { source: { type: string } }> = { "ohmygame:reference-tools": { source: { type: "preinstalled" } } };
    const remove = vi.fn(async (id: string) => { delete copies[id]; });
    const formatOne = { read: async (id: string) => copies[id], remove } as unknown as LocalPluginStore;
    expect(await manager.seed(services, formatOne)).toEqual([]);
    expect(remove).toHaveBeenCalledWith("ohmygame:reference-tools");
    expect(services.index.get(ID)).toBeDefined();
    copies["ohmygame:reference-tools"] = { source: { type: "directory" } };
    remove.mockClear();
    await manager.seed(services, formatOne);
    expect(remove).not.toHaveBeenCalled();
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

/** A prepared release: a format 2 package converted from a repository with one `SKILL.md` at its root, as img2threejs is. */
async function preparedPlugin(options: { releaseId?: string; version?: string; skillContent?: string; iconContent?: string } = {}) {
  const directory = await temporary("ohmygame-prepared-plugin-");
  const source = await temporary("ohmygame-prepared-source-");
  const pluginId = "11111111-1111-4111-8111-111111111111";
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
  const converted = await convertFormat1Package({ root: source, manifest }, packaged, { id: ID });
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
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
    }],
  };
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
  return { directory, source, pluginId, releaseId, skillContent, iconContent, artifactSha256 };
}

async function temporary(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
