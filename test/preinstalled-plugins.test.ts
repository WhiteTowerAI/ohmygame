import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
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
      source: { type: "catalog", pluginId: prepared.pluginId, releaseId: prepared.releaseId },
      origin: { type: "github", repository: "example/reference-tools", commit: "abc123" },
      curation: "featured",
      skills: [{ id: "skills/reference/SKILL.md", name: "Reference", enabled: true }],
    });

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

async function preparedPlugin() {
  const directory = await temporary("ohmygame-prepared-plugin-");
  const source = await temporary("ohmygame-prepared-source-");
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
  await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(source, "skills", "reference"), { recursive: true });
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
