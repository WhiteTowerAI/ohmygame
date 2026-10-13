import { webPreviewSettingsChanged } from "../src/shared/project-runtime.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewManager } from "../src/daemon/preview.js";
import { ProjectManager } from "../src/daemon/projects.js";
import {
  previewScriptArguments,
  previewDependencyDirectory,
} from "../src/daemon/preview-launch.js";
import { createPreviewProxy } from "../src/daemon/preview-proxy.js";
import { createServer } from "node:http";
import { previewPageUrl } from "../src/shared/preview-page.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { RuntimeEventBus } from "../src/shared/events.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohmygame-preview-lifecycle-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, "index.html"),
    "<head></head><p>Static General game</p>",
  );
  const project: ProjectState = {
    id: "general",
    name: "General",
    type: "general",
    webPreviewEnabled: true,
    workspacePath: directory,
    updatedAt: new Date().toISOString(),
    preview: { status: "stopped" },
  };
  return { directory, project };
}
function manager(
  options: ConstructorParameters<typeof PreviewManager>[1] = {},
) {
  const result = new PreviewManager(new RuntimeEventBus(), options);
  cleanups.push(() => result.stopAll());
  return result;
}

describe("preview policy and lifecycle", () => {
  it.each(["stop", "disable", "release"])(
    "cancels automatic inspection when users %s before it completes",
    async (action) => {
      const { project } = await fixture();
      const preview = manager();
      preview.acquire(project, "editor:review");
      const pending = preview.automatic(project);
      if (action === "stop") await preview.stop(project);
      if (action === "disable") project.previewAutoStart = false;
      if (action === "release") preview.release(project, "editor:review");
      await pending;
      expect(project.preview.status).toBe("stopped");
      expect(project.preview.url).toBeUndefined();
      if (action === "stop") expect(project.preview.stopReason).toBe("manual");
    },
  );

  it("keeps a manual stop when an unfinished inspection finds no runnable workspace", async () => {
    const { project, directory } = await fixture();
    await rm(path.join(directory, "index.html"));
    const preview = manager();
    preview.acquire(project, "editor:review");
    const pending = preview.automatic(project);
    await preview.stop(project);
    await pending;
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "manual",
    });
  });

  it("lets an explicit Play request take over automatic inspection after the automatic policy changes", async () => {
    const { project } = await fixture();
    const preview = manager();
    preview.acquire(project, "editor:review");
    const pending = preview.automatic(project);
    project.previewAutoStart = false;
    const url = await preview.ensureStarted(project);
    await pending;
    expect(project.preview.status).toBe("ready");
    expect((await fetch(url)).status).toBe(200);
  });

  it("reopens automatically while idle collection is closing the previous server", async () => {
    const { project } = await fixture();
    const preview = manager({ idleTimeoutMs: 10 });
    await preview.ensureStarted(project);
    preview.acquire(project, "editor:old");
    preview.release(project, "editor:old");
    const collecting = preview.collectIdle(Date.now() + 20);
    preview.acquire(project, "editor:new");
    const opening = preview.automatic(project);
    await Promise.all([collecting, opening]);
    expect(project.preview.status).toBe("ready");
    expect((await fetch(project.preview.url!)).status).toBe(200);
  });

  it.each(["disable", "release"])(
    "cancels an automatic launch without an error when users %s after checking starts",
    async (action) => {
      const { project } = await fixture();
      const events = new RuntimeEventBus();
      const preview = new PreviewManager(events);
      cleanups.push(() => preview.stopAll());
      preview.acquire(project, "editor:review");
      const unsubscribe = events.subscribe(project.id, (event) => {
        if (
          event.type === "preview.updated" &&
          event.data.preview.phase === "checking"
        ) {
          if (action === "disable") project.previewAutoStart = false;
          else preview.release(project, "editor:review");
        }
      });
      try {
        await preview.automatic(project);
        expect(project.preview.status).toBe("stopped");
        expect(project.preview.error).toBeUndefined();
        expect(events.since(project.id).at(-1)?.data).toMatchObject({
          preview: { status: "stopped" },
        });
      } finally {
        unsubscribe();
      }
    },
  );

  it.each(["command", "script"] as const)(
    "does not spawn a %s after its launch is cancelled",
    async (mode) => {
      const { project, directory } = await fixture();
      project.previewMode = mode;
      const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
      project.previewCommand = `${executable} server.mjs`;
      await writeFile(
        path.join(directory, "server.mjs"),
        "import {writeFileSync} from 'node:fs';writeFileSync('server.pid',String(process.pid));setInterval(()=>{},1000);",
      );
      if (mode === "script") {
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ scripts: { dev: "node server.mjs" } }),
        );
        await mkdir(path.join(directory, "node_modules"));
      }
      const events = new RuntimeEventBus();
      const preview = new PreviewManager(events);
      cleanups.push(() => preview.stopAll());
      let stopping: Promise<void> | undefined;
      const unsubscribe = events.subscribe(project.id, (event) => {
        if (
          event.type === "preview.updated" &&
          event.data.preview.phase === "launching"
        )
          stopping = preview.stop(project);
      });
      try {
        await expect(preview.start(project)).rejects.toThrow("cancelled");
        await stopping;
        expect(stopping).toBeDefined();
        expect(project.preview.status).toBe("stopped");
        await new Promise((resolve) => setTimeout(resolve, 150));
        await expect(
          readFile(path.join(directory, "server.pid")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        unsubscribe();
      }
    },
  );

  it("supports static General games and preserves their origin across stops and daemon restarts", async () => {
    const { directory, project } = await fixture();
    const first = manager();
    const url = await first.ensureStarted(project);
    expect(await (await fetch(url)).text()).toContain("Static General game");
    await first.stop(project);
    expect(await first.ensureStarted(project)).toBe(url);
    await first.stopAll();
    const second = manager();
    const restored = { ...project, preview: { status: "stopped" as const } };
    expect(await second.ensureStarted(restored)).toBe(url);
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, ".data/preview-origin.json"),
          "utf8",
        ),
      ).port,
    ).toBe(Number(new URL(url).port));
  });

  it("redirects static directory pages through the preview proxy and preserves their client", async () => {
    const { directory, project } = await fixture();
    const nested = path.join(directory, "level one");
    await mkdir(nested);
    await writeFile(
      path.join(nested, "index.html"),
      '<head></head><script type="module" src="./game.js"></script>',
    );
    await writeFile(path.join(nested, "game.js"), "export const ready = true;");
    const origin = await manager().ensureStarted(project);
    const url = previewPageUrl(
      `${origin}/level%20one?level=2&label=a%2Fb`,
      "editor",
      "static-redirect",
    );

    const redirect = await fetch(url, { redirect: "manual" });
    expect(redirect.status).toBe(301);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin).toBe(origin);
    expect(location.pathname).toBe("/level%20one/");
    expect(location.searchParams.get("level")).toBe("2");
    expect(location.searchParams.get("label")).toBe("a/b");
    expect(location.searchParams.get("__ohmygame_client")).toBe(
      "static-redirect",
    );
    expect(location.searchParams.get("__ohmygame_view")).toBe("editor");
    expect(await redirect.text()).toBe("");

    const response = await fetch(location, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
    const html = await response.text();
    expect(html).toContain('src="./game.js"');
    expect(html).toContain("__ohmygame_preview_bridge__");
    const script = await fetch(new URL("./game.js", response.url));
    expect(script.status).toBe(200);
    expect(await script.text()).toBe("export const ready = true;");
  });

  it("respects manual mode and keeps a manual stop across file changes and project reopen", async () => {
    const { directory, project } = await fixture();
    project.previewAutoStart = false;
    const preview = manager();
    preview.acquire(project, "editor:first", true);
    await preview.automatic(project);
    expect(project.preview.status).toBe("stopped");
    await preview.ensureStarted(project);
    await preview.stop(project);
    project.previewAutoStart = true;
    await writeFile(path.join(directory, "index.html"), "<p>Edited</p>");
    preview.release(project, "editor:first");
    preview.acquire(project, "editor:second", true);
    await preview.automatic(project, true);
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "manual",
    });
    await preview.ensureStarted(project);
    expect(project.preview.status).toBe("ready");
  });

  it("keeps a preview while a player or test uses it and collects it after the last lease closes", async () => {
    const { project } = await fixture();
    const preview = manager({ idleTimeoutMs: 10, leaseTimeoutMs: 100_000 });
    await preview.ensureStarted(project);
    preview.acquire(project, "editor:first");
    preview.touch(project, "page:player");
    preview.touch(project, "page:test");
    preview.release(project, "editor:first");
    await preview.collectIdle(Date.now() + 1_000);
    expect(project.preview.status).toBe("ready");
    preview.release(project, "page:player");
    await preview.collectIdle(Date.now() + 1_000);
    expect(project.preview.status).toBe("ready");
    preview.release(project, "page:test");
    await preview.collectIdle(Date.now() + 1_000);
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "idle",
    });
  });

  it("expires abandoned leases and allows idle previews to start again on project open", async () => {
    const { project } = await fixture();
    const preview = manager({ idleTimeoutMs: 10, leaseTimeoutMs: 10 });
    await preview.ensureStarted(project);
    preview.acquire(project, "editor:abandoned");
    const now = Date.now();
    await preview.collectIdle(now + 20);
    await preview.collectIdle(now + 40);
    expect(project.preview.status).toBe("stopped");
    preview.acquire(project, "editor:new", true);
    await vi.waitFor(() => expect(project.preview.status).toBe("ready"));
  });

  it("keeps recovered projects paused even when files change and agents finish", async () => {
    const { project } = await fixture();
    const preview = manager();
    preview.acquire(project, "editor:recovered", true, true);
    await preview.automatic(project, true);
    expect(project.preview).toMatchObject({
      status: "stopped",
      stopReason: "recovery",
    });
    await preview.ensureStarted(project);
    expect(project.preview.status).toBe("ready");
  });

  it("starts an open General project when static browser output appears", async () => {
    const { directory, project } = await fixture();
    await rm(path.join(directory, "index.html"));
    const preview = manager();
    preview.acquire(project, "editor:creating", true);
    await vi.waitFor(() => expect(project.preview.status).toBe("waiting"));
    await writeFile(
      path.join(directory, "index.html"),
      "<head></head><p>Created by agent</p>",
    );
    await vi.waitFor(() => expect(project.preview.status).toBe("ready"), {
      timeout: 2_000,
    });
    expect(await (await fetch(project.preview.url!)).text()).toContain(
      "Created by agent",
    );
  });

  it("forgets deleted projects immediately and allows a fresh session without the old manual pause", async () => {
    const { project } = await fixture();
    const preview = manager();
    preview.acquire(project, "editor:old");
    const url = await preview.ensureStarted(project);
    await preview.forget(project);
    await expect(fetch(url)).rejects.toThrow();
    preview.acquire(project, "editor:new", true);
    await vi.waitFor(() => expect(project.preview.status).toBe("ready"));
  });

  it("serves static routes while blocking dotfiles and symlinks outside the workspace", async () => {
    const { directory, project } = await fixture();
    await writeFile(path.join(directory, ".env"), "secret");
    const outside = await mkdtemp(
      path.join(tmpdir(), "ohmygame-preview-outside-"),
    );
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(path.join(outside, "secret.txt"), "outside");
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(directory, "escape.txt"),
    );
    const url = await manager().ensureStarted(project);
    expect((await fetch(`${url}/.env`)).status).toBe(403);
    expect((await fetch(`${url}/escape.txt`)).status).toBe(403);
    expect(
      await (
        await fetch(`${url}/play`, { headers: { accept: "text/html" } })
      ).text(),
    ).toContain("Static General game");
  });

  it("runs arbitrary local server commands without Node dependencies and cancels their process tree", async () => {
    const { directory, project } = await fixture();
    const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    await writeFile(
      path.join(directory, "server.mjs"),
      `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; writeFileSync('command.pid', String(process.pid)); createServer((q,r)=>r.end('Custom General game')).listen(Number(process.env.PORT),process.env.HOST);`,
    );
    project.previewMode = "command";
    project.previewCommand = `${executable} server.mjs`;
    const preview = manager({ readinessTimeoutMs: 2_000 });
    expect(
      await (await fetch(await preview.ensureStarted(project))).text(),
    ).toBe("Custom General game");
    const pid = Number(
      await readFile(path.join(directory, "command.pid"), "utf8"),
    );
    await preview.stop(project);
    // The shell's close event can precede the OS reaping its descendants.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2_000 });
    project.previewCommand = `${executable} -e "setInterval(()=>{},1000)"`;
    const pending = preview.start(project);
    const rejection = expect(pending).rejects.toThrow("superseded");
    await vi.waitFor(() => expect(project.preview.phase).toBe("connecting"));
    await preview.stop(project);
    await rejection;
    expect(project.preview.status).toBe("stopped");
  });
});

