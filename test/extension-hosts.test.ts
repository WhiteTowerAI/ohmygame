import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ExtensionHostError,
  ExtensionHosts,
} from "../src/daemon/extension-hosts.js";
import { ToolBridge } from "../src/daemon/agent-runtimes/tool-bridge.js";
import { NativePlugins } from "../src/daemon/native-plugins.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import {
  adoptTypedProject,
  availableProjectTypes,
  buildWebPreview,
  createTypedProject,
  projectKind,
  projectKindAt,
  recognizeProjectTypes,
} from "../src/daemon/project-types.js";
import {
  PluginGrants,
  projectFolderKey,
  setProjectPlugin,
  writeProjectFile,
} from "../src/daemon/project-plugins.js";
import type { ExtensionHostPlugin } from "../src/shared/extension-host-protocol.js";

// Plugins that behave, and plugins that hang, crash or fail to activate.
const SOURCES: Record<string, string> = {
  tools: `
    let activations = 0;
    export function activate(context) {
      activations += 1;
      context.registerTool("echo", async (input, call) => {
        call.progress("halfway");
        return { input, activations };
      });
      context.registerTool("pid", () => process.pid);
      context.registerTool("wait", (_input, call) =>
        new Promise((resolve) =>
          call.signal.addEventListener("abort", () => resolve("stopped")),
        ),
      );
      context.registerTool("spin", () => { for (;;) {} });
      context.registerTool("crash", () => {
        setImmediate(() => { throw new Error("boom"); });
        return new Promise(() => {});
      });
      context.registerTool("hog", () => {
        const kept = [];
        for (;;) kept.push(new Array(1e5).fill(kept.length));
      });
      context.registerTool("where", () => ({ project: context.project }));
      context.registerTool("bogus", () => {
        // Messages a broken host might send; none of them may hurt the daemon.
        for (let id = 0; id < 50; id += 1) {
          process.send({ type: "error", id, message: { toString: 0 } });
          process.send({ type: "activated", id, tools: "all" });
          process.send({ type: "stats", id, stats: null });
        }
        process.send({ type: "ready", protocol: "?" });
        process.send("nonsense");
        return "still here";
      });
      context.registerTool("bigint", () => 1n);
      context.registerTool("huge", () => "x".repeat(9 * 1024 * 1024));
      context.registerTool("spawnChild", async () => {
        const { spawn } = await import("node:child_process");
        const child = spawn("sleep", ["30"], { stdio: "ignore" });
        setTimeout(() => { throw new Error("boom"); }, 100);
        return child.pid;
      });
      context.registerCommand("greet", (input) => "hi " + input);
      context.onDispose(async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(new URL("./disposed.txt", import.meta.url), "yes");
      });
      context.onDispose(() => { activations = 0; });
    }
  `,
  "versioned-1": `
    export function activate(context) {
      context.registerTool("which", () => "1");
      context.registerTool("slow", () =>
        new Promise((resolve) => setTimeout(() => resolve("1 finished"), 300)),
      );
    }
  `,
  "versioned-2": `
    export function activate(context) {
      context.registerTool("which", () => "2");
      context.registerTool("slow", () => "2 finished");
    }
  `,
  slowstart: `
    export async function activate(context) {
      context.onDispose(async () => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(new URL("./disposed.txt", import.meta.url), "yes");
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      context.registerTool("pid", () => process.pid);
    }
  `,
  sneaky: `
    export function activate(context) {
      context.registerTool("listed", () => 1);
      context.registerTool("hidden", () => 2);
    }
  `,
  other: `
    export function activate(context) {
      context.registerTool("pid", () => process.pid);
    }
  `,
  broken: `
    export function activate() { throw new Error("cannot start"); }
  `,
};

const TOOLS: Record<string, string[]> = {
  tools: [
    "echo",
    "pid",
    "wait",
    "spin",
    "crash",
    "hog",
    "where",
    "bogus",
    "bigint",
    "huge",
    "spawnChild",
  ],
  "versioned-1": ["which", "slow"],
  "versioned-2": ["which", "slow"],
  sneaky: ["listed"],
  slowstart: ["pid"],
  other: ["pid"],
  broken: ["anything"],
};

let root: string;
const plugin = (name: string, version = "1.0.0"): ExtensionHostPlugin => ({
  id: `test/${name}`,
  version,
  root: path.join(root, name),
  entry: "index.mjs",
  tools: TOOLS[name] ?? [],
  commands: name === "tools" ? ["greet"] : [],
  projectTypes: [],
});

/** Two versions of one plugin, in their own folders. */
const versioned = (version: 1 | 2): ExtensionHostPlugin => ({
  ...plugin(`versioned-${version}`, `${version}.0.0`),
  id: "test/versioned",
});

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ohmygame-extension-hosts-"));
  for (const [name, source] of Object.entries(SOURCES)) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "index.mjs"), source);
  }
  return () => rm(root, { recursive: true, force: true });
});

const hostsToDispose: ExtensionHosts[] = [];
afterEach(async () => {
  await Promise.all(hostsToDispose.splice(0).map((hosts) => hosts.dispose()));
});

