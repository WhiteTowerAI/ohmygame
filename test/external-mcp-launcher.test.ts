import { defineTool } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { ExternalMcpService } from "../src/daemon/external-mcp.js";
import {
  installExternalMcpLauncher,
  markExternalMcpApp,
} from "../src/desktop/external-mcp-install.js";
import {
  ExternalMcpLauncher,
  type Message,
} from "../src/desktop/external-mcp-launcher.js";
import type { ProjectState } from "../src/shared/contracts.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ohmygame-launcher-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A daemon's MCP service, reached through `fetch` as the launcher reaches the real one. */
async function fixture() {
  const root = await temporaryDirectory();
  const game = path.join(root, "game");
  await mkdir(game);
  const other = path.join(root, "other");
  await mkdir(other);
  const projects: ProjectState[] = [
    {
      id: "game",
      name: "Game",
      type: "web-game",
      updatedAt: "",
      workspacePath: game,
      preview: { status: "stopped" },
    },
    {
      id: "other",
      name: "Other",
      type: "web-game",
      updatedAt: "",
      workspacePath: other,
      preview: { status: "stopped" },
    },
  ];
  const executions: string[] = [];
  let generation: Promise<void> = Promise.resolve();
  const tools = (project: ProjectState) => [
    defineTool({
      name: "canvas_check",
      label: "Check Canvas",
      description: "Check the canvas",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: `canvas of ${project.id}` }],
        details: {},
      }),
    }),
    ...["generate_image", "canvas_initialize"].map((name) =>
      defineTool({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => {
          executions.push(`${name}:${project.id}`);
          if (name === "generate_image") await generation;
          return {
            content: [
              { type: "text" as const, text: `${name} in ${project.id}` },
            ],
            details: {},
          };
        },
      }),
    ),
  ];
  const service = new ExternalMcpService({
    dataDirectory: root,
    projects: () => projects,
    tools,
    catalog: () => tools(projects[0]!),
    waitMs: 1,
  });
  cleanup.push(() => service.close());
  await service.load();
  const requests: Array<{ method: string; session?: string; roots?: string }> =
    [];
  const fetchDaemon: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({
      method: init?.method === "DELETE" ? "DELETE" : String(body?.method),
      ...(headers.get("mcp-session-id")
        ? { session: headers.get("mcp-session-id")! }
        : {}),
      ...(headers.get("x-ohmygame-roots")
        ? { roots: headers.get("x-ohmygame-roots")! }
        : {}),
    });
    if (init?.method === "DELETE")
      return new Response(null, {
        status: await service.end(
          headers.get("authorization") ?? undefined,
          headers.get("mcp-session-id") ?? undefined,
        ),
      });
    const answer = await service.handle({
      authorization: headers.get("authorization") ?? undefined,
      sessionId: headers.get("mcp-session-id") ?? undefined,
      roots: headers.get("x-ohmygame-roots") ?? undefined,
      body,
    });
    return new Response(
      answer.body === undefined ? null : JSON.stringify(answer.body),
      { status: answer.status, headers: answer.headers },
    );
  };
  const written: Message[] = [];
  let starts = 0;
  let failures = 0;
  let lostResponse: { tool: string; truncated: boolean } | undefined;
  const create = (overrides: { startApp?: () => void } = {}) =>
    new ExternalMcpLauncher({
      dataDirectory: root,
      write: (message) => written.push(message),
      fetch: async (url, init) => {
        if (failures > 0) {
          failures--;
          throw new TypeError("fetch failed");
        }
        const response = await fetchDaemon(url, init);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (
          response.ok &&
          body?.method === "tools/call" &&
          body.params?.name === lostResponse?.tool
        ) {
          const truncated = lostResponse!.truncated;
          lostResponse = undefined;
          if (truncated) return new Response('{"jsonrpc":', { status: 200 });
          throw new TypeError("response lost after execution");
        }
        return response;
      },
      environment: {},
      cwd: game,
      isAlive: () => true,
      startTimeoutMs: 3_000,
      startApp:
        overrides.startApp ??
        (() => {
          starts++;
        }),
    });
  let id = 0;
  const ask = async (
    launcher: ExternalMcpLauncher,
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const request = ++id;
    await launcher.receive({ jsonrpc: "2.0", id: request, method, params });
    return written.find((message) => message.id === request);
  };
  const call = async (
    launcher: ExternalMcpLauncher,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const answer = await ask(launcher, "tools/call", { name, arguments: args });
    const result = answer?.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: result.content[0]!.text, isError: !!result.isError };
  };
  return {
    root,
    game,
    other,
    projects,
    service,
    requests,
    executions,
    written,
    create,
    ask,
    call,
    starts: () => starts,
    failNext: (count: number) => {
      failures = count;
    },
    loseResponse: (tool: string, truncated = false) => {
      lostResponse = { tool, truncated };
    },
    holdGeneration: () => {
      let finish!: () => void;
      generation = new Promise<void>((resolve) => {
        finish = resolve;
      });
      return finish;
    },
  };
}

