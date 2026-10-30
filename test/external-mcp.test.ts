import { defineTool } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ExternalMcpService } from "../src/daemon/external-mcp.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type {
  ExternalMcpCatalog,
  ExternalMcpEndpoint,
} from "../src/shared/external-mcp.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function temporaryDirectory() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ohmygame-external-mcp-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function project(
  id: string,
  workspacePath: string,
  type: ProjectState["type"] = "web-game",
): ProjectState {
  return {
    id,
    name: id,
    type,
    updatedAt: "",
    workspacePath,
    preview: { status: "stopped" },
  };
}

async function fixture() {
  const root = await temporaryDirectory();
  const game = path.join(root, "game");
  const story = path.join(root, "story");
  await mkdir(path.join(game, "src"), { recursive: true });
  await mkdir(story);
  const projects = [
    project("game", game),
    project("story", story, "interactive-story"),
  ];
  const released: string[] = [];
  const signals: AbortSignal[] = [];
  let finish: (() => void) | undefined;
  const tools = (current: ProjectState) => [
    defineTool({
      name: "generate_image",
      label: "Generate Image",
      description: "Generate an image",
      parameters: Type.Object({ prompt: Type.String() }),
      execute: async (_id, input, signal) => {
        signals.push(signal!);
        await new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
        return {
          content: [
            { type: "text", text: `image of ${input.prompt} in ${current.id}` },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "canvas_check",
      label: "Check Canvas",
      description: "Check the canvas",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: `canvas of ${current.id}` }],
        details: {},
      }),
    }),
    defineTool({
      name: "questionnaire",
      label: "Ask",
      description: "Ask the user",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    }),
    ...(current.type === "interactive-story"
      ? [
          defineTool({
            name: "playable_check",
            label: "Check Story",
            description: "Check the story",
            parameters: Type.Object({}),
            execute: async () => ({
              content: [{ type: "text", text: "story ok" }],
              details: {},
            }),
          }),
        ]
      : []),
  ];
  const service = new ExternalMcpService({
    dataDirectory: root,
    projects: () => projects,
    tools: (current) => tools(current),
    catalog: () => tools(projects[1]!),
    release: (projectId, sessionId) => {
      released.push(`${projectId}:${sessionId}`);
    },
    waitMs: 20,
  });
  cleanup.push(() => service.close());
  await service.load();
  await service.listening("http://127.0.0.1:1/external-mcp");
  await service.setEnabled(true);
  const endpoint = JSON.parse(
    await readFile(path.join(root, "external-mcp", "endpoint.json"), "utf8"),
  ) as ExternalMcpEndpoint;
  const authorization = `Bearer ${endpoint.token}`;
  let id = 0;
  const rpc = async (
    session: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    roots?: string[],
  ) =>
    service.handle({
      authorization,
      sessionId: session,
      roots: roots ? JSON.stringify(roots) : undefined,
      body: { jsonrpc: "2.0", id: ++id, method, params },
    });
  const open = async (roots?: string[]) => {
    const answer = await rpc(
      undefined,
      "initialize",
      { protocolVersion: "2025-06-18" },
      roots,
    );
    return answer.headers!["mcp-session-id"]!;
  };
  const call = async (
    session: string,
    name: string,
    args: Record<string, unknown> = {},
    roots?: string[],
  ) => {
    const answer = await rpc(
      session,
      "tools/call",
      { name, arguments: args },
      roots,
    );
    const result = (
      answer.body as {
        result: { content: Array<{ text: string }>; isError?: boolean };
      }
    ).result;
    return {
      text: result.content.map((item) => item.text).join("\n"),
      isError: result.isError === true,
    };
  };
  return {
    root,
    game,
    story,
    service,
    endpoint,
    authorization,
    rpc,
    open,
    call,
    released,
    signals,
    finish: () => finish?.(),
  };
}

