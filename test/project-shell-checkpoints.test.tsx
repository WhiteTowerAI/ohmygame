// @vitest-environment happy-dom
import path from "node:path";
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promptText, typePrompt } from "./prompt-field.js";
import type { DesktopRuntimeState } from "../src/shared/desktop-runtime.js";
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
    pendingPrompts: [],
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
  it("binds the displayed Codex model before retrying a conversation that has no saved model", async () => {
    const model = { provider: "codex-cli", providerName: "Codex", id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningLevels: [], nativeReasoningLevels: ["low"] };
    const modelRoute = "/projects/project/conversations/conversation/model";
    const turnRoute = "/projects/project/conversations/conversation/turns";
    const daemon = await openProject((route, init) => {
      if (route.startsWith("/models?")) return Response.json({ models: [model], defaultReasoningLevel: "medium" });
      if (route === modelRoute && init.method === "PUT") return Response.json({ model: { provider: model.provider, id: model.id }, nativeReasoningLevel: "low" });
      if (route === turnRoute && init.method === "POST") return Response.json({ turnId: "new-turn" }, { status: 202 });
      return undefined;
    });
    expect(container.textContent).toContain("GPT-6.1-Sol");
    await typePrompt("Try again", container);
    await click("Send prompt");
    const calls = daemon.requests.filter((request) => request.route === modelRoute || request.route === turnRoute);
    expect(calls.map((request) => [request.method, request.route])).toEqual([["PUT", modelRoute], ["POST", turnRoute]]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ provider: "codex-cli", id: "gpt-6.1-sol" });
    expect(JSON.parse(calls[1]!.body!).prompt).toBe("Try again");
  });

  it("keeps the draft and does not send when the displayed model cannot be bound", async () => {
    const model = { provider: "codex-cli", providerName: "Codex", id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningLevels: [], nativeReasoningLevels: ["low"] };
    const daemon = await openProject((route, init) => {
      if (route.startsWith("/models?")) return Response.json({ models: [model], defaultReasoningLevel: "medium" });
      if (route.endsWith("/conversation/model") && init.method === "PUT") return Response.json({ error: "Model is not available" }, { status: 400 });
      return undefined;
    });
    await typePrompt("Try again", container);
    await click("Send prompt");
    expect(daemon.requests.some((request) => request.method === "POST" && request.route.endsWith("/turns"))).toBe(false);
    expect(promptText(container)).toBe("Try again");
    expect(container.textContent).toContain("Model is not available");
  });

  it("keeps an existing conversation's saved model when sending", async () => {
    const model = { provider: "codex-cli", providerName: "Codex", id: "gpt-6.1-sol", name: "GPT-6.1-Sol", reasoningLevels: [], nativeReasoningLevels: ["low"] };
    const saved = { provider: model.provider, id: model.id };
    const conversation = { ...detail("live-turn"), settings: { model: saved } };
    const daemon = await openProject((route, init) => {
      if (route.startsWith("/models?")) return Response.json({ models: [model], defaultReasoningLevel: "medium" });
      if (route.endsWith("/turns") && init.method === "POST") return Response.json({ turnId: "new-turn" }, { status: 202 });
      return undefined;
    }, conversation);
    await typePrompt("Continue", container);
    await click("Send prompt");
    expect(daemon.requests.some((request) => request.method === "PUT" && request.route.endsWith("/conversation/model"))).toBe(false);
    expect(daemon.requests.some((request) => request.method === "POST" && request.route.endsWith("/turns"))).toBe(true);
  });

  it("opens the design route on the canvas panel and keeps a closed chat closed across project updates", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
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

    await click("Layout and panels");
    await act(async () => menuItem("Chat").click());
    await settle();
    expect(tabs("left")).toEqual(["*Chat"]);
    expect(container.querySelector(".floating-chat")).toBeNull();
    expect(document.querySelector(".agent-pane .agent-body > .chat-input > .composer")).toBe(composer);
  });
});