it("answers the handshake and tool list itself, without starting OhMyGame", async () => {
  const { service, requests, create, ask, starts } = await fixture();
  // A daemon that was enabled once leaves its tool list behind.
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  await service.close();
  const launcher = create();
  const initialized = await ask(launcher, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
  });
  expect(initialized?.result).toMatchObject({
    serverInfo: { name: "ohmygame-studio", version: "1" },
    instructions: expect.stringContaining("wait_job"),
  });
  const listed = await ask(launcher, "tools/list");
  expect(
    (listed?.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    ),
  ).toContain("canvas_check");
  expect(requests).toEqual([]);
  expect(starts()).toBe(0);
});

it("explains how to turn the feature on instead of starting the app", async () => {
  const { create, ask, call, starts } = await fixture();
  const launcher = create();
  await ask(launcher, "initialize", { capabilities: {} });
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: true,
    text: expect.stringContaining(
      "Settings → MCP Server → Allow other agents to use OhMyGame",
    ),
  });
  expect(starts()).toBe(0);
});

it("starts OhMyGame on the first tool call and binds the folder the client works in", async () => {
  const { service, game, requests, create, ask, call } = await fixture();
  await service.setEnabled(true);
  let started = 0;
  const launcher = create({
    startApp: () => {
      started++;
      void service.listening("http://127.0.0.1:1/external-mcp");
    },
  });
  await ask(launcher, "initialize", { capabilities: {} });
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  expect(started).toBe(1);
  expect(requests.map((request) => request.method)).toEqual([
    "initialize",
    "tools/call",
  ]);
  expect(JSON.parse(requests[1]!.roots!)).toEqual([game]);

  // The daemon restarts with a new token; the launcher connects again by itself.
  await service.setEnabled(false);
  await service.setEnabled(true);
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  expect(requests.map((request) => request.method).slice(2)).toEqual([
    "tools/call",
    "initialize",
    "tools/call",
  ]);

  await launcher.close();
  expect(requests.at(-1)).toMatchObject({ method: "DELETE" });
});

it("waits for an app that is already starting instead of starting a second one", async () => {
  const { root, service, create, ask, call, starts } = await fixture();
  await service.setEnabled(true);
  await markExternalMcpApp(root, 4242);
  const launcher = create();
  await ask(launcher, "initialize", { capabilities: {} });
  setTimeout(
    () => void service.listening("http://127.0.0.1:1/external-mcp"),
    700,
  );
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  expect(starts()).toBe(0);
});

it("looks for the daemon again after a dropped connection, then explains", async () => {
  const { service, create, ask, call, failNext } = await fixture();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const launcher = create();
  await ask(launcher, "initialize", { capabilities: {} });
  failNext(1);
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  failNext(2);
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: true,
    text: "Could not reach OhMyGame (fetch failed). Open the OhMyGame app and try again.",
  });
});

it("forgets the app's record only when it is still the app's own", async () => {
  const { root } = await fixture();
  const first = await markExternalMcpApp(root, 1);
  await markExternalMcpApp(root, 2);
  await first();
  expect(
    JSON.parse(
      await readFile(path.join(root, "external-mcp", "app.json"), "utf8"),
    ),
  ).toEqual({ version: 1, pid: 2 });
});