it("bounds dependency installation and leaves cancelled installs retryable", async () => {
  const { directory, project } = await fixture();
  project.previewMode = "script";
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      scripts: { dev: "node server.mjs", postinstall: "node install.mjs" },
    }),
  );
  await writeFile(
    path.join(directory, "install.mjs"),
    "import {writeFileSync} from 'node:fs';writeFileSync('installer.pid',String(process.pid));console.log('Installing fixture');setInterval(()=>{},1000);",
  );
  const preview = manager({ installTimeoutMs: 2_000 });
  const pending = preview.start(project);
  const rejected = expect(pending).rejects.toThrow("installation timed out");
  await vi.waitFor(() => expect(project.preview.phase).toBe("installing"));
  await rejected;
  expect(project.preview.status).toBe("error");
  expect(project.preview.logs).toContain("Installing fixture");
  const pid = Number(
    await readFile(path.join(directory, "installer.pid"), "utf8"),
  );
  expect(() => process.kill(pid, 0)).toThrow();
  expect(
    await readFile(path.join(directory, ".ohmygame-install-pending"), "utf8"),
  ).toContain("not completed");
});

describe("General project startup configuration", () => {
  it("uses framework-specific arguments and environment-only startup for unknown scripts", () => {
    expect(previewScriptArguments("vite", 1234)).toContain("--strictPort");
    expect(previewScriptArguments("next dev", 1234)).toEqual([
      "--hostname",
      "127.0.0.1",
      "--port",
      "1234",
    ]);
    expect(previewScriptArguments("astro dev", 1234)).not.toContain(
      "--strictPort",
    );
    expect(previewScriptArguments("node server.mjs", 1234)).toEqual([]);
    expect(
      previewScriptArguments("whatever", 1234, ["--listen", "{host}:{port}"]),
    ).toEqual(["--listen", "127.0.0.1:1234"]);
  });
  it("finds the monorepo owner without searching outside the selected workspace", async () => {
    const { directory } = await fixture();
    const nested = path.join(directory, "apps/game");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ workspaces: ["apps/*"] }),
    );
    await writeFile(path.join(nested, "package.json"), "{}");
    expect(await previewDependencyDirectory(directory, nested)).toBe(directory);
    expect(await previewDependencyDirectory(nested, nested)).toBe(nested);
  });
  it("persists and duplicates preview settings while keeping disabled General projects opt-in", async () => {
    const { directory } = await fixture();
    const projects = new ProjectManager(path.join(directory, "library"));
    await projects.load();
    const project = await projects.create("General", "general");
    const settings = {
      startupDirectory: ".",
      startupScript: "dev",
      previewPath: "/play",
      previewViewport: "mobile" as const,
      webPreviewEnabled: true,
      previewMode: "command" as const,
      previewCommand: "python3 -m http.server {port} --bind {host}",
      previewAutoStart: false,
      previewIdleMinutes: 3,
      previewPort: 8000,
    };
    await projects.setRunSettings(project.id, settings);
    const copy = await projects.duplicate(project.id);
    expect({
      ...copy,
      startupDirectory: copy.startupDirectory ?? ".",
      startupScript: copy.startupScript ?? "dev",
    }).toMatchObject(settings);
    const reloaded = new ProjectManager(path.join(directory, "library"));
    await reloaded.load();
    const loaded = reloaded.get(project.id)!;
    expect({
      ...loaded,
      startupDirectory: loaded.startupDirectory ?? ".",
      startupScript: loaded.startupScript ?? "dev",
    }).toMatchObject(settings);
    await expect(
      projects.setRunSettings(project.id, { ...settings, previewCommand: "" }),
    ).rejects.toThrow("Enter a command");
  });
});