it("publishes a token only while enabled and revokes it when turned off", async () => {
  const { root, service, endpoint, authorization, open, rpc } = await fixture();
  const file = path.join(root, "external-mcp", "endpoint.json");
  expect(endpoint).toMatchObject({
    version: 1,
    url: "http://127.0.0.1:1/external-mcp",
    contractVersion: 1,
  });
  if (process.platform !== "win32")
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  const catalog = JSON.parse(
    await readFile(path.join(root, "external-mcp", "tools.json"), "utf8"),
  ) as ExternalMcpCatalog;
  expect(catalog).toMatchObject({
    version: 1,
    contractVersion: 1,
    instructions: expect.stringContaining("wait_job"),
  });
  expect(catalog.tools.map((tool) => tool.name)).toContain("generate_image");
  expect(
    await service.handle({
      authorization: "Bearer wrong",
      sessionId: undefined,
      roots: undefined,
      body: {},
    }),
  ).toMatchObject({ status: 401 });
  const session = await open();
  expect((await rpc(session, "ping")).status).toBe(200);

  await service.setEnabled(false);
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await service.handle({
      authorization,
      sessionId: session,
      roots: undefined,
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
    }),
  ).toMatchObject({ status: 401 });

  await service.setEnabled(true);
  const renewed = JSON.parse(
    await readFile(file, "utf8"),
  ) as ExternalMcpEndpoint;
  expect(renewed.token).not.toBe(endpoint.token);
  expect(
    JSON.parse(
      await readFile(path.join(root, "external-mcp", "settings.json"), "utf8"),
    ),
  ).toEqual({ version: 1, enabled: true });
});

it("requires an initialized session", async () => {
  const { service, authorization, rpc, open } = await fixture();
  expect(await rpc(undefined, "tools/list")).toMatchObject({ status: 400 });
  expect(await rpc("unknown", "tools/list")).toMatchObject({ status: 404 });
  const session = await open();
  const notified = await service.handle({
    authorization,
    sessionId: session,
    roots: undefined,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(notified.status).toBe(202);
  expect(notified.body).toBeUndefined();
});

it("lists the public tools only, the same before a project is chosen", async () => {
  const { open, rpc } = await fixture();
  const session = await open();
  const answer = await rpc(session, "tools/list");
  const tools = (
    answer.body as {
      result: { tools: Array<{ name: string; _meta?: unknown }> };
    }
  ).result.tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_projects",
    "open_project",
    "get_project",
    "get_job",
    "wait_job",
    "cancel_job",
    "generate_image",
    "canvas_check",
    "playable_check",
  ]);
  expect(tools.some((tool) => tool._meta)).toBe(false);
});

it("binds the project containing the client's folder, until one is opened explicitly", async () => {
  const { game, story, open, call } = await fixture();
  const unbound = await open();
  expect(await call(unbound, "canvas_check")).toMatchObject({
    isError: true,
    text: expect.stringContaining("list_projects"),
  });

  const session = await open([path.join(game, "src")]);
  expect(await call(session, "canvas_check")).toEqual({
    isError: false,
    text: "canvas of game",
  });
  expect(JSON.parse((await call(session, "get_project")).text)).toMatchObject({
    id: "game",
    type: "web-game",
  });

  expect(
    JSON.parse((await call(session, "open_project", { project: story })).text),
  ).toMatchObject({ id: "story" });
  expect(await call(session, "canvas_check", {}, [`file://${game}`])).toEqual({
    isError: false,
    text: "canvas of story",
  });
  const listed = JSON.parse((await call(session, "list_projects")).text) as {
    projects: Array<{ id: string; current: boolean }>;
  };
  expect(listed.projects.find((item) => item.current)?.id).toBe("story");
});

it("refuses tools outside the public list and those the project does not have", async () => {
  const { game, open, call } = await fixture();
  const session = await open([game]);
  expect(await call(session, "questionnaire")).toMatchObject({
    isError: true,
    text: "Tool questionnaire is not available",
  });
  expect(await call(session, "playable_check")).toMatchObject({
    isError: true,
    text: "Tool playable_check is not available for project game (web-game). It needs an Interactive Story project.",
  });
  expect(
    await call(session, "open_project", { project: "missing" }),
  ).toMatchObject({ isError: true });
});

