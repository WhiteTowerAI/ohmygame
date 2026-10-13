import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewManager } from "../src/daemon/preview.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

const managers: PreviewManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  vi.unstubAllEnvs();
});

describe("PreviewManager", () => {
  it.skipIf(process.platform === "win32")("fails the start when the package manager is not installed and starts once it is", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const events = new RuntimeEventBus();
    const manager = new PreviewManager(events, { readinessTimeoutMs: 2_000 });
    managers.push(manager);
    vi.stubEnv("PATH", await mkdtemp(path.join(tmpdir(), "ohmygame-preview-path-")));

    await expect(manager.start(project)).rejects.toThrow("npm was not found");
    expect(project.preview.status).toBe("error");
    expect(project.preview.error).toContain("npm");
    expect(events.since(project.id).filter((event) => event.type === "preview.updated" && event.data.preview.status === "error")).toHaveLength(1);
    vi.unstubAllEnvs();
    const url = await manager.start(project);
    expect(await (await fetch(url)).text()).toBe("ready");
  });

  it("keeps missing managers local to the preview and preserves installed dependencies", async () => {
    const workspacePath = await createWorkspace(false);
    await writeFile(path.join(workspacePath, "bun.lock"), "{}");
    vi.stubEnv("PATH", workspacePath);
    const project = createProject(workspacePath);
    const events = new RuntimeEventBus();
    const manager = new PreviewManager(events);
    managers.push(manager);
    await expect(manager.start(project)).rejects.toThrow("bun was not found");
    expect(project.preview.status).toBe("error");
    expect(
      events
        .since(project.id)
        .filter(
          (event) =>
            event.type === "preview.updated" &&
            event.data.preview.status === "error",
        ),
    ).toHaveLength(1);
    expect(
      await readFile(
        path.join(workspacePath, "node_modules", ".bin", "vite"),
        "utf8",
      ),
    ).toBe("");
  });

  it.skipIf(process.platform === "win32")(
    "contains a spawn failure even when the executable disappears after preflight",
    async () => {
      const workspacePath = await mkdtemp(
        path.join(tmpdir(), "ohmygame-spawn-race-"),
      );
      const bin = path.join(workspacePath, "bin");
      await mkdir(bin);
      const executable = path.join(bin, "npm");
      await writeFile(
        path.join(workspacePath, "package.json"),
        JSON.stringify({ scripts: { dev: "node server.mjs" } }),
      );
      await writeFile(
        executable,
        `#!${process.execPath}\nimport { mkdirSync, unlinkSync } from 'node:fs'; mkdirSync('node_modules'); unlinkSync(${JSON.stringify(executable)});`,
      );
      await chmod(executable, 0o755);
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
      const project = createProject(workspacePath);
      const events = new RuntimeEventBus();
      const manager = new PreviewManager(events, { readinessTimeoutMs: 2_000 });
      managers.push(manager);
      const before = Date.now();
      await expect(manager.start(project)).rejects.toThrow("ENOENT");
      expect(Date.now() - before).toBeLessThan(1_500);
      expect(project.preview.status).toBe("error");
      expect(
        events
          .since(project.id)
          .filter(
            (event) =>
              event.type === "preview.updated" &&
              event.data.preview.status === "error",
          ),
      ).toHaveLength(1);
    },
  );

  it("reports a running preview's exit once and can launch another project", async () => {
    const workspacePath = await createWorkspace(false);
    await writeFile(
      path.join(workspacePath, "server.mjs"),
      `
      import { createServer } from 'node:http';
      import { writeSync } from 'node:fs';
      createServer((request, response) => { if (request.url === '/crash') { writeSync(1, 'preview is exiting'); process.exit(7); } response.end('ready'); })
        .listen(Number(process.env.PORT || process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
    `,
    );
    const project = createProject(workspacePath);
    const events = new RuntimeEventBus();
    const manager = new PreviewManager(events, { readinessTimeoutMs: 2_000 });
    managers.push(manager);
    const url = await manager.start(project);
    await fetch(`${url}/crash`).catch(() => {});
    await vi.waitFor(() => expect(project.preview.status).toBe("error"));
    // Let the log debounce expire: the failure snapshot must consume its pending flush.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(project.preview.logs).toContain("preview is exiting");
    expect(
      events
        .since(project.id)
        .filter(
          (event) =>
            event.type === "preview.updated" &&
            event.data.preview.status === "error",
        ),
    ).toHaveLength(1);
    const other = createProject(await createWorkspace(false));
    expect(await (await fetch(await manager.start(other))).text()).toBe(
      "ready",
    );
  });
  it("isolates project binaries and the daemon token during install and preview, and retries failed installs", async () => {
    vi.stubEnv("ESBUILD_BINARY_PATH", "/app/esbuild");
    vi.stubEnv("OHMYGAME_DAEMON_TOKEN", "secret");
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "ohmygame-preview-retry-"),
    );
    await writeFile(
      path.join(workspacePath, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { postinstall: "node install.mjs", dev: "node server.mjs" },
      }),
    );
    await writeFile(
      path.join(workspacePath, "install.mjs"),
      `
      import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      if (process.env.ESBUILD_BINARY_PATH) throw new Error("app binary leaked into install");
      if (process.env.OHMYGAME_DAEMON_TOKEN) throw new Error("daemon token leaked into install");
      const attempts = existsSync("attempts") ? Number(readFileSync("attempts", "utf8")) + 1 : 1;
      writeFileSync("attempts", String(attempts));
      mkdirSync("node_modules", { recursive: true });
      if (attempts === 1) throw new Error("interrupted postinstall");
    `,
    );
    await writeFile(
      path.join(workspacePath, "server.mjs"),
      `
      import { createServer } from "node:http";
      if (process.env.ESBUILD_BINARY_PATH) throw new Error("app binary leaked into preview");
      if (process.env.OHMYGAME_DAEMON_TOKEN) throw new Error("daemon token leaked into preview");
      const port = Number(process.env.PORT || process.argv[process.argv.indexOf("--port") + 1]);
      createServer((_request, response) => response.end("ready")).listen(port, "127.0.0.1");
    `,
    );
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);
    await expect(manager.start(project)).rejects.toThrow(
      "interrupted postinstall",
    );
    const url = await manager.start(project);
    expect(await (await fetch(url)).text()).toBe("ready");
    expect(await readFile(path.join(workspacePath, "attempts"), "utf8")).toBe(
      "2",
    );
    expect(process.env.ESBUILD_BINARY_PATH).toBe("/app/esbuild");
    expect(process.env.OHMYGAME_DAEMON_TOKEN).toBe("secret");
  });

  it("reuses the same process for concurrent player and agent launches and subsequent opens", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);
    const urls = await Promise.all([
      manager.ensureStarted(project),
      manager.ensureStarted(project),
    ]);
    expect(urls[0]).toBe(urls[1]);
    const pid = await readFile(path.join(workspacePath, "server.pid"), "utf8");
    expect(await manager.ensureStarted(project)).toBe(urls[0]);
    expect(await readFile(path.join(workspacePath, "server.pid"), "utf8")).toBe(
      pid,
    );
    expect(isProcessRunning(Number(pid))).toBe(true);
    await manager.stop(project);
    await manager.ensureStarted(project);
    expect(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    ).not.toBe(pid);
  });

  it("rejects disabled General previews, including cached ready servers, and stops their process", async () => {
    const workspacePath = await createWorkspace(false);
    const project: ProjectState = {
      ...createProject(workspacePath),
      type: "general",
      webPreviewEnabled: false,
      preview: { status: "waiting" },
    };
    const events = new RuntimeEventBus();
    const manager = new PreviewManager(events, { readinessTimeoutMs: 2_000 });
    managers.push(manager);
    await expect(manager.start(project)).rejects.toThrow("Enable Web preview");
    expect(project.preview).toEqual({ status: "waiting" });
    project.webPreviewEnabled = true;
    const url = await manager.ensureStarted(project);
    const pid = Number(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    );
    project.webPreviewEnabled = false;
    await expect(manager.ensureStarted(project)).rejects.toThrow(
      "Enable Web preview",
    );
    await expect(manager.start(project)).rejects.toThrow("Enable Web preview");
    await manager.stop(project);
    await vi.waitFor(() => expect(isProcessRunning(pid)).toBe(false));
    await expect(
      fetch(url, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
  });

  it("keeps a pending workspace waiting and preserves a ready server on preflight failure", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);
    const url = await manager.start(project);
    const pid = Number(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    );
    await writeFile(
      path.join(workspacePath, "package.json"),
      JSON.stringify({ scripts: { dev: "bun format" } }),
    );
    await expect(manager.start(project)).rejects.toThrow("non-server task");
    expect(project.preview).toMatchObject({ status: "ready", url });
    expect(isProcessRunning(pid)).toBe(true);
    process.kill(pid, "SIGTERM");
    await vi.waitFor(() => expect(project.preview.status).toBe("error"));
    await manager.stop(project);
    project.preview = { status: "waiting" };
    await expect(manager.start(project)).rejects.toThrow("non-server task");
    expect(project.preview).toEqual({ status: "waiting" });
  });

  it("shares explicit restarts and cancels a startup during preflight without late errors", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);
    await manager.start(project);
    const originalPid = await readFile(
      path.join(workspacePath, "server.pid"),
      "utf8",
    );
    const restarting = manager.start(project);
    expect(manager.ensureStarted(project)).toBe(restarting);
    await restarting;
    expect(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    ).not.toBe(originalPid);
    await manager.stop(project);
    const cancelled = manager.start(project);
    const rejection = expect(cancelled).rejects.toThrow("superseded");
    await manager.stop(project);
    await rejection;
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "manual",
      url: undefined,
    });
  });

  it("cleans up a launch superseded by invalid configuration instead of leaving it starting", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const events = new RuntimeEventBus();
    const manager = new PreviewManager(events, { readinessTimeoutMs: 2_000 });
    managers.push(manager);
    let replacement: Promise<string> | undefined;
    const unsubscribe = events.subscribe(project.id, (event) => {
      if (
        event.type !== "preview.updated" ||
        event.data.preview.phase !== "checking"
      )
        return;
      project.startupScript = "missing";
      replacement = manager.start(project);
      void replacement.catch(() => {});
    });
    await expect(manager.start(project)).rejects.toThrow("superseded");
    await expect(replacement).rejects.toThrow("no missing script");
    expect(project.preview.status).toBe("error");
    unsubscribe();
    await expect(
      readFile(path.join(workspacePath, "server.pid")),
    ).rejects.toThrow();
  });

  it("starts and stops a preview process tree", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);

    const url = await manager.start(project);
    expect(await (await fetch(url)).text()).toBe("ready");
    await manager.stop(project);
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "manual",
      url: undefined,
    });
    await expect(
      fetch(url, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
  });

  it("waits for an in-flight stop before reopening instead of returning the closing server", async () => {
    const workspacePath = await createWorkspace(false);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);
    await manager.start(project);
    const pid = await readFile(path.join(workspacePath, "server.pid"), "utf8");
    const stopping = manager.stop(project);
    const restarting = manager.ensureStarted(project);
    await stopping;
    const url = await restarting;
    expect(project.preview).toMatchObject({ status: "ready", url });
    expect(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    ).not.toBe(pid);
    expect(await (await fetch(url)).text()).toBe("ready");
    const finalStop = manager.stop(project);
    project.startupScript = "missing";
    await expect(manager.start(project)).rejects.toThrow("no missing script");
    await finalStop;
    expect(project.preview.status).toBe("stopped");
  });

  it("cleans up the process when readiness fails", async () => {
    const workspacePath = await createWorkspace(true);
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 1_000,
    });
    managers.push(manager);

    await expect(manager.start(project)).rejects.toThrow(
      /did not become ready[\s\S]*server error/,
    );
    const pid = Number(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    );
    await vi.waitFor(() => expect(isProcessRunning(pid)).toBe(false));
    expect(project.preview.status).toBe("error");
    expect(project.preview.error).toContain("server error");
  });

  it("keeps a listening server alive when its root page returns a content error", async () => {
    const workspacePath = await createWorkspace(false);
    await writeFile(path.join(workspacePath, "broken"), "");
    await writeFile(
      path.join(workspacePath, "server.mjs"),
      `
      import { createServer } from 'node:http';
      import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync('server.pid', String(process.pid));
      createServer((_request, response) => {
        response.writeHead(existsSync('broken') ? 500 : 200, { 'content-type': 'text/html' });
        response.end('<head></head><body>Project content</body>');
      }).listen(Number(process.env.PORT || process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
    `,
    );
    const project = createProject(workspacePath);
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);
    const url = await manager.start(project);
    expect(project.preview.status).toBe("ready");
    expect((await fetch(url)).status).toBe(500);
    expect(project.preview.diagnostic?.kind).toBe("compile");
    const pid = Number(
      await readFile(path.join(workspacePath, "server.pid"), "utf8"),
    );
    expect(isProcessRunning(pid)).toBe(true);
    await rm(path.join(workspacePath, "broken"));
    expect((await fetch(url)).status).toBe(200);
    expect(project.preview.diagnostic).toBeUndefined();
    expect(isProcessRunning(pid)).toBe(true);
  });

  it("starts the preview from the configured startup directory", async () => {
    const workspacePath = await mkdtemp(
      path.join(tmpdir(), "ohmygame-preview-root-"),
    );
    const startupDirectory = path.join(workspacePath, "apps", "game");
    await mkdir(path.join(startupDirectory, "node_modules", ".bin"), {
      recursive: true,
    });
    await writeFile(
      path.join(startupDirectory, "node_modules", ".bin", "vite"),
      "",
    );
    await writeFile(
      path.join(startupDirectory, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { start: "node server.mjs" },
      }),
    );
    await writeFile(
      path.join(startupDirectory, "server.mjs"),
      `
      import { createServer } from "node:http";
      const portIndex = process.argv.indexOf("--port");
      const port = Number(process.env.PORT || process.argv[portIndex + 1]);
      createServer((_request, response) => response.end("nested ready")).listen(port, "127.0.0.1");
    `,
    );
    const project = {
      ...createProject(workspacePath),
      startupDirectory: "apps/game",
      startupScript: "start",
    };
    const manager = new PreviewManager(new RuntimeEventBus(), {
      readinessTimeoutMs: 2_000,
    });
    managers.push(manager);

    const url = await manager.start(project);
    expect(await (await fetch(url)).text()).toBe("nested ready");
  });
});

