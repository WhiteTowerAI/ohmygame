import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PreinstalledPluginManager } from "../src/daemon/preinstalled-plugins.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";

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
    expect(isPreparedPluginIndex({
      version: 1,
      plugins: [{
        pluginId: "plugin-1", releaseId: "release-1", name: "unsafe", version: "1.0.0",
        artifactFile: "../plugin.zip",
        artifactSha256: "a".repeat(64), artifactBytes: 1,
        manifest: { name: "unsafe", version: "1.0.0", description: "Unsafe" },
        origin: { type: "github", repository: "example/unsafe", commit: "abc123" },
      }],
    })).toBe(false);
  });

  it("installs a prepared Plugin enabled by default without replacing it on restart", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-data-");
    const bundledPluginsDirectory = await temporary("ohmygame-preinstalled-bundled-");
    const prepared = await preparedPlugin();
    const first = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(first);
    await first.ready();

    const detail = await first.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: "ohmygame:reference-tools",
      installed: true,
      enabled: true,
      preinstalled: true,
      source: { type: "preinstalled", pluginId: prepared.pluginId, releaseId: prepared.releaseId },
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
      skills: [{ id: "skills/reference/SKILL.md", name: "Reference", enabled: true }],
    });
    const icon = await first.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools/icon" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    expect(icon.body).toBe(prepared.iconContent);

    const installedSkill = path.join(
      dataDirectory, "plugins", "installed", "marketplace", "ohmygame", "reference-tools", "1.0.0",
      "skills", "reference", "SKILL.md",
    );
    expect((await first.inject({
      method: "PUT",
      url: "/plugins/ohmygame%3Areference-tools/settings",
      payload: { enabled: false, components: {} },
    })).statusCode).toBe(200);
    await writeFile(installedSkill, `${prepared.skillContent}\nLocal marker`);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(second);
    await second.ready();
    expect(await readFile(installedSkill, "utf8")).toContain("Local marker");
    expect((await second.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).json().enabled).toBe(false);
  });

  it.each(["1.0.0", "2.0.0"])("replaces a prepared release at version %s while preserving switches", async (version) => {
    const dataDirectory = await temporary("ohmygame-preinstalled-upgrade-");
    const bundledPluginsDirectory = await temporary("ohmygame-preinstalled-bundled-");
    const firstPrepared = await preparedPlugin();
    const first = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: firstPrepared.directory,
    });
    apps.push(first);
    await first.ready();
    await first.inject({
      method: "PUT",
      url: "/plugins/ohmygame%3Areference-tools/settings",
      payload: { enabled: false, components: {} },
    });
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const secondPrepared = await preparedPlugin({
      releaseId: "33333333-3333-4333-8333-333333333333",
      version,
      skillContent: "---\nname: reference\ndescription: Rebuild a newer reference.\n---\n",
      iconContent: firstPrepared.iconContent.replace("#f00", "#00f"),
    });
    const second = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: secondPrepared.directory,
    });
    apps.push(second);
    await second.ready();

    expect((await second.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).json()).toMatchObject({
      version,
      enabled: false,
      source: { type: "preinstalled", releaseId: secondPrepared.releaseId },
      skills: [{ description: "Rebuild a newer reference." }],
    });
    expect((await second.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools/icon" })).body)
      .toBe(secondPrepared.iconContent);
    if (version !== "1.0.0") {
      await expect(readFile(path.join(
        dataDirectory, "plugins", "installed", "marketplace", "ohmygame", "reference-tools", "1.0.0",
        "skills", "reference", "SKILL.md",
      ))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(JSON.parse(await readFile(path.join(dataDirectory, "plugins", "preinstalled-plugins.json"), "utf8")))
      .toMatchObject({ plugins: { [secondPrepared.pluginId]: { seededReleaseId: secondPrepared.releaseId, removed: false } } });
  });

  it("does not restore a preinstalled Plugin after the user removes it", async () => {
    const dataDirectory = await temporary("ohmygame-preinstalled-remove-");
    const bundledPluginsDirectory = await temporary("ohmygame-preinstalled-bundled-");
    const prepared = await preparedPlugin();
    const first = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(first);
    await first.ready();
    expect((await first.inject({ method: "DELETE", url: "/plugins/ohmygame%3Areference-tools" })).statusCode).toBe(204);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(second);
    await second.ready();

    expect((await second.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).statusCode).toBe(404);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "plugins", "preinstalled-plugins.json"), "utf8")))
      .toMatchObject({ plugins: { [prepared.pluginId]: { seededReleaseId: prepared.releaseId, removed: true } } });
  });

  it("keeps startup available when one prepared archive fails verification", async () => {
    const prepared = await preparedPlugin();
    await writeFile(path.join(prepared.directory, `${prepared.releaseId}.zip`), "damaged");
    const app = createApp({
      dataDirectory: await temporary("ohmygame-preinstalled-invalid-"),
      bundledPluginsDirectory: await temporary("ohmygame-preinstalled-bundled-"),
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(app);

    await app.ready();
    expect((await app.inject({ method: "GET", url: "/plugins/ohmygame%3Areference-tools" })).statusCode).toBe(404);
  });

});

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
    description: "Reference workflows",
    skills: ["./skills/reference/SKILL.md"],
    interface: {
      displayName: "Reference Tools", shortDescription: "Rebuild a reference.",
      icon: { type: "asset", path: "./assets/icon.svg" } as const,
    },
  };
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(source, "skills", "reference"), { recursive: true });
  await mkdir(path.join(source, "assets"), { recursive: true });
  await writeFile(path.join(source, "assets", "icon.svg"), iconContent);
  await writeFile(path.join(source, ".ohmygame-plugin", "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(source, "skills", "reference", "SKILL.md"), skillContent);
  const archive = await createPluginArchive(source);
  const artifactSha256 = createHash("sha256").update(archive).digest("hex");
  await writeFile(path.join(directory, `${releaseId}.zip`), archive);
  const index: PreparedPluginIndex = {
    version: 1,
    plugins: [{
      pluginId,
      releaseId,
      name: manifest.name,
      version: manifest.version,
      artifactFile: `${releaseId}.zip`,
      artifactSha256,
      artifactBytes: archive.length,
      manifest,
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
    }],
  };
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
  return { directory, pluginId, releaseId, skillContent, iconContent, artifactSha256 };
}

async function temporary(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}
