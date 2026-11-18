import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PAGE_TOOL_DEFAULT_MS, PAGE_TOOL_START_MS, PluginPageTools } from "../src/daemon/plugin-page-tools.js";
import type { ProjectState, RuntimeEvent, RuntimeEventData } from "../src/shared/contracts.js";
import { readPluginUiRequest, readPluginUiToolMessage } from "../src/shared/plugin-ui-protocol.js";

type Published = { type: "plugin.page.tool" | "plugin.page.tool.cancel"; data: RuntimeEventData["plugin.page.tool"] | RuntimeEventData["plugin.page.tool.cancel"] };

function broker(windows = 1) {
  const published: Published[] = [];
  const tools = new PluginPageTools({
    publish: (_projectId, type, data) => void published.push({ type, data } as Published),
    windows: () => windows,
  });
  const call = (extra: Partial<Parameters<PluginPageTools["call"]>[0]> = {}) =>
    tools.call({ projectId: "p", plugin: "acme/fx", version: "1.0.0", panel: "main", tool: "select", input: { id: 1 }, ...extra });
  const request = () => (published.find((item) => item.type === "plugin.page.tool")!.data as RuntimeEventData["plugin.page.tool"]).request;
  return { tools, published, call, request };
}

describe("plugin page tools", () => {
  afterEach(() => vi.useRealTimers());

  it("hands the open window a call and resolves with the page's answer", async () => {
    const { tools, published, call, request } = broker();
    const progress: string[] = [];
    const result = call({ onProgress: (message) => progress.push(message) });
    expect(published[0]).toMatchObject({ type: "plugin.page.tool", data: { plugin: "acme/fx", version: "1.0.0", panel: "main", tool: "select", input: { id: 1 } } });
    // Another project can't answer it, and the page's writes aren't the caller's until it has the call.
    expect(tools.answer("other", request(), { started: true })).toBe(false);
    expect(tools.running("p", "acme/fx", "main")).toBe(false);
    expect(tools.answer("p", request(), { started: true })).toBe(true);
    // One window takes it; another that asks too lets it go.
    expect(tools.answer("p", request(), { started: true })).toBe(false);
    expect(tools.running("p", "acme/fx", "main")).toBe(true);
    // Only the panel answering it: the plugin's other panels' changes stay their own.
    expect(tools.running("p", "acme/fx", "side")).toBe(false);
    expect(tools.running("p", "acme/other", "main")).toBe(false);
    tools.answer("p", request(), { progress: "Halfway" });
    tools.answer("p", request(), { result: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
    expect(progress).toEqual(["Halfway"]);
    // Answered once: a late answer finds nothing waiting.
    expect(tools.running("p", "acme/fx", "main")).toBe(false);
    expect(tools.answer("p", request(), { result: 2 })).toBe(false);
  });

  it("fails at once when no window of the project is open", async () => {
    const { published, call } = broker(0);
    await expect(call()).rejects.toThrow(/project must be open in OhMyGame/);
    expect(published).toEqual([]);
  });

  it("gives up when the page doesn't take the call or answer in time, and tells the window", async () => {
    vi.useFakeTimers();
    const { tools, published, call, request } = broker();
    const untaken = call();
    const caught = untaken.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(PAGE_TOOL_START_MS);
    expect(await caught).toMatch(/No window of OhMyGame took/);
    expect(published.at(-1)).toEqual({ type: "plugin.page.tool.cancel", data: { request: request() } });

    published.length = 0;
    const slow = call({ timeoutMs: 5_000 });
    const failed = slow.catch((error: Error) => error.message);
    // Once taken, the page has the tool's own time, from then on.
    await vi.advanceTimersByTimeAsync(PAGE_TOOL_START_MS - 1);
    tools.answer("p", request(), { started: true });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(tools.running("p", "acme/fx", "main")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failed).toMatch(/didn't answer in 5 seconds/);
    expect(published.at(-1)?.type).toBe("plugin.page.tool.cancel");
    expect(PAGE_TOOL_DEFAULT_MS).toBe(60_000);
  });

  it("fails once every open window has said why it can't take the call", async () => {
    const { tools, published, call, request } = broker(2);
    const declined = call();
    expect(tools.answer("p", request(), { declined: "The panel is hidden here" })).toBe(true);
    // The other window may still take it.
    expect(tools.answer("p", request(), { started: true })).toBe(true);
    tools.answer("p", request(), { result: "shown" });
    await expect(declined).resolves.toBe("shown");

    published.length = 0;
    const refused = call();
    tools.answer("p", request(), { declined: "Off here" });
    tools.answer("p", request(), { declined: "Hidden here" });
    await expect(refused).rejects.toThrow("Hidden here");
    expect(published.at(-1)?.type).toBe("plugin.page.tool.cancel");
  });

  it("stops when the caller does, and passes on the page's error", async () => {
    const { tools, published, call, request } = broker();
    const controller = new AbortController();
    const stopped = call({ signal: controller.signal });
    controller.abort();
    await expect(stopped).rejects.toThrow("Cancelled");
    expect(published.at(-1)).toEqual({ type: "plugin.page.tool.cancel", data: { request: request() } });

    published.length = 0;
    const failing = call();
    tools.answer("p", request(), { started: true });
    tools.answer("p", request(), { error: "No such effect" });
    await expect(failing).rejects.toThrow("No such effect");
  });

  it("reads a page's tool messages and its context for the next message", () => {
    expect(readPluginUiToolMessage({ toolCall: 3, accepted: true })).toEqual({ toolCall: 3, accepted: true });
    expect(readPluginUiToolMessage({ toolCall: 3, progress: "x".repeat(3000) })).toEqual({ toolCall: 3, progress: "x".repeat(2000) });
    expect(readPluginUiToolMessage({ toolCall: 3, result: null })).toEqual({ toolCall: 3, result: null });
    expect(readPluginUiToolMessage({ toolCall: 3, error: "" })).toEqual({ toolCall: 3, error: "The page's tool failed" });
    expect(readPluginUiToolMessage({ id: 3, result: 1 })).toBeUndefined();
    expect(readPluginUiToolMessage({ toolCall: "3", result: 1 })).toBeUndefined();

    expect(readPluginUiRequest({ id: 1, method: "context.set", params: { label: "Ricochet", text: "Effect impacts/ricochet, frame 3" } })).toMatchObject({ ok: true });
    expect(readPluginUiRequest({ id: 1, method: "context.set", params: {} })).toMatchObject({ ok: true });
    expect(readPluginUiRequest({ id: 1, method: "context.set", params: { label: "Ricochet" } })).toMatchObject({ ok: false, error: expect.stringMatching(/needs text/) });
    expect(readPluginUiRequest({ id: 1, method: "context.set", params: { label: "x".repeat(121), text: "y" } })).toMatchObject({ ok: false });
  });
});

describe("plugin page tools in the app", () => {
  const fixtures: { app: ReturnType<typeof createApp>; directories: string[] }[] = [];
  afterEach(async () => {
    for (const { app, directories } of fixtures.splice(0)) {
      await app.close();
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
    }
  });

  async function setup() {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "ohmygame-page-tools-"));
    const source = await mkdtemp(path.join(tmpdir(), "ohmygame-page-tools-source-"));
    const app = createApp({ dataDirectory });
    fixtures.push({ app, directories: [dataDirectory, source] });
    await app.ready();
    await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(source, "ui"), { recursive: true });
    await writeFile(path.join(source, "ui/panel.html"), "<p>panel</p>");
    await writeFile(path.join(source, "ui/icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await writeFile(path.join(source, "select.json"), JSON.stringify({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }));
    await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify({
      id: "acme/fx", version: "1.0.0", engines: { "ohmygame-api": "^2.35.0" }, displayName: "FX", description: "Effects.", icon: "./ui/icon.svg",
      capabilities: { "project.files": "write" },
      contributes: {
        panels: [{ id: "main", title: "Main", area: "right", entry: "./ui/panel.html" }],
        tools: [{ name: "select", description: "Shows an effect in the panel.", input: "./select.json", panel: "main" }],
        commands: [{ id: "pick", title: "Pick", run: { tool: "select", input: { id: "impacts/ricochet" } } }],
      },
    }));
    const payload = { source: { type: "directory", path: source } };
    const inspected = await app.inject({ method: "POST", url: "/plugin-sources/inspect", payload });
    expect(inspected.statusCode, inspected.body).toBe(200);
    const added = await app.inject({ method: "POST", url: "/plugin-sources/install", payload: { ...payload, digest: inspected.json().digest } });
    expect(added.statusCode, added.body).toBe(201);
    const project = (await app.inject({ method: "POST", url: "/projects", payload: { name: "FX" } })).json<ProjectState>();
    const on = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugins/acme/fx`, payload: { on: true, version: "1.0.0" } });
    expect(on.statusCode, on.body).toBe(204);
    return { app, project };
  }

  /** Opens the project's events as a window does, and hands back each page tool call as it comes. */
  async function openWindow(app: ReturnType<typeof createApp>, project: ProjectState) {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const stream = await fetch(`${address}/projects/${project.id}/events?cursor=0`, { signal: controller.signal });
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const next = async (): Promise<RuntimeEvent<"plugin.page.tool">> => {
      for (;;) {
        const blocks = text.split("\n\n");
        text = blocks.pop()!;
        for (const block of blocks) {
          const line = block.split("\n").find((item) => item.startsWith("data: "));
          const event = line ? JSON.parse(line.slice(6)) as RuntimeEvent : undefined;
          if (event?.type === "plugin.page.tool") {
            text = blocks.slice(blocks.indexOf(block) + 1).join("\n\n") + (text ? `\n\n${text}` : "");
            return event as RuntimeEvent<"plugin.page.tool">;
          }
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("The stream ended");
        text += value;
      }
    };
    return { next, close: () => controller.abort() };
  }

  it("runs a panel's tool from a command, with the page's writes in the command's change", async () => {
    const { app, project } = await setup();
    // With no window, there is no page to ask.
    const closed = await app.inject({ method: "POST", url: `/projects/${project.id}/plugin-commands`, payload: { command: "acme/fx:pick" } });
    expect(closed.statusCode).toBeGreaterThanOrEqual(400);
    expect(closed.json().error).toMatch(/must be open in OhMyGame/);

    const window = await openWindow(app, project);
    try {
      const running = app.inject({ method: "POST", url: `/projects/${project.id}/plugin-commands`, payload: { command: "acme/fx:pick" } });
      const call = await window.next();
      expect(call.data).toMatchObject({ plugin: "acme/fx", version: "1.0.0", panel: "main", tool: "select", input: { id: "impacts/ricochet" } });
      const answer = (body: unknown) => app.inject({ method: "POST", url: `/projects/${project.id}/plugin-page-tools/${call.data.request}`, payload: body as Record<string, unknown> });
      expect((await answer({ started: true })).statusCode).toBe(204);
      // The command holds the workspace; the page's write is part of its change rather than waiting for it.
      const written = await app.inject({ method: "PUT", url: `/projects/${project.id}/plugin-files/acme/fx/content?path=fx/ricochet.js`, headers: { "content-type": "application/octet-stream", "x-plugin-panel": "main" }, payload: "export const meta = {};" });
      expect(written.statusCode, written.body).toBe(200);
      expect((await answer({ result: { shown: "impacts/ricochet" } })).statusCode).toBe(204);
      const done = await running;
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ result: { shown: "impacts/ricochet" }, change: { plugin: "acme/fx", changed: ["fx/ricochet.js"] } });
      expect(await readFile(path.join(project.workspacePath, "fx/ricochet.js"), "utf8")).toBe("export const meta = {};");
      const history = (await app.inject({ method: "GET", url: `/projects/${project.id}/plugin-changes` })).json<Array<{ title: string }>>();
      expect(history.map((change) => change.title)).toEqual(["Pick"]);
      // Nothing waits for an answer that comes again.
      expect((await answer({ result: 1 })).statusCode).toBe(404);
    } finally {
      window.close();
    }
  });

  it("checks the tool's input before the page hears of it", async () => {
    const { app, project } = await setup();
    const window = await openWindow(app, project);
    try {
      const response = await app.inject({ method: "POST", url: `/projects/${project.id}/plugin-commands`, payload: { command: "acme/fx:pick", input: { id: 3 } } });
      expect(response.statusCode).toBe(400);
    } finally {
      window.close();
    }
  });
});