async function createWorkspace(fail: boolean): Promise<string> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "ohmygame-preview-"));
  await mkdir(path.join(workspacePath, "node_modules", ".bin"), {
    recursive: true,
  });
  await writeFile(path.join(workspacePath, "node_modules", ".bin", "vite"), "");
  await writeFile(
    path.join(workspacePath, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { dev: "node server.mjs" },
    }),
  );
  if (fail) await writeFile(path.join(workspacePath, "fail"), "");
  await writeFile(
    path.join(workspacePath, "server.mjs"),
    `
    import { existsSync, writeFileSync } from "node:fs";
    import { createServer } from "node:http";
    const portIndex = process.argv.indexOf("--port");
    const port = Number(process.env.PORT || process.argv[portIndex + 1]);
    writeFileSync("server.pid", String(process.pid));
    console.log("server output 1");
    console.log("server output 2");
    console.error("server error");
    if (existsSync("fail")) setInterval(() => {}, 1000);
    else createServer((_request, response) => response.end("ready")).listen(port, "127.0.0.1");
  `,
  );
  return workspacePath;
}

function createProject(workspacePath: string): ProjectState {
  return {
    id: path.basename(workspacePath),
    name: "Preview",
    type: "web-game",
    updatedAt: new Date(0).toISOString(),
    workspacePath,
    preview: { status: "stopped" },
  };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