it("isolates diagnostics from different windows and ignores reports from replaced documents", async () => {
  const server = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end("<head></head>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const updates: unknown[][] = [];
  const proxy = await createPreviewProxy(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    (...args) => updates.push(args),
  );
  cleanups.push(() => proxy.close());
  const document = async (client: string, source: "editor" | "playtest") => {
    const html = await (
      await fetch(previewPageUrl(proxy.url, source, client))
    ).text();
    return new URL(html.match(/src="([^"]+bridge[^"]+)"/)![1], proxy.url).href;
  };
  const report = (endpoint: string, diagnostic: unknown) =>
    fetch(endpoint, {
      method: "POST",
      headers: { origin: proxy.url, "content-type": "application/json" },
      body: JSON.stringify({ type: "diagnostic", diagnostic }),
    });
  const editor = await document("editor", "editor");
  await report(editor, { kind: "runtime", message: "Editor failed" });
  const test = await document("test", "playtest");
  expect((updates.at(-1)?.[1] as { source: string }[])[0].source).toBe(
    "editor",
  );
  await report(test, { kind: "runtime", message: "Test failed" });
  await report(test, null);
  expect(
    (updates.at(-1)?.[1] as { message: string }[]).map((d) => d.message),
  ).toEqual(["Editor failed"]);
  await document("editor", "editor");
  await report(editor, { kind: "runtime", message: "Old editor failed" });
  expect(updates.at(-1)?.[0]).toBeUndefined();
});

it("does not restart when saving equivalent defaults or changing display and policy settings", async () => {
  const { project } = await fixture();
  expect(
    webPreviewSettingsChanged(project, {
      ...project,
      previewMode: "auto",
      previewCommand: "",
      previewAutoStart: false,
      previewViewport: "mobile",
      previewIdleMinutes: 1,
    }),
  ).toBe(false);
  expect(
    webPreviewSettingsChanged(project, { ...project, previewMode: "static" }),
  ).toBe(true);
});