it("turns slow generations into jobs that outlive the request", async () => {
  const { game, open, call, signals, finish } = await fixture();
  const session = await open([game]);
  const started = await call(session, "generate_image", { prompt: "a fox" });
  expect(started.isError).toBe(false);
  const jobId = started.text.match(/job ([0-9a-f-]+)/)?.[1];
  expect(jobId).toBeTruthy();
  expect((await call(session, "get_job", { jobId })).text).toContain(
    "still running",
  );

  // Another session, such as a reconnected client, can still collect the result.
  const later = await open();
  finish();
  expect(await call(later, "wait_job", { jobId, timeoutSeconds: 1 })).toEqual({
    isError: false,
    text: "image of a fox in game",
  });
  expect(signals[0]!.aborted).toBe(false);
  expect(await call(later, "get_job", { jobId: "missing" })).toMatchObject({
    isError: true,
  });
});

it("cancels a job", async () => {
  const { game, open, call, signals } = await fixture();
  const session = await open([game]);
  const jobId = (
    await call(session, "generate_image", { prompt: "a fox" })
  ).text.match(/job ([0-9a-f-]+)/)?.[1];
  expect(await call(session, "cancel_job", { jobId })).toMatchObject({
    isError: true,
    text: `Job ${jobId} was cancelled`,
  });
  expect(signals[0]!.aborted).toBe(true);
});

it("releases a session's playtest windows when it ends or changes project", async () => {
  const { game, story, service, authorization, open, call, released } =
    await fixture();
  const session = await open([game]);
  await call(session, "open_project", { project: story });
  expect(released).toEqual([`game:${session}`]);
  expect(await service.end(authorization, session)).toBe(204);
  expect(released).toEqual([`game:${session}`, `story:${session}`]);
  expect(await service.end(authorization, session)).toBe(404);
});

it("serves the public contract from the daemon without the app token", async () => {
  const dataDirectory = await temporaryDirectory();
  const app = createApp({
    dataDirectory,
    piAgentDirectory: path.join(dataDirectory, "pi-agent"),
    accessToken: "app-token",
  });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const settings = await app.inject({
    method: "PUT",
    url: "/settings/external-agents",
    headers: { authorization: "Bearer app-token" },
    payload: { enabled: true },
  });
  expect(settings.json()).toMatchObject({
    enabled: true,
    clients: [{ id: "claude-code" }, { id: "codex" }],
  });
  const endpoint = JSON.parse(
    await readFile(
      path.join(dataDirectory, "external-mcp", "endpoint.json"),
      "utf8",
    ),
  ) as ExternalMcpEndpoint;
  expect(endpoint.url).toBe(
    `http://127.0.0.1:${(app.server.address() as { port: number }).port}/external-mcp`,
  );

  const post = (
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/external-mcp",
      headers: { authorization: `Bearer ${endpoint.token}`, ...headers },
      payload,
    });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/external-mcp",
        headers: { authorization: "Bearer app-token" },
        payload: {},
      })
    ).statusCode,
  ).toBe(401);
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  expect(initialized.json()).toMatchObject({
    result: { serverInfo: { name: "ohmygame-studio", version: "1" } },
  });
  const session = initialized.headers["mcp-session-id"] as string;
  const listed = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { "mcp-session-id": session },
  );
  const names = (
    listed.json() as { result: { tools: Array<{ name: string }> } }
  ).result.tools.map((tool) => tool.name);
  // Additive tools are compatible; retain every existing tool, see docs/external-agents.md.
  expect(names).toEqual([
    "list_projects",
    "open_project",
    "get_project",
    "get_job",
    "wait_job",
    "cancel_job",
    "generate_image",
    "generate_3d_asset",
    "animate_3d_asset",
    "generate_video",
    "generate_speech",
    "generate_sound_effect",
    "generate_music",
    "generate_audio",
    "playable_add_node",
    "playable_check",
    "canvas_check",
    "canvas_initialize",
    "generate_canvas_media",
    "game_use",
  ]);
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/external-mcp",
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "mcp-session-id": session,
        },
      })
    ).statusCode,
  ).toBe(204);

  await app.close();
  await expect(
    stat(path.join(dataDirectory, "external-mcp", "endpoint.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
