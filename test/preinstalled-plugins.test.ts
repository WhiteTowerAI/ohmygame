import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import { createPublishApp } from "../src/publish-server/app.js";
import { PublishStore, type StoredPlugin, type StoredPluginRelease } from "../src/publish-server/store.js";
import { isPreparedPluginIndex, type PreparedPluginIndex } from "../src/shared/preinstalled-plugins.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("preinstalled plugins", () => {
  it("rejects archive paths outside the prepared directory", () => {
    expect(isPreparedPluginIndex({
      version: 1,
      plugins: [{
        pluginId: "plugin-1", releaseId: "release-1", name: "unsafe", version: "1.0.0",
        publishedAt: "2026-01-01T00:00:00.000Z", artifactFile: "../plugin.zip",
        artifactSha256: "a".repeat(64), artifactBytes: 1,
        manifest: { name: "unsafe", version: "1.0.0", description: "Unsafe" }, skills: [],
        publisher: { id: "publisher", displayName: "Publisher" },
        origin: { type: "github", repository: "example/unsafe", commit: "abc123" },
      }],
    })).toBe(false);
  });

  it("installs a prepared Catalog Plugin enabled by default without replacing it on restart", async () => {
    const dataDirectory = await temporary("open-game-preinstalled-data-");
    const bundledPluginsDirectory = await temporary("open-game-preinstalled-bundled-");
    const prepared = await preparedPlugin();
    const first = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(first);
    await first.ready();

    const detail = await first.inject({ method: "GET", url: "/plugins/opengame%3Areference-tools" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: "opengame:reference-tools",
      installed: true,
      enabled: true,
      preinstalled: true,
      source: { type: "catalog", pluginId: prepared.pluginId, releaseId: prepared.releaseId },
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
      curation: "featured",
      skills: [{ id: "skills/reference/SKILL.md", name: "Reference", enabled: true }],
    });

    const installedSkill = path.join(
      dataDirectory, "plugins", "installed", "marketplace", "opengame", "reference-tools", "1.0.0",
      "skills", "reference", "SKILL.md",
    );
    expect((await first.inject({
      method: "PUT",
      url: "/plugins/opengame%3Areference-tools/settings",
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
    expect((await second.inject({ method: "GET", url: "/plugins/opengame%3Areference-tools" })).json().enabled).toBe(false);
  });

  it("does not restore a preinstalled Plugin after the user removes it", async () => {
    const dataDirectory = await temporary("open-game-preinstalled-remove-");
    const bundledPluginsDirectory = await temporary("open-game-preinstalled-bundled-");
    const prepared = await preparedPlugin();
    const first = createApp({
      dataDirectory,
      bundledPluginsDirectory,
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(first);
    await first.ready();
    expect((await first.inject({ method: "DELETE", url: "/plugins/opengame%3Areference-tools" })).statusCode).toBe(204);
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

    expect((await second.inject({ method: "GET", url: "/plugins/opengame%3Areference-tools" })).statusCode).toBe(404);
    expect(JSON.parse(await readFile(path.join(dataDirectory, "plugins", "preinstalled-plugins.json"), "utf8")))
      .toMatchObject({ plugins: { [prepared.pluginId]: { seededReleaseId: prepared.releaseId, removed: true } } });
  });

  it("keeps startup available when one prepared archive fails verification", async () => {
    const prepared = await preparedPlugin();
    await writeFile(path.join(prepared.directory, `${prepared.releaseId}.zip`), "damaged");
    const app = createApp({
      dataDirectory: await temporary("open-game-preinstalled-invalid-"),
      bundledPluginsDirectory: await temporary("open-game-preinstalled-bundled-"),
      preinstalledPluginsDirectory: prepared.directory,
      publishFetch: async () => Response.json([]),
    });
    apps.push(app);

    await app.ready();
    expect((await app.inject({ method: "GET", url: "/plugins/opengame%3Areference-tools" })).statusCode).toBe(404);
  });

  it("seeds the prepared release into the public Catalog with its source metadata", async () => {
    const prepared = await preparedPlugin();
    const app = createPublishApp({
      dataDirectory: await temporary("open-game-preinstalled-publish-"),
      preinstalledPluginsDirectory: prepared.directory,
      verifyPublisherToken: async () => undefined,
    });
    apps.push(app);
    await app.ready();

    const listing = await app.inject({ method: "GET", url: `/v1/explore/plugins/${prepared.pluginId}` });
    expect(listing.statusCode).toBe(200);
    expect(listing.json()).toMatchObject({
      id: prepared.pluginId,
      releaseId: prepared.releaseId,
      name: "reference-tools",
      version: "1.0.0",
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
      curation: "featured",
      author: { id: "github:example", displayName: "Example" },
    });
    const content = await app.inject({
      method: "GET",
      url: `/v1/explore/plugins/${prepared.pluginId}/releases/${prepared.releaseId}/content`,
    });
    expect(content.statusCode).toBe(200);
    expect(createHash("sha256").update(content.rawPayload).digest("hex")).toBe(prepared.artifactSha256);
  });

  it("does not downgrade or relist an existing Catalog Plugin when seeding again", async () => {
    const store = new PublishStore(await temporary("open-game-preinstalled-store-"));
    const publisher = { id: "github:example", displayName: "Example" };
    const plugin: StoredPlugin = {
      id: "plugin-1", publisherId: publisher.id, name: "reference-tools", currentReleaseId: "release-1",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      origin: { type: "github", repository: "example/reference-tools", commit: "old-commit" },
      curation: "featured",
    };
    const bundled = pluginRelease("release-1", "1.0.0", "2026-01-01T00:00:00.000Z");
    const newer = pluginRelease("release-2", "1.1.0", "2026-02-01T00:00:00.000Z");
    try {
      store.seedPlugin(plugin, bundled, publisher);
      const reservation = store.reserveIdempotency(
        publisher.id, "POST", "/release", "newer-release", "request-hash", newer.publishedAt,
      );
      expect(reservation).toEqual({ kind: "new" });
      store.activatePluginRelease(publisher.id, newer, {
        method: "POST", route: "/release", key: "newer-release", statusCode: 201, body: {},
      });
      expect(store.setPluginListing(publisher.id, plugin.id, "unlisted", newer.publishedAt)).toMatchObject({ status: "unlisted" });

      store.seedPlugin(plugin, bundled, publisher);

      expect(store.currentPluginRelease(publisher.id, plugin.id)?.version).toBe("1.1.0");
      expect(store.explorePlugin(plugin.id)).toBeUndefined();

      const nextBundled = pluginRelease("release-3", "1.2.0", "2026-03-01T00:00:00.000Z");
      store.seedPlugin({
        ...plugin,
        currentReleaseId: nextBundled.id,
        origin: { type: "github", repository: "example/reference-tools", commit: "new-commit" },
      }, nextBundled, publisher);
      expect(store.currentPluginRelease(publisher.id, plugin.id)?.version).toBe("1.2.0");
      expect(store.explorePlugin(plugin.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

async function preparedPlugin() {
  const directory = await temporary("open-game-prepared-plugin-");
  const source = await temporary("open-game-prepared-source-");
  const pluginId = "11111111-1111-4111-8111-111111111111";
  const releaseId = "22222222-2222-4222-8222-222222222222";
  const skillContent = "---\nname: reference\ndescription: Rebuild a reference.\n---\n";
  const manifest = {
    name: "reference-tools",
    version: "1.0.0",
    description: "Reference workflows",
    skills: ["./skills/reference/SKILL.md"],
    interface: { displayName: "Reference Tools", shortDescription: "Rebuild a reference." },
  };
  await mkdir(path.join(source, ".opengame-plugin"), { recursive: true });
  await mkdir(path.join(source, "skills", "reference"), { recursive: true });
  await writeFile(path.join(source, ".opengame-plugin", "plugin.json"), JSON.stringify(manifest));
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
      publishedAt: "2026-01-01T00:00:00.000Z",
      artifactFile: `${releaseId}.zip`,
      artifactSha256,
      artifactBytes: archive.length,
      manifest,
      skills: [{ id: "skills/reference/SKILL.md", name: "Reference", description: "Rebuild a reference." }],
      publisher: { id: "github:example", displayName: "Example" },
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
      curation: "featured",
    }],
  };
  await writeFile(path.join(directory, "index.json"), JSON.stringify(index));
  return { directory, pluginId, releaseId, skillContent, artifactSha256 };
}

async function temporary(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function pluginRelease(id: string, version: string, publishedAt: string): StoredPluginRelease {
  return {
    id,
    pluginId: "plugin-1",
    version,
    artifactSha256: "a".repeat(64),
    artifactBytes: 1,
    manifest: { name: "reference-tools", version, description: "Reference workflows" },
    skills: [],
    publishedAt,
  };
}
