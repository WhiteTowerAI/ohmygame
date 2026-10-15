import Fastify from "fastify";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ZipFile } from "yazl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalPluginError, LocalPluginStore } from "../src/daemon/local-plugins.js";
import {
  PluginCapabilities,
  mcpPluginPackage,
} from "../src/daemon/plugin-capabilities.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import {
  LocalPluginAdapter,
  PluginCatalogService,
} from "../src/daemon/plugin-catalog.js";
import {
  PluginPortability,
  registerPluginPortabilityRoutes,
} from "../src/daemon/plugin-portability.js";
import { pluginCompatibilityIssue } from "../src/daemon/plugin-contract.js";
import {
  inspectPluginDependencies,
  executableExists,
} from "../src/daemon/plugin-dependencies.js";
import { discoverPlugins } from "../src/daemon/plugin-discovery.js";
import { inspectPluginFiles } from "../src/daemon/plugin-draft.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import {
  PLUGIN_ARCHIVE_MAX_BYTES,
  type PluginManifest,
} from "../src/shared/plugins.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-portability-"));
  const local = new LocalPluginStore(path.join(directory, "data"));
  const settings = new PluginSettingsStore(path.join(directory, "data"));
  await settings.load();
  const service = new PluginCapabilities(
    path.join(directory, "data"),
    path.join(directory, "agent"),
    [local],
    local,
    settings,
  );
  await service.configuration.load();
  cleanup.push(async () => {
    await service.host.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    local,
    settings,
    service,
    portability: new PluginPortability(local, service, settings),
  };
}
const manifest: PluginManifest = {
  name: "portable-tools",
  version: "1.0.0",
  description: "Portable tools",
  skills: "./skills/",
  mcpServers: "./mcp.json",
  configuration: {
    endpoint: {
      type: "text",
      label: "Endpoint",
      default: "https://example.com/mcp",
    },
    token: { type: "secret", label: "Token", required: true },
    mode: {
      type: "select",
      label: "Mode",
      options: ["fast", "full"],
      default: "fast",
    },
  },
};
async function packageAt(
  directory: string,
  metadata: PluginManifest = manifest,
  definitions: unknown = {
    api: {
      url: "${config.endpoint}",
      headers: { Authorization: "Bearer ${config.token}" },
    },
  },
) {
  await mkdir(path.join(directory, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(directory, "skills", "portable", "scripts"), {
    recursive: true,
  });
  await writeFile(
    path.join(directory, ".ohmygame-plugin/plugin.json"),
    JSON.stringify(metadata),
  );
  await writeFile(
    path.join(directory, "mcp.json"),
    JSON.stringify({ mcpServers: definitions }),
  );
  await writeFile(
    path.join(directory, "skills/portable/SKILL.md"),
    "---\nname: portable\ndescription: Portable work\n---\nUse scripts/run.sh.\n",
  );
  await writeFile(
    path.join(directory, "skills/portable/scripts/run.sh"),
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(path.join(directory, "skills/portable/scripts/run.sh"), 0o755);
}

describe("plugin portability", () => {
  it("round-trips files, effective definitions and nonsecret settings independently of AI workspaces", async () => {
    const source = await environment();
    const root = path.join(source.directory, "source");
    await packageAt(root);
    const plugin = await source.local.installAuthored(root);
    await source.service.configuration.update(plugin, {
      endpoint: "https://backup.example/mcp",
      token: "private-token",
      mode: "full",
    });
    await source.service.setDefinition(plugin, "api", {
      url: "${config.endpoint}",
      headers: { Authorization: "Bearer ${config.token}" },
      timeout: 4321,
    });
    await source.settings.update(plugin, {
      enabled: false,
      components: { "skill:skills/portable/SKILL.md": false, "mcp:api": false },
    });
    const bytes = await source.portability.export(plugin.id);
    expect(bytes.toString()).not.toContain("private-token");
    const target = await environment();
    expect(await target.portability.inspect(bytes)).toMatchObject({
      plugin: { id: plugin.id },
      restoresSettings: true,
    });
    const restored = await target.portability.restore(bytes);
    expect(restored).toMatchObject({
      id: plugin.id,
      enabled: false,
      source: { type: "archive" },
      skills: [{ enabled: false }],
      mcpServers: [{ enabled: false }],
    });
    expect(target.service.configuration.view(restored)).toMatchObject({
      values: { endpoint: "https://backup.example/mcp", mode: "full" },
      configuredSecrets: [],
      missing: ["token"],
    });
    expect(await target.service.template(restored, "api")).toMatchObject({
      timeout: 4321,
    });
    const installedPath = (await target.local.installedPath(restored.id))!;
    expect(
      await readFile(
        path.join(installedPath, "skills/portable/scripts/run.sh"),
        "utf8",
      ),
    ).toContain("exit 0");
    if (process.platform !== "win32")
      expect(
        (await stat(path.join(installedPath, "skills/portable/scripts/run.sh")))
          .mode & 0o111,
      ).toBe(0o111);
    const reloaded = new PluginSettingsStore(
      path.join(target.directory, "data"),
    );
    await reloaded.load();
    expect(
      reloaded.decorate((await target.local.read(plugin.id))!).enabled,
    ).toBe(false);
  });

  it("replaces old overrides, preserves matching credentials and rejects stale previews", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root);
    const plugin = await env.local.install(root);
    await env.service.configuration.update(plugin, {
      token: "kept-secret",
      endpoint: "https://backup.example/mcp",
    });
    const bytes = await env.portability.export(plugin.id);
    await env.service.setDefinition(plugin, "api", {
      url: "https://old.example/mcp",
      headers: { Authorization: "Bearer old-literal" },
    });
    await env.service.configuration.update(plugin, {
      endpoint: "https://changed.example/mcp",
    });
    const preview = await env.portability.inspect(bytes);
    await expect(env.portability.restore(bytes)).rejects.toMatchObject({
      statusCode: 409,
    });
    const restored = await env.portability.restore(
      bytes,
      preview.existingRevision,
    );
    expect(await env.service.definition(restored, "api")).toMatchObject({
      url: "https://backup.example/mcp",
      headers: { Authorization: "Bearer kept-secret" },
    });
    expect(env.service.configuration.view(restored).fields).not.toHaveProperty(
      "api-headers-authorization",
    );
    const nextPreview = await env.portability.inspect(bytes);
    const installed = (await env.local.installedPath(plugin.id))!;
    await writeFile(
      path.join(installed, "skills/portable/SKILL.md"),
      "---\nname: portable\ndescription: Changed\n---\n",
    );
    await expect(
      env.portability.restore(bytes, nextPreview.existingRevision),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("exports installed plugins after a host downgrade", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root);
    const plugin = await env.local.install(root);
    const indexPath = path.join(env.directory, "data", "plugins", "installed-plugins.json");
    const records = JSON.parse(await readFile(indexPath, "utf8")) as Array<{ manifest: Record<string, unknown> }>;
    records[0]!.manifest.minimumHostVersion = "999.0.0";
    await writeFile(indexPath, JSON.stringify(records));

    const bytes = await env.portability.export(plugin.id);

    expect(bytes.length).toBeGreaterThan(0);
  });

  it("normalizes imported metadata, retains marketplace identity, and masks MCP literals", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root, manifest, {
      api: {
        url: "https://user:url-secret@example.com/mcp",
        headers: { Authorization: "Bearer header-secret" },
      },
      cli: {
        command: "node",
        args: ["run.js", "--api-key", "arg-secret"],
        env: { TOKEN: "env-secret", NODE_ENV: "production" },
      },
    });
    await rm(path.join(root, ".ohmygame-plugin/plugin.json"));
    await mkdir(path.join(root, ".codex-plugin"));
    await writeFile(
      path.join(root, ".codex-plugin/plugin.json"),
      JSON.stringify({ name: manifest.name, credential: "imported-secret" }),
    );
    const plugin = await env.local.install(
      root,
      { type: "directory", path: root },
      manifest,
      { id: "community", displayName: "Community" },
    );
    const bytes = await env.portability.export(plugin.id);
    for (const secret of [
      "imported-secret",
      "url-secret",
      "header-secret",
      "arg-secret",
      "env-secret",
    ])
      expect(bytes.toString()).not.toContain(secret);
    const target = await environment();
    const restored = await target.portability.restore(bytes);
    expect(restored.id).toBe("marketplace:community:portable-tools");
    const installed = (await target.local.installedPath(restored.id))!;
    await expect(
      readFile(path.join(installed, ".codex-plugin/plugin.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await target.service.template(restored, "cli")).toMatchObject({
      env: { NODE_ENV: "production", TOKEN: "${config.cli-env-token}" },
      args: ["run.js", "--api-key", "${config.cli-args-2}"],
    });
    expect(
      target.service.configuration.view(restored).configuredSecrets,
    ).toEqual([]);
  });

  it("rejects Public identity, secret restore data and ZIPs with unsafe entries", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root);
    const backup = {
      version: 1,
      marketplace: { id: "ohmygame", displayName: "OhMyGame" },
      settings: { enabled: true, components: {} },
      values: {},
    };
    await writeFile(
      path.join(root, ".ohmygame-plugin/backup.json"),
      JSON.stringify(backup),
    );
    await expect(
      env.portability.inspect(await createPluginArchive(root)),
    ).rejects.toThrow("Personal");
    await writeFile(
      path.join(root, ".ohmygame-plugin/backup.json"),
      JSON.stringify({
        ...backup,
        marketplace: { id: "personal", displayName: "Personal" },
        values: { token: "secret" },
      }),
    );
    await expect(
      env.portability.inspect(await createPluginArchive(root)),
    ).rejects.toThrow("invalid or secret");
    for (const entry of [".env", "node_modules/secret.txt"])
      await expect(
        env.portability.inspect(await zipEntry(entry)),
      ).rejects.toThrow();
    await expect(
      env.portability.inspect(await zipEntry("link", 0o120777)),
    ).rejects.toThrow("symbolic link");
    const traversal = await zipEntry("aa/evil");
    // Change equal-length local/central entry names without yazl's path guard.
    const unsafe = Buffer.from(
      traversal.toString("latin1").replaceAll("aa/evil", "../evil"),
      "latin1",
    );
    await expect(env.portability.inspect(unsafe)).rejects.toThrow();
    await expect(
      env.portability.inspect(Buffer.from("not a zip")),
    ).rejects.toThrow("valid ZIP");
    await expect(
      env.portability.inspect(Buffer.alloc(PLUGIN_ARCHIVE_MAX_BYTES + 1)),
    ).rejects.toThrow("50 MB");
    expect((await env.local.list()).plugins).toEqual([]);
  });

  it("supports authenticated-style binary routes and refuses malformed upload bodies", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root);
    const bytes = await createPluginArchive(root);
    const app = Fastify();
    cleanup.push(() => app.close());
    const invalidate = vi.fn();
    registerPluginPortabilityRoutes(app, {
      local: env.local,
      plugins: new PluginCatalogService(
        [new LocalPluginAdapter(env.local)],
        env.settings,
      ),
      capabilities: env.service,
      settings: env.settings,
      invalidate,
    });
    const inspected = await app.inject({
      method: "POST",
      url: "/plugins/import/inspect",
      headers: { "content-type": "application/zip" },
      payload: bytes,
    });
    expect(inspected.statusCode).toBe(200);
    expect((await env.local.list()).plugins).toEqual([]);
    const installed = await app.inject({
      method: "POST",
      url: "/plugins/import",
      headers: { "content-type": "application/zip" },
      payload: bytes,
    });
    expect(installed.statusCode).toBe(201);
    expect(invalidate).toHaveBeenCalledOnce();
    const exported = await app.inject({
      url: `/plugins/${encodeURIComponent(installed.json().id)}/export`,
    });
    expect(exported.headers["content-type"]).toBe("application/zip");
    expect(exported.headers["cache-control"]).toBe("no-store");
    expect((await env.portability.inspect(exported.rawPayload)).plugin.id).toBe(
      installed.json().id,
    );
    expect(
      (
        await app.inject({
          url: `/plugins/${encodeURIComponent(installed.json().id)}/dependencies`,
        })
      ).statusCode,
    ).toBe(200);
    const malformed = await app.inject({
      method: "POST",
      url: "/plugins/import/inspect",
      payload: {},
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("rejects an export whose installed package changes during capture", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root);
    const plugin = await env.local.install(root);
    const original = env.service.portableTemplates.bind(env.service);
    vi.spyOn(env.service, "portableTemplates").mockImplementation(
      async (selected) => {
        const result = await original(selected);
        await writeFile(
          path.join((await env.local.installedPath(plugin.id))!, "new.txt"),
          "changed",
        );
        return result;
      },
    );
    await expect(env.portability.export(plugin.id)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("plugin contract and dependency checks", () => {
  it("accepts old packages and enforces host/format compatibility at discovery and install", async () => {
    expect(pluginCompatibilityIssue(manifest, "1.0.0")).toBeUndefined();
    expect(
      pluginCompatibilityIssue(
        { ...manifest, minimumHostVersion: "1.0.0" },
        "1.0.0-beta.1",
      ),
    ).toContain("requires OhMyGame");
    expect(
      pluginCompatibilityIssue(
        { ...manifest, minimumHostVersion: "1.0.0-beta.1" },
        "1.0.0",
      ),
    ).toBeUndefined();
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(root, { ...manifest, formatVersion: 2 });
    await expect(discoverPlugins(root)).rejects.toBeInstanceOf(LocalPluginError);
    await expect(discoverPlugins(root)).rejects.toThrow("Plugin format 2");
    await expect(env.local.install(root)).rejects.toThrow("Plugin format 2");
    await packageAt(root, { ...manifest, minimumHostVersion: "999.0.0" });
    await expect(env.local.install(root)).rejects.toThrow(
      "requires OhMyGame 999.0.0",
    );
  });

  it("moves flagged, positional, and URL-path credentials into secret fields", () => {
    const { servers, values } = mcpPluginPackage(
      {
        name: "leaky",
        servers: {
          local: {
            command: "server",
            args: [
              "--auth-token",
              "plain-flag-value",
              "--key=inline-value",
              "sk-live-0123456789abcdefghij",
              "--token-file",
              "./token.txt",
              "--verbose",
            ],
          },
          remote: { url: "https://host.example/mcp/Ab3dEf6hIj9kLm2nOp5qRs8t/sse" },
        },
      },
      true,
    );
    const args = servers.local!.args as string[];
    expect(args.slice(1, 4).every((arg) => arg.includes("${config."))).toBe(true);
    expect(args[2]).toMatch(/^--key=\$\{config\./);
    expect(args.slice(4)).toEqual(["--token-file", "./token.txt", "--verbose"]);
    expect(servers.remote!.url).toMatch(/^\$\{config\./);
    expect(Object.values(values)).toEqual(
      expect.arrayContaining([
        "plain-flag-value",
        "inline-value",
        "sk-live-0123456789abcdefghij",
        "https://host.example/mcp/Ab3dEf6hIj9kLm2nOp5qRs8t/sse",
      ]),
    );
  });

  it("finds the daemon runtime executable when PATH is empty", async () => {
    expect(
      await executableExists(path.basename(process.execPath), "", tmpdir()),
    ).toBe(true);
  });

  it("checks local executables, working directories, scripts, and pinned packages without executing commands", async () => {
    const env = await environment();
    const root = path.join(env.directory, "source");
    await packageAt(
      root,
      {
        ...manifest,
        requirements: {
          commands: ["missing-plugin-command-xyz"],
          platforms: [process.platform === "win32" ? "linux" : "win32"],
        },
      },
      {
        local: {
          command: process.execPath,
          args: [
            "skills/portable/scripts/run.sh",
            "missing.py",
            "https://example.com/remote.js",
          ],
        },
        pinned: {
          command: "npx",
          args: [
            "--package",
            "@scope/mcp@1.2.3",
            "--package=other@2.0.0",
            "mcp",
          ],
        },
        latest: { command: "npx", args: ["-y", "mcp@latest"] },
        missing: { command: "node", cwd: "./missing", args: ["missing.js"] },
        configured: {
          command: "node",
          cwd: "${config.folder}",
          args: ["missing.js"],
        },
      },
    );
    const plugin = await env.local.install(root);
    const probe = vi.spyOn(env.service.host, "probe");
    const { checks } = await inspectPluginDependencies(plugin, env.service);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "platform", status: "error" }),
        {
          code: "command",
          target: "missing-plugin-command-xyz",
          status: "error",
        },
        { code: "path", target: "local: run.sh", status: "ok" },
        { code: "path", target: "local: missing.py", status: "error" },
        { code: "cwd", target: "Missing", status: "error" },
        { code: "configuration", target: "Configured", status: "warning" },
        { code: "unpinned-package", target: "mcp@latest", status: "warning" },
      ]),
    );
    expect(
      checks.filter((check) => check.code === "unpinned-package"),
    ).toHaveLength(1);
    expect(checks.some((check) => check.target.includes("remote.js"))).toBe(
      false,
    );
    expect(
      checks.some((check) => check.target === "configured: missing.js"),
    ).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(
      await executableExists(
        "./skills/portable/scripts/run.sh",
        "",
        (await env.local.installedPath(plugin.id))!,
      ),
    ).toBe(true);
    expect(
      (await inspectPluginFiles((await env.local.installedPath(plugin.id))!))
        .revision,
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});

function zipEntry(name: string, mode = 0o100644): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("test"), name, { mode, compress: false });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}
