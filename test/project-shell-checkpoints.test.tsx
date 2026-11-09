// @vitest-environment happy-dom
import path from "node:path";
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRuntimeState } from "../src/shared/desktop-runtime.js";
import { promptText } from "./prompt-field.js";
import type {
  CheckpointChangeItem,
  ConversationDetail,
  RuntimeEvent,
  RuntimeEventData,
  RuntimeEventType,
  TurnChanges,
} from "../src/shared/contracts.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock(CODING_WORKSPACE);
});

const READY: DesktopRuntimeState = {
  status: "ready",
  generation: 1,
  recovered: false,
  runtime: { url: "http://127.0.0.1:1001", token: "token" },
};
const BASE =
  "/projects/project/conversations/conversation/checkpoints/checkpoint-1";
const UNFINISHED = "/projects/project/checkpoints/unfinished";
const CODING_WORKSPACE = path.resolve("src/renderer/coding-workspace.tsx");
const CHANGES: CheckpointChangeItem[] = [
  { path: "a.js", kind: "modified", state: "applied" },
  { path: "b.js", kind: "added", state: "applied" },
];

function detail(turnId: string, changes?: TurnChanges): ConversationDetail {
  const timestamp = new Date(0).toISOString();
  return {
    conversation: {
      id: "conversation",
      projectId: "project",
      title: "Chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 2,
    },
    cursor: 0,
    agent: { status: "idle" },
    settings: {},
    plan: { mode: "normal" },
    pendingPrompts: [], scheduledMessages: [],
    turns: [
      {
        id: turnId,
        conversationId: "conversation",
        status: "completed",
        items: [
          {
            id: `${turnId}:user`,
            turnId,
            type: "userMessage",
            text: "Build",
            checkpointId: "checkpoint-1",
            ...(changes ? { changes } : {}),
          },
          {
            id: `${turnId}:answer`,
            turnId,
            type: "agentMessage",
            text: "Built",
            status: "completed",
            phase: "final_answer",
          },
        ],
      },
    ],
  };
}

