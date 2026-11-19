import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { PAGE_TOOL_DEFAULT_MS, PAGE_TOOL_START_MS, PluginPageTools } from "../src/daemon/plugin-page-tools.js";
import { createPanelScreenshotTool, PANEL_SCREENSHOT_CAPTURE_MS, PANEL_SCREENSHOT_START_MS, PanelScreenshots } from "../src/daemon/panel-screenshots.js";
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

const image = { panel: "main", mediaType: "image/webp" as const, data: "aW1hZ2U=", width: 320, height: 200, theme: "dark" as const };

describe("panel screenshots", () => {
  afterEach(() => vi.useRealTimers());

  function screenshots(windows = 1, panels = [{ plugin: "acme/fx", id: "main", title: "Main" }, { plugin: "acme/fx", id: "side", title: "Side" }, { plugin: "acme/map", id: "main", title: "Map" }]) {
    const published: RuntimeEventData["plugin.panel.capture"][] = [];
    const cancelled: string[] = [];
    const service = new PanelScreenshots({
      publish: (_projectId, type, data) => void (type === "plugin.panel.capture"
        ? published.push(data as RuntimeEventData["plugin.panel.capture"])
        : cancelled.push(data.request)),
      windows: () => windows,
      panels: async () => panels,
    });
    /** The next request, once published: it waits for the project's panels first. */
    const request = (index = published.length) => vi.waitFor(() => {
      if (!published[index]) throw new Error("Not published yet");
      return published[index].request;
    });
    return { service, published, cancelled, request };
  }

  it("asks the open window for the named panel and resolves with its capture", async () => {
    const { service, published, request } = screenshots();
    const taken = service.capture("p", { plugin: "acme/map" });
    const id = await request();
    expect(published[0]).toMatchObject({ plugin: "acme/map", panel: "main" });
    // Only one window takes it, and only that window's image counts.
    expect(service.answer("other", id, { started: true })).toBe(false);
    expect(service.answer("p", id, { image })).toBe(false);
    expect(service.answer("p", id, { started: true })).toBe(true);
    expect(service.answer("p", id, { started: true })).toBe(false);
    expect(service.answer("p", id, { image })).toBe(true);
    await expect(taken).resolves.toEqual({ ...image, plugin: "acme/map" });
    expect(service.answer("p", id, { image })).toBe(false);
  });

  it("names the panels when the agent's choice isn't one, and needs an open window", async () => {
    const { service, published } = screenshots();
    await expect(service.capture("p", { plugin: "acme/fx" })).rejects.toThrow(/More than one panel matches.*acme\/fx side \(Side\)/);
    await expect(service.capture("p", { panel: "gone" })).rejects.toThrow(/No panel matches. Panels: acme\/fx main \(Main\)/);
    await expect(screenshots(1, []).service.capture("p", {})).rejects.toThrow("This project shows no plugin panels");
    await expect(screenshots(0).service.capture("p", { plugin: "acme/map" })).rejects.toThrow(/open in the desktop app/);
    expect(published).toEqual([]);
  });

  it("fails once every window has said why, when none takes it in time, and when the capture fails", async () => {
    const { service, published, cancelled, request } = screenshots(2);
    const first = request();
    const declined = service.capture("p", { plugin: "acme/map" });
    await first.then((id) => {
      service.answer("p", id, { declined: "This window is a browser" });
      service.answer("p", id, { declined: "The panel is hidden here" });
    });
    // The agent hears every window's reason, as either may be the one that matters.
    await expect(declined).rejects.toThrow("This window is a browser The panel is hidden here");


    const next = request();
    const failing = service.capture("p", { plugin: "acme/map" });
    const second = await next;
    service.answer("p", second, { started: true });
    // A window that declines after another took it changes nothing.
    service.answer("p", second, { declined: "Hidden" });
    service.answer("p", second, { error: "The panel has no size to capture" });
    await expect(failing).rejects.toThrow("no size");

    vi.useFakeTimers();
    const untaken = service.capture("p", { plugin: "acme/map" }).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_START_MS);
    expect(await untaken).toMatch(/No window of the desktop app took/);
    expect(cancelled.at(-1)).toBe(published.at(-1)!.request);
    const count = published.length;
    const slow = service.capture("p", { plugin: "acme/map" }).catch((error: Error) => error.message);
    // Once taken, the window has the capture's own time from then on.
    await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_START_MS - 1);
    service.answer("p", published[count]!.request, { started: true });
    await vi.advanceTimersByTimeAsync(PANEL_SCREENSHOT_CAPTURE_MS);
    expect(await slow).toMatch(/wasn't captured in time/);
    // The window that took it hears the agent stopped waiting, so it stops showing the panel.
    expect(cancelled.at(-1)).toBe(published[count]!.request);
  });

  it("stops when the agent does, and shows the agent the image", async () => {
    const { service, cancelled, request } = screenshots();
    const controller = new AbortController();
    const pending = request();
    const stopped = service.capture("p", { plugin: "acme/map" }, controller.signal);
    const id = await pending;
    controller.abort();
    await expect(stopped).rejects.toThrow("Cancelled");
    expect(cancelled).toEqual([id]);
    expect(service.answer("p", id, { started: true })).toBe(false);

    const tool = createPanelScreenshotTool("p", service);
    const pendingLater = request();
    const result = tool.execute("call", { plugin: "acme/map", panel: "main" }, undefined, undefined, {} as never);
    const later = await pendingLater;
    service.answer("p", later, { started: true });
    service.answer("p", later, { image });
    const shown = await result;
    expect(JSON.parse((shown.content[0] as { text: string }).text)).toEqual({ plugin: "acme/map", panel: "main", width: 320, height: 200, theme: "dark" });
    expect(shown.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/webp" });
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
    return { app, project, dataDirectory };
  }

  /** Opens the project's events as a window does and waits for the requested event. */
  async function openWindow(app: ReturnType<typeof createApp>, project: ProjectState) {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const stream = await fetch(`${address}/projects/${project.id}/events?cursor=0`, { signal: controller.signal });
    const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const next = async <T extends "plugin.page.tool" | "plugin.panel.capture">(type: T): Promise<RuntimeEvent<T>> => {
      for (;;) {
        const blocks = text.split("\n\n");
        text = blocks.pop()!;
        for (const block of blocks) {
          const line = block.split("\n").find((item) => item.startsWith("data: "));
          const event = line ? JSON.parse(line.slice(6)) as RuntimeEvent : undefined;
          if (event?.type === type) {
            text = blocks.slice(blocks.indexOf(block) + 1).join("\n\n") + (text ? `\n\n${text}` : "");
            return event as RuntimeEvent<T>;
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
      const call = await window.next("plugin.page.tool");
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

  it("takes an MCP screenshot reply even while a plugin command holds the workspace", async () => {
    const { app, project, dataDirectory } = await setup();
    const base = `/projects/${project.id}`;
    const answer = (request: string, body: unknown) => app.inject({ method: "POST", url: `${base}/plugin-panel-captures/${request}`, payload: body as Record<string, unknown> });
    expect((await answer("missing", { started: true })).statusCode).toBe(404);
    // An image is checked whole before anything hears of it.
    expect((await answer("missing", { image: { panel: "main" } })).statusCode).toBe(400);

    const window = await openWindow(app, project);
    try {
      const enabled = await app.inject({ method: "PUT", url: "/settings/external-agents", payload: { enabled: true } });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const { token } = JSON.parse(await readFile(path.join(dataDirectory, "external-mcp", "endpoint.json"), "utf8")) as { token: string };
      const headers = { authorization: `Bearer ${token}`, "x-ohmygame-roots": JSON.stringify([project.workspacePath]) };
      const init = await app.inject({ method: "POST", url: "/external-mcp", headers, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
      const session = init.headers["mcp-session-id"];
      expect(session, init.body).toBeTypeOf("string");
      const running = app.inject({ method: "POST", url: "/external-mcp", headers: { ...headers, "mcp-session-id": String(session) }, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "panel_screenshot", arguments: { plugin: "acme/fx", panel: "main" } } } });
      const capture = await window.next("plugin.panel.capture");
      expect((await answer(capture.data.request, { started: true })).statusCode).toBe(204);

      const command = app.inject({ method: "POST", url: `${base}/plugin-commands`, payload: { command: "acme/fx:pick" } });
      const { data: call } = await window.next("plugin.page.tool");
      const commandAnswer = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${base}/plugin-page-tools/${call.request}`, payload });
      expect((await commandAnswer({ started: true })).statusCode).toBe(204);
      const captured = await answer(capture.data.request, { image });
      await commandAnswer({ result: "done" });
      expect((await command).statusCode).toBe(200);
      expect(captured.statusCode, captured.body).toBe(204);
      expect((await running).json()).toMatchObject({ result: { content: [expect.objectContaining({ type: "text" }), { type: "image", data: image.data, mimeType: image.mediaType }] } });
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