function hosts(options: ConstructorParameters<typeof ExtensionHosts>[0] = {}) {
  const created = new ExtensionHosts({
    callTimeoutMs: 5_000,
    cancelGraceMs: 200,
    ...options,
  });
  hostsToDispose.push(created);
  return created;
}

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ExtensionHostError);
  return error as ExtensionHostError;
};

describe("extension hosts", () => {
  it("starts a host on the first call and activates each plugin once", async () => {
    const extensionHosts = hosts();
    expect(await extensionHosts.status()).toEqual([]);
    const progress: string[] = [];
    const first = await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "echo",
      input: { a: 1 },
      onProgress: (message) => progress.push(message),
    });
    const second = await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "echo",
      input: 2,
    });
    expect(first).toEqual({ input: { a: 1 }, activations: 1 });
    expect(second).toEqual({ input: 2, activations: 1 });
    expect(progress).toEqual(["halfway"]);
    const [status] = await extensionHosts.status();
    expect(status.scope).toBe("app");
    expect(status.plugins["test/tools"].tools).toContain("echo");
    expect(status.stats?.rss).toBeGreaterThan(0);
  });

  it("keeps app and each project in their own host", async () => {
    const extensionHosts = hosts();
    const pid = (scope: string) =>
      extensionHosts.invoke({ scope, plugin: plugin("tools"), tool: "pid" });
    const [app, a, b, aAgain] = await Promise.all([
      pid("app"),
      pid("project-a"),
      pid("project-b"),
      pid("project-a"),
    ]);
    expect(new Set([app, a, b]).size).toBe(3);
    expect(aAgain).toBe(a);
    expect(app).not.toBe(process.pid);
  });

  it("cancels a call that listens to its signal without stopping the host", async () => {
    const extensionHosts = hosts();
    const before = await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "pid",
    });
    const controller = new AbortController();
    const call = extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "wait",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    expect((await failure(call)).code).toBe("cancelled");
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "pid",
      }),
    ).toBe(before);
  });

  it("stops a host whose call never yields, and starts a fresh one for the next call", async () => {
    const extensionHosts = hosts();
    const before = await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "pid",
    });
    const error = await failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "spin",
        timeoutMs: 100,
      }),
    );
    expect(error.code).toBe("timeout");
    const after = await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "pid",
    });
    expect(after).not.toBe(before);
  });

  it("fails calls in flight when a host crashes, without touching other hosts", async () => {
    const extensionHosts = hosts();
    const other = await extensionHosts.invoke({
      scope: "project-b",
      plugin: plugin("other"),
      tool: "pid",
    });
    const waiting = extensionHosts.invoke({
      scope: "project-a",
      plugin: plugin("tools"),
      tool: "wait",
    });
    const crash = extensionHosts.invoke({
      scope: "project-a",
      plugin: plugin("tools"),
      tool: "crash",
    });
    expect((await failure(crash)).code).toBe("crashed");
    expect((await failure(waiting)).code).toBe("crashed");
    expect(
      await extensionHosts.invoke({
        scope: "project-b",
        plugin: plugin("other"),
        tool: "pid",
      }),
    ).toBe(other);
  });

  it("quarantines a plugin that keeps stopping its host until it is released", async () => {
    const extensionHosts = hosts({ crashLimit: 2 });
    const crash = () =>
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "crash",
      });
    expect((await failure(crash())).code).toBe("crashed");
    expect((await failure(crash())).code).toBe("crashed");
    expect((await failure(crash())).code).toBe("quarantined");
    // Other plugins keep working.
    await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("other"),
      tool: "pid",
    });
    extensionHosts.release("test/tools");
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "echo",
        input: "back",
      }),
    ).toMatchObject({ input: "back" });
  });

  it("reports a plugin that fails to activate and keeps the host for others", async () => {
    const extensionHosts = hosts();
    const error = await failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("broken"),
        tool: "anything",
      }),
    );
    expect(error.code).toBe("failed");
    expect(error.message).toContain("cannot start");
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("other"),
        tool: "pid",
      }),
    ).toEqual(expect.any(Number));
    expect(extensionHosts.quarantined("test/broken")).toBe(false);
  });

  it("disposes a deactivated plugin's registrations", async () => {
    const extensionHosts = hosts();
    const echo = () =>
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "echo",
      });
    expect(await echo()).toMatchObject({ activations: 1 });
    await extensionHosts.deactivate("app", "test/tools");
    // onDispose reset the counter; the next call activates it again.
    expect(await echo()).toMatchObject({ activations: 1 });
  });

  it("runs only the tools and commands the manifest declares", async () => {
    const extensionHosts = hosts();
    const error = await failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("sneaky"),
        tool: "listed",
      }),
    );
    expect(error.message).toContain("does not declare a tool named hidden");
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        command: "greet",
        input: "there",
      }),
    ).toBe("hi there");
    // A tool and a command are separate names.
    expect(
      (
        await failure(
          extensionHosts.invoke({
            scope: "app",
            plugin: plugin("tools"),
            tool: "greet",
          }),
        )
      ).message,
    ).toContain("no tool named greet");
  });

  it("starts a project's host in its folder and tells plugins which it is", async () => {
    const extensionHosts = hosts();
    const folder = await realpath(root);
    expect(
      await extensionHosts.invoke({
        scope: folder,
        project: folder,
        plugin: plugin("tools"),
        tool: "where",
      }),
    ).toEqual({ project: { folder } });
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "where",
      }),
    ).not.toHaveProperty("project");
  });

  it("switches versions once the running version's calls finish", async () => {
    const extensionHosts = hosts();
    const order: string[] = [];
    const call = (version: 1 | 2, tool: string) =>
      extensionHosts
        .invoke({ scope: "app", plugin: versioned(version), tool })
        .then((value) => {
          order.push(String(value));
          return value;
        });
    expect(await call(1, "which")).toBe("1");
    const slow = call(1, "slow");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await call(2, "which")).toBe("2");
    expect(await slow).toBe("1 finished");
    expect(order).toEqual(["1", "1 finished", "2"]);
    expect(extensionHosts.active("app")["test/versioned"]?.version).toBe(
      "2.0.0",
    );
  });

  it("turns a plugin off even while it switches versions", async () => {
    const extensionHosts = hosts();
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: versioned(1),
        tool: "which",
      }),
    ).toBe("1");
    const slow = failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: versioned(1),
        tool: "slow",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const newer = failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: versioned(2),
        tool: "which",
      }),
    );
    await extensionHosts.deactivate("app", "test/versioned");
    expect((await slow).code).toBe("cancelled");
    expect((await newer).code).toBe("unavailable");
    expect(extensionHosts.active("app")).toEqual({});
  });

  // The heap limit is a V8 flag; under Bun, which runs these tests, hosts run
  // on JavaScriptCore and ignore it.
  it.skipIf(Boolean(process.versions.bun))(
    "counts running out of memory as a crash",
    async () => {
      const extensionHosts = hosts({ maxHeapMb: 32, crashLimit: 1 });
      const error = await failure(
        extensionHosts.invoke({
          scope: "app",
          plugin: plugin("tools"),
          tool: "hog",
          timeoutMs: 20_000,
        }),
      );
      expect(error.code).toBe("crashed");
      expect(extensionHosts.quarantined("test/tools")).toBe(true);
    },
    30_000,
  );

  it("survives messages and values IPC can't carry", async () => {
    const extensionHosts = hosts();
    const pid = () =>
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "pid",
      });
    const before = await pid();
    expect(
      await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "bogus",
      }),
    ).toBe("still here");
    const input = await failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "echo",
        input: 1n,
        timeoutMs: 100,
      }),
    );
    expect(input.code).toBe("failed");
    for (const tool of ["bigint", "huge"])
      expect(
        (
          await failure(
            extensionHosts.invoke({
              scope: "app",
              plugin: plugin("tools"),
              tool,
            }),
          )
        ).code,
      ).toBe("failed");
    // The refused input's time limit passing doesn't stop the host.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await pid()).toBe(before);
    expect(extensionHosts.quarantined("test/tools")).toBe(false);
  });

  it("cancels a turned-off plugin's running calls", async () => {
    const extensionHosts = hosts();
    const waiting = failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "wait",
      }),
    );
    await vi.waitFor(() =>
      expect(extensionHosts.active("app")["test/tools"]?.loaded).toBe(true),
    );
    await extensionHosts.deactivate("app", "test/tools");
    expect((await waiting).code).toBe("cancelled");
    expect(extensionHosts.active("app")).toEqual({});
  });

  it("lets plugins clean up when their host stops", async () => {
    const extensionHosts = hosts();
    await rm(path.join(root, "tools/disposed.txt"), { force: true });
    await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "pid",
    });
    await extensionHosts.stop("app");
    expect(await readFile(path.join(root, "tools/disposed.txt"), "utf8")).toBe(
      "yes",
    );
  });

  it("lets a plugin that is still activating clean up when its host stops", async () => {
    const extensionHosts = hosts({ cancelGraceMs: 2_000 });
    await rm(path.join(root, "slowstart/disposed.txt"), { force: true });
    const call = failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("slowstart"),
        tool: "pid",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await extensionHosts.stop("app");
    expect((await call).code).toBe("crashed");
    expect(
      await readFile(path.join(root, "slowstart/disposed.txt"), "utf8"),
    ).toBe("yes");
  });

  it.skipIf(process.platform === "win32")(
    "stops what a plugin started when its host crashes",
    async () => {
      const extensionHosts = hosts();
      const child = (await extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "spawnChild",
      })) as number;
      const running = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(running()).toBe(true);
      await vi.waitFor(() => expect(running()).toBe(false), { timeout: 5_000 });
    },
  );

  it("keeps a quarantined plugin off after its crashes are old", async () => {
    const extensionHosts = hosts({ crashLimit: 1, crashWindowMs: 50 });
    await failure(
      extensionHosts.invoke({
        scope: "app",
        plugin: plugin("tools"),
        tool: "crash",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(extensionHosts.quarantined("test/tools")).toBe(true);
  });

  it("starts nothing once disposed", async () => {
    const extensionHosts = hosts();
    await extensionHosts.dispose();
    expect(
      (
        await failure(
          extensionHosts.invoke({
            scope: "app",
            plugin: plugin("tools"),
            tool: "pid",
          }),
        )
      ).message,
    ).toContain("shut down");
  });

  it("stops an idle host", async () => {
    const extensionHosts = hosts({ idleMs: 100 });
    await extensionHosts.invoke({
      scope: "app",
      plugin: plugin("tools"),
      tool: "pid",
    });
    expect(await extensionHosts.status()).toHaveLength(1);
    await vi.waitFor(
      async () => expect(await extensionHosts.status()).toEqual([]),
      { timeout: 3_000 },
    );
  });
});

// --- Native plugins in projects ------------------------------------------

/** A native plugin package; later versions can ask for more. */
async function nativePackage(
  version: string,
  options: { network?: string[]; answer?: string; slowActivate?: boolean } = {},
) {
  const dir = path.join(root, `packages/tiles-${version}`);
  await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(dir, "tools"), { recursive: true });
  await writeFile(
    path.join(dir, "tools/where.json"),
    JSON.stringify({ type: "object", properties: {} }),
  );
  await writeFile(
    path.join(dir, "tools/count.json"),
    JSON.stringify({
      type: "object",
      properties: { wrong: { type: "boolean" } },
      additionalProperties: false,
    }),
  );
  await writeFile(
    path.join(dir, "tools/count-output.json"),
    JSON.stringify({
      type: "object",
      properties: { n: { type: "integer" } },
      required: ["n"],
    }),
  );
  await writeFile(
    path.join(dir, "index.mjs"),
    `export async function activate(context) {
      ${options.slowActivate ? "await new Promise((resolve) => setTimeout(resolve, 300));" : ""}
      context.registerTool("where", () => ({
        folder: context.project?.folder,
        version: context.version,
        answer: ${JSON.stringify(options.answer ?? "tiles")},
      }));
      context.registerTool("count", (input, call) => {
        call.progress("counting");
        return { n: input.wrong ? "many" : 3 };
      });
      context.registerCommand("tidyUp", () => "tidy");
    }`,
  );
  await writeManifest(dir, version, options.network);
  return dir;
}