/** A daemon that answers the routes the shell needs, with `routes` deciding the checkpoint ones. */
async function openProject(
  routes: (
    route: string,
    init: RequestInit,
  ) => Response | Promise<Response> | undefined,
  conversation = detail("live-turn", { files: 2 }),
  shellProps: Partial<Pick<
    ComponentProps<
      typeof import("../src/renderer/project-shell.js").ProjectShell
    >,
    "initialPrompt" | "onInitialPromptHandled" | "onOpenConversation" | "view"
  >> & { wrap?: (shell: ReactNode) => ReactNode } = {},
) {
  const { wrap = (shell: ReactNode) => shell, ...props } = shellProps;
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: {
      platform: "darwin",
      runtime: { daemonUrl: "http://127.0.0.1:1000", token: "old-token" },
      runtimeService: {
        state: vi.fn(),
        restart: vi.fn(),
        onState: vi.fn(() => () => {}),
      },
    },
  });
  const daemon = {
    conversation,
    requests: [] as { route: string; method: string; body?: string }[],
    events: undefined as
      ReadableStreamDefaultController<Uint8Array> | undefined,
    send<T extends RuntimeEventType>(
      id: number,
      type: T,
      data: RuntimeEventData[T],
      conversationId?: string,
      turnId?: string,
    ) {
      const event = {
        id,
        projectId: "project",
        ...(conversationId ? { conversationId } : {}),
        ...(turnId ? { turnId } : {}),
        type,
        timestamp: new Date(0).toISOString(),
        data,
      } as RuntimeEvent<T>;
      this.events!.enqueue(
        new TextEncoder().encode(
          `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const { pathname, search } = new URL(url);
      const route = pathname + search;
      if (pathname.endsWith("/events"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              daemon.events = controller;
              init.signal!.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      daemon.requests.push({
        route,
        method: init.method ?? "GET",
        ...(init.body ? { body: String(init.body) } : {}),
      });
      return (
        routes(route, init) ??
        Response.json(
          pathname === "/projects/project"
            ? {
                id: "project",
                name: "Test",
                type: "general",
                webPreviewEnabled: false,
                workspacePath: "/tmp/project",
                updatedAt: new Date(0).toISOString(),
                preview: { status: "stopped" },
              }
            : pathname.endsWith("/conversations")
              ? [daemon.conversation.conversation]
              : pathname.endsWith("/conversations/conversation")
                ? daemon.conversation
                : pathname.endsWith("/checkpoints/unfinished")
                  ? { unfinished: false }
                  : pathname.endsWith("/checkpoint-1/changes")
                    ? { changes: CHANGES }
                    : pathname.endsWith("/models") ||
                        pathname.endsWith("/catalog")
                      ? { models: [], providers: [] }
                      : pathname.includes("capabilities")
                        ? { plugins: [], skills: [] }
                        : [],
        )
      );
    }),
  );
  const { updateRuntimeConnection } =
    await import("../src/renderer/runtime-connection.js");
  const { ProjectShell } = await import("../src/renderer/project-shell.js");
  const { AuthProvider } = await import("../src/renderer/auth.js");
  updateRuntimeConnection(READY);
  const render = (conversationId: string) => act(async () =>
    root.render(
      <AuthProvider>
        {wrap(<ProjectShell
          projectId="project"
          conversationId={conversationId}
          onOpenConversation={() => {}}
          onNavigate={() => {}} onHome={() => {}}
          {...props}
        />)}
      </AuthProvider>,
    ),
  );
  await render("conversation");
  await settle();
  return Object.assign(daemon, { route: render });
}

/** A page context's files, for pages that don't use them. */
const NO_FILES = {
  list: async () => ({ entries: [], truncated: false }),
  read: async () => new Blob(),
  write: async (path: string) => path,
  createFolder: async (path: string) => path,
  move: async (_from: string, to: string) => to,
  delete: async () => {},
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
const buttons = () =>
  [...container.querySelectorAll("button")].map(
    (candidate) => candidate.textContent,
  );
const texts = (selector: string) =>
  [...container.querySelectorAll(selector)].map(
    (element) => element.textContent,
  );
async function click(name: string) {
  await act(async () => button(name)!.click());
  await settle();
}

describe("project shell layout", () => {
  it("does not reformat historical responses while the current response streams, and keeps branching available", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
    const timestamp = Date.UTC(2026, 7, 23, 8, 5);
    const formattedResponse = vi.fn();
    const format = Object.getOwnPropertyDescriptor(
      Intl.DateTimeFormat.prototype,
      "format",
    )!.get!;
    const prototype = Intl.DateTimeFormat.prototype as unknown as {
      readonly format: unknown;
    };
    vi.spyOn(prototype, "format", "get").mockImplementation(
      function (this: Intl.DateTimeFormat) {
        const bound = format.call(this) as (value?: number | Date) => string;
        return (value?: number | Date) => {
          if (value === timestamp) formattedResponse();
          return bound(value);
        };
      },
    );
    const conversation = detail("history");
    const response = conversation.turns[0].items[1];
    if (response.type !== "agentMessage")
      throw new Error("Expected an assistant response");
    response.timestamp = timestamp;
    response.branchEntryId = "history-entry";
    const onOpenConversation = vi.fn();
    const daemon = await openProject(
      (route) => route.endsWith("/branch")
        ? Response.json({ ...conversation.conversation, id: "branched" })
        : undefined,
      conversation,
      { onOpenConversation },
    );
    expect(formattedResponse).toHaveBeenCalled();
    await act(async () =>
      daemon.send(1, "agent.started", { prompt: "Continue" }, "conversation", "live"),
    );
    await settle();
    await act(async () => daemon.send(2, "item.started", {
      item: {
        id: "live-answer", turnId: "live", type: "agentMessage",
        text: "Working", status: "inProgress",
      },
    }, "conversation", "live"));
    await settle();
    formattedResponse.mockClear();
    for (let id = 3; id < 6; id++) {
      await act(async () => daemon.send(id, "item.agentMessage.delta", {
        itemId: "live-answer", delta: " next",
      }, "conversation", "live"));
      await settle();
    }
    // Streamed text renders at most every 50 ms.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(container.textContent).toContain("Working next next next");
    expect(formattedResponse).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await click("Branch in new chat");
    expect(onOpenConversation).toHaveBeenCalledWith("branched");
    expect(
      daemon.requests.find((request) => request.route.endsWith("/branch"))?.body,
    ).toContain("history-entry");
  });

  it("applies streamed text together on a frame, at most every 50 ms, before any later event", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
    const daemon = await openProject(() => undefined, detail("history"));
    await act(async () => daemon.send(1, "agent.started", { prompt: "Continue" }, "conversation", "live"));
    await act(async () => daemon.send(2, "item.started", {
      item: { id: "live-answer", turnId: "live", type: "agentMessage", text: "Draft", status: "inProgress" },
    }, "conversation", "live"));
    await settle();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    await act(async () => {
      daemon.send(3, "item.agentMessage.delta", { itemId: "live-answer", delta: " one" }, "conversation", "live");
      daemon.send(4, "item.agentMessage.delta", { itemId: "live-answer", delta: " two" }, "conversation", "live");
    });
    // Both tokens wait for one frame.
    expect(frames).toHaveLength(1);
    expect(container.textContent).not.toContain("Draft one");
    await act(async () => frames[0]!(performance.now()));
    expect(container.textContent).toContain("Draft one two");
    // Text that follows soon after waits for a later frame.
    await act(async () => daemon.send(5, "item.agentMessage.delta", { itemId: "live-answer", delta: " and" }, "conversation", "live"));
    await act(async () => frames[1]!(performance.now() + 10));
    expect(container.textContent).not.toContain("two and");
    expect(frames).toHaveLength(3);
    await act(async () => frames[2]!(performance.now() + 60));
    expect(container.textContent).toContain("Draft one two and");
    await act(async () => {
      daemon.send(6, "item.agentMessage.delta", { itemId: "live-answer", delta: " three" }, "conversation", "live");
      // The final text arrives before that frame and must not gain the token again.
      daemon.send(7, "item.completed", {
        item: { id: "live-answer", turnId: "live", type: "agentMessage", text: "Draft one two and three", status: "completed" },
      }, "conversation", "live");
    });
    expect(container.textContent).toContain("Draft one two and three");
    expect(container.textContent).not.toContain("three three");
  });

  it("opens the design route on the canvas panel and keeps a closed chat closed across project updates", async () => {
    // The project shell decides when the workspace shows its settings.
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: ({ settingsOpen, onSettingsOpenChange }: { settingsOpen?: boolean; onSettingsOpenChange?: (open: boolean) => void }) =>
      settingsOpen ? <button type="button" className="project-settings" onClick={() => onSettingsOpenChange?.(false)}>Settings</button> : null }));
    const daemon = await openProject(() => undefined, detail("live-turn"), {
      view: "design",
    });
    const tabs = (area: string) =>
      [...container.querySelectorAll(`.dock-area-${area} .dock-tab`)].map(
        (tab) =>
          `${tab.classList.contains("is-active") ? "*" : ""}${tab.querySelector(".dock-tab-label")!.textContent}`,
      );
    const menuItem = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(".ui-menu-item")].find(
        (item) => item.textContent?.trim() === name,
      )!;

    // A General project without a preview offers no game panel. The design
    // route brings its canvas forward, beside the design document.
    expect(tabs("left")).toEqual(["*Chat"]);
    expect(tabs("center")).toEqual(["Code", "Design", "*Canvas", "Assets"]);
    const composer = document.querySelector(".composer");
    expect(composer).not.toBeNull();
    await click("Close Chat");
    expect(container.querySelector(".dock-area-left")).toBeNull();
    // With the chat closed, its composer floats over the middle, and only
    // there: the same one, moved rather than made again, so it keeps its state.
    expect(document.querySelectorAll(".composer")).toHaveLength(1);
    expect(container.querySelector(".dock-area-center .floating-chat .composer")).toBe(composer);

    await act(async () =>
      daemon.send(1, "workspace.restored", {
        version: "restored",
        changed: [],
      }),
    );
    await settle();
    expect(container.querySelector(".dock-area-left")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("ohmygame-workspace-layout")!)
        .layout.left.panels,
    ).toEqual([]);

    // The + menu offers the closed panels, then the layouts, which put the chat back on the left.
    await click("Add panel");
    expect(menuItem("Chat")).toBeDefined();
    await act(async () => menuItem("Default").click());
    await settle();
    expect(tabs("left")).toEqual(["*Chat"]);
    // The top bar has no layout button now; the project menu leads with the project's settings.
    expect(button("Layout and panels")).toBeUndefined();
    await act(async () => container.querySelector<HTMLButtonElement>(".project-name")!.click());
    const projectMenu = [...document.querySelectorAll(".ui-menu-item")].map((item) => item.textContent?.trim());
    expect(projectMenu.slice(0, 2)).toEqual(["Project settings…", "Name and appearance…"]);
    expect(projectMenu).toContain("Plugins…");
    expect(projectMenu).not.toContain("Plugin changes…");
    await act(async () => menuItem("Project settings…").click());
    expect(document.querySelector(".project-settings")).not.toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>(".project-settings")!.click());
    expect(document.querySelector(".project-settings")).toBeNull();
    expect(container.querySelector(".floating-chat")).toBeNull();
    expect(document.querySelector(".agent-pane .agent-body > .chat-input > .composer")).toBe(composer);
  });
});

describe("plugins in the project shell", () => {
  it("puts the initial message back in the input box until a plugin type's project is set up, opening the panel that sets it up", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
    let ready = false;
    const handled = vi.fn();
    const attachment = { id: "file", batchId: "batch", name: "sketch.txt", relativePath: "sketch.txt", size: 12, kind: "text" as const };
    const daemon = await openProject(
      (route, init) => {
        if (route === "/projects/project")
          return Response.json({
            id: "project", name: "Native", type: "general", webPreviewEnabled: false, workspacePath: "/tmp/project",
            updatedAt: new Date(0).toISOString(), preview: { status: "stopped" },
            pluginType: { id: "acme/maker:maker", plugin: "acme/maker", preview: "native" },
          });
        if (route.startsWith("/projects/project/plugin-panels")) return Response.json([
          { id: "setup", plugin: "acme/maker", version: "1.0.0", title: "Maker setup", area: "right", capabilities: {}, commands: [], url: "about:blank" },
        ]);
        if (/\/turns(\?|$)/.test(route) && init.method === "POST" && !ready)
          return Response.json({ error: "Connect a Maker project first", code: "project-not-ready", panel: "acme/maker:setup" }, { status: 409 });
        return undefined;
      },
      detail("live-turn"),
      { initialPrompt: { generation: 1, prompt: "Build my Maker game", mentions: [], images: [], mode: "planning", attachments: [attachment] }, onInitialPromptHandled: handled },
    );
    await settle();
    // The message is the input box's to send again or change, with what it carried and why it waits.
    expect(handled).toHaveBeenCalledOnce();
    expect(container.querySelector(".composer-info")?.textContent).toBe("Your first message hasn't been sent yet, so it's back in the message box. Connect a Maker project first");
    expect(container.querySelector(".composer-error")).toBeNull();
    expect(promptText(container)).toBe("Build my Maker game");
    expect(container.querySelector(".composer-attachment")?.textContent).toBe("sketch.txt");
    const tabs = () => [...container.querySelectorAll(".dock-area-right .dock-tab-label")].map((tab) => tab.textContent);
    expect(tabs()).toContain("Maker setup");
    // Closed, the panel comes back when the message is refused again.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Maker setup"]')!.click());
    expect(tabs()).not.toContain("Maker setup");
    const send = () => act(async () => container.querySelector<HTMLButtonElement>(".send-button")!.click());
    await send();
    await settle();
    expect(tabs()).toContain("Maker setup");
    expect(promptText(container)).toBe("Build my Maker game");
    ready = true;
    await send();
    await settle();
    const sent = daemon.requests.filter((request) => request.method === "POST" && /\/turns(\?|$)/.test(request.route));
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[2]!.body!)).toMatchObject({ prompt: "Build my Maker game", mode: "planning", attachments: [{ id: "file", batchId: "batch" }] });
    expect(container.querySelector(".composer-info")).toBeNull();
    expect(promptText(container)).toBe("");
    expect(container.querySelector(".composer-attachment")).toBeNull();
  });

  it("doesn't offer the initial message again when its request was lost on the way, as the turn may have started", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
    const handled = vi.fn();
    await openProject(
      (route, init) => {
        if (/\/turns(\?|$)/.test(route) && init.method === "POST") throw new TypeError("Failed to fetch");
        return undefined;
      },
      detail("live-turn"),
      { initialPrompt: { generation: 1, prompt: "Build my game", mentions: [], images: [], mode: "normal" }, onInitialPromptHandled: handled },
    );
    await settle();
    expect(handled).toHaveBeenCalledOnce();
    expect(container.querySelector(".composer-error")?.textContent).toContain("Failed to fetch");
    expect(container.querySelector(".composer-info")).toBeNull();
    expect(promptText(container)).toBe("");
  });

  it("shows a plugin's frame once its page has the app's theme", async () => {
    const frameModule = await import("../src/renderer/plugin-frame.js");
    const { PluginFrame, connectPluginFrame, PLUGIN_FRAME_REVEAL_AFTER_LOAD_MS, PLUGIN_FRAME_REVEAL_LATEST_MS } = frameModule;
    const context = {
      plugin: { id: "acme/maker", version: "1.0.0", panel: "main" },
      locale: "en" as const,
      capabilities: {},
      commands: [],
      project: () => ({ name: "Game", type: "web-game" }),
      storage: { get: async () => null, set: async () => {} },
      files: NO_FILES,
      runCommand: async () => null,
      history: async () => ({ turns: [] }),
      usage: async () => ({ rows: [] }),
      toast: () => {},
      confirm: async () => false,
    };
    // The page's bridge says once it has applied the theme it was sent.
    let page: MessagePort | undefined;
    const ready = vi.fn();
    // It also answers pings, and passes on errors the page didn't catch, cut to length.
    const onPong = vi.fn();
    const onError = vi.fn();
    const connection = connectPluginFrame({ postMessage: (_data: unknown, _origin: string, ports: MessagePort[]) => (page = ports[0]) } as unknown as Window, context, ready, { onPong, onError });
    page!.postMessage({ event: "ready" });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    page!.postMessage({ event: "pong" });
    page!.postMessage({ event: "error", message: `TypeError: ${"x".repeat(5000)}` });
    page!.postMessage({ event: "error", message: { not: "text" } });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(onPong).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toHaveLength(4000);
    expect(onError.mock.calls[1]![0]).toBe("Error");
    connection.close();
    page!.close();

    // Without a bridge, a frame shows a moment after its page loads.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => root.render(<PluginFrame url="about:blank" title="Loads" context={context} />));
      const loads = container.querySelector<HTMLIFrameElement>("iframe.plugin-frame")!;
      expect(loads.hasAttribute("data-ready")).toBe(false);
      await act(async () => vi.advanceTimersByTime(PLUGIN_FRAME_REVEAL_AFTER_LOAD_MS + 50));
      expect(loads.isConnected).toBe(true);
      expect(loads.hasAttribute("data-ready")).toBe(true);
      await act(async () => root.render(<></>));

      // One whose page never loads still shows within a few seconds.
      const listen = HTMLIFrameElement.prototype.addEventListener;
      vi.spyOn(HTMLIFrameElement.prototype, "addEventListener").mockImplementation(function (this: HTMLIFrameElement, type: string, ...rest: unknown[]) {
        if (type !== "load") (listen as (...args: unknown[]) => void).call(this, type, ...rest);
      });
      await act(async () => root.render(<PluginFrame url="about:blank#stalls" title="Stalls" context={context} />));
      const stalls = container.querySelector<HTMLIFrameElement>("iframe.plugin-frame")!;
      await act(async () => vi.advanceTimersByTime(PLUGIN_FRAME_REVEAL_LATEST_MS - 1));
      expect(stalls.hasAttribute("data-ready")).toBe(false);
      await act(async () => vi.advanceTimersByTime(1));
      expect(stalls.hasAttribute("data-ready")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a plugin's brand colour only where it stands out, and keeps its page from flooding the app", async () => {
    const { accentTokens, handlePluginUiRequest, rateLimit } = await import("../src/renderer/plugin-frame.js");
    const app = { "--color-surface": "#1c1c1c", "--color-accent": "#2563eb", "--color-on-accent": "#ffffff" };
    const light = { ...app, "--color-surface": "#ffffff" };
    expect(accentTokens("#00d8c4", "dark", app)).toEqual({ "--omg-accent": "#00d8c4", "--omg-on-accent": "#000000" });
    // Too faint on a light surface, so the app's accent takes its place.
    expect(accentTokens("#00d8c4", "light", light)).toEqual({ "--omg-accent": "#2563eb", "--omg-on-accent": "#ffffff" });
    expect(accentTokens({ dark: "#00d8c4", light: "#00857a" }, "light", light)).toEqual({ "--omg-accent": "#00857a", "--omg-on-accent": "#000000" });
    expect(accentTokens({ dark: "#00d8c4" }, "light", light)["--omg-accent"]).toBe("#2563eb");
    expect(accentTokens(undefined, "dark", app)["--omg-accent"]).toBe("#2563eb");
    expect(accentTokens("#00d8c4", "dark", { ...app, "--color-surface": "color-mix(in srgb, red, blue)" })["--omg-accent"]).toBe("#2563eb");
    expect(accentTokens("#00d8c4", "dark", { ...app, "--color-surface": "rgb(28, 28, 28)" })["--omg-accent"]).toBe("#00d8c4");

    let time = 0;
    const allowed = rateLimit(2, 100, () => time);
    expect([allowed(), allowed(), allowed()]).toEqual([true, true, false]);
    time = 100;
    expect(allowed()).toBe(true);

    const toast = vi.fn();
    const confirm = vi.fn(async () => true);
    const context = {
      plugin: { id: "acme/maker", version: "1.0.0", panel: "main" },
      locale: "en" as const,
      capabilities: {},
      commands: [],
      project: () => ({ name: "Game", type: "web-game" }),
      storage: { get: async () => null, set: async () => {} },
      files: NO_FILES,
      runCommand: async () => null,
      history: async () => ({ turns: [] }),
      usage: async () => ({ rows: [] }),
      toast,
      confirm,
    };
    await expect(handlePluginUiRequest({ id: 1, method: "ui.toast", params: { message: "Saved", tone: "success" } }, context)).resolves.toBeNull();
    expect(toast).toHaveBeenCalledWith("Saved", "success");
    await expect(handlePluginUiRequest({ id: 2, method: "ui.confirm", params: { title: "Reset?", message: "Clears it.", confirmLabel: "Reset", extra: "dropped" } }, context)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith({ title: "Reset?", message: "Clears it.", confirmLabel: "Reset" });
  });

  it("refuses a question from a hidden page, and more toasts than the limit", async () => {
    const { PluginFrame, PLUGIN_TOAST_LIMIT } = await import("../src/renderer/plugin-frame.js");
    const toast = vi.fn();
    const confirm = vi.fn(async () => true);
    const context = {
      plugin: { id: "acme/noisy", version: "1.0.0", panel: "main" },
      locale: "en" as const,
      capabilities: {},
      commands: [],
      project: () => ({ name: "Game", type: "web-game" }),
      storage: { get: async () => null, set: async () => {} },
      files: NO_FILES,
      runCommand: async () => null,
      history: async () => ({ turns: [] }),
      usage: async () => ({ rows: [] }),
      toast,
      confirm,
    };
    let page: MessagePort | undefined;
    const post = vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue({
      postMessage: (_data: unknown, _origin: string, ports: MessagePort[]) => (page = ports[0]),
    } as unknown as Window);
    try {
      await act(async () => root.render(<PluginFrame url="about:blank" title="Page" context={context} visible={false} />));
      const frame = container.querySelector<HTMLIFrameElement>("iframe.plugin-frame")!;
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
      });
      const replies = new Map<number, Record<string, unknown>>();
      page!.onmessage = ({ data }) => replies.set(data.id, data);
      page!.postMessage({ id: 1, method: "ui.confirm", params: { title: "Reset?" } });
      await vi.waitFor(() => expect(replies.get(1)?.error).toContain("isn't showing"));
      expect(confirm).not.toHaveBeenCalled();
      await act(async () => root.render(<PluginFrame url="about:blank" title="Page" context={context} visible />));
      page!.postMessage({ id: 2, method: "ui.confirm", params: { title: "Reset?" } });
      await vi.waitFor(() => expect(replies.get(2)?.result).toBe(true));
      for (let id = 10; id <= 10 + PLUGIN_TOAST_LIMIT; id++) page!.postMessage({ id, method: "ui.toast", params: { message: "Hello" } });
      await vi.waitFor(() => expect(replies.get(10 + PLUGIN_TOAST_LIMIT)?.error).toContain("too many"));
      expect(toast).toHaveBeenCalledTimes(PLUGIN_TOAST_LIMIT);
      // Both of two toolbar commands that finish together reach the page, and another plugin's doesn't.
      const heard: unknown[] = [];
      const listeners = new Set<(run: { command: string; result?: unknown; error?: string }) => void>();
      const onToolbarRun = (listener: (run: { command: string; result?: unknown; error?: string }) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      };
      await act(async () => root.render(<PluginFrame url="about:blank" title="Page" context={context} visible onToolbarRun={onToolbarRun} />));
      page!.onmessage = ({ data }) => {
        if (data.event === "command") heard.push(data);
        else replies.set(data.id, data);
      };
      await act(async () => {
        for (const listener of listeners) {
          listener({ command: "acme/noisy:one", result: 1 });
          listener({ command: "acme/noisy:two", error: "Failed" });
          listener({ command: "acme/other:three" });
        }
      });
      await vi.waitFor(() => expect(heard).toEqual([{ event: "command", command: "one", result: 1 }, { event: "command", command: "two", error: "Failed" }]));
      // A second page of the plugin shares its limit.
      const first = page!;
      await act(async () => root.render(<PluginFrame key="other" url="about:blank#other" title="Other" context={{ ...context, plugin: { ...context.plugin, panel: "other" } }} visible />));
      await act(async () => {
        container.querySelector("iframe.plugin-frame")!.dispatchEvent(new Event("load"));
      });
      expect(page).not.toBe(first);
      page!.onmessage = ({ data }) => replies.set(data.id, data);
      page!.postMessage({ id: 30, method: "ui.toast", params: { message: "Hello" } });
      await vi.waitFor(() => expect(replies.get(30)?.error).toContain("too many"));
      page!.close();
    } finally {
      post.mockRestore();
    }
  });

  it("passes a page's net.fetch to the app only when the page may use it", async () => {
    const { PluginFrame } = await import("../src/renderer/plugin-frame.js");
    const fetch = vi.fn(async () => ({ status: 200, statusText: "OK", url: "https://api.example.com/a", headers: {}, body: "hi" }));
    const context = {
      plugin: { id: "_project/stats", version: "r1", panel: "stats" },
      locale: "en" as const,
      capabilities: { net: ["api.example.com"] },
      commands: [],
      project: () => ({ name: "Game", type: "web-game" }),
      storage: { get: async () => null, set: async () => {} },
      files: NO_FILES,
      runCommand: async () => null,
      history: async () => ({ turns: [] }),
      usage: async () => ({ rows: [] }),
      toast: vi.fn(),
      confirm: vi.fn(async () => true),
      fetch,
    };
    let page: MessagePort | undefined;
    const post = vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue({
      postMessage: (_data: unknown, _origin: string, ports: MessagePort[]) => (page = ports[0]),
    } as unknown as Window);
    try {
      await act(async () => root.render(<PluginFrame url="about:blank" title="Stats" context={context} visible />));
      await act(async () => {
        container.querySelector<HTMLIFrameElement>("iframe.plugin-frame")!.dispatchEvent(new Event("load"));
      });
      const replies = new Map<number, Record<string, unknown>>();
      page!.onmessage = ({ data }) => replies.set(data.id, data);
      page!.postMessage({ id: 1, method: "net.fetch", params: { url: "https://api.example.com/a" } });
      await vi.waitFor(() => expect(replies.get(1)?.result).toMatchObject({ status: 200, body: "hi" }));
      expect(fetch).toHaveBeenCalledWith({ url: "https://api.example.com/a" });
      await act(async () => root.render(<PluginFrame url="about:blank" title="Stats" context={{ ...context, capabilities: {} }} visible />));
      page!.postMessage({ id: 2, method: "net.fetch", params: { url: "https://api.example.com/a" } });
      await vi.waitFor(() => expect(replies.get(2)?.error).toContain("net capability"));
      expect(fetch).toHaveBeenCalledTimes(1);
      page!.close();
    } finally {
      post.mockRestore();
    }
  });

  it("hands a page the project's files as far as it may use them, and says when they change", async () => {
    const { PluginFrame } = await import("../src/renderer/plugin-frame.js");
    // A browser's port carries a Blob; jsdom's Blob doesn't survive Node's port, and Node's own does.
    vi.stubGlobal("Blob", (await import("node:buffer")).Blob);
    const written: Array<[string, string]> = [];
    const files = {
      ...NO_FILES,
      read: async () => new Blob(["level"], { type: "application/json" }),
      write: async (path: string, contents: Blob) => {
        written.push([path, await contents.text()]);
        return path;
      },
    };
    const context = {
      plugin: { id: "acme/files", version: "1.0.0", panel: "main" },
      locale: "en" as const,
      capabilities: { "project.files": "read" as "read" | "write" },
      commands: [],
      project: () => ({ name: "Game", type: "web-game" }),
      storage: { get: async () => null, set: async () => {} },
      files,
      runCommand: async () => null,
      history: async () => ({ turns: [] }),
      usage: async () => ({ rows: [] }),
      toast: () => {},
      confirm: async () => false,
    };
    let page: MessagePort | undefined;
    const post = vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue({
      postMessage: (_data: unknown, _origin: string, ports: MessagePort[]) => (page = ports[0]),
    } as unknown as Window);
    try {
      await act(async () => root.render(<PluginFrame url="about:blank" title="Files" context={context} visible filesRevision={1} />));
      await act(async () => {
        container.querySelector("iframe.plugin-frame")!.dispatchEvent(new Event("load"));
      });
      const replies = new Map<number, Record<string, unknown>>();
      const events: unknown[] = [];
      page!.onmessage = ({ data }) => (data.event ? events.push(data) : replies.set(data.id, data));
      page!.postMessage({ id: 1, method: "files.read", params: { path: "levels/one.json" } });
      await vi.waitFor(() => expect(replies.get(1)?.result).toBeInstanceOf(Blob));
      expect(await (replies.get(1)!.result as Blob).text()).toBe("level");
      // Reading doesn't cover writing.
      page!.postMessage({ id: 2, method: "files.write", params: { path: "a.txt", data: "x" } });
      await vi.waitFor(() => expect(replies.get(2)?.error).toContain("project.files capability set to write"));
      expect(written).toEqual([]);
      const writer = { ...context, capabilities: { "project.files": "write" as const } };
      await act(async () => root.render(<PluginFrame url="about:blank" title="Files" context={writer} visible filesRevision={1} />));
      page!.postMessage({ id: 3, method: "files.write", params: { path: "a.txt", data: "text" } });
      page!.postMessage({ id: 4, method: "files.write", params: { path: "b.bin", data: new Blob(["bytes"]) } });
      await vi.waitFor(() => expect(replies.get(4)?.result).toBe("b.bin"));
      expect(written).toEqual([["a.txt", "text"], ["b.bin", "bytes"]]);
      expect(events.filter((event) => (event as { event: string }).event === "files")).toEqual([]);
      await act(async () => root.render(<PluginFrame url="about:blank" title="Files" context={writer} visible filesRevision={2} />));
      await vi.waitFor(() => expect(events).toContainEqual({ event: "files" }));
      // Changes that arrive before one render reach the page together.
      const { mergeFileChanges } = await import("../src/renderer/project-shell.js");
      const both = mergeFileChanges(mergeFileChanges(undefined, { paths: ["src/b.ts"] }), { paths: ["src/a.ts", ".env"] });
      expect(both).toEqual({ paths: [".env", "src/a.ts", "src/b.ts"] });
      expect(mergeFileChanges({ paths: Array.from({ length: 200 }, (_, index) => `f${index}`) }, { paths: ["g"] })).toMatchObject({ truncated: true });
      await act(async () => root.render(<PluginFrame url="about:blank" title="Files" context={writer} visible filesRevision={2} fileChange={both} />));
      await vi.waitFor(() => expect(events).toContainEqual({ event: "files", paths: ["src/a.ts", "src/b.ts"] }));
      page!.close();
    } finally {
      post.mockRestore();
    }
  });

  it("draws a panel's toolbar commands in manifest order, with the rest in a menu, one run at a time", async () => {
    const { PluginPanelToolbar, PLUGIN_TOOLBAR_BUTTONS } = await import("../src/renderer/project-plugin-contributions.js");
    const commands = ["one", "two", "three", "four"].map((id) => ({ id: `acme/maker:${id}`, plugin: "acme/maker", title: id, slots: [{ slot: "panel.toolbar" }], run: { native: id } }));
    let finish!: () => void;
    const onRun = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await act(async () => root.render(<PluginPanelToolbar commands={commands as never} onRun={onRun} />));
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".plugin-toolbar .ui-button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["one", "two", "three"].slice(0, PLUGIN_TOOLBAR_BUTTONS));
    expect(container.querySelector(".plugin-toolbar .ui-icon-button")).not.toBeNull();
    await act(async () => buttons[0]!.click());
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(buttons[0]!.disabled).toBe(true);
    await act(async () => buttons[0]!.click());
    expect(onRun).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(buttons[0]!.disabled).toBe(false);
    await act(async () => root.render(<PluginPanelToolbar commands={[]} onRun={onRun} />));
    expect(container.querySelector(".plugin-toolbar")).toBeNull();
  });

  it("shows a plugin's panel where it asks, and runs its menu command with Undo", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
    const { ToastProvider } = await import("../src/renderer/ui/index.js");
    const daemon = await openProject((route, init) => {
      if (route.startsWith("/projects/project/plugin-panels")) return Response.json([
        { id: "preview", plugin: "acme/maker", version: "1.0.0", title: "Maker preview", area: "right", capabilities: {}, commands: ["upload"], url: "about:blank" },
        { id: "hidden", plugin: "acme/maker", version: "1.0.0", title: "Hidden", area: "right", when: "project.type == 'web-game'", capabilities: {}, commands: [], url: "about:blank" },
        // Shown because a plugin without panels or commands is active here.
        { id: "tools", plugin: "acme/maker", version: "1.0.0", title: "Tool log", area: "bottom", when: "project.plugin('acme/tools')", capabilities: {}, commands: [], url: "about:blank" },
      ]);
      if (route.startsWith("/projects/project/plugins")) return Response.json({ global: [], plugins: [
        { id: "acme/tools", displayName: "Tools", description: "", version: "1.0.0", used: "1.0.0", status: "active", providesType: false, capabilities: [], consented: true },
      ] });
      if (route.startsWith("/projects/project/plugin-commands") && init.method === "POST") return Response.json({ result: null, change: { id: "change-1", changed: ["build/index.html"] } });
      if (route.startsWith("/projects/project/plugin-commands")) return Response.json([
        { id: "acme/maker:upload", plugin: "acme/maker", title: "Upload build", slots: [{ slot: "project.menu" }], run: { native: "upload" } },
        // The manifest only checks the prefix, so a link can still be malformed.
        { id: "acme/maker:docs", plugin: "acme/maker", title: "Open docs", slots: [{ slot: "project.menu" }], run: { url: "https://[" } },
      ]);
      if (route === "/projects/project/plugin-changes/change-1/undo") return new Response(null, { status: 204 });
    }, detail("live-turn"), { wrap: (shell) => <ToastProvider>{shell}</ToastProvider> });
    await settle();
    const tabs = (area: string) => [...container.querySelectorAll(`.dock-area-${area} .dock-tab-label`)].map((tab) => tab.textContent);
    // A panel whose `when` doesn't hold here stays out.
    expect(tabs("right")).toEqual(["Maker preview"]);
    expect(tabs("bottom")).toEqual(["Tool log"]);
    const frame = container.querySelector<HTMLIFrameElement>(".dock-area-right iframe.plugin-frame")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");

    // Moving or closing the panel keeps its page, as with the built-in panels.
    const view = frame.closest(".dock-view");
    expect(view).not.toBeNull();
    const tab = [...container.querySelectorAll(".dock-area-right .dock-tab")].find((entry) => entry.textContent?.includes("Maker preview"))!;
    await act(async () => tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".ui-menu-item")].find((entry) => entry.textContent?.trim() === "Move to Bottom")!.click());
    await settle();
    expect(tabs("bottom")).toEqual(["Tool log", "Maker preview"]);
    // happy-dom has no moveBefore, so the moved iframe reloads here; the view holding it is the same.
    expect(container.querySelector(".dock-area-bottom iframe.plugin-frame[title='Maker preview']")?.closest(".dock-view")).toBe(view);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Maker preview"]')!.click());
    expect(view!.isConnected).toBe(true);

    await act(async () => container.querySelector<HTMLButtonElement>(".project-name")!.click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>(".ui-menu-item")].find((entry) => entry.textContent?.trim() === "Open docs")!.click());
    expect(document.querySelector(".ui-toasts")?.textContent).toContain("isn't a valid web address");
    expect(container.querySelector(".project-name")).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>(".project-name")!.click());
    const item = [...document.querySelectorAll<HTMLButtonElement>(".ui-menu-item")].find((entry) => entry.textContent?.trim() === "Upload build")!;
    await act(async () => item.click());
    await settle();
    expect(daemon.requests.find((request) => request.route === "/projects/project/plugin-commands" && request.method === "POST")?.body).toBe(JSON.stringify({ command: "acme/maker:upload" }));
    expect(document.querySelector(".ui-toasts")?.textContent).toContain("Upload build finished");
    await act(async () => document.querySelector<HTMLButtonElement>(".ui-toast-action")!.click());
    await settle();
    expect(daemon.requests.some((request) => request.route === "/projects/project/plugin-changes/change-1/undo" && request.method === "POST")).toBe(true);

    // A running command's sign-in link opens only once the person sees its host.
    await act(async () => daemon.send(1, "plugin.command.progress", { command: "acme/maker:upload", message: "Plain link", url: "http://maker.example.com/device" }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => daemon.send(2, "plugin.command.progress", { command: "acme/maker:upload", message: "Sign in to Maker", url: "https://maker.example.com/device?code=AB12" }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sign in to Maker");
    expect(dialog.textContent).toContain("maker.example.com");

    // An edit to ohmygame.json outside the app reaches the open project.
    const reads = () => daemon.requests.filter((request) => request.route.startsWith("/projects/project/plugin-panels")).length;
    const before = reads();
    await act(async () => daemon.send(3, "project.plugins.changed", {}));
    await settle();
    expect(reads()).toBe(before + 1);
  });
});

describe("continue after a usage limit in the project shell", () => {
  /** A chat stopped at a usage limit, with a daemon that keeps the state of its continue. */
  async function openStopped(otherRoutes: (route: string) => Response | Promise<Response> | undefined = () => undefined) {
    const chat = detail("turn");
    chat.settings = { model: { provider: "claude-code-cli", id: "sonnet" } };
    chat.turns[0] = { id: "turn", conversationId: "conversation", status: "failed", items: [
      { id: "turn:user", turnId: "turn", type: "userMessage", text: "Build", checkpointId: "checkpoint-1", changes: { files: 2 } },
      { id: "turn:error", turnId: "turn", type: "agentMessage", text: "", status: "failed", error: { code: "quota_exceeded", message: "You've hit your limit" } },
    ] };
    let limitState = "armed";
    return openProject((route, init) => {
      const other = otherRoutes(route);
      if (other) return other;
      if (route.includes("/context-usage")) return Response.json({ contextUsage: { tokens: null, contextWindow: 0, percent: null, limitResume: { at: Date.UTC(2026, 9, 26, 12), state: limitState } } });
      if (route === "/agent-runtimes/claude-code-cli" && init.method === "PATCH") {
        limitState = JSON.parse(String(init.body)).autoContinue ? "armed" : "off";
        return Response.json({});
      }
      if (route.endsWith("/limit-resume/skip")) {
        limitState = "skipped";
        return new Response(null, { status: 204 });
      }
    }, chat);
  }
  const toggle = () => container.querySelector<HTMLButtonElement>('.agent-error-card [role="switch"]');

  it("shows the switch on the card and changes the coding agent's setting from it", async () => {
    const daemon = await openStopped();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle()!.click());
    await settle();
    expect(daemon.requests.find((request) => request.method === "PATCH")).toMatchObject({ route: "/agent-runtimes/claude-code-cli", body: JSON.stringify({ autoContinue: false }) });
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle()!.click());
    await settle();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the switch when the turn on screen stops at the limit", async () => {
    let limitResume: { at: number; state: string } | undefined;
    const chat = detail("turn");
    chat.settings = { model: { provider: "claude-code-cli", id: "sonnet" } };
    chat.agent = { status: "running" };
    chat.turns[0] = { id: "turn", conversationId: "conversation", status: "inProgress", items: [{ id: "turn:user", turnId: "turn", type: "userMessage", text: "Build" }] };
    const daemon = await openProject((route) => route.includes("/context-usage") ? Response.json({ contextUsage: { tokens: null, contextWindow: 0, percent: null, limitResume } }) : undefined, chat);
    expect(toggle()).toBeNull();
    limitResume = { at: Date.UTC(2026, 9, 26, 12), state: "armed" };
    await act(async () => {
      daemon.send(1, "item.completed", { item: { id: "turn:error", turnId: "turn", type: "agentMessage", text: "", status: "failed", error: { code: "quota_exceeded", message: "You've hit your limit" } } }, "conversation", "turn");
      daemon.send(2, "agent.error", { error: "You've hit your limit", code: "quota_exceeded" }, "conversation", "turn");
    });
    await settle();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
  });

  it("doesn't carry the switch to another chat's card while that chat's state is read", async () => {
    const other = detail("turn");
    other.conversation = { ...other.conversation, id: "other", title: "Other" };
    other.settings = { model: { provider: "claude-code-cli", id: "sonnet" } };
    other.turns[0] = { id: "turn", conversationId: "other", status: "failed", items: [
      { id: "turn:error", turnId: "turn", type: "agentMessage", text: "", status: "failed", error: { code: "authentication_failed", message: "Signed out" } },
    ] };
    const daemon = await openStopped((route) => {
      if (route === "/projects/project/conversations") return Response.json([detail("turn").conversation, other.conversation]);
      if (route.includes("/conversations/other/context-usage")) return new Promise<Response>(() => {});
      if (route.split("?")[0] === "/projects/project/conversations/other") return Response.json(other);
    });
    expect(toggle()).not.toBeNull();
    await daemon.route("other");
    await settle();
    expect(container.querySelector(".agent-error-card")).not.toBeNull();
    expect(toggle()).toBeNull();
  });

  it("reads it again, without the old switch, when a turn starts and fails in one go", async () => {
    let reads = 0;
    let reading = false;
    const daemon = await openStopped((route) => {
      if (!reading || !route.includes("/context-usage")) return undefined;
      reads += 1;
      return new Promise<Response>(() => {});
    });
    expect(toggle()).not.toBeNull();
    reading = true;
    const event = (id: number, type: RuntimeEventType, data: unknown) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, projectId: "project", conversationId: "conversation", turnId: "next", type, timestamp: new Date(0).toISOString(), data })}\n\n`;
    await act(async () => daemon.events!.enqueue(new TextEncoder().encode([
      event(1, "agent.started", { prompt: "Again" }),
      event(2, "item.completed", { item: { id: "next:error", turnId: "next", type: "agentMessage", text: "", status: "failed", error: { code: "authentication_failed", message: "Signed out" } } }),
      event(3, "agent.error", { error: "Signed out", code: "authentication_failed" }),
    ].join(""))));
    await settle();
    expect(container.querySelectorAll(".agent-error-card")).toHaveLength(2);
    expect(toggle()).toBeNull();
    expect(reads).toBeGreaterThan(0);
  });

  it("takes the switch away as soon as another turn starts", async () => {
    let reading = false;
    const daemon = await openStopped((route) => reading && route.includes("/context-usage") ? new Promise<Response>(() => {}) : undefined);
    expect(toggle()).not.toBeNull();
    reading = true;
    await act(async () => daemon.send(1, "agent.started", { prompt: "Again" }, "conversation", "next"));
    await settle();
    expect(toggle()).toBeNull();
  });

  it("takes the switch away when undoing the turn ended the continue", async () => {
    let undone = false;
    await openStopped((route) => {
      if (route === `${BASE}/changes`) return Response.json({ changes: CHANGES });
      if (route === `${BASE}/undo`) {
        undone = true;
        return Response.json({ changed: ["a.js", "b.js"], conflicts: [] });
      }
      if (undone && route.includes("/context-usage")) return Response.json({ contextUsage: { tokens: null, contextWindow: 0, percent: null } });
    });
    expect(toggle()).not.toBeNull();
    await click("2 files changed");
    await click("Undo");
    expect(undone).toBe(true);
    expect(toggle()).toBeNull();
  });

  it("skips the continue and takes the switch away once a message is being written", async () => {
    localStorage.setItem("ohmygame:composer-draft:v1:project:conversation", JSON.stringify({ version: 1, prompt: "Change direction", mentions: [], planning: false }));
    const daemon = await openStopped();
    await settle();
    expect(daemon.requests.filter((request) => request.route.endsWith("/limit-resume/skip"))).toHaveLength(1);
    expect(toggle()).toBeNull();
  });
});