describe("plugins in the project shell", () => {
  it("holds the initial message until a plugin type's project is set up, opening the panel that sets it up", async () => {
    vi.doMock(CODING_WORKSPACE, () => ({ CodingWorkspace: () => null }));
    let ready = false;
    const handled = vi.fn();
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
        if (route.endsWith("/turns") && init.method === "POST" && !ready)
          return Response.json({ error: "Connect a Maker project first", code: "project-not-ready", panel: "acme/maker:setup" }, { status: 409 });
        return undefined;
      },
      detail("live-turn"),
      { initialPrompt: { generation: 1, prompt: "Build my Maker game", mentions: [], images: [], mode: "normal" }, onInitialPromptHandled: handled },
    );
    await settle();
    expect(handled).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Your initial message has not been sent.");
    expect(container.textContent).toContain("Connect a Maker project first");
    expect(container.querySelector(".paused-initial-prompt pre")?.textContent).toBe("Build my Maker game");
    const tabs = () => [...container.querySelectorAll(".dock-area-right .dock-tab-label")].map((tab) => tab.textContent);
    // Closed, the panel comes back when the message is refused again.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close Maker setup"]')!.click());
    expect(tabs()).not.toContain("Maker setup");
    await click("Send original message");
    expect(tabs()).toContain("Maker setup");
    expect(handled).not.toHaveBeenCalled();
    ready = true;
    await click("Send original message");
    expect(handled).toHaveBeenCalledOnce();
    const sent = daemon.requests.filter((request) => request.method === "POST" && request.route.endsWith("/turns"));
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[2]!.body!).prompt).toBe("Build my Maker game");
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
      runCommand: async () => null,
    };
    // The page's bridge says once it has applied the theme it was sent.
    let page: MessagePort | undefined;
    const ready = vi.fn();
    const connection = connectPluginFrame({ postMessage: (_data: unknown, _origin: string, ports: MessagePort[]) => (page = ports[0]) } as unknown as Window, context, ready);
    page!.postMessage({ event: "ready" });
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
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

describe("checkpoints in the project shell", () => {
  it.each(["claude-code-cli", "codex-cli"] as const)("switches the selected %s chat account without changing its model or other chats", async (runtime) => {
    const chat = detail("turn");
    chat.settings = { model: { provider: runtime, id: runtime === "codex-cli" ? "gpt-test" : "sonnet" }, accountProfiles: { [runtime]: "system" } };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const daemon = await openProject((route, init) => {
      if (route === `/agent-runtimes/${runtime}/profiles`) return Response.json([
        { id: "system", name: "System default", auth: { status: "signed-in", billing: "subscription", account: "personal@example.com" } },
        { id: "work", name: "Work", auth: { status: "signed-in", billing: "subscription", account: "work@example.com" } },
      ]);
      if (route.endsWith("/account-profile") && init.method === "PUT") return Response.json({ profileId: "work" });
    }, chat);
    const label = `${runtime === "codex-cli" ? "Codex" : "Claude Code"} account`;
    const selector = container.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`)!;
    expect(selector).not.toBeNull();
    const profileReads = daemon.requests.filter((request) => request.route === `/agent-runtimes/${runtime}/profiles`).length;
    await act(async () => selector.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes("Work"))!;
    await act(async () => option.click());
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(selector.textContent).toBe("Work");
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
    await act(async () => container.querySelector<HTMLButtonElement>(".conversation-trigger")!.click());
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
    expect(container.querySelector('[aria-label^="Codex account:"]')?.textContent).toBe("Work");
    removed = true;
    await act(async () => window.dispatchEvent(new Event("ohmygame-models-changed")));
    await settle();
    expect(container.querySelector('[aria-label^="Codex account:"]')?.textContent).toBe("System default");
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
      (request) => request.route === "/projects/project/files",
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
        (request) => request.route === "/projects/project/files",
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