async function writeManifest(dir: string, version: string, network?: string[]) {
  await writeFile(
    path.join(dir, ".ohmygame-plugin/plugin.json"),
    JSON.stringify({
      id: "acme/tiles",
      version,
      engines: { "ohmygame-api": "^2.0.0" },
      displayName: "Tiles",
      description: "Tile tools.",
      entrypoints: { native: "./index.mjs" },
      capabilities: { native: true, ...(network ? { network } : {}) },
      contributes: {
        tools: [
          {
            name: "where",
            description: "Says where it runs.",
            input: "./tools/where.json",
          },
          {
            name: "count",
            description: "Counts tiles.",
            input: "./tools/count.json",
            output: "./tools/count-output.json",
          },
        ],
        commands: [
          { id: "tidy-up", title: "Tidy up", run: { native: "tidyUp" } },
        ],
      },
    }),
  );
}

async function nativeSetup() {
  const data = await mkdtemp(path.join(tmpdir(), "ohmygame-native-data-"));
  const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-native-project-"));
  const index = new PluginIndex(path.join(data, "plugin-index.json"));
  const grants = new PluginGrants(path.join(data, "plugin-grants.json"));
  await grants.load();
  const extensionHosts = hosts();
  const runtime = new NativePlugins({ index, grants, hosts: extensionHosts });
  const install = async (dir: string) => {
    const result = await index.add(dir);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
  };
  const use = (version: string) =>
    writeProjectFile(
      folder,
      (file) => ({ ...file, plugins: { "acme/tiles": version } }),
      { type: "general", plugins: { "acme/tiles": version } },
    );
  const key = await projectFolderKey(folder);
  const allow = async (allowed: string[] = ["native"]) => {
    await grants.consent("acme/tiles", allowed);
    await grants.approve(key, "acme/tiles", allowed);
  };
  return {
    data,
    folder,
    key,
    index,
    grants,
    extensionHosts,
    runtime,
    install,
    use,
    allow,
    cleanup: () =>
      Promise.all(
        [data, folder].map((dir) => rm(dir, { recursive: true, force: true })),
      ),
  };
}

