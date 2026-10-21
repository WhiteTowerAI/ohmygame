import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginIntegrationHost } from "../src/daemon/plugin-integration.js";
import { PluginCapabilities } from "../src/daemon/plugin-capabilities.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { matchesPluginProject } from "../src/daemon/plugin-integration-routes.js";
import {
  pluginProjectType,
  supportsProjectPreview,
  supportsWebPreview,
} from "../src/shared/project-runtime.js";
import { createApp } from "../src/daemon/app.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function source() {
  const directory = await mkdtemp(path.join(tmpdir(), "omg-integration-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
  await writeFile(
    path.join(root, ".ohmygame-plugin/plugin.json"),
    JSON.stringify({
      name: "fixture",
      description: "Fixture",
      version: "1.0.0",
      integration: {
        entry: "./integration.mjs",
        createProject: true,
        projectFiles: ["./.fixture/project.json"],
        preview: "external",
      },
      interface: { projectTypes: ["general"] },
    }),
  );
  await cp(
    path.resolve("test/fixtures/plugin-integration.mjs"),
    path.join(root, "integration.mjs"),
  );
  return { directory, root };
}
async function environment() {
  const { directory, root } = await source();
  const settings = new PluginSettingsStore(directory);
  await settings.load();
  const local = new LocalPluginStore(directory);
  const plugin = await local.install(root);
  const capabilities = new PluginCapabilities(
    directory,
    path.join(directory, "agent"),
    [local],
    local,
    settings,
  );
  await capabilities.configuration.load();
  const changed = vi.fn();
  const write = vi.fn((_project, operation) => operation());
  const host = new PluginIntegrationHost(capabilities, changed, write);
  cleanup.push(() => host.close());
  const projects = new ProjectManager(directory);
  const project = await projects.create("Native", "general", undefined, {
    pluginId: plugin.id,
    preview: "external",
  });
  return { directory, plugin, host, project, changed, write };
}

describe("plugin integration", () => {
  it("creates through the workspace write guard using the registered project name", async () => {
    const { host, plugin, project, write, changed } = await environment();
    await expect(host.execute(plugin, "create")).rejects.toThrow(
      "cannot create",
    );
    const unsupported = {
      ...plugin,
      integration: { ...plugin.integration!, createProject: false },
    };
    expect(() => host.start(unsupported, "create", project)).toThrow(
      "cannot create",
    );
    host.start(plugin, "create", project);
    expect(() => host.start(plugin, "create", project)).toThrow(
      "Another plugin operation",
    );
    await vi.waitFor(() =>
      expect(host.state(plugin.id, project.id)?.running).toBe(false),
    );
    expect(host.state(plugin.id, project.id)).toMatchObject({
      result: { project: { id: project.name } },
      connectionCheckedAt: expect.any(Number),
    });
    expect(write).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(project);
  });
  it("selects types by compatibility and keeps helper plugins engine-independent", () => {
    expect(
      pluginProjectType("web-game", [{ projectTypes: ["general"] }, {}]),
    ).toBe("general");
    expect(pluginProjectType("web-game", [{}])).toBe("web-game");
    expect(
      pluginProjectType("general", [
        { projectTypes: ["web-game", "godot-game"] },
      ]),
    ).toBeUndefined();
    expect(
      pluginProjectType("web-game", [
        { projectTypes: ["general"] },
        { projectTypes: ["web-game"] },
      ]),
    ).toBeUndefined();
  });
  it("persists the preview provider through reload and duplication without changing ordinary General defaults", async () => {
    const { directory, plugin, project } = await environment();
    expect(supportsWebPreview(project)).toBe(false);
    expect(supportsProjectPreview(project)).toBe(true);
    const restored = new ProjectManager(directory);
    await restored.load();
    expect(restored.get(project.id)?.integration).toEqual(project.integration);
    expect((await restored.duplicate(project.id)).integration).toEqual(
      project.integration,
    );
    expect(
      (await restored.create("Ordinary", "general")).webPreviewEnabled,
    ).toBe(true);
    const other = await restored.create("Existing", "general");
    await restored.setIntegration(other.id, {
      pluginId: plugin.id,
      preview: "external",
    });
    expect(other.webPreviewEnabled).toBe(false);
    await expect(
      restored.setIntegration(other.id, { pluginId: "another" }),
    ).rejects.toThrow("another plugin");
  });
  it("executes real adapters and serializes environment setup without losing task results", async () => {
    const { host, plugin, project, changed, write } = await environment();
    host.start(plugin, "prepare");
    expect(() => host.start(plugin, "status", project)).toThrow(
      "setup operation",
    );
    await vi.waitFor(() => expect(host.state(plugin.id)?.running).toBe(false));
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith();
    host.start(plugin, "bind", project, "selected-app");
    await vi.waitFor(() =>
      expect(host.state(plugin.id, project.id)?.running).toBe(false),
    );
    expect(write).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith(project);
    const checkedAt = host.state(plugin.id, project.id)?.connectionCheckedAt;
    expect(checkedAt).toEqual(expect.any(Number));
    expect(host.state(plugin.id, project.id)?.result?.project?.id).toBe(
      "selected-app",
    );
    await host.execute(plugin, "preview-start", project);
    expect(host.state(plugin.id, project.id)).toMatchObject({
      result: {
        project: { id: "selected-app" },
        preview: { status: "running" },
      },
      connectionCheckedAt: checkedAt,
    });
    expect(await matchesPluginProject(plugin, project.workspacePath)).toBe(
      true,
    );
  });
  it("invalidates stale project setup state after account or environment changes", async () => {
    const { host, plugin, project } = await environment();
    await host.execute(plugin, "status", project);
    expect(host.state(plugin.id, project.id)).toBeDefined();
    await host.execute(plugin, "prepare");
    expect(host.state(plugin.id, project.id)).toBeUndefined();
    await host.close();
    expect(() => host.start(plugin, "status")).toThrow("shutting down");
  });
  it("lets project views follow and cancel running plugin setup", async () => {
    const { host, plugin, project } = await environment();
    host.start(plugin, "connect");
    await vi.waitFor(() =>
      expect(host.state(plugin.id, project.id)).toMatchObject({
        action: "connect",
        running: true,
        authorizationUrl: "https://example.com/authorize",
      }),
    );
    host.cancel(plugin.id, project.id);
    // Windows stops the adapter only after the graceful-termination grace period.
    await vi.waitFor(() => expect(host.state(plugin.id)?.running).toBe(false), { timeout: 10_000 });
    expect(host.state(plugin.id, project.id)).toBeUndefined();
  });
  it("rejects malformed protocol, excessive messages and unsafe authorization URLs", async () => {
    const { host, plugin, project } = await environment();
    await expect(host.execute(plugin, "preview-logs", project)).rejects.toThrow(
      "Invalid plugin integration response",
    );
    await expect(
      host.execute(plugin, "preview-refresh", project),
    ).rejects.toThrow("message exceeded");
    await expect(host.execute(plugin, "preview-stop", project)).rejects.toThrow(
      "authorization URL",
    );
  });
  it("cancels on abort, disable and shutdown and rejects disabled or incompatible entry points", async () => {
    const { host, plugin, project } = await environment();
    const controller = new AbortController();
    const operation = host.execute(
      plugin,
      "connect",
      undefined,
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(host.state(plugin.id)?.authorizationUrl).toBe(
        "https://example.com/authorize",
      ),
    );
    controller.abort();
    await expect(operation).rejects.toThrow();
    expect(host.state(plugin.id)?.authorizationUrl).toBeUndefined();
    host.start(plugin, "connect");
    await host.forget(plugin.id);
    expect(host.state(plugin.id)).toBeUndefined();
    expect(() => host.start({ ...plugin, enabled: false }, "status")).toThrow(
      "Enable",
    );
    expect(() =>
      host.start(plugin, "status", { ...project, type: "web-game" }),
    ).toThrow("project type");
    host.start(plugin, "connect");
    await host.close();
    expect(host.state(plugin.id)?.running).toBe(false);
  });
  it("refuses project markers that escape the workspace", async () => {
    const { plugin, project, directory } = await environment();
    await mkdir(path.join(project.workspacePath, ".fixture"));
    const target = path.join(directory, "outside.json");
    await writeFile(target, "{}");
    await symlink(
      target,
      path.join(project.workspacePath, ".fixture/project.json"),
    );
    expect(await matchesPluginProject(plugin, project.workspacePath)).toBe(
      false,
    );
  });
  it("validates schemas, project ownership and imported project recognition through HTTP", async () => {
    const { directory, root } = await source();
    const app = createApp({ dataDirectory: path.join(directory, "data") });
    cleanup.push(() => app.close());
    await app.ready();
    const installed = await app.inject({
      method: "POST",
      url: "/plugins/install",
      payload: { type: "directory", path: root },
    });
    const pluginId = installed.json().id;
    expect(pluginId).toBe("personal:fixture");
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { type: "general", pluginId },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.webPreviewEnabled).toBe(false);
    const publish = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/publish`,
      payload: { accessToken: "fixture", title: "Native game" },
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.json().error).toContain("plugin publishing");
    const base = `/plugins/${encodeURIComponent(pluginId)}/integration?projectId=${project.id}`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: base,
          payload: { action: "arbitrary" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: base + "&workspacePath=/tmp" })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/plugins/${pluginId}/integration?projectId=missing`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/projects",
          payload: { type: "web-game", pluginId },
        })
      ).statusCode,
    ).toBe(400);
    await vi.waitFor(async () =>
      expect((await app.inject({ url: base })).json().running).toBe(false),
    );
    const bind = await app.inject({
      method: "POST",
      url: base,
      payload: { action: "bind", projectId: "selected-app" },
    });
    expect(bind.statusCode).toBe(202);
    await vi.waitFor(async () =>
      expect((await app.inject({ url: base })).json().running).toBe(false),
    );
    expect(
      JSON.parse(
        await readFile(
          path.join(project.workspacePath, ".fixture/project.json"),
          "utf8",
        ),
      ),
    ).toEqual({ id: "selected-app" });
    const workspace = path.join(directory, "import");
    await mkdir(path.join(workspace, ".fixture"), { recursive: true });
    await writeFile(
      path.join(workspace, ".fixture/project.json"),
      '{"id":"existing"}',
    );
    const imported = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { workspacePath: workspace, type: "web-game" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      type: "general",
      integration: { pluginId },
    });
    const ordinaryWorkspace = path.join(directory, "ordinary");
    await mkdir(ordinaryWorkspace);
    const ordinary = (
      await app.inject({
        method: "POST",
        url: "/projects",
        payload: { type: "general", workspacePath: ordinaryWorkspace },
      })
    ).json();
    await writeFile(path.join(ordinary.workspacePath, "index.html"), "Game");
    const preview = await app.inject({
      method: "POST",
      url: `/projects/${ordinary.id}/preview`,
    });
    expect(preview.statusCode).toBe(200);
    await mkdir(path.join(ordinary.workspacePath, ".fixture"));
    await writeFile(
      path.join(ordinary.workspacePath, ".fixture/project.json"),
      '{"id":"recognized"}',
    );
    const reimported = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { workspacePath: ordinary.workspacePath },
    });
    expect(reimported.statusCode).toBe(200);
    expect(reimported.json()).toMatchObject({
      id: ordinary.id,
      webPreviewEnabled: true,
    });
    expect(reimported.json().integration).toBeUndefined();
    const candidate = `/plugins/${encodeURIComponent(pluginId)}/integration?projectId=${ordinary.id}`;
    expect((await app.inject({ url: candidate })).statusCode).toBe(200);
    await vi.waitFor(async () =>
      expect((await app.inject({ url: candidate })).json().running).toBe(false),
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: candidate,
          payload: { action: "preview-start" },
        })
      ).statusCode,
    ).toBe(400);
    const selected = await app.inject({
      method: "PUT",
      url: `/projects/${ordinary.id}/integration`,
      payload: { pluginId },
    });
    expect(selected.json()).toMatchObject({
      webPreviewEnabled: false,
      integration: { pluginId, preview: "external" },
      preview: { status: "stopped" },
    });
    await app.inject({
      method: "POST",
      url: candidate,
      payload: { action: "preview-start" },
    });
    await vi.waitFor(async () =>
      expect((await app.inject({ url: candidate })).json()).toMatchObject({
        running: false,
        result: { preview: { status: "running" } },
      }),
    );
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/projects/${ordinary.id}/integration`,
        })
      ).json().integration,
    ).toBeUndefined();
    const actions = await readFile(
      path.join(
        directory,
        "data",
        "plugin-data",
        createHash("sha256").update(pluginId).digest("hex").slice(0, 24),
        "actions.log",
      ),
      "utf8",
    );
    expect(actions.trim().split("\n").at(-1)).toBe("preview-stop");
    await app.inject({
      method: "PUT",
      url: `/projects/${ordinary.id}/integration`,
      payload: { pluginId },
    });
    await app.inject({
      method: "PUT",
      url: `/plugins/${encodeURIComponent(pluginId)}/settings`,
      payload: { enabled: false, components: {} },
    });
    const disconnected = await app.inject({
      method: "DELETE",
      url: `/projects/${ordinary.id}/integration`,
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json().integration).toBeUndefined();
    expect(disconnected.json().webPreviewEnabled).toBe(false);
    await app.inject({
      method: "PUT",
      url: `/plugins/${encodeURIComponent(pluginId)}/settings`,
      payload: { enabled: true, components: {} },
    });
    const web = (
      await app.inject({
        method: "POST",
        url: "/projects",
        payload: { type: "web-game" },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/projects/${web.id}/integration`,
          payload: { pluginId },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("gates prompts on the connection, rechecks an old result and removes private data on uninstall", async () => {
    const { directory, root } = await source();
    const dataDirectory = path.join(directory, "data");
    const app = createApp({
      dataDirectory,
      createSession: async () => ({
        messages: [],
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        subscribe: () => () => {},
        getSkills: () => [],
      }),
    });
    cleanup.push(() => app.close());
    await app.ready();
    const pluginId = (
      await app.inject({
        method: "POST",
        url: "/plugins/install",
        payload: { type: "directory", path: root },
      })
    ).json().id;
    const project = (
      await app.inject({
        method: "POST",
        url: "/projects",
        payload: { type: "general", pluginId },
      })
    ).json();
    const conversation = (
      await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations`,
      })
    ).json();
    const send = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/projects/${project.id}/conversations/${conversation.id}/turns`,
        payload: { prompt: "Build" },
      });
      await vi.waitFor(async () =>
        expect(
          (await app.inject({ url: "/projects/activity" })).json().activity,
        ).toEqual([]),
      );
      return response.statusCode;
    };
    expect(await send()).toBe(409);
    const base = `/plugins/${encodeURIComponent(pluginId)}/integration?projectId=${project.id}`;
    await app.inject({
      method: "POST",
      url: base,
      payload: { action: "bind", projectId: "selected-app" },
    });
    await vi.waitFor(async () =>
      expect((await app.inject({ url: base })).json().running).toBe(false),
    );
    expect(await send()).toBe(202);
    const pluginData = path.join(
      dataDirectory,
      "plugin-data",
      createHash("sha256").update(pluginId).digest("hex").slice(0, 24),
    );
    await writeFile(path.join(pluginData, "signed-out"), "");
    expect(await send()).toBe(202);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      expect(await send()).toBe(409);
    } finally {
      vi.restoreAllMocks();
    }
    await app.inject({
      method: "DELETE",
      url: `/plugins/${encodeURIComponent(pluginId)}`,
    });
    expect(existsSync(pluginData)).toBe(false);
  });
});