describe("checkpoints in the project shell", () => {
  it.each(["claude-code-cli", "codex-cli"] as const)("switches the selected %s chat account without changing its model or other chats", async (runtime) => {
    const chat = detail("turn");
    chat.settings = { model: { provider: runtime, id: runtime === "codex-cli" ? "gpt-test" : "sonnet" }, accountProfiles: { [runtime]: "system" } };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const daemon = await openProject((route, init) => {
      if (route === `/agent-runtimes/${runtime}/profiles`) return Response.json([
        { id: "system", name: "System default", auth: { status: "signed-in", billing: "subscription", account: "personal@example.com" } },
        { id: "work", name: "Work", auth: { status: "signed-in", billing: "subscription", account: "work@example.com" }, limits: [{ id: "codex/primary", usedPercent: 96, windowMinutes: 300 }] },
      ]);
      if (route.endsWith("/account-profile") && init.method === "PUT") return Response.json({ profileId: "work" });
    }, chat);
    const label = `${runtime === "codex-cli" ? "Codex" : "Claude Code"} account`;
    const selector = container.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`)!;
    expect(selector).not.toBeNull();
    const profileReads = daemon.requests.filter((request) => request.route === `/agent-runtimes/${runtime}/profiles`).length;
    await act(async () => selector.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('.agent-account-menu [role="radio"]')].find((button) => button.textContent?.includes("Work"))!;
    // Each account shows its busiest window, so one with room left is easy to pick.
    expect(option.querySelector(".agent-account-row-usage.is-danger")?.textContent).toBe("96%");
    await act(async () => option.click());
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(selector.querySelector(".agent-account-trigger-name")?.textContent).toBe("Work");
    expect(container.querySelector(`[aria-label^="${label}:"]`)).toBe(selector);
    expect(daemon.requests.filter((request) => request.route === `/agent-runtimes/${runtime}/profiles`)).toHaveLength(profileReads);
    expect(daemon.requests.find((request) => request.route.endsWith("/account-profile"))).toMatchObject({ method: "PUT", body: JSON.stringify({ runtime, profileId: "work" }) });
    expect(daemon.requests.some((request) => request.route.endsWith("/model") && request.method === "PUT")).toBe(false);
  });

  it("keeps a conversation opened while the previous one was being archived", async () => {
    let archived!: () => void;
    const onOpenConversation = vi.fn();
    const other = { ...detail("turn").conversation, id: "other", title: "Other" };
    const daemon = await openProject((route, init) => {
      if (route === "/projects/project/conversations") return Response.json([detail("turn").conversation, other]);
      if (route === "/projects/project/conversations/other") return Response.json({ ...detail("turn"), conversation: other });
      if (route.endsWith("/conversation/archive") && init.method === "POST") return new Promise((resolve) => { archived = () => resolve(new Response(null, { status: 204 })); });
    }, undefined, { onOpenConversation });
    // The header keeps the history behind a button instead of showing the open conversation's title.
    expect(document.querySelector(".chat-header-actions")?.textContent).not.toContain("Chat");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Conversation history"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Archive Chat"]')!.click());
    await daemon.route("other");
    onOpenConversation.mockClear();
    await act(async () => archived());
    await settle();
    expect(onOpenConversation).not.toHaveBeenCalled();
  });

  it("shows why a project could not open instead of failing to render", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await openProject((route) => route === "/projects/project" ? Response.json({ error: "Project storage is unreadable" }, { status: 500 }) : undefined);
    expect(container.textContent).toContain("Project storage is unreadable");
    expect(errors.mock.calls.some((call) => String(call[0]).includes("hooks"))).toBe(false);
  });

  it("refreshes the account picker after a profile is deleted in settings", async () => {
    let removed = false;
    const chat = detail("turn");
    chat.settings = { model: { provider: "codex-cli", id: "gpt-test" }, accountProfiles: { "codex-cli": "work" } };
    const daemon = await openProject((route) => {
      if (route === "/agent-runtimes/codex-cli/profiles") return Response.json([
        { id: "system", name: "System default", auth: { status: "signed-in", billing: "subscription" } },
        { id: "personal", name: "Personal", auth: { status: "signed-in", billing: "subscription" } },
        ...(!removed ? [{ id: "work", name: "Work", auth: { status: "signed-in", billing: "subscription" } }] : []),
      ]);
    }, chat);
    expect(container.querySelector('[aria-label^="Codex account:"] .agent-account-trigger-name')?.textContent).toBe("Work");
    removed = true;
    await act(async () => window.dispatchEvent(new Event("ohmygame-models-changed")));
    await settle();
    expect(container.querySelector('[aria-label^="Codex account:"] .agent-account-trigger-name')?.textContent).toBe("Default");
    expect(daemon.requests.some((request) => request.route.endsWith("/account-profile") && request.method === "PUT")).toBe(false);
  });

  it("undoes a turn through the conflict choice and marks it without reading the conversation again", async () => {
    const daemon = await openProject((route, init) => {
      if (route === `${BASE}/changes`)
        return Response.json({
          changes: [
            { path: "a.js", kind: "modified", state: "changed" },
            { path: "b.js", kind: "added", state: "applied" },
          ],
        });
      if (route !== `${BASE}/undo`) return undefined;
      return init.body === "{}"
        ? Response.json(
            {
              error: "Files were changed after this turn",
              conflicts: ["a.js"],
            },
            { status: 409 },
          )
        : Response.json({ changed: ["b.js"], conflicts: ["a.js"] });
    });
    const asked = (route: string) =>
      daemon.requests.filter((request) => request.route.startsWith(route))
        .length;

    await click("2 files changed");
    expect(texts(".turn-change-row")).toEqual(["a.js—Changed later", "b.js—"]);

    await click("Undo");
    expect(texts(".turn-changes-conflicts li")).toEqual(["a.js"]);

    await click("Keep them");
    expect(
      daemon.requests.filter((request) => request.route === `${BASE}/undo`),
    ).toEqual([
      { route: `${BASE}/undo`, method: "POST", body: "{}" },
      {
        route: `${BASE}/undo`,
        method: "POST",
        body: JSON.stringify({ conflicts: "keep" }),
      },
    ]);
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "1 file was put back. 1 file was left as it is.",
    );

    const fileLists = asked("/projects/project/files");
    const changeLists = asked(`${BASE}/changes`);
    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 1 },
        "conversation",
      ),
    );
    await settle();

    // The event marks the turn. The conversation is not read for it.
    expect(asked("/projects/project/conversations/conversation?reset=1")).toBe(
      0,
    );
    expect(container.querySelector(".turn-changes-undone")!.textContent).toBe(
      "Partly undone",
    );
    expect(button("Undo")).toBeUndefined();
    expect(button("Undo the rest")).toBeDefined();
    // The turn marker does not also invalidate files. The project-wide event
    // updates every editor and the open list once, after the lock is released.
    expect(asked("/projects/project/files")).toBe(fileLists);
    expect(asked(`${BASE}/changes`)).toBe(changeLists);
    await act(async () =>
      daemon.send(2, "workspace.restored", {
        version: "restored",
        changed: ["a.js"],
      }),
    );
    await settle();
    expect(asked("/projects/project/files")).toBeGreaterThan(fileLists);
    expect(asked(`${BASE}/changes`)).toBe(changeLists + 1);
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "1 file was put back. 1 file was left as it is.",
    );
    expect(button("2 files changed")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("branches after confirmation and opens the returned conversation", async () => {
    const chat = detail("turn");
    const response = chat.turns[0]!.items[1]!;
    if (response.type === "agentMessage") response.branchEntryId = "stored-response";
    const onOpenConversation = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const daemon = await openProject((route, init) => route.endsWith("/branch") && init.method === "POST"
      ? Response.json({ ...chat.conversation, id: "new-branch" }) : undefined, chat, { onOpenConversation });
    await click("Branch in new chat");
    expect(confirm).toHaveBeenCalledWith("Create a new chat with all messages through this response?");
    expect(daemon.requests.some((request) => request.route.endsWith("/branch"))).toBe(false);
    confirm.mockReturnValue(true);
    await click("Branch in new chat");
    expect(daemon.requests.find((request) => request.route.endsWith("/branch"))).toMatchObject({ method: "POST", body: JSON.stringify({ entryId: "stored-response" }) });
    expect(onOpenConversation).toHaveBeenCalledWith("new-branch");
  });

  it("reapplies a turn, updates editors through SSE, and keeps the current conversation", async () => {
    const daemon = await openProject((route) => {
      if (route === `${BASE}/undo`)
        return Response.json({
          changed: ["a.js", "b.js"],
          conflicts: [],
          undone: true,
          kept: 0,
        });
      if (route === `${BASE}/reapply`)
        return Response.json({
          changed: ["a.js", "b.js"],
          conflicts: [],
          undone: false,
          kept: 0,
        });
      return undefined;
    });
    await click("2 files changed");
    await click("Undo");
    expect(button("Reapply")).toBeDefined();
    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 0 },
        "conversation",
      ),
    );
    await settle();
    await click("Reapply");
    expect(
      daemon.requests.filter((request) => request.route === `${BASE}/reapply`),
    ).toEqual([{ route: `${BASE}/reapply`, method: "POST", body: "{}" }]);
    expect(button("Reapply")).toBeUndefined();
    expect(button("Undo")).toBeDefined();
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "2 files reapplied.",
    );
    const fileReads = daemon.requests.filter(
      (request) => request.route === "/projects/project/files?directory=",
    ).length;
    await act(async () =>
      daemon.send(
        2,
        "workspace.reapplied",
        { checkpointId: "checkpoint-1", undone: false, kept: 0 },
        "conversation",
      ),
    );
    await act(async () =>
      daemon.send(3, "workspace.restored", {
        version: "reapplied",
        changed: ["a.js", "b.js"],
      }),
    );
    await settle();
    expect(
      daemon.requests.filter(
        (request) => request.route === "/projects/project/files?directory=",
      ).length,
    ).toBeGreaterThan(fileReads);
    expect(
      daemon.requests.some((request) => request.route.includes("?reset=1")),
    ).toBe(false);
    expect(container.textContent).toContain("Built");
  });

  it("keeps a turn that started while an undo was reported", async () => {
    const stored = {
      ...detail("stored-turn", { files: 2, undone: true }),
      cursor: 1,
    };
    const held: Array<() => void> = [];
    // A conversation read for the undo would be answered only after the next turn started.
    const daemon = await openProject((route) =>
      route.endsWith("?reset=1")
        ? new Promise<Response>((resolve) => {
            held.push(() => resolve(Response.json(stored)));
          })
        : undefined,
    );

    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 0 },
        "conversation",
      ),
    );
    await settle();
    await act(async () => {
      daemon.send(
        2,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      );
      daemon.send(
        3,
        "checkpoint.created",
        { checkpointId: "checkpoint-2" },
        "conversation",
        "turn-2",
      );
    });
    await settle();
    await act(async () => held.forEach((answer) => answer()));
    await settle();
    await act(async () => {
      daemon.send(4, "agent.completed", {}, "conversation", "turn-2");
      daemon.send(
        5,
        "checkpoint.completed",
        { checkpointId: "checkpoint-2", files: 3 },
        "conversation",
        "turn-2",
      );
    });
    await settle();

    expect(held).toHaveLength(0);
    expect(texts(".user-message")).toEqual(["Build", "Next thing"]);
    expect(texts(".turn-changes-summary")).toEqual([
      "2 files changed",
      "3 files changed",
    ]);
  });

  it("does not mark a turn for an undo in another conversation, and reads no conversation for a restore without one", async () => {
    const daemon = await openProject(() => undefined);
    await click("2 files changed");
    const loads = () =>
      daemon.requests.filter(
        (request) =>
          request.route === "/projects/project/conversations/conversation" ||
          request.route.startsWith(
            "/projects/project/conversations/conversation?",
          ),
      ).length;
    const before = loads();

    // A checkpoint id is unique only within its conversation.
    await act(async () =>
      daemon.send(
        1,
        "workspace.undone",
        { checkpointId: "checkpoint-1", kept: 0 },
        "another",
      ),
    );
    await act(async () =>
      daemon.send(2, "workspace.restored", {
        version: "restored",
        changed: [],
      }),
    );
    await settle();

    expect(loads()).toBe(before);
    expect(button("Undo")).toBeDefined();
    expect(container.textContent).not.toContain("Changes undone");
  });

  it("reads the conversation again after a restore in it", async () => {
    const daemon = await openProject(() => undefined);

    daemon.conversation = { ...detail("stored-turn"), cursor: 1 };
    await act(async () =>
      daemon.send(
        1,
        "workspace.restored",
        { checkpointId: "checkpoint-1", version: "restored", changed: [] },
        "conversation",
      ),
    );
    await settle();

    expect(daemon.requests).toContainEqual({
      route: "/projects/project/conversations/conversation?reset=1",
      method: "GET",
    });
    expect(container.querySelector(".turn-changes")).toBeNull();
  });

  it("shows the row as soon as the end of a turn is reported, and reads an open list again when files changed", async () => {
    let changes = CHANGES;
    const daemon = await openProject(
      (route) =>
        route === `${BASE}/changes` ? Response.json({ changes }) : undefined,
      detail("live-turn"),
    );
    expect(container.querySelector(".turn-changes")).toBeNull();

    await act(async () =>
      daemon.send(
        1,
        "checkpoint.completed",
        { checkpointId: "checkpoint-1", files: 2 },
        "conversation",
      ),
    );
    await settle();

    expect(button("Undo")).toBeUndefined();
    await click("2 files changed");
    expect(button("Undo")).toBeDefined();
    expect(texts(".turn-change-row")).toEqual(["a.js—", "b.js—"]);

    // A later turn rewrites one of the files.
    changes = [{ ...CHANGES[0], state: "changed" }, CHANGES[1]];
    await act(async () =>
      daemon.send(
        2,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      ),
    );
    await act(async () =>
      daemon.send(3, "agent.completed", {}, "conversation", "turn-2"),
    );
    await settle();

    expect(texts(".turn-change-row")).toEqual(["a.js—Changed later", "b.js—"]);
    expect(
      daemon.requests.filter((request) => request.route === `${BASE}/changes`),
    ).toHaveLength(2);
  });

  it("offers no undo while the Agent works or the connection is lost", async () => {
    const daemon = await openProject(() => undefined);
    await click("2 files changed");
    expect(button("Undo")!.disabled).toBe(false);

    await act(async () =>
      daemon.send(
        1,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      ),
    );
    await settle();

    expect(button("Undo")!.disabled).toBe(true);
    // Looking at the changes stays possible.
    expect(button("2 files changed")!.disabled).toBe(false);

    await act(async () =>
      daemon.send(2, "agent.completed", {}, "conversation", "turn-2"),
    );
    await settle();
    expect(button("Undo")!.disabled).toBe(false);

    await act(async () => daemon.events!.close());
    await settle();
    expect(button("Undo")!.disabled).toBe(true);
  });

  it("overwrites only the files that were shown, and asks again when more were changed", async () => {
    const answers = [
      Response.json(
        { error: "Files were changed after this turn", conflicts: ["a.js"] },
        { status: 409 },
      ),
      Response.json(
        {
          error: "Files were changed after this turn",
          conflicts: ["a.js", "b.js"],
        },
        { status: 409 },
      ),
      Response.json(
        {
          error: "These files cannot be put back",
          conflicts: ["a.js"],
          blocked: true,
        },
        { status: 409 },
      ),
    ];
    const daemon = await openProject((route) =>
      route === `${BASE}/undo` ? answers.shift() : undefined,
    );
    await click("2 files changed");
    await click("Undo");
    expect(texts(".turn-changes-conflicts li")).toEqual(["a.js"]);

    await click("Overwrite them");

    expect(texts(".turn-changes-conflicts li")).toEqual(["a.js", "b.js"]);
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).toContain(
      "More files were changed in the meantime, so nothing was overwritten.",
    );
    expect(container.querySelector(".turn-changes-result")).toBeNull();

    await click("Overwrite them");

    expect(
      daemon.requests
        .filter((request) => request.route === `${BASE}/undo`)
        .map((request) => request.body),
    ).toEqual([
      "{}",
      JSON.stringify({ conflicts: "overwrite", expected: ["a.js"] }),
      JSON.stringify({ conflicts: "overwrite", expected: ["a.js", "b.js"] }),
    ]);
    // A file that can never be put back is not offered for overwriting again.
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).toContain(
      "These files cannot be put back because other files are in their place:",
    );
    expect(buttons()).toContain("Undo the rest");
    expect(buttons()).not.toContain("Overwrite them");
  });

  it("saves the design before it undoes", async () => {
    let saved!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    vi.doMock(CODING_WORKSPACE, () => ({
      CodingWorkspace: ({
        onDesignSaveReady,
      }: {
        onDesignSaveReady: (save: (() => Promise<void>) | undefined) => void;
      }) => {
        useEffect(() => onDesignSaveReady(save), [onDesignSaveReady]);
        return null;
      },
    }));
    const daemon = await openProject((route) =>
      route === `${BASE}/undo`
        ? Response.json({ changed: ["a.js", "b.js"], conflicts: [] })
        : undefined,
    );
    const undone = () =>
      daemon.requests.filter((request) => request.route === `${BASE}/undo`)
        .length;

    await click("2 files changed");
    await click("Undo");

    // Unsaved edits must be on disk before conflicts are worked out.
    expect(save).toHaveBeenCalledTimes(1);
    expect(undone()).toBe(0);

    await act(async () => saved());
    await settle();
    expect(undone()).toBe(1);
    expect(container.querySelector(".turn-changes-result")!.textContent).toBe(
      "2 files were put back.",
    );
  });

  it("saves pending edits before it exports, and exports nothing when saving fails", async () => {
    let saved!: () => void;
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { saved = resolve; }))
      .mockRejectedValueOnce(new Error("Disk full"));
    vi.doMock(CODING_WORKSPACE, () => ({
      CodingWorkspace: ({ onDesignSaveReady }: { onDesignSaveReady: (save: (() => Promise<void>) | undefined) => void }) => {
        useEffect(() => onDesignSaveReady(save), [onDesignSaveReady]);
        return null;
      },
    }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:archive"), revokeObjectURL: vi.fn() }));
    const daemon = await openProject((route) =>
      route === "/projects/project/export" ? new Response(new Blob(["zip"])) : undefined);
    const exported = () => daemon.requests.filter((request) => request.route === "/projects/project/export").length;
    const exportArchive = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>(".project-name")!.click());
      await act(async () => [...document.querySelectorAll<HTMLElement>(".ui-menu-item")]
        .find((item) => item.textContent?.includes("Export"))!.click());
      await settle();
    };

    await exportArchive();
    expect(save).toHaveBeenCalledTimes(1);
    expect(exported()).toBe(0);
    await act(async () => saved());
    await settle();
    expect(exported()).toBe(1);

    await exportArchive();
    expect(save).toHaveBeenCalledTimes(2);
    expect(exported()).toBe(1);
    expect(document.body.textContent).toContain("Disk full");
  });

  it("reopens a story's closed Code panel to show a file the chat links to", async () => {
    const PLAYABLE = path.resolve("src/renderer/playable-editor-workspace.tsx");
    vi.doMock(PLAYABLE, () => ({ PlayableEditorWorkspace: () => <p>Story editor</p> }));
    const linked = detail("live-turn");
    linked.turns[0]!.items[1] = { ...linked.turns[0]!.items[1]!, text: "Edited [the story](story/scenes.json)." } as never;
    try {
      await openProject((route) => route === "/projects/project" ? Response.json({
        id: "project", name: "Test", type: "interactive-story", workspacePath: "/tmp/project",
        updatedAt: new Date(0).toISOString(), preview: { status: "stopped" },
      }) : undefined, linked);
      // A story offers a canvas too, but its panels belong to the story editor.
      expect(container.textContent).toContain("Story editor");
      const codeTab = () => [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.getAttribute("aria-label") === "Code");
      expect(codeTab()).toBeDefined();
      await click("Close Code");
      expect(codeTab()).toBeUndefined();
      await act(async () => container.querySelector<HTMLAnchorElement>(".workspace-file-link")!.click());
      await settle();
      expect(codeTab()?.getAttribute("aria-selected")).toBe("true");
    } finally {
      vi.doUnmock(PLAYABLE);
    }
  });

  it("publishes from the top bar's Publish menu, or exports the web build there after saving", async () => {
    const publishDialog = vi.fn();
    const save = vi.fn(async () => {});
    vi.doMock(CODING_WORKSPACE, () => ({
      CodingWorkspace: (props: { publishDialog?: string; onDesignSaveReady: (save: (() => Promise<void>) | undefined) => void }) => {
        publishDialog(props.publishDialog);
        useEffect(() => props.onDesignSaveReady(save), [props.onDesignSaveReady]);
        return null;
      },
    }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:build"), revokeObjectURL: vi.fn() }));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    const daemon = await openProject((route) =>
      route === "/projects/project/build" ? new Response(new Blob(["zip"])) : undefined);
    const menuItem = async (label: string) => {
      await click("Publish");
      await act(async () => [...document.querySelectorAll<HTMLElement>(".ui-menu-item")]
        .find((item) => item.textContent?.includes(label))!.click());
      await settle();
    };

    expect(publishDialog).not.toHaveBeenCalledWith("open");
    await menuItem("Publish to the OhMyGame community");
    expect(publishDialog).toHaveBeenLastCalledWith("open");

    // A story's or other editor's pending save finishes before the build reads the files.
    let saved!: () => void;
    const { desktopSave } = await import("../src/renderer/desktop-save.js");
    const unregister = desktopSave.register(() => new Promise<void>((resolve) => { saved = resolve; }));
    const built = () => daemon.requests.filter((request) => request.route === "/projects/project/build");
    try {
      await menuItem("Export web build");
      expect(save).toHaveBeenCalledTimes(1);
      expect(built()).toHaveLength(0);
      await click("Publish");
      const publishItem = [...document.querySelectorAll<HTMLButtonElement>(".ui-menu-item")]
        .find((item) => item.textContent?.includes("Publish to the OhMyGame community"))!;
      expect(publishItem.disabled).toBe(true);
      await act(async () => saved());
      await settle();
    } finally {
      unregister();
    }
    expect(built()).toHaveLength(1);
    expect(downloads).toEqual(["Test (web).zip"]);
  });

  it("asks before it puts the files back after a restore that was cut off, and shows why that failed", async () => {
    let refuse = true;
    const daemon = await openProject((route, init) => {
      if (route === UNFINISHED) return Response.json({ unfinished: true });
      if (route === `${UNFINISHED}/changes`)
        return Response.json({
          changes: [
            { path: "level2.js", kind: "removed" },
            { path: "notes.txt", kind: "modified" },
            { path: "old.js", kind: "added" },
          ],
        });
      if (route !== `${UNFINISHED}/restore` || init.method !== "POST")
        return undefined;
      return refuse
        ? Response.json(
            { error: "Wait for the agent to finish" },
            { status: 409 },
          )
        : new Response(null, { status: 204 });
    });
    const banner = () => container.querySelector(".unfinished-restore");
    const restores = () =>
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/restore`,
      ).length;

    expect(banner()!.getAttribute("role")).toBe("status");
    expect(banner()!.textContent).toContain(
      "Putting files back was interrupted, so the project's files may be partly changed.",
    );

    await click("Put the files back");

    // Nothing is put back before the user saw what that does.
    expect(restores()).toBe(0);
    expect(banner()!.textContent).toContain(
      "3 files will be put back to how they were before the interruption. Later changes to these files will be lost.",
    );
    expect(texts(".unfinished-restore-files li")).toEqual([
      "Removedlevel2.js",
      "Changed backnotes.txt",
      "Comes backold.js",
    ]);
    expect(button("Put the files back")).toBeUndefined();

    await click("Put 3 files back");
    expect(banner()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Wait for the agent to finish",
    );
    expect(restores()).toBe(1);

    // After a failure the list is read again before the user is asked.
    refuse = false;
    await click("Put the files back");
    await click("Put 3 files back");
    expect(banner()).toBeNull();
    expect(restores()).toBe(2);
    expect(
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/changes`,
      ),
    ).toHaveLength(2);
  });

  it("names at most ten of the files it would put back, and hides the offer on request", async () => {
    const daemon = await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json({
              changes: Array.from({ length: 12 }, (_, index) => ({
                path: `file-${index + 1}.js`,
                kind: "modified",
              })),
            })
          : undefined,
    );

    await click("Put the files back");

    expect(texts(".unfinished-restore-files li")).toEqual([
      ...Array.from(
        { length: 10 },
        (_, index) => `Changed backfile-${index + 1}.js`,
      ),
      "and 2 more",
    ]);
    expect(button("Put 12 files back")).toBeDefined();

    await click("Not now");

    expect(container.querySelector(".unfinished-restore")).toBeNull();
    expect(
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/restore`,
      ),
    ).toHaveLength(0);
  });

  it("words the offer for a single file, and asks again once the files changed", async () => {
    const daemon = await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json({
              changes: [{ path: "notes.txt", kind: "modified" }],
            })
          : undefined,
    );

    await click("Put the files back");
    expect(
      container.querySelector(".unfinished-restore")!.textContent,
    ).toContain(
      "1 file will be put back to how it was before the interruption. Later changes to this file will be lost.",
    );
    expect(button("Put 1 file back")!.disabled).toBe(false);

    // While the Agent works nothing can be put back.
    await act(async () =>
      daemon.send(
        1,
        "agent.started",
        { prompt: "Next thing" },
        "conversation",
        "turn-2",
      ),
    );
    await settle();
    expect(button("Put 1 file back")!.disabled).toBe(true);
    expect(button("Not now")!.disabled).toBe(false);

    // What it wrote is not in the list the user was shown.
    await act(async () =>
      daemon.send(2, "agent.completed", {}, "conversation", "turn-2"),
    );
    await settle();
    expect(button("Put 1 file back")).toBeUndefined();
    expect(button("Put the files back")!.disabled).toBe(false);
  });

  it("says so when no file needs to be put back, and clears the offer on request", async () => {
    const daemon = await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json({ changes: [] })
          : route === `${UNFINISHED}/restore`
            ? new Response(null, { status: 204 })
            : undefined,
    );

    await click("Put the files back");
    expect(
      container.querySelector(".unfinished-restore")!.textContent,
    ).toContain("The files are already as they were before the interruption.");
    expect(button("Put 0 files back")).toBeUndefined();
    expect(button("Not now")).toBeUndefined();

    // The mark is still there for the next start, so it is taken away by the daemon.
    await click("OK");
    expect(
      daemon.requests.filter(
        (request) => request.route === `${UNFINISHED}/restore`,
      ),
    ).toHaveLength(1);
    expect(container.querySelector(".unfinished-restore")).toBeNull();
  });

  it.each(["changes", "restore"])(
    "hides the offer without an error when the %s request finds nothing unfinished any more",
    async (missing) => {
      await openProject((route) =>
        route === UNFINISHED
          ? Response.json({ unfinished: true })
          : route === `${UNFINISHED}/${missing}`
            ? Response.json(
                { error: "No restore or undo was left unfinished" },
                { status: 404 },
              )
            : route === `${UNFINISHED}/changes`
              ? Response.json({
                  changes: [{ path: "notes.txt", kind: "modified" }],
                })
              : undefined,
      );

      await click("Put the files back");
      if (missing === "restore") await click("Put 1 file back");

      expect(container.querySelector(".unfinished-restore")).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("shows in the banner why the files to put back could not be listed", async () => {
    await openProject((route) =>
      route === UNFINISHED
        ? Response.json({ unfinished: true })
        : route === `${UNFINISHED}/changes`
          ? Response.json(
              { error: "The checkpoint store could not be read" },
              { status: 500 },
            )
          : undefined,
    );

    await click("Put the files back");

    expect(
      container.querySelector('.unfinished-restore [role="alert"]')!
        .textContent,
    ).toBe("The checkpoint store could not be read");
    expect(button("Put the files back")!.disabled).toBe(false);
  });

  it("shows the banner when an undo left the workspace partly changed, until a later one runs to its end", async () => {
    const daemon = await openProject((route) =>
      route === `${BASE}/undo`
        ? Response.json(
            {
              error: "The undo could not be completed",
              code: "CHECKPOINT_INCOMPLETE",
            },
            { status: 409 },
          )
        : undefined,
    );
    expect(container.querySelector(".unfinished-restore")).toBeNull();

    await click("2 files changed");
    await click("Undo");

    expect(container.querySelector(".turn-changes-error")!.textContent).toBe(
      "The undo could not be completed",
    );
    expect(container.querySelector(".unfinished-restore")).not.toBeNull();

    await act(async () =>
      daemon.send(1, "workspace.restored", {
        version: "restored",
        changed: [],
      }),
    );
    await settle();
    expect(container.querySelector(".unfinished-restore")).toBeNull();
  });
});