describe("native plugins", () => {
  it("loads nothing until the person allows the plugin in the project", async () => {
    const setup = await nativeSetup();
    try {
      await setup.install(await nativePackage("1.0.0"));
      await setup.use("1.0.0");
      const refused = await failure(
        setup.runtime.callTool("acme/tiles:where", { folder: setup.folder }),
      );
      expect(refused.code).toBe("unavailable");
      expect(refused.message).toContain("needs-consent");
      expect(setup.extensionHosts.scopes()).toEqual([]);

      await setup.allow();
      expect(
        await setup.runtime.callTool("acme/tiles:where", {
          folder: setup.folder,
        }),
      ).toEqual({ folder: setup.key, version: "1.0.0", answer: "tiles" });
      expect(
        await setup.runtime.runCommand("acme/tiles:tidy-up", {
          folder: setup.folder,
        }),
      ).toBe("tidy");
      // Only what the manifest declares, checked before the host is asked.
      for (const call of [
        () =>
          setup.runtime.callTool("acme/tiles:tidyUp", { folder: setup.folder }),
        () =>
          setup.runtime.callTool("acme/other:where", { folder: setup.folder }),
        () =>
          setup.runtime.runCommand("acme/tiles:where", {
            folder: setup.folder,
          }),
      ])
        expect((await failure(call())).code).toBe("unavailable");
      expect(await setup.runtime.projectStatus(setup.folder)).toEqual([
        {
          id: "acme/tiles",
          version: "1.0.0",
          status: "active",
          quarantined: false,
          loaded: true,
        },
      ]);
    } finally {
      await setup.cleanup();
    }
  });

  it("unloads a plugin the project stops allowing", async () => {
    const setup = await nativeSetup();
    try {
      await setup.install(await nativePackage("1.0.0"));
      await setup.use("1.0.0");
      await setup.allow();
      await setup.runtime.callTool("acme/tiles:where", {
        folder: setup.folder,
      });
      expect(setup.extensionHosts.active(setup.key)).toHaveProperty(
        "acme/tiles",
      );
      await setup.grants.revoke(setup.key, "acme/tiles");
      await setup.runtime.refresh();
      expect(setup.extensionHosts.active(setup.key)).toEqual({});
      expect(
        (
          await failure(
            setup.runtime.callTool("acme/tiles:where", {
              folder: setup.folder,
            }),
          )
        ).message,
      ).toContain("needs-approval");
    } finally {
      await setup.cleanup();
    }
  });

  it("refuses a call whose plugin was revoked while it activated", async () => {
    const setup = await nativeSetup();
    try {
      await setup.install(await nativePackage("1.0.0", { slowActivate: true }));
      await setup.use("1.0.0");
      await setup.allow();
      const call = failure(
        setup.runtime.callTool("acme/tiles:where", { folder: setup.folder }),
      );
      await vi.waitFor(() =>
        expect(setup.extensionHosts.active(setup.key)).toHaveProperty(
          "acme/tiles",
        ),
      );
      await setup.grants.revoke(setup.key, "acme/tiles");
      await setup.runtime.refreshProject(setup.folder);
      expect((await call).code).toBe("unavailable");
      expect(setup.extensionHosts.active(setup.key)).toEqual({});
    } finally {
      await setup.cleanup();
    }
  });

  it("moves a running project to the version its file names", async () => {
    const setup = await nativeSetup();
    try {
      await setup.install(await nativePackage("1.0.0"));
      await setup.install(await nativePackage("1.1.0", { answer: "newer" }));
      await setup.use("1.0.0");
      await setup.allow();
      const where = () =>
        setup.runtime.callTool("acme/tiles:where", { folder: setup.folder });
      expect(await where()).toMatchObject({ version: "1.0.0" });
      await setup.use("1.1.0");
      await setup.runtime.refreshProject(setup.folder);
      expect(setup.extensionHosts.active(setup.key)).toEqual({});
      expect(await where()).toEqual({
        folder: setup.key,
        version: "1.1.0",
        answer: "newer",
      });
    } finally {
      await setup.cleanup();
    }
  });

  it("asks again when a package changed on disk wants more", async () => {
    const setup = await nativeSetup();
    try {
      const dir = await nativePackage("1.0.0");
      await setup.install(dir);
      await setup.use("1.0.0");
      await setup.allow();
      await writeManifest(dir, "1.0.0", ["api.example.com"]);
      const refused = await failure(
        setup.runtime.callTool("acme/tiles:where", { folder: setup.folder }),
      );
      expect(refused.message).toContain("needs-consent");
      expect(setup.extensionHosts.scopes()).toEqual([]);
    } finally {
      await setup.cleanup();
    }
  });
});