it("uses the client's MCP roots when it offers them", async () => {
  const { service, game, written, requests, create, ask, call } =
    await fixture();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const launcher = create();
  await ask(launcher, "initialize", { capabilities: { roots: {} } });
  await launcher.receive({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const rootsRequest = written.find(
    (message) => message.method === "roots/list",
  );
  expect(rootsRequest?.id).toBe("ohmygame-roots-1");
  await launcher.receive({
    jsonrpc: "2.0",
    id: rootsRequest!.id,
    result: { roots: [{ uri: `file://${game}`, name: "game" }] },
  });
  expect(await call(launcher, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  expect(JSON.parse(requests.at(-1)!.roots!)).toEqual([`file://${game}`]);
});

it("writes a launcher script that keeps arguments with spaces and quotes intact", async () => {
  if (process.platform === "win32") return;
  const root = await temporaryDirectory();
  const entry = path.join(root, "it's an entry.mjs");
  await writeFile(
    entry,
    "console.log(JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE }));\n",
  );
  const launcher = await installExternalMcpLauncher({
    binDirectory: path.join(root, "bin"),
    executable: process.execPath,
    entry,
    dataDirectory: path.join(root, "Application Support", "data"),
  });
  expect(launcher).toEqual({
    command: path.join(root, "bin", "ohmygame-mcp"),
    args: [],
    env: {},
  });
  expect((await stat(launcher.command)).mode & 0o111).toBeTruthy();
  const { stdout } = await promisify(execFile)(launcher.command, ["--extra"]);
  expect(JSON.parse(stdout)).toEqual({
    args: [
      "--data-dir",
      path.join(root, "Application Support", "data"),
      "--extra",
    ],
    node: "1",
  });

  expect(
    await installExternalMcpLauncher({
      binDirectory: "unused",
      executable: "C:\\OhMyGame\\OhMyGame.exe",
      entry: "main.js",
      dataDirectory: "C:\\data",
      platform: "win32",
    }),
  ).toEqual({
    command: "C:\\OhMyGame\\OhMyGame.exe",
    args: ["main.js", "--data-dir", "C:\\data"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
});

it.each(["generate_image", "canvas_initialize"])(
  "does not replay %s after execution when its response is lost",
  async (name) => {
    const { service, create, call, loseResponse, executions } = await fixture();
    await service.listening("http://127.0.0.1:1/external-mcp");
    await service.setEnabled(true);
    const launcher = create();
    loseResponse(name);
    expect(await call(launcher, name)).toMatchObject({
      isError: true,
      text: expect.stringContaining("not automatically retried"),
    });
    expect(executions).toEqual([`${name}:game`]);
    expect(await call(launcher, "canvas_check")).toEqual({
      isError: false,
      text: "canvas of game",
    });
  },
);

it("does not repeat an accepted generation job after a truncated response", async () => {
  const { service, create, call, loseResponse, executions, holdGeneration } =
    await fixture();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const finish = holdGeneration();
  const launcher = create();
  try {
    loseResponse("generate_image", true);
    expect(await call(launcher, "generate_image")).toMatchObject({
      isError: true,
      text: expect.stringContaining("Execution status is unknown"),
    });
    expect(executions).toEqual(["generate_image:game"]);
  } finally {
    finish();
  }
});

it("retries a generation rejected before execution by an expired session", async () => {
  const { service, create, call, executions, requests } = await fixture();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const launcher = create();
  await call(launcher, "get_project");
  await service.setEnabled(false);
  await service.setEnabled(true);
  expect(await call(launcher, "generate_image")).toEqual({
    isError: false,
    text: "generate_image in game",
  });
  expect(requests.map((request) => request.method)).toEqual([
    "initialize",
    "tools/call",
    "tools/call",
    "initialize",
    "tools/call",
  ]);
  expect(executions).toEqual(["generate_image:game"]);
});

it.each(["token", "session", "network"])(
  "restores the canonical explicit project after %s loss",
  async (loss) => {
    const {
      root,
      other,
      service,
      create,
      call,
      executions,
      requests,
      failNext,
    } = await fixture();
    await service.listening("http://127.0.0.1:1/external-mcp");
    await service.setEnabled(true);
    const launcher = create();
    expect(
      (await call(launcher, "open_project", { project: other })).isError,
    ).toBe(false);
    expect(
      (await call(launcher, "open_project", { project: "missing" })).isError,
    ).toBe(true);
    if (loss === "token") {
      await service.setEnabled(false);
      await service.setEnabled(true);
    } else if (loss === "session") {
      const endpoint = JSON.parse(
        await readFile(
          path.join(root, "external-mcp", "endpoint.json"),
          "utf8",
        ),
      );
      await service.end(`Bearer ${endpoint.token}`, requests.at(-1)!.session);
    } else {
      failNext(1);
      // A read can reconnect safely; a failed generation dispatch must never be replayed.
      expect(
        JSON.parse((await call(launcher, "get_project")).text),
      ).toMatchObject({ id: "other" });
    }
    expect(await call(launcher, "generate_image")).toEqual({
      isError: false,
      text: "generate_image in other",
    });
    expect(
      JSON.parse((await call(launcher, "get_project")).text),
    ).toMatchObject({ id: "other" });
    expect(executions).toEqual(["generate_image:other"]);
  },
);

it("blocks project tools when the explicit project is gone and permits selecting another", async () => {
  const { projects, service, create, call, executions } = await fixture();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const launcher = create();
  await call(launcher, "open_project", { project: "other" });
  projects.pop();
  await service.setEnabled(false);
  await service.setEnabled(true);
  expect(await call(launcher, "generate_image")).toMatchObject({
    isError: true,
    text: expect.stringContaining("No OhMyGame project"),
  });
  expect(await call(launcher, "canvas_initialize")).toMatchObject({
    isError: true,
  });
  expect(executions).toEqual([]);
  expect((await call(launcher, "list_projects")).isError).toBe(false);
  expect(
    (await call(launcher, "open_project", { project: "game" })).isError,
  ).toBe(false);
  expect(await call(launcher, "generate_image")).toEqual({
    isError: false,
    text: "generate_image in game",
  });
});