describe("plugin tools", () => {
  it("registers a project's plugin tools once for every agent", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-tools-"));
    const folder = await mkdtemp(
      path.join(tmpdir(), "ohmygame-tools-project-"),
    );
    const services = new PluginServices({
      directory: data,
      hosts: { callTimeoutMs: 5_000, cancelGraceMs: 200 },
    });
    try {
      expect(await services.agentTools(folder)).toEqual([]);
      const installed = await services.index.add(await nativePackage("1.0.0"));
      expect(installed.ok).toBe(true);
      await writeProjectFile(folder, (file) => file, {
        type: "general",
        plugins: { "acme/tiles": "1.0.0" },
      });
      // Asked for but not allowed: no tools.
      expect(await services.agentTools(folder)).toEqual([]);
      const key = await projectFolderKey(folder);
      await services.grants.consent("acme/tiles", ["native"]);
      await services.grants.approve(key, "acme/tiles", ["native"]);

      const tools = await services.agentTools(folder);
      expect(tools.map((tool) => tool.name)).toEqual([
        "acme__tiles__where",
        "acme__tiles__count",
      ]);
      const count = tools[1]!;
      expect(count).toMatchObject({
        label: "Tiles: count",
        description: "Counts tiles.",
        namespace: { name: "acme__tiles" },
        outputSchema: { required: ["n"] },
      });
      const updates: string[] = [];
      const result = await count.execute(
        "call-1",
        {},
        undefined,
        (update) =>
          updates.push(
            String(
              update.details &&
                (update.details as { progress?: string }).progress,
            ),
          ),
        undefined as never,
      );
      expect(result).toMatchObject({
        content: [{ type: "text", text: '{\n  "n": 3\n}' }],
        structuredContent: { n: 3 },
      });
      expect(updates).toEqual(["counting"]);
      await expect(
        count.execute(
          "call-2",
          { wrong: true },
          undefined,
          undefined,
          undefined as never,
        ),
      ).rejects.toThrow("doesn't match its output schema");

      // The coding agents and external agents get the same definitions.
      const bridge = new ToolBridge(tools);
      expect(bridge.names).toContain("acme__tiles__where");
      const bridged = await bridge.call("acme__tiles__where", {}, "call-3");
      expect(JSON.stringify(bridged)).toContain(key.replaceAll("\\", "\\\\"));
      expect(
        bridge.list("all").find((tool) => tool.name === "acme__tiles__count"),
      ).toMatchObject({ outputSchema: { required: ["n"] } });
      expect(
        (await bridge.call("acme__tiles__count", {}, "call-5")).result,
      ).toMatchObject({ structuredContent: { n: 3 } });

      // A newer version makes older definitions refuse to run, and tells listeners.
      const changes: Array<string | undefined> = [];
      services.onChange((changed) => changes.push(changed));
      expect((await services.install(await nativePackage("1.1.0"))).ok).toBe(
        true,
      );
      await services.setProjectPlugin(folder, "acme/tiles", "1.1.0");
      expect(changes).toEqual([undefined, folder]);
      await expect(
        count.execute("call-6", {}, undefined, undefined, undefined as never),
      ).rejects.toThrow("is now 1.1.0");
      expect(
        (await services.agentTools(folder)).map((tool) => tool.name),
      ).toContain("acme__tiles__count");
      // Editing ohmygame.json outside OhMyGame counts too.
      changes.length = 0;
      await writeFile(
        path.join(folder, "ohmygame.json"),
        JSON.stringify({ type: "general", plugins: { "acme/tiles": "1.0.0" } }),
      );
      await vi.waitFor(() => expect(changes).toContain(folder), {
        timeout: 3_000,
      });
      const refused = await bridge.call(
        "acme__tiles__count",
        { wrong: "yes" },
        "call-4",
      );
      expect(refused.isError).toBe(true);
    } finally {
      await services.close();
      await Promise.all(
        [data, folder].map((dir) => rm(dir, { recursive: true, force: true })),
      );
    }
  });
});

// --- Project types --------------------------------------------------------

/** A plugin project type with a template, recognized by `board.txt`, built for the web. */
async function boardPackage(build: "good" | "outside" | "empty") {
  const dir = path.join(root, `packages/board-${build}`);
  await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(dir, "templates/board/levels"), { recursive: true });
  await writeFile(path.join(dir, "templates/board/board.txt"), "board");
  await writeFile(path.join(dir, "templates/board/levels/one.txt"), "1");
  // The host writes the project file; a template's own is skipped.
  await writeFile(path.join(dir, "templates/board/ohmygame.json"), "{}");
  await writeFile(
    path.join(dir, "index.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";
    import path from "node:path";
    export function activate(context) {
      context.registerProjectType("board", {
        buildWeb: async (_input, call) => {
          call.progress("building");
          const folder = path.join(context.project.folder, ".ohmygame/build/web");
          await mkdir(folder, { recursive: true });
          ${build === "empty" ? "" : 'await writeFile(path.join(folder, "index.html"), "<p>board</p>");'}
          return { folder: ${JSON.stringify(build === "outside" ? ".." : ".ohmygame/build/web")} };
        },
      });
    }`,
  );
  await writeFile(
    path.join(dir, ".ohmygame-plugin/plugin.json"),
    JSON.stringify({
      id: "acme/board",
      version: "1.0.0",
      engines: { "ohmygame-api": "^2.0.0" },
      displayName: "Board",
      description: "Board games.",
      entrypoints: { native: "./index.mjs" },
      capabilities: { native: true },
      contributes: {
        projectTypes: [
          {
            id: "board",
            title: "%board.title%",
            template: "./templates/board/",
            recognize: { files: ["board.txt"] },
            preview: "web-build",
          },
        ],
      },
    }),
  );
  await mkdir(path.join(dir, "locales"), { recursive: true });
  await writeFile(
    path.join(dir, "locales/en.json"),
    JSON.stringify({ "board.title": "Board game" }),
  );
  await writeFile(
    path.join(dir, "locales/zh-CN.json"),
    JSON.stringify({ "board.title": "桌游" }),
  );
  return dir;
}

describe("project types", () => {
  const setup = async (build: "good" | "outside" | "empty" = "good") => {
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-types-data-"));
    const parent = await mkdtemp(path.join(tmpdir(), "ohmygame-types-"));
    const services = new PluginServices({
      directory: data,
      hosts: { callTimeoutMs: 5_000, cancelGraceMs: 200 },
    });
    const installed = await services.install(await boardPackage(build));
    if (!installed.ok) throw new Error(JSON.stringify(installed.issues));
    await services.consent("acme/board", ["native"]);
    return {
      services,
      parent,
      cleanup: async () => {
        await services.close();
        await Promise.all(
          [data, parent].map((dir) =>
            rm(dir, { recursive: true, force: true }),
          ),
        );
      },
    };
  };

  it("lists, creates, recognizes and builds a plugin type's projects", async () => {
    const { services, parent, cleanup } = await setup();
    try {
      const types = await availableProjectTypes(services, "zh-CN");
      expect(types.map((type) => type.id)).toEqual([
        "general",
        "interactive-story",
        "acme/board:board",
      ]);
      const board = types[2]!;
      expect(board).toMatchObject({
        title: "桌游",
        preview: "web-build",
        plugin: { id: "acme/board", version: "1.0.0" },
        creates: "template",
      });
      expect(projectKind(board)).toEqual({
        kind: "general",
        pluginType: {
          id: "acme/board:board",
          plugin: "acme/board",
          preview: "web-build",
        },
      });

      const busy = path.join(parent, "busy");
      await mkdir(busy);
      await writeFile(path.join(busy, "notes.txt"), "mine");
      await expect(
        createTypedProject({
          folder: busy,
          type: board.id,
          name: "Busy",
          services,
        }),
      ).rejects.toThrow("needs an empty folder");
      expect(await readFile(path.join(busy, "notes.txt"), "utf8")).toBe("mine");

      const folder = path.join(parent, "new");
      await createTypedProject({
        folder,
        type: board.id,
        name: "New",
        services,
      });
      expect(
        JSON.parse(await readFile(path.join(folder, "ohmygame.json"), "utf8")),
      ).toMatchObject({
        type: "acme/board:board",
        plugins: { "acme/board": "1.0.0" },
      });
      expect(await readFile(path.join(folder, "levels/one.txt"), "utf8")).toBe(
        "1",
      );
      expect(
        (await recognizeProjectTypes(folder, services)).map((type) => type.id),
      ).toEqual(["acme/board:board"]);
      expect(await recognizeProjectTypes(busy, services)).toEqual([]);

      const progress: string[] = [];
      const build = await buildWebPreview({
        folder,
        services,
        onProgress: (message) => progress.push(message),
      });
      expect(build).toEqual({
        directory: path.join(await realpath(folder), ".ohmygame/build/web"),
        entry: "index.html",
      });
      expect(progress).toContain("building");
      // A core type isn't built.
      const plain = path.join(parent, "plain");
      await createTypedProject({
        folder: plain,
        type: "general",
        name: "Plain",
        services,
      });
      expect(await buildWebPreview({ folder: plain, services })).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("takes on a folder that already holds the type's files without overwriting them", async () => {
    const { services, parent, cleanup } = await setup();
    try {
      const folder = path.join(parent, "existing");
      await mkdir(folder);
      await expect(
        adoptTypedProject({ folder, type: "acme/board:board", services }),
      ).rejects.toThrow("doesn't look like");
      await writeFile(path.join(folder, "board.txt"), "my board");
      await adoptTypedProject({ folder, type: "acme/board:board", services });
      expect(await readFile(path.join(folder, "board.txt"), "utf8")).toBe(
        "my board",
      );
      expect(
        JSON.parse(await readFile(path.join(folder, "ohmygame.json"), "utf8")),
      ).toMatchObject({ type: "acme/board:board" });
      expect(await buildWebPreview({ folder, services })).toMatchObject({
        entry: "index.html",
      });

      // A fresh clone already has the file: its type plugin is allowed in the
      // folder at the version it pins, and the file stays as it is.
      const clone = path.join(parent, "clone");
      await mkdir(clone);
      const cloned = JSON.stringify({ type: "acme/board:board", plugins: { "acme/board": "1.0.0" } });
      await writeFile(path.join(clone, "ohmygame.json"), cloned);
      await writeFile(path.join(clone, "board.txt"), "cloned board");
      await adoptTypedProject({ folder: clone, type: "acme/board:board", services });
      expect(await readFile(path.join(clone, "ohmygame.json"), "utf8")).toBe(cloned);
      expect(await projectKindAt(clone, services)).toMatchObject({
        pluginType: { preview: "web-build" },
      });
      expect(await buildWebPreview({ folder: clone, services })).toMatchObject({
        entry: "index.html",
      });

      // A project file that names another type is the folder's own.
      await writeFile(
        path.join(folder, "ohmygame.json"),
        JSON.stringify({ type: "general" }),
      );
      await expect(
        adoptTypedProject({ folder, type: "acme/board:board", services }),
      ).rejects.toThrow("says it is general");
    } finally {
      await cleanup();
    }
  });

  it("refuses a web build outside its project or without its page", async () => {
    for (const [build, message] of [
      ["outside", "is not in the project folder"],
      ["empty", "has no index.html"],
    ] as const) {
      const { services, parent, cleanup } = await setup(build);
      try {
        const folder = path.join(parent, "game");
        await createTypedProject({
          folder,
          type: "acme/board:board",
          name: "Game",
          services,
        });
        await expect(buildWebPreview({ folder, services })).rejects.toThrow(
          message,
        );
      } finally {
        await cleanup();
      }
    }
  });
});

describe("plugin settings and commands", () => {
  it("sends settings with each call, keeps secrets from the page and lists commands", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-settings-"));
    const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-settings-project-"));
    const dir = path.join(root, "packages/keys");
    await mkdir(path.join(dir, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(dir, "tools"), { recursive: true });
    await writeFile(
      path.join(dir, "tools/empty.json"),
      JSON.stringify({ type: "object", properties: {} }),
    );
    await writeFile(
      path.join(dir, "index.mjs"),
      `export function activate(context) {
        context.registerTool("settings", (_input, call) => call.configuration);
      }`,
    );
    await writeFile(
      path.join(dir, ".ohmygame-plugin/plugin.json"),
      JSON.stringify({
        id: "acme/keys",
        version: "1.0.0",
        engines: { "ohmygame-api": "^2.0.0" },
        displayName: "Keys",
        description: "Settings.",
        entrypoints: { native: "./index.mjs" },
        capabilities: { native: true },
        configuration: {
          engine: { type: "path", title: "Engine" },
          mode: { type: "select", title: "Mode", options: ["fast", "safe"], default: "safe" },
          token: { type: "secret", title: "Token" },
        },
        contributes: {
          tools: [{ name: "settings", description: "Echoes settings.", input: "./tools/empty.json" }],
          commands: [
            { id: "check", title: "Check", run: { tool: "settings" }, slots: [{ slot: "project.menu", when: "project.plugin('acme/keys')" }] },
            { id: "ask", title: "Ask", slash: "ask", run: { prompt: "Check the settings." } },
          ],
        },
      }),
    );
    const services = new PluginServices({ directory: data, hosts: { callTimeoutMs: 5_000, cancelGraceMs: 200 } });
    try {
      expect((await services.install(dir)).ok).toBe(true);
      await services.consent("acme/keys", ["native"]);
      await writeProjectFile(folder, (file) => file, { type: "general" });
      await setProjectPlugin({ folder, id: "acme/keys", version: "1.0.0", index: services.index, grants: services.grants });
      const call = () => services.native.callTool("acme/keys:settings", { folder });
      expect(await call()).toEqual({ mode: "safe" });

      await expect(services.configure("acme/keys", { mode: "slow" })).rejects.toThrow("must be one of");
      await expect(services.configure("acme/keys", { engine: "relative/godot" })).rejects.toThrow("absolute path");
      await services.configure("acme/keys", { engine: "/opt/engine", token: "s3cret" });
      // Without `capabilities.secrets`, native code never sees the token.
      expect(await call()).toEqual({ engine: "/opt/engine", mode: "safe" });
      expect(services.values.view(services.index.get("acme/keys")!)).toEqual({
        engine: { type: "path", value: "/opt/engine" },
        mode: { type: "select", value: "safe" },
        token: { type: "secret", configured: true },
      });
      // The file holds secrets, so only the person can read it.
      if (process.platform !== "win32")
        expect((await stat(path.join(data, "configuration.json"))).mode & 0o077).toBe(0);
      // A version that declares the token as plain text never sees the secret.
      const entry = services.index.get("acme/keys")!;
      const retyped = structuredClone(entry);
      (retyped.manifest.configuration as Record<string, unknown>).token = { type: "text", title: "Token" };
      expect(services.values.view(retyped).token).toEqual({ type: "text", value: null });
      expect(services.values.forNative(retyped)).not.toHaveProperty("token");
      await services.configure("acme/keys", { engine: null });
      expect(await call()).toEqual({ mode: "safe" });

      const commands = await services.commands(folder);
      expect(commands.map((command) => [command.id, command.slash ?? null])).toEqual([
        ["acme/keys:check", null],
        ["acme/keys:ask", "ask"],
      ]);
      expect(commands[0]!.slots).toEqual([{ slot: "project.menu", when: "project.plugin('acme/keys')" }]);
      expect((await services.projectCommand(folder, "acme/keys:check"))?.command.run).toEqual({ tool: "settings" });
      expect(await services.projectCommand(folder, "acme/keys:nothing")).toBeUndefined();
    } finally {
      await services.close();
      await Promise.all([data, folder].map((item) => rm(item, { recursive: true, force: true })));
    }
  });
});
